import { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
} from "react-native";
import Markdown from "react-native-markdown-display";
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
  /** Dynamic time-of-day card background */
  cardBg?: string;
  /** Called when user picks a file to upload */
  onUpload?: (file: File) => Promise<string | null | void>;
}

export function ChatCard({ session, focused = false, style, onDescend, onResolve, onAddChild, onRename, childCount = 0, resolvedCount = 0, scrollEnabled = true, urgent, important, onSend, streamingText, machine, onSetMachine, onSetModel, onSpeak, speakingMessageId, titleColor, cardBg, onUpload }: ChatCardProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(session.messages);

  // Sync messages when the parent refreshes session.messages (e.g. after API reply loads)
  useEffect(() => {
    setMessages(session.messages);
  }, [session.messages]);
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(20);
  const cardRef = useRef<View>(null);
  const inputRef = useRef<TextInput>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<Array<{ name: string; filename: string }>>([]);
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
  const [mode, setMode] = useState<'chat' | 'doc'>('chat');
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

  // Native drag-and-drop — RNW's View strips drag events, so attach directly to DOM
  const dragCountRef = useRef(0);
  const onUploadRef = useRef(onUpload);
  onUploadRef.current = onUpload;
  const setStagedFilesRef = useRef(setStagedFiles);
  setStagedFilesRef.current = setStagedFiles;

  useEffect(() => {
    if (Platform.OS !== "web" || !cardRef.current) return;
    const el = cardRef.current as unknown as HTMLElement;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current++;
      if (dragCountRef.current === 1) setIsDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current--;
      if (dragCountRef.current <= 0) { dragCountRef.current = 0; setIsDragOver(false); }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current = 0;
      setIsDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && onUploadRef.current) {
        onUploadRef.current(file).then(filename => {
          if (filename) setStagedFilesRef.current(prev => [...prev, { name: file.name, filename }]);
        });
      }
    };

    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && stagedFiles.length === 0) return;
    for (const f of stagedFiles) {
      onSend?.(`[attachment:${f.filename}]`);
    }
    if (trimmed) {
      setMessages((prev) => [
        ...prev,
        { id: String(Date.now()), kind: "user", text: trimmed, timestamp: Date.now() },
      ]);
      onSend?.(trimmed);
    }
    setText("");
    setStagedFiles([]);
    setInputHeight(20);
  }, [text, stagedFiles, onSend, session.id]);

  // Reset input height when text is fully cleared
  useEffect(() => {
    if (!text) setInputHeight(20);
  }, [text]);

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

  const hasContent = text.trim().length > 0 || stagedFiles.length > 0;

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

  const handleHeaderPress = () => {
    if (editing) return;
    if (onDescend) onDescend();
  };

  return (
    <View ref={cardRef} style={[
      styles.container,
      cardBg ? { backgroundColor: cardBg } : undefined,
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
    ]}
    {...(Platform.OS === "web" ? {
      onMouseEnter: () => {
        const node = (inputRef.current as any)?._node ?? inputRef.current;
        if (node instanceof HTMLElement) node.focus({ preventScroll: true });
      },
      onMouseLeave: () => { inputRef.current?.blur(); },
    } : {})}
    >
      {/* Drag-over overlay */}
      {Platform.OS === "web" && isDragOver && (
        <View style={{
          ...StyleSheet.absoluteFillObject,
          zIndex: 50,
          borderRadius: 20,
          backgroundColor: 'rgba(0,0,0,0.04)',
          borderWidth: 2,
          borderColor: 'rgba(0,0,0,0.12)',
          borderStyle: 'dashed',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        } as any}>
          <Text style={{ fontSize: 13, color: 'rgba(0,0,0,0.30)', fontFamily: theme.fonts.sans }}>Drop file</Text>
        </View>
      )}

      {/* Breathing overlay — whole card pulses when thinking */}
      {Platform.OS === "web" && isThinking && (
        <View style={{
          ...StyleSheet.absoluteFillObject,
          zIndex: 0,
          borderRadius: 20,
          pointerEvents: "none",
          animation: isStreaming
            ? "cardSettle 2s ease-out forwards"
            : "cardBreathe 3.5s ease-in-out infinite",
        } as any} />
      )}

      {/* Header — floating gradient overlay */}
      <Pressable
        onPress={handleHeaderPress}
        style={[
          styles.header,
          Platform.OS === "web" ? {
            cursor: onDescend ? "pointer" : "default",
            background: 'linear-gradient(to bottom, rgba(255,255,255,1) 0%, rgba(255,255,255,0.98) 50%, rgba(255,255,255,0) 100%)',
            transition: 'background 0.3s ease',
          } as any : undefined,
        ]}
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
        {/* Doc/Chat toggle */}
        <Pressable
          onPress={() => setMode(m => m === 'chat' ? 'doc' : 'chat')}
          style={({ pressed }) => [styles.modeToggle, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.modeToggleText}>{mode === 'chat' ? 'Doc' : 'Chat'}</Text>
        </Pressable>
        {/* Controls — fade in on hover */}
        <View style={Platform.OS === "web" ? {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          opacity: headerHovered ? 1 : 0,
          transition: 'opacity 0.2s ease',
        } as any : { flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {session.model && onSetModel ? (
            <GlassButton size={32} onPress={() => {
              const next: Record<string, string> = { opus: 'sonnet', sonnet: 'haiku', haiku: 'opus' };
              onSetModel(next[session.model ?? 'sonnet'] ?? 'sonnet');
            }}>
              <Text style={styles.badgeText}>{({ opus: 'O', sonnet: 'S', haiku: 'H' } as Record<string, string>)[session.model ?? 'sonnet'] ?? 'S'}</Text>
            </GlassButton>
          ) : session.model ? (
            <GlassButton size={32}>
              <Text style={styles.badgeText}>{({ opus: 'O', sonnet: 'S', haiku: 'H' } as Record<string, string>)[session.model ?? 'sonnet'] ?? 'S'}</Text>
            </GlassButton>
          ) : null}
          {onSetMachine && (
            <GlassButton size={32} onPress={() => onSetMachine(machine === 'macbook' ? null : 'macbook')}>
              <Text style={[styles.badgeText, machine === 'macbook' && { color: 'rgba(0,0,0,0.55)' }]}>
                {machine === 'macbook' ? 'MB' : 'Auto'}
              </Text>
            </GlassButton>
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
        </View>
      </Pressable>

      {mode === 'doc' ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.docContent}>
          <Markdown style={docMarkdownStyles}>{session.work ?? ''}</Markdown>
        </ScrollView>
      ) : (
        <MessageList
          messages={
            streamingText
              ? [...messages, { id: "__streaming__", kind: "agent" as const, text: streamingText, timestamp: Date.now() }]
              : messages
          }
          scrollEnabled={scrollEnabled}
          onSpeak={onSpeak}
          speakingMessageId={speakingMessageId}
          topPad={56}
          bottomPad={16}
        />
      )}

      {/* Card input bar */}
      {session.status !== "resolved" && <View style={styles.inputArea}>
        {stagedFiles.length > 0 && (
          <View style={styles.stagedRow}>
            {stagedFiles.map((f, i) => (
              <View key={i} style={styles.stagedPill}>
                <Text style={styles.stagedName} numberOfLines={1}>{f.name}</Text>
                <Pressable onPress={() => setStagedFiles(prev => prev.filter((_, j) => j !== i))} hitSlop={4}>
                  <Text style={styles.stagedRemove}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={styles.inputRow}>
          {Platform.OS === 'web' && onUpload && (
            <input
              ref={fileInputRef as any}
              type="file"
              style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }}
              onChange={(e: any) => {
                const file = e.target?.files?.[0];
                if (file && onUpload) {
                  onUpload(file).then(filename => {
                    if (filename) setStagedFiles(prev => [...prev, { name: file.name, filename }]);
                  });
                }
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
          )}
          <TextInput
            ref={inputRef}
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
          {hasContent ? (
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
          height: "clamp(280px, calc(100vh - 280px), 680px)",
          display: "flex",
          flexDirection: "column",
          overscrollBehavior: "contain",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.03)",
          transition: "background-color 0.5s ease, box-shadow 0.3s ease",
        }
      : {
          flex: 1,
        }),
  } as any,
  containerFocused: {} as any,
  containerUnfocused: {} as any,
  header: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 8,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
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
  badgeText: {
    fontSize: 10,
    fontWeight: "600" as const,
    color: "rgba(0,0,0,0.35)",
    fontFamily: theme.fonts.sans,
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
      ? { zIndex: 10 }
      : {}),
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
    ...(Platform.OS === "web" ? { outlineStyle: "none", overflow: "hidden", resize: "none" } : {}),
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
  stagedRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  stagedPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.06)",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 6,
    maxWidth: 200,
  },
  stagedName: {
    fontSize: 11,
    color: "rgba(0,0,0,0.5)",
    fontFamily: theme.fonts.sans,
    flexShrink: 1,
  },
  stagedRemove: {
    fontSize: 14,
    color: "rgba(0,0,0,0.3)",
    fontFamily: theme.fonts.sans,
  },
  modeToggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.05)",
  },
  modeToggleText: {
    fontSize: 11,
    fontWeight: "600" as const,
    color: "rgba(0,0,0,0.40)",
    fontFamily: theme.fonts.sans,
  },
  docContent: {
    padding: 20,
    paddingTop: 64,
    paddingBottom: 24,
  },
});

const docMarkdownStyles = StyleSheet.create({
  body: {
    ...theme.typography.markdownBody,
  },
  strong: {
    fontWeight: "700",
    color: "rgba(0,0,0,0.90)",
  },
  em: {
    fontStyle: "italic",
  },
  code_inline: {
    ...theme.typography.markdownCodeInline,
    fontFamily: theme.fonts.sans,
    backgroundColor: "transparent",
    borderWidth: 0,
    paddingHorizontal: 0,
    borderRadius: 0,
  },
  code_block: {
    ...theme.typography.markdownCodeBlock,
    backgroundColor: theme.colors.codeBg,
    borderRadius: theme.radii.codeBlock,
    padding: 16,
    marginVertical: 10,
    fontFamily: theme.fonts.mono,
  },
  fence: {
    ...theme.typography.markdownCodeBlock,
    backgroundColor: theme.colors.codeBg,
    borderRadius: theme.radii.codeBlock,
    padding: 16,
    marginVertical: 10,
    fontFamily: theme.fonts.mono,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.03)",
  },
  paragraph: {
    ...theme.typography.markdownParagraph,
    marginBottom: 16,
    marginTop: 0,
  },
  bullet_list: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    marginBottom: 16,
    paddingLeft: 4,
  },
  ordered_list: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    marginBottom: 16,
    paddingLeft: 4,
  },
  list_item: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    marginBottom: 6,
    flexDirection: "row",
  },
  blockquote: {
    fontSize: theme.typography.markdownParagraph.fontSize,
    borderLeftWidth: 3,
    borderLeftColor: "rgba(0,0,0,0.08)",
    paddingLeft: 16,
    marginBottom: 16,
    backgroundColor: "transparent",
  },
  heading1: {
    ...theme.typography.markdownHeading1,
    marginBottom: 8,
    marginTop: 16,
  },
  heading2: {
    ...theme.typography.markdownHeading2,
    marginBottom: 6,
    marginTop: 14,
  },
  heading3: {
    ...theme.typography.markdownHeading3,
    marginBottom: 4,
    marginTop: 12,
  },
  link: {
    color: theme.colors.blue,
    textDecorationLine: "none",
    fontSize: theme.typography.markdownBody.fontSize,
  },
  hr: {
    backgroundColor: "rgba(0,0,0,0.06)",
    height: StyleSheet.hairlineWidth,
    marginVertical: 20,
  },
});
