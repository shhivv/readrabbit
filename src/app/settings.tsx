import { useEffect, useState } from "react";
import { StyleSheet, Text, View, Pressable, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { colors, fonts, spacing } from "@/lib/theme";
import {
  TOPICS,
  seedCatalogSources,
  getDb,
  kvGet,
  kvSet,
  type Topic,
} from "@/lib/db";
import { refreshIfNeeded } from "@/lib/crawler/engine";
import { TopicCard, PrimaryButton } from "@/lib/ui";

const GITHUB_URL = "https://github.com/shhivv/naturallycurious";

const BLURBS: Record<Topic, string> = {
  technology: "systems, programming, security",
  economics: "markets, incentives, policy",
  math: "proofs, patterns, problems",
};

export default function SettingsScreen() {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<Topic>>(new Set());
  const [saved, setSaved] = useState<Set<Topic>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await kvGet("topics");
        if (raw) {
          const list = JSON.parse(raw) as Topic[];
          setSelected(new Set(list));
          setSaved(new Set(list));
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const dirty =
    !loading &&
    (selected.size !== saved.size ||
      [...selected].some((t) => !saved.has(t)));

  function toggle(t: Topic) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const added = [...selected].filter((t) => !saved.has(t));
      const removed = [...saved].filter((t) => !selected.has(t));

      if (added.length > 0) {
        await seedCatalogSources(added);
      }
      if (removed.length > 0) {
        const db = await getDb();
        for (const topic of removed) {
          // stop fetching that topic's seeds and pull their unread posts
          // from the stream. Bookmarks stay. Re-adding a topic later starts
          // a fresh crawl; old archived posts stay archived.
          await db.runAsync(
            "UPDATE sources SET status = 'dead' WHERE origin = 'seed' AND topic = ?",
            [topic]
          );
          await db.runAsync(
            "UPDATE articles SET is_archived = 1 WHERE topic = ? AND is_read = 0 AND is_bookmarked = 0",
            [topic]
          );
        }
      }

      await kvSet("topics", JSON.stringify([...selected]));
      setSaved(new Set(selected));
      refreshIfNeeded().catch(() => {});
    } finally {
      setSaving(false);
      router.back();
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable hitSlop={12} onPress={() => router.back()}>
          <Feather name="x" size={20} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.title}>settings</Text>
        <View style={{ width: 20 }} />
      </View>

      {loading ? null : (
        <Animated.View entering={FadeIn.duration(300)} style={styles.body}>
          <Text style={styles.sectionLabel}>topics</Text>
          <View style={styles.topics}>
            {TOPICS.map((t) => (
              <TopicCard
                key={t}
                label={t}
                blurb={BLURBS[t]}
                active={selected.has(t)}
                onPress={() => toggle(t)}
              />
            ))}
          </View>
          <Text style={styles.hint}>
            removed topics stop updating and leave the stream.
          </Text>

          <View style={{ flex: 1 }} />

          <View style={styles.about}>
            <Text style={styles.aboutLine}>naturally curious v0.1.0</Text>
            <Pressable
              style={styles.githubRow}
              onPress={() => Linking.openURL(GITHUB_URL)}
            >
              <Feather name="github" size={14} color={colors.textTertiary} />
              <Text style={styles.githubLink}>shhivv/naturallycurious</Text>
              <Feather
                name="arrow-up-right"
                size={12}
                color={colors.textTertiary}
              />
            </Pressable>
          </View>

          <PrimaryButton
            label={saving ? "saving..." : dirty ? "save changes" : "saved"}
            enabled={dirty && !saving}
            onPress={save}
          />
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.text,
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: colors.textTertiary,
    marginBottom: spacing.md,
  },
  topics: {
    gap: spacing.md,
  },
  hint: {
    marginTop: spacing.md,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textTertiary,
  },
  about: {
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  aboutLine: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.textTertiary,
  },
  githubRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: colors.bgRaised,
  },
  githubLink: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textSecondary,
  },
});
