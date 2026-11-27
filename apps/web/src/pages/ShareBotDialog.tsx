import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotSharing,
  ConnectionCatalogItem,
  SpaceMembers,
  VaultItem,
} from "@tangow/contracts";
import type { ShareableApp } from "@tangow/core";
import {
  connectorKey,
  declareApp,
  givableSkills,
  keyLockedBySpace,
  keySharedWithAudience,
  shareableApps,
  shareKeyWithAudience,
  shareWithPerson,
  shareWithSpace,
} from "@tangow/core";
import {
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SettingRow,
  Switch,
  UserAvatar,
} from "@tangow/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { saveFailureReason } from "../lib/save-store";
import { userInitials } from "../lib/user-initials";
import { SettingsGroup } from "./bot-page/page-kit";

/**
 * The owner's MCP servers, and those given to the bot: the only ones it can declare. A failed read
 * fails the apps list, since without them a declared server would read as deleted.
 */
async function givenServers(botId: string) {
  const [all, assignments] = await Promise.all([
    rpc.mcp.servers.list(),
    rpc.mcp.assignments.list({ botId }),
  ]);
  return { all, given: new Set(assignments.map((assignment) => assignment.serverId)) };
}

/**
 * Who besides its owner uses the bot: everyone in the Space, or the people ticked. Each change
 * saves itself; no one ticked means only the owner. Once shared, the bot uses only the skills
 * ticked for it, and a member's run only the apps and MCP servers ticked, with the member's own
 * accounts and credentials. The keys this bot saved can be shared with the same audience, one
 * explicit tick each.
 */
