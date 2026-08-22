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
import { SafeAreaView } from "react-native-safe-area-context";
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

import {
  getArticleById,
  getInterestIndices,
  markRead,
  archiveArticle,
  setBookmarked,
  toggleInterest,
  kvGet,
  kvSet,
  type ArticleRow,
} from "@/lib/db";
import {
  loadDeque,
  topUpDeque,
  LOW_WATER,
} from "@/lib/deque";
import { refreshIfNeeded } from "@/lib/crawler/engine";
import { CodeBlock } from "@/lib/code";
import { maybeFetchStarterPack } from "@/lib/starter";
import { colors, fonts, spacing } from "@/lib/theme";

const SPRING_CONFIG = { damping: 20, stiffness: 300, mass: 0.8 };
const SPRING_SNAPPY = { damping: 15, stiffness: 400, mass: 0.5 };
const ENTER_DURATION = 500;
const ENTER_EASE = Easing.out(Easing.exp);

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
    const { document } = parseHTML(
      `<html><body>${contentHtml}</body></html>`
    );

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
  return str
    .replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (match, dec, hex, named) => {
      if (dec) return String.fromCharCode(parseInt(dec, 10));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      const entities: Record<string, string> = {
        amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " ", apos: "'",
      };
      return entities[named] ?? match;
    });
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
    borderWidth: 1,
    borderColor: colors.border,
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

function ActionButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.92, SPRING_SNAPPY);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, SPRING_CONFIG);
      }}
      onPress={onPress}
      hitSlop={12}
      style={[styles.actionBtn, active && styles.actionBtnActive, animatedStyle]}
    >
      <Text style={[styles.actionLabel, active && styles.actionLabelActive]}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

