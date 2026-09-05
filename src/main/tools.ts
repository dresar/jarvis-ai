import { exec } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { join, resolve, relative, basename, dirname } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { getDatabase, logToolCall } from './database'
import { executePythonSkill, getPythonSkillToolDeclarations } from './memory/skillStore'
import { consoleLogger } from './logger'

const execAsync = promisify(exec)

// ============================================================
// TOOLS PREMIUM - Kontrol Penuh Sistem
// ============================================================

export async function openApplication(appName: string): Promise<string> {
  const id = randomUUID()
  try {
    await execAsync(`start "" "${appName}"`)
    const r = `✅ Berhasil membuka "${appName}".`
    logToolCall(id, 'open_application', JSON.stringify({ appName }), r)
    return r
  } catch {
    // Coba dengan perintah langsung tanpa tanda kutip ganda
    try {
      await execAsync(`start ${appName}`)
      const r = `✅ Membuka "${appName}"...`
      logToolCall(id, 'open_application', JSON.stringify({ appName }), r)
      return r
    } catch {
      const r = `❌ Gagal membuka "${appName}". Coba sebutkan nama yang lebih spesifik.`
      logToolCall(id, 'open_application', JSON.stringify({ appName }), r)
      return r
    }
  }
}

export async function getSystemStatus(): Promise<string> {
  const id = randomUUID()
  try {
    const now = new Date()
    const tanggal = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    const jam = now.toLocaleTimeString('id-ID')

    const { stdout: cpu } = await execAsync(
      `powershell -command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"`
    )
    const { stdout: mem } = await execAsync(
      `powershell -command "$os = Get-CimInstance Win32_OperatingSystem; [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize * 100)"`
    )
    const { stdout: disk } = await execAsync(
      `powershell -command "$d = Get-PSDrive C; [math]::Round($d.Used / ($d.Used + $d.Free) * 100)"`
    )
    const { stdout: bat } = await execAsync(
      `powershell -command "(Get-CimInstance Win32_Battery).EstimatedChargeRemaining"` 
    ).catch(() => ({ stdout: 'AC' }))

    const batStr = bat.trim() && bat.trim() !== 'AC' ? `🔋 Baterai: ${bat.trim()}%` : '🔌 Terhubung charger'
    const r = `📅 ${tanggal}, pukul ${jam}\n💻 CPU: ${cpu.trim()}% | RAM: ${mem.trim()}% | Disk C: ${disk.trim()}%\n${batStr}`
    logToolCall(id, 'get_system_status', '{}', r)
    return r
  } catch {
    const r = `🕐 Sekarang pukul ${new Date().toLocaleTimeString('id-ID')}`
    logToolCall(id, 'get_system_status', '{}', r)
    return r
  }
}

export async function searchWeb(query: string): Promise<string> {
  const id = randomUUID()
  const enc = encodeURIComponent(query)
  await execAsync(`start https://www.google.com/search?q=${enc}`)
  const r = `🔍 Membuka pencarian Google untuk: "${query}"`
  logToolCall(id, 'search_web', JSON.stringify({ query }), r)
  return r
}

export async function setVolume(level: number): Promise<string> {
  const id = randomUUID()
  const clamped = Math.min(100, Math.max(0, level))
  // Atur volume Windows menggunakan PowerShell
  try {
    await execAsync(
      `powershell -command "$vol = ${clamped / 100}; $wmp = New-Object -ComObject WMPlayer.OCX; $wmp.settings.volume = ${clamped}" 2>nul`
    )
  } catch {
    // Fallback: abaikan error volume
  }
  const r = `🔊 Volume diatur ke ${clamped}%`
  logToolCall(id, 'set_volume', JSON.stringify({ level: clamped }), r)
  return r
}

export async function lockScreen(): Promise<string> {
  const id = randomUUID()
  await execAsync('rundll32.exe user32.dll,LockWorkStation')
  const r = '🔒 Layar dikunci.'
  logToolCall(id, 'lock_screen', '{}', r)
  return r
}

