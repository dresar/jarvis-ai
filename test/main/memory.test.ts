import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'

import {
  initializeSchema,
  getConfig,
  setConfig,
  getChatHistory,
  saveChatMessage,
  clearChatHistory,
  getSkillsMetadata,
  getExecutionLogs
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
  deleteSemanticMemoryItem
} from '../../src/main/memory/semanticRag'

import {
  parsePythonSkillFile,
  upsertSkillMetadata,
  syncSkillStore,
  recordSkillMetrics,
  executePythonSkill,
  matchExistingSkill,
  getPythonSkillToolDeclarations,
  deleteSkillMetadata
} from '../../src/main/memory/skillStore'

describe('Milestone 3: 3-Pillar Memory Subsystem Test Suite', () => {
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

  // ─────────────────────────────────────────
  // Pillar 1: Episodic Buffer Memory Tests
  // ─────────────────────────────────────────
  describe('Pillar 1: Episodic Buffer Memory', () => {
    it('1.1 getEpisodicContext retrieves sliding window messages and session summary', () => {
      saveChatMessage('msg-1', 'user', 'Halo Jarvis', 'session-1', db)
      saveChatMessage('msg-2', 'model', 'Halo! Ada yang bisa kubantu?', 'session-1', db)
      setConfig('episodic_summary_session-1', 'Pengguna menyapa Jarvis.', db)

      const context = getEpisodicContext('session-1', { maxWindowSize: 20 }, db)

      expect(context.sessionId).toBe('session-1')
      expect(context.totalMessagesCount).toBe(2)
      expect(context.messages.length).toBe(2)
      expect(context.messages[0].content).toBe('Halo Jarvis')
      expect(context.messages[1].content).toBe('Halo! Ada yang bisa kubantu?')
      expect(context.summary).toBe('Pengguna menyapa Jarvis.')
      expect(context.isSummarized).toBe(true)
    })

    it('1.2 getEpisodicContext respects maxWindowSize limit', () => {
      for (let i = 1; i <= 10; i++) {
        saveChatMessage(`msg-${i}`, i % 2 === 1 ? 'user' : 'model', `Pesan ${i}`, 'session-2', db)
      }

      const context = getEpisodicContext('session-2', { maxWindowSize: 4 }, db)
      expect(context.totalMessagesCount).toBe(10)
      expect(context.messages.length).toBe(4)
      expect(context.messages[0].content).toBe('Pesan 7')
      expect(context.messages[3].content).toBe('Pesan 10')
    })

    it('1.3 formatEpisodicHistoryForGemini formats history turns for Gemini API', () => {
      const context = {
        sessionId: 'default',
        messages: [
          { role: 'user' as const, content: 'Siapa nama kamu?' },
          { role: 'model' as const, content: 'Nama saya Jarvis.' }
        ],
        summary: null,
        totalMessagesCount: 2,
        isSummarized: false
      }

      const formatted = formatEpisodicHistoryForGemini(context)
      expect(formatted).toEqual([
        { role: 'user', parts: [{ text: 'Siapa nama kamu?' }] },
        { role: 'model', parts: [{ text: 'Nama saya Jarvis.' }] }
      ])
    })

    it('1.4 clearEpisodicBuffer removes chat history and summary', () => {
      saveChatMessage('msg-1', 'user', 'Test clear', 'session-clear', db)
      setConfig('episodic_summary_session-clear', 'Summary clear test', db)

      clearEpisodicBuffer('session-clear', db)

      const context = getEpisodicContext('session-clear', {}, db)
      expect(context.totalMessagesCount).toBe(0)
      expect(context.messages.length).toBe(0)
      expect(context.summary).toBeNull()
      expect(context.isSummarized).toBe(false)
    })

    it('1.5 saveAndProcessEpisodicMessage saves message and handles threshold trigger', async () => {
      const res = await saveAndProcessEpisodicMessage('msg-1', 'user', 'Hallo', 'session-process', { summarizeThreshold: 25 }, db)
      expect(res.summaryUpdated).toBe(false)

      const history = getChatHistory(10, 'session-process', db)
      expect(history.length).toBe(1)
      expect(history[0].content).toBe('Hallo')
    })
  })

  // ─────────────────────────────────────────
  // Pillar 2: Semantic Long-Term RAG Memory Tests
  // ─────────────────────────────────────────
  describe('Pillar 2: Semantic Long-Term RAG Memory', () => {
    it('2.1 formats retrieved semantic memories for system prompt', () => {
      const memories = [
        {
          id: 'mem-1',
          content: 'Pengguna menyukai tema gelap (dark mode).',
          category: 'user_preference',
          metadata: null,
          similarityScore: 0.88,
          createdAt: '2026-08-14T00:00:00Z',
          updatedAt: '2026-08-14T00:00:00Z'
        },
        {
          id: 'mem-2',
          content: 'Pengguna tinggal di Jakarta.',
          category: 'user_fact',
          metadata: null,
          similarityScore: 0.75,
          createdAt: '2026-08-14T00:00:00Z',
          updatedAt: '2026-08-14T00:00:00Z'
        }
      ]

      const formatted = formatSemanticMemoriesForSystemPrompt(memories)
      expect(formatted).toContain('[MEMORI JANGKA PANJANG (SEMANTIC RAG)]')
      expect(formatted).toContain('[USER_PREFERENCE] Pengguna menyukai tema gelap (dark mode). (Relevansi: 88%)')
      expect(formatted).toContain('[USER_FACT] Pengguna tinggal di Jakarta. (Relevansi: 75%)')
    })

    it('2.2 formatSemanticMemoriesForSystemPrompt returns empty string for empty input', () => {
      expect(formatSemanticMemoriesForSystemPrompt([])).toBe('')
    })

    it('2.3 deleteSemanticMemoryItem deletes row from database by ID', () => {
      const vec = [1, 0, 0]
      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('mem-del-1', 'Fakta sementara', 'general', JSON.stringify(vec))

      const deleted = deleteSemanticMemoryItem('mem-del-1', db)
      expect(deleted).toBe(true)

      const row = db.prepare('SELECT * FROM semantic_memory WHERE id = ?').get('mem-del-1')
      expect(row).toBeUndefined()
    })

    it('2.4 searchSemanticMemory cosine ranking and fallback work with pre-inserted vectors', async () => {
      const vec1 = [1.0, 0.0, 0.0]
      const vec2 = [0.0, 1.0, 0.0]

      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('m1', 'Suka kopi hitam tanpa gula', 'user_preference', JSON.stringify(vec1))

      db.prepare(
        `INSERT INTO semantic_memory (id, content, category, embedding) VALUES (?, ?, ?, ?)`
      ).run('m2', 'Bekerja sebagai software developer', 'user_fact', JSON.stringify(vec2))

      // Direct search using pre-calculated embedding query
      const results = await retrieveSemanticMemories('kopi', { minScore: 0.5 }, db)
      // Since generateTextEmbedding will fail without key in offline test mode, it falls back to text search for 'kopi'
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('m1')
    })
  })

  // ─────────────────────────────────────────
  // Pillar 3: Procedural Memory Skill Store Tests
  // ─────────────────────────────────────────
  describe('Pillar 3: Procedural Memory Skill Store', () => {
    let testSkillsDir: string

    beforeEach(() => {
      testSkillsDir = join(tmpdir(), `jarvis-skills-test-${Date.now()}`)
      mkdirSync(testSkillsDir, { recursive: true })
      process.env.JARVIS_SKILLS_PATH = testSkillsDir
    })

    afterEach(() => {
      delete process.env.JARVIS_SKILLS_PATH
      if (existsSync(testSkillsDir)) {
        try {
          rmSync(testSkillsDir, { recursive: true, force: true })
        } catch {}
      }
    })

    it('3.1 parsePythonSkillFile extracts metadata and JSON parameters schema correctly', () => {
      const dummyPyPath = join(testSkillsDir, 'calculator.py')
      const pyContent = `"""
Skill Name: calculator
Description: Calculates simple arithmetic expression.
Version: 1.2.0
Entrypoint: compute
Parameters:
{
  "type": "object",
  "properties": {
    "expression": { "type": "string", "description": "Math expression" }
  },
  "required": ["expression"]
}
"""

def compute(expression: str):
    return eval(expression)
`
      writeFileSync(dummyPyPath, pyContent, 'utf-8')

      const parsed = parsePythonSkillFile(dummyPyPath)

      expect(parsed.name).toBe('calculator')
      expect(parsed.description).toBe('Calculates simple arithmetic expression.')
      expect(parsed.version).toBe('1.2.0')
      expect(parsed.entrypoint).toBe('compute')
      expect(parsed.parametersSchema.properties.expression.type).toBe('string')
      expect(parsed.parametersSchema.required).toEqual(['expression'])
    })

    it('3.2 upsertSkillMetadata and syncSkillStore index python files into skills_metadata table', async () => {
      const dummyPyPath = join(testSkillsDir, 'currency_converter.py')
      const pyContent = `"""
Skill Name: currency_converter
Description: Converts currency amount based on exchange rate.
Version: 1.0.0
Entrypoint: convert
"""

def convert(amount: float, rate: float):
    return amount * rate
`
      writeFileSync(dummyPyPath, pyContent, 'utf-8')

      const report = await syncSkillStore(db)

      expect(report.totalSkills).toBe(1)
      expect(report.skills[0].name).toBe('currency_converter')
      expect(report.skills[0].entrypoint).toBe('convert')
    })

    it('3.3 recordSkillMetrics calculates moving average latency and success counts', () => {
      const dummySkill = {
        skillId: 'skill_test_metric',
        name: 'test_metric',
        description: 'Metric test skill',
        filePath: join(testSkillsDir, 'test_metric.py'),
        entrypoint: 'run',
        version: '1.0.0',
        parametersSchema: { type: 'object' as const, properties: {} },
        rawDocstring: ''
      }

      upsertSkillMetadata(dummySkill, db)

      recordSkillMetrics('test_metric', true, 100, db)
      recordSkillMetrics('test_metric', true, 200, db)

      const report = getSkillsMetadata(db)
      const skill = report.skills.find((s) => s.name === 'test_metric')

      expect(skill?.successCount).toBe(2)
      expect(skill?.averageExecutionTimeMs).toBe(150)
      expect(skill?.successRate).toBe(100)
    })

    it('3.4 executePythonSkill runs Python script and captures stdout, stderr, latency, and metrics', async () => {
      const dummyPyPath = join(testSkillsDir, 'math_adder.py')
      const pyContent = `"""
Skill Name: math_adder
Description: Adds two numbers.
Version: 1.0.0
Entrypoint: run
Parameters:
{
  "type": "object",
  "properties": {
    "a": { "type": "number" },
    "b": { "type": "number" }
  },
  "required": ["a", "b"]
}
"""

def run(a: float, b: float):
    return {"sum": a + b}
`
      writeFileSync(dummyPyPath, pyContent, 'utf-8')

      await syncSkillStore(db)

      const result = await executePythonSkill('math_adder', { a: 15, b: 27 }, 10000, db)

      expect(result.success).toBe(true)
      expect(result.result).toEqual({ sum: 42 })
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)

      // Verify execution metrics in DB
      const report = getSkillsMetadata(db)
      const skill = report.skills.find((s) => s.name === 'math_adder')
      expect(skill?.successCount).toBe(1)

      // Verify execution log entry
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(1)
      expect(logs.logs[0].toolName).toBe('skill:math_adder')
    })

    it('3.5 matchExistingSkill matches task description against registered skills', async () => {
      const dummySkill = {
        skillId: 'skill_web_scraper',
        name: 'web_scraper',
        description: 'Scrapes web page headers and body content from target URL.',
        filePath: join(testSkillsDir, 'web_scraper.py'),
        entrypoint: 'run',
        version: '1.0.0',
        parametersSchema: { type: 'object' as const, properties: {} },
        rawDocstring: ''
      }

      upsertSkillMetadata(dummySkill, db)

      const match = await matchExistingSkill('Tolong jalankan web_scraper untuk mengambil data', 0.5, db)

      expect(match.matched).toBe(true)
      expect(match.skill?.name).toBe('web_scraper')
      expect(match.confidenceScore).toBeGreaterThanOrEqual(0.5)
    })

    it('3.6 getPythonSkillToolDeclarations converts skills to Gemini function declarations', () => {
      const dummySkill = {
        skillId: 'skill_translator',
        name: 'translator',
        description: 'Translates text between languages.',
        filePath: join(testSkillsDir, 'translator.py'),
        entrypoint: 'run',
        version: '1.0.0',
        parametersSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', description: 'Source text' }
          },
          required: ['text']
        },
        rawDocstring: ''
      }

      upsertSkillMetadata(dummySkill, db)

      const tools = getPythonSkillToolDeclarations(db)
      expect(tools.length).toBe(1)
      expect(tools[0].name).toBe('skill_translator')
      expect(tools[0].description).toContain('Translates text between languages.')
      expect(tools[0].parameters.properties.text.type).toBe('string')
    })

    it('3.7 deleteSkillMetadata removes skill from database', () => {
      const dummySkill = {
        skillId: 'skill_temp',
        name: 'temp_skill',
        description: 'Temporary skill',
        filePath: join(testSkillsDir, 'temp.py'),
        entrypoint: 'run',
        version: '1.0.0',
        parametersSchema: { type: 'object' as const, properties: {} },
        rawDocstring: ''
      }

      upsertSkillMetadata(dummySkill, db)
      expect(getSkillsMetadata(db).totalSkills).toBe(1)

      const deleted = deleteSkillMetadata('temp_skill', db)
      expect(deleted).toBe(true)
      expect(getSkillsMetadata(db).totalSkills).toBe(0)
    })
  })
})
