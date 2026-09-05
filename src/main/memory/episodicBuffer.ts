/**
 * Episodic Buffer Memory Subsystem (`src/main/memory/episodicBuffer.ts`)
 * Manages short-term conversation context with sliding windows,
 * session summary persistence in SQLite, and auto-summarization using Gemini 2.5 Flash.
 */

import Database from 'better-sqlite3'
import {
  getChatHistory,
  saveChatMessage,
  clearChatHistory,
  getConfig,
  setConfig,
  deleteConfig,
  getDatabase
} from '../database'
import { executeWithKeyRotation } from '../keyPoolManager'
import { callGeminiRestApi } from '../ai'

export interface EpisodicBufferConfig {
  maxWindowSize: number // Maximum messages in active sliding window (default: 20)
  summarizeThreshold: number // Message count threshold to trigger auto-summarization (default: 25)
  keepLatestOnSummarize: number // Messages to keep un-summarized after summarization (default: 10)
  summaryModel: string // Model used for summarization (default: 'gemini-3.1-flash-lite')
}

export const DEFAULT_EPISODIC_CONFIG: EpisodicBufferConfig = {
  maxWindowSize: 20,
  summarizeThreshold: 25,
  keepLatestOnSummarize: 10,
  summaryModel: 'gemini-3.1-flash-lite'
}

export interface EpisodicContext {
  sessionId: string
  messages: Array<{ role: 'user' | 'model'; content: string }>
  summary: string | null
  totalMessagesCount: number
  isSummarized: boolean
}

/**
 * Retrieves the current episodic context for a session, including sliding window messages and summary.
 */
export function getEpisodicContext(
  sessionId = 'default',
  config: Partial<EpisodicBufferConfig> = {},
  customDb?: Database.Database
): EpisodicContext {
  const mergedConfig = { ...DEFAULT_EPISODIC_CONFIG, ...config }
  const dbInstance = customDb || getDatabase()

  // 1. Fetch raw count of messages for session
  const countRow = dbInstance
    .prepare('SELECT COUNT(*) as count FROM conversation_history WHERE session_id = ?')
    .get(sessionId) as { count: number } | undefined
  const totalMessagesCount = countRow?.count || 0

  // 2. Fetch sliding window messages
  const messages = getChatHistory(mergedConfig.maxWindowSize, sessionId, dbInstance) as Array<{
    role: 'user' | 'model'
    content: string
  }>

  // 3. Fetch current session summary from app_config
  const summaryKey = `episodic_summary_${sessionId}`
  const summary = getConfig(summaryKey, dbInstance)

  return {
    sessionId,
    messages,
    summary,
    totalMessagesCount,
    isSummarized: Boolean(summary)
  }
}

/**
 * Saves a new chat message to SQLite conversation_history and checks if auto-summarization should trigger.
 */
export async function saveAndProcessEpisodicMessage(
  messageId: string,
  role: 'user' | 'model' | 'system',
  content: string,
  sessionId = 'default',
  config: Partial<EpisodicBufferConfig> = {},
  customDb?: Database.Database
): Promise<{ summaryUpdated: boolean; newSummary?: string }> {
  const mergedConfig = { ...DEFAULT_EPISODIC_CONFIG, ...config }
  const dbInstance = customDb || getDatabase()

  // 1. Save chat message to SQLite
  saveChatMessage(messageId, role, content, sessionId, dbInstance)

  // 2. Check total message count
  const countRow = dbInstance
    .prepare('SELECT COUNT(*) as count FROM conversation_history WHERE session_id = ?')
    .get(sessionId) as { count: number } | undefined
  const totalCount = countRow?.count || 0

  // 3. Fetch last summarized count from SQLite app_config
  const lastSummarizedKey = `episodic_last_summarized_count_${sessionId}`
  const lastSummarizedVal = getConfig(lastSummarizedKey, dbInstance)
  const lastSummarizedCount = lastSummarizedVal ? parseInt(lastSummarizedVal, 10) : 0

  // 4. Trigger auto-summarization when total count reaches threshold AND at least 15 (threshold - keepLatest) new un-summarized messages accumulate
  const minNewMessages = mergedConfig.summarizeThreshold - mergedConfig.keepLatestOnSummarize
  if (totalCount >= mergedConfig.summarizeThreshold && (totalCount - lastSummarizedCount) >= minNewMessages) {
    try {
      const newSummary = await triggerAutoSummarization(sessionId, mergedConfig, dbInstance)
      if (newSummary) {
        return { summaryUpdated: true, newSummary }
      }
    } catch (err: any) {
      console.error(`[EpisodicBuffer] Auto-summarization failed for session "${sessionId}":`, err?.message || err)
    }
  }

  return { summaryUpdated: false }
}

