import { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  Share,
  ActivityIndicator,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withSequence,
  withRepeat,
  withDelay,
  interpolate,
  runOnJS,
  FadeIn,
  Easing,
} from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";
import RenderHtml from "react-native-render-html";
import { Image as ExpoImage } from "expo-image";
import { parseHTML } from "linkedom";
import { useFocusEffect, useRouter } from "expo-router";

import {
  getArticleById,
  getInterestIndices,
  markRead,
  archiveArticle,
  muteAuthor,
  setBookmarked,
  toggleInterest,
  kvGet,
  kvSet,
  type ArticleRow,
} from "@/lib/db";
import { getArticleAttribution } from "@/lib/attribution";
import {
  loadDiverseOpeningDeque,
  loadDeque,
  topUpDeque,
  LOW_WATER,
} from "@/lib/deque";
import { refreshIfNeeded } from "@/lib/crawler/engine";
import { CodeBlock } from "@/lib/code";
import { colors, fonts, spacing } from "@/lib/theme";
import { capture } from "@/lib/analytics";

const SPRING_CONFIG = { damping: 20, stiffness: 300, mass: 0.8 };
const ENTER_DURATION = 500;
const ENTER_EASE = Easing.out(Easing.exp);
const OVERFLOW_BUTTON_SIZE = 44;
const SWIPE_ACTIVATION_DISTANCE = 20;
const SWIPE_COMMIT_DISTANCE = 60;
const SWIPE_FLICK_VELOCITY = 500;
const BOOKMARK_BLUE = "#4da3ff";
const DIVERSE_OPENING_READY_KEY = "diverse_opening_ready_v1";
const DIVERSE_OPENING_MAX_WAIT_MS = 15_000;

// ---------- article model ----------

interface Segment {
  index: number;
  html: string;
  code?: { text: string; lang: string | null };
}

interface HydratedArticle {
  row: ArticleRow;
  segments: Segment[];
  likedIndices: Set<number>;
}

const HYDRATION_CACHE_LIMIT = 24;
const hydrationCache = new Map<number, HydratedArticle>();

function touchCache(id: number, value: HydratedArticle) {
  hydrationCache.delete(id);
  hydrationCache.set(id, value);
  while (hydrationCache.size > HYDRATION_CACHE_LIMIT) {
    const oldest = hydrationCache.keys().next().value;
    if (oldest == null) break;
    hydrationCache.delete(oldest);
  }
}

// Split sanitized content into top-level reading segments (for tap-to-heart),
// normalizing pre-rendered katex wrappers into plain tags along the way.
function splitSegments(contentHtml: string): Segment[] {
  try {
    const { document } = parseHTML(`<html><body>${contentHtml}</body></html>`);

    // nc-math → display: div.nc-katex-display / inline: unwrap children
    for (const node of Array.from(document.querySelectorAll("nc-math"))) {
      const display = node.getAttribute("data-nc-display") === "1";
      const parent = node.parentElement;
      if (!parent) continue;
      if (display) {
        const holder = document.createElement("div");
        holder.setAttribute("class", "nc-katex-display");
        while (node.firstChild) holder.appendChild(node.firstChild);
        node.replaceWith(holder);
      } else {
        while (node.firstChild) {
          parent.insertBefore(node.firstChild, node);
        }
        node.remove();
      }
    }

    const segments: Segment[] = [];
    let index = 0;
    for (const el of Array.from(document.body.children)) {
      const tag = el.tagName.toLowerCase();
      if (tag === "pre") {
        // code blocks render through the dedicated highlighter, not
        // RenderHtml (which collapses whitespace inside pre)
        segments.push({
          index,
          html: "",
          code: {
            text: el.textContent ?? "",
            lang: el.getAttribute("data-nc-lang"),
          },
        });
        index++;
        if (index >= 250) break;
      } else if (
        tag === "p" ||
        tag === "blockquote" ||
        tag === "h1" ||
        tag === "h2" ||
        tag === "h3" ||
        tag === "h4" ||
        tag === "ul" ||
        tag === "ol" ||
        tag === "figure" ||
        tag === "table"
      ) {
        const html = el.outerHTML ?? "";
        if (html.trim()) {
          segments.push({ index, html });
          index++;
        }
        if (index >= 250) break;
      }
    }
    return segments;
  } catch {
    return [];
  }
}

async function hydrate(id: number): Promise<HydratedArticle | null> {
  const cached = hydrationCache.get(id);
  if (cached) {
    touchCache(id, cached);
    return cached;
  }
  const row = await getArticleById(id);
  if (!row || !row.content_html) return null;
  const likedIndices = await getInterestIndices(id);
  const segments = splitSegments(row.content_html);
  // segments carry everything the reader renders; the raw payloads would
  // otherwise sit in the LRU (~360KB/article x 24) for no benefit
  row.content_html = "";
  row.text_content = "";
  const value: HydratedArticle = {
    row,
    segments,
    likedIndices,
  };
  touchCache(id, value);
  return value;
}

// ---------- formatting helpers ----------

function decodeEntities(str: string): string {
  return str.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g,
    (match, dec, hex, named) => {
      if (dec) return String.fromCharCode(parseInt(dec, 10));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      const entities: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        nbsp: " ",
        apos: "'",
      };
      return entities[named] ?? match;
    },
  );
}

