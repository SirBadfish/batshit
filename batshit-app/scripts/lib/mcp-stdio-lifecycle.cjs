'use strict'

/**
 * Managed CLI helper lifecycle — one shutdown rule for every `scripts/*-mcp.cjs` bridge.
 *
 * WHY THIS EXISTS (F-P7-10, measured 2026-09-17):
 *
 * The MCP SDK's `StdioServerTransport` attaches exactly two stdin listeners, `data` and
 * `error` (`@modelcontextprotocol/sdk/dist/cjs/server/stdio.js`). It never listens for
 * `end` or `close`, so nothing in the SDK notices the parent CLI's write end going away and
 * `transport.onclose` never fires on a parent exit.
 *
 * That omission is invisible for a bridge that holds no open libuv handle: stdin EOF closes
 * the last handle, the event loop drains, and Node exits on its own. `mode4-controls-mcp.cjs`
 * exited in 8 ms for exactly that reason and never leaked.
 *
 * It is fatal for a bridge that holds one. `codex-subagent-mcp.cjs` and
 * `claude-permission-mcp.cjs` both `await redis.connect()` at startup, and that socket keeps
 * the loop alive forever. macOS reparents the helper to PID 1 and it never dies: 63 live
 * orphans (~237 MB resident, all `--agent=megasmoke_codex_primary`, 3–4 days old) were
 * measured on one Mac, plus one new orphan per managed Codex turn on the dev lane.
 *
 * "Exits by accident because it happens to hold no handle" is not a contract. Every stdio
 * bridge installs this, so adding a Redis client, a keep-alive socket, or an interval to any
 * of them can never silently reintroduce the leak.
 *
 * CALL THIS **AFTER** `await server.connect(transport)`.
 * Before the transport attaches its `data` listener, `process.stdin` is paused, and a paused
 * stream never emits `end`. Installing early would register a listener that can never fire.
 * Signal handlers do not depend on stdin flow, but they are installed together so there is
 * one call site per bridge rather than two that can drift apart.
 */

const process = require('node:process')

/**
 * Upper bound on teardown. A hung `redis.quit()` must never be the reason an orphan
 * survives, so the timer wins if cleanup does not finish first.
 */
const DEFAULT_HARD_EXIT_MS = 2000

const PARENT_GONE_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT']

/**
 * @param {object} [options]
 * @param {string} [options.logPrefix] Bridge log tag, e.g. `[subagent-mcp]`.
 * @param {(reason: string) => unknown} [options.onShutdown] Best-effort cleanup (close Redis).
 * @param {number} [options.hardExitMs] Teardown deadline; defaults to 2000 ms.
 * @returns {{ shutdown: (reason: string, exitCode?: number) => void }}
 */
function installStdioLifecycle(options = {}) {
  const { logPrefix = '', onShutdown, hardExitMs = DEFAULT_HARD_EXIT_MS } = options

  let shuttingDown = false

  const shutdown = (reason, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true

    // `unref` so the deadline is not itself a reason to stay alive: if cleanup finishes and
    // the loop drains first, the process exits without waiting for this timer.
    const deadline = setTimeout(() => process.exit(exitCode), hardExitMs)
    if (typeof deadline.unref === 'function') deadline.unref()

    Promise.resolve()
      .then(() => (typeof onShutdown === 'function' ? onShutdown(reason) : undefined))
      .catch((error) => {
        if (logPrefix) console.error(`${logPrefix} shutdown cleanup failed after ${reason}`, error)
      })
      .finally(() => process.exit(exitCode))
  }

  // The parent closed its write end, or died and the kernel closed it for them. This is the
  // path every real managed run takes, including a CLI killed with SIGKILL.
  process.stdin.on('end', () => shutdown('stdin-end'))
  process.stdin.on('close', () => shutdown('stdin-close'))

  // EPIPE on stdout means the read end is gone, so the parent is gone too. Without a
  // listener this is an uncaught exception; with one it is an ordinary shutdown.
  process.stdout.on('error', () => shutdown('stdout-error'))

  for (const signal of PARENT_GONE_SIGNALS) {
    process.on(signal, () => shutdown(signal))
  }

  return { shutdown }
}

module.exports = {
  installStdioLifecycle,
  DEFAULT_HARD_EXIT_MS
}
