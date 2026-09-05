import { ipcMain, desktopCapturer, app, BrowserWindow } from 'electron'
import {
  getConfig,
  setConfig,
  getChatHistory,
  getApiKeyPoolStatus,
  getExecutionLogs,
  searchSemanticMemory,
  getSkillsMetadata,
  executeRawInspectionQuery,
  getDatabaseOverallStats,
  ExecutionLogFilter,
  maskApiKey
} from './database'
import { sendMessage, resetChat, setApiKeyAndReset, initializeChat } from './ai'
import { getKeyPoolStatus, addKeyToPool, removeKeyFromPool, selectBestKey } from './keyPoolManager'
import { listAvailableVrmAvatars, setActiveVrmAvatar, deleteCustomVrmFile } from './vrmManager'
import { validateAndSelectModel } from './modelSelector'
import {
  getEpisodicContext,
  clearEpisodicBuffer,
  triggerAutoSummarization
} from './memory/episodicBuffer'
import {
  saveSemanticMemorySnippet,
  retrieveSemanticMemories,
  deleteSemanticMemoryItem
} from './memory/semanticRag'
import {
  syncSkillStore,
  executePythonSkill,
  matchExistingSkill,
  deleteSkillMetadata
} from './memory/skillStore'
import { evaluateExecutionResult } from './learning/selfEvaluator'
import { serializeSkill } from './learning/skillSerializer'
import { runAutoDebuggingLoop } from './learning/autoDebugger'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { createWriteStream, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

const TTS_DIR = join(app.getPath('temp'), 'jarvis-tts')

export function registerIpcHandlers(): void {
  mkdirSync(TTS_DIR, { recursive: true })

  // ─────────────────────────────────────────
  // Config: GET & SET
  // ─────────────────────────────────────────
  ipcMain.handle('config:get', (_event, key: string) => {
    return getConfig(key)
  })

  ipcMain.handle('config:set', (_event, key: string, value: string) => {
    setConfig(key, value)
    if (key === 'GEMINI_API_KEY' && value && value.trim()) {
      addKeyToPool(value.trim())
      setApiKeyAndReset(value.trim())
    }
    return true
  })

  // ─────────────────────────────────────────
  // Key Pool Management IPC Handlers
  // ─────────────────────────────────────────
  ipcMain.handle('keypool:status', () => {
    return getKeyPoolStatus()
  })

  ipcMain.handle('keypool:add', (_event, apiKey: string) => {
    return addKeyToPool(apiKey)
  })

  ipcMain.handle('keypool:remove', (_event, apiKey: string) => {
    return removeKeyFromPool(apiKey)
  })

  ipcMain.handle('keypool:rotate', () => {
    const selected = selectBestKey()
    const stats = getKeyPoolStatus()
    return {
      success: true,
      activeKeyId: selected?.id || null,
      maskedKey: selected ? maskApiKey(selected.apiKey) : null,
      status: selected?.status || 'UNKNOWN',
      stats
    }
  })

  // ─────────────────────────────────────────
  // VRM Character Management IPC Handlers
  // ─────────────────────────────────────────
  ipcMain.handle('vrm:list', () => {
    return listAvailableVrmAvatars()
  })

  ipcMain.handle('vrm:select', (_event, filename: string) => {
    setActiveVrmAvatar(filename)
    const avatarUrl = `http://127.0.0.1:14228/models/${filename}`
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('vrm:swap', avatarUrl)
      }
    })
    return { success: true, activeAvatar: filename, avatarUrl }
  })

  ipcMain.handle('vrm:delete', (_event, filename: string) => {
    return deleteCustomVrmFile(filename)
  })

  // ─────────────────────────────────────────
  // Database Inspection & Operations IPC Handlers
  // ─────────────────────────────────────────
  ipcMain.handle('db:keypool-status', () => {
    return getApiKeyPoolStatus()
  })

  ipcMain.handle('db:execution-logs', (_event, filters?: ExecutionLogFilter) => {
    return getExecutionLogs(filters)
  })

  ipcMain.handle(
    'db:semantic-search',
    (
      _event,
      queryText?: string,
      category?: string,
      limit?: number,
      queryEmbedding?: number[]
    ) => {
      return searchSemanticMemory(queryText, category, limit, queryEmbedding)
    }
  )

  ipcMain.handle('db:skills-metadata', () => {
    return getSkillsMetadata()
  })

  ipcMain.handle('db:raw-query', (_event, sqlQuery: string) => {
    return executeRawInspectionQuery(sqlQuery)
  })

  ipcMain.handle('db:stats', () => {
    return getDatabaseOverallStats()
  })

  // ─────────────────────────────────────────
  // Memory Subsystem IPC Handlers (Milestone 3)
  // ─────────────────────────────────────────

  // 1. Episodic Buffer IPC Handlers
  ipcMain.handle('memory:episodic:get', (_event, sessionId?: string) => {
    return getEpisodicContext(sessionId || 'default')
  })

  ipcMain.handle('memory:episodic:summarize', async (_event, sessionId?: string) => {
    return await triggerAutoSummarization(sessionId || 'default')
  })

  ipcMain.handle('memory:episodic:clear', (_event, sessionId?: string) => {
    const sid = sessionId || 'default'
    clearEpisodicBuffer(sid)
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('memory:cleared', sid)
    })
    return true
  })

  // 2. Semantic Long-Term RAG IPC Handlers
  ipcMain.handle('memory:semantic:add', async (_event, input: any) => {
    return await saveSemanticMemorySnippet(input)
  })

  ipcMain.handle('memory:semantic:search', async (_event, query: string, options?: any) => {
    return await retrieveSemanticMemories(query, options)
  })

  ipcMain.handle('memory:semantic:delete', (_event, id: string) => {
    return deleteSemanticMemoryItem(id)
  })

  // 3. Procedural Skill Store IPC Handlers
  ipcMain.handle('skills:scan', async () => {
    return await syncSkillStore()
  })

  ipcMain.handle('skills:execute', async (_event, skillName: string, args?: Record<string, any>) => {
    return await executePythonSkill(skillName, args || {})
  })

  ipcMain.handle('skills:check-reuse', async (_event, taskDescription: string) => {
    return await matchExistingSkill(taskDescription)
  })

  ipcMain.handle('skills:delete', (_event, skillName: string) => {
    return deleteSkillMetadata(skillName)
  })

  // ─────────────────────────────────────────
  // Learning Loop IPC Handlers (Milestone 4)
  // ─────────────────────────────────────────
  ipcMain.handle(
    'learning:auto-debug',
    async (
      _event,
      taskPrompt: string,
      originalCode: string,
      initialError: string,
      maxRetries?: number
    ) => {
      return await runAutoDebuggingLoop(taskPrompt, originalCode, initialError, maxRetries ?? 3)
    }
  )

  ipcMain.handle(
    'learning:evaluate',
    async (
      _event,
      taskPrompt: string,
      toolName: string,
      output: string,
      stderr?: string,
      options?: any
    ) => {
      return await evaluateExecutionResult(taskPrompt, toolName, output, stderr, options)
    }
  )

  ipcMain.handle(
    'learning:serialize',
    async (
      _event,
      skillName: string,
      code: string,
      description: string,
      parametersSchema?: Record<string, any>,
      options?: any
    ) => {
      return await serializeSkill(skillName, code, description, parametersSchema || {}, options)
    }
  )

  // ─────────────────────────────────────────
  // Model Selector IPC Handlers
  // ─────────────────────────────────────────
  ipcMain.handle('model:get', () => {
    const savedModel = getConfig('GEMINI_MODEL') ?? undefined
    return validateAndSelectModel(savedModel)
  })

  ipcMain.handle('model:set', (_event, model: string) => {
    const validated = validateAndSelectModel(model)
    setConfig('GEMINI_MODEL', validated)
    return validated
  })

  // ─────────────────────────────────────────
  // Chat: Kirim pesan ke Gemini
  // ─────────────────────────────────────────
  ipcMain.handle('chat:send', async (_event, userText: string, includeScreen: boolean, audioBase64?: string) => {
    let screenshotBase64: string | undefined

    if (includeScreen) {
      screenshotBase64 = await captureScreen()
    }

    const { text, emotion } = await sendMessage(userText, screenshotBase64, audioBase64)

    // Convert teks ke audio TTS
    const audioPath = await generateTts(text)

    return { text, emotion, audioPath }
  })

  // ─────────────────────────────────────────
  // Chat: Ambil riwayat
  // ─────────────────────────────────────────
  ipcMain.handle('chat:history', () => {
    return getChatHistory(50)
  })

  // ─────────────────────────────────────────
  // Chat: Reset (hapus memori)
  // ─────────────────────────────────────────
  ipcMain.handle('chat:reset', (_event, sessionId?: string) => {
    const sid = sessionId || 'default'
    resetChat(sid)
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('memory:cleared', sid)
    })
    return true
  })

  // ─────────────────────────────────────────
  // Screen: Ambil screenshot layar
  // ─────────────────────────────────────────
  ipcMain.handle('screen:capture', async () => {
    return await captureScreen()
  })

  // ─────────────────────────────────────────
  // Init: Inisialisasi chat saat pertama kali
  // ─────────────────────────────────────────
  ipcMain.handle('chat:init', () => {
    initializeChat()
    const stats = getKeyPoolStatus()
    if (stats.activeKeys > 0) {
      return { ready: true, activeKeys: stats.activeKeys }
    }
    return { ready: false, message: 'Tidak ada API Key Gemini aktif di pool.' }
  })
}

