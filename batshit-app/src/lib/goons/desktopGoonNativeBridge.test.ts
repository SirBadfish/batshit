import { describe, expect, it, vi } from 'vitest'
import {
  adaptDesktopGoonStatePort,
  DESKTOP_GOON_SHELL_SCHEMA_VERSION,
  type DesktopGoonStatePortFacade
} from '$lib/goons/desktopGoonNativeBridge'

function facade() {
  let message: ((value: unknown) => void) | null = null
  let close: ((event: { generation: number; reason: string }) => void) | null = null
  const value: DesktopGoonStatePortFacade = {
    generation: 3,
    metadata: {
      schemaVersion: DESKTOP_GOON_SHELL_SCHEMA_VERSION,
      generation: 3,
      role: 'desktop'
    },
    postMessage: vi.fn(),
    onMessage(listener) {
      message = listener
      return () => {
        message = null
      }
    },
    onClose(listener) {
      close = listener
      return () => {
        close = null
      }
    },
    close: vi.fn()
  }
  return {
    value,
    emitMessage: (payload: unknown) => message?.(payload),
    emitClose: (reason: string) => close?.({ generation: 3, reason })
  }
}

describe('Desktop Goon native state-port adapter', () => {
  it('keeps the raw port out of app code while adapting messages', () => {
    const source = facade()
    const port = adaptDesktopGoonStatePort(source.value)
    const messages = vi.fn()
    port.addEventListener('message', messages)
    source.emitMessage({ hello: 'Goon' })
    expect(messages).toHaveBeenCalledWith({ data: { hello: 'Goon' } })

    port.postMessage({ reply: true })
    expect(source.value.postMessage).toHaveBeenCalledWith({ reply: true })
  })

  it('turns an unexpected preload close into a visible port error and closes once', () => {
    const source = facade()
    const port = adaptDesktopGoonStatePort(source.value)
    const errors = vi.fn()
    port.addEventListener('messageerror', errors)
    source.emitClose('invalid-message')
    expect(errors).toHaveBeenCalledWith({
      data: { generation: 3, reason: 'invalid-message' }
    })
    expect(() => port.postMessage({ late: true })).toThrow(/closed/i)

    port.close()
    expect(source.value.close).not.toHaveBeenCalled()
  })

  it('does not report controller-driven close ordering as a transport failure', () => {
    const source = facade()
    const port = adaptDesktopGoonStatePort(source.value)
    const errors = vi.fn()
    port.addEventListener('messageerror', errors)

    source.emitClose('desktop-button')

    expect(errors).not.toHaveBeenCalled()
    expect(() => port.postMessage({ late: true })).toThrow(/closed/i)
  })

  it('detaches and closes the facade on deliberate cleanup', () => {
    const source = facade()
    const port = adaptDesktopGoonStatePort(source.value)
    port.close()
    expect(source.value.close).toHaveBeenCalledOnce()
  })
})
