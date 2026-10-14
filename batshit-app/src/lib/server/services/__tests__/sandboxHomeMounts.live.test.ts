/** BL-368: real Apple Container old/new mount proof, using only disposable sentinel files. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  __setAppleContainerBatshitHomeMountRootForTests,
  executeAppleContainerSandboxCommand
} from '../appleContainerSandbox'

const LIVE = process.env.BATSHIT_LIVE_APPLE_CONTAINER === '1'
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

describe.runIf(LIVE)('BL-368 real sandbox mount boundary', () => {
  it('old mounts allow sentinel writes; current mounts hide protected data and allow installer writes', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'batshit-bl368-'))
    const root = await realpath(temp)
    const home = path.join(root, '.batshit')
    const workspace = path.join(root, 'workspace')
    const legacyName = `bl368-old-mounts-${Date.now()}`
    const previousRecordDir = process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR
    process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = path.join(root, 'launch-records')
    __setAppleContainerBatshitHomeMountRootForTests(home)
    const cli = (args: string[]) => execFileSync('container', args, { encoding: 'utf8', timeout: 120_000 })
    try {
      await mkdir(workspace, { recursive: true })
      for (const name of ['runtime', 'pinokio']) {
        await mkdir(path.join(home, name), { recursive: true })
        await writeFile(path.join(home, name, 'sentinel'), 'host-owned')
      }
      const command = ['runtime', 'pinokio'].map((name) =>
        `test ! -e ${quote(path.join(home, name, 'sentinel'))}`
      ).concat(`printf allowed > ${quote(path.join(home, 'installs', 'allowed'))}`).join(' && ')
      const result = await executeAppleContainerSandboxCommand({
        userId: 'bl368-proof', workspaceRoot: workspace, cwd: workspace, command, timeoutMs: 120_000
      })
      expect(result.ok ? result.run.exitCode : result.reason).toBe(0)
      expect(await readFile(path.join(home, 'installs', 'allowed'), 'utf8')).toBe('allowed')
      for (const name of ['runtime', 'pinokio']) {
        expect(await readFile(path.join(home, name, 'sentinel'), 'utf8')).toBe('host-owned')
        const denied = await executeAppleContainerSandboxCommand({
          workspaceRoot: path.join(home, name), cwd: path.join(home, name), command: 'true', timeoutMs: 1000
        })
        expect(denied).toMatchObject({ ok: false, reason: expect.stringMatching(/protected runtime/) })
      }
      // Reproduce the pre-fix mounts, never the user's actual home/data.
      cli(['run', '--rm', '--name', legacyName, '--network', 'batshit-apple-sandbox-internal',
        '--read-only', ...['runtime', 'pinokio'].flatMap((name) => ['--volume', `${path.join(home, name)}:${path.join(home, name)}`]),
        'bash:5.2', 'bash', '-lc', ['runtime', 'pinokio'].map((name) =>
          `printf old-policy-wrote > ${quote(path.join(home, name, 'sentinel'))}`
        ).join(' && ')])
      for (const name of ['runtime', 'pinokio']) {
        expect(await readFile(path.join(home, name, 'sentinel'), 'utf8')).toBe('old-policy-wrote')
      }
    } finally {
      try { cli(['delete', '--force', legacyName]) } catch { /* --rm already removed it */ }
      __setAppleContainerBatshitHomeMountRootForTests(null)
      if (previousRecordDir === undefined) delete process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR
      else process.env.BATSHIT_APPLE_CONTAINER_STATE_DIR = previousRecordDir
      await rm(temp, { recursive: true, force: true })
    }
  }, 240_000)
})
