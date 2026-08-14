import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ShutdownEvent = Readonly<{
  schemaVersion: 'app-lifecycle/v1'
  type: 'shutdown-started'
  reason: 'app-quit' | 'window-close'
}>

type LifecycleListener = (event: ShutdownEvent) => void

function setLifecycleBridge(bridge: {
  isShuttingDown(): boolean
  onShutdown(listener: LifecycleListener): () => void
}) {
  Object.defineProperty(window, 'zero', {
    configurable: true,
    value: { lifecycle: bridge }
  })
}

describe('intentional Electron shutdown lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    Reflect.deleteProperty(window, 'zero')
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'zero')
  })

  it('keeps genuine browser/runtime failures visible without a trusted Electron signal', async () => {
    const { isIntentionalAppShutdown, runUnlessExpectedIntentionalShutdownNotification } = await import(
      './appLifecycle.client'
    )
    const emit = vi.fn(() => 'visible-toast')

    expect(isIntentionalAppShutdown()).toBe(false)
    expect(
      runUnlessExpectedIntentionalShutdownNotification(
        'Sessions failed to load',
        emit,
        'suppressed-toast'
      )
    ).toBe('visible-toast')
    expect(emit).toHaveBeenCalledOnce()
  })

  it('suppresses known teardown notification noise after the preload bridge reports shutdown', async () => {
    setLifecycleBridge({
      isShuttingDown: () => true,
      onShutdown: () => () => {}
    })
    const { isIntentionalAppShutdown, runUnlessExpectedIntentionalShutdownNotification } = await import(
      './appLifecycle.client'
    )
    const emit = vi.fn(() => 'visible-toast')

    expect(isIntentionalAppShutdown()).toBe(true)
    expect(
      runUnlessExpectedIntentionalShutdownNotification(
        'Sessions failed to load',
        emit,
        'suppressed-toast'
      )
    ).toBe('suppressed-toast')
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not turn intentional shutdown into a broad error fallback', async () => {
    setLifecycleBridge({
      isShuttingDown: () => true,
      onShutdown: () => () => {}
    })
    const { runUnlessExpectedIntentionalShutdownNotification } = await import(
      './appLifecycle.client'
    )
    const emit = vi.fn(() => 'visible-toast')

    expect(
      runUnlessExpectedIntentionalShutdownNotification(
        'Voice preview failed',
        emit,
        'suppressed-toast'
      )
    ).toBe('visible-toast')
    expect(emit).toHaveBeenCalledOnce()
  })

  it('delivers the trusted shutdown transition once and unsubscribes cleanly', async () => {
    let shutdownListener: LifecycleListener | null = null
    const unsubscribe = vi.fn()
    setLifecycleBridge({
      isShuttingDown: () => false,
      onShutdown(listener) {
        shutdownListener = listener
        return unsubscribe
      }
    })
    const { isIntentionalAppShutdown, onIntentionalAppShutdown } = await import(
      './appLifecycle.client'
    )
    const listener = vi.fn()
    const stop = onIntentionalAppShutdown(listener)
    const event: ShutdownEvent = {
      schemaVersion: 'app-lifecycle/v1',
      type: 'shutdown-started',
      reason: 'window-close'
    }

    expect(shutdownListener).not.toBeNull()
    shutdownListener?.(event)
    shutdownListener?.(event)

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(event)
    expect(isIntentionalAppShutdown()).toBe(true)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
