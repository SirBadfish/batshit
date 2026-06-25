export type IconRefKind = 'lucide' | 'brand' | 'fileType' | 'batshit' | 'custom'
export type AvatarIconFit = 'contain' | 'fill'

export type IconRef =
  | {
      kind: 'lucide'
      id: string
      color?: string | null
      tone?: string | null
    }
  | {
      kind: 'brand'
      slug: string
      fixed?: boolean
    }
  | {
      kind: 'fileType'
      id: string
    }
  | {
      kind: 'batshit'
      id: string
    }
  | {
      kind: 'custom'
      iconId: string
    }

export type IconCatalogCategory = 'general' | 'brand' | 'fileType' | 'batshit'

export interface IconCatalogEntry {
  ref: IconRef
  id: string
  label: string
  category: IconCatalogCategory
  keywords: string[]
  description?: string
  fixed?: boolean
}

export interface CustomIconRecord {
  id: string
  userId: string
  name: string
  path: string
  mimeType: 'image/svg+xml' | 'image/png'
  fileName: string
  sizeBytes: number
  tags: string[]
  display?: CustomIconDisplaySettings
  source?: CustomIconSourceProvenance
  createdAt: string
  updatedAt: string
}

export type CustomIconColorMode = 'original' | 'brand' | 'light' | 'dark' | 'custom'

export interface CustomIconDisplaySettings {
  colorMode: CustomIconColorMode
  customHex?: string
}

export interface CustomIconSourceProvenance {
  provider: 'lobe-icons' | 'simple-icons'
  providerLabel: string
  slug: string
  packageName?: string
  packageVersion?: string
  sourceUrl?: string
  licenseType?: string
  licenseUrl?: string
  guidelinesUrl?: string
  brandHex?: string
  downloadedAt: string
}

export interface IconLibraryPrefs {
  favorites: IconRef[]
  recents: IconRef[]
}

export function isIconRef(value: unknown): value is IconRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>

  if (raw.kind === 'lucide') return typeof raw.id === 'string' && raw.id.trim().length > 0
  if (raw.kind === 'brand') return typeof raw.slug === 'string' && raw.slug.trim().length > 0
  if (raw.kind === 'fileType') return typeof raw.id === 'string' && raw.id.trim().length > 0
  if (raw.kind === 'batshit') return typeof raw.id === 'string' && raw.id.trim().length > 0
  if (raw.kind === 'custom') {
    return typeof raw.iconId === 'string' && raw.iconId.trim().length > 0
  }

  return false
}

export function cloneIconRef(value: IconRef): IconRef {
  if (value.kind === 'lucide') {
    return {
      kind: 'lucide',
      id: value.id,
      ...(value.color ? { color: value.color } : {}),
      ...(value.tone ? { tone: value.tone } : {})
    }
  }
  if (value.kind === 'brand') {
    return { kind: 'brand', slug: value.slug, ...(value.fixed ? { fixed: true } : {}) }
  }
  if (value.kind === 'fileType') return { kind: 'fileType', id: value.id }
  if (value.kind === 'batshit') return { kind: 'batshit', id: value.id }
  return { kind: 'custom', iconId: value.iconId }
}

export function iconRefKey(value: IconRef | null | undefined): string {
  if (!value) return ''
  if (value.kind === 'lucide') return `lucide:${value.id}`
  if (value.kind === 'brand') return `brand:${value.slug}`
  if (value.kind === 'fileType') return `fileType:${value.id}`
  if (value.kind === 'batshit') return `batshit:${value.id}`
  return `custom:${value.iconId}`
}

export function parseIconRef(value: unknown): IconRef | null {
  if (!isIconRef(value)) return null
  return cloneIconRef(value)
}

export function normalizeAvatarIconFit(value: unknown): AvatarIconFit {
  void value
  return 'fill'
}
