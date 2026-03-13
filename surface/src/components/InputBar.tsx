import { useState, useCallback } from "react";
import {
  View,
  TextInput,
  Pressable,
  Text,
  StyleSheet,
  Platform,
} from "react-native";
import { theme } from "../constants/theme";

/** Apple waveform bars for dictation */
function WaveformIcon() {
  const c = "rgba(0,0,0,0.30)";
  return (
    <View style={waveStyles.container}>
      <View style={[waveStyles.bar, { height: 6, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 14, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 10, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 16, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 8, backgroundColor: c }]} />
    </View>
  );
}

const waveStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    height: 20,
  },
  bar: {
    width: 2.5,
    borderRadius: 2,
  },
});

interface SearchBarProps {
  onSearch?: (query: string) => void;
}

export function SearchBar({ onSearch }: SearchBarProps) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSearch?.(trimmed);
    setText("");
  };

  const handleKeyPress = (e: any) => {
    if (
      Platform.OS === "web" &&
      e.nativeEvent.key === "Enter"
    ) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <View style={styles.row}>
      <View style={styles.pill}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message..."
          placeholderTextColor="rgba(0,0,0,0.22)"
          onKeyPress={handleKeyPress}
          // @ts-ignore web-only
          enterKeyHint="send"
        />
        <Pressable style={({ pressed }) => [styles.micArea, pressed && styles.pressed]}>
          <WaveformIcon />
        </Pressable>
      </View>
    </View>
  );
}

// Keep InputBar export for backwards compat
export { SearchBar as InputBar };

const BUTTON_SIZE = 56;

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  pill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F5F3F0",
    borderRadius: 12,
    paddingLeft: 14,
    paddingRight: 4,
    minHeight: 40,
  } as any,
  input: {
    ...theme.typography.searchInput,
    flex: 1,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  micArea: {
    padding: 4,
  },
  pressed: {
    opacity: 0.5,
  },
});