function HeartBadge({ liked }: { liked: boolean }) {
  const scale = useSharedValue(liked ? 1 : 0);
  const opacity = useSharedValue(liked ? 1 : 0);

  useEffect(() => {
    if (liked) {
      scale.value = withSequence(
        withSpring(1.35, { damping: 8, stiffness: 420, mass: 0.4 }),
        withSpring(1, SPRING_CONFIG)
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
      <Feather name="heart" size={11} color="#FF6B8A" />
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
      withTiming(1, { duration: ENTER_DURATION, easing: ENTER_EASE })
    );
    enterY.value = withDelay(
      enterDelay,
      withTiming(0, { duration: ENTER_DURATION, easing: ENTER_EASE })
    );
  }, [enterDelay, enterOpacity, enterY]);

  const animatedBg = useAnimatedStyle(() => ({
    backgroundColor: `rgba(255, 107, 138, ${bgOpacity.value})`,
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
          withTiming(0.06, { duration: 500, easing: Easing.out(Easing.quad) })
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

function SkeletonBlock({ width, height, radius = 6, delay = 0 }: {
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
          withTiming(0.09, { duration: 900, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.04, { duration: 900, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      )
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
  onShare,
}: {
  article: ArticleRow;
  bookmarked: boolean;
  onToggleBookmark: () => void;
  onShare: () => void;
}) {
  const bookmarkScale = useSharedValue(1);
  const prevBookmarked = useRef(bookmarked);

  useEffect(() => {
    if (bookmarked !== prevBookmarked.current) {
      bookmarkScale.value = withSequence(
        withSpring(1.15, { damping: 8, stiffness: 500, mass: 0.3 }),
        withSpring(1, SPRING_CONFIG)
      );
      prevBookmarked.current = bookmarked;
    }
  }, [bookmarked, bookmarkScale]);

  return (
    <View style={styles.articleHeader}>
      <Animated.View entering={FadeIn.duration(ENTER_DURATION).easing(ENTER_EASE)} style={styles.metaRow}>
        {article.site_name ? (
          <Text style={styles.siteName}>{article.site_name}</Text>
        ) : null}
        {article.published_date ? (
          <>
            <Text style={styles.metaDot}>{"·"}</Text>
            <Text style={styles.metaDate}>{formatDate(article.published_date)}</Text>
          </>
        ) : null}
        {article.word_count > 0 ? (
          <>
            <Text style={styles.metaDot}>{"·"}</Text>
            <Text style={styles.metaDate}>{readTime(article.word_count)}</Text>
          </>
        ) : null}
      </Animated.View>

      <Animated.Text
        entering={FadeIn.duration(ENTER_DURATION).easing(ENTER_EASE).delay(60)}
        style={styles.title}
      >
        {decodeEntities(article.title)}
      </Animated.Text>

      {article.author ? (
        <Animated.Text
          entering={FadeIn.duration(ENTER_DURATION).easing(ENTER_EASE).delay(120)}
          style={styles.author}
        >
          {decodeEntities(article.author)}
        </Animated.Text>
      ) : null}

      <Animated.View
        entering={FadeIn.duration(ENTER_DURATION).easing(ENTER_EASE).delay(180)}
        style={styles.actionRow}
      >
        <ActionButton
          label={bookmarked ? "bookmarked" : "bookmark"}
          active={bookmarked}
          onPress={onToggleBookmark}
        />
        <ActionButton label="share" onPress={onShare} />
      </Animated.View>
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
        <SkeletonBlock width={contentWidth * 0.9} height={28} radius={4} delay={80} />
        <SkeletonBlock width={contentWidth * 0.7} height={28} radius={4} delay={100} />
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
            <SkeletonBlock width={contentWidth} height={14} delay={300 + i * 40} />
            <SkeletonBlock width={contentWidth * 0.85} height={14} delay={320 + i * 40} />
            <SkeletonBlock width={contentWidth * 0.65} height={14} delay={340 + i * 40} />
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
  const contentWidth = width - spacing.lg * 2;

  const [dequeIds, setDequeIds] = useState<number[]>([]);
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
  const scrollRef = useRef<ScrollView>(null);

  const prefetchAround = useCallback((ids: number[], index: number) => {
    // staggered: each hydrate parses full content on the JS thread, and a
    // burst of them mid-swipe-animation would stutter the frame pacing
    let offset = 0;
    const queue: Array<[number, boolean]> = [];
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
        (offset += behind ? 0 : 60)
      );
    }
  }, []);

  const showArticle = useCallback((value: HydratedArticle) => {
    articleRef.current = value;
    setArticle(value);
    setBookmarkedState(!!value.row.is_bookmarked);
    setArticleKey((k) => k + 1);
    kvSet("last_article_id", String(value.row.id)).catch(() => {});
    markRead(value.row.id).catch(() => {});
  }, []);

  // boot: restore last position or start fresh deque
  useEffect(() => {
    setLoading(true);
    (async () => {
      refreshIfNeeded().catch(() => {});

      let ids = await loadDeque();
      const savedIdRaw = await kvGet("last_article_id");
      const savedId = savedIdRaw ? parseInt(savedIdRaw, 10) : NaN;

      if (!Number.isNaN(savedId)) {
        const saved = await hydrate(savedId);
        if (saved) {
          ids = ids.filter((id) => id !== savedId);
          ids.unshift(savedId);
        }
      }

      dequeRef.current = ids;
      setDequeIds(ids);

      if (ids.length === 0) {
        setLoading(false);
        setStarving(true); // poll loop picks up as the crawl lands posts
        return;
      }

      const firstId = Number.isNaN(savedId)
        ? ids[0]
        : ids.includes(savedId)
          ? savedId
          : ids[0];
      const firstIdx = ids.indexOf(firstId);
      currentIndexRef.current = firstIdx;
      setCurrentIndex(firstIdx);

      const first = await hydrate(firstId);
      if (first) showArticle(first);
      prefetchAround(ids, firstIdx);
      setLoading(false);
    })();
  }, [showArticle, prefetchAround]);

  // starving: nothing readable yet (first run or drained) — poll until the
  // background crawl lands enriched posts in the database
  useEffect(() => {
    if (!starving || loading) return;
    let cancelled = false;

    // static daily pack fills the gap instantly when configured; the crawl
    // keeps going regardless and takes over with fresher material
    maybeFetchStarterPack().catch(() => {});

    const tick = async () => {
      try {
        const ids = await loadDeque();
        if (cancelled) return;
        if (ids.length > 0) {
          dequeRef.current = ids;
          setDequeIds(ids);
          currentIndexRef.current = 0;
          setCurrentIndex(0);
          const first = await hydrate(ids[0]);
          if (!cancelled && first) {
            showArticle(first);
            prefetchAround(ids, 0);
            setStarving(false);
          }
        }
      } catch {
        // keep polling
      }
    };

    tick();
    const interval = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [starving, loading, showArticle, prefetchAround]);

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
      const ids = dequeRef.current;
      const idx = currentIndexRef.current;
      const nextIndex = idx + direction;

      if (direction === -1 && nextIndex < 0) return;

      if (nextIndex >= ids.length) {
        // end of deque: refill
        setStarving(true);
        const { ids: refilled } = await topUpDeque(ids);
        dequeRef.current = refilled;
        setDequeIds(refilled);
        setStarving(false);
        if (refilled.length > 0) {
          const nextIdx = Math.min(idx + 1, refilled.length - 1);
          currentIndexRef.current = nextIdx;
          setCurrentIndex(nextIdx);
          const next = await hydrate(refilled[nextIdx]);
          pendingReveal.current = "instant";
          scrollRef.current?.scrollTo({ y: 0, animated: false });
          if (next) showArticle(next);
          prefetchAround(refilled, nextIdx);
        }
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
        if (next) showArticle(next);
      }

      if (ids.length - nextIndex <= LOW_WATER) {
        topUpDeque(ids).then(({ ids: merged }) => {
          if (merged.length > ids.length) {
            dequeRef.current = merged;
            setDequeIds(merged);
          }
        });
      }
    },
    [showArticle, prefetchAround, translateX, opacity]
  );

  const goNext = useCallback(() => navigate(1), [navigate]);
  const goPrev = useCallback(() => navigate(-1), [navigate]);

  const toggleBookmark = useCallback(() => {
    if (!article) return;
    const next = !bookmarked;
    setBookmarkedState(next);
    setArticleBookmark(article.row.id, next).catch(() => {});
  }, [article, bookmarked]);

  const shareArticle = useCallback(() => {
    if (!article) return;
    Share.share({
      message: `${article.row.title}\n${article.row.url}\n\n— Shared from Naturally Curious`,
      url: article.row.url,
    }).catch(() => {});
  }, [article]);

  const hasNext = true; // deque refills forward forever
  const hasPrev = currentIndex > 0;

  const gesture = Gesture.Pan()
    .activeOffsetX([-30, 30])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
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
      if (e.translationX < -80 && hasNext) {
        opacity.value = withTiming(0, { duration: 150, easing: Easing.in(Easing.quad) });
        translateX.value = withTiming(
          -width * 0.25,
          { duration: 150, easing: Easing.in(Easing.quad) },
          () => {
            runOnJS(goNext)();
          }
        );
      } else if (e.translationX > 80 && hasPrev) {
        opacity.value = withTiming(0, { duration: 150, easing: Easing.in(Easing.quad) });
        translateX.value = withTiming(
          width * 0.25,
          { duration: 150, easing: Easing.in(Easing.quad) },
          () => {
            runOnJS(goPrev)();
          }
        );
      } else {
        translateX.value = withSpring(0, SPRING_CONFIG);
        opacity.value = withSpring(1, SPRING_CONFIG);
      }
    });

  const animatedStyle = useAnimatedStyle(() => {
    const scale = interpolate(
      Math.abs(translateX.value),
      [0, width * 0.3],
      [1, 0.97]
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
            <Text style={styles.emptyTitle}>gathering good posts…</Text>
            <Text style={styles.emptySubtitle}>
              your phone is out crawling blogs — this fills in on its own
            </Text>
          </Animated.View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={styles.container} edges={["top"]}>
        <GestureDetector gesture={gesture}>
          <Animated.View style={[{ flex: 1 }, animatedStyle]}>
            {article ? (
              <ScrollView
                ref={scrollRef}
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                key={`scroll-${article.row.id}`}
              >
                <ArticleHeader
                  key={`header-${articleKey}`}
                  article={article.row}
                  bookmarked={bookmarked}
                  onToggleBookmark={toggleBookmark}
                  onShare={shareArticle}
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
                  )
                )}
                  </View>
                ) : (
                  <Animated.View
                    entering={FadeIn.duration(ENTER_DURATION).easing(ENTER_EASE).delay(360)}
                  >
                    <Text style={styles.plainText}>{article.row.excerpt}</Text>
                  </Animated.View>
                )}

                {article.row.url ? (
                  <Text style={styles.sourceLink} numberOfLines={1}>
                    {article.row.url.replace(/^https?:\/\//, "")}
                  </Text>
                ) : null}

                <View style={{ height: 60 }} />
              </ScrollView>
            ) : (
              <InlineSkeleton contentWidth={contentWidth} />
            )}
          </Animated.View>
        </GestureDetector>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

async function setArticleBookmark(articleId: number, next: boolean): Promise<void> {
  await setBookmarked(articleId, next);
}

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
    paddingTop: spacing.sm,
  },
  articleHeader: {
    marginBottom: 24,
    gap: 10,
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
  author: {
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.textTertiary,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  actionBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionBtnActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(201, 168, 124, 0.1)",
  },
  actionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textTertiary,
    letterSpacing: 0.5,
  },
  actionLabelActive: {
    color: colors.accent,
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
    backgroundColor: "#FF6B8A",
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
