import type { BotSecretDestination, VaultItem as Key } from "@tangow/contracts";
import { SharedVaultItem, VaultItem as VaultItemSchema } from "@tangow/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Group, InkSwitch, Row } from "../components/bot-page/kit";
import { SpokenError } from "../components/bot-page/spoken-error";
import { UserAvatar } from "../components/user-avatar";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { userInitials } from "../lib/inbox";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { nativeTextStyle } from "../lib/typography";
import type { VaultScreen } from "../lib/vault";
import { readSpacePeople } from "../lib/vault";

type AuthType = BotSecretDestination["auth"]["type"];

/** "api.example.com" or a full URL, as the HTTPS origin a credential is bound to. */
function siteOrigin(site: string): string {
  const trimmed = site.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return trimmed;
  }
}

function readItem(param?: string) {
  if (!param) return null;
  try {
    const value: unknown = JSON.parse(param);
    const owned = VaultItemSchema.safeParse(value);
    if (owned.success) return owned.data;
    const shared = SharedVaultItem.safeParse(value);
    return shared.success ? shared.data : null;
  } catch {
    return null;
  }
}
export default function VaultItem() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createVaultItemStyles);
  const params = useLocalSearchParams<{ item?: string }>();
  const selected = readItem(params.item);
  const item = selected && !("ownerName" in selected) ? selected : null;
  const [editing, setEditing] = useState(false);
  const [site, setSite] = useState("");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<AuthType>("bearer");
  const [authField, setAuthField] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    Boolean(value) &&
    (item !== null ||
      (Boolean(site.trim() && name) && (authType === "bearer" || Boolean(authField.trim()))));

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace("/vault");
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      close();
    } catch (cause) {
      setError(serverMessage(cause) || fallback);
      setBusy(false);
    }
  }

  function save() {
    if (!ready || busy) return;
    const auth: BotSecretDestination["auth"] =
      authType === "header"
        ? { type: "header", name: authField.trim() }
        : authType === "basic"
          ? { type: "basic", username: authField.trim() }
          : { type: "bearer" };
    const destination = item
      ? { name: item.name, origin: item.origin, auth: item.auth }
      : { name, origin: siteOrigin(site), auth };
    // Cleared before the request, so the value is never shown again.
    setValue("");
    void run(() => rpc("vault/put", { ...destination, value }), t("Could not save"));
  }

  function remove() {
    if (!item || busy) return;
    Alert.alert(t("Remove {name}?", { name: item.name }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Remove"),
        style: "destructive",
        onPress: () =>
          void run(() => rpc("vault/remove", { name: item.name }), t("Could not remove key")),
      },
    ]);
  }

  if (selected && !editing) {
    const auth = selected.auth;
    return (
      <>
        <Stack.Screen
          options={{
            title: selected.name,
            headerBackVisible: false,
            unstable_headerLeftItems: () =>
              item
                ? [
                    {
                      type: "button",
                      label: t("Edit"),
                      disabled: busy,
                      onPress: () => {
                        setError(null);
                        setEditing(true);
                      },
                    },
                  ]
                : [],
            unstable_headerRightItems: () => [
              { type: "button", label: t("Done"), variant: "done", disabled: busy, onPress: close },
            ],
          }}
        />
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
          <Group>
            <Row label={t("Site")} subline={new URL(selected.origin).host} />
            <Row
              label={t("Sent as")}
              subline={
                auth.type === "bearer" ? "Bearer" : auth.type === "basic" ? "Basic" : t("Header")
              }
            />
            {auth.type === "header" ? <Row label={t("Header name")} subline={auth.name} /> : null}
            {auth.type === "basic" ? <Row label={t("Username")} subline={auth.username} /> : null}
            <Row label={t("Key")} subline="••••••••••••" />
            {"ownerName" in selected ? (
              <Row label={t("Shared by")} subline={selected.ownerName} />
            ) : null}
          </Group>
          <SpokenError>{error}</SpokenError>
          {item ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={remove}
              style={({ pressed }) => [styles.delete, pressed && styles.pressed]}
            >
              <Text style={styles.deleteLabel}>{t("Remove")}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </>
    );
  }

  const field = (
    label: string,
    text: string,
    onChange: (next: string) => void,
    extra: Partial<ComponentProps<typeof TextInput>> = {},
  ) => (
    <Group label={label}>
      <View style={styles.field}>
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          value={text}
          onChangeText={onChange}
          placeholderTextColor={tokens.mutedForeground}
          style={styles.input}
          {...extra}
        />
      </View>
    </Group>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: item ? item.name : t("New API key"),
          headerBackVisible: false,
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: t("Cancel"),
              variant: "plain",
              hidesSharedBackground: true,
              disabled: busy,
              onPress: close,
            },
          ],
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: item ? t("Replace key") : t("Save"),
              variant: "done",
              disabled: busy || !ready,
              onPress: save,
            },
          ],
        }}
      />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {item ? null : (
          <>
            {field(t("Site"), site, setSite, {
              placeholder: "api.example.com",
              keyboardType: "url",
              autoFocus: true,
            })}
            {field(
              t("Name"),
              name,
              // Names are what the bot calls the key by: lowercase letters, digits and "_".
              (next) => setName(next.toLowerCase().replace(/[^a-z0-9_]/g, "_")),
              { placeholder: "example_api" },
            )}
            <Group label={t("Sent as")}>
              {(
                [
                  ["bearer", "Bearer"],
                  ["header", t("Header")],
                  ["basic", "Basic"],
                ] as const
              ).map(([type, label]) => (
                <Row
                  key={type}
                  label={label}
                  checked={authType === type}
                  onPress={() => {
                    setAuthType(type);
                    setAuthField("");
                  }}
                />
              ))}
            </Group>
            {authType === "header"
              ? field(t("Header name"), authField, setAuthField, { placeholder: "X-Api-Key" })
              : authType === "basic"
                ? field(t("Username"), authField, setAuthField)
                : null}
          </>
        )}
        {item ? <KeySharing item={item} /> : null}
        {field(t("Key"), value, setValue, {
          secureTextEntry: true,
          autoComplete: "off",
          autoFocus: item !== null,
        })}
        <SpokenError>{error}</SpokenError>
      </ScrollView>
    </>
  );
}

