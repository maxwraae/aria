import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type Database from 'better-sqlite3';
import { generateId, now } from '../db/utils.js';

const SECRETS_PATH = path.join(os.homedir(), '.aria', 'secrets.json');

interface Secrets {
  vapid?: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
}

function loadSecrets(): Secrets {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSecrets(secrets: Secrets): void {
  const dir = path.dirname(SECRETS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
}

let initialized = false;

/**
 * Load or generate VAPID keys and configure web-push.
 * Returns the public key (needed by the frontend for subscription).
 */
export function initPush(db: Database.Database): string {
  const secrets = loadSecrets();

  if (!secrets.vapid) {
    const keys = webpush.generateVAPIDKeys();
    secrets.vapid = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:max@aria.local',
    };
    saveSecrets(secrets);
    console.log('[push] Generated VAPID keys → ~/.aria/secrets.json');
  }

  if (!initialized) {
    webpush.setVapidDetails(
      secrets.vapid.subject,
      secrets.vapid.publicKey,
      secrets.vapid.privateKey,
    );
    initialized = true;
  }

  return secrets.vapid.publicKey;
}

/**
 * Save a push subscription (upsert by endpoint).
 */
export function saveSubscription(
  db: Database.Database,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  label?: string,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO push_subscriptions (id, endpoint, keys_p256dh, keys_auth, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(generateId(), sub.endpoint, sub.keys.p256dh, sub.keys.auth, label ?? null, now());
}

/**
 * Remove a push subscription by endpoint.
 */
export function removeSubscription(db: Database.Database, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

interface PushPayload {
  message: string;
  sender?: string;
  important?: boolean;
  urgent?: boolean;
}

/**
 * Send a push notification to all subscribed devices.
 * Fire-and-forget: errors are logged, stale subscriptions are cleaned up.
 */
export function sendPushToAll(db: Database.Database, payload: PushPayload): void {
  const rows = db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions').all() as Array<{
    endpoint: string;
    keys_p256dh: string;
    keys_auth: string;
  }>;

  if (rows.length === 0) return;

  const body = JSON.stringify(payload);

  for (const row of rows) {
    const sub = {
      endpoint: row.endpoint,
      keys: { p256dh: row.keys_p256dh, auth: row.keys_auth },
    };

    webpush.sendNotification(sub, body).catch((err: any) => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or invalid — clean up
        removeSubscription(db, row.endpoint);
        console.log(`[push] Removed stale subscription: ${row.endpoint.slice(0, 60)}...`);
      } else {
        console.error(`[push] Failed to send to ${row.endpoint.slice(0, 60)}:`, err.message ?? err);
      }
    });
  }

  console.log(`[push] Sent to ${rows.length} subscriber(s)`);
}
