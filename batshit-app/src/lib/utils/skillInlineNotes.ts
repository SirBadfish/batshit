function humanizeSkillWord(value: string): string {
  if (!value) return ''
  if (/^n8n$/i.test(value)) return 'n8n'
  if (/^[a-z]{2,3}$/i.test(value)) return value.toUpperCase()
  return value[0].toUpperCase() + value.slice(1).toLowerCase()
}

function humanizeSkillSlug(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.split('/').map(humanizeSkillWord).join('/'))
    .join(' ')
    .trim()
}

export function stripSkillInlineMetadata(value: string): string {
  return String(value ?? '')
    .replace(/^(?:skill|invoked skill):\s*/i, '')
    .replace(/\s*\|\s*skill\s*id\s*=\s*.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatSkillInlineDisplayName(value: string): string {
  const cleaned = stripSkillInlineMetadata(value)
  if (!cleaned) return 'Skill'

  const looksLikePlainSlug = /^[a-z0-9][a-z0-9:_/-]*$/i.test(cleaned) && !/[A-Z]/.test(cleaned)
  return looksLikePlainSlug ? humanizeSkillSlug(cleaned) : cleaned
}
