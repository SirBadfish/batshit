import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginAccessAssignments from './PluginAccessAssignments.svelte'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
import type { AgentPluginDescriptor } from '$lib/types/agentPlugins'

const fixture = (): AgentPluginDescriptor => ({ id: 'fixture.tools', name: 'Fixture Tools', description: 'Related fixture skills.', version: '1.0.0', builtIn: false,
  skills: [{ commandId: 'owned_inspect', skillId: 'owned_inspect', name: 'Inspect', invocation: '/fixture.tools:inspect' }], enabled_for_all_agents: false, enabled_agent_ids: [], revision: 'fixture-revision' })
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('one plugin access switch', () => {
  it('hydrates without a write and saves only the explicitly selected agent', async () => {
    let row = fixture()
    const writes: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_path, init) => {
      if (!init?.method) return reply({ plugins: [row] })
      writes.push(JSON.parse(init.body))
      row = { ...row, enabled_agent_ids: ['first-agent'], revision: 'saved' }
      return reply({ plugin: row, changed: true })
    }))
    render(PluginAccessAssignments, { props: { entityId: 'first-agent' } })
    const toggle = await screen.findByRole('switch', { name: 'Fixture Tools plugin access' })
    expect(writes).toEqual([])
    await fireEvent.click(toggle)
    await waitFor(() => expect(writes).toEqual([{ agentId: 'first-agent', enabled: true }]))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    cleanup()
    render(PluginAccessAssignments, { props: { entityId: 'first-agent' } })
    expect((await screen.findByRole('switch', { name: 'Fixture Tools plugin access' })).getAttribute('aria-checked')).toBe('true')
    expect(writes).toHaveLength(1)
  })

  it('keeps an unknown save locked until a deliberate saved read and never replays it', async () => {
    let row = fixture(), writes = 0, reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_path, init) => {
      if (!init?.method) { reads++; return reply({ plugins: [row] }) }
      writes++; row = { ...row, enabled_agent_ids: ['first-agent'] }
      throw new Error('Lost reply')
    }))
    render(PluginAccessAssignments, { props: { entityId: 'first-agent' } })
    const toggle = await screen.findByRole('switch', { name: 'Fixture Tools plugin access' }) as HTMLButtonElement
    await fireEvent.click(toggle)
    await screen.findAllByText(/could not be confirmed/)
    expect(toggle.disabled).toBe(true)
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.slashCommandsUpdated))
    expect(reads).toBe(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh Saved Plugins' }))
    await waitFor(() => expect(toggle.disabled).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(writes).toBe(1)
  })

  it('refreshes a mounted switch after another surface changes access without writing', async () => {
    let row = fixture()
    const fetchMock = vi.fn(async () => reply({ plugins: [row] }))
    vi.stubGlobal('fetch', fetchMock)
    render(PluginAccessAssignments, { props: { entityId: 'first-agent' } })
    const toggle = await screen.findByRole('switch', { name: 'Fixture Tools plugin access' })
    row = { ...row, enabled_agent_ids: ['first-agent'], revision: 'elsewhere' }
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.slashCommandsUpdated))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(fetchMock.mock.calls).toEqual([['/api/plugins'], ['/api/plugins']])
  })

  it('keeps incomplete imports and removals unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ plugins: [{ ...fixture(), installing: true }] })))
    render(PluginAccessAssignments, { props: { entityId: 'first-agent' } })
    expect((await screen.findByRole('switch', { name: 'Fixture Tools plugin access' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Incomplete')).toBeTruthy()
  })
})
