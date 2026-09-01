import { BRAND_ICON_MAP, BRAND_ICON_META } from '$lib/data/brand-icons.generated'
import type { ThemeMode } from '$lib/types/theme'

export type BrandIconSlug = keyof typeof BRAND_ICON_MAP

type IconResolution = {
  slug: BrandIconSlug | null
  icon: string
  monochrome: boolean
  brandColor: string | null
  usesCurrentColor: boolean
}

const DEFAULT_ICON_SLUG: null = null
const DEFAULT_ICON = '/batshit-icon-dark-ios.png'

const COMMON_SUFFIXES = ['ai', 'org', 'labs', 'lab', 'inc', 'tech', 'team', 'research', 'group', 'cloud', 'studio', 'systems']

const PROVIDER_SLUG_OVERRIDES: Record<string, BrandIconSlug | string> = {
  '@n8n/n8n-nodes-langchain.lmchatopenai': 'openai-mono',
  '@n8n/n8n-nodes-langchain.lmchatanthropic': 'claude-color',
  '@n8n/n8n-nodes-langchain.lmchatazureopenai': 'azure-color',
  '@n8n/n8n-nodes-langchain.lmchatawsbedrock': 'bedrock-color',
  '@n8n/n8n-nodes-langchain.lmchatcohere': 'cohere-color',
  '@n8n/n8n-nodes-langchain.lmchatgooglegemini': 'gemini-color',
  '@n8n/n8n-nodes-langchain.lmchatgooglevertexai': 'vertexai-color',
  '@n8n/n8n-nodes-langchain.lmchatgroq': 'groq-color-F55036',
  '@n8n/n8n-nodes-langchain.lmchatmistralai': 'mistral-color',
  '@n8n/n8n-nodes-langchain.lmchatollama': 'ollama-mono',
  '@n8n/n8n-nodes-langchain.lmchatollamamodel': 'ollama-mono',
  '@n8n/n8n-nodes-langchain.lmchatopenrouter': 'openrouter-color',
  '@n8n/n8n-nodes-langchain.lmchatxaigrok': 'grok-mono',
  '@n8n/n8n-nodes-langchain.lmcohere': 'cohere-color',
  '@n8n/n8n-nodes-langchain.lmollamamodel': 'ollama-mono',
  '@n8n/n8n-nodes-langchain.lmchathuggingfaceinference': 'huggingface-color',
  '@n8n/n8n-nodes-langchain.lmchatdeepseek': 'deepseek-color',
  azureopenai: 'azure-color',
  'azure-openai': 'azure-color',
  azureopenaicredentialsapi: 'azure-color',
  'aws-bedrock': 'bedrock-color',
  awsbedrock: 'bedrock-color',
  anthropic: 'claude-color',
  claude: 'claude-color',
  openrouter: 'openrouter-color',
  openroutergateway: 'openrouter-color',
  openai: 'openai-mono',
  fal: 'fal-color',
  'fal-ai': 'fal-color',
  codex: 'codex-color',
  'codex-cli': 'codex-color',
  'openai-codex': 'codex-color',
  google: 'google-color',
  'google-gemini': 'gemini-color',
  googlegemini: 'gemini-color',
  'google-vertex-ai': 'vertexai-color',
  googlevertex: 'vertexai-color',
  mistral: 'mistral-color',
  mistralai: 'mistral-color',
  groq: 'groq-color-F55036',
  cohere: 'cohere-color',
  huggingface: 'huggingface-color',
  deepseek: 'deepseek-color',
  deepgram: 'deepgram-color',
  fish: 'fishaudio-mono',
  fishaudio: 'fishaudio-mono',
  cartesia: 'cartesia-color',
  async: 'async-color',
  mimo: 'mimo-color',
  minimax: 'minimax-color',
  alibaba: 'alibaba-color',
  alibabacloud: 'alibaba-color',
  stepfun: 'stepfun-color',
  livekit: 'livekit-color',
  inworld: 'inworld-mono',
  azurespeech: 'azure-color',
  zai: 'zai-mono',
  zai_coding: 'zai-mono',
  'x-ai': 'xai-mono',
  xai: 'xai-mono',
  'meta-llama': 'meta-color',
  meta: 'meta-color',
  amazon: 'aws-color',
  'vercel-gateway': 'vercel-mono',
  vercel: 'vercel-mono',
  lmstudio: 'lmstudio-mono',
  vllm: 'vllm-mono',
  llamacpp: 'llamacpp-color',
  'llama-cpp': 'llamacpp-color',
  dmr: 'docker-color',
  dockermodelrunner: 'docker-color',
  'docker-model-runner': 'docker-color',
  wan: 'wan-color',
  wan22: 'wan-color',
  'wan-2-2': 'wan-color',
  moonshotai: 'moonshot-mono',
  'stepfun-ai': 'stepfun-color',
  bytedance: 'bytedance-color',
  together: 'together-color',
  togetherai: 'together-color',
  perplexity: 'perplexity-color',
  qwen: 'qwen-color',
  qwencloud: 'qwen-color',
  qwen_token_plan: 'qwen-color',
  kimi: 'kimi-color',
  hailuo: 'hailuo-color',
  baidu: 'baidu-color',
  baichuan: 'baichuan-color',
  tencent: 'tencent-color',
  voyage: 'voyage-color'
}

export const providerBackgrounds: Record<string, string> = {
}

export const darkModeInvertIcons = [
  'anthropic-mono.svg',
  'openai-mono.svg',
  'codex-mono.svg',
  'xai-mono.svg',
  'ollama-mono.svg',
  'moonshot-mono.svg',
  'openrouter-mono.svg',
  'github-mono.svg',
  'grok-mono.svg',
  'mcp-mono.svg',
  'elevenlabs-mono.svg',
  'fishaudio-mono.svg',
  'inworld-mono.svg',
  'mimo-color.svg',
  'vercel-mono.svg'
]

const monochromeBrandIconPaths = new Set<string>(
  Object.keys(BRAND_ICON_MAP)
    .filter((slug) => iconIsMonochrome(slug as BrandIconSlug))
    .map((slug) => BRAND_ICON_MAP[slug as BrandIconSlug])
)

function sanitize(value?: string | null) {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? ''
}

function stripCommonSuffixes(value: string) {
  let result = value
  let updated = true
  while (updated) {
    updated = false
    for (const suffix of COMMON_SUFFIXES) {
      if (result.length > suffix.length + 2 && result.endsWith(suffix)) {
        result = result.slice(0, -suffix.length)
        updated = true
      }
    }
  }
  return result
}

function buildCandidateList(...values: Array<string | undefined>) {
  const ordered: string[] = []
  const seen = new Set<string>()

  const push = (raw?: string | null) => {
    if (!raw) return
    const sanitized = sanitize(raw)
    if (sanitized.length < 3) return
    const stripped = stripCommonSuffixes(sanitized)

    if (!seen.has(sanitized)) {
      ordered.push(sanitized)
      seen.add(sanitized)
    }
    if (stripped !== sanitized && !seen.has(stripped)) {
      ordered.push(stripped)
      seen.add(stripped)
    }
  }

  values.forEach((value) => {
    if (!value) return
    push(value)
    value
      .replace(/\s+/g, ' ')
      .trim()
      .split(/[^a-zA-Z0-9]+/)
      .forEach((segment) => push(segment))
  })

  return ordered
}

function findSlugForCandidate(candidate?: string) {
  if (!candidate) return undefined
  const attempts = [
    `${candidate}-color`,
    `${candidate}-mono`,
    `${candidate}-brand`,
    `${candidate}-logo`,
    `${candidate}-dark`,
    `${candidate}-light`,
    candidate
  ]
  for (const attempt of attempts) {
    if (BRAND_ICON_MAP[attempt as BrandIconSlug]) {
      return attempt as BrandIconSlug
    }
  }
  return undefined
}

function iconSlugToPath(slug?: BrandIconSlug | null) {
  if (!slug) return DEFAULT_ICON
  return BRAND_ICON_MAP[slug] ?? DEFAULT_ICON
}

function getIconMeta(slug?: BrandIconSlug | null) {
  if (!slug) return undefined
  return BRAND_ICON_META[slug]
}

function iconIsMonochrome(slug?: BrandIconSlug | null) {
  if (!slug) return false
  const meta = BRAND_ICON_META[slug]
  if (typeof meta?.monochrome === 'boolean') return meta.monochrome
  return !slug.includes('color') && !slug.includes('brand')
}

function applyThemeVariant(slug?: BrandIconSlug | null, theme?: ThemeMode) {
  if (!slug || !theme) return slug ?? null
  if (slug.endsWith('-dark') || slug.endsWith('-light')) return slug
  const themed = `${slug}-${theme}` as BrandIconSlug
  if (BRAND_ICON_MAP[themed]) return themed
  return slug
}

function resolveProviderIconSlug(providerId?: string | null, fallbackProviderId?: string | null) {
  if (!providerId) {
    if (fallbackProviderId) {
      return resolveProviderIconSlug(fallbackProviderId, null)
    }
    return DEFAULT_ICON_SLUG
  }
  const normalized = providerId.toLowerCase()
  const sanitized = sanitize(providerId)
  const override = PROVIDER_SLUG_OVERRIDES[normalized] ?? PROVIDER_SLUG_OVERRIDES[sanitized]
  if (override && BRAND_ICON_MAP[override as BrandIconSlug]) {
    return override as BrandIconSlug
  }

  const candidates = buildCandidateList(normalized)
  for (const candidate of candidates) {
    const slug = findSlugForCandidate(candidate)
    if (slug) {
      return slug
    }
  }

  if (fallbackProviderId) {
    const fallbackSanitized = sanitize(fallbackProviderId)
    if (fallbackSanitized && fallbackSanitized !== sanitized) {
      return resolveProviderIconSlug(fallbackProviderId, null)
    }
  }

  return DEFAULT_ICON_SLUG
}

function resolveModelIconSlug(
  modelId?: string | null,
  providerId?: string | null,
  modelName?: string | null,
  fallbackProviderId?: string | null
) {
  const candidates = buildCandidateList(modelName ?? undefined, modelId ?? undefined)
  for (const candidate of candidates) {
    const slug = findSlugForCandidate(candidate)
    if (slug) {
      return slug
    }
  }
  return resolveProviderIconSlug(providerId, fallbackProviderId)
}

function resolveProviderIcon(
  providerId?: string | null,
  theme?: ThemeMode,
  fallbackProviderId?: string | null
): IconResolution {
  const baseSlug = resolveProviderIconSlug(providerId, fallbackProviderId)
  const slug = applyThemeVariant(baseSlug, theme)
  const meta = getIconMeta(slug)
  return {
    slug,
    icon: iconSlugToPath(slug),
    monochrome: iconIsMonochrome(slug),
    brandColor: meta?.brandColor ?? null,
    usesCurrentColor: meta?.usesCurrentColor ?? false
  }
}

function resolveModelIcon(
  modelId?: string | null,
  providerId?: string | null,
  customIconPath?: string | null,
  modelName?: string | null,
  theme?: ThemeMode,
  fallbackProviderId?: string | null
): IconResolution {
  if (customIconPath) {
    return {
      slug: null,
      icon: customIconPath,
      monochrome: false,
      brandColor: null,
      usesCurrentColor: false
    }
  }

  const baseSlug = resolveModelIconSlug(modelId, providerId, modelName, fallbackProviderId)
  const slug = applyThemeVariant(baseSlug, theme)
  const meta = getIconMeta(slug)
  return {
    slug,
    icon: iconSlugToPath(slug),
    monochrome: iconIsMonochrome(slug),
    brandColor: meta?.brandColor ?? null,
    usesCurrentColor: meta?.usesCurrentColor ?? false
  }
}

export function getProviderIcon(providerId: string, theme?: ThemeMode) {
  return resolveProviderIcon(providerId, theme).icon
}

export function getProviderIconEntry(
  providerId: string,
  theme?: ThemeMode,
  fallbackProviderId?: string | null
): IconResolution {
  return resolveProviderIcon(providerId, theme, fallbackProviderId)
}

export function getProviderBackground(providerId: string) {
  return providerBackgrounds[providerId]
}

export function needsDarkModeInvert(iconPath: string) {
  const normalizedPath = iconPath.split(/[?#]/, 1)[0]
  if (monochromeBrandIconPaths.has(normalizedPath)) return true
  if (/\/[^/]+-mono\.svg$/i.test(normalizedPath)) return true
  return darkModeInvertIcons.some((icon) => normalizedPath.includes(icon))
}

export function getModelProviderIcons(
  modelId: string,
  providerId: string,
  customIconPath?: string,
  modelName?: string,
  theme: ThemeMode = 'dark',
  fallbackProviderId?: string | null
) {
  const providerEntry = resolveProviderIcon(providerId, theme, fallbackProviderId)
  const modelEntry = resolveModelIcon(
    modelId,
    providerId,
    customIconPath,
    modelName,
    theme,
    fallbackProviderId
  )

  return {
    modelIcon: modelEntry.icon,
    providerIcon: providerEntry.icon,
    needsBackground: !!providerBackgrounds[providerId],
    backgroundColor: providerBackgrounds[providerId],
    modelMonochrome: modelEntry.monochrome,
    providerMonochrome: providerEntry.monochrome,
    modelBrandColor: modelEntry.brandColor,
    providerBrandColor: providerEntry.brandColor,
    modelUsesCurrentColor: modelEntry.usesCurrentColor,
    providerUsesCurrentColor: providerEntry.usesCurrentColor
  }
}
