import type { ParameterDefinition } from '$lib/data/parameter-schemas'
import {
  getProviderIconEntry,
  needsDarkModeInvert
} from '$lib/utils/brandingIcons'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
import type { ModelCapabilities, ModelCompatibility } from '$lib/types/savedModels'
import type { ThemeMode } from '$lib/types/theme'

const DEVELOPER_LABEL_OVERRIDES: Record<string, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  'fal-ai': 'fal.ai',
  deepseek: 'DeepSeek',
  zai: 'Z.ai',
  zai_coding: 'Z.ai Coding Plan',
  qwen_token_plan: 'Qwen Token Plan',
  'black-forest-labs': 'Black Forest Labs',
  'stability-ai': 'Stability AI',
  huggingface: 'Hugging Face',
  alfredpros: 'AlfredPros',
  'alfred-pros': 'AlfredPros',
  bytedance: 'ByteDance',
  deepcogito: 'Deep Cogito',
  'deep-cogito': 'Deep Cogito',
  ibm: 'IBM',
  'ibm-granite': 'IBM',
  minimax: 'MiniMax',
  'mini-max': 'MiniMax',
  hunyuan: 'Hunyuan',
  hunyuan3d: 'Hunyuan3D',
  ideogram: 'Ideogram',
  recraft: 'Recraft',
  kling: 'Kling',
  vidu: 'Vidu',
  pixverse: 'PixVerse',
  meshy: 'Meshy',
  qwen: 'Qwen',
  longcat: 'LongCat',
  meta: 'Meta',
  neversleep: 'NeverSleep',
  'never-sleep': 'NeverSleep',
  nousresearch: 'NousResearch',
  'nous-research': 'NousResearch',
  nvidia: 'NVIDIA',
  opengvlab: 'OpenGVLab',
  'open-gvlab': 'OpenGVLab',
  thedrummer: 'TheDrummer',
  'the-drummer': 'TheDrummer',
  thudm: 'THUDM',
  tng: 'TNG',
  tngtech: 'TNG',
  'tng-tech': 'TNG',
  congnativecomputations: 'Cognitive Computations',
  cognitivecomputations: 'Cognitive Computations',
  elevenlabs: 'ElevenLabs',
  assemblyai: 'AssemblyAI',
  deepinfra: 'DeepInfra',
  'z-ai': 'Z.ai',
  xai: 'xAI',
  'x-ai': 'xAI',
  moonshotai: 'MoonshotAI',
  mistralai: 'Mistral AI',
  togetherai: 'Together.ai',
  fireworks: 'Fireworks AI',
  'stepfun-ai': 'StepFun AI',
  ollama: 'Ollama',
  dmr: 'Docker Model Runner',
  lmstudio: 'LM Studio',
  'llama-cpp': 'llama.cpp',
  vllm: 'vLLM'
}

const CONNECTION_ICON_OVERRIDES: Record<string, string> = {
  'vercel-gateway': 'vercel',
  openrouter: 'openrouter',
  'azure-openai': 'azure',
  'aws-bedrock': 'aws-bedrock',
  'google-vertex': 'google-vertex-ai',
  'direct:huggingface': 'huggingface',
  'direct:ollama': 'ollama',
  'direct:lmstudio': 'lmstudio',
  'direct:vllm': 'vllm',
  'direct:llama-cpp': 'ollama',
  'direct:dmr': 'dmr'
}

export function formatCompatibilityLabel(compat: ModelCompatibility | null) {
  if (!compat) return 'Unknown'
  if (compat.label === 'both') return 'Works with n8n + batshit'
  if (compat.label === 'n8n_only') return 'n8n only'
  return 'Batshit only (direct mode)'
}

export function parameterSupportLabel(supportedInN8N: boolean) {
  return supportedInN8N
    ? 'Available in API and in n8n Chat Model nodes'
    : 'Available in API only'
}

export function formatDeveloperLabel(developerId?: string | null) {
  if (!developerId) return 'Unknown'
  const normalized = developerId.trim().toLowerCase()
  if (!normalized) return 'Unknown'
  const override = DEVELOPER_LABEL_OVERRIDES[normalized]
  if (override) return override

  const segments = normalized.replace(/[_-]+/g, ' ').split(' ').filter(Boolean)
  if (!segments.length) return developerId

  const formatted = segments.map((segment) => {
    if (segment === 'ai') return 'AI'
    if (/^ai\d+$/.test(segment)) return `AI${segment.slice(2)}`
    if (segment.endsWith('ai') && segment.length > 2) {
      const prefix = segment.slice(0, -2)
      const prefixLabel = prefix.charAt(0).toUpperCase() + prefix.slice(1)
      return `${prefixLabel}AI`
    }
    return segment.charAt(0).toUpperCase() + segment.slice(1)
  })

  return formatted.join(' ')
}

export function resolveConnectionIconKey(option: CatalogConnectionOption): string {
  return (
    CONNECTION_ICON_OVERRIDES[option.id] ??
    option.service ??
    option.providers?.[0] ??
    'batshit-icon'
  )
}

