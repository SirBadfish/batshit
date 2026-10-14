import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import GlobalToolGrid from '../GlobalToolGrid.svelte'

/**
 * BL-231: with nothing saved, the zip control permission is OFF, the value the compiler runs with
 * (`zipAgentControlPermission.test.ts`), and Reset to defaults writes OFF.
 *
 * SA-129 DL-06 (BL-1484): the permission is parked behind a hidden experiment key,
 * `global_zip_settings.zip_agent_control_experiment`, and the older `zip_agent_control_enabled` and
 * `zip_control_mode` are ignored. The grid shows no control for any of them: a save of another zip
 * control carries every key it does not own through as stored (the route replaces the whole block,
 * BL-487), and Reset to defaults writes a clean block with none of them (absent is OFF).
 *
 * Renders the REAL grid; `fetch` answers the grid's three loads and records its saves.
 */

type Saved = { url: string; body: any }

function stubFetch(settings: Record<string, unknown>) {
  const saves: Saved[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/user/settings' && method === 'GET') {
        return new Response(JSON.stringify({ settings }), { status: 200 })
      }
      if (url === '/api/user/settings' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        saves.push({ url, body })
        return new Response(JSON.stringify({ settings: { ...settings, ...body } }), { status: 200 })
      }
      if (url === '/api/mcp/gateways') return new Response(JSON.stringify({ gateways: [] }), { status: 200 })
      if (url === '/api/cli-tools') return new Response(JSON.stringify({ tools: [] }), { status: 200 })
      return new Response(JSON.stringify({ error: `unrouted ${method} ${url}` }), { status: 501 })
    })
  )
  return saves
}

function selectTrigger(labelText: string): HTMLElement {
  const label = screen.getByText(labelText, { selector: '.batshit-settings-form-label' }).closest('label')
  // The label also holds the (i) menu's button; the select is the compact trigger.
  const trigger = label?.querySelector('.batshit-settings-select-compact')
  if (!trigger) throw new Error(`${labelText} select not found`)
  return trigger as HTMLElement
}

async function chooseLayoutInline() {
  await fireEvent.keyDown(selectTrigger('AI Zip Layout'), { key: 'ArrowDown' })
  const option = await screen.findByRole('option', { name: 'Inline', exact: true })
  await fireEvent.pointerUp(option, { pointerType: 'mouse' })
}

async function renderLoaded(settings: Record<string, unknown>) {
  const saves = stubFetch(settings)
  render(GlobalToolGrid, { props: { userId: 'zbctx_user' } })
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/user/settings'))
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).toBeNull())
  await screen.findByText('AI Zip Layout', { selector: '.batshit-settings-form-label' })
  return saves
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Global Tool Grid: the parked zip control permission (BL-231, BL-1484)', () => {
  it('shows no Zip Control Permissions control, with nothing saved or with a saved ON', async () => {
    await renderLoaded({ global_zip_settings: undefined })
    expect(screen.queryByText('Zip Control Permissions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'About Zip Control Permissions' })).toBeNull()
  })

  it('a saved ON is still not shown', async () => {
    await renderLoaded({ global_zip_settings: { zip_agent_control_experiment: true, zip_agent_control_enabled: true } })
    expect(screen.queryByText('Zip Control Permissions')).toBeNull()
  })

  it('a save of another zip control carries a stored experiment ON, and the ignored legacy key, through unchanged', async () => {
    const saves = await renderLoaded({
      global_zip_settings: { zip_agent_control_experiment: true, zip_agent_control_enabled: true, zip_ai_view_mode: 'appended' }
    })
    await chooseLayoutInline()

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.zip_ai_view_mode).toBe('inline')
    expect(saves[0].body.global_zip_settings.zip_agent_control_experiment).toBe(true)
    expect(saves[0].body.global_zip_settings.zip_agent_control_enabled).toBe(true)
  })

  it('a save with nothing stored writes no value for any of them (absent reads OFF)', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    await chooseLayoutInline()
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings).not.toHaveProperty('zip_agent_control_experiment')
    expect(saves[0].body.global_zip_settings).not.toHaveProperty('zip_agent_control_enabled')
  })

  it('a save keeps a legacy zip_control_mode exactly as stored', async () => {
    const saves = await renderLoaded({
      global_zip_settings: { zip_control_mode: 'agent', zip_ai_view_mode: 'appended' }
    })
    await chooseLayoutInline()
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_zip_settings.zip_control_mode).toBe('agent')
    expect(saves[0].body.global_zip_settings).not.toHaveProperty('zip_agent_control_enabled')
    expect(saves[0].body.global_zip_settings).not.toHaveProperty('zip_agent_control_experiment')
  })

  it('Reset to defaults writes a clean block: no experiment key (OFF) and no legacy keys', async () => {
    const saves = await renderLoaded({
      global_zip_settings: { zip_agent_control_experiment: true, zip_agent_control_enabled: true, zip_control_mode: 'agent' }
    })

    await fireEvent.click(await screen.findByRole('button', { name: /Reset to defaults/ }, { timeout: 5000 }))

    await waitFor(() => expect(saves).toHaveLength(1))
    const block = saves[0].body.global_zip_settings
    expect(block).not.toHaveProperty('zip_agent_control_experiment')
    expect(block).not.toHaveProperty('zip_agent_control_enabled')
    expect(block).not.toHaveProperty('zip_control_mode')
    expect(block).toMatchObject({ zip_ai_view_mode: 'appended', zip_tool_notes_enabled: true })
  })
})
