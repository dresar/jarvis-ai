/**
 * Empirical Challenger Edge-Case Test Harness for autoDebugger.ts
 * (`test/main/autoDebugger.edge.test.ts`)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'fs'
import { initializeSchema, getExecutionLogs } from '../../src/main/database'
import {
  sanitizePythonCode,
  executeTempPythonCode,
  logAutoDebugAttempt,
  runAutoDebuggingLoop
} from '../../src/main/learning/autoDebugger'
import * as keyPoolManager from '../../src/main/keyPoolManager'

describe('Empirical Challenger: Edge Case & Stress Harness for autoDebugger.ts', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeSchema(db)
  })

  afterEach(() => {
    if (db) db.close()
    vi.restoreAllMocks()
  })

  // ─────────────────────────────────────────────────────────
  // Edge Case 1: Infinite Loop Timeout in Python Snippet
  // ─────────────────────────────────────────────────────────
  describe('1. Infinite Loop & Execution Timeout', () => {
    it('1.1 executeTempPythonCode times out cleanly when script runs in infinite loop', async () => {
      const infiniteLoopCode = `
import time
def run(**kwargs):
    while True:
        time.sleep(0.01)
`
      const startTime = performance.now()
      // Use short timeout of 800ms
      const res = await executeTempPythonCode(infiniteLoopCode, {}, 800)
      const elapsed = performance.now() - startTime

      expect(res.success).toBe(false)
      expect(elapsed).toBeLessThan(3000) // Must terminate near timeout, not hang forever
      expect(res.error).toBeDefined()
    })

    it('1.2 runAutoDebuggingLoop handles timeout during code evaluation and continues loop', async () => {
      let callCount = 0
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          // Attempt 1: Infinite loop script
          return '```python\nimport time\ndef run():\n    while True:\n        time.sleep(0.05)\n```'
        }
        // Attempt 2: Fixed script
        return '```python\ndef run(**kwargs):\n    return {"status": "fixed_after_timeout"}\n```'
      })

      // We need executeTempPythonCode to use a short timeout in tests, but runAutoDebuggingLoop uses default 15000ms.
      // Let's test with infinite loop code that executes quickly or mock executeTempPythonCode if needed.
      // Wait, let's test executeTempPythonCode directly for timeouts, and test loop behavior.
      const result = await runAutoDebuggingLoop(
        'Fix endless loop',
        'def run(): pass',
        'Initial error',
        2,
        db
      )

      // Call 1 was infinite loop (or whatever was returned), call 2 was fixed.
      // If attempt 1 timed out (or if default timeout 15000ms is used, wait - 15000ms is 15s).
      // Let's verify result!
      expect(result.success).toBe(true)
      expect(result.attempts).toBe(2)
      expect(result.finalCode).toContain('fixed_after_timeout')
    }, 20000)
  })

  // ─────────────────────────────────────────────────────────
  // Edge Case 2: Empty Response from LLM
  // ─────────────────────────────────────────────────────────
  describe('2. Empty Response from LLM Handling', () => {
    it('2.1 sanitizePythonCode returns empty string for empty / whitespace / empty block inputs', () => {
      expect(sanitizePythonCode('')).toBe('')
      expect(sanitizePythonCode('   ')).toBe('')
      expect(sanitizePythonCode('\n\n\t')).toBe('')
      expect(sanitizePythonCode('```python\n```')).toBe('')
      expect(sanitizePythonCode('```py\n  \n```')).toBe('')
      expect(sanitizePythonCode('```\n```')).toBe('')
    })

    it('2.2 runAutoDebuggingLoop handles empty LLM output by logging error and retrying', async () => {
      let callCount = 0
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        callCount++
        if (callCount === 1) return '' // Empty string
        if (callCount === 2) return '   ' // Whitespace
        if (callCount === 3) return '```python\n```' // Empty block
        return '```python\ndef run():\n    return 42\n```'
      })

      const result = await runAutoDebuggingLoop(
        'Do math',
        'def run(): broken',
        'SyntaxError',
        3, // maxRetries = 3
        db
      )

      expect(result.success).toBe(false)
      expect(result.attempts).toBe(3)
      expect(result.errorLog).toContain('Attempt 1: LLM generated empty code response.')
      expect(result.errorLog).toContain('Attempt 2: LLM generated empty code response.')
      expect(result.errorLog).toContain('Attempt 3: LLM generated empty code response.')

      // Check DB logs
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(3)
      expect(logs.logs.every((l) => l.status === 'ERROR')).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────
  // Edge Case 3: maxRetries Bounding Enforcement
  // ─────────────────────────────────────────────────────────
  describe('3. Bounded Retry Enforcement (maxRetries)', () => {
    it('3.1 strictly enforces maxRetries = 1', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        '```python\ndef run():\n    raise ValueError("Always fails")\n```'
      )

      const result = await runAutoDebuggingLoop(
        'Task prompt',
        'original code',
        'initial error',
        1,
        db
      )

      expect(result.success).toBe(false)
      expect(result.attempts).toBe(1)
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(1)
    })

    it('3.2 strictly enforces maxRetries = 3', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        '```python\ndef run():\n    raise ValueError("Always fails")\n```'
      )

      const result = await runAutoDebuggingLoop(
        'Task prompt',
        'original code',
        'initial error',
        3,
        db
      )

      expect(result.success).toBe(false)
      expect(result.attempts).toBe(3)
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(3)
      expect(logs.logs.map((l) => l.toolName).sort()).toEqual([
        'auto_debugger:attempt_1',
        'auto_debugger:attempt_2',
        'auto_debugger:attempt_3'
      ])
    })

    it('3.3 strictly enforces maxRetries = 5', async () => {
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockResolvedValue(
        '```python\ndef run():\n    raise ValueError("Always fails")\n```'
      )

      const result = await runAutoDebuggingLoop(
        'Task prompt',
        'original code',
        'initial error',
        5,
        db
      )

      expect(result.success).toBe(false)
      expect(result.attempts).toBe(5)
      const logs = getExecutionLogs({}, db)
      expect(logs.totalCount).toBe(5)
    })
  })

  // ─────────────────────────────────────────────────────────
  // Edge Case 4: Invalid Syntax & Runtime Exception Handling
  // ─────────────────────────────────────────────────────────
  describe('4. Invalid Syntax & Python Runtime Errors', () => {
    it('4.1 executeTempPythonCode captures SyntaxError and returns traceback', async () => {
      const invalidSyntaxCode = `
def run(**kwargs):
    if True
        print("Missing colon")
`
      const res = await executeTempPythonCode(invalidSyntaxCode)
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/SyntaxError/i)
      expect(res.stderr).toMatch(/SyntaxError/i)
    })

    it('4.2 executeTempPythonCode handles missing entrypoint function', async () => {
      const noEntrypointCode = `
x = 10
y = 20
`
      const res = await executeTempPythonCode(noEntrypointCode)
      expect(res.success).toBe(false)
      expect(res.error).toContain('No entrypoint function')
    })

    it('4.3 executeTempPythonCode captures ZeroDivisionError traceback', async () => {
      const runtimeErrorCode = `
def run(**kwargs):
    return 1 / 0
`
      const res = await executeTempPythonCode(runtimeErrorCode)
      expect(res.success).toBe(false)
      expect(res.error).toContain('ZeroDivisionError')
    })

    it('4.4 runAutoDebuggingLoop captures SyntaxError and feeds it into repair prompt for subsequent attempts', async () => {
      let callCount = 0

      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return '```python\ndef run():\n    if True\n        return 1\n```'
        } else {
          return '```python\ndef run(**kwargs):\n    return {"fixed": True}\n```'
        }
      })

      const result = await runAutoDebuggingLoop(
        'Syntax repair prompt',
        'def run(): broken',
        'Initial error',
        2,
        db
      )

      expect(result.success).toBe(true)
      expect(result.attempts).toBe(2)
      expect(result.errorLog.some((err) => err.includes('SyntaxError'))).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────
  // Edge Case 5: Gemini API Failure Recovery
  // ─────────────────────────────────────────────────────────
  describe('5. Gemini API Exception & Recovery', () => {
    it('5.1 runAutoDebuggingLoop handles keyRotation API failures gracefully', async () => {
      let callCount = 0
      vi.spyOn(keyPoolManager, 'executeWithKeyRotation').mockImplementation(async () => {
        callCount++
        if (callCount === 1) throw new Error('HTTP 429 Rate Limit Exceeded')
        return '```python\ndef run(**kwargs):\n    return {"status": "recovered"}\n```'
      })

      const result = await runAutoDebuggingLoop(
        'Task prompt',
        'def run(): code',
        'initial error',
        2,
        db
      )

      expect(result.success).toBe(true)
      expect(result.attempts).toBe(2)
      expect(result.errorLog[1]).toContain('HTTP 429 Rate Limit Exceeded')
    })
  })
})
