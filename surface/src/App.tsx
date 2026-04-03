import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Platform, Animated, ScrollView, Dimensions } from "react-native";
import { ChatCard } from "./components/ChatCard";
import { GlassButton, GlassPill } from "./components/Glass";
import { NeedsYouStrip } from "./components/NeedsYouStrip";
import { RecentWorkStrip } from "./components/RecentWorkStrip";
import { ProjectsStrip } from "./components/ProjectsStrip";
import { theme } from "./constants/theme";
import { FocusProvider, useFocus } from "./context/FocusContext";
import { useARIA } from "./hooks/useARIA";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { usePushSubscription } from "./hooks/usePushSubscription";
import type { ObjectiveNode } from "./hooks/adapters";
import { CreateIcon, PlusIcon, PATHS } from "./components/Icons";
import { UsageRings } from "./components/UsageRings";

// Time-of-day gradient: each period has a top and base color.
// A subtle CSS breathing animation drifts lightness within the period.
const TOD_PERIODS = {
  morning:   { top: [25, 30, 89],  base: [30, 8, 93]  },  // 6-10  sunrise coral
  midday:    { top: [200, 12, 91], base: [30, 6, 94]  },  // 10-15 warm neutral
  afternoon: { top: [36, 26, 88],  base: [32, 8, 93]  },  // 15-19 golden amber
  evening:   { top: [20, 22, 87],  base: [28, 8, 92]  },  // 19-22 ember
  night:     { top: [220, 12, 87], base: [30, 5, 92]  },  // 22-6  warm slate
} as const;

type TodPeriod = keyof typeof TOD_PERIODS;

function getTimePeriod(h: number): TodPeriod {
  if (h >= 6 && h < 10) return "morning";
  if (h >= 10 && h < 15) return "midday";
  if (h >= 15 && h < 19) return "afternoon";
  if (h >= 19 && h < 22) return "evening";
  return "night";
}

const BREATHE_CSS = `
@keyframes todBreathe {
  0%, 100% { filter: brightness(1.00); }
  50%      { filter: brightness(1.015); }
}
@keyframes focusIn {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.94); }
  to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
@keyframes pulse {
  0%, 100% { opacity: 0.35; }
  50%      { opacity: 0.8; }
}
@keyframes cardBreathe {
  0%, 100% { background-color: var(--card-breathe-off); }
  50%      { background-color: var(--card-breathe-on); }
}
@keyframes cardSettle {
  0%   { background-color: var(--card-breathe-on); }
  100% { background-color: var(--card-breathe-off); }
}
@keyframes headerBreathe {
  0%, 100% { filter: brightness(1.0) saturate(1.0); }
  50%      { filter: brightness(0.97) saturate(1.3); }
}
@keyframes headerSettle {
  0%   { filter: brightness(0.97) saturate(1.3); }
  100% { filter: brightness(1.0) saturate(1.0); }
}
@keyframes heroFadeOut {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(-12px); }
}
@keyframes chatFadeIn {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes searchSlideIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}`;

function useTimeOfDay() {
  const [period, setPeriod] = useState<TodPeriod>(() => getTimePeriod(new Date().getHours()));

  useEffect(() => {
    if (Platform.OS !== "web") return;
    // Inject breathing animation
    const styleEl = document.createElement("style");
    styleEl.textContent = BREATHE_CSS;
    document.head.appendChild(styleEl);
    // Check period every minute
    const t = setInterval(() => {
      setPeriod(getTimePeriod(new Date().getHours()));
    }, 60_000);
    return () => { clearInterval(t); document.head.removeChild(styleEl); };
  }, []);

  const colors = TOD_PERIODS[period];
  const gradient = `radial-gradient(ellipse at 50% -20%, hsl(${colors.top[0]},${colors.top[1]}%,${colors.top[2]}%) 0%, hsl(${colors.base[0]},${colors.base[1]}%,${colors.base[2]}%) 75%)`;
  // Text color: same hue as background top, stronger saturation, darker
  const textColor = `hsl(${colors.top[0]}, ${Math.min(colors.top[1] + 12, 40)}%, 45%)`;
  const textColorMuted = `hsl(${colors.top[0]}, ${Math.min(colors.top[1] + 8, 30)}%, 58%)`;
  const buttonColor = `hsl(${colors.top[0]}, ${Math.min(colors.top[1] + 10, 35)}%, 55%)`;
  // Card surface — faintest echo of the sky hue on white
  const cardBg = `hsl(${colors.top[0]}, ${Math.min(colors.top[1], 14)}%, 98%)`;

  // Card breathing uses the same hue as the background, more saturated and concentrated
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const [h, s] = colors.top;
    const sat = Math.min(s + 12, 35);
    document.documentElement.style.setProperty("--card-breathe-off", `hsla(${h}, ${sat}%, 52%, 0.00)`);
    document.documentElement.style.setProperty("--card-breathe-on", `hsla(${h}, ${sat}%, 52%, 0.07)`);
  }, [period]);

  return { gradient, period, textColor, textColorMuted, buttonColor, cardBg };
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, "0");
  const time = `${h}:${m}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;
  return { time, date };
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => Dimensions.get("window").width < theme.layout.mobileBreakpoint);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const mq = window.matchMedia(`(max-width: ${theme.layout.mobileBreakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    setMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return mobile;
}

const FAVICON_COLORS: Record<TodPeriod, string> = {
  morning:   "hsl(25, 40%, 45%)",
  midday:    "hsl(200, 25%, 40%)",
  afternoon: "hsl(36, 45%, 42%)",
  evening:   "hsl(20, 40%, 40%)",
  night:     "hsl(220, 20%, 38%)",
};

const FAVICON_PATH = PATHS.wave;

function useFavicon() {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    function updateFavicon() {
      const period = getTimePeriod(new Date().getHours());
      const color = FAVICON_COLORS[period];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080"><path d="${FAVICON_PATH}" fill="${color}"/></svg>`;
      const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      document.querySelector('link[rel="icon"]')?.setAttribute("href", dataUrl);
    }
    updateFavicon();
    const t = setInterval(updateFavicon, 60_000);
    return () => clearInterval(t);
  }, []);
}

function findById(node: ObjectiveNode | null, id: string): ObjectiveNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function findPathById(node: ObjectiveNode | null, targetId: string, path: ObjectiveNode[] = []): ObjectiveNode[] | null {
  if (!node) return null;
  if (node.id === targetId) return [...path, node];
  if (node.children) {
    for (const child of node.children) {
      const result = findPathById(child, targetId, [...path, node]);
      if (result) return result;
    }
  }
  return null;
}

