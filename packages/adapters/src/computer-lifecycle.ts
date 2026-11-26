import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  PortableFile,
  SandboxProvider,
} from "@tangow/adapter-kit";
import type { ComputerUpdate } from "@tangow/contracts";
import { VolumeKind } from "@tangow/contracts";
import {
  ACTIVE_RUN_STATUSES,
  computerVolumeHome,
  parseScreenLeaseId,
  screenLeaseId,
} from "@tangow/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@tangow/db";
import { expireComputerExecutionLeases, parseComputerMode } from "@tangow/db";
import {
  clearInactiveUserComputerControl,
  expireComputerControl,
  hasActiveComputerControl,
} from "./computer-control.js";
import { scheduleBotScreenSleep, toComputerRef } from "./computer-support.js";
import {
  archiveDiscardedWorkspace,
  checkpointComputerWorkspace,
  ensureComputerWorkspaceLayout,
  restoreComputerWorkspace,
} from "./computer-workspace.js";
import { homeMovePending } from "./docker-home-migration.js";
import { resolveAgentHomePath } from "./home.js";
import type { RunWorkers } from "./runtime-worker/runtime.js";
import { userSkillsRoot } from "./skill-store.js";
import { copySharedSkills } from "./skill-tools.js";

type ComputerUpdateProgress = (
  stage: Exclude<ComputerUpdate["stage"], "preparing">,
) => Promise<void>;

const EXECUTION_LEASE_MS = 5 * 60_000;
const BOOT_WAIT_ATTEMPTS = 40;
const BOOT_WAIT_MS = 250;
/**
 * A booting claim newer than an execution-lease TTL is treated as live, not abandoned.
 * Dedicated / lease-less boots never write an execution-lease row, so this stamp age is the
 * lower bound before reclaim/Reset may treat a lease-less claim as abandoned. Align with
 * EXECUTION_LEASE_MS (a crashed team worker's lease would expire then). Slow dedicated boots
 * past this window stay protected while their run worker lease still heartbeats.
 */
const BOOT_CLAIM_STALE_MS = EXECUTION_LEASE_MS;

/**
 * Booting and suspending claims newer than an execution-lease TTL are live.
 * Older ones are abandoned: the worker died mid-transition, and Reset or a later
 * provision may reclaim them. Missing stamps fail closed (treated as live).
 */
function isAbandonedLifecycleClaim(updatedAt: Date | null | undefined, now = Date.now()): boolean {
  return updatedAt instanceof Date && now - updatedAt.getTime() >= BOOT_CLAIM_STALE_MS;
}

function isLiveSuspending(
  computer: { state: string; updatedAt?: Date | null },
  now = Date.now(),
): boolean {
  return computer.state === "suspending" && !isAbandonedLifecycleClaim(computer.updatedAt, now);
}

/**
 * "Nobody but us holds this computer."
 *
 * Whoever moves a computer to "booting" holds its execution lease for the whole provision,
 * renewed on the run heartbeat, so a booting row whose only live lease is our own belongs to
 * a worker that died between the claim and its own failure handler. Before this nothing
 * cleared that state -- the claim took only stopped/suspended/error rows and replaceComputer
 * refused a booting one -- so the computer stayed wedged for good and every run on its bot
 * retried forever.
 *
 * Used only when claiming an abandoned "booting" row. End-of-boot writes fence on the claim
 * stamp (updatedAt) instead: fencing them with this predicate too would let a second Team bot
 * lease that appears mid-provision block both activation and the failure write, leave the row
 * stuck in "booting", and destroy the valid winner's sandbox. A lease that merely expired
 * without being taken still passes, so a slow manual boot that never heartbeats keeps working.
 *
 * When screenLeaseId is absent, require that no live execution lease exists at all. Booting
 * reclaim compare-and-swaps the pre-wait updatedAt so two lease-less callers cannot both
 * match even if one re-reads the other's claim stamp during the boot wait.
 */
