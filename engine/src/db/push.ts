import { getCoordinatorUrl, isWorker } from './node.js';

// ── Data sync (fire-and-forget) ──────────────────────────────────

export function pushSync(payload: {
  objectives?: Record<string, unknown>[],
  inbox?: Record<string, unknown>[],
  turns?: Record<string, unknown>[],
}): void {
  if (!isWorker()) return;
  const url = getCoordinatorUrl();
  if (!url) return;

  fetch(`${url}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

// ── Stream forwarding (debounced, ~100ms) ────────────────────────

const pendingStreams = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

export function pushStream(objectiveId: string, text: string, done: boolean): void {
  if (!isWorker()) return;
  const url = getCoordinatorUrl();
  if (!url) return;

  // done=true flushes immediately
  if (done) {
    const pending = pendingStreams.get(objectiveId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingStreams.delete(objectiveId);
    }
    doStreamPost(url, objectiveId, text, true);
    return;
  }

  // Debounce: accumulate and POST every 100ms
  const existing = pendingStreams.get(objectiveId);
  if (existing) {
    existing.text = text; // always keep latest cumulative text
    return; // timer already running
  }

  const timer = setTimeout(() => {
    const entry = pendingStreams.get(objectiveId);
    pendingStreams.delete(objectiveId);
    if (entry) {
      doStreamPost(url, objectiveId, entry.text, false);
    }
  }, 100);

  pendingStreams.set(objectiveId, { text, timer });
}

function doStreamPost(url: string, objectiveId: string, text: string, done: boolean): void {
  fetch(`${url}/api/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objectiveId, text, done }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
