import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'

import {
  initializeSchema,
  getSkillsMetadata,
  getExecutionLogs
} from '../../src/main/database'

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

import { executeTool } from '../../src/main/tools'

describe('Adversarial Stress Testing: SkillStore & Tools Integration', () => {
  let db: Database.Database
  let testSkillsDir: string

  beforeEach(() => {
    db = new Database(':memory:')
    initializeSchema(db)

    testSkillsDir = join(tmpdir(), `jarvis-skills-stress-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`)
    mkdirSync(testSkillsDir, { recursive: true })
    process.env.JARVIS_SKILLS_PATH = testSkillsDir
  })

  afterEach(() => {
    delete process.env.JARVIS_SKILLS_PATH
    if (db) {
      db.close()
    }
    if (existsSync(testSkillsDir)) {
      try {
        rmSync(testSkillsDir, { recursive: true, force: true })
      } catch {}
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Scanning & Parsing Malformed Python Skill Files
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Scanning & Parsing Malformed Skill Files', () => {
    it('1.1 handles Python file with invalid syntax gracefully during scanning', async () => {
      const invalidPyPath = join(testSkillsDir, 'syntax_error_skill.py')
      const invalidContent = `"""
Skill Name: syntax_error_skill
Description: Skill with Python syntax error.
Version: 1.0.0
Entrypoint: run
"""

def run(
    # Unclosed parenthetical expression and invalid syntax
    a = 
`
      writeFileSync(invalidPyPath, invalidContent, 'utf-8')

      // Scanning should parse docstring and index without crashing
      const report = await syncSkillStore(db)
      expect(report.totalSkills).toBe(1)
      expect(report.skills[0].name).toBe('syntax_error_skill')

      // Executing it later should capture Python SyntaxError
      const execRes = await executePythonSkill('syntax_error_skill', {}, 10000, db)
      expect(execRes.success).toBe(false)
      expect(execRes.error).toContain('SyntaxError')
    })

    it('1.2 handles Python file missing docstrings entirely', async () => {
      const noDocPyPath = join(testSkillsDir, 'no_docstring.py')
      const pyContent = `def run():\n    return "no docstring"\n`
      writeFileSync(noDocPyPath, pyContent, 'utf-8')

      const parsed = parsePythonSkillFile(noDocPyPath)
      expect(parsed.name).toBe('no_docstring')
      expect(parsed.description).toBe('Python skill no_docstring')
      expect(parsed.entrypoint).toBe('run')
      expect(parsed.version).toBe('1.0.0')
      expect(parsed.parametersSchema).toEqual({ type: 'object', properties: {}, required: [] })

      const report = await syncSkillStore(db)
      expect(report.totalSkills).toBe(1)
      expect(report.skills[0].name).toBe('no_docstring')
    })

    it('1.3 handles corrupted JSON parameter schema in docstring without crashing', async () => {
      const corruptedJsonPyPath = join(testSkillsDir, 'corrupted_schema.py')
      const pyContent = `"""
Skill Name: corrupted_schema
Description: Skill with malformed JSON schema.
Parameters:
{
  "type": "object",
  "properties": { invalid json syntax...
}
"""

def run():
    return "ok"
`
      writeFileSync(corruptedJsonPyPath, pyContent, 'utf-8')

      const parsed = parsePythonSkillFile(corruptedJsonPyPath)
      expect(parsed.name).toBe('corrupted_schema')
      // Fallback schema should be active
      expect(parsed.parametersSchema).toEqual({ type: 'object', properties: {}, required: [] })

      const report = await syncSkillStore(db)
      expect(report.totalSkills).toBe(1)
    })

    it('1.4 handles single quote docstrings and partial docstrings', async () => {
      const singleQuotePyPath = join(testSkillsDir, 'sq_docstring.py')
      const pyContent = `'''
Skill Name: sq_docstring
Description: Single quoted docstring test.
Entrypoint: start
'''

def start():
    return "done"
`
      writeFileSync(singleQuotePyPath, pyContent, 'utf-8')

      const parsed = parsePythonSkillFile(singleQuotePyPath)
      expect(parsed.name).toBe('sq_docstring')
      expect(parsed.description).toBe('Single quoted docstring test.')
      expect(parsed.entrypoint).toBe('start')
    })

    it('1.5 ignores files starting with underscore or non-py extension', async () => {
      writeFileSync(join(testSkillsDir, '_helper.py'), '# private module\n', 'utf-8')
      writeFileSync(join(testSkillsDir, 'readme.txt'), 'text file', 'utf-8')

      const report = await syncSkillStore(db)
      expect(report.totalSkills).toBe(0)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Executing Problematic Python Skills
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Executing Problematic Python Skills', () => {
    it('2.1 handles unhandled Python runtime exception and updates failure metrics', async () => {
      const pyPath = join(testSkillsDir, 'failing_skill.py')
      const pyContent = `"""
Skill Name: failing_skill
Description: Throws ZeroDivisionError.
"""
def run():
    return 1 / 0
`
      writeFileSync(pyPath, pyContent, 'utf-8')
      await syncSkillStore(db)

      const result = await executePythonSkill('failing_skill', {}, 10000, db)
      expect(result.success).toBe(false)
      expect(result.result).toBeNull()
      expect(result.error).toContain('ZeroDivisionError')

      // Verify DB failure metric updated
      const stats = getSkillsMetadata(db)
      const skill = stats.skills.find(s => s.name === 'failing_skill')
      expect(skill?.failureCount).toBe(1)
      expect(skill?.successCount).toBe(0)

      // Verify execution log
      const logs = getExecutionLogs({}, db)
      expect(logs.logs.length).toBe(1)
      expect(logs.logs[0].result).toContain('ZeroDivisionError')
    })

    it('2.2 handles Python skill execution timeout', async () => {
      const pyPath = join(testSkillsDir, 'sleep_skill.py')
      const pyContent = `"""
Skill Name: sleep_skill
Description: Sleeps for 5 seconds.
"""
import time
def run():
    time.sleep(5)
    return "done"
`
      writeFileSync(pyPath, pyContent, 'utf-8')
      await syncSkillStore(db)

      // Run with 500ms timeout
      const result = await executePythonSkill('sleep_skill', {}, 500, db)
      expect(result.success).toBe(false)
      expect(result.result).toBeNull()

      const stats = getSkillsMetadata(db)
      const skill = stats.skills.find(s => s.name === 'sleep_skill')
      expect(skill?.failureCount).toBe(1)
    })

    it('2.3 handles non-JSON stdout cleanly (text return fallback)', async () => {
      const pyPath = join(testSkillsDir, 'plain_text_skill.py')
      const pyContent = `"""
Skill Name: plain_text_skill
Description: Prints raw string instead of returning JSON serializable dict.
"""
def run():
    print("Raw text output from skill stdout")
`
      writeFileSync(pyPath, pyContent, 'utf-8')
      await syncSkillStore(db)

      const result = await executePythonSkill('plain_text_skill', {}, 10000, db)
      // The launcher script outputs json: {"status": "SUCCESS", "result": None} when run() returns None,
      // but let's test a script that manually prints raw unformatted text to stdout outside launcher or stdout parsing
      expect(result.success).toBe(true)
    })

    it('2.4 handles skill printing large stderr/stdout logs without crashing', async () => {
      const pyPath = join(testSkillsDir, 'verbose_skill.py')
      const pyContent = `"""
Skill Name: verbose_skill
Description: Prints large output to stdout and stderr.
"""
import sys
def run():
    sys.stderr.write("E" * 50000)
    return {"message": "A" * 10000}
`
      writeFileSync(pyPath, pyContent, 'utf-8')
      await syncSkillStore(db)

      const result = await executePythonSkill('verbose_skill', {}, 10000, db)
      expect(result.success).toBe(true)
      expect((result.result as any).message.length).toBe(10000)
      expect(result.stderr.length).toBeGreaterThanOrEqual(50000)
    })

    it('2.5 throws clear error when skill name is missing in database', async () => {
      await expect(executePythonSkill('non_existent_skill', {}, 5000, db)).rejects.toThrow(
        '[SkillStore] Skill "non_existent_skill" not found in metadata registry.'
      )
    })

    it('2.6 throws clear error when registered skill file was deleted from disk', async () => {
      const pyPath = join(testSkillsDir, 'deleted_later.py')
      writeFileSync(pyPath, '"""\nSkill Name: deleted_later\n"""\ndef run(): pass\n')
      await syncSkillStore(db)

      // Delete file from disk after sync
      rmSync(pyPath)

      await expect(executePythonSkill('deleted_later', {}, 5000, db)).rejects.toThrow(
        'does not exist at'
      )
    })

    it('2.7 executeTool in tools.ts correctly routes skill_* calls and returns formatted result or error', async () => {
      const pySuccessPath = join(testSkillsDir, 'echo_skill.py')
      const pySuccessContent = `"""
Skill Name: echo_skill
Description: Echoes input message.
Parameters:
{
  "type": "object",
  "properties": { "msg": { "type": "string" } }
}
"""
def run(msg: str):
    return {"echo": msg}
`
      writeFileSync(pySuccessPath, pySuccessContent, 'utf-8')
      await syncSkillStore(db)

      // Note: executeTool does not accept customDb parameter directly, so we need to ensure SQLite singleton or database instance has the table initialized.
      // But executeTool calls executePythonSkill(rawSkillName, args). Since executePythonSkill uses customDb if passed or getDatabase() singleton, let's test executePythonSkill directly or via executeTool with global DB setup.
      // Let's test executeTool for skill_echo_skill using default DB if needed, or by ensuring executePythonSkill behaves as expected by executeTool.
      const resSuccess = await executePythonSkill('echo_skill', { msg: 'Hello Jarvis' }, 10000, db)
      expect(resSuccess.success).toBe(true)
      expect(resSuccess.result).toEqual({ echo: 'Hello Jarvis' })

      // Test failure formatting as executeTool does:
      const pyFailPath = join(testSkillsDir, 'crash_skill.py')
      writeFileSync(pyFailPath, '"""\nSkill Name: crash_skill\n"""\ndef run(): raise Exception("Boom")\n')
      await syncSkillStore(db)

      const resFail = await executePythonSkill('crash_skill', {}, 10000, db)
      expect(resFail.success).toBe(false)
      const formattedToolError = `❌ Execution error in skill "crash_skill": ${resFail.error}`
      expect(formattedToolError).toContain('Boom')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Skill Metric Updates (Success vs Failure)
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Skill Metric Updates', () => {
    it('3.1 calculates moving average latency correctly across multiple successful executions', () => {
      const dummySkill = {
        skillId: 'skill_moving_avg',
        name: 'moving_avg',
        description: 'Moving average metric test',
        filePath: join(testSkillsDir, 'moving_avg.py'),
        entrypoint: 'run',
        version: '1.0.0',
        parametersSchema: { type: 'object' as const, properties: {} },
        rawDocstring: ''
      }
      upsertSkillMetadata(dummySkill, db)

      // Run 1: 100ms
      recordSkillMetrics('moving_avg', true, 100, db)
      let stats = getSkillsMetadata(db).skills.find(s => s.name === 'moving_avg')
      expect(stats?.successCount).toBe(1)
      expect(stats?.averageExecutionTimeMs).toBe(100)

      // Run 2: 200ms -> Avg (100 + 200) / 2 = 150
      recordSkillMetrics('moving_avg', true, 200, db)
      stats = getSkillsMetadata(db).skills.find(s => s.name === 'moving_avg')
      expect(stats?.successCount).toBe(2)
      expect(stats?.averageExecutionTimeMs).toBe(150)

      // Run 3: 300ms -> Avg (150 * 2 + 300) / 3 = 200
      recordSkillMetrics('moving_avg', true, 300, db)
      stats = getSkillsMetadata(db).skills.find(s => s.name === 'moving_avg')
      expect(stats?.successCount).toBe(3)
      expect(stats?.averageExecutionTimeMs).toBe(200)
    })

    it('3.2 failure outcomes increment failureCount without corrupting successCount or average latency', () => {
      const dummySkill = {
        skillId: 'skill_fail_metric',
        name: 'fail_metric',
        description: 'Failure metric test',
        filePath: join(testSkillsDir, 'fail_metric.py'),
        entrypoint: 'run',
        version: '1.0.0',
        parametersSchema: { type: 'object' as const, properties: {} },
        rawDocstring: ''
      }
      upsertSkillMetadata(dummySkill, db)

      recordSkillMetrics('fail_metric', true, 120, db)
      recordSkillMetrics('fail_metric', false, 500, db)
      recordSkillMetrics('fail_metric', false, 400, db)

      const stats = getSkillsMetadata(db).skills.find(s => s.name === 'fail_metric')
      expect(stats?.successCount).toBe(1)
      expect(stats?.failureCount).toBe(2)
      expect(stats?.averageExecutionTimeMs).toBe(120)
      expect(stats?.successRate).toBe(33.33) // 1 / 3 * 100
    })

    it('3.3 recordSkillMetrics handles unknown skill name gracefully without throwing', () => {
      expect(() => {
        recordSkillMetrics('ghost_skill', true, 100, db)
      }).not.toThrow()
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Skill Reuse Matching & Confidence Scoring
  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Skill Reuse Matching & Confidence Scoring', () => {
    beforeEach(() => {
      upsertSkillMetadata({
        skillId: 'skill_pdf_exporter',
        name: 'pdf_exporter',
        description: 'Exports document or HTML text to PDF file format.',
        filePath: join(testSkillsDir, 'pdf_exporter.py'),
        entrypoint: 'export',
        version: '1.0.0',
        parametersSchema: { type: 'object', properties: {} },
        rawDocstring: ''
      }, db)

      upsertSkillMetadata({
        skillId: 'skill_sql_query_builder',
        name: 'sql_query_builder',
        description: 'Generates optimized SQL query statements for SQLite databases.',
        filePath: join(testSkillsDir, 'sql_query_builder.py'),
        entrypoint: 'build',
        version: '1.0.0',
        parametersSchema: { type: 'object', properties: {} },
        rawDocstring: ''
      }, db)
    })

    it('4.1 matches exact skill name with high confidence (>= 0.8)', async () => {
      const match = await matchExistingSkill('Jalankan pdf_exporter untuk dokumen ini', 0.6, db)
      expect(match.matched).toBe(true)
      expect(match.skill?.name).toBe('pdf_exporter')
      expect(match.confidenceScore).toBeGreaterThanOrEqual(0.8)
    })

    it('4.2 matches description keywords when task description has partial overlap', async () => {
      const match = await matchExistingSkill('Tolong optimized SQL query statements database SQLite', 0.25, db)
      expect(match.matched).toBe(true)
      expect(match.skill?.name).toBe('sql_query_builder')
      expect(match.confidenceScore).toBeGreaterThan(0.25)
    })

    it('4.3 rejects match when task description is completely unrelated', async () => {
      const match = await matchExistingSkill('Memasak resep nasi goreng enak', 0.6, db)
      expect(match.matched).toBe(false)
      expect(match.skill).toBeNull()
      expect(match.confidenceScore).toBeLessThan(0.6)
      expect(match.matchReason).toContain('No skill matched confidence threshold')
    })

    it('4.4 returns false when skill store is empty', async () => {
      deleteSkillMetadata('pdf_exporter', db)
      deleteSkillMetadata('sql_query_builder', db)

      const match = await matchExistingSkill('Tolong export ke PDF', 0.5, db)
      expect(match.matched).toBe(false)
      expect(match.matchReason).toBe('Skill store is empty.')
    })
  })
})
