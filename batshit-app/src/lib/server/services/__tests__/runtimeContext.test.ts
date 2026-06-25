import { describe, expect, it } from 'vitest'
import { resolveRuntimeContext } from '../runtimeContext'

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

  it('falls back to source checkout context', () => {
    const context = resolveRuntimeContext({})

    expect(context.mode).toBe('native')
    expect(context.label).toBe('Source checkout')
    expect(context.adminCards.macAppRequiredRuntime).toBe(false)
    expect(context.adminCards.appleContainerSandbox).toBe(false)
    expect(context.adminCards.dockerSandbox).toBe(true)
  })
})
