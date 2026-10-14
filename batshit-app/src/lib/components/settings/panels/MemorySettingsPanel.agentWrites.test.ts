import { render, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test-utils/userSettingsRoute'

/**
 * SA-122 A-1y (LS-067/LS-068): an agent saved its own Settings (App Actions). The Memory panel holds
 * no draft of an agent's fields, only its list (the picker), so it reads that listed agent again
 * and shows the new name. An agent it does not list is not read. The user channel is a stand-in
 * that hands the panel the event the server publishes.
 */

const channel = vi.hoisted(() => ({ listeners: new Set<(event: any) => void>() }))
vi.mock('$lib/services/userChannel', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  onUserChannelEvent: (listener: (event: any) => void) => {
    channel.listeners.add(listener)
    return () => channel.listeners.delete(listener)
  }
}))

const AGENT = 'a1y_memory_agent'
let record: Record<string, unknown>
let agentReads: string[] = []

function ensureBrowserStubs() {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
  }
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  }
}

beforeEach(() => {
  ensureBrowserStubs()
  channel.listeners.clear()
  agentReads = []
  record = { id: AGENT, user_id: 'a1y_memory_user', displayName: 'Memory probe', agentType: 'api', memory_enabled: true }
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
      const method = (init.method ?? 'GET').toUpperCase()
      const path = url.split('?')[0]
      if (path === '/api/agents' && method === 'GET') return jsonResponse({ agents: [{ ...record }] })
      if (path.startsWith('/api/agents/') && method === 'GET') {
        agentReads.push(path)
        return path === `/api/agents/${AGENT}` ? jsonResponse({ ...record }) : jsonResponse({ error: 'Agent not found' }, 404)
      }
      if (path === '/api/user/saved-models') return jsonResponse({ models: [] })
      if (path === '/api/memory/config') return jsonResponse({ error: 'not under test' }, 500)
      return jsonResponse({ results: [], items: [], entries: [], segments: [] })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function emit(event: Record<string, unknown>) {
  for (const listener of [...channel.listeners]) listener(event)
}

function pickerName() {
  return document.querySelector('.memory-agent-option-name')?.textContent?.trim() ?? ''
}

describe('the Memory panel and an agent saving its own Settings (SA-122 A-1y)', () => {
  it('reads a listed agent again and shows its new name; an agent it does not list is not read', async () => {
    const { unmount } = render((await import('./MemorySettingsPanel.svelte')).default)
    await waitFor(() => expect(pickerName()).toBe('Memory probe'), { timeout: 10_000 })

    record = { ...record, displayName: 'Memory probe 2' }
    emit({ type: 'agent_settings_changed', agentId: 'a1y_not_listed', family: 'identity' })
    emit({ type: 'agent_settings_changed', agentId: AGENT, family: 'identity' })

    await waitFor(() => expect(pickerName()).toBe('Memory probe 2'), { timeout: 10_000 })
    expect(agentReads).toEqual([`/api/agents/${AGENT}`])

    unmount()
    expect(channel.listeners.size).toBe(0)
  })
})
