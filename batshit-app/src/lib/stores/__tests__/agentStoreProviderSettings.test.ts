import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'
import { MCP_SETTINGS_REVISION_HEADER } from '$lib/utils/agentSettingsSectionSaves'
import { makeMcpSettingsSnapshot, mcpSettingsReadPaths } from '$lib/server/agentRecordUpdate'
import { captureSettingsLifecycle } from '$lib/server/services/appActions/settings/lifecycle'
import { agentTypeSnapshotOf } from '$lib/test-utils/agentUpdateScriptTwin'

/**
 * BL-514: the agents store lays a save over its own copy the way the server does, so the chat bar
 * (Work mode, never-allow list) shows what was saved: a model pick keeps the agent's own keys.
 * BL-848, BL-855: the Claude settings and the Tool Grid display settings are laid over
 * the copy key by key (and, for the Tool Grid, entry by entry), as the server writes them.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  agentStore.setAgents([])
})

const WORK_MODE = { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] }

describe('agents store: a save keeps the agent keys in its copy (BL-514)', () => {
  it('a model pick replaces the model keys and keeps nativeTools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })))
    agentStore.setAgents([
      { id: 'ssmod_store_agent', provider_specific_settings: { temperature: 1.2, nativeTools: WORK_MODE } } as any
    ])

    await agentStore.updateAgentSettings('ssmod_store_agent', { provider_specific_settings: {} })

    expect(agentStore.getAgentById('ssmod_store_agent')?.provider_specific_settings).toEqual({ nativeTools: WORK_MODE })
  })

  it('a chat-bar Work-mode save keeps the model keys and lays nativeTools over field by field (BL-833, BL-841)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    agentStore.setAgents([
      { id: 'ssnt_store_agent', provider_specific_settings: { temperature: 1.2, nativeTools: WORK_MODE, codex_permission_mode: 'chat' } } as any
    ])

    await agentStore.updateAgentSettings('ssnt_store_agent', { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } } })

    expect(agentStore.getAgentById('ssnt_store_agent')?.provider_specific_settings).toEqual({
      temperature: 1.2,
      nativeTools: { ...WORK_MODE, bashAccessMode: 'agent' },
      codex_permission_mode: 'chat'
    })
    // The server gets what the control sent, not the laid-over copy.
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))).toEqual({
      provider_specific_settings: { nativeTools: { bashAccessMode: 'agent' } }
    })
  })

  const CLAUDE = { model: 'sonnet', permissionMode: 'default', addDirs: [] }
  const CLAUDE_FULL = { model: 'sonnet', permissionMode: 'default', chrome: true, addDirs: ['/a'] }
  const DCM = { version: 1, groups: { gw_a: 'group-only' }, tools: { 'gw_a::read': 'name-only' }, groupDisplayPreferences: {}, toolDisplayPreferences: {} }

  it('a claude_settings save lays over the copy key by key and sends only the keys it names (BL-848)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    agentStore.setAgents([{ id: 'ssblk_store_agent', claude_settings: CLAUDE_FULL, dcmDisplaySettings: DCM } as any])

    await agentStore.updateAgentSettings('ssblk_store_agent', {
      claude_settings: { permissionMode: 'plan', chrome: null, addDirs: ['/b'] }
    })

    const agent = agentStore.getAgentById('ssblk_store_agent')
    expect(agent?.claude_settings).toEqual({ model: 'sonnet', permissionMode: 'plan', addDirs: ['/b'] })
    expect(agent?.dcmDisplaySettings).toEqual(DCM)
    expect(JSON.parse(String((fetchMock.mock.calls[0] as any[])[1].body))).toEqual({
      claude_settings: { permissionMode: 'plan', chrome: null, addDirs: ['/b'] }
    })
  })

  it('a claude_settings save keeps the keys it does not name; a copy with no block takes the named keys (BL-848)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })))
    agentStore.setAgents([
      { id: 'ssblk_has', claude_settings: CLAUDE } as any,
      { id: 'ssblk_none' } as any,
      { id: 'ssblk_null', claude_settings: null } as any
    ])

    await agentStore.updateAgentSettings('ssblk_has', { claude_settings: { permissionMode: 'plan' } })
    await agentStore.updateAgentSettings('ssblk_none', { claude_settings: { permissionMode: 'plan' } })
    await agentStore.updateAgentSettings('ssblk_null', { claude_settings: { permissionMode: 'plan' } })

    expect(agentStore.getAgentById('ssblk_has')?.claude_settings).toEqual({ ...CLAUDE, permissionMode: 'plan' })
    expect(agentStore.getAgentById('ssblk_none')?.claude_settings).toEqual({ permissionMode: 'plan' })
    expect(agentStore.getAgentById('ssblk_null')?.claude_settings).toEqual({ permissionMode: 'plan' })
  })

  it('a dcmDisplaySettings save lays over the copy entry by entry, an entry named null removed (BL-855)', async () => {
    let record = { id: 'ssblk_dcm', user_id: 'ssblk_user', agentType: 'api', created_at: '2026-10-23T00:00:00.000Z',
      dcmDisplaySettings: DCM, defaultMCPGateways: ['gw_a'] }
    const snapshot = () => {
      const paths = mcpSettingsReadPaths()
      return makeMcpSettingsSnapshot(record.id, paths, paths.map(path => agentTypeSnapshotOf(record, [path])),
        captureSettingsLifecycle([`agent:${record.id}`]))
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        expect(body.expectedMcpSettings).toEqual(snapshot().revisions)
        record = { ...record, defaultMCPGateways: body.defaultMCPGateways }
        const saved = snapshot()
        return Response.json({ success: true, mcpSettings: {
          values: { defaultMCPGateways: record.defaultMCPGateways },
          revisions: { defaultMCPGateways: saved.revisions.defaultMCPGateways }
        } })
      }
      return Response.json(record, { headers: { [MCP_SETTINGS_REVISION_HEADER]: JSON.stringify(snapshot().revisions) } })
    })
    vi.stubGlobal('fetch', fetchMock)
    agentStore.setAgents([record as any])
    const original = await agentStore.loadAgentMcpSettingsDetail(record.id)
    expect(original).toBeTruthy()

    await agentStore.updateAgentSettings('ssblk_dcm', {
      dcmDisplaySettings: { groups: { gw_a: null, gw_b: 'hidden' }, tools: { 'gw_a::write': 'hidden' } },
      defaultMCPGateways: ['gw_b'],
      expectedMcpSettings: original!.revisions
    })

    const agent = agentStore.getAgentById('ssblk_dcm')
    expect(agent?.dcmDisplaySettings).toEqual({
      ...DCM,
      groups: { gw_b: 'hidden' },
      tools: { 'gw_a::read': 'name-only', 'gw_a::write': 'hidden' }
    })
    expect(agent?.defaultMCPGateways).toEqual(['gw_b'])
    const issued = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(issued).toHaveLength(1)
    expect(JSON.parse(String(issued[0][1]!.body)).dcmDisplaySettings).toEqual({
      groups: { gw_a: null, gw_b: 'hidden' },
      tools: { 'gw_a::write': 'hidden' }
    })
  })

  it('a save that names none of the three blocks leaves the copy of them alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })))
    agentStore.setAgents([{ id: 'ssblk_other', claude_settings: CLAUDE_FULL, dcmDisplaySettings: DCM } as any])

    await agentStore.updateAgentSettings('ssblk_other', { displayName: 'Renamed' })

    const agent = agentStore.getAgentById('ssblk_other')
    expect(agent?.displayName).toBe('Renamed')
    expect(agent?.claude_settings).toEqual(CLAUDE_FULL)
    expect(agent?.dcmDisplaySettings).toEqual(DCM)
  })

  it('a refused save of these blocks puts the copy back as it was (BL-848, BL-855)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    agentStore.setAgents([{ id: 'ssblk_refused', claude_settings: CLAUDE_FULL, dcmDisplaySettings: DCM } as any])

    await expect(
      agentStore.updateAgentSettings('ssblk_refused', {
        claude_settings: { model: 'opus' },
        dcmDisplaySettings: { groups: { gw_a: 'hidden' } }
      })
    ).rejects.toThrow()

    const agent = agentStore.getAgentById('ssblk_refused')
    expect(agent?.claude_settings).toEqual(CLAUDE_FULL)
    expect(agent?.dcmDisplaySettings).toEqual(DCM)
  })

  it('a block that is neither an object nor null is refused before anything is sent or changed', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    agentStore.setAgents([{ id: 'ssblk_bad', claude_settings: CLAUDE_FULL } as any])

    await expect(agentStore.updateAgentSettings('ssblk_bad', { claude_settings: 'opus' as any })).rejects.toThrow(
      'must be an object or null'
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(agentStore.getAgentById('ssblk_bad')?.claude_settings).toEqual(CLAUDE_FULL)
  })

  it('a refused save puts the copy back as it was', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = { temperature: 1.2, nativeTools: WORK_MODE }
    agentStore.setAgents([{ id: 'ssmod_store_agent', provider_specific_settings: before } as any])

    await expect(agentStore.updateAgentSettings('ssmod_store_agent', { provider_specific_settings: {} })).rejects.toThrow()

    expect(agentStore.getAgentById('ssmod_store_agent')?.provider_specific_settings).toEqual(before)
  })
})