export async function shutdownComputer(delayMinutes: number = 0): Promise<string> {
  const id = randomUUID()
  const secs = delayMinutes * 60
  if (delayMinutes === 0) {
    await execAsync('shutdown /s /t 10')
    const r = '⚠️ Komputer akan dimatikan dalam 10 detik!'
    logToolCall(id, 'shutdown_computer', JSON.stringify({ delayMinutes }), r)
    return r
  }
  await execAsync(`shutdown /s /t ${secs}`)
  const r = `⏱️ Komputer akan dimatikan dalam ${delayMinutes} menit.`
  logToolCall(id, 'shutdown_computer', JSON.stringify({ delayMinutes }), r)
  return r
}

export async function cancelShutdown(): Promise<string> {
  const id = randomUUID()
  await execAsync('shutdown /a').catch(() => {})
  const r = '✅ Jadwal shutdown dibatalkan.'
  logToolCall(id, 'cancel_shutdown', '{}', r)
  return r
}

export async function openFolder(folderPath: string): Promise<string> {
  const id = randomUUID()
  const safe = folderPath || '%USERPROFILE%'
  await execAsync(`explorer "${safe}"`)
  const r = `📁 Membuka folder: ${safe}`
  logToolCall(id, 'open_folder', JSON.stringify({ folderPath: safe }), r)
  return r
}

export async function getClipboard(): Promise<string> {
  const id = randomUUID()
  const { stdout } = await execAsync(
    `powershell -command "Get-Clipboard"`
  ).catch(() => ({ stdout: '' }))
  const content = stdout.trim().slice(0, 300)
  const r = content ? `📋 Isi clipboard:\n"${content}"` : '📋 Clipboard kosong.'
  logToolCall(id, 'get_clipboard', '{}', r)
  return r
}

