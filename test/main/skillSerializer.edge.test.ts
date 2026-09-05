/**
/**
 * Edge Case Test Suite for SkillSerializer Subsystem
 * (`test/main/skillSerializer.edge.test.ts`)
 * Tests reserved python keywords, special character names, file overwrite behavior,
 * and SQLite skills_metadata upsert integrity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync, readFileSync } from 'fs'
import { initializeSchema, getSkillsMetadata } from '../../src/main/database'
import {
  sanitizeSkillName,
  cleanPythonCode,
  formatSkillDocstring,
  serializeSkill
} from '../../src/main/learning/skillSerializer'
import { parsePythonSkillFile } from '../../src/main/memory/skillStore'

describe('SkillSerializer Edge Cases & Persistence', () => {
  let db: Database.Database
  const createdFiles: string[] = []

  beforeEach(() => {
    db = new Database(':memory:')
    initializeSchema(db)
  })

  afterEach(() => {
    for (const file of createdFiles) {
      if (existsSync(file)) {
        try { unlinkSync(file) } catch {}
      }
    }
    createdFiles.length = 0
    if (db) db.close()
  })

  // 1. Reserved Python Keywords
  describe('1. Reserved Python Keyword Sanitization', () => {
    it('prepend custom_ to python reserved keywords', () => {
      const reservedList = [
        'sys', 'os', 'json', 'math', 're', 'time', 'random',
        'subprocess', 'import', 'def', 'class', 'return',
        'for', 'while', 'if', 'else', 'try', 'except'
      ]

      for (const kw of reservedList) {
        expect(sanitizeSkillName(kw)).toBe(`custom_${kw}`)
      }
    })

    it('handles uppercase or whitespace reserved keywords correctly', () => {
      expect(sanitizeSkillName('  SYS  ')).toBe('custom_sys')
      expect(sanitizeSkillName('JSON')).toBe('custom_json')
      expect(sanitizeSkillName('SubProcess')).toBe('custom_subprocess')
    })
  })

  // 2. Special Characters and Name Edge Cases
  describe('2. Special Character Skill Names & Edge Cases', () => {
    it('sanitizes names with special characters and symbols', () => {
      expect(sanitizeSkillName('My-Special_Skill #42!')).toBe('my_special_skill_42')
      expect(sanitizeSkillName('skill_🔥_fire')).toBe('skill_fire')
    })

    it('falls back to skill_<timestamp> for purely non-alphabetic or empty names', () => {
      expect(sanitizeSkillName('!@#$%^&*()')).toMatch(/^skill_\d+$/)
      expect(sanitizeSkillName('   ')).toMatch(/^skill_\d+$/)
      expect(sanitizeSkillName('')).toMatch(/^skill_\d+$/)
    })

    it('falls back to skill_<timestamp> for names starting with a digit', () => {
      expect(sanitizeSkillName('123_calculator')).toMatch(/^skill_\d+$/)
      expect(sanitizeSkillName('99bottles')).toMatch(/^skill_\d+$/)
    })

    it('collapses multiple underscores and strips leading/trailing underscores', () => {
      expect(sanitizeSkillName('___my___cool___skill___')).toBe('my_cool_skill')
    })

    it('truncates skill names exceeding 50 characters', () => {
      const longName = 'a'.repeat(100)
      const sanitized = sanitizeSkillName(longName)
      expect(sanitized.length).toBe(50)
      expect(sanitized).toBe('a'.repeat(50))
    })
  })

  // 3. Overwrite Behavior in ./skills/ Directory
  describe('3. File Overwrite Behavior in ./skills/', () => {
    it('overwrites existing skill file cleanly when serialized with same skillName', async () => {
      const skillName = 'test_overwrite_target'
      const codeV1 = `
def run(**kwargs):
    return {"version": 1}
`
      const codeV2 = `
def run(**kwargs):
    return {"version": 2, "status": "updated"}
`

      // First serialization
      const path1 = await serializeSkill(
        skillName,
        codeV1,
        'Initial version',
        { type: 'object', properties: {} },
        { customDb: db, version: '1.0.0' }
      )
      createdFiles.push(path1)
      expect(existsSync(path1)).toBe(true)
      let fileContent = readFileSync(path1, 'utf-8')
      expect(fileContent).toContain('Version: 1.0.0')
      expect(fileContent).toContain('Description: Initial version')
      expect(fileContent).toContain('return {"version": 1}')

      // Overwrite serialization
      const path2 = await serializeSkill(
        skillName,
        codeV2,
        'Updated version',
        { type: 'object', properties: { flag: { type: 'boolean' } } },
        { customDb: db, version: '2.0.0' }
      )
      expect(path2).toBe(path1)

      fileContent = readFileSync(path2, 'utf-8')
      expect(fileContent).toContain('Version: 2.0.0')
      expect(fileContent).toContain('Description: Updated version')
      expect(fileContent).toContain('return {"version": 2, "status": "updated"}')

      // Verify parsePythonSkillFile works on overwritten file
      const parsed = parsePythonSkillFile(path2)
      expect(parsed.version).toBe('2.0.0')
      expect(parsed.description).toBe('Updated version')
      expect(parsed.parametersSchema.properties).toHaveProperty('flag')
    })
  })

  // 4. SQLite skills_metadata Table Upsert Verification
  describe('4. SQLite skills_metadata Table Upsert Verification', () => {
    it('upserts SQLite skills_metadata row without creating duplicate entries', async () => {
      const skillName = 'test_upsert_skill'

      // First serialization
      await serializeSkill(
        skillName,
        'def run(**kwargs): return {"step": 1}',
        'Step 1 Description',
        {},
        { customDb: db, version: '1.0.0' }
      )

      let metadataReport = getSkillsMetadata(db)
      expect(metadataReport.totalSkills).toBe(1)
      expect(metadataReport.skills[0].name).toBe('test_upsert_skill')
      expect(metadataReport.skills[0].version).toBe('1.0.0')
      expect(metadataReport.skills[0].description).toBe('Step 1 Description')

      // Second serialization (upsert)
      await serializeSkill(
        skillName,
        'def run(**kwargs): return {"step": 2}',
        'Step 2 Description',
        { type: 'object', properties: { count: { type: 'number' } } },
        { customDb: db, version: '1.1.0' }
      )

      metadataReport = getSkillsMetadata(db)
      // Must STILL be 1 total skill in the DB (ON CONFLICT(name) DO UPDATE)
      expect(metadataReport.totalSkills).toBe(1)
      expect(metadataReport.skills[0].name).toBe('test_upsert_skill')
      expect(metadataReport.skills[0].version).toBe('1.1.0')
      expect(metadataReport.skills[0].description).toBe('Step 2 Description')

      // Direct SQL check
      const rowCount = db.prepare('SELECT COUNT(*) as cnt FROM skills_metadata WHERE name = ?').get('test_upsert_skill') as any
      expect(rowCount.cnt).toBe(1)
    })

    it('handles multiple distinct skills in skills_metadata', async () => {
      const skills = ['alpha_skill', 'beta_skill', 'gamma_skill']
      for (const name of skills) {
        const p = await serializeSkill(name, 'def run(): pass', `Skill ${name}`, {}, { customDb: db })
        createdFiles.push(p)
      }

      const metadataReport = getSkillsMetadata(db)
      expect(metadataReport.totalSkills).toBe(3)
    })
  })

  // 5. Code Cleaning & Formatting Edge Cases
  describe('5. Code Cleaning and Formatting Edge Cases', () => {
    it('cleanPythonCode does not duplicate imports if import json/sys already present', () => {
      const codeWithImports = `import json\nimport sys\n\ndef run(**kwargs):\n    return json.dumps(kwargs)`
      const cleaned = cleanPythonCode(codeWithImports)

      const jsonImportMatches = cleaned.match(/^import json\b/gm)
      const sysImportMatches = cleaned.match(/^import sys\b/gm)

      expect(jsonImportMatches?.length).toBe(1)
      expect(sysImportMatches?.length).toBe(1)
    })

    it('formatSkillDocstring replaces newlines in description with spaces', () => {
      const multiLineDesc = "Line 1\nLine 2\nLine 3"
      const docstring = formatSkillDocstring('multiline_skill', multiLineDesc, {})

      expect(docstring).toContain('Description: Line 1 Line 2 Line 3')
      expect(docstring).not.toContain('Description: Line 1\nLine 2')
    })
  })
})
