import { useState, useEffect, useCallback, useRef } from 'react';
import type { Objective, InboxMessage } from './types';
import type { ChatSession } from '../types/chat';
import type { NeedsYouItem } from '../components/NeedsYouStrip';
import type { ObjectiveCardData } from '../components/ObjectiveCard';
import { buildTree, toNeedsYouItems, toQuickItems, toRecentWork, toSession, type ObjectiveNode } from './adapters';

function getWsUrl(): string {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:8080/ws';
}

export type TTSMessage = {
  type: 'tts_audio';
  requestId: string;
  audio: string;
  sampleRate: number;
  isLastChunk: boolean;
} | {
  type: 'tts_error';
  requestId: string;
  error: string;
};

export interface UseARIAReturn {
  tree: ObjectiveNode | null;
  objectives: Objective[];
  needsYou: NeedsYouItem[];
  quickItems: NeedsYouItem[];
  recentWork: ObjectiveCardData[];
  getSession: (id: string) => ChatSession;
  loadConversation: (id: string) => Promise<void>;
  sendMessage: (objectiveId: string, text: string) => Promise<void>;
  createObjective: (parent: string, objective: string, instructions?: string) => Promise<string | null>;
  updateObjective: (id: string, fields: { objective?: string; description?: string; model?: string }) => Promise<void>;
  setMachine: (id: string, machine: string | null) => Promise<void>;
  watchObjective: (objectiveId: string) => void;
  sendTTSRequest: (text: string) => string;
  cancelTTS: (requestId: string) => void;
  onTTSMessage: (cb: (msg: TTSMessage) => void) => void;
  succeedObjective: (id: string, summary: string) => Promise<void>;
  failObjective: (id: string, reason: string) => Promise<void>;
  rejectObjective: (id: string, feedback: string) => Promise<void>;
  uploadFile: (file: File) => Promise<string | null>;
  streamingText: Map<string, string>;
  connected: boolean;
}

