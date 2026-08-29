import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { PostHogProvider, usePostHog } from "posthog-react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { colors } from "@/lib/theme";
import { allFonts } from "@/lib/fonts";
import { getDb, kvGet } from "@/lib/db";
import { setPostHogClient } from "@/lib/analytics";

SplashScreen.preventAutoHideAsync();

function RootInner() {
  const [fontsLoaded] = useFonts(allFonts());
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const segments = useSegments();
  const posthog = usePostHog();

  useEffect(() => {
    setPostHogClient(posthog);
  }, [posthog]);

  useEffect(() => {
    if (!fontsLoaded) return;
    (async () => {
      try {
        await getDb();
      } catch {
        // db failures surface later per-screen; don't brick the shell
      }
      SplashScreen.hideAsync().catch(() => {});
      setReady(true);
    })();
  }, [fontsLoaded]);

  // Gate on the persisted flag, re-read on every route change — never on
  // cached state, or onboarding's own transition gets bounced back.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      let isOnboarded = false;
      try {
        const flag = await kvGet("onboarded");
        isOnboarded = flag === "1";
      } catch {
        isOnboarded = false;
      }
      if (cancelled) return;
      const inOnboarding = segments[0] === "onboarding";
      if (!isOnboarded && !inOnboarding) {
        router.replace("/onboarding");
      } else if (isOnboarded && inOnboarding) {
        router.replace("/");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, segments, router]);

  if (!ready || !fontsLoaded) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="onboarding" />
        <Stack.Screen
          name="settings"
          options={{ presentation: "modal", animation: "slide_from_bottom" }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <PostHogProvider
      apiKey="phc_qYDxC6W2enKfznFfoBqksn9QFwWa3X4PcWxJs6g77Ckm"
      options={{
        host: "https://us.i.posthog.com",
        // Keep analytics session-scoped and deliberately non-identifying.
        persistence: "memory",
        personProfiles: "never",
        disableGeoip: true,
        captureAppLifecycleEvents: false,
        setDefaultPersonProperties: false,
        customAppProperties: (properties) => ({
          $app_build: properties.$app_build,
          $app_version: properties.$app_version,
        }),
      }}
      autocapture={{
        captureScreens: false,
        captureTouches: false,
      }}
    >
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
          <RootInner />
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </PostHogProvider>
  );
}