export async function setClipboard(text: string): Promise<string> {
  const id = randomUUID()
  const escaped = text.replace(/'/g, "''")
  await execAsync(`powershell -command "Set-Clipboard -Value '${escaped}'"`)
  const r = `📋 Teks disalin ke clipboard.`
  logToolCall(id, 'set_clipboard', JSON.stringify({ text }), r)
  return r
}

// ============================================================
// M4 SYSTEM CONTROL TOOLS
// ============================================================

export type InstallationFileAction = 'list' | 'read' | 'write' | 'delete'

export interface ManageInstallationFilesArgs {
  action: InstallationFileAction
  relativePath?: string
  content?: string
}

export interface FileItemInfo {
  name: string
  isDirectory: boolean
  sizeBytes: number
  updatedAt: string
}

export interface ReadErrorLogsArgs {
  lines?: number
  source?: 'db' | 'file'
}

export interface ExecuteCommandArgs {
  command: string
  timeoutMs?: number
}

/**
 * Resolves the Jarvis application installation directory.
 * Priority: JARVIS_INSTALL_DIR env > Windows LocalAppData Programs > app.getAppPath() > process.cwd()
 */
export function getInstallationDirectory(): string {
  if (process.env.JARVIS_INSTALL_DIR) {
    return process.env.JARVIS_INSTALL_DIR
  }

  const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\NCN0C\\AppData\\Local'
  const defaultLocalPath = join(localAppData, 'Programs', 'jarvis')
  if (existsSync(defaultLocalPath)) {
    return defaultLocalPath
  }

  try {
    if (app && typeof app.getAppPath === 'function') {
      return app.getAppPath()
    }
  } catch {}
  return process.cwd()
}

/**
 * Validates and resolves a relative path within the installation directory,
 * strictly preventing path traversal attacks.
 */
export function resolveSafeInstallationPath(baseDir: string, relativePath = ''): string {
  const cleanRelative = relativePath.trim().replace(/^[\/\\]+/, '')
  const resolved = resolve(baseDir, cleanRelative)
  const rel = relative(baseDir, resolved)

  if (rel.startsWith('..') || resolve(baseDir, cleanRelative) !== resolved || (rel && resolve(baseDir, rel) !== resolved)) {
    throw new Error(`[Security] Path traversal outside installation folder is strictly blocked: "${relativePath}"`)
  }
  if (relativePath.includes('..') && (rel.startsWith('..') || !rel || rel === '.')) {
    throw new Error(`[Security] Path traversal outside installation folder is strictly blocked: "${relativePath}"`)
  }
  return resolved
}

/**
 * Manages files and folders in the Jarvis installation directory (list, read, write, delete).
 */
export async function manageInstallationFiles(
  args: ManageInstallationFilesArgs,
  customBaseDir?: string
): Promise<string> {
  const id = randomUUID()
  const baseDir = customBaseDir || getInstallationDirectory()

  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }

  const { action, relativePath = '', content } = args
  let targetPath = ''

  try {
    targetPath = resolveSafeInstallationPath(baseDir, relativePath)
  } catch (err: any) {
    const errorMsg = `❌ Gagal mengelola file instalasi (${action}): ${err?.message || err}`
    logToolCall(id, 'manage_installation_files', JSON.stringify(args), errorMsg)
    return errorMsg
  }

  try {
    let resultMessage = ''

    switch (action) {
      case 'list': {
        if (!existsSync(targetPath)) {
          resultMessage = `❌ Path tidak ditemukan: ${relativePath || '.'}`
          break
        }
        const stat = statSync(targetPath)
        if (!stat.isDirectory()) {
          resultMessage = `📄 File: ${basename(targetPath)} (${stat.size} bytes, diubah: ${stat.mtime.toISOString()})`
          break
        }

        const entries = readdirSync(targetPath, { withFileTypes: true })
        if (entries.length === 0) {
          resultMessage = `📁 Folder "${relativePath || '.'}" kosong.`
          break
        }

        const items: FileItemInfo[] = entries.map((e) => {
          const itemPath = join(targetPath, e.name)
          let size = 0
          let mtime = new Date().toISOString()
          try {
            const s = statSync(itemPath)
            size = s.size
            mtime = s.mtime.toISOString()
          } catch {}
          return {
            name: e.name,
            isDirectory: e.isDirectory(),
            sizeBytes: size,
            updatedAt: mtime
          }
        })

        const formattedList = items
          .map((i) => `  ${i.isDirectory ? '📁 [DIR]' : '📄 [FILE]'} ${i.name.padEnd(30)} ${i.isDirectory ? '' : `${i.sizeBytes} B`} (${i.updatedAt.slice(0, 19)})`)
          .join('\n')

        resultMessage = `📁 Isi direktori "${relativePath || '.'}" (${items.length} item):\n${formattedList}`
        break
      }

      case 'read': {
        if (!existsSync(targetPath)) {
          resultMessage = `❌ File tidak ditemukan: ${relativePath}`
          break
        }
        const stat = statSync(targetPath)
        if (stat.isDirectory()) {
          resultMessage = `❌ Path "${relativePath}" adalah direktori, bukan file. Gunakan action "list".`
          break
        }
        // Safety guard: Limit read size to 100KB to prevent memory exhaustion
        const MAX_READ_BYTES = 100 * 1024
        if (stat.size > MAX_READ_BYTES) {
          resultMessage = `⚠️ File terlalu besar untuk dibaca langsung (${stat.size} bytes > 100KB).`
          break
        }
        const fileContent = readFileSync(targetPath, 'utf-8')
        resultMessage = `📄 Isi file "${relativePath}":\n\`\`\`\n${fileContent}\n\`\`\``
        break
      }

      case 'write': {
        const parentDir = dirname(targetPath)
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true })
        }
        const dataToWrite = typeof content === 'string' ? content : ''
        writeFileSync(targetPath, dataToWrite, 'utf-8')
        resultMessage = `✅ Berhasil menulis ${Buffer.byteLength(dataToWrite, 'utf-8')} bytes ke file "${relativePath}".`
        break
      }

      case 'delete': {
        if (resolve(targetPath) === resolve(baseDir)) {
          resultMessage = `❌ Dilarang menghapus root direktori instalasi.`
          break
        }
        if (!existsSync(targetPath)) {
          resultMessage = `⚠️ File/folder tidak ditemukan untuk dihapus: ${relativePath}`
          break
        }
        rmSync(targetPath, { recursive: true, force: true })
        resultMessage = `🗑️ Berhasil menghapus: "${relativePath}".`
        break
      }

      default:
        resultMessage = `⚠️ Tindakan "${action}" tidak dikenal. Gunakan "list", "read", "write", atau "delete".`
    }

    logToolCall(id, 'manage_installation_files', JSON.stringify(args), resultMessage)
    return resultMessage
  } catch (err: any) {
    const errorMsg = `❌ Gagal mengelola file instalasi (${action}): ${err?.message || err}`
    logToolCall(id, 'manage_installation_files', JSON.stringify(args), errorMsg)
    return errorMsg
  }
}

/**
 * Reads error logs from SQLite execution_logs or console stderr/exception entries.
 */
export async function readErrorLogs(
  args: ReadErrorLogsArgs = {},
  customDb?: Database.Database
): Promise<string> {
  const id = randomUUID()
  const lines = Math.min(Math.max(1, args.lines || 50), 200)
  const source = args.source === 'file' ? 'file' : 'db'

  try {
    if (source === 'db') {
      const db = customDb || getDatabase()
      const rows = db.prepare(`
        SELECT id, key_id, model, status, error_message, latency_ms, tool_name, parameters, result, timestamp
        FROM execution_logs
        WHERE status IN ('ERROR', 'RATE_LIMITED', 'INVALID_KEY')
           OR error_message IS NOT NULL
           OR result LIKE 'ERROR%'
           OR result LIKE '❌%'
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(lines) as any[]

      if (rows.length === 0) {
        const r = `✅ Tidak ada log error ditemukan di database (semua eksekusi berjalan lancar).`
        logToolCall(id, 'read_error_logs', JSON.stringify(args), r, db)
        return r
      }

      const formatted = rows.map((r, idx) => {
        const toolOrModel = r.tool_name ? `Tool: ${r.tool_name}` : `Model: ${r.model}`
        const errorDetail = r.error_message || r.result || 'No specific error message'
        return `[#${idx + 1}] ${r.timestamp} | Status: ${r.status} | ${toolOrModel}\n    Error: ${errorDetail}`
      }).join('\n\n')

      const r = `📋 Ditemukan ${rows.length} log error di database SQLite:\n\n${formatted}`
      logToolCall(id, 'read_error_logs', JSON.stringify(args), r, db)
      return r
    } else {
      // source === 'file' (Read from in-memory stderr/exception consoleLogger and stream)
      const entries = consoleLogger.getEntries(undefined, lines)
      const errorEntries = entries.filter((e) => e.level === 'error' || e.source === 'stderr' || e.source === 'exception')

      if (errorEntries.length === 0) {
        const r = `✅ Tidak ada stream stderr / uncaught exception error pada konsol runtime.`
        logToolCall(id, 'read_error_logs', JSON.stringify(args), r, customDb)
        return r
      }

      const formatted = errorEntries.map((e, idx) => {
        const stackSnippet = e.stack ? `\n    Stack: ${e.stack.split('\n').slice(0, 3).join(' ')}` : ''
        return `[#${idx + 1}] ${e.timestamp} [${e.source.toUpperCase()}]\n    Message: ${e.message}${stackSnippet}`
      }).join('\n\n')

      const r = `📋 Ditemukan ${errorEntries.length} entri stderr/exception pada konsol:\n\n${formatted}`
      logToolCall(id, 'read_error_logs', JSON.stringify(args), r, customDb)
      return r
    }
  } catch (err: any) {
    const errorMsg = `❌ Gagal membaca log error: ${err?.message || err}`
    logToolCall(id, 'read_error_logs', JSON.stringify(args), errorMsg, customDb)
    return errorMsg
  }
}

