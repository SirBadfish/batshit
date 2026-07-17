import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeRegisteredRuntimeResources,
  registerRuntimeShutdownTask,
  resetRuntimeShutdownTasksForTests
} from '../runtimeShutdown'

describe('runtime shutdown coordinator', () => {
  beforeEach(() => resetRuntimeShutdownTasksForTests())

  it('starts every registered cleanup and waits for completion', async () => {
    const events: string[] = []
    let release!: () => void
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })
    registerRuntimeShutdownTask('sse', async (reason) => {
      events.push(`sse:start:${reason}`)
      await delayed
      events.push('sse:done')
    })
    registerRuntimeShutdownTask('other', async () => {
      events.push('other:done')
    })

    const closing = closeRegisteredRuntimeResources('SIGTERM')
    await vi.waitFor(() => expect(events).toContain('other:done'))
    expect(events).toContain('sse:start:SIGTERM')
    release()
    await closing
    expect(events).toContain('sse:done')
  })

  it('reports task failures after the other cleanups finish', async () => {
    const completed = vi.fn()
    registerRuntimeShutdownTask('broken', async () => {
      throw new Error('boom')
    })
    registerRuntimeShutdownTask('healthy', async () => completed())

    await expect(closeRegisteredRuntimeResources('test')).rejects.toThrow(
      'Runtime shutdown failed during test'
    )
    expect(completed).toHaveBeenCalledOnce()
  })
})
