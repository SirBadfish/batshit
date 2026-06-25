import { promises as fs, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { CustomIconRecord, CustomIconSourceProvenance } from '$lib/icons/iconTypes'
import { createCustomIcon, IconLibraryError } from './iconLibrary'
import { applySvgPaintColor, sanitizeIconSvg } from './svgSanitizer'

const require = createRequire(import.meta.url)

export type OnlineIconProviderId = 'lobe-icons' | 'simple-icons'

export interface OnlineIconCandidate {
  provider: OnlineIconProviderId
  providerLabel: string
  id: string
  slug: string
  title: string
  previewSvg?: string
  brandHex?: string
  sourceUrl?: string
  licenseType?: string
  licenseUrl?: string
  guidelinesUrl?: string
}

interface SearchOptions {
  query: string
  providers?: OnlineIconProviderId[]
  limit?: number
}

interface ImportOptions {
  provider: OnlineIconProviderId
  slug: string
}

interface SimpleIconMetadata {
  title: string
  slug: string
  hex?: string
  source?: string
  guidelines?: string
  license?: {
    type?: string
    url?: string
  }
}

interface LobeIconMetadata {
  slug: string
  fileName: string
  title: string
  baseSlug: string
  variant: 'color' | 'brand' | 'mono' | 'text' | 'default'
  filePath: string
}

const DEFAULT_PROVIDER_IDS: OnlineIconProviderId[] = ['lobe-icons', 'simple-icons']
const MAX_QUERY_LENGTH = 80
const DEFAULT_LIMIT = 24
const PROVIDER_LIMIT = 18

const simpleIconsDataPath = require.resolve('simple-icons/icons.json')
const simpleIconsPackageDir = path.resolve(path.dirname(simpleIconsDataPath), '..')
const simpleIconsData = require('simple-icons/icons.json') as SimpleIconMetadata[]
const simpleIconsPackage = JSON.parse(readFileSync(path.join(simpleIconsPackageDir, 'package.json'), 'utf8')) as {
  version: string
  name: string
  license?: string
}

const lobeIconsPackage = require('@lobehub/icons-static-svg/package.json') as {
  version: string
  name: string
  license?: string
}
const lobeIconsPackageDir = path.dirname(require.resolve('@lobehub/icons-static-svg/package.json'))
const lobeIconsDir = path.join(lobeIconsPackageDir, 'icons')

let lobeMetadataCache: LobeIconMetadata[] | null = null

function normalizeQuery(query: string) {
  return query.trim().slice(0, MAX_QUERY_LENGTH).toLowerCase()
}

function compact(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function titleCase(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (part.length <= 3 && part === part.toLowerCase()) return part.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function detectLobeVariant(slug: string): Pick<LobeIconMetadata, 'baseSlug' | 'variant'> {
  if (slug.endsWith('-color')) return { baseSlug: slug.slice(0, -6), variant: 'color' }
  if (slug.endsWith('-brand')) return { baseSlug: slug.slice(0, -6), variant: 'brand' }
  if (slug.endsWith('-text')) return { baseSlug: slug.slice(0, -5), variant: 'text' }
  return { baseSlug: slug, variant: 'default' }
}

function variantRank(variant: LobeIconMetadata['variant']) {
  if (variant === 'color') return 0
  if (variant === 'default') return 1
  if (variant === 'brand') return 2
  if (variant === 'mono') return 3
  return 4
}

function scoreMatch(query: string, values: string[]) {
  const normalized = normalizeQuery(query)
  const compactQuery = compact(normalized)
  if (!normalized) return 0

  let best = 0
  for (const value of values) {
    const normalizedValue = value.toLowerCase()
    const compactValue = compact(value)
    if (normalizedValue === normalized || compactValue === compactQuery) best = Math.max(best, 100)
    else if (normalizedValue.startsWith(normalized) || compactValue.startsWith(compactQuery)) best = Math.max(best, 80)
    else if (normalizedValue.includes(normalized) || compactValue.includes(compactQuery)) best = Math.max(best, 50)
  }
  return best
}

function providerSet(input: OnlineIconProviderId[] | undefined) {
  const set = new Set(input?.length ? input : DEFAULT_PROVIDER_IDS)
  return DEFAULT_PROVIDER_IDS.filter((provider) => set.has(provider))
}

async function readSvg(filePath: string) {
  return await fs.readFile(filePath, 'utf8')
}

function sanitizePreview(svgText: string) {
  try {
    return sanitizeIconSvg(svgText)
  } catch {
    return undefined
  }
}

function simpleIconFilePath(slug: string) {
  return path.join(simpleIconsPackageDir, 'icons', `${slug}.svg`)
}

function simpleIconSource(metadata: SimpleIconMetadata): CustomIconSourceProvenance {
  return {
    provider: 'simple-icons',
    providerLabel: 'Simple Icons',
    slug: metadata.slug,
    packageName: simpleIconsPackage.name,
    packageVersion: simpleIconsPackage.version,
    sourceUrl: metadata.source,
    licenseType: metadata.license?.type,
    licenseUrl: metadata.license?.url,
    guidelinesUrl: metadata.guidelines,
    brandHex: metadata.hex ? `#${metadata.hex}` : undefined,
    downloadedAt: new Date().toISOString()
  }
}

async function searchSimpleIcons(query: string, limit: number): Promise<OnlineIconCandidate[]> {
  const normalized = normalizeQuery(query)
  if (!normalized) return []

  const matches = simpleIconsData
    .map((icon) => ({
      icon,
      score: scoreMatch(normalized, [icon.title, icon.slug])
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.icon.title.localeCompare(b.icon.title))
    .slice(0, limit)

  return await Promise.all(
    matches.map(async ({ icon }) => {
      const svgText = applySvgPaintColor(await readSvg(simpleIconFilePath(icon.slug)), icon.hex)
      return {
        provider: 'simple-icons',
        providerLabel: 'Simple Icons',
        id: `simple-icons:${icon.slug}`,
        slug: icon.slug,
        title: icon.title,
        previewSvg: sanitizePreview(svgText),
        brandHex: icon.hex ? `#${icon.hex}` : undefined,
        sourceUrl: icon.source,
        licenseType: icon.license?.type,
        licenseUrl: icon.license?.url,
        guidelinesUrl: icon.guidelines
      } satisfies OnlineIconCandidate
    })
  )
}

async function getLobeMetadata() {
  if (lobeMetadataCache) return lobeMetadataCache

  const files = (await fs.readdir(lobeIconsDir)).filter((fileName) => fileName.endsWith('.svg'))
  lobeMetadataCache = files
    .map((fileName) => {
      const slug = fileName.replace(/\.svg$/i, '')
      const { baseSlug, variant } = detectLobeVariant(slug)
      return {
        slug,
        fileName,
        title: variant === 'default' ? titleCase(baseSlug) : `${titleCase(baseSlug)} ${titleCase(variant)}`,
        baseSlug,
        variant,
        filePath: path.join(lobeIconsDir, fileName)
      } satisfies LobeIconMetadata
    })
    .sort((left, right) => {
      const baseCompare = left.baseSlug.localeCompare(right.baseSlug)
      if (baseCompare !== 0) return baseCompare
      return variantRank(left.variant) - variantRank(right.variant)
    })

  return lobeMetadataCache
}

function lobeSource(icon: LobeIconMetadata): CustomIconSourceProvenance {
  return {
    provider: 'lobe-icons',
    providerLabel: 'Lobe Icons',
    slug: icon.slug,
    packageName: lobeIconsPackage.name,
    packageVersion: lobeIconsPackage.version,
    sourceUrl: `https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons/${icon.fileName}`,
    licenseType: lobeIconsPackage.license,
    licenseUrl: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE',
    downloadedAt: new Date().toISOString()
  }
}

async function searchLobeIcons(query: string, limit: number): Promise<OnlineIconCandidate[]> {
  const normalized = normalizeQuery(query)
  if (!normalized) return []

  const metadata = await getLobeMetadata()
  const matches = metadata
    .map((icon) => ({
      icon,
      score: scoreMatch(normalized, [icon.title, icon.slug, icon.baseSlug])
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const variantCompare = variantRank(a.icon.variant) - variantRank(b.icon.variant)
      if (variantCompare !== 0) return variantCompare
      return a.icon.title.localeCompare(b.icon.title)
    })
    .slice(0, limit)

  return await Promise.all(
    matches.map(async ({ icon }) => ({
      provider: 'lobe-icons',
      providerLabel: 'Lobe Icons',
      id: `lobe-icons:${icon.slug}`,
      slug: icon.slug,
      title: icon.title,
      previewSvg: sanitizePreview(await readSvg(icon.filePath)),
      sourceUrl: `https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons/${icon.fileName}`,
      licenseType: lobeIconsPackage.license,
      licenseUrl: 'https://github.com/lobehub/lobe-icons/blob/master/LICENSE'
    }))
  )
}

export async function searchOnlineIcons(options: SearchOptions) {
  const normalized = normalizeQuery(options.query)
  if (!normalized) return []

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 60)
  const providers = providerSet(options.providers)
  const providerLimit = Math.max(Math.ceil(limit / Math.max(providers.length, 1)), PROVIDER_LIMIT)
  const results = await Promise.all(
    providers.map((provider) => {
      if (provider === 'lobe-icons') return searchLobeIcons(normalized, providerLimit)
      return searchSimpleIcons(normalized, providerLimit)
    })
  )

  return results
    .flat()
    .sort((left, right) => {
      const leftScore = scoreMatch(normalized, [left.title, left.slug])
      const rightScore = scoreMatch(normalized, [right.title, right.slug])
      if (rightScore !== leftScore) return rightScore - leftScore
      if (left.provider !== right.provider) return left.provider.localeCompare(right.provider)
      return left.title.localeCompare(right.title)
    })
    .slice(0, limit)
}

async function importSimpleIcon(userId: string, slug: string): Promise<CustomIconRecord> {
  const metadata = simpleIconsData.find((icon) => icon.slug === slug)
  if (!metadata) {
    throw new IconLibraryError('Simple Icons candidate not found', 404)
  }

  const svgText = applySvgPaintColor(await readSvg(simpleIconFilePath(metadata.slug)), metadata.hex)
  const file = new File([svgText], `${metadata.slug}.svg`, { type: 'image/svg+xml' })
  return await createCustomIcon(userId, file, {
    name: metadata.title,
    tags: ['simple-icons', metadata.slug, metadata.title],
    source: simpleIconSource(metadata)
  })
}

async function importLobeIcon(userId: string, slug: string): Promise<CustomIconRecord> {
  const metadata = (await getLobeMetadata()).find((icon) => icon.slug === slug)
  if (!metadata) {
    throw new IconLibraryError('Lobe Icons candidate not found', 404)
  }

  const svgText = await readSvg(metadata.filePath)
  const file = new File([svgText], `${metadata.slug}.svg`, { type: 'image/svg+xml' })
  return await createCustomIcon(userId, file, {
    name: metadata.title,
    tags: ['lobe-icons', metadata.slug, metadata.baseSlug],
    source: lobeSource(metadata)
  })
}

export async function importOnlineIcon(userId: string, options: ImportOptions) {
  if (options.provider === 'simple-icons') return await importSimpleIcon(userId, options.slug)
  if (options.provider === 'lobe-icons') return await importLobeIcon(userId, options.slug)
  throw new IconLibraryError('Unsupported online icon provider')
}

export function parseOnlineIconProviders(input: string | null | undefined): OnlineIconProviderId[] {
  if (!input) return DEFAULT_PROVIDER_IDS
  const values = input
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is OnlineIconProviderId => value === 'lobe-icons' || value === 'simple-icons')
  return values.length ? values : DEFAULT_PROVIDER_IDS
}