function heldByNobodyElse(lease: { ownerId: string; fence: number } | null) {
  return {
    executionLeases: {
      none: {
        expiresAt: { gt: new Date() },
        ...(lease ? { NOT: { runId: lease.ownerId, fence: lease.fence } } : {}),
      },
    },
  };
}

/**
 * A live execution lease held by some OTHER bot on this computer.
 *
 * replaceComputer already holds the lease for its own bot, so "any live lease" would always
 * be true there; a shared Team Computer mid-boot for a different bot must still be refused.
 */
async function hasForeignExecutionLease(
  prisma: PrismaClient,
  computerId: string,
  botId: string,
): Promise<boolean> {
  const live = await prisma.computerExecutionLease.findFirst({
    where: { computerId, botId: { not: botId }, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return live !== null;
}

/**
 * A live worker lease on another run that uses this computer.
 *
 * Dedicated boots never take a computer execution lease, so after BOOT_CLAIM_STALE_MS the
 * claim stamp alone would look abandoned while provision is still running. A heartbeating
 * run lease proves the provisioner is alive. exceptRunId lets a recovering continueRun
 * reclaim its own abandoned boot without treating itself as foreign.
 */
async function hasLiveForeignRunLease(
  prisma: PrismaClient,
  computerId: string,
  exceptRunId?: string,
): Promise<boolean> {
  const live = await prisma.run.findFirst({
    where: {
      status: { in: [...ACTIVE_RUN_STATUSES] },
      bot: { computerId },
      leaseExpiresAt: { gt: new Date() },
      ...(exceptRunId ? { id: { not: exceptRunId } } : {}),
    },
    select: { id: true },
  });
  return live !== null;
}

/** `transition`: someone else's fresh start or suspend, which ends on its own. */
export class ComputerBusyError extends Error {
  constructor(readonly reason: "held" | "transition" | "home_move_incomplete" = "held") {
    super(
      reason === "home_move_incomplete"
        ? "Computer is busy: home move incomplete"
        : "Computer is busy",
    );
    this.name = "ComputerBusyError";
  }
}

export class ComputerCapacityError extends Error {
  constructor() {
    super("Computer capacity is temporarily full");
    this.name = "ComputerCapacityError";
  }
}

export { toComputerRef } from "./computer-support.js";

async function loadVolumeHome(
  prisma: PrismaClient,
  computer: { id: string; scope: string; spaceId: string; userId: string },
  sharedBot: boolean,
) {
  const scope = parseComputerMode(computer.scope);
  const volumes = await prisma.volume.findMany({
    where: {
      OR: [
        { kind: "bot_private", bot: { computerId: computer.id } },
        ...(sharedBot
          ? []
          : [{ kind: "space_shared", spaceId: computer.spaceId, userId: computer.userId }]),
      ],
    },
    select: { kind: true, botId: true, providerRef: true },
    orderBy: { id: "asc" },
  });
  return computerVolumeHome(
    scope,
    volumes.map((volume) => ({ ...volume, kind: VolumeKind.parse(volume.kind) })),
  );
}

/** The space lock also covers a computer added after the move reserved the existing ones. */
async function claimComputerLifecycle(
  prisma: PrismaClient,
  computer: { id: string; spaceId: string; homeStorage: string },
  args: Prisma.ComputerUpdateManyArgs,
) {
  if (computer.homeStorage !== "volumes") return prisma.computer.updateMany(args);
  return prisma.$transaction(async (tx) => {
    const computers = await tx.$queryRaw<{ maintenanceId: string | null }[]>`
      SELECT "maintenanceId" FROM computers WHERE "spaceId" = ${computer.spaceId}
        AND (scope = 'team' OR id = ${computer.id})
      ORDER BY id FOR UPDATE`;
    if (computers.some((row) => row.maintenanceId?.startsWith("home-move:"))) {
      throw new ComputerBusyError();
    }
    return tx.computer.updateMany(args);
  });
}

export async function provisionComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
    /** Creates the volumes a home on volumes lacks, before its machine mounts them. */
    workers?: Pick<RunWorkers, "provisionHomeVolumes">;
  },
  computerId: string,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw new ComputerBusyError();
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const homePath = resolveAgentHomePath(deps.home, existing.homeKey, deps.dataDir ?? "./data");
  // A Docker home half-moved onto its volumes must not boot until the move finishes.
  if (existing.kind === "docker" && (await homeMovePending(homePath))) {
    throw new ComputerBusyError("home_move_incomplete");
  }
  await mkdir(homePath, { recursive: true });
  // A shared bot's computer is used by others: its owner's shared volume stays off it, and it
  // mounts the bot's own copy of its skills instead of the library of whoever runs it.
  const sharedBot = await deps.prisma.bot.findFirst({
    where: { computerId, visibility: { not: "private" } },
    select: { id: true, spaceId: true, userId: true },
  });
  // Docker would create missing bind sources as root; create them as the worker user first.
  if (deps.dataDir) {
    if (sharedBot)
      await copySharedSkills({ prisma: deps.prisma, dataDir: deps.dataDir }, sharedBot);
    else await mkdir(userSkillsRoot(deps.dataDir, context), { recursive: true });
  }

  // If we first observe abandoned "booting", remember that stamp before waiting. A concurrent
  // reclaim bumps updatedAt while state stays "booting"; fencing the claim on the pre-wait
  // stamp keeps those callers mutually exclusive. After the wait, a finished boot returns
  // "running" and takes the normal reconnect claim instead.
  //
  // Only reclaim stamps that were already older than an execution-lease TTL when we first
  // saw them. A fresher stamp means another caller may still be provisioning (dedicated and
  // lease-less boots can outlast the short boot-wait poll); stealing would double-provision
  // and roll back their sandbox. Live team boots with an execution lease are already blocked
  // by heldByNobodyElse; this guards the lease-less path (and expired-lease gaps).
  const reclaimStamp = existing.state === "booting" ? existing.updatedAt : null;
  const bootClaimIsStale =
    reclaimStamp !== null && Date.now() - reclaimStamp.getTime() >= BOOT_CLAIM_STALE_MS;
  // Idle stop does not refresh updatedAt while checkpointing or waiting on provider stop.
  // A live suspend can therefore age across the TTL during the ready wait; only reclaim
  // stamps that were already abandoned when we first saw them, matching booting reclaim.
  const suspendStamp = existing.state === "suspending" ? existing.updatedAt : null;
  const suspendClaimIsStale = suspendStamp !== null && isAbandonedLifecycleClaim(suspendStamp);
  // A fresh booting claim (or one whose run lease is still live) cannot be reclaimed after
  // the wait either, so do not block workers for the full boot-wait window. Shared Postgres
  // journeys previously hung createApp stop() while continueRun sat in that wait against a
  // wedged mid-boot row left by an earlier suite.
  if (existing.state === "booting" && reclaimStamp !== null && !bootClaimIsStale) {
    throw new ComputerBusyError("transition");
  }
  if (
    existing.state === "booting" &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw new ComputerBusyError();
  }
  if (existing.state === "booting" || existing.state === "suspending") {
    existing = await waitForComputerReady(deps.prisma, computerId, context);
  }
  // A booting row whose holder is gone is reclaimable. A suspending row is too once
  // its claim was already older than an execution-lease TTL when first observed and
  // no other run is still alive.
  const staleSuspending =
    existing.state === "suspending" &&
    suspendClaimIsStale &&
    !(await hasLiveForeignRunLease(deps.prisma, computerId, context.runId));
  if (
    !staleSuspending &&
    !["running", "stopped", "suspended", "error", "booting"].includes(existing.state)
  ) {
    throw new ComputerBusyError(
      existing.state === "suspending" && !suspendClaimIsStale ? "transition" : "held",
    );
  }
  // Waited for suspending (or similar) and landed on booting we never stamped: another
  // caller owns that boot. Do not adopt its updatedAt / previousRef and double-provision.
  if (existing.state === "booting" && reclaimStamp === null) {
    throw new ComputerBusyError("transition");
  }
  // We came to reclaim abandoned booting; if another caller already activated, do not fall
  // through into reconnect (that would provision again under their providerRef).
  if (reclaimStamp !== null && existing.state === "running") {
    throw new ComputerBusyError();
  }
  // Stamp age is only a lower bound. Dedicated / lease-less boots can provision longer than
  // BOOT_CLAIM_STALE_MS; a heartbeating foreign run lease means the holder is still alive.
  if (
    existing.state === "booting" &&
    reclaimStamp !== null &&
    (await hasLiveForeignRunLease(deps.prisma, computerId, context.runId))
  ) {
    throw new ComputerBusyError();
  }

  // A bot attached after the move has no volume yet: one the machine never mounted would leave
  // its computer writing to local disk while its workers see the volume.
  if (existing.homeStorage === "volumes") {
    await deps.workers?.provisionHomeVolumes(computerId, context);
  }
  const reconnecting =
    Boolean(existing.providerRef) &&
    (existing.state === "running" || existing.state === "suspending");
  // Reconnect can allocate a replacement too. Claim it before any provider call,
  // and compare the observed reference so a delayed caller cannot replace a winner.
  // An abandoned "booting" row is claimed only when no other live execution lease remains,
  // and only when we observed "booting" (never as an OR arm on a running/stopped claim).
  const previousRef = { providerRef: existing.providerRef, kind: existing.kind };
  const bootLease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : null;
  // Reclaim "booting" only when we observed it. Always ORing a booting arm lets a second
  // caller match after the first claimed running/stopped/… → booting and double-provision.
  // Stale "suspending" uses the same stamp fence so two recoveries cannot both provision.
  const claimWhere =
    existing.state === "booting" || existing.state === "suspending"
      ? {
          state: existing.state,
          updatedAt: existing.state === "booting" ? reclaimStamp! : suspendStamp!,
          ...(existing.state === "suspending" ? previousRef : {}),
          ...heldByNobodyElse(bootLease),
        }
      : {
          state: existing.state,
          ...previousRef,
        };
  // Choose the claim stamp before writing so a concurrent reclaim cannot make us adopt its
  // updatedAt on a follow-up read (which would let our activation overwrite the newer owner).
  // Advance past the observed stamp even when Date.now() equals it (same ms or clock skew);
  // otherwise a booting self-transition would leave the CAS token unchanged and a second
  // worker that observed the same stamp could also claim and provision.
  const observedStamp = reclaimStamp ?? suspendStamp ?? existing.updatedAt;
  const claimStamp = new Date(Math.max(Date.now(), observedStamp.getTime() + 1));
  const claimed = await claimComputerLifecycle(deps.prisma, existing, {
    where: {
      id: computerId,
      ...claimWhere,
      maintenanceId: existing.maintenanceId ?? null,
      ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
    },
    data: { state: "booting", updatedAt: claimStamp },
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  let provisioned: ComputerRef | undefined;
  try {
    await onProgress?.("recreating");
    const ref = await deps.sandbox.provision(
      {
        botId: existing.homeKey,
        homePath,
        providerRef: existing.providerRef ?? undefined,
        providerKind: existing.kind as ComputerRef["kind"],
        releaseRef: existing.releaseRef,
        ...(sharedBot ? { skillsBotId: sharedBot.id } : {}),
        ...(existing.homeStorage === "volumes"
          ? {
              volumeHome: {
                ...(await loadVolumeHome(deps.prisma, existing, sharedBot !== null)),
                archive: (files: AsyncIterable<PortableFile>) =>
                  archiveDiscardedWorkspace(
                    deps.home,
                    existing,
                    existing.providerRef ?? "unknown",
                    files,
                    context,
                  ),
              },
            }
          : {}),
      },
      context,
    );
    provisioned = ref;
    await deps.sandbox.prepare(ref, context);
    const replacement =
      ref.fresh === true ||
      !existing.providerRef ||
      existing.providerRef !== ref.providerRef ||
      existing.kind !== ref.kind;
    if (replacement) {
      await onProgress?.("restoring");
      await restoreComputerWorkspace(deps.home, deps.sandbox, existing, ref, context);
    }
    await onProgress?.("reconnecting");
    await ensureComputerWorkspaceLayout(
      deps.sandbox,
      ref,
      parseComputerMode(existing.scope),
      context.botId,
      context,
    );
    const activeControl = hasActiveComputerControl(existing);
    const activated = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "booting",
        updatedAt: claimStamp,
        ...previousRef,
        maintenanceId: existing.maintenanceId ?? null,
        ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
      },
      data: {
        state: "running",
        providerRef: ref.providerRef,
        releaseRef: ref.releaseRef ?? (replacement ? null : existing.releaseRef),
        kind: ref.kind,
        ...(!reconnecting
          ? {
              controlHolder: activeControl ? "user" : controlHolder,
              ...(!activeControl
                ? {
                    controlLeaseId: null,
                    controlLeaseExpiresAt: null,
                    controlBotId: null,
                    controlRunId: null,
                  }
                : {}),
            }
          : {}),
      },
    });
    if (activated.count !== 1) {
      throw new ComputerBusyError();
    }
    return ref;
  } catch (error) {
    // A failed reconnect never owns an existing workspace, even if setup failed.
    const rollbackError =
      provisioned && (!reconnecting || provisioned.fresh === true)
        ? await rollbackProvisionedComputer(deps.sandbox, provisioned, context, error)
        : undefined;
    try {
      await deps.prisma.computer.updateMany({
        where: {
          id: computerId,
          state: "booting",
          updatedAt: claimStamp,
          ...previousRef,
          maintenanceId: existing.maintenanceId ?? null,
        },
        data: {
          state: reconnecting ? "running" : "error",
          ...(!reconnecting && rollbackError && provisioned
            ? { providerRef: provisioned.providerRef, kind: provisioned.kind }
            : {}),
        },
      });
    } catch (recordError) {
      throw new AggregateError(
        [error, ...(rollbackError ? [rollbackError] : []), recordError],
        "Computer provisioning failed and its failure could not be recorded",
      );
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Computer provisioning failed and its sandbox could not be rolled back",
      );
    }
    throw error;
  }
}

