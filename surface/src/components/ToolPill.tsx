import { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  ScrollView,
  Platform,
} from "react-native";
import { theme } from "../constants/theme";
import type { TraceToolGroup, PromotedTool } from "../types/chat";

/* ── Icon characters ── */
const ICONS: Record<string, string> = {
  batch: "\u25CB", // ○
  edit: "\u270E", // ✎
  agent: "\u25B6", // ▶
  bash: ">_",
  mcp: "\u26A1", // ⚡
};

/* ── Pulsing icon wrapper ── */
function PillIcon({ type, pulse }: { type: string; pulse?: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (pulse) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0.3,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      );
      anim.start();
      return () => anim.stop();
    } else {
      opacity.setValue(1);
    }
  }, [pulse]);

  return (
    <Animated.Text style={[styles.iconText, { opacity }]}>
      {ICONS[type] || ICONS.batch}
    </Animated.Text>
  );
}

/* ── FadeSlideIn ── */
function FadeSlideIn({ children, style }: { children: React.ReactNode; style?: any }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

/* ── TracePill ── */
export function TracePill({ data }: { data: TraceToolGroup }) {
  const [expanded, setExpanded] = useState(false);
  const running = data.tools.filter((t) => t.status === "running");
  const isRunning = running.length > 0;

  // Build smart summary grouped by tool name
  type Group = { label: string; details: string[] };
  const groups: Record<string, Group> = {};

  for (const tool of data.tools) {
    const label = tool.name.toLowerCase();
    if (!groups[label]) groups[label] = { label, details: [] };
    groups[label].details.push(tool.detail);
  }

  const summary = Object.values(groups)
    .map((g) => {
      const first = g.details[0];
      const rest = g.details.length - 1;
      const base = first ? `${g.label} ${first}` : g.label;
      return rest > 0 ? `${base} +${rest}` : base;
    })
    .join(" \u00B7 ");

  // Running state text
  let runningText = "";
  if (isRunning) {
    const r = running[0];
    const base = r.name.toLowerCase();
    const gerund = base.endsWith("e")
      ? base.slice(0, -1) + "ing"
      : base + "ing";
    runningText = `${gerund} ${r.detail}...`;
  }

  return (
    <View style={styles.pillWrapper}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={({ pressed }) => [
          styles.pillButton,
          pressed && styles.pillPressed,
        ]}
      >
        <PillIcon type="batch" pulse={isRunning} />
        <Text style={styles.pillLabel} numberOfLines={1}>
          {isRunning ? runningText : summary}
        </Text>
      </Pressable>
      {expanded && (
        <FadeSlideIn style={styles.expandedContainer}>
          {data.tools.map((tool, i) => (
            <View key={i} style={styles.expandedRow}>
              <Text style={styles.expandedName}>{tool.name}</Text>
              <Text style={styles.expandedDetail} numberOfLines={1}>
                {tool.detail}
              </Text>
              <Text
                style={[
                  styles.expandedStatus,
                  tool.status === "running" && styles.statusRunning,
                  tool.status === "failed" && styles.statusFailed,
                ]}
              >
                {tool.status === "running"
                  ? "..."
                  : tool.status === "failed"
                  ? "failed"
                  : "done"}
              </Text>
            </View>
          ))}
        </FadeSlideIn>
      )}
    </View>
  );
}

/* ── Extract a short detail string from promoted tool data ── */
function extractDetail(data: PromotedTool): string {
  if (data.result) return data.result;
  if (!data.input) return "";
  try {
    const parsed = JSON.parse(data.input);
    if (parsed.command) return parsed.command;
    if (parsed.new_string) return parsed.new_string.slice(0, 60);
    if (parsed.description) return parsed.description;
  } catch {}
  return data.input.slice(0, 60);
}

/* ── PromotedPill ── */
export function PromotedPill({ data }: { data: PromotedTool }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = data.status === "running";
  type ToolBarEntry = { bg: string; icon: string; text: string; chevron: string; shadow: string };
  const toolBarThemes = theme.toolBar as unknown as Record<string, ToolBarEntry>;
  const t = toolBarThemes[data.icon] ?? (theme.toolBar.agent as unknown as ToolBarEntry);

  const chevronRotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(chevronRotate, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [expanded]);

  const chevronStyle = {
    transform: [{
      rotate: chevronRotate.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '90deg'],
      })
    }]
  };

  return (
    <View style={styles.pillWrapper}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={({ pressed }) => [
          styles.promotedBar,
          { backgroundColor: t.bg },
          Platform.OS === "web" && { boxShadow: t.shadow },
          pressed && { opacity: 0.85 },
        ]}
      >
        {/* Line 1: icon + title + chevron */}
        <View style={styles.promotedTopRow}>
          <Text style={[styles.iconText, { color: t.icon }]}>
            {ICONS[data.icon] || ICONS.batch}
          </Text>
          <Text style={[styles.pillLabel, { color: t.text }]} numberOfLines={1}>
            {data.summary}
          </Text>
          <Animated.Text style={[styles.chevron, { color: t.chevron }, chevronStyle]}>{"\u203A"}</Animated.Text>
        </View>
        {/* Line 2: detail, indented to align under title */}
        {data.input && (
          <Text style={[styles.promotedDetailLine, { color: t.text }]} numberOfLines={1}>
            {extractDetail(data)}
          </Text>
        )}
      </Pressable>
      {expanded && (
        <FadeSlideIn style={styles.promotedExpanded}>
          {data.result !== undefined && (
            <Text style={styles.promotedResult}>{data.result}</Text>
          )}
          {data.input && (
            <ScrollView
              horizontal
              style={styles.promotedCode}
              showsHorizontalScrollIndicator={false}
            >
              <Text style={styles.promotedCodeText}>{data.input}</Text>
            </ScrollView>
          )}
        </FadeSlideIn>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pillWrapper: {
    marginVertical: 8,
  },
  pillButton: {
    flexDirection: "row",
    alignItems: "center",
    height: 44,
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 18,
    gap: 10,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 2px 8px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.04)" }
      : { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8 }),
  } as any,
  pillPressed: {
    backgroundColor: "rgba(0,0,0,0.03)",
  },
  iconText: {
    ...theme.typography.toolPillIcon,
  },
  pillLabel: {
    ...theme.typography.toolPill,
    flex: 1,
  },
  promotedBar: {
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 10,
    gap: 4,
  } as any,
  promotedTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  promotedDetailLine: {
    ...theme.typography.promotedDetail,
    opacity: 0.45,
  },
  expandedContainer: {
    marginTop: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.04)",
    overflow: "hidden",
    backgroundColor: "#FAFAFA",
    padding: 8,
  },
  expandedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.04)",
  },
  expandedName: {
    ...theme.typography.toolExpandedName,
    width: 50,
  },
  expandedDetail: {
    ...theme.typography.toolExpandedDetail,
    flex: 1,
  },
  expandedStatus: {
    ...theme.typography.toolExpandedStatus,
  },
  statusRunning: {
    color: theme.colors.amber,
  },
  statusFailed: {
    color: theme.colors.failed,
  },
  chevron: {
    ...theme.typography.toolChevron,
  },
  sectionLabel: {
    ...theme.typography.toolSectionLabel,
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  preScroll: {
    backgroundColor: "#F5F5F7",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.02)",
    padding: 8,
    maxHeight: 160,
  },
  preText: {
    ...theme.typography.toolPreText,
  },
  promotedExpanded: {
    marginTop: 6,
    borderRadius: 12,
    backgroundColor: "#1C1C1E",
    padding: 14,
    gap: 8,
  },
  promotedResult: {
    ...theme.typography.promotedResult,
  },
  promotedCode: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: 10,
    maxHeight: 160,
  },
  promotedCodeText: {
    ...theme.typography.promotedCode,
    fontFamily: Platform.OS === "web" ? theme.fonts.mono : "monospace",
  },
});
