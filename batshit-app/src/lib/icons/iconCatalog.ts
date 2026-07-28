import { BRAND_ICON_MAP } from '$lib/data/brand-icons.generated'
import { FILE_ICON_MAP } from '$lib/data/file-icons.generated'
import { BATSHIT_ICON_ENTRIES } from './batshitIconRegistry'
import type { IconCatalogEntry, IconRef } from './iconTypes'

const EXTRA_BRAND_ICON_MAP = {
  'batshit-icon': '/batshit-icon-dark-ios.png',
  'blender-color': '/brand-icons/blender-color.png',
  'deepgram-color': '/brand-icons/deepgram-color.svg',
  'gnubash-color': '/brand-icons/gnubash-color.svg',
  'gnubash-dark': '/brand-icons/gnubash-dark.svg',
  'gnubash-mono': '/brand-icons/gnubash-mono.svg',
  'mcp-mono': '/brand-icons/mcp-mono.svg',
  'vrm-color': '/brand-icons/vrm-color.png',
  'vroid-color': '/brand-icons/vroid-color.png',
  'youtube-color': '/brand-icons/youtube-color.svg'
} as const

const BRAND_ICON_PATHS: Record<string, string> = {
  ...BRAND_ICON_MAP,
  ...EXTRA_BRAND_ICON_MAP
}

const GENERAL_ICON_IDS = [
  'app-window',
  'archive',
  'audio-lines',
  'badge',
  'blocks',
  'book-open',
  'bot',
  'bot-message-square',
  'box',
  'boxes',
  'brain',
  'chart-bar',
  'chart-pie',
  'cloud',
  'code',
  'command',
  'container',
  'cpu',
  'database',
  'file-code',
  'file-axis-3d',
  'file-text',
  'folder',
  'folder-open',
  'globe',
  'hammer',
  'hard-drive',
  'image',
  'key',
  'layers',
  'layout-grid',
  'message-circle',
  'messages-square',
  'mic',
  'monitor',
  'music',
  'network',
  'notebook',
  'package',
  'package-open',
  'palette',
  'paperclip',
  'plug',
  'plug-zap',
  'puzzle',
  'radio',
  'rocket',
  'scroll-text',
  'search',
  'server',
  'settings',
  'settings-2',
  'shield',
  'sliders-horizontal',
  'sparkles',
  'table',
  'tag',
  'tags',
  'terminal',
  'user-round',
  'users',
  'video',
  'wand-sparkles',
  'workflow',
  'wrench',
  'zap'
] as const

const GENERAL_LABELS: Record<string, string> = {
  'app-window': 'App Window',
  'audio-lines': 'Audio Lines',
  'book-open': 'Open Book',
  'bot-message-square': 'Bot Message',
  'file-code': 'Code File',
  'file-axis-3d': '3D File',
  'file-text': 'Text File',
  'folder-open': 'Open Folder',
  'hard-drive': 'Hard Drive',
  'layout-grid': 'Layout Grid',
  'message-circle': 'Message',
  'messages-square': 'Messages',
  'package-open': 'Open Package',
  'plug-zap': 'Powered Plug',
  'settings-2': 'Settings',
  'sliders-horizontal': 'Sliders',
  'user-round': 'User',
  'wand-sparkles': 'Magic Wand'
}

const BRAND_LABEL_OVERRIDES: Record<string, string> = {
  adobe: 'Adobe',
  adobefirefly: 'Adobe Firefly',
  ai21: 'AI21',
  anthropic: 'Anthropic',
  aws: 'AWS',
  azure: 'Azure',
  azureai: 'Azure AI',
  baai: 'BAAI',
  batshit: 'Batshit',
  blender: 'Blender',
  cloudflare: 'Cloudflare',
  comfyui: 'ComfyUI',
  deepgram: 'Deepgram',
  deepseek: 'DeepSeek',
  docker: 'Docker',
  elevenlabs: 'ElevenLabs',
  fal: 'fal',
  figma: 'Figma',
  gemini: 'Gemini',
  github: 'GitHub',
  gnubash: 'GNU Bash',
  gradio: 'Gradio',
  groq: 'Groq',
  huggingface: 'Hugging Face',
  langchain: 'LangChain',
  llamacpp: 'llama.cpp',
  llamaindex: 'LlamaIndex',
  lmstudio: 'LM Studio',
  mcp: 'MCP',
  n8n: 'n8n',
  notion: 'Notion',
  ollama: 'Ollama',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  perplexity: 'Perplexity',
  qwen: 'Qwen',
  stability: 'Stability AI',
  together: 'Together AI',
  vercel: 'Vercel',
  vllm: 'vLLM',
  wan: 'Wan',
  vrm: 'VRM',
  vroid: 'VRoid',
  xai: 'xAI',
  youtube: 'YouTube'
}

