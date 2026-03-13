import { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
  Animated,
} from "react-native";
import { theme } from "../constants/theme";
import type { ToolCall } from "../types/chat";

/* ── Extract display info from raw tool_call ── */

interface FigureDisplay {
  icon: string;
  title: string;
  subtitle: string;
  expandedContent?: string;
}

function extractFigure(tool: ToolCall): FigureDisplay {
  const { name, input, result } = tool;

  switch (name) {
    case "Edit": {
      const file = input.file_path ?? "";
      const filename = file.split("/").pop() ?? file;
      const old = input.old_string ?? "";
      const next = input.new_string ?? "";
      const oldPreview = old.trim().split("\n")[0]?.slice(0, 40) ?? "";
      const newPreview = next.trim().split("\n")[0]?.slice(0, 40) ?? "";
      const subtitle = oldPreview && newPreview
        ? `${oldPreview} \u2192 ${newPreview}`
        : newPreview || "edit applied";
      return {
        icon: "\u270E", // pencil
        title: filename,
        subtitle,
        expandedContent: result ?? formatDiff(old, next),
      };
    }

    case "Write": {
      const file = input.file_path ?? "";
      const filename = file.split("/").pop() ?? file;
      const lines = (input.content ?? "").split("\n").length;
      return {
        icon: "\u270E",
        title: filename,
        subtitle: `Created (${lines} lines)`,
        expandedContent: result ?? input.content?.slice(0, 500),
      };
    }

    case "Bash": {
      const cmd = input.command ?? "";
      const cmdPreview = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
      const resultPreview = typeof result === "string"
        ? result.trim().split("\n").slice(0, 3).join("\n")
        : undefined;
      return {
        icon: ">_",
        title: cmdPreview,
        subtitle: resultPreview?.split("\n")[0]?.slice(0, 60) ?? "",
        expandedContent: typeof result === "string" ? result : undefined,
      };
    }

    case "Agent":
    case "TaskCreate": {
      const desc = input.description ?? input.prompt?.slice(0, 60) ?? name;
      return {
        icon: "\u25B6", // play
        title: desc,
        subtitle: tool.status === "running" ? "working..." : tool.status,
        expandedContent: input.prompt,
      };
    }

    default: {
      // MCP tools: mcp__google-workspace__manage_event -> "Calendar event"
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        const action = parts[parts.length - 1]?.replace(/_/g, " ") ?? name;
        const detail = input.summary ?? input.text ?? input.name ?? "";
        return {
          icon: "\u26A1", // bolt
          title: action,
          subtitle: detail,
          expandedContent: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        };
      }

      // Fallback for unknown promoted tools
      return {
        icon: "\u2022", // bullet
        title: name,
        subtitle: typeof result === "string" ? result.slice(0, 60) : "",
        expandedContent: typeof result === "string" ? result : undefined,
      };
    }
  }
}

function formatDiff(old: string, next: string): string {
  const lines: string[] = [];
  if (old) old.split("\n").forEach((l) => lines.push(`- ${l}`));
  if (next) next.split("\n").forEach((l) => lines.push(`+ ${l}`));
  return lines.join("\n");
}

/* ── Animated helpers ── */

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

function AnimatedChevron({ expanded }: { expanded: boolean }) {
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rotate, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [expanded]);

  const animatedStyle = {
    transform: [{
      rotate: rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }),
    }],
  };

  return (
    <Animated.Text style={[styles.chevron, animatedStyle]}>{"›"}</Animated.Text>
  );
}

/* ── Status dot ── */

function StatusIndicator({ status }: { status: ToolCall["status"] }) {
  const color =
    status === "running" ? theme.colors.amber :
    status === "failed" ? theme.colors.failed :
    "rgba(0,0,0,0.20)";
  const label =
    status === "running" ? "..." :
    status === "failed" ? "failed" :
    "\u2713";
  return <Text style={[styles.status, { color }]}>{label}</Text>;
}

/* ── Figure component ── */

export function Figure({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const display = extractFigure(tool);

  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      style={({ pressed }) => [
        styles.wrapper,
        pressed && { opacity: 0.6 },
      ]}
    >
      {/* Line: icon + title + status */}
      <View style={styles.topRow}>
        <Text style={styles.icon}>{display.icon}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {display.title}
        </Text>
        <StatusIndicator status={tool.status} />
        <AnimatedChevron expanded={expanded} />
      </View>

      {/* Subtitle */}
      {display.subtitle ? (
        <Text style={styles.subtitle} numberOfLines={expanded ? undefined : 1}>
          {display.subtitle}
        </Text>
      ) : null}

      {/* Expanded content */}
      {expanded && display.expandedContent ? (
        <FadeSlideIn>
          <ScrollView
            style={styles.expandedScroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.expandedText}>{display.expandedContent}</Text>
          </ScrollView>
        </FadeSlideIn>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 4,
    gap: 2,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  icon: {
    ...theme.typography.figureIcon,
    width: 18,
    textAlign: "center",
  },
  title: {
    ...theme.typography.figureTitle,
    flex: 1,
  },
  status: {
    ...theme.typography.figureStatus,
  },
  subtitle: {
    ...theme.typography.figureSubtitle,
    fontFamily: Platform.OS === "web" ? theme.fonts.mono : "monospace",
    paddingLeft: 24, // align with title (icon width 18 + gap 6)
  },
  expandedScroll: {
    maxHeight: 200,
    marginTop: 4,
    paddingLeft: 24,
  },
  expandedText: {
    ...theme.typography.figureDrawerText,
    fontFamily: Platform.OS === "web" ? theme.fonts.mono : "monospace",
  },
  chevron: {
    fontSize: 14,
    color: "rgba(0,0,0,0.25)",
    marginLeft: 2,
  },
});
