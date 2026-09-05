import { getConfig } from './database'
import { getDynamicGeminiTools, executeTool } from './tools'
import { executeWithKeyRotation, initializeKeyPool, addKeyToPool, getKeyPoolStatus } from './keyPoolManager'
import { validateAndSelectModel } from './modelSelector'
import {
  getEpisodicContext,
  saveAndProcessEpisodicMessage,
  formatEpisodicHistoryForGemini,
  clearEpisodicBuffer
} from './memory/episodicBuffer'
import {
  retrieveSemanticMemories,
  formatSemanticMemoriesForSystemPrompt
} from './memory/semanticRag'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { evaluateExecutionResult, EvaluationResult } from './learning/selfEvaluator'
import { serializeSkill } from './learning/skillSerializer'
import { runAutoDebuggingLoop, executeTempPythonCode } from './learning/autoDebugger'

const BASE_SYSTEM_PROMPT = `Kamu adalah Jarvis, asisten AI pribadi yang super santai, asik, gaul, dan akrab banget sama user (seperti teman dekat / bestie).
Gunakan gaya bahasa sehari-hari yang SUPER NON-FORMAL (pakai gue-elo / aku-kamu yang santai, luwes, jangan kaku atau formal sama sekali, singkat, padat, to the point, dan ekspresif).
Kamu selalu mengingat percakapan sebelumnya dan konteks obrolan.

Saat merespons, tambahkan tag emosi di awal kalimat pertama:
- [SENANG] untuk ekspresi gembira/antusias/lucu
- [SEDIH] untuk ekspresi sedih/simpati
- [MARAH] untuk ekspresi kesal/frustrasi
- [HERAN] untuk ekspresi kaget/penasaran
- [SANTAI] untuk ekspresi normal/santai sehari-hari
Contoh: "[SENANG] Yo! Ada apa nih bro? Gas, gue bantu sekarang!"`

interface GeminiContentPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, any> }
  functionResponse?: { name: string; response: Record<string, any> }
}

interface GeminiContentTurn {
  role: 'user' | 'model' | 'function'
  parts: GeminiContentPart[]
}

/**
 * Direct Gemini Base REST API Call - No @google/genai library dependency.
 */
export async function callGeminiRestApi(
  apiKey: string,
  model: string,
  contents: GeminiContentTurn[],
  systemInstruction?: string,
  tools?: any[]
): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const bodyPayload: Record<string, any> = {
    contents
  }

  if (systemInstruction) {
    bodyPayload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    }
  }

  if (tools && tools.length > 0) {
    bodyPayload.tools = tools
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload)
  })

  if (!response.ok) {
    const errText = await response.text()
    const error = new Error(`Gemini REST API Error (${response.status}): ${errText}`)
    ;(error as any).status = response.status
    throw error
  }

  return await response.json()
}

export function initializeChat(): void {
  initializeKeyPool()
  const stats = getKeyPoolStatus()
  if (stats.activeKeys === 0) {
    console.warn('[AI] No active keys available in key pool.')
  }
}

