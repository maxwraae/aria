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
  machine?: string | null;
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
      machine: obj.machine ?? null,
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
    .filter(o => o.parent !== null && o.id !== 'quick' && o.parent !== 'quick') // exclude root, quick, and quick's children
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

export function toQuickItems(objectives: Objective[], sessionCache: Map<string, ChatSession>): NeedsYouItem[] {
  return objectives
    .filter(o => o.parent === 'quick')
    .filter(o => o.status !== 'resolved' && o.status !== 'abandoned')
    .sort((a, b) => b.updated_at - a.updated_at)
    .map(o => ({
      session: sessionCache.get(o.id) ?? {
        id: o.id,
        name: o.objective,
        status: mapStatus(o.status),
        messages: [],
      },
      parents: [],
    }));
}

export function toRecentWork(objectives: Objective[]): ObjectiveCardData[] {
  const topLevel = objectives
    .filter(o => o.parent === 'root' && o.id !== 'quick') // children of root only, exclude root and quick
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

const ATTACHMENT_REGEX = /\[attachment:(.+?)\]/;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

function isImageFile(filename: string): boolean {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

export function toMessages(messages: InboxMessage[], objectives?: Objective[], selfId?: string): ChatMessage[] {
  // Build a lookup map from objective ID → objective text (display name)
  const nameById = new Map<string, string>();
  if (objectives) {
    for (const o of objectives) {
      nameById.set(o.id, o.objective);
    }
  }

  return messages.flatMap(m => {
    if (m.type === 'action') {
      let tool = 'unknown';
      if (m.message.startsWith('edited ') || m.message.startsWith('wrote ')) tool = 'Edit';
      else if (m.message.startsWith('searched ')) tool = 'WebSearch';
      else if (m.message.startsWith('spawned ')) tool = 'spawn-child';
      else if (m.message.startsWith('fetched ')) tool = 'WebFetch';
      return [{ id: m.id, kind: 'action' as const, summary: m.message, tool, timestamp: m.created_at * 1000 }];
    }
    if (m.sender === 'max') {
      const match = ATTACHMENT_REGEX.exec(m.message);
      if (match) {
        const filename = match[1];
        const timestamp = m.created_at * 1000;
        const textPart = m.message.replace(ATTACHMENT_REGEX, '').trim();
        const result: ChatMessage[] = [];

        if (textPart) {
          result.push({
            id: m.id,
            kind: 'user' as const,
            text: textPart,
            timestamp,
          });
        }

        if (isImageFile(filename)) {
          result.push({
            id: m.id + '-attachment',
            kind: 'image' as const,
            uri: '/api/uploads/' + filename,
            width: 0,
            height: 0,
            timestamp,
          });
        } else {
          result.push({
            id: m.id + '-attachment',
            kind: 'file' as const,
            name: filename,
            size: '',
            timestamp,
          });
        }

        return result;
      }

      return [{
        id: m.id,
        kind: 'user' as const,
        text: m.message,
        timestamp: m.created_at * 1000,
      }];
    }
    if (m.sender === 'system') {
      return [{
        id: m.id,
        kind: 'agent' as const,
        text: m.message,
        whisper: 'system',
        timestamp: m.created_at * 1000,
      }];
    }
    // Skip self — the objective's own replies shouldn't get a child label
    if (m.sender === selfId) {
      return [{ id: m.id, kind: 'agent' as const, text: m.message, timestamp: m.created_at * 1000 }];
    }
    // This message is from a child objective — resolve its display name
    const senderName = nameById.get(m.sender) ?? undefined;
    return [{
      id: m.id,
      kind: 'agent' as const,
      text: m.message,
      sender: senderName,
      timestamp: m.created_at * 1000,
    }];
  });
}

export function toSession(obj: Objective, messages: InboxMessage[], objectives?: Objective[]): ChatSession {
  return {
    id: obj.id,
    name: obj.objective,
    status: mapStatus(obj.status),
    model: obj.model,
    messages: toMessages(messages, objectives, obj.id),
  };
}
