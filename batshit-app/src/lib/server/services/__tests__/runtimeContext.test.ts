import { describe, expect, it, vi } from 'vitest'
import * as runtimeContext from '../runtimeContext'
import { resolveRuntimeContext } from '../runtimeContext'

vi.mock('$lib/server/services/liveKitSidecarRuntime', () => ({
  getLiveKitSidecarRuntimeSummary: vi.fn(async () => ({ id: 'livekit' })),
  installLiveKitSidecarRuntime: vi.fn(async () => ({ install: { installed: true }, runtime: { id: 'livekit' } })),
  startLiveKitSidecarRuntime: vi.fn(async () => ({ id: 'livekit' }))
}))

describe('resolveRuntimeContext', () => {
  it('treats the Mac app runtime owner as the Mac app context', () => {
    const context = resolveRuntimeContext({
      BATSHIT_RUNTIME_OWNER: 'mac-app'
    })

    expect(context.mode).toBe('mac-app')
    expect(context.macApp).toBe(true)
    expect(context.containerized).toBe(false)
    expect(context.adminCards.macAppRequiredRuntime).toBe(true)
    expect(context.adminCards.appleContainerSandbox).toBe(true)
  })

  it('lets the Mac app runtime owner win over containerized env markers', () => {
    const context = resolveRuntimeContext({
      BATSHIT_RUNTIME_OWNER: 'mac-app',
      BATSHIT_CONTAINERIZED: '1',
      BATSHIT_RUNTIME_ENV: 'docker'
    })

    expect(context.mode).toBe('mac-app')
    expect(context.containerized).toBe(false)
  })

  it('detects Docker from BATSHIT_CONTAINERIZED', () => {
    const context = resolveRuntimeContext({
      BATSHIT_CONTAINERIZED: '1'
    })

    expect(context.mode).toBe('docker')
    expect(context.macApp).toBe(false)
    expect(context.containerized).toBe(true)
    expect(context.adminCards.macAppRequiredRuntime).toBe(false)
    expect(context.adminCards.appleContainerSandbox).toBe(false)
  })

  it('detects Docker from BATSHIT_RUNTIME_ENV', () => {
    const context = resolveRuntimeContext({
      BATSHIT_RUNTIME_ENV: 'docker'
    })

    expect(context.mode).toBe('docker')
    expect(context.containerized).toBe(true)
  })

  it('names the Pinokio launcher as its own native install', () => {
    const context = resolveRuntimeContext({
      BATSHIT_RUNTIME_OWNER: 'pinokio'
    })

    expect(context.mode).toBe('native')
    expect(context.label).toBe('Pinokio')
    expect(context.pinokio).toBe(true)
    expect(context.macApp).toBe(false)
    expect(context.adminCards.macAppRequiredRuntime).toBe(false)
    expect(context.adminCards.dockerSandbox).toBe(true)
  })

  it('lets Docker markers win over the Pinokio owner', () => {
    const context = resolveRuntimeContext({
      BATSHIT_RUNTIME_OWNER: 'pinokio',
      BATSHIT_CONTAINERIZED: '1'
    })

    expect(context.mode).toBe('docker')
    expect(context.pinokio).toBe(false)
  })

  it('falls back to source checkout context', () => {
    const context = resolveRuntimeContext({})

    expect(context.mode).toBe('native')
    expect(context.label).toBe('Source checkout')
    expect(context.pinokio).toBe(false)
    expect(context.adminCards.macAppRequiredRuntime).toBe(false)
    expect(context.adminCards.appleContainerSandbox).toBe(false)
    expect(context.adminCards.dockerSandbox).toBe(true)
  })

  it('names Windows WSL2 and exposes its engine capability only for the explicit owned Linux guest', () => {
    const runtimeEnv = {
      BATSHIT_RUNTIME_OWNER: 'pinokio',
      BATSHIT_PINOKIO_HOST: 'windows-wsl',
      BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned'
    }
    const context = resolveRuntimeContext(runtimeEnv, 'linux')
    expect(context.label).toBe('Pinokio (Windows, WSL2)')
    expect(context.mode).toBe('native')
    expect(context.localVoiceEngineStopPolicy).toBe('all-owned')
    for (const platform of ['darwin', 'win32'] as const) {
      expect(resolveRuntimeContext(runtimeEnv, platform).localVoiceEngineStopPolicy).toBe('per-engine')
    }
    for (const overrides of [
      { BATSHIT_RUNTIME_OWNER: 'mac-app' },
      { BATSHIT_RUNTIME_OWNER: undefined },
      { BATSHIT_CONTAINERIZED: '1' },
      { BATSHIT_RUNTIME_ENV: 'docker' },
      { BATSHIT_PINOKIO_HOST: undefined },
      { BATSHIT_PINOKIO_ENGINE_STOP_POLICY: undefined },
      { BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'force' }
    ]) {
      expect(resolveRuntimeContext({ ...runtimeEnv, ...overrides }, 'linux').localVoiceEngineStopPolicy).toBe('per-engine')
    }
  })

  it('never derives stop authority from a durable launch profile or HOST bind address', () => {
    const context = resolveRuntimeContext({
      BATSHIT_RUNTIME_OWNER: 'pinokio',
      BATSHIT_PINOKIO_LAUNCH_PROFILE: 'windows-wsl',
      HOST: 'windows-wsl'
    }, 'linux')
    expect(context.label).toBe('Pinokio')
    expect(context.localVoiceEngineStopPolicy).toBe('per-engine')
  })
})

describe('LiveKit route runtime capability disclosure', () => {
  it.each(['GET', 'start', 'install'])('carries the derived stop policy in the %s response', async (operation) => {
    const context = resolveRuntimeContext({
      BATSHIT_RUNTIME_OWNER: 'pinokio', BATSHIT_PINOKIO_HOST: 'windows-wsl',
      BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned'
    }, 'linux')
    const capability = vi.spyOn(runtimeContext, 'resolveRuntimeContext').mockReturnValue(context)
    try {
      const route = await import('../../../../routes/api/voice/runtime/livekit/+server')
      const event = {
        locals: { user: { id: 'voice-runtime-capability' } },
        request: new Request('http://localhost/api/voice/runtime/livekit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation })
        })
      }
      const response = await (operation === 'GET' ? route.GET : route.POST)(event as any)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        runtime: { id: 'livekit' },
        runtimeContext: { label: 'Pinokio (Windows, WSL2)', localVoiceEngineStopPolicy: 'all-owned' }
      })
    } finally {
      capability.mockRestore()
    }
  })

  it('keeps runtime capability reads signed in', async () => {
    const route = await import('../../../../routes/api/voice/runtime/livekit/+server')
    const response = await route.GET({ locals: {} } as any)
    expect(response.status).toBe(401)
    expect(await response.json()).not.toHaveProperty('runtimeContext')
  })
})
