/**
 * Skill Serialization Subsystem (`src/main/learning/skillSerializer.ts`)
 * Serializes successful code solutions into reusable Python files under ./skills/<skillName>.py,
 * formats standard header docstrings, verifies syntax integrity via parsePythonSkillFile,
 * and updates SQLite skills_metadata table.
 */

import Database from 'better-sqlite3'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  ensureSkillsDirectoryExists,
  parsePythonSkillFile,
  upsertSkillMetadata
} from '../memory/skillStore'
import { logToolCall } from '../database'

export interface SkillSerializationOptions {
  version?: string
  author?: string
  customDb?: Database.Database
}

/**
 * Sanitizes a raw skill name into a valid Python module identifier.
 */
export function sanitizeSkillName(rawName: string): string {
  const sanitized = (rawName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)

  if (!sanitized || !/^[a-z]/.test(sanitized)) {
    return `skill_${Date.now()}`
  }

  const reserved = new Set([
    'sys',
    'os',
    'json',
    'math',
    're',
    'time',
    'random',
    'subprocess',
    'import',
    'def',
    'class',
    'return',
    'for',
    'while',
    'if',
    'else',
    'try',
    'except'
  ])

  if (reserved.has(sanitized)) {
    return `custom_${sanitized}`
  }

  return sanitized
}

/**
 * Cleans Python source code, stripping markdown fences and ensuring required imports and entrypoint.
 */
export function cleanPythonCode(rawCode: string): string {
  let code = (rawCode || '').replace(/```(?:python|py)?\s*|\s*```/g, '').trim()

  const hasJsonImport = /^import json\b/m.test(code)
  const hasSysImport = /^import sys\b/m.test(code)

  let importHeader = ''
  if (!hasJsonImport) importHeader += 'import json\n'
  if (!hasSysImport) importHeader += 'import sys\n'

  if (importHeader) {
    code = `${importHeader}\n${code}`
  }

  // Ensure entrypoint 'run' exists
  if (!/def run\s*\(/.test(code)) {
    code = `${code}\n\ndef run(**kwargs):\n    """Auto-generated entrypoint wrapper."""\n    return {"status": "success", "input": kwargs}\n`
  }

  return code
}

/**
 * Formats Python docstring matching skillStore.ts parsing requirements.
 */
export function formatSkillDocstring(
  skillName: string,
  description: string,
  parametersSchema: Record<string, any>,
  version = '1.0.0'
): string {
  const schemaObj =
    parametersSchema && Object.keys(parametersSchema).length > 0
      ? parametersSchema
      : { type: 'object', properties: {}, required: [] }

  const cleanDescription = (description || `Python skill ${skillName}`).replace(/\n/g, ' ')

  return `"""
Skill Name: ${skillName}
Description: ${cleanDescription}
Entrypoint: run
Version: ${version}
Parameters: ${JSON.stringify(schemaObj, null, 2)}
"""`
}

/**
 * Serializes Python code into ./skills/<skillName>.py and updates SQLite skills_metadata.
 */
export async function serializeSkill(
  skillName: string,
  code: string,
  description: string,
  parametersSchema: Record<string, any> = {},
  options?: SkillSerializationOptions
): Promise<string> {
  const validName = sanitizeSkillName(skillName)
  const skillsDir = ensureSkillsDirectoryExists()
  const filePath = join(skillsDir, `${validName}.py`)
  const version = options?.version || '1.0.0'

  const docstring = formatSkillDocstring(validName, description, parametersSchema, version)
  const cleanedCode = cleanPythonCode(code)
  const fullFileContent = `${docstring}\n\n${cleanedCode}\n`

  // 1. Write file to ./skills/
  writeFileSync(filePath, fullFileContent, 'utf-8')

  // 2. Parse created file to verify metadata integrity
  const parsedSkill = parsePythonSkillFile(filePath)

  // 3. Upsert metadata into SQLite skills_metadata table
  upsertSkillMetadata(parsedSkill, options?.customDb)

  // 4. Log serialization event
  try {
    logToolCall(
      randomUUID(),
      `serialize_skill:${validName}`,
      JSON.stringify({ description, version }),
      `Successfully serialized skill file to ${filePath}`,
      options?.customDb
    )
  } catch (logErr) {
    console.warn('[SkillSerializer] Failed to log tool call:', logErr)
  }

  return filePath
}
