/**
 * Procedural Memory Skill Store Subsystem (`src/main/memory/skillStore.ts`)
 * Manages dynamic Python skill discovery, metadata docstring parsing,
 * SQLite skills_metadata indexing, safe Python process execution, and skill reuse matching.
 */

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join, basename } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { getDatabase, logToolCall, getSkillsMetadata, SkillsMetadataReport } from '../database'

const execFileAsync = promisify(execFile)

export interface PythonSkillParameterProperty {
  type: string
  description?: string
  default?: any
  enum?: string[]
}

export interface PythonSkillParameterSchema {
  type: 'object'
  properties: Record<string, PythonSkillParameterProperty>
  required?: string[]
}

export interface ParsedPythonSkill {
  skillId: string
  name: string
  description: string
  filePath: string
  entrypoint: string
  version: string
  parametersSchema: PythonSkillParameterSchema
  rawDocstring: string
}

export interface SkillExecutionResult {
  success: boolean
  skillName: string
  result: any
  error?: string
  stdout: string
  stderr: string
  latencyMs: number
}

export interface SkillReuseMatch {
  matched: boolean
  confidenceScore: number
  skill: ParsedPythonSkill | null
  matchReason: string
}

/**
 * Returns absolute path to ./skills/ directory
 */
export function getSkillsDirectory(): string {
  if (process.env.JARVIS_SKILLS_PATH) {
    return process.env.JARVIS_SKILLS_PATH
  }
  const rootDir = app?.getAppPath ? app.getAppPath() : process.cwd()
  return join(rootDir, 'skills')
}

/**
 * Ensures ./skills/ directory exists on disk.
 */
