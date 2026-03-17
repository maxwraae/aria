import http from 'http';
import fs from 'fs';
import { execSync } from 'node:child_process';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';
import {
  getTree,
  getObjective,
  getChildren,
  getConversation,
  insertMessage,
  createObjective,
  updateObjective,
  searchObjectives,
  matchObjectiveByText,
  updateStatus,
  updateTurnSession,
  cascadeAbandon,
  setWaitingOn,
  clearWaitingOn,
  setResolutionSummary,
  PROTECTED_IDS,
} from '../db/queries.js';
import { subscribe, unsubscribe, type StreamCallback } from '../engine/streams.js';
import { getTTS } from './tts.js';

// ── MIME types for static serving ─────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// ── JSON body parser ──────────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── Route matching ────────────────────────────────────────────────

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ── Server ────────────────────────────────────────────────────────

export function startServer(
  db: Database.Database,
  nudge: () => void,
  surfaceDist: string | null,
  port: number = 8080
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // CORS headers for Tailscale access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── API Routes ────────────────────────────────────────────

      // GET /api/objectives - full tree
      if (method === 'GET' && pathname === '/api/objectives') {
        const tree = getTree(db);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tree));
        return;
      }

      // GET /api/objectives/:id - single objective + children
      const showParams = matchRoute(pathname, '/api/objectives/:id');
      if (method === 'GET' && showParams && !pathname.includes('/conversation') && !pathname.includes('/message')) {
        const obj = getObjective(db, showParams.id);
        if (!obj) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const children = getChildren(db, showParams.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...obj, children }));
        return;
      }

      // PATCH /api/objectives/:id - update objective name/description
      const patchParams = matchRoute(pathname, '/api/objectives/:id');
      if (method === 'PATCH' && patchParams && !pathname.includes('/conversation') && !pathname.includes('/message')) {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => {
          try {
            const { objective, description, machine, model } = JSON.parse(body);
            updateObjective(db, patchParams.id, { objective, description, machine, model });
            const updated = getObjective(db, patchParams.id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updated));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // GET /api/objectives/:id/conversation
      const convParams = matchRoute(pathname, '/api/objectives/:id/conversation');
      if (method === 'GET' && convParams) {
        const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
        const messages = getConversation(db, convParams.id).slice(0, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messages));
        return;
      }

      // POST /api/objectives - create a new objective
      if (method === 'POST' && pathname === '/api/objectives') {
        const body = await parseBody(req);
        const objective = body.objective as string;
        if (!objective) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'objective required' }));
          return;
        }
        const newObj = createObjective(db, {
          objective,
          description: (body.description as string) ?? undefined,
          parent: (body.parent as string) ?? undefined,
          model: (body.model as string) ?? undefined,
        });
        // If instructions provided, send as first message
        if (body.instructions) {
          insertMessage(db, {
            objective_id: newObj.id,
            message: body.instructions as string,
            sender: 'max',
          });
          nudge();
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(newObj));
        return;
      }

      // POST /api/objectives/:id/message
      const msgParams = matchRoute(pathname, '/api/objectives/:id/message');
      if (method === 'POST' && msgParams) {
        const body = await parseBody(req);
        const message = body.message as string;
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message required' }));
          return;
        }
        const sender = (body.sender as string) ?? 'max';
        const msg = insertMessage(db, {
          objective_id: msgParams.id,
          message,
          sender,
        });
        nudge();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msg));
        return;
      }

      // POST /api/message - implicit routing (Slice 3)
      if (method === 'POST' && pathname === '/api/message') {
        const body = await parseBody(req);
        const message = body.message as string;
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message required' }));
          return;
        }

        const matches = matchObjectiveByText(db, message);

        if (matches.length === 0) {
          // No match — create new objective under quick
          const newObj = createObjective(db, {
            objective: message,
            parent: 'quick',
          });
          insertMessage(db, {
            objective_id: newObj.id,
            message,
            sender: 'max',
          });
          nudge();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ routed: true, objectiveId: newObj.id, created: true }));
          return;
        }

        // FTS rank is negative (more negative = better match)
        const topScore = matches[0].rank;
        const secondScore = matches.length > 1 ? matches[1].rank : 0;

        // High-confidence: top score is significantly better than second
        // rank is negative, so we check if top is more than 20% better (more negative)
        const isHighConfidence = matches.length === 1 ||
          (secondScore !== 0 && Math.abs(topScore) > Math.abs(secondScore) * 1.2);

        if (isHighConfidence) {
          // Route directly to the best match
          insertMessage(db, {
            objective_id: matches[0].id,
            message,
            sender: 'max',
          });
          nudge();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ routed: true, objectiveId: matches[0].id }));
          return;
        }

        // Ambiguous — return candidates for surface to show picker
        const candidates = matches.map(m => ({
          id: m.id,
          objective: m.objective,
          description: m.description,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ routed: false, candidates }));
        return;
      }

      // POST /api/objectives/:id/succeed
      const succeedParams = matchRoute(pathname, '/api/objectives/:id/succeed');
      if (method === 'POST' && succeedParams) {
        const body = await parseBody(req);
        const summary = body.summary as string;
        if (!summary) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'summary required' }));
          return;
        }
        const obj = getObjective(db, succeedParams.id);
        if (!obj) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        if (PROTECTED_IDS.has(succeedParams.id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot resolve protected objective' }));
          return;
        }
        const children = getChildren(db, succeedParams.id);
        const activeChildren = children.filter(c => ['idle', 'needs-input'].includes(c.status));

        updateStatus(db, succeedParams.id, 'resolved');
        setResolutionSummary(db, succeedParams.id, summary);
        cascadeAbandon(db, succeedParams.id);

        insertMessage(db, {
          objective_id: succeedParams.id,
          message: summary,
          sender: 'system',
          type: 'reply',
        });

        if (obj.parent) {
          insertMessage(db, {
            objective_id: obj.parent,
            message: `[resolved] ${obj.objective}: ${summary}`,
            sender: succeedParams.id,
            type: 'reply',
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: succeedParams.id,
          objective: obj.objective,
          status: 'resolved',
          abandoned_children: activeChildren.length,
        }));
        return;
      }

      // POST /api/objectives/:id/fail
      const failParams = matchRoute(pathname, '/api/objectives/:id/fail');
      if (method === 'POST' && failParams) {
        const body = await parseBody(req);
        const reason = body.reason as string;
        if (!reason) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'reason required' }));
          return;
        }
        const obj = getObjective(db, failParams.id);
        if (!obj) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        if (PROTECTED_IDS.has(failParams.id)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot fail protected objective' }));
          return;
        }

        updateStatus(db, failParams.id, 'failed');

        if (obj.parent) {
          insertMessage(db, {
            objective_id: obj.parent,
            message: `[failed] ${obj.objective}: ${reason}`,
            sender: failParams.id,
            type: 'reply',
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: failParams.id, status: 'failed' }));
        return;
      }

      // POST /api/objectives/:id/reject
      const rejectParams = matchRoute(pathname, '/api/objectives/:id/reject');
      if (method === 'POST' && rejectParams) {
        const body = await parseBody(req);
        const feedback = body.feedback as string;
        if (!feedback) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'feedback required' }));
          return;
        }
        const obj = getObjective(db, rejectParams.id);
        if (!obj) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        updateStatus(db, rejectParams.id, 'idle');
        clearWaitingOn(db, rejectParams.id);

        const caller = (body.caller as string) ?? 'max';
        insertMessage(db, {
          objective_id: rejectParams.id,
          message: feedback,
          sender: caller,
          type: 'message',
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: rejectParams.id, status: 'idle' }));
        return;
      }

      // POST /api/objectives/:id/wait
      const waitParams = matchRoute(pathname, '/api/objectives/:id/wait');
      if (method === 'POST' && waitParams) {
        const body = await parseBody(req);
        const reason = body.reason as string;
        if (!reason) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'reason required' }));
          return;
        }
        const obj = getObjective(db, waitParams.id);
        if (!obj) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        setWaitingOn(db, waitParams.id, reason);
        updateStatus(db, waitParams.id, 'idle');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: waitParams.id, status: 'idle', waiting_on: reason }));
        return;
      }

      // POST /api/notify
      if (method === 'POST' && pathname === '/api/notify') {
        const body = await parseBody(req);
        const message = body.message as string;
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message required' }));
          return;
        }
        const sender = (body.sender as string) ?? 'system';
        const important = body.important as boolean ?? false;
        const urgent = body.urgent as boolean ?? false;

        insertMessage(db, {
          objective_id: 'root',
          message: '[notify] ' + message,
          sender,
          type: 'signal',
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message, important, urgent }));
        return;
      }

      // GET /api/worker/objectives?machine=X
      if (method === 'GET' && pathname === '/api/worker/objectives') {
        const machine = url.searchParams.get('machine');
        if (!machine) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'machine parameter required' }));
          return;
        }
        // Get objectives with unprocessed messages assigned to this machine
        const pending = db.prepare(`
          SELECT DISTINCT o.* FROM objectives o
          JOIN inbox i ON i.objective_id = o.id
          WHERE i.turn_id IS NULL
          AND o.status IN ('idle', 'needs-input')
          AND o.machine = ?
        `).all(machine);

        // For each, include unprocessed messages
        const result = (pending as Record<string, unknown>[]).map((obj) => ({
          ...obj,
          messages: db.prepare(
            'SELECT * FROM inbox WHERE objective_id = ? AND turn_id IS NULL ORDER BY created_at'
          ).all(obj.id),
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // POST /api/worker/turns/:turnId/complete
      const workerCompleteParams = matchRoute(pathname, '/api/worker/turns/:turnId/complete');
      if (method === 'POST' && workerCompleteParams) {
        const body = await parseBody(req);
        const { objectiveId, status, lastAssistantText, sessionId } = body;

        if (!objectiveId || !lastAssistantText) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'objectiveId and lastAssistantText required' }));
          return;
        }

        const turnId = workerCompleteParams.turnId;

        // Update session ID on turn
        if (sessionId) {
          updateTurnSession(db, turnId, sessionId as string);
        }

        // Set status
        const finalStatus = (status as string) || 'needs-input';
        updateStatus(db, objectiveId as string, finalStatus);

        // Store assistant response
        const selfMsg = insertMessage(db, {
          objective_id: objectiveId as string,
          message: lastAssistantText as string,
          sender: objectiveId as string,
          type: 'reply',
        });
        db.prepare('UPDATE inbox SET turn_id = ? WHERE id = ?').run(turnId, selfMsg.id);

        // Route to non-Max senders
        const triggeredMessages = db.prepare(
          "SELECT DISTINCT sender FROM inbox WHERE turn_id = ? AND sender != ? AND sender != ? AND sender != ?"
        ).all(turnId, 'max', 'system', objectiveId) as { sender: string }[];

        for (const { sender } of triggeredMessages) {
          const senderObj = getObjective(db, sender);
          if (senderObj) {
            insertMessage(db, {
              objective_id: sender,
              message: lastAssistantText as string,
              sender: objectiveId as string,
              type: 'reply',
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // GET /api/search?q=
      if (method === 'GET' && pathname === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        if (!q) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'q parameter required' }));
          return;
        }
        const results = searchObjectives(db, q);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results));
        return;
      }

      // ── Static file serving (SPA fallback) ─────────────────

      if (surfaceDist && method === 'GET' && !pathname.startsWith('/api/')) {
        const filePath = pathname === '/' ? '/index.html' : pathname;
        const fullPath = path.join(surfaceDist, filePath);

        // Security: prevent directory traversal
        if (!fullPath.startsWith(surfaceDist)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            const ext = path.extname(fullPath);
            const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
            const headers: Record<string, string> = { 'Content-Type': mimeType };
            // Prevent caching of HTML so refreshes always get latest build
            if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            res.writeHead(200, headers);
            fs.createReadStream(fullPath).pipe(res);
            return;
          }
        } catch {
          // File doesn't exist - fall through to SPA fallback
        }

        // SPA fallback: serve index.html for any non-file route
        const indexPath = path.join(surfaceDist, 'index.html');
        try {
          fs.statSync(indexPath);
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
          fs.createReadStream(indexPath).pipe(res);
          return;
        } catch {
          // No index.html yet
        }
      }

      // ── 404 ────────────────────────────────────────────────

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
      console.error('[server] Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  // ── WebSocket ─────────────────────────────────────────────────

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    let watchedObjectiveId: string | null = null;
    let streamCallback: StreamCallback | null = null;
    let lastTreeJSON = '';

    // Send initial tree snapshot
    const tree = getTree(db);
    const treeJSON = JSON.stringify(tree);
    lastTreeJSON = treeJSON;
    ws.send(JSON.stringify({ type: 'tree_snapshot', tree }));

    // Tree polling (every 500ms)
    const treeInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const currentTree = getTree(db);
        const currentJSON = JSON.stringify(currentTree);
        if (currentJSON !== lastTreeJSON) {
          lastTreeJSON = currentJSON;
          ws.send(JSON.stringify({ type: 'tree_snapshot', tree: currentTree }));
        }
      } catch (err) {
        console.error('[ws] Tree poll error:', err);
      }
    }, 500);

    // Handle client messages
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'watch_objective') {
          // Unsubscribe from previous objective
          if (watchedObjectiveId && streamCallback) {
            unsubscribe(watchedObjectiveId, streamCallback);
          }

          watchedObjectiveId = msg.objectiveId as string;

          // Subscribe to activeStreams for this objective
          streamCallback = (text: string, done: boolean) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({
              type: 'turn_stream',
              objectiveId: watchedObjectiveId,
              text,
              done,
            }));
          };

          subscribe(watchedObjectiveId, streamCallback);
        }

        // ── TTS ─────────────────────────────────────────────────
        if (msg.type === 'tts_request') {
          const text = msg.text as string;
          const requestId = msg.requestId as string;
          if (!text || !requestId) return;

          const tts = getTTS();
          if (!tts) {
            ws.send(JSON.stringify({ type: 'tts_error', requestId, error: 'TTS not available' }));
            return;
          }

          tts.synthesizeStreaming(text, (audio, sampleRate, isLastChunk) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ type: 'tts_audio', requestId, audio, sampleRate, isLastChunk }));
          }).catch(err => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tts_error', requestId, error: String(err) }));
            }
          });
        }
      } catch {
        // Invalid message, ignore
      }
    });

    // Cleanup on close
    ws.on('close', () => {
      clearInterval(treeInterval);
      if (watchedObjectiveId && streamCallback) {
        unsubscribe(watchedObjectiveId, streamCallback);
      }
    });
  });

  // ── Start listening ────────────────────────────────────────────

  server.listen(port, '0.0.0.0', () => {
    // Automatically ensure Tailscale HTTPS tunnel is active
    let tailscaleUrl: string | null = null;
    try {
      const tsPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
      if (fs.existsSync(tsPath)) {
        const out = execSync(`"${tsPath}" serve --bg ${port}`).toString();
        if (out.includes("https://")) {
          tailscaleUrl = out.match(/https:\/\/[^\s]+/)?.[0] ?? null;
        }
      }
    } catch (err) {
      // Tailscale not available or needs manual login
    }

    console.log(`[server] Aria is running`);
    if (tailscaleUrl) {
      console.log(`[server]   ${tailscaleUrl}`);
    }
    console.log(`[server]   http://localhost:${port}`);
  });

  return server;
}