function CreateObjectiveOverlay({ parentId, onSubmit, onDismiss }: { parentId: string; onSubmit: (parentId: string, name: string, description?: string) => void; onDismiss: () => void }) {
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    // Auto-focus after animation
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(parentId, trimmed, description.trim() || undefined);
      onDismiss();
    }
  };

  return (
    <>
      <Pressable
        onPress={onDismiss}
        style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,10,20,0.12)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          zIndex: 300,
          cursor: "default",
        } as any}
      />
      <View
        style={{
          position: "fixed",
          top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 301,
          width: "min(440px, 85vw)",
          animation: "focusIn 200ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards",
        } as any}
      >
        <View style={{
          backgroundColor: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          borderRadius: 16,
          borderWidth: 1.5,
          borderColor: "rgba(255,255,255,0.4)",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.15,
          shadowRadius: 32,
          overflow: "hidden",
        } as any}>
          <View style={{
            paddingHorizontal: 20,
            paddingTop: 18,
            paddingBottom: 6,
          }}>
            <Text style={{
              fontSize: 13,
              fontWeight: "500" as const,
              color: "rgba(0,0,0,0.35)",
              fontFamily: theme.fonts.sans,
            }}>New objective</Text>
          </View>
          <View style={{
            paddingHorizontal: 20,
            paddingBottom: 18,
          }}>
            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={setValue}
              placeholder="What should be true?"
              placeholderTextColor="rgba(0,0,0,0.22)"
              onKeyPress={(e: any) => {
                if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
                if (Platform.OS === "web" && e.nativeEvent.key === "Escape") {
                  onDismiss();
                }
              }}
              style={{
                fontSize: 18,
                fontWeight: "400" as const,
                color: "#000000",
                fontFamily: theme.fonts.sans,
                paddingVertical: 8,
                ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
              } as any}
            />
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Description (optional)"
              placeholderTextColor="rgba(0,0,0,0.18)"
              multiline
              onKeyPress={(e: any) => {
                if (Platform.OS === "web" && e.nativeEvent.key === "Escape") {
                  onDismiss();
                }
              }}
              style={{
                fontSize: 14,
                fontWeight: "400" as const,
                color: "rgba(0,0,0,0.7)",
                fontFamily: theme.fonts.sans,
                paddingVertical: 6,
                ...(Platform.OS === "web" ? { outlineStyle: "none", fieldSizing: "content" } : {}),
              } as any}
            />
          </View>
        </View>
      </View>
    </>
  );
}

