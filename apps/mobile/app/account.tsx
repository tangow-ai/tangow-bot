import type {
  ActionAutoReviewSettings,
  ComputerListItem,
  SpaceDecisionConfig,
} from "@tangow/contracts";
import type { Href } from "expo-router";
import { useRouter } from "expo-router";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusedRead } from "../components/bot-page/kit";
import { NativeMenu } from "../components/native-menu";
import { NativeSymbol } from "../components/native-symbol";
import { SettingSwitch } from "../components/setting-switch";
import { UserAvatar } from "../components/user-avatar";
import type { MobileBot, MobileMe, MobileSpaceNavigation } from "../lib/api";
import { currentApiBase, loadSessionToken, rpc, selectedSpaceId } from "../lib/api";
import { formatUpdateLabel, getAppVersionInfo } from "../lib/app-version";
import { mobileTokens } from "../lib/appearance";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { useI18n } from "../lib/i18n";
import { userInitials } from "../lib/inbox";
import { selectInboxSpace } from "../lib/inbox-spaces";
import type { LiveNotificationSettings } from "../lib/live-notifications";
import {
  canPostPromotedNotifications,
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  getLiveNotificationSettings,
  openLiveNotificationSettings,
  openPromotedNotificationSettings,
  setLiveNotificationSettings,
} from "../lib/live-notifications";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { useProfilePhoto } from "../lib/profile-photo";
import { registerPushToken } from "../lib/push";

