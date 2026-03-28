import { useRef, useEffect } from "react";
import { View, Text, ScrollView, StyleSheet, Platform, Pressable } from "react-native";
import { ChatCard } from "./ChatCard";
import { theme } from "../constants/theme";
import type { ChatSession } from "../types/chat";

export interface NeedsYouItem {
  session: ChatSession;
  urgent?: boolean;
  important?: boolean;
  /** Breadcrumb path to this card's parent, e.g. ["Ship the app", "Nail onboarding"] */
  parents: string[];
}

/** Plain-text breadcrumb above each card — muted, no chrome */
function BreadcrumbRow({ item }: { item: NeedsYouItem }) {
  if (item.parents.length === 0) return null;
  const crumbs = item.parents.slice(-2);

  return (
    <View style={tagStyles.row}>
      <Text style={tagStyles.text} numberOfLines={1}>
        {crumbs.join("  \u203A  ")}
      </Text>
    </View>
  );
}


const tagStyles = StyleSheet.create({
  row: {
    height: 40,
    justifyContent: "flex-end",
    paddingBottom: 8,
  },
  text: {
    fontSize: 14,
    fontWeight: "400" as const,
    color: "rgba(22,18,14,0.42)",
    fontFamily: theme.fonts.sans,
  },
});

interface NeedsYouStripProps {
  items: NeedsYouItem[];
  onNavigate?: (sessionId: string) => void;
  onExpand?: () => void;
  headerColor?: string;
  onSend?: (objectiveId: string, text: string) => Promise<void> | void;
  streamingText?: Map<string, string>;
  header?: string;
}

export function NeedsYouStrip({ items, onNavigate, onExpand, headerColor, onSend, streamingText, header }: NeedsYouStripProps) {
  const scrollRef = useRef<ScrollView>(null);

  // On web: horizontal wheel/trackpad scrolls the strip, vertical passes through to page
  useEffect(() => {
    if (Platform.OS !== "web" || !scrollRef.current) return;
    // React Native Web nests the scrollable div — walk down to find it
    const outer = (scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement })?.getScrollableNode?.()
      ?? (scrollRef.current as unknown as HTMLElement);
    if (!outer) return;
    // The actual scrollable element may be a child div with overflow
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
      <Pressable
        onPress={onExpand}
        style={({ pressed }) => [styles.headerRow, pressed && { opacity: 0.7 }]}
      >
        <Text style={[styles.sectionHeader, headerColor ? { color: headerColor } : undefined]}>{header ?? `${items.length} needs you`}</Text>
        <Text style={styles.sectionArrow}>{"\u203A"}</Text>
      </Pressable>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        style={styles.scroll}
      >
        {items.map((item) => (
          <View key={item.session.id} style={styles.cardWrapper}>
            <BreadcrumbRow item={item} />
            <ChatCard
              session={item.session}
              onDescend={onNavigate ? () => onNavigate(item.session.id) : undefined}
              urgent={item.urgent}
              important={item.important}
              onSend={onSend ? (text) => onSend(item.session.id, text) : undefined}
              streamingText={streamingText?.get(item.session.id)}
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
    paddingTop: 24,
    ...(Platform.OS === "web"
      ? { marginLeft: "auto", marginRight: "auto", overflow: "hidden" }
      : {}),
  } as any,
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.layout.gridPadding,
    marginBottom: 48,
    maxWidth: theme.layout.gridMaxWidth,
    ...(Platform.OS === "web"
      ? { cursor: "pointer", marginLeft: "auto", marginRight: "auto", width: "100%" }
      : {}),
  } as any,
  sectionHeader: {
    fontSize: 34,
    fontWeight: "700" as const,
    color: "rgba(22,18,14,0.65)",
    fontFamily: theme.fonts.sans,
    letterSpacing: -0.3,
  },
  sectionArrow: {
    fontSize: 28,
    fontWeight: "300" as const,
    color: "rgba(22,18,14,0.25)",
    fontFamily: theme.fonts.sans,
    lineHeight: 34,
  },
  scroll: {
    ...(Platform.OS === "web"
      ? { overflowX: "auto", overflowY: "hidden", overscrollBehaviorX: "contain" }
      : {}),
  } as any,
  scrollContent: {
    gap: theme.layout.gridGap,
    ...(Platform.OS === "web"
      ? {
          display: "flex",
          flexDirection: "row",
          flexWrap: "nowrap",
          paddingLeft: `max(${theme.layout.gridPadding}px, calc((100vw - ${theme.layout.gridMaxWidth}px) / 2 + ${theme.layout.gridPadding}px))`,
          paddingRight: theme.layout.gridPadding,
        }
      : { paddingHorizontal: theme.layout.gridPadding, flexDirection: "row" }),
  } as any,
  cardWrapper: {
    ...(Platform.OS === "web"
      ? {
          flexShrink: 0,
          width: "calc(50vw - 56px)",
          minWidth: 320,
          maxWidth: 560,
          maxHeight: "calc(100vh - 160px)",
        }
      : {}),
  } as any,
});
