import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../constants/theme";

interface BreadcrumbProps {
  segments: string[];
  siblingCount?: number;
  activeSibling?: number;
}

export function Breadcrumb({ segments, siblingCount = 1, activeSibling = 0 }: BreadcrumbProps) {
  // Show max 4 segments. If deeper, collapse middle into "..."
  const visible =
    segments.length <= 4
      ? segments
      : [segments[0], "...", segments[segments.length - 2], segments[segments.length - 1]];

  return (
    <View style={styles.container}>
      <View style={styles.trail}>
        {visible.map((seg, i) => {
          const isLast = i === visible.length - 1;
          const isCollapsed = seg === "...";
          return (
            <View key={i} style={styles.segmentRow}>
              {i > 0 && <Text style={styles.separator}>{"\u203A"}</Text>}
              <Pressable
                style={({ pressed }) => [pressed && !isLast && styles.pressed]}
              >
                <Text
                  style={[
                    styles.segment,
                    isLast && styles.segmentActive,
                    isCollapsed && styles.segmentCollapsed,
                  ]}
                  numberOfLines={1}
                >
                  {seg}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      {/* Sibling dot indicators */}
      {siblingCount > 1 && (
        <View style={styles.dots}>
          {Array.from({ length: siblingCount }).map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i === activeSibling && styles.dotActive]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: 8,
    paddingBottom: 12,
  },
  trail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  segmentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  separator: {
    ...theme.typography.breadcrumbSep,
    marginHorizontal: 4,
  },
  segment: {
    ...theme.typography.breadcrumbAncestor,
  },
  segmentActive: {
    ...theme.typography.breadcrumbCurrent,
  },
  segmentCollapsed: {
    letterSpacing: 2,
  },
  pressed: {
    opacity: 0.5,
  },
  dots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.status.idle.dot,
  },
  dotActive: {
    backgroundColor: theme.status.resolved.dot,
  },
});
