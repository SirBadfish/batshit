import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { NATIVE_BASH_STOP_GUIDANCE, nativeToolService } from '../nativeTools'
import { __runAppleContainerCommandForTests } from '../appleContainerSandbox'
import { closeRegisteredRuntimeResources } from '../runtimeShutdown'
import { redis } from '$lib/server/redis'

/**
 * Stop ends a running command on the API lane (2026-09-18).
 *
 * The AI SDK hands every tool call an abort signal; the command tool ignored it, so a Stop
 * aborted the stream and then waited for the command to finish. Measured on the dev lane: Stop
 * 1.5 s into `sleep 20` (Apple Container sandbox) ended the reply's request 22 s later
 * (`_local/stopfix-proof/before-api-mid.json`); the Codex lane took 133 ms. These run REAL
 * processes on the local shell, the default backend, and through the Apple Container runner.
 */

let workspace: string | null = null

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
  workspace = null
})

async function freshWorkspace() {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-bash-stop-'))
  return workspace
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function goneWithin(pid: number, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isRunning(pid)
}

/** Wait for a file the command writes, and answer its trimmed text. */
async function markerText(dir: string, name: string) {
  for (let tries = 0; tries < 250; tries += 1) {
    const text = (await readFile(path.join(dir, name), 'utf8').catch(() => '')).trim()
    if (text) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`the command never wrote ${name}`)
}

// An agent record for the dispatch to govern with (the default lane's Redis is an in-memory fake).
const DISPATCH_AGENT_ID = 'agent-bsd2-dispatch'

async function seedDispatchAgent(nativeTools: Record<string, unknown> = {}) {
  await redis.set(`agent:${DISPATCH_AGENT_ID}`, {
    user_id: 'josh',
    provider_specific_settings: {
      nativeTools: { executionBackend: 'local', bashEnabled: true, bashAccessMode: 'dangerous', ...nativeTools }
    }
  } as any)
}

/** The dispatch the managed CLI helper and n8n Workflow Subagents call, with the route's Stop. */
function dispatch(
  action: string,
  payloadInput: Record<string, unknown>,
  options: { abortSignal?: AbortSignal; projectPath?: string } = {}
) {
  return nativeToolService.dispatchNativeAutomationPackAction({
    userId: 'josh',
    action,
    payloadInput,
    context: { session_id: 'session-bsd2', agent_id: DISPATCH_AGENT_ID, mode: 'mode4', actor_type: 'primary' },
    projectPath: options.projectPath ?? null,
    actorType: 'agent',
    abortSignal: options.abortSignal
  } as any) as Promise<Record<string, any>>
}

async function runStopped(command: string, stopAfterMs: number) {
  const cwd = await freshWorkspace()
  const stop = new AbortController()
  const started = Date.now()
  setTimeout(() => stop.abort('user'), stopAfterMs)
  const result = await nativeToolService.nativeBashExecute({
    command,
    workspaceRoot: cwd,
    cwd,
    accessMode: 'dangerous',
    backend: 'local',
    abortSignal: stop.signal
  })
  return { result, ms: Date.now() - started, cwd }
}

/**
 * Start a command and Stop it once it has written `marker`. A fixed delay is not enough when the
 * test depends on something the command did before the Stop: `/bin/zsh -lc` reads the login
 * profile first, and under load (or with a slow profile) a Stop 150-400 ms in landed before the
 * command's first line ran (seen in the full lane 2026-09-18; reproduced with a `.zshenv` that
 * sleeps 0.5 s). `ms` counts from the Stop.
 */
async function runStoppedAfter(command: string, marker: string) {
  const cwd = await freshWorkspace()
  const stop = new AbortController()
  const call = nativeToolService.nativeBashExecute({
    command,
    workspaceRoot: cwd,
    cwd,
    accessMode: 'dangerous',
    backend: 'local',
    abortSignal: stop.signal
  })
  await markerText(cwd, marker)
  const stoppedAt = Date.now()
  stop.abort('user')
  const result = await call
  return { result, ms: Date.now() - stoppedAt, cwd }
}

describe('a Stop during a local shell command', () => {
  it('ends the command at once and says it was stopped', async () => {
    const { result, ms } = await runStopped('sleep 5', 150)

    expect(ms).toBeLessThan(1_500)
    expect(result).toMatchObject({
      success: false,
      stopped: true,
      timedOut: false,
      // The stored step's words; with no reason it read "Tool execution failed."
      reason: 'The command was stopped.'
    })
  })

  it('does not wait for a child the shell started, which would hold its output open', async () => {
    // The shell stays to run `echo`, so `sleep` is ITS child and keeps the pipes open after the
    // shell is killed; waiting for the pipes to close meant waiting for `sleep`.
    const { result, ms, cwd } = await runStopped('sleep 5; echo done > after.txt', 150)

    expect(ms).toBeLessThan(1_500)
    expect(result).toMatchObject({ success: false, stopped: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(path.join(cwd, 'after.txt'))).toBe(false)
  })

  it('never starts a command it was told to stop before it began', async () => {
    const cwd = await freshWorkspace()
    const stop = new AbortController()
    stop.abort('user')

    const result = await nativeToolService.nativeBashExecute({
      command: 'echo ran > ran.txt',
      workspaceRoot: cwd,
      cwd,
      accessMode: 'dangerous',
      backend: 'local',
      abortSignal: stop.signal
    })

    expect(result).toMatchObject({ success: false, stopped: true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(existsSync(path.join(cwd, 'ran.txt'))).toBe(false)
  })

  it('does not call a stopped command a success, even one that exits 0 when told to stop', async () => {
    // As with a timeout: a program that handles the stop signal and exits 0 was still stopped.
    // The Stop waits for the trap: one that lands first ends the shell with no exit code.
    const { result, ms } = await runStoppedAfter("trap 'exit 0' TERM; echo set > trap.set; sleep 5 & wait", 'trap.set')

    expect(ms).toBeLessThan(1_500)
    expect(result).toMatchObject({ success: false, stopped: true, exitCode: 0 })
  })

  it('runs a command to its end when nobody stops it', async () => {
    const { result } = await runStopped('echo hello', 5_000)
    expect(result).toMatchObject({ success: true, exitCode: 0 })
    expect(result.stopped).toBeUndefined()
  })
})

describe('the command tool hands the model run’s abort signal to the command', () => {
  async function buildBashTool(cwd: string) {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: cwd,
      providerSettings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashPolicyMode: 'workspace',
          bashAccessMode: 'dangerous',
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          agentBrowserEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)
    return (tools as any).native_bash_execute
  }

  it('tells the model what a Stop and a timeout end, and how to leave a program running (Agent Docs)', async () => {
    const description: string = (await buildBashTool(await freshWorkspace())).description

    expect(description).toMatch(/A Stop or a timeout ends the command and everything it started\./)
    // The redirect is what lets the command finish: a background program that still holds the
    // command's output keeps the tool waiting, and the timeout then ends it.
    expect(description).toContain('> log 2>&1 &')
    expect(description).toMatch(/let the command finish/)
    expect(description).toMatch(/until Batshit quits/)
    // Every reply removes the chat's sandboxes when it ends, and what runs in them.
    expect(description).toMatch(/in a sandbox, at most until this reply ends/)
  })

  it('the managed CLI helper’s own bash tool says the same words: its commands take the same Stop', () => {
    // `batshit_server_bash_execute` runs through the dispatch, which hands its command the Stop
    // of the reply running in the chat (2026-09-18). The helper is a `.cjs` script and keeps a
    // copy of the text, held here to the one constant.
    const helper = readFileSync(path.resolve(__dirname, '../../../../../scripts/mode4-controls-mcp.cjs'), 'utf8')
    expect(helper).toContain(NATIVE_BASH_STOP_GUIDANCE)
  })

  it('stops a running command when the run is stopped', async () => {
    const cwd = await freshWorkspace()
    const bashTool = await buildBashTool(cwd)
    const stop = new AbortController()
    setTimeout(() => stop.abort('user'), 150)
    const started = Date.now()

    const result = await bashTool.execute(
      { command: 'sleep 5' },
      { abortSignal: stop.signal, toolCallId: 'call_stop', messages: [] }
    )

    expect(Date.now() - started).toBeLessThan(1_500)
    expect(result).toMatchObject({ success: false, stopped: true })
  })
})

describe('the Apple Container command runner', () => {
  it('stops its command when told to, instead of waiting for it', async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort('user'), 150)
    const started = Date.now()

    // The runner spawns whatever CLI it is given; `sleep` stands in for `container exec`.
    const run = await __runAppleContainerCommandForTests('sleep', ['5'], {
      timeoutMs: 10_000,
      abortSignal: stop.signal
    })

    expect(Date.now() - started).toBeLessThan(1_500)
    expect(run).toMatchObject({ stopped: true, timedOut: false })
  })

  it('never starts a command stopped before it began, as when a Stop lands while the sandbox starts', async () => {
    const cwd = await freshWorkspace()
    const stop = new AbortController()
    stop.abort('user')

    const run = await __runAppleContainerCommandForTests('sh', ['-c', 'echo ran > ran.txt'], {
      cwd,
      timeoutMs: 10_000,
      abortSignal: stop.signal
    })

    expect(run).toMatchObject({ stopped: true, exitCode: null })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(existsSync(path.join(cwd, 'ran.txt'))).toBe(false)
  })
})

/**
 * A Stop and a timeout end everything the command started (2026-09-18), one rule for both.
 *
 * Measured on the code before (`_local/bgkill-proof/before-local.json`): a program the command
 * started in the background kept running after a Stop, even one whose parent shell had already
 * left; and a 1 s timeout returned only 12 s later, when the background `sleep 12` that held the
 * command's output ended on its own (`npm run dev &` would have held the reply forever). Each
 * command now leads its own process group, and a Stop or timeout ends the whole group.
 */
describe('a Stop or a timeout ends what the command started in the background', () => {
  const leftovers: number[] = []

  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  })

  // The command writes its background program's pid to `bg.pid`.
  async function backgroundPid(cwd: string) {
    for (let tries = 0; tries < 100; tries += 1) {
      const text = await readFile(path.join(cwd, 'bg.pid'), 'utf8').catch(() => '')
      if (text.trim()) {
        const pid = Number(text.trim())
        leftovers.push(pid)
        return pid
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('the command never wrote bg.pid')
  }

  async function runTimedOut(command: string, timeoutMs: number) {
    const cwd = await freshWorkspace()
    const started = Date.now()
    const result = await nativeToolService.nativeBashExecute({
      command,
      workspaceRoot: cwd,
      cwd,
      accessMode: 'dangerous',
      backend: 'local',
      timeoutMs
    })
    return { result, ms: Date.now() - started, cwd }
  }

  // Each Stop below waits for `bg.pid`: a Stop that lands before the background program starts
  // proves nothing about it (and the test used to fail "never wrote bg.pid" under a slow shell).
  it('a Stop ends a program the command started in the background', async () => {
    const { result, cwd } = await runStoppedAfter('sleep 30 & echo $! > bg.pid; sleep 29', 'bg.pid')
    const pid = await backgroundPid(cwd)

    expect(result).toMatchObject({ success: false, stopped: true })
    expect(await goneWithin(pid, 1_000)).toBe(true)
  })

  it('a Stop ends a background program whose own parent shell already left', async () => {
    // The subshell exits at once, so `sleep 30` belongs to no shell of the command any more.
    const { result, cwd } = await runStoppedAfter('(sleep 30 & echo $! > bg.pid); sleep 29', 'bg.pid')
    const pid = await backgroundPid(cwd)

    expect(result).toMatchObject({ success: false, stopped: true })
    expect(await goneWithin(pid, 1_000)).toBe(true)
  })

  it('a Stop ends a background program that ignores the polite signal, a moment later', async () => {
    // The program writes its own pid once it ignores SIGTERM (an ignored signal stays ignored
    // across `exec`), so the Stop reaches a program that really ignores it.
    const { result, cwd } = await runStoppedAfter(
      "(trap '' TERM; exec sh -c 'echo $$ > bg.pid; exec sleep 30') & wait",
      'bg.pid'
    )
    const pid = await backgroundPid(cwd)

    expect(result).toMatchObject({ success: false, stopped: true })
    expect(await goneWithin(pid, 1_500)).toBe(true)
  })

  it('a timeout ends the command and its background program at the timeout', async () => {
    const { result, ms, cwd } = await runTimedOut('sleep 30 & echo $! > bg.pid; wait', 1_000)
    const pid = await backgroundPid(cwd)

    expect(ms).toBeLessThan(3_000)
    expect(result).toMatchObject({ success: false, timedOut: true })
    expect(await goneWithin(pid, 1_000)).toBe(true)
  })

  it('a timeout does not wait for a background program that holds the command’s output', async () => {
    // The shell is done at once; the background program still holds its output. Before, the tool
    // waited for that program, so the timeout never ended anything.
    const { result, ms, cwd } = await runTimedOut('sleep 30 & echo $! > bg.pid', 1_000)
    const pid = await backgroundPid(cwd)

    expect(ms).toBeLessThan(3_000)
    expect(result).toMatchObject({ success: false, timedOut: true })
    expect(await goneWithin(pid, 1_000)).toBe(true)
  })

  it('a timeout does not wait for a program that left the command’s group and holds its output', async () => {
    // A program that makes itself a new session escapes the group kill (a known limit). It
    // still holds the command's output, which is let go after the SIGKILL round.
    const escape = `"${process.execPath}" -e "const c = require('child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); require('fs').writeFileSync('bg.pid', String(c.pid))"`
    const { result, ms, cwd } = await runTimedOut(`${escape}; sleep 29`, 1_000)
    await backgroundPid(cwd)

    expect(ms).toBeLessThan(3_000)
    expect(result).toMatchObject({ success: false, timedOut: true })
  })

  it('a finished command’s own background program keeps running until Batshit quits', async () => {
    // `nohup server > log 2>&1 &` must still work. Quitting Batshit ends it, as it did when every
    // command shared the app server's process group.
    const { result, cwd } = await runTimedOut('sleep 30 > /dev/null 2>&1 & echo $! > bg.pid', 10_000)
    const pid = await backgroundPid(cwd)

    expect(result).toMatchObject({ success: true, exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(isRunning(pid)).toBe(true)

    await closeRegisteredRuntimeResources('SIGTERM')

    expect(await goneWithin(pid, 1_000)).toBe(true)
  })
})

/**
 * A Stop ends a running Agent Browser call, and never its daemon (2026-09-18, bug sweep item 17).
 *
 * The agent-browser runner (`runAgentBrowserCli`) took no abort signal, so a Stop left the CLI
 * call running to its own time limit (45 s by default, up to 120 s). The CLI is a short client of
 * a daemon it starts once and that is long-lived by design: seen on this Mac with 0.37.1, the
 * daemon leads its own process group and its output goes to `/dev/null`. The fake CLI below plays
 * both parts: its first call starts such a daemon, then it works on its command for 30 s.
 */
describe('a Stop ends a running Agent Browser call, never its daemon', () => {
  const fakeDirs: string[] = []
  const previousBin = process.env.BATSHIT_AGENT_BROWSER_BIN

  afterEach(async () => {
    // Whatever a fake started, even when a test failed before reading its pids.
    for (const dir of fakeDirs.splice(0)) {
      for (const name of ['cli.pid', 'daemon.pid', 'child.pid']) {
        const text = await readFile(path.join(dir, name), 'utf8').catch(() => '')
        const pid = Number(text.trim())
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }
      await rm(dir, { recursive: true, force: true })
    }
    if (previousBin === undefined) delete process.env.BATSHIT_AGENT_BROWSER_BIN
    else process.env.BATSHIT_AGENT_BROWSER_BIN = previousBin
  })

  /** A fake `agent-browser`: `--version` answers at once; any command is logged and takes 30 s. */
  async function fakeAgentBrowser(
    options: {
      stderr?: string
      childHoldsOutput?: boolean
      exitZeroOnStop?: boolean
      quick?: boolean
      /** The first command fails at once with this startup error; later ones take 30 s. */
      firstFailsWith?: string
      /** `close` succeeds at once (the recovery's first step). */
      quickClose?: boolean
    } = {}
  ) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-ab-stop-'))
    fakeDirs.push(dir)
    const at = (name: string) => JSON.stringify(path.join(dir, name))
    const script = [
      "import { spawn } from 'node:child_process'",
      "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'",
      'const args = process.argv.slice(2)',
      "if (args[0] === '--version') { console.log('agent-browser 0.37.1'); process.exit(0) }",
      `const first = !existsSync(${at('calls.log')})`,
      `appendFileSync(${at('calls.log')}, JSON.stringify(args) + '\\n')`,
      ...(options.firstFailsWith
        ? [`if (first) { process.stderr.write(${JSON.stringify(`${options.firstFailsWith}\n`)}); process.exit(1) }`]
        : []),
      ...(options.quickClose
        ? ["if (args.at(-1) === 'close') { console.log(JSON.stringify({ success: true, data: {} })); process.exit(0) }"]
        : []),
      // Like the real CLI: the first call starts the daemon, detached, output on /dev/null.
      `if (!existsSync(${at('daemon.pid')})) {`,
      "  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
      '  daemon.unref()',
      `  writeFileSync(${at('daemon.pid')}, String(daemon.pid))`,
      '}',
      ...(options.childHoldsOutput
        ? [
            // A helper of the CLI's own that shares its output (the real CLI has none).
            "const child = spawn('sleep', ['30'], { stdio: 'inherit' })",
            `writeFileSync(${at('child.pid')}, String(child.pid))`
          ]
        : []),
      ...(options.stderr ? [`process.stderr.write(${JSON.stringify(`${options.stderr}\n`)})`] : []),
      ...(options.exitZeroOnStop
        ? ["process.on('SIGTERM', () => { console.log(JSON.stringify({ success: true, data: {} })); process.exit(0) })"]
        : []),
      `writeFileSync(${at('cli.pid')}, String(process.pid))`,
      options.quick
        ? "console.log(JSON.stringify({ success: true, data: { title: 'Example' } }))"
        : "setTimeout(() => console.log(JSON.stringify({ success: true, data: { title: 'late' } })), 30_000)"
    ].join('\n')
    await writeFile(path.join(dir, 'fake-agent-browser.mjs'), script)
    const bin = path.join(dir, 'agent-browser')
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'fake-agent-browser.mjs')}" "$@"\n`)
    await chmod(bin, 0o755)
    process.env.BATSHIT_AGENT_BROWSER_BIN = bin
    return dir
  }

  async function pidFrom(dir: string, name: string) {
    for (let tries = 0; tries < 200; tries += 1) {
      const pid = Number((await readFile(path.join(dir, name), 'utf8').catch(() => '')).trim())
      if (pid > 0) return pid
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`the fake agent-browser never wrote ${name}`)
  }

  async function callsOf(dir: string) {
    const text = await readFile(path.join(dir, 'calls.log'), 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean)
  }

  function useGetTitle(extra: { abortSignal?: AbortSignal; params?: Record<string, unknown> } = {}) {
    return nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'get title',
      params: extra.params ?? {},
      settings: { liveViewEnabled: false },
      abortSignal: extra.abortSignal
    } as any)
  }

  it('ends the CLI call at once and says it was stopped, and the daemon keeps running', async () => {
    const dir = await fakeAgentBrowser()
    const stop = new AbortController()
    const call = useGetTitle({ abortSignal: stop.signal })
    const cliPid = await pidFrom(dir, 'cli.pid')
    const daemonPid = await pidFrom(dir, 'daemon.pid')

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({
      success: false,
      stopped: true,
      // The stored step's words, as for a stopped bash command.
      reason: 'The command was stopped.',
      error: 'The command was stopped.'
    })
    expect(await goneWithin(cliPid, 1_000)).toBe(true)
    expect(isRunning(daemonPid)).toBe(true)
  })

  it('never starts a call it was told to stop before it began', async () => {
    const dir = await fakeAgentBrowser()
    const stop = new AbortController()
    stop.abort('user')

    const result = await useGetTitle({ abortSignal: stop.signal })

    expect(result).toMatchObject({ success: false, stopped: true, reason: 'The command was stopped.' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await callsOf(dir)).toEqual([])
  })

  it('does not run the recovery retry for a stopped call, even one that printed a startup error first', async () => {
    const dir = await fakeAgentBrowser({ stderr: 'Browser not launched. Call launch first.' })
    const stop = new AbortController()
    const call = useGetTitle({ abortSignal: stop.signal })
    await pidFrom(dir, 'cli.pid')

    stop.abort('user')
    const result = await call

    expect(result).toMatchObject({ success: false, stopped: true, bootstrap: { attempted: false } })
    expect(await callsOf(dir)).toHaveLength(1)
  })

  it('says it was stopped when the Stop lands during the recovery after a startup error', async () => {
    // The first call fails at once with "Browser not launched", so the recovery runs `close`;
    // the Stop lands while `close` runs.
    const dir = await fakeAgentBrowser({ firstFailsWith: 'Browser not launched. Call launch first.' })
    const stop = new AbortController()
    const call = useGetTitle({ abortSignal: stop.signal })
    await pidFrom(dir, 'cli.pid')

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({
      success: false,
      stopped: true,
      error: 'The command was stopped.',
      bootstrap: { attempted: true, succeeded: false }
    })
    // The command, then `close`; nothing after the Stop.
    expect((await callsOf(dir)).map((line) => JSON.parse(line).at(-1))).toEqual(['title', 'close'])
  })

  it('ends the live-preview `close` that runs before an `open`, and the `open` never starts', async () => {
    const dir = await fakeAgentBrowser()
    const stop = new AbortController()
    const call = nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: { url: 'https://example.com' },
      settings: { liveViewEnabled: true, runtimeMode: 'chromium', provider: 'local' },
      abortSignal: stop.signal
    } as any)
    await pidFrom(dir, 'cli.pid')

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({
      success: false,
      stopped: true,
      livePreviewPreparation: { attempted: true, succeeded: false }
    })
    expect((await callsOf(dir)).map((line) => JSON.parse(line).at(-1))).toEqual(['close'])
  })

  it('ends the wait that runs before a screenshot, and the screenshot never starts', async () => {
    const dir = await fakeAgentBrowser()
    const stop = new AbortController()
    const call = nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'screenshot',
      settings: { liveViewEnabled: false },
      abortSignal: stop.signal
    } as any)
    await pidFrom(dir, 'cli.pid')

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({ success: false, stopped: true, preScreenshotWait: { attempted: true, success: false } })
    const calls = await callsOf(dir)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0])).toContain('wait')
  })

  it('does not call the recovery a success when the Stop cuts its retry, even one that prints success on the Stop', async () => {
    // The command fails at once, `close` succeeds, and the Stop lands in the retried command.
    const dir = await fakeAgentBrowser({
      firstFailsWith: 'Browser not launched. Call launch first.',
      quickClose: true,
      exitZeroOnStop: true
    })
    const stop = new AbortController()
    const call = useGetTitle({ abortSignal: stop.signal })
    await pidFrom(dir, 'cli.pid')

    stop.abort('user')
    const result = await call

    expect(result).toMatchObject({ success: false, stopped: true, bootstrap: { attempted: true, succeeded: false } })
    expect((await callsOf(dir)).map((line) => JSON.parse(line).at(-1))).toEqual(['title', 'close', 'title'])
  })

  it('does not call a stopped call a success, even when its CLI prints success and exits 0 on the Stop', async () => {
    const dir = await fakeAgentBrowser({ exitZeroOnStop: true })
    const stop = new AbortController()
    const call = useGetTitle({ abortSignal: stop.signal })
    await pidFrom(dir, 'cli.pid')

    stop.abort('user')
    const result = await call

    expect(result).toMatchObject({
      success: false,
      stopped: true,
      error: 'The command was stopped.',
      execution: { exitCode: 0 }
    })
  })

  it('lets go of the reply’s signal when a call ends: one reply can make many calls', async () => {
    await fakeAgentBrowser({ quick: true })
    const reply = new AbortController()
    const added = vi.spyOn(reply.signal, 'addEventListener')
    const removed = vi.spyOn(reply.signal, 'removeEventListener')

    const result = await useGetTitle({ abortSignal: reply.signal })

    expect(result).toMatchObject({ success: true, result: { title: 'Example' } })
    expect(result.stopped).toBeUndefined()
    expect(added).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1])
  })

  it('comes back after a Stop even when something the CLI started still holds its output', async () => {
    const dir = await fakeAgentBrowser({ childHoldsOutput: true })
    const stop = new AbortController()
    const call = useGetTitle({ abortSignal: stop.signal })
    const cliPid = await pidFrom(dir, 'cli.pid')

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_500)
    expect(result).toMatchObject({ success: false, stopped: true })
    expect(await goneWithin(cliPid, 1_000)).toBe(true)
  })

  it('ends an Agent Browser call run through the dispatch, and reports it as stopped, not as a backend failure', async () => {
    const dir = await fakeAgentBrowser()
    await seedDispatchAgent({ agentBrowserEnabled: true })
    const stop = new AbortController()
    const call = dispatch('agent_browser_use', { toolName: 'get title', params: {} }, { abortSignal: stop.signal })
    const cliPid = await pidFrom(dir, 'cli.pid')
    const daemonPid = await pidFrom(dir, 'daemon.pid')

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({
      success: true,
      data: { success: false, stopped: true, reason: 'The command was stopped.' }
    })
    expect(await goneWithin(cliPid, 1_000)).toBe(true)
    expect(isRunning(daemonPid)).toBe(true)
    await redis.del(`agent:${DISPATCH_AGENT_ID}`)
  })

  it('ends an agent_browser: ref run through the dispatch broker the same way', async () => {
    const dir = await fakeAgentBrowser()
    await seedDispatchAgent({ agentBrowserEnabled: true })
    const stop = new AbortController()
    const call = dispatch('batshit_tool_use', { ref: 'agent_browser:get_title', input: {} }, { abortSignal: stop.signal })
    const cliPid = await pidFrom(dir, 'cli.pid')

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    expect(result).toMatchObject({
      success: true,
      data: { success: false, stopped: true, reason: 'The command was stopped.', family: 'agent_browser' }
    })
    expect(await goneWithin(cliPid, 1_000)).toBe(true)
    await redis.del(`agent:${DISPATCH_AGENT_ID}`)
  })

  it('ignores an abortSignal typed into the broker input: only a real signal counts', async () => {
    // The broker's input schema passes unknown keys through and the API broker spreads it.
    await fakeAgentBrowser({ quick: true })

    const result = await nativeToolService.nativeBatshitToolUse({
      ref: 'agent_browser:get_title',
      input: {},
      abortSignal: { aborted: false },
      userId: 'josh',
      allowedFamilies: ['agent_browser'],
      runtimeMode: 'mode3',
      actorType: 'in-process',
      agentBrowserSettings: { liveViewEnabled: false }
    } as any)

    expect(result).toMatchObject({ success: true, family: 'agent_browser', result: { title: 'Example' } })
  })

  it('a timeout still ends only the CLI call, the same way, with no signal at all (the n8n dispatch)', async () => {
    const dir = await fakeAgentBrowser()
    const started = Date.now()
    const call = useGetTitle({ params: { timeoutMs: 1_000 } })
    const cliPid = await pidFrom(dir, 'cli.pid')
    const daemonPid = await pidFrom(dir, 'daemon.pid')

    const result = await call

    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result).toMatchObject({ success: false, execution: { timedOut: true } })
    expect(result.stopped).toBeUndefined()
    expect(await goneWithin(cliPid, 1_000)).toBe(true)
    expect(isRunning(daemonPid)).toBe(true)
  })
})

