import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/services/apiClient', () => ({
  BATSHIT_SERVER_API_URL: 'http://localhost:5600/api/v1'
}))

import { SSEService } from './sse'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  static OPEN = 1
  static CLOSED = 2

  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  readyState = 0
  url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

describe('SSEService connection timers', () => {
  let originalEventSource: typeof globalThis.EventSource

  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as any
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.EventSource = originalEventSource
    vi.restoreAllMocks()
  })

  it('clears pending connection timeout when disconnecting before open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new SSEService('session-1')
    const errors: string[] = []

    service.connect(() => {}).catch((error) => {
      errors.push(error.message)
    })
    service.disconnect()
    await vi.advanceTimersByTimeAsync(5000)

    expect(warnSpy).not.toHaveBeenCalledWith('[SSE] Connection timeout after 5 seconds')
    expect(errors).toEqual([])
  })

  it('ignores stale timeout state after reconnecting to a fresh EventSource', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new SSEService('session-2')

    service.connect(() => {}).catch(() => {})
    service.disconnect()

    const connected = service.connect(() => {})
    const secondEventSource = FakeEventSource.instances[1]
    secondEventSource.readyState = FakeEventSource.OPEN
    secondEventSource.onopen?.()
    await connected

    await vi.advanceTimersByTimeAsync(5000)

    expect(warnSpy).not.toHaveBeenCalledWith('[SSE] Connection timeout after 5 seconds')
    expect(service.isConnected()).toBe(true)
  })

  it('closes the EventSource when the initial connection times out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new SSEService('session-3')

    const connection = service.connect(() => {}).catch((error) => error)
    const eventSource = FakeEventSource.instances[0]

    await vi.advanceTimersByTimeAsync(5000)

    const error = await connection
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('SSE connection timeout')
    expect(eventSource.readyState).toBe(FakeEventSource.CLOSED)
    expect(service.isConnected()).toBe(false)
  })
})
