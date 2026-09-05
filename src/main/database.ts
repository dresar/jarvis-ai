import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, renameSync } from 'fs'

function getDbPaths() {
  let userData: string
  try {
    userData = app?.getPath ? app.getPath('userData') : ''
  } catch {
    userData = ''
  }
  if (!userData) {
    userData = process.env.APPDATA ? join(process.env.APPDATA, 'jarvis') : process.cwd()
  }

  const dbDir = join(userData, 'jarvis-data')
  const dbPath = join(dbDir, 'jarvis_memory.db')
  const legacyDbPath = join(dbDir, 'jarvis.db')
  return { dbDir, dbPath, legacyDbPath }
}

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    const { dbDir, dbPath, legacyDbPath } = getDbPaths()
    mkdirSync(dbDir, { recursive: true })
    const isNewDb = !existsSync(dbPath)
    db = new Database(dbPath)

    // Performance & Integrity Pragmas
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    initializeSchema(db)

    if (isNewDb && existsSync(legacyDbPath)) {
      migrateLegacyDatabase(db, legacyDbPath)
    }
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * Initializes exact DDL SQL schema for the 6 core tables and performance indexes.
 */
export function initializeSchema(database: Database.Database): void {
  database.exec(`
    -- 1. App Configuration Table
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Conversation History Table
    CREATE TABLE IF NOT EXISTS conversation_history (
      message_id TEXT PRIMARY KEY,
      session_id TEXT DEFAULT 'default',
      role TEXT NOT NULL CHECK(role IN ('user', 'model', 'system')),
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_history_session_created 
      ON conversation_history(session_id, created_at DESC);

    -- 3. Gemini API Key Pool Table
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
    CREATE INDEX IF NOT EXISTS idx_api_key_pool_status ON api_key_pool(status);
    CREATE INDEX IF NOT EXISTS idx_api_key_pool_last_used ON api_key_pool(last_used_at);

    -- 4. Unified Execution Logs Table (Key Rotations, Tool Calls & Auto-Debugging Logs)
    CREATE TABLE IF NOT EXISTS execution_logs (
      id TEXT PRIMARY KEY,
      key_id TEXT,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('SUCCESS', 'RATE_LIMITED', 'INVALID_KEY', 'ERROR')),
      error_message TEXT,
      latency_ms INTEGER DEFAULT 0,
      tool_name TEXT,
      parameters TEXT,
      result TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (key_id) REFERENCES api_key_pool(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_logs_timestamp ON execution_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_execution_logs_key_id ON execution_logs(key_id);
    CREATE INDEX IF NOT EXISTS idx_execution_logs_status ON execution_logs(status);

    -- 5. Semantic Long-Term Memory (RAG Vector Embeddings)
    CREATE TABLE IF NOT EXISTS semantic_memory (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      embedding TEXT NOT NULL,
      source TEXT DEFAULT 'user_chat',
      tags TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_category ON semantic_memory(category);
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_source ON semantic_memory(source);
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_created ON semantic_memory(created_at DESC);

    -- 6. Procedural Memory Skills Metadata
    CREATE TABLE IF NOT EXISTS skills_metadata (
      skill_id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      file_path TEXT NOT NULL,
      entrypoint TEXT DEFAULT 'run',
      version TEXT DEFAULT '1.0.0',
      parameters_schema TEXT,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      average_execution_time_ms REAL DEFAULT 0.0,
      last_executed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_skills_metadata_name ON skills_metadata(name);
    CREATE INDEX IF NOT EXISTS idx_skills_metadata_last_executed ON skills_metadata(last_executed_at DESC);
  `)
}

/**
 * Handles automatic migration from existing jarvis.db if present.
 */
