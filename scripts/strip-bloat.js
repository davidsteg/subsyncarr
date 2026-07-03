// Strip stdout/stderr from existing engines JSON to reclaim ~10GB of DB bloat
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.argv[2] || '/app/data/subsyncarr-plus.db';
const BATCH_SIZE = 5000;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const total = db.prepare('SELECT COUNT(*) as c FROM file_results').get().c;
console.log(`Total rows: ${total}`);

let offset = 0;
let cleaned = 0;
let skipped = 0;
const startTime = Date.now();

while (offset < total) {
  const rows = db.prepare(
    'SELECT id, engines FROM file_results ORDER BY id LIMIT ? OFFSET ?'
  ).all(BATCH_SIZE, offset);

  const updateStmt = db.prepare('UPDATE file_results SET engines = ? WHERE id = ?');

  const txn = db.transaction(() => {
    for (const row of rows) {
      try {
        const engines = JSON.parse(row.engines);
        let changed = false;
        for (const [engine, data] of Object.entries(engines)) {
          if (data && typeof data === 'object' && ('stdout' in data || 'stderr' in data)) {
            const { stdout, stderr, ...lean } = data;
            engines[engine] = lean;
            changed = true;
          }
        }
        if (changed) {
          updateStmt.run(JSON.stringify(engines), row.id);
          cleaned++;
        } else {
          skipped++;
        }
      } catch (e) {
        console.error(`Error parsing row ${row.id}: ${e.message}`);
        skipped++;
      }
    }
  });

  txn();
  offset += BATCH_SIZE;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const pct = ((offset / total) * 100).toFixed(1);
  console.log(`[${elapsed}s] ${offset}/${total} (${pct}%) — cleaned: ${cleaned}, skipped: ${skipped}`);
}

const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`Done in ${totalElapsed}s — cleaned ${cleaned} rows, skipped ${skipped}`);

// Vacuum to reclaim space
console.log('Vacuuming...');
db.pragma('incremental_vacuum');
const newSize = db.pragma('page_count', {simple: true}) * db.pragma('page_size', {simple: true});
console.log(`DB size after vacuum: ${(newSize/1024/1024).toFixed(1)} MB`);
db.close();
