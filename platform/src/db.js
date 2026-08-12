/**
 * SQLite database layer for agent.mona.expert platform.
 * Uses sql.js (WebAssembly) — no native compilation needed.
 * Stores API keys, agent configs, and audit logs.
 */
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

let _db = null;
let _dbPath = null;

/**
 * Minimal sync-like wrapper around sql.js async.
 * SQL.js runs in WASM so we keep everything in memory and
 * periodically flush to disk.
 */
class SQLiteDB {
  constructor(sqlDb, dbPath) {
    this.sqlDb = sqlDb;
    this.dbPath = dbPath;
  }

  exec(sql) {
    this.sqlDb.exec(sql);
  }

  prepare(sql) {
    return {
      run: (...params) => {
        this.sqlDb.run(sql, params);
        return { changes: this.sqlDb.getRowsModified() };
      },
      get: (...params) => {
        const stmt = this.sqlDb.prepare(sql);
        try {
          stmt.bind(params);
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            stmt.free();
            return row;
          }
          stmt.free();
          return null;
        } catch (e) {
          stmt.free();
          throw e;
        }
      },
      all: (...params) => {
        const stmt = this.sqlDb.prepare(sql);
        try {
          stmt.bind(params);
          const rows = [];
          const cols = stmt.getColumnNames();
          while (stmt.step()) {
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            rows.push(row);
          }
          stmt.free();
          return rows;
        } catch (e) {
          stmt.free();
          throw e;
        }
      }
    };
  }

  pragma(pragma) {
    // sql.js doesn't support PRAGMA, silently skip
  }

  save() {
    const data = this.sqlDb.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }
}

export async function initDB(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  _dbPath = path.join(dataDir, 'platform.db');

  const SQL = await initSqlJs();

  // Try to load existing database
  let sqlDb;
  if (fs.existsSync(_dbPath)) {
    const buffer = fs.readFileSync(_dbPath);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }

  const db = new SQLiteDB(sqlDb, _dbPath);

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT,
      key_encrypted TEXT NOT NULL,
      created TEXT DEFAULT (datetime('now')),
      last_used TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT DEFAULT 'openai/gpt-4o',
      system_prompt TEXT DEFAULT '',
      tools TEXT DEFAULT '["files","web","shell"]',
      container_id TEXT,
      status TEXT DEFAULT 'stopped',
      port INTEGER,
      created TEXT DEFAULT (datetime('now')),
      last_active TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      data TEXT,
      agent_id TEXT
    );
  `);

  // Create indexes (silently fail if they already exist)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(type)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp)'); } catch {}

  db.save();

  console.log(`  DB: ${_dbPath}`);
  _db = db;
  return _db;
}

export function getDB() {
  if (!_db) throw new Error('DB not initialized. Call initDB() first.');
  return _db;
}

// Periodic auto-save
let saveInterval = null;
export function startAutoSave(ms = 30_000) {
  if (saveInterval) return;
  saveInterval = setInterval(() => {
    if (_db) _db.save();
  }, ms);
}

export function stopAutoSave() {
  if (saveInterval) {
    clearInterval(saveInterval);
    saveInterval = null;
  }
}
