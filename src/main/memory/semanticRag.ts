/**
 * Semantic Long-Term RAG Memory Subsystem (`src/main/memory/semanticRag.ts`)
 * Manages saving memory snippets, generating 768-dim vector embeddings via text-embedding-004,
 * retrieving relevant memories using cosine vector similarity, and formatting system prompt context.
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import {
  getDatabase,
  searchSemanticMemory,
  SemanticSearchResult
} from '../database'
import { executeWithKeyRotation } from '../keyPoolManager'
import { validateAndSelectModel } from '../modelSelector'

export type MemoryCategory = 'user_preference' | 'user_fact' | 'agent_insight' | 'task_result' | 'general'
export type MemorySource = 'user_chat' | 'explicit' | 'auto_extraction'

export interface SaveMemoryInput {
  content: string
  category?: MemoryCategory
  source?: MemorySource
  tags?: string[]
  metadata?: Record<string, any>
}

export interface SemanticMemoryItem {
  id: string
  content: string
  category: MemoryCategory
  embedding: number[]
  source: MemorySource
  tags: string[]
  metadata: Record<string, any> | null
  createdAt: string
  updatedAt: string
}

export interface MemoryRetrievalOptions {
  limit?: number // Default: 5
  minScore?: number // Minimum similarity score threshold (default: 0.55)
  category?: MemoryCategory
}

/**
 * Generates a 768-dimensional float embedding vector for a given text using Gemini `text-embedding-004`.
 */
export async function generateTextEmbedding(text: string): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error('[SemanticRAG] Text for embedding generation cannot be empty.')
  }

  // Ensure text-embedding-004 model is validated with allowEmbedding option
  const model = validateAndSelectModel('text-embedding-004', { allowEmbedding: true })

  return executeWithKeyRotation(
    async (apiKey, modelName) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${apiKey}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${modelName}`,
          content: { parts: [{ text: text.trim() }] }
        })
      })

      if (!res.ok) {
        const errText = await res.text()
        const error = new Error(`Embedding API Error (${res.status}): ${errText}`)
        ;(error as any).status = res.status
        throw error
      }

      const json = await res.json()
      const values = json.embedding?.values
      if (!values || !Array.isArray(values) || values.length === 0) {
        throw new Error('[SemanticRAG] Empty or invalid embedding vector returned by API.')
      }

      return values
    },
    5,
    model
  )
}

/**
 * Saves a semantic memory snippet into SQLite database with vector embedding.
 */
export async function saveSemanticMemorySnippet(
  input: SaveMemoryInput,
  customDb?: Database.Database
): Promise<SemanticMemoryItem> {
  const dbInstance = customDb || getDatabase()
  const content = input.content.trim()

  if (!content) {
    throw new Error('[SemanticRAG] Cannot save empty semantic memory snippet.')
  }

  // 1. Generate 768-dim vector embedding
  const embedding = await generateTextEmbedding(content)

  // 2. Prepare database entry
  const id = randomUUID()
  const category = input.category || 'general'
  const source = input.source || 'user_chat'
  const tagsStr = input.tags ? JSON.stringify(input.tags) : null
  const metadataStr = input.metadata ? JSON.stringify(input.metadata) : null
  const embeddingStr = JSON.stringify(embedding)

  // 3. Insert into semantic_memory table
  dbInstance
    .prepare(
      `INSERT INTO semantic_memory (id, content, category, embedding, source, tags, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, content, category, embeddingStr, source, tagsStr, metadataStr)

  const now = new Date().toISOString()
  return {
    id,
    content,
    category,
    embedding,
    source,
    tags: input.tags || [],
    metadata: input.metadata || null,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * Retrieves relevant semantic memories using vector cosine similarity.
 */
export async function retrieveSemanticMemories(
  query: string,
  options: MemoryRetrievalOptions = {},
  customDb?: Database.Database
): Promise<SemanticSearchResult[]> {
  const dbInstance = customDb || getDatabase()
  const limit = options.limit || 5
  const minScore = options.minScore ?? 0.55

  let queryEmbedding: number[] | undefined = undefined
  try {
    queryEmbedding = await generateTextEmbedding(query)
  } catch (err: any) {
    console.warn(`[SemanticRAG] Embedding generation failed for search query. Falling back to text search: ${err?.message || err}`)
  }

  // Search using searchSemanticMemory DAO from database.ts
  const rawResults = searchSemanticMemory(query, options.category, limit * 2, queryEmbedding, dbInstance)

  // Filter by minScore if similarityScore exists
  const filtered = rawResults.filter((item) => {
    if (typeof item.similarityScore === 'number') {
      return item.similarityScore >= minScore
    }
    return true
  })

  return filtered.slice(0, limit)
}

/**
 * Formats retrieved semantic memories into a structured context snippet for Gemini system prompt.
 */
export function formatSemanticMemoriesForSystemPrompt(memories: SemanticSearchResult[]): string {
  if (!memories || memories.length === 0) {
    return ''
  }

  const lines = memories.map((m) => {
    const categoryTag = m.category ? `[${m.category.toUpperCase()}] ` : ''
    const scoreTag = typeof m.similarityScore === 'number'
      ? ` (Relevansi: ${Math.round(m.similarityScore * 100)}%)`
      : ''
    return `- ${categoryTag}${m.content}${scoreTag}`
  })

  return `\n[MEMORI JANGKA PANJANG (SEMANTIC RAG)]\nBerikut adalah fakta/preferensi relevan yang tersimpan tentang pengguna:\n${lines.join('\n')}\n`
}

/**
 * Deletes a semantic memory snippet by ID.
 */
export function deleteSemanticMemoryItem(id: string, customDb?: Database.Database): boolean {
  const dbInstance = customDb || getDatabase()
  const info = dbInstance.prepare('DELETE FROM semantic_memory WHERE id = ?').run(id)
  return info.changes > 0
}
