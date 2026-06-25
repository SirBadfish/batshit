import { normalizeId } from '$lib/utils/idNormalizer'

export const BATSHIT_ZIP_REFERENCE_REGEX = /\{\{batshit-zip:([^:}\s]+)(?::::([^}]*))?\}\}/g
export const BATSHIT_CLIP_REFERENCE_REGEX = /\{\{batshit-clip:([^:}\s]+)(?::::([^}]*))?\}\}/g
export const BATSHIT_LEGACY_CLIP_REFERENCE_REGEX =
  /\{\{batshit-clip\|[^}]*\bid:([^|}\s]+)[^}]*\}\}[\s\S]*?\{\{\/batshit-clip\}\}/g

const CONCRETE_ZIP_ID_PATTERNS = [
  /^(zip|upload|terminal|diff|error|cool_tool|tool_raw|file|image|document|web)_\d{10,}_[a-z0-9]{4,12}$/i,
  /^tool_[a-z0-9_-]+_\d{10,}_[a-z0-9]{4,12}$/i
]

const CONCRETE_CLIP_ID_PATTERNS = [
  /^clip_\d{10,}_[a-z0-9]{4,12}$/i,
  /^clip_\d{10,}_[a-z0-9]{4,12}_\d+$/i,
  /^clip_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
]

function normalizeTrustedIds(trustedIds?: Set<string> | string[] | null): Set<string> | null {
  if (!trustedIds) return null
  const values = trustedIds instanceof Set ? Array.from(trustedIds) : trustedIds
  return new Set(values.map((id) => normalizeId(id)).filter(Boolean))
}

export function isConcreteZipId(id: string): boolean {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (!raw) return false
  if (raw.includes('...')) return false
  return CONCRETE_ZIP_ID_PATTERNS.some((pattern) => pattern.test(raw))
}

export function isTrustedZipReferenceId(
  id: string,
  trustedZipIds?: Set<string> | string[] | null,
  options: { allowConcreteWithoutTrustedSet?: boolean } = {}
): boolean {
  const trusted = normalizeTrustedIds(trustedZipIds)
  const normalized = normalizeId(id)

  if (trusted) {
    return trusted.has(normalized)
  }

  return options.allowConcreteWithoutTrustedSet ? isConcreteZipId(id) : false
}

export function neutralizeAllZipReferenceSyntax(content: string): string {
  if (!content || !content.includes('{{batshit-zip:')) return content
  return content.replace(BATSHIT_ZIP_REFERENCE_REGEX, '[zip reference omitted]')
}

export function neutralizeUntrustedZipReferenceSyntax(
  content: string,
  options: {
    trustedZipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string {
  if (!content || !content.includes('{{batshit-zip:')) return content

  return content.replace(BATSHIT_ZIP_REFERENCE_REGEX, (match, zipId) =>
    isTrustedZipReferenceId(zipId, options.trustedZipIds, {
      allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
    })
      ? match
      : '[zip reference omitted]'
  )
}

export function extractTrustedZipIdsFromContent(
  content: string,
  options: {
    trustedZipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string[] {
  if (!content || !content.includes('{{batshit-zip:')) return []

  const ids = new Set<string>()
  const regex = new RegExp(BATSHIT_ZIP_REFERENCE_REGEX.source, 'g')
  let match: RegExpExecArray | null = null

  while ((match = regex.exec(content)) !== null) {
    const zipId = match[1]
    if (
      zipId &&
      isTrustedZipReferenceId(zipId, options.trustedZipIds, {
        allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
      })
    ) {
      ids.add(zipId)
    }
  }

  return Array.from(ids)
}

export function collectTrustedZipIdsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return []

  const ids = new Set<string>()
  const record = metadata as Record<string, any>
  const add = (value: unknown) => {
    if (typeof value === 'string' && isConcreteZipId(value)) {
      ids.add(value.trim())
    }
  }
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(add)
    }
  }

  addArray(record.zipIds)
  addArray(record.zip_ids)

  if (Array.isArray(record.zipReferences)) {
    for (const entry of record.zipReferences) {
      if (typeof entry === 'string') {
        const match = entry.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
        add(match?.[1] ?? entry)
      } else if (entry && typeof entry === 'object') {
        add((entry as Record<string, any>).zipId)
        add((entry as Record<string, any>).zip_id)
        add((entry as Record<string, any>).id)
        const reference = (entry as Record<string, any>).reference
        if (typeof reference === 'string') {
          const match = reference.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
          add(match?.[1])
        }
      }
    }
  }

  return Array.from(ids)
}

export function isConcreteClipId(id: string): boolean {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (!raw) return false
  if (raw.includes('...')) return false
  return CONCRETE_CLIP_ID_PATTERNS.some((pattern) => pattern.test(raw))
}

export function isTrustedClipReferenceId(
  id: string,
  trustedClipIds?: Set<string> | string[] | null,
  options: { allowConcreteWithoutTrustedSet?: boolean } = {}
): boolean {
  const trusted = normalizeTrustedIds(trustedClipIds)
  const normalized = normalizeId(id)

  if (trusted) {
    return trusted.has(normalized)
  }

  return options.allowConcreteWithoutTrustedSet ? isConcreteClipId(id) : false
}

export function neutralizeAllClipReferenceSyntax(content: string): string {
  if (!content || !content.includes('{{batshit-clip')) return content
  return content
    .replace(BATSHIT_LEGACY_CLIP_REFERENCE_REGEX, '[clip reference omitted]')
    .replace(BATSHIT_CLIP_REFERENCE_REGEX, '[clip reference omitted]')
}

export function neutralizeUntrustedClipReferenceSyntax(
  content: string,
  options: {
    trustedClipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string {
  if (!content || !content.includes('{{batshit-clip')) return content

  const replaceIfUntrusted = (match: string, clipId: string) =>
    isTrustedClipReferenceId(clipId, options.trustedClipIds, {
      allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
    })
      ? match
      : '[clip reference omitted]'

  return content
    .replace(BATSHIT_LEGACY_CLIP_REFERENCE_REGEX, replaceIfUntrusted)
    .replace(BATSHIT_CLIP_REFERENCE_REGEX, replaceIfUntrusted)
}

export function stripTrustedClipReferenceSyntax(
  content: string,
  options: {
    trustedClipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string {
  if (!content || !content.includes('{{batshit-clip')) return content

  const stripIfTrusted = (match: string, clipId: string) =>
    isTrustedClipReferenceId(clipId, options.trustedClipIds, {
      allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
    })
      ? ''
      : match

  return content
    .replace(BATSHIT_LEGACY_CLIP_REFERENCE_REGEX, stripIfTrusted)
    .replace(BATSHIT_CLIP_REFERENCE_REGEX, stripIfTrusted)
}

export function extractTrustedClipIdsFromContent(
  content: string,
  options: {
    trustedClipIds?: Set<string> | string[] | null
    allowConcreteWithoutTrustedSet?: boolean
  } = {}
): string[] {
  if (!content || !content.includes('{{batshit-clip')) return []

  const ids = new Set<string>()
  const addIfTrusted = (clipId: string) => {
    if (
      clipId &&
      isTrustedClipReferenceId(clipId, options.trustedClipIds, {
        allowConcreteWithoutTrustedSet: options.allowConcreteWithoutTrustedSet
      })
    ) {
      ids.add(clipId)
    }
  }

  const newSyntaxRegex = new RegExp(BATSHIT_CLIP_REFERENCE_REGEX.source, 'g')
  let newSyntaxMatch: RegExpExecArray | null = null
  while ((newSyntaxMatch = newSyntaxRegex.exec(content)) !== null) {
    addIfTrusted(newSyntaxMatch[1])
  }

  const legacyRegex = new RegExp(BATSHIT_LEGACY_CLIP_REFERENCE_REGEX.source, 'g')
  let legacyMatch: RegExpExecArray | null = null
  while ((legacyMatch = legacyRegex.exec(content)) !== null) {
    addIfTrusted(legacyMatch[1])
  }

  return Array.from(ids)
}

export function collectTrustedClipIdsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return []

  const ids = new Set<string>()
  const record = metadata as Record<string, any>
  const add = (value: unknown) => {
    if (typeof value === 'string' && isConcreteClipId(value)) {
      ids.add(value.trim())
    }
  }
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(add)
    }
  }

  add(record.clipId)
  add(record.clip_id)
  addArray(record.clipIds)
  addArray(record.clip_ids)

  if (Array.isArray(record.clippedItems)) {
    for (const item of record.clippedItems) {
      add(item?.clipId)
      add(item?.clip_id)
      add(item?.id)
    }
  }

  if (Array.isArray(record.clipReferences)) {
    for (const entry of record.clipReferences) {
      if (typeof entry === 'string') {
        const match = entry.match(/\{\{batshit-clip:([^:}]+)(?::::[^}]*)?\}\}/)
        add(match?.[1] ?? entry)
      } else if (entry && typeof entry === 'object') {
        add((entry as Record<string, any>).clipId)
        add((entry as Record<string, any>).clip_id)
        add((entry as Record<string, any>).id)
        const reference = (entry as Record<string, any>).reference
        if (typeof reference === 'string') {
          const match = reference.match(/\{\{batshit-clip:([^:}]+)(?::::[^}]*)?\}\}/)
          add(match?.[1])
        }
      }
    }
  }

  return Array.from(ids)
}
