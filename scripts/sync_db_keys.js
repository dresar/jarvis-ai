const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 1. Get 66 valid keys from src/main/keyPoolManager.ts
const kpmPath = path.join(__dirname, '../src/main/keyPoolManager.ts');
const kpmCode = fs.readFileSync(kpmPath, 'utf-8');
const match = kpmCode.match(/export const SEED_API_KEYS: string\[\] = \[([\s\S]*?)\n\]/);
const keyLines = match[1].match(/'[^']+'/g) || [];
const validKeys = keyLines.map(k => k.replace(/'/g, ''));
console.log(`Loaded ${validKeys.length} valid keys.`);

// Find all db paths
const dbPaths = [
  path.join(__dirname, '../jarvis-data/jarvis_memory.db'),
  path.join(process.env.APPDATA || '', 'jarvis/jarvis-data/jarvis_memory.db')
];

for (const dbPath of dbPaths) {
  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  console.log(`\nSyncing database: ${dbPath}`);
  const db = new Database(dbPath);
  
  // Ensure tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS api_key_pool (
      id TEXT PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'COOLDOWN', 'DISABLED')),
      last_used_at INTEGER,
      cooldown_until INTEGER,
      success_calls INTEGER DEFAULT 0,
      failed_calls INTEGER DEFAULT 0,
      rate_limit_count INTEGER DEFAULT 0,
      consecutive_errors INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Delete all keys not in the valid 66 list
  const allCurrent = db.prepare('SELECT api_key FROM api_key_pool').all();
  const deleteStmt = db.prepare('DELETE FROM api_key_pool WHERE api_key = ?');
  let deletedCount = 0;
  for (const row of allCurrent) {
    if (!validKeys.includes(row.api_key)) {
      deleteStmt.run(row.api_key);
      deletedCount++;
    }
  }

  // Insert or update valid keys
  const insertStmt = db.prepare(`
    INSERT INTO api_key_pool (id, api_key, status, success_calls, failed_calls, rate_limit_count, consecutive_errors, updated_at)
    VALUES (?, ?, 'ACTIVE', 1, 0, 0, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(api_key) DO UPDATE SET status = 'ACTIVE', consecutive_errors = 0, cooldown_until = NULL, updated_at = CURRENT_TIMESTAMP
  `);

  db.transaction(() => {
    for (const k of validKeys) {
      insertStmt.run(crypto.randomUUID(), k);
    }
    // Set active model to gemini-3.1-flash-lite in app_config
    db.prepare(`
      INSERT INTO app_config (key, value, updated_at) VALUES ('model', 'gemini-3.1-flash-lite', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = 'gemini-3.1-flash-lite', updated_at = CURRENT_TIMESTAMP
    `).run();
    db.prepare(`
      INSERT INTO app_config (key, value, updated_at) VALUES ('GEMINI_MODEL', 'gemini-3.1-flash-lite', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = 'gemini-3.1-flash-lite', updated_at = CURRENT_TIMESTAMP
    `).run();
  })();

  const count = db.prepare("SELECT COUNT(*) as c FROM api_key_pool WHERE status = 'ACTIVE'").get();
  console.log(`Database sync complete: ${count.c} active keys in pool, ${deletedCount} invalid keys removed.`);
  db.close();
}