const BRAND_VARIANT_ORDER: Record<string, number> = {
  color: 0,
  dark: 1,
  light: 2,
  mono: 3
}

const LEGACY_FILE_TYPE_ICON_IDS = [
  'folder',
  'folder-code',
  'folder-git',
  'folder-lock',
  'folder-open',
  'folder-root',
  'file',
  'file-archive',
  'file-braces',
  'file-chart-column',
  'file-chart-pie',
  'file-code',
  'file-cog',
  'file-image',
  'file-lock',
  'file-music',
  'file-spreadsheet',
  'file-stack',
  'file-terminal',
  'file-text',
  'file-video-camera',
  'file-volume',
  'braces',
  'brackets',
  'code-xml',
  'database',
  'image',
  'package'
] as const

const LEGACY_FILE_TYPE_LABELS: Record<string, string> = {
  folder: 'Folder',
  'folder-code': 'Code Folder',
  'folder-git': 'Git Folder',
  'folder-lock': 'Locked Folder',
  'folder-open': 'Open Folder',
  'folder-root': 'Root Folder',
  file: 'File',
  'file-archive': 'Archive File',
  'file-braces': 'JSON File',
  'file-chart-column': 'Data File',
  'file-chart-pie': 'Chart File',
  'file-code': 'Code File',
  'file-cog': 'Config File',
  'file-image': 'Image File',
  'file-lock': 'Locked File',
  'file-music': 'Audio File',
  'file-spreadsheet': 'Spreadsheet',
  'file-stack': 'Stacked Files',
  'file-terminal': 'Script File',
  'file-text': 'Text File',
  'file-video-camera': 'Video File',
  'file-volume': 'Audio File',
  braces: 'Braces',
  brackets: 'Brackets',
  'code-xml': 'XML Code',
  database: 'Database',
  image: 'Image',
  package: 'Package'
}

const FILE_TYPE_FALLBACKS: Record<string, string> = {
  'folder-code': 'folder-src',
  'folder-lock': 'folder-secure',
  'file-archive': 'zip',
  'file-braces': 'json',
  'file-chart-column': 'table',
  'file-chart-pie': 'table',
  'file-code': 'document',
  'file-cog': 'settings',
  'file-image': 'image',
  'file-lock': 'lock',
  'file-music': 'audio',
  'file-spreadsheet': 'table',
  'file-terminal': 'console',
  'file-text': 'document',
  'file-video-camera': 'video',
  'file-volume': 'audio',
  braces: 'json',
  brackets: 'json',
  'code-xml': 'xml',
  package: 'nodejs'
}

function toTitleCase(id: string) {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function splitBrandSlug(slug: string) {
  const colorWithHexMatch = slug.match(/^(.*)-color-[a-f0-9]{6}$/i)
  if (colorWithHexMatch) return { base: colorWithHexMatch[1], variant: 'color' }

  for (const variant of ['color', 'dark', 'light', 'mono']) {
    const suffix = `-${variant}`
    if (slug.endsWith(suffix)) {
      return {
        base: slug.slice(0, -suffix.length),
        variant
      }
    }
  }

  return { base: slug, variant: null }
}

function normalizeBrandBase(base: string) {
  return base.trim().replace(/\s*\(\d+\)$/g, '')
}

function brandBaseLabel(base: string) {
  const normalizedBase = normalizeBrandBase(base)
  const override = BRAND_LABEL_OVERRIDES[normalizedBase]
  if (override) return override
  return toTitleCase(normalizedBase.replace(/[._\s]+/g, '-'))
}

function brandLabelForSlug(slug: string) {
  const { base, variant } = splitBrandSlug(slug)
  const label = brandBaseLabel(base)
  if (variant === 'color') return `${label} Color`
  if (variant === 'mono') return `${label} Mono`
  if (variant === 'dark') return `${label} Dark`
  if (variant === 'light') return `${label} Light`
  return label
}

function compareBrandSlugs(left: string, right: string) {
  const leftParts = splitBrandSlug(left)
  const rightParts = splitBrandSlug(right)
  const leftLabel = brandBaseLabel(leftParts.base)
  const rightLabel = brandBaseLabel(rightParts.base)
  const labelCompare = leftLabel.localeCompare(rightLabel, undefined, { sensitivity: 'base' })
  if (labelCompare !== 0) return labelCompare

  const leftVariantOrder = leftParts.variant ? BRAND_VARIANT_ORDER[leftParts.variant] : 99
  const rightVariantOrder = rightParts.variant ? BRAND_VARIANT_ORDER[rightParts.variant] : 99
  if (leftVariantOrder !== rightVariantOrder) return leftVariantOrder - rightVariantOrder

  return left.localeCompare(right)
}

function keywordsFor(...values: string[]) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
        .filter((value) => value.length > 1)
    )
  )
}

function entry(id: string, label: string, ref: IconRef, category: IconCatalogEntry['category']) {
  return {
    id,
    label,
    ref,
    category,
    keywords: keywordsFor(id, label)
  } satisfies IconCatalogEntry
}

