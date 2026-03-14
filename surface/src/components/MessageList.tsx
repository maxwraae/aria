import { useRef, useEffect, type ReactNode } from "react";
import { ScrollView, Animated, StyleSheet, Platform } from "react-native";
import type { ChatMessage } from "../types/chat";
import { UserMessage } from "./UserMessage";
import { AgentMessage } from "./AgentMessage";
import { Figure } from "./Figure";
import { theme } from "../constants/theme";

interface MessageListProps {
  messages: ChatMessage[];
  scrollEnabled?: boolean;
  bottomPad?: number;
  onSpeak?: (text: string) => void;
  speakingMessageId?: string | null;
}

function AnimatedMessageRow({ children, style }: { children: ReactNode; style?: any }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(14)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 280,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

export function MessageList({ messages, scrollEnabled = true, bottomPad = 120, onSpeak, speakingMessageId }: MessageListProps) {

  function renderMessage(item: ChatMessage) {
    switch (item.kind) {
      case "user":
        return <UserMessage message={item} />;
      case "agent":
        return (
          <AgentMessage
            id={item.id}
            text={item.text}
            whisper={item.whisper}
            onSpeak={onSpeak}
            isSpeaking={speakingMessageId === item.id}
          />
        );
      case "tool_call":
        return <Figure tool={item} />;
    }
  }
  const scrollRef = useRef<ScrollView>(null);

  // Scroll to bottom on mount (no animation)
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.list}
      contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator={false}
    >
      {messages.map((item) => (
        <AnimatedMessageRow key={item.id} style={styles.messageRow}>{renderMessage(item)}</AnimatedMessageRow>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
    ...(Platform.OS === "web"
      ? { overscrollBehavior: "none" }
      : {}),
  } as any,
  content: {
    paddingHorizontal: theme.layout.messagePadH,
    paddingTop: 8,
    paddingBottom: theme.layout.messagePadBottom,
  },
  messageRow: {
    marginBottom: theme.spacing.messagePaddingV,
  },
});
