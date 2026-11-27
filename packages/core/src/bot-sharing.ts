import type {
  AgentSkillCatalogEntry,
  BotConnector,
  BotSharing,
  Connection,
  ConnectionCatalogItem,
  McpServer,
} from "@tangow/contracts";

/** The owner's own skills a shared bot can be given; a disabled one is given to no bot. */
export function givableSkills(skills: readonly AgentSkillCatalogEntry[]): AgentSkillCatalogEntry[] {
  return skills.filter((skill) => skill.source === "user" && skill.availability !== "disabled");
}

/** An app or MCP server the owner can declare on a shared bot, under the name the sheet shows. */
export type ShareableApp = { key: string; name: string; need: BotConnector };

export function connectorKey(need: BotConnector): string {
  return need.kind === "mcp" ? `mcp:${need.serverId}` : `${need.connectorId}:${need.provider}`;
}

/**
 * The owner's connected apps, one per app however many accounts, named as in the catalog, and the
 * MCP servers they gave the bot, then everything already declared, so an app the owner has since
 * disconnected or a server they deleted can still be unticked.
 */
export function shareableApps(
  rows: readonly Connection[],
  catalog: readonly ConnectionCatalogItem[],
  servers: { all: readonly McpServer[]; given: ReadonlySet<string> },
  declared: readonly BotConnector[],
  deleted: string,
): ShareableApp[] {
  const apps = new Map<string, ShareableApp>();
  const add = (need: BotConnector, name: string) => {
    const key = connectorKey(need);
    if (!apps.has(key)) apps.set(key, { key, name, need });
  };
  const nameOf = (need: BotConnector, fallback: string) =>
    need.kind === "mcp"
      ? (servers.all.find((server) => server.id === need.serverId)?.name ?? deleted)
      : (catalog.find(
          (entry) => entry.connectorId === need.connectorId && entry.slug === need.provider,
        )?.name ?? fallback);
  for (const row of rows) {
    if (row.status !== "connected") continue;
    const need = { kind: "app", connectorId: row.connectorId, provider: row.provider } as const;
    add(need, nameOf(need, row.displayName));
  }
  for (const server of servers.all) {
    if (servers.given.has(server.id)) add({ kind: "mcp", serverId: server.id }, server.name);
  }
  for (const need of declared) add(need, nameOf(need, need.kind === "app" ? need.provider : ""));
  return [...apps.values()];
}

type Audience = Pick<BotSharing, "visibility" | "userIds">;

/** Everyone in the Space, or back to private: either way nobody stays ticked. */
export function shareWithSpace(everyone: boolean): Audience {
  return { visibility: everyone ? "space" : "private", userIds: [] };
}

/** Ticks or unticks one person; nobody ticked means only the owner. */
export function shareWithPerson(sharing: Audience, userId: string, checked: boolean): Audience {
  const chosen = sharing.visibility === "people" ? sharing.userIds : [];
  const userIds = checked ? [...chosen, userId] : chosen.filter((id) => id !== userId);
  return { visibility: userIds.length > 0 ? "people" : "private", userIds };
}

/** Declares or drops one app or MCP server, keeping who the bot is shared with. */
export function declareApp(sharing: BotSharing, app: ShareableApp, checked: boolean): BotSharing {
  const connectors = checked
    ? [...sharing.connectors, app.need]
    : sharing.connectors.filter((need) => connectorKey(need) !== app.key);
  return { ...sharing, connectors };
}

/** Team memory shows on a shared bot, and on any bot that still has some: unsharing keeps it. */
export function showsTeamMemory(
  sharing: Pick<BotSharing, "visibility">,
  teamDocuments: readonly unknown[],
): boolean {
  return sharing.visibility !== "private" || teamDocuments.length > 0;
}

type KeyShare = { userIds: readonly string[]; space: boolean };

/**
 * A key shared with the whole Space already reaches the people a bot is shared with: the sheet
 * shows it ticked and locked, since the whole-Space share is changed in the Vault, not here.
 */
export function keyLockedBySpace(key: KeyShare, audience: Audience): boolean {
  return audience.visibility === "people" && key.space;
}

/**
 * A key counts as shared with the bot's audience when everyone ticked has it, or, for a bot shared
 * with the Space, when its owner chose to share it with the whole Space. Never inferred otherwise.
 */
export function keySharedWithAudience(key: KeyShare, audience: Audience): boolean {
  if (audience.visibility === "space" || keyLockedBySpace(key, audience)) return key.space;
  if (audience.visibility !== "people" || audience.userIds.length === 0) return false;
  return audience.userIds.every((id) => key.userIds.includes(id));
}

/** Ticking a key shares it with the bot's audience; unticking takes exactly that audience away. */
export function shareKeyWithAudience(
  key: KeyShare,
  audience: Audience,
  checked: boolean,
): { userIds: string[]; space: boolean } {
  if (keyLockedBySpace(key, audience)) return { userIds: [...key.userIds], space: key.space };
  if (audience.visibility === "space") return { userIds: [...key.userIds], space: checked };
  const people = audience.visibility === "people" ? audience.userIds : [];
  const userIds = checked
    ? [...new Set([...key.userIds, ...people])]
    : key.userIds.filter((id) => !people.includes(id));
  return { userIds, space: key.space };
}