export const GENERAL_ICON_CATALOG = GENERAL_ICON_IDS.map((id) =>
  entry(id, GENERAL_LABELS[id] ?? toTitleCase(id), { kind: 'lucide', id }, 'general')
)

export const BRAND_ICON_CATALOG = Object.keys(BRAND_ICON_PATHS).sort(compareBrandSlugs).map((slug) =>
  entry(slug, brandLabelForSlug(slug), { kind: 'brand', slug }, 'brand')
)

export const FILE_TYPE_ICON_CATALOG = [
  ...Object.entries(FILE_ICON_MAP).map(([id, icon]) => entry(id, icon.label, { kind: 'fileType', id }, 'fileType')),
  ...LEGACY_FILE_TYPE_ICON_IDS.filter((id) => !(id in FILE_ICON_MAP)).map((id) =>
    entry(id, LEGACY_FILE_TYPE_LABELS[id] ?? toTitleCase(id), { kind: 'fileType', id }, 'fileType')
  )
]

export const BATSHIT_ICON_CATALOG = BATSHIT_ICON_ENTRIES.map((item) => ({
  ...item,
  ref: { kind: 'batshit', id: item.id } satisfies IconRef,
  category: 'batshit' as const
}))

export const ICON_CATALOG = [
  ...GENERAL_ICON_CATALOG,
  ...BRAND_ICON_CATALOG,
  ...FILE_TYPE_ICON_CATALOG,
  ...BATSHIT_ICON_CATALOG
] satisfies IconCatalogEntry[]

export const DEFAULT_ICON_REF: IconRef = { kind: 'lucide', id: 'sparkles' }
export const DEFAULT_SKILL_ICON_REF: IconRef = { kind: 'batshit', id: 'skills' }
export const DEFAULT_PROMPT_ICON_REF: IconRef = { kind: 'batshit', id: 'prompts' }
export const DEFAULT_ARTIFACT_ICON_REF: IconRef = { kind: 'batshit', id: 'artifacts' }
export const DEFAULT_CLI_TOOL_ICON_REF: IconRef = { kind: 'batshit', id: 'cli-tools' }
export const DEFAULT_MCP_GATEWAY_ICON_REF: IconRef = { kind: 'lucide', id: 'plug' }
export const DEFAULT_MCP_GROUP_ICON_REF: IconRef = { kind: 'lucide', id: 'tags' }
export const DEFAULT_AGENT_ICON_REF: IconRef = { kind: 'batshit', id: 'agents' }
export const DEFAULT_SUBAGENT_ICON_REF: IconRef = { kind: 'batshit', id: 'subagents' }
export const DEFAULT_GROUP_ICON_REF: IconRef = { kind: 'batshit', id: 'groups' }
export const DEFAULT_PROJECT_ICON_REF: IconRef = { kind: 'batshit', id: 'projects' }
export const DEFAULT_VOICE_ENGINE_ICON_REF: IconRef = { kind: 'batshit', id: 'voice-engine-manager' }

export function getIconCatalogEntries() {
  return ICON_CATALOG
}

export function getBrandIconPath(slug: string): string | null {
  return BRAND_ICON_PATHS[slug] ?? null
}

export function normalizeFileTypeIconId(id: string) {
  return FILE_TYPE_FALLBACKS[id] ?? id
}

export function getFileTypeIconPath(id: string): string | null {
  const normalizedId = normalizeFileTypeIconId(id)
  return FILE_ICON_MAP[normalizedId as keyof typeof FILE_ICON_MAP]?.path ?? null
}

export function findCatalogEntry(ref: IconRef | null | undefined) {
  if (!ref) return null
  if (ref.kind === 'lucide') return ICON_CATALOG.find((item) => item.ref.kind === 'lucide' && item.ref.id === ref.id) ?? null
  if (ref.kind === 'brand') return ICON_CATALOG.find((item) => item.ref.kind === 'brand' && item.ref.slug === ref.slug) ?? null
  if (ref.kind === 'fileType') return ICON_CATALOG.find((item) => item.ref.kind === 'fileType' && item.ref.id === ref.id) ?? null
  if (ref.kind === 'batshit') return ICON_CATALOG.find((item) => item.ref.kind === 'batshit' && item.ref.id === ref.id) ?? null
  return null
}

export function isCatalogIconRef(ref: IconRef | null | undefined) {
  return Boolean(findCatalogEntry(ref))
}

export function searchIconCatalog(query: string, entries: IconCatalogEntry[] = ICON_CATALOG) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return entries

  return entries.filter((item) => {
    return (
      item.id.toLowerCase().includes(normalized) ||
      item.label.toLowerCase().includes(normalized) ||
      item.keywords.some((keyword) => keyword.includes(normalized))
    )
  })
}
