import { getDatabase } from './database'
import { validateAndSelectModel, ModelValidationOptions } from './modelSelector'
import { randomUUID } from 'crypto'

export type KeyStatus = 'ACTIVE' | 'COOLDOWN' | 'DISABLED'

export interface KeyEntry {
  id: string
  apiKey: string
  maskedKey?: string
  status: KeyStatus
  lastUsedAt: number | null
  cooldownUntil: number | null
  successCalls: number
  failedCalls: number
  rateLimitCount: number
  consecutiveErrors: number
  createdAt: string
  updatedAt: string
}

export interface KeyPoolStats {
  totalKeys: number
  activeKeys: number
  cooldownKeys: number
  disabledKeys: number
  totalSuccessCalls: number
  totalFailedCalls: number
}

// âš ï¸ SEED_API_KEYS dikosongkan sebelum upload ke GitHub (keamanan)
// Tambahkan Gemini API Key Anda melalui Dashboard â†’ Key Pool Manager setelah instalasi
// Atau isi di sini jika ingin pre-seed (JANGAN commit ke repo publik!)
export const SEED_API_KEYS: string[] = [
  // Tambahkan API key Anda di sini, contoh:
  // 'AIzaSy...',
]

// In-Memory Key Store Map