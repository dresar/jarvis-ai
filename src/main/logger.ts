import { EventEmitter } from 'events'

export interface LogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error'
  source: 'stdout' | 'stderr' | 'exception'
  message: string
  stack?: string
}

class ConsoleStreamLogger extends EventEmitter {
  private buffer: LogEntry[] = []
  private readonly maxLines = 1000

  constructor() {
    super()
    this.interceptStderr()
    this.trapExceptions()
  }

  private interceptStderr(): void {
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: any, encoding?: any, cb?: any) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      if (str && str.trim()) {
        this.addEntry('error', 'stderr', str)
      }
      return origStderrWrite(chunk, encoding, cb)
    }
  }

  private trapExceptions(): void {
    process.on('uncaughtException', (err: Error) => {
      this.addEntry('error', 'exception', err?.message || String(err), err?.stack)
    })
    process.on('unhandledRejection', (reason: any) => {
      const msg = reason?.message || String(reason)
      const stack = reason?.stack || undefined
      this.addEntry('error', 'exception', `Unhandled Rejection: ${msg}`, stack)
    })
  }

  public addEntry(
    level: 'info' | 'warn' | 'error',
    source: 'stdout' | 'stderr' | 'exception',
    message: string,
    stack?: string
  ): void {
    const entry: LogEntry = {
      id: `console_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      source,
      message: message.trim(),
      stack
    }
    this.buffer.push(entry)
    if (this.buffer.length > this.maxLines) {
      this.buffer.shift()
    }
    this.emit('entry', entry)
  }

  public getEntries(since?: string, limit = 200): LogEntry[] {
    let list = this.buffer
    if (since) {
      list = list.filter((e) => e.timestamp > since)
    }
    return list.slice(-limit)
  }

  public clear(): void {
    this.buffer = []
    this.emit('clear')
  }
}

export const consoleLogger = new ConsoleStreamLogger()
