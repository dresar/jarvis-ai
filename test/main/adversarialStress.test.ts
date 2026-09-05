import Module from 'node:module'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// Patch require('electron') BEFORE requiring any module
const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-adversarial-test-'))
const originalRequire = Module.prototype.require
Module.prototype.require = function (id: string) {
  if (id === 'electron') {
    return {
      app: {
        getPath: (name: string) => {
          if (name === 'userData') return testUserDataDir
          return os.tmpdir()
        }
      }
    }
  }
  return originalRequire.apply(this, arguments as any)
}

import { describe, it, beforeAll as before, beforeEach } from 'vitest'
import assert from 'node:assert/strict'

let keyPool: typeof import('../../src/main/keyPoolManager')
let modelSelector: typeof import('../../src/main/modelSelector')
let dbModule: typeof import('../../src/main/database')

describe('Adversarial Stress Test Suite - Milestone 1', () => {
  before(async () => {
    keyPool = await import('../../src/main/keyPoolManager')
    modelSelector = await import('../../src/main/modelSelector')
    dbModule = await import('../../src/main/database')
  })

  beforeEach(() => {
    keyPool.resetKeyPoolForTesting()
  })

  describe('1. Prohibited Models Enforcement', () => {
    const requiredProhibitedModels = [
      'gemini-1.5-flash',
      'GEMINI-1.5-PRO',
      'gemini-1.5-flash-8b',
      'models/gemini-1.5-flash'
    ]

    const additionalEdgeCases = [
      'gemini-1.5-pro-001',
      '  gemini-1.5-flash  ',
      'GEMINI-1.5-FLASH-LATEST',
      'models/gemini-1.5-pro/v1'
    ]

    it('1.1 should identify all required prohibited models as prohibited', () => {
      for (const model of requiredProhibitedModels) {
        assert.equal(
          modelSelector.isModelProhibited(model),
          true,
          `Failed to block required prohibited model: "${model}"`
        )
      }
    })

    it('1.2 should identify all edge-case prohibited models as prohibited', () => {
      for (const model of additionalEdgeCases) {
        assert.equal(
          modelSelector.isModelProhibited(model),
          true,
          `Failed to block edge-case prohibited model: "${model}"`
        )
      }
    })

    it('1.3 should fallback to default model when default options are used for prohibited models', () => {
      for (const model of [...requiredProhibitedModels, ...additionalEdgeCases]) {
        const selected = modelSelector.validateAndSelectModel(model)
        assert.equal(
          selected,
          modelSelector.DEFAULT_MODEL,
          `Prohibited model "${model}" did not fall back to default model!`
        )
      }
    })

    it('1.4 should throw error when throwOnProhibited option is enabled for prohibited models', () => {
      for (const model of requiredProhibitedModels) {
        assert.throws(
          () => {
            modelSelector.validateAndSelectModel(model, { throwOnProhibited: true })
          },
          /Prohibited model requested/,
          `Failed to throw error for prohibited model "${model}"`
        )
      }
    })

    it('1.5 should sanitize prohibited model before passing model to operation in executeWithKeyRotation', async () => {
      let receivedModel = ''
      const mockOp = async (_key: string, model: string) => {
        receivedModel = model
        return 'SUCCESS'
      }

      for (const prohibitedModel of requiredProhibitedModels) {
        const result = await keyPool.executeWithKeyRotation(mockOp, 3, prohibitedModel)
        assert.equal(result, 'SUCCESS')
        assert.equal(
          receivedModel,
          modelSelector.DEFAULT_MODEL,
          `executeWithKeyRotation allowed prohibited model "${prohibitedModel}" to pass to operation callback!`
        )
      }
    })
  })

  describe('2. Failover Execution (429, 400/403, Timeouts)', () => {
    it('2.1 should failover across 5 consecutive 429 rate limit errors and succeed on attempt 6', async () => {
      let attempts = 0
      const attemptedKeys: string[] = []

      const mockOp = async (apiKey: string) => {
        attempts++
        attemptedKeys.push(apiKey)
        if (attempts <= 5) {
          const err: any = new Error(`429 Rate Limit Exceeded - Attempt ${attempts}`)
          err.status = 429
          throw err
        }
        return 'SUCCESS_AT_ATTEMPT_6'
      }

      const result = await keyPool.executeWithKeyRotation(mockOp, 10, 'gemini-3.1-flash-lite')
      assert.equal(result, 'SUCCESS_AT_ATTEMPT_6')
      assert.equal(attempts, 6)

      // Ensure 6 distinct keys were attempted
      const uniqueKeys = new Set(attemptedKeys)
      assert.equal(uniqueKeys.size, 6, 'Failover did not use distinct keys for each attempt!')

      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.cooldownKeys, 5)
      assert.equal(stats.activeKeys, keyPool.SEED_API_KEYS.length - 5)

      // Check SQLite execution_logs
      const db = dbModule.getDatabase()
      const rateLimitLogs = db
        .prepare("SELECT * FROM execution_logs WHERE status = 'RATE_LIMITED'")
        .all()
      assert.equal(rateLimitLogs.length, 5)
    })

    it('2.2 should transition key to DISABLED on 400 invalid key error and never select it again', async () => {
      let attempts = 0
      let disabledApiKey = ''

      const mockOp = async (apiKey: string) => {
        attempts++
        if (attempts === 1) {
          disabledApiKey = apiKey
          const err: any = new Error('API key not valid. Please pass a valid API key.')
          err.status = 400
          throw err
        }
        return 'SUCCESS_AFTER_DISABLED_KEY'
      }

      const result = await keyPool.executeWithKeyRotation(mockOp, 5, 'gemini-2.5-flash')
      assert.equal(result, 'SUCCESS_AFTER_DISABLED_KEY')
      assert.equal(attempts, 2)

      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.disabledKeys, 1)

      // Verify disabled key is never selected in subsequent calls
      for (let i = 0; i < 100; i++) {
        const nextKey = keyPool.selectBestKey()
        assert.notEqual(
          nextKey.apiKey,
          disabledApiKey,
          'Disabled key was selected by selectBestKey()!'
        )
      }
    })

    it('2.3 should handle network timeouts, increment consecutiveErrors, and transition to COOLDOWN on 3rd error', async () => {
      const key1 = keyPool.selectBestKey()

      // Record 2 transient network errors
      keyPool.recordKeyError(key1.id, 'ETIMEDOUT: Connection timed out', 'gemini-3.1-flash-lite')
      keyPool.recordKeyError(key1.id, 'ECONNRESET: Connection reset by peer', 'gemini-3.1-flash-lite')

      let stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.activeKeys, keyPool.SEED_API_KEYS.length, 'Key should remain ACTIVE before 3rd error')

      // Record 3rd transient error
      keyPool.recordKeyError(key1.id, '503 Service Unavailable', 'gemini-3.1-flash-lite')

      stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.cooldownKeys, 1, 'Key should move to COOLDOWN on 3rd consecutive error')
      assert.equal(stats.activeKeys, keyPool.SEED_API_KEYS.length - 1)
    })

    it('2.4 should handle cascading heterogeneous errors (429 -> 400 -> timeout -> success)', async () => {
      let attempts = 0

      const mockOp = async () => {
        attempts++
        if (attempts === 1) {
          const err: any = new Error('429 ResourceExhausted: Quota exceeded')
          err.status = 429
          throw err
        }
        if (attempts === 2) {
          const err: any = new Error('400 Invalid API Key')
          err.status = 400
          throw err
        }
        if (attempts === 3) {
          throw new Error('ETIMEDOUT: socket hang up')
        }
        return 'CASCADING_SUCCESS'
      }

      const result = await keyPool.executeWithKeyRotation(mockOp, 5, 'gemini-3.1-flash-lite')
      assert.equal(result, 'CASCADING_SUCCESS')
      assert.equal(attempts, 4)

      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.cooldownKeys, 1, 'Key 1 (429) should be in COOLDOWN')
      assert.equal(stats.disabledKeys, 1, 'Key 2 (400) should be DISABLED')
    })
  })

  describe('3. Cooldown Lifecycle & Key Recovery', () => {
    it('3.1 should throw error when ALL keys enter COOLDOWN state with distant cooldownUntil', () => {
      const db = dbModule.getDatabase()
      const futureTime = Date.now() + 600_000 // 10 minutes in future

      db.prepare(`UPDATE api_key_pool SET status = 'COOLDOWN', cooldown_until = ?`).run(futureTime)
      keyPool.initializeKeyPool(keyPool.SEED_API_KEYS) // reload cache map

      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.cooldownKeys, keyPool.SEED_API_KEYS.length)
      assert.equal(stats.activeKeys, 0)

      assert.throws(
        () => {
          keyPool.selectBestKey()
        },
        /All Gemini API keys are currently in COOLDOWN or DISABLED state/,
        'selectBestKey failed to throw when all keys are in COOLDOWN'
      )
    })

    it('3.2 selectBestKey auto-reactivates key with cooldownUntil <= 5000ms without SqliteError', () => {
      const db = dbModule.getDatabase()
      const nearFutureTime = Date.now() + 2000 // 2 seconds in future

      // Set all keys to COOLDOWN in distant future first
      db.prepare(`UPDATE api_key_pool SET status = 'COOLDOWN', cooldown_until = ?`).run(
        Date.now() + 600_000
      )

      // Set one single key to expire in 2s
      const firstKeyId = (db.prepare('SELECT id FROM api_key_pool LIMIT 1').get() as any).id
      db.prepare('UPDATE api_key_pool SET cooldown_until = ? WHERE id = ?').run(
        nearFutureTime,
        firstKeyId
      )

      keyPool.initializeKeyPool(keyPool.SEED_API_KEYS) // reload cache map

      const selected = keyPool.selectBestKey()
      assert.equal(selected.id, firstKeyId)
      assert.equal(selected.status, 'ACTIVE')
      assert.equal(selected.cooldownUntil, null)
    })

    it('3.3 should automatically recover expired COOLDOWN keys back to ACTIVE state upon refresh', () => {
      const db = dbModule.getDatabase()
      const pastTime = Date.now() - 10_000 // expired 10 seconds ago

      // Set 10 keys to COOLDOWN in the past
      db.prepare(`
        UPDATE api_key_pool 
        SET status = 'COOLDOWN', cooldown_until = ? 
        WHERE rowid <= 10
      `).run(pastTime)

      keyPool.initializeKeyPool(keyPool.SEED_API_KEYS)

      let stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.cooldownKeys, 10)
      assert.equal(stats.activeKeys, keyPool.SEED_API_KEYS.length - 10)

      // Calling selectBestKey triggers refreshCooldowns()
      keyPool.selectBestKey()

      stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.cooldownKeys, 0, 'Expired cooldown keys were not recovered!')
      assert.equal(stats.activeKeys, keyPool.SEED_API_KEYS.length, 'All keys should now be ACTIVE!')
    })
  })

  describe('4. LRU Rotation & Load Distribution Stress', () => {
    it('4.1 should cycle through all distinct active keys before repeating', () => {
      const selectedKeyIds = new Set<string>()
      const totalKeys = keyPool.SEED_API_KEYS.length

      for (let i = 0; i < totalKeys; i++) {
        const key = keyPool.selectBestKey()
        assert.ok(!selectedKeyIds.has(key.id), `LRU algorithm selected duplicate key on step ${i + 1}`)
        selectedKeyIds.add(key.id)
      }

      assert.equal(selectedKeyIds.size, totalKeys, 'LRU selection did not rotate through all keys!')

      // next call should circle back to the very first key selected
      const nextKey = keyPool.selectBestKey()
      assert.ok(selectedKeyIds.has(nextKey.id), 'next call should pick an existing key from pool')
    })
  })
})
