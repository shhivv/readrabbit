import { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  FadeIn,
  Easing,
} from "react-native-reanimated";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { colors, fonts, spacing } from "@/lib/theme";
import { PrimaryButton, TopicCard } from "@/lib/ui";
import { TOPICS, seedCatalogSources, getDb, kvSet, type Topic } from "@/lib/db";
import { runCrawl } from "@/lib/crawler/engine";
import { registerBackgroundCrawl } from "@/lib/background";

const GITHUB_URL = "https://github.com/shhivv/naturallycurious";
const SPRING = { damping: 18, stiffness: 260 };
const ENTER = { duration: 420, easing: Easing.out(Easing.quad) };

const TOPIC_META: Array<{ id: Topic; label: string; blurb: string }> = [
  {
    id: "technology",
    label: "technology",
    blurb: "systems, programming, security",
  },
  {
    id: "economics",
    label: "economics",
    blurb: "markets, incentives, policy",
  },
  {
    id: "math",
    label: "math",
    blurb: "proofs, patterns, problems",
  },
];

const STEPS = ["welcome", "topics", "about"] as const;

export default function OnboardingScreen() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<Set<Topic>>(new Set());
  const [starting, setStarting] = useState(false);

  const canContinue = selected.size > 0;

  function toggle(topic: Topic) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  }

  async function begin() {
    setStarting(true);
    await seedCatalogSources([...selected]);
    await kvSet("topics", JSON.stringify([...selected]));
    await kvSet("onboarded", "1");
    registerBackgroundCrawl().catch(() => {});

    // entirely behind the scenes: the reader opens now and fills itself
    // from the database as articles land
    runCrawl({ mode: "initial" }).catch(() => {});

    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.container}>
      {step === 0 && (
        <WelcomeStep key="welcome" onNext={() => setStep(1)} />
      )}
      {step === 1 && (
        <TopicsStep
          key="topics"
          selected={selected}
          canContinue={canContinue}
          onToggle={toggle}
          onNext={() => setStep(2)}
        />
      )}
      {step === 2 && (
        <AboutStep key="about" starting={starting} onBegin={begin} />
      )}

      {step > 0 && !starting ? (
        <View style={styles.footerNav}>
          <Pressable hitSlop={12} onPress={() => setStep((s) => s - 1)}>
            <Text style={styles.backLabel}>back</Text>
          </Pressable>
          <View style={styles.dots}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i === step && styles.dotActive]}
              />
            ))}
          </View>
          <View style={{ width: 40 }} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <View style={styles.step}>
      <View style={styles.centerBlock}>
        <Animated.Text entering={FadeIn.duration(700)} style={styles.logo}>
          naturally curious
        </Animated.Text>
        <Animated.Text
          entering={FadeIn.duration(600).delay(250)}
          style={styles.tagline}
        >
          your phone reads small independent blogs,{"\n"}so you don't scroll big media
        </Animated.Text>
      </View>
      <PrimaryButton label="get started" onPress={onNext} delay={500} />
    </View>
  );
}

function TopicsStep({
  selected,
  canContinue,
  onToggle,
  onNext,
}: {
  selected: Set<Topic>;
  canContinue: boolean;
  onToggle: (t: Topic) => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.header}>
        <Text style={styles.title}>what are you into?</Text>
        <Text style={styles.subtitle}>pick any. all three works.</Text>
      </View>

      <Animated.View entering={FadeIn.duration(ENTER.duration)} style={styles.topics}>
        {TOPIC_META.map((meta) => (
          <TopicCard
            key={meta.id}
            label={meta.label}
            blurb={meta.blurb}
            active={selected.has(meta.id)}
            onPress={() => onToggle(meta.id)}
          />
        ))}
      </Animated.View>

      <View style={{ flex: 1 }} />

      <PrimaryButton
        label="continue"
        enabled={canContinue}
        onPress={onNext}
      />
    </View>
  );
}

function AboutStep({
  starting,
  onBegin,
}: {
  starting: boolean;
  onBegin: () => void;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.header}>
        <Text style={styles.title}>built to stay yours</Text>
      </View>

      <Animated.View entering={FadeIn.duration(ENTER.duration)} style={styles.facts}>
        <FactRow icon="smartphone" text="everything runs on this phone. no account, nothing leaves it." />
        <FactRow icon="rss" text="it reads small blogs by people, not outlets." />
        <FactRow icon="git-branch" text="free and open source." />

        <Pressable style={styles.githubRow} onPress={() => Linking.openURL(GITHUB_URL)}>
          <Feather name="github" size={15} color={colors.textSecondary} />
          <Text style={styles.githubLink}>shhivv/naturallycurious</Text>
          <Feather name="arrow-up-right" size={13} color={colors.textTertiary} />
        </Pressable>
      </Animated.View>

      <View style={{ flex: 1 }} />

      <PrimaryButton
        label={starting ? "opening..." : "start reading"}
        enabled={!starting}
        onPress={onBegin}
      />
    </View>
  );
}

function FactRow({ icon, text }: { icon: string; text: string }) {
  const iconFor: Record<string, keyof typeof Feather.glyphMap> = {
    smartphone: "smartphone",
    rss: "rss",
    "git-branch": "git-branch",
  };
  return (
    <View style={styles.factRow}>
      <Feather name={iconFor[icon]} size={16} color={colors.textTertiary} />
      <Text style={styles.factText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  step: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  centerBlock: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 18,
  },
  logo: {
    fontFamily: fonts.logo,
    fontSize: 58,
    lineHeight: 74,
    color: colors.text,
    textAlign: "center",
  },
  tagline: {
    fontSize: 14,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: "center",
  },
  header: {
    gap: 8,
    marginBottom: spacing.xl,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 30,
    lineHeight: 38,
    color: colors.text,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
  },
  topics: {
    gap: spacing.md,
  },
  facts: {
    gap: spacing.lg,
  },
  factRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    paddingRight: spacing.sm,
  },
  factText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 23,
    color: colors.text,
  },
  githubRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.bgRaised,
  },
  githubLink: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    color: colors.textSecondary,
  },
  footerNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  backLabel: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
    color: colors.textTertiary,
  },
  dots: {
    flexDirection: "row",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  dotActive: {
    backgroundColor: colors.text,
  },
});
