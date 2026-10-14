import { describe, expect, it } from 'vitest'
import { createPendingSaves } from './pendingSaves'

/** BL-941: the chat bar's send waits for its own mode saves, with a limit (`ChatInput.svelte`). */
describe('createPendingSaves', () => {
  const later = <T,>(ms: number, value: T, fail = false) =>
    new Promise<T>((resolve, reject) => setTimeout(() => (fail ? reject(new Error('refused')) : resolve(value)), ms))

  it('answers at once with nothing tracked', async () => {
    const saves = createPendingSaves()
    expect(await saves.settled(10)).toBe(true)
    expect(saves.generation).toBe(0)
  })

  it('waits for every tracked save, a refused one included, and forgets them after', async () => {
    const saves = createPendingSaves()
    const refused = saves.track(later(20, 'a', true))
    refused.catch(() => {})
    saves.track(later(40, 'b'))
    expect(saves.size).toBe(2)
    expect(saves.generation).toBe(2)
    expect(await saves.settled(1_000)).toBe(true)
    expect(saves.size).toBe(0)
  })

  it('a save tracked while it waits is waited for too', async () => {
    const saves = createPendingSaves()
    saves.track(later(20, 'a'))
    setTimeout(() => saves.track(later(30, 'b')), 10)
    const started = Date.now()
    expect(await saves.settled(1_000)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })

  it('a save that never answers: the wait gives up at its limit and says so', async () => {
    const saves = createPendingSaves()
    saves.track(new Promise(() => {}))
    const started = Date.now()
    expect(await saves.settled(60)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
    expect(saves.size).toBe(1)
  })

  it('answers the same promise it tracks', async () => {
    const saves = createPendingSaves()
    const save = later(5, 'value')
    expect(saves.track(save)).toBe(save)
    expect(await save).toBe('value')
  })
})
