import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import {
  initializeSchema,
  migrateLegacyDatabase,
  getApiKeyPoolStatus,
  getExecutionLogs,
  searchSemanticMemory,
  getSkillsMetadata,
  executeRawInspectionQuery,
  getDatabaseOverallStats,
  calculateCosineSimilarity,
  maskApiKey,
  getConfig,
  setConfig,
  deleteConfig,
  getChatHistory,
  saveChatMessage,
  clearChatHistory,
  logToolCall
} from '../../src/main/database'

describe('Adversarial Stress & Edge Case Test Suite', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initializeSchema(db)
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 1. SQL Injection & Bypass Attempts on executeRawInspectionQuery
  // ───────────────────────────────────────────────────────────────────────────
  describe('1. SQL Injection & Security Bypass Attempts', () => {
    it('blocks case-manipulation DDL and mutation keywords', () => {
      const payloads = [
        'dRoP tAbLe app_config',
        'InSeRt InTo app_config VALUES ("k", "v")',
        'uPdAtE app_config SET value="hack"',
        'dElEtE fRoM app_config',
        'aLtEr TABLE app_config ADD COLUMN foo TEXT',
        'cReAtE TABLE evil (id INT)',
        'vAcUuM',
        'rEiNdEx',
        'tRuNcAtE',
        'aTtAcH DATABASE "evil.db" AS evil',
        'dEtAcH DATABASE evil'
      ]

      for (const payload of payloads) {
        const res = executeRawInspectionQuery(payload, db)
        expect(res.success, `Payload "${payload}" should be blocked`).toBe(false)
        expect(res.error).toContain('Security Error')
      }
    })

    it('blocks multi-statement queries with various delimiters and comments', () => {
      const payloads = [
        'SELECT 1; DROP TABLE app_config',
        'SELECT 1; SELECT 2',
        'SELECT 1; -- comment\nDELETE FROM app_config',
        'SELECT 1/*comment*/; DROP TABLE app_config',
        'SELECT 1; UPDATE app_config SET value = "x"'
      ]

      for (const payload of payloads) {
        const res = executeRawInspectionQuery(payload, db)
        expect(res.success, `Multi-statement payload "${payload}" should be blocked`).toBe(false)
      }
    })

    it('handles query comments and whitespace variations safely', () => {
      // Inline comments breaking standard tokens
      const commentPayload = 'SELECT/*comment*/ * FROM app_config'
      const res = executeRawInspectionQuery(commentPayload, db)
      expect(res.success).toBe(true)

      // Comment attempting to disguise DROP
      const disguisedDrop = '/* SELECT * FROM app_config */ DROP TABLE app_config'
      const dropRes = executeRawInspectionQuery(disguisedDrop, db)
      expect(dropRes.success).toBe(false)
      expect(dropRes.error).toContain('Security Error')
    })

    it('handles UNION SELECT queries safely within read-only scope', () => {
      db.prepare(`INSERT INTO app_config (key, value) VALUES ('k1', 'v1')`).run()
      db.prepare(`INSERT INTO api_key_pool (id, api_key, status) VALUES ('id1', 'secret-key-1234567890', 'ACTIVE')`).run()

      const unionQuery = 'SELECT key AS col1, value AS col2 FROM app_config UNION SELECT id, api_key FROM api_key_pool'
      const res = executeRawInspectionQuery(unionQuery, db)
      expect(res.success).toBe(true)
      expect(res.rowCount).toBe(2)
    })

    it('enforces LIMIT 500 automatically on unlimited SELECT queries', () => {
      // Seed 600 rows in conversation_history
      const stmt = db.prepare(`INSERT INTO conversation_history (message_id, role, content) VALUES (?, 'user', 'msg')`)
      for (let i = 0; i < 600; i++) {
        stmt.run(`m-${i}`)
      }

      const res = executeRawInspectionQuery('SELECT * FROM conversation_history', db)
      expect(res.success).toBe(true)
      expect(res.rowCount).toBe(500)
    })

    it('respects existing explicit LIMIT less than or greater than 500', () => {
      const stmt = db.prepare(`INSERT INTO conversation_history (message_id, role, content) VALUES (?, 'user', 'msg')`)
      for (let i = 0; i < 50; i++) {
        stmt.run(`m-${i}`)
      }

      const res = executeRawInspectionQuery('SELECT * FROM conversation_history LIMIT 10', db)
      expect(res.success).toBe(true)
      expect(res.rowCount).toBe(10)
    })

    it('allows valid PRAGMA and EXPLAIN queries', () => {
      const pragmaRes = executeRawInspectionQuery('PRAGMA table_info(app_config)', db)
      expect(pragmaRes.success).toBe(true)

      const explainRes = executeRawInspectionQuery('EXPLAIN QUERY PLAN SELECT * FROM app_config', db)
      expect(explainRes.success).toBe(true)
    })

    it('handles empty query and whitespace-only queries gracefully', () => {
      expect(executeRawInspectionQuery('', db).success).toBe(false)
      expect(executeRawInspectionQuery('   ', db).success).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. High Concurrency & Lock Stress Testing
  // ───────────────────────────────────────────────────────────────────────────
  describe('2. High Concurrency & Lock Stress Testing', () => {
    it('handles 200 rapid parallel writes and reads without locking errors', async () => {
      const operations: Promise<void>[] = []

      for (let i = 0; i < 100; i++) {
        operations.push(
          new Promise((resolve) => {
            setConfig(`concurrent_key_${i}`, `value_${i}`, db)
            saveChatMessage(`c_msg_${i}`, 'user', `Concurrent content ${i}`, 'session_conc', db)
            logToolCall(`c_log_${i}`, 'tool_conc', JSON.stringify({ i }), 'result_ok', db)
            resolve()
          })
        )
      }

      await Promise.all(operations)

      const history = getChatHistory(200, 'session_conc', db)
      expect(history.length).toBe(100)

      const stats = getDatabaseOverallStats(db)
      expect(stats['app_config']).toBeGreaterThanOrEqual(100)
      expect(stats['execution_logs']).toBe(100)
    })

    it('handles rapid atomic transaction updates concurrently', () => {
      const transactionFn = db.transaction((batchId: number) => {
        for (let j = 0; j < 10; j++) {
          setConfig(`batch_${batchId}_key_${j}`, `val_${j}`, db)
        }
      })

      for (let i = 0; i < 20; i++) {
        transactionFn(i)
      }

      const countRow = db.prepare("SELECT COUNT(*) as count FROM app_config WHERE key LIKE 'batch_%'").get() as any
      expect(countRow.count).toBe(200)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Legacy Migration Edge Cases
  // ───────────────────────────────────────────────────────────────────────────
  describe('3. Legacy Migration Edge Cases', () => {
    let testDir: string

    beforeEach(() => {
      testDir = join(tmpdir(), `jarvis-mig-stress-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`)
      mkdirSync(testDir, { recursive: true })
    })

    afterEach(() => {
      try {
        if (existsSync(testDir)) {
          rmSync(testDir, { recursive: true, force: true })
        }
      } catch {
        // ignore cleanup error
      }
    })

    it('gracefully handles corrupted/non-SQLite legacy database file without crashing', () => {
      const legacyPath = join(testDir, 'jarvis.db')
      const targetPath = join(testDir, 'jarvis_memory.db')

      // Write garbage binary data
      writeFileSync(legacyPath, Buffer.from('NOT A SQLITE FILE HELLO WORLD GARBAGE DATA 1234567890'))

      const targetDb = new Database(targetPath)
      initializeSchema(targetDb)

      // Should not throw unhandled exception
      expect(() => migrateLegacyDatabase(targetDb, legacyPath)).not.toThrow()
      targetDb.close()
    })

    it('handles legacy database with missing tables or extra columns gracefully', () => {
      const legacyPath = join(testDir, 'jarvis.db')
      const targetPath = join(testDir, 'jarvis_memory.db')

      // Legacy DB with only app_config (missing conversation_history and tool_logs)
      const legacyDb = new Database(legacyPath)
      legacyDb.exec(`
        CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME, extra_col TEXT);
        INSERT INTO app_config VALUES ('k_partial', 'v_partial', '2026-01-01', 'extra_data');
      `)
      legacyDb.close()

      const targetDb = new Database(targetPath)
      initializeSchema(targetDb)

      migrateLegacyDatabase(targetDb, legacyPath)

      expect(getConfig('k_partial', targetDb)).toBe('v_partial')
      expect(getChatHistory(10, 'default', targetDb).length).toBe(0)

      targetDb.close()
    })

    it('handles duplicate primary key conflicts during legacy migration (INSERT OR IGNORE/REPLACE)', () => {
      const legacyPath = join(testDir, 'jarvis.db')
      const targetPath = join(testDir, 'jarvis_memory.db')

      const legacyDb = new Database(legacyPath)
      legacyDb.exec(`
        CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME);
        INSERT INTO app_config VALUES ('theme', 'legacy_light', '2026-01-01');

        CREATE TABLE conversation_history (message_id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME);
        INSERT INTO conversation_history VALUES ('msg-dup', 'user', 'legacy content', '2026-01-01');
      `)
      legacyDb.close()

      const targetDb = new Database(targetPath)
      initializeSchema(targetDb)

      // Pre-populate targetDb with duplicate key
      setConfig('theme', 'existing_dark', targetDb)
      saveChatMessage('msg-dup', 'user', 'existing content', 'default', targetDb)

      // Run migration
      migrateLegacyDatabase(targetDb, legacyPath)

      // Config uses INSERT OR REPLACE (legacy updates config)
      expect(getConfig('theme', targetDb)).toBe('legacy_light')

      // Conversation history uses INSERT OR IGNORE (existing preserved)
      const history = getChatHistory(10, 'default', targetDb)
      expect(history.length).toBe(1)
      expect(history[0].content).toBe('existing content')

      targetDb.close()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Malformed Data Inputs & Boundary Testing
  // ───────────────────────────────────────────────────────────────────────────
  describe('4. Malformed Data Inputs & Boundary Testing', () => {
    it('handles extremely large text strings (1MB+) in saveChatMessage and setConfig', () => {
      const hugeBlob = 'A'.repeat(1 * 1024 * 1024) // 1MB string

      expect(() => setConfig('huge_config', hugeBlob, db)).not.toThrow()
      expect(getConfig('huge_config', db)).toBe(hugeBlob)

      expect(() => saveChatMessage('huge_msg_1', 'user', hugeBlob, 'default', db)).not.toThrow()
      const history = getChatHistory(1, 'default', db)
      expect(history[0].content.length).toBe(1 * 1024 * 1024)
    })

    it('handles null bytes, unicode control chars, and SQL metacharacters safely', () => {
      const trickyString = "O'Connor \0 \u0000 '; DROP TABLE app_config; -- \" \" \\ \n \r \t <script>alert(1)</script>"

      setConfig(trickyString, trickyString, db)
      expect(getConfig(trickyString, db)).toBe(trickyString)

      saveChatMessage('tricky_msg_1', 'user', trickyString, 'default', db)
      const history = getChatHistory(1, 'default', db)
      expect(history[0].content).toBe(trickyString)
    })

    it('handles out-of-bounds, negative, or invalid filter options in getExecutionLogs', () => {
      db.prepare(`INSERT INTO execution_logs (id, model, status) VALUES ('l1', 'm1', 'SUCCESS')`).run()

      // Negative limit / offset defaults to fallback limit (50) and offset (0)
      const resNeg = getExecutionLogs({ limit: -10, offset: -5 }, db)
      expect(resNeg.logs.length).toBe(1)

      // Huge limit is capped at 200
      const resHuge = getExecutionLogs({ limit: 99999 }, db)
      expect(resHuge.limit).toBe(200)

      // SQL injection in filter fields
      const resInj = getExecutionLogs({ status: "SUCCESS' OR '1'='1" as any, model: "'; DROP TABLE app_config; --" }, db)
      expect(resInj.logs.length).toBe(0)
    })

    it('handles malformed JSON embedding strings in searchSemanticMemory gracefully', () => {
      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('bad-mem-1', 'Corrupted vector record', 'test', 'INVALID_JSON_CORRUPTED_VECTOR')

      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('good-mem-1', 'Valid vector record', 'test', JSON.stringify([1.0, 0.0]))

      const results = searchSemanticMemory(undefined, undefined, 10, [1.0, 0.0], db)
      expect(results.length).toBe(2)
      // Corrupted record falls back to similarityScore = 0
      const badRec = results.find((r) => r.id === 'bad-mem-1')
      expect(badRec?.similarityScore).toBe(0)
      expect(results[0].id).toBe('good-mem-1')
    })

    it('handles zero-length or mismatched dimension arrays in calculateCosineSimilarity', () => {
      expect(calculateCosineSimilarity([], [])).toBe(0)
      expect(calculateCosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
      expect(calculateCosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0)
    })
  })
})
