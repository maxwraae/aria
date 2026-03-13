import type { Objective, InboxMessage } from './types';
import type { ChatMessage, ChatSession } from '../types/chat';
import type { NeedsYouItem } from '../components/NeedsYouStrip';
import type { ObjectiveCardData, ObjectiveChild } from '../components/ObjectiveCard';

export interface ObjectiveNode {
  id: string;
  name: string;
  status: "idle" | "thinking" | "needs-input" | "resolved" | "failed";
  description?: string;
  urgent?: boolean;
  important?: boolean;
  model?: string;
  children?: ObjectiveNode[];
}

function mapStatus(s: string): "idle" | "thinking" | "needs-input" | "resolved" | "failed" {
  if (s === 'abandoned') return 'failed';
  if (s === 'waiting-input') return 'needs-input';
  const valid = ['idle', 'thinking', 'needs-input', 'resolved', 'failed'];
  return valid.includes(s) ? s as any : 'idle';
}

// Remembered child order per parent — locked once seen, new children prepend
const lockedOrder = new Map<string | null, string[]>();

export function buildTree(objectives: Objective[]): ObjectiveNode | null {
  const byParent = new Map<string | null, Objective[]>();
  for (const obj of objectives) {
    const key = obj.parent;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(obj);
  }

  function build(parentId: string | null): ObjectiveNode[] {
    const children = byParent.get(parentId) ?? [];
    const ids = children.map(c => c.id);

    // Lock order: first time we see this parent's children, remember the order
    // On subsequent calls, keep that order and prepend any new children
    const locked = lockedOrder.get(parentId);
    let ordered: Objective[];
    if (locked) {
      const byId = new Map(children.map(c => [c.id, c]));
      // Start with new children (not in locked order) at the top
      const newIds = ids.filter(id => !locked.includes(id));
      // Then existing in their locked order (skip removed ones)
      const existingIds = locked.filter(id => byId.has(id));
      const finalOrder = [...newIds, ...existingIds];
      ordered = finalOrder.map(id => byId.get(id)!).filter(Boolean);
      // Update locked order with new children prepended
      lockedOrder.set(parentId, finalOrder);
    } else {
      ordered = children;
      lockedOrder.set(parentId, ids);
    }

    return ordered.map(obj => ({
      id: obj.id,
      name: obj.objective,
      status: mapStatus(obj.status),
      description: obj.description ?? undefined,
      urgent: obj.urgent === 1 ? true : undefined,
      important: obj.important === 1 ? true : undefined,
      model: obj.model,
      children: build(obj.id),
    }));
  }

  const roots = build(null);
  return roots[0] ?? null;
}

export function buildParentChain(objectives: Objective[], id: string): string[] {
  const byId = new Map(objectives.map(o => [o.id, o]));
  const chain: string[] = [];
  let current = byId.get(id);
  while (current?.parent) {
    const parent = byId.get(current.parent);
    if (!parent) break;
    chain.unshift(parent.objective);
    current = parent;
  }
  return chain;
}

export function toNeedsYouItems(objectives: Objective[], sessionCache: Map<string, ChatSession>): NeedsYouItem[] {
  return objectives
    .filter(o => o.parent !== null) // exclude root
    .filter(o => o.status === 'needs-input' || o.status === 'waiting-input')
    .sort((a, b) => {
      const scoreA = (a.urgent ? 2 : 0) + (a.important ? 1 : 0);
      const scoreB = (b.urgent ? 2 : 0) + (b.important ? 1 : 0);
      return scoreB - scoreA || b.updated_at - a.updated_at;
    })
    .map(o => ({
      session: sessionCache.get(o.id) ?? {
        id: o.id,
        name: o.objective,
        status: mapStatus(o.status),
        messages: [],
      },
      urgent: o.urgent === 1 ? true : undefined,
      important: o.important === 1 ? true : undefined,
      parents: buildParentChain(objectives, o.id),
    }));
}

export function toRecentWork(objectives: Objective[]): ObjectiveCardData[] {
  const topLevel = objectives
    .filter(o => o.parent === 'root') // children of root only, exclude root itself
    .sort((a, b) => b.updated_at - a.updated_at);

  return topLevel.map(o => {
    const children = objectives
      .filter(c => c.parent === o.id)
      .map(c => ({ name: c.objective, status: mapStatus(c.status) } as ObjectiveChild));
    return {
      id: o.id,
      name: o.objective,
      description: o.description ?? '',
      lastAccessed: new Date(o.updated_at * 1000),
      status: mapStatus(o.status),
      children,
    };
  });
}

export function toMessages(messages: InboxMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (m.sender === 'max') {
      return {
        id: m.id,
        kind: 'user' as const,
        text: m.message,
        timestamp: m.created_at * 1000,
      };
    }
    if (m.sender === 'system') {
      return {
        id: m.id,
        kind: 'agent' as const,
        text: m.message,
        whisper: 'system',
        timestamp: m.created_at * 1000,
      };
    }
    return {
      id: m.id,
      kind: 'agent' as const,
      text: m.message,
      timestamp: m.created_at * 1000,
    };
  });
}

export function toSession(obj: Objective, messages: InboxMessage[]): ChatSession {
  return {
    id: obj.id,
    name: obj.objective,
    status: mapStatus(obj.status),
    model: obj.model,
    messages: toMessages(messages),
  };
}
