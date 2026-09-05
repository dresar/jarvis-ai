/**
 * Milestone 4 Test Suite: Closed Learning Loop & Autonomous Self-Evaluation / Skill Serialization
 * (`test/main/learning.test.ts`)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { initializeSchema, getExecutionLogs, getSkillsMetadata } from '../../src/main/database'
import {
  evaluateExecutionResult,
  EvaluationResult
} from '../../src/main/learning/selfEvaluator'
import {
  sanitizeSkillName,
  cleanPythonCode,
  formatSkillDocstring,
  serializeSkill
} from '../../src/main/learning/skillSerializer'
import {
  sanitizePythonCode,
  executeTempPythonCode,
  logAutoDebugAttempt,
  runAutoDebuggingLoop
} from '../../src/main/learning/autoDebugger'
import { processPythonSkillWithLearningLoop } from '../../src/main/ai'
import { getSkillsDirectory, parsePythonSkillFile } from '../../src/main/memory/skillStore'
import * as keyPoolManager from '../../src/main/keyPoolManager'

describe('Milestone 4: Closed Learning Loop & Skill Evolution Engine', () => {
  let db: Database.Database
  const createdFiles: string[] = []

  beforeEach(() => {
    db = new Database(':memory:')
    initializeSchema(db)
  })

  afterEach(() => {
    // Cleanup temp test skill files
    for (const file of createdFiles) {
      if (existsSync(file)) {
        try { unlinkSync(file) } catch {}
      }
    }
    createdFiles.length = 0
    if (db) db.close()
    vi.restoreAllMocks()
  })

  // ─────────────────────────────────────────
  // 1. Autonomous Self-Evaluator
  // ─────────────────────────────────────────
  describe('1. Self-Evaluator Subsystem (selfEvaluator.ts)', () => {
    it('1.1 evaluates execution result using executeWithKeyRotation and clamps score', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        JSON.stringify({
          success: true,
          score: 0.95,
          feedback: 'Output correctly matches prompt',
          reusableSkillName: 'test_calculator'
        })
      )

      const res = await evaluateExecutionResult(
        'Calculate 2 + 2',
        'calculator',
        'Result is 4',
        undefined,
        { customDb: db, threshold: 0.70 }
      )

      expect(res.success).toBe(true)
      expect(res.score).toBe(0.95)
      expect(res.feedback).toBe('Output correctly matches prompt')
      expect(res.reusableSkillName).toBe('test_calculator')

      // Verify DB log
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(1)
      expect(logs.logs[0].toolName).toBe('eval:calculator')
    })

    it('1.2 sanitizes reusableSkillName to valid lowercase snake_case', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        JSON.stringify({
          success: true,
          score: 0.85,
          feedback: 'Great reusable tool',
          reusableSkillName: '  My Cool-Tool! 123  '
        })
      )

      const res = await evaluateExecutionResult(
        'Parse CSV data',
        'csv_parser',
        'Parsed 10 rows',
        undefined,
        { customDb: db }
      )

      expect(res.reusableSkillName).toBe('my_cool_tool_123')
    })

    it('1.3 triggers fallback evaluation when executeWithKeyRotation throws error', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockRejectedValue(
        new Error('API Key pool exhausted')
      )

      const res = await evaluateExecutionResult(
        'Fetch weather',
        'weather_tool',
        'Temperature is 25C',
        undefined,
        { customDb: db }
      )

      expect(res.success).toBe(true)
      expect(res.score).toBe(0.75)
      expect(res.feedback).toContain('Evaluation fallback triggered')

      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(1)
    })

    it('1.4 triggers fallback evaluation failure if stderr contains fatal errors', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockRejectedValue(
        new Error('API call failure')
      )

      const res = await evaluateExecutionResult(
        'Execute script',
        'python_tool',
        '',
        'Traceback (most recent call last):\nValueError: invalid input',
        { customDb: db }
      )

      expect(res.success).toBe(false)
      expect(res.score).toBe(0.0)
    })
  })

  // ─────────────────────────────────────────
  // 2. Skill Serialization & Formatting
  // ─────────────────────────────────────────
  describe('2. Skill Serializer Subsystem (skillSerializer.ts)', () => {
    it('2.1 sanitizeSkillName cleans raw inputs and handles Python reserved keywords', () => {
      expect(sanitizeSkillName('My New Skill! ')).toBe('my_new_skill')
      expect(sanitizeSkillName('123_invalid')).toMatch(/^skill_/)
      expect(sanitizeSkillName('sys')).toBe('custom_sys')
      expect(sanitizeSkillName('json')).toBe('custom_json')
    })

    it('2.2 cleanPythonCode strips markdown fences and adds required imports/entrypoint', () => {
      const raw = '```python\ndef calculate(a, b):\n    return a + b\n```'
      const cleaned = cleanPythonCode(raw)

      expect(cleaned).toContain('import json')
      expect(cleaned).toContain('import sys')
      expect(cleaned).toContain('def run(**kwargs):')
      expect(cleaned).not.toContain('```')
    })

    it('2.3 formatSkillDocstring creates headers compatible with parsePythonSkillFile', () => {
      const docstring = formatSkillDocstring(
        'data_cleaner',
        'Cleans raw text data',
        { type: 'object', properties: { text: { type: 'string' } } },
        '1.1.0'
      )

      expect(docstring).toContain('Skill Name: data_cleaner')
      expect(docstring).toContain('Description: Cleans raw text data')
      expect(docstring).toContain('Entrypoint: run')
      expect(docstring).toContain('Version: 1.1.0')
      expect(docstring).toContain('Parameters:')
    })

    it('2.4 serializeSkill writes .py file, parses metadata, and upserts into SQLite skills_metadata', async () => {
      const skillName = 'test_serializer_skill'
      const code = `
def run(**kwargs):
    return {"status": "ok", "value": 42}
`
      const filePath = await serializeSkill(
        skillName,
        code,
        'Test skill serialization',
        { type: 'object', properties: {} },
        { customDb: db, version: '1.0.0' }
      )
      createdFiles.push(filePath)

      expect(existsSync(filePath)).toBe(true)

      // Verify file header docstring parsing
      const parsed = parsePythonSkillFile(filePath)
      expect(parsed.name).toBe('test_serializer_skill')
      expect(parsed.entrypoint).toBe('run')

      // Verify SQLite skills_metadata upsert
      const metadata = getSkillsMetadata(db)
      expect(metadata.totalSkills).toBe(1)
      expect(metadata.skills[0].name).toBe('test_serializer_skill')

      // Verify execution_logs log
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(1)
      expect(logs.logs[0].toolName).toBe('serialize_skill:test_serializer_skill')
    })
  })

  // ─────────────────────────────────────────
  // 3. Bounded Auto-Debugging Loop
  // ─────────────────────────────────────────
  describe('3. Auto-Debugger Subsystem (autoDebugger.ts)', () => {
    it('3.1 sanitizePythonCode strips backticks and markdown wrappers', () => {
      expect(sanitizePythonCode('```python\nprint("hello")\n```')).toBe('print("hello")')
      expect(sanitizePythonCode('```\nx = 10\n```')).toBe('x = 10')
      expect(sanitizePythonCode('   x = 5   ')).toBe('x = 5')
      expect(sanitizePythonCode('')).toBe('')
    })

    it('3.2 executeTempPythonCode executes valid Python script and captures output', async () => {
      const validCode = `
def run(**kwargs):
    return {"output": "Hello from Python"}
`
      const res = await executeTempPythonCode(validCode)
      expect(res.success).toBe(true)
      expect(res.result).toEqual({ output: 'Hello from Python' })
    })

    it('3.3 executeTempPythonCode handles failing Python code and returns error', async () => {
      const failingCode = `
def run(**kwargs):
    raise ValueError("Explicit test error")
`
      const res = await executeTempPythonCode(failingCode)
      expect(res.success).toBe(false)
      expect(res.error).toContain('ValueError: Explicit test error')
    })

    it('3.4 logAutoDebugAttempt writes attempt record to SQLite execution_logs', () => {
      logAutoDebugAttempt(1, 'SUCCESS', null, 'def run(): return 1', 120, db)
      logAutoDebugAttempt(2, 'ERROR', 'SyntaxError: invalid syntax', 'def run(): error', 200, db)

      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(2)

      const attempt1 = logs.logs.find((l) => l.toolName === 'auto_debugger:attempt_1')
      expect(attempt1).toBeDefined()
      expect(attempt1?.status).toBe('SUCCESS')
      expect(attempt1?.model).toBe('gemini-2.5-flash')

      const attempt2 = logs.logs.find((l) => l.toolName === 'auto_debugger:attempt_2')
      expect(attempt2).toBeDefined()
      expect(attempt2?.status).toBe('ERROR')
      expect(attempt2?.errorMessage).toBe('SyntaxError: invalid syntax')
    })

    it('3.5 runAutoDebuggingLoop terminates after maxRetries = 3 when repairs fail', async () => {
      // Mock executeWithKeyRotation to return code that will fail execution test
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        '```python\ndef run():\n    raise RuntimeError("Persistent bug")\n```'
      )

      const result = await runAutoDebuggingLoop(
        'Fix calculation script',
        'def run(): broken',
        'SyntaxError: invalid syntax',
        3,
        db
      )

      expect(result.success).toBe(false)
      expect(result.attempts).toBe(3)
      expect(result.errorLog.length).toBeGreaterThanOrEqual(3)

      // Check DB logs count (3 attempts)
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(3)
    })

    it('3.6 runAutoDebuggingLoop succeeds early if Gemini provides fixed code on attempt 1', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        '```python\ndef run(**kwargs):\n    return {"status": "fixed"}\n```'
      )

      const result = await runAutoDebuggingLoop(
        'Fix calculation script',
        'def run(): broken',
        'SyntaxError: invalid syntax',
        3,
        db
      )

      expect(result.success).toBe(true)
      expect(result.attempts).toBe(1)
      expect(result.finalCode).toContain('def run(**kwargs):')

      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(1)
      expect(logs.logs[0].status).toBe('SUCCESS')
    })
  })

  // ─────────────────────────────────────────
  // 4. Closed Learning Loop Integration
  // ─────────────────────────────────────────
  describe('4. Closed Learning Loop Integration (ai.ts)', () => {
    it('4.1 processPythonSkillWithLearningLoop completes full flow: execution -> evaluation -> serialization', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        JSON.stringify({
          success: true,
          score: 0.90,
          feedback: 'Function works perfectly',
          reusableSkillName: 'test_integration_skill'
        })
      )

      const validCode = `
def run(**kwargs):
    return {"message": "integration success"}
`

      const result = await processPythonSkillWithLearningLoop(
        'Run integration test',
        'test_integration_skill',
        validCode,
        {},
        { customDb: db }
      )

      expect(result.success).toBe(true)
      expect(result.skillSaved).toBe(true)
      expect(result.evaluation.score).toBe(0.90)

      // Track created file for cleanup
      const skillsDir = getSkillsDirectory()
      const createdPath = join(skillsDir, 'test_integration_skill.py')
      createdFiles.push(createdPath)

      expect(existsSync(createdPath)).toBe(true)
    })
  })
})
