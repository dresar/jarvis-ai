import http from 'http'
import fs from 'fs'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import {
  getConfig,
  setConfig,
  getApiKeyPoolStatus,
  getExecutionLogs,
  searchSemanticMemory,
  clearExecutionLogs,
  maskApiKey
} from './database'
import { getKeyPoolStatus, addKeyToPool, removeKeyFromPool, selectBestKey } from './keyPoolManager'
import { validateAndSelectModel } from './modelSelector'
import { resetChat, setApiKeyAndReset } from './ai'
import {
  getEpisodicContext,
  triggerAutoSummarization,
  clearEpisodicBuffer
} from './memory/episodicBuffer'
import {
  saveSemanticMemorySnippet,
  retrieveSemanticMemories,
  deleteSemanticMemoryItem
} from './memory/semanticRag'
import { consoleLogger } from './logger'
import {
  listAvailableVrmAvatars,
  saveUploadedVrmFile,
  deleteCustomVrmFile,
  setActiveVrmAvatar,
  getVrmDir
} from './vrmManager'
import { getDynamicGeminiTools, executeTool } from './tools'

let server: http.Server | null = null
let mainWindowRef: BrowserWindow | null = null

export function setServerMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

function sendJsonResponse(res: http.ServerResponse, statusCode: number, payload: any): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-VRM-Filename'
  })
  res.end(JSON.stringify(payload))
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function parseBufferBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function startHttpServer(port = 14228): void {
  if (server) return

  try {
    server = http.createServer(async (req, res) => {
      // CORS Preflight
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With, X-VRM-Filename'
      )

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      const pathname = decodeURIComponent(parsedUrl.pathname)

      try {
        // ─────────────────────────────────────────────────────────────
        // REST API ROUTING (/api/*)
        // ─────────────────────────────────────────────────────────────
        if (pathname.startsWith('/api/')) {
          await handleApiRoute(req, res, pathname, parsedUrl)
          return
        }

        // ─────────────────────────────────────────────────────────────
        // STATIC VRM MODELS ROUTING (/models/*)
        // ─────────────────────────────────────────────────────────────
        if (pathname.startsWith('/models/')) {
          const filename = path.basename(pathname)
          const candidatePaths = [
            path.join(getVrmDir(), filename),
            path.join(__dirname, '../../src/renderer/public/models', filename),
            path.join(__dirname, '../renderer/models', filename),
            path.join(app.getAppPath(), 'out/renderer/models', filename),
            path.join(process.resourcesPath || '', 'app.asar.unpacked/out/renderer/models', filename)
          ]

          let targetFile = ''
          for (const p of candidatePaths) {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
              targetFile = p
              break
            }
          }

          if (targetFile) {
            const buf = fs.readFileSync(targetFile)
            res.writeHead(200, {
              'Content-Type': 'model/gltf-binary',
              'Content-Length': buf.length
            })
            res.end(buf)
            return
          } else {
            sendJsonResponse(res, 404, { success: false, error: 'VRM Model file not found' })
            return
          }
        }

        // ─────────────────────────────────────────────────────────────
        // STATIC FILE SERVING FOR SPA WEB DASHBOARD
        // ─────────────────────────────────────────────────────────────
        let reqFilePath = pathname
        if (reqFilePath === '/' || reqFilePath === '/dashboard' || reqFilePath.startsWith('/dashboard/')) {
          reqFilePath = '/index.html'
        }

        const candidateDistPaths = [
          path.join(process.resourcesPath || '', 'app.asar.unpacked/out/renderer', reqFilePath),
          path.join(__dirname, '../renderer', reqFilePath),
          path.join(app.getAppPath(), 'out/renderer', reqFilePath),
          path.join(__dirname, '../../src/renderer/public', reqFilePath),
          path.join(process.resourcesPath || '', 'app.asar.unpacked/resources', reqFilePath)
        ]

        let targetDistFile = ''
        for (const p of candidateDistPaths) {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            targetDistFile = p
            break
          }
        }

        // SPA Fallback: If static asset not found, serve index.html for client routing
        if (!targetDistFile) {
          const indexCandidates = [
            path.join(process.resourcesPath || '', 'app.asar.unpacked/out/renderer/index.html'),
            path.join(__dirname, '../renderer/index.html'),
            path.join(app.getAppPath(), 'out/renderer/index.html')
          ]
          for (const p of indexCandidates) {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
              targetDistFile = p
              break
            }
          }
        }

        if (targetDistFile && fs.existsSync(targetDistFile)) {
          const ext = path.extname(targetDistFile).toLowerCase().substring(1)
          const mimeMap: Record<string, string> = {
            html: 'text/html; charset=utf-8',
            js: 'application/javascript; charset=utf-8',
            css: 'text/css; charset=utf-8',
            json: 'application/json; charset=utf-8',
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            svg: 'image/svg+xml',
            ico: 'image/x-icon',
            wasm: 'application/wasm',
            vrm: 'model/gltf-binary',
            glb: 'model/gltf-binary'
          }
          const buf = fs.readFileSync(targetDistFile)
          res.writeHead(200, {
            'Content-Type': mimeMap[ext] || 'application/octet-stream',
            'Content-Length': buf.length
          })
          res.end(buf)
          return
        }

        sendJsonResponse(res, 404, { success: false, error: 'Resource not found' })
      } catch (err: any) {
        console.error('[HttpServer Error]:', err)
        sendJsonResponse(res, 500, { success: false, error: err?.message || 'Internal Server Error' })
      }
    })

    server.listen(port, '127.0.0.1', () => {
      console.log(`[Jarvis HTTP Server] Listening on http://127.0.0.1:${port}`)
    })
  } catch (err) {
    console.error('[Jarvis HTTP Server] Failed to start:', err)
  }
}

