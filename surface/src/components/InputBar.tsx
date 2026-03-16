import { useState, useCallback, useRef } from "react";
import {
  View,
  TextInput,
  Pressable,
  Text,
  StyleSheet,
  Platform,
} from "react-native";
import { theme } from "../constants/theme";

declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

/** Apple waveform bars for dictation */
function WaveformIcon({ color = "rgba(0,0,0,0.30)" }: { color?: string }) {
  const c = color;
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

function useVoiceInput(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const startListening = useCallback(() => {
    if (Platform.OS !== "web") return;
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("Speech recognition not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      onResult(transcript);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [onResult]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  return { isListening, startListening, stopListening };
}

interface SearchBarProps {
  onSearch?: (query: string) => void;
  onVoiceResult?: (text: string) => void;
}

export function SearchBar({ onSearch, onVoiceResult }: SearchBarProps) {
  const [text, setText] = useState("");

  const handleVoiceResult = useCallback(
    (transcript: string) => {
      setText((prev) => (prev ? prev + " " + transcript : transcript));
      onVoiceResult?.(transcript);
    },
    [onVoiceResult]
  );

  const { isListening, startListening, stopListening } =
    useVoiceInput(handleVoiceResult);

  const handleMicPress = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

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
        <Pressable
          style={({ pressed }) => [styles.micArea, pressed && styles.pressed]}
          onPress={handleMicPress}
        >
          <WaveformIcon
            color={isListening ? "rgba(255,59,48,0.8)" : "rgba(0,0,0,0.30)"}
          />
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