export function useARIA(): UseARIAReturn {
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [tree, setTree] = useState<ObjectiveNode | null>(null);
  const [needsYou, setNeedsYou] = useState<NeedsYouItem[]>([]);
  const [quickItems, setQuickItems] = useState<NeedsYouItem[]>([]);
  const [recentWork, setRecentWork] = useState<ObjectiveCardData[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamingText, setStreamingText] = useState<Map<string, string>>(new Map());

  const sessionsRef = useRef<Map<string, ChatSession>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectivesRef = useRef<Objective[]>([]);
  const ttsCallbackRef = useRef<((msg: TTSMessage) => void) | null>(null);
  const loadConversationRef = useRef<(id: string) => Promise<void>>();
  const watchedRef = useRef<Set<string>>(new Set());

  // Keep objectivesRef in sync
  useEffect(() => {
    objectivesRef.current = objectives;
  }, [objectives]);

  const processTree = useCallback((objs: Objective[]) => {
    setObjectives(objs);
    const builtTree = buildTree(objs);
    setTree(builtTree);
    setNeedsYou(toNeedsYouItems(objs, sessionsRef.current));
    setQuickItems(toQuickItems(objs, sessionsRef.current));
    setRecentWork(toRecentWork(objs));
  }, []);

  useEffect(() => {
    let alive = true;

    function connect() {
      if (!alive) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'tree_snapshot') {
            processTree(msg.tree);
            // Auto-subscribe to all thinking objectives for streaming
            for (const obj of msg.tree) {
              if (obj.status === 'thinking' && !watchedRef.current.has(obj.id)) {
                watchedRef.current.add(obj.id);
                ws.send(JSON.stringify({ type: 'watch_objective', objectiveId: obj.id }));
              }
            }
          } else if (msg.type === 'turn_stream') {
            if (msg.done) {
              // Clean up subscription tracking
              watchedRef.current.delete(msg.objectiveId);
              // Reload conversation first, then clear streaming text
              loadConversationRef.current?.(msg.objectiveId).then(() => {
                setStreamingText(prev => {
                  const next = new Map(prev);
                  next.delete(msg.objectiveId);
                  return next;
                });
              });
            } else {
              setStreamingText(prev => {
                const next = new Map(prev);
                next.set(msg.objectiveId, msg.text);
                return next;
              });
            }
          } else if (msg.type === 'tts_audio' || msg.type === 'tts_error') {
            console.log('[TTS] ws received:', msg.type, 'callback:', !!ttsCallbackRef.current);
            ttsCallbackRef.current?.(msg);
          }
        } catch {
          // Invalid message, ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        watchedRef.current.clear(); // Re-subscribe on reconnect
        if (alive) {
          reconnectRef.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      alive = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [processTree]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const [convRes, objRes] = await Promise.all([
        fetch(`/api/objectives/${id}/conversation?limit=500`),
        fetch(`/api/objectives/${id}`),
      ]);
      if (!convRes.ok) return;
      const messages: InboxMessage[] = await convRes.json();
      const objData = objRes.ok ? await objRes.json() : null;

      const obj = objectivesRef.current.find(o => o.id === id);
      if (obj) {
        const session = toSession(obj, messages, objectivesRef.current);
        sessionsRef.current.set(id, { ...session, work: objData?.work ?? null });
        setNeedsYou(toNeedsYouItems(objectivesRef.current, sessionsRef.current));
        setQuickItems(toQuickItems(objectivesRef.current, sessionsRef.current));
      }
    } catch {
      // Network error, will retry on next navigation
    }
  }, []);

  // Keep ref in sync so WS handler can call loadConversation
  useEffect(() => { loadConversationRef.current = loadConversation; }, [loadConversation]);

  const getSession = useCallback((id: string): ChatSession => {
    const obj = objectivesRef.current.find(o => o.id === id);
    const status = obj ? (obj.status === 'abandoned' ? 'failed' : obj.status as any) : 'idle';
    const model = obj?.model;
    const cached = sessionsRef.current.get(id);
    if (cached) {
      // Always use latest status from objective, not stale cached status
      return { ...cached, status, model, name: obj?.objective ?? cached.name };
    }
    return { id, name: obj?.objective ?? '', status, model, messages: [] };
  }, []);

  const watchObjective = useCallback((objectiveId: string) => {
    if (watchedRef.current.has(objectiveId)) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      watchedRef.current.add(objectiveId);
      ws.send(JSON.stringify({ type: 'watch_objective', objectiveId }));
    }
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      const res = await fetch('/api/objectives');
      if (!res.ok) return;
      const objs: Objective[] = await res.json();
      processTree(objs);
    } catch {
      // Will retry on next poll
    }
  }, [processTree]);

  const sendMessage = useCallback(async (objectiveId: string, text: string) => {
    console.log('[useARIA] sendMessage called:', objectiveId, text);
    // Subscribe to streaming for this objective before sending
    watchObjective(objectiveId);
    // Optimistically mark as thinking so UI updates instantly
    const cached = sessionsRef.current.get(objectiveId);
    if (cached) {
      sessionsRef.current.set(objectiveId, { ...cached, status: 'thinking' });
    }
    // Also update the objectives ref so getSession picks it up
    objectivesRef.current = objectivesRef.current.map(o =>
      o.id === objectiveId ? { ...o, status: 'thinking' } : o
    );
    setObjectives([...objectivesRef.current]);
    try {
      const res = await fetch(`/api/objectives/${objectiveId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      console.log('[useARIA] sendMessage response:', res.status, res.statusText);
      await Promise.all([loadConversation(objectiveId), refreshTree()]);
    } catch (err) {
      console.error('[useARIA] sendMessage error:', err);
    }
  }, [loadConversation, refreshTree]);

  const createObj = useCallback(async (parent: string, objective: string, instructions?: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/objectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective, parent, instructions }),
      });
      const newObj = await res.json();
      await refreshTree();
      return newObj.id ?? null;
    } catch (err) {
      console.error('[useARIA] createObjective error:', err);
      return null;
    }
  }, [refreshTree]);

  const updateObj = useCallback(async (id: string, fields: { objective?: string; description?: string; model?: string }) => {
    try {
      await fetch(`/api/objectives/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      await refreshTree();
    } catch (err) {
      console.error('[useARIA] updateObjective error:', err);
    }
  }, [refreshTree]);

  const sendTTSRequest = useCallback((text: string): string => {
    const requestId = crypto.randomUUID();
    const ws = wsRef.current;
    console.log('[TTS] sendTTSRequest, ws:', !!ws, 'readyState:', ws?.readyState);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tts_request', requestId, text }));
      console.log('[TTS] sent tts_request:', requestId);
    }
    return requestId;
  }, []);

  const cancelTTS = useCallback((requestId: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tts_cancel', requestId }));
    }
  }, []);

  const onTTSMessage = useCallback((cb: (msg: TTSMessage) => void) => {
    ttsCallbackRef.current = cb;
  }, []);

  const setMachine = useCallback(async (id: string, machine: string | null) => {
    try {
      await fetch(`/api/objectives/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine }),
      });
      await refreshTree();
    } catch (err) {
      console.error('[useARIA] setMachine error:', err);
    }
  }, [refreshTree]);

  const succeedObjective = useCallback(async (id: string, summary: string) => {
    try {
      await fetch(`/api/objectives/${id}/succeed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary }),
      });
      await refreshTree();
    } catch (err) {
      console.error('[useARIA] succeedObjective error:', err);
    }
  }, [refreshTree]);

  const failObjective = useCallback(async (id: string, reason: string) => {
    try {
      await fetch(`/api/objectives/${id}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      await refreshTree();
    } catch (err) {
      console.error('[useARIA] failObjective error:', err);
    }
  }, [refreshTree]);

  const rejectObjective = useCallback(async (id: string, feedback: string) => {
    try {
      await fetch(`/api/objectives/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      });
      await refreshTree();
    } catch (err) {
      console.error('[useARIA] rejectObjective error:', err);
    }
  }, [refreshTree]);

  const uploadFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Strip the data:...;base64, prefix
          const base64Data = result.split(',')[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, data: base64 }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.filename as string;
    } catch (err) {
      console.error('[useARIA] uploadFile error:', err);
      return null;
    }
  }, []);

  return {
    tree,
    objectives,
    needsYou,
    quickItems,
    recentWork,
    getSession,
    loadConversation,
    sendMessage,
    createObjective: createObj,
    updateObjective: updateObj,
    setMachine,
    succeedObjective,
    failObjective,
    rejectObjective,
    uploadFile,
    watchObjective,
    sendTTSRequest,
    cancelTTS,
    onTTSMessage,
    streamingText,
    connected,
  };
}