export function stopHttpServer(): void {
  if (server) {
    try {
      server.close()
    } catch {}
    server = null
  }
}

// ─────────────────────────────────────────────────────────────
// REST API ROUTE HANDLER MATRIX
// ─────────────────────────────────────────────────────────────
async function handleApiRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  parsedUrl: URL
): Promise<void> {
  const method = req.method?.toUpperCase() || 'GET'

  // 1. /api/settings (GET/POST)
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const model = validateAndSelectModel(getConfig('GEMINI_MODEL') ?? undefined)
      const systemPrompt = getConfig('SYSTEM_PROMPT') ?? ''
      const apiKey = getConfig('GEMINI_API_KEY') ?? ''
      const voice = getConfig('EDGE_TTS_VOICE') ?? 'id-ID-ArdiNeural'
      sendJsonResponse(res, 200, {
        success: true,
        data: { model, systemPrompt, apiKey, voice }
      })
      return
    }

    if (method === 'POST') {
      const body = await parseJsonBody(req)
      if (body.model) {
        const validModel = validateAndSelectModel(body.model)
        setConfig('GEMINI_MODEL', validModel)
      }
      if (typeof body.systemPrompt === 'string') {
        setConfig('SYSTEM_PROMPT', body.systemPrompt)
      }
      if (body.apiKey) {
        const key = String(body.apiKey).trim()
        setConfig('GEMINI_API_KEY', key)
        if (key) {
          addKeyToPool(key)
          setApiKeyAndReset(key)
        }
      }
      if (body.voice) {
        setConfig('EDGE_TTS_VOICE', body.voice)
      }
      sendJsonResponse(res, 200, {
        success: true,
        message: 'Pengaturan berhasil diperbarui.'
      })
      return
    }
  }

  // /api/chat/reset (POST)
  if (pathname === '/api/chat/reset' && method === 'POST') {
    resetChat()
    sendJsonResponse(res, 200, { success: true, message: 'Percakapan dan memori berhasil direset.' })
    return
  }

  // 2. /api/keypool & /api/keypool/rotate
  if (pathname === '/api/keypool/rotate' && method === 'POST') {
    const selectedKey = selectBestKey()
    const stats = getKeyPoolStatus()
    sendJsonResponse(res, 200, {
      success: true,
      message: 'Rotasi paksa API Key pool berhasil.',
      data: {
        activeKeyId: selectedKey?.id || null,
        maskedKey: selectedKey ? maskApiKey(selectedKey.apiKey) : null,
        status: selectedKey?.status || 'UNKNOWN',
        stats
      }
    })
    return
  }

  if (pathname === '/api/keypool') {
    if (method === 'GET') {
      const memoryStats = getKeyPoolStatus()
      const dbStats = getApiKeyPoolStatus()
      sendJsonResponse(res, 200, {
        success: true,
        data: {
          totalKeys: dbStats.totalKeys || memoryStats.totalKeys,
          activeKeys: memoryStats.activeKeys,
          cooldownKeys: memoryStats.cooldownKeys,
          disabledKeys: memoryStats.disabledKeys,
          totalSuccessCalls: memoryStats.totalSuccessCalls,
          totalFailedCalls: memoryStats.totalFailedCalls,
          keyDetails: dbStats.keyDetails || []
        }
      })
      return
    }

    if (method === 'POST') {
      const body = await parseJsonBody(req)
      const key = body.apiKey || body.key
      if (!key || typeof key !== 'string' || !key.trim()) {
        sendJsonResponse(res, 400, { success: false, error: 'API Key wajib diisi.' })
        return
      }
      const ok = addKeyToPool(key.trim())
      sendJsonResponse(res, ok ? 200 : 400, {
        success: ok,
        message: ok ? 'API Key berhasil ditambahkan.' : 'API Key gagal ditambahkan.'
      })
      return
    }

    if (method === 'DELETE') {
      const body = await parseJsonBody(req)
      const key = body.apiKey || body.id || parsedUrl.searchParams.get('apiKey') || parsedUrl.searchParams.get('id')
      if (!key) {
        sendJsonResponse(res, 400, { success: false, error: 'API Key atau ID wajib diisi.' })
        return
      }
      const ok = removeKeyFromPool(String(key))
      sendJsonResponse(res, 200, { success: ok, message: 'API Key berhasil dihapus dari pool.' })
      return
    }
  }

  // 3. /api/memory/episodic
  if (pathname === '/api/memory/episodic') {
    const sessionId = parsedUrl.searchParams.get('session') || 'default'

    if (method === 'GET') {
      const episodicData = getEpisodicContext(sessionId)
      sendJsonResponse(res, 200, { success: true, data: episodicData })
      return
    }

    if (method === 'DELETE') {
      clearEpisodicBuffer(sessionId)
      sendJsonResponse(res, 200, { success: true, message: `Buffer sesi '${sessionId}' dibersihkan.` })
      return
    }
  }

  if (pathname === '/api/memory/episodic/summarize' && method === 'POST') {
    const body = await parseJsonBody(req)
    const sessionId = body.sessionId || parsedUrl.searchParams.get('session') || 'default'
    const summary = await triggerAutoSummarization(sessionId)
    sendJsonResponse(res, 200, { success: true, data: { summary } })
    return
  }

  // 4. /api/memory/semantic
  if (pathname === '/api/memory/semantic/search' && method === 'POST') {
    const body = await parseJsonBody(req)
    const query = body.query || ''
    const category = body.category
    const limit = body.limit || 20
    const minScore = body.minScore ?? 0.3
    const results = await retrieveSemanticMemories(query, { category, limit, minScore })
    sendJsonResponse(res, 200, { success: true, data: results })
    return
  }

  if (pathname === '/api/memory/semantic') {
    if (method === 'GET') {
      const category = parsedUrl.searchParams.get('category') || undefined
      const limitStr = parsedUrl.searchParams.get('limit')
      const limit = limitStr ? parseInt(limitStr, 10) : 50
      const results = searchSemanticMemory('', category, limit)
      sendJsonResponse(res, 200, { success: true, data: results })
      return
    }

    if (method === 'POST') {
      const body = await parseJsonBody(req)
      if (!body.content) {
        sendJsonResponse(res, 400, { success: false, error: 'Konten memori semantik wajib diisi.' })
        return
      }
      const item = await saveSemanticMemorySnippet({
        content: body.content,
        category: body.category || 'general',
        tags: body.tags || []
      })
      sendJsonResponse(res, 200, { success: true, data: item })
      return
    }

    if (method === 'DELETE') {
      const body = await parseJsonBody(req)
      const id = body.id || parsedUrl.searchParams.get('id')
      if (!id) {
        sendJsonResponse(res, 400, { success: false, error: 'ID memori wajib diisi.' })
        return
      }
      const ok = deleteSemanticMemoryItem(String(id))
      sendJsonResponse(res, 200, { success: ok, message: 'Snippet memori berhasil dihapus.' })
      return
    }
  }

  // Delete semantic snippet via path /api/memory/semantic/:id
  if (pathname.startsWith('/api/memory/semantic/') && method === 'DELETE') {
    const id = pathname.replace('/api/memory/semantic/', '')
    if (id && id !== 'search') {
      const ok = deleteSemanticMemoryItem(id)
      sendJsonResponse(res, 200, { success: ok, message: 'Snippet memori berhasil dihapus.' })
      return
    }
  }

  // 5. /api/logs & /api/logs/console
  if (pathname === '/api/logs/console' && method === 'GET') {
    const since = parsedUrl.searchParams.get('since') || undefined
    const limitStr = parsedUrl.searchParams.get('limit')
    const limit = limitStr ? parseInt(limitStr, 10) : 200
    const entries = consoleLogger.getEntries(since, limit)
    sendJsonResponse(res, 200, { success: true, data: { entries } })
    return
  }

  if (pathname === '/api/logs') {
    if (method === 'GET') {
      const status = parsedUrl.searchParams.get('status') || undefined
      const limitStr = parsedUrl.searchParams.get('limit')
      const offsetStr = parsedUrl.searchParams.get('offset')
      const filters = {
        status: status as any,
        limit: limitStr ? parseInt(limitStr, 10) : 50,
        offset: offsetStr ? parseInt(offsetStr, 10) : 0
      }
      const logsData = getExecutionLogs(filters)
      sendJsonResponse(res, 200, { success: true, data: logsData })
      return
    }

    if (method === 'DELETE') {
      clearExecutionLogs()
      consoleLogger.clear()
      sendJsonResponse(res, 200, { success: true, message: 'Log eksekusi dan konsol dibersihkan.' })
      return
    }
  }

  // 6. /api/vrm & /api/vrm/select
  if (pathname === '/api/vrm/select' && method === 'POST') {
    const body = await parseJsonBody(req)
    const filename = body.filename
    if (!filename || typeof filename !== 'string') {
      sendJsonResponse(res, 400, { success: false, error: 'Nama file VRM wajib diisi.' })
      return
    }

    setActiveVrmAvatar(filename)
    const avatarUrl = `http://127.0.0.1:14228/models/${filename}`

    // Broadcast IPC event to renderer webContents for instant hot-swapping
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('vrm:swap', avatarUrl)
    }
    BrowserWindow.getAllWindows().forEach((win) => {
      if (win !== mainWindowRef && !win.isDestroyed()) {
        win.webContents.send('vrm:swap', avatarUrl)
      }
    })

    sendJsonResponse(res, 200, {
      success: true,
      message: 'Karakter VRM aktif berhasil diubah.',
      data: {
        activeAvatar: filename,
        avatarUrl
      }
    })
    return
  }

  if (pathname === '/api/vrm' || pathname === '/api/vrm/upload') {
    if (method === 'GET') {
      const avatars = listAvailableVrmAvatars()
      const activeAvatar = getConfig('ACTIVE_VRM_MODEL') || 'avatar.vrm'
      sendJsonResponse(res, 200, {
        success: true,
        data: {
          activeAvatar,
          avatars
        }
      })
      return
    }

    if (method === 'POST') {
      try {
        const headerFilename = req.headers['x-vrm-filename'] as string
        const buffer = await parseBufferBody(req)

        if (!buffer || buffer.length === 0) {
          sendJsonResponse(res, 400, { success: false, error: 'Payload file kosong.' })
          return
        }

        let targetFilename = headerFilename || `vrm_${Date.now()}.vrm`
        if (!targetFilename.endsWith('.vrm') && !targetFilename.endsWith('.glb')) {
          targetFilename += '.vrm'
        }

        const savedName = saveUploadedVrmFile(targetFilename, buffer)
        const url = `http://127.0.0.1:14228/models/${savedName}`

        sendJsonResponse(res, 200, {
          success: true,
          message: 'File VRM berhasil diunggah.',
          data: {
            filename: savedName,
            url
          }
        })
      } catch (err: any) {
        sendJsonResponse(res, 400, { success: false, error: err?.message || 'Gagal mengunggah VRM.' })
      }
      return
    }

    if (method === 'DELETE') {
      const body = await parseJsonBody(req)
      const filename = body.filename || parsedUrl.searchParams.get('filename')
      if (!filename) {
        sendJsonResponse(res, 400, { success: false, error: 'Nama file wajib diisi.' })
        return
      }
      const ok = deleteCustomVrmFile(String(filename))
      sendJsonResponse(res, 200, {
        success: ok,
        message: ok ? 'File custom VRM dihapus.' : 'File tidak ditemukan atau built-in.'
      })
      return
    }
  }

  // Delete VRM by path /api/vrm/:filename
  if (pathname.startsWith('/api/vrm/') && method === 'DELETE') {
    const filename = pathname.replace('/api/vrm/', '')
    if (filename && filename !== 'select' && filename !== 'upload') {
      const ok = deleteCustomVrmFile(filename)
      sendJsonResponse(res, 200, {
        success: ok,
        message: ok ? 'File custom VRM dihapus.' : 'File tidak ditemukan atau built-in.'
      })
      return
    }
  }

  // 7. /api/tools (GET)
  if (pathname === '/api/tools' && method === 'GET') {
    const tools = getDynamicGeminiTools()
    sendJsonResponse(res, 200, { success: true, data: tools })
    return
  }

  // 8. /api/system/control (POST)
  if (pathname === '/api/system/control' && method === 'POST') {
    const body = await parseJsonBody(req)
    const toolName = body.tool || body.name
    const toolArgs = body.args || body.parameters || {}

    if (!toolName || typeof toolName !== 'string' || !toolName.trim()) {
      sendJsonResponse(res, 400, {
        success: false,
        error: 'Nama tool ("tool") wajib diisi dan berupa string.'
      })
      return
    }

    try {
      const result = await executeTool(toolName.trim(), toolArgs)
      sendJsonResponse(res, 200, {
        success: true,
        data: {
          tool: toolName.trim(),
          result
        },
        output: result
      })
    } catch (err: any) {
      sendJsonResponse(res, 500, {
        success: false,
        error: err?.message || `Gagal mengeksekusi tool "${toolName}".`
      })
    }
    return
  }

  sendJsonResponse(res, 404, { success: false, error: `Endpoint API ${pathname} tidak ditemukan.` })
}
