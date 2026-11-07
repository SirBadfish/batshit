import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_VOICE_PROVIDER_IDS } from '$lib/data/builtinVoiceCatalog'
import { publishFreshBuiltinVoiceCatalog } from '$lib/server/services/builtinVoiceCatalogCollector'
import { parseVoiceSyncArgs, runVoiceSync } from '../../../../build-scripts/sync-voice-model-catalog'

function setup(status: 'proposed' | 'stored' | 'conflict' = 'proposed') {
  const providers = Object.fromEntries(BUILTIN_VOICE_PROVIDER_IDS.map(providerId => [providerId, { entries: [{ modelId: 'SECRET_MODEL' }] }]))
  const snapshot = { generation: 2, sequence: 3, providers }
  const report = BUILTIN_VOICE_PROVIDER_IDS.map(providerId => ({ providerId, status: 'current', discovery: 'partial', pending: 1, followUp: 'adapter-contract', secret: 'SECRET_BODY' }))
  const store = { read: vi.fn(), compareAndSet: vi.fn() }
  const http = vi.fn()
  const now = () => 42
  const publish = vi.fn(async () => ({ status, snapshot, winner: status === 'conflict' ? { ...snapshot, sequence: 4 } : undefined, report }))
  return { snapshot, report, ports: { store, http, now, publish } }
}

describe('voice sync runner', () => {
  it('defaults to dry-run and requires explicit publication and initialization', () => {
    expect(parseVoiceSyncArgs([])).toEqual({ dryRun: true, initializeAbsent: false })
    expect(parseVoiceSyncArgs(['--publish', '--initialize-absent'])).toEqual({ dryRun: false, initializeAbsent: true })
    expect(parseVoiceSyncArgs(['--dry-run', '--initialize-absent'])).toEqual({ dryRun: true, initializeAbsent: true })
    for (const args of [['--publish', '--dry-run'], ['--publish', '--publish'], ['--fixture'], ['--publish=true']]) {
      expect(() => parseVoiceSyncArgs(args)).toThrow('invalid_arguments')
    }
  })

  it('passes the exact injected ports, and prints only finite coverage and counts', async () => {
    const { ports } = setup()
    const result = await runVoiceSync(parseVoiceSyncArgs([]), ports as never)
    expect(ports.publish).toHaveBeenCalledOnce()
    expect(ports.publish).toHaveBeenCalledWith({ store: ports.store, http: ports.http, now: ports.now, dryRun: true, initializeAbsent: false })
    expect(result.exitCode).toBe(0)
    expect(result.output).toMatchObject({ status: 'proposed', mode: 'dry-run', order: { generation: 2, sequence: 3 } })
    expect(JSON.stringify(result.output)).not.toContain('SECRET')
    expect(result.output).toHaveProperty('providers', expect.arrayContaining([expect.objectContaining({ providerId: 'google', discovery: 'partial', count: 1 })]))
  })

  it('passes publish and initialization only when requested', async () => {
    const { ports } = setup('stored')
    const result = await runVoiceSync(parseVoiceSyncArgs(['--publish', '--initialize-absent']), ports as never)
    expect(ports.publish).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, initializeAbsent: true }))
    expect(result).toMatchObject({ exitCode: 0, output: { status: 'stored', mode: 'publish' } })
  })

  it('reports a losing CAS as failure with winner order and does not retry', async () => {
    const { ports } = setup('conflict')
    const result = await runVoiceSync(parseVoiceSyncArgs(['--publish']), ports as never)
    expect(result).toMatchObject({ exitCode: 1, output: { status: 'conflict', order: { sequence: 4 } } })
    expect(ports.publish).toHaveBeenCalledOnce()
  })

  it('reports blocked sources without hiding other providers and exits nonzero', async () => {
    const { ports, report } = setup('stored')
    report[1].status = 'blocked'; report[1].discovery = 'unknown'; report[1].followUp = 'source-incomplete'
    const result = await runVoiceSync(parseVoiceSyncArgs(['--publish']), ports as never)
    expect(result.exitCode).toBe(1)
    expect(result.output).toHaveProperty('providers', expect.arrayContaining([expect.objectContaining({ status: 'blocked' }), expect.objectContaining({ status: 'current' })]))
  })

  it('makes unreadable state and arbitrary exceptions finite failures without leaking messages', async () => {
    const { ports } = setup()
    ports.publish.mockRejectedValue(new Error('SECRET provider body and credential'))
    const result = await runVoiceSync(parseVoiceSyncArgs([]), ports as never)
    expect(result).toEqual({ exitCode: 1, output: { status: 'failed', mode: 'dry-run' } })
    expect(ports.publish).toHaveBeenCalledOnce()
  })

  it('rejects incomplete or inconsistent result shapes instead of reporting success', async () => {
    const { ports, report } = setup()
    report.pop()
    expect(await runVoiceSync(parseVoiceSyncArgs([]), ports as never)).toEqual({ exitCode: 1, output: { status: 'failed', mode: 'dry-run' } })
    const stored = setup('stored')
    expect((await runVoiceSync(parseVoiceSyncArgs([]), stored.ports as never)).exitCode).toBe(1)
    for (const field of ['generation', 'sequence'] as const) {
      const invalid = setup(); invalid.snapshot[field] = 0
      expect((await runVoiceSync(parseVoiceSyncArgs([]), invalid.ports as never)).exitCode).toBe(1)
    }
  })
  it('refuses absent prior state before any source request unless initialization is explicit', async () => {
    const store = { read: vi.fn(async () => ({ state: 'absent' as const })), compareAndSet: vi.fn() }
    const http = vi.fn()
    const result = await runVoiceSync(parseVoiceSyncArgs([]), { store, http: http as unknown as typeof fetch, now: () => Date.parse('2026-10-28T12:00:00Z'), publish: publishFreshBuiltinVoiceCatalog })
    expect(result.exitCode).toBe(1)
    expect(store.read).toHaveBeenCalledOnce()
    expect(http).not.toHaveBeenCalled()
    expect(store.compareAndSet).not.toHaveBeenCalled()
  })

  it('runs a bounded fake source episode in dry mode and reports blocked sources', async () => {
    const store = { read: vi.fn(async () => ({ state: 'absent' as const })), compareAndSet: vi.fn() }
    const http = vi.fn(async () => { throw new Error('SECRET source body') })
    const result = await runVoiceSync(parseVoiceSyncArgs(['--initialize-absent']), { store, http: http as unknown as typeof fetch, now: () => Date.parse('2026-10-28T12:00:00Z'), publish: publishFreshBuiltinVoiceCatalog })
    expect(result.exitCode).toBe(1)
    expect(result.output).toMatchObject({ status: 'proposed', mode: 'dry-run' })
    expect(http.mock.calls.length).toBeGreaterThan(0)
    expect(store.compareAndSet).not.toHaveBeenCalled()
    expect(JSON.stringify(result.output)).not.toContain('SECRET')
  })

})
