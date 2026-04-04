import Database from 'better-sqlite3';
import fs from 'fs';
import { getPeerDbPath } from './node.js';

let peerAvailable = false;
let lastPeerCheck = 0;
const PEER_CHECK_INTERVAL = 30_000; // 30 seconds

export function attachPeer(db: Database.Database): boolean {
  try {
    const peerPath = getPeerDbPath();
    if (!fs.existsSync(peerPath)) {
      if (peerAvailable) console.error('[aria] Peer database not found, operating local-only');
      peerAvailable = false;
      return false;
    }

    // Detach first if already attached
    try { db.exec('DETACH DATABASE peer'); } catch {}

    db.exec(`ATTACH DATABASE '${peerPath}' AS peer`);
    peerAvailable = true;
    return true;
  } catch (err) {
    if (peerAvailable) console.error('[aria] Peer database unavailable:', (err as Error).message);
    peerAvailable = false;
    return false;
  }
}

export function isPeerAvailable(): boolean {
  return peerAvailable;
}

/**
 * Execute a function with peer attached. Falls back to local-only on failure.
 * The callback receives whether peer is available.
 */
export function withPeer<T>(db: Database.Database, fn: (hasPeer: boolean) => T): T {
  // Readonly connections can't ATTACH — skip peer, retry on transient I/O errors
  if (db.readonly) {
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        return fn(false);
      } catch (err: any) {
        if (attempt < 3 && err?.code?.startsWith?.('SQLITE_IOERR')) {
          const waitMs = 100 * (attempt + 1);
          const start = Date.now();
          while (Date.now() - start < waitMs) {} // sync wait
          continue;
        }
        throw err;
      }
    }
    return fn(false); // unreachable
  }

  const now = Date.now();
  if (!peerAvailable && now - lastPeerCheck < PEER_CHECK_INTERVAL) {
    return fn(false);
  }
  lastPeerCheck = now;

  const hasPeer = attachPeer(db);
  try {
    return fn(hasPeer);
  } catch (err) {
    // If a peer query fails (e.g. iCloud corruption), retry local-only
    if (hasPeer) {
      try { db.exec('DETACH DATABASE peer'); } catch {}
      peerAvailable = false;
      return fn(false);
    }
    throw err;
  } finally {
    if (hasPeer) {
      try { db.exec('DETACH DATABASE peer'); } catch {}
    }
  }
}

/**
 * Build a UNION ALL query that combines local and peer results.
 * Only includes peer if available.
 */
export function buildUnionQuery(localQuery: string, peerQuery: string, hasPeer: boolean): string {
  if (!hasPeer) return localQuery;
  return `${localQuery} UNION ALL ${peerQuery}`;
}
