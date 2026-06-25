import {
  DEFAULT_ARTIFACT_ICON_REF,
  DEFAULT_CLI_TOOL_ICON_REF,
  DEFAULT_PROMPT_ICON_REF,
  DEFAULT_PROJECT_ICON_REF,
  DEFAULT_SKILL_ICON_REF,
  GENERAL_ICON_CATALOG,
  isCatalogIconRef
} from './iconCatalog'
import type { IconRef } from './iconTypes'
import { parseIconRef } from './iconTypes'

const EMOJI_REGEX = /\p{Extended_Pictographic}/u

const LEGACY_ICON_MAP: Record<string, IconRef> = {
  '🧠': DEFAULT_SKILL_ICON_REF,
  '✨': DEFAULT_PROMPT_ICON_REF,
  '🔍': { kind: 'lucide', id: 'search' },
  '📚': { kind: 'lucide', id: 'book-open' },
  '🎨': { kind: 'lucide', id: 'palette' },
  '🎙️': { kind: 'lucide', id: 'mic' },
  '🤗': { kind: 'brand', slug: 'huggingface-color' },
  '🔧': DEFAULT_CLI_TOOL_ICON_REF,
  '☁️': { kind: 'lucide', id: 'cloud' },
  '📁': DEFAULT_PROJECT_ICON_REF,
  '📄': { kind: 'fileType', id: 'file-text' },
  '🧩': { kind: 'lucide', id: 'puzzle' },
  '🎤': { kind: 'lucide', id: 'mic' },
  '🧰': { kind: 'lucide', id: 'wrench' }
}

const LUCIDE_NAME_MAP: Record<string, string> = {
  app: 'app-window',
  artifact: 'app-window',
  audio: 'audio-lines',
  brain: 'brain',
  code: 'code',
  command: 'command',
  file: 'file-text',
  folder: 'folder',
  image: 'image',
  mcp: 'plug',
  mic: 'mic',
  model: 'brain',
  prompt: 'sparkles',
  skill: 'brain',
  terminal: 'terminal',
  tool: 'wrench',
  video: 'video',
  voice: 'audio-lines',
  workflow: 'workflow'
}

const BRAND_NAME_MAP: Record<string, string> = {
  anthropic: 'anthropic-mono',
  comfyui: 'comfyui-color',
  docker: 'docker-color',
  elevenlabs: 'elevenlabs-mono',
  gemini: 'gemini-color',
  gradio: 'gradio-color',
  huggingface: 'huggingface-color',
  lmstudio: 'lmstudio-mono',
  llamacpp: 'llamacpp-color',
  n8n: 'n8n-color',
  ollama: 'ollama-mono',
  openai: 'openai-mono',
  qwen: 'qwen-color',
  vercel: 'vercel-mono',
  vllm: 'vllm-color',
  wan: 'wan-color'
}

const KNOWN_LUCIDE_IDS = new Set(GENERAL_ICON_CATALOG.map((entry) => entry.id))

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function isEmojiIcon(value: unknown) {
  return typeof value === 'string' && EMOJI_REGEX.test(value.trim())
}

export function normalizeIconRef(value: unknown, fallback: IconRef = DEFAULT_ARTIFACT_ICON_REF): IconRef {
  const parsed = parseIconRef(value)
  if (parsed && (parsed.kind === 'custom' || isCatalogIconRef(parsed))) return parsed

  if (typeof value !== 'string') return fallback

  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (LEGACY_ICON_MAP[trimmed]) return LEGACY_ICON_MAP[trimmed]

  const normalized = normalizeText(trimmed)
  if (BRAND_NAME_MAP[normalized]) {
    return { kind: 'brand', slug: BRAND_NAME_MAP[normalized] }
  }
  if (LUCIDE_NAME_MAP[normalized]) {
    return { kind: 'lucide', id: LUCIDE_NAME_MAP[normalized] }
  }

  if (KNOWN_LUCIDE_IDS.has(trimmed)) return { kind: 'lucide', id: trimmed }
  return isEmojiIcon(trimmed) ? fallback : fallback
}

export function normalizeOptionalIconRef(value: unknown): IconRef | null {
  const parsed = parseIconRef(value)
  if (parsed && (parsed.kind === 'custom' || isCatalogIconRef(parsed))) return parsed
  if (typeof value === 'string' && value.trim()) return normalizeIconRef(value)
  return null
}
