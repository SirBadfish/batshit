import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { ComponentProps } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentMcpDefaultsCard from '$lib/components/settings/agent/AgentMcpDefaultsCard.svelte'
import GlobalToolGrid from '../GlobalToolGrid.svelte'
import { resetUserSettings } from '$lib/stores/userSettings.svelte'
import { SHARED_NON_MCP_TOOL_GRID_CONFIG } from '$lib/components/tools/toolGridConfig'

// Match the existing mounted grid harness: jsdom finishes each slide on the next tick.
if (typeof Element.prototype.animate !== 'function') Object.defineProperty(Element.prototype, 'animate', {
  configurable: true,
  value: () => {
    let onfinish: (() => void) | null = null
    return { cancel() {}, finish() {}, play() {}, pause() {}, get onfinish() { return onfinish }, set onfinish(handler: (() => void) | null) { onfinish = handler; setTimeout(() => handler?.(), 0) } }
  }
})

function catalog(empty = false, settings: unknown = {}, envelope?: unknown) {
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method && init.method !== 'GET') {
      writes.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ success: true })
    }
    if (url === '/api/user/settings') return Response.json(envelope ?? { settings })
    if (url === '/api/native-tools/sandbox/status?hostOnly=1') return Response.json({ typedFileToolsHost: { platform: 'darwin', containerized: false } })
    if (url.startsWith('/api/mcp/gateways/') && url.endsWith('/tools')) return Response.json({ mcps: [{ id: 'group', name: 'Files', tools: [{ id: 'read_document' }] }] })
    if (url.startsWith('/api/mcp/gateways')) return Response.json({ gateways: empty ? [] : [
      { id: 'alpha', name: 'Alpha Source', enabled: true, type: 'docker-gateway' },
      { id: 'beta', name: 'Beta Source', enabled: true, type: 'docker-gateway' }
    ] })
    if (url === '/api/cli-tools') return Response.json({ tools: empty ? [] : [{ toolId: 'saved-cli', title: 'Saved CLI' }] })
    throw new Error(`Unexpected request ${url}`)
  }))
  return writes
}

function agentProps(compactDropdownMode = false, overrides: Partial<ComponentProps<typeof AgentMcpDefaultsCard>> = {}): ComponentProps<typeof AgentMcpDefaultsCard> {
  return {
    userId: 'hierarchy-user', agentId: 'hierarchy-agent', subjectKind: 'primary',
    toolHostScope: 'api', defaultMCPGateways: ['alpha', 'beta'], defaultMCPToolSelections: [],
    defaultCliToolIds: ['saved-cli'], nativeCliToolsEnabled: true, nativeDynamicMcpEnabled: true,
    dcmDisplaySettings: { version: 1, groups: {}, tools: {} }, mcpSaveState: 'idle', mcpRenderNonce: 0,
    defaultOpen: true, showCardHeader: false, showGridIntroBlock: false, showZipControls: true,
    showZipModeControls: false, showPostTableControls: false, compactDropdownMode,
    nonMcpZipRows: [SHARED_NON_MCP_TOOL_GRID_CONFIG.bash, SHARED_NON_MCP_TOOL_GRID_CONFIG.all_other_tools],
    onGatewaysChange: vi.fn(), onCliToolIdsChange: vi.fn(), onDcmDisplaySettingsChange: vi.fn(),
    getToolZipOverride: () => ({ buffer_size: '', zip_threshold: '', auto_zip: '__inherit__' }),
    onToolZipOverrideChange: vi.fn(),
    getNonMcpZipOverride: () => ({ buffer_size: '', zip_threshold: '', auto_zip: '__inherit__', min_buffer: 2 }),
    onNonMcpZipOverrideChange: vi.fn(),
    getEnableControl: () => ({ checked: true, disabled: false, onChange: vi.fn() }),
    ...overrides
  }
}

const trigger = (name: string) => screen.getByRole('button', { name, exact: true })
const expanded = (name: string) => trigger(name).getAttribute('aria-expanded')

