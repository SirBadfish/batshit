import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PortableSkillsSettingsPanel from './PortableSkillsSettingsPanel.svelte'

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
})
