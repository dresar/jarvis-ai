/**
 * Bounded Auto-Debugging Loop Subsystem (`src/main/learning/autoDebugger.ts`)
 * Feeds stderr, stack traces, and failing Python code back to Gemini Flash
 * using key rotation to attempt automatic repair up to maxRetries (3 retries).
 * Logs each repair attempt and result in SQLite execution_logs.
 */

import Database from 'better-sqlite3'
import { getDatabase } from '../database'
import { executeWithKeyRotation } from '../keyPoolManager'
import { callGeminiRestApi } from '../ai'
import { resolvePythonExecutable } from '../memory/skillStore'
import { spawn } from 'child_process'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

export interface AutoDebugResult {
  success: boolean
  finalCode: string
  attempts: number
  errorLog: string[]
}

/**
 * Strips markdown code block wrappers (```python ... ```) and extracts raw Python code.
 */
export function sanitizePythonCode(rawText: string): string {
  if (!rawText || !rawText.trim()) return ''

  let cleaned = rawText.trim()

  // Extract python code block if present
  const codeBlockMatch = cleaned.match(/```(?:python|py)?\s*([\s\S]*?)```/i)
  if (codeBlockMatch && codeBlockMatch[1]) {
    cleaned = codeBlockMatch[1].trim()
  } else {
    // Strip leading or trailing backticks if unmatched
    cleaned = cleaned.replace(/^```(?:python|py)?\s*/i, '').replace(/\s*```$/, '').trim()
  }

  return cleaned
}

/**
 * Tests execution of a raw Python code snippet by writing it to a temporary file
 * and executing it via a Python process.
 */
export async function executeTempPythonCode(
  code: string,
  args: Record<string, any> = {},
  timeoutMs = 15000
): Promise<{ success: boolean; result?: any; error?: string; stdout: string; stderr: string }> {
  const tempDir = join(tmpdir(), 'jarvis-autodebug-temp')
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }

  const tempFilePath = join(tempDir, `debug_${randomUUID().slice(0, 8)}.py`)
  writeFileSync(tempFilePath, code, 'utf-8')

  let pyCmd = 'python'
  try {
    pyCmd = await resolvePythonExecutable()
  } catch {
    pyCmd = 'python'
  }

  const launcherScript = `
import sys, json, importlib.util

filePath = sys.argv[1]
argsJson = sys.argv[2]

try:
    spec = importlib.util.spec_from_file_location("temp_debug_skill", filePath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    
    # Try finding run entrypoint or first callable function
    entrypoint = getattr(mod, 'run', None)
    if not entrypoint:
        funcs = [v for k, v in mod.__dict__.items() if callable(v) and not k.startswith('_')]
        if funcs:
            entrypoint = funcs[0]
            
    if not entrypoint:
        raise AttributeError("No entrypoint function 'run' or public callable found in script.")
        
    kwargs = json.loads(argsJson) if argsJson else {}
    res = entrypoint(**kwargs) if kwargs else entrypoint()
    print(json.dumps({"status": "SUCCESS", "result": res}))
except Exception as e:
    import traceback
    print(json.dumps({"status": "ERROR", "error": str(e), "traceback": traceback.format_exc()}), file=sys.stderr)
    sys.exit(1)
`

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(pyCmd, ['-c', launcherScript, tempFilePath, JSON.stringify(args)], {
        timeout: timeoutMs
      })
    } catch (err: any) {
      if (existsSync(tempFilePath)) {
        try { unlinkSync(tempFilePath) } catch {}
      }
      return resolve({
        success: false,
        error: `Failed to spawn Python process: ${err.message}`,
        stdout: '',
        stderr: err.message
      })
    }

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })

    child.on('close', (codeStatus) => {
      if (existsSync(tempFilePath)) {
        try { unlinkSync(tempFilePath) } catch {}
      }

      if (codeStatus === 0) {
        try {
          const parsed = JSON.parse(stdout.trim())
          resolve({
            success: true,
            result: parsed.result,
            stdout,
            stderr
          })
        } catch {
          resolve({
            success: true,
            result: stdout.trim(),
            stdout,
            stderr
          })
        }
      } else {
        resolve({
          success: false,
          error: stderr.trim() || stdout.trim() || `Process exited with code ${codeStatus}`,
          stdout,
          stderr
        })
      }
    })

    child.on('error', (err) => {
      if (existsSync(tempFilePath)) {
        try { unlinkSync(tempFilePath) } catch {}
      }
      resolve({
        success: false,
        error: `Failed to spawn Python: ${err.message}`,
        stdout: '',
        stderr: err.message
      })
    })
  })
}

