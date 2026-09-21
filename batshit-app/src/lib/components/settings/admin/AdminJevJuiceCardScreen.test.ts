import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminJevJuiceCard from './AdminJevJuiceCard.svelte'
import { JEV_INCOMING_TEXT_SCREEN_LABEL } from '$lib/utils/jevJuiceControl'

/**
 * SA-120 P7 — the one instance switch **Screen Incoming Text** (LS-057) on the Admin card
 * (no "Jev Juice:" prefix there, Josh 2026-09-17: the card is the feature's name), under the same Settings Auto-Save Contract as the rest of it: hydration must
 * never save, and one flip saves once, carrying the whole config rather than one field.
 */

type FetchCall = { url: string; init?: RequestInit }

function installFetch(stored: { enabled?: boolean; screenIncomingText?: boolean } = {}) {
  const calls: FetchCall[] = []
  const config = {
    enabled: stored.enabled ?? true,
    modelId: 'jev-1.13.0',
    attemptTimeoutMs: 5000,
    inChatWaitMs: 750,
    screenIncomingText: stored.screenIncomingText ?? false,
    updatedAt: null
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    if (url.endsWith('/api/settings/typesafe') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: { ...config, ...body, updatedAt: 'now' }, key: { present: true, source: 'user' } })
      }
    }
    if (url.endsWith('/api/settings/typesafe')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          config,
          key: { present: true, source: 'user' },
          limits: {
            pinnedModelId: 'jev-1.13.0',
            attemptTimeoutMinMs: 500,
            attemptTimeoutMaxMs: 30000,
            inChatWaitMinMs: 200,
            inChatWaitMaxMs: 30000
          }
        })
      }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  // @ts-expect-error test override
  global.fetch = fetchMock
  return { calls }
}

const putBodies = (calls: FetchCall[]) =>
  calls.filter((call) => call.init?.method === 'PUT').map((call) => JSON.parse(String(call.init?.body)))

async function screenSwitch() {
  const toggle = await screen.findByRole('switch', { name: new RegExp(JEV_INCOMING_TEXT_SCREEN_LABEL, 'i') })
  await waitFor(() => expect(toggle).not.toBeDisabled())
  return toggle
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AdminJevJuiceCard: Screen Incoming Text', () => {
  it('hydrates from the saved config without saving', async () => {
    const { calls } = installFetch({ screenIncomingText: true })
    render(AdminJevJuiceCard)

    const toggle = await screenSwitch()
    expect(toggle.getAttribute('data-state')).toBe('checked')
    expect(toggle.id).toBe('jev-juice-screen-incoming-text')
    expect(JEV_INCOMING_TEXT_SCREEN_LABEL).toBe('Screen Incoming Text')
    expect(screen.queryByText('Jev Juice: Screen Incoming Text')).toBeNull()
    // Give any hydration-triggered autosave a chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(putBodies(calls)).toHaveLength(0)
  })

  it('starts off when nothing is stored, and saves exactly once when it is turned on', async () => {
    const { calls } = installFetch()
    render(AdminJevJuiceCard)

    const toggle = await screenSwitch()
    expect(toggle.getAttribute('data-state')).toBe('unchecked')

    await fireEvent.click(toggle)
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1), { timeout: 3000 })
    // The card saves the whole config, not one field: a partial write would drop the rest.
    expect(putBodies(calls)[0]).toEqual({
      enabled: true,
      modelId: 'jev-1.13.0',
      attemptTimeoutMs: 5000,
      inChatWaitMs: 750,
      screenIncomingText: true
    })
    await screen.findByText('Saved')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(putBodies(calls)).toHaveLength(1)
  })

  it('turns back off and saves that, so the switch can be undone', async () => {
    const { calls } = installFetch({ screenIncomingText: true })
    render(AdminJevJuiceCard)

    await fireEvent.click(await screenSwitch())
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1), { timeout: 3000 })
    expect(putBodies(calls)[0].screenIncomingText).toBe(false)
  })
})
