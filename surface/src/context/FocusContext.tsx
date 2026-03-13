import { createContext, useContext, useState, useEffect } from "react";
import { Platform } from "react-native";
import type { ReactNode } from "react";
import type { ChatSession } from "../types/chat";

export interface FocusContextValue {
  focusedId: string | null;
  focusedSession: ChatSession | null;
  focusCard: (id: string, session: ChatSession) => void;
  dismissFocus: () => void;
}

const FocusContext = createContext<FocusContextValue>({
  focusedId: null,
  focusedSession: null,
  focusCard: () => {},
  dismissFocus: () => {},
});

export function FocusProvider({ children }: { children: ReactNode }) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusedSession, setFocusedSession] = useState<ChatSession | null>(null);

  // Escape key dismisses focus on web
  useEffect(() => {
    if (Platform.OS !== "web" || !focusedId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFocusedId(null);
        setFocusedSession(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusedId]);

  const focusCard = (id: string, session: ChatSession) => {
    setFocusedId(id);
    setFocusedSession(session);
  };

  const dismissFocus = () => {
    setFocusedId(null);
    setFocusedSession(null);
  };

  return (
    <FocusContext.Provider value={{ focusedId, focusedSession, focusCard, dismissFocus }}>
      {children}
    </FocusContext.Provider>
  );
}

export const useFocus = () => useContext(FocusContext);