function formatDate(ms: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function readTime(wordCount: number): string {
  const minutes = Math.max(1, Math.round(wordCount / 220));
  return `${minutes} min read`;
}

// ---------- html styling ----------

const bodyColor = "#c4c0bb";

const baseTagsStyles = {
  body: {
    color: bodyColor,
    fontFamily: fonts.sans,
    fontSize: 18,
    lineHeight: 32,
  },
  h1: { fontFamily: fonts.sansBold, fontSize: 24, color: colors.text },
  h2: { fontFamily: fonts.sansBold, fontSize: 21, color: colors.text },
  h3: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.text },
  h4: { fontFamily: fonts.sansBold, fontSize: 17, color: colors.text },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    paddingLeft: 16,
    fontStyle: "italic" as const,
    color: colors.textSecondary,
  },
  img: { borderRadius: 10 },
  pre: {
    backgroundColor: colors.bgRaised,
    borderRadius: 8,
    padding: 14,
    fontFamily: fonts.mono,
    fontSize: 13.5,
    lineHeight: 22,
    color: "#d5d0c9",
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 14,
    backgroundColor: colors.bgRaised,
  },
  li: { color: colors.text },
  a: {
    color: colors.accentHover,
    textDecorationLine: "underline" as const,
    textDecorationColor: colors.border,
  },
};

// KaTeX output uses class names instead of inline styles (we strip those);
// map them onto the bundled KaTeX TTFs.
const katexClassStyles = {
  mathnormal: { fontFamily: "Katex-Math-Italic" },
  mathdefault: { fontFamily: "Katex-Math-Italic" },
  mathit: { fontFamily: "Katex-Main-Italic" },
  textit: { fontFamily: "Katex-Main-Italic" },
  mathbf: { fontFamily: "Katex-Main-Bold" },
  boldsymbol: { fontFamily: "Katex-Main-Bold" },
  amsrm: { fontFamily: "Katex-Ams" },
  mord: { fontFamily: "Katex-Main" },
  mbin: { fontFamily: "Katex-Main" },
  mrel: { fontFamily: "Katex-Main" },
  mopen: { fontFamily: "Katex-Main" },
  mclose: { fontFamily: "Katex-Main" },
  mpunct: { fontFamily: "Katex-Main" },
  minner: { fontFamily: "Katex-Main" },
  delimsizing: { fontFamily: "Katex-Main" },
  size1: { fontFamily: "Katex-Size1" },
  size2: { fontFamily: "Katex-Size2" },
  size3: { fontFamily: "Katex-Size3" },
  size4: { fontFamily: "Katex-Size4" },
  "nc-katex-display": {
    width: "100%" as const,
    marginBottom: 10,
    marginTop: 6,
  },
};

const domVisitors = {
  onElement: (el: any) => {
    if (el.name === "img") {
      const src = el.attribs?.src || "";
      if (!src.startsWith("http://") && !src.startsWith("https://")) {
        el.attribs = { ...el.attribs, src: "" };
        el.name = "span";
      }
    }
  },
};

// ---------- small components ----------

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function HeartBadge({ liked }: { liked: boolean }) {
  const scale = useSharedValue(liked ? 1 : 0);
  const opacity = useSharedValue(liked ? 1 : 0);

  useEffect(() => {
    if (liked) {
      scale.value = withSequence(
        withSpring(1.35, { damping: 8, stiffness: 420, mass: 0.4 }),
        withSpring(1, SPRING_CONFIG),
      );
      opacity.value = withTiming(1, { duration: 120 });
    } else {
      opacity.value = withTiming(0, { duration: 140 });
      scale.value = withTiming(0, { duration: 140 });
    }
  }, [liked, scale, opacity]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[styles.heartBadge, style]}>
      <Feather name="heart" size={11} color={colors.like} />
    </Animated.View>
  );
}

function TappableParagraph({
  segment,
  articleId,
  liked,
  contentWidth,
  enterDelay,
}: {
  segment: Segment;
  articleId: number;
  liked: boolean;
  contentWidth: number;
  enterDelay: number;
}) {
  const [isLiked, setIsLiked] = useState(liked);
  const bgOpacity = useSharedValue(liked ? 0.06 : 0);
  const lineScale = useSharedValue(liked ? 1 : 0);
  const lastTap = useRef(0);

  const enterOpacity = useSharedValue(0);
  const enterY = useSharedValue(8);

  useEffect(() => {
    enterOpacity.value = withDelay(
      enterDelay,
      withTiming(1, { duration: ENTER_DURATION, easing: ENTER_EASE }),
    );
    enterY.value = withDelay(
      enterDelay,
      withTiming(0, { duration: ENTER_DURATION, easing: ENTER_EASE }),
    );
  }, [enterDelay, enterOpacity, enterY]);

  const animatedBg = useAnimatedStyle(() => ({
    backgroundColor: `rgba(255, 92, 138, ${bgOpacity.value})`,
    opacity: enterOpacity.value,
    transform: [{ translateY: enterY.value }],
  }));

  const lineStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: lineScale.value }],
    opacity: lineScale.value,
  }));

  function handlePress() {
    const now = Date.now();
    if (now - lastTap.current < 350) {
      const next = !isLiked;
      setIsLiked(next);
      if (next) {
        bgOpacity.value = withSequence(
          withTiming(0.14, { duration: 150 }),
          withTiming(0.06, { duration: 500, easing: Easing.out(Easing.quad) }),
        );
        lineScale.value = withSpring(1, SPRING_CONFIG);
      } else {
        bgOpacity.value = withTiming(0, { duration: 200 });
        lineScale.value = withSpring(0, SPRING_CONFIG);
      }
      toggleInterest(articleId, segment.index, "").catch(() => {});

      // keep the hydration cache in sync for revisits
      const cached = hydrationCache.get(articleId);
      if (cached) {
        const next = new Set(cached.likedIndices);
        if (next.has(segment.index)) next.delete(segment.index);
        else next.add(segment.index);
        touchCache(articleId, { ...cached, likedIndices: next });
      }
    }
    lastTap.current = now;
  }

  return (
    <Pressable onPress={handlePress}>
      <Animated.View style={[styles.paragraph, animatedBg]}>
        <RenderHtml
          contentWidth={contentWidth}
          source={{ html: `<body>${segment.html}</body>` }}
          tagsStyles={baseTagsStyles}
          classesStyles={katexClassStyles}
          domVisitors={domVisitors}
          systemFonts={[
            "Geist",
            "Geist-Bold",
            "Geist-Mono",
            "Katex-Main",
            "Katex-Main-Bold",
            "Katex-Main-Italic",
            "Katex-Math-Italic",
            "Katex-Ams",
            "Katex-Size1",
            "Katex-Size2",
            "Katex-Size3",
            "Katex-Size4",
          ]}
          defaultTextProps={{ selectable: true }}
        />
        <Animated.View style={[styles.tappedLine, lineStyle]} />
        <HeartBadge liked={isLiked} />
      </Animated.View>
    </Pressable>
  );
}

