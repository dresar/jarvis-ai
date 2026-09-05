import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import http from 'http'

// Mock Electron
vi.mock('electron', () => {
  const tmpDir = join(process.cwd(), 'temp_test_userdata_system_tools')
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true })
  }
  return {
    app: {
      getPath: () => tmpDir,
      getAppPath: () => process.cwd()
    },
    BrowserWindow: class {
      static getAllWindows() { return [] }
      isDestroyed() { return false }
      webContents = {
        send: vi.fn()
      }
    }
  }
})

import {
  initializeSchema,
  logToolCall,
  getDatabase
} from '../../src/main/database'

import {
  getInstallationDirectory,
  resolveSafeInstallationPath,
  manageInstallationFiles,
  readErrorLogs,
  executeCommand,
  normalizeSchemaTypes,
  STATIC_GEMINI_FUNCTION_DECLARATIONS,
  getDynamicGeminiTools,
  executeTool
} from '../../src/main/tools'

import {
  upsertSkillMetadata,
  syncSkillStore
} from '../../src/main/memory/skillStore'

import { consoleLogger } from '../../src/main/logger'
import { startHttpServer, stopHttpServer } from '../../src/main/server'

const TEST_PORT = 14229
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`

function makeRequest(
  urlPath: string,
  options: http.RequestOptions = {},
  body?: string | Buffer
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, BASE_URL)
    const bodyBuf = body ? (typeof body === 'string' ? Buffer.from(body, 'utf-8') : body) : null

    const headers: http.OutgoingHttpHeaders = {}
    if (options.headers) {
      Object.assign(headers, options.headers)
    }
    if (bodyBuf) {
      headers['Content-Length'] = bodyBuf.length
    }

    const reqOptions: http.RequestOptions = {
      hostname: fullUrl.hostname,
      port: fullUrl.port,
      path: fullUrl.pathname + fullUrl.search,
      method: options.method || 'GET',
      headers
    }

    const req = http.request(reqOptions, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk.toString('utf-8') })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: data
        })
      })
    })

    req.on('error', reject)
    if (bodyBuf) {
      req.write(bodyBuf)
    }
    req.end()
  })
}

describe('M4 System Control Tools & AI Integration Test Suite', () => {
  let db: Database.Database
  let testInstallDir: string
  let testSkillsDir: string

  beforeAll(async () => {
    startHttpServer(TEST_PORT)
    await new Promise((r) => setTimeout(r, 200))
  })

  afterAll(() => {
    stopHttpServer()
  })

  beforeEach(() => {
    db = new Database(':memory:')
    initializeSchema(db)

    testInstallDir = join(tmpdir(), `jarvis-install-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`)
    mkdirSync(testInstallDir, { recursive: true })
    process.env.JARVIS_INSTALL_DIR = testInstallDir

    testSkillsDir = join(tmpdir(), `jarvis-skills-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`)
    mkdirSync(testSkillsDir, { recursive: true })
    process.env.JARVIS_SKILLS_PATH = testSkillsDir

    consoleLogger.clear()
  })

  afterEach(() => {
    delete process.env.JARVIS_INSTALL_DIR
    delete process.env.JARVIS_SKILLS_PATH
    if (db) {
      db.close()
    }
    if (existsSync(testInstallDir)) {
      try {
        rmSync(testInstallDir, { recursive: true, force: true })
      } catch {}
    }
    if (existsSync(testSkillsDir)) {
      try {
        rmSync(testSkillsDir, { recursive: true, force: true })
      } catch {}
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Installation Directory Resolution & Path Traversal Prevention
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Installation Directory Resolution & Security Guardrails', () => {
    it('1.1 getInstallationDirectory honors JARVIS_INSTALL_DIR environment variable', () => {
      expect(getInstallationDirectory()).toBe(testInstallDir)
    })

    it('1.2 resolveSafeInstallationPath correctly resolves valid subpaths', () => {
      const resolved = resolveSafeInstallationPath(testInstallDir, 'subfolder/file.txt')
      expect(resolved).toBe(join(testInstallDir, 'subfolder', 'file.txt'))
    })

    it('1.3 resolveSafeInstallationPath blocks directory traversal attempts (..)', () => {
      expect(() => {
        resolveSafeInstallationPath(testInstallDir, '../outside.txt')
      }).toThrow('[Security] Path traversal outside installation folder is strictly blocked')

      expect(() => {
        resolveSafeInstallationPath(testInstallDir, 'sub/../../outside.txt')
      }).toThrow('[Security] Path traversal outside installation folder is strictly blocked')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2. manageInstallationFiles Tool
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. manageInstallationFiles Tool Operations', () => {
    it('2.1 action "write" creates subdirectories and writes file content', async () => {
      const res = await manageInstallationFiles({
        action: 'write',
        relativePath: 'config/settings.json',
        content: '{"theme":"dark"}'
      }, testInstallDir)

      expect(res).toContain('Berhasil menulis')
      expect(res).toContain('config/settings.json')

      const writtenFile = join(testInstallDir, 'config', 'settings.json')
      expect(existsSync(writtenFile)).toBe(true)
      expect(readFileSync(writtenFile, 'utf-8')).toBe('{"theme":"dark"}')
    })

    it('2.2 action "read" reads existing file content correctly', async () => {
      const filePath = join(testInstallDir, 'readme.txt')
      writeFileSync(filePath, 'Hello Jarvis Installation', 'utf-8')

      const res = await manageInstallationFiles({
        action: 'read',
        relativePath: 'readme.txt'
      }, testInstallDir)

      expect(res).toContain('Hello Jarvis Installation')
    })

    it('2.3 action "read" returns error for non-existent file', async () => {
      const res = await manageInstallationFiles({
        action: 'read',
        relativePath: 'missing.txt'
      }, testInstallDir)

      expect(res).toContain('File tidak ditemukan')
    })

    it('2.4 action "read" rejects reading directories', async () => {
      const dirPath = join(testInstallDir, 'logs')
      mkdirSync(dirPath, { recursive: true })

      const res = await manageInstallationFiles({
        action: 'read',
        relativePath: 'logs'
      }, testInstallDir)

      expect(res).toContain('adalah direktori, bukan file')
    })

    it('2.5 action "read" guards against files larger than 100KB', async () => {
      const largeFilePath = join(testInstallDir, 'large.bin')
      const largeBuffer = Buffer.alloc(110 * 1024, 'A')
      writeFileSync(largeFilePath, largeBuffer)

      const res = await manageInstallationFiles({
        action: 'read',
        relativePath: 'large.bin'
      }, testInstallDir)

      expect(res).toContain('File terlalu besar untuk dibaca langsung')
    })

    it('2.6 action "list" lists files and directories accurately', async () => {
      writeFileSync(join(testInstallDir, 'app.exe'), 'exe content')
      mkdirSync(join(testInstallDir, 'resources'))
      writeFileSync(join(testInstallDir, 'resources', 'data.json'), '{}')

      const resRoot = await manageInstallationFiles({
        action: 'list',
        relativePath: ''
      }, testInstallDir)

      expect(resRoot).toContain('app.exe')
      expect(resRoot).toContain('resources')

      const resSub = await manageInstallationFiles({
        action: 'list',
        relativePath: 'resources'
      }, testInstallDir)

      expect(resSub).toContain('data.json')
    })

    it('2.7 action "list" on empty folder reports empty message', async () => {
      const emptyDir = join(testInstallDir, 'empty_folder')
      mkdirSync(emptyDir)

      const res = await manageInstallationFiles({
        action: 'list',
        relativePath: 'empty_folder'
      }, testInstallDir)

      expect(res).toContain('kosong')
    })

    it('2.8 action "delete" safely deletes file or subdirectory', async () => {
      const fileToDelete = join(testInstallDir, 'temp.log')
      writeFileSync(fileToDelete, 'temp')

      const res = await manageInstallationFiles({
        action: 'delete',
        relativePath: 'temp.log'
      }, testInstallDir)

      expect(res).toContain('Berhasil menghapus')
      expect(existsSync(fileToDelete)).toBe(false)
    })

    it('2.9 action "delete" prevents deleting root installation directory', async () => {
      const res = await manageInstallationFiles({
        action: 'delete',
        relativePath: ''
      }, testInstallDir)

      expect(res).toContain('Dilarang menghapus root direktori')
      expect(existsSync(testInstallDir)).toBe(true)
    })

    it('2.10 handles path traversal attempt gracefully with error message', async () => {
      const res = await manageInstallationFiles({
        action: 'read',
        relativePath: '../../windows/system32/cmd.exe'
      }, testInstallDir)

      expect(res).toContain('Path traversal outside installation folder is strictly blocked')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3. readErrorLogs Tool
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. readErrorLogs Tool Operations', () => {
    it('3.1 source "db" returns message when no error logs exist', async () => {
      const res = await readErrorLogs({ source: 'db', lines: 10 }, db)
      expect(res).toContain('Tidak ada log error ditemukan di database')
    })

    it('3.2 source "db" retrieves and formats error logs with status ERROR or RATE_LIMITED', async () => {
      // Seed error logs in execution_logs
      db.prepare(`
        INSERT INTO execution_logs (id, key_id, model, status, error_message, latency_ms, tool_name, parameters, result, timestamp)
        VALUES ('err_1', NULL, 'gemini-2.5-flash', 'ERROR', '403 Forbidden: API key revoked', 120, 'gemini_api', '{}', 'ERROR: 403', '2026-08-14 01:00:00')
      `).run()

      db.prepare(`
        INSERT INTO execution_logs (id, key_id, model, status, error_message, latency_ms, tool_name, parameters, result, timestamp)
        VALUES ('err_2', NULL, 'gemini-2.5-flash', 'RATE_LIMITED', '429 Resource Exhausted', 350, 'gemini_api', '{}', 'ERROR: 429', '2026-08-14 01:05:00')
      `).run()

      const res = await readErrorLogs({ source: 'db', lines: 10 }, db)
      expect(res).toContain('Ditemukan 2 log error di database')
      expect(res).toContain('403 Forbidden')
      expect(res).toContain('429 Resource Exhausted')
    })

    it('3.3 source "file" returns message when no console errors exist', async () => {
      const res = await readErrorLogs({ source: 'file', lines: 20 })
      expect(res).toContain('Tidak ada stream stderr / uncaught exception')
    })

    it('3.4 source "file" retrieves captured stderr and exception entries', async () => {
      consoleLogger.addEntry('error', 'stderr', 'Unhandled promise rejection in background job', 'Error: Stack trace')
      consoleLogger.addEntry('error', 'exception', 'Uncaught ReferenceError: foo is not defined', 'ReferenceError: Stack trace')

      const res = await readErrorLogs({ source: 'file', lines: 20 })
      expect(res).toContain('Ditemukan 2 entri stderr/exception')
      expect(res).toContain('Unhandled promise rejection')
      expect(res).toContain('ReferenceError: foo is not defined')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 4. executeCommand Tool
  // ──────────────────────────────────────────────────────────────────────────
  describe('4. executeCommand Tool Operations', () => {
    it('4.1 rejects empty command with error message', async () => {
      const res = await executeCommand({ command: '   ' }, db)
      expect(res).toContain('Perintah command tidak boleh kosong')
    })

    it('4.2 intercepts and blocks dangerous commands', async () => {
      const dangerousCommands = [
        'format c:',
        'FORMAT D:',
        'rmdir /s /q c:',
        'del /f /s /q c:\\',
        'Stop-Computer -Force',
        'Clear-Disk'
      ]

      for (const cmd of dangerousCommands) {
        const res = await executeCommand({ command: cmd }, db)
        expect(res).toContain('Security Error: Perintah')
        expect(res).toContain('diblokir')
      }
    })

    it('4.3 executes valid PowerShell command and formats stdout output with latency', async () => {
      const res = await executeCommand({ command: 'Write-Output "Jarvis PowerShell Test"' }, db)
      expect(res).toContain('STATUS: SUCCESS')
      expect(res).toContain('Latency:')
      expect(res).toContain('Jarvis PowerShell Test')
    })

    it('4.4 captures non-zero exit / failure gracefully', async () => {
      const res = await executeCommand({ command: 'NonExistentCommandXYZ123' }, db)
      expect(res).toContain('STATUS: FAILED')
      expect(res).toContain('STDERR')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Schema Normalization & Dynamic Gemini Tools
  // ──────────────────────────────────────────────────────────────────────────
  describe('5. Schema Normalization & Dynamic Gemini Tools Registration', () => {
    it('5.1 normalizeSchemaTypes recursively converts types to uppercase', () => {
      const rawSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          tags: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }

      const normalized = normalizeSchemaTypes(rawSchema)
      expect(normalized.type).toBe('OBJECT')
      expect(normalized.properties.name.type).toBe('STRING')
      expect(normalized.properties.age.type).toBe('NUMBER')
      expect(normalized.properties.tags.type).toBe('ARRAY')
      expect(normalized.properties.tags.items.type).toBe('STRING')
    })

    it('5.2 STATIC_GEMINI_FUNCTION_DECLARATIONS contains all 13 core tool declarations', () => {
      expect(STATIC_GEMINI_FUNCTION_DECLARATIONS.length).toBe(13)

      const names = STATIC_GEMINI_FUNCTION_DECLARATIONS.map(d => d.name)
      expect(names).toContain('open_application')
      expect(names).toContain('get_system_status')
      expect(names).toContain('search_web')
      expect(names).toContain('set_volume')
      expect(names).toContain('lock_screen')
      expect(names).toContain('shutdown_computer')
      expect(names).toContain('cancel_shutdown')
      expect(names).toContain('open_folder')
      expect(names).toContain('get_clipboard')
      expect(names).toContain('set_clipboard')
      expect(names).toContain('manage_installation_files')
      expect(names).toContain('read_error_logs')
      expect(names).toContain('execute_command')
    })

    it('5.3 getDynamicGeminiTools combines static tools with dynamic Python skill tools', async () => {
      // Upsert a test Python skill into SQLite metadata
      upsertSkillMetadata({
        skillId: 'skill_weather_reporter',
        name: 'weather_reporter',
        description: 'Fetches local weather report.',
        filePath: join(testSkillsDir, 'weather_reporter.py'),
        entrypoint: 'run',
        version: '1.0.0',
        parametersSchema: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' }
          },
          required: ['city']
        },
        rawDocstring: ''
      }, db)

      const tools = getDynamicGeminiTools(db)
      expect(tools.length).toBe(1)
      const declarations = tools[0].functionDeclarations
      expect(declarations.length).toBe(14) // 13 static + 1 dynamic

      const skillDecl = declarations.find((d: any) => d.name === 'skill_weather_reporter')
      expect(skillDecl).toBeDefined()
      expect(skillDecl.description).toContain('Fetches local weather report')
      expect(skillDecl.parameters.type).toBe('OBJECT')
      expect(skillDecl.parameters.properties.city.type).toBe('STRING')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 6. executeTool Routing
  // ──────────────────────────────────────────────────────────────────────────
  describe('6. executeTool Routing', () => {
    it('6.1 routes manage_installation_files properly', async () => {
      const res = await executeTool('manage_installation_files', {
        action: 'write',
        relativePath: 'routed.txt',
        content: 'Routed content'
      })
      expect(res).toContain('Berhasil menulis')
    })

    it('6.2 routes read_error_logs properly', async () => {
      const res = await executeTool('read_error_logs', { lines: 5, source: 'file' })
      expect(res).toBeDefined()
      expect(typeof res).toBe('string')
    })

    it('6.3 routes execute_command properly', async () => {
      const res = await executeTool('execute_command', { command: 'echo "Hello from executeTool"' })
      expect(res).toContain('STATUS: SUCCESS')
      expect(res).toContain('Hello from executeTool')
    })

    it('6.4 returns unknown tool warning for unrecognized tool', async () => {
      const res = await executeTool('unknown_magic_tool', {})
      expect(res).toContain('tidak dikenal')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 7. REST API Endpoints: GET /api/tools & POST /api/system/control
  // ──────────────────────────────────────────────────────────────────────────
  describe('7. HTTP REST API Endpoints', () => {
    it('7.1 GET /api/tools returns dynamic Gemini tool declarations', async () => {
      const res = await makeRequest('/api/tools')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(Array.isArray(json.data)).toBe(true)
      expect(json.data[0]).toHaveProperty('functionDeclarations')
      expect(json.data[0].functionDeclarations.length).toBeGreaterThanOrEqual(13)
    })

    it('7.2 POST /api/system/control executes get_system_status', async () => {
      const payload = JSON.stringify({
        tool: 'get_system_status',
        args: {}
      })
      const res = await makeRequest('/api/system/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)

      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data.tool).toBe('get_system_status')
      expect(json.data).toHaveProperty('result')
      expect(json).toHaveProperty('output')
    })

    it('7.3 POST /api/system/control executes execute_command', async () => {
      const payload = JSON.stringify({
        tool: 'execute_command',
        args: { command: 'echo "REST API Control Test"' }
      })
      const res = await makeRequest('/api/system/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)

      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data.result).toContain('REST API Control Test')
    })

    it('7.4 POST /api/system/control returns 400 when tool is missing or empty', async () => {
      const payload = JSON.stringify({ args: {} })
      const res = await makeRequest('/api/system/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)

      expect(res.statusCode).toBe(400)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(false)
      expect(json.error).toContain('wajib diisi')
    })
  })
})
