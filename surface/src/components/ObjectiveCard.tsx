import { useRef, useEffect } from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import { theme } from "../constants/theme";

export interface ObjectiveChild {
  name: string;
  status: "idle" | "thinking" | "needs-input" | "resolved" | "failed";
}

export interface ObjectiveCardData {
  id: string;
  name: string;
  description: string;
  lastAccessed: Date;
  status: "idle" | "thinking" | "needs-input" | "resolved" | "failed";
  children: ObjectiveChild[];
}

interface ObjectiveCardProps {
  data: ObjectiveCardData;
  onPress?: () => void;
  /** Dynamic time-of-day color for the objective title */
  titleColor?: string;
}

function dotColor(status: ObjectiveChild["status"]): string {
  if (status === "failed") return theme.status.failed.dot;
  if (status === "needs-input") return "hsl(215, 18%, 52%)";
  if (status === "thinking") return "hsl(32, 35%, 52%)";
  return theme.status.idle.dot;
}

export function ObjectiveCard({ data, onPress, titleColor }: ObjectiveCardProps) {
  const cardRef = useRef<View>(null);

  // Route horizontal wheel to parent horizontal scroll
  useEffect(() => {
    if (Platform.OS !== "web" || !cardRef.current) return;
    const el = cardRef.current as unknown as HTMLElement;
    const handler = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      if (dx <= 3 || dy >= dx) return;
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollWidth > parent.clientWidth + 1) {
          e.preventDefault();
          parent.scrollLeft += e.deltaX;
          return;
        }
        parent = parent.parentElement;
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const totalCount = data.children.length;

  // Resolve header tint from status
  const headerTint = theme.status[data.status as keyof typeof theme.status]?.tint
    ?? "rgba(0,0,0,0.03)";

  return (
    <Pressable
      onPress={onPress}
      style={Platform.OS === "web" ? { cursor: "pointer" } as any : undefined}
    >
      <View ref={cardRef} style={styles.container}>

        {/* Header — solid background, tinted by status */}
        <View style={[styles.header, { backgroundColor: headerTint || "rgba(0,0,0,0.03)" }]}>
          <Text style={[styles.title, titleColor ? { color: titleColor } : undefined]} numberOfLines={1}>{data.name}</Text>
          <View style={{ flex: 1 }} />
          {totalCount > 0 && (
            <Text style={styles.count}>{totalCount}</Text>
          )}
        </View>

        {/* Body — description preview + status dots */}
        <View style={styles.body}>
          <Text style={styles.description} numberOfLines={2}>{data.description}</Text>

          {data.children.length > 0 && (
            <View style={styles.dots}>
              {data.children.map((child, i) => (
                <View
                  key={i}
                  style={[styles.dot, { backgroundColor: dotColor(child.status) }]}
                />
              ))}
            </View>
          )}
        </View>

      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: 20,
    overflow: "hidden",
    ...(Platform.OS === "web"
      ? {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }
      : { flex: 1 }),
  } as any,

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 8,
  } as any,

  title: {
    fontSize: 16,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.78)",
    fontFamily: theme.fonts.sans,
    flexShrink: 1,
  },

  count: {
    fontSize: 14,
    fontWeight: "400" as const,
    color: "rgba(0,0,0,0.30)",
    fontFamily: theme.fonts.sans,
  },

  body: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 20,
    gap: 16,
    ...(Platform.OS === "web"
      ? { display: "flex", flexDirection: "column" }
      : {}),
  } as any,

  description: {
    fontSize: 13,
    fontWeight: "400" as const,
    lineHeight: 19,
    color: "rgba(0,0,0,0.45)",
    fontFamily: theme.fonts.sans,
  },

  dots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexWrap: "wrap",
  },

  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
});