export function migrateLegacyDatabase(targetDb: Database.Database, legacyPath: string): void {
  let legacyDb: Database.Database | null = null
  try {
    console.log(`[Database] Found legacy database at ${legacyPath}. Starting automatic migration...`)
    legacyDb = new Database(legacyPath, { readonly: true })

    try {
      targetDb.transaction(() => {
        // 1. Migrate app_config
        try {
          const configs = legacyDb!.prepare('SELECT key, value, updated_at FROM app_config').all() as any[]
          const insertConfig = targetDb.prepare(`
            INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
          `)
          for (const c of configs) {
            insertConfig.run(c.key, c.value, c.updated_at)
          }
          console.log(`[Database Migration] Migrated ${configs.length} app_config entries.`)
        } catch (err: any) {
          console.warn('[Database Migration] app_config migration notice:', err.message)
        }

        // 2. Migrate conversation_history
        try {
          const messages = legacyDb!.prepare('SELECT message_id, role, content, created_at FROM conversation_history').all() as any[]
          const insertMsg = targetDb.prepare(`
            INSERT OR IGNORE INTO conversation_history (message_id, session_id, role, content, created_at)
            VALUES (?, 'default', ?, ?, ?)
          `)
          for (const m of messages) {
            insertMsg.run(m.message_id, m.role, m.content, m.created_at)
          }
          console.log(`[Database Migration] Migrated ${messages.length} conversation_history entries.`)
        } catch (err: any) {
          console.warn('[Database Migration] conversation_history migration notice:', err.message)
        }

        // 3. Migrate tool_logs to execution_logs
        try {
          const toolLogs = legacyDb!.prepare('SELECT log_id, tool_name, parameters, result, timestamp FROM tool_logs').all() as any[]
          const insertLog = targetDb.prepare(`
            INSERT OR IGNORE INTO execution_logs (id, key_id, model, status, error_message, latency_ms, tool_name, parameters, result, timestamp)
            VALUES (?, NULL, 'system_tool', 'SUCCESS', NULL, 0, ?, ?, ?, ?)
          `)
          for (const l of toolLogs) {
            insertLog.run(l.log_id, l.tool_name, l.parameters, l.result, l.timestamp)
          }
          console.log(`[Database Migration] Migrated ${toolLogs.length} legacy tool_logs into execution_logs.`)
        } catch (err: any) {
          console.warn('[Database Migration] tool_logs migration notice:', err.message)
        }
      })()
    } finally {
      if (legacyDb) {
        legacyDb.close()
      }
    }

    // Backup legacy file to avoid re-migration
    const backupPath = `${legacyPath}.bak`
    renameSync(legacyPath, backupPath)
    console.log(`[Database Migration] Legacy database backed up to ${backupPath}. Migration successful.`)
  } catch (error: any) {
    console.error('[Database Migration] Migration failed:', error.message)
  }
}

// ─────────────────────────────────────────
// Interfaces & Types
// ─────────────────────────────────────────

export interface KeyPoolStatusReport {
  totalKeys: number
  activeKeys: number
  cooldownKeys: number
  disabledKeys: number
  totalSuccessCalls: number
  totalFailedCalls: number
  totalRateLimitCount: number
  averageLatencyMs: number
  keyDetails: Array<{
    id: string
    maskedKey: string
    status: 'ACTIVE' | 'COOLDOWN' | 'DISABLED'
    lastUsedAt: number | null
    cooldownUntil: number | null
    successCalls: number
    failedCalls: number
    rateLimitCount: number
    consecutiveErrors: number
  }>
}

export interface ExecutionLogFilter {
  limit?: number
  offset?: number
  status?: 'SUCCESS' | 'RATE_LIMITED' | 'INVALID_KEY' | 'ERROR'
  keyId?: string
  model?: string
  startDate?: string
  endDate?: string
}

export interface ExecutionLogResult {
  logs: Array<{
    id: string
    keyId: string | null
    model: string
    status: 'SUCCESS' | 'RATE_LIMITED' | 'INVALID_KEY' | 'ERROR'
    errorMessage: string | null
    latencyMs: number | null
    timestamp: string
    toolName?: string | null
    parameters?: string | null
    result?: string | null
  }>
  totalCount: number
  limit: number
  offset: number
}

export interface SemanticSearchResult {
  id: string
  content: string
  category?: string
  metadata: Record<string, any> | null
  similarityScore?: number
  createdAt: string
  updatedAt: string
}

