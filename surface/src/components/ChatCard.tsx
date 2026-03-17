import { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
} from "react-native";
import { theme } from "../constants/theme";
import { PlusIcon } from "./Icons";
import { MessageList } from "./MessageList";
import { GlassButton } from "./Glass";
import type { ChatMessage, ChatSession } from "../types/chat";
import { useFocus } from "../context/FocusContext";

/** Compact waveform icon for card input */
function WaveformSmall({ active = false }: { active?: boolean }) {
  const c = active ? "rgba(255,59,48,0.8)" : "rgba(0,0,0,0.25)";
  return (
    <View style={waveStyles.container}>
      <View style={[waveStyles.bar, { height: 5, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 11, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 8, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 13, backgroundColor: c }]} />
      <View style={[waveStyles.bar, { height: 6, backgroundColor: c }]} />
    </View>
  );
}

const waveStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1.5,
    height: 16,
  },
  bar: {
    width: 2,
    borderRadius: 1.5,
  },
});

interface ChatCardProps {
  session: ChatSession;
  focused?: boolean;
  style?: any;
  onDescend?: () => void;
  onResolve?: () => void;
  onAddChild?: () => void;
  onRename?: (newName: string) => void;
  childCount?: number;
  resolvedCount?: number;
  /** Disable internal scroll so parent scroll works (e.g. in strips) */
  scrollEnabled?: boolean;
  /** Objective is marked urgent */
  urgent?: boolean;
  /** Objective is marked important */
  important?: boolean;
  /** Called when the user sends a message; parent forwards to API */
  onSend?: (text: string) => Promise<void> | void;
  /** Streaming text currently being generated for this session's objective */
  streamingText?: string;
  /** Current machine assignment for this objective */
  machine?: string | null;
  /** Called when user toggles machine assignment */
  onSetMachine?: (machine: string | null) => void;
  /** Called when user clicks the model badge to cycle model */
  onSetModel?: (model: string) => void;
  /** Called when user clicks speak on an agent message */
  onSpeak?: (text: string) => void;
  /** ID of the message currently being spoken */
  speakingMessageId?: string | null;
  /** Dynamic time-of-day color for the objective title */
  titleColor?: string;
}

