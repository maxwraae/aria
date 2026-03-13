import { View, Text, StyleSheet } from "react-native";
import { theme } from "../constants/theme";
import type { UserMessage as UserMessageType } from "../types/chat";

interface UserMessageProps {
  message: UserMessageType;
}

const isChildAgent = (sender?: string) => sender && sender !== "Max";

export function UserMessage({ message }: UserMessageProps) {
  const sender = message.sender ?? "Max";
  const child = isChildAgent(message.sender);

  return (
    <View style={child ? styles.wrapperLeft : styles.wrapperRight}>
      <Text style={styles.senderLabel}>{sender}</Text>
      <View style={[styles.pill, child ? styles.pillChild : styles.pillMax]}>
        <Text style={styles.text}>{message.text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapperRight: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
    maxWidth: "85%",
    marginVertical: 6,
  },
  wrapperLeft: {
    alignSelf: "flex-start",
    alignItems: "flex-start",
    maxWidth: "85%",
    marginVertical: 6,
  },
  senderLabel: {
    fontSize: 11,
    fontWeight: "500",
    color: "rgba(0,0,0,0.32)",
    marginBottom: 3,
    letterSpacing: 0.2,
  },
  pill: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  pillMax: {
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  pillChild: {
    backgroundColor: "rgba(0,122,255,0.08)",
  },
  text: {
    ...theme.typography.userMessage,
  },
});
