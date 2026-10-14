import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../nativeTools', async importOriginal => {
  const actual = await importOriginal<typeof import('../nativeTools')>()
  return { ...actual, nativeToolService: { ...actual.nativeToolService,
    buildMode3NativeTools: vi.fn(async () => ({ tools: {}, toolApprovals: {}, fetchZipAvailable: false })) } }
})
const { VercelAIBrain } = await import('../vercelBrain')
const { nativeToolService } = await import('../nativeTools')
afterEach(() => vi.clearAllMocks())

describe('SA-122 originating API reply signal at the brain/native-tools owner boundary', () => {
  it('forwards the same server-owned signal when Workers are disabled and keeps its retirement', async () => {
    const controller = new AbortController()
    const brain = new VercelAIBrain() as any
    await brain.buildToolsForMode3(undefined, undefined, 'sa122_session', 'sa122_user', [], undefined,
      'sa122_primary', { assignedSubagents: [] }, null, null, 'off', {
        providerSettings: { nativeTools: { fabricEnabled: true, batshitToolsEnabled: true } },
        allowFabricControlTools: true, workersEnabled: false, abortSignal: controller.signal
      })
    expect(nativeToolService.buildMode3NativeTools).toHaveBeenCalledTimes(1)
    const owned = vi.mocked(nativeToolService.buildMode3NativeTools).mock.calls[0][0]
    expect(owned.workers).toBeNull()
    expect(owned.abortSignal).toBe(controller.signal)
    controller.abort()
    expect(owned.abortSignal?.aborted).toBe(true)
  })
})
