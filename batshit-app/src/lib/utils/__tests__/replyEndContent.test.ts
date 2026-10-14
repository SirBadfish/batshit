import { describe, expect, it } from 'vitest'
import { stripZipControlBlocks } from '$lib/utils/zipControl'
import { stripLeadingSubagentZipEcho } from '$lib/utils/subagentEchoSanitizer'
import { isConcreteZipId, scanZipReferences } from '$lib/utils/zipReferenceSafety'
import { finishReplyEndContent, replyEndZipIds } from '$lib/utils/replyEndContent'

/**
 * BL-775 golden comparison. The chat page edited `end`'s content and wrote the reply's `zipIds`
 * before it saved the reply over the server's record; the server now makes the same edits and the
 * tab saves nothing. The page's code is frozen below exactly as it stood at `c41bedf5e`
 * (`routes/+page.svelte`, `sanitizeMessageContent`, `extractZipIdsFromReferences`,
 * `extractZipIdsFromContent`, `replaceCoolToolMarkersWithZipRefs`, and the `end` handler's order),
 * and a generated corpus is run through both: the stored bytes and the allow-list must match.
 */
const pageBeforeBl775 = (() => {
  function sanitizeMessageContent(content: string): string {
    if (!content) {
      return content
    }

    let sanitized = stripZipControlBlocks(content)
    sanitized = stripLeadingSubagentZipEcho(sanitized)

    const hasZipRefs = /\{\{batshit-zip:[^}]+\}\}/.test(sanitized)
    const hasCoolToolTags = /<cool_tool[\s>]/.test(sanitized)

    if (hasZipRefs && hasCoolToolTags) {
      sanitized = sanitized.replace(/<cool_tool[^>]*>[\s\S]*?<\/cool_tool>/gi, '')
      sanitized = sanitized.replace(/<cool_tool[^>]*\/>/gi, '')
    } else if (!hasZipRefs) {
      sanitized = sanitized.replace(/<cool_tool[^>]*>\s*<\/cool_tool>/gi, '')
      sanitized = sanitized.replace(/<cool_tool[^>]*\/>/gi, '')
    }

    sanitized = sanitized.replace(/<\/cool_tool>/gi, '')
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim()

    return sanitized
  }

  function isLikelyZipId(id: string): boolean {
    return isConcreteZipId(id)
  }

  function extractZipIdsFromReferences(references: any[]): string[] {
    if (!Array.isArray(references)) return []
    const ids = new Set<string>()
    const addId = (value: unknown) => {
      const id = typeof value === 'string' ? value.trim() : ''
      if (id && isLikelyZipId(id)) {
        ids.add(id)
      }
    }

    for (const ref of references) {
      if (ref && typeof ref === 'object') {
        addId(ref.zipId)
        addId(ref.zip_id)
        addId(ref.id)
      }
      const reference = typeof ref === 'string'
        ? ref
        : typeof ref?.reference === 'string'
          ? ref.reference
          : ''
      if (!reference) continue
      const match = reference.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
      addId(match?.[1])
    }
    return Array.from(ids)
  }

  function extractZipIdsFromContent(content: string): string[] {
    if (!content) return []
    const ids: string[] = []
    for (const reference of scanZipReferences(content)) {
      if (reference.id && isLikelyZipId(reference.id)) {
        ids.push(reference.id)
      }
    }
    return ids
  }

  function replaceCoolToolMarkersWithZipRefs(content: string, zipRefs: any[]): string {
    if (!content || !Array.isArray(zipRefs) || zipRefs.length === 0) return content

    const coolToolRefs = zipRefs.filter((ref) => {
      const placeholder = typeof ref?.placeholder === 'string' ? ref.placeholder : ''
      const reference = typeof ref?.reference === 'string' ? ref.reference : ''
      return placeholder.includes('ZIP_COOL_TOOL') || reference.includes('batshit-zip:cool_tool_')
    })

    if (coolToolRefs.length === 0) return content

    let idx = 0
    let replaced = content.replace(/<cool_tool[^>]*>[\s\S]*?<\/cool_tool>/gi, (match) => {
      const ref = coolToolRefs[idx++]
      return ref?.reference || match
    })

    replaced = replaced.replace(/<cool_tool[^>]*\/>/gi, (match) => {
      const ref = coolToolRefs[idx++]
      return ref?.reference || match
    })

    return replaced
  }

  /** The `end` handler's content and `zipIds`, in its order (the store copy was never empty here). */
  function endSave(data: { content: string; zipReferences?: any[] }) {
    let finalContent = data.content
    if (data.zipReferences && Array.isArray(data.zipReferences) && data.zipReferences.length > 0) {
      finalContent = replaceCoolToolMarkersWithZipRefs(finalContent, data.zipReferences)
    }
    finalContent = sanitizeMessageContent(finalContent)
    if (data.zipReferences && Array.isArray(data.zipReferences) && data.zipReferences.length > 0) {
      const missingRefs = data.zipReferences
        .map((r: any) => r.reference || '')
        .filter(Boolean)
        .filter((ref: string) => !finalContent.includes(ref))
      if (missingRefs.length > 0) {
        const refsBlock = missingRefs.join('\n\n')
        finalContent = finalContent.trim().length > 0
          ? `${finalContent}\n\n${refsBlock}`
          : refsBlock
      }
    }
    const zipIds = Array.from(new Set([
      ...extractZipIdsFromReferences(Array.isArray(data.zipReferences) ? data.zipReferences : []),
      ...extractZipIdsFromContent(finalContent)
    ]))
    return { content: finalContent, zipIds }
  }

  return { endSave }
})()

