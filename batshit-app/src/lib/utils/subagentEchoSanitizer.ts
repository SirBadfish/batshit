import { createNextIndexFinder } from '$lib/utils/braceScan'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether the text holds a zip reference that names a Subagent: exactly
 * `/\{\{batshit-zip:[^}]*subagent[^}]*\}\}/i`, in one pass. For an opener, only the first `}` after
 * it can end the reference (`[^}]*` cannot pass one), so it needs `subagent` between the two and a
 * second `}` right after. The pattern read to the end again from every opener, which held the one
 * Node process for seconds on a reply of openers that never close (BL-775, BL-707's rule).
 */
export function hasSubagentZipReference(content: string): boolean {
  const lower = content.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
  const open = '{{batshit-zip:'
  if (!lower.includes(open)) return false
  const nextBrace = createNextIndexFinder(content, '}')
  const nextSubagent = createNextIndexFinder(lower, 'subagent')
  let from = 0
  for (;;) {
    const start = lower.indexOf(open, from)
    if (start < 0) return false
    const bodyStart = start + open.length
    const brace = nextBrace(bodyStart)
    if (brace >= content.length) return false
    const word = nextSubagent(bodyStart)
    if (word + 'subagent'.length <= brace && content.charCodeAt(brace + 1) === 125 /* } */) return true
    from = start + 1
  }
}

export function stripLeadingSubagentZipEcho(content: string): string {
  if (typeof content !== 'string' || !content) return content

  const hasSubagentZip = hasSubagentZipReference(content)
  if (!hasSubagentZip) return content

  const maxPrefixLength = Math.min(40, content.length - 1)

  for (let length = maxPrefixLength; length >= 2; length -= 1) {
    const prefix = content.slice(0, length)
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) continue

    const nextChar = content.charAt(length)
    if (!/[A-Z]/.test(nextChar)) continue

    const remainder = content.slice(length)
    if (!remainder.trim()) continue

    const repeatedPrefix = new RegExp(`\\b${escapeRegExp(prefix)}\\b`)
    if (!repeatedPrefix.test(remainder)) continue

    return remainder.trimStart()
  }

  return content
}
