import { View, StyleSheet } from "react-native";
import { theme } from "../constants/theme";

// All five Surface status states — pulls dot color from single source of truth
type Status = keyof typeof theme.status;

export function StatusDot({ status }: { status: Status }) {
  const color = theme.status[status]?.dot ?? theme.status.idle.dot;
  return (
    <View style={[styles.dot, { backgroundColor: color }]} />
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