export interface SkillMetadataRow {
  skillId: string
  name: string
  description: string | null
  filePath: string
  entrypoint: string
  version: string
  parametersSchema?: string
  parameters_schema?: string
  successCount: number
  failureCount: number
  successRate: number
  averageExecutionTimeMs: number
  lastExecutedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SkillsMetadataReport {
  totalSkills: number
  totalExecutions: number
  overallSuccessRate: number
  skills: SkillMetadataRow[]
}

export interface RawQueryResult {
  success: boolean
  columns: string[]
  rows: Record<string, any>[]
  rowCount: number
  executionTimeMs: number
  error?: string
}

// ─────────────────────────────────────────
// Core DAO Functions & Utilities
// ─────────────────────────────────────────

export function maskApiKey(key: string): string {
  if (typeof key !== 'string' || !key || key.length <= 12) return '***'
  return `${key.slice(0, 8)}...${key.slice(-4)}`
}

export function getConfig(key: string, customDb?: Database.Database): string | null {
  const dbInstance = customDb || getDatabase()
  const row = dbInstance.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setConfig(key: string, value: string, customDb?: Database.Database): void {
  const dbInstance = customDb || getDatabase()
  dbInstance
    .prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    )
    .run(key, value)
}

export function deleteConfig(key: string, customDb?: Database.Database): void {
  const dbInstance = customDb || getDatabase()
  dbInstance.prepare('DELETE FROM app_config WHERE key = ?').run(key)
}

export function getChatHistory(
  limit = 20,
  sessionId = 'default',
  customDb?: Database.Database
): Array<{ role: string; content: string }> {
  const dbInstance = customDb || getDatabase()
  const rows = dbInstance
    .prepare(
      `SELECT role, content FROM conversation_history
       WHERE session_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(sessionId, limit) as Array<{ role: string; content: string }>
  return rows.reverse()
}

export function saveChatMessage(
  messageId: string,
  role: 'user' | 'model' | 'system',
  content: string,
  sessionId = 'default',
  customDb?: Database.Database
): void {
  const dbInstance = customDb || getDatabase()
  dbInstance
    .prepare(
      `INSERT OR IGNORE INTO conversation_history (message_id, session_id, role, content)
       VALUES (?, ?, ?, ?)`
    )
    .run(messageId, sessionId, role, content)
}

export function clearChatHistory(sessionId = 'default', customDb?: Database.Database): void {
  const dbInstance = customDb || getDatabase()
  dbInstance.prepare('DELETE FROM conversation_history WHERE session_id = ?').run(sessionId)
}

export function logToolCall(
  logId: string,
  toolName: string,
  parameters: string,
  result: string,
  customDb?: Database.Database
): void {
  const dbInstance = customDb || getDatabase()
  dbInstance
    .prepare(
      `INSERT INTO execution_logs (id, key_id, model, status, error_message, latency_ms, tool_name, parameters, result)
       VALUES (?, NULL, 'system_tool', 'SUCCESS', NULL, 0, ?, ?, ?)`
    )
    .run(logId, toolName, parameters, result)
}

export function getApiKeyPoolStatus(customDb?: Database.Database): KeyPoolStatusReport {
  const dbInstance = customDb || getDatabase()

  const metrics = dbInstance
    .prepare(
      `SELECT 
        COUNT(*) as total_keys,
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_keys,
        SUM(CASE WHEN status = 'COOLDOWN' THEN 1 ELSE 0 END) as cooldown_keys,
        SUM(CASE WHEN status = 'DISABLED' THEN 1 ELSE 0 END) as disabled_keys,
        COALESCE(SUM(success_calls), 0) as total_success_calls,
        COALESCE(SUM(failed_calls), 0) as total_failed_calls,
        COALESCE(SUM(rate_limit_count), 0) as total_rate_limit_count
      FROM api_key_pool`
    )
    .get() as any

  const avgLatencyRow = dbInstance
    .prepare(
      `SELECT AVG(latency_ms) as avg_latency FROM execution_logs WHERE status = 'SUCCESS' AND latency_ms IS NOT NULL AND latency_ms > 0`
    )
    .get() as any

  const keys = dbInstance
    .prepare(
      `SELECT id, api_key, status, last_used_at, cooldown_until, success_calls, failed_calls, rate_limit_count, consecutive_errors
       FROM api_key_pool
       ORDER BY last_used_at DESC NULLS LAST`
    )
    .all() as any[]

  return {
    totalKeys: metrics?.total_keys || 0,
    activeKeys: metrics?.active_keys || 0,
    cooldownKeys: metrics?.cooldown_keys || 0,
    disabledKeys: metrics?.disabled_keys || 0,
    totalSuccessCalls: metrics?.total_success_calls || 0,
    totalFailedCalls: metrics?.total_failed_calls || 0,
    totalRateLimitCount: metrics?.total_rate_limit_count || 0,
    averageLatencyMs: Math.round(avgLatencyRow?.avg_latency || 0),
    keyDetails: keys.map((k) => ({
      id: k.id,
      maskedKey: maskApiKey(k.api_key),
      status: k.status,
      lastUsedAt: k.last_used_at,
      cooldownUntil: k.cooldown_until,
      successCalls: k.success_calls,
      failedCalls: k.failed_calls,
      rateLimitCount: k.rate_limit_count,
      consecutiveErrors: k.consecutive_errors
    }))
  }
}

export function getExecutionLogs(
  filters: ExecutionLogFilter = {},
  customDb?: Database.Database
): ExecutionLogResult {
  const dbInstance = customDb || getDatabase()
  const limit = Math.min(filters.limit || 50, 200)
  const offset = filters.offset || 0

  const conditions: string[] = []
  const params: any[] = []

  if (filters.status) {
    conditions.push('status = ?')
    params.push(filters.status)
  }
  if (filters.keyId) {
    conditions.push('key_id = ?')
    params.push(filters.keyId)
  }
  if (filters.model) {
    conditions.push('model = ?')
    params.push(filters.model)
  }
  if (filters.startDate) {
    conditions.push('timestamp >= ?')
    params.push(filters.startDate)
  }
  if (filters.endDate) {
    conditions.push('timestamp <= ?')
    params.push(filters.endDate)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countRow = dbInstance
    .prepare(`SELECT COUNT(*) as count FROM execution_logs ${whereClause}`)
    .get(...params) as any

  const rows = dbInstance
    .prepare(
      `SELECT id, key_id, model, status, error_message, latency_ms, tool_name, parameters, result, timestamp
       FROM execution_logs
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as any[]

  return {
    logs: rows.map((r) => ({
      id: r.id,
      keyId: r.key_id,
      model: r.model,
      status: r.status,
      errorMessage: r.error_message,
      latencyMs: r.latency_ms,
      timestamp: r.timestamp,
      toolName: r.tool_name,
      parameters: r.parameters,
      result: r.result
    })),
    totalCount: countRow?.count || 0,
    limit,
    offset
  }
}

export function clearExecutionLogs(customDb?: Database.Database): void {
  const dbInstance = customDb || getDatabase()
  dbInstance.prepare('DELETE FROM execution_logs').run()
}

export function calculateCosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  if (a.length !== b.length || a.length === 0) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]
    const valB = b[i]
    if (typeof valA !== 'number' || typeof valB !== 'number' || !Number.isFinite(valA) || !Number.isFinite(valB)) {
      return 0
    }
    dotProduct += valA * valB
    normA += valA * valA
    normB += valB * valB
  }
  if (normA === 0 || normB === 0 || !Number.isFinite(dotProduct) || !Number.isFinite(normA) || !Number.isFinite(normB)) {
    return 0
  }
  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  return Number.isFinite(similarity) ? similarity : 0
}

