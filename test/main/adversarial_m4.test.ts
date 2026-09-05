import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import http from 'http'

// Mock Electron before imports
vi.mock('electron', () => {
  const tmpDir = join(process.cwd(), 'temp_test_userdata_adv_m4')
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
  getPythonSkillToolDeclarations
} from '../../src/main/memory/skillStore'

import { consoleLogger } from '../../src/main/logger'
import { startHttpServer, stopHttpServer } from '../../src/main/server'

const TEST_PORT = 14230
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

describe('Adversarial Challenger Suite — Milestone M4 (System Control & Dynamic Tools)', () => {
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

    testInstallDir = join(tmpdir(), `jarvis-m4-adv-install-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`)
    mkdirSync(testInstallDir, { recursive: true })
    process.env.JARVIS_INSTALL_DIR = testInstallDir

    testSkillsDir = join(tmpdir(), `jarvis-m4-adv-skills-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`)
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
  // SECTION 1: Adversarial Payloads to POST /api/system/control
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Adversarial & Malformed Payloads to POST /api/system/control', () => {
    it('1.1 handles completely empty request body (status 400)', async () => {
      const res = await makeRequest('/api/system/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, '')

      expect(res.statusCode).toBe(400)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(false)
      expect(json.error).toContain('wajib diisi')
    })

    it('1.2 handles whitespace-only request body (status 400)', async () => {
      const res = await makeRequest('/api/system/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, '   \t\r\n   ')

      expect(res.statusCode).toBe(400)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(false)
    })

    it('1.3 handles malformed / broken JSON syntax gracefully without crashing server (status 400)', async () => {
      const malformedPayloads = [
        '{ tool: "get_system_status", invalid_json',
        '{"tool": "execute_command", "args": { "command": "dir" }',
        'NOT_JSON_AT_ALL_XYZ',
        '{"tool": undefined}',
        '{"tool": "open_app", "args": [unquoted]}'
      ]

      for (const payload of malformedPayloads) {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, payload)

        expect(res.statusCode).toBe(400)
        const json = JSON.parse(res.body)
        expect(json.success).toBe(false)
      }
    })

    it('1.4 verifies behavior on non-object root JSON values (primitives & arrays)', async () => {
      const primitiveBodies = [
        '12345',
        '"just_a_string"',
        'true',
        'false',
        'null',
        '[{"tool": "get_system_status"}]'
      ]

      for (const body of primitiveBodies) {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, body)

        // If body is null or primitive, server should return 400 instead of crashing / 500
        const json = JSON.parse(res.body)
        expect(json.success).toBe(false)
      }
    })

    it('1.5 handles missing, empty, or non-string "tool" fields (status 400)', async () => {
      const invalidToolCases = [
        {},
        { tool: '' },
        { tool: '   \n\t  ' },
        { tool: 123 },
        { tool: true },
        { tool: [] },
        { tool: {} }
      ]

      for (const c of invalidToolCases) {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify(c))

        expect(res.statusCode).toBe(400)
        const json = JSON.parse(res.body)
        expect(json.success).toBe(false)
        expect(json.error).toContain('wajib diisi')
      }
    })

    it('1.6 handles unrecognized / non-existent tool names gracefully (returns warning message)', async () => {
      const unknownTools = [
        'non_existent_tool_12345',
        'hack_the_planet',
        '../../../etc/passwd',
        '<script>alert(1)</script>',
        'system.eval'
      ]

      for (const toolName of unknownTools) {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ tool: toolName, args: {} }))

        expect(res.statusCode).toBe(200)
        const json = JSON.parse(res.body)
        expect(json.success).toBe(true)
        expect(json.data.result).toContain('tidak dikenal')
        expect(json.output).toContain('tidak dikenal')
      }
    })

    it('1.7 handles alternative field aliases: "name" for tool, "parameters" for args', async () => {
      const res = await makeRequest('/api/system/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({
        name: 'read_error_logs',
        parameters: { lines: 5, source: 'file' }
      }))

      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data.tool).toBe('read_error_logs')
      expect(json.data.result).toBeDefined()
    })

    it('1.8 handles non-object "args" values (null, string, array, number) safely', async () => {
      const weirdArgs = [
        { tool: 'read_error_logs', args: null },
        { tool: 'read_error_logs', args: 'not_an_object' },
        { tool: 'read_error_logs', args: 999 },
        { tool: 'read_error_logs', args: [1, 2, 3] }
      ]

      for (const body of weirdArgs) {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify(body))

        expect(res.statusCode).toBe(200)
        const json = JSON.parse(res.body)
        expect(json.success).toBe(true)
      }
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 2: Adversarial Stress Testing of System Control Tools via API
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Adversarial Attacks on System Control Tools via API', () => {
    describe('2.1 manage_installation_files attack vectors', () => {
      it('blocks path traversal attempts via POST /api/system/control', async () => {
        const traversalPayloads = [
          '../../windows/system32/cmd.exe',
          '..\\..\\windows\\system32',
          '/../../../../etc/shadow',
          'sub/../../../etc/hosts',
          '....//....//....//windows'
        ]

        for (const relPath of traversalPayloads) {
          const res = await makeRequest('/api/system/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, JSON.stringify({
            tool: 'manage_installation_files',
            args: {
              action: 'read',
              relativePath: relPath
            }
          }))

          expect(res.statusCode).toBe(200)
          const json = JSON.parse(res.body)
          expect(json.success).toBe(true)
          expect(json.data.result).toContain('Path traversal outside installation folder is strictly blocked')
        }
      })

      it('blocks deletion of root installation directory', async () => {
        const rootDeletePayloads = ['', '/', '\\', '.', './', '.\\']

        for (const target of rootDeletePayloads) {
          const res = await makeRequest('/api/system/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, JSON.stringify({
            tool: 'manage_installation_files',
            args: {
              action: 'delete',
              relativePath: target
            }
          }))

          expect(res.statusCode).toBe(200)
          const json = JSON.parse(res.body)
          expect(json.success).toBe(true)
          expect(json.data.result).toMatch(/Dilarang menghapus root direktori|Path traversal/)
        }
      })

      it('handles invalid / unsupported actions gracefully', async () => {
        const invalidActions = ['format', 'chmod', 'exec', 'upload', '', undefined, null]

        for (const action of invalidActions) {
          const res = await makeRequest('/api/system/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, JSON.stringify({
            tool: 'manage_installation_files',
            args: {
              action: action as any,
              relativePath: 'test.txt'
            }
          }))

          expect(res.statusCode).toBe(200)
          const json = JSON.parse(res.body)
          expect(json.success).toBe(true)
          expect(json.data.result).toContain('tidak dikenal')
        }
      })

      it('safely handles writing non-string content (numbers, booleans, objects)', async () => {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
          tool: 'manage_installation_files',
          args: {
            action: 'write',
            relativePath: 'typed_content.json',
            content: { key: 'value' } as any
          }
        }))

        expect(res.statusCode).toBe(200)
        const json = JSON.parse(res.body)
        expect(json.success).toBe(true)
        expect(json.data.result).toContain('Berhasil menulis')
      })
    })

    describe('2.2 read_error_logs edge cases', () => {
      it('clamps boundary and out-of-range lines parameter (negative, huge, non-numeric)', async () => {
        const boundaryLines = [-100, 0, 999999, 'abc', null, undefined, NaN]

        for (const l of boundaryLines) {
          const res = await makeRequest('/api/system/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, JSON.stringify({
            tool: 'read_error_logs',
            args: { lines: l as any }
          }))

          expect(res.statusCode).toBe(200)
          const json = JSON.parse(res.body)
          expect(json.success).toBe(true)
          expect(json.data.result).toBeDefined()
        }
      })

      it('handles unrecognized source parameter gracefully (falls back to db)', async () => {
        const weirdSources = ['cloud', 'satellite', 123, null, '']

        for (const s of weirdSources) {
          const res = await makeRequest('/api/system/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, JSON.stringify({
            tool: 'read_error_logs',
            args: { source: s as any }
          }))

          expect(res.statusCode).toBe(200)
          const json = JSON.parse(res.body)
          expect(json.success).toBe(true)
        }
      })
    })

    describe('2.3 execute_command attack vectors & boundary conditions', () => {
      it('intercepts and blocks varied case and spaced destructive commands', async () => {
        const destructiveCommands = [
          'format c:',
          '  FORMAT   D:  ',
          'rmdir /s /q C:\\',
          'RMDIR \\s \\q c:',
          'del /f /s /q c:\\windows\\system32',
          'Stop-Computer -Force',
          'Clear-Disk',
          'Format-Volume -DriveLetter C',
          'Remove-Partition -DiskNumber 0'
        ]

        for (const cmd of destructiveCommands) {
          const res = await makeRequest('/api/system/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }, JSON.stringify({
            tool: 'execute_command',
            args: { command: cmd }
          }))

          expect(res.statusCode).toBe(200)
          const json = JSON.parse(res.body)
          expect(json.success).toBe(true)
          expect(json.data.result).toContain('Security Error: Perintah')
          expect(json.data.result).toContain('diblokir')
        }
      })

      it('handles unicode, emojis, and quotes in commands safely', async () => {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
          tool: 'execute_command',
          args: { command: 'Write-Output "Unicode: 🔥 日本語 🚀"' }
        }))

        expect(res.statusCode).toBe(200)
        const json = JSON.parse(res.body)
        expect(json.success).toBe(true)
        expect(json.data.result).toContain('STATUS: SUCCESS')
      })

      it('truncates output exceeding 4000 characters to protect against token blowout', async () => {
        const res = await makeRequest('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({
          tool: 'execute_command',
          args: { command: 'Write-Output ("A" * 5000)' }
        }))

        expect(res.statusCode).toBe(200)
        const json = JSON.parse(res.body)
        expect(json.success).toBe(true)
        expect(json.data.result).toContain('Output dipotong karena melebihi 4000 karakter')
      })
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 3: Dynamic Tool Registration with Complex Nested Schemas
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Dynamic Tool Registration & Complex Nested Schema Normalization', () => {
    it('3.1 normalizeSchemaTypes handles deeply nested object hierarchies', () => {
      const complexNestedSchema = {
        type: 'object',
        description: 'Complex enterprise payload schema',
        properties: {
          level1_string: { type: 'string', description: 'Top level string' },
          level1_object: {
            type: 'object',
            properties: {
              level2_number: { type: 'number' },
              level2_boolean: { type: 'boolean' },
              level2_nested: {
                type: 'object',
                properties: {
                  level3_integer: { type: 'integer' },
                  level3_array: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        item_id: { type: 'string' },
                        item_val: { type: 'number' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        required: ['level1_string']
      }

      const normalized = normalizeSchemaTypes(complexNestedSchema)

      expect(normalized.type).toBe('OBJECT')
      expect(normalized.properties.level1_string.type).toBe('STRING')
      expect(normalized.properties.level1_object.type).toBe('OBJECT')
      expect(normalized.properties.level1_object.properties.level2_number.type).toBe('NUMBER')
      expect(normalized.properties.level1_object.properties.level2_boolean.type).toBe('BOOLEAN')
      expect(normalized.properties.level1_object.properties.level2_nested.type).toBe('OBJECT')
      expect(normalized.properties.level1_object.properties.level2_nested.properties.level3_integer.type).toBe('INTEGER')
      expect(normalized.properties.level1_object.properties.level2_nested.properties.level3_array.type).toBe('ARRAY')
      expect(normalized.properties.level1_object.properties.level2_nested.properties.level3_array.items.type).toBe('OBJECT')
      expect(normalized.properties.level1_object.properties.level2_nested.properties.level3_array.items.properties.item_id.type).toBe('STRING')
      expect(normalized.properties.level1_object.properties.level2_nested.properties.level3_array.items.properties.item_val.type).toBe('NUMBER')
      expect(normalized.required).toEqual(['level1_string'])
    })

    it('3.2 normalizeSchemaTypes handles arrays of primitive types', () => {
      const arrayPrimitiveSchema = {
        type: 'object',
        properties: {
          string_list: {
            type: 'array',
            items: { type: 'string' }
          },
          number_list: {
            type: 'array',
            items: { type: 'number' }
          }
        }
      }

      const normalized = normalizeSchemaTypes(arrayPrimitiveSchema)
      expect(normalized.type).toBe('OBJECT')
      expect(normalized.properties.string_list.type).toBe('ARRAY')
      expect(normalized.properties.string_list.items.type).toBe('STRING')
      expect(normalized.properties.number_list.type).toBe('ARRAY')
      expect(normalized.properties.number_list.items.type).toBe('NUMBER')
    })

    it('3.3 normalizeSchemaTypes handles empty, null, and primitive input safely', () => {
      const invalidInputs = [null, undefined, '', 'string', 1234, true, false, []]

      for (const input of invalidInputs) {
        const normalized = normalizeSchemaTypes(input)
        expect(normalized).toBeDefined()
        expect(normalized.type).toBe('OBJECT')
        expect(normalized.properties).toEqual({})
      }
    })

    it('3.4 normalizeSchemaTypes handles schemas with missing type or properties', () => {
      const incomplete1 = { description: 'No type specified' }
      const norm1 = normalizeSchemaTypes(incomplete1)
      expect(norm1.type).toBe('OBJECT')
      expect(norm1.properties).toEqual({})

      const incomplete2 = { type: 'object' } // no properties
      const norm2 = normalizeSchemaTypes(incomplete2)
      expect(norm2.type).toBe('OBJECT')
      expect(norm2.properties).toEqual({})
    })

    it('3.5 dynamic skill registration survives corrupted/invalid JSON in parameters_schema', () => {
      db.prepare(`
        INSERT INTO skills_metadata (
          skill_id, name, description, file_path, entrypoint, version, parameters_schema, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        'skill_corrupted_json',
        'corrupted_json_skill',
        'Skill with corrupted parameter JSON schema',
        join(testSkillsDir, 'corrupted.py'),
        'run',
        '1.0.0',
        '{ invalid_json_syntax: true, unclosed '
      )

      expect(() => {
        const tools = getDynamicGeminiTools(db)
        expect(tools.length).toBe(1)
        expect(tools[0].functionDeclarations.length).toBeGreaterThanOrEqual(13)
      }).not.toThrow()
    })

    it('3.6 registers multiple diverse dynamic skills with complex parameters and uppercase types', () => {
      const skillsToRegister = [
        {
          skillId: 'skill_db_migrator',
          name: 'db_migrator',
          description: 'Migrates SQLite database tables.',
          filePath: join(testSkillsDir, 'db_migrator.py'),
          entrypoint: 'run',
          version: '2.1.0',
          parametersSchema: {
            type: 'object' as const,
            properties: {
              targetTable: { type: 'string', description: 'Table name' },
              dryRun: { type: 'boolean', description: 'Dry run flag' },
              options: {
                type: 'object' as any,
                properties: {
                  batchSize: { type: 'integer' },
                  retryCount: { type: 'number' }
                }
              }
            },
            required: ['targetTable']
          },
          rawDocstring: ''
        },
        {
          skillId: 'skill_sentiment_analyzer',
          name: 'sentiment_analyzer',
          description: 'Analyzes user text emotion & sentiment.',
          filePath: join(testSkillsDir, 'sentiment_analyzer.py'),
          entrypoint: 'analyze',
          version: '1.0.0',
          parametersSchema: {
            type: 'object' as const,
            properties: {
              textSamples: {
                type: 'array' as any,
                items: { type: 'string' }
              }
            }
          },
          rawDocstring: ''
        }
      ]

      for (const s of skillsToRegister) {
        upsertSkillMetadata(s, db)
      }

      const tools = getDynamicGeminiTools(db)
      const declarations = tools[0].functionDeclarations

      expect(declarations.some((d: any) => d.name === 'manage_installation_files')).toBe(true)
      expect(declarations.some((d: any) => d.name === 'execute_command')).toBe(true)

      const migratorDecl = declarations.find((d: any) => d.name === 'skill_db_migrator')
      expect(migratorDecl).toBeDefined()
      expect(migratorDecl.parameters.type).toBe('OBJECT')
      expect(migratorDecl.parameters.properties.targetTable.type).toBe('STRING')
      expect(migratorDecl.parameters.properties.dryRun.type).toBe('BOOLEAN')
      expect(migratorDecl.parameters.properties.options.type).toBe('OBJECT')
      expect(migratorDecl.parameters.properties.options.properties.batchSize.type).toBe('INTEGER')

      const sentimentDecl = declarations.find((d: any) => d.name === 'skill_sentiment_analyzer')
      expect(sentimentDecl).toBeDefined()
      expect(sentimentDecl.parameters.properties.textSamples.type).toBe('ARRAY')
      expect(sentimentDecl.parameters.properties.textSamples.items.type).toBe('STRING')
    })
  })
})
