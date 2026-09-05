/**
 * Autonomous Self-Evaluation Subsystem (`src/main/learning/selfEvaluator.ts`)
 * Evaluates tool/code execution outputs using gemini-2.5-flash via REST API,
 * grades correctness/completeness/reliability (0.0-1.0), and logs evaluation events in SQLite.
 */

import type Database from 'better-sqlite3'
import { executeWithKeyRotation } from '../keyPoolManager'
import { getConfig, logToolCall } from '../database'
import { callGeminiRestApi } from '../ai'
import { randomUUID } from 'crypto'

export interface EvaluationOptions {
  model?: string
  threshold?: number // Default: 0.70
  sessionId?: string
  customDb?: Database.Database
}

export interface EvaluationResult {
  success: boolean
  score: number // Float 0.0 - 1.0
  feedback: string
  reusableSkillName?: string
}

const EVALUATOR_SYSTEM_PROMPT = `You are an expert AI Code and Tool Execution Evaluator for the Jarvis Autonomous Agent system.
Your task is to objectively grade tool/code execution outputs against the user's task prompt.

Evaluation Criteria:
1. Correctness (0.0 - 0.4): Does the output directly fulfill the user's intent?
2. Completeness (0.0 - 0.3): Is the result complete and properly formatted without truncation?
3. Reliability (0.0 - 0.3): Did the execution complete without fatal runtime exceptions or errors in stderr?

Reusability Rules:
- If the executed solution represents a reusable Python script or generic automation tool (e.g. data cleaner, file converter, scraper, system utility) AND the score is >= 0.70, suggest a clean, lowercase snake_case name for reusableSkillName (e.g. "csv_data_cleaner").
- If the solution is task-specific, single-use, or failed, set reusableSkillName to null.

Output Format:
You MUST respond ONLY with a JSON object matching this schema:
{
  "score": 0.85,
  "success": true,
  "feedback": "Concise summary of why this score was assigned.",
  "reusableSkillName": "optional_snake_case_name_or_null"
}`

export async function evaluateExecutionResult(
  taskPrompt: string,
  toolName: string,
  output: string,
  stderr?: string,
  options: EvaluationOptions = {}
): Promise<EvaluationResult> {
  const threshold = options.threshold ?? 0.70
  const modelToUse = options.model || getConfig('GEMINI_MODEL') || 'gemini-3.1-flash-lite'

  const truncatedOutput = (output || '').slice(0, 4000)
  const truncatedStderr = (stderr || '').slice(0, 2000)

  const userContent = `TASK PROMPT:
${taskPrompt}

EXECUTED TOOL NAME:
${toolName}

EXECUTION OUTPUT (STDOUT):
${truncatedOutput || '(No stdout)'}

EXECUTION ERRORS (STDERR):
${truncatedStderr || '(No stderr errors)'}
`

  try {
    const rawText = await executeWithKeyRotation(
      async (apiKey, model) => {
        const res = await callGeminiRestApi(
          apiKey,
          model,
          [{ role: 'user', parts: [{ text: userContent }] }],
          EVALUATOR_SYSTEM_PROMPT
        )
        const text = res?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
        return text
      },
      5,
      modelToUse
    )

    // Robust JSON Parsing (strip markdown code blocks if wrapped)
    const cleanedJson = rawText.replace(/```json\s*|\s*```/g, '').trim()
    const parsed = JSON.parse(cleanedJson)

    const rawScore = typeof parsed.score === 'number' ? parsed.score : 0.0
    const clampedScore = Math.max(0.0, Math.min(1.0, Math.round(rawScore * 100) / 100))
    const isSuccess = clampedScore >= threshold && (parsed.success === false ? false : true)

    let skillName: string | undefined = undefined
    if (isSuccess && typeof parsed.reusableSkillName === 'string' && parsed.reusableSkillName.trim()) {
      const sanitized = parsed.reusableSkillName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
      if (sanitized.length >= 3 && /^[a-z][a-z0-9_]*$/.test(sanitized)) {
        skillName = sanitized
      }
    }

    const evalResult: EvaluationResult = {
      success: isSuccess,
      score: clampedScore,
      feedback: parsed.feedback || (isSuccess ? 'Execution succeeded.' : 'Execution failed evaluation.'),
      reusableSkillName: skillName
    }

    try {
      logToolCall(
        randomUUID(),
        `eval:${toolName}`,
        JSON.stringify({ taskPrompt, score: clampedScore, isSuccess }),
        JSON.stringify(evalResult),
        options.customDb
      )
    } catch {}

    return evalResult
  } catch (error: any) {
    console.error('[SelfEvaluator] Evaluation failed:', error.message)
    const hasOutput = Boolean(output && output.trim().length > 0)
    const hasStderrError = Boolean(stderr && /error|traceback|exception/i.test(stderr))
    const isFallbackSuccess = hasOutput && !hasStderrError

    const fallbackResult: EvaluationResult = {
      success: isFallbackSuccess,
      score: isFallbackSuccess ? 0.75 : 0.0,
      feedback: `Evaluation fallback triggered due to LLM error: ${error.message}`
    }

    try {
      logToolCall(
        randomUUID(),
        `eval:${toolName}`,
        JSON.stringify({ taskPrompt, error: error.message }),
        JSON.stringify(fallbackResult),
        options.customDb
      )
    } catch {}

    return fallbackResult
  }
}
