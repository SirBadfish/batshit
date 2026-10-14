import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { normalizeNativeExecutionBackend, sandboxUnavailableMessage } from '../nativeExecutionBackend'

describe('nativeExecutionBackend', () => {
  it('normalizes supported execution backend aliases', () => {
    expect(normalizeNativeExecutionBackend('local')).toBe('local')
    expect(normalizeNativeExecutionBackend('docker')).toBe('docker_sandbox')
    expect(normalizeNativeExecutionBackend('docker-sandbox')).toBe('docker_sandbox')
    expect(normalizeNativeExecutionBackend('sandbox')).toBe('docker_sandbox')
    expect(normalizeNativeExecutionBackend('apple')).toBe('apple_container')
    expect(normalizeNativeExecutionBackend('apple-container')).toBe('apple_container')
    expect(normalizeNativeExecutionBackend('apple container')).toBe('apple_container')
  })

  it('rejects empty, non-string, and unknown backend values', () => {
    expect(normalizeNativeExecutionBackend('')).toBeNull()
    expect(normalizeNativeExecutionBackend('unknown')).toBeNull()
    expect(normalizeNativeExecutionBackend(null)).toBeNull()
  })
})

// BL-83: Agent Settings says the true thing for each Apple Container state. A stopped system with
// the CLI installed is `available` (the first sandboxed command starts it, BL-62) and never gets
// this message; the panel shows its own "not started yet" note instead.
describe('sandboxUnavailableMessage', () => {
  it('names what is missing for each Apple Container state', () => {
    expect(
      sandboxUnavailableMessage('apple_container', { available: false, installed: false, supported: true })
    ).toBe('Apple Container is not installed. Apple-backed Bash runs will fail safely until it is installed.')
    expect(
      sandboxUnavailableMessage('apple_container', { available: false, installed: true, supported: true })
    ).toBe(
      'Apple Container is installed but not answering. Apple-backed Bash runs will fail safely until it answers.'
    )
    expect(
      sandboxUnavailableMessage('apple_container', { available: false, installed: true, supported: false })
    ).toBe('Apple Container runs only on a Mac. Apple-backed Bash runs will fail safely here.')
    expect(sandboxUnavailableMessage('apple_container', null)).toBe(
      'Apple Container is not available. Apple-backed Bash runs will fail safely until it is.'
    )
  })

  it('has nothing to say about an Apple Container that Batshit can use, started or not', () => {
    expect(
      sandboxUnavailableMessage('apple_container', { available: true, installed: true, supported: true })
    ).toBeNull()
  })

  it('never claims Apple Container must already be running', () => {
    for (const status of [
      null,
      { available: false, installed: false, supported: true },
      { available: false, installed: true, supported: true },
      { available: false, installed: true, supported: false }
    ]) {
      expect(sandboxUnavailableMessage('apple_container', status) ?? '').not.toMatch(/running/)
    }
  })

  // The panel is 15,000 lines, so its two call sites are pinned from the line start: a status
  // dropped from either would bring back one message for every state.
  it('Agent Settings hands each selected status to the message, for agents and subagents', () => {
    const panel = readFileSync('src/lib/components/settings/panels/AgentSettingsPanel.svelte', 'utf8')
    expect(panel).toContain('\n    return sandboxUnavailableMessage(backend, status) ?? "";\n')
    expect(panel).toContain(
      '\n                            {getSandboxUnavailableMessage(selectedSandboxBackend, selectedSandboxStatus)}\n'
    )
    expect(panel).toContain(
      '\n                            {getSandboxUnavailableMessage(subagentSelectedSandboxBackend, subagentSelectedSandboxStatus)}\n'
    )
    expect(panel).not.toContain('installed and running')
  })

  it('keeps the Docker Sandbox message', () => {
    expect(sandboxUnavailableMessage('docker_sandbox', { available: false })).toBe(
      'Docker Sandbox is not available. Docker-backed Bash runs will fail safely until Docker Sandbox is ready.'
    )
  })
})