const DISALLOWED_COMMAND_PATTERNS = [
  /rmdir\s+[\/\\]s\s+[\/\\]q\s+[c-z]:[\/\\]?$/i,
  /del\s+[\/\\]f\s+[\/\\]s\s+[\/\\]q\s+[c-z]:[\/\\]/i,
  /format\s+[c-z]:/i,
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
  /\bRemove-Partition\b/i,
  /\bStop-Computer\s+-Force\b/i
]

/**
 * Safely executes PowerShell command with timeout control and output capture.
 */
export async function executeCommand(
  args: ExecuteCommandArgs,
  customDb?: Database.Database
): Promise<string> {
  const id = randomUUID()
  const { command, timeoutMs = 30000 } = args

  if (!command || !command.trim()) {
    const r = '❌ Perintah command tidak boleh kosong.'
    logToolCall(id, 'execute_command', JSON.stringify(args), r, customDb)
    return r
  }

  const trimmedCmd = command.trim()

  // Guardrail check
  for (const pattern of DISALLOWED_COMMAND_PATTERNS) {
    if (pattern.test(trimmedCmd)) {
      const r = `⛔ Security Error: Perintah "${trimmedCmd}" diblokir karena berpotensi merusak sistem disk.`
      logToolCall(id, 'execute_command', JSON.stringify(args), r, customDb)
      return r
    }
  }

  const effectiveTimeout = Math.min(Math.max(1000, timeoutMs), 120000)
  const startTime = performance.now()

  try {
    const { stdout, stderr } = await execAsync(trimmedCmd, {
      shell: 'powershell.exe',
      timeout: effectiveTimeout,
      maxBuffer: 5 * 1024 * 1024
    })

    const latencyMs = Math.round(performance.now() - startTime)
    const cleanStdout = (stdout || '').trim()
    const cleanStderr = (stderr || '').trim()

    // Truncate output if excessively long (> 4000 chars) to prevent token blowout
    const MAX_OUTPUT_CHARS = 4000
    const truncatedStdout = cleanStdout.length > MAX_OUTPUT_CHARS
      ? `${cleanStdout.slice(0, MAX_OUTPUT_CHARS)}\n... [Output dipotong karena melebihi 4000 karakter]`
      : cleanStdout

    let outputResult = `[STATUS: SUCCESS | Latency: ${latencyMs}ms]`
    if (truncatedStdout) {
      outputResult += `\n--- STDOUT ---\n${truncatedStdout}`
    }
    if (cleanStderr) {
      outputResult += `\n--- STDERR ---\n${cleanStderr}`
    }
    if (!truncatedStdout && !cleanStderr) {
      outputResult += `\n(Perintah selesai tanpa output teks)`
    }

    logToolCall(id, 'execute_command', JSON.stringify(args), outputResult, customDb)
    return outputResult
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - startTime)
    const errStdout = (err?.stdout || '').trim()
    const errStderr = (err?.stderr || err?.message || String(err)).trim()

    let errorResult = `[STATUS: FAILED | Latency: ${latencyMs}ms]`
    if (errStderr) {
      errorResult += `\n--- STDERR ---\n${errStderr}`
    }
    if (errStdout) {
      errorResult += `\n--- STDOUT ---\n${errStdout}`
    }

    logToolCall(id, 'execute_command', JSON.stringify(args), errorResult, customDb)
    return errorResult
  }
}

