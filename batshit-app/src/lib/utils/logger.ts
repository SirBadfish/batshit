// Frontend logging utility that respects environment variables
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
} as const

type LogLevel = keyof typeof LOG_LEVELS

class Logger {
  private level: LogLevel
  private debugMode: boolean

  constructor() {
    // Get log level from environment or default to 'info'
    const viteLogLevel =
      typeof import.meta !== 'undefined' && (import.meta as any).env
        ? (import.meta as any).env.VITE_LOG_LEVEL
        : undefined
    const envLevel =
      viteLogLevel ||
      (typeof process !== 'undefined' ? process.env?.VITE_LOG_LEVEL : undefined) ||
      'info'
    this.level = (envLevel in LOG_LEVELS ? envLevel : 'info') as LogLevel

    const viteDebugMode =
      typeof import.meta !== 'undefined' && (import.meta as any).env
        ? (import.meta as any).env.VITE_DEBUG_MODE
        : undefined
    const debugFlag =
      viteDebugMode ??
      (typeof process !== 'undefined' ? process.env?.VITE_DEBUG_MODE : undefined) ??
      'false'
    this.debugMode = String(debugFlag).toLowerCase() === 'true'
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level]
  }

  error(...args: any[]) {
    if (this.shouldLog('error')) {
      console.error(...args)
    }
  }

  warn(...args: any[]) {
    if (this.shouldLog('warn')) {
      console.warn(...args)
    }
  }

  info(...args: any[]) {
    if (this.shouldLog('info')) {
      console.log(...args)
    }
  }

  debug(...args: any[]) {
    if (this.shouldLog('debug') && this.debugMode) {
      console.log('[DEBUG]', ...args)
    }
  }

  // Special method for development-only logging
  dev(...args: any[]) {
    const viteDev =
      typeof import.meta !== 'undefined' && (import.meta as any).env
        ? (import.meta as any).env.DEV
        : undefined
    const isDev =
      viteDev ??
      (typeof process !== 'undefined' ? process.env?.NODE_ENV === 'development' : false)
    if (isDev && this.debugMode) {
      console.log('[DEV]', ...args)
    }
  }
}

export const logger = new Logger()