/**
 * Executes background auto-summarization of older messages using Gemini 2.5 Flash.
 */
export async function triggerAutoSummarization(
  sessionId = 'default',
  config: Partial<EpisodicBufferConfig> = {},
  customDb?: Database.Database
): Promise<string | null> {
  const mergedConfig = { ...DEFAULT_EPISODIC_CONFIG, ...config }
  const dbInstance = customDb || getDatabase()

  // 1. Fetch all messages in chronological order
  const rows = dbInstance
    .prepare(
      `SELECT role, content FROM conversation_history
       WHERE session_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(sessionId) as Array<{ role: string; content: string }>

  if (rows.length <= mergedConfig.keepLatestOnSummarize) {
    return null
  }

  // 2. Separate messages to summarize vs. messages to keep
  const messagesToSummarize = rows.slice(0, rows.length - mergedConfig.keepLatestOnSummarize)
  const existingSummaryKey = `episodic_summary_${sessionId}`
  const existingSummary = getConfig(existingSummaryKey, dbInstance)

  // 3. Construct summarization prompt
  const conversationText = messagesToSummarize
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n')

  const prompt = `Kamu adalah sistem pembuat ringkasan memori percakapan AI.
${existingSummary ? `RINGKASAN SEBELUMNYA:\n${existingSummary}\n\n` : ''}
PERCAKAPAN BARU YANG HARUS DIGABUNGKAN DAN DIRINGKAS:
${conversationText}

TUGAS:
Buatlah ringkasan kumulatif yang padat, akurat, dan terstruktur dalam Bahasa Indonesia.
Pertahankan fakta penting, preferensi pengguna, topik utama, keputusan yang dibuat, dan tugas yang tersisa.
Jangan tambahkan opini atau komentar eksternal. Langsung berikan ringkasan.`

  // 4. Call Gemini 2.5 Flash via Key Pool Rotator using REST API
  const newSummary = await executeWithKeyRotation(
    async (apiKey, model) => {
      const res = await callGeminiRestApi(
        apiKey,
        model,
        [{ role: 'user', parts: [{ text: prompt }] }]
      )
      return res?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    },
    5,
    mergedConfig.summaryModel
  )

  if (newSummary) {
    // 5. Store updated summary and update last summarized count in app_config
    setConfig(existingSummaryKey, newSummary, dbInstance)
    const lastSummarizedKey = `episodic_last_summarized_count_${sessionId}`
    setConfig(lastSummarizedKey, String(rows.length), dbInstance)
    console.log(`[EpisodicBuffer] Updated summary for session "${sessionId}" (${newSummary.length} chars).`)
    return newSummary
  }

  return null
}

/**
 * Formats episodic history into Gemini API chat history structure (`formattedHistory`).
 */
export function formatEpisodicHistoryForGemini(
  context: EpisodicContext
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const formatted: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []

  for (const msg of context.messages) {
    const role = msg.role === 'user' ? 'user' : 'model'
    formatted.push({
      role,
      parts: [{ text: msg.content }]
    })
  }

  return formatted
}

/**
 * Clears episodic buffer memory and summary for a given session.
 */
export function clearEpisodicBuffer(sessionId = 'default', customDb?: Database.Database): void {
  const dbInstance = customDb || getDatabase()
  clearChatHistory(sessionId, dbInstance)
  deleteConfig(`episodic_summary_${sessionId}`, dbInstance)
  deleteConfig(`episodic_last_summarized_count_${sessionId}`, dbInstance)
  console.log(`[EpisodicBuffer] Cleared episodic memory and summary for session "${sessionId}".`)
}
