import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

const originalClipboard = navigator.clipboard
const originalExecCommand = document.execCommand

function setClipboard(value: Clipboard | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value
  })
}

function setExecCommand(fn: ((commandId: string) => boolean) | undefined) {
  if (!fn) {
    delete (document as typeof document & { execCommand?: unknown }).execCommand
    return
  }

  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: fn
  })
}

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    setClipboard(originalClipboard)
    setExecCommand(originalExecCommand)
  })

  it('uses navigator clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const execCommand = vi.fn().mockReturnValue(true)
    setClipboard({ writeText } as unknown as Clipboard)
    setExecCommand(execCommand)

    await copyTextToClipboard('hello')

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to textarea copy when navigator clipboard is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Denied'))
    const execCommand = vi.fn().mockReturnValue(true)
    setClipboard({ writeText } as unknown as Clipboard)
    setExecCommand(execCommand)

    await expect(copyTextToClipboard('mac app copy')).resolves.toBeUndefined()

    expect(writeText).toHaveBeenCalledWith('mac app copy')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})
