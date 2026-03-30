import { View, Pressable, StyleSheet, Platform } from "react-native";
import type { ViewStyle, PressableProps } from "react-native";
import { theme } from "../constants/theme";

const GLASS = theme.glass;

/**
 * GlassPill — flexible-width container with glass material.
 * Accepts an optional `tint` color that replaces the default background.
 */
interface GlassPillProps {
  children: React.ReactNode;
  style?: ViewStyle;
  height?: number;
  tint?: string;
}

export function GlassPill({ children, style, height = 36, tint }: GlassPillProps) {
  const r = height / 2;
  const isSplit = tint === "split";
  const splitBg = Platform.OS === "web"
    ? { background: "linear-gradient(90deg, rgba(0,122,255,0.12) 50%, rgba(255,159,10,0.12) 50%)" }
    : {};
  return (
    <View style={[pillStyles.shadow, { borderRadius: r }, style]}>
      <View
        style={[
          pillStyles.core,
          { height, borderRadius: r },
          isSplit ? splitBg as any : tint ? { backgroundColor: tint } : null,
          Platform.OS === "web" ? pillStyles.web : null,
        ]}
      >
        <View style={[pillStyles.edge, { borderRadius: r }]}>
          {children}
        </View>
      </View>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  shadow: {
    ...GLASS.shadow,
    ...(Platform.OS === "web" ? { boxShadow: "0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06)" } : {}),
  } as any,
  core: {
    overflow: "hidden",
    backgroundColor: GLASS.bg,
  },
  web: {
    backdropFilter: GLASS.blur,
    WebkitBackdropFilter: GLASS.blur,
  } as any,
  edge: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    gap: 8,
    borderWidth: GLASS.edgeBorder,
    borderColor: GLASS.edgeColor,
  },
});

/**
 * GlassButton — fixed-size pressable with glass material.
 * Accepts an optional `tint` color.
 */
interface GlassButtonProps extends Omit<PressableProps, "style"> {
  children: React.ReactNode;
  size?: number;
  round?: boolean;
  style?: ViewStyle;
  tint?: string;
}

export function GlassButton({
  children,
  size = 32,
  round = true,
  style,
  tint,
  ...pressableProps
}: GlassButtonProps) {
  const r = round ? size / 2 : 8;

  return (
    <View style={[buttonStyles.shadow, { borderRadius: r }, style]}>
      <Pressable
        {...pressableProps}
        style={({ pressed }) => [
          buttonStyles.core,
          { width: size, height: size, borderRadius: r },
          tint ? { backgroundColor: tint } : null,
          Platform.OS === "web" ? buttonStyles.web : null,
          pressed && buttonStyles.pressed,
        ]}
      >
        <View style={[buttonStyles.edge, { borderRadius: r }]}>
          {children}
        </View>
      </Pressable>
    </View>
  );
}

const buttonStyles = StyleSheet.create({
  shadow: {
    ...GLASS.shadow,
    ...(Platform.OS === "web" ? { boxShadow: "0 1px 3px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06)" } : {}),
  } as any,
  core: {
    overflow: "hidden",
    backgroundColor: GLASS.bg,
  },
  web: {
    backdropFilter: GLASS.blur,
    WebkitBackdropFilter: GLASS.blur,
    transition: GLASS.transition,
  } as any,
  pressed: {
    backgroundColor: GLASS.bgPressed,
    ...(Platform.OS === "web" ? { transform: [{ scale: 0.98 }] } : {}),
  } as any,
  edge: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: GLASS.edgeBorder,
    borderColor: GLASS.edgeColor,
  },
});

export { GLASS };