function FadeImage({ uri, style }: { uri: string; style: any }) {
  return (
    <ExpoImage
      source={{ uri }}
      style={style}
      contentFit="cover"
      transition={400}
      recyclingKey={uri}
    />
  );
}

function SkeletonBlock({
  width,
  height,
  radius = 6,
  delay = 0,
}: {
  width: number | string;
  height: number;
  radius?: number;
  delay?: number;
}) {
  const shimmer = useSharedValue(0.04);

  useEffect(() => {
    shimmer.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(0.09, {
            duration: 900,
            easing: Easing.inOut(Easing.ease),
          }),
          withTiming(0.04, {
            duration: 900,
            easing: Easing.inOut(Easing.ease),
          }),
        ),
        -1,
        true,
      ),
    );
  }, [delay, shimmer]);

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(255, 255, 255, ${shimmer.value})`,
  }));

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius: radius,
        },
        animatedStyle,
      ]}
    />
  );
}

function ArticleHeader({
  article,
  bookmarked,
  onToggleBookmark,
}: {
  article: ArticleRow;
  bookmarked: boolean;
  onToggleBookmark: () => void;
}) {
  const attribution = getArticleAttribution(article);
  const bookmarkScale = useSharedValue(1);
  const prevBookmarked = useRef(bookmarked);

  useEffect(() => {
    if (bookmarked !== prevBookmarked.current) {
      bookmarkScale.value = withSequence(
        withSpring(1.15, { damping: 8, stiffness: 500, mass: 0.3 }),
        withSpring(1, SPRING_CONFIG),
      );
      prevBookmarked.current = bookmarked;
    }
  }, [bookmarked, bookmarkScale]);

  const bookmarkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: bookmarkScale.value }],
  }));

  return (
    <View style={styles.articleHeader}>
      <View style={styles.articleTopRow}>
        <Animated.View
          entering={FadeIn.duration(ENTER_DURATION).easing(ENTER_EASE)}
          style={[styles.metaRow, styles.articleMeta]}
        >
          {attribution.primary ? (
            <Text
              style={[
                styles.siteName,
                attribution.hasAuthor && styles.bylineName,
              ]}
            >
              {decodeEntities(attribution.primary)}
            </Text>
          ) : null}
          {attribution.secondary ? (
            <>
              <Text style={styles.metaDot}>{"·"}</Text>
              <Text style={styles.metaDate}>
                {decodeEntities(attribution.secondary)}
              </Text>
            </>
          ) : null}
          {article.published_date ? (
            <>
              <Text style={styles.metaDot}>{"·"}</Text>
              <Text style={styles.metaDate}>
                {formatDate(article.published_date)}
              </Text>
            </>
          ) : null}
          {article.word_count > 0 ? (
            <>
              <Text style={styles.metaDot}>{"·"}</Text>
              <Text style={styles.metaDate}>
                {readTime(article.word_count)}
              </Text>
            </>
          ) : null}
        </Animated.View>

        {bookmarked ? (
          <AnimatedPressable
            accessibilityLabel="Remove bookmark"
            accessibilityRole="button"
            hitSlop={10}
            onPress={onToggleBookmark}
            style={[styles.bookmarkIndicator, bookmarkStyle]}
          >
            <Feather name="bookmark" size={20} color={BOOKMARK_BLUE} />
          </AnimatedPressable>
        ) : null}
      </View>

      <Animated.Text
        entering={FadeIn.duration(ENTER_DURATION).easing(ENTER_EASE).delay(60)}
        style={styles.title}
      >
        {decodeEntities(article.title)}
      </Animated.Text>
    </View>
  );
}

function InlineSkeleton({ contentWidth }: { contentWidth: number }) {
  return (
    <View style={[styles.scrollContent, { paddingTop: spacing.sm }]}>
      <View style={styles.articleHeader}>
        <View style={styles.metaRow}>
          <SkeletonBlock width={80} height={12} delay={0} />
          <SkeletonBlock width={100} height={12} delay={50} />
        </View>
        <SkeletonBlock
          width={contentWidth * 0.9}
          height={28}
          radius={4}
          delay={80}
        />
        <SkeletonBlock
          width={contentWidth * 0.7}
          height={28}
          radius={4}
          delay={100}
        />
        <View style={styles.metaRow}>
          <SkeletonBlock width={90} height={12} delay={160} />
        </View>
        <View style={styles.actionRow}>
          <SkeletonBlock width={80} height={26} radius={14} delay={220} />
          <SkeletonBlock width={56} height={26} radius={14} delay={240} />
        </View>
      </View>
      <View style={{ gap: 16, marginTop: 28 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={{ gap: 8 }}>
            <SkeletonBlock
              width={contentWidth}
              height={14}
              delay={300 + i * 40}
            />
            <SkeletonBlock
              width={contentWidth * 0.85}
              height={14}
              delay={320 + i * 40}
            />
            <SkeletonBlock
              width={contentWidth * 0.65}
              height={14}
              delay={340 + i * 40}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------- main screen ----------

const PREFETCH_AHEAD = 8;
const PREFETCH_BEHIND = 2;

export default function ReaderScreen() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const contentWidth = width - spacing.lg * 2;

  const [, setDequeIds] = useState<number[]>([]);
  const dequeRef = useRef<number[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentIndexRef = useRef(0);
  const [article, setArticle] = useState<HydratedArticle | null>(null);
  const articleRef = useRef<HydratedArticle | null>(null);
  const [bookmarked, setBookmarkedState] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starving, setStarving] = useState(false);
  const [articleKey, setArticleKey] = useState(0);

  const translateX = useSharedValue(0);
  const opacity = useSharedValue(1);
  const swipeCommitted = useSharedValue(false);
  const navigationInFlightRef = useRef(false);
  const requiresDiverseOpeningRef = useRef(false);
  const diverseOpeningStartedAtRef = useRef(0);
  const selectedTopicsKeyRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const prefetchAround = useCallback((ids: number[], index: number) => {
    // staggered: each hydrate parses full content on the JS thread, and a
    // burst of them mid-swipe-animation would stutter the frame pacing
    let offset = 0;
    const queue: [number, boolean][] = [];
    for (let i = 1; i <= PREFETCH_AHEAD; i++) {
      const idx = index + i;
      if (idx < ids.length && !hydrationCache.has(ids[idx])) {
        queue.push([ids[idx], false]);
      }
    }
    for (let i = 1; i <= PREFETCH_BEHIND; i++) {
      const idx = index - i;
      if (idx >= 0 && idx !== index && !hydrationCache.has(ids[idx])) {
        queue.push([ids[idx], true]);
      }
    }
    for (const [id, behind] of queue) {
      setTimeout(
        () => {
          hydrate(id).catch(() => {});
        },
        (offset += behind ? 0 : 60),
      );
    }
  }, []);

  const showArticle = useCallback((value: HydratedArticle) => {
    articleRef.current = value;
    setArticle(value);
    setBookmarkedState(!!value.row.is_bookmarked);
    setArticleKey((k) => k + 1);
    markRead(value.row.id).catch(() => {});
    capture("article_viewed", {
      topic: value.row.topic,
      word_count: value.row.word_count,
    });
  }, []);

  const loadReaderIds = useCallback(async () => {
    if (!requiresDiverseOpeningRef.current) return loadDeque();

    const diverse = await loadDiverseOpeningDeque();
    if (diverse.length > 0) return diverse;
    if (
      Date.now() - diverseOpeningStartedAtRef.current >=
      DIVERSE_OPENING_MAX_WAIT_MS
    ) {
      // Offline and depleted libraries must remain readable. The next normal
      // crawl/refill still uses persistent identity cooling; this fallback
      // only bounds the one-time strict opening wait.
      return loadDeque();
    }
    return [];
  }, []);

  const installReaderIds = useCallback(
    async (ids: number[]): Promise<boolean> => {
      if (ids.length === 0) return false;
      const first = await hydrate(ids[0]);
      if (!first) return false;

      dequeRef.current = ids;
      setDequeIds(ids);
      currentIndexRef.current = 0;
      setCurrentIndex(0);
      showArticle(first);
      prefetchAround(ids, 0);

      // Persist readiness only after a card really hydrated. A broken row can
      // no longer permanently bypass the first-opening contract.
      if (requiresDiverseOpeningRef.current) {
        requiresDiverseOpeningRef.current = false;
        await kvSet(DIVERSE_OPENING_READY_KEY, "1");
      }
      return true;
    },
    [prefetchAround, showArticle],
  );

  // Boot into a fresh unseen card. On the first run after this diversity
  // contract ships, wait for a genuinely varied opening rather than serving
  // whichever prolific feed happened to finish first.
  useEffect(() => {
    (async () => {
      refreshIfNeeded().catch(() => {});

      selectedTopicsKeyRef.current = (await kvGet("topics")) ?? "";
      const openingReady = await kvGet(DIVERSE_OPENING_READY_KEY);
      requiresDiverseOpeningRef.current = openingReady !== "1";
      diverseOpeningStartedAtRef.current = Date.now();
      const ids = await loadReaderIds();
      if (!(await installReaderIds(ids))) {
        setLoading(false);
        setStarving(true); // poll loop picks up as the crawl lands posts
        return;
      }
      setLoading(false);
    })();
  }, [installReaderIds, loadReaderIds]);

  // The reader stays mounted beneath the settings modal. Rebuild its queue
  // when topic preferences change so removed topics disappear immediately
  // and a newly selected topic participates in the next balanced generation.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const topicsKey = (await kvGet("topics")) ?? "";
        if (cancelled) return;
        if (selectedTopicsKeyRef.current == null) {
          selectedTopicsKeyRef.current = topicsKey;
          return;
        }
        if (selectedTopicsKeyRef.current === topicsKey) return;
        selectedTopicsKeyRef.current = topicsKey;

        hydrationCache.clear();
        dequeRef.current = [];
        setDequeIds([]);
        currentIndexRef.current = 0;
        setCurrentIndex(0);
        articleRef.current = null;
        setArticle(null);
        requiresDiverseOpeningRef.current = true;
        diverseOpeningStartedAtRef.current = Date.now();
        setLoading(false);
        setStarving(true);
      })().catch(() => {});
      return () => {
        cancelled = true;
      };
    }, []),
  );

  // starving: nothing readable yet (first run or drained) — poll until the
  // background crawl lands enriched posts in the database
  useEffect(() => {
    if (!starving || loading) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const ids = await loadReaderIds();
        if (cancelled) return;
        if (await installReaderIds(ids)) {
          if (!cancelled) setStarving(false);
        }
      } catch {
        // keep polling
      }
    };

    tick();
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [starving, loading, installReaderIds, loadReaderIds]);

  const pendingReveal = useRef<"instant" | "fade">("instant");

  useEffect(() => {
    if (pendingReveal.current === "instant") {
      opacity.value = 1;
    } else {
      opacity.value = withTiming(1, {
        duration: 300,
        easing: Easing.out(Easing.quad),
      });
    }
  }, [articleKey, opacity]);

  const navigate = useCallback(
    async (direction: 1 | -1) => {
      // A swipe can finish while hydration or a deque top-up is still on the
      // JS thread. Ignore overlapping requests so they cannot advance the
      // same index twice or let an older request replace a newer article.
      if (navigationInFlightRef.current) {
        translateX.value = withSpring(0, SPRING_CONFIG);
        opacity.value = withSpring(1, SPRING_CONFIG);
        return;
      }
      navigationInFlightRef.current = true;
      swipeCommitted.value = true;

      const ids = dequeRef.current;
      const idx = currentIndexRef.current;
      const nextIndex = idx + direction;
      const previousArticle = articleRef.current;

      const settleCurrentArticle = () => {
        currentIndexRef.current = idx;
        setCurrentIndex(idx);

        if (
          previousArticle &&
          articleRef.current?.row.id !== previousArticle.row.id
        ) {
          pendingReveal.current = "instant";
          articleRef.current = previousArticle;
          setArticle(previousArticle);
          setBookmarkedState(!!previousArticle.row.is_bookmarked);
          setArticleKey((key) => key + 1);
        }

        translateX.value = withSpring(0, SPRING_CONFIG);
        opacity.value = withSpring(1, SPRING_CONFIG);
      };

      try {
        if (direction === -1 && nextIndex < 0) {
          settleCurrentArticle();
          return;
        }

        if (nextIndex >= ids.length) {
          // There is no known card to animate to yet. Return the current card
          // to rest while the deque refills instead of leaving it off-axis.
          translateX.value = withSpring(0, SPRING_CONFIG);
          opacity.value = withSpring(1, SPRING_CONFIG);

          const { ids: refilled } = await topUpDeque(ids);
          const latestIds = dequeRef.current;
          const availableIds =
            latestIds.length > refilled.length ? latestIds : refilled;

          dequeRef.current = availableIds;
          setDequeIds(availableIds);

          // A top-up can legitimately return no new rows (or another top-up
          // may still be running). Never clamp back to the current index,
          // which would present the same article as if it were new.
          if (nextIndex >= availableIds.length) {
            settleCurrentArticle();
            return;
          }

          const next = await hydrate(availableIds[nextIndex]);
          if (!next) {
            settleCurrentArticle();
            return;
          }

          translateX.value = 0;
          opacity.value = 1;
          currentIndexRef.current = nextIndex;
          setCurrentIndex(nextIndex);
          pendingReveal.current = "instant";
          scrollRef.current?.scrollTo({ y: 0, animated: false });
          showArticle(next);
          prefetchAround(availableIds, nextIndex);
          return;
        }

        if (direction === 1 && articleRef.current) {
          archiveArticle(articleRef.current.row.id).catch(() => {});
        }

        translateX.value = 0;
        opacity.value = 0;

        const nextId = ids[nextIndex];
        const cached = hydrationCache.get(nextId);

        scrollRef.current?.scrollTo({ y: 0, animated: false });
        currentIndexRef.current = nextIndex;
        setCurrentIndex(nextIndex);
        prefetchAround(ids, nextIndex);

        if (cached) {
          pendingReveal.current = "instant";
          showArticle(cached);
        } else {
          pendingReveal.current = "fade";
          articleRef.current = null;
          setArticle(null);
          setArticleKey((k) => k + 1);
          const next = await hydrate(nextId);
          if (!next) {
            settleCurrentArticle();
            return;
          }
          showArticle(next);
        }

        if (ids.length - nextIndex <= LOW_WATER) {
          topUpDeque(ids)
            .then(({ ids: merged }) => {
              // Do not let a slow top-up overwrite navigation history that a
              // newer request has already extended.
              if (merged.length > ids.length && dequeRef.current === ids) {
                dequeRef.current = merged;
                setDequeIds(merged);
              }
            })
            .catch(() => {});
        }
      } catch {
        settleCurrentArticle();
      } finally {
        navigationInFlightRef.current = false;
        swipeCommitted.value = false;
      }
    },
    [showArticle, prefetchAround, translateX, opacity, swipeCommitted],
  );

  const goNext = useCallback(() => navigate(1), [navigate]);
  const goPrev = useCallback(() => navigate(-1), [navigate]);

  const toggleBookmark = useCallback(() => {
    const current = articleRef.current;
    if (!current) return;

    const next = !bookmarked;
    capture(next ? "article_bookmarked" : "article_unbookmarked", {
      topic: current.row.topic,
    });
    const articleId = current.row.id;
    const updated: HydratedArticle = {
      ...current,
      row: { ...current.row, is_bookmarked: next ? 1 : 0 },
    };

    articleRef.current = updated;
    setArticle(updated);
    setBookmarkedState(next);
    touchCache(articleId, updated);

    setArticleBookmark(articleId, next).catch(() => {
      // Keep a later user action intact if this older write is the one that
      // failed; otherwise restore both the visible article and the cache.
      const cached = hydrationCache.get(articleId);
      if (!cached || !!cached.row.is_bookmarked !== next) return;

      const rolledBack: HydratedArticle = {
        ...cached,
        row: { ...cached.row, is_bookmarked: next ? 0 : 1 },
      };
      touchCache(articleId, rolledBack);

      if (
        articleRef.current?.row.id === articleId &&
        !!articleRef.current.row.is_bookmarked === next
      ) {
        articleRef.current = rolledBack;
        setArticle(rolledBack);
        setBookmarkedState(!next);
      }
    });
  }, [bookmarked]);

  const shareArticle = useCallback(() => {
    if (!article) return;
    capture("article_shared", { topic: article.row.topic });
    Share.share({
      message: `${article.row.title}\n${article.row.url}\n\nshared from ReadRabbit`,
      url: article.row.url,
    }).catch(() => {});
  }, [article]);

  const notInterested = useCallback(() => {
    if (!article) return;
    archiveArticle(article.row.id).catch(() => {});
    navigate(1);
  }, [article, navigate]);

  const muteCurrentAuthor = useCallback(async () => {
    const current = articleRef.current;
    if (!current?.row.author.trim() || navigationInFlightRef.current) return;

    capture("author_muted");
    navigationInFlightRef.current = true;
    const oldIds = dequeRef.current;
    const oldIndex = currentIndexRef.current;

    try {
      const mutedIds = new Set(await muteAuthor(current.row.author));
      if (mutedIds.size === 0) return;

      for (const id of mutedIds) hydrationCache.delete(id);

      const history = oldIds
        .slice(0, oldIndex)
        .filter((id) => !mutedIds.has(id));
      const forward = oldIds
        .slice(oldIndex + 1)
        .filter((id) => !mutedIds.has(id));
      let nextIds = [...history, ...forward];
      let nextIndex = history.length;

      dequeRef.current = nextIds;
      setDequeIds(nextIds);

      // The current article must disappear as soon as the preference lands.
      articleRef.current = null;
      setArticle(null);
      setArticleKey((key) => key + 1);

      if (nextIndex >= nextIds.length) {
        const { ids: refilled } = await topUpDeque(nextIds);
        nextIds = refilled;
      }

      dequeRef.current = nextIds;
      setDequeIds(nextIds);

      if (nextIndex >= nextIds.length) {
        currentIndexRef.current = Math.max(0, nextIds.length - 1);
        setCurrentIndex(currentIndexRef.current);
        setStarving(true);
        return;
      }

      const next = await hydrate(nextIds[nextIndex]);
      if (!next) {
        currentIndexRef.current = Math.max(0, nextIndex - 1);
        setCurrentIndex(currentIndexRef.current);
        setStarving(true);
        return;
      }

      currentIndexRef.current = nextIndex;
      setCurrentIndex(nextIndex);
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      showArticle(next);
      prefetchAround(nextIds, nextIndex);
      setStarving(false);
    } catch {
      // The mute is already durable if a later refill or hydration failed.
      // Leave the muted card hidden while the normal starving poll recovers.
      setStarving(true);
    } finally {
      navigationInFlightRef.current = false;
    }
  }, [prefetchAround, showArticle]);

  const hasNext = true; // deque refills forward forever
  const hasPrev = currentIndex > 0;

  const gesture = Gesture.Pan()
    .activeOffsetX([-SWIPE_ACTIVATION_DISTANCE, SWIPE_ACTIVATION_DISTANCE])
    .failOffsetY([-14, 14])
    .onUpdate((e) => {
      if (swipeCommitted.value) return;
      const resistance = 0.35;
      const edgeDamping =
        (e.translationX < 0 && !hasNext) || (e.translationX > 0 && !hasPrev)
          ? 0.12
          : resistance;
      translateX.value = e.translationX * edgeDamping;
      const progress = Math.min(Math.abs(e.translationX) / 120, 1);
      opacity.value = 1 - progress * 0.15;
    })
    .onEnd((e) => {
      if (swipeCommitted.value) return;

      const swipedForward =
        e.translationX < -SWIPE_COMMIT_DISTANCE ||
        (e.translationX < -SWIPE_ACTIVATION_DISTANCE &&
          e.velocityX < -SWIPE_FLICK_VELOCITY);
      const swipedBackward =
        e.translationX > SWIPE_COMMIT_DISTANCE ||
        (e.translationX > SWIPE_ACTIVATION_DISTANCE &&
          e.velocityX > SWIPE_FLICK_VELOCITY);

      if (swipedForward && hasNext) {
        swipeCommitted.value = true;
        opacity.value = withTiming(0, {
          duration: 150,
          easing: Easing.in(Easing.quad),
        });
        translateX.value = withTiming(
          -width * 0.25,
          { duration: 150, easing: Easing.in(Easing.quad) },
          (finished) => {
            if (finished) {
              runOnJS(goNext)();
            } else {
              swipeCommitted.value = false;
              translateX.value = withSpring(0, SPRING_CONFIG);
              opacity.value = withSpring(1, SPRING_CONFIG);
            }
          },
        );
      } else if (swipedBackward && hasPrev) {
        swipeCommitted.value = true;
        opacity.value = withTiming(0, {
          duration: 150,
          easing: Easing.in(Easing.quad),
        });
        translateX.value = withTiming(
          width * 0.25,
          { duration: 150, easing: Easing.in(Easing.quad) },
          (finished) => {
            if (finished) {
              runOnJS(goPrev)();
            } else {
              swipeCommitted.value = false;
              translateX.value = withSpring(0, SPRING_CONFIG);
              opacity.value = withSpring(1, SPRING_CONFIG);
            }
          },
        );
      } else {
        translateX.value = withSpring(0, SPRING_CONFIG);
        opacity.value = withSpring(1, SPRING_CONFIG);
      }
    })
    .onFinalize(() => {
      // onEnd is not called for every terminal gesture state (for example,
      // cancellation by the OS or another recognizer). Always settle a
      // non-committed card so partial translation/rotation cannot persist.
      if (!swipeCommitted.value) {
        translateX.value = withSpring(0, SPRING_CONFIG);
        opacity.value = withSpring(1, SPRING_CONFIG);
      }
    });

  const animatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(
      Math.abs(translateX.value),
      [0, width * 0.3],
      [1, 0.97],
    );
    return {
      transform: [{ translateX: translateX.value }, { scale }],
      opacity: opacity.value,
    };
  });

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <InlineSkeleton contentWidth={contentWidth} />
      </SafeAreaView>
    );
  }

  const starvingEmpty = starving && !article;

  if (starvingEmpty) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.center}>
          <Animated.View entering={FadeIn.duration(600).easing(ENTER_EASE)}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.emptyTitle}>Building your reading list…</Text>
            <Text style={styles.emptySubtitle}>
              Finding thoughtful posts from independent blogs.
            </Text>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.container}>
        <GestureDetector gesture={gesture}>
          <Animated.View style={[{ flex: 1 }, animatedStyle]}>
            {article ? (
              <ScrollView
                ref={scrollRef}
                style={styles.scroll}
                contentContainerStyle={[
                  styles.scrollContent,
                  {
                    paddingTop: insets.top + OVERFLOW_BUTTON_SIZE + spacing.lg,
                  },
                ]}
                showsVerticalScrollIndicator={false}
                key={`scroll-${article.row.id}`}
              >
                <ArticleHeader
                  key={`header-${articleKey}`}
                  article={article.row}
                  bookmarked={bookmarked}
                  onToggleBookmark={toggleBookmark}
                />

                {article.row.lead_image_url ? (
                  <FadeImage
                    uri={article.row.lead_image_url}
                    style={styles.leadImage}
                  />
                ) : null}

                {article.segments.length > 0 ? (
                  <View style={styles.segmentList}>
                    {article.segments.map((seg) =>
                      seg.code ? (
                        <Animated.View
                          key={`${article.row.id}-code-${seg.index}`}
                          entering={FadeIn.duration(ENTER_DURATION)
                            .easing(ENTER_EASE)
                            .delay(Math.min(240 + seg.index * 30, 800))}
                        >
                          <CodeBlock
                            code={seg.code.text}
                            langHint={seg.code.lang ?? undefined}
                          />
                        </Animated.View>
                      ) : (
                        <TappableParagraph
                          key={`${article.row.id}-${seg.index}`}
                          segment={seg}
                          articleId={article.row.id}
                          liked={article.likedIndices.has(seg.index)}
                          contentWidth={contentWidth}
                          enterDelay={Math.min(240 + seg.index * 30, 800)}
                        />
                      ),
                    )}
                  </View>
                ) : (
                  <Animated.View
                    entering={FadeIn.duration(ENTER_DURATION)
                      .easing(ENTER_EASE)
                      .delay(360)}
                  >
                    <Text style={styles.plainText}>{article.row.excerpt}</Text>
                  </Animated.View>
                )}

                {article.row.url ? (
                  <Text style={styles.sourceLink} numberOfLines={1}>
                    {article.row.url.replace(/^https?:\/\//, "")}
                  </Text>
                ) : null}

                <View style={{ height: 100 }} />
              </ScrollView>
            ) : (
              <InlineSkeleton contentWidth={contentWidth} />
            )}
          </Animated.View>
        </GestureDetector>
        <OverflowMenu
          bookmarked={bookmarked}
          canMuteAuthor={
            article ? getArticleAttribution(article.row).hasAuthor : false
          }
          onToggleBookmark={toggleBookmark}
          onShare={shareArticle}
          onNotInterested={notInterested}
          onMuteAuthor={muteCurrentAuthor}
          onSettings={() => router.push("/settings")}
        />
      </View>
    </GestureHandlerRootView>
  );
}

async function setArticleBookmark(
  articleId: number,
  next: boolean,
): Promise<void> {
  await setBookmarked(articleId, next);
}

const OVERFLOW_ITEMS = [
  { key: "bookmark", label: "Bookmark", icon: "bookmark" },
  { key: "share", label: "Share", icon: "share-2" },
  { key: "mute-author", label: "Mute author", icon: "user-x" },
  { key: "settings", label: "Settings", icon: "settings" },
] as const;

function OverflowMenu({
  bookmarked,
  canMuteAuthor,
  onToggleBookmark,
  onShare,
  onNotInterested,
  onMuteAuthor,
  onSettings,
}: {
  bookmarked: boolean;
  canMuteAuthor: boolean;
  onToggleBookmark: () => void;
  onShare: () => void;
  onNotInterested: () => void;
  onMuteAuthor: () => void;
  onSettings: () => void;
}) {
  const insets = useSafeAreaInsets();
  const open = useSharedValue(0);
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    open.value = withSpring(next ? 1 : 0, {
      damping: 18,
      stiffness: 280,
      mass: 0.5,
    });
  }, [expanded, open]);

  const close = useCallback(() => {
    setExpanded(false);
    open.value = withSpring(0, { damping: 18, stiffness: 280, mass: 0.5 });
  }, [open]);

  const handleAction = useCallback(
    (key: string) => {
      close();
      switch (key) {
        case "bookmark":
          onToggleBookmark();
          break;
        case "share":
          onShare();
          break;
        case "not-interested":
          onNotInterested();
          break;
        case "mute-author":
          onMuteAuthor();
          break;
        case "settings":
          onSettings();
          break;
      }
    },
    [
      close,
      onToggleBookmark,
      onShare,
      onNotInterested,
      onMuteAuthor,
      onSettings,
    ],
  );

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: open.value * 0.35,
  }));

  const menuStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [
      { translateY: interpolate(open.value, [0, 1], [-8, 0]) },
      { scale: interpolate(open.value, [0, 1], [0.96, 1]) },
    ],
  }));

  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(open.value, [0, 1], [1, 0.96]) }],
  }));

  return (
    <>
      <Animated.View
        pointerEvents={expanded ? "auto" : "none"}
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: "#000" },
          overlayStyle,
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <View
        style={[
          overflowStyles.container,
          {
            top: insets.top + spacing.sm,
            right: insets.right + spacing.md,
          },
        ]}
        pointerEvents="box-none"
      >
        <AnimatedPressable
          accessibilityLabel={
            expanded ? "Close article menu" : "Open article menu"
          }
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={6}
          onPress={toggle}
          style={[
            overflowStyles.main,
            expanded && overflowStyles.mainExpanded,
            buttonStyle,
          ]}
        >
          <Feather name="more-horizontal" size={20} color={colors.text} />
        </AnimatedPressable>

        <Animated.View
          accessibilityRole="menu"
          pointerEvents={expanded ? "auto" : "none"}
          style={[overflowStyles.menu, menuStyle]}
        >
          {OVERFLOW_ITEMS.filter(
            (item) => item.key !== "mute-author" || canMuteAuthor,
          ).map((item, index) => {
            const active = item.key === "bookmark" && bookmarked;
            const label = active ? "Bookmarked" : item.label;

            return (
              <Pressable
                accessibilityRole="menuitem"
                accessibilityState={{ selected: active }}
                key={item.key}
                onPress={() => handleAction(item.key)}
                style={({ pressed }) => [
                  overflowStyles.menuItem,
                  index > 0 && overflowStyles.menuDivider,
                  active && overflowStyles.menuItemActive,
                  pressed && overflowStyles.menuItemPressed,
                ]}
              >
                <Feather
                  name={item.icon}
                  size={17}
                  color={active ? colors.text : colors.textSecondary}
                />
                <Text
                  style={[
                    overflowStyles.menuLabel,
                    active && overflowStyles.menuLabelActive,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </Animated.View>
      </View>
    </>
  );
}

const overflowStyles = StyleSheet.create({
  container: {
    position: "absolute",
    alignItems: "flex-end",
    zIndex: 100,
    elevation: 100,
  },
  main: {
    width: OVERFLOW_BUTTON_SIZE,
    height: OVERFLOW_BUTTON_SIZE,
    borderRadius: OVERFLOW_BUTTON_SIZE / 2,
    backgroundColor: "rgba(28, 28, 28, 0.88)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#343434",
    alignItems: "center",
    justifyContent: "center",
  },
  mainExpanded: {
    backgroundColor: colors.bgActive,
    borderColor: "#484848",
  },
  menu: {
    position: "absolute",
    top: OVERFLOW_BUTTON_SIZE + spacing.sm,
    right: 0,
    width: 184,
    overflow: "hidden",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#353535",
    backgroundColor: "#1a1a1a",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 14,
  },
  menuItem: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  menuDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  menuItemActive: {
    backgroundColor: "rgba(255, 255, 255, 0.055)",
  },
  menuItemPressed: {
    backgroundColor: colors.bgActive,
  },
  menuLabel: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.textSecondary,
  },
  menuLabelActive: {
    color: colors.text,
  },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 80,
  },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    elevation: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    paddingTop: 6,
    height: 44,
  },
  wordmark: {
    fontFamily: fonts.logo,
    fontSize: 22,
    color: colors.textTertiary,
  },
  articleHeader: {
    marginBottom: 24,
    gap: 10,
  },
  articleTopRow: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  articleMeta: {
    flex: 1,
  },
  bookmarkIndicator: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  siteName: {
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.accent,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  bylineName: {
    textTransform: "none",
    letterSpacing: 0.25,
  },
  metaDot: { color: colors.textTertiary, fontSize: 12 },
  metaDate: {
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.textTertiary,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 28,
    lineHeight: 36,
    color: colors.text,
    letterSpacing: -0.3,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  leadImage: {
    width: "100%",
    height: 220,
    borderRadius: 12,
    marginBottom: 28,
  },
  segmentList: {
    gap: 4,
  },
  paragraph: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 8,
    position: "relative",
  },
  tappedLine: {
    position: "absolute",
    left: -4,
    top: 4,
    bottom: 4,
    width: 2.5,
    backgroundColor: colors.like,
    borderRadius: 2,
    opacity: 0.7,
  },
  heartBadge: {
    position: "absolute",
    right: -2,
    top: 4,
  },
  plainText: {
    fontFamily: fonts.sans,
    fontSize: 18,
    lineHeight: 32,
    color: colors.text,
  },
  sourceLink: {
    marginTop: 32,
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textTertiary,
  },
  emptyTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 19,
    color: colors.text,
    textAlign: "center",
    marginTop: spacing.md,
  },
  emptySubtitle: {
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
    marginTop: 6,
  },
});
