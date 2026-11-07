import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PortableSkillsSettingsPanel from './PortableSkillsSettingsPanel.svelte'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'

// BL-341: the copy-ready `.env` snippet names the Batshit this page is on (the native lane is
// 5621, Pinokio 5650), never a fixed 5620. jsdom serves the page from its own address, which is
// not 5620, so a hard-coded port shows here.

// Synthetic portable-token fixture; keep the displayed prefix/suffix and exact value.
const TOKEN = ['bspt','bl341','rotated','secret'].join('_')
const RECORD = {
  id: 'pst_bl341',
  label: 'Artifacts Token',
  families: ['artifacts'],
  tokenPrefix: 'bspt_bl3',
  tokenSuffix: 'cret',
  createdAt: '2026-10-11T15:00:00.000Z',
  updatedAt: '2026-10-11T15:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/portable-skills/tokens' && !init?.method) {
        return okJson({ success: true, tokens: [RECORD], families: [], envTemplates: [] })
      }
      if (url.endsWith('/rotate') && init?.method === 'POST') {
        return okJson({ success: true, token: TOKEN, record: RECORD, families: [], envTemplates: [] })
      }
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`)
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BL-341: the Portable Skills env snippet uses the app origin', () => {
  it('names this page origin, with localhost written as 127.0.0.1', async () => {
    render(PortableSkillsSettingsPanel, { props: { embedded: true } })
    await fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }))

    const snippet = await waitFor(() => {
      const code = Array.from(document.querySelectorAll('pre code')).find((node) =>
        node.textContent?.includes('BATSHIT_PORTABLE_TOKEN=')
      )
      expect(code).toBeTruthy()
      return code!.textContent ?? ''
    })

    const { protocol, hostname, port } = window.location
    expect(port).not.toBe('5620')
    const host = hostname === 'localhost' ? '127.0.0.1' : hostname
    expect(snippet).toBe(
      `BATSHIT_BASE_URL=${protocol}//${host}${port ? `:${port}` : ''}\nBATSHIT_PORTABLE_TOKEN=${TOKEN}\n`
    )
  })

  it('adds App Actions through the separate explicit grant save and refreshes the token family label', async () => {
    let granted = false
    const writes: Array<{ path: string; body: any }> = []
    const initialExpiry = new Date(Date.now() + 3600000).toISOString()
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/portable-skills/tokens') return okJson({ success: true, tokens: [{ ...RECORD, families: granted ? ['artifacts', 'app-actions'] : ['artifacts'] }], families: [{ id: 'artifacts', label: 'Artifacts', controlIds: [] }, { id: 'app-actions', label: 'App Actions', controlIds: [] }], envTemplates: [] })
      if (path === `/api/portable-skills/tokens/${RECORD.id}/app-actions-grant`) {
        if (init?.method === 'PUT') { writes.push({ path, body: JSON.parse(String(init.body)) }); granted = true }
        return okJson({ success: true, tokenId: RECORD.id, authorityGeneration: granted ? 2 : 1, grant: granted ? { policy: { ...defaultAppActionsPolicy(true), enabled: true }, expiresAt: initialExpiry } : null, subjects: [] })
      }
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${path}`)
    })
    render(PortableSkillsSettingsPanel, { props: { embedded: true } })
    const disclosure = await screen.findByText('App Actions Access', { selector: 'summary' })
    const details = disclosure.parentElement as HTMLDetailsElement
    details.open = true; await fireEvent(details, new Event('toggle'))
    await fireEvent.click(await screen.findByRole('switch', { name: 'Enable App Actions' }))
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Save Portable App Actions Access' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body.expectedAuthorityGeneration).toBe(1)
    expect(Object.keys(writes[0].body).sort()).toEqual(['expectedAuthorityGeneration', 'grant'])
    expect(await screen.findByText('App Actions', { selector: '[data-slot="badge"]' })).toBeTruthy()
    expect(screen.getAllByText('Artifacts', { selector: '[data-slot="badge"]' }).length).toBeGreaterThan(0)
  })
})