/**
 * A Stop reaches a command run through the dispatch (2026-09-18, the sweep's second round).
 *
 * The managed CLI lanes' own `batshit_server_bash_execute`, and n8n Workflow Subagents, run their
 * commands through `/api/native-tools/dispatch`, which passed no Stop: after a Stop such a command
 * ran on to its own time limit. The route now hands the dispatch the Stop of the reply running in
 * the chat, and the dispatch hands it to the command through `nativeBashExecute`'s own path.
 */
describe('a Stop reaches a command run through the dispatch', () => {
  const leftovers: number[] = []

  afterEach(async () => {
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await redis.del(`agent:${DISPATCH_AGENT_ID}`)
  })

  it('ends a bash_execute command and what it started at once, and says it was stopped', async () => {
    const cwd = await freshWorkspace()
    await seedDispatchAgent()
    const stop = new AbortController()
    const call = dispatch('bash_execute', { command: 'sleep 20 & echo $! > bg.pid; sleep 19' }, {
      abortSignal: stop.signal,
      projectPath: cwd
    })
    const pid = Number(await markerText(cwd, 'bg.pid'))
    leftovers.push(pid)

    const stoppedAt = Date.now()
    stop.abort('user')
    const result = await call

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    // A command that ran is the dispatch's data, as a failed one is; its words say it was stopped.
    expect(result).toMatchObject({
      success: true,
      data: {
        success: false,
        stopped: true,
        reason: 'The command was stopped.',
        failureMessage: 'The command was stopped.'
      }
    })
    expect(await goneWithin(pid, 1_000)).toBe(true)
  })

  it('never starts a bash_execute command a Stop reached first', async () => {
    const cwd = await freshWorkspace()
    await seedDispatchAgent()
    const stop = new AbortController()
    stop.abort('user')

    const result = await dispatch('bash_execute', { command: 'echo ran > ran.txt' }, {
      abortSignal: stop.signal,
      projectPath: cwd
    })

    expect(result).toMatchObject({ success: true, data: { success: false, stopped: true } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(existsSync(path.join(cwd, 'ran.txt'))).toBe(false)
  })

  it('runs a command to its end when no reply runs in the chat (no Stop handed over), as before', async () => {
    const cwd = await freshWorkspace()
    await seedDispatchAgent()

    const result = await dispatch('bash_execute', { command: 'echo hello' }, { projectPath: cwd })

    expect(result).toMatchObject({ success: true, data: { success: true, exitCode: 0 } })
    expect(result.data.stopped).toBeUndefined()
  })
})