/**
 * Logs auto-debugging repair attempts into SQLite execution_logs table.
 */
export function logAutoDebugAttempt(
  attempt: number,
  status: 'SUCCESS' | 'ERROR',
  errorMessage: string | null,
  repairedCode: string,
  latencyMs: number,
  customDb?: Database.Database
): void {
  const db = customDb || getDatabase()
  const logId = randomUUID()

  db.prepare(`
    INSERT INTO execution_logs (
      id, key_id, model, status, error_message, latency_ms, tool_name, parameters, result
    ) VALUES (?, NULL, 'gemini-2.5-flash', ?, ?, ?, ?, ?, ?)
  `).run(
    logId,
    status,
    errorMessage,
    latencyMs,
    `auto_debugger:attempt_${attempt}`,
    JSON.stringify({ attempt, codeLength: (repairedCode || '').length }),
    (repairedCode || '').slice(0, 2000)
  )
}

/**
 * Runs the Bounded Auto-Debugging Loop (up to maxRetries attempts).
 */
export async function runAutoDebuggingLoop(
  taskPrompt: string,
  originalCode: string,
  initialError: string,
  maxRetries = 3,
  customDb?: Database.Database
): Promise<AutoDebugResult> {
  let currentCode = originalCode
  let currentError = initialError
  const errorLog: string[] = [initialError]

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const startTime = performance.now()
    const repairPrompt = `You are an expert Python developer and auto-debugger.
Fix the following Python script so that it correctly fulfills the user prompt without errors.

USER TASK PROMPT:
${taskPrompt}

CURRENT FAILING PYTHON CODE:
\`\`\`python
${currentCode}
\`\`\`

VERBATIM ERROR / STDERR TRACEBACK:
${currentError}

REQUIREMENTS FOR REPAIRED CODE:
1. Fix all syntax errors, import errors, logic bugs, and runtime exceptions.
2. Structure the module with standard docstring containing "Skill Name", "Description", and "Entrypoint".
3. Provide a top-level function named 'run' as the entrypoint.
4. Output ONLY valid, complete, runnable Python code. Do NOT add conversational prose. Enclose code in \`\`\`python ... \`\`\` code block.
`

    let repairedCode = ''

    try {
      repairedCode = await executeWithKeyRotation(
        async (apiKey, model) => {
          const res = await callGeminiRestApi(
            apiKey,
            model,
            [{ role: 'user', parts: [{ text: repairPrompt }] }]
          )
          const text = res?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
          return text
        },
        10,
        'gemini-3.1-flash-lite'
      )
    } catch (err: any) {
      const errMsg = `Gemini API call failed during auto-debugging attempt ${attempt}: ${err?.message || err}`
      currentError = errMsg
      errorLog.push(errMsg)
      const latencyMs = Math.round(performance.now() - startTime)
      try {
        logAutoDebugAttempt(attempt, 'ERROR', errMsg, currentCode, latencyMs, customDb)
      } catch {}
      continue
    }

    const sanitizedCode = sanitizePythonCode(repairedCode)
    if (!sanitizedCode) {
      const errMsg = `Attempt ${attempt}: LLM generated empty code response.`
      currentError = errMsg
      errorLog.push(errMsg)
      const latencyMs = Math.round(performance.now() - startTime)
      try {
        logAutoDebugAttempt(attempt, 'ERROR', errMsg, '', latencyMs, customDb)
      } catch {}
      continue
    }

    currentCode = sanitizedCode

    // Test execution of repaired code
    const testResult = await executeTempPythonCode(currentCode)
    const latencyMs = Math.round(performance.now() - startTime)

    if (testResult.success) {
      try {
        logAutoDebugAttempt(attempt, 'SUCCESS', null, currentCode, latencyMs, customDb)
      } catch {}
      return {
        success: true,
        finalCode: currentCode,
        attempts: attempt,
        errorLog
      }
    } else {
      const testError = testResult.error || testResult.stderr || 'Execution test failed'
      currentError = testError
      errorLog.push(testError)
      try {
        logAutoDebugAttempt(attempt, 'ERROR', testError, currentCode, latencyMs, customDb)
      } catch {}
    }
  }

  return {
    success: false,
    finalCode: currentCode,
    attempts: maxRetries,
    errorLog
  }
}
