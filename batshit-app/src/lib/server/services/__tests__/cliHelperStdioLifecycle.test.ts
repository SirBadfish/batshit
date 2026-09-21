/**
 * F-P7-10 — a managed CLI helper bridge must not outlive the run that spawned it.
 *
 * WHAT BROKE. The MCP SDK's `StdioServerTransport` attaches only `data` and `error` to
 * stdin; it never listens for `end`/`close`, so `transport.onclose` does not fire when the
 * parent CLI's write end goes away. A bridge holding no open libuv handle still exited,
 * because stdin EOF drained its event loop — an accident, not a contract. The two bridges
 * that `await redis.connect()` never drained: 63 orphaned `codex-subagent-mcp.cjs`
 * processes (all PPID 1, ~237 MB resident, 3-4 days old) were measured on one Mac, plus one
 * new orphan per managed Codex turn on the dev lane.
 *
 * WHAT THIS PINS. Every `scripts/*-mcp.cjs` bridge exits promptly on stdin EOF, SIGTERM and
 * SIGHUP, **while holding an open handle**. The `--require` preload swaps `require('redis')`
 * for a client that opens a real listening socket on connect, which is what reproduces the
 * immortality condition without needing a Redis server — so this runs in the default lane.
 * Remove `installStdioLifecycle` from a bridge and its three cases hang and fail.
 *
 * The last case is the forward-looking half: a NEW `scripts/*-mcp.cjs` is discovered from
 * disk and must be listed here, so the next bridge cannot ship without this contract.
 *
 * MUTATION-CHECKED 2026-09-17, three ways:
 *   - drop `installStdioLifecycle` from the bridges -> both Redis-holding bridges fail the
 *     stdin case (`mode4-controls-mcp.cjs` still passes it, because it genuinely holds no
 *     handle; the source case is what covers that one).
 *   - delete the call from `mode4-controls-mcp.cjs` -> the source case fails.
 *   - remove the teardown deadline and hang `onShutdown` -> all six process cases fail.
 *
 * That third mutation is why the signal cases are here. Registering a SIGTERM/SIGHUP handler
 * REPLACES Node's default terminate, so these bridges can now hang where they previously
 * could not; the cases pin that the deadline still wins.
 */

import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const SCRIPTS_DIR = path.resolve(process.cwd(), 'scripts')
const FAKE_REDIS_PRELOAD = path.resolve(
  process.cwd(),
  'src/lib/test-utils/fixtures/stdio-helper-fake-redis.cjs'
)

/** Generous enough for a loaded CI box, far below the "forever" this test exists to catch. */
const EXIT_DEADLINE_MS = 5000
const STARTUP_DEADLINE_MS = 15000

type HelperCase = {
  /** File name inside `batshit-app/scripts`. */
  file: string
  /** Server name the bridge reports in its `initialize` response. */
  serverName: string
  args: string[]
}

/**
 * Every stdio bridge Batshit spawns for a managed CLI run. Keep in sync with the
 * `scripts/*-mcp.cjs` discovery case below, which fails when this list goes stale.
 */
const HELPERS: HelperCase[] = [
  {
    file: 'codex-subagent-mcp.cjs',
    serverName: 'batshit-subagent-bridge',
    args: ['--agent=lifecycle_test_agent', '--user=lifecycle-test-user', '--url=http://127.0.0.1:59999']
  },
  {
    file: 'claude-permission-mcp.cjs',
    serverName: 'batshit-claude-approvals',
    args: []
  },
  {
    file: 'mode4-controls-mcp.cjs',
    serverName: 'batshit-cli-internal-tools',
    args: ['--agent=lifecycle_test_agent', '--user=lifecycle-test-user', '--url=http://127.0.0.1:59999']
  }
]