async function waitForComputerReady(
  prisma: PrismaClient,
  computerId: string,
  context: AdapterContext,
) {
  for (let attempt = 0; attempt < BOOT_WAIT_ATTEMPTS; attempt += 1) {
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("computer boot aborted");
    }
    const current = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (current.state === "running" && current.providerRef) return current;
    if (current.state !== "booting" && current.state !== "suspending") return current;
    await new Promise((resolve) => setTimeout(resolve, BOOT_WAIT_MS));
  }
  return prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
}

/**
 * Waits while someone else starts or suspends the computer, for as long as their claim stays
 * live, and not at all while maintenance holds it.
 */
export async function waitOutComputerTransition(
  prisma: PrismaClient,
  computerId: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + BOOT_CLAIM_STALE_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const { state, maintenanceId } = await prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
      select: { state: true, maintenanceId: true },
    });
    if (maintenanceId || (state !== "booting" && state !== "suspending")) return;
    await delay(BOOT_WAIT_MS, undefined, { signal });
  }
}

async function rollbackProvisionedComputer(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  cause: unknown,
): Promise<unknown | undefined> {
  try {
    await sandbox.releaseScreen?.(computer, context).catch(() => undefined);
    if (computer.fresh) {
      await sandbox.destroy(computer, context);
    } else if (cause instanceof ComputerBusyError) {
      try {
        await sandbox.stop(computer, context);
      } catch {
        await sandbox.destroy(computer, context);
      }
    } else {
      await sandbox.stop(computer, context);
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

export interface ComputerExecutionLease {
  computerId: string;
  botId: string;
  runId: string;
  fence: number;
}

export function screenLeaseIdForRun(
  lease: Pick<ComputerExecutionLease, "runId" | "fence"> | null,
  runId: string,
  fence = 0,
): string {
  return screenLeaseId(lease?.runId ?? runId, lease?.fence ?? fence);
}

export async function acquireComputerExecutionLease(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
    resumeHeldLease?: boolean;
  },
): Promise<ComputerExecutionLease | null> {
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: input.computerId } });
  if (computer.maintenanceId && computer.maintenanceId !== input.runId)
    throw new ComputerBusyError();
  // A shared bot's runs take turns on its dedicated computer, as on a team computer.
  if (
    computer.scope !== "team" &&
    !(await prisma.bot.findFirst({
      where: { id: input.botId, visibility: { not: "private" } },
      select: { id: true },
    }))
  )
    return null;
  if (isLiveSuspending(computer)) throw new ComputerBusyError("transition");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
  const [reclaimed] = await prisma.computerExecutionLease.updateManyAndReturn({
    where: {
      computerId: input.computerId,
      botId: input.botId,
      OR: [{ expiresAt: { lt: now } }, ...(input.resumeHeldLease ? [{ runId: input.runId }] : [])],
    },
    data: {
      runId: input.runId,
      expiresAt,
      fence: { increment: 1 },
    },
    select: { fence: true },
  });
  if (reclaimed) {
    return validateAcquiredComputerLease(prisma, {
      computerId: input.computerId,
      botId: input.botId,
      runId: input.runId,
      fence: reclaimed.fence,
    });
  }
  try {
    const created = await prisma.computerExecutionLease.create({
      data: {
        computerId: input.computerId,
        botId: input.botId,
        runId: input.runId,
        fence: 1,
        expiresAt,
      },
      select: { fence: true },
    });
    return validateAcquiredComputerLease(prisma, {
      computerId: input.computerId,
      botId: input.botId,
      runId: input.runId,
      fence: created.fence,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new ComputerBusyError();
    throw error;
  }
}

async function validateAcquiredComputerLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease,
): Promise<ComputerExecutionLease> {
  const computer = await prisma.computer.findUniqueOrThrow({
    where: { id: lease.computerId },
    select: { state: true, maintenanceId: true, updatedAt: true },
  });
  if (
    !isLiveSuspending(computer) &&
    (!computer.maintenanceId || computer.maintenanceId === lease.runId)
  )
    return lease;
  await releaseComputerExecutionLease(prisma, lease);
  throw new ComputerBusyError(
    computer.maintenanceId && computer.maintenanceId !== lease.runId ? "held" : "transition",
  );
}