/** A small deterministic generator, so a failure names a reproducible case. */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const COOL_A = '{{batshit-zip:cool_tool_1790000000001_abcd12:::read_file: a.ts - 3 lines}}'
const COOL_B = '{{batshit-zip:cool_tool_1790000000002_efgh34:::bash: ls - exit 0 - 2 lines}}'
const ERROR_Z = '{{batshit-zip:error_1790000000003_ijkl56:::Error: boom}}'
const SUBAGENT_Z = '{{batshit-zip:cool_tool_1790000000004_subagent:::subagent Helper - done}}'
const PIECES = [
  'Here is the answer.',
  'Second paragraph with `inline code`.',
  '\n\n\n\n',
  '\n',
  ' ',
  COOL_A,
  COOL_B,
  ERROR_Z,
  SUBAGENT_Z,
  '<cool_tool data-zip-id="x">payload</cool_tool>',
  '<cool_tool data-zip-id="y"/>',
  '<cool_tool>\n</cool_tool>',
  '</cool_tool>',
  '<batshit-zip-control>{"unzip":["tool_result_1"]}</batshit-zip-control>',
  '<batshit-tool-notes>{"notes":["read a.ts"]}</batshit-tool-notes>',
  '```\n<batshit-tool-notes>{"notes":[]}</batshit-tool-notes>\n```',
  'HelperHelper said Helper is done',
  '{{batshit-zip:not a real id}}',
  '{{batshit-zip:cool_tool_1790000000005_zz99:::extra}}',
  '{{batshit-steer:steer_1}}',
  'ünïcødé ✓ and emoji 🦇'
]
const REFS = [
  { zipId: 'cool_tool_1790000000001_abcd12', reference: COOL_A },
  { reference: COOL_B, placeholder: '{{ZIP_PLACEHOLDER_COOL_TOOL_1}}' },
  { zipId: 'error_1790000000003_ijkl56', reference: ERROR_Z },
  { zip_id: 'cool_tool_1790000000004_subagent', reference: SUBAGENT_Z },
  { id: 'cool_tool_1790000000006_mnop78', reference: '{{batshit-zip:cool_tool_1790000000006_mnop78:::missing from text}}' },
  { reference: '' },
  { zipId: 'not concrete', reference: '{{batshit-zip:fake}}' }
]

function corpus(count: number) {
  const random = makeRandom(775)
  const cases: Array<{ content: string; zipReferences?: any[] }> = []
  for (let i = 0; i < count; i += 1) {
    const parts: string[] = []
    const length = 1 + Math.floor(random() * 8)
    for (let p = 0; p < length; p += 1) parts.push(PIECES[Math.floor(random() * PIECES.length)])
    const content = parts.join(random() < 0.5 ? '' : '\n\n')
    const refCount = Math.floor(random() * 4)
    const zipReferences = random() < 0.2
      ? undefined
      : Array.from({ length: refCount }, () => REFS[Math.floor(random() * REFS.length)])
    cases.push({ content, zipReferences })
  }
  return cases
}

