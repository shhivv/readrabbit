import { useEffect } from "react";
import {
  ActivityIndicator,
  View,
  Text,
  Pressable,
  StyleSheet,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  FadeIn,
} from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";
import { colors, fonts } from "@/lib/theme";

// Shared onboarding/settings primitives. Underscore prefix keeps expo-router
// from treating this file as a route.

export const SPRING = { damping: 18, stiffness: 260 };

export function PrimaryButton({
  label,
  enabled = true,
  onPress,
  delay = 0,
  loading = false,
}: {
  label: string;
  enabled?: boolean;
  onPress: () => void;
  delay?: number;
  loading?: boolean;
}) {
  const interactive = enabled && !loading;

  return (
    <Animated.View
      entering={FadeIn.delay(delay)}
      style={{ opacity: interactive || loading ? 1 : 0.3 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !interactive, busy: loading }}
        disabled={!interactive}
        onPress={onPress}
        style={({ pressed }) => [
          styles.primaryBtn,
          pressed && styles.primaryBtnPressed,
        ]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={colors.bg} />
        ) : (
          <>
            <Text style={styles.primaryLabel}>{label}</Text>
            <Feather name="arrow-right" size={16} color={colors.bg} />
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

export function TopicCard({
  label,
  blurb,
  active,
  onPress,
}: {
  label: string;
  blurb: string;
  active: boolean;
  onPress: () => void;
}) {
  const border = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    border.value = withSpring(active ? 1 : 0, SPRING);
  }, [active, border]);

  const cardStyle = useAnimatedStyle(() => ({
    backgroundColor:
      border.value > 0.5 ? "rgba(255, 255, 255, 0.08)" : colors.bgRaised,
  }));

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && styles.topicCardPressed}
    >
      <Animated.View style={[styles.topicCard, cardStyle]}>
        <View style={styles.topicRow}>
          <Text style={[styles.topicLabel, active && styles.topicLabelActive]}>
            {label}
          </Text>
          {active ? (
            <Feather name="check" size={16} color={colors.text} />
          ) : null}
        </View>
        {blurb.length > 0 ? (
          <Text style={styles.topicBlurb}>{blurb}</Text>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primaryBtn: {
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.text,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryBtnPressed: {
    opacity: 0.84,
    transform: [{ scale: 0.99 }],
  },
  primaryLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.bg,
    letterSpacing: 0.2,
  },
  topicCard: {
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
    gap: 5,
  },
  topicCardPressed: {
    transform: [{ scale: 0.97 }],
  },
  topicRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topicLabel: {
    fontFamily: fonts.mono,
    fontSize: 13,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: colors.textSecondary,
  },
  topicLabelActive: {
    color: colors.text,
  },
  topicBlurb: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textTertiary,
  },
});