// ============================================================
// SKEMA TOOLS UNTUK GEMINI FUNCTION CALLING
// ============================================================

/**
 * Normalizes JSON schema types to uppercase strings expected by Gemini REST API.
 */
export function normalizeSchemaTypes(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return { type: 'OBJECT', properties: {} }
  }

  const copy = JSON.parse(JSON.stringify(schema))

  function recursiveNormalize(node: any) {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'string') {
      node.type = node.type.toUpperCase()
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const key of Object.keys(node.properties)) {
        recursiveNormalize(node.properties[key])
      }
    }
    if (node.items && typeof node.items === 'object') {
      recursiveNormalize(node.items)
    }
  }

  recursiveNormalize(copy)
  if (!copy.type) copy.type = 'OBJECT'
  if (!copy.properties) copy.properties = {}
  return copy
}

export const STATIC_GEMINI_FUNCTION_DECLARATIONS = [
  {
    name: 'open_application',
    description: 'Membuka sebuah aplikasi atau program di komputer Windows pengguna. Gunakan ini jika pengguna meminta membuka program seperti Spotify, Chrome, Notepad, Calculator, dll.',
    parameters: { type: 'OBJECT', properties: { appName: { type: 'STRING', description: 'Nama file eksekutabel atau nama aplikasi. Contoh: "notepad", "chrome", "spotify", "calc", "mspaint".' } }, required: ['appName'] }
  },
  {
    name: 'get_system_status',
    description: 'Mendapatkan informasi sistem komputer saat ini: waktu, tanggal, CPU, RAM, Disk, dan status baterai.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'search_web',
    description: 'Membuka browser dan mencari sesuatu di Google. Gunakan saat pengguna ingin mencari informasi di internet.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Kata kunci pencarian Google.' } }, required: ['query'] }
  },
  {
    name: 'set_volume',
    description: 'Mengatur tingkat volume suara sistem komputer.',
    parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Level volume antara 0 (mute) sampai 100 (maksimal).' } }, required: ['level'] }
  },
  {
    name: 'lock_screen',
    description: 'Mengunci layar komputer pengguna.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'shutdown_computer',
    description: 'Mematikan komputer. Bisa langsung atau dengan delay menit.',
    parameters: { type: 'OBJECT', properties: { delayMinutes: { type: 'NUMBER', description: 'Berapa menit sebelum shutdown. Masukkan 0 untuk shutdown segera (dengan konfirmasi 10 detik).' } } }
  },
  {
    name: 'cancel_shutdown',
    description: 'Membatalkan jadwal shutdown yang telah diatur sebelumnya.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'open_folder',
    description: 'Membuka folder di File Explorer Windows.',
    parameters: { type: 'OBJECT', properties: { folderPath: { type: 'STRING', description: 'Path folder yang akan dibuka. Contoh: "C:\\Users", "Downloads". Kosongkan untuk membuka folder Home.' } } }
  },
  {
    name: 'get_clipboard',
    description: 'Membaca isi clipboard pengguna saat ini.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'set_clipboard',
    description: 'Menyalin teks ke clipboard pengguna.',
    parameters: { type: 'OBJECT', properties: { text: { type: 'STRING', description: 'Teks yang akan disalin ke clipboard.' } }, required: ['text'] }
  },
  {
    name: 'manage_installation_files',
    description: 'Mengelola file dan folder di direktori instalasi Jarvis (C:\\Users\\NCN0C\\AppData\\Local\\Programs\\jarvis atau root app). Mendukung melihat isi folder (list), membaca file teks (read), menulis/mengedit file (write), dan menghapus file/folder (delete).',
    parameters: {
      type: 'OBJECT',
      properties: {
        action: {
          type: 'STRING',
          enum: ['list', 'read', 'write', 'delete'],
          description: 'Tindakan yang akan dilakukan: "list", "read", "write", atau "delete".'
        },
        relativePath: {
          type: 'STRING',
          description: 'Path relatif file/folder dari direktori instalasi. Contoh: "resources/app", "package.json", "logs/error.log". Kosongkan untuk direktori root instalasi.'
        },
        content: {
          type: 'STRING',
          description: 'Isi teks yang akan ditulis ke file (wajib untuk action "write").'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'read_error_logs',
    description: 'Membaca riwayat error log aplikasi untuk kebutuhan diagnosa dan perbaikan diri. Mendukung pembacaan dari tabel SQLite execution_logs ("db") atau stream konsol runtime stderr/exception ("file").',
    parameters: {
      type: 'OBJECT',
      properties: {
        lines: {
          type: 'NUMBER',
          description: 'Jumlah baris error log terbaru yang ingin dibaca (default: 50, maks: 200).'
        },
        source: {
          type: 'STRING',
          enum: ['db', 'file'],
          description: 'Sumber log: "db" untuk database execution_logs atau "file" untuk stderr/exception console stream.'
        }
      }
    }
  },
  {
    name: 'execute_command',
    description: 'Mengeksekusi perintah PowerShell di sistem Windows secara aman dengan batas timeout dan menangkap output stdout serta stderr.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: {
          type: 'STRING',
          description: 'Perintah PowerShell yang akan dieksekusi. Contoh: "Get-Process | Select-Object -First 5", "ipconfig", "dir".'
        },
        timeoutMs: {
          type: 'NUMBER',
          description: 'Batas waktu eksekusi dalam milidetik (default: 30000 ms).'
        }
      },
      required: ['command']
    }
  }
]

