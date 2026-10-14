import { describe, expect, it } from 'vitest'
import { isArtifactWriteLockBusy, withArtifactWriteLock } from './artifactWriteLock'

// BL-547: writes to one artifact take turns; different artifacts never wait on each other.

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('withArtifactWriteLock', () => {
  it('runs writers of one artifact one at a time, in arrival order', async () => {
    const order: string[] = []
    const firstMayFinish = deferred()

    const first = withArtifactWriteLock('artifact_a', async () => {
      order.push('first start')
      await firstMayFinish.promise
      order.push('first end')
    })
    const second = withArtifactWriteLock('artifact_a', async () => {
      order.push('second start')
      order.push('second end')
    })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(order).toEqual(['first start'])
    expect(isArtifactWriteLockBusy('artifact_a')).toBe(true)

    firstMayFinish.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first start', 'first end', 'second start', 'second end'])
    expect(isArtifactWriteLockBusy('artifact_a')).toBe(false)
  })

  it('never makes a writer of another artifact wait', async () => {
    const holdA = deferred()
    const a = withArtifactWriteLock('artifact_a', () => holdA.promise)
    const b = await withArtifactWriteLock('artifact_b', async () => 'b ran')
    expect(b).toBe('b ran')
    holdA.resolve()
    await a
  })

  it('lets a writer that holds the lock take it again (applyPatch calls update)', async () => {
    const answer = await withArtifactWriteLock('artifact_a', () =>
      withArtifactWriteLock('artifact_a', async () => 'nested ran')
    )
    expect(answer).toBe('nested ran')
    expect(isArtifactWriteLockBusy('artifact_a')).toBe(false)
  })

  it('keeps the queue moving after a writer throws', async () => {
    const failed = withArtifactWriteLock('artifact_a', async () => {
      throw new Error('refused')
    })
    const next = withArtifactWriteLock('artifact_a', async () => 'next ran')
    await expect(failed).rejects.toThrow('refused')
    await expect(next).resolves.toBe('next ran')
    expect(isArtifactWriteLockBusy('artifact_a')).toBe(false)
  })
})