describe('replyEndContent: the page’s end edits, now on the server (BL-775 golden comparison)', () => {
  it('stores the same bytes and the same zipIds as the page did, over a generated corpus', () => {
    const cases = corpus(4000)
    let differing = 0
    for (const testCase of cases) {
      const before = pageBeforeBl775.endSave(testCase)
      const content = finishReplyEndContent(testCase.content, testCase.zipReferences)
      const zipIds = replyEndZipIds(content, testCase.zipReferences)
      if (content !== before.content || JSON.stringify(zipIds) !== JSON.stringify(before.zipIds)) {
        differing += 1
        expect({ content, zipIds }, JSON.stringify(testCase)).toEqual(before)
      }
    }
    expect(differing).toBe(0)
  })

  it('replaces markers, appends a reference the text lost, and writes an empty allow-list when there are no zips', () => {
    const refs = [
      { zipId: 'cool_tool_1790000000001_abcd12', reference: COOL_A },
      { zipId: 'cool_tool_1790000000006_mnop78', reference: '{{batshit-zip:cool_tool_1790000000006_mnop78:::lost}}' }
    ]
    const content = finishReplyEndContent('Read it.\n\n<cool_tool data-zip-id="x">body</cool_tool>\n\n\n\nDone.', refs)
    expect(content).toBe(`Read it.\n\n${COOL_A}\n\nDone.\n\n{{batshit-zip:cool_tool_1790000000006_mnop78:::lost}}`)
    expect(replyEndZipIds(content, refs)).toEqual(['cool_tool_1790000000001_abcd12', 'cool_tool_1790000000006_mnop78'])
    expect(replyEndZipIds('Plain words.', [])).toEqual([])
  })
})

/**
 * The linear scans against the patterns they replace, over texts dense with openers, closers, and
 * near misses (BL-775 moved these edits to the server, where BL-707's rule holds: no scan may cost
 * openers times length). The page's frozen code above is the oracle for the Cool Tool and zip id
 * patterns; the Subagent echo check is compared with its own old pattern here.
 */
const DENSE_TOKENS = [
  '{{batshit-zip:', '{{BATSHIT-ZIP:', 'subagent', 'SubAgent', '}', '}}', ':', ':::', 'id1', '<cool_tool',
  '<COOL_TOOL', '<Cool_Tool x="1"', '>', '/>', '</cool_tool>', '</Cool_Tool>', ' ', '\n', '\t', 'x', 'ſ', 'Helper'
]

function denseTexts(count: number, seed: number) {
  const random = makeRandom(seed)
  return Array.from({ length: count }, () => {
    let text = ''
    const length = Math.floor(random() * 24)
    for (let i = 0; i < length; i += 1) text += DENSE_TOKENS[Math.floor(random() * DENSE_TOKENS.length)]
    return text
  })
}

function oldStripLeadingSubagentZipEchoCheck(content: string): boolean {
  return /\{\{batshit-zip:[^}]*subagent[^}]*\}\}/i.test(content)
}

describe('replyEndContent: the linear scans match the old patterns', () => {
  it('stores the same bytes and zipIds as the page over texts dense with openers', () => {
    const differing: string[] = []
    for (const text of denseTexts(8000, 7752)) {
      const refs = [{ reference: text }, { reference: COOL_A }]
      const before = pageBeforeBl775.endSave({ content: text, zipReferences: refs })
      const content = finishReplyEndContent(text, refs)
      const zipIds = replyEndZipIds(content, refs)
      if (content !== before.content || JSON.stringify(zipIds) !== JSON.stringify(before.zipIds)) differing.push(JSON.stringify(text))
    }
    expect(differing).toEqual([])
  })

  it('finds a Subagent zip reference exactly where the old pattern did', async () => {
    const { hasSubagentZipReference } = await import('$lib/utils/subagentEchoSanitizer')
    let found = 0
    for (const text of denseTexts(8000, 7753)) {
      const expected = oldStripLeadingSubagentZipEchoCheck(text)
      if (expected) found += 1
      expect(hasSubagentZipReference(text), JSON.stringify(text)).toBe(expected)
    }
    expect(found).toBeGreaterThan(50)
  })

  it('edits a 1 MB reply of openers that never close in well under 200 ms (BL-707’s rule)', () => {
    const size = 1024 * 1024
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length))
    const refs = [{ reference: COOL_A, placeholder: 'ZIP_COOL_TOOL_1' }]
    for (const reply of [
      fill('<cool_tool '),
      fill('<cool_tool x>'),
      fill('<cool_tool x> '),
      fill('{{batshit-zip:subagent '),
      fill('{{batshit-zip:a:::b ') + COOL_A,
      fill('<COOL_TOOL>\n') + '{{batshit-zip:x}}'
    ]) {
      const started = performance.now()
      const content = finishReplyEndContent(reply, [...refs, { reference: reply }])
      replyEndZipIds(content, [...refs, { reference: reply }])
      expect(performance.now() - started, reply.slice(0, 24)).toBeLessThan(200)
    }
  }, 60_000)
})

