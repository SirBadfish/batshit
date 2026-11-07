// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => ({ building: false, armPlan: vi.fn(), armVoice: vi.fn() }))
vi.mock('$app/env', () => ({
  get building() { return observed.building },
  dev: false,
  version: 'test'
}))
vi.mock('$lib/server/services/claudePlanRunRegistry', () => ({ armClaudePlanRunLifecycle: observed.armPlan }))
vi.mock('$lib/server/services/voiceEngineRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('$lib/server/services/voiceEngineRegistry')>(),
  registerDockerVoiceEngineShutdown: observed.armVoice
}))

const flags = ['__batshitRuntimeShutdownRegistered', '__batshitRuntimeSigtermRegistered'] as const
let previous: Array<PropertyDescriptor | undefined>
let on: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  observed.armPlan.mockReset()
  observed.armVoice.mockReset()
  previous = flags.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  for (const key of flags) delete (globalThis as Record<string, unknown>)[key]
  const originalOn = process.on
  on = vi.spyOn(process, 'on').mockImplementation(((event: string | symbol, listener: (...args: any[]) => void) => {
    // Do not install test-owned shutdown listeners on the Vitest process.
    if (event === 'SIGTERM' || event === 'sveltekit:shutdown') return process
    return Reflect.apply(originalOn, process, [event, listener])
  }) as typeof process.on)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [index, key] of flags.entries()) {
    const descriptor = previous[index]
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  vi.resetModules()
})

describe('server hook module lifecycle admission', () => {
  it('does not arm runtime cleanup or shutdown during build analysis or prerendering', async () => {
    observed.building = true
    await import('./hooks.server')
    expect(observed.armPlan).not.toHaveBeenCalled()
    expect(observed.armVoice).not.toHaveBeenCalled()
    expect(on.mock.calls.filter(([event]) => event === 'SIGTERM' || event === 'sveltekit:shutdown')).toEqual([])
  }, 20_000)

  it('arms runtime cleanup and shutdown at server module load before a request', async () => {
    observed.building = false
    await import('./hooks.server')
    expect(observed.armPlan).toHaveBeenCalledOnce()
    expect(observed.armVoice).toHaveBeenCalledOnce()
    const events = on.mock.calls.map(([event]) => event)
    expect(events).toContain('SIGTERM')
    expect(events).toContain('sveltekit:shutdown')
  }, 20_000)
})
