import { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withDelay,
  withTiming,
  Easing,
  FadeIn,
} from "react-native-reanimated";
import { useRouter } from "expo-router";
import { colors, fonts, spacing } from "@/lib/theme";
import { TOPICS, seedCatalogSources, getDb, kvSet, type Topic } from "@/lib/db";
import { runCrawl } from "@/lib/crawler/engine";
import { registerBackgroundCrawl } from "@/lib/background";

const SPRING = { damping: 18, stiffness: 260 };

const TOPIC_META: Array<{ id: Topic; label: string; blurb: string }> = [
  {
    id: "technology",
    label: "technology",
    blurb: "systems, programming, security — the craft of building things",
  },
  {
    id: "economics",
    label: "economics",
    blurb: "markets, incentives, policy — how the world allocates",
  },
  {
    id: "math",
    label: "math",
    blurb: "proofs, patterns, problems — thinking in structures",
  },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<Topic>>(new Set());
  const [phase, setPhase] = useState<"pick" | "starting">("pick");

  const canBegin = selected.size > 0;

  function toggle(topic: Topic) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  }

  async function begin() {
    setPhase("starting");
    await seedCatalogSources([...selected]);
    await kvSet("onboarded", "1");
    registerBackgroundCrawl().catch(() => {});

    // entirely behind the scenes: the reader opens now and fills itself
    // from the database as enrichment lands
    runCrawl({ mode: "initial" }).catch(() => {});

    router.replace("/");
  }

  if (phase !== "pick") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.content, { justifyContent: "center", alignItems: "center" }]}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Animated.View entering={FadeIn.duration(700)} style={styles.header}>
          <Text style={styles.eyebrow}>naturally curious</Text>
          <Text style={styles.title}>
            what are you{"\n"}curious about?
          </Text>
          <Text style={styles.subtitle}>
            pick a few. your phone will go find the good
            stuff itself — small blogs, real people, no feed-bait.
          </Text>
        </Animated.View>

        <View style={styles.topics}>
          {TOPIC_META.map((meta, index) => (
            <TopicCard
              key={meta.id}
              label={meta.label}
              blurb={meta.blurb}
              active={selected.has(meta.id)}
              onPress={() => toggle(meta.id)}
              delay={200 + index * 120}
            />
          ))}
        </View>

        <View style={{ flex: 1 }} />

        <BeginButton enabled={canBegin} onPress={begin} />
      </View>
    </SafeAreaView>
  );
}

function TopicCard({
  label,
  blurb,
  active,
  onPress,
  delay,
}: {
  label: string;
  blurb: string;
  active: boolean;
  onPress: () => void;
  delay: number;
}) {
  const scale = useSharedValue(1);
  const border = useSharedValue(0);

  useEffect(() => {
    border.value = withSpring(active ? 1 : 0, SPRING);
  }, [active, border]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    borderColor:
      border.value > 0.5
        ? colors.accent
        : colors.border,
    backgroundColor:
      border.value > 0.5 ? "rgba(201, 168, 124, 0.07)" : colors.bgRaised,
  }));

  return (
    <Animated.View entering={FadeIn.duration(500).delay(delay).easing(Easing.out(Easing.quad))}>
      <Pressable
        onPressIn={() => (scale.value = withSpring(0.97, SPRING))}
        onPressOut={() => (scale.value = withSpring(1, SPRING))}
        onPress={onPress}
      >
        <Animated.View style={[styles.topicCard, cardStyle]}>
          <Text style={[styles.topicLabel, active && styles.topicLabelActive]}>
            {label}
          </Text>
          <Text style={styles.topicBlurb}>{blurb}</Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

function BeginButton({ enabled, onPress }: { enabled: boolean; onPress: () => void }) {
  const opacity = useSharedValue(enabled ? 1 : 0.35);
  useEffect(() => {
    opacity.value = withTiming(enabled ? 1 : 0.35, { duration: 200 });
  }, [enabled, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={style}>
      <Pressable
        disabled={!enabled}
        onPress={onPress}
        style={[styles.beginBtn, !enabled && styles.beginBtnDisabled]}
      >
        <Text style={styles.beginLabel}>start exploring</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  header: {
    gap: 12,
    marginBottom: spacing.xl + spacing.sm,
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: colors.accent,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 34,
    lineHeight: 42,
    color: colors.text,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 23,
    color: colors.textSecondary,
  },
  topics: {
    gap: spacing.md,
  },
  topicCard: {
    borderWidth: 1.5,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
    gap: 6,
  },
  topicLabel: {
    fontFamily: fonts.mono,
    fontSize: 13,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: colors.textSecondary,
  },
  topicLabelActive: {
    color: colors.accent,
  },
  topicBlurb: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textTertiary,
  },
  beginBtn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
  },
  beginBtnDisabled: {},
  beginLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    color: "#141414",
    letterSpacing: 0.3,
  },
  crawlContent: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  crawlTitle: {
    fontFamily: fonts.sans,
    fontSize: 17,
    color: colors.text,
    textAlign: "center",
  },
  crawlMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textTertiary,
    textAlign: "center",
    letterSpacing: 1,
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.bgActive,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
});
