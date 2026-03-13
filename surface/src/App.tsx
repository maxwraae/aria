import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Platform, Animated, ScrollView, Dimensions } from "react-native";
import { ChatCard } from "./components/ChatCard";
import { GlassButton, GlassPill } from "./components/Glass";
import { NeedsYouStrip } from "./components/NeedsYouStrip";
import { RecentWorkStrip } from "./components/RecentWorkStrip";
import { theme } from "./constants/theme";
import { FocusProvider, useFocus } from "./context/FocusContext";
import { useARIA } from "./hooks/useARIA";
import type { ObjectiveNode } from "./hooks/adapters";

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

  // Card breathing uses the same hue as the background, more saturated and concentrated
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const [h, s] = colors.top;
    const sat = Math.min(s + 30, 60);
    document.documentElement.style.setProperty("--card-breathe-off", `hsla(${h}, ${sat}%, 52%, 0.00)`);
    document.documentElement.style.setProperty("--card-breathe-on", `hsla(${h}, ${sat}%, 52%, 0.22)`);
  }, [period]);

  return { gradient, period, textColor, textColorMuted };
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

function CreateObjectiveOverlay({ parentId, onSubmit, onDismiss }: { parentId: string; onSubmit: (parentId: string, name: string) => void; onDismiss: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    // Auto-focus after animation
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(parentId, trimmed);
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

function FocusOverlay({ onSend, streamingText }: { onSend: (id: string, text: string) => Promise<void>; streamingText: Map<string, string> }) {
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
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const enterWorkView = useCallback((id: string) => {
    setCurrentId(id);
    slideAnim.setValue(-40);
    fadeAnim.setValue(0);
    setView("work");
    pushUrl(`/objectives/${id}`);
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, slideAnim, pushUrl]);

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
      .filter(o => o.id !== 'root' && o.status !== 'resolved' && o.status !== 'abandoned')
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

  const handleHeroSubmit = useCallback(() => {
    const trimmed = heroText.trim();
    if (!trimmed) return;
    setHeroText("");
    setSearchResults([]);
    aria.sendMessage('root', trimmed);
    enterWorkView('root');
  }, [heroText, aria.sendMessage, enterWorkView]);

  const path = (effectiveCurrent && currentId)
    ? (findPathById(aria.tree, currentId) || [effectiveCurrent])
    : (effectiveCurrent ? [effectiveCurrent] : []);
  const ancestors = path.slice(0, -1);
  const children = effectiveCurrent?.children || [];

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
            {/* Header — home pill left, clock right */}
            <View style={styles.header}>
              <View style={styles.headerInner}>
                <GlassPill height={36}>
                  <Text style={styles.homeIcon}>{"\u2302"}</Text>
                </GlassPill>
                <View style={styles.clockGroup}>
                  <Text style={styles.clockTime}>{clock.time}</Text>
                  <Text style={styles.clockDate}>{clock.date}</Text>
                </View>
              </View>
            </View>

            {/* Scrollable home content */}
            <ScrollView
              style={styles.homeScroll}
              contentContainerStyle={styles.homeScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {/* Hero — input at center */}
              <View style={styles.heroContainer}>
                <View style={styles.heroInner}>
                  <Text style={[styles.heroGreeting, { color: tod.textColor }]}>What are you working on?</Text>
                  <View style={styles.heroInputWrapper}>
                    <TextInput
                      style={styles.heroInput}
                      value={heroText}
                      onChangeText={setHeroText}
                      placeholder="Start something new..."
                      placeholderTextColor="rgba(0,0,0,0.22)"
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
                      <View style={styles.heroWaveform}>
                        {[5, 11, 8, 13, 6].map((h, i) => (
                          <View key={i} style={{ width: 2, height: h, borderRadius: 1.5, backgroundColor: "rgba(0,0,0,0.25)" }} />
                        ))}
                      </View>
                    )}
                  </View>
                  {/* Search results */}
                  {searchResults.length > 0 && (
                    <View style={styles.searchResults}>
                      {searchResults.map((result) => (
                        <Pressable
                          key={result.id}
                          onPress={() => {
                            setHeroText("");
                            setSearchResults([]);
                            enterWorkView(result.id);
                          }}
                          style={({ pressed }) => [styles.searchRow, pressed && { opacity: 0.6 }]}
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

              {/* Needs You strip */}
              <NeedsYouStrip items={aria.needsYou} onNavigate={(id) => enterWorkView(id)} onExpand={enterNeedsYou} headerColor={tod.textColor} onSend={aria.sendMessage} streamingText={aria.streamingText} />

              {/* Recent Work strip */}
              <RecentWorkStrip items={aria.recentWork} onNavigate={(id) => enterWorkView(id)} headerColor={tod.textColor} />
            </ScrollView>
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
                <View style={styles.clockGroup}>
                  <Text style={styles.clockTime}>{clock.time}</Text>
                  <Text style={styles.clockDate}>{clock.date}</Text>
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
                  {aria.needsYou.map((item, i) => (
                    <ChatCard
                      key={item.session.id}
                      session={item.session}
                      focused={i === 0}
                      onResolve={() => {}}
                      urgent={item.urgent}
                      important={item.important}
                      onSend={(text) => aria.sendMessage(item.session.id, text)}
                      streamingText={aria.streamingText.get(item.session.id)}
                    />
                  ))}
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
                <View style={styles.clockGroup}>
                  <Text style={styles.clockTime}>{clock.time}</Text>
                  <Text style={styles.clockDate}>{clock.date}</Text>
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
                  <Text style={styles.objectiveTitle}>{effectiveCurrent?.name ?? ""}</Text>
                  <Text style={[styles.objectiveDescription, { maxWidth: 640 }]}>{effectiveCurrent?.description || "No description"}</Text>
                  <View style={styles.actionButtons}>
                    <GlassButton size={38} onPress={() => {
                      if (currentId) console.log("resolve", currentId);
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
                      <Text style={styles.plusIcon}>+</Text>
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
                      onDescend={child.children && child.children.length > 0 ? () => goDown(child) : undefined}
                      childCount={child.children?.length ?? 0}
                      resolvedCount={child.children?.filter(c => c.status === "resolved").length ?? 0}
                      urgent={child.urgent}
                      important={child.important}
                      onAddChild={() => setCreateParentId(child.id)}
                      onSend={(text) => aria.sendMessage(child.id, text)}
                      streamingText={aria.streamingText.get(child.id)}
                    />
                  ))}
                </View>
              </ScrollView>
            </Animated.View>

          </View>
        )}
        <FocusOverlay onSend={aria.sendMessage} streamingText={aria.streamingText} />
        {createParentId && (
          <CreateObjectiveOverlay
            parentId={createParentId}
            onSubmit={async (parentId, name) => {
              const newId = await aria.createObjective(parentId, name);
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
    paddingBottom: 64,
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
    paddingLeft: 18,
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
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  heroSendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
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

  // ── Search results ──
  searchResults: {
    width: "100%",
    backgroundColor: "rgba(255,255,255,0.72)",
    ...(Platform.OS === "web" ? {
      backdropFilter: "blur(20px) saturate(180%)",
      WebkitBackdropFilter: "blur(20px) saturate(180%)",
    } : {}),
    borderRadius: 14,
    marginTop: 8,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
  } as any,
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 12,
    gap: 10,
    ...(Platform.OS === "web" ? { cursor: "pointer" } : {}),
  } as any,
  searchDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  searchName: {
    fontSize: 14,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.75)",
    fontFamily: theme.fonts.sans,
    flexShrink: 1,
  },
  searchDesc: {
    fontSize: 13,
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
          paddingBottom: theme.layout.gridPadding,
        }
      : {
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "flex-start",
          gap: theme.layout.gridGap,
          paddingHorizontal: theme.layout.gridPadding,
          paddingBottom: theme.layout.gridPadding,
        }),
  } as any,

});
