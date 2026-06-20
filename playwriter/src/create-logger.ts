import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import stripAnsi from 'strip-ansi'
import { LOG_FILE_PATH } from './utils.js'

export type Logger = {
  log(...args: unknown[]): Promise<void>
  error(...args: unknown[]): Promise<void>
  logFilePath: string
}

export function createFileLogger({ logFilePath }: { logFilePath?: string } = {}): Logger {
  const resolvedLogFilePath = logFilePath || LOG_FILE_PATH
  const logDir = path.dirname(resolvedLogFilePath)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  fs.writeFileSync(resolvedLogFilePath, '')

  let queue: Promise<void> = Promise.resolve()

  // The relay otherwise logs every forwarded CDP event ("Forwarding CDP event:
  // Network.* from tab …"), which floods the file (MBs per run) and buries the
  // events you actually want — extension connect/disconnect, session/tab
  // lifecycle, errors. Drop that high-frequency noise unless PLAYWRITER_LOG_VERBOSE
  // is set, so the log stays useful for watching agent runs.
  const verbose = process.env.PLAYWRITER_LOG_VERBOSE === '1' || process.env.PLAYWRITER_LOG_VERBOSE === 'true'
  const NOISE = /Forwarding CDP event:/

  const log = (...args: unknown[]): Promise<void> => {
    const message = args
      .map((arg) =>
        typeof arg === 'string' ? arg : util.inspect(arg, { depth: null, colors: false, maxStringLength: 1000 }),
      )
      .join(' ')
    if (!verbose && NOISE.test(message)) return queue
    queue = queue.then(() => fs.promises.appendFile(resolvedLogFilePath, stripAnsi(message) + '\n'))
    return queue
  }

  return {
    log,
    error: log,
    logFilePath: resolvedLogFilePath,
  }
}