// ─────────────────────────────────────────
// Helper: Ambil screenshot desktop
// ─────────────────────────────────────────
async function captureScreen(): Promise<string | undefined> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 }
    })
    if (sources.length === 0) return undefined

    const screenshot = sources[0].thumbnail
    const base64 = screenshot.toJPEG(85).toString('base64')
    return base64
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────
// Helper: TTS menggunakan msedge-tts
// ─────────────────────────────────────────
async function generateTts(text: string): Promise<string> {
  const filename = `tts-${Date.now()}.mp3`
  const outputPath = join(TTS_DIR, filename)

  try {
    // Bersihkan file TTS lama
    if (existsSync(TTS_DIR)) {
      const files = readdirSync(TTS_DIR)
      for (const file of files) {
        if (file !== filename && file.endsWith('.mp3')) {
          try {
            unlinkSync(join(TTS_DIR, file))
          } catch {
            // abaikan error hapus file lama
          }
        }
      }
    }

    const voiceName = getConfig('EDGE_TTS_VOICE') ?? getConfig('VOICE_NAME') ?? 'id-ID-ArdiNeural'
    const tts = new MsEdgeTTS()
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)

    await new Promise<void>((resolve, reject) => {
      const { audioStream } = tts.toStream(text)
      const writable = createWriteStream(outputPath)
      audioStream.pipe(writable)
      writable.on('finish', resolve)
      writable.on('error', reject)
      audioStream.on('error', reject)
    })

    return outputPath
  } catch (err) {
    console.error('TTS error:', err)
    return ''
  }
}