async function checkHierarchy() {
  await screen.findByText('CLI Tools', { selector: '.batshit-settings-tool-grid-name' })
  const topNames = Array.from(document.querySelectorAll('table > tbody > tr')).filter(row => row.parentElement?.parentElement?.querySelector('thead'))
    .map(row => row.querySelector('.batshit-settings-tool-grid-name')?.textContent?.trim()).filter(Boolean)
  expect(topNames).toEqual(['Batshit Tools', 'CLI Tools', 'MCP Tools', 'All Other Tools'])
  expect(screen.queryByText('Alpha Source', { selector: '.batshit-settings-tool-grid-name' })).toBeNull()
  await fireEvent.click(trigger('Toggle MCP Tools'))
  expect(expanded('Toggle MCP Tools')).toBe('true')
  await fireEvent.click(await screen.findByRole('button', { name: 'Toggle groups for MCP Source Alpha Source', exact: true }))
  expect(expanded('Toggle MCP Tools')).toBe('true')
  expect(expanded('Toggle groups for MCP Source Alpha Source')).toBe('true')
  await fireEvent.click(await screen.findByRole('button', { name: 'Toggle tools for group Files', exact: true }))
  expect(await screen.findByText('read_document', { selector: '.batshit-settings-tool-grid-name' })).toBeTruthy()
  await fireEvent.click(trigger('Toggle groups for MCP Source Beta Source'))
  expect(expanded('Toggle groups for MCP Source Alpha Source')).toBe('false')
  expect(expanded('Toggle groups for MCP Source Beta Source')).toBe('true')
  await fireEvent.click(trigger('Toggle CLI tools for CLI Tools'))
  expect(expanded('Toggle MCP Tools')).toBe('false')
  expect(expanded('Toggle CLI tools for CLI Tools')).toBe('true')
  await fireEvent.click(trigger('Toggle Batshit Tools'))
  expect(expanded('Toggle CLI tools for CLI Tools')).toBe('false')
  expect(expanded('Toggle Batshit Tools')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Toggle Other', exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Toggle All Other Tools', exact: true })).toBeNull()
}

afterEach(() => { cleanup(); resetUserSettings(); vi.unstubAllGlobals() })