export async function renewComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
  const owner = {
    computerId: lease.computerId,
    botId: lease.botId,
    runId: lease.runId,
    fence: lease.fence,
  };
  // A heartbeat admitted before a pause may reach the database after the longer hold commits.
  const renewed = await prisma.computerExecutionLease.updateMany({
    where: { ...owner, expiresAt: { gt: now, lt: expiresAt } },
    data: { expiresAt },
  });
  if (renewed.count === 1) return true;
  return Boolean(
    await prisma.computerExecutionLease.findFirst({
      where: { ...owner, expiresAt: { gte: expiresAt } },
      select: { computerId: true },
    }),
  );
}

export async function holdComputerExecutionLeaseForTakeover(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const now = new Date();
  const held = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
      expiresAt: { gt: now },
    },
    data: { expiresAt: new Date(now.getTime() + 24 * 60 * 60_000) },
  });
  return held.count === 1;
}

export async function releaseComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<void> {
  if (!lease) return;
  // Keep the row as an expired tombstone so the next run for this bot increments
  // its fence. Deleting it resets the fence to 1, which lets a still-open screen
  // session from the previous run reject the new run as stale.
  await expireComputerExecutionLeases(prisma, {
    computerId: lease.computerId,
    botId: lease.botId,
    runId: lease.runId,
    fence: lease.fence,
  });
}

