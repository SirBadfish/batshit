import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import MemoryRecordDetail from './MemoryRecordDetail.svelte'

/**
 * BL-437: the Memory Panel's Save used to send `expires_at` on every save, rebuilt from the
 * date part as UTC midnight, so editing only the importance of an Awareness memory moved its
 * expiry earlier (often into the past), and a picked date expired the afternoon before.
 *
 * The suite runs in a fixed time zone west of UTC (Pacific), where UTC midnight is the
 * previous local afternoon; the offset guard below fails loudly if the zone did not apply.
 */

const PREVIOUS_TZ = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles'
})

afterAll(() => {
  if (PREVIOUS_TZ === undefined) delete process.env.TZ
  else process.env.TZ = PREVIOUS_TZ
})

afterEach(() => vi.restoreAllMocks())

// Oct 1, 2026 at 10:30 PM Pacific (PDT, UTC-7): a late-evening expiry.
const LATE_EVENING_EXPIRY = '2026-10-02T05:30:00.000Z'

function awarenessRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem_1790000000000_ssmem1',
    agent_id: 'agent_ssmem',
    lane: 'awareness',
    content: 'Josh is traveling until the end of October 1.',
    importance: 5,
    expires_at: LATE_EVENING_EXPIRY,
    expires_ts: Date.parse(LATE_EVENING_EXPIRY),
    is_superseded: 'n',
    provenance: [],
    media: [],
    ...overrides
  }
}

function renderDetail(record = awarenessRecord()) {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ record }), { status: 200 }))
  const onChanged = vi.fn()
  const view = render(MemoryRecordDetail, {
    props: {
      agentId: 'agent_ssmem',
      detail: { record, standingMediaCount: 0, chain: { predecessors: [], successors: [] } },
      onChanged,
      onDeleted: vi.fn()
    }
  })
  return { fetchSpy, onChanged, view }
}

async function saveAndReadUpdates(fetchSpy: ReturnType<typeof vi.spyOn>): Promise<Record<string, unknown>> {
  await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('/api/memory/manage/record')
  expect(init.method).toBe('PATCH')
  return JSON.parse(String(init.body)).updates
}

function dateInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="date"]')
  expect(input).not.toBeNull()
  return input as HTMLInputElement
}

describe('MemoryRecordDetail expiry (BL-437)', () => {
  it('runs in a zone west of UTC, so UTC midnight is the previous local afternoon', () => {
    expect(new Date('2026-10-01T12:00:00.000Z').getTimezoneOffset()).toBe(420)
  })

  it('shows the local date the stored expiry falls on', () => {
    const { view } = renderDetail()
    // 05:30 UTC on Oct 2 is 10:30 PM on Oct 1 in Pacific time.
    expect(dateInput(view.container).value).toBe('2026-10-01')
  })

  it('saving only the importance sends no expires_at, so the stored expiry stays as it is', async () => {
    const { fetchSpy, view } = renderDetail()
    const importance = view.container.querySelector('input[type="number"]') as HTMLInputElement
    expect(importance).not.toBeNull()
    await fireEvent.input(importance, { target: { value: '8' } })

    const updates = await saveAndReadUpdates(fetchSpy)
    expect(updates.importance).toBe(8)
    expect(Object.prototype.hasOwnProperty.call(updates, 'expires_at')).toBe(false)
  })

  it('a picked date expires at the end of that local day, not the afternoon before', async () => {
    const { fetchSpy, view } = renderDetail(awarenessRecord({ expires_at: undefined, expires_ts: undefined }))
    await fireEvent.input(dateInput(view.container), { target: { value: '2026-10-01' } })

    const updates = await saveAndReadUpdates(fetchSpy)
    const sent = Date.parse(String(updates.expires_at))
    const localEndOfOct1 = new Date(2026, 9, 1, 23, 59, 59, 999).getTime()
    const localStartOfOct2 = new Date(2026, 9, 2, 0, 0, 0, 0).getTime()
    expect(sent).toBeGreaterThanOrEqual(localEndOfOct1)
    // Still Oct 1 locally, so the picker shows the date the user chose after the save.
    expect(sent).toBeLessThan(localStartOfOct2)
    expect(updates.expires_at).toBe('2026-10-02T06:59:59.999Z')
  })

  it('clearing the date sends expires_at null', async () => {
    const { fetchSpy, view } = renderDetail()
    await fireEvent.input(dateInput(view.container), { target: { value: '' } })

    const updates = await saveAndReadUpdates(fetchSpy)
    expect(updates.expires_at).toBeNull()
  })
})

describe('MemoryRecordDetail repeated final-hour expiry (BL-1237)', () => {
  async function inSantiago(check: () => Promise<void>) {
    const previous = process.env.TZ
    process.env.TZ = 'America/Santiago'
    try {
      expect(new Date('2026-04-05T02:30:00.000Z').getTimezoneOffset()).toBe(180)
      expect(new Date('2026-04-05T03:30:00.000Z').getTimezoneOffset()).toBe(240)
      await check()
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  }

  it('a newly picked date sends the end of the second final hour', async () => {
    await inSantiago(async () => {
      const { fetchSpy, view } = renderDetail(awarenessRecord({ expires_at: undefined, expires_ts: undefined }))
      await fireEvent.input(dateInput(view.container), { target: { value: '2026-04-04' } })
      const updates = await saveAndReadUpdates(fetchSpy)
      expect(updates.expires_at).toBe('2026-04-05T03:59:59.999Z')
      // MemorySettingsPanel's detailLoading branch remounts the saved detail after onChanged.
      view.unmount()
      const saved = renderDetail(awarenessRecord({
        expires_at: updates.expires_at,
        expires_ts: Date.parse(String(updates.expires_at))
      }))
      expect(dateInput(saved.view.container).value).toBe('2026-04-04')
    })
  })

  it('saving importance leaves an old first-hour expiry out of the request', async () => {
    await inSantiago(async () => {
      const oldExpiry = '2026-04-05T02:59:59.999Z'
      const { fetchSpy, view } = renderDetail(awarenessRecord({
        expires_at: oldExpiry,
        expires_ts: Date.parse(oldExpiry)
      }))
      expect(dateInput(view.container).value).toBe('2026-04-04')
      const importance = view.container.querySelector('input[type="number"]') as HTMLInputElement
      await fireEvent.input(importance, { target: { value: '8' } })
      const updates = await saveAndReadUpdates(fetchSpy)
      expect(updates.importance).toBe(8)
      expect(Object.prototype.hasOwnProperty.call(updates, 'expires_at')).toBe(false)
    })
  })
})

// BL-447: the detail loader marks a provenance entry whose chat is gone (`source_deleted`);
// the "Where It Came From" list says so beside that entry and no other.
describe('MemoryRecordDetail provenance of a deleted chat (BL-447)', () => {
  it('says "(original chat deleted)" only beside the entry whose chat is gone', () => {
    const { view } = renderDetail(awarenessRecord({
      provenance: [
        { session_id: 'chat-still-here', source: 'agent' },
        { session_id: 'chat-deleted', source: 'agent', quote: 'until the end of October 1', source_deleted: true }
      ]
    }))
    const lines = Array.from(view.container.querySelectorAll('.memory-detail-provenance p'))
    expect(lines).toHaveLength(2)
    expect(lines[0].textContent).toContain('chat-still-here')
    expect(lines[0].textContent).not.toContain('(original chat deleted)')
    expect(lines[1].textContent).toContain('chat-deleted')
    expect(lines[1].textContent).toContain('(original chat deleted)')
    expect(lines[1].textContent).toContain('until the end of October 1')
  })
})
