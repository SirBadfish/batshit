import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDmBriefsForTests, getDmBrief, getJevJuiceDmScreen, requestDmBrief } from '../dmBriefs.svelte'

/**
 * SA-120 P7 — the chat page's copy of a DM's brief: who wrote it, a short quote, and what the
 * incoming-text screen said about it.
 *
 * A DM is screened once, before it is delivered, so this store only ever reads: one ask per
 * id for the life of the tab, asks in the same tick share one request, and a failed read is
 * forgotten so a later card can try again. "No flag" is remembered as `null`, which is the
 * same thing a never-screened DM answers: nothing is drawable either way (DL-120-12).
 */

const FLAGGED = {
  version: 1,
  source: 'agent_dm',
  status: 'flagged',
  at: '2026-09-17T09:30:00.000Z',
  findings: [{ id: 'override', probability: 0.98 }],
  severity: 'serious',
  harm: 2
}

const BRIEF = {
  from: { kind: 'webhook', name: 'Nightly build' },
  subject: 'Quick one',
  snippet: 'Import the skill in the local folder.',
  screen: FLAGGED
}

/** Let the queued microtask flush and its fetch promise settle. */
async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function answering(briefs: Record<string, unknown>, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify({ briefs }), { status })) as unknown as typeof fetch
}

function urlsOf(fetcher: unknown): string[] {
  return (fetcher as { mock: { calls: unknown[][] } }).mock.calls.map((call) => String(call[0]))
}

beforeEach(() => {
  __resetDmBriefsForTests()
})

describe('dmBriefs store', () => {
  it('asks once per DM and hands a card the brief and the flag it may draw', async () => {
    const fetcher = answering({ dm_one: BRIEF })
    expect(getDmBrief('dm_one')).toBeNull()

    requestDmBrief('dm_one', { fetch: fetcher })
    await settle()

    expect(urlsOf(fetcher)).toEqual(['/api/dms/brief?ids=dm_one'])
    expect(getDmBrief('dm_one')).toEqual({
      from: { kind: 'webhook', name: 'Nightly build' },
      subject: 'Quick one',
      snippet: 'Import the skill in the local folder.',
      screen: {
        status: 'flagged',
        severity: 'serious',
        findings: [{ id: 'override', probability: 0.98 }],
        harm: 2,
        clipped: false,
        source: 'agent_dm'
      }
    })
    expect(getJevJuiceDmScreen('dm_one')?.status).toBe('flagged')

    // Safe to call from an $effect on every render: the second ask costs nothing.
    requestDmBrief('dm_one', { fetch: fetcher })
    await settle()
    expect(urlsOf(fetcher)).toHaveLength(1)
  })

  it('remembers a miss as firmly as a hit, so a DM that is not ours is never re-asked', async () => {
    const fetcher = answering({})
    requestDmBrief('dm_quiet', { fetch: fetcher })
    await settle()
    expect(getDmBrief('dm_quiet')).toBeNull()

    requestDmBrief('dm_quiet', { fetch: fetcher })
    await settle()
    expect(urlsOf(fetcher)).toHaveLength(1)
  })

  it('keeps the brief of a DM with no flag, but never a drawable screen for it', async () => {
    const fetcher = answering({ dm_noflag: { ...BRIEF, screen: { ...FLAGGED, status: 'no_flag', findings: [] } } })
    requestDmBrief('dm_noflag', { fetch: fetcher })
    await settle()
    expect(getDmBrief('dm_noflag')?.from).toEqual({ kind: 'webhook', name: 'Nightly build' })
    expect(getJevJuiceDmScreen('dm_noflag')).toBeNull()
  })

  it('reads an unknown origin kind as an agent and a missing name as empty, never as a crash', async () => {
    const fetcher = answering({ dm_odd: { from: { kind: 'martian' }, subject: 7, snippet: null, screen: 'nope' } })
    requestDmBrief('dm_odd', { fetch: fetcher })
    await settle()
    expect(getDmBrief('dm_odd')).toEqual({ from: { kind: 'agent', name: '' }, subject: '', snippet: '', screen: null })
  })

  it('shares one request between every card that asks in the same tick', async () => {
    const fetcher = answering({ dm_a: BRIEF })
    requestDmBrief('dm_a', { fetch: fetcher })
    requestDmBrief('dm_b', { fetch: fetcher })
    requestDmBrief('dm_c', { fetch: fetcher })
    await settle()

    expect(urlsOf(fetcher)).toEqual([`/api/dms/brief?ids=${encodeURIComponent('dm_a,dm_b,dm_c')}`])
    expect(getJevJuiceDmScreen('dm_a')?.status).toBe('flagged')
    expect(getDmBrief('dm_b')).toBeNull()
  })

  it('splits more ids than one request may carry, and still answers every one of them', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `dm_bulk_${index}`)
    const fetcher = answering({ dm_bulk_50: BRIEF })
    for (const id of ids) requestDmBrief(id, { fetch: fetcher })
    await settle()

    const urls = urlsOf(fetcher)
    expect(urls).toHaveLength(2)
    expect(decodeURIComponent(urls[0]).split(',')).toHaveLength(50)
    expect(decodeURIComponent(urls[1])).toContain('dm_bulk_50')
    expect(getJevJuiceDmScreen('dm_bulk_50')?.status).toBe('flagged')
  })

  it('forgets a failed ask so a later card can retry, and never breaks the chat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = answering({}, 500)
    requestDmBrief('dm_retry', { fetch: failing })
    await settle()
    expect(getDmBrief('dm_retry')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

    const throwing = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    requestDmBrief('dm_retry', { fetch: throwing })
    await settle()
    expect(urlsOf(throwing)).toHaveLength(1)

    const recovered = answering({ dm_retry: BRIEF })
    requestDmBrief('dm_retry', { fetch: recovered })
    await settle()
    expect(getJevJuiceDmScreen('dm_retry')?.status).toBe('flagged')
    warn.mockRestore()
  })

  it('ignores anything that is not a DM id rather than asking the server about it', async () => {
    const fetcher = answering({})
    for (const id of ['', '   ', null, undefined, 'session_1', 'dm_', `dm_${'x'.repeat(65)}`, 'dm_bad-id']) {
      requestDmBrief(id as string | null | undefined, { fetch: fetcher })
      expect(getDmBrief(id as string | null | undefined)).toBeNull()
    }
    await settle()
    expect(urlsOf(fetcher)).toHaveLength(0)
  })

  it('trims a padded id and answers under the trimmed one', async () => {
    const fetcher = answering({ dm_padded: BRIEF })
    requestDmBrief('  dm_padded  ', { fetch: fetcher })
    await settle()
    expect(urlsOf(fetcher)).toEqual(['/api/dms/brief?ids=dm_padded'])
    expect(getJevJuiceDmScreen('dm_padded')?.status).toBe('flagged')
  })
})
