import { useState, useEffect, useCallback, useRef } from 'react';
import type { Objective, InboxMessage } from './types';
import type { ChatSession } from '../types/chat';
import type { NeedsYouItem } from '../components/NeedsYouStrip';
import type { ObjectiveCardData } from '../components/ObjectiveCard';
import { buildTree, toNeedsYouItems, toRecentWork, toSession, type ObjectiveNode } from './adapters';

function getWsUrl(): string {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:8080/ws';
}

export interface UseARIAReturn {
  tree: ObjectiveNode | null;
  objectives: Objective[];
  needsYou: NeedsYouItem[];
  recentWork: ObjectiveCardData[];
  getSession: (id: string) => ChatSession;
  loadConversation: (id: string) => Promise<void>;
  sendMessage: (objectiveId: string, text: string) => Promise<void>;
  createObjective: (parent: string, objective: string, instructions?: string) => Promise<string | null>;
  updateObjective: (id: string, fields: { objective?: string; description?: string }) => Promise<void>;
  watchObjective: (objectiveId: string) => void;
  streamingText: Map<string, string>;
  connected: boolean;
}

export function useARIA(): UseARIAReturn {
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [tree, setTree] = useState<ObjectiveNode | null>(null);
  const [needsYou, setNeedsYou] = useState<NeedsYouItem[]>([]);
  const [recentWork, setRecentWork] = useState<ObjectiveCardData[]>([]);
  const [connected, setConnected] = useState(false);
  const [streamingText, setStreamingText] = useState<Map<string, string>>(new Map());

  const sessionsRef = useRef<Map<string, ChatSession>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectivesRef = useRef<Objective[]>([]);

  // Keep objectivesRef in sync
  useEffect(() => {
    objectivesRef.current = objectives;
  }, [objectives]);

  const processTree = useCallback((objs: Objective[]) => {
    setObjectives(objs);
    const builtTree = buildTree(objs);
    setTree(builtTree);
    setNeedsYou(toNeedsYouItems(objs, sessionsRef.current));
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
          } else if (msg.type === 'turn_stream') {
            setStreamingText(prev => {
              const next = new Map(prev);
              if (msg.done) {
                next.delete(msg.objectiveId);
              } else {
                next.set(msg.objectiveId, msg.text);
              }
              return next;
            });
          }
        } catch {
          // Invalid message, ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
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
      const res = await fetch(`/api/objectives/${id}/conversation`);
      if (!res.ok) return;
      const messages: InboxMessage[] = await res.json();

      const obj = objectivesRef.current.find(o => o.id === id);
      if (obj) {
        const session = toSession(obj, messages);
        sessionsRef.current.set(id, session);
        setNeedsYou(toNeedsYouItems(objectivesRef.current, sessionsRef.current));
      }
    } catch {
      // Network error, will retry on next navigation
    }
  }, []);

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
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
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

  const updateObj = useCallback(async (id: string, fields: { objective?: string; description?: string }) => {
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

  return {
    tree,
    objectives,
    needsYou,
    recentWork,
    getSession,
    loadConversation,
    sendMessage,
    createObjective: createObj,
    updateObjective: updateObj,
    watchObjective,
    streamingText,
    connected,
  };
}
