import { describe, it, expect, vi } from 'vitest'

vi.mock('./api', () => ({
  api: {
    getZip: vi.fn(async () => null),
    getZips: vi.fn(async () => new Map())
  }
}))

vi.mock('$lib/services/zipping', () => ({
  zippingService: {
    isUnzipped: vi.fn(() => false),
    isRezipped: vi.fn(() => false)
  }
}))

import { compileForAI, compileForUserBatch } from './messageCompiler'
import { buildSteerPlaceholder, type DeliveredSteer } from '$lib/utils/steerControl'

/**
 * SA-114 P1 (DL-114-04) — the steer placeholder, expanded by BOTH compilers.
 *
 * The text lives in `metadata.steers[]` rather than inside the marker, which is the same
 * split the zip family uses. It is what lets one assistant record carry a steer while its
 * compiled history stays byte-identical from the moment it is written.
 */

const steer = (overrides: Partial<DeliveredSteer> = {}): DeliveredSteer => ({
  steerId: 'steer_abc',
  messageId: 'msg_1',
  text: 'also run the tests',
  at: '2026-09-10T12:00:00.000Z',
  source: 'user',
  step: 1,
  lane: 'api',
  ...overrides
})

const messageWith = (steers: DeliveredSteer[]) => ({
  id: 'msg_1',
  metadata: { steers }
})