/**
 * Who the owner shares one key with; each change saves itself. "Everyone" is the owner's explicit
 * choice and also covers people who join the space later.
 */
function KeySharing({ item }: { item: Key }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createVaultItemStyles);
  const [others, setOthers] = useState<Omit<VaultScreen, "vault"> | null>(null);
  const [share, setShare] = useState({ userIds: item.userIds, space: item.space });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    readSpacePeople().then(
      (read) => live && setOthers(read),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  async function save(next: typeof share) {
    const previous = share;
    setShare(next);
    setPending(true);
    setError(null);
    try {
      await rpc("vault/share", { name: item.name, ...next });
    } catch {
      setShare(previous);
      setError(t("Could not save"));
    } finally {
      setPending(false);
    }
  }

  if (!others || others.people.length === 0) return null;
  const everyone = t("Everyone in {space}", { space: others.space.name });
  return (
    <>
      <Group label={t("Shared with")}>
        <Row
          label={everyone}
          control={
            <InkSwitch
              accessibilityLabel={everyone}
              value={share.space}
              disabled={pending}
              onValueChange={(checked) => void save({ ...share, space: checked })}
            />
          }
        />
        {share.space
          ? null
          : others.people.map((member) => (
              <Row
                key={member.userId}
                leading={
                  <UserAvatar initials={userInitials(member.name)} image={member.image} size={28} />
                }
                label={member.name}
                control={
                  <InkSwitch
                    accessibilityLabel={member.name}
                    value={share.userIds.includes(member.userId)}
                    disabled={pending}
                    onValueChange={(checked) =>
                      void save({
                        ...share,
                        userIds: checked
                          ? [...share.userIds, member.userId]
                          : share.userIds.filter((id) => id !== member.userId),
                      })
                    }
                  />
                }
              />
            ))}
      </Group>
      {share.space ? (
        <Text style={styles.note}>
          {t(
            "Every current and future member of {space} can use this key on its site, from their bots and yours that you can see, including webhooks and routines.",
            { space: others.space.name },
          )}
        </Text>
      ) : share.userIds.length > 0 ? (
        <Text style={styles.note}>
          {t(
            "These people can use this key on its site, from their bots and yours that you can see, including webhooks and routines.",
          )}
        </Text>
      ) : null}
      <SpokenError>{error}</SpokenError>
    </>
  );
}

function createVaultItemStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 28 },
    field: { paddingHorizontal: 16, paddingVertical: 14 },
    input: { padding: 0, color: tokens.foreground, ...nativeTextStyle("composer") },
    delete: { alignSelf: "center", paddingVertical: 10, paddingHorizontal: 16 },
    deleteLabel: { color: tokens.destructive, ...nativeTextStyle("body") },
    pressed: { opacity: 0.6 },
    note: {
      paddingHorizontal: 16,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 14 }),
    },
  });
}
