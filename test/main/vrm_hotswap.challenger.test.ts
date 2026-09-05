import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'

// Mock Electron
const mockSend1 = vi.fn()
const mockSend2 = vi.fn()
const mockSendDestroyed = vi.fn()

const mockWindow1 = {
  isDestroyed: () => false,
  webContents: { send: mockSend1 }
}
const mockWindow2 = {
  isDestroyed: () => false,
  webContents: { send: mockSend2 }
}
const mockDestroyedWindow = {
  isDestroyed: () => true,
  webContents: { send: mockSendDestroyed }
}

const mockIpcHandlers: Record<string, Function> = {}

vi.mock('electron', () => {
  const tmpDir = path.join(process.cwd(), 'temp_test_userdata_vrm')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }
  return {
    app: {
      getPath: () => tmpDir,
      getAppPath: () => process.cwd()
    },
    ipcMain: {
      handle: (channel: string, handler: Function) => {
        mockIpcHandlers[channel] = handler
      },
      on: vi.fn()
    },
    desktopCapturer: {
      getSources: vi.fn().mockResolvedValue([])
    },
    BrowserWindow: {
      getAllWindows: () => [mockWindow1, mockWindow2, mockDestroyedWindow]
    }
  }
})

// Mock fetch for embeddings
const originalFetch = globalThis.fetch
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const urlStr = String(input)
  if (urlStr.includes('generativelanguage.googleapis.com') && urlStr.includes('embedContent')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        embedding: {
          values: new Array(768).fill(0.01)
        }
      }),
      text: async () => ''
    } as any
  }
  return originalFetch(input, init)
})

import { registerIpcHandlers } from '../../src/main/ipc'
import { startHttpServer, stopHttpServer, setServerMainWindow } from '../../src/main/server'
import { getConfig } from '../../src/main/database'

const TEST_PORT = 14228
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
      res.on('data', (chunk) => {
        data += chunk.toString('utf-8')
      })
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

describe('M2 Empirical Challenger: VRM Hot-Swap & Broadcast Verification Suite', () => {
  beforeAll(async () => {
    registerIpcHandlers()
    startHttpServer(TEST_PORT)
    await new Promise((r) => setTimeout(r, 200))
  })

  afterAll(() => {
    stopHttpServer()
  })

  // ─────────────────────────────────────────────────────────────
  // 1. Electron Window IPC Handler: vrm:select
  // ─────────────────────────────────────────────────────────────
  describe('1. Electron Window IPC Handler (vrm:select)', () => {
    it('1.1 registers vrm:select IPC handler and broadcasts vrm:swap to all non-destroyed windows', async () => {
      mockSend1.mockClear()
      mockSend2.mockClear()
      mockSendDestroyed.mockClear()

      expect(mockIpcHandlers['vrm:select']).toBeDefined()

      const result = await mockIpcHandlers['vrm:select']({}, 'cyber_bot_2099.vrm')

      const expectedUrl = 'http://127.0.0.1:14228/models/cyber_bot_2099.vrm'

      expect(result).toEqual({
        success: true,
        activeAvatar: 'cyber_bot_2099.vrm',
        avatarUrl: expectedUrl
      })

      // Must send to active windows
      expect(mockSend1).toHaveBeenCalledTimes(1)
      expect(mockSend1).toHaveBeenCalledWith('vrm:swap', expectedUrl)

      expect(mockSend2).toHaveBeenCalledTimes(1)
      expect(mockSend2).toHaveBeenCalledWith('vrm:swap', expectedUrl)

      // Must NEVER send to destroyed windows
      expect(mockSendDestroyed).not.toHaveBeenCalled()

      // Active config must be persisted
      expect(getConfig('ACTIVE_VRM_MODEL')).toBe('cyber_bot_2099.vrm')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 2. REST API: /api/vrm/select Hot-Swap Broadcasting
  // ─────────────────────────────────────────────────────────────
  describe('2. REST API /api/vrm/select Hot-Swap Broadcasting', () => {
    it('2.1 POST /api/vrm/select correctly sets active model, broadcasts vrm:swap to all open windows without duplicate sends', async () => {
      mockSend1.mockClear()
      mockSend2.mockClear()
      mockSendDestroyed.mockClear()

      // Set mockWindow1 as mainWindowRef
      setServerMainWindow(mockWindow1 as any)

      const payload = JSON.stringify({ filename: 'hologram_companion.vrm' })
      const res = await makeRequest(
        '/api/vrm/select',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        payload
      )

      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.message).toContain('Karakter VRM aktif berhasil diubah')
      expect(json.data.activeAvatar).toBe('hologram_companion.vrm')
      expect(json.data.avatarUrl).toBe('http://127.0.0.1:14228/models/hologram_companion.vrm')

      // Check broadcast calls
      expect(mockSend1).toHaveBeenCalledTimes(1)
      expect(mockSend1).toHaveBeenCalledWith(
        'vrm:swap',
        'http://127.0.0.1:14228/models/hologram_companion.vrm'
      )

      expect(mockSend2).toHaveBeenCalledTimes(1)
      expect(mockSend2).toHaveBeenCalledWith(
        'vrm:swap',
        'http://127.0.0.1:14228/models/hologram_companion.vrm'
      )

      // Destroyed window is never called
      expect(mockSendDestroyed).not.toHaveBeenCalled()
    })

    it('2.2 POST /api/vrm/select with invalid/missing payload returns HTTP 400 error', async () => {
      const resEmpty = await makeRequest(
        '/api/vrm/select',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        JSON.stringify({})
      )

      expect(resEmpty.statusCode).toBe(400)
      const json = JSON.parse(resEmpty.body)
      expect(json.success).toBe(false)
      expect(json.error).toContain('Nama file VRM wajib diisi')
    })
  })

  // ─────────────────────────────────────────────────────────────
  // 3. VRM Upload, Static Serving, and Deletion Lifecycle
  // ─────────────────────────────────────────────────────────────
  describe('3. VRM Upload, Static Serving, and Deletion Lifecycle', () => {
    const testFilename = 'challenger_test_model.vrm'
    const testBinaryData = Buffer.from('VRM_GLTF_BINARY_TEST_PAYLOAD_CHALLENGER_M2')

    it('3.1 uploads VRM file via POST /api/vrm/upload', async () => {
      const res = await makeRequest(
        '/api/vrm/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-VRM-Filename': testFilename
          }
        },
        testBinaryData
      )

      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data.filename).toBe(testFilename)
      expect(json.data.url).toBe(`http://127.0.0.1:14228/models/${testFilename}`)
    })

    it('3.2 serves static VRM model with model/gltf-binary content type via GET /models/:filename', async () => {
      const res = await makeRequest(`/models/${testFilename}`)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('model/gltf-binary')
      expect(res.body).toBe('VRM_GLTF_BINARY_TEST_PAYLOAD_CHALLENGER_M2')
    })

    it('3.3 lists uploaded avatar in gallery via GET /api/vrm', async () => {
      const res = await makeRequest('/api/vrm')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      const found = json.data.avatars.find((a: any) => a.filename === testFilename)
      expect(found).toBeDefined()
      expect(found.isBuiltIn).toBe(false)
    })

    it('3.4 deletes custom avatar via DELETE /api/vrm/:filename and verifies it is no longer served', async () => {
      const res = await makeRequest(`/api/vrm/${testFilename}`, { method: 'DELETE' })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)

      const res404 = await makeRequest(`/models/${testFilename}`)
      expect(res404.statusCode).toBe(404)
    })
  })
})