export function ChatCard({ session, focused = false, style, onDescend, onResolve, onAddChild, onRename, childCount = 0, resolvedCount = 0, scrollEnabled = true, urgent, important, onSend, streamingText, machine, onSetMachine, onSetModel, onSpeak, speakingMessageId, titleColor }: ChatCardProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages);

  // Sync messages when the parent refreshes session.messages (e.g. after API reply loads)
  useEffect(() => {
    setMessages(session.messages);
  }, [session.messages]);
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(20);
  const cardRef = useRef<View>(null);
  const [editing, setEditing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const handleVoiceInput = useCallback(() => {
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (!SR) return;
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i]?.[0]?.transcript;
        if (t && event.results[i].isFinal) {
          setText((prev: string) => prev ? prev + ' ' + t : t);
        }
      }
    };
    recognition.onend = () => { setIsListening(false); recognitionRef.current = null; };
    recognition.onerror = () => { setIsListening(false); recognitionRef.current = null; };
    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening]);
  const [editText, setEditText] = useState(session.name);
  const [headerHovered, setHeaderHovered] = useState(false);

  const { focusedId, focusCard, dismissFocus } = useFocus();
  const isFocused = focusedId === session.id;
  const anyFocused = focusedId !== null;

  useEffect(() => { setEditText(session.name); }, [session.name]);

  // Route horizontal wheel events to the nearest horizontal scroll parent.
  // Necessary because nested scroll containers eat wheel events on web.
  useEffect(() => {
    if (Platform.OS !== "web" || !cardRef.current) return;
    const el = cardRef.current as unknown as HTMLElement;
    const handler = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      // Only intercept when scroll is meaningfully horizontal
      if (dx <= 3 || dy >= dx) return;
      // Walk up DOM to find first element that can actually scroll horizontally
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollWidth > parent.clientWidth + 1) {
          e.preventDefault();
          parent.scrollLeft += e.deltaX;
          return;
        }
        parent = parent.parentElement;
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [
      ...prev,
      { id: String(Date.now()), kind: "user", text: trimmed, timestamp: Date.now() },
    ]);
    setText("");
    setInputHeight(20);
    console.log('[ChatCard] handleSend:', session.id, trimmed, 'onSend:', !!onSend);
    onSend?.(trimmed);
  }, [text, onSend, session.id]);

  const handleKeyPress = (e: any) => {
    if (
      Platform.OS === "web" &&
      e.nativeEvent.key === "Enter" &&
      !e.nativeEvent.shiftKey
    ) {
      e.preventDefault();
      handleSend();
    }
  };

  const onContentSizeChange = useCallback((e: any) => {
    const h = e.nativeEvent.contentSize.height;
    setInputHeight(Math.min(Math.max(h, 20), 6 * 20));
  }, []);

  const hasText = text.trim().length > 0;

  // Resolve header tint from status + priority (all tokens from theme)
  const status = session.status;
  const needsInput = status === "needs-input";
  const isThinking = status === "thinking";
  const isStreaming = Boolean(streamingText);

  const priorityKey = (urgent && important) ? "both" : urgent ? "urgent" : important ? "important" : null;

  let headerTint: string | undefined;
  if (status === "failed" || status === "resolved") {
    headerTint = theme.status[status].tint;
  } else if (needsInput && priorityKey) {
    headerTint = theme.priority[priorityKey].needsInput;
  } else if (needsInput) {
    headerTint = theme.status["needs-input"].tint;
  } else if (isThinking) {
    headerTint = theme.status.thinking.tint;
  } else if (priorityKey) {
    headerTint = theme.priority[priorityKey].idle;
  } else {
    headerTint = theme.status.idle.tint;
  }

  // Breathing animation for thinking status only
  const headerBreathStyle = Platform.OS === "web" && isThinking
    ? (isStreaming
        ? { animation: "cardSettle 2s ease-out forwards" }
        : { animation: "cardBreathe 3.5s ease-in-out infinite" })
    : {};

  const handleHeaderPress = () => {
    if (editing) return;
    if (onDescend) onDescend();
  };

  return (
    <View ref={cardRef} style={[
      styles.container,
      focused ? styles.containerFocused : styles.containerUnfocused,
      session.status === "resolved" && { opacity: 0.45 },
      !scrollEnabled && Platform.OS === "web" && { overscrollBehavior: "auto" } as any,
      Platform.OS === "web" && anyFocused && !isFocused ? {
        filter: "blur(2px)",
        opacity: 0.45,
        transition: "filter 280ms ease, opacity 280ms ease",
        pointerEvents: "none",
      } as any : undefined,
      style,
    ]}>
      {/* Header — entire bar is clickable */}
      <Pressable
        onPress={handleHeaderPress}
        style={[styles.header, { backgroundColor: headerTint || "rgba(0,0,0,0.03)" }, Platform.OS === "web" ? { cursor: onDescend ? "pointer" : "default", ...headerBreathStyle } as any : undefined]}
        {...(Platform.OS === "web" ? {
          onMouseEnter: () => setHeaderHovered(true),
          onMouseLeave: () => setHeaderHovered(false),
        } : {})}
      >
        {editing ? (
          <TextInput
            autoFocus
            value={editText}
            onChangeText={setEditText}
            onSubmitEditing={() => { onRename?.(editText); setEditing(false); }}
            onKeyPress={(e) => { if (e.nativeEvent.key === "Escape") { setEditText(session.name); setEditing(false); } }}
            onBlur={() => { onRename?.(editText); setEditing(false); }}
            style={styles.titleInput}
          />
        ) : (
          <>
            {childCount > 0 && (
              <Text style={styles.childCount}>
                {resolvedCount > 0 ? `${resolvedCount}/${childCount}` : `${childCount}`}
              </Text>
            )}
            <Text style={[styles.title, titleColor ? { color: titleColor } : undefined]} numberOfLines={1}>
              {session.name}
            </Text>
          </>
        )}
        {session.status === "thinking" && (
          <Text style={Platform.OS === "web" ? {
            fontSize: 12,
            color: "rgba(0,0,0,0.35)",
            marginLeft: 8,
            fontFamily: theme.fonts.sans,
            animation: "pulse 1.5s ease-in-out infinite",
          } as any : { fontSize: 12, color: "rgba(0,0,0,0.35)", marginLeft: 8 }}>
            thinking...
          </Text>
        )}
        <View style={{ flex: 1 }} />
        {session.model && onSetModel ? (
          <Pressable
            onPress={() => {
              onSetModel(session.model === 'haiku' ? 'sonnet' : 'haiku');
            }}
            style={[Platform.OS === 'web' ? { cursor: 'pointer' } as any : undefined]}
          >
            <Text style={styles.modelBadge}>
              {session.model === 'haiku' ? 'H' : 'O'}
            </Text>
          </Pressable>
        ) : session.model ? (
          <Text style={styles.modelBadge}>
            {session.model === 'haiku' ? 'H' : 'O'}
          </Text>
        ) : null}
        {onSetMachine && (
          <Pressable
            onPress={() => onSetMachine(machine === 'macbook' ? null : 'macbook')}
            style={[styles.machineToggle, Platform.OS === 'web' ? { cursor: 'pointer' } as any : undefined]}
          >
            <Text style={[styles.machineBadge, machine === 'macbook' && styles.machineBadgeActive]}>
              {machine === 'macbook' ? 'MB' : 'Auto'}
            </Text>
          </Pressable>
        )}
        <GlassButton
          size={32}
          onPress={isFocused ? dismissFocus : () => focusCard(session.id, session)}
        >
          <Text style={styles.focusIcon}>{isFocused ? "\u2715" : "\u2197"}</Text>
        </GlassButton>
        <GlassButton size={32} onPress={onResolve}>
          <Text style={styles.checkIcon}>{"\u2713"}</Text>
        </GlassButton>
        {onAddChild && (
          <GlassButton size={32} onPress={onAddChild}>
            <PlusIcon size={14} color="rgba(0,0,0,0.45)" />
          </GlassButton>
        )}
      </Pressable>

      <MessageList
        messages={
          streamingText
            ? [...messages, { id: "__streaming__", kind: "agent" as const, text: streamingText, timestamp: Date.now() }]
            : messages
        }
        scrollEnabled={scrollEnabled}
        onSpeak={onSpeak}
        speakingMessageId={speakingMessageId}
      />

      {/* Card input bar */}
      {session.status !== "resolved" && <View style={styles.inputArea}>
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, { height: inputHeight }]}
            value={text}
            onChangeText={setText}
            placeholder="Message..."
            placeholderTextColor="rgba(0,0,0,0.22)"
            multiline
            onContentSizeChange={onContentSizeChange}
            onKeyPress={handleKeyPress}
            // @ts-ignore web-only
            enterKeyHint="send"
          />
          {hasText ? (
            <Pressable onPress={handleSend} style={({ pressed }) => [styles.inputBtn, styles.sendBtn, pressed && styles.btnPressed]}>
              <Text style={styles.sendArrow}>{"\u2191"}</Text>
            </Pressable>
          ) : (
            <Pressable onPress={handleVoiceInput} style={({ pressed }) => [styles.inputBtn, pressed && styles.btnPressed]}>
              <WaveformSmall active={isListening} />
            </Pressable>
          )}
        </View>
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: 20,
    overflow: "hidden",
    ...(Platform.OS === "web"
      ? {
          height: "calc(100vh - 240px)",
          display: "flex",
          flexDirection: "column",
          overscrollBehavior: "contain",
        }
      : {
          flex: 1,
        }),
  } as any,
  containerFocused: {} as any,
  containerUnfocused: {} as any,
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 8,
  } as any,
  childCount: {
    fontSize: 13,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.35)",
    fontFamily: theme.fonts.sans,
    minWidth: 18,
    textAlign: "center" as const,
  },
  title: {
    fontSize: 16,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.78)",
    fontFamily: theme.fonts.sans,
    flexShrink: 1,
  },
  depthIndicator: {
    ...theme.typography.cardDepthIndicator,
    marginLeft: 4,
  },
  checkIcon: {
    ...theme.typography.cardCheckIcon,
  },
  focusBtnWrap: {
    marginRight: 6,
  } as any,
  modelBadge: {
    fontSize: 11,
    fontWeight: "600" as const,
    color: "rgba(0,0,0,0.25)",
    fontFamily: theme.fonts.sans,
    marginRight: 4,
  },
  machineToggle: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  machineBadge: {
    fontSize: 10,
    fontWeight: "600" as const,
    color: "rgba(0,0,0,0.25)",
    fontFamily: theme.fonts.sans,
  },
  machineBadgeActive: {
    color: "rgba(0,0,0,0.55)",
  },
  focusIcon: {
    fontSize: 14,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.40)",
    fontFamily: theme.fonts.sans,
  } as any,
  titleInput: {
    fontSize: 16,
    fontWeight: "500" as const,
    color: "rgba(0,0,0,0.78)",
    fontFamily: theme.fonts.sans,
    flexShrink: 1,
    minWidth: 80,
    ...(Platform.OS === "web" ? { outlineStyle: "none", lineHeight: "normal", padding: 0, margin: 0 } : {}),
  } as any,
  // Card input bar — floating overlay at bottom
  inputArea: {
    ...(Platform.OS === "web"
      ? { position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10 }
      : { position: "absolute", bottom: 0, left: 0, right: 0 }),
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
  } as any,
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#F5F3F0",
    borderRadius: 12,
    paddingLeft: 16,
    paddingRight: 5,
    paddingVertical: 5,
    minHeight: 48,
  },
  input: {
    ...theme.typography.cardInput,
    flex: 1,
    paddingVertical: 6,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  inputBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtn: {
    backgroundColor: "rgba(0,0,0,0.10)",
  },
  sendArrow: {
    ...theme.typography.cardSendArrow,
  },
  btnPressed: {
    opacity: 0.5,
  },
});
