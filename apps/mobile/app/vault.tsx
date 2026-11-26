import type { VaultItem } from "@tangow/contracts";
import { Stack, useRouter } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { Group, LoadFailed, LoadingRows, Row, useFocusedRead } from "../components/bot-page/kit";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { readVaultScreen, sharedWithLabel } from "../lib/vault";

/**
 * The person's credentials in this space, then the ones others share with them (read-only): name
 * and site; values are never read back.
 */
export default function Vault() {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createVaultStyles);
  const { read, retry } = useFocusedRead(readVaultScreen, []);
  const open = (item?: VaultItem) =>
    router.push({ pathname: "/vault-item", params: item ? { item: JSON.stringify(item) } : {} });

  return (
    <>
      <Stack.Screen
        options={{
          unstable_headerRightItems: () => [
            { type: "button", label: t("Add"), onPress: () => open() },
          ],
        }}
      />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {read.kind === "loading" ? (
          <LoadingRows />
        ) : read.kind === "failed" ? (
          <LoadFailed onRetry={retry} />
        ) : (
          <>
            <Group>
              {read.value.vault.mine.map((item) => (
                <Row
                  key={item.name}
                  label={item.name}
                  subline={[new URL(item.origin).host, sharedWithLabel(item, read.value.people)]
                    .filter(Boolean)
                    .join(" · ")}
                  chevron
                  onPress={() => open(item)}
                />
              ))}
            </Group>
            {read.value.vault.shared.length > 0 ? (
              <Group label={t("Shared with you")}>
                {read.value.vault.shared.map((item) => (
                  <Row
                    key={`${item.ownerName}:${item.name}:${item.origin}`}
                    label={item.name}
                    subline={`${new URL(item.origin).host} · ${item.ownerName}`}
                  />
                ))}
              </Group>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

function createVaultStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 28 },
  });
}
