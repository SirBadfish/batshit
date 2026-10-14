import { describe, expect, it } from 'vitest'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MAX_CLI_TOOL_OUTPUT_CHARS, runCliProcess } from '../cliToolRegistry'
import { getCommandModelCapture } from '../commandModelCapture'

const cutLine = `[Output cut here by Batshit: the command printed more than 200,000 characters.]`

async function waitForFile(file: string) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      await access(file)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error('CLI child did not become ready')
}

async function printStreams(stdoutChars: number, stderrChars: number) {
  return runCliProcess({
    executable: process.execPath,
    args: [
      '-e',
      `process.stdout.write('x'.repeat(${stdoutChars})); process.stderr.write('y'.repeat(${stderrChars}))`
    ],
    env: {},
    timeoutMs: 10_000
  })
}

describe('saved CLI tool output capture', () => {
  it('preserves both streams exactly at the per-stream limit', async () => {
    const run = await printStreams(MAX_CLI_TOOL_OUTPUT_CHARS, MAX_CLI_TOOL_OUTPUT_CHARS)

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe('x'.repeat(MAX_CLI_TOOL_OUTPUT_CHARS))
    expect(run.stderr).toBe('y'.repeat(MAX_CLI_TOOL_OUTPUT_CHARS))
    expect(run.stdoutCut).toBe(false)
    const capture = getCommandModelCapture(run)
    // BL-679: the end of stderr first (8,000 at most), then stdout, then the earlier stderr.
    const earlier = MAX_CLI_TOOL_OUTPUT_CHARS - 8_000
    expect(capture?.text).toContain(`follow stdout):\n${'y'.repeat(8_000)}\nstdout:\n${'x'.repeat(MAX_CLI_TOOL_OUTPUT_CHARS)}\nstderr (the first ${earlier.toLocaleString('en-US')} characters, before the end shown above):\n${'y'.repeat(earlier)}`)
    expect(capture?.text.endsWith('y'.repeat(earlier))).toBe(true)
    expect(capture?.originalTextChars).toBe(capture?.text.length)
    expect(JSON.stringify(run)).not.toContain('originalTextChars')
  })

  it('marks each cut stream within its own limit and ignores subsequent output', async () => {
    const run = await printStreams(MAX_CLI_TOOL_OUTPUT_CHARS + 1, MAX_CLI_TOOL_OUTPUT_CHARS + 1)

    expect(run.exitCode).toBe(0)
    expect(run.stdoutCut).toBe(true)
    expect(run.stdout.length).toBeLessThanOrEqual(MAX_CLI_TOOL_OUTPUT_CHARS)
    expect(run.stderr.length).toBeLessThanOrEqual(MAX_CLI_TOOL_OUTPUT_CHARS)
    expect(run.stdout.endsWith(cutLine)).toBe(true)
    expect(run.stderr.endsWith(cutLine)).toBe(true)
    const capture = getCommandModelCapture(run)
    const earlier = MAX_CLI_TOOL_OUTPUT_CHARS + 1 - 8_000
    expect(capture?.text).toContain(`follow stdout):\n${'y'.repeat(8_000)}\nstdout:\n${'x'.repeat(MAX_CLI_TOOL_OUTPUT_CHARS + 1)}\nstderr (the first ${earlier.toLocaleString('en-US')} characters, before the end shown above):\n${'y'.repeat(earlier)}`)
    expect(capture?.text).not.toContain(cutLine)
  })

  it('carries actual process failure status and stdout without changing the public result', async () => {
    const run = await runCliProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('before failure'); process.stderr.write('reason'); process.exit(7)"],
      env: {}, timeoutMs: 10_000
    })
    const capture = getCommandModelCapture(run)
    expect(run.exitCode).toBe(7)
    expect(capture?.text).toContain('exitCode=7')
    expect(capture?.text).toContain('exitCode=7      ; signal=none            ; timedOut=false; stopped=false; outputIncomplete=false\nstderr:\nreason\nstdout:\nbefore failure')
    expect(JSON.stringify(run)).not.toContain('status: exitCode=')
  })

  it('keeps private capture on timeout and Stop, including a pre-aborted call', async () => {
    const params = {
      executable: process.execPath,
      args: ['-e', "process.stdout.write('started'); setInterval(() => {}, 1000)"],
      env: {}
    }
    const timedOut = await runCliProcess({ ...params, timeoutMs: 500 })
    expect(timedOut.timedOut).toBe(true)
    expect(getCommandModelCapture(timedOut)?.text).toContain('timedOut=true')

    const controller = new AbortController()
    const stopTimer = setTimeout(() => controller.abort(), 500)
    const stopped = await runCliProcess({ ...params, timeoutMs: 5_000, abortSignal: controller.signal })
    clearTimeout(stopTimer)
    expect(stopped.stopped).toBe(true)
    expect(getCommandModelCapture(stopped)?.text).toContain('stopped=true')

    const preAborted = new AbortController()
    preAborted.abort()
    const neverStarted = await runCliProcess({ ...params, timeoutMs: 5_000, abortSignal: preAborted.signal })
    expect(neverStarted.stopped).toBe(true)
    expect(getCommandModelCapture(neverStarted)?.text).toContain('stopped=true')
  })

  it('drains bytes written by a signal handler before sealing Stop and timeout captures', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'batshit-cli-drain-'))
    const ready = path.join(folder, 'ready')
    const script = `
      const fs = require('node:fs')
      process.on('SIGTERM', () => {
        process.stdout.write('after-signal-out')
        process.stderr.write('after-signal-err')
        setTimeout(() => process.exit(0), 20)
      })
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready')
      setInterval(() => {}, 1_000)
    `
    try {
      const controller = new AbortController()
      const pending = runCliProcess({
        executable: process.execPath, args: ['-e', script], env: {},
        timeoutMs: 5_000, abortSignal: controller.signal
      })
      await waitForFile(ready)
      controller.abort()
      const stopped = await pending
      expect(stopped.stopped).toBe(true)
      expect(stopped.stdout).not.toContain('after-signal-out')
      expect(stopped.stderr).toContain('The command was stopped.')
      expect(getCommandModelCapture(stopped)?.text).toContain('stderr:\nafter-signal-err\nstdout:\nafter-signal-out')
      expect(getCommandModelCapture(stopped)?.text).toContain('outputIncomplete=false')

      const timedOut = await runCliProcess({
        executable: process.execPath, args: ['-e', script], env: {}, timeoutMs: 500
      })
      expect(timedOut.timedOut).toBe(true)
      expect(getCommandModelCapture(timedOut)?.text).toContain('stderr:\nafter-signal-err\nstdout:\nafter-signal-out')
      expect(getCommandModelCapture(timedOut)?.text).toContain('outputIncomplete=false')
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('reports incomplete capture when an outside descendant holds pipes beyond Stop', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'batshit-cli-incomplete-'))
    const ready = path.join(folder, 'holder-pid')
    const script = `
      const fs = require('node:fs')
      const { spawn } = require('node:child_process')
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3000)'], {
        detached: true, stdio: ['ignore', process.stdout, process.stderr]
      })
      holder.unref()
      fs.writeFileSync(${JSON.stringify(ready)}, String(holder.pid))
      setInterval(() => {}, 1_000)
    `
    let holderPid: number | null = null
    try {
      const controller = new AbortController()
      const pending = runCliProcess({
        executable: process.execPath, args: ['-e', script], env: {},
        timeoutMs: 5_000, abortSignal: controller.signal
      })
      await waitForFile(ready)
      holderPid = Number(await readFile(ready, 'utf8'))
      controller.abort()
      const stopped = await pending
      expect(stopped.stopped).toBe(true)
      expect(stopped.stderr).toContain('capture incomplete: pipes did not close')
      expect(getCommandModelCapture(stopped)?.text).toContain('outputIncomplete=true')
      expect(getCommandModelCapture(stopped)?.originalTextChars).toBe(getCommandModelCapture(stopped)?.text.length)
    } finally {
      if (holderPid && Number.isSafeInteger(holderPid)) {
        try { process.kill(holderPid, 'SIGKILL') } catch { /* holder already exited */ }
      }
      await rm(folder, { recursive: true, force: true })
    }
  })
})
