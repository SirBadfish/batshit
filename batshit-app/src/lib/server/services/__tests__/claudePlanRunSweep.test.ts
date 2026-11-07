// @vitest-environment node
/**
 * SA-139 P2: the boot sweep of stale `/tmp/bcp-*` Claude plan run folders. Every folder lives under a
 * temp root, and process liveness, command lookup and the kill are injected, so no real process is
 * ever inspected or signalled.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { sweepStaleClaudePlanRunFolders } from '../claudePlanRun'

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sa139-sweep-'))
  roots.push(root)
  return root
}

/** A run folder under `root`; `owner` and `claude` are the pids written into owner.json and claude.json (omit to leave the file out). */
function runFolder(root: string, name: string, files: { owner?: number; claude?: number } = {}): string {
  const folder = path.join(root, name)
  mkdirSync(folder)
  if (files.owner !== undefined) writeFileSync(path.join(folder, 'owner.json'), JSON.stringify({ ownerPid: files.owner }))
  if (files.claude !== undefined) writeFileSync(path.join(folder, 'claude.json'), JSON.stringify({ pid: files.claude }))
  return folder
}

const OWNER = 910001
const CLAUDE = 910002

/** Injected process facts: which pids are alive and what command each runs. */
function world(alive: number[], commands: Record<number, string> = {}) {
  return {
    isAlive: vi.fn((pid: number) => alive.includes(pid)),
    commandOf: vi.fn((pid: number) => commands[pid] ?? null),
    kill: vi.fn((_pid: number) => {})
  }
}

describe('sweepStaleClaudePlanRunFolders', () => {
  it('keeps a folder whose owner is alive and signals nothing', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { owner: OWNER, claude: CLAUDE })
    const injected = world([OWNER, CLAUDE], { [CLAUDE]: `claude --settings ${folder}/settings.json` })
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [], killed: [], kept: [folder] })
    expect(injected.kill).not.toHaveBeenCalled()
    expect(existsSync(folder)).toBe(true)
  })

  it('kills a live Claude Code that still runs this folder when the owner is dead, and removes the folder', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { owner: OWNER, claude: CLAUDE })
    const injected = world([CLAUDE], { [CLAUDE]: `/usr/local/bin/claude --settings ${folder}/settings.json` })
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [folder], killed: [CLAUDE], kept: [] })
    expect(injected.kill).toHaveBeenCalledTimes(1)
    expect(injected.kill).toHaveBeenCalledWith(CLAUDE)
    expect(existsSync(folder)).toBe(false)
  })

  it('never signals a live pid whose command does not name the folder (a reused pid), and still removes the folder', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { owner: OWNER, claude: CLAUDE })
    const injected = world([CLAUDE], { [CLAUDE]: `/usr/bin/some-stranger --flag ${path.join(root, 'bcp-bbbbbb')}/x` })
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [folder], killed: [], kept: [] })
    expect(injected.kill).not.toHaveBeenCalled()
    expect(existsSync(folder)).toBe(false)
  })

  it('never signals a live pid whose command cannot be read', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { owner: OWNER, claude: CLAUDE })
    const injected = world([CLAUDE])
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [folder], killed: [], kept: [] })
    expect(injected.kill).not.toHaveBeenCalled()
  })

  it('removes the folder without a kill when the owner and the Claude Code pid are both dead', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { owner: OWNER, claude: CLAUDE })
    const injected = world([], { [CLAUDE]: `claude ${folder}` })
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [folder], killed: [], kept: [] })
    expect(injected.kill).not.toHaveBeenCalled()
    expect(existsSync(folder)).toBe(false)
  })

  it('removes the folder when the owner is dead and no claude.json was written', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { owner: OWNER })
    const injected = world([])
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [folder], killed: [], kept: [] })
    expect(injected.kill).not.toHaveBeenCalled()
  })

  it('keeps a folder with no owner.json', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { claude: CLAUDE })
    const injected = world([CLAUDE], { [CLAUDE]: `claude ${folder}` })
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [], killed: [], kept: [folder] })
    expect(injected.kill).not.toHaveBeenCalled()
    expect(existsSync(folder)).toBe(true)
  })

  it('keeps a folder whose owner.json names this process, even if the injected check says dead', async () => {
    const root = tempRoot()
    const folder = runFolder(root, 'bcp-aaaaaa', { owner: process.pid, claude: CLAUDE })
    const injected = world([CLAUDE], { [CLAUDE]: `claude ${folder}` })
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [], killed: [], kept: [folder] })
    expect(injected.kill).not.toHaveBeenCalled()
    expect(existsSync(folder)).toBe(true)
  })

  it('ignores a folder whose name is not bcp- plus exactly six letters or digits', async () => {
    const root = tempRoot()
    const odd = ['bcp-toolongname', 'bcp-short', 'other', 'bcp-aaaaa-', 'xbcp-aaaaaa', 'bcp-aaaaaaa'].map(name => runFolder(root, name, { owner: OWNER }))
    const real = runFolder(root, 'bcp-Ab3Xy9', { owner: OWNER })
    const injected = world([])
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome).toEqual({ removed: [real], killed: [], kept: [] })
    for (const folder of odd) expect(existsSync(folder), folder).toBe(true)
    expect(existsSync(real)).toBe(false)
  })

  it('sweeps several folders independently', async () => {
    const root = tempRoot()
    const mine = runFolder(root, 'bcp-aaaaaa', { owner: OWNER, claude: CLAUDE })
    const other = runFolder(root, 'bcp-bbbbbb', { owner: OWNER + 10 })
    const injected = world([OWNER + 10], { [CLAUDE]: `claude ${mine}` })
    injected.isAlive.mockImplementation((pid: number) => pid === OWNER + 10 || pid === CLAUDE)
    const outcome = await sweepStaleClaudePlanRunFolders({ root, ...injected })
    expect(outcome.removed).toEqual([mine])
    expect(outcome.killed).toEqual([CLAUDE])
    expect(outcome.kept).toEqual([other])
  })

  it('answers empty for a root that does not exist', async () => {
    const injected = world([])
    const outcome = await sweepStaleClaudePlanRunFolders({ root: path.join(tempRoot(), 'missing'), ...injected })
    expect(outcome).toEqual({ removed: [], killed: [], kept: [] })
    expect(injected.kill).not.toHaveBeenCalled()
  })
})