describe('Tool Grid parent hierarchy', () => {
  it('Subagent three-column parents share exclusivity, native icons and unavailable Fabric info disclosure', async () => {
    catalog()
    const reason = 'Fabric & Utilities is available only to Primary Agents.'
    render(AgentMcpDefaultsCard, { props: agentProps(false, {
      subjectKind: 'subagent', showZipControls: false,
      getEnableControl: id => ({ checked: id !== 'fabric_find', disabled: id === 'fabric_find', notice: id === 'fabric_find' ? reason : null, onChange: vi.fn() })
    }) })
    await fireEvent.click(await screen.findByRole('button', { name: 'Toggle Batshit Tools', exact: true }))
    expect(await screen.findByRole('button', { name: 'Batshit Tool: Bash', exact: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Batshit Tool: Web Search', exact: true })).toBeTruthy()
    const fabric = screen.getByRole('switch', { name: 'Enable Fabric & Utilities', exact: true }) as HTMLButtonElement
    expect(fabric.getAttribute('aria-checked')).toBe('false')
    expect(fabric.disabled).toBe(true)
    expect(screen.queryByText(reason)).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'About Fabric & Utilities', exact: true }))
    expect(await screen.findByText(reason)).toBeTruthy()
    await fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await fireEvent.click(trigger('Toggle CLI tools for CLI Tools'))
    expect(expanded('Toggle Batshit Tools')).toBe('false')
    await fireEvent.click(trigger('Toggle MCP Tools'))
    expect(expanded('Toggle CLI tools for CLI Tools')).toBe('false')
    expect(screen.getAllByRole('columnheader').map(column => column.textContent?.trim())).toEqual(['Item', 'Enable', 'Display Detail'])
    expect(screen.queryByRole('columnheader', { name: 'Zip Buffer' })).toBeNull()
  })

  it.each([
    [false, 'group-only', 'group-only'],
    [true, 'hidden', 'group-only'],
    [false, 'hidden', 'hidden'],
    [true, 'use-global', 'hidden']
  ] as const)('single Enable reflects native %s / local %s / global %s and dispatches one explicit paired choice', async (native, local, global) => {
    catalog(false, { global_tool_grid_settings: { cli: { dcmDisplayDefaults: { groups: { 'CLI Tools': global } } } } })
    const onChange = vi.fn(), onDcmDisplaySettingsChange = vi.fn()
    render(AgentMcpDefaultsCard, { props: agentProps(false, {
      nativeCliToolsEnabled: native,
      dcmDisplaySettings: { version: 1, groups: { '__cli_tools__::CLI Tools': local }, tools: {} },
      getEnableControl: id => ({ checked: id === 'cli_tools' ? native : true, disabled: false, onChange }),
      onDcmDisplaySettingsChange
    }) })
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/cli-tools'))
    const enable = screen.getByRole('switch', { name: 'Enable CLI Tools', exact: true })
    expect(enable.getAttribute('aria-checked')).toBe('false')
    await fireEvent.click(enable)
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange.mock.calls[0][0]).toBe(true)
    expect(onDcmDisplaySettingsChange).not.toHaveBeenCalled()
  })

  it.each([false, true])('an unavailable global read blocks ON and preserves explicit OFF for native %s', async native => {
    catalog(false, {}, {})
    const onChange = vi.fn()
    render(AgentMcpDefaultsCard, { props: agentProps(false, { getEnableControl: id => ({ checked: id === 'cli_tools' ? native : true, disabled: false, onChange }) }) })
    await screen.findByText('Could not read saved global Tool Grid defaults.')
    const enable = screen.getByRole('switch', { name: 'Enable CLI Tools', exact: true }) as HTMLButtonElement
    expect(enable.disabled).toBe(!native)
    await fireEvent.click(enable)
    expect(onChange).toHaveBeenCalledTimes(native ? 1 : 0)
    if (native) expect(onChange).toHaveBeenCalledWith(false)
  })

  it.each([false, true])('shares exclusive parents and nested MCP sources in Agent/compact mode %s without writes', async compact => {
    const writes = catalog()
    const props = agentProps(compact)
    render(AgentMcpDefaultsCard, { props })
    await checkHierarchy()
    expect(writes).toEqual([])
    expect(props.onGatewaysChange).not.toHaveBeenCalled()
    expect(props.onDcmDisplaySettingsChange).not.toHaveBeenCalled()
    expect(props.onCliToolIdsChange).not.toHaveBeenCalled()
  })

  it('uses the same Global hierarchy without inventing an all-source enable', async () => {
    const writes = catalog()
    render(GlobalToolGrid, { props: { userId: 'hierarchy-user' } })
    await checkHierarchy()
    const mcpRow = screen.getByText('MCP Tools', { selector: '.batshit-settings-tool-grid-name' }).closest('tr')!
    expect(mcpRow.querySelector('[role="switch"]')).toBeNull()
    expect(writes).toEqual([])
  })

  it('retains empty CLI and MCP parents and the native saved-choice recovery control', async () => {
    const writes = catalog(true), onChange = vi.fn(), onRead = vi.fn()
    render(AgentMcpDefaultsCard, { props: agentProps(false, {
      nativeCliToolsEnabled: false,
      getEnableControl: id => ({ checked: id !== 'cli_tools', disabled: id === 'cli_tools', onChange, ...(id === 'cli_tools' ? { notice: 'Your draft is unconfirmed.', onRead } : {}) })
    }) })
    await waitFor(() => expect(screen.queryByText('Loading MCP and CLI tool rows...')).toBeNull())
    await fireEvent.click(trigger('Toggle CLI tools for CLI Tools'))
    expect(await screen.findByText('No saved CLI tools yet.')).toBeTruthy()
    await fireEvent.click(trigger('Toggle MCP Tools'))
    expect(await screen.findByText('No MCP sources discovered yet.')).toBeTruthy()
    expect(writes).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
    // The surviving CLI row must carry the original field's notice/read owner.
    expect(screen.getByText('Your draft is unconfirmed.')).toBeTruthy()
    await fireEvent.click(trigger('Read saved CLI Tools choice'))
    expect(onRead).toHaveBeenCalledOnce()
  })
})