const HELPER_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_OPTIONS: `--require ${FAKE_REDIS_PRELOAD}`,
  // The bridges refuse to start without a per-run credential (SA-117 DL-117-08).
  BATSHIT_AGENT_TOKEN: 'lifecycle-test-run-credential',
  BATSHIT_SESSION_ID: 'lifecycle-test-session',
  BATSHIT_MESSAGE_ID: 'lifecycle-test-message',
  // Never let a real Redis be reachable from this suite even if the preload were bypassed.
  REDIS_URL: 'redis://127.0.0.1:1/0',
  REDIS_PASSWORD: ''
}

type RunningHelper = {
  child: ChildProcessWithoutNullStreams
  stderr: () => string
}

/**
 * Spawn a bridge and wait for a real `initialize` response.
 *
 * The handshake is the readiness signal on purpose: it proves the transport is connected
 * before stdin is closed, so a later exit cannot be a startup crash wearing a clean exit's
 * clothes.
 */
async function startHelper(helper: HelperCase): Promise<RunningHelper> {
  const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, helper.file), ...helper.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: HELPER_ENV
  }) as ChildProcessWithoutNullStreams

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  let earlyExit: string | null = null
  child.on('exit', (code, signal) => {
    if (earlyExit === null) earlyExit = `code=${code} signal=${signal}`
  })

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'batshit-lifecycle-test', version: '1.0.0' }
      }
    })}\n`
  )

  const deadline = Date.now() + STARTUP_DEADLINE_MS
  while (Date.now() < deadline) {
    if (stdout.includes(helper.serverName)) {
      return { child, stderr: () => stderr }
    }
    if (earlyExit) {
      throw new Error(`${helper.file} exited during startup (${earlyExit}). stderr:\n${stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  child.kill('SIGKILL')
  throw new Error(`${helper.file} never answered initialize. stdout:\n${stdout}\nstderr:\n${stderr}`)
}

/** Resolves to the exit reason, or `null` if the bridge was still alive at the deadline. */
async function awaitExit(child: ChildProcessWithoutNullStreams): Promise<string | null> {
  const result = await Promise.race([
    new Promise<string>((resolve) => child.on('exit', (code, signal) => resolve(`code=${code} signal=${signal}`))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), EXIT_DEADLINE_MS))
  ])
  if (result === null) child.kill('SIGKILL')
  return result
}

describe('managed CLI helper bridges exit with their run (F-P7-10)', () => {
  for (const helper of HELPERS) {
    describe(helper.file, () => {
      it('exits when its parent closes stdin, while holding an open handle', async () => {
        const { child, stderr } = await startHelper(helper)
        child.stdin.end()
        const exit = await awaitExit(child)
        expect(exit, `${helper.file} survived stdin EOF — it will orphan to PID 1. stderr:\n${stderr()}`).not.toBeNull()
      }, 30000)

      it('exits on SIGTERM', async () => {
        const { child, stderr } = await startHelper(helper)
        child.kill('SIGTERM')
        const exit = await awaitExit(child)
        expect(exit, `${helper.file} survived SIGTERM. stderr:\n${stderr()}`).not.toBeNull()
      }, 30000)

      it('exits on SIGHUP', async () => {
        const { child, stderr } = await startHelper(helper)
        child.kill('SIGHUP')
        const exit = await awaitExit(child)
        expect(exit, `${helper.file} survived SIGHUP. stderr:\n${stderr()}`).not.toBeNull()
      }, 30000)
    })
  }

  it('covers every stdio bridge on disk, and each one installs the shared lifecycle', () => {
    const onDisk = readdirSync(SCRIPTS_DIR)
      .filter((name) => name.endsWith('-mcp.cjs'))
      .sort()

    expect(
      onDisk,
      'A new scripts/*-mcp.cjs bridge exists that this suite does not cover. Add it to HELPERS.'
    ).toEqual(HELPERS.map((helper) => helper.file).sort())

    for (const name of onDisk) {
      const source = readFileSync(path.join(SCRIPTS_DIR, name), 'utf8')
      expect(source, `${name} must require the shared lifecycle module`).toContain(
        'mcp-stdio-lifecycle.cjs'
      )
      expect(source, `${name} must call installStdioLifecycle after server.connect`).toContain(
        'installStdioLifecycle('
      )
    }
  })
})
