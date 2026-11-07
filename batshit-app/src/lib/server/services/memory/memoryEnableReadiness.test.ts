import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  state: 'preparation-required' as 'ready' | 'preparing' | 'preparation-required',
  current: false,
  observe: vi.fn(),
  effect: vi.fn(() => { throw new Error('Readiness must not prepare or construct an embedder.') })
}))
vi.mock('./memoryEmbedder', async (importOriginal) => ({
  ...await importOriginal<typeof import('./memoryEmbedder')>(),
  observeBuiltinMemoryReadiness: state.observe,
  createMemoryEmbedder: state.effect,
  createMemoryEmbedderAsync: state.effect,
  ensureBuiltinModelReady: state.effect
}))

import {
  assertMemoryEnableReadiness,
  MemoryEnableReadinessError,
  readMemoryEnableReadiness,
  type MemoryEnableReadinessSnapshot
} from './memoryEnableReadiness'

const SOURCE = `memory-enable-v1:${'a'.repeat(40)}`
const BUILTIN = 'builtin:embeddinggemma-300m'
const clientReply = (reply: unknown) => ({ eval: vi.fn(async () => reply) })

beforeEach(() => {
  vi.clearAllMocks()
  state.state = 'preparation-required'
  state.current = false
  state.observe.mockImplementation(() => ({ state: state.state, isCurrent: () => state.current }))
})

// These tests exercise the reply/observation boundary. Actual fixed-leaf Lua
// admission and source races belong to the owning real-Redis Settings suite.
describe('Memory enable readiness observation', () => {
  it.each(['preset', 'local-ai', 'api'])('reports admitted %s configuration without claiming runtime health', async (lane) => {
    const client = clientReply(['OK', SOURCE, lane, ''])
    const result = await readMemoryEnableReadiness(client)
    expect(result).toEqual({ status: 'configuration-ready', reason: 'embedding-configuration-ready-runtime-unchecked', source: SOURCE })
    expect(() => assertMemoryEnableReadiness(result)).not.toThrow()
    expect(state.observe).not.toHaveBeenCalled()
    expect(state.effect).not.toHaveBeenCalled()
    expect(client.eval).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      keys: ['batshit:memory_config'], arguments: []
    })
  })

  it.each([
    ['preparation-required', 'preparation-required', 'builtin-model-preparation-required'],
    ['preparing', 'preparing', 'builtin-model-preparing'],
    ['ready', 'builtin-ready', 'builtin-model-ready']
  ] as const)('reflects the exact builtin %s observation', async (observed, status, reason) => {
    state.state = observed
    state.current = observed === 'ready'
    const result = await readMemoryEnableReadiness(clientReply(['OK', SOURCE, 'builtin', BUILTIN]))
    expect(result).toEqual({ status, reason, source: SOURCE, builtinModelId: BUILTIN })
    expect(state.observe).toHaveBeenCalledExactlyOnceWith(BUILTIN)
    expect(state.effect).not.toHaveBeenCalled()
    if (observed === 'ready') expect(() => assertMemoryEnableReadiness(result)).not.toThrow()
    else expect(() => assertMemoryEnableReadiness(result)).toThrow(reason)
  })

  it('synchronously refuses a once-ready builtin after its exact observation is retired', async () => {
    state.state = 'ready'; state.current = true
    const result = await readMemoryEnableReadiness(clientReply(['OK', SOURCE, 'builtin', BUILTIN]))
    expect(() => assertMemoryEnableReadiness(result)).not.toThrow()
    state.current = false
    expect(() => assertMemoryEnableReadiness(result)).toThrow(MemoryEnableReadinessError)
    expect(state.observe).toHaveBeenCalledTimes(1)
    expect(state.effect).not.toHaveBeenCalled()
  })

  it('does not transfer fulfilled readiness through a copied or reconstructed snapshot', async () => {
    state.state = 'ready'; state.current = true
    const result = await readMemoryEnableReadiness(clientReply(['OK', SOURCE, 'builtin', BUILTIN]))
    expect(() => assertMemoryEnableReadiness({ ...result })).toThrow('builtin-model-preparation-required')
  })

  it('does not promote a captured pending observation after a later preparation succeeds', async () => {
    state.state = 'preparing'
    const result = await readMemoryEnableReadiness(clientReply(['OK', SOURCE, 'builtin', BUILTIN]))
    state.state = 'ready'; state.current = true
    expect(() => assertMemoryEnableReadiness(result)).toThrow('builtin-model-preparing')
  })

  it.each([
    null, {}, [], ['UNAVAILABLE'], ['OK', SOURCE, 'unknown', ''],
    ['OK', SOURCE, 'builtin', 'builtin:unknown'], ['OK', 'unbounded-or-raw', 'api', ''],
    ['OK', SOURCE, 'api', 'must-not-return-config-values'], ['OK', SOURCE, 'api', '', 'extra'],
    ['OK', SOURCE, 'builtin', null]
  ])('makes a malformed/unavailable reply unavailable (%j)', async (reply) => {
    const result = await readMemoryEnableReadiness(clientReply(reply))
    expect(result).toEqual({ status: 'configuration-unavailable', reason: 'embedding-configuration-unavailable', source: '' })
    expect(() => assertMemoryEnableReadiness(result)).toThrow('embedding-configuration-unavailable')
    expect(state.observe).not.toHaveBeenCalled()
    expect(state.effect).not.toHaveBeenCalled()
  })

  it('does not treat an unavailable Redis read as absent/factory configuration or expose its error', async () => {
    const client = { eval: vi.fn(async () => { throw new Error('sensitive endpoint and credentials') }) }
    const result = await readMemoryEnableReadiness(client)
    expect(result).toEqual({ status: 'configuration-unavailable', reason: 'embedding-configuration-unavailable', source: '' })
    try {
      assertMemoryEnableReadiness(result)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryEnableReadinessError)
      expect((error as MemoryEnableReadinessError).reason).toBe('embedding-configuration-unavailable')
      expect(String(error)).not.toContain('sensitive')
    }
  })

  it('refuses a ready status whose private source evidence is absent', () => {
    const result: MemoryEnableReadinessSnapshot = { status: 'configuration-ready', reason: 'untrusted text', source: '' }
    expect(() => assertMemoryEnableReadiness(result)).toThrow('Nothing was saved')
    expect(() => assertMemoryEnableReadiness(result)).not.toThrow('untrusted text')
  })
})