export function ensureSkillsDirectoryExists(): string {
  const dir = getSkillsDirectory()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * Parses Python docstring and extracts Skill metadata & JSON parameters schema.
 */
export function parsePythonSkillFile(filePath: string): ParsedPythonSkill {
  const fileName = basename(filePath, '.py')
  const content = readFileSync(filePath, 'utf-8')

  // Match docstring between triple quotes """...""" or '''...'''
  const docstringMatch = content.match(/^"""([\s\S]*?)"""|^'''([\s\S]*?)'''/m)
  const docstring = docstringMatch ? (docstringMatch[1] || docstringMatch[2]).trim() : ''

  // Header extraction regexes
  const nameMatch = docstring.match(/^Skill Name:\s*(.+)$/im)
  const descMatch = docstring.match(/^Description:\s*(.+)$/im)
  const entryMatch = docstring.match(/^Entrypoint:\s*(.+)$/im)
  const verMatch = docstring.match(/^Version:\s*(.+)$/im)
  const paramsMatch = docstring.match(/Parameters:\s*(\{[\s\S]*\})/i)

  const name = nameMatch ? nameMatch[1].trim() : fileName
  const description = descMatch ? descMatch[1].trim() : (docstring.split('\n')[0] || `Python skill ${fileName}`)
  const entrypoint = entryMatch ? entryMatch[1].trim() : 'run'
  const version = verMatch ? verMatch[1].trim() : '1.0.0'

  let parametersSchema: PythonSkillParameterSchema = {
    type: 'object',
    properties: {},
    required: []
  }

  if (paramsMatch) {
    try {
      parametersSchema = JSON.parse(paramsMatch[1].trim())
    } catch {
      console.warn(`[SkillStore] Failed to parse JSON parameters schema in ${filePath}. Using fallback.`)
    }
  }

  return {
    skillId: `skill_${name}`,
    name,
    description,
    filePath,
    entrypoint,
    version,
    parametersSchema,
    rawDocstring: docstring
  }
}

/**
 * DAO: Upsert parsed skill metadata into SQLite skills_metadata table.
 */
export function upsertSkillMetadata(skill: ParsedPythonSkill, customDb?: Database.Database): void {
  const db = customDb || getDatabase()
  db.prepare(`
    INSERT INTO skills_metadata (
      skill_id, name, description, file_path, entrypoint, version, parameters_schema, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      file_path = excluded.file_path,
      entrypoint = excluded.entrypoint,
      version = excluded.version,
      parameters_schema = excluded.parameters_schema,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    skill.skillId,
    skill.name,
    skill.description,
    skill.filePath,
    skill.entrypoint,
    skill.version,
    JSON.stringify(skill.parametersSchema)
  )
}

/**
 * Scans ./skills/ directory and updates SQLite skills_metadata index.
 */
export async function syncSkillStore(customDb?: Database.Database): Promise<SkillsMetadataReport> {
  const dir = ensureSkillsDirectoryExists()
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.py') && !f.startsWith('_')) : []

  for (const file of files) {
    const fullPath = join(dir, file)
    try {
      const parsed = parsePythonSkillFile(fullPath)
      upsertSkillMetadata(parsed, customDb)
    } catch (err: any) {
      console.error(`[SkillStore] Error parsing skill file ${file}:`, err?.message || err)
    }
  }

  return getSkillsMetadata(customDb)
}

/**
 * DAO: Update skill execution stats (success/failure counts, moving avg latency).
 */
export function recordSkillMetrics(name: string, success: boolean, latencyMs: number, customDb?: Database.Database): void {
  const db = customDb || getDatabase()
  const row = db.prepare('SELECT success_count, failure_count, average_execution_time_ms FROM skills_metadata WHERE name = ?').get(name) as any
  if (!row) return

  if (success) {
    const newSuccessCount = (row.success_count || 0) + 1
    const oldAvg = row.average_execution_time_ms || 0
    const newAvg = newSuccessCount > 1 ? ((oldAvg * (newSuccessCount - 1)) + latencyMs) / newSuccessCount : latencyMs

    db.prepare(`
      UPDATE skills_metadata
      SET success_count = ?, average_execution_time_ms = ?, last_executed_at = CURRENT_TIMESTAMP
      WHERE name = ?
    `).run(newSuccessCount, newAvg, name)
  } else {
    const newFailCount = (row.failure_count || 0) + 1
    db.prepare(`
      UPDATE skills_metadata
      SET failure_count = ?, last_executed_at = CURRENT_TIMESTAMP
      WHERE name = ?
    `).run(newFailCount, name)
  }
}

/**
 * Resolves Python binary name on host system.
 */
export async function resolvePythonExecutable(): Promise<string> {
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
  for (const cmd of candidates) {
    try {
      await execFileAsync(cmd, ['--version'])
      return cmd
    } catch {}
  }
  return 'python'
}

/**
 * Skill Loading & Execution Wrapper: Spawns Python process to execute requested skill.
 */
export async function executePythonSkill(
  skillName: string,
  args: Record<string, any> = {},
  timeoutMs = 30000,
  customDb?: Database.Database
): Promise<SkillExecutionResult> {
  const db = customDb || getDatabase()
  const row = db.prepare('SELECT * FROM skills_metadata WHERE name = ?').get(skillName) as any

  if (!row) {
    throw new Error(`[SkillStore] Skill "${skillName}" not found in metadata registry.`)
  }

  const filePath = row.file_path
  const entrypoint = row.entrypoint || 'run'
  if (!existsSync(filePath)) {
    throw new Error(`[SkillStore] Skill file for "${skillName}" does not exist at ${filePath}.`)
  }

  const pyCmd = await resolvePythonExecutable()
  const startTime = performance.now()

  // Inline Python launcher code that imports module, passes JSON input, captures return JSON
  const launcherScript = `
import sys, json, importlib.util

filePath = sys.argv[1]
entrypoint = sys.argv[2]
argsJson = sys.argv[3]

try:
    spec = importlib.util.spec_from_file_location("dynamic_skill", filePath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    func = getattr(mod, entrypoint)
    kwargs = json.loads(argsJson)
    res = func(**kwargs)
    print(json.dumps({"status": "SUCCESS", "result": res}))
except Exception as e:
    import traceback
    print(json.dumps({"status": "ERROR", "error": str(e), "traceback": traceback.format_exc()}), file=sys.stderr)
    sys.exit(1)
`

  return new Promise<SkillExecutionResult>((resolve) => {
    const child = spawn(pyCmd, ['-c', launcherScript, filePath, entrypoint, JSON.stringify(args)], {
      timeout: timeoutMs
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })

    child.on('close', (code) => {
      const latencyMs = Math.round(performance.now() - startTime)
      const logId = randomUUID()

      if (code === 0) {
        try {
          const parsedOut = JSON.parse(stdout.trim())
          recordSkillMetrics(skillName, true, latencyMs, db)
          logToolCall(logId, `skill:${skillName}`, JSON.stringify(args), JSON.stringify(parsedOut.result), db)

          resolve({
            success: true,
            skillName,
            result: parsedOut.result,
            stdout,
            stderr,
            latencyMs
          })
        } catch {
          recordSkillMetrics(skillName, true, latencyMs, db)
          logToolCall(logId, `skill:${skillName}`, JSON.stringify(args), stdout, db)

          resolve({
            success: true,
            skillName,
            result: stdout.trim(),
            stdout,
            stderr,
            latencyMs
          })
        }
      } else {
        recordSkillMetrics(skillName, false, latencyMs, db)
        logToolCall(logId, `skill:${skillName}`, JSON.stringify(args), `ERROR: ${stderr || stdout}`, db)

        resolve({
          success: false,
          skillName,
          result: null,
          error: stderr || stdout || `Process exited with code ${code}`,
          stdout,
          stderr,
          latencyMs
        })
      }
    })

    child.on('error', (err) => {
      const latencyMs = Math.round(performance.now() - startTime)
      const logId = randomUUID()
      recordSkillMetrics(skillName, false, latencyMs, db)
      logToolCall(logId, `skill:${skillName}`, JSON.stringify(args), `SPAWN_ERROR: ${err.message}`, db)

      resolve({
        success: false,
        skillName,
        result: null,
        error: `Failed to spawn Python process: ${err.message}`,
        stdout,
        stderr: err.message,
        latencyMs
      })
    })
  })
}

/**
 * Pre-Task Skill Reuse Check Utility: Searches existing skills to see if one matches user task.
 */
export async function matchExistingSkill(
  taskDescription: string,
  minConfidence = 0.6,
  customDb?: Database.Database
): Promise<SkillReuseMatch> {
  const storeStats = getSkillsMetadata(customDb)
  if (!storeStats.skills || storeStats.skills.length === 0) {
    return { matched: false, confidenceScore: 0, skill: null, matchReason: 'Skill store is empty.' }
  }

  const queryLower = taskDescription.toLowerCase()
  let bestMatch: any = null
  let maxScore = 0

  for (const s of storeStats.skills) {
    const nameLower = s.name.toLowerCase()
    const descLower = (s.description || '').toLowerCase()

    let score = 0
    if (queryLower.includes(nameLower)) score += 0.8

    // Keyword match count
    const taskTokens = queryLower.split(/\W+/).filter((t) => t.length > 3)
    const matches = taskTokens.filter((t) => descLower.includes(t) || nameLower.includes(t))
    if (taskTokens.length > 0) {
      score += (matches.length / taskTokens.length) * 0.5
    }

    if (score > maxScore) {
      maxScore = score
      bestMatch = s
    }
  }

  if (bestMatch && maxScore >= minConfidence) {
    return {
      matched: true,
      confidenceScore: Math.min(1.0, Math.round(maxScore * 100) / 100),
      skill: {
        skillId: bestMatch.skillId,
        name: bestMatch.name,
        description: bestMatch.description || '',
        filePath: bestMatch.filePath,
        entrypoint: bestMatch.entrypoint,
        version: bestMatch.version,
        parametersSchema: JSON.parse((bestMatch as any).parameters_schema || bestMatch.parametersSchema || '{}'),
        rawDocstring: ''
      },
      matchReason: `Matched skill "${bestMatch.name}" with confidence ${Math.round(maxScore * 100)}%`
    }
  }

  return {
    matched: false,
    confidenceScore: Math.round(maxScore * 100) / 100,
    skill: null,
    matchReason: 'No skill matched confidence threshold.'
  }
}

/**
 * Dynamic Tool Registration Helper: Converts scanned Python skills into Gemini Function Declarations.
 */
export function getPythonSkillToolDeclarations(customDb?: Database.Database): Array<{ name: string; description: string; parameters: any }> {
  const store = getSkillsMetadata(customDb)
  return store.skills.map((s) => ({
    name: `skill_${s.name}`,
    description: `[Procedural Skill] ${s.description || s.name}`,
    parameters: JSON.parse((s as any).parameters_schema || s.parametersSchema || '{"type":"object","properties":{}}')
  }))
}

/**
 * Deletes skill metadata entry by name from SQLite skills_metadata table.
 */
export function deleteSkillMetadata(name: string, customDb?: Database.Database): boolean {
  const db = customDb || getDatabase()
  const info = db.prepare('DELETE FROM skills_metadata WHERE name = ?').run(name)
  return info.changes > 0
}
