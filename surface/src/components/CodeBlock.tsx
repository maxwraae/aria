import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Platform,
} from "react-native";
import { theme } from "../constants/theme";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code }: CodeBlockProps) {
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
      >
        <Text style={styles.code} selectable>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.codeBg,
    borderRadius: theme.radii.codeBlock,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.03)",
    marginVertical: 10,
    overflow: "hidden",
    maxHeight: 400,
  },
  scrollView: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  code: {
    ...theme.typography.codeBlock,
    fontFamily: Platform.OS === "web" ? theme.fonts.mono : "monospace",
  },
});
