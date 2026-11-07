import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { holdAgentProfileFolder, withAgentProfileFolder } from '../agentProfileFolderGate'
import {
  assertProfileFolderPreparation,
  captureProfileFolderPreparation,
  ProfileFolderChangedError,
  releaseProfileFolderPreparation
} from '../agentProfileFolderQueue'

/**
 * BL-745 / BL-753 — the folder gate's turns, as the deletes use them. SA-139 R5 removed every
 * profile writer (its publications and run-start writes went with this file's old cases), so
 * what stays is the delete's hold: folder work queued during it waits until the delete's steps
 * are done (the record is gone), the delete's own folder removal inside it runs at once, and the
 * hold makes any earlier preparation of the folder stale. Generic saves no longer use the folder.
 */

let runtimeRoot: string, previousRuntimeRoot: string | undefined

beforeEach(async () => {
  previousRuntimeRoot = process.env.BATSHIT_AGENT_RUNTIME_ROOT
  runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'batshit-folder-gate-')))
  process.env.BATSHIT_AGENT_RUNTIME_ROOT = runtimeRoot
})
afterEach(async () => {
  if (previousRuntimeRoot === undefined) delete process.env.BATSHIT_AGENT_RUNTIME_ROOT
  else process.env.BATSHIT_AGENT_RUNTIME_ROOT = previousRuntimeRoot
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe("a delete's hold on a managed profile folder", () => {
  it('runs folder work queued during the hold only after every step of the delete', async () => {
    let finishDelete!: () => void
    const deleteMayFinish = new Promise<void>((resolve) => { finishDelete = resolve })
    let deleting!: () => void
    const deleteStarted = new Promise<void>((resolve) => { deleting = resolve })
    const events: string[] = []
    const deletion = holdAgentProfileFolder('batshit_agent_one', async () => {
      events.push('delete starts')
      deleting()
      await deleteMayFinish
      events.push('record removed')
    })
    await deleteStarted
    const queued = withAgentProfileFolder('batshit_agent_one', async () => { events.push('queued folder work') })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual(['delete starts'])
    finishDelete()
    await Promise.all([deletion, queued])
    expect(events).toEqual(['delete starts', 'record removed', 'queued folder work'])
  })

  it("runs the delete's own folder removal inside the hold at once, and holds no other folder", async () => {
    const events: string[] = []
    await holdAgentProfileFolder('batshit_agent_one', async () => {
      await withAgentProfileFolder('batshit_agent_one', async () => { events.push('folder removed inside the hold') })
      await withAgentProfileFolder('batshit_agent_two', async () => { events.push('another folder is not held') })
      events.push('record removed')
    })
    expect(events).toEqual(['folder removed inside the hold', 'another folder is not held', 'record removed'])
  })

  it('makes a preparation of the folder captured before the hold stale, and leaves an ordinary turn alone', async () => {
    const beforeTurn = captureProfileFolderPreparation('batshit_agent_one')
    const beforeHold = captureProfileFolderPreparation('batshit_agent_one')
    const otherFolder = captureProfileFolderPreparation('batshit_agent_two')
    try {
      await withAgentProfileFolder('batshit_agent_one', async () => 'an ordinary folder turn')
      expect(() => assertProfileFolderPreparation(beforeTurn)).not.toThrow()
      await holdAgentProfileFolder('batshit_agent_one', async () => 'the delete')
      expect(() => assertProfileFolderPreparation(beforeHold)).toThrow(ProfileFolderChangedError)
      expect(() => assertProfileFolderPreparation(otherFolder)).not.toThrow()
    } finally {
      for (const preparation of [beforeTurn, beforeHold, otherFolder]) releaseProfileFolderPreparation(preparation)
    }
  })
})
