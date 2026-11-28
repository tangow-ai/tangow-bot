import * as Notifications from "expo-notifications";
import {
  DarkTheme,
  Stack,
  ThemeProvider,
  useGlobalSearchParams,
  usePathname,
  useRouter,
} from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ComputerUpdateProgress } from "../components/computer-update-progress";
import { currentApiBase, loadApiBase, loadSessionToken, selectedSpaceId } from "../lib/api";
import { loadAppearancePreference, mobileTokens } from "../lib/appearance";
import { useChatReducedMotion } from "../lib/chat-motion";
import { loadDebugMode } from "../lib/debug-mode";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import {
  configureForegroundNotifications,
  destinationIsOnScreen,
  notificationDestination,
  resumeLiveNotifications,
} from "../lib/live-notifications";
import { native, useResolvedAppearance } from "../lib/native";

configureForegroundNotifications();

// Keep the native splash up until the app is ready (see `Layout`).
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function Layout() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const resolved = useResolvedAppearance();
  const reducedMotion = useChatReducedMotion();
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const notificationResponse = Notifications.useLastNotificationResponse();
  const navigationTheme = useMemo(() => {
    const tokens = mobileTokens();
    return {
      ...DarkTheme,
      dark: resolved === "dark",
      colors: {
        ...DarkTheme.colors,
        background: tokens.background,
        card: tokens.background,
        text: tokens.foreground,
        border: tokens.border,
        primary: tokens.primary,
        notification: tokens.foreground,
      },
    };
  }, [resolved]);

  useEffect(() => {
    void Promise.all([
      Promise.all([loadApiBase(), loadAppearancePreference()])
        .then(async () =>
          resumeLiveNotifications(
            currentApiBase(),
            await loadSessionToken(),
            selectedSpaceId() ?? "",
          ),
        )
        .catch(() => undefined),
      bootstrapI18n(),
      loadDebugMode(),
    ]).finally(() => setReady(true));
  }, []);

  // A tapped push, cold start included, opens the conversation it came from once the
  // stack exists; clearing it keeps a later remount from replaying the same tap. The
  // route is read through a ref so navigating does not rerun this for the same tap.
  const currentRoute = useRef({ pathname, params });
  currentRoute.current = { pathname, params };
  useEffect(() => {
    if (!ready || !notificationResponse) return;
    if (notificationResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    Notifications.clearLastNotificationResponse();
    const destination = notificationDestination(
      notificationResponse.notification.request.content.data,
    );
    const { pathname: onScreen, params: onScreenParams } = currentRoute.current;
    if (destination && !destinationIsOnScreen(destination, onScreen, onScreenParams)) {
      router.push(destination);
    }
  }, [notificationResponse, ready, router]);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        {ready ? (
          <ThemeProvider value={navigationTheme}>
            <StatusBar style={resolved === "light" ? "dark" : "light"} />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: navigationTheme.colors.background },
                headerTintColor: navigationTheme.colors.text,
                headerShadowVisible: false,
                headerBackButtonDisplayMode: "minimal",
                contentStyle: { backgroundColor: String(native.page) },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false, title: "Tangow" }} />
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              <Stack.Screen
                name="integration-setup"
                options={{ title: t("Server integrations") }}
              />
              <Stack.Screen name="account" options={{ title: t("Settings") }} />
              <Stack.Screen name="profile" options={{ title: t("Account") }} />
              <Stack.Screen
                name="change-password"
                options={{
                  title: t("Change password"),
                  presentation: "formSheet",
                  sheetAllowedDetents: [0.6, 1],
                  sheetGrabberVisible: true,
                }}
              />
              <Stack.Screen
                name="edit-bot-proposal"
                options={{
                  title: "",
                  presentation: "formSheet",
                  sheetAllowedDetents: [0.6, 1],
                  sheetGrabberVisible: true,
                }}
              />
              <Stack.Screen
                name="edit-draft"
                options={{
                  title: t("Edit message"),
                  presentation: "formSheet",
                  sheetAllowedDetents: [0.6, 1],
                  sheetGrabberVisible: true,
                }}
              />
              <Stack.Screen
                name="sheet"
                options={{
                  headerShown: false,
                  presentation: "formSheet",
                  sheetAllowedDetents: "fitToContents",
                  sheetGrabberVisible: true,
                }}
              />
              <Stack.Screen name="providers" options={{ title: t("Providers") }} />
              <Stack.Screen name="models" options={{ title: t("Models") }} />
              <Stack.Screen name="usage" options={{ title: t("Usage") }} />
              <Stack.Screen name="computer-settings" options={{ title: t("Computer") }} />
              <Stack.Screen name="voice" options={{ title: t("Voice") }} />
              <Stack.Screen name="integrations" options={{ title: t("Integrations") }} />
              <Stack.Screen name="custom-apps" options={{ title: t("Custom apps") }} />
              <Stack.Screen name="skills" options={{ title: t("Skills") }} />
              <Stack.Screen name="vault" options={{ title: t("Vault") }} />
              <Stack.Screen
                name="vault-item"
                options={{
                  presentation: "formSheet",
                  sheetAllowedDetents: [1],
                  sheetGrabberVisible: true,
                }}
              />
              <Stack.Screen
                name="new"
                options={{
                  title: t("New bot"),
                  presentation: "modal",
                  gestureEnabled: true,
                  headerBackVisible: false,
                }}
              />
              <Stack.Screen
                name="new-group"
                options={{
                  title: t("New group"),
                  presentation: "modal",
                  gestureEnabled: true,
                }}
              />
              <Stack.Screen
                name="new-space"
                options={{
                  title: t("New space"),
                  presentation: "modal",
                  gestureEnabled: true,
                  headerBackVisible: false,
                }}
              />
              <Stack.Screen name="group-thread" options={{ title: t("Group") }} />
              <Stack.Screen name="group-settings" options={{ title: t("Group settings") }} />
              <Stack.Screen
                name="bot"
                options={{
                  title: "",
                  headerBackTitle: t("Chat"),
                  headerBackButtonDisplayMode: "default",
                }}
              />
              <Stack.Screen
                name="bot-text"
                options={{ presentation: "fullScreenModal", gestureEnabled: false }}
              />
              <Stack.Screen
                name="image-viewer"
                options={{
                  presentation: "fullScreenModal",
                  headerShown: false,
                  contentStyle: { backgroundColor: mobileTokens().mediaBackdrop },
                  animation: reducedMotion ? "fade" : "default",
                }}
              />
              <Stack.Screen name="bot-routine" />
              <Stack.Screen name="bot-routine-new" options={{ title: t("New routine") }} />
              <Stack.Screen name="bot-model" options={{ title: t("Model") }} />
              <Stack.Screen name="bot-voice" options={{ title: t("Voice and replies") }} />
              <Stack.Screen name="bot-choice" options={{ title: "" }} />
              <Stack.Screen
                name="bot-appearance"
                options={{
                  title: t("Appearance"),
                  presentation: "formSheet",
                  sheetAllowedDetents: "fitToContents",
                  sheetGrabberVisible: true,
                  headerShown: false,
                }}
              />
              <Stack.Screen name="bot-memory" options={{ presentation: "modal" }} />
              <Stack.Screen name="bot-share" options={{ presentation: "modal" }} />
              <Stack.Screen name="bot-skill" />
              <Stack.Screen name="bot-files" options={{ title: t("Files") }} />
              <Stack.Screen name="bot-file" options={{ title: t("Files") }} />
              <Stack.Screen name="thread" options={{ title: t("Thread") }} />
              <Stack.Screen name="peer-messages" options={{ title: t("Bot chat") }} />
              <Stack.Screen name="computer" options={{ title: t("Computer") }} />
            </Stack>
            <ComputerUpdateProgress />
          </ThemeProvider>
        ) : null}
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