describe('steer placeholder compilation', () => {
  it('reads to the model as the user’s own words', async () => {
    const content = `Looking at the tests now.\n\n${buildSteerPlaceholder('steer_abc')}\n\nDone.`
    const result = await compileForAI(content, 0, 1, {}, messageWith([steer()]), {})

    expect(result).toContain('[The user said, mid-reply: also run the tests]')
    expect(result).not.toContain('batshit-steer')
  })

  it('marks a DM steer as NOT from the user (DL-114-13)', async () => {
    const content = buildSteerPlaceholder('steer_dm')
    const result = await compileForAI(
      content,
      0,
      1,
      {},
      messageWith([
        steer({ steerId: 'steer_dm', source: 'dm', dmId: 'dm_1', label: 'Cooper', text: 'build is red' })
      ]),
      {}
    )

    expect(result).toContain(
      '[Agent DM — from Cooper, not from the user, delivered mid-reply: build is red]'
    )
    expect(result).not.toContain('The user said')
  })

  it('shows the user their own words as an inset inside the reply (P3)', async () => {
    const content = `Working.\n\n${buildSteerPlaceholder('steer_abc')}\n\nDone.`
    const result = await compileForUserBatch(content, { steers: [steer()] })

    expect(result).toContain('<div class="batshit-steer-inset">')
    expect(result).toContain('<span class="batshit-steer-inset-label">You, mid-reply</span>')
    expect(result).toContain('also run the tests')
    // P1 rendered a blockquote here; P3 replaced it with the inset (DL-114-04).
    expect(result).not.toContain('> **You said, mid-reply:**')
    expect(result).not.toContain('batshit-steer:')
  })

  it('escapes the inset text and keeps it inside one HTML block (P3)', async () => {
    const content = buildSteerPlaceholder('steer_abc')
    const result = await compileForUserBatch(content, {
      steers: [steer({ text: '<img src=x onerror=alert(1)>\n\nsecond paragraph' })]
    })

    expect(result).not.toContain('<img')
    expect(result).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // marked ends an HTML block at the first BLANK line, so newlines become <br> or the
    // second half of the steer would spill out of the bubble as loose markdown.
    expect(result).toContain('<br><br>second paragraph')
    expect(result.split('\n').filter((line) => line.trim() === '').length).toBe(0)
  })

  it('marks a DM-sourced inset as not from the user (P3)', async () => {
    const content = buildSteerPlaceholder('steer_dm')
    const result = await compileForUserBatch(content, {
      steers: [steer({ steerId: 'steer_dm', source: 'dm', dmId: 'dm_1', label: 'Cooper' })]
    })

    expect(result).toContain('class="batshit-steer-inset is-dm"')
    expect(result).toContain('Agent DM from Cooper, mid-reply')
  })

  it('never leaves raw braces in either view when the text is gone', async () => {
    const content = buildSteerPlaceholder('steer_missing')

    const forAi = await compileForAI(content, 0, 1, {}, messageWith([]), {})
    const forUser = await compileForUserBatch(content, { steers: [] })

    for (const result of [forAi, forUser]) {
      expect(result).not.toContain('{{batshit-steer:')
      expect(result).toContain('A message arrived mid-reply')
    }
  })

  it('leaves exactly one blank line around the expansion', async () => {
    // Measured on BSMS 2026-09-10: the stored content already separates the marker from
    // the tool zips before it, so an expansion that adds its own newlines without eating
    // those grew a four-newline gap in every later compile.
    const content = `{{batshit-zip:cool_tool_1_aaaaa}}\n\n${buildSteerPlaceholder('steer_abc')}PINEAPPLE.`
    const result = await compileForAI(content, 0, 1, {}, messageWith([steer()]), {})

    expect(result).not.toMatch(/\n{3}/)
    expect(result).toContain('\n\n[The user said, mid-reply: also run the tests]\n\nPINEAPPLE.')
  })

  it('keeps one blank line between two steers that landed at the same boundary (F-P1-4)', async () => {
    // Five steers accepted before one boundary are stored as consecutive markers, each
    // separated by a blank line (T3 on BSMS). The gap-eating regex consumes the blank line
    // AFTER the first marker, so the second expansion's own leading newlines doubled up.
    const content = `{{batshit-zip:cool_tool_1_aaaaa}}\n\n${buildSteerPlaceholder('s1')}\n\n${buildSteerPlaceholder('s2')}\n\n${buildSteerPlaceholder('s3')}PINEAPPLE.`
    const result = await compileForAI(
      content,
      0,
      1,
      {},
      messageWith([
        steer({ steerId: 's1', text: 'first' }),
        steer({ steerId: 's2', text: 'second' }),
        steer({ steerId: 's3', text: 'third' })
      ]),
      {}
    )

    expect(result).not.toMatch(/\n{3}/)
    expect(result).toContain(
      '[The user said, mid-reply: first]\n\n[The user said, mid-reply: second]\n\n[The user said, mid-reply: third]\n\nPINEAPPLE.'
    )
  })

  it('does not add a blank line the stored message never had', async () => {
    const onlyMarker = buildSteerPlaceholder('steer_abc')
    const result = await compileForAI(onlyMarker, 0, 1, {}, messageWith([steer()]), {})
    expect(result).toBe('[The user said, mid-reply: also run the tests]')
  })

  it('leaves content with no steer marker byte-identical', async () => {
    const content = 'An ordinary reply with no steer in it.'
    expect(await compileForAI(content, 0, 1, {}, messageWith([]), {})).toBe(content)
    expect(await compileForUserBatch(content)).toBe(content)
  })

  it('expands several markers in the order they appear', async () => {
    const content = `${buildSteerPlaceholder('s1')} middle ${buildSteerPlaceholder('s2')}`
    const result = await compileForAI(
      content,
      0,
      1,
      {},
      messageWith([
        steer({ steerId: 's1', text: 'first' }),
        steer({ steerId: 's2', text: 'second' })
      ]),
      {}
    )

    expect(result.indexOf('first')).toBeLessThan(result.indexOf('middle'))
    expect(result.indexOf('middle')).toBeLessThan(result.indexOf('second'))
  })

  it('ignores a malformed steers entry rather than throwing', async () => {
    const content = buildSteerPlaceholder('steer_abc')
    const result = await compileForAI(
      content,
      0,
      1,
      {},
      { id: 'msg_1', metadata: { steers: [null, { steerId: 'steer_abc' }, 'nonsense'] } },
      {}
    )

    expect(result).toContain('A message arrived mid-reply')
  })
})
