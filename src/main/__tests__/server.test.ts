import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { vi } from 'vitest'

// Mock Electron before loading server
vi.mock('electron', () => {
  const tmpDir = path.join(process.cwd(), 'temp_test_userdata')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
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

// Mock fetch for Gemini API embedding calls
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

// Ensure index.html exists in out/renderer/index.html for SPA fallback tests
const outRendererDir = path.join(process.cwd(), 'out/renderer')
if (!fs.existsSync(outRendererDir)) {
  fs.mkdirSync(outRendererDir, { recursive: true })
}
const outIndexHtml = path.join(outRendererDir, 'index.html')
if (!fs.existsSync(outIndexHtml)) {
  fs.writeFileSync(outIndexHtml, '<!DOCTYPE html><html><body>Jarvis SPA Test</body></html>')
}

import { startHttpServer, stopHttpServer } from '../server'

const PORT = 14228
const BASE_URL = `http://127.0.0.1:${PORT}`

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

describe('M2 HTTP Server & REST API Empirical Verification', () => {
  beforeAll(async () => {
    startHttpServer(PORT)
    await new Promise((r) => setTimeout(r, 200))
  })

  afterAll(() => {
    stopHttpServer()
  })

  describe('CORS and Preflight (OPTIONS)', () => {
    it('should return CORS headers on OPTIONS preflight request', async () => {
      const res = await makeRequest('/api/settings', { method: 'OPTIONS' })
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('*')
      expect(res.headers['access-control-allow-methods']).toContain('GET')
      expect(res.headers['access-control-allow-headers']).toContain('Content-Type')
    })
  })

  describe('SPA Static Files and Fallback Handling', () => {
    it('should serve index.html for root path /', async () => {
      const res = await makeRequest('/')
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.body).toContain('Jarvis')
    })

    it('should serve index.html for /dashboard', async () => {
      const res = await makeRequest('/dashboard')
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
    })

    it('should fallback to index.html for unknown page routes', async () => {
      const res = await makeRequest('/some/unknown/spa/route')
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
    })
  })

  describe('REST API Endpoint: /api/settings', () => {
    it('GET /api/settings should return current settings object', async () => {
      const res = await makeRequest('/api/settings')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toHaveProperty('model')
      expect(json.data).toHaveProperty('systemPrompt')
      expect(json.data).toHaveProperty('apiKey')
      expect(json.data).toHaveProperty('voice')
    })

    it('POST /api/settings should update settings', async () => {
      const updatePayload = JSON.stringify({
        model: 'gemini-2.5-flash',
        systemPrompt: 'You are Jarvis, an advanced assistant.',
        voice: 'id-ID-ArdiNeural'
      })
      const res = await makeRequest('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, updatePayload)

      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.message).toContain('berhasil diperbarui')

      const checkRes = await makeRequest('/api/settings')
      const checkJson = JSON.parse(checkRes.body)
      expect(checkJson.data.model).toBe('gemini-2.5-flash')
      expect(checkJson.data.systemPrompt).toBe('You are Jarvis, an advanced assistant.')
    })
  })

  describe('REST API Endpoint: /api/keypool & /api/keypool/rotate', () => {
    it('GET /api/keypool should return keypool status', async () => {
      const res = await makeRequest('/api/keypool')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toHaveProperty('totalKeys')
      expect(json.data).toHaveProperty('activeKeys')
    })

    it('POST /api/keypool should add a key to pool', async () => {
      const payload = JSON.stringify({ apiKey: 'AIzaSyTestKeyForPool999' })
      const res = await makeRequest('/api/keypool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
    })

    it('POST /api/keypool/rotate should rotate active key', async () => {
      const res = await makeRequest('/api/keypool/rotate', { method: 'POST' })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.message).toContain('Rotasi paksa')
      expect(json.data).toHaveProperty('stats')
    })

    it('DELETE /api/keypool should remove key from pool via JSON body', async () => {
      const payload = JSON.stringify({ apiKey: 'AIzaSyTestKeyForPool999' })
      const res = await makeRequest('/api/keypool', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      }, payload)
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
    })

    it('DELETE /api/keypool should remove key from pool via query param', async () => {
      const addPayload = JSON.stringify({ apiKey: 'AIzaSyTestKeyQueryParam888' })
      await makeRequest('/api/keypool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, addPayload)

      const res = await makeRequest('/api/keypool?apiKey=AIzaSyTestKeyQueryParam888', {
        method: 'DELETE'
      })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
    })
  })

  describe('REST API Endpoint: /api/memory/episodic', () => {
    it('GET /api/memory/episodic should return episodic context', async () => {
      const res = await makeRequest('/api/memory/episodic?session=default')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toBeDefined()
    })

    it('POST /api/memory/episodic/summarize should trigger summarization', async () => {
      const payload = JSON.stringify({ sessionId: 'default' })
      const res = await makeRequest('/api/memory/episodic/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toHaveProperty('summary')
    })

    it('DELETE /api/memory/episodic should clear episodic buffer', async () => {
      const res = await makeRequest('/api/memory/episodic?session=default', { method: 'DELETE' })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
    })
  })

  describe('REST API Endpoint: /api/memory/semantic', () => {
    let createdSnippetId = ''

    it('POST /api/memory/semantic should save semantic memory snippet', async () => {
      const payload = JSON.stringify({
        content: 'Jarvis is an AI companion created for voice interaction.',
        category: 'general',
        tags: ['ai', 'voice']
      })
      const res = await makeRequest('/api/memory/semantic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toHaveProperty('id')
      createdSnippetId = json.data.id
    })

    it('GET /api/memory/semantic should list semantic memories', async () => {
      const res = await makeRequest('/api/memory/semantic?category=general')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(Array.isArray(json.data)).toBe(true)
    })

    it('POST /api/memory/semantic without content should return 400 error', async () => {
      const payload = JSON.stringify({})
      const res = await makeRequest('/api/memory/semantic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)
      expect(res.statusCode).toBe(400)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(false)
      expect(json.error).toContain('wajib diisi')
    })

    it('POST /api/memory/semantic/search should search memories', async () => {
      const payload = JSON.stringify({ query: 'Jarvis AI' })
      const res = await makeRequest('/api/memory/semantic/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(Array.isArray(json.data)).toBe(true)
    })

    it('DELETE /api/memory/semantic/:id should delete semantic item', async () => {
      const snippetId = createdSnippetId || 'non_existent_id'
      const res = await makeRequest(`/api/memory/semantic/${snippetId}`, { method: 'DELETE' })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json).toHaveProperty('success')
    })
  })

  describe('REST API Endpoint: /api/logs & /api/logs/console', () => {
    it('GET /api/logs should return execution logs', async () => {
      const res = await makeRequest('/api/logs?limit=10')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toBeDefined()
    })

    it('GET /api/logs/console should return console entries', async () => {
      const res = await makeRequest('/api/logs/console?limit=50')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toHaveProperty('entries')
    })

    it('DELETE /api/logs should clear logs', async () => {
      const res = await makeRequest('/api/logs', { method: 'DELETE' })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
    })
  })

  describe('REST API Endpoint: /api/vrm & /api/vrm/select', () => {
    it('GET /api/vrm should return available avatar gallery', async () => {
      const res = await makeRequest('/api/vrm')
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data).toHaveProperty('activeAvatar')
      expect(json.data).toHaveProperty('avatars')
    })

    it('POST /api/vrm/upload should save uploaded file', async () => {
      const fakeVrmBuffer = Buffer.from('FAKE_VRM_BINARY_DATA_HEADER_12345')
      const res = await makeRequest('/api/vrm/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-VRM-Filename': 'test_avatar_challenger.vrm'
        }
      }, fakeVrmBuffer)
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data.filename).toBe('test_avatar_challenger.vrm')
    })

    it('POST /api/vrm/select should set active VRM and trigger IPC event', async () => {
      const payload = JSON.stringify({ filename: 'test_avatar_challenger.vrm' })
      const res = await makeRequest('/api/vrm/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, payload)
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
      expect(json.data.activeAvatar).toBe('test_avatar_challenger.vrm')
    })

    it('GET /models/test_avatar_challenger.vrm should serve static model', async () => {
      const res = await makeRequest('/models/test_avatar_challenger.vrm')
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('model/gltf-binary')
    })

    it('DELETE /api/vrm/test_avatar_challenger.vrm should delete custom model', async () => {
      const res = await makeRequest('/api/vrm/test_avatar_challenger.vrm', { method: 'DELETE' })
      expect(res.statusCode).toBe(200)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(true)
    })
  })

  describe('Invalid API Routes and Error Payloads', () => {
    it('should return 404 JSON error payload for unknown /api/ route', async () => {
      const res = await makeRequest('/api/non_existent_endpoint')
      expect(res.statusCode).toBe(404)
      const json = JSON.parse(res.body)
      expect(json.success).toBe(false)
      expect(json.error).toContain('tidak ditemukan')
    })
  })
})
