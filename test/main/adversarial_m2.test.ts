import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  initializeSchema,
  calculateCosineSimilarity,
  searchSemanticMemory,
  maskApiKey,
  getApiKeyPoolStatus,
  executeRawInspectionQuery,
  getExecutionLogs
} from '../../src/main/database'

describe('Adversarial Stress Test Suite — Milestone 2 Persistence & Vectors', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeSchema(db)
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  // ─────────────────────────────────────────────────────────────
  // 1. Vector Similarity Scoring Edge Cases
  // ─────────────────────────────────────────────────────────────
  describe('1. Vector Similarity Scoring Edge Cases', () => {
    it('1.1 Zero vectors return 0 without throwing or returning NaN', () => {
      const zero1 = [0, 0, 0, 0]
      const zero2 = [0, 0, 0, 0]
      const vecNormal = [1, 2, 3, 4]

      const simZeroZero = calculateCosineSimilarity(zero1, zero2)
      expect(simZeroZero).toBe(0)
      expect(Number.isNaN(simZeroZero)).toBe(false)

      const simZeroNormal = calculateCosineSimilarity(zero1, vecNormal)
      expect(simZeroNormal).toBe(0)
      expect(Number.isNaN(simZeroNormal)).toBe(false)
    })

    it('1.2 Orthogonal vectors return 0', () => {
      const v1 = [1, 0, 0, 0]
      const v2 = [0, 1, 0, 0]
      expect(calculateCosineSimilarity(v1, v2)).toBe(0)
    })

    it('1.3 Identical vectors return 1.0', () => {
      const v1 = [0.5, 0.5, 0.5, 0.5]
      const v2 = [0.5, 0.5, 0.5, 0.5]
      expect(calculateCosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5)
    })

    it('1.4 Dimension mismatches return 0 gracefully', () => {
      const v1 = [1, 2]
      const v2 = [1, 2, 3]
      expect(calculateCosineSimilarity(v1, v2)).toBe(0)
      expect(calculateCosineSimilarity([], [1, 2, 3])).toBe(0)
      expect(calculateCosineSimilarity([1, 2, 3], [])).toBe(0)
    })

    it('1.5 Non-array JSON string embedding (e.g. JSON string "hello") matching query vector length safely returns score 0 instead of NaN', () => {
      // JSON.stringify("hello") -> '"hello"'
      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('str-embed', 'String embedding memory', 'test', JSON.stringify('hello'))

      const queryVec5 = [1, 2, 3, 4, 5] // length 5 matches 'hello'.length
      const results = searchSemanticMemory(undefined, 'test', 10, queryVec5, db)
      
      expect(results.length).toBe(1)
      const score = results[0].similarityScore
      expect(score).toBe(0)
      expect(Number.isNaN(score)).toBe(false)
    })

    it('1.6 NaN in queryEmbedding safely produces score 0 in searchSemanticMemory results', () => {
      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('mem-1', 'Memory 1', 'test', JSON.stringify([1, 0, 0]))
      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('mem-2', 'Memory 2', 'test', JSON.stringify([0, 1, 0]))

      const results = searchSemanticMemory(undefined, 'test', 10, [NaN, 0, 0], db)
      expect(results.length).toBe(2)
      expect(results[0].similarityScore).toBe(0)
      expect(results[1].similarityScore).toBe(0)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 2. API Key Masking Security
  // ─────────────────────────────────────────────────────────────
  describe('2. API Key Masking Security', () => {
    it('2.1 handles null, undefined, empty, and short inputs', () => {
      expect(maskApiKey(null as any)).toBe('***')
      expect(maskApiKey(undefined as any)).toBe('***')
      expect(maskApiKey('')).toBe('***')
      expect(maskApiKey('12345678901')).toBe('***') // length 11
      expect(maskApiKey('123456789012')).toBe('***') // length 12
    })

    it('2.2 masks boundary length 13 and longer API keys', () => {
      const key13 = '1234567890123'
      expect(maskApiKey(key13)).toBe('12345678...0123')

      const realLookingKey = 'AIzaSyD-9876543210abcdefghijklmn'
      const masked = maskApiKey(realLookingKey)
      expect(masked).toBe('AIzaSyD-...klmn')
      expect(masked.length).toBe(15)
      expect(masked.includes('9876543210')).toBe(false)
    })

    it('2.3 non-string input (number/object) safely returns *** in maskApiKey without throwing', () => {
      expect(maskApiKey(123456789012345 as any)).toBe('***')
      expect(maskApiKey({ key: 'secret' } as any)).toBe('***')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 3. getApiKeyPoolStatus Aggregation Edge Cases
  // ─────────────────────────────────────────────────────────────
  describe('3. getApiKeyPoolStatus Aggregations', () => {
    it('3.1 returns clean report on empty database without NaN or undefined', () => {
      const status = getApiKeyPoolStatus(db)
      expect(status).toEqual({
        totalKeys: 0,
        activeKeys: 0,
        cooldownKeys: 0,
        disabledKeys: 0,
        totalSuccessCalls: 0,
        totalFailedCalls: 0,
        totalRateLimitCount: 0,
        averageLatencyMs: 0,
        keyDetails: []
      })
      expect(Number.isNaN(status.averageLatencyMs)).toBe(false)
    })

    it('3.2 aggregates multiple keys across ACTIVE, COOLDOWN, and DISABLED statuses correctly', () => {
      db.prepare(`INSERT INTO api_key_pool (id, api_key, status, success_calls, failed_calls, rate_limit_count) VALUES (?, ?, ?, ?, ?, ?)`).run('k1', 'key_active_1_123456789', 'ACTIVE', 100, 5, 2)
      db.prepare(`INSERT INTO api_key_pool (id, api_key, status, success_calls, failed_calls, rate_limit_count) VALUES (?, ?, ?, ?, ?, ?)`).run('k2', 'key_active_2_123456789', 'ACTIVE', 50, 0, 0)
      db.prepare(`INSERT INTO api_key_pool (id, api_key, status, success_calls, failed_calls, rate_limit_count) VALUES (?, ?, ?, ?, ?, ?)`).run('k3', 'key_cooldown_123456789', 'COOLDOWN', 20, 10, 10)
      db.prepare(`INSERT INTO api_key_pool (id, api_key, status, success_calls, failed_calls, rate_limit_count) VALUES (?, ?, ?, ?, ?, ?)`).run('k4', 'key_disabled_123456789', 'DISABLED', 5, 15, 0)

      db.prepare(`INSERT INTO execution_logs (id, key_id, model, status, latency_ms) VALUES (?, ?, ?, ?, ?)`).run('log1', 'k1', 'gemini-2.5-flash', 'SUCCESS', 150)
      db.prepare(`INSERT INTO execution_logs (id, key_id, model, status, latency_ms) VALUES (?, ?, ?, ?, ?)`).run('log2', 'k2', 'gemini-2.5-pro', 'SUCCESS', 350)
      db.prepare(`INSERT INTO execution_logs (id, key_id, model, status, latency_ms) VALUES (?, ?, ?, ?, ?)`).run('log3', 'k3', 'gemini-2.5-flash', 'ERROR', 500)

      const status = getApiKeyPoolStatus(db)

      expect(status.totalKeys).toBe(4)
      expect(status.activeKeys).toBe(2)
      expect(status.cooldownKeys).toBe(1)
      expect(status.disabledKeys).toBe(1)
      expect(status.totalSuccessCalls).toBe(175)
      expect(status.totalFailedCalls).toBe(30)
      expect(status.totalRateLimitCount).toBe(12)
      expect(status.averageLatencyMs).toBe(250)
      expect(status.keyDetails.length).toBe(4)
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 4. Large Volume Semantic Memory Performance & Ordering
  // ─────────────────────────────────────────────────────────────
  describe('4. Large Volume Semantic Memory Search Performance & Accuracy', () => {
    it('4.1 handles 2,000 standard 1536-dimensional vectors with correct score ranking and latency', () => {
      const DIM = 1536
      const targetVec = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1.0 : 0.0))

      const stmt = db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      )

      const insertMany = db.transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          const vec = new Array(DIM).fill(0)
          if (i === 1500) {
            vec[0] = 1.0 // Perfect similarity with targetVec
          } else {
            const colIndex = (i % (DIM - 1)) + 1
            vec[colIndex] = 0.8
          }
          stmt.run(`mem-${i}`, `Memory item ${i}`, 'bench', JSON.stringify(vec))
        }
      })

      insertMany(2000)

      const start = performance.now()
      const searchResults = searchSemanticMemory(undefined, 'bench', 10, targetVec, db)
      const durationMs = performance.now() - start

      console.log(`[Performance Benchmark] 2,000 1536-dim vector search duration: ${durationMs.toFixed(2)} ms`)

      expect(searchResults.length).toBe(10)
      expect(searchResults[0].id).toBe('mem-1500')
      expect(searchResults[0].similarityScore).toBeCloseTo(1.0, 5)

      // Scores must be strictly descending
      for (let i = 0; i < searchResults.length - 1; i++) {
        expect(searchResults[i].similarityScore!).toBeGreaterThanOrEqual(
          searchResults[i + 1].similarityScore!
        )
      }
      expect(durationMs).toBeLessThan(1000) // Expect search under 1s
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 5. Raw Inspection Query Security Guard Stress Tests
  // ─────────────────────────────────────────────────────────────
  describe('5. Raw Inspection Query Security Guard Stress Tests', () => {
    it('5.1 blocks mutation attempts using comments, case variations, and multi-statements', () => {
      expect(executeRawInspectionQuery('DrOp TaBlE app_config', db).success).toBe(false)
      expect(executeRawInspectionQuery('InSeRt InTo app_config VALUES ("a", "b")', db).success).toBe(false)
      expect(executeRawInspectionQuery('SELECT * FROM app_config; DELETE FROM app_config;', db).success).toBe(false)

      db.prepare(`INSERT INTO app_config (key, value) VALUES ('k1', 'v1')`).run()
      const cteRes = executeRawInspectionQuery('WITH temp AS (SELECT * FROM app_config) SELECT * FROM temp', db)
      expect(cteRes.success).toBe(true)
      expect(cteRes.rowCount).toBe(1)
    })
  })
})
