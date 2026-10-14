import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCliProcess } from '../cliToolRegistry'
import { getCommandModelCapture } from '../commandModelCapture'

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

describe('saved CLI output drain fallback', () => {
  it.skipIf(process.platform === 'win32')('does not claim lost output when both pipes ended but child close is delayed', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'batshit-cli-ended-pipes-'))
    const ready = path.join(folder, 'pid')
    const script = `
      const fs = require('node:fs')
      process.stdout.end('complete-out')
      process.stderr.end('complete-err')
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid))
      setTimeout(() => process.exit(0), 4000)
    `
    const controller = new AbortController()
    const actualKill = process.kill.bind(process)
    let childPid: number | null = null
    let killSpy: ReturnType<typeof vi.spyOn> | null = null
    try {
      const pending = runCliProcess({
        executable: process.execPath, args: ['-e', script], env: {},
        timeoutMs: 5_000, abortSignal: controller.signal
      })
      await waitForFile(ready)
      childPid = Number(await readFile(ready, 'utf8'))
      // Let both EOF events reach Batshit's pipe readers while the child remains alive.
      await new Promise((resolve) => setTimeout(resolve, 200))
      killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -childPid && (signal === 'SIGTERM' || signal === 'SIGKILL')) return true
        return actualKill(pid, signal)
      })
      controller.abort()
      const result = await pending // the still-running child deliberately withholds `close`

      expect(result.stopped).toBe(true)
      expect(result.stderr).toContain('The command was stopped.')
      expect(result.stderr).not.toContain('capture incomplete')
      expect(getCommandModelCapture(result)?.text).toContain('outputIncomplete=false')
      expect(getCommandModelCapture(result)?.text).toContain('stderr:\ncomplete-err\nstdout:\ncomplete-out')
    } finally {
      killSpy?.mockRestore()
      if (childPid && Number.isSafeInteger(childPid)) {
        try { actualKill(-childPid, 'SIGKILL') } catch { /* child already exited */ }
      }
      await rm(folder, { recursive: true, force: true })
    }
  })
})
