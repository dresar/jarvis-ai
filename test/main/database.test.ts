import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'fs'
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

describe('Database DAO & Inspection Utilities Test Suite', () => {
  let db: Database.Database

  beforeEach(() => {
    // Instantiate isolated in-memory SQLite database
    db = new Database(':memory:')
    initializeSchema(db)
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  it('1. Schema Verification: all 6 tables and indexes are initialized correctly', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>

    const tableNames = tables.map((t) => t.name).sort()
    const expectedTables = [
      'api_key_pool',
      'app_config',
      'conversation_history',
      'execution_logs',
      'semantic_memory',
      'skills_metadata'
    ].sort()

    expect(tableNames).toEqual(expectedTables)

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>

    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_conversation_history_session_created')
    expect(indexNames).toContain('idx_api_key_pool_status')
    expect(indexNames).toContain('idx_execution_logs_timestamp')
    expect(indexNames).toContain('idx_semantic_memory_category')
    expect(indexNames).toContain('idx_skills_metadata_name')
  })

  it('2. Key masking & Basic Config/Chat/Tool DAO functions work', () => {
    // maskApiKey
    expect(maskApiKey('AQ.Ab8RN6KiddT5Lq8aGfuo41to3j25oN48Oi6DxP0mdL5lsVtflg')).toBe(
      'AQ.Ab8RN...tflg'
    )
    expect(maskApiKey('short')).toBe('***')
    expect(maskApiKey('')).toBe('***')
    expect(maskApiKey(123456789012345 as any)).toBe('***')
    expect(maskApiKey(null as any)).toBe('***')
    expect(maskApiKey(undefined as any)).toBe('***')
    expect(maskApiKey({ key: 'test' } as any)).toBe('***')

    // App Config DAO
    setConfig('theme', 'dark', db)
    expect(getConfig('theme', db)).toBe('dark')
    deleteConfig('theme', db)
    expect(getConfig('theme', db)).toBeNull()

    // Chat History DAO
    saveChatMessage('msg-1', 'user', 'Hello Jarvis', 'default', db)
    saveChatMessage('msg-2', 'model', 'Hello User', 'default', db)
    const history = getChatHistory(10, 'default', db)
    expect(history.length).toBe(2)
    expect(history[0].role).toBe('user')
    expect(history[1].role).toBe('model')
    clearChatHistory('default', db)
    expect(getChatHistory(10, 'default', db).length).toBe(0)

    // Log Tool Call DAO
    logToolCall('log-1', 'get_weather', '{"city":"Jakarta"}', '{"temp":28}', db)
    const execLogs = getExecutionLogs({}, db)
    expect(execLogs.totalCount).toBe(1)
    expect(execLogs.logs[0].toolName).toBe('get_weather')
  })

  it('3. getApiKeyPoolStatus returns correct aggregations and masked keys', () => {
    db.prepare(
      `INSERT INTO api_key_pool (id, api_key, status, success_calls, failed_calls, rate_limit_count) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('key-1', 'AQ.Ab8RN6KiddT5Lq8aGfuo41to3j25oN48Oi6DxP0mdL5lsVtflg', 'ACTIVE', 10, 1, 0)
    db.prepare(
      `INSERT INTO api_key_pool (id, api_key, status, success_calls, failed_calls, rate_limit_count) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('key-2', 'AQ.Ab8RN6L7zg7UX9ZhecSqyec5-0JVUmely0q5YxWCuwbfFly5EQ', 'COOLDOWN', 5, 2, 3)

    db.prepare(
      `INSERT INTO execution_logs (id, key_id, model, status, latency_ms) VALUES (?, ?, ?, ?, ?)`
    ).run('log-1', 'key-1', 'gemini-2.5-flash', 'SUCCESS', 200)
    db.prepare(
      `INSERT INTO execution_logs (id, key_id, model, status, latency_ms) VALUES (?, ?, ?, ?, ?)`
    ).run('log-2', 'key-2', 'gemini-2.5-flash', 'SUCCESS', 400)

    const status = getApiKeyPoolStatus(db)

    expect(status.totalKeys).toBe(2)
    expect(status.activeKeys).toBe(1)
    expect(status.cooldownKeys).toBe(1)
    expect(status.totalSuccessCalls).toBe(15)
    expect(status.totalFailedCalls).toBe(3)
    expect(status.totalRateLimitCount).toBe(3)
    expect(status.averageLatencyMs).toBe(300)
    expect(status.keyDetails.length).toBe(2)
    expect(status.keyDetails[0].maskedKey).toContain('...')
  })

  it('4. getExecutionLogs filters logs by status, model, keyId and pagination', () => {
    db.prepare(`INSERT INTO api_key_pool (id, api_key, status) VALUES ('key-0', 'key0_key_string_001', 'ACTIVE')`).run()
    db.prepare(`INSERT INTO api_key_pool (id, api_key, status) VALUES ('key-1', 'key1_key_string_002', 'ACTIVE')`).run()

    for (let i = 1; i <= 15; i++) {
      db.prepare(
        `INSERT INTO execution_logs (id, key_id, model, status, latency_ms, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        `log-${i}`,
        `key-${i % 2}`,
        i % 2 === 0 ? 'gemini-2.5-flash' : 'gemini-2.5-pro',
        i % 3 === 0 ? 'RATE_LIMITED' : 'SUCCESS',
        100 + i,
        `2026-08-14T00:00:${i < 10 ? '0' + i : i}Z`
      )
    }

    const filtered = getExecutionLogs(
      { status: 'RATE_LIMITED', limit: 10, offset: 0 },
      db
    )

    expect(filtered.totalCount).toBe(5)
    expect(filtered.logs.length).toBe(5)
    expect(filtered.logs[0].status).toBe('RATE_LIMITED')

    const paginated = getExecutionLogs({ limit: 5, offset: 5 }, db)
    expect(paginated.logs.length).toBe(5)
    expect(paginated.totalCount).toBe(15)

    const modelFiltered = getExecutionLogs({ model: 'gemini-2.5-flash' }, db)
    expect(modelFiltered.logs.every((l) => l.model === 'gemini-2.5-flash')).toBe(true)
  })

  it('5. searchSemanticMemory ranks by cosine vector similarity and supports text fallback', () => {
    // Math similarity check
    expect(calculateCosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(calculateCosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(calculateCosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(calculateCosineSimilarity([NaN, 1], [1, 1])).toBe(0)
    expect(calculateCosineSimilarity([1, 1], [NaN, 1])).toBe(0)
    expect(calculateCosineSimilarity([Infinity, 1], [1, 1])).toBe(0)
    expect(calculateCosineSimilarity('not-an-array' as any, [1, 1])).toBe(0)
    expect(calculateCosineSimilarity([1, 1], null as any)).toBe(0)

    const vec1 = [1.0, 0.0, 0.0]
    const vec2 = [0.0, 1.0, 0.0]

    db.prepare(
      `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
    ).run('mem-1', 'User prefers dark mode UI', 'preference', JSON.stringify(vec1))
    db.prepare(
      `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
    ).run('mem-2', 'User lives in Jakarta', 'fact', JSON.stringify(vec2))

    // Vector Similarity Mode
    const queryVec = [0.9, 0.1, 0.0]
    const vecResults = searchSemanticMemory(undefined, undefined, 10, queryVec, db)

    expect(vecResults.length).toBe(2)
    expect(vecResults[0].id).toBe('mem-1')
    expect(vecResults[0].similarityScore!).toBeGreaterThan(0.8)

    // Text Fallback Mode
    const textResults = searchSemanticMemory('Jakarta', undefined, 10, undefined, db)
    expect(textResults.length).toBe(1)
    expect(textResults[0].id).toBe('mem-2')
  })

  it('6. getSkillsMetadata calculates skill success rates accurately', () => {
    db.prepare(
      `INSERT INTO skills_metadata (skill_id, name, file_path, success_count, failure_count, average_execution_time_ms) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sk-1', 'web_scraper', './skills/web_scraper.py', 80, 20, 150.5)

    const report = getSkillsMetadata(db)

    expect(report.totalSkills).toBe(1)
    expect(report.totalExecutions).toBe(100)
    expect(report.overallSuccessRate).toBe(80)
    expect(report.skills[0].successRate).toBe(80)
    expect(report.skills[0].averageExecutionTimeMs).toBe(151)
  })

  it('7. executeRawInspectionQuery allows SELECT/EXPLAIN/PRAGMA and blocks SQL mutation & multi-statement attacks', () => {
    db.prepare(`INSERT INTO app_config (key, value) VALUES ('theme', 'dark')`).run()

    // Valid SELECT
    const selectResult = executeRawInspectionQuery('SELECT * FROM app_config', db)
    expect(selectResult.success).toBe(true)
    expect(selectResult.rowCount).toBe(1)
    expect(selectResult.rows[0].value).toBe('dark')

    // Valid SELECT with single trailing semicolon
    const selectResultSemi = executeRawInspectionQuery('SELECT * FROM app_config;', db)
    expect(selectResultSemi.success).toBe(true)
    expect(selectResultSemi.rowCount).toBe(1)

    // Valid PRAGMA
    const pragmaResult = executeRawInspectionQuery('PRAGMA table_info(app_config)', db)
    expect(pragmaResult.success).toBe(true)

    // Valid EXPLAIN
    const explainResult = executeRawInspectionQuery('EXPLAIN QUERY PLAN SELECT * FROM app_config', db)
    expect(explainResult.success).toBe(true)

    // Blocked DROP
    const dropResult = executeRawInspectionQuery('DROP TABLE app_config', db)
    expect(dropResult.success).toBe(false)
    expect(dropResult.error).toContain('Security Error')

    // Blocked DELETE
    const deleteResult = executeRawInspectionQuery('DELETE FROM app_config', db)
    expect(deleteResult.success).toBe(false)
    expect(deleteResult.error).toContain('Security Error')

    // Blocked UPDATE
    const updateResult = executeRawInspectionQuery("UPDATE app_config SET value='light'", db)
    expect(updateResult.success).toBe(false)
    expect(updateResult.error).toContain('Security Error')

    // Blocked INSERT
    const insertResult = executeRawInspectionQuery("INSERT INTO app_config VALUES ('a', 'b', NULL)", db)
    expect(insertResult.success).toBe(false)
    expect(insertResult.error).toContain('Security Error')

    // Blocked REPLACE
    const replaceResult = executeRawInspectionQuery("REPLACE INTO app_config (key, value) VALUES ('k', 'v')", db)
    expect(replaceResult.success).toBe(false)
    expect(replaceResult.error).toContain('Security Error')

    // Blocked PRAGMA mutation
    const pragmaMutateResult = executeRawInspectionQuery('PRAGMA foreign_keys = OFF', db)
    expect(pragmaMutateResult.success).toBe(false)
    expect(pragmaMutateResult.error).toContain('Security Error')

    // CTE WITH query limit injection & leading comment normalization
    const insertMany = db.transaction(() => {
      const insertStmt = db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)`)
      for (let i = 1; i <= 505; i++) {
        insertStmt.run(`key-${i}`, `val-${i}`)
      }
    })
    insertMany()
    const cteResult = executeRawInspectionQuery(
      '/* comment */ WITH cte AS (SELECT * FROM app_config) SELECT * FROM cte',
      db
    )
    expect(cteResult.success).toBe(true)
    expect(cteResult.rowCount).toBe(500)

    // Blocked Multi-Statement
    const multiResult = executeRawInspectionQuery(
      'SELECT 1; DROP TABLE app_config;',
      db
    )
    expect(multiResult.success).toBe(false)
    expect(multiResult.error).toContain('Multi-statement')
  })

  it('8. getDatabaseOverallStats returns correct counts across 6 tables', () => {
    db.prepare(`INSERT INTO app_config (key, value) VALUES ('k1', 'v1')`).run()
    db.prepare(`INSERT INTO conversation_history (message_id, role, content) VALUES ('m1', 'user', 'hi')`).run()

    const stats = getDatabaseOverallStats(db)
    expect(stats['app_config']).toBe(1)
    expect(stats['conversation_history']).toBe(1)
    expect(stats['api_key_pool']).toBe(0)
    expect(stats['execution_logs']).toBe(0)
    expect(stats['semantic_memory']).toBe(0)
    expect(stats['skills_metadata']).toBe(0)
  })

  it('9. migrateLegacyDatabase automatically migrates legacy jarvis.db tables to new schema', () => {
    const testDir = join(tmpdir(), `jarvis-test-mig-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })

    const legacyPath = join(testDir, 'jarvis.db')
    const targetPath = join(testDir, 'jarvis_memory.db')

    // 1. Create Legacy Database
    const legacyDb = new Database(legacyPath)
    legacyDb.exec(`
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME);
      INSERT INTO app_config (key, value, updated_at) VALUES ('legacy_key', 'legacy_val', '2026-01-01');

      CREATE TABLE conversation_history (message_id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at DATETIME);
      INSERT INTO conversation_history (message_id, role, content, created_at) VALUES ('legacy-m1', 'user', 'legacy msg', '2026-01-01');

      CREATE TABLE tool_logs (log_id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, parameters TEXT, result TEXT, timestamp DATETIME);
      INSERT INTO tool_logs (log_id, tool_name, parameters, result, timestamp) VALUES ('legacy-l1', 'old_tool', '{}', '{}', '2026-01-01');
    `)
    legacyDb.close()

    // 2. Create Target Database & Run Migration
    const targetDb = new Database(targetPath)
    initializeSchema(targetDb)
    migrateLegacyDatabase(targetDb, legacyPath)

    // 3. Verify Target DB Content
    const configVal = getConfig('legacy_key', targetDb)
    expect(configVal).toBe('legacy_val')

    const chatHist = getChatHistory(10, 'default', targetDb)
    expect(chatHist.length).toBe(1)
    expect(chatHist[0].content).toBe('legacy msg')

    const logs = getExecutionLogs({}, targetDb)
    expect(logs.totalCount).toBe(1)
    expect(logs.logs[0].toolName).toBe('old_tool')

    targetDb.close()

    // 4. Verify Legacy DB file was renamed to jarvis.db.bak
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(`${legacyPath}.bak`)).toBe(true)

    // Cleanup temp dir
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('10. migrateLegacyDatabase ensures legacyDb handle is closed in finally block even on error', () => {
    const testDir = join(tmpdir(), `jarvis-test-mig-err-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })

    const legacyPath = join(testDir, 'jarvis.db')
    const targetPath = join(testDir, 'jarvis_memory.db')

    // Create Legacy Database
    const legacyDb = new Database(legacyPath)
    legacyDb.exec(`
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME);
      INSERT INTO app_config (key, value, updated_at) VALUES ('k1', 'v1', '2026-01-01');
    `)
    legacyDb.close()

    // Pass closed targetDb to trigger error inside transaction
    const targetDb = new Database(targetPath)
    targetDb.close()

    // migrateLegacyDatabase catches error and closes legacyDb in finally block
    expect(() => migrateLegacyDatabase(targetDb, legacyPath)).not.toThrow()

    // legacyDb should be closed, so unlinking legacyPath succeeds without Windows file lock (EBUSY) error
    expect(() => unlinkSync(legacyPath)).not.toThrow()

    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })
})
