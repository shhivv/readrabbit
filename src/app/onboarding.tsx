import { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  Easing,
} from "react-native-reanimated";
import { useRouter } from "expo-router";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";
import { colors, fonts, spacing } from "@/lib/theme";
import { PrimaryButton, TopicCard } from "@/lib/ui";
import { seedCatalogSources, kvSet, type Topic } from "@/lib/db";
import { runCrawl } from "@/lib/crawler/engine";
import { registerBackgroundCrawl } from "@/lib/background";

const GITHUB_URL = "https://github.com/shhivv/readrabbit";
const WEBSITE_URL = "https://readrabbit.one";
const ENTER = { duration: 420, easing: Easing.out(Easing.quad) };

const TOPIC_META: { id: Topic; label: string; blurb: string }[] = [
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
const STEP_TITLES = ["Welcome", "Topics", "About"] as const;

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
      <OnboardingHeader
        step={step}
        onBack={step > 0 && !starting ? () => setStep((s) => s - 1) : undefined}
      />

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
    </SafeAreaView>
  );
}

function OnboardingHeader({
  step,
  onBack,
}: {
  step: number;
  onBack?: () => void;
}) {
  return (
    <View style={styles.appHeader}>
      <View style={styles.headerSlot}>
        {onBack ? (
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onBack}
          >
            <Feather name="chevron-left" size={21} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.appHeaderTitle}>{STEP_TITLES[step]}</Text>
      <Text style={[styles.headerProgress, styles.headerSlot]}>
        {step + 1} / {STEPS.length}
      </Text>
    </View>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <View style={styles.step}>
      <View style={styles.centerBlock}>
        <Animated.Text
          entering={FadeIn.duration(500)}
          style={styles.sectionLabel}
        >
          YOUR PERSONAL READER
        </Animated.Text>
        <Animated.View
          entering={FadeIn.duration(600).delay(100)}
          style={styles.brandIcon}
        >
          <Image
            source={require("../../assets/images/icon.png")}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            accessible
            accessibilityLabel="ReadRabbit logo"
          />
        </Animated.View>
        <Animated.Text entering={FadeIn.duration(700)} style={styles.logo}>
          ReadRabbit
        </Animated.Text>
        <Animated.Text
          entering={FadeIn.duration(600).delay(250)}
          style={styles.tagline}
        >
          For the Naturally Curious
        </Animated.Text>
      </View>
      <PrimaryButton label="Get started" onPress={onNext} delay={500} />
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
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.intro}>
          <Text style={styles.sectionLabel}>CHOOSE YOUR FEED</Text>
          <Text style={styles.title}>What are you into?</Text>
          <Text style={styles.subtitle}>Pick any. All three works.</Text>
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
      </ScrollView>

      <PrimaryButton
        label="Continue"
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
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.intro}>
          <Text style={styles.sectionLabel}>PRIVATE BY DEFAULT</Text>
          <Text style={styles.title}>Built to stay yours</Text>
        </View>

        <Animated.View entering={FadeIn.duration(ENTER.duration)} style={styles.facts}>
          <FactRow icon="smartphone" text="Everything runs on this phone. No account, nothing leaves it." />
          <FactRow icon="rss" text="Thoughtful writing from independent blogs." />
          <FactRow icon="git-branch" text="Free and open source." />

          <Pressable
            style={({ pressed }) => [
              styles.githubRow,
              pressed && styles.rowPressed,
            ]}
            onPress={() => Linking.openURL(WEBSITE_URL)}
          >
            <Feather name="globe" size={15} color={colors.textTertiary} />
            <Text style={styles.githubLink}>readrabbit.one</Text>
            <Feather name="arrow-up-right" size={13} color={colors.textTertiary} />
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.githubRow,
              pressed && styles.rowPressed,
            ]}
            onPress={() => Linking.openURL(GITHUB_URL)}
          >
            <Feather name="github" size={15} color={colors.textTertiary} />
            <Text style={styles.githubLink}>shhivv/readrabbit</Text>
            <Feather name="arrow-up-right" size={13} color={colors.textTertiary} />
          </Pressable>
        </Animated.View>
      </ScrollView>

      <PrimaryButton
        label="Start reading"
        loading={starting}
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
      <View style={styles.factIcon}>
        <Feather name={iconFor[icon]} size={16} color={colors.textSecondary} />
      </View>
      <Text style={styles.factText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  appHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  appHeaderTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.text,
  },
  headerSlot: {
    width: 44,
  },
  headerProgress: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textTertiary,
    letterSpacing: 0.6,
    textAlign: "right",
  },
  step: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  centerBlock: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 14,
  },
  brandIcon: {
    width: 128,
    height: 128,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    backgroundColor: "#151515",
  },
  logo: {
    fontFamily: fonts.sansBold,
    fontSize: 42,
    lineHeight: 50,
    letterSpacing: -1.8,
    color: colors.text,
    textAlign: "center",
  },
  tagline: {
    fontSize: 15,
    lineHeight: 24,
    color: colors.textSecondary,
    textAlign: "center",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing.lg,
  },
  intro: {
    gap: 8,
    marginBottom: spacing.xl,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    color: colors.textTertiary,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 26,
    lineHeight: 34,
    color: colors.text,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.textSecondary,
  },
  topics: {
    gap: spacing.md,
  },
  facts: {
    gap: spacing.md,
  },
  factRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 72,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    backgroundColor: colors.bgRaised,
  },
  factIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgHover,
  },
  factText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 21,
    color: colors.textSecondary,
  },
  githubRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: colors.bgRaised,
  },
  rowPressed: {
    backgroundColor: colors.bgActive,
  },
  githubLink: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    color: colors.textSecondary,
  },
});
