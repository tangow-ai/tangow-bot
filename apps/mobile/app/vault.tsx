import type { BotSecretDestination, SharedVaultItem, VaultItem } from "@tangow/contracts";
import { filterVault, vaultInitial } from "@tangow/core";
import { radii, sizes } from "@tangow/ui-tokens";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Group, LoadFailed, LoadingRows, Row, useFocusedRead } from "../components/bot-page/kit";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { readVaultScreen, sharedWithLabel } from "../lib/vault";

export default function Vault() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createVaultStyles);
  const { read, retry } = useFocusedRead(readVaultScreen, []);
  const [query, setQuery] = useState("");
  const vault = read.kind === "ready" ? read.value.vault : null;
  const visible = vault && filterVault(vault, query);
  const hasItems = vault !== null && (vault.mine.length > 0 || vault.shared.length > 0);
  const open = (item?: VaultItem | SharedVaultItem) =>
    router.push({ pathname: "/vault-item", params: item ? { item: JSON.stringify(item) } : {} });

  const tile = (item: BotSecretDestination) => (
    <View
      style={styles.tile}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={styles.initial}>{vaultInitial(item)}</Text>
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          unstable_headerRightItems: () => [
            { type: "button", label: t("Add"), onPress: () => open() },
          ],
        }}
      />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {read.kind === "loading" ? (
          <LoadingRows />
        ) : read.kind === "failed" ? (
          <LoadFailed onRetry={retry} />
        ) : visible && hasItems ? (
          <>
            <TextInput
              accessibilityLabel={t("Search the vault")}
              placeholder={t("Search")}
              placeholderTextColor={tokens.mutedForeground}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
              style={styles.search}
            />
            {visible.mine.length === 0 && visible.shared.length === 0 ? (
              <Text style={styles.note} accessibilityLiveRegion="polite">
                {t("No match")}
              </Text>
            ) : null}
            <Group>
              {visible.mine.map((item) => (
                <Row
                  key={item.name}
                  leading={tile(item)}
                  label={item.name}
                  subline={[new URL(item.origin).host, sharedWithLabel(item, read.value.people)]
                    .filter(Boolean)
                    .join(" · ")}
                  chevron
                  onPress={() => open(item)}
                />
              ))}
            </Group>
            {visible.shared.length > 0 ? (
              <Group label={t("Shared with you")}>
                {visible.shared.map((item) => (
                  <Row
                    key={`${item.ownerName}:${item.name}:${item.origin}`}
                    leading={tile(item)}
                    label={item.name}
                    subline={`${new URL(item.origin).host} · ${item.ownerName}`}
                    chevron
                    onPress={() => open(item)}
                  />
                ))}
              </Group>
            ) : null}
          </>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{t("Nothing in your vault yet")}</Text>
            <Text style={styles.note}>{t("Add a key, or let a bot ask you for one.")}</Text>
          </View>
        )}
      </ScrollView>
    </>
  );
}

function createVaultStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 16 },
    search: {
      minHeight: sizes.mobileStack,
      borderRadius: radii.row,
      backgroundColor: tokens.muted,
      paddingHorizontal: 12,
      color: tokens.foreground,
      ...nativeTextStyle("body"),
    },
    empty: { alignItems: "center", paddingVertical: 32, paddingHorizontal: 16, gap: 8 },
    emptyTitle: { color: tokens.foreground, textAlign: "center", ...nativeTextStyle("body") },
    note: { color: tokens.mutedForeground, textAlign: "center", ...nativeTextStyle("meta") },
    tile: {
      width: sizes.message,
      height: sizes.message,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.row,
      backgroundColor: tokens.muted,
    },
    initial: { color: tokens.foreground, ...nativeTextStyle("label") },
  });
}
