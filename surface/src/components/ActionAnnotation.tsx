import { View, Text, StyleSheet } from "react-native";
import { theme } from "../constants/theme";
import type { ActionAnnotation as ActionType } from "../types/chat";

export function ActionAnnotation({ action }: { action: ActionType }) {
  return (
    <View style={styles.container}>
      <View style={styles.bar} />
      <Text style={styles.text} numberOfLines={1}>{action.summary}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 2,
    marginVertical: 1,
  },
  bar: {
    width: 2,
    height: 14,
    backgroundColor: "rgba(0,0,0,0.10)",
    borderRadius: 1,
    marginRight: 8,
  },
  text: {
    fontSize: 12,
    color: "rgba(0,0,0,0.32)",
    fontFamily: theme.fonts.sans,
    fontWeight: "400" as const,
  },
});
