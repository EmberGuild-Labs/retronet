// Small rotating file log (PLAN 1.3): userData/logs/main.log, 1 MB x 3 files (main.log, main.1.log, main.2.log).
// Never log page contents, form data or IPC payloads; log method names, codes and origins only.
// Writes are synchronous appends: the log is low-volume and must survive a crash right after the line.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

const MAX_BYTES = 1024 * 1024
const KEEP = 3

let dir: string | null = null
let size = 0
let toConsole = true

/** Point the log at a directory (call once userData is final). Lines before this go to the console only. */
export function initLogger(logsDir: string, opts: { console?: boolean } = {}): void {
  toConsole = opts.console ?? true
  try {
    mkdirSync(logsDir, { recursive: true })
    dir = logsDir
    try {
      size = statSync(join(logsDir, 'main.log')).size
    } catch {
      size = 0
    }
  } catch {
    dir = null
  }
}

export function logFilePath(): string | null {
  return dir ? join(dir, 'main.log') : null
}

function rotate(d: string): void {
  rmSync(join(d, `main.${KEEP - 1}.log`), { force: true })
  for (let i = KEEP - 2; i >= 1; i--) {
    try {
      renameSync(join(d, `main.${i}.log`), join(d, `main.${i + 1}.log`))
    } catch {
      // missing generation, fine
    }
  }
  try {
    renameSync(join(d, 'main.log'), join(d, 'main.1.log'))
  } catch {
    // nothing to rotate
  }
  size = 0
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function log(level: LogLevel, msg: string, ...extra: unknown[]): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra.length ? ' ' + extra.map(fmt).join(' ') : ''}\n`
  if (toConsole) (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line.trimEnd())
  if (!dir) return
  try {
    const bytes = Buffer.byteLength(line)
    if (size + bytes > MAX_BYTES) rotate(dir)
    appendFileSync(join(dir, 'main.log'), line)
    size += bytes
  } catch {
    // Logging must never throw into the caller.
  }
}

export const logger = {
  info: (msg: string, ...extra: unknown[]): void => log('info', msg, ...extra),
  warn: (msg: string, ...extra: unknown[]): void => log('warn', msg, ...extra),
  error: (msg: string, ...extra: unknown[]): void => log('error', msg, ...extra)
}
