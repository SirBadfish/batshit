function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function stripLeadingSubagentZipEcho(content: string): string {
  if (typeof content !== 'string' || !content) return content

  const hasSubagentZip = /\{\{batshit-zip:[^}]*subagent[^}]*\}\}/i.test(content)
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
