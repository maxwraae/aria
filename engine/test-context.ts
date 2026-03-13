#!/usr/bin/env npx tsx
// test-context.ts — helper for context assembly and engine query tests
// Called by test-engine.sh with a command argument

import { initDb } from './src/db/schema.js';
import { assembleContext } from './src/context/assembler.js';
import { getPendingObjectives, getThinkingCount, getStuckObjectives } from './src/db/queries.js';
import fs from 'fs';

const command = process.argv[2];
const args = process.argv.slice(3);

const db = initDb();

try {
  switch (command) {
    case 'assemble': {
      const objectiveId = args[0];
      if (!objectiveId) {
        console.error('Usage: test-context.ts assemble <objectiveId>');
        process.exit(1);
      }
      const outPath = assembleContext(db, objectiveId);
      console.log(outPath);
      break;
    }

    case 'check-file': {
      const filePath = args[0];
      const section = args[1];
      if (!filePath || !section) {
        console.error('Usage: test-context.ts check-file <path> <section>');
        process.exit(1);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(section)) {
        console.log('FOUND');
      } else {
        console.log('NOT_FOUND');
      }
      break;
    }

    case 'read-file': {
      const filePath = args[0];
      if (!filePath) {
        console.error('Usage: test-context.ts read-file <path>');
        process.exit(1);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      console.log(content);
      break;
    }

    case 'get-pending': {
      const pending = getPendingObjectives(db);
      console.log(JSON.stringify(pending.map(o => ({ id: o.id, status: o.status }))));
      break;
    }

    case 'get-thinking-count': {
      const count = getThinkingCount(db);
      console.log(count);
      break;
    }

    case 'get-stuck': {
      const threshold = parseInt(args[0] ?? '300', 10);
      const stuck = getStuckObjectives(db, threshold);
      console.log(JSON.stringify(stuck.map(o => ({ id: o.id, status: o.status }))));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
} finally {
  db.close();
}
