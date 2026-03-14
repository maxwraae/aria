import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Platform } from "react-native";
import Markdown from "react-native-markdown-display";
import { theme } from "../constants/theme";

interface AgentMessageProps {
  id?: string;
  text: string;
  whisper?: string;
  onSpeak?: (text: string, messageId: string) => void;
  isSpeaking?: boolean;
}

const markdownStyles = StyleSheet.create({
  body: {
    ...theme.typography.markdownBody,
    ...(Platform.OS !== "web" ? { fontFamily: undefined } : {}),
  },
  strong: {
    fontWeight: "700",
    color: "rgba(0,0,0,0.90)",
  },
  em: {
    fontStyle: "italic",
  },
  code_inline: {
    ...theme.typography.markdownCodeInline,
    fontFamily: Platform.OS === "web" ? theme.fonts.sans : undefined,
    backgroundColor: "transparent",
    borderWidth: 0,
    paddingHorizontal: 0,
    borderRadius: 0,
  },
  code_block: {
    ...theme.typography.markdownCodeBlock,
    backgroundColor: theme.colors.codeBg,
    borderRadius: theme.radii.codeBlock,
    padding: 16,
    marginVertical: 10,
    fontFamily: Platform.OS === "web" ? theme.fonts.mono : "monospace",
  },
  fence: {
    ...theme.typography.markdownCodeBlock,
    backgroundColor: theme.colors.codeBg,
    borderRadius: theme.radii.codeBlock,
    padding: 16,
    marginVertical: 10,
    fontFamily: Platform.OS === "web" ? theme.fonts.mono : "monospace",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.03)",
  },
  paragraph: {
    ...theme.typography.markdownParagraph,
    marginBottom: 16,
    marginTop: 0,
  },
  bullet_list: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    marginBottom: 16,
    paddingLeft: 4,
  },
  ordered_list: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    marginBottom: 16,
    paddingLeft: 4,
  },
  list_item: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    marginBottom: 6,
    flexDirection: "row",
  },
  blockquote: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    borderLeftWidth: 3,
    borderLeftColor: "rgba(0,0,0,0.08)",
    paddingLeft: 16,
    marginBottom: 16,
    backgroundColor: "transparent",
  },
  heading1: {
    ...theme.typography.markdownHeading1,
    marginBottom: 8,
    marginTop: 16,
  },
  heading2: {
    ...theme.typography.markdownHeading2,
    marginBottom: 6,
    marginTop: 14,
  },
  heading3: {
    ...theme.typography.markdownHeading3,
    marginBottom: 4,
    marginTop: 12,
  },
  link: {
    color: theme.colors.blue,
    textDecorationLine: "none",
    fontSize: theme.typography.markdownBody.fontSize,
  },
  hr: {
    backgroundColor: "rgba(0,0,0,0.06)",
    height: StyleSheet.hairlineWidth,
    marginVertical: 20,
  },
});

const markdownRules = {};

export function AgentMessage({ id, text, whisper, onSpeak, isSpeaking }: AgentMessageProps) {
  return (
    <View style={styles.container}>
      <Markdown style={markdownStyles} rules={markdownRules}>
        {text}
      </Markdown>
      <View style={styles.footer}>
        {whisper ? (
          <Whisper text={whisper} />
        ) : <View />}
        {onSpeak ? (
          <Pressable
            onPress={() => onSpeak(text)}
            hitSlop={8}
            style={({ pressed }) => [
              styles.speakButton,
              pressed && { opacity: 0.6 },
              isSpeaking && styles.speakButtonActive,
            ]}
          >
            <Text style={[styles.speakIcon, isSpeaking && styles.speakIconActive]}>
              {isSpeaking ? '◼' : '♪'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function Whisper({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      style={({ pressed }) => [pressed && { opacity: 0.5 }]}
    >
      <Text
        style={styles.whisper}
        numberOfLines={expanded ? undefined : 1}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 4,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: -4,
  },
  whisper: {
    ...theme.typography.whisper,
    fontFamily: Platform.OS === "web" ? theme.fonts.mono : "monospace",
    textAlign: "right",
    marginTop: -8,
    flex: 1,
  },
  speakButton: {
    padding: 4,
    opacity: 0.25,
  },
  speakButtonActive: {
    opacity: 1,
  },
  speakIcon: {
    fontSize: 12,
    color: "rgba(0,0,0,0.4)",
    fontFamily: theme.fonts.sans,
  },
  speakIconActive: {
    color: theme.colors.amber,
  },
});
