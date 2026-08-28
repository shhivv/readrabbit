import { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  Linking,
  ScrollView,
} from "react-native";
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
  getBookmarkedArticles,
  getMutedAuthors,
  unmuteAuthor,
  type Topic,
  type ArticleRow,
  type MutedAuthorRow,
} from "@/lib/db";
import { getArticleAttribution } from "@/lib/attribution";
import { runCrawl } from "@/lib/crawler/engine";
import { PrimaryButton, TopicCard } from "@/lib/ui";
import { capture } from "@/lib/analytics";

const GITHUB_URL = "https://github.com/shhivv/readrabbit";
const WEBSITE_URL = "https://readrabbit.one";

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
  const [bookmarks, setBookmarks] = useState<
    Pick<ArticleRow, "id" | "title" | "author" | "site_name" | "url">[]
  >([]);
  const [mutedAuthors, setMutedAuthors] = useState<MutedAuthorRow[]>([]);
  const [unmuting, setUnmuting] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const raw = await kvGet("topics");
        if (raw) {
          const list = JSON.parse(raw) as Topic[];
          setSelected(new Set(list));
          setSaved(new Set(list));
        }
        setBookmarks(await getBookmarkedArticles());
        setMutedAuthors(await getMutedAuthors());
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
        const db = await getDb();
        for (const topic of added) {
          // Resume every source the user paused for this topic, including
          // community-discovered blogs—not only the fixed catalog.
          await db.runAsync(
            `UPDATE sources
             SET status = 'active', consecutive_failures = 0, next_check_at = 0
             WHERE status = 'paused' AND topic = ?`,
            [topic]
          );
        }
        await seedCatalogSources(added);
      }
      if (removed.length > 0) {
        const db = await getDb();
        for (const topic of removed) {
          // stop fetching every source for that topic (including community
          // aggregators and discovered blogs) and pull unread posts
          // from the stream. Bookmarks stay. Re-adding a topic later starts
          // a fresh crawl; old archived posts stay archived.
          await db.runAsync(
            "UPDATE sources SET status = 'paused' WHERE topic = ?",
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
      capture("topics_updated", { topics: [...selected] });
      // A preference change is explicit user intent, so bypass the ordinary
      // four-hour refresh throttle. The mounted reader will rebuild on focus
      // while this crawl starts filling any newly selected topic.
      runCrawl({ mode: "background" }).catch(() => {});
    } finally {
      setSaving(false);
      router.back();
    }
  }

  async function handleUnmute(authorKey: string) {
    setUnmuting((current) => new Set(current).add(authorKey));
    try {
      await unmuteAuthor(authorKey);
      setMutedAuthors((current) =>
        current.filter((author) => author.author_key !== authorKey)
      );
    } finally {
      setUnmuting((current) => {
        const next = new Set(current);
        next.delete(authorKey);
        return next;
      });
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable hitSlop={12} onPress={() => router.back()}>
          <Feather name="x" size={20} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 20 }} />
      </View>

      {loading ? null : (
        <Animated.View entering={FadeIn.duration(300)} style={styles.body}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.sectionLabel}>Topics</Text>
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

            {bookmarks.length > 0 ? (
              <>
                <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>
                  Bookmarks
                </Text>
                <View style={styles.topics}>
                  {bookmarks.map((bookmark) => {
                    const attribution = getArticleAttribution(bookmark);
                    return (
                      <Pressable
                        key={bookmark.id}
                        style={styles.bookmarkRow}
                        onPress={() => Linking.openURL(bookmark.url)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={styles.bookmarkTitle} numberOfLines={2}>
                            {bookmark.title}
                          </Text>
                          {attribution.primary ? (
                            <Text style={styles.bookmarkSite}>
                              {attribution.primary}
                            </Text>
                          ) : null}
                        </View>
                        <Feather
                          name="arrow-up-right"
                          size={14}
                          color={colors.textTertiary}
                        />
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            {mutedAuthors.length > 0 ? (
              <>
                <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>
                  Muted authors
                </Text>
                <View style={styles.topics}>
                  {mutedAuthors.map((author) => (
                    <View key={author.author_key} style={styles.mutedAuthorRow}>
                      <View style={styles.mutedAuthorIdentity}>
                        <Feather
                          name="user-x"
                          size={15}
                          color={colors.textTertiary}
                        />
                        <Text style={styles.mutedAuthorName} numberOfLines={1}>
                          {author.display_name}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityLabel={`Unmute ${author.display_name}`}
                        accessibilityRole="button"
                        disabled={unmuting.has(author.author_key)}
                        hitSlop={8}
                        onPress={() => handleUnmute(author.author_key)}
                        style={({ pressed }) => [
                          styles.unmuteButton,
                          pressed && styles.unmuteButtonPressed,
                        ]}
                      >
                        <Text style={styles.unmuteLabel}>
                          {unmuting.has(author.author_key) ? "…" : "Unmute"}
                        </Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            <View style={styles.about}>
              <Text style={styles.aboutLine}>ReadRabbit v0.1.0</Text>
              <Pressable
                style={styles.githubRow}
                onPress={() => Linking.openURL(WEBSITE_URL)}
              >
                <Feather name="globe" size={14} color={colors.textTertiary} />
                <Text style={styles.githubLink}>readrabbit.one</Text>
                <Feather
                  name="arrow-up-right"
                  size={12}
                  color={colors.textTertiary}
                />
              </Pressable>
              <Pressable
                style={styles.githubRow}
                onPress={() => Linking.openURL(GITHUB_URL)}
              >
                <Feather name="github" size={14} color={colors.textTertiary} />
                <Text style={styles.githubLink}>shhivv/readrabbit</Text>
                <Feather
                  name="arrow-up-right"
                  size={12}
                  color={colors.textTertiary}
                />
              </Pressable>
            </View>
          </ScrollView>

          <View style={styles.saveArea}>
            {dirty || saving ? (
              <PrimaryButton
                label="Save changes"
                loading={saving}
                onPress={save}
              />
            ) : (
              <View
                accessibilityLabel="All changes saved"
                accessibilityRole="text"
                style={styles.savedStatus}
              >
                <Feather name="check" size={15} color={colors.textTertiary} />
                <Text style={styles.savedStatusLabel}>All changes saved</Text>
              </View>
            )}
          </View>
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
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.text,
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
  },
  saveArea: {
    minHeight: 52,
    justifyContent: "center",
  },
  savedStatus: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  savedStatusLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textTertiary,
    letterSpacing: 0.4,
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
  scrollContent: {
    paddingBottom: spacing.lg,
  },
  bookmarkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.bgRaised,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  bookmarkTitle: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  bookmarkSite: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 3,
  },
  mutedAuthorRow: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    backgroundColor: colors.bgRaised,
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
  mutedAuthorIdentity: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  mutedAuthorName: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.text,
  },
  unmuteButton: {
    borderRadius: 10,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  unmuteButtonPressed: {
    backgroundColor: colors.bgActive,
  },
  unmuteLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.accent,
  },
  about: {
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.xxl,
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