export function getConnectionIconMeta(option: CatalogConnectionOption, theme: ThemeMode) {
  const key = resolveConnectionIconKey(option)
  const entry = getProviderIconEntry(key, theme)
  const shouldInvert = needsDarkModeInvert(entry.icon) && theme === 'dark'
  const filter = shouldInvert ? 'brightness(0) invert(1)' : ''
  return {
    icon: entry.icon,
    filter
  }
}

export type CatalogRoleFilter = 'all' | 'chat' | 'vision' | 'visual' | 'audio' | 'utility'

export const CATALOG_ROLE_OPTIONS: ReadonlyArray<{
  value: CatalogRoleFilter
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'chat', label: 'Text' },
  { value: 'vision', label: 'Vision' },
  { value: 'visual', label: 'Media' },
  { value: 'audio', label: 'Audio' },
  { value: 'utility', label: 'Utility' }
]

export function normalizeCatalogRole(value?: string | null): 'chat' | 'visual' | 'audio' | 'utility' {
  if (value === 'visual') return 'visual'
  if (value === 'vision') return 'chat'
  if (value === 'audio') return 'audio'
  if (value === 'utility') return 'utility'
  return 'chat'
}

export function matchesCatalogRole(model: CatalogModel, role: CatalogRoleFilter) {
  if (role === 'all') return true
  if (role === 'vision') {
    const hasVision = model.features?.vision === true || String(model.purpose) === 'vision'
    return hasVision && normalizeCatalogRole(model.purpose ?? null) === 'chat'
  }
  return normalizeCatalogRole(model.purpose ?? null) === role
}

export function formatN8NStatus(status?: CatalogConnectionOption['n8nStatus']) {
  if (status === 'ready') return 'Ready'
  if (status === 'locked') return 'Missing'
  return 'Unknown'
}

export function almostEqual(a?: number, b?: number) {
  if (a === undefined || b === undefined) return false
  return Math.abs(a - b) < 0.0001
}

function stripNumericFormatting(value: unknown) {
  return String(value ?? '')
    .replace(/[$,\s]/g, '')
    .trim()
}

export function parseFormattedNumber(value: unknown) {
  const normalized = stripNumericFormatting(value)
  if (!normalized.length || normalized === '-' || normalized === '.' || normalized === '-.') {
    return undefined
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseFormattedInteger(value: unknown) {
  const parsed = parseFormattedNumber(value)
  return parsed === undefined ? undefined : Math.trunc(parsed)
}

function countFractionDigits(step?: number | string | null) {
  if (step === undefined || step === null) return 0
  const stepString = typeof step === 'number' ? step.toString() : String(step).trim()
  if (!stepString.length) return 0
  const normalized = stepString.toLowerCase()
  if (normalized.includes('e-')) {
    const exponent = Number.parseInt(normalized.split('e-')[1] ?? '', 10)
    return Number.isFinite(exponent) ? exponent : 0
  }
  const [, fraction = ''] = normalized.split('.')
  return fraction.length
}

function formatNumberDisplay(
  value: number,
  options: {
    minimumFractionDigits?: number
    maximumFractionDigits?: number
    useGrouping?: boolean
  } = {}
) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 3,
    useGrouping: options.useGrouping ?? true
  }).format(value)
}

export function formatCurrencyDisplay(value: unknown) {
  const parsed = parseFormattedNumber(value)
  if (parsed === undefined) return ''
  return `$${formatNumberDisplay(parsed, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`
}

export function formatGroupedIntegerDisplay(value: unknown) {
  const parsed = parseFormattedInteger(value)
  if (parsed === undefined) return ''
  return formatNumberDisplay(parsed, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function formatDecimalDisplay(
  value: unknown,
  options: {
    minimumFractionDigits?: number
    maximumFractionDigits?: number
    useGrouping?: boolean
  } = {}
) {
  const parsed = parseFormattedNumber(value)
  if (parsed === undefined) return ''
  return formatNumberDisplay(parsed, {
    minimumFractionDigits: options.minimumFractionDigits ?? 1,
    maximumFractionDigits: options.maximumFractionDigits ?? 3,
    useGrouping: options.useGrouping ?? true
  })
}

export function formatFlexibleNumberDisplay(value: unknown) {
  const parsed = parseFormattedNumber(value)
  if (parsed === undefined) return ''
  if (Number.isInteger(parsed)) {
    return formatGroupedIntegerDisplay(parsed)
  }
  return formatDecimalDisplay(parsed, { minimumFractionDigits: 1, maximumFractionDigits: 6 })
}

export function toComparableNumber(value: unknown) {
  return parseFormattedNumber(value)
}

function getParameterMaximumFractionDigits(definition: ParameterDefinition) {
  const stepDigits = countFractionDigits(definition.step)
  return Math.min(Math.max(stepDigits, 1), 6)
}

export function formatParameterDisplayValue(definition: ParameterDefinition, value: string) {
  if (!value.trim().length) return ''

  switch (definition.inputType) {
    case 'integer':
      return formatGroupedIntegerDisplay(value)
    case 'number':
      return formatDecimalDisplay(value, {
        minimumFractionDigits: 1,
        maximumFractionDigits: getParameterMaximumFractionDigits(definition)
      })
    default:
      return value
  }
}

export function formatPrice(value?: number | null) {
  if (value === undefined || value === null) return null
  const formatted = Number(value).toFixed(3)
  return formatted.replace(/\.?0+$/, '')
}