/**
 * Releasing a bot's desktop slot drops its view token, and the next slot gets a new one, so the
 * bot's screen generation moves on and URLs sealed for the old slot stop being reused. Open
 * screens only re-read on a status event, so the release announces one.
 *
 * A screen the provider keeps has neither: its token and viewers stay, and the bot's next run
 * finds the page it left. Closing it is left to `computer.screen-sleep`.
 */
export async function releaseBotScreen(
  deps: {
    prisma: Pick<PrismaClient, "bot">;
    sandbox: Pick<SandboxProvider, "releaseScreen">;
    events?: Pick<ThreadEvents, "append">;
    jobs?: Pick<JobPublisher, "enqueue">;
  },
  computer: ComputerRef,
  context: AdapterContext,
  release: "keep" | "teardown" = "teardown",
): Promise<boolean> {
  if (!deps.sandbox.releaseScreen) return false;
  let released: "kept" | "refused" | void;
  try {
    // Teardown is every provider's default, so only a keep request carries an argument.
    released =
      release === "keep"
        ? await deps.sandbox.releaseScreen(computer, context, "keep")
        : await deps.sandbox.releaseScreen(computer, context);
  } catch {
    // A failed release keeps the slot and its token.
    return false;
  }
  // A newer run owns the screen: its token and viewers are not this release's to move on.
  if (released === "refused") return true;
  const botId = context.botId;
  if (released === "kept") {
    // A screen nobody closes stays until its computer's own idle shutdown.
    await scheduleKeptScreenSleep(deps, context).catch(() => undefined);
    return true;
  }
  if (!botId) return true;
  const bot = await deps.prisma.bot
    .update({
      where: { id: botId },
      data: { screenGeneration: { increment: 1 } },
      select: {
        spaceId: true,
        thread: { select: { id: true } },
        computer: { select: { state: true } },
      },
    })
    .catch(() => null);
  if (!bot?.thread || !bot.computer || !deps.events) return true;
  await deps.events
    .append({
      spaceId: bot.spaceId,
      threadId: bot.thread.id,
      botId,
      type: "computer.status",
      payload: { status: bot.computer.state },
    })
    .catch(() => undefined);
  return true;
}

