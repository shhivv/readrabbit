import { useEffect } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
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
}: {
  label: string;
  enabled?: boolean;
  onPress: () => void;
  delay?: number;
}) {
  const opacity = useSharedValue(enabled ? 1 : 0.35);
  useEffect(() => {
    opacity.value = withTiming(enabled ? 1 : 0.35, { duration: 200 });
  }, [enabled, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View entering={FadeIn.delay(delay)} style={style}>
      <Pressable
        disabled={!enabled}
        onPress={onPress}
        style={[styles.primaryBtn, !enabled && styles.btnDisabled]}
      >
        <Text style={styles.primaryLabel}>{label}</Text>
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
  const scale = useSharedValue(1);
  const border = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    border.value = withSpring(active ? 1 : 0, SPRING);
  }, [active, border]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    borderColor: border.value > 0.5 ? colors.text : colors.border,
    backgroundColor:
      border.value > 0.5 ? "rgba(255, 255, 255, 0.05)" : colors.bgRaised,
  }));

  return (
    <Pressable
      onPressIn={() => (scale.value = withSpring(0.97, SPRING))}
      onPressOut={() => (scale.value = withSpring(1, SPRING))}
      onPress={onPress}
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
    backgroundColor: colors.text,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
  },
  btnDisabled: {},
  primaryLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 15,
    color: "#111111",
    letterSpacing: 0.3,
  },
  topicCard: {
    borderWidth: 1.5,
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
    gap: 5,
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