export async function sendMessage(
  userText: string,
  screenshotBase64?: string,
  audioBase64?: string,
  sessionId = 'default'
): Promise<{ text: string; emotion: string }> {
  const userMsgId = randomUUID()
  const effectiveText = userText?.trim() ? userText.trim() : (audioBase64 ? '🎙️ [Pesan Suara]' : 'Halo Jarvis')

  // 1. Save User Message to Episodic Buffer Memory
  await saveAndProcessEpisodicMessage(userMsgId, 'user', effectiveText, sessionId)

  // 2. Pillar 2: Retrieve Relevant Long-Term Semantic Memories (RAG)
  const semanticMemories = await retrieveSemanticMemories(effectiveText, { limit: 5, minScore: 0.50 })
  const semanticContextSnippet = formatSemanticMemoriesForSystemPrompt(semanticMemories)

  // 3. Pillar 1: Retrieve Episodic Context (Sliding Window & Session Summary)
  const episodicContext = getEpisodicContext(sessionId)
  const summarySnippet = episodicContext.summary
    ? `\n[RINGKASAN SESI PERCAKAPAN SEBELUMNYA]\n${episodicContext.summary}\n`
    : ''

  // 4. Assemble Dynamic System Instruction
  const customPrompt = getConfig('GEMINI_SYSTEM_PROMPT')
  const basePromptToUse = customPrompt && customPrompt.trim() ? customPrompt.trim() : BASE_SYSTEM_PROMPT
  const fullSystemInstruction = `${basePromptToUse}${semanticContextSnippet}${summarySnippet}`

  // 5. Format Chat History into REST API turns
  const formattedHistory = formatEpisodicHistoryForGemini(episodicContext)
  const conversationTurns: GeminiContentTurn[] = formattedHistory.map((h) => ({
    role: h.role === 'model' ? 'model' : 'user',
    parts: h.parts.map((p) => ({ text: p.text }))
  }))

  // Add user current turn
  const userParts: GeminiContentPart[] = []
  if (userText && userText.trim()) {
    userParts.push({ text: userText.trim() })
  }
  if (audioBase64) {
    userParts.push({
      inlineData: {
        mimeType: 'audio/webm',
        data: audioBase64
      }
    })
    if (!userText || !userText.trim()) {
      userParts.push({ text: 'Dengarkan pesan suara ini secara saksama dan respon langsung dengan bahasa gaul santai Jarvis.' })
    }
  } else if (!userText || !userText.trim()) {
    userParts.push({ text: 'Halo Jarvis!' })
  }

  if (screenshotBase64) {
    userParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: screenshotBase64
      }
    })
  }

  conversationTurns.push({
    role: 'user',
    parts: userParts
  })

  const requestedModel = getConfig('GEMINI_MODEL') ?? undefined

  // 6. Execute Gemini Call via Key Pool Rotator using REST API
  const rawText = await executeWithKeyRotation(
    async (apiKey, model) => {
      const contents = [...conversationTurns]
      let maxFunctionLoop = 5
      let finalResponseText = ''

      while (maxFunctionLoop > 0) {
        maxFunctionLoop--
        const dynamicTools = getDynamicGeminiTools()
        const apiResult = await callGeminiRestApi(
          apiKey,
          model,
          contents,
          fullSystemInstruction,
          dynamicTools
        )

        const candidate = apiResult?.candidates?.[0]
        const candidateParts: GeminiContentPart[] = candidate?.content?.parts || []

        const functionCallParts = candidateParts.filter((p: any) => p.functionCall)
        if (functionCallParts.length > 0) {
          contents.push({
            role: 'model',
            parts: candidateParts
          })

          const functionResponseParts: GeminiContentPart[] = []
          for (const fnPart of functionCallParts) {
            const fnCall = fnPart.functionCall!
            const result = await executeTool(fnCall.name, fnCall.args || {})
            functionResponseParts.push({
              functionResponse: {
                name: fnCall.name,
                response: { result }
              }
            })
          }

          contents.push({
            role: 'user',
            parts: functionResponseParts
          })
        } else {
          const textPart = candidateParts.find((p: any) => p.text !== undefined)
          finalResponseText = textPart?.text || 'Maaf, saya tidak bisa merespons saat ini.'
          break
        }
      }

      return finalResponseText || 'Maaf, saya tidak bisa merespons saat ini.'
    },
    10,
    requestedModel
  )

  // 7. Parse Emotion Tag and Clean Text
  const emotionMatch = rawText.match(/^\[([A-Z]+)\]/)
  const emotion = emotionMatch ? emotionMatch[1] : 'SANTAI'
  const cleanText = rawText.replace(/^\[[A-Z]+\]\s*/, '')

  // 8. Save Model Response to Episodic Buffer Memory
  const modelMsgId = randomUUID()
  await saveAndProcessEpisodicMessage(modelMsgId, 'model', cleanText, sessionId)

  return { text: cleanText, emotion }
}

export function resetChat(sessionId = 'default'): void {
  clearEpisodicBuffer(sessionId)
}

export function setApiKeyAndReset(newKey: string): void {
  addKeyToPool(newKey)
}

export async function processPythonSkillWithLearningLoop(
  taskPrompt: string,
  skillName: string,
  code: string,
  args: Record<string, any> = {},
  options?: { maxRetries?: number; customDb?: Database.Database }
): Promise<{
  success: boolean
  result: any
  skillSaved: boolean
  evaluation: EvaluationResult
  finalCode: string
}> {
  let finalCode = code
  let execResult = await executeTempPythonCode(finalCode, args)

  if (!execResult.success) {
    const debugResult = await runAutoDebuggingLoop(
      taskPrompt,
      finalCode,
      execResult.error || execResult.stderr || 'Execution failed',
      options?.maxRetries ?? 3,
      options?.customDb
    )

    if (debugResult.success) {
      finalCode = debugResult.finalCode
      execResult = await executeTempPythonCode(finalCode, args)
    }
  }

  const outputStr =
    typeof execResult.result === 'string'
      ? execResult.result
      : JSON.stringify(execResult.result ?? execResult.stdout ?? '')

  const evaluation = await evaluateExecutionResult(
    taskPrompt,
    skillName,
    outputStr,
    execResult.stderr,
    { customDb: options?.customDb }
  )

  let skillSaved = false
  if (evaluation.success && evaluation.score >= 0.70) {
    const targetSkillName = evaluation.reusableSkillName || skillName
    await serializeSkill(
      targetSkillName,
      finalCode,
      evaluation.feedback,
      {},
      { customDb: options?.customDb }
    )
    skillSaved = true
  }

  return {
    success: execResult.success,
    result: execResult.result,
    skillSaved,
    evaluation,
    finalCode
  }
}

export { validateAndSelectModel }