/** Settings: the account first, then what belongs to the current space. */
export default function Account() {
  const { t } = useI18n();
  const router = useRouter();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [spaces, setSpaces] = useState<MobileSpaceNavigation["spaces"]>([]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { read: computers } = useFocusedRead(
    () => rpc<ComputerListItem[]>("computer/list"),
    [spaceId],
  );
  const computerUpdateAvailable =
    computers.kind === "ready" && computers.value.some((item) => item.status.updateAvailable);
  const [notifications, setNotifications] = useState<LiveNotificationSettings>(
    DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  );
  const [notificationsReady, setNotificationsReady] = useState(Platform.OS !== "android");
  const [notificationPending, setNotificationPending] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [archivedBots, setArchivedBots] = useState<MobileBot[]>([]);
  const [autoReview, setAutoReview] = useState<ActionAutoReviewSettings | null>(null);
  const [autoReviewPending, setAutoReviewPending] = useState(false);
  // undefined while loading or unreadable: the decision-model hint stays hidden.
  const [decision, setDecision] = useState<SpaceDecisionConfig | null | undefined>(undefined);
  const tokens = useMobileTokens();
  const photo = useProfilePhoto();
  const styles = useThemedStyles(createAccountStyles);
  const versionInfo = getAppVersionInfo();
  const updateLabel = formatUpdateLabel(versionInfo.update, t);
  const versionAccessibility = [versionInfo.nativeLabel, updateLabel].filter(Boolean).join(". ");
  const space = spaces.find((item) => item.id === spaceId);
  const spaceRows: { label: string; href: Href }[] = [
    { label: t("Models"), href: "/models" },
    { label: t("Voice"), href: "/voice" },
    { label: t("Computer"), href: "/computer-settings" },
    { label: t("Integrations"), href: "/integrations" },
    { label: t("Custom apps"), href: "/custom-apps" },
    { label: t("Skills"), href: "/skills" },
    { label: t("Vault"), href: "/vault" },
    { label: t("Usage"), href: "/usage" },
  ];

  // Everything below the profile belongs to the selected space, so a switch reloads it all.
  const load = useCallback(async () => {
    await Promise.all([
      rpc<MobileMe>("me")
        .then(setMe)
        .catch(() => undefined),
      rpc<MobileSpaceNavigation>("spaces/list")
        .then((navigation) => {
          setSpaces(navigation.spaces);
          setSpaceId(navigation.current.id);
        })
        .catch(() => undefined),
      rpc<MobileBot[]>("bots/listArchived")
        .then(setArchivedBots)
        .catch(() => undefined),
      rpc<ActionAutoReviewSettings>("autoReview/get")
        .then(setAutoReview)
        .catch(() => undefined),
      rpc<SpaceDecisionConfig | null>("decision/providerConfig")
        .then(setDecision)
        .catch(() => setDecision(undefined)),
      Platform.OS === "android"
        ? getLiveNotificationSettings()
            .then(setNotifications)
            .catch(() => undefined)
            .finally(() => setNotificationsReady(true))
        : undefined,
    ]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchSpace(nextId: string) {
    if (nextId === spaceId || switching) return;
    setSwitching(true);
    try {
      if (!(await selectInboxSpace(nextId, load))) throw new Error(t("Could not switch spaces"));
    } catch (err) {
      Alert.alert(
        err instanceof Error ? err.message : t("Could not switch spaces"),
        t("Try again."),
      );
    } finally {
      setSwitching(false);
    }
  }

  function promptRename() {
    if (!space) return;
    if (Platform.OS !== "ios") {
      setRenaming(true);
      return;
    }
    Alert.prompt(
      t("Rename space"),
      undefined,
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Save"), onPress: (value?: string) => void renameSpace(value ?? "") },
      ],
      "plain-text",
      space.name,
    );
  }

  async function renameSpace(value: string) {
    const name = value.trim();
    if (!space || !name || name === space.name) return;
    try {
      await rpc("spaces/rename", { spaceId: space.id, name });
      await load();
    } catch (renameError) {
      Alert.alert(
        t("Could not rename space"),
        renameError instanceof Error ? renameError.message : t("Try again."),
      );
    }
  }

  async function restoreBot(botId: string) {
    try {
      await rpc("bots/restore", { botId });
      setArchivedBots((bots) => bots.filter((bot) => bot.id !== botId));
    } catch (restoreError) {
      Alert.alert(
        t("Could not restore bot"),
        restoreError instanceof Error ? restoreError.message : t("Try again."),
      );
    }
  }

  async function toggleAutoReview(enabled: boolean) {
    setAutoReviewPending(true);
    try {
      setAutoReview(await rpc<ActionAutoReviewSettings>("autoReview/set", { enabled }));
    } catch (cause) {
      Alert.alert(
        t("Could not save Auto Review"),
        cause instanceof Error ? cause.message : t("Try again."),
      );
    } finally {
      setAutoReviewPending(false);
    }
  }

  async function updateNotifications(next: LiveNotificationSettings) {
    const previous = notifications;
    setNotifications(next);
    setNotificationPending(true);
    setNotificationError(null);
    try {
      await setLiveNotificationSettings(
        next,
        currentApiBase(),
        await loadSessionToken(),
        selectedSpaceId() ?? "",
      );
      if (next.liveConnection && !(await canPostPromotedNotifications())) {
        await openPromotedNotificationSettings();
      }
      try {
        await registerPushToken();
      } catch (cause) {
        // The live settings saved; only the push token failed. Report it without
        // reverting the toggle the user just moved.
        setNotificationError(
          cause instanceof Error ? cause.message : t("Could not update notifications"),
        );
      }
    } catch (cause) {
      setNotifications(previous);
      setNotificationError(
        cause instanceof Error ? cause.message : t("Could not update notifications"),
      );
    } finally {
      setNotificationPending(false);
    }
  }

  const spaceLabel = space ? (
    <>
      <View style={styles.spaceTile}>
        <Text style={styles.spaceInitial}>
          {Array.from(space.name.trim())[0]?.toUpperCase() ?? "?"}
        </Text>
      </View>
      <Text numberOfLines={1} style={styles.spaceName}>
        {space.name}
      </Text>
    </>
  ) : null;

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.group}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/profile")}
            style={({ pressed }) => [styles.profileRow, pressed && styles.pressed]}
          >
            <UserAvatar
              initials={userInitials(me?.name ?? "")}
              image={photo}
              size={56}
              fontSize={20}
            />
            <View style={styles.profileText}>
              <Text numberOfLines={1} style={styles.name}>
                {me?.name || t("Your account")}
              </Text>
              {me?.email ? (
                <Text numberOfLines={1} style={styles.email}>
                  {me.email}
                </Text>
              ) : null}
            </View>
            <Chevron />
          </Pressable>
          <View style={styles.separator} />
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/providers")}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Text style={styles.rowLabel}>{t("Providers")}</Text>
            <Chevron />
          </Pressable>
        </View>

        <View style={styles.group}>
          {space && (spaces.length > 1 || space.canRename) ? (
            <NativeMenu
              title={spaces.length > 1 ? t("Switch space") : space.name}
              accessibilityLabel={spaces.length > 1 ? t("Switch space") : space.name}
              accessibilityValue={spaces.length > 1 ? space.name : undefined}
              disabled={switching}
              options={
                spaces.length > 1
                  ? spaces.map((item) => ({ value: item.id, label: item.name }))
                  : []
              }
              selected={space.id}
              onSelect={(value) => void switchSpace(value)}
              actions={
                space.canRename
                  ? [{ label: t("Rename space…"), systemImage: "pencil", onPress: promptRename }]
                  : []
              }
              style={({ pressed }) => [
                styles.row,
                styles.spaceRow,
                pressed && styles.pressed,
                switching && styles.disabled,
              ]}
            >
              {spaceLabel}
              <NativeSymbol
                ios="chevron.up.chevron.down"
                android="chevron-expand"
                size={15}
                color={native.secondaryLabel}
              />
            </NativeMenu>
          ) : space ? (
            <View style={[styles.row, styles.spaceRow]}>{spaceLabel}</View>
          ) : null}
          {space && renaming ? (
            <NamePrompt
              title={t("Rename space")}
              initialValue={space.name}
              onCancel={() => setRenaming(false)}
              onSave={(name) => {
                setRenaming(false);
                void renameSpace(name);
              }}
            />
          ) : null}
          {spaceRows.map((row, index) => (
            <Fragment key={row.label}>
              {space || index > 0 ? <View style={styles.separator} /> : null}
              <Pressable
                accessibilityRole="button"
                disabled={switching}
                onPress={() => router.push(row.href)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Text style={styles.rowLabel}>{row.label}</Text>
                {row.href === "/computer-settings" && computerUpdateAvailable ? (
                  <Text style={styles.email}>{t("Update available")}</Text>
                ) : null}
                <Chevron />
              </Pressable>
            </Fragment>
          ))}
        </View>

        {autoReview ? (
          <View accessibilityLabel={t("Action confirmations")} style={styles.card}>
            <Text style={styles.settingsTitle}>{t("Action confirmations")}</Text>
            <SettingSwitch
              label={t("Auto-review bot actions")}
              detail={
                autoReview.enabled && !autoReview.checkerAvailable
                  ? t("Add a model in Settings to use this.")
                  : t("You'll be asked to confirm actions flagged as dangerous.")
              }
              value={autoReview.enabled}
              disabled={autoReviewPending || switching}
              onChange={(enabled) => void toggleAutoReview(enabled)}
            />
            {autoReview.enabled && autoReview.checkerAvailable && decision === null ? (
              <View style={styles.hint}>
                <NativeSymbol
                  ios="exclamationmark.triangle.fill"
                  android="warning"
                  size={13}
                  color={tokens.warning}
                />
                <Text style={styles.hintLabel}>
                  {t("Improve accuracy by setting up a decision model.")}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {Platform.OS === "android" ? (
          <View accessibilityLabel={t("Notifications")} style={styles.card}>
            <Text style={styles.settingsTitle}>{t("Notifications")}</Text>
            <SettingSwitch
              label={t("Live working status")}
              detail={t("While agents are working")}
              value={notifications.liveConnection}
              disabled={notificationPending || !notificationsReady}
              onChange={(liveConnection) =>
                void updateNotifications({ ...notifications, liveConnection })
              }
            />
            <SettingSwitch
              label={t("Agent messages")}
              detail={t("Replies and completed work")}
              value={notifications.messages}
              disabled={notificationPending || !notificationsReady}
              onChange={(messages) => void updateNotifications({ ...notifications, messages })}
            />
            <SettingSwitch
              label={t("Scheduled tasks")}
              detail={t("Alerts from routines")}
              value={notifications.scheduledTasks}
              disabled={notificationPending || !notificationsReady}
              onChange={(scheduledTasks) =>
                void updateNotifications({ ...notifications, scheduledTasks })
              }
            />
            <SettingSwitch
              label={t("Needs attention")}
              detail={t("Questions, approvals, takeover")}
              value={notifications.needsAttention}
              disabled={notificationPending || !notificationsReady}
              onChange={(needsAttention) =>
                void updateNotifications({ ...notifications, needsAttention })
              }
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void openPromotedNotificationSettings()}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={{ color: native.label, fontSize: 14 }}>{t("Live update settings")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void openLiveNotificationSettings()}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={{ color: native.label, fontSize: 14 }}>
                {t("Notification settings")}
              </Text>
            </Pressable>
            {notificationError ? <Text style={styles.error}>{notificationError}</Text> : null}
          </View>
        ) : null}

        {archivedBots.length > 0 ? (
          <View style={styles.archivedSection}>
            <Text style={styles.sectionTitle}>{t("Archived bots")}</Text>
            {archivedBots.map((bot) => (
              <View key={bot.id} style={styles.archivedRow}>
                <Text numberOfLines={1} style={styles.archivedName}>
                  {bot.name}
                </Text>
                <Pressable onPress={() => void restoreBot(bot.id)} hitSlop={8}>
                  <Text style={styles.restoreLabel}>{t("Restore")}</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    confirmDeleteBot(bot, () =>
                      setArchivedBots((bots) => bots.filter((item) => item.id !== bot.id)),
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={styles.archivedDeleteLabel}>{t("Delete")}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {versionInfo.nativeLabel || updateLabel ? (
          <View
            accessibilityLabel={versionAccessibility}
            accessibilityRole="summary"
            style={styles.versionFooter}
          >
            {versionInfo.nativeLabel ? (
              <Text style={styles.versionLine}>{versionInfo.nativeLabel}</Text>
            ) : null}
            {updateLabel ? <Text style={styles.versionLine}>{updateLabel}</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Android has no text prompt: a small native dialog stands in for iOS's Alert.prompt. */
function NamePrompt({
  title,
  initialValue,
  onCancel,
  onSave,
}: {
  title: string;
  initialValue: string;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [value, setValue] = useState(initialValue);
  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <View style={[promptStyles.backdrop, { backgroundColor: tokens.overlay }]}>
        <View style={[promptStyles.card, { backgroundColor: tokens.card }]}>
          <Text style={[promptStyles.title, { color: tokens.foreground }]}>{title}</Text>
          <TextInput
            autoFocus
            selectTextOnFocus
            value={value}
            maxLength={60}
            onChangeText={setValue}
            onSubmitEditing={() => onSave(value)}
            returnKeyType="done"
            style={[promptStyles.input, { color: tokens.foreground, borderColor: tokens.border }]}
          />
          <View style={promptStyles.actions}>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={onCancel}>
              <Text style={[promptStyles.action, { color: tokens.mutedForeground }]}>
                {t("Cancel")}
              </Text>
            </Pressable>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => onSave(value)}>
              <Text style={[promptStyles.action, { color: tokens.foreground }]}>{t("Save")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const promptStyles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", padding: 32 },
  card: { borderRadius: 16, padding: 20, gap: 16 },
  title: { fontSize: 18, fontWeight: "600" },
  input: { borderBottomWidth: StyleSheet.hairlineWidth * 2, paddingVertical: 8, fontSize: 16 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 24 },
  action: { fontSize: 15, fontWeight: "600" },
});

function Chevron() {
  return (
    <NativeSymbol
      ios="chevron.right"
      android="chevron-forward"
      size={13}
      color={native.tertiaryLabel}
    />
  );
}

function createAccountStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    content: {
      flexGrow: 1,
      padding: 20,
      gap: 20,
    },
    group: {
      borderRadius: 16,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    row: {
      minHeight: 50,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    rowLabel: {
      flex: 1,
      color: native.label,
      fontSize: 17,
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginLeft: 16,
      backgroundColor: native.tertiaryLabel,
    },
    profileRow: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    profileText: {
      flex: 1,
      minWidth: 0,
    },
    name: {
      color: native.label,
      fontSize: 20,
      fontWeight: "600",
    },
    email: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    spaceRow: {
      minHeight: 56,
    },
    spaceTile: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: tokens.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    spaceInitial: {
      color: tokens.primaryForeground,
      fontSize: 15,
      fontWeight: "600",
    },
    spaceName: {
      flex: 1,
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    card: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 4,
    },
    archivedSection: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 14,
    },
    sectionTitle: {
      color: native.secondaryLabel,
      fontSize: 14,
      fontWeight: "600",
    },
    archivedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    archivedName: {
      flex: 1,
      color: native.label,
      fontSize: 16,
    },
    restoreLabel: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
    },
    archivedDeleteLabel: {
      color: tokens.destructive,
      fontSize: 14,
    },
    settingsTitle: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    versionFooter: {
      marginTop: 4,
      alignItems: "center",
      gap: 2,
    },
    versionLine: {
      color: native.tertiaryLabel,
      fontSize: 12,
      textAlign: "center",
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
      marginTop: 10,
    },
    hint: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    hintLabel: {
      flex: 1,
      color: native.secondaryLabel,
      fontSize: 12.5,
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
