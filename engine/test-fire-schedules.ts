// Test helper: fire all ready schedules
import { initDb } from './src/db/schema.js';
import { getReadySchedules, deleteSchedule, bumpSchedule, insertMessage } from './src/db/queries.js';
import { parseInterval } from './src/cli/parse-interval.js';

const db = initDb();
const ready = getReadySchedules(db);

for (const s of ready) {
  insertMessage(db, {
    objective_id: s.objective_id,
    message: s.message,
    sender: 'system',
    type: 'message',
  });

  if (s.interval) {
    const secs = parseInterval(s.interval);
    if (secs && secs > 0) {
      bumpSchedule(db, s.id, secs);
    } else {
      deleteSchedule(db, s.id);
    }
  } else {
    deleteSchedule(db, s.id);
  }
}

console.log(`Fired ${ready.length} schedule(s)`);
db.close();
