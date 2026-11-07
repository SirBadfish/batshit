import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cancelQueuedProjectSave,
  dropProjectLane,
  flushQueuedProjectSaves,
  latestProjectDraft,
  latestProjectRevision,
  onProjectSaved,
  PROJECT_SAVES_READ_WAIT_MS,
  projectAnswerSeq,
  projectAnswersSince,
  publishProjectSaved,
  queueProjectSave,
  resetProjectAutosaveForTests,
  saveProjectNow,
  waitForProjectSaves
} from './projectAutosave'
import { applySavedAnswersSince } from '$lib/projects/projectSaveAnswers'

type Form = { id: string; name: string }

/** A save function whose calls can be answered one by one. */
function controlledSave() {
  const calls: Array<{ form: Form; resolve: () => void; reject: (error: Error) => void }> = []
  const run = vi.fn(
    (form: Form) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ form, resolve, reject })
      })
  )
  return { run, calls }
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  resetProjectAutosaveForTests()
  vi.useRealTimers()
})

describe('projectAutosave: one ordered lane per project (BL-2384)', () => {
  it('coalesces typing into the latest copy after the delay', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    queueProjectSave('a', { id: 'a', name: 'A12' }, 'A12', run)
    await vi.advanceTimersByTimeAsync(599)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A12'])
  })

  it('runs writes of one project one after another, and different projects side by side', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    queueProjectSave('b', { id: 'b', name: 'B1' }, 'B1', run)
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A1', 'B1'])

    queueProjectSave('a', { id: 'a', name: 'A2' }, 'A2', run)
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A1', 'B1'])

    calls[0].resolve()
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A1', 'B1', 'A2'])
  })

  it('a copy equal to the one waiting or on its way sends nothing again', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    await vi.advanceTimersByTimeAsync(600)
    calls[0].resolve()
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('shows the newest unconfirmed copy, and forgets it once answered', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    expect(latestProjectDraft<Form>('a')?.name).toBe('A1')
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    expect(latestProjectDraft<Form>('a')?.name).toBe('A1')
    calls[0].resolve()
    await settle()
    expect(latestProjectDraft('a')).toBeNull()
  })

  it('a failed write is not retried by itself', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    calls[0].reject(new Error('down'))
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(latestProjectDraft('a')).toBeNull()
  })

  it('cancel drops the waiting copy and returns it with its revision', async () => {
    const { run } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    const revision = latestProjectRevision('a')
    expect(cancelQueuedProjectSave<Form>('a')).toEqual({ form: { id: 'a', name: 'A1' }, revision })
    await vi.advanceTimersByTimeAsync(600)
    expect(run).not.toHaveBeenCalled()
    expect(latestProjectRevision('a')).toBe(0)

    // A newer copy queued after the cancel has a higher revision than the cancelled one.
    queueProjectSave('a', { id: 'a', name: 'A2' }, 'A2', run)
    expect(latestProjectRevision('a')).toBeGreaterThan(revision)
  })

  // Review round 4 (d): an editor's Save behind an autosave already on its way.
  it('an explicit Save waits behind a write on its way and replaces a waiting copy', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    queueProjectSave('a', { id: 'a', name: 'A2' }, 'A2', run)

    const explicit = saveProjectNow('a', { id: 'a', name: 'A2 + rules' }, 'A2 + rules', run)
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A1'])

    calls[0].resolve()
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A1', 'A2 + rules'])
    calls[1].resolve()
    await expect(explicit).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(600)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('an explicit Save rejects with its own error', async () => {
    const { run, calls } = controlledSave()
    const explicit = saveProjectNow('a', { id: 'a', name: 'A1' }, 'A1', run)
    await settle()
    calls[0].reject(new Error('Fixture write unavailable'))
    await expect(explicit).rejects.toThrow('Fixture write unavailable')
  })

  it('a closing panel sends every waiting copy at once', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    queueProjectSave('b', { id: 'b', name: 'B1' }, 'B1', run)
    flushQueuedProjectSaves()
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A1', 'B1'])
  })

  // Review round 4 (1): a write that never answers must not hold a reopened panel.
  it('waiting for earlier writes is bounded', async () => {
    const { run, calls } = controlledSave()
    expect(await waitForProjectSaves()).toBe(true)

    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    flushQueuedProjectSaves()
    await settle()
    let answered: boolean | undefined
    void waitForProjectSaves().then((value) => { answered = value })
    await vi.advanceTimersByTimeAsync(PROJECT_SAVES_READ_WAIT_MS - 1)
    expect(answered).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(answered).toBe(false)

    let settledInTime: boolean | undefined
    void waitForProjectSaves().then((value) => { settledInTime = value })
    calls[0].resolve()
    await settle()
    expect(settledInTime).toBe(true)
  })

  // Round 5: answers reach whichever panel is mounted, and a list reader can catch up.
  it('publishes each saved answer to every listener and keeps it for a list read that began earlier', () => {
    const heard: string[] = []
    const stop = onProjectSaved<{ name: string }, Form>((answer) => heard.push(answer.project.name))
    const before = projectAnswerSeq()
    publishProjectSaved('a', { name: 'A saved' }, { id: 'a', name: 'A1' })
    stop()
    publishProjectSaved('a', { name: 'A saved again' }, { id: 'a', name: 'A2' })
    expect(heard).toEqual(['A saved'])
    expect(projectAnswersSince<{ name: string }, Form>(before).map((answer) => answer.project.name)).toEqual([
      'A saved',
      'A saved again'
    ])
  })

  it('a dropped lane sends neither its waiting copy nor copies still waiting behind a write', async () => {
    const { run, calls } = controlledSave()
    queueProjectSave('a', { id: 'a', name: 'A1' }, 'A1', run)
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    void saveProjectNow('a', { id: 'a', name: 'A2' }, 'A2', run)
    queueProjectSave('a', { id: 'a', name: 'A3' }, 'A3', run)
    dropProjectLane('a')
    calls[0].resolve()
    await settle()
    await vi.advanceTimersByTimeAsync(600)
    await settle()
    expect(calls.map((call) => call.form.name)).toEqual(['A1'])
  })
})

describe('applySavedAnswersSince (BL-2384 round 6)', () => {
  it('lays an answer over the list only where the list copy is not newer', () => {
    const before = projectAnswerSeq()
    publishProjectSaved('a', { id: 'a', name: 'answer', updated_at: '2026-10-27T12:00:05.000Z' }, { id: 'a', name: 'answer' })
    publishProjectSaved('b', { id: 'b', name: 'answer', updated_at: '2026-10-27T12:00:05.000Z' }, { id: 'b', name: 'answer' })
    const list = [
      { id: 'a', name: 'older list copy', updated_at: '2026-10-27T12:00:00.000Z' },
      { id: 'b', name: 'newer list copy', updated_at: '2026-10-27T12:00:09.000Z' },
      { id: 'c', name: 'untouched' }
    ]
    expect(applySavedAnswersSince(list, before).map((project) => project.name)).toEqual([
      'answer',
      'newer list copy',
      'untouched'
    ])
  })

  it('an unknown stamp on the list copy never blocks the answer', () => {
    const before = projectAnswerSeq()
    publishProjectSaved('a', { id: 'a', name: 'answer', updated_at: '2026-10-27T12:00:05.000Z' }, { id: 'a', name: 'answer' })
    expect(applySavedAnswersSince([{ id: 'a', name: 'never updated' }], before)[0].name).toBe('answer')
  })
})
