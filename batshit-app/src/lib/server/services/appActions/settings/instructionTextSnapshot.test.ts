import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { INSTRUCTION_LIMITS } from '$lib/appActions/settings/instructionPreferences'
import { SETTINGS_REPORT_BYTE_LIMITS } from '$lib/appActions/settings/reportContract'
import { withSettingsRecordReplacement } from './lifecycle'
import { createInstructionTextPages, INSTRUCTION_TEXT_READ_SCRIPT, readInstructionTextSnapshot, type InstructionTextReader } from './instructionTextSnapshot'

const subject = { kind: 'primary' as const, id: 'p' }, owner = 'owner'
const raw = (value: unknown) => JSON.stringify([value])
function reply(text: string | null | undefined = 'Hello 🌊') {
  return ['OK', raw(subject.id), raw(owner), raw('api'), raw('2026-10-17T00:00:00.000Z'), 'absent', '[]',
    text === undefined ? 'absent' : text === null ? 'null' : 'string', typeof text === 'string' ? Buffer.byteLength(text) : 0, text === undefined ? '[]' : raw(text)]
}
const read = (text: string | null | undefined, includeText = true) => readInstructionTextSnapshot(subject, owner, async () => reply(text), { includeText })

describe('bounded fixed instruction text snapshots', () => {
  it('issues one fixed reader with exact owner/type and retains no text/raw prompt in metadata', async () => {
    const source = vi.fn(async () => reply('🌊é'))
    const result = await readInstructionTextSnapshot(subject, owner, source, { includeText: false })
    expect(source).toHaveBeenCalledOnce()
    expect(source).toHaveBeenCalledWith(INSTRUCTION_TEXT_READ_SCRIPT, { keys: ['agent:p'], arguments: ['$.agentType', 'p', owner, '1'] })
    expect(result.customPrompt).toEqual({ stored: 'set', codeUnits: 4, utf8Bytes: 7, read: 'available' })
    expect(result.promptPreimage).toBe(`sha256:${createHash('sha256').update(raw('🌊é')).digest('hex')}`)
    expect(result.text).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('🌊é')
    expect(result.raw.map(([path]) => path)).toEqual(['$.id', '$.user_id', '$.agentType', '$.created_at', '$.include_global_prompt'])
    expect(result.record).not.toHaveProperty('system_prompt')
  })
  it('retains exact explicitly read prompt raw preimages and different null/absent states', async () => {
    const present = await read(' exact\n ')
    expect(present.text).toBe(' exact\n ')
    expect(present.raw.at(-1)).toEqual(['$.system_prompt', raw(' exact\n ')])
    const nullResult = await read(null)
    expect(nullResult.customPrompt).toMatchObject({ stored: 'unset', representation: 'null' })
    expect(nullResult.raw.at(-1)).toEqual(['$.system_prompt', '[null]'])
    expect(nullResult.promptPreimage).toBe(`sha256:${createHash('sha256').update('[null]').digest('hex')}`)
    const absent = reply(); absent[7] = 'absent'; absent[8] = 0; absent[9] = '[]'
    const absentResult = await readInstructionTextSnapshot(subject, owner, async () => absent, { includeText: true })
    expect(absentResult.customPrompt).toMatchObject({ stored: 'unset', representation: 'absent' })
    expect(absentResult.raw.at(-1)).toEqual(['$.system_prompt', '[]'])
    expect(absentResult.promptPreimage).toBe(`sha256:${createHash('sha256').update('[]').digest('hex')}`)
    expect(absentResult.promptPreimage).not.toBe(nullResult.promptPreimage)
  })
  it('keeps oversize counts honestly unknown without a fetched prompt and malformed values invalid', async () => {
    const oversized = reply(); oversized[8] = INSTRUCTION_LIMITS.readSnapshotBytes + 1; oversized[9] = ''
    const result = await readInstructionTextSnapshot(subject, owner, async () => oversized, { includeText: true })
    expect(result.customPrompt).toEqual({ stored: 'set', codeUnits: null, utf8Bytes: INSTRUCTION_LIMITS.readSnapshotBytes + 1, read: 'too_large' })
    expect(result.text).toBeUndefined(); expect(result.raw.some(([path]) => path === '$.system_prompt')).toBe(false)
    expect(result.promptPreimage).toBeUndefined()
    expect(() => createInstructionTextPages(result)).toThrow('unavailable')
    const invalid = reply(); invalid[5] = 'invalid'; invalid[6] = ''; invalid[7] = 'invalid'; invalid[8] = 0; invalid[9] = ''
    const unavailable = await readInstructionTextSnapshot(subject, owner, async () => invalid, { includeText: false })
    expect(unavailable.customPrompt).toMatchObject({ stored: 'invalid', read: 'unavailable' })
    expect(unavailable.record.include_global_prompt).toEqual({ invalid: true })
    expect(unavailable.raw.some(([path]) => path === '$.include_global_prompt')).toBe(false)
  })
  it('captures prompt-disabled intent before await and never exposes later-mutated disclosure options', async () => {
    const options = { includeText: false, prompt: false }, input = { ...subject }
    const disabled = reply(); disabled[7] = 'disabled'; disabled[8] = 0; disabled[9] = ''
    let resolve!: (value: unknown) => void
    const source = vi.fn<InstructionTextReader>(() => new Promise<unknown>(done => { resolve = done }))
    const pending = readInstructionTextSnapshot(input, owner, source, options)
    options.includeText = true; options.prompt = true; input.id = 'other'
    resolve(disabled)
    const result = await pending
    expect(source.mock.calls[0][1]).toEqual({ keys: ['agent:p'], arguments: ['$.agentType', 'p', owner, '0'] })
    expect(result.subject.id).toBe('p'); expect(result.customPrompt).toBeUndefined(); expect(result.text).toBeUndefined()
  })
  it('rejects malformed replies, fake byte counts, wrong owners and lifecycle replacement during a read', async () => {
    for (const value of [null, ['UNAVAILABLE'], [...reply(), 'extra'], (() => { const r = reply(); r[2] = raw('foreign'); return r })(),
      (() => { const r = reply(); r[8] = 1; return r })(), (() => { const r = reply(); r[1] = raw('x'.repeat(1025)); return r })()]) {
      await expect(readInstructionTextSnapshot(subject, owner, async () => value, { includeText: false })).rejects.toThrow('unavailable')
    }
    const failure = new Error('source failed')
    await expect(readInstructionTextSnapshot(subject, owner, async () => { throw failure }, { includeText: true })).rejects.toBe(failure)
    let resolve!: (value: unknown) => void
    const pending = readInstructionTextSnapshot(subject, owner, () => new Promise(done => { resolve = done }), { includeText: true })
    await withSettingsRecordReplacement('agent:p', async () => {})
    resolve(reply())
    await expect(pending).rejects.toThrow('identity changed')
  })
})