function EditObjectiveOverlay({ name, description, onSubmit, onDismiss }: { name: string; description: string; onSubmit: (name: string, description: string) => void; onDismiss: () => void }) {
  const [editName, setEditName] = useState(name);
  const [editDesc, setEditDesc] = useState(description);
  const nameRef = useRef<TextInput>(null);
  const descRef = useRef<TextInput>(null);

  useEffect(() => {
    const t = setTimeout(() => nameRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = () => {
    const trimmedName = editName.trim();
    if (!trimmedName) return;
    onSubmit(trimmedName, editDesc.trim());
    onDismiss();
  };

  return (
    <>
      <Pressable
        onPress={onDismiss}
        style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,10,20,0.12)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          zIndex: 300,
          cursor: "default",
        } as any}
      />
      <View
        style={{
          position: "fixed",
          top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 301,
          width: "min(440px, 85vw)",
          animation: "focusIn 200ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards",
        } as any}
      >
        <View style={{
          backgroundColor: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          borderRadius: 16,
          borderWidth: 1.5,
          borderColor: "rgba(255,255,255,0.4)",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.15,
          shadowRadius: 32,
          overflow: "hidden",
        } as any}>
          <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
            <Text style={{
              fontSize: 13,
              fontWeight: "500" as const,
              color: "rgba(0,0,0,0.35)",
              fontFamily: theme.fonts.sans,
            }}>Edit objective</Text>
          </View>
          <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
            <TextInput
              ref={nameRef}
              value={editName}
              onChangeText={setEditName}
              placeholder="Objective name"
              placeholderTextColor="rgba(0,0,0,0.22)"
              onKeyPress={(e: any) => {
                if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                  e.preventDefault();
                  descRef.current?.focus();
                }
                if (Platform.OS === "web" && e.nativeEvent.key === "Escape") {
                  onDismiss();
                }
              }}
              style={{
                fontSize: 18,
                fontWeight: "600" as const,
                color: "#000000",
                fontFamily: theme.fonts.sans,
                paddingVertical: 8,
                ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
              } as any}
            />
          </View>
          <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
            <Text style={{
              fontSize: 13,
              fontWeight: "500" as const,
              color: "rgba(0,0,0,0.35)",
              fontFamily: theme.fonts.sans,
              paddingBottom: 4,
            }}>Description</Text>
            <TextInput
              ref={descRef}
              value={editDesc}
              onChangeText={setEditDesc}
              placeholder="Optional description"
              placeholderTextColor="rgba(0,0,0,0.22)"
              multiline
              numberOfLines={3}
              onKeyPress={(e: any) => {
                if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
                if (Platform.OS === "web" && e.nativeEvent.key === "Escape") {
                  onDismiss();
                }
              }}
              style={{
                fontSize: 14,
                fontWeight: "400" as const,
                color: "#000000",
                fontFamily: theme.fonts.sans,
                paddingVertical: 8,
                minHeight: 64,
                ...(Platform.OS === "web" ? { outlineStyle: "none", resize: "none" } : {}),
              } as any}
            />
          </View>
          <View style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            paddingHorizontal: 20,
            paddingBottom: 16,
            paddingTop: 8,
            gap: 8,
          }}>
            <Pressable
              onPress={onDismiss}
              style={({ pressed }) => ({
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Text style={{ fontSize: 14, fontWeight: "500" as const, color: "rgba(0,0,0,0.35)", fontFamily: theme.fonts.sans }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              style={({ pressed }) => ({
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: "rgba(0,0,0,0.08)",
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Text style={{ fontSize: 14, fontWeight: "600" as const, color: "rgba(0,0,0,0.65)", fontFamily: theme.fonts.sans }}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

function ResolveObjectiveOverlay({ onSucceed, onDismiss }: { onSucceed: (text: string) => void; onDismiss: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <Pressable
        onPress={onDismiss}
        style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,10,20,0.12)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          zIndex: 300,
          cursor: "default",
        } as any}
      />
      <View
        style={{
          position: "fixed",
          top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 301,
          width: "min(440px, 85vw)",
          animation: "focusIn 200ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards",
        } as any}
      >
        <View style={{
          backgroundColor: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          borderRadius: 16,
          borderWidth: 1.5,
          borderColor: "rgba(255,255,255,0.4)",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.15,
          shadowRadius: 32,
          overflow: "hidden",
        } as any}>
          <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
            <Text style={{
              fontSize: 13,
              fontWeight: "500" as const,
              color: "rgba(0,0,0,0.35)",
              fontFamily: theme.fonts.sans,
            }}>Resolve objective</Text>
          </View>
          <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={setValue}
              placeholder="Resolution summary…"
              placeholderTextColor="rgba(0,0,0,0.22)"
              multiline
              numberOfLines={3}
              onKeyPress={(e: any) => {
                if (Platform.OS === "web" && e.nativeEvent.key === "Escape") {
                  onDismiss();
                }
              }}
              style={{
                fontSize: 15,
                fontWeight: "400" as const,
                color: "#000000",
                fontFamily: theme.fonts.sans,
                paddingVertical: 8,
                minHeight: 64,
                ...(Platform.OS === "web" ? { outlineStyle: "none", resize: "none" } : {}),
              } as any}
            />
          </View>
          <View style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            paddingHorizontal: 20,
            paddingBottom: 16,
            paddingTop: 8,
            gap: 8,
          }}>
            <Pressable
              onPress={onDismiss}
              style={({ pressed }) => ({
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Text style={{ fontSize: 14, fontWeight: "500" as const, color: "rgba(0,0,0,0.35)", fontFamily: theme.fonts.sans }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => { onSucceed(value.trim()); onDismiss(); }}
              style={({ pressed }) => ({
                paddingHorizontal: 16,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: "rgba(40,120,60,0.10)",
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Text style={{ fontSize: 14, fontWeight: "600" as const, color: "rgba(30,100,50,0.85)", fontFamily: theme.fonts.sans }}>Resolve</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}

function FocusOverlay({ onSend, onUpload, streamingText, onSpeak, speakingMessageId, titleColor, cardBg }: { onSend: (id: string, text: string) => Promise<void>; onUpload: (file: File) => Promise<string | null>; streamingText: Map<string, string>; onSpeak?: (text: string) => void; speakingMessageId?: string | null; titleColor?: string; cardBg?: string }) {
  const { focusedSession, dismissFocus } = useFocus();
  if (!focusedSession || Platform.OS !== "web") return null;
  return (
    <>
      <Pressable
        onPress={dismissFocus}
        style={{
          position: "fixed", top: theme.layout.headerH, left: 0, right: 0, bottom: 0,
          background: "rgba(10,10,20,0.20)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          zIndex: 200,
          cursor: "default",
        } as any}
      />
      <View
        style={{
          position: "fixed",
          top: `calc(50% + ${theme.layout.headerH / 2}px)`, left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(700px, 90vw)",
          height: `calc(85vh - ${theme.layout.headerH}px)`,
          zIndex: 201,
          animation: "focusIn 300ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards",
          boxShadow: "0 32px 80px rgba(0,0,0,0.35)",
          borderRadius: 20,
          overflow: "hidden",
        } as any}
      >
        <ChatCard
          session={focusedSession}
          scrollEnabled={true}
          onSend={(text) => onSend(focusedSession.id, text)}
          streamingText={streamingText.get(focusedSession.id)}
          onSpeak={onSpeak}
          speakingMessageId={speakingMessageId}
          titleColor={titleColor}
          cardBg={cardBg}
          onUpload={onUpload}
          style={{
            flex: 1,
            width: "100%",
            minWidth: "unset",
            maxWidth: "none",
            height: "100%",
            maxHeight: "none",
            borderRadius: 0,
          } as any}
        />
      </View>
    </>
  );
}

export default function App() {
  const isMobile = useIsMobile();
  const tod = useTimeOfDay();
  const clock = useClock();
  useFavicon();
  usePushSubscription();
  // URL routing: read initial state from path
  const [view, setView] = useState<"home" | "work" | "needs-you">(() => {
    if (typeof window === 'undefined') return "home";
    const path = window.location.pathname;
    if (path === '/needs-you') return "needs-you";
    if (path.startsWith('/objectives/')) return "work";
    return "home";
  });
  const [currentId, setCurrentId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const match = window.location.pathname.match(/^\/objectives\/(.+)/);
    return match ? match[1] : null;
  });

  // Sync URL on navigation
  const pushUrl = useCallback((path: string) => {
    if (typeof window !== 'undefined' && window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handler = () => {
      const path = window.location.pathname;
      if (path === '/needs-you') {
        setView("needs-you");
        setCurrentId(null);
      } else if (path.startsWith('/objectives/')) {
        const id = path.replace('/objectives/', '');
        setView("work");
        setCurrentId(id);
      } else {
        setView("home");
        setCurrentId(null);
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const aria = useARIA();
  const audioPlayer = useAudioPlayer();

  // Connect audio player to TTS WebSocket messages
  useEffect(() => {
    aria.onTTSMessage((msg) => {
      if (msg.type === 'tts_audio') {
        audioPlayer.onTTSChunk(msg);
      }
    });
  }, [aria.onTTSMessage, audioPlayer.onTTSChunk]);

  // Speak handler: if already speaking, stop. Otherwise, start TTS.
  const handleSpeak = useCallback((text: string) => {
    console.log('[TTS] handleSpeak called, text length:', text.length, 'speakingId:', audioPlayer.speakingId);
    if (audioPlayer.speakingId) {
      audioPlayer.stop();
      return;
    }
    const requestId = aria.sendTTSRequest(text);
    console.log('[TTS] sent request:', requestId);
    audioPlayer.startSpeaking(requestId);
  }, [audioPlayer, aria]);

  const current = currentId ? findById(aria.tree, currentId) : aria.tree;
  const effectiveCurrent = current ?? aria.tree;

  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideAnim = useRef(new Animated.Value(0)).current;
  const gridScrollRef = useRef<ScrollView>(null);

  // Horizontal trackpad/wheel scrolls the grid vertically
  useEffect(() => {
    if (Platform.OS !== "web" || !gridScrollRef.current) return;
    const el = (gridScrollRef.current as unknown as { getScrollableNode?: () => HTMLElement })?.getScrollableNode?.()
      ?? (gridScrollRef.current as unknown as HTMLElement);
    if (!el || !el.addEventListener) return;
    const handler = (e: WheelEvent) => {
      // If the event is mostly horizontal, convert to vertical scroll
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 3) {
        e.preventDefault();
        el.scrollTop += e.deltaX;
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const navigateTo = useCallback((node: ObjectiveNode, direction: "up" | "down" = "down") => {
    const exitY = direction === "up" ? 40 : -40;
    const enterY = direction === "up" ? -40 : 40;
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: exitY, duration: 120, useNativeDriver: true }),
    ]).start(() => {
      setCurrentId(node.id);
      pushUrl(`/objectives/${node.id}`);
      slideAnim.setValue(enterY);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    });
  }, [fadeAnim, slideAnim, pushUrl]);

  const [heroText, setHeroText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const [homeChatId, setHomeChatId] = useState<string | null>(null);
  const [mobileChatId, setMobileChatId] = useState<string | null>(null);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const enterWorkView = useCallback((id: string) => {
    if (isMobile) {
      setMobileChatId(id);
      aria.loadConversation(id);
      aria.watchObjective(id);
      return;
    }
    setCurrentId(id);
    slideAnim.setValue(-40);
    fadeAnim.setValue(0);
    setView("work");
    pushUrl(`/objectives/${id}`);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [isMobile, fadeAnim, slideAnim, pushUrl, aria.loadConversation, aria.watchObjective]);

  const handleVoiceInput = useCallback(() => {
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }

    const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[Voice] Speech recognition not supported');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = true;

    recognition.onresult = (event: any) => {
      // Collect all new results since continuous mode appends
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i]?.[0]?.transcript;
        if (text && event.results[i].isFinal) {
          setHeroText((prev: string) => prev ? prev + ' ' + text : text);
        }
      }
    };
    recognition.onend = () => {
      // In continuous mode, onend only fires when manually stopped
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognition.onerror = (e: any) => {
      console.warn('[Voice] Error:', e.error);
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening]);

  // Load conversation and subscribe to streaming when entering work view
  useEffect(() => {
    if (currentId) {
      aria.loadConversation(currentId);
      aria.watchObjective(currentId);
    }
  }, [currentId]);

  // Preload conversations for all NeedsYou strip items
  useEffect(() => {
    for (const item of aria.needsYou) {
      aria.loadConversation(item.session.id);
    }
  }, [aria.needsYou.map(i => i.session.id).join(',')]);

  const [searchResults, setSearchResults] = useState<ObjectiveNode[]>([]);

  // Client-side search as user types in hero input
  useEffect(() => {
    const q = heroText.trim().toLowerCase();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    const matches = aria.objectives
      .filter(o => o.id !== 'root' && o.id !== 'quick' && o.status !== 'resolved' && o.status !== 'abandoned')
      .filter(o =>
        o.objective.toLowerCase().includes(q) ||
        (o.description ?? '').toLowerCase().includes(q)
      )
      .slice(0, 5)
      .map(o => ({
        id: o.id,
        name: o.objective,
        status: (o.status === 'abandoned' ? 'failed' : o.status) as ObjectiveNode['status'],
        description: o.description ?? undefined,
      }));
    setSearchResults(matches);
  }, [heroText, aria.objectives]);

  const handleHeroSubmit = useCallback(async () => {
    const trimmed = heroText.trim();
    if (!trimmed) return;
    setHeroText("");
    setSearchResults([]);
    const newId = await aria.createObjective('quick', trimmed, trimmed);
    if (newId) {
      aria.loadConversation(newId);
      aria.watchObjective(newId);
      setHomeChatId(newId);
    }
  }, [heroText, aria.createObjective, aria.loadConversation]);

  const path = (effectiveCurrent && currentId)
    ? (findPathById(aria.tree, currentId) || [effectiveCurrent])
    : (effectiveCurrent ? [effectiveCurrent] : []);
  const ancestors = path.slice(0, -1);
  const children = (effectiveCurrent?.children || []).filter(c => !(effectiveCurrent?.id === 'root' && c.id === 'quick'));

  // Preload conversations for children of the current objective
  useEffect(() => {
    for (const child of children) {
      aria.loadConversation(child.id);
      aria.watchObjective(child.id);
    }
  }, [children.map(c => c.id).join(',')]);

  const goHome = useCallback(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 40, duration: 120, useNativeDriver: true }),
    ]).start(() => {
      setView("home");
      setCurrentId(null);
      pushUrl('/');
      slideAnim.setValue(0);
      fadeAnim.setValue(1);
    });
  }, [fadeAnim, slideAnim, pushUrl]);

  const enterNeedsYou = useCallback(() => {
    slideAnim.setValue(-40);
    fadeAnim.setValue(0);
    setView("needs-you");
    pushUrl('/needs-you');
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim, pushUrl]);

  const goUp = useCallback(() => {
    if (ancestors.length > 0) navigateTo(ancestors[ancestors.length - 1], "up");
  }, [ancestors, navigateTo]);

  const goDown = useCallback((child: ObjectiveNode) => {
    navigateTo(child, "down");
  }, [navigateTo]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "ArrowUp") { e.preventDefault(); if (ancestors.length > 0) navigateTo(ancestors[ancestors.length - 1], "up"); }
      if (e.key === "ArrowDown") { e.preventDefault(); const d = children.find((c) => c.children && c.children.length > 0); if (d) navigateTo(d, "down"); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ancestors, children, navigateTo]);

  // Build collapsed breadcrumb: ancestors only (current node shown in objective section below)
  const maxCrumbs = isMobile ? 2 : 3;
  const displayPath: { node: ObjectiveNode; isEllipsis?: boolean }[] = [];
  if (ancestors.length <= maxCrumbs) {
    ancestors.forEach((n) => displayPath.push({ node: n }));
  } else {
    displayPath.push({ node: ancestors[0] }); // root
    displayPath.push({ node: ancestors[0], isEllipsis: true }); // ...
    const tail = ancestors.slice(-(maxCrumbs - 1));
    tail.forEach((n) => displayPath.push({ node: n }));
  }

  return (
    <FocusProvider>
      <>
        {view === "home" && (
          <View style={[styles.root, Platform.OS === "web" ? { background: tod.gradient, transition: "background 2s ease", animation: "todBreathe 8s ease-in-out infinite" } as any : null]}>
            {/* Header — home pill left, clock right (hidden on mobile) */}
            {!isMobile && (
            <View style={styles.header}>
              <View style={styles.headerInner}>
                <Pressable onPress={() => enterWorkView('root')} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
                  <GlassPill height={36}>
                    <Text style={styles.homeIcon}>{"\u2302"}</Text>
                  </GlassPill>
                </Pressable>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 } as any}>
                  {(() => {
                    const thinkingCount = aria.objectives.filter(o => o.status === 'thinking').length;
                    const needsCount = aria.needsYou.length;
                    if (!thinkingCount && !needsCount) return null;
                    return (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 } as any}>
                        {thinkingCount > 0 && (
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(40,35,30,0.06)", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 } as any}>
                            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(40,35,30,0.18)" }} />
                            <Text style={{ fontSize: 11, fontWeight: "600" as const, color: "rgba(40,35,30,0.45)", fontFamily: theme.fonts.sans }}>{thinkingCount}</Text>
                          </View>
                        )}
                        {needsCount > 0 && (
                          <Pressable onPress={enterNeedsYou} style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "hsla(30, 28%, 52%, 0.12)", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, cursor: "pointer" } as any}>
                            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "hsl(30, 35%, 50%)" }} />
                            <Text style={{ fontSize: 11, fontWeight: "600" as const, color: "hsl(30, 30%, 40%)", fontFamily: theme.fonts.sans }}>{needsCount}</Text>
                          </Pressable>
                        )}
                      </View>
                    );
                  })()}
                  <UsageRings />
                  <View style={styles.clockGroup}>
                    <Text style={styles.clockTime}>{clock.time}</Text>
                    <Text style={styles.clockDate}>{clock.date}</Text>
                  </View>
                </View>
              </View>
            </View>
            )}

            {homeChatId ? (
              /* ── Home chat mode: hero area replaced by root ChatCard ── */
              isMobile ? (
                /* Mobile: full-screen overlay */
                <View style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 250, background: tod.gradient, animation: "chatFadeIn 250ms ease-out both", display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 12px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" } as any}>
                  <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 } as any}>
                    <Pressable
                      onPress={() => setHomeChatId(null)}
                      style={({ pressed }) => [{ padding: 8 } as any, pressed && { opacity: 0.5 }]}
                    >
                      <Text style={{ color: tod.textColor, fontSize: 18, fontFamily: theme.fonts.sans, fontWeight: "400" as const }}>{"\u2190"}</Text>
                    </Pressable>
                  </View>
                  <ChatCard
                    session={aria.getSession(homeChatId)}
                    scrollEnabled={true}
                    onSend={(text) => aria.sendMessage(homeChatId, text)}
                    streamingText={aria.streamingText.get(homeChatId)}
                    onSpeak={handleSpeak}
                    speakingMessageId={audioPlayer.speakingId}
                    titleColor={tod.textColor} cardBg={tod.cardBg}
                    onUpload={async (file) => aria.uploadFile(file)}
                    style={{ flex: 1, width: "100%", maxWidth: "none", maxHeight: "none", borderRadius: 0 } as any}
                  />
                </View>
              ) : (
                /* Desktop: existing homeChatContainer */
                <View style={styles.homeChatContainer as any}>
                  <Pressable
                    onPress={() => setHomeChatId(null)}
                    style={({ pressed }) => [styles.homeChatDismiss as any, pressed && { opacity: 0.5 }]}
                  >
                    <Text style={{ color: tod.textColor, fontSize: 14, fontFamily: theme.fonts.sans, fontWeight: "400" as const }}>{"\u2190"}</Text>
                  </Pressable>
                  <ChatCard
                    session={aria.getSession(homeChatId)}
                    scrollEnabled={true}
                    onSend={(text) => aria.sendMessage(homeChatId!, text)}
                    streamingText={aria.streamingText.get(homeChatId!)}
                    onSpeak={handleSpeak}
                    speakingMessageId={audioPlayer.speakingId}
                    titleColor={tod.textColor} cardBg={tod.cardBg}
                    onUpload={async (file) => aria.uploadFile(file)}
                    style={{ flex: 1, maxWidth: 640, width: "100%" } as any}
                  />
                </View>
              )
            ) : (
              /* ── Normal home: scrollable hero + strips ── */
              <>
              <ScrollView
                style={styles.homeScroll}
                contentContainerStyle={[styles.homeScrollContent, isMobile && { paddingTop: 16, paddingBottom: 100 }]}
                showsVerticalScrollIndicator={false}
              >
                {/* Hero — input at center */}
                <View style={styles.heroContainer}>
                  <View style={styles.heroInner}>
                    <Text style={[styles.heroGreeting, { color: tod.textColor }]}>What are you working on?</Text>
                    {!isMobile && (
                      <View style={[{ width: "100%", backgroundColor: "#F5F3F0", borderRadius: 14, minHeight: 90 } as any, searchResults.length > 0 && { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }]}>
                        {/* Input row */}
                        <View style={{ paddingHorizontal: 18, paddingTop: 6 } as any}>
                          <TextInput
                            style={styles.heroInput}
                            value={heroText}
                            onChangeText={setHeroText}
                            placeholder="Start something new..."
                            placeholderTextColor="rgba(0,0,0,0.22)"
                            multiline
                            onKeyPress={(e: any) => {
                              if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                                e.preventDefault();
                                handleHeroSubmit();
                              }
                            }}
                            // @ts-ignore web-only
                            enterKeyHint="send"
                          />
                        </View>
                        {/* Action row */}
                        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: 12, paddingRight: 6, paddingBottom: 6, paddingTop: 2 } as any}>
                          <Pressable onPress={() => setCreateParentId('root')} style={({ pressed }) => [{ alignItems: "center", justifyContent: "center" } as any, pressed && { opacity: 0.5 }]}>
                            <CreateIcon size={28} bg={tod.buttonColor} color="#FFFFFF" />
                          </Pressable>
                          {heroText.trim().length > 0 ? (
                            <Pressable onPress={handleHeroSubmit} style={({ pressed }) => [styles.heroSendBtn, { backgroundColor: tod.buttonColor }, pressed && { opacity: 0.5 }]}>
                              <Text style={styles.heroSendArrow}>{"\u2191"}</Text>
                            </Pressable>
                          ) : (
                            <Pressable onPress={handleVoiceInput} style={({ pressed }) => [styles.heroWaveform, pressed && { opacity: 0.5 }]}>
                              {[5, 11, 8, 13, 6].map((h, i) => (
                                <View key={i} style={{ width: 2, height: h, borderRadius: 1.5, backgroundColor: isListening ? "rgba(255,59,48,0.8)" : "rgba(0,0,0,0.25)" }} />
                              ))}
                            </Pressable>
                          )}
                        </View>
                      </View>
                    )}
                    {/* Search results — connected below input */}
                    {!isMobile && searchResults.length > 0 && (
                      <View style={styles.searchResults}>
                        {searchResults.map((result, idx) => (
                          <Pressable
                            key={result.id}
                            onPress={() => {
                              setHeroText("");
                              setSearchResults([]);
                              enterWorkView(result.id);
                            }}
                            style={({ pressed }) => [styles.searchRow, pressed && { opacity: 0.6 }, idx === 0 && { borderTopWidth: 1, borderTopColor: "rgba(0,0,0,0.06)" }]}
                          >
                            <View style={[styles.searchDot, {
                              backgroundColor: result.status === 'needs-input' ? 'rgba(0,0,0,0.35)'
                                : result.status === 'thinking' ? 'hsla(32, 35%, 52%, 1)'
                                : 'rgba(0,0,0,0.15)',
                            }]} />
                            <Text style={styles.searchName} numberOfLines={1}>{result.name}</Text>
                            {result.description && (
                              <Text style={styles.searchDesc} numberOfLines={1}>{result.description}</Text>
                            )}
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>
                </View>

                {/* Needs You strip — desktop only */}
                {!isMobile && <NeedsYouStrip items={aria.needsYou} onNavigate={(id) => enterWorkView(id)} onExpand={enterNeedsYou} headerColor={tod.textColor} onSend={aria.sendMessage} streamingText={aria.streamingText} />}

                {/* Quick strip — desktop only */}
                {!isMobile && aria.quickItems.length > 0 && <NeedsYouStrip items={aria.quickItems} onNavigate={(id) => enterWorkView(id)} onExpand={() => enterWorkView('quick')} headerColor={tod.textColor} onSend={aria.sendMessage} streamingText={aria.streamingText} header="Quick" />}

                {/* Projects — root-level objectives as grid tiles */}
                {!isMobile && aria.tree && (
                  <ProjectsStrip
                    projects={(aria.tree.children ?? []).filter(c => c.status !== 'resolved' && c.id !== 'quick')}
                    onNavigate={(id) => enterWorkView(id)}
                    onCreateChild={(id) => setCreateParentId(id)}
                    onEdit={(id) => setEditingId(id)}
                    headerColor={tod.textColor}
                    titleColor={tod.textColor}
                  />
                )}

                {/* Recent Work strip — desktop only */}
                {!isMobile && <RecentWorkStrip items={aria.recentWork} onNavigate={(id) => enterWorkView(id)} headerColor={tod.textColor} />}
              </ScrollView>

              {/* Mobile: fixed input bar pinned to bottom */}
              {isMobile && (
                <View style={{
                  position: "fixed",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  paddingHorizontal: 32,
                  paddingTop: 12,
                  paddingBottom: `calc(28px + env(safe-area-inset-bottom))`,
                  zIndex: 100,
                } as any}>
                  {/* Search results render above input on mobile — connected */}
                  {searchResults.length > 0 && (
                    <View style={[styles.searchResults, { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: 14, borderTopRightRadius: 14, marginBottom: 0 }]}>
                      {searchResults.map((result, idx) => (
                        <Pressable
                          key={result.id}
                          onPress={() => {
                            setHeroText("");
                            setSearchResults([]);
                            enterWorkView(result.id);
                          }}
                          style={({ pressed }) => [styles.searchRow, pressed && { opacity: 0.6 }, idx === searchResults.length - 1 && { borderBottomWidth: 1, borderBottomColor: "rgba(0,0,0,0.06)" }]}
                        >
                          <View style={[styles.searchDot, {
                            backgroundColor: result.status === 'needs-input' ? 'rgba(0,0,0,0.35)'
                              : result.status === 'thinking' ? 'hsla(32, 35%, 52%, 1)'
                              : 'rgba(0,0,0,0.15)',
                          }]} />
                          <Text style={styles.searchName} numberOfLines={1}>{result.name}</Text>
                          {result.description && (
                            <Text style={styles.searchDesc} numberOfLines={1}>{result.description}</Text>
                          )}
                        </Pressable>
                      ))}
                    </View>
                  )}
                  <View style={[styles.heroInputWrapper, {
                    backgroundColor: "rgba(255,255,255,0.85)",
                    borderWidth: 1,
                    borderColor: "rgba(0,0,0,0.08)",
                    shadowColor: "#000",
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.08,
                    shadowRadius: 12,
                    minHeight: 48,
                  }, searchResults.length > 0 && { borderTopLeftRadius: 0, borderTopRightRadius: 0 }]}>
                    <Pressable onPress={() => setCreateParentId('root')} style={({ pressed }) => [{ width: 38, height: 38, alignItems: "center", justifyContent: "center" } as any, pressed && { opacity: 0.5 }]}>
                      <Text style={{ fontSize: 20, fontWeight: "300", color: "rgba(0,0,0,0.25)", fontFamily: theme.fonts.sans, lineHeight: 22 }}>+</Text>
                    </Pressable>
                    <TextInput
                      style={styles.heroInput}
                      value={heroText}
                      onChangeText={setHeroText}
                      placeholder="Start something new..."
                      placeholderTextColor="rgba(0,0,0,0.38)"
                      multiline
                      onKeyPress={(e: any) => {
                        if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                          e.preventDefault();
                          handleHeroSubmit();
                        }
                      }}
                      // @ts-ignore web-only
                      enterKeyHint="send"
                    />
                    {heroText.trim().length > 0 ? (
                      <Pressable onPress={handleHeroSubmit} style={({ pressed }) => [styles.heroSendBtn, pressed && { opacity: 0.5 }]}>
                        <Text style={styles.heroSendArrow}>{"\u2191"}</Text>
                      </Pressable>
                    ) : (
                      <Pressable onPress={handleVoiceInput} style={({ pressed }) => [styles.heroWaveform, pressed && { opacity: 0.5 }]}>
                        {[5, 11, 8, 13, 6].map((h, i) => (
                          <View key={i} style={{ width: 2, height: h, borderRadius: 1.5, backgroundColor: isListening ? "rgba(255,59,48,0.8)" : "rgba(0,0,0,0.25)" }} />
                        ))}
                      </Pressable>
                    )}
                  </View>
                </View>
              )}
              </>
            )}

            {/* Mobile: full-screen objective chat overlay */}
            {isMobile && mobileChatId && (
              <View style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 250, background: tod.gradient, animation: "chatFadeIn 250ms ease-out both", display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 12px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" } as any}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 } as any}>
                  <Pressable
                    onPress={() => setMobileChatId(null)}
                    style={({ pressed }) => [{ padding: 8 } as any, pressed && { opacity: 0.5 }]}
                  >
                    <Text style={{ color: tod.textColor, fontSize: 18, fontFamily: theme.fonts.sans, fontWeight: "400" as const }}>{"\u2190"}</Text>
                  </Pressable>
                </View>
                <ChatCard
                  session={aria.getSession(mobileChatId)}
                  scrollEnabled={true}
                  onSend={(text) => aria.sendMessage(mobileChatId, text)}
                  streamingText={aria.streamingText.get(mobileChatId)}
                  onSpeak={handleSpeak}
                  speakingMessageId={audioPlayer.speakingId}
                  titleColor={tod.textColor} cardBg={tod.cardBg}
                  onUpload={async (file) => aria.uploadFile(file)}
                  style={{ flex: 1, width: "100%", maxWidth: "none", maxHeight: "none", borderRadius: 0 } as any}
                />
              </View>
            )}

          </View>
        )}
        {view === "needs-you" && (
          <View style={[styles.root, Platform.OS === "web" ? { background: tod.gradient, transition: "background 2s ease", animation: "todBreathe 8s ease-in-out infinite" } as any : null]}>

            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerInner}>
                <View style={styles.breadcrumbRow}>
                  <Pressable onPress={goHome} style={Platform.OS === "web" ? { cursor: "pointer" } as any : undefined}>
                    <GlassPill height={36} tint="rgba(255,255,255,0.5)">
                      <Text style={styles.homeIcon}>{"\u2302"}</Text>
                    </GlassPill>
                  </Pressable>
                  <Text style={styles.breadcrumbSep}>{"\u203A"}</Text>
                  <GlassPill height={30}>
                    <Text style={styles.breadcrumbCurrent}>Needs you</Text>
                  </GlassPill>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 } as any}>
                  <UsageRings />
                  <View style={styles.clockGroup}>
                    <Text style={styles.clockTime}>{clock.time}</Text>
                    <Text style={styles.clockDate}>{clock.date}</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Card grid — all needs-you sessions */}
            <Animated.View style={[styles.contentOuter, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
              <ScrollView
                showsVerticalScrollIndicator={false}
                style={styles.content}
                contentContainerStyle={styles.scrollContent}
              >
                <View style={styles.gridContent}>
                  {aria.needsYou.map((item, i) => {
                    const obj = aria.objectives.find(o => o.id === item.session.id);
                    return (
                    <ChatCard
                      key={item.session.id}
                      session={item.session}
                      focused={i === 0}
                      onResolve={() => setResolvingId(item.session.id)}
                      urgent={item.urgent}
                      important={item.important}
                      onSend={(text) => aria.sendMessage(item.session.id, text)}
                      streamingText={aria.streamingText.get(item.session.id)}
                      machine={obj?.machine}
                      onSetMachine={(m) => aria.setMachine(item.session.id, m)}
                      onSetModel={(m) => aria.updateObjective(item.session.id, { model: m })}
                      onSpeak={handleSpeak}
                      speakingMessageId={audioPlayer.speakingId}
                      titleColor={tod.textColor} cardBg={tod.cardBg}
                      onUpload={async (file) => aria.uploadFile(file)}
                    />
                    );
                  })}
                </View>
              </ScrollView>
            </Animated.View>

          </View>
        )}
        {view === "work" && (
          <View style={[styles.root, Platform.OS === "web" ? { background: tod.gradient, transition: "background 2s ease", animation: "todBreathe 8s ease-in-out infinite" } as any : null]}>

            {/* ── HEADER ── */}
            <View style={styles.header}>
              <View style={styles.headerInner}>
                <View style={styles.breadcrumbRow}>
                  {/* Ancestors: home + path, no separators, faded, close together */}
                  <Pressable onPress={goHome} style={Platform.OS === "web" ? { cursor: "pointer" } as any : undefined}>
                    <GlassPill height={36} tint="rgba(255,255,255,0.5)">
                      <Text style={styles.homeIcon}>{"\u2302"}</Text>
                    </GlassPill>
                  </Pressable>
                  {displayPath.map((entry, i) => {
                    if (entry.isEllipsis) {
                      return (
                        <Text key="ellipsis" style={styles.breadcrumbAncestor}>...</Text>
                      );
                    }
                    return (
                      <Pressable key={entry.node.id + i} onPress={() => navigateTo(entry.node, "up")} style={Platform.OS === "web" ? { cursor: "pointer" } as any : undefined}>
                        <GlassPill height={30} tint="rgba(255,255,255,0.5)">
                          <Text style={styles.breadcrumbAncestor}>{entry.node.name}</Text>
                        </GlassPill>
                      </Pressable>
                    );
                  })}
                  {/* Single separator before current */}
                  <Text style={styles.breadcrumbSep}>{"\u203A"}</Text>
                  <GlassPill height={30}>
                    <Text style={styles.breadcrumbCurrent}>{effectiveCurrent?.name ?? ""}</Text>
                  </GlassPill>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 } as any}>
                  <UsageRings />
                  <View style={styles.clockGroup}>
                    <Text style={styles.clockTime}>{clock.time}</Text>
                    <Text style={styles.clockDate}>{clock.date}</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* ── CONTENT ── */}
            <Animated.View
              style={[styles.contentOuter, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
            >
              <ScrollView
                ref={gridScrollRef}
                showsVerticalScrollIndicator={false}
                style={styles.content}
                contentContainerStyle={styles.scrollContent}
              >
                {/* Objective section — title, description, actions */}
                <View style={styles.objectiveSection}>
                  <Text style={[styles.objectiveTitle, { color: tod.textColor }]}>{effectiveCurrent?.name ?? ""}</Text>
                  <Text style={[styles.objectiveDescription, { maxWidth: 640 }]}>{effectiveCurrent?.description || "No description"}</Text>
                  <View style={styles.actionButtons}>
                    <GlassButton size={38} onPress={() => {
                      if (currentId) setResolvingId(currentId);
                    }}>
                      <Text style={styles.actionButtonIcon}>{"\u2713"}</Text>
                    </GlassButton>
                    <GlassButton size={38} onPress={() => {
                      if (currentId) setEditingId(currentId);
                    }}>
                      <Text style={styles.actionButtonIcon}>{"\u270E"}</Text>
                    </GlassButton>
                    <GlassButton size={38} onPress={() => {
                      if (currentId) setCreateParentId(currentId);
                    }}>
                      <PlusIcon size={16} color="rgba(0,0,0,0.45)" />
                    </GlassButton>
                  </View>
                </View>

                {/* Card grid */}
                <View style={styles.gridContent}>
                  {children.map((child, i) => (
                    <ChatCard
                      key={child.id}
                      session={aria.getSession(child.id)}
                      focused={i === 0}
                      onDescend={() => goDown(child)}
                      childCount={child.children?.length ?? 0}
                      resolvedCount={child.children?.filter(c => c.status === "resolved").length ?? 0}
                      urgent={child.urgent}
                      important={child.important}
                      onResolve={() => setResolvingId(child.id)}
                      onAddChild={() => setCreateParentId(child.id)}
                      onSend={(text) => aria.sendMessage(child.id, text)}
                      streamingText={aria.streamingText.get(child.id)}
                      machine={child.machine}
                      onSetMachine={(m) => aria.setMachine(child.id, m)}
                      onSetModel={(m) => aria.updateObjective(child.id, { model: m })}
                      onSpeak={handleSpeak}
                      speakingMessageId={audioPlayer.speakingId}
                      titleColor={tod.textColor} cardBg={tod.cardBg}
                      onUpload={async (file) => aria.uploadFile(file)}
                    />
                  ))}
                </View>
              </ScrollView>
            </Animated.View>

          </View>
        )}
        <FocusOverlay onSend={aria.sendMessage} onUpload={async (file) => aria.uploadFile(file)} streamingText={aria.streamingText} onSpeak={handleSpeak} speakingMessageId={audioPlayer.speakingId} titleColor={tod.textColor} cardBg={tod.cardBg} />
        {createParentId && (
          <CreateObjectiveOverlay
            parentId={createParentId}
            onSubmit={async (parentId, name, desc) => {
              const newId = await aria.createObjective(parentId, name);
              if (newId && desc) await aria.updateObjective(newId, { description: desc });
              if (newId && parentId !== currentId) enterWorkView(newId);
            }}
            onDismiss={() => setCreateParentId(null)}
          />
        )}
        {editingId && (() => {
          const node = findById(aria.tree, editingId);
          return (
            <EditObjectiveOverlay
              name={node?.name ?? ""}
              description={node?.description ?? ""}
              onSubmit={(newName, newDesc) => {
                const nameChanged = newName !== (node?.name ?? "");
                const descChanged = newDesc !== (node?.description ?? "");
                if (nameChanged || descChanged) {
                  const fields: { objective?: string; description?: string } = {};
                  if (nameChanged) fields.objective = newName;
                  if (descChanged) fields.description = newDesc;
                  aria.updateObjective(editingId, fields);
                }
              }}
              onDismiss={() => setEditingId(null)}
            />
          );
        })()}
        {resolvingId && (
          <ResolveObjectiveOverlay
            onSucceed={(summary) => aria.succeedObjective(resolvingId, summary)}
            onDismiss={() => setResolvingId(null)}
          />
        )}
      </>
    </FocusProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    ...(Platform.OS === "web"
      ? { backgroundColor: theme.colors.background, height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }
      : { backgroundColor: theme.colors.background }),
  } as any,

  // ── Header ──
  header: {
    ...(Platform.OS === "web"
      ? {
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 210,
          height: theme.layout.headerH,
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          backgroundColor: "rgba(237,235,232,0.80)",
        }
      : { position: "absolute", top: 0, left: 0, right: 0, height: theme.layout.headerH, backgroundColor: "#F0F0F0" }),
    alignItems: "center",
  } as any,
  headerInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flex: 1,
    maxWidth: theme.layout.gridMaxWidth,
    width: "100%",
    paddingHorizontal: theme.layout.gridPadding,
    height: "100%",
  } as any,
  breadcrumbRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  homeIcon: {
    fontSize: 20,
    fontWeight: "400" as const,
    color: "rgba(40,35,30,0.50)",
    fontFamily: theme.fonts.sans,
  },
  breadcrumbAncestor: {
    ...theme.typography.breadcrumbAncestor,
  },
  breadcrumbCurrent: {
    ...theme.typography.breadcrumbCurrent,
  },
  breadcrumbSep: {
    fontSize: 28,
    fontWeight: "200" as const,
    color: "rgba(40,35,30,0.20)",
    fontFamily: theme.fonts.sans,
    marginHorizontal: 8,
  },
  plusIcon: {
    ...theme.typography.plusIcon,
  },
  // ── Clock ──
  clockGroup: {
    alignItems: "flex-end",
    gap: 1,
  },
  clockTime: {
    fontSize: 18,
    fontWeight: "500" as const,
    color: "rgba(22,18,14,0.50)",
    fontFamily: theme.fonts.sans,
    letterSpacing: 0.5,
  },
  clockDate: {
    fontSize: 13,
    fontWeight: "400" as const,
    color: "rgba(22,18,14,0.32)",
    fontFamily: theme.fonts.sans,
  },

  // ── Home scroll ──
  homeScroll: {
    ...(Platform.OS === "web"
      ? {
          flexGrow: 1,
          flexBasis: 0,
          overscrollBehavior: "none",
        }
      : { flex: 1 }),
  } as any,
  homeScrollContent: {
    paddingTop: theme.layout.headerH,
    paddingBottom: "50vh",
  },

  // ── Home hero ──
  heroContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    ...(Platform.OS === "web"
      ? { minHeight: `calc(100vh - ${theme.layout.headerH}px - 100px)` }
      : {}),
  } as any,
  heroInner: {
    alignItems: "center",
    width: "100%",
    maxWidth: 520,
    gap: 24,
  } as any,
  heroGreeting: {
    fontSize: 34,
    fontWeight: "700" as const,
    color: "rgba(22,18,14,0.65)",
    fontFamily: theme.fonts.sans,
    letterSpacing: -0.3,
    textAlign: "center",
  },
  heroInputWrapper: {
    flexDirection: "row",
    alignItems: "flex-end",
    width: "100%",
    backgroundColor: "#F5F3F0",
    borderRadius: 14,
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: 52,
    gap: 8,
  } as any,
  heroInput: {
    flex: 1,
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 22,
    color: "#000000",
    fontFamily: theme.fonts.sans,
    paddingVertical: 8,
    ...(Platform.OS === "web" ? { outlineStyle: "none", fieldSizing: "content" } : {}),
  } as any,
  heroSendBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroSendArrow: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700" as const,
    lineHeight: 18,
    fontFamily: theme.fonts.sans,
  },
  heroWaveform: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    height: 38,
    paddingHorizontal: 10,
  },

  // ── Home chat mode ──
  homeChatContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    width: "100%",
    ...(Platform.OS === "web" ? {
      height: `calc(100vh - ${theme.layout.headerH}px)`,
      marginTop: theme.layout.headerH,
      animation: "chatFadeIn 250ms ease-out both",
    } : {}),
  } as any,
  homeChatDismiss: {
    alignSelf: "center",
    maxWidth: 640,
    width: "100%",
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 4,
    ...(Platform.OS === "web" ? { cursor: "pointer" } : {}),
  } as any,

  // ── Search results ──
  searchResults: {
    width: "100%",
    backgroundColor: "#F5F3F0",
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    marginTop: 0,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    ...(Platform.OS === "web" ? {
      animation: "searchSlideIn 150ms ease-out",
    } : {}),
  } as any,
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 10,
    ...(Platform.OS === "web" ? { cursor: "pointer" } : {}),
  } as any,
  searchDot: {
    width: theme.typography.cardTitle.fontSize > 15 ? 8 : 6,
    height: theme.typography.cardTitle.fontSize > 15 ? 8 : 6,
    borderRadius: theme.typography.cardTitle.fontSize > 15 ? 4 : 3,
  },
  searchName: {
    fontSize: theme.typography.cardTitle.fontSize,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.75)",
    fontFamily: theme.fonts.sans,
    flexShrink: 1,
  },
  searchDesc: {
    fontSize: theme.typography.cardInput.fontSize,
    fontWeight: "400" as const,
    color: "rgba(0,0,0,0.35)",
    fontFamily: theme.fonts.sans,
    flexShrink: 1,
    marginLeft: 4,
  },

  // ── Content (cards) ──
  contentOuter: {
    ...(Platform.OS === "web"
      ? { position: "fixed", top: 0, bottom: 0, left: 0, right: 0, zIndex: 25 }
      : { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }),
  } as any,
  content: {
    flex: 1,
    ...(Platform.OS === "web" ? { overscrollBehaviorX: "none" } : {}),
  } as any,
  scrollContent: {
    paddingTop: theme.layout.headerH + 48,
    maxWidth: theme.layout.gridMaxWidth,
    width: "100%",
    ...(Platform.OS === "web"
      ? { marginLeft: "auto", marginRight: "auto" }
      : {}),
  } as any,

  // ── Objective section ──
  objectiveSection: {
    paddingHorizontal: theme.layout.gridPadding,
    paddingTop: 24,
    paddingBottom: 72,
    gap: 16,
    ...(Platform.OS === "web"
      ? { maxWidth: "50%" }
      : {}),
    minWidth: 320,
  } as any,
  actionButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 4,
  },
  actionButtonIcon: {
    fontSize: 17,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.40)",
    fontFamily: theme.fonts.sans,
  },
  objectiveTitle: {
    fontSize: 38,
    fontWeight: "700" as const,
    color: "rgba(22,18,14,0.78)",
    fontFamily: theme.fonts.sans,
    letterSpacing: -0.5,
  },
  objectiveDescription: {
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 24,
    color: "rgba(22,18,14,0.65)",
    fontFamily: theme.fonts.sans,
  },

  // ── Card grid ──
  gridContent: {
    ...(Platform.OS === "web"
      ? {
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
          gap: theme.layout.gridGap,
          paddingHorizontal: theme.layout.gridPadding,
          paddingBottom: "50vh",
        }
      : {
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "flex-start",
          gap: theme.layout.gridGap,
          paddingHorizontal: theme.layout.gridPadding,
          paddingBottom: "50vh",
        }),
  } as any,

});