export function searchSemanticMemory(
  queryText?: string,
  category?: string,
  limit = 10,
  queryEmbedding?: number[],
  customDb?: Database.Database
): SemanticSearchResult[] {
  const dbInstance = customDb || getDatabase()

  let sql = 'SELECT id, content, category, embedding, metadata, created_at, updated_at FROM semantic_memory'
  const conditions: string[] = []
  const params: any[] = []

  if (category) {
    conditions.push('category = ?')
    params.push(category)
  }

  // Vector Cosine Similarity Search Mode
  if (queryEmbedding && queryEmbedding.length > 0) {
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    const rows = dbInstance.prepare(sql).all(...params) as any[]

    const scored = rows.map((r) => {
      let vec: number[] = []
      try {
        vec = JSON.parse(r.embedding)
      } catch {
        vec = []
      }
      const score = calculateCosineSimilarity(queryEmbedding, vec)
      return {
        id: r.id,
        content: r.content,
        category: r.category,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        similarityScore: score,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }
    })

    return scored
      .sort((a, b) => (b.similarityScore || 0) - (a.similarityScore || 0))
      .slice(0, limit)
  }

  // Fallback: Text Pattern Search Mode
  if (queryText && queryText.trim()) {
    conditions.push('content LIKE ?')
    params.push(`%${queryText.trim()}%`)
  }

  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const rows = dbInstance.prepare(sql).all(...params) as any[]

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    category: r.category,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export function getSkillsMetadata(customDb?: Database.Database): SkillsMetadataReport {
  const dbInstance = customDb || getDatabase()

  const rows = dbInstance
    .prepare(
      `SELECT skill_id, name, description, file_path, entrypoint, version, parameters_schema,
              success_count, failure_count, average_execution_time_ms, 
              last_executed_at, created_at, updated_at
       FROM skills_metadata
       ORDER BY last_executed_at DESC NULLS LAST, created_at DESC`
    )
    .all() as any[]

  let totalExecutions = 0
  let totalSuccesses = 0

  const skills: SkillMetadataRow[] = rows.map((r) => {
    const sCount = r.success_count || 0
    const fCount = r.failure_count || 0
    const total = sCount + fCount
    const rate = total > 0 ? (sCount / total) * 100 : 0

    totalExecutions += total
    totalSuccesses += sCount

    return {
      skillId: r.skill_id,
      name: r.name,
      description: r.description,
      filePath: r.file_path,
      entrypoint: r.entrypoint,
      version: r.version,
      parametersSchema: r.parameters_schema,
      parameters_schema: r.parameters_schema,
      successCount: sCount,
      failureCount: fCount,
      successRate: Math.round(rate * 100) / 100,
      averageExecutionTimeMs: Math.round(r.average_execution_time_ms || 0),
      lastExecutedAt: r.last_executed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  })

  const overallSuccessRate =
    totalExecutions > 0 ? Math.round((totalSuccesses / totalExecutions) * 10000) / 100 : 0

  return {
    totalSkills: skills.length,
    totalExecutions,
    overallSuccessRate,
    skills
  }
}

function stripLeadingComments(sql: string): string {
  let str = sql.trim()
  while (true) {
    if (str.startsWith('/*')) {
      const endIdx = str.indexOf('*/')
      if (endIdx !== -1) {
        str = str.slice(endIdx + 2).trim()
        continue
      }
    }
    if (str.startsWith('--')) {
      const endIdx = str.indexOf('\n')
      if (endIdx !== -1) {
        str = str.slice(endIdx + 1).trim()
        continue
      } else {
        str = ''
        break
      }
    }
    break
  }
  return str
}

export function executeRawInspectionQuery(
  sqlQuery: string,
  customDb?: Database.Database
): RawQueryResult {
  if (!sqlQuery || !sqlQuery.trim()) {
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: 0,
      error: 'SQL query string cannot be empty.'
    }
  }

  let normalized = stripLeadingComments(sqlQuery.trim())

  if (normalized.endsWith(';')) {
    normalized = normalized.slice(0, -1).trim()
  }

  if (normalized.includes(';')) {
    const statements = normalized.split(';').filter((s) => s.trim().length > 0)
    if (statements.length > 1) {
      return {
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: 0,
        error: 'Multi-statement SQL queries are strictly prohibited for inspection.'
      }
    }
  }

  const disallowedRegex = /\b(INSERT|UPDATE|DELETE|DROP|REPLACE|ALTER|CREATE|VACUUM|REINDEX|TRUNCATE|ATTACH|DETACH)\b/i
  if (
    disallowedRegex.test(normalized) ||
    (/^\s*PRAGMA\b/i.test(normalized) && normalized.includes('='))
  ) {
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: 0,
      error: 'Security Error: Only read-only SELECT, EXPLAIN, and PRAGMA queries are allowed.'
    }
  }

  let queryToExecute = normalized
  if (/^\s*(SELECT|WITH)\b/i.test(normalized) && !/\bLIMIT\b/i.test(normalized)) {
    queryToExecute += ' LIMIT 500'
  }

  const dbInstance = customDb || getDatabase()
  const startTime = performance.now()

  try {
    const stmt = dbInstance.prepare(queryToExecute)
    const rows = stmt.all() as Record<string, any>[]
    const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []

    return {
      success: true,
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs
    }
  } catch (err: any) {
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: Math.round((performance.now() - startTime) * 100) / 100,
      error: err?.message || String(err)
    }
  }
}

export function getDatabaseOverallStats(customDb?: Database.Database): Record<string, number> {
  const dbInstance = customDb || getDatabase()
  const tables = [
    'api_key_pool',
    'execution_logs',
    'semantic_memory',
    'skills_metadata',
    'conversation_history',
    'app_config'
  ]

  const stats: Record<string, number> = {}

  for (const table of tables) {
    try {
      const row = dbInstance.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as any
      stats[table] = row?.count || 0
    } catch {
      stats[table] = 0
    }
  }

  return stats
}