/**
 * Returns complete Gemini tools array containing static function declarations
 * and dynamic Python procedural skill declarations from SQLite skills_metadata.
 */
export function getDynamicGeminiTools(customDb?: Database.Database): any[] {
  const staticDeclarations = STATIC_GEMINI_FUNCTION_DECLARATIONS

  let dynamicSkillDeclarations: Array<{ name: string; description: string; parameters: any }> = []
  try {
    const rawDeclarations = getPythonSkillToolDeclarations(customDb)
    dynamicSkillDeclarations = rawDeclarations.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: normalizeSchemaTypes(d.parameters)
    }))
  } catch (err) {
    console.warn('[Tools] Could not load dynamic procedural skills:', err)
  }

  return [
    {
      functionDeclarations: [
        ...staticDeclarations,
        ...dynamicSkillDeclarations
      ]
    }
  ]
}

export const GEMINI_TOOLS = getDynamicGeminiTools()

// ============================================================
// EKSEKUTOR TOOLS
// ============================================================
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name.startsWith('skill_')) {
    const rawSkillName = name.replace(/^skill_/, '')
    const res = await executePythonSkill(rawSkillName, args as Record<string, any>)
    if (res.success) {
      return typeof res.result === 'object' ? JSON.stringify(res.result) : String(res.result)
    } else {
      return `❌ Execution error in skill "${rawSkillName}": ${res.error}`
    }
  }

  switch (name) {
    case 'open_application': return openApplication(args.appName as string)
    case 'get_system_status': return getSystemStatus()
    case 'search_web': return searchWeb(args.query as string)
    case 'set_volume': return setVolume(args.level as number)
    case 'lock_screen': return lockScreen()
    case 'shutdown_computer': return shutdownComputer(args.delayMinutes as number ?? 0)
    case 'cancel_shutdown': return cancelShutdown()
    case 'open_folder': return openFolder(args.folderPath as string ?? '')
    case 'get_clipboard': return getClipboard()
    case 'set_clipboard': return setClipboard(args.text as string)

    // New M4 System Tools
    case 'manage_installation_files': return manageInstallationFiles(args as any)
    case 'read_error_logs': return readErrorLogs(args as any)
    case 'execute_command': return executeCommand(args as any)

    default: return `⚠️ Tool "${name}" tidak dikenal.`
  }
}
