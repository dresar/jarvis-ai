import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  initializeSchema,
  setConfig,
  getConfig,
  saveChatMessage,
  getChatHistory
} from '../../src/main/database'

import {
  getEpisodicContext,
  saveAndProcessEpisodicMessage,
  formatEpisodicHistoryForGemini,
  clearEpisodicBuffer,
  triggerAutoSummarization,
  DEFAULT_EPISODIC_CONFIG
} from '../../src/main/memory/episodicBuffer'

import * as keyPoolManager from '../../src/main/keyPoolManager'

describe('Challenger Verification Suite — Milestone 3: Episodic Buffer Edge Cases', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeSchema(db)
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  // ──────────────────────────────────────────────────────────────────────────
  // CHALLENGE 1: Multi-Session Isolation & Special Character Session IDs
  // ──────────────────────────────────────────────────────────────────────────
  describe('Challenge 1: Multi-Session Memory Isolation & Special Characters', () => {
    it('1.1 Strictly isolates messages, count, summary, and lastSummarizedCount across multiple concurrent sessions', async () => {
      const executeSpy = vi.spyOn(keyPoolManager, 'executeWithKeyRotation')
      executeSpy.mockImplementation(async (_op, _attempts, _model) => {
        return 'Summary for specific session'
      })

      const session1 = 'user-session-alpha'
      const session2 = 'user-session-beta'
      const session3 = 'user-session-gamma'

      // Populate Session 1 with 10 messages
      for (let i = 1; i <= 10; i++) {
        saveChatMessage(`s1-m${i}`, 'user', `Session 1 Message ${i}`, session1, db)
      }
      setConfig(`episodic_summary_${session1}`, 'Summary for Session 1', db)
      setConfig(`episodic_last_summarized_count_${session1}`, '10', db)

      // Populate Session 2 with 5 messages
      for (let i = 1; i <= 5; i++) {
        saveChatMessage(`s2-m${i}`, 'model', `Session 2 Message ${i}`, session2, db)
      }

      // Populate Session 3 with 25 messages (triggers summarization for Session 3)
      for (let i = 1; i <= 25; i++) {
        await saveAndProcessEpisodicMessage(`s3-m${i}`, i % 2 === 1 ? 'user' : 'model', `Session 3 Message ${i}`, session3, { summarizeThreshold: 25 }, db)
      }

      // Verify Session 1
      const ctx1 = getEpisodicContext(session1, {}, db)
      expect(ctx1.totalMessagesCount).toBe(10)
      expect(ctx1.messages.length).toBe(10)
      expect(ctx1.summary).toBe('Summary for Session 1')
      expect(getConfig(`episodic_last_summarized_count_${session1}`, db)).toBe('10')

      // Verify Session 2
      const ctx2 = getEpisodicContext(session2, {}, db)
      expect(ctx2.totalMessagesCount).toBe(5)
      expect(ctx2.messages.length).toBe(5)
      expect(ctx2.summary).toBeNull()
      expect(getConfig(`episodic_last_summarized_count_${session2}`, db)).toBeNull()

      // Verify Session 3
      const ctx3 = getEpisodicContext(session3, {}, db)
      expect(ctx3.totalMessagesCount).toBe(25)
      expect(ctx3.summary).toBe('Summary for specific session')
      expect(getConfig(`episodic_last_summarized_count_${session3}`, db)).toBe('25')
    })

    it('1.2 Safely handles session IDs containing special characters, quotes, unicode, and spaces without SQL injection', async () => {
      const complexSessionIds = [
        "session'with'single'quotes",
        'session"with"double"quotes',
        'session; DROP TABLE conversation_history; --',
        'session/with/slashes/and/backslashes\\',
        'session_🚀_unicode_emoji_123',
        '   session_with_spaces   '
      ]

      for (const sessId of complexSessionIds) {
        saveChatMessage(`msg-1-${sessId}`, 'user', `Hello from ${sessId}`, sessId, db)
        setConfig(`episodic_summary_${sessId}`, `Summary for ${sessId}`, db)
        setConfig(`episodic_last_summarized_count_${sessId}`, '1', db)

        const ctx = getEpisodicContext(sessId, {}, db)
        expect(ctx.sessionId).toBe(sessId)
        expect(ctx.totalMessagesCount).toBe(1)
        expect(ctx.messages[0].content).toBe(`Hello from ${sessId}`)
        expect(ctx.summary).toBe(`Summary for ${sessId}`)

        clearEpisodicBuffer(sessId, db)
        const ctxAfter = getEpisodicContext(sessId, {}, db)
        expect(ctxAfter.totalMessagesCount).toBe(0)
        expect(ctxAfter.summary).toBeNull()
      }

      // Ensure main table was not dropped by SQL injection test
      const checkTable = db.prepare("SELECT count(*) as count FROM conversation_history").get() as { count: number }
      expect(checkTable.count).toBe(0)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // CHALLENGE 2: Threshold Boundary Conditions & Custom Configurations
  // ──────────────────────────────────────────────────────────────────────────
  describe('Challenge 2: Threshold Boundary & Custom Configurations', () => {
    it('2.1 Precise boundary checks for summarizeThreshold (24 vs 25 vs 26 vs 39 vs 40)', async () => {
      const sessionId = 'boundary-check-session'
      let summarizeCalls = 0

      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        summarizeCalls++
        return `Summary Call ${summarizeCalls}`
      })

      // Add messages 1 to 24 (Threshold 25)
      for (let i = 1; i <= 24; i++) {
        const res = await saveAndProcessEpisodicMessage(`m-${i}`, 'user', `Msg ${i}`, sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
        expect(res.summaryUpdated).toBe(false)
      }
      expect(summarizeCalls).toBe(0)

      // Message 25: EXACT THRESHOLD REACHED -> Summarizes
      const res25 = await saveAndProcessEpisodicMessage('m-25', 'user', 'Msg 25', sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
      expect(res25.summaryUpdated).toBe(true)
      expect(summarizeCalls).toBe(1)
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBe('25')

      // Message 26: 1 message above threshold (delta = 1 < 15) -> NO Summarization
      const res26 = await saveAndProcessEpisodicMessage('m-26', 'user', 'Msg 26', sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
      expect(res26.summaryUpdated).toBe(false)
      expect(summarizeCalls).toBe(1)

      // Add up to 39 (delta = 14 < 15) -> NO Summarization
      for (let i = 27; i <= 39; i++) {
        const res = await saveAndProcessEpisodicMessage(`m-${i}`, 'user', `Msg ${i}`, sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
        expect(res.summaryUpdated).toBe(false)
      }
      expect(summarizeCalls).toBe(1)

      // Message 40: (40 - 25 = 15 >= 15) -> Summarizes second time!
      const res40 = await saveAndProcessEpisodicMessage('m-40', 'user', 'Msg 40', sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
      expect(res40.summaryUpdated).toBe(true)
      expect(summarizeCalls).toBe(2)
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBe('40')
    })

    it('2.2 Custom low thresholds: summarizeThreshold = 5, keepLatestOnSummarize = 2 (minNewMessages = 3)', async () => {
      const sessionId = 'custom-low-threshold'
      let summarizeCalls = 0

      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        summarizeCalls++
        return `Custom Low Summary ${summarizeCalls}`
      })

      const customConfig = { summarizeThreshold: 5, keepLatestOnSummarize: 2 }

      // Insert 4 messages -> no summary
      for (let i = 1; i <= 4; i++) {
        await saveAndProcessEpisodicMessage(`m-${i}`, 'user', `Msg ${i}`, sessionId, customConfig, db)
      }
      expect(summarizeCalls).toBe(0)

      // Insert 5th message -> triggers summary #1 (summarizes 3 msgs, keeps 2)
      await saveAndProcessEpisodicMessage('m-5', 'user', 'Msg 5', sessionId, customConfig, db)
      expect(summarizeCalls).toBe(1)
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBe('5')

      // Insert 6 and 7 -> delta is 1 and 2 < 3 -> no summary
      await saveAndProcessEpisodicMessage('m-6', 'user', 'Msg 6', sessionId, customConfig, db)
      await saveAndProcessEpisodicMessage('m-7', 'user', 'Msg 7', sessionId, customConfig, db)
      expect(summarizeCalls).toBe(1)

      // Insert 8th message -> 8 - 5 = 3 >= 3 -> triggers summary #2
      await saveAndProcessEpisodicMessage('m-8', 'user', 'Msg 8', sessionId, customConfig, db)
      expect(summarizeCalls).toBe(2)
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBe('8')
    })

    it('2.3 Edge case: keepLatestOnSummarize = 0', async () => {
      const sessionId = 'zero-keep-latest'
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue('All messages summarized')

      for (let i = 1; i <= 5; i++) {
        await saveAndProcessEpisodicMessage(`m-${i}`, 'user', `Msg ${i}`, sessionId, { summarizeThreshold: 5, keepLatestOnSummarize: 0 }, db)
      }

      const summaryKey = `episodic_summary_${sessionId}`
      expect(getConfig(summaryKey, db)).toBe('All messages summarized')
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBe('5')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // CHALLENGE 3: State Reset & Post-Clear Re-Summarization Cycle
  // ──────────────────────────────────────────────────────────────────────────
  describe('Challenge 3: Summarization State Reset on Clear', () => {
    it('3.1 clearEpisodicBuffer completely removes history, summary, and lastSummarizedCount, enabling clean second lifecycle', async () => {
      const sessionId = 'clear-lifecycle-session'
      let summarizeCalls = 0

      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        summarizeCalls++
        return `Lifecycle Summary ${summarizeCalls}`
      })

      // Lifecycle 1: Fill 25 messages, trigger summary #1
      for (let i = 1; i <= 25; i++) {
        await saveAndProcessEpisodicMessage(`m1-${i}`, 'user', `L1 Msg ${i}`, sessionId, { summarizeThreshold: 25 }, db)
      }
      expect(summarizeCalls).toBe(1)
      expect(getEpisodicContext(sessionId, {}, db).isSummarized).toBe(true)

      // Clear buffer
      clearEpisodicBuffer(sessionId, db)

      // Verify all 3 keys cleared
      const ctxCleared = getEpisodicContext(sessionId, {}, db)
      expect(ctxCleared.totalMessagesCount).toBe(0)
      expect(ctxCleared.messages.length).toBe(0)
      expect(ctxCleared.summary).toBeNull()
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBeNull()

      // Lifecycle 2: Fill 25 new messages in cleared session -> MUST trigger summary #2 afresh at message 25
      for (let i = 1; i <= 24; i++) {
        const res = await saveAndProcessEpisodicMessage(`m2-${i}`, 'user', `L2 Msg ${i}`, sessionId, { summarizeThreshold: 25 }, db)
        expect(res.summaryUpdated).toBe(false)
      }
      expect(summarizeCalls).toBe(1) // Still 1

      const resL225 = await saveAndProcessEpisodicMessage('m2-25', 'user', 'L2 Msg 25', sessionId, { summarizeThreshold: 25 }, db)
      expect(resL225.summaryUpdated).toBe(true)
      expect(summarizeCalls).toBe(2) // Triggers summary #2 correctly!
      expect(getEpisodicContext(sessionId, {}, db).summary).toBe('Lifecycle Summary 2')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // CHALLENGE 4: Gemini Summarization Error Resilience & Retry Behavior
  // ──────────────────────────────────────────────────────────────────────────
  describe('Challenge 4: Summarization API Failure & Retry Resilience', () => {
    it('4.1 If auto-summarization fails at threshold (e.g. 25th message), it gracefully handles error and retries on subsequent turns until successful', async () => {
      const sessionId = 'failure-retry-session'
      let attempt = 0

      // Mock executeWithKeyRotation to fail on first attempt, succeed on second attempt
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        attempt++
        if (attempt === 1) {
          throw new Error('Key Pool Rotator temporary rate limit / 503 error')
        }
        return 'Recovered Summary after failure'
      })

      // Add 24 messages
      for (let i = 1; i <= 24; i++) {
        await saveAndProcessEpisodicMessage(`m-${i}`, 'user', `Msg ${i}`, sessionId, { summarizeThreshold: 25 }, db)
      }

      // 25th message: Summarization attempt #1 fails
      const res25 = await saveAndProcessEpisodicMessage('m-25', 'user', 'Msg 25', sessionId, { summarizeThreshold: 25 }, db)
      expect(res25.summaryUpdated).toBe(false)
      // Verify lastSummarizedCount was NOT updated on failure
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBeNull()

      // 26th message: Total count = 26, lastSummarizedCount = 0. Delta = 26 >= 15. Attempts summarization attempt #2 -> SUCCEEDS!
      const res26 = await saveAndProcessEpisodicMessage('m-26', 'user', 'Msg 26', sessionId, { summarizeThreshold: 25 }, db)
      expect(res26.summaryUpdated).toBe(true)
      expect(res26.newSummary).toBe('Recovered Summary after failure')
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBe('26')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // CHALLENGE 5: Edge Input Data & Large Payloads
  // ──────────────────────────────────────────────────────────────────────────
  describe('Challenge 5: Edge Data Handling & Formatter Integrity', () => {
    it('5.1 Handles large text payloads (50KB per message) without crashing SQLite or buffer', async () => {
      const sessionId = 'large-payload-session'
      const largeContent = 'A'.repeat(50000)

      for (let i = 1; i <= 5; i++) {
        saveChatMessage(`large-${i}`, i % 2 === 1 ? 'user' : 'model', `${largeContent}-${i}`, sessionId, db)
      }

      const ctx = getEpisodicContext(sessionId, { maxWindowSize: 5 }, db)
      expect(ctx.totalMessagesCount).toBe(5)
      expect(ctx.messages[0].content.length).toBe(50002)
    })

    it('5.2 Ignores duplicate messageId without throwing primary key constraint error', () => {
      saveChatMessage('dup-id', 'user', 'First insertion', 'dup-session', db)
      expect(() => {
        saveChatMessage('dup-id', 'user', 'Second insertion with same ID', 'dup-session', db)
      }).not.toThrow()

      const history = getChatHistory(10, 'dup-session', db)
      expect(history.length).toBe(1)
      expect(history[0].content).toBe('First insertion')
    })

    it('5.3 Formats system messages in formatEpisodicHistoryForGemini safely', () => {
      const context = {
        sessionId: 'system-msg-session',
        messages: [
          { role: 'user' as const, content: 'User msg' },
          { role: 'model' as const, content: 'Model msg' }
        ],
        summary: 'System summary',
        totalMessagesCount: 2,
        isSummarized: true
      }

      const formatted = formatEpisodicHistoryForGemini(context)
      expect(formatted).toEqual([
        { role: 'user', parts: [{ text: 'User msg' }] },
        { role: 'model', parts: [{ text: 'Model msg' }] }
      ])
    })
  })
})
