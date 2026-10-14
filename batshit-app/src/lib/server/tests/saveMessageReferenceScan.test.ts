import { describe, expect, it, vi } from 'vitest'
import { unclosedReferenceReplies } from '$lib/test-utils/unclosedReferenceReplies'

/**
 * `saveMessage` (the real facade in `$lib/server/redis.ts`, its client stubbed: the claim is CPU,
 * not Redis) cleans every message it saves, the reply-end save included, with `dedupeZipRefs`:
 * it drops `{{TOOL_LOADING_PLACEHOLDER:…}}` tokens and repeats of a `{{batshit-zip:…}}` token.
 * Its two patterns searched to the first `}` again from every opener, about 30 s of the one Node
 * process for 20,000 openers in 1 MB that never close. `braceScan.ts` reads them once now.
 */

/** The literal cleanup `dedupeZipRefs` did with its old patterns, kept here as the oracle. */
function oldDedupeZipRefs(text: string): string {
  let cleaned = text.replace(/\{\{TOOL_LOADING_PLACEHOLDER:[^}]+\}\}/g, '')
  const seen = new Set<string>()
  cleaned = cleaned.replace(/\{\{batshit-zip:[^}]+\}\}/g, (match) => {
    if (seen.has(match)) return ''
    seen.add(match)
    return match
  })
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

async function stubbedRedisService() {
  const { RedisService } = await vi.importActual<typeof import('$lib/server/redis')>(
    '$lib/server/redis'
  )
  const service = new RedisService()
  const saved: any[] = []
  const client = {
    exists: vi.fn(async () => 1),
    json: { get: vi.fn(async () => null) },
    sMembers: vi.fn(async () => []),
    eval: vi.fn(async (_script: string, options: { arguments: string[] }) => {
      saved.push(JSON.parse(options.arguments[0]))
    }),
    lRange: vi.fn(async () => []),
    rPush: vi.fn(async () => 1)
  }
  vi.spyOn(service, 'execute').mockImplementation(async (operation: any) => operation(client))
  vi.spyOn(service as any, 'touchSession').mockResolvedValue(undefined)
  return { service, saved }
}

const message = (content: string, role: 'assistant' | 'user') => ({
  id: 'message-1',
  session_id: 'session-1',
  user_id: 'user-1',
  role,
  content
})

/** Deterministic, so a failure names a text that reproduces. */
function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = [
  '{{batshit-zip:', '{{batshit-zip:', '{{TOOL_LOADING_PLACEHOLDER:', '}}', '}}', '}', '{', ':::',
  'zip_1', 'tool_1', ' ', '\n', '\n\n\n', 'a', '{{batshit-zip:zip_1}}', '{{batshit-zip:zip_1:::x}}',
  '{{TOOL_LOADING_PLACEHOLDER:tool_1}}'
]

describe('saveMessage keeps its zip dedupe and reads a reply once', () => {
  it('saves exactly what the old patterns saved', async () => {
    const { service, saved } = await stubbedRedisService()
    const random = seededRandom(4273)
    const texts = [
      '{{batshit-zip:zip_1}}\n\n\n\n{{batshit-zip:zip_1}} {{TOOL_LOADING_PLACEHOLDER:tool_1}}done',
      '{{batshit-zip:a\n{b}} {{batshit-zip:a\n{b}}'
    ]
    for (let i = 0; i < 600; i++) {
      let text = 'x'
      const length = 1 + Math.floor(random() * 16)
      for (let j = 0; j < length; j++) text += TOKENS[Math.floor(random() * TOKENS.length)]
      texts.push(text)
    }
    let changed = 0
    for (const text of texts) {
      saved.length = 0
      await service.saveMessage(message(text, 'assistant') as any)
      expect(saved[0]?.content, JSON.stringify(text)).toBe(oldDedupeZipRefs(text))
      if (saved[0]?.content !== text.trim()) changed++
    }
    // The comparison covers texts the cleanup changed, not only ones it left alone.
    expect(changed).toBeGreaterThan(100)
  })

  it('saves a 1 MB reply of 20,000 openers that never close in well under 200 ms', async () => {
    const { service, saved } = await stubbedRedisService()
    const replies = {
      ...unclosedReferenceReplies('zip'),
      ...unclosedReferenceReplies('toolLoadingPlaceholder')
    }
    for (const [shape, content] of Object.entries(replies)) {
      for (const role of ['assistant', 'user'] as const) {
        saved.length = 0
        const started = performance.now()
        await service.saveMessage(message(content, role) as any)
        expect(performance.now() - started, `${shape} (${role})`).toBeLessThan(200)
        expect(saved[0]?.content, `${shape} (${role})`).toBe(content.trim())
      }
    }
  })

  // BL-707: `POST /api/messages` passes the browser's whole message, metadata included, and every
  // save reads each `clipReferences` entry for the clip ids it trusts. Its pattern searched to the
  // first `}` again from every opener, so one long entry stalled the save the same way.
  it('saves a message whose posted clipReferences entry holds 20,000 unclosed openers in well under 200 ms', async () => {
    const { service, saved } = await stubbedRedisService()
    for (const [shape, entry] of Object.entries(unclosedReferenceReplies('clip'))) {
      for (const role of ['assistant', 'user'] as const) {
        saved.length = 0
        const started = performance.now()
        await service.saveMessage({
          ...message('Read {{batshit-clip:clip_1779416324513_abcd1234:::notes.md}}.', role),
          metadata: { clipReferences: [entry, { reference: entry }] }
        } as any)
        expect(performance.now() - started, `${shape} (${role})`).toBeLessThan(200)
        // Nothing in the entry is a clip it trusts, so a user's clip reference is still neutralized.
        expect(saved[0]?.content, `${shape} (${role})`).toBe(
          role === 'user'
            ? 'Read [clip reference omitted].'
            : 'Read {{batshit-clip:clip_1779416324513_abcd1234:::notes.md}}.'
        )
      }
    }
  })

  it('still trusts a clip a posted clipReferences entry names (BL-707)', async () => {
    const { service, saved } = await stubbedRedisService()
    await service.saveMessage({
      ...message('Read {{batshit-clip:clip_1779416324513_abcd1234:::notes.md}}.', 'user'),
      metadata: { clipReferences: ['{{batshit-clip:clip_1779416324513_abcd1234:::notes.md}}'] }
    } as any)
    expect(saved[0]?.content).toBe('Read {{batshit-clip:clip_1779416324513_abcd1234:::notes.md}}.')
  })
})
