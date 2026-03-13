import { useRef, useState } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { GLASS } from "./Glass";
import { theme } from "../constants/theme";

export interface HoverTrayAction {
  label: string;
  onPress: () => void;
}

export interface HoverTrayProps {
  children: React.ReactNode;
  actions: HoverTrayAction[];
}

export function HoverTray({ children, actions }: HoverTrayProps) {
  if (Platform.OS !== "web") {
    return <>{children}</>;
  }

  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      hideTimer.current = null;
    }, 80);
  };

  // Clean up on unmount is handled implicitly — the component unmounts and
  // the timer fires harmlessly since setState on an unmounted component is
  // a no-op in React 18+. For safety we use useRef so the ref itself is stable.

  const wrapperStyle: React.CSSProperties = {
    position: "relative" as const,
    display: "inline-flex",
  };

  const trayStyle: React.CSSProperties = {
    position: "absolute" as const,
    top: "100%",
    left: 0,
    zIndex: 100,
    marginTop: 4,
    opacity: visible ? 1 : 0,
    transition: "opacity 0.12s ease",
    pointerEvents: visible ? "auto" : "none",
    // Glass styling
    backgroundColor: GLASS.bg,
    backdropFilter: GLASS.blur,
    WebkitBackdropFilter: GLASS.blur,
    borderRadius: 20,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: GLASS.edgeColor,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 6,
    paddingBottom: 6,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    // Shadow
    boxShadow: `0px 4px 12px rgba(0,0,0,0.10)`,
    display: "flex",
    minWidth: "100%",
    justifyContent: "center" as const,
    boxSizing: "border-box" as const,
  };

  return (
    <div
      style={wrapperStyle}
      onMouseEnter={() => { cancelHide(); setVisible(true); }}
      onMouseLeave={scheduleHide}
    >
      {children}
      <div
        style={trayStyle}
        onMouseEnter={cancelHide}
        onMouseLeave={scheduleHide}
      >
        {actions.map((action) => (
          <Pressable
            key={action.label}
            onPress={action.onPress}
            style={({ pressed }) => ({
              opacity: pressed ? 0.6 : 1,
              paddingHorizontal: 10,
              paddingVertical: 6,
              ...(Platform.OS === "web" ? { cursor: "pointer" } : {}),
            })}
          >
            <Text
              style={theme.typography.hoverTrayAction}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </div>
    </div>
  );
}
