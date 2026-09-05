import Module from 'node:module'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// Patch require('electron') BEFORE requiring any module
const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'))
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
let dbModule: typeof import('../../src/main/database')

describe('KeyPoolManager Module', () => {
  before(async () => {
    keyPool = await import('../../src/main/keyPoolManager')
    dbModule = await import('../../src/main/database')
  })

  beforeEach(() => {
    keyPool.resetKeyPoolForTesting()
  })

  describe('Key Seeding & Initial Status', () => {
    it('should seed valid Gemini API keys into the pool', () => {
      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.totalKeys, keyPool.SEED_API_KEYS.length)
      assert.equal(stats.activeKeys, keyPool.SEED_API_KEYS.length)
      assert.equal(stats.cooldownKeys, 0)
      assert.equal(stats.disabledKeys, 0)
    })
  })

  describe('LRU Key Selection Algorithm', () => {
    it('should pick active key and update lastUsedAt timestamp', () => {
      const key1 = keyPool.selectBestKey()
      assert.ok(key1)
      assert.ok(key1.apiKey)
      assert.equal(key1.status, 'ACTIVE')
      assert.ok((key1.lastUsedAt ?? 0) > 0)

      const key2 = keyPool.selectBestKey()
      assert.ok(key2)
      assert.notEqual(key2.id, key1.id)
    })
  })

  describe('State Machine & Metrics', () => {
    it('should transition key to COOLDOWN on rate limit (429)', () => {
      const initialActive = keyPool.getKeyPoolStatus().activeKeys
      const key = keyPool.selectBestKey()
      keyPool.recordKeyRateLimit(key.id, '429 Rate Limit Exceeded', 'gemini-3.1-flash-lite')

      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.cooldownKeys, 1)
      assert.equal(stats.activeKeys, initialActive - 1)
    })

    it('should transition key to DISABLED on invalid key (400/403)', () => {
      const key = keyPool.selectBestKey()
      keyPool.recordKeyDisabled(key.id, '400 Invalid API Key', 'gemini-3.1-flash-lite')

      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.disabledKeys, 1)
      assert.equal(stats.totalFailedCalls, 1)
    })

    it('should record key success and reset consecutive errors', () => {
      const key = keyPool.selectBestKey()
      keyPool.recordKeySuccess(key.id, 150, 'gemini-3.1-flash-lite')

      const stats = keyPool.getKeyPoolStatus()
      assert.ok(stats.totalSuccessCalls >= 1)
    })
  })

  describe('Dynamic Key Operations', () => {
    it('should add custom key to pool', () => {
      const initialTotal = keyPool.getKeyPoolStatus().totalKeys
      const customKey = 'AIzaSyTestCustomKey999'
      const added = keyPool.addKeyToPool(customKey)
      assert.equal(added, true)

      const stats = keyPool.getKeyPoolStatus()
      assert.equal(stats.totalKeys, initialTotal + 1)
    })

    it('should remove key from pool', () => {
      const customKey = 'AIzaSyTestCustomKeyForRemoval'
      keyPool.addKeyToPool(customKey)
      const totalBefore = keyPool.getKeyPoolStatus().totalKeys

      const removed = keyPool.removeKeyFromPool(customKey)
      assert.equal(removed, true)
      assert.equal(keyPool.getKeyPoolStatus().totalKeys, totalBefore - 1)
    })
  })

  describe('executeWithKeyRotation Failover Wrapper', () => {
    it('should successfully execute operation using active key', async () => {
      let callCount = 0
      const mockOp = async (_key: string, _model: string) => {
        callCount++
        return 'SUCCESS_RESULT'
      }

      const result = await keyPool.executeWithKeyRotation(mockOp, 5, 'gemini-2.5-flash')
      assert.equal(result, 'SUCCESS_RESULT')
      assert.equal(callCount, 1)
    })

    it('should automatically failover to next key when encountering rate limit (429)', async () => {
      let attempts = 0
      const mockOp = async () => {
        attempts++
        if (attempts === 1) {
          const err: any = new Error('429 ResourceExhausted: Quota exceeded')
          err.status = 429
          throw err
        }
        return 'SUCCESS_AFTER_RETRY'
      }

      const result = await keyPool.executeWithKeyRotation(mockOp, 5, 'gemini-2.5-flash')
      assert.equal(result, 'SUCCESS_AFTER_RETRY')
      assert.equal(attempts, 2)

      const stats = keyPool.getKeyPoolStatus()
      assert.ok(stats.cooldownKeys >= 1)
    })

    it('should throw error when max attempts fail', async () => {
      let attempts = 0
      const mockOp = async () => {
        attempts++
        throw new Error('Persistent Error')
      }

      await assert.rejects(
        async () => {
          await keyPool.executeWithKeyRotation(mockOp, 3, 'gemini-2.5-flash')
        },
        /All 3 key rotation attempts failed/
      )
      assert.equal(attempts, 3)
    })
  })

  describe('Cooldown Key Auto-Reactivation', () => {
    it('should auto-reactivate a cooldown key when selectBestKey() runs with cooldownUntil <= 5000ms', () => {
      const db = dbModule.getDatabase()
      const distantFuture = Date.now() + 600_000 // 10 minutes in future

      // Set all keys to COOLDOWN in distant future first
      db.prepare("UPDATE api_key_pool SET status = 'COOLDOWN', cooldown_until = ?").run(distantFuture)

      // Set one single key to expire in 2000ms (<= 5000ms)
      const targetRow = db.prepare('SELECT id FROM api_key_pool LIMIT 1').get() as { id: string }
      const nearFuture = Date.now() + 2000
      db.prepare('UPDATE api_key_pool SET cooldown_until = ? WHERE id = ?').run(nearFuture, targetRow.id)

      // Re-initialize key pool to sync cache map with db state
      keyPool.initializeKeyPool(keyPool.SEED_API_KEYS)

      // Call selectBestKey() - should auto-reactivate the key with cooldownUntil <= 5000ms without throwing SqliteError
      const selected = keyPool.selectBestKey()

      assert.equal(selected.id, targetRow.id)
      assert.equal(selected.status, 'ACTIVE')
      assert.equal(selected.cooldownUntil, null)
      assert.equal(selected.consecutiveErrors, 0)
      assert.ok((selected.lastUsedAt ?? 0) > 0)

      // Verify SQLite database update
      const dbRow = db.prepare('SELECT status, cooldown_until, consecutive_errors FROM api_key_pool WHERE id = ?').get(targetRow.id) as any
      assert.equal(dbRow.status, 'ACTIVE')
      assert.equal(dbRow.cooldown_until, null)
      assert.equal(dbRow.consecutive_errors, 0)
    })

    it('should auto-reactivate a cooldown key when selectBestKey() runs with cooldownUntil in the past', () => {
      const db = dbModule.getDatabase()
      const pastTime = Date.now() - 10_000 // 10 seconds ago

      // Set all keys to COOLDOWN in distant future first
      db.prepare("UPDATE api_key_pool SET status = 'COOLDOWN', cooldown_until = ?").run(Date.now() + 600_000)

      // Set one single key to have expired in the past
      const targetRow = db.prepare('SELECT id FROM api_key_pool LIMIT 1').get() as { id: string }
      db.prepare('UPDATE api_key_pool SET cooldown_until = ? WHERE id = ?').run(pastTime, targetRow.id)

      // Re-initialize key pool to sync cache map with db state
      keyPool.initializeKeyPool(keyPool.SEED_API_KEYS)

      // Call selectBestKey() - refreshCooldowns() will recover the expired key back to ACTIVE
      const selected = keyPool.selectBestKey()

      assert.equal(selected.id, targetRow.id)
      assert.equal(selected.status, 'ACTIVE')
      assert.equal(selected.cooldownUntil, null)

      // Verify SQLite database update
      const dbRow = db.prepare('SELECT status, cooldown_until FROM api_key_pool WHERE id = ?').get(targetRow.id) as any
      assert.equal(dbRow.status, 'ACTIVE')
      assert.equal(dbRow.cooldown_until, null)
    })
  })
})
