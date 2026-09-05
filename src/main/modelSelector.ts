/**
 * Model Selector & Strict Guard for Gemini Models
 * Enforces default gemini-3.1-flash-lite, supports 2.5/3.x models and text-embedding-004,
 * and bans legacy gemini-1.5-* models via strict regex guard.
 */

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite'

export const SUPPORTED_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.0-flash',
  'gemini-3.0-pro',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'text-embedding-004'
] as const

export type SupportedModel = (typeof SUPPORTED_MODELS)[number]

/**
 * Strict regex pattern matching any legacy gemini-1.5 model name (case-insensitive)
 */
export const PROHIBITED_MODEL_REGEX = /gemini-1\.5/i

export interface ModelValidationOptions {
  /** If true, throws an Error when a prohibited model is requested instead of falling back */
  throwOnProhibited?: boolean
  /** If true, permits text-embedding-004 model selection */
  allowEmbedding?: boolean
}

export interface ModelSpec {
  name: SupportedModel
  displayName: string
  tier: 'flash' | 'pro' | 'embedding'
  contextWindow: number
  supportsVision: boolean
  supportsTools: boolean
}

export const MODEL_SPECS: Record<SupportedModel, ModelSpec> = {
  'gemini-3.1-flash-lite': {
    name: 'gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite (Default)',
    tier: 'flash',
    contextWindow: 1048576,
    supportsVision: true,
    supportsTools: true
  },
  'gemini-3.0-flash': {
    name: 'gemini-3.0-flash',
    displayName: 'Gemini 3.0 Flash',
    tier: 'flash',
    contextWindow: 1048576,
    supportsVision: true,
    supportsTools: true
  },
  'gemini-3.0-pro': {
    name: 'gemini-3.0-pro',
    displayName: 'Gemini 3.0 Pro',
    tier: 'pro',
    contextWindow: 2097152,
    supportsVision: true,
    supportsTools: true
  },
  'gemini-2.5-flash': {
    name: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    tier: 'flash',
    contextWindow: 1048576,
    supportsVision: true,
    supportsTools: true
  },
  'gemini-2.5-pro': {
    name: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    tier: 'pro',
    contextWindow: 2097152,
    supportsVision: true,
    supportsTools: true
  },
  'text-embedding-004': {
    name: 'text-embedding-004',
    displayName: 'Text Embedding 004',
    tier: 'embedding',
    contextWindow: 2048,
    supportsVision: false,
    supportsTools: false
  }
}

/**
 * Checks if a given model name violates the strict gemini-1.5-* ban.
 */
export function isModelProhibited(modelName?: string): boolean {
  if (!modelName) return false
  return PROHIBITED_MODEL_REGEX.test(modelName.trim())
}

/**
 * Checks if a model name is in the list of officially supported models and not prohibited.
 */
export function isModelSupported(modelName?: string): boolean {
  if (!modelName) return false
  const trimmed = modelName.trim()
  if (isModelProhibited(trimmed)) return false
  return (SUPPORTED_MODELS as readonly string[]).includes(trimmed)
}

/**
 * Validates and selects a Gemini model.
 * 
 * Rules:
 * 1. Omitted/empty model -> returns default 'gemini-3.1-flash-lite'
 * 2. Prohibited gemini-1.5-* model -> logs ERROR, blocks, falls back to default (or throws if options.throwOnProhibited is true)
 * 3. Supported model (2.5/3.x) -> returns requested model
 * 4. Unknown/unsupported model -> logs WARN, falls back to default
 * 
 * @param requestedModel Optional name of model requested by user/system
 * @param options Validation options
 * @returns Validated model string guaranteed to be non-prohibited
 */
export function validateAndSelectModel(
  requestedModel?: string,
  options?: ModelValidationOptions
): string {
  if (!requestedModel || requestedModel.trim() === '') {
    return DEFAULT_MODEL
  }

  const cleaned = requestedModel.trim()

  // Guard: Strict regex check for prohibited gemini-1.5 models
  if (isModelProhibited(cleaned)) {
    console.error(
      `[ModelSelector] BANNED MODEL BLOCKED: "${cleaned}" matches prohibited pattern ${PROHIBITED_MODEL_REGEX}. Usage of gemini-1.5-* is strictly forbidden.`
    )
    if (options?.throwOnProhibited) {
      throw new Error(
        `Prohibited model requested: "${cleaned}". Usage of gemini-1.5 models is strictly forbidden.`
      )
    }
    console.warn(`[ModelSelector] Falling back to default model: "${DEFAULT_MODEL}".`)
    return DEFAULT_MODEL
  }

  // Check if model is supported
  if (isModelSupported(cleaned)) {
    if (cleaned === 'text-embedding-004' && !options?.allowEmbedding) {
      console.warn(
        `[ModelSelector] Embedding model "${cleaned}" requested in non-embedding context. Defaulting to "${DEFAULT_MODEL}".`
      )
      return DEFAULT_MODEL
    }
    return cleaned
  }

  // Fallback for unknown / unsupported models
  console.warn(
    `[ModelSelector] Unsupported model "${cleaned}". Supported models are [${SUPPORTED_MODELS.join(
      ', '
    )}]. Defaulting to "${DEFAULT_MODEL}".`
  )
  return DEFAULT_MODEL
}

/**
 * Retrieves specification details for a model.
 */
export function getModelSpec(modelName?: string): ModelSpec {
  const selected = validateAndSelectModel(modelName, { allowEmbedding: true }) as SupportedModel
  return MODEL_SPECS[selected] || MODEL_SPECS[DEFAULT_MODEL]
}

/**
 * Returns a list of all supported models.
 */
export function listSupportedModels(): readonly string[] {
  return [...SUPPORTED_MODELS]
}
