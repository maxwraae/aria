#!/usr/bin/env npx tsx
// migrate-peer.ts — Run initDb migrations against the peer (macbook) database
import { initDb } from './src/db/schema.js';

const db = initDb();

// Verify columns
const cols = (db.pragma('table_info(objectives)') as {name: string}[]).map(c => c.name);
console.log('objectives columns:', cols.join(', '));
const inboxCols = (db.pragma('table_info(inbox)') as {name: string}[]).map(c => c.name);
console.log('inbox columns:', inboxCols.join(', '));

// Check depth backfill
const sample = db.prepare('SELECT id, objective, depth FROM objectives LIMIT 5').all() as {id: string, objective: string, depth: number}[];
console.log('sample depths:');
for (const s of sample) {
  console.log(`  ${s.id.slice(0,8)} depth=${s.depth} "${s.objective.slice(0,50)}"`);
}

db.close();
console.log('Done');
