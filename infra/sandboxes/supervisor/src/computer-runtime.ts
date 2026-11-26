import type { Duplex } from "node:stream";

/** What a bot's computer is made from. The backend turns it into a container or a pod. */
export interface ComputerSpec {
  botId: string;
  spaceId: string;
  userId: string;
  skillsBotId?: string;
  /** The bot's home under `DATA_DIR`, already checked by the routes. */
  homePath: string;
  volumeHome?: { root: string; mounts: Array<{ volume: string; path: string }> };
}

export interface ComputerOwner {
  botId: string;
  spaceId: string;
}

/** A computer as the routes see it, read again on every call: a resume can move its address. */
export interface Computer {
  /** The container or pod name, or the Docker container id the API already holds. */
  id: string;
  running: boolean;
  image: string;
  /** The release it runs. One that differs from `release()` is replaced. */
  releaseRef: string;
  /** False when the computer was built from another spec than the one it was looked up with. */
  matchesSpec: boolean;
  /** Where the workspace starts inside the computer. */
  workspace: string;
  /** The desktop control endpoint, when the computer exposes one. */
  control?: { url: string; token: string };
  /** Where the asked screen port is reachable. */
  screen?: { host: string; port: string };
}

export interface ExecOptions {
  cwd: string;
  env: string[];
  /** Written to the command's stdin, which then closes, unless a signal owns its end. */
  stdin?: Buffer;
  /** Aborting closes the command's stdin and abandons it. */
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface WorkerGuest {
  /** Relays the socket into the guest's stdin and its stdout back, until either side ends. */
  attach(socket: Duplex, head: Buffer): void;
  /** Ends the guest before anything was relayed. */
  close(): void;
}

export interface WorkerAttempt {
  attemptId: string;
  ttlSeconds: number;
  mounts: Array<{ volume: string; path: string; readOnly: boolean }>;
}

/**
 * Where computers and workers run. The routes keep the lifecycle decisions (replace, screens,
 * locks); a backend only creates, reads, stops, removes, and runs commands.
 */
export interface ComputerRuntime {
  /** The release a computer created now would run. */
  release(): Promise<string>;
  /** A computer by id, owned by `owner`. Throws when it is missing or someone else's. */
  getComputer(query: { id: string; owner: ComputerOwner; screenPort?: string }): Promise<Computer>;
  /** The bot's computer, if any, compared with `spec`. */
  getComputer(query: { spec: ComputerSpec }): Promise<Computer | undefined>;
  /** Starts `existing` again, or creates the computer, replacing `existing` when asked. */
  ensureComputer(
    spec: ComputerSpec,
    existing?: Pick<Computer, "id" | "running" | "releaseRef"> & { replace: boolean },
  ): Promise<{ id: string; releaseRef: string; resumed: boolean }>;
  /** Stops the computer and keeps its files. */
  stopComputer(id: string): Promise<void>;
  removeComputer(id: string, botId: string): Promise<void>;
  exec(id: string, argv: string[], options: ExecOptions): Promise<ExecResult>;
  workers: {
    /** One worker per attempt: a second call returns the first. */
    ensure(attempt: WorkerAttempt): Promise<{ id: string }>;
    /** Resolves only once no worker of the attempt is left. */
    destroy(attemptId: string): Promise<{ destroyed: boolean }>;
    /** Starts the guest with the attempt's capability. Undefined when `id` is not a worker. */
    openGuest(id: string, capability: string): Promise<WorkerGuest | undefined>;
  };
}

export class ComputerIdentityError extends Error {}
export class ComputerNotFoundError extends Error {}
export class ComputerLimitError extends Error {
  constructor(readonly limit?: number) {
    super(
      limit === undefined
        ? "Computer capacity is temporarily full"
        : `Computer limit reached for space (max: ${limit})`,
    );
  }
}
