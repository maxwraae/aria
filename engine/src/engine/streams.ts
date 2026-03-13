/**
 * Shared activeStreams map for bridging live turn output to WebSocket clients.
 * Module-level state shared between engine/output.ts and server/index.ts.
 */

export type StreamCallback = (text: string, done: boolean) => void;

const activeStreams = new Map<string, StreamCallback[]>();

export function subscribe(objectiveId: string, cb: StreamCallback): void {
  if (!activeStreams.has(objectiveId)) {
    activeStreams.set(objectiveId, []);
  }
  activeStreams.get(objectiveId)!.push(cb);
}

export function unsubscribe(objectiveId: string, cb: StreamCallback): void {
  const cbs = activeStreams.get(objectiveId);
  if (!cbs) return;
  const idx = cbs.indexOf(cb);
  if (idx !== -1) cbs.splice(idx, 1);
  if (cbs.length === 0) activeStreams.delete(objectiveId);
}

export function emit(objectiveId: string, text: string, done: boolean): void {
  const cbs = activeStreams.get(objectiveId);
  if (!cbs) return;
  for (const cb of cbs) {
    cb(text, done);
  }
}
