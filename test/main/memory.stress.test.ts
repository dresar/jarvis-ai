import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  initializeSchema,
  setConfig,
  saveChatMessage,
  getConfig
} from '../../src/main/database'

import {
  getEpisodicContext,
  saveAndProcessEpisodicMessage,
  formatEpisodicHistoryForGemini,
  clearEpisodicBuffer,
  triggerAutoSummarization
} from '../../src/main/memory/episodicBuffer'

import {
  saveSemanticMemorySnippet,
  retrieveSemanticMemories,
  formatSemanticMemoriesForSystemPrompt,
  deleteSemanticMemoryItem,
  generateTextEmbedding,
  SemanticMemoryItem
} from '../../src/main/memory/semanticRag'

import { validateAndSelectModel } from '../../src/main/modelSelector'
import * as keyPoolManager from '../../src/main/keyPoolManager'

describe('Adversarial & Stress Testing Suite — Milestone 3 (Memory Subsystem)', () => {
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
  // STRESS TEST 1: High volume message additions & automatic summarization
  // ──────────────────────────────────────────────────────────────────────────
  describe('Stress Test 1: High Volume Message Additions & Auto-Summarization', () => {
    it('1.1 Handles 200 rapid message additions and enforces maxWindowSize sliding window', async () => {
      const sessionId = 'high-volume-session'
      const startMs = Date.now()

      // Add 200 messages without API call (mocking auto summarization to prevent network delays)
      for (let i = 1; i <= 200; i++) {
        const role = i % 2 === 1 ? 'user' : 'model'
        saveChatMessage(`msg-${i}`, role, `Pesan ke-${i} dari ${role}`, sessionId, db)
      }

      const elapsedMs = Date.now() - startMs
      console.log(`[StressTest] 200 message inserts completed in ${elapsedMs}ms`)

      // Verify DB total count
      const context = getEpisodicContext(sessionId, { maxWindowSize: 20 }, db)
      expect(context.totalMessagesCount).toBe(200)
      expect(context.messages.length).toBe(20)

      // Verify sliding window contains exact last 20 messages (msg-181 to msg-200)
      expect(context.messages[0].content).toBe('Pesan ke-181 dari user')
      expect(context.messages[19].content).toBe('Pesan ke-200 dari model')
    })

    it('1.2 Triggers auto-summarization at threshold and updates session summary in app_config', async () => {
      const sessionId = 'auto-summary-session'

      // Mock executeWithKeyRotation to simulate Gemini summarization response
      const executeSpy = vi.spyOn(keyPoolManager, 'executeWithKeyRotation')
      executeSpy.mockResolvedValue('RINGKASAN_KUMULATIF: User membahas topik A, B, C.')

      // Insert 24 messages (threshold is 25)
      for (let i = 1; i <= 24; i++) {
        await saveAndProcessEpisodicMessage(`m-${i}`, i % 2 === 1 ? 'user' : 'model', `Pesan ${i}`, sessionId, { summarizeThreshold: 25 }, db)
      }

      // Check before 25th message: summary not updated
      let context = getEpisodicContext(sessionId, {}, db)
      expect(context.totalMessagesCount).toBe(24)
      expect(context.summary).toBeNull()

      // Add 25th message: should trigger summarization
      const res = await saveAndProcessEpisodicMessage('m-25', 'user', 'Pesan 25', sessionId, { summarizeThreshold: 25 }, db)
      expect(res.summaryUpdated).toBe(true)
      expect(res.newSummary).toBe('RINGKASAN_KUMULATIF: User membahas topik A, B, C.')

      // Verify summary persisted in SQLite app_config
      context = getEpisodicContext(sessionId, {}, db)
      expect(context.summary).toBe('RINGKASAN_KUMULATIF: User membahas topik A, B, C.')
      expect(context.isSummarized).toBe(true)
    })

    it('1.3 Handles edge case when keepLatestOnSummarize >= summarizeThreshold', async () => {
      const sessionId = 'edge-threshold-session'

      // Add 10 messages
      for (let i = 1; i <= 10; i++) {
        saveChatMessage(`m-${i}`, 'user', `Pesan ${i}`, sessionId, db)
      }

      // If keepLatestOnSummarize (15) >= rows count (10), triggerAutoSummarization returns null
      const summary = await triggerAutoSummarization(sessionId, { keepLatestOnSummarize: 15 }, db)
      expect(summary).toBeNull()
    })

    it('1.4 Handles high-volume cumulative summarization across multiple cycles', async () => {
      const sessionId = 'multi-summary-session'
      let callCount = 0

      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async (op: any) => {
        callCount++
        return `Ringkasan Siklus ${callCount}`
      })

      // Trigger summarization 3 times
      for (let cycle = 1; cycle <= 3; cycle++) {
        for (let i = 1; i <= 25; i++) {
          await saveAndProcessEpisodicMessage(`c${cycle}-m${i}`, 'user', `Pesan ${i} siklus ${cycle}`, sessionId, { summarizeThreshold: 25 }, db)
        }
      }

      expect(callCount).toBeGreaterThanOrEqual(3)
      const context = getEpisodicContext(sessionId, {}, db)
      expect(context.summary).toContain('Ringkasan Siklus')
    })

    it('1.5 VERIFY FIX Bug 2: Persists episodic_last_summarized_count in app_config and prevents redundant calls', async () => {
      const sessionId = 'redundant-summary-test'
      let callCount = 0

      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        callCount++
        return `Summary call ${callCount}`
      })

      // Insert 25 messages -> 25th triggers summarization (call #1)
      for (let i = 1; i <= 25; i++) {
        await saveAndProcessEpisodicMessage(`m-${i}`, 'user', `Msg ${i}`, sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
      }

      expect(callCount).toBe(1)
      const lastCount = getConfig(`episodic_last_summarized_count_${sessionId}`, db)
      expect(lastCount).toBe('25')

      // Insert 14 more messages (total 39). Should NOT trigger auto-summarization because delta is 14 < 15.
      for (let i = 26; i <= 39; i++) {
        const res = await saveAndProcessEpisodicMessage(`m-${i}`, 'user', `Msg ${i}`, sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
        expect(res.summaryUpdated).toBe(false)
      }
      expect(callCount).toBe(1) // Still 1! No redundant calls per turn!

      // Insert 40th message. Delta becomes 15 (40 - 25 = 15 >= 15). Should trigger summarization (call #2).
      const res40 = await saveAndProcessEpisodicMessage('m-40', 'user', 'Msg 40', sessionId, { summarizeThreshold: 25, keepLatestOnSummarize: 10 }, db)
      expect(res40.summaryUpdated).toBe(true)
      expect(callCount).toBe(2)
      expect(getConfig(`episodic_last_summarized_count_${sessionId}`, db)).toBe('40')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // STRESS TEST 2: Vector embedding failures & fallback text search
  // ──────────────────────────────────────────────────────────────────────────
  describe('Stress Test 2: Embedding Generation Failures & Fallback Text Search', () => {
    it('2.1 VERIFY FIX: generateTextEmbedding model text-embedding-004 is preserved by executeWithKeyRotation', async () => {
      // Test real generateTextEmbedding call logic without network calls by inspecting executeWithKeyRotation parameter passing
      const executeSpy = vi.spyOn(keyPoolManager, 'executeWithKeyRotation')

      // Call generateTextEmbedding
      try {
        await generateTextEmbedding('Test text for embedding')
      } catch {
        // Expected failure in test environment
      }

      expect(executeSpy).toHaveBeenCalled()
      const requestedModelArg = executeSpy.mock.calls[0][2]
      expect(requestedModelArg).toBe('text-embedding-004')

      // Verify what happens when executeWithKeyRotation receives 'text-embedding-004' with { allowEmbedding: true }:
      const modelResultInKeyRotation = validateAndSelectModel(requestedModelArg, { allowEmbedding: true })
      
      // VERIFIED FIX: validateAndSelectModel('text-embedding-004', { allowEmbedding: true }) returns 'text-embedding-004'!
      expect(modelResultInKeyRotation).toBe('text-embedding-004')
    })

    it('2.2 Verify retrieveSemanticMemories fallback to text search when embedding generation fails', async () => {
      // Pre-insert semantic memory rows
      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding, source) VALUES (?, ?, ?, ?, ?)`
      ).run('sem-1', 'Pengguna menyukai bahasa TypeScript dan Python.', 'user_preference', JSON.stringify([0.1, 0.2]), 'explicit')

      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding, source) VALUES (?, ?, ?, ?, ?)`
      ).run('sem-2', 'Pengguna bertempat tinggal di Jakarta, Indonesia.', 'user_fact', JSON.stringify([0.3, 0.4]), 'user_chat')

      // Force generateTextEmbedding to throw an error (simulating network or key failure)
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockRejectedValue(new Error('Embedding API Unavailable'))

      const results = await retrieveSemanticMemories('TypeScript', { limit: 5 }, db)
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('sem-1')
      expect(results[0].content).toContain('TypeScript')
    })

    it('2.3 Fallback text search handles special characters and SQL injection attempts safely', async () => {
      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('sem-sql', "Pengguna berkata: 'DROP TABLE users; -- % _ \" \\", 'general', JSON.stringify([0.1]))

      // Force generateTextEmbedding to fail so it uses fallback text search
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockRejectedValue(new Error('Embedding API Unavailable'))

      // Test SQL injection attempt in search query string
      const query = "'DROP TABLE users; --"
      const results = await retrieveSemanticMemories(query, { limit: 5 }, db)
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('sem-sql')
      expect(results[0].content).toContain("DROP TABLE users;")
    })

    it('2.4 Save & delete operations on semantic memory', async () => {
      // Mock generateTextEmbedding to return valid 768-dim float array
      const fakeEmbedding = new Array(768).fill(0.01)
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(fakeEmbedding as any)

      const saved = await saveSemanticMemorySnippet({
        content: 'Pengguna alergi udang dan kepiting.',
        category: 'user_fact',
        source: 'user_chat',
        tags: ['alergi', 'makanan']
      }, db)

      expect(saved.id).toBeDefined()
      expect(saved.content).toBe('Pengguna alergi udang dan kepiting.')
      expect(saved.tags).toEqual(['alergi', 'makanan'])

      // Verify stored in DB
      const row = db.prepare('SELECT * FROM semantic_memory WHERE id = ?').get(saved.id) as any
      expect(row).toBeDefined()

      // Delete item
      const deleted = deleteSemanticMemoryItem(saved.id, db)
      expect(deleted).toBe(true)

      const rowAfter = db.prepare('SELECT * FROM semantic_memory WHERE id = ?').get(saved.id)
      expect(rowAfter).toBeUndefined()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // STRESS TEST 3: System Prompt Context Formatting (0, 1, and Many Memories)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Stress Test 3: System Prompt Context Formatting (0, 1, Many Memories)', () => {
    it('3.1 Formats system prompt with 0 memories -> returns empty string', () => {
      expect(formatSemanticMemoriesForSystemPrompt([])).toBe('')
      expect(formatSemanticMemoriesForSystemPrompt(null as any)).toBe('')
      expect(formatSemanticMemoriesForSystemPrompt(undefined as any)).toBe('')
    })

    it('3.2 Formats system prompt with 1 memory', () => {
      const memories = [
        {
          id: 'm1',
          content: 'Pengguna berumur 28 tahun.',
          category: 'user_fact' as const,
          metadata: null,
          similarityScore: 0.92,
          createdAt: '2026-08-14T00:00:00Z',
          updatedAt: '2026-08-14T00:00:00Z'
        }
      ]

      const formatted = formatSemanticMemoriesForSystemPrompt(memories)
      expect(formatted).toBe(
        `\n[MEMORI JANGKA PANJANG (SEMANTIC RAG)]\nBerikut adalah fakta/preferensi relevan yang tersimpan tentang pengguna:\n- [USER_FACT] Pengguna berumur 28 tahun. (Relevansi: 92%)\n`
      )
    })

    it('3.3 Formats system prompt with Many (10+) memories correctly', () => {
      const memories = Array.from({ length: 12 }, (_, i) => ({
        id: `mem-${i}`,
        content: `Fakta pengguna nomor ${i + 1}`,
        category: (i % 2 === 0 ? 'user_preference' : 'agent_insight') as const,
        metadata: null,
        similarityScore: 0.90 - i * 0.03,
        createdAt: '2026-08-14T00:00:00Z',
        updatedAt: '2026-08-14T00:00:00Z'
      }))

      const formatted = formatSemanticMemoriesForSystemPrompt(memories)
      expect(formatted).toContain('[MEMORI JANGKA PANJANG (SEMANTIC RAG)]')
      const lines = formatted.trim().split('\n')
      // Header + subheader + 12 items = 14 lines
      expect(lines.length).toBe(14)
      expect(lines[2]).toContain('[USER_PREFERENCE] Fakta pengguna nomor 1 (Relevansi: 90%)')
      expect(lines[13]).toContain('[AGENT_INSIGHT] Fakta pengguna nomor 12 (Relevansi: 57%)')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // STRESS TEST 4: Context Window Boundaries & Session Resets
  // ──────────────────────────────────────────────────────────────────────────
  describe('Stress Test 4: Context Window Boundaries & Session Resets', () => {
    it('4.1 getEpisodicContext respects custom maxWindowSize limits (1, 5, 50)', () => {
      for (let i = 1; i <= 30; i++) {
        saveChatMessage(`msg-${i}`, i % 2 === 1 ? 'user' : 'model', `Pesan ${i}`, 'window-test-session', db)
      }

      const ctx1 = getEpisodicContext('window-test-session', { maxWindowSize: 1 }, db)
      expect(ctx1.messages.length).toBe(1)
      expect(ctx1.messages[0].content).toBe('Pesan 30')

      const ctx5 = getEpisodicContext('window-test-session', { maxWindowSize: 5 }, db)
      expect(ctx5.messages.length).toBe(5)
      expect(ctx5.messages[0].content).toBe('Pesan 26')
      expect(ctx5.messages[4].content).toBe('Pesan 30')

      const ctx50 = getEpisodicContext('window-test-session', { maxWindowSize: 50 }, db)
      expect(ctx50.messages.length).toBe(30)
    })

    it('4.2 clearEpisodicBuffer resets session without leaking or affecting other active sessions', () => {
      // Setup Session A
      saveChatMessage('a-1', 'user', 'Pesan A1', 'session-A', db)
      setConfig('episodic_summary_session-A', 'Summary Session A', db)

      // Setup Session B
      saveChatMessage('b-1', 'user', 'Pesan B1', 'session-B', db)
      setConfig('episodic_summary_session-B', 'Summary Session B', db)

      // Clear Session A only
      clearEpisodicBuffer('session-A', db)

      // Verify Session A is reset
      const ctxA = getEpisodicContext('session-A', {}, db)
      expect(ctxA.totalMessagesCount).toBe(0)
      expect(ctxA.messages.length).toBe(0)
      expect(ctxA.summary).toBeNull()

      // Verify Session B is untouched
      const ctxB = getEpisodicContext('session-B', {}, db)
      expect(ctxB.totalMessagesCount).toBe(1)
      expect(ctxB.messages.length).toBe(1)
      expect(ctxB.messages[0].content).toBe('Pesan B1')
      expect(ctxB.summary).toBe('Summary Session B')
    })
  })
})
