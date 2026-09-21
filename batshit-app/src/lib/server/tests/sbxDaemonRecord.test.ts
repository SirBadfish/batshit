import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recordSbxDaemonStart, sbxCallStartedDaemon } from '../services/sbxDaemonRecord'

// BL-61 (2026-09-21): the record that lets quitting stop the sbx daemon Batshit's own call started.
// Twin of `batshit-mac/scripts/sbx-daemon-stop.mjs`, whose tests stop a real daemon from it.
describe('the sbx daemon record', () => {
  let root = ''
  const saved: Record<string, string | undefined> = {}
  const keys = ['BATSHIT_SBX_DAEMON_STATE_DIR', 'BATSHIT_VOICE_RUNTIME_OWNER', 'PATH']

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'batshit-sbx-daemon-record-'))
    for (const key of keys) saved[key] = process.env[key]
  })

  afterEach(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await rm(root, { recursive: true, force: true })
  })

  it('counts only sbx saying so first, never a sandboxed command printing the same words', () => {
    expect(sbxCallStartedDaemon('Starting sandboxd daemon...\n', '{"sandboxes":[]}')).toBe(true)
    expect(sbxCallStartedDaemon('', 'Starting sandboxd daemon...\r\n{}')).toBe(true)
    expect(sbxCallStartedDaemon('warn\nStarting sandboxd daemon...\n', 'out\n')).toBe(false)
    expect(sbxCallStartedDaemon('', '{"sandboxes":[]}')).toBe(false)
  })

  it('records which Batshit started it, the call window, and the sbx PATH found, as PATH names it', async () => {
    const bin = path.join(root, 'bin')
    await mkdir(bin)
    await writeFile(path.join(bin, 'sbx'), '#!/bin/sh\nexit 0\n')
    await chmod(path.join(bin, 'sbx'), 0o755)
    process.env.PATH = `${path.join(root, 'nothing-here')}${path.delimiter}${bin}`
    process.env.BATSHIT_SBX_DAEMON_STATE_DIR = path.join(root, 'state')
    process.env.BATSHIT_VOICE_RUNTIME_OWNER = 'native:4242:1758459739000'

    await recordSbxDaemonStart(Date.parse('2026-09-21T13:02:19.600Z'), Date.parse('2026-09-21T13:02:20.950Z'))

    expect(JSON.parse(await readFile(path.join(root, 'state', '.batshit-sbx-daemon-launch.json'), 'utf8'))).toEqual({
      launchedBy: 'native:4242:1758459739000',
      callStartedAt: '2026-09-21T13:02:19.600Z',
      callEndedAt: '2026-09-21T13:02:20.950Z',
      sbxPath: path.join(bin, 'sbx')
    })
  })
})
