#!/usr/bin/env npx tsx
// test-prelaunch-helper.ts — helper for Mac Mini pre-launch validation
// Called by test-prelaunch.sh with a command argument

import { getMachineId, isWorker, getLocalDbPath, getPeerDbPath } from './src/db/node.js';
import { initDb } from './src/db/schema.js';
import { syncFromPeer } from './src/db/queries.js';
import { assembleContext } from './src/context/assembler.js';
import personaBrick from './src/context/bricks/persona/index.js';
import contractBrick from './src/context/bricks/contract/index.js';
import environmentBrick from './src/context/bricks/environment/index.js';
import objectiveBrick from './src/context/bricks/objective/index.js';
import parentsBrick from './src/context/bricks/parents/index.js';
import siblingsBrick from './src/context/bricks/siblings/index.js';
import childrenBrick from './src/context/bricks/children/index.js';
import similarBrick from './src/context/bricks/similar/index.js';
import memoryBrick from './src/context/bricks/memory/index.js';
import conversationBrick from './src/context/bricks/conversation/index.js';
import neverBrick from './src/context/bricks/never/index.js';
import focusBrick from './src/context/bricks/focus/index.js';
import { loadConfig } from './src/context/config.js';
import fs from 'fs';

const BRICKS = [
  personaBrick,
  contractBrick,
  environmentBrick,
  objectiveBrick,
  parentsBrick,
  siblingsBrick,
  childrenBrick,
  similarBrick,
  memoryBrick,
  conversationBrick,
  neverBrick,
  focusBrick,
];

const command = process.argv[2];

try {
  switch (command) {
    case 'machine-id': {
      console.log(getMachineId());
      break;
    }

    case 'is-worker': {
      console.log(isWorker() ? 'true' : 'false');
      break;
    }

    case 'local-db-path': {
      console.log(getLocalDbPath());
      break;
    }

    case 'peer-db-path': {
      console.log(getPeerDbPath());
      break;
    }

    case 'init-db': {
      const db = initDb();
      db.close();
      console.log('OK');
      break;
    }

    case 'check-root': {
      const db = initDb();
      try {
        const row = db.prepare("SELECT id FROM objectives WHERE id = 'root'").get();
        console.log(row ? 'YES' : 'NO');
      } finally {
        db.close();
      }
      break;
    }

    case 'check-quick': {
      const db = initDb();
      try {
        const row = db.prepare("SELECT id FROM objectives WHERE id = 'quick'").get();
        console.log(row ? 'YES' : 'NO');
      } finally {
        db.close();
      }
      break;
    }

    case 'check-journal': {
      const db = initDb();
      try {
        const result = db.pragma('journal_mode') as { journal_mode: string }[];
        console.log(result[0]?.journal_mode ?? 'unknown');
      } finally {
        db.close();
      }
      break;
    }

    case 'check-columns': {
      const db = initDb();
      try {
        const objCols = (db.pragma('table_info(objectives)') as { name: string }[]).map(c => c.name);
        const inboxCols = (db.pragma('table_info(inbox)') as { name: string }[]).map(c => c.name);
        console.log(JSON.stringify({ objectives: objCols, inbox: inboxCols }));
      } finally {
        db.close();
      }
      break;
    }

    case 'assemble-context': {
      const db = initDb();
      try {
        const config = loadConfig();
        const { content } = assembleContext(BRICKS, {
          db,
          objectiveId: 'root',
          config: config as unknown as Record<string, unknown>,
        });
        console.log(content);
      } finally {
        db.close();
      }
      break;
    }

    case 'sync-peer': {
      const db = initDb();
      try {
        syncFromPeer(db);
        console.log('OK');
      } catch (err) {
        console.log((err as Error).message ?? String(err));
      } finally {
        db.close();
      }
      break;
    }

    case 'peer-available': {
      const peerPath = getPeerDbPath();
      console.log(fs.existsSync(peerPath) ? 'YES' : 'NO');
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
} catch (err) {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
}