describe('immutable code-point-safe complete instruction text pages', () => {
  it('pages every exact character with complete UTF16 accounting inside the full wrapper budget', async () => {
    const text = ('🌊\n"\\é').repeat(12000), source = vi.fn(async () => reply(text))
    const snapshot = await readInstructionTextSnapshot(subject, owner, source, { includeText: true })
    const pages = createInstructionTextPages(snapshot, { reservedBytes: 1024, observedAt: '2026-10-17T00:00:00.000Z' })
    const chunks: string[] = []
    let cursor: string | undefined, offset = 0, count = 0
    do {
      const page = pages.page(cursor)
      expect(Buffer.byteLength(JSON.stringify(page)) + 1024).toBeLessThanOrEqual(SETTINGS_REPORT_BYTE_LIMITS.values)
      expect(JSON.stringify(page)).not.toContain('promptPreimage')
      expect(JSON.stringify(page)).not.toContain(snapshot.promptPreimage!)
      expect(page.text!.isWellFormed()).toBe(true)
      expect(page.continuation.offsetCodeUnits).toBe(offset)
      expect(page.continuation.returnedCodeUnits).toBe(page.text!.length)
      offset += page.text!.length; chunks.push(page.text!)
      expect(page.continuation.remainingCodeUnits).toBe(text.length - offset)
      cursor = page.continuation.nextCursor ?? undefined; count++
    } while (cursor)
    expect(count).toBeGreaterThan(1); expect(chunks.join('')).toBe(text); expect(offset).toBe(text.length)
    expect(source).toHaveBeenCalledOnce()
    expect(pages.page()).toEqual(pages.page())
    expect(() => { (pages.page().subject as any).id = 'changed' }).toThrow()
  })
  it('binds cursor to exact immutable snapshot and rejects surrogate-interior offsets and insufficient budget', async () => {
    const snapshot = await read('🌊one'), pages = createInstructionTextPages(snapshot)
    expect(() => pages.page(`si1:${pages.snapshotId}:1`)).toThrow('mismatch')
    expect(() => pages.page(`si1:${'a'.repeat(64)}:2`)).toThrow('mismatch')
    expect(() => pages.page(`si1:${pages.snapshotId}:999999`)).toThrow('mismatch')
    expect(() => pages.page('sr1:wrong:0')).toThrow('cursor')
    expect(() => createInstructionTextPages(snapshot, { reservedBytes: 24575 }).page()).toThrow('budget')
    expect(() => createInstructionTextPages(snapshot, { reservedBytes: -1 })).toThrow('budget')
    const metadata = await read('secret', false)
    expect(() => createInstructionTextPages(metadata)).toThrow('unavailable')
  })
  it('returns complete empty and null snapshots without invented text or continuation', async () => {
    for (const text of ['', null]) {
      const page = createInstructionTextPages(await read(text)).page()
      expect(page.text).toBe(text)
      expect(page.continuation).toEqual({ totalCodeUnits: 0, offsetCodeUnits: 0, returnedCodeUnits: 0, remainingCodeUnits: 0, nextCursor: null })
    }
  })
})