export function ShareBotDialog({
  bot,
  spaceName,
  userId,
  onClose,
}: {
  bot: Pick<Bot, "id" | "name" | "spaceId">;
  spaceName: string;
  userId: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [sharing, setSharing] = useState<BotSharing | null>(null);
  const [people, setPeople] = useState<SpaceMembers["members"]>([]);
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [apps, setApps] = useState<ShareableApp[]>([]);
  const [keys, setKeys] = useState<VaultItem[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const opening = rpc.bots.sharing({ botId: bot.id });
    Promise.all([
      opening,
      rpc.spaces.members({ spaceId: bot.spaceId }),
      rpc.agentSkills.list(),
    ]).then(
      ([current, view, catalog]) => {
        if (!live) return;
        setSharing(current);
        setPeople(view.members.filter((member) => member.userId !== userId));
        setSkills(givableSkills(catalog));
      },
      () => live && setError(t`Couldn't load`),
    );
    // The catalog only names the apps, and can be slow: the sheet doesn't wait for it. The apps
    // declared on opening stay listed, so unticking one never makes it vanish.
    Promise.all([
      rpc.connections.list(),
      rpc.connections.catalog({}).catch(() => [] as ConnectionCatalogItem[]),
      givenServers(bot.id),
      opening,
    ]).then(
      ([rows, catalog, servers, current]) =>
        live && setApps(shareableApps(rows, catalog, servers, current.connectors, t`Deleted`)),
      () => undefined,
    );
    rpc.vault.list().then(
      (vault) => live && setKeys(vault.mine.filter((key) => key.botId === bot.id)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bot.id, bot.spaceId, userId, t]);

  async function save(
    next: Omit<BotSharing, "connectors"> & Partial<Pick<BotSharing, "connectors">>,
  ) {
    const previous = sharing;
    setSharing(previous && { ...previous, ...next });
    setPending(true);
    setError(null);
    try {
      setSharing(await rpc.bots.share({ botId: bot.id, ...next }));
      // Sharing changes which skills count for the bot.
      setSkills(givableSkills(await rpc.agentSkills.list()));
    } catch (failure) {
      setSharing(previous);
      // A refusal the API explains, such as a bot still running, says why.
      setError(saveFailureReason(failure) || t`Couldn't save`);
    } finally {
      setPending(false);
    }
  }

  async function giveSkill(skill: AgentSkillCatalogEntry, enabled: boolean) {
    setError(null);
    try {
      const updated = await rpc.agentSkills.setAccess({
        skillId: skill.id,
        bots: [{ botId: bot.id, enabled }],
      });
      setSkills((list) => list.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch {
      setError(t`Couldn't save`);
    }
  }

  async function shareKey(key: VaultItem, checked: boolean) {
    if (!sharing) return;
    const next = { ...key, ...shareKeyWithAudience(key, sharing, checked) };
    setError(null);
    setKeys((list) => list.map((entry) => (entry.name === key.name ? next : entry)));
    try {
      await rpc.vault.share({ name: key.name, userIds: next.userIds, space: next.space });
    } catch {
      setKeys((list) => list.map((entry) => (entry.name === key.name ? key : entry)));
      setError(t`Couldn't save`);
    }
  }

  const declared = new Set(sharing?.connectors.map(connectorKey));
  const giveApp = (app: ShareableApp, checked: boolean) => {
    if (sharing) void save(declareApp(sharing, app, checked));
  };

  const everyone = sharing?.visibility === "space";
  const chosen = sharing?.visibility === "people" ? sharing.userIds : [];
  const toggle = (memberId: string, checked: boolean) => {
    if (sharing) void save(shareWithPerson(sharing, memberId, checked));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="share-bot-dialog" className="gap-4">
        <DialogHeader>
          <DialogTitle className="break-words" dir="auto">
            <Trans>Share {bot.name}</Trans>
          </DialogTitle>
        </DialogHeader>
        {sharing ? (
          <div className="flex flex-col gap-4">
            <SettingsGroup>
              <SettingRow label={t`Everyone in ${spaceName}`}>
                <Switch
                  aria-label={t`Everyone in ${spaceName}`}
                  checked={everyone}
                  disabled={pending}
                  onCheckedChange={(checked) => void save(shareWithSpace(checked))}
                />
              </SettingRow>
            </SettingsGroup>
            {!everyone && people.length > 0 ? (
              <SettingsGroup>
                {people.map((member) => (
                  <SettingRow
                    key={member.userId}
                    leading={
                      <UserAvatar
                        initials={userInitials(member.name)}
                        image={member.image}
                        className="size-7 text-label"
                      />
                    }
                    label={member.name}
                  >
                    <Checkbox
                      aria-label={member.name}
                      checked={chosen.includes(member.userId)}
                      disabled={pending}
                      onCheckedChange={(checked) => toggle(member.userId, checked)}
                    />
                  </SettingRow>
                ))}
              </SettingsGroup>
            ) : null}
            {sharing.visibility !== "private" && skills.length > 0 ? (
              <SettingsGroup label={t`Skills this bot can use`}>
                {skills.map((skill) => (
                  <SettingRow key={skill.id} label={skill.name}>
                    <Checkbox
                      aria-label={skill.name}
                      checked={skill.visibleBotIds.includes(bot.id)}
                      onCheckedChange={(checked) => void giveSkill(skill, checked)}
                    />
                  </SettingRow>
                ))}
              </SettingsGroup>
            ) : null}
            {sharing.visibility !== "private" && apps.length > 0 ? (
              <SettingsGroup label={t`Apps this bot can use`}>
                {apps.map((app) => (
                  <SettingRow key={app.key} label={app.name}>
                    <Checkbox
                      aria-label={app.name}
                      checked={declared.has(app.key)}
                      disabled={pending}
                      onCheckedChange={(checked) => giveApp(app, checked)}
                    />
                  </SettingRow>
                ))}
              </SettingsGroup>
            ) : null}
            {sharing.visibility !== "private" && keys.length > 0 ? (
              <div className="flex flex-col gap-2">
                <SettingsGroup label={t`Keys`}>
                  {keys.map((key) => (
                    <SettingRow key={key.name} label={key.name} subline={new URL(key.origin).host}>
                      <Checkbox
                        aria-label={key.name}
                        checked={keySharedWithAudience(key, sharing)}
                        disabled={pending || keyLockedBySpace(key, sharing)}
                        onCheckedChange={(checked) => void shareKey(key, checked)}
                      />
                    </SettingRow>
                  ))}
                </SettingsGroup>
                <p className="text-meta text-muted-foreground">
                  {everyone
                    ? t`Every current and future member of ${spaceName} can use ticked keys on their sites, from their bots and yours that you can see, including webhooks and routines.`
                    : t`These people can use ticked keys on their sites, from their bots and yours that you can see, including webhooks and routines.`}
                </p>
              </div>
            ) : null}
            {sharing.visibility === "private" ? null : (
              <p className="text-meta text-muted-foreground">
                <Trans>Everyone who uses this bot can see its files and browser sign-ins.</Trans>
              </p>
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
