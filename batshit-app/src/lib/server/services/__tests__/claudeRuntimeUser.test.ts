import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveClaudeRuntimeUid } from '../claudeRuntimeUser'

const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
afterEach(() => {
  vi.restoreAllMocks()
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid)
  else Reflect.deleteProperty(process, 'getuid')
})

describe('runtime UID resolution', () => {
  it('uses an explicit run-as UID without consulting the current process', () => {
    const getuid = vi.fn(() => { throw new Error('Unexpected current UID lookup') })
    Object.defineProperty(process, 'getuid', { configurable: true, value: getuid })
    expect(resolveClaudeRuntimeUid({ BATSHIT_CLAUDE_RUN_AS_UID: '701' })).toBe(701)
    expect(getuid).not.toHaveBeenCalled()
  })

  it('calls the captured UID function without passing the process object', () => {
    const getuid = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBeUndefined()
      expect(args).toEqual([])
      return 501
    })
    Object.defineProperty(process, 'getuid', { configurable: true, value: getuid })
    expect(resolveClaudeRuntimeUid({})).toBe(501)
    expect(getuid).toHaveBeenCalledOnce()
  })

  it('keeps absent UID support distinct from a failed UID lookup', () => {
    Object.defineProperty(process, 'getuid', { configurable: true, value: undefined })
    expect(resolveClaudeRuntimeUid({})).toBeNull()
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => { throw new Error('UID lookup failed') } })
    expect(() => resolveClaudeRuntimeUid({})).toThrow('UID lookup failed')
  })
})