async function scheduleKeptScreenSleep(
  deps: { prisma: Pick<PrismaClient, "bot">; jobs?: Pick<JobPublisher, "enqueue"> },
  context: AdapterContext,
) {
  const { botId, screenLeaseId } = context;
  if (!deps.jobs || !botId || !screenLeaseId) return;
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: { computerId: true },
  });
  if (bot?.computerId) {
    await scheduleBotScreenSleep(deps.jobs, { computerId: bot.computerId, botId, screenLeaseId });
  }
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export type ComputerReplaceMode = "recover" | "reset" | "update";

export async function replaceComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  mode: ComputerReplaceMode,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
  onProgress?: ComputerUpdateProgress,
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (existing.maintenanceId && existing.maintenanceId !== context.operationId)
    throw new ComputerBusyError();
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    const expired = await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    // Failed provider revoke keeps the lease for retry; do not wipe it and continue reset.
    if (!expired && existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  // Orphaned controlHolder=user with no lease id can be cleared for reset/recover.
  if (
    existing.controlHolder === "user" &&
    !hasActiveComputerControl(existing) &&
    !existing.controlLeaseId
  ) {
    await clearInactiveUserComputerControl(deps.prisma, existing.id);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (existing.controlHolder === "user" && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const botId = context.botId;
  if (!botId) throw new Error("computer replacement requires a bot id");
  if (hasActiveComputerControl(existing)) {
    throw new ComputerBusyError();
  }
  // Reset is the in-product recovery for a hung suspend. Recover and update still refuse
  // so they cannot destroy a computer that is only stuck, not requested as a Reset.
  if (existing.state === "suspending" && mode !== "reset") {
    throw new ComputerBusyError();
  }
  // Allow Reset on a stale "booting" or "suspending" row unless another bot still holds a live
  // lease. Dedicated computers never create an execution-lease row, so the foreign-lease check
  // alone cannot see an in-flight dedicated boot or idle stop. Refuse claim stamps younger than
  // an execution-lease TTL (not merely the boot-wait poll) so a slow dedicated provision or
  // suspend is not destroyed mid-flight. Also refuse while a run still uses the computer —
  // before claiming suspending — so rollback cannot bump @updatedAt under an in-flight boot.
  if (existing.state === "booting" || existing.state === "suspending") {
    if (await hasForeignExecutionLease(deps.prisma, computerId, botId)) {
      throw new ComputerBusyError();
    }
    if (!isAbandonedLifecycleClaim(existing.updatedAt)) {
      throw new ComputerBusyError();
    }
    const activeBootRun = await deps.prisma.run.findFirst({
      where: {
        status: { in: [...ACTIVE_RUN_STATUSES] },
        bot: { computerId },
      },
      select: { id: true },
    });
    if (activeBootRun) throw new ComputerBusyError();
  }

  const previousState = existing.state;
  const now = new Date();
  const claimStamp = new Date(Math.max(now.getTime(), existing.updatedAt.getTime() + 1));
  const claimed = await claimComputerLifecycle(deps.prisma, existing, {
    where: {
      id: computerId,
      state: previousState,
      maintenanceId: existing.maintenanceId ?? null,
      // CAS the booting/suspending stamp so a concurrent live claim cannot be overwritten.
      ...(previousState === "booting" || previousState === "suspending"
        ? { updatedAt: existing.updatedAt }
        : {}),
      executionLeases: { none: { botId: { not: botId }, expiresAt: { gt: now } } },
      OR: [
        { controlHolder: { not: "user" } },
        { controlLeaseId: null },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lte: now } },
      ],
    },
    data: { state: "suspending", updatedAt: claimStamp },
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  // Re-check after the claim in case a run started between the pre-check and CAS.
  const activeRun = await deps.prisma.run.findFirst({
    where: {
      status: { in: [...ACTIVE_RUN_STATUSES] },
      bot: { computerId },
    },
    select: { id: true },
  });
  if (activeRun) {
    await deps.prisma.computer.updateMany({
      where: { id: computerId, state: "suspending", updatedAt: claimStamp },
      data: { state: previousState },
    });
    throw new ComputerBusyError();
  }

  const oldRef = existing.providerRef ? toComputerRef(existing) : null;
  try {
    // Retry the checkpoint even after an earlier update left the row in error.
    if (oldRef && (mode === "update" || (existing.state === "running" && mode === "recover"))) {
      try {
        await onProgress?.("saving");
        const revision = await checkpointComputerWorkspace(
          deps.home,
          deps.sandbox,
          existing,
          oldRef,
          context,
        );
        const recorded = await deps.prisma.computer.updateMany({
          where: { id: computerId, state: "suspending", updatedAt: claimStamp },
          data: { homeRevision: revision, updatedAt: claimStamp },
        });
        if (recorded.count !== 1) throw new ComputerBusyError();
        await deps.sandbox.preserveBeforeReplace?.(oldRef, context);
      } catch (error) {
        if (mode !== "recover" || error instanceof ComputerBusyError) throw error;
      }
    }
    await onProgress?.("recreating");
    if (oldRef) {
      await deps.sandbox.releaseScreen?.(oldRef, context).catch(() => undefined);
      try {
        await deps.sandbox.destroy(oldRef, context);
      } catch (error) {
        if (mode !== "recover") throw error;
      }
    }
    const stopped = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "suspending",
        updatedAt: claimStamp,
        maintenanceId: existing.maintenanceId ?? null,
      },
      data: {
        state: "stopped",
        providerRef: null,
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
        updatedAt: claimStamp,
      },
    });
    if (stopped.count !== 1) throw new ComputerBusyError();
    return provisionComputer(deps, computerId, context, controlHolder, onProgress);
  } catch (error) {
    await deps.prisma.computer
      .updateMany({
        where: {
          id: computerId,
          updatedAt: claimStamp,
          maintenanceId: existing.maintenanceId ?? null,
        },
        data: { state: "error" },
      })
      .catch(() => undefined);
    throw error;
  }
}
