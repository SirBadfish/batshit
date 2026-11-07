import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import GlobalToolGrid from '../GlobalToolGrid.svelte'

/** Typed File Tools is per-agent only. Global zip/display saves never reintroduce inheritance. */

// The Batshit Tools section opens with a slide; jsdom has no Web Animations, so each animation
// finishes on the next tick.
if (typeof Element.prototype.animate !== 'function') {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => {
      let onfinish: (() => void) | null = null
      return {
        cancel() {},
        finish() {},
        play() {},
        pause() {},
        get onfinish() {
          return onfinish
        },
        set onfinish(handler: (() => void) | null) {
          onfinish = handler
          setTimeout(() => handler?.(), 0)
        }
      }
    }
  })
}

type Saved = { url: string; body: any }

function stubFetch(settings: Record<string, unknown>) {
  let persisted = settings
  const saves: Saved[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/user/settings' && method === 'GET') {
        return new Response(JSON.stringify({ settings: persisted }), { status: 200 })
      }
      if (url === '/api/user/settings' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        saves.push({ url, body })
        persisted = { ...persisted, ...body }
        return new Response(JSON.stringify({ success: true, settings: persisted }), { status: 200 })
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
  const trigger = label?.querySelector('.batshit-settings-select-compact')
  if (!trigger) throw new Error(`${labelText} select not found`)
  return trigger as HTMLElement
}

async function choose(labelText: string, optionName: string) {
  await fireEvent.keyDown(selectTrigger(labelText), { key: 'ArrowDown' })
  const option = await screen.findByRole('option', { name: optionName, exact: true })
  await fireEvent.pointerUp(option, { pointerType: 'mouse' })
}

async function renderLoaded(settings: Record<string, unknown>) {
  const saves = stubFetch(settings)
  render(GlobalToolGrid, { props: { userId: 'typed_grid_user' } })
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/user/settings'))
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).toBeNull())

  return saves
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Global Tool Grid retires the global typed-file grant', () => {
  it('has no global grant/default control and saves no execution grant when another choice changes', async () => {
    const saves = await renderLoaded({ global_zip_settings: { zip_ai_view_mode: 'appended' } })
    expect(screen.queryByText('Typed File Tools', { selector: '.batshit-settings-form-label' })).toBeNull()
    expect(saves).toEqual([])
    await choose('AI Zip Layout', 'Inline')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_tool_grid_settings).not.toHaveProperty('typed_file_tools')
  })
  it('does not serialize a stale retired field from a loaded snapshot on ordinary save or reset', async () => {
    const saves = await renderLoaded({ global_tool_grid_settings: { typed_file_tools: true } })
    expect(screen.queryByText('Typed File Tools', { selector: '.batshit-settings-form-label' })).toBeNull()
    await choose('AI Zip Layout', 'Inline')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0].body.global_tool_grid_settings).not.toHaveProperty('typed_file_tools')
    await fireEvent.click(await screen.findByRole('button', { name: /Reset to defaults/ }, { timeout: 5000 }))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1].body.global_tool_grid_settings).not.toHaveProperty('typed_file_tools')
  })
})
