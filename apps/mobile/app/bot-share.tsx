import type { AgentSkillCatalogEntry, BotSharing, VaultItem, VaultList } from "@tangow/contracts";
import type { ShareableApp } from "@tangow/core";
import {
  connectorKey,
  declareApp,
  keyLockedBySpace,
  keySharedWithAudience,
  shareKeyWithAudience,
  shareWithPerson,
  shareWithSpace,
} from "@tangow/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { Group, InkSwitch, LoadFailed, LoadingRows, Row } from "../components/bot-page/kit";
import { SpokenError } from "../components/bot-page/spoken-error";
import { UserAvatar } from "../components/user-avatar";
import { type MobileSpaceNavigation, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { readShareableApps, readShareSheet, type ShareSheet, saveSharing } from "../lib/bot-share";
import { useI18n } from "../lib/i18n";
import { userInitials } from "../lib/inbox";
import { useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { nativeTextStyle } from "../lib/typography";

/**
 * Who besides its owner uses the bot: everyone in the Space, or the people switched on. Each change
 * saves itself; nobody on means only the owner. Once shared, the bot uses only the skills switched
 * on for it, and a member's run only the apps and MCP servers switched on, with the member's own
 * accounts and credentials. The keys this bot saved can be shared with the same audience, one
 * explicit switch each. Mirrors web's share sheet; the rules are `@tangow/core`'s.
 */
export default function BotShareScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const styles = useThemedStyles(createShareStyles);
  const { t } = useI18n();
  const router = useRouter();
  const [sheet, setSheet] = useState<ShareSheet | null>(null);
  const [spaceName, setSpaceName] = useState("");
  const [apps, setApps] = useState<ShareableApp[]>([]);
  const [keys, setKeys] = useState<VaultItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setFailed(false);
    const opening = readShareSheet(botId);
    opening.then(
      (read) => live && setSheet(read),
      () => live && setFailed(true),
    );
    Promise.all([opening, rpc<MobileSpaceNavigation>("spaces/list")]).then(
      ([read, navigation]) =>
        live &&
        setSpaceName(navigation.spaces.find((space) => space.id === read.bot.spaceId)?.name ?? ""),
      () => undefined,
    );
    // The apps declared on opening stay listed, so switching one off never makes it vanish.
    opening
      .then((read) => readShareableApps(botId, read.sharing.connectors))
      .then(
        (list) => live && setApps(list),
        () => undefined,
      );
    rpc<VaultList>("vault/list").then(
      (vault) => live && setKeys(vault.mine.filter((key) => key.botId === botId)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [botId]);
  useEffect(load, [load]);

  async function save(next: Parameters<typeof saveSharing>[1]) {
    if (!sheet) return;
    const previous = sheet.sharing;
    setSheet({ ...sheet, sharing: { ...previous, ...next } });
    setPending(true);
    setError(null);
    try {
      const saved = await saveSharing(botId, next);
      setSheet(
        (current) =>
          current && { ...current, sharing: saved.sharing, skills: saved.skills ?? current.skills },
      );
    } catch (failure) {
      setSheet((current) => current && { ...current, sharing: previous });
      // A refusal the API explains, such as a bot still running, says why.
      setError(serverMessage(failure) || t("Could not save"));
    } finally {
      setPending(false);
    }
  }

  async function giveSkill(skill: AgentSkillCatalogEntry, enabled: boolean) {
    setError(null);
    try {
      const updated = await rpc<AgentSkillCatalogEntry>("agentSkills/setAccess", {
        skillId: skill.id,
        bots: [{ botId, enabled }],
      });
      setSheet(
        (current) =>
          current && {
            ...current,
            skills: current.skills.map((entry) => (entry.id === updated.id ? updated : entry)),
          },
      );
    } catch {
      setError(t("Could not save"));
    }
  }

  async function shareKey(key: VaultItem, checked: boolean) {
    if (!sheet) return;
    const next = { ...key, ...shareKeyWithAudience(key, sheet.sharing, checked) };
    setError(null);
    setKeys((list) => list.map((entry) => (entry.name === key.name ? next : entry)));
    try {
      await rpc("vault/share", { name: key.name, userIds: next.userIds, space: next.space });
    } catch {
      setKeys((list) => list.map((entry) => (entry.name === key.name ? key : entry)));
      setError(t("Could not save"));
    }
  }

  const sharing: BotSharing | undefined = sheet?.sharing;
  const everyone = sharing?.visibility === "space";
  const chosen = sharing?.visibility === "people" ? sharing.userIds : [];
  const declared = new Set(sharing?.connectors.map(connectorKey));

  return (
    <>
      <Stack.Screen
        options={{
          title: t("Share {name}", { name: sheet?.bot.name ?? "" }),
          unstable_headerRightItems: () => [
            { type: "button", label: t("Done"), variant: "done", onPress: () => router.back() },
          ],
        }}
      />
      <ScrollView
        testID="bot-share"
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        {sheet && sharing ? (
          <>
            <Group>
              <Row
                label={t("Everyone in {space}", { space: spaceName })}
                control={
                  <InkSwitch
                    accessibilityLabel={t("Everyone in {space}", { space: spaceName })}
                    value={everyone}
                    disabled={pending}
                    onValueChange={(checked) => void save(shareWithSpace(checked))}
                  />
                }
              />
            </Group>
            {!everyone && sheet.people.length > 0 ? (
              <Group>
                {sheet.people.map((member) => (
                  <Row
                    key={member.userId}
                    leading={
                      <UserAvatar
                        initials={userInitials(member.name)}
                        image={member.image}
                        size={28}
                      />
                    }
                    label={member.name}
                    control={
                      <InkSwitch
                        accessibilityLabel={member.name}
                        value={chosen.includes(member.userId)}
                        disabled={pending}
                        onValueChange={(checked) =>
                          void save(shareWithPerson(sharing, member.userId, checked))
                        }
                      />
                    }
                  />
                ))}
              </Group>
            ) : null}
            {sharing.visibility !== "private" && sheet.skills.length > 0 ? (
              <Group label={t("Skills this bot can use")}>
                {sheet.skills.map((skill) => (
                  <Row
                    key={skill.id}
                    label={skill.name}
                    control={
                      <InkSwitch
                        accessibilityLabel={skill.name}
                        value={skill.visibleBotIds.includes(botId)}
                        onValueChange={(checked) => void giveSkill(skill, checked)}
                      />
                    }
                  />
                ))}
              </Group>
            ) : null}
            {sharing.visibility !== "private" && apps.length > 0 ? (
              <Group label={t("Apps this bot can use")}>
                {apps.map((app) => (
                  <Row
                    key={app.key}
                    label={app.name}
                    control={
                      <InkSwitch
                        accessibilityLabel={app.name}
                        value={declared.has(app.key)}
                        disabled={pending}
                        onValueChange={(checked) => void save(declareApp(sharing, app, checked))}
                      />
                    }
                  />
                ))}
              </Group>
            ) : null}
            {sharing.visibility !== "private" && keys.length > 0 ? (
              <>
                <Group label={t("Keys")}>
                  {keys.map((key) => (
                    <Row
                      key={key.name}
                      label={key.name}
                      subline={new URL(key.origin).host}
                      control={
                        <InkSwitch
                          accessibilityLabel={key.name}
                          value={keySharedWithAudience(key, sharing)}
                          disabled={pending || keyLockedBySpace(key, sharing)}
                          onValueChange={(checked) => void shareKey(key, checked)}
                        />
                      }
                    />
                  ))}
                </Group>
                <Text style={styles.note}>
                  {everyone
                    ? t(
                        "Every current and future member of {space} can use the keys switched on, each on its own site, from their bots and yours that you can see, including webhooks and routines.",
                        { space: spaceName },
                      )
                    : t(
                        "These people can use the keys switched on, each on its own site, from their bots and yours that you can see, including webhooks and routines.",
                      )}
                </Text>
              </>
            ) : null}
            {sharing.visibility === "private" ? null : (
              <Text style={styles.note}>
                {t("Everyone who uses this bot can see its files and browser sign-ins.")}
              </Text>
            )}
            <SpokenError>{error}</SpokenError>
          </>
        ) : failed ? (
          <LoadFailed onRetry={load} />
        ) : (
          <Group>
            <LoadingRows />
          </Group>
        )}
      </ScrollView>
    </>
  );
}

function createShareStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 28 },
    note: {
      paddingHorizontal: 16,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 14 }),
    },
  });
}
