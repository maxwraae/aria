import { useRef, useEffect } from "react";
import { View, Text, ScrollView, StyleSheet, Platform } from "react-native";
import { ObjectiveCard } from "./ObjectiveCard";
import type { ObjectiveCardData } from "./ObjectiveCard";
import { theme } from "../constants/theme";

interface RecentWorkStripProps {
  items: ObjectiveCardData[];
  onNavigate?: (id: string) => void;
  headerColor?: string;
}

export function RecentWorkStrip({ items, onNavigate, headerColor }: RecentWorkStripProps) {
  const scrollRef = useRef<ScrollView>(null);

  // On web: horizontal wheel/trackpad scrolls the strip
  useEffect(() => {
    if (Platform.OS !== "web" || !scrollRef.current) return;
    const outer = (scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement })?.getScrollableNode?.()
      ?? (scrollRef.current as unknown as HTMLElement);
    if (!outer) return;
    const el = (outer.querySelector?.("[style*='overflow']") as HTMLElement) ?? outer;
    const handler = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      if (dx > dy && dx > 3) {
        e.preventDefault();
        el.scrollLeft += e.deltaX;
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  if (items.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={[styles.sectionHeader, headerColor ? { color: headerColor } : undefined]}>Recent work</Text>
      </View>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        style={styles.scroll}
      >
        {items.map((item) => (
          <View key={item.id} style={styles.cardWrapper}>
            <ObjectiveCard
              data={item}
              onPress={onNavigate ? () => onNavigate(item.id) : undefined}
            />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    paddingTop: 64,
    ...(Platform.OS === "web"
      ? { marginLeft: "auto", marginRight: "auto", overflow: "hidden" }
      : {}),
  } as any,
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.layout.gridPadding,
    marginBottom: 24,
    maxWidth: theme.layout.gridMaxWidth,
    ...(Platform.OS === "web"
      ? { marginLeft: "auto", marginRight: "auto", width: "100%" }
      : {}),
  } as any,
  sectionHeader: {
    fontSize: 34,
    fontWeight: "700" as const,
    color: "rgba(22,18,14,0.65)",
    fontFamily: theme.fonts.sans,
    letterSpacing: -0.3,
  },
  scroll: {
    ...(Platform.OS === "web"
      ? { overflowX: "auto", overflowY: "hidden", overscrollBehaviorX: "contain" }
      : {}),
  } as any,
  scrollContent: {
    gap: 16,
    ...(Platform.OS === "web"
      ? {
          display: "flex",
          flexDirection: "row",
          flexWrap: "nowrap",
          paddingLeft: `max(${theme.layout.gridPadding}px, calc((100vw - ${theme.layout.gridMaxWidth}px) / 2 + ${theme.layout.gridPadding}px))`,
          paddingRight: theme.layout.gridPadding,
          paddingBottom: 8,
        }
      : { paddingHorizontal: theme.layout.gridPadding, flexDirection: "row" }),
  } as any,
  cardWrapper: {
    ...(Platform.OS === "web"
      ? {
          flexShrink: 0,
          width: 280,
          minHeight: 160,
        }
      : {}),
  } as any,
});
