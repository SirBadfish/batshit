<script lang="ts">
import { onDestroy, onMount } from 'svelte'
import { Input } from '$lib/components/ui/input'
import { Button } from '$lib/components/ui/button'
import { Badge } from '$lib/components/ui/badge'
import * as Select from '$lib/components/ui/select'
import * as Card from '$lib/components/ui/card'
import * as Collapsible from '$lib/components/ui/collapsible'
import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
import CustomProvidersSettingsPanel from './CustomProvidersSettingsPanel.svelte'
import type { IconRef } from '$lib/icons/iconTypes'
import { Loader2, KeyRound, ShieldAlert, CheckCircle2, Trash2, ChevronDown, Pencil, Save, X, Copy, Sparkles, Plus } from '@lucide/svelte'
import { toast } from '$lib/components/ui/sonner/settings-toast'
import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
import { copyTextToClipboard } from '$lib/utils/clipboard'

type ApiKeyStatus = 'ready' | 'needs-config' | 'error'

type ApiKeyServiceDefinition = {
  id: string
  label: string
  description: string
  scope: 'gateway' | 'provider'
  connectionHint?: string
  docsUrl?: string
  inputType?: 'password' | 'text'
  canGenerate?: boolean
  iconRef?: IconRef
}

type ApiKeyRow = ApiKeyServiceDefinition & {
  masked: string
  status: ApiKeyStatus
  updatedAt: string
  managedByRuntime?: boolean
  defaultedByRuntime?: boolean
  runtimeLabel?: string
  inputValue: string
  editing: boolean
  visible: boolean
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string | null
  saving: boolean
  testing: boolean
  deleting: boolean
  copying?: boolean
}

const DEFAULT_API_KEY_ICON_REF: IconRef = { kind: 'lucide', id: 'key' }
const BATSHIT_ICON_REF: IconRef = { kind: 'brand', slug: 'batshit-icon' }
const DOCKER_ICON_REF: IconRef = { kind: 'brand', slug: 'docker-color' }
const N8N_ICON_REF: IconRef = { kind: 'brand', slug: 'n8n-color' }
const LIVEKIT_ICON_REF: IconRef = { kind: 'lucide', id: 'radio' }

const SERVICES: ApiKeyServiceDefinition[] = [
  {
    id: 'n8n_api_key',
    label: 'n8n API Key',
    description: 'Used for n8n workflow discovery and credential detection.',
    scope: 'gateway',
    connectionHint: 'n8n server',
    docsUrl: 'https://docs.n8n.io/reference/api/',
    iconRef: N8N_ICON_REF
  },
  {
    id: 'n8n_api_url',
    label: 'n8n URL',
    description:
      'Base URL for your n8n instance (for example https://n8n.example.com or http://localhost:5678). Do not include /api/v1.',
    scope: 'gateway',
    connectionHint: 'n8n server',
    inputType: 'text',
    iconRef: N8N_ICON_REF
  },
  {
    id: 'n8n_instance_mcp_token',
    label: 'n8n Instance MCP Token',
    description: 'Bearer token for the n8n instance MCP server (Admin → Settings → MCP). Used for instance MCP gateways and Codex.',
    scope: 'gateway',
    connectionHint: 'n8n instance MCP',
    iconRef: N8N_ICON_REF
  },
  {
    id: 'ai_gateway',
    label: 'Vercel AI Gateway',
    description: 'Unlock the hosted model catalog, routing, and caching.',
    scope: 'gateway',
    docsUrl: 'https://vercel.com/docs/ai/ai-gateway',
    iconRef: { kind: 'brand', slug: 'vercel-mono' }
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude (Sonnet, Opus, Haiku) direct connections.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'claude-color' }
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT‑4.1, GPT‑4o, o1 reasoning, and Omni voice models.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'openai-mono' }
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI',
    description: 'Kimi OpenAI-compatible chat models, including Kimi K2.6.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://platform.kimi.ai/docs/api/overview',
    iconRef: { kind: 'brand', slug: 'moonshot-mono' }
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    description: 'MiniMax M-series chat models plus MiniMax cloud text-to-speech.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
    iconRef: { kind: 'lucide', id: 'sparkles' }
  },
  {
    id: 'mimo',
    label: 'MiMo',
    description: 'Xiaomi MiMo V2.5 chat models plus MiMo V2.5 text-to-speech.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://mimo.mi.com/docs/en-US/api/chat/openai-api',
    iconRef: { kind: 'brand', slug: 'mimo-color' }
  },
  {
    id: 'qwencloud',
    label: 'Qwen Cloud',
    description: 'Qwen and other DashScope-hosted models through Alibaba Cloud Model Studio.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    iconRef: { kind: 'brand', slug: 'qwen-color' }
  },
  {
    id: 'alibaba',
    label: 'Alibaba Cloud',
    description: 'Alibaba Cloud Model Studio Qwen models plus Qwen cloud text-to-speech.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    iconRef: { kind: 'lucide', id: 'cloud' }
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    description: 'StepFun chat models plus StepFun cloud text-to-speech.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://platform.stepfun.ai/docs/en/quickstart/overview',
    iconRef: { kind: 'lucide', id: 'zap' }
  },
  {
    id: 'zai',
    label: 'Z.ai General',
    description: 'Z.ai OpenAI‑compatible models (GLM‑4.7, etc.) via the general endpoint.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.z.ai/overview/quick-start',
    iconRef: { kind: 'brand', slug: 'zai-mono' }
  },
  {
    id: 'zai_coding',
    label: 'Z.ai Coding Plan',
    description: 'Z.ai Coding Plan endpoint for the coding-plan GLM model set (live-discovered when available).',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.z.ai/devpack/tool/others',
    iconRef: { kind: 'brand', slug: 'zai-mono' }
  },
  {
    id: 'google',
    label: 'Google',
    description: 'Gemini 2.5 Pro, Flash, and experimental thinking models.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'gemini-color' }
  },
  {
    id: 'xai',
    label: 'xAI',
    description: 'Grok direct chat models and Grok Voice speech-to-speech sessions.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.x.ai/developers/rest-api-reference',
    iconRef: { kind: 'brand', slug: 'xai-mono' }
  },
  {
    id: 'fal',
    label: 'fal.ai',
    description: 'fal.ai image + audio models (Flux, Minimax TTS) for artifacts and media.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'fal-color' }
  },
  {
    id: 'fish',
    label: 'Fish Audio',
    description: 'Fish Audio realtime text-to-speech.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-stream-with-timestamps',
    iconRef: { kind: 'lucide', id: 'fish' }
  },
  {
    id: 'inworld',
    label: 'Inworld',
    description: 'Inworld cloud text-to-speech voices.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech',
    iconRef: { kind: 'lucide', id: 'audio-lines' }
  },
  {
    id: 'cartesia',
    label: 'Cartesia',
    description: 'Cartesia Sonic text-to-speech voices.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.cartesia.ai/api-reference/tts/bytes',
    iconRef: { kind: 'brand', slug: 'cartesia-color' }
  },
  {
    id: 'async',
    label: 'Async',
    description: 'Async Voice API text-to-speech.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.async.com/text-to-speech-18760785e0',
    iconRef: { kind: 'brand', slug: 'async-color' }
  },
  {
    id: 'azure_speech_key',
    label: 'Azure Speech Key',
    description: 'Microsoft Azure Speech text-to-speech resource key.',
    scope: 'provider',
    connectionHint: 'Voice provider',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech',
    iconRef: { kind: 'brand', slug: 'azure' }
  },
  {
    id: 'azure_speech_region',
    label: 'Azure Speech Region',
    description: 'Azure Speech resource region, such as eastus or westus2.',
    scope: 'provider',
    connectionHint: 'Voice provider',
    inputType: 'text',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions',
    iconRef: { kind: 'brand', slug: 'azure' }
  },
  {
    id: 'luma',
    label: 'Luma',
    description: 'Luma Photon image/video models for artifacts and media.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'luma-color' }
  },
  {
    id: 'replicate',
    label: 'Replicate',
    description: 'Replicate hosted models (Flux, etc.) for image generation.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'replicate-mono' }
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'ElevenLabs speech + transcription models.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'elevenlabs-mono' }
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    description: 'Deepgram transcription models (Nova, etc.).',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'deepgram-color' }
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    description: 'AssemblyAI transcription models (Best/Nano).',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'assemblyai-color' }
  },
  {
    id: 'cohere',
    label: 'Cohere',
    description: 'Cohere chat, embeddings, rerank, and transcription models.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'cohere-color' }
  },
  {
    id: 'exa',
    label: 'Exa',
    description: 'API key for Native Web Search when provider is set to Exa.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.exa.ai/reference/search',
    iconRef: { kind: 'brand', slug: 'exa-color' }
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    description: 'API key for Native Web Search when provider is set to Perplexity.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.perplexity.ai/api-reference/search-post',
    iconRef: { kind: 'brand', slug: 'perplexity-color' }
  },
  {
    id: 'browserbase',
    label: 'Browserbase',
    description: 'API key for Agent Browser cloud provider mode (Browserbase).',
    scope: 'provider',
    connectionHint: 'Cloud provider',
    docsUrl: 'https://docs.browserbase.com/introduction/getting-started',
    iconRef: { kind: 'lucide', id: 'app-window' }
  },
  {
    id: 'browserbase_project_id',
    label: 'Browserbase Project ID',
    description: 'Required project/workspace ID for Browserbase sessions.',
    scope: 'provider',
    connectionHint: 'Cloud provider',
    inputType: 'text',
    docsUrl: 'https://docs.browserbase.com/introduction/getting-started',
    iconRef: { kind: 'lucide', id: 'app-window' }
  },
  {
    id: 'browserbase_api_url',
    label: 'Browserbase API URL',
    description: 'Optional Browserbase API URL override (advanced networking setups).',
    scope: 'provider',
    connectionHint: 'Cloud provider',
    inputType: 'text',
    docsUrl: 'https://docs.browserbase.com/introduction/getting-started',
    iconRef: { kind: 'lucide', id: 'app-window' }
  },
  {
    id: 'browseruse',
    label: 'Browser Use',
    description: 'API key for Agent Browser cloud provider mode (Browser Use).',
    scope: 'provider',
    connectionHint: 'Cloud provider',
    docsUrl: 'https://docs.browser-use.com/',
    iconRef: { kind: 'lucide', id: 'bot' }
  },
  {
    id: 'browseruse_base_url',
    label: 'Browser Use Base URL',
    description: 'Optional Browser Use API base URL override.',
    scope: 'provider',
    connectionHint: 'Cloud provider',
    inputType: 'text',
    docsUrl: 'https://docs.browser-use.com/',
    iconRef: { kind: 'lucide', id: 'bot' }
  },
  {
    id: 'kernel',
    label: 'Kernel',
    description: 'API key for Agent Browser cloud provider mode (Kernel).',
    scope: 'provider',
    connectionHint: 'Cloud provider',
    iconRef: { kind: 'lucide', id: 'cloud' }
  },
  {
    id: 'kernel_base_url',
    label: 'Kernel Base URL',
    description: 'Optional Kernel API base URL override.',
    scope: 'provider',
    connectionHint: 'Cloud provider',
    inputType: 'text',
    iconRef: { kind: 'lucide', id: 'cloud' }
  },
  {
    id: 'livekit_url',
    label: 'LiveKit URL',
    description: 'LiveKit server URL for voice sessions, such as wss://voice.example.com or ws://localhost:7880.',
    scope: 'gateway',
    connectionHint: 'Voice runtime',
    inputType: 'text',
    docsUrl: 'https://docs.livekit.io/home/self-hosting/',
    iconRef: LIVEKIT_ICON_REF
  },
  {
    id: 'livekit_api_key',
    label: 'LiveKit API Key',
    description: 'API key used server-side to mint LiveKit room tokens and dispatch Batshit voice agents.',
    scope: 'gateway',
    connectionHint: 'Voice runtime',
    docsUrl: 'https://docs.livekit.io/home/self-hosting/',
    iconRef: LIVEKIT_ICON_REF
  },
  {
    id: 'livekit_api_secret',
    label: 'LiveKit API Secret',
    description: 'API secret used server-side for LiveKit room token signing. Never send this to the browser.',
    scope: 'gateway',
    connectionHint: 'Voice runtime',
    docsUrl: 'https://docs.livekit.io/home/self-hosting/',
    iconRef: LIVEKIT_ICON_REF
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    description: 'DeepInfra hosted chat models through the built-in model catalog.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'deepinfra-color' }
  },
  {
    id: 'togetherai',
    label: 'Together.ai',
    description: 'Together.ai hosted chat models through the built-in model catalog.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'together-color' }
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    description: 'Fireworks serverless models through the built-in model catalog.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'fireworks-color' }
  },
  {
    id: 'baseten',
    label: 'Baseten',
    description: 'Baseten Model API models through the built-in model catalog.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'baseten-mono' }
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    description: 'Cerebras inference models through the built-in model catalog.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'cerebras-color' }
  },
  {
    id: 'mistral',
    label: 'Mistral',
    description: 'Mistral Large, Medium, and Codestral access.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'mistral-color' }
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Groq’s ultra‑low latency Llama and Mixtral endpoints.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'groq-color-F55036' }
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Route through OpenRouter to hundreds of community models.',
    scope: 'provider',
    connectionHint: 'Router',
    iconRef: { kind: 'brand', slug: 'openrouter-color' }
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek chat + code direct access.',
    scope: 'provider',
    connectionHint: 'Direct',
    iconRef: { kind: 'brand', slug: 'deepseek-color' }
  },
  {
    id: 'huggingface',
    label: 'HuggingFace',
    description: 'HF_TOKEN for Gradio client, private Spaces, and higher API rate limits.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://huggingface.co/docs/hub/security-tokens',
    iconRef: { kind: 'brand', slug: 'huggingface-color' }
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'GITHUB_TOKEN for private repos, higher rate limits, and authenticated API access.',
    scope: 'provider',
    connectionHint: 'Direct',
    docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    iconRef: { kind: 'brand', slug: 'github-mono' }
  },
  {
    id: 'batshit_token',
    label: 'Batshit Internal Token',
    description:
      'Authorizes internal Batshit helper tools. Managed by the active runtime environment: root .env for source installs, Mac runtime env for the packaged app, and .env.docker / Docker Compose for Docker.',
    scope: 'gateway',
    connectionHint: 'batshit-server',
    canGenerate: true,
    iconRef: BATSHIT_ICON_REF
  },
  {
    id: 'batshit_artifact_complete_url',
    label: 'Artifact Complete URL',
    description: 'Internal URL used by batshit-server for the Artifact Built-in AI fallback. Most setups should leave this blank so Batshit auto-uses the default. Only set this for advanced networking (reverse proxy, container network, or remote host) where batshit-server cannot reach the default URL.',
    scope: 'gateway',
    connectionHint: 'batshit-server',
    inputType: 'text',
    iconRef: BATSHIT_ICON_REF
  }
]

type ApiKeyGroup = {
  id: string
  label: string
  description?: string
  serviceIds?: string[]
  includeGatewayToken?: boolean
  showAllRows?: boolean
  allowAdd?: boolean
  kind?: 'keys' | 'custom'
}

const GROUPS: ApiKeyGroup[] = [
  {
    id: 'core',
    label: 'Core Infrastructure',
    description: 'n8n + Batshit services, gateway tokens, and internal URLs.',
    serviceIds: [
      'batshit_artifact_complete_url',
      'batshit_token',
      'n8n_api_key',
      'n8n_instance_mcp_token',
      'n8n_api_url'
    ],
    includeGatewayToken: true,
    showAllRows: true
  },
  {
    id: 'voice-runtime',
    label: 'Voice Runtime',
    description: 'LiveKit and other realtime voice-session runtime credentials.',
    serviceIds: ['livekit_url', 'livekit_api_key', 'livekit_api_secret'],
    showAllRows: true
  },
  {
    id: 'providers',
    label: 'Providers',
    description: 'Provider, router, media, search, browser, and developer credentials.',
    serviceIds: [
      'anthropic',
      'alibaba',
      'assemblyai',
      'async',
      'azure_speech_key',
      'azure_speech_region',
      'baseten',
      'browseruse',
      'browseruse_base_url',
      'browserbase',
      'browserbase_api_url',
      'browserbase_project_id',
      'cartesia',
      'cerebras',
      'cohere',
      'deepgram',
      'deepinfra',
      'deepseek',
      'elevenlabs',
      'exa',
      'fal',
      'fish',
      'fireworks',
      'github',
      'google',
      'groq',
      'huggingface',
      'kernel',
      'kernel_base_url',
      'luma',
      'inworld',
      'minimax',
      'mimo',
      'mistral',
      'moonshot',
      'openai',
      'openrouter',
      'perplexity',
      'qwencloud',
      'replicate',
      'stepfun',
      'togetherai',
      'xai',
      'ai_gateway',
      'zai_coding',
      'zai'
    ],
    allowAdd: true
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-Compatible',
    description: 'Bring your own OpenAI-compatible endpoints for API agents. Models must be entered manually.',
    kind: 'custom'
  }
]

const createRow = (definition: ApiKeyServiceDefinition): ApiKeyRow => ({
  ...definition,
  masked: '',
  status: 'needs-config',
  updatedAt: '',
  managedByRuntime: false,
  defaultedByRuntime: false,
  runtimeLabel: undefined,
  inputValue: '',
  editing: false,
  visible: false,
  saveState: 'idle',
  saveError: null,
  saving: false,
  testing: false,
  deleting: false,
  copying: false
})

let keyRows = $state<ApiKeyRow[]>(SERVICES.map(createRow))
let isLoading = $state(true)
let loadError = $state<string | null>(null)
let openGroupId = $state<string | null>(null)
let addServiceSelections = $state<Record<string, string>>({})

let gatewayToken = $state<string | null>(null)
let gatewayTokenLoading = $state(true)
let gatewayTokenError = $state<string | null>(null)
let gatewayTokenCopying = $state(false)
let serviceEnvSyncError = $state<string | null>(null)
const autosaveResetTimers = new Map<string, ReturnType<typeof setTimeout>>()

const SERVICE_ENV_PATH = 'batshit-server/server/.env'
const API_KEYS_EMPTY_MESSAGE = 'No API keys saved yet.'
const API_KEYS_LOAD_ERROR_MESSAGE = 'Failed to load API keys.'

let savedApiKeyCount = $derived(keyRows.filter((row) => row.status === 'ready').length)
let showNoSavedApiKeysNotice = $derived(!isLoading && !loadError && savedApiKeyCount === 0)

async function readApiKeysLoadError(response: Response) {
  const payload = await response.json().catch(() => null)
  const message = payload?.error
  return typeof message === 'string' && message.trim().length > 0
    ? message
    : API_KEYS_LOAD_ERROR_MESSAGE
}

async function syncServiceEnv() {
  const resp = await fetch('/api/runtime/service-env', { method: 'POST' })
  const data = await resp.json().catch(() => null)
  if (resp.ok) {
    serviceEnvSyncError = null
    toast.success(
      data?.managedByRuntime
        ? 'Runtime-managed BATSHIT_TOKEN is already configured.'
        : 'batshit-server/.env updated'
    )
    return
  }

  const err = data?.error || 'Failed to update batshit-server environment file.'
  serviceEnvSyncError = `${err} Manual fallback for host installs: copy the token and paste BATSHIT_TOKEN into ${SERVICE_ENV_PATH}, then restart batshit-server. Docker installs should update BATSHIT_TOKEN in .env.docker and restart the Compose stack.`
  toast.error('Auto-sync failed. Use the runtime env fallback.')
}

function generateHex(bytes = 32) {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

onMount(async () => {
  await Promise.all([loadKeys(), loadGatewayToken()])
})

onDestroy(() => {
  for (const timer of autosaveResetTimers.values()) {
    clearTimeout(timer)
  }
  autosaveResetTimers.clear()
})

function updateRow(serviceId: string, updater: (row: ApiKeyRow) => ApiKeyRow) {
  keyRows = keyRows.map((row) => (row.id === serviceId ? updater(row) : row))
}

function isApiKeyRow(row: ApiKeyRow | undefined): row is ApiKeyRow {
  return Boolean(row)
}

function getGroupRows(group: ApiKeyGroup) {
  if (group.kind === 'custom') return []
  return (group.serviceIds ?? [])
    .map((serviceId) => keyRows.find((row) => row.id === serviceId))
    .filter(isApiKeyRow)
    .filter((row) => group.showAllRows || row.status === 'ready' || row.visible)
}

function getGroupHiddenRows(group: ApiKeyGroup) {
  if (group.kind === 'custom') return []
  return (group.serviceIds ?? [])
    .map((serviceId) => keyRows.find((row) => row.id === serviceId))
    .filter(isApiKeyRow)
    .filter((row) => row.status !== 'ready' && !row.visible)
}

function getGroupReadyCount(group: ApiKeyGroup) {
  return getGroupRows(group).filter((row) => row.status === 'ready').length
}

function handleAddServiceSelection(groupId: string, value: string | string[] | undefined) {
  const serviceId = Array.isArray(value) ? value[0] : value
  if (!serviceId) return

  clearAutosaveResetTimer(serviceId)
  updateRow(serviceId, (current) => ({
    ...current,
    visible: true,
    editing: true,
    inputValue: '',
    saveError: null,
    saveState: 'idle'
  }))
  addServiceSelections = { ...addServiceSelections, [groupId]: '' }
}

function maskSecret(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 4) return 'Stored'
  return `••••${trimmed.slice(-4)}`
}

function summarizeStoredValue(row: ApiKeyRow, value: string) {
  if (row.inputType === 'text') {
    return value.length > 48 ? `${value.slice(0, 45)}...` : value
  }
  return maskSecret(value)
}

function clearAutosaveResetTimer(serviceId: string) {
  const timer = autosaveResetTimers.get(serviceId)
  if (!timer) return
  clearTimeout(timer)
  autosaveResetTimers.delete(serviceId)
}

function scheduleAutosaveReset(serviceId: string) {
  clearAutosaveResetTimer(serviceId)
  const timer = setTimeout(() => {
    updateRow(serviceId, (current) =>
      current.saveState === 'saved' ? { ...current, saveState: 'idle' } : current
    )
    autosaveResetTimers.delete(serviceId)
  }, 2000)
  autosaveResetTimers.set(serviceId, timer)
}

function setRowInputValue(serviceId: string, value: string) {
  updateRow(serviceId, (current) => ({
    ...current,
    inputValue: value,
    saveError: null,
    saveState: 'idle'
  }))

  clearAutosaveResetTimer(serviceId)
}

function isRuntimeManagedService(rowOrId: ApiKeyRow | string) {
  const row =
    typeof rowOrId === 'string' ? keyRows.find((entry) => entry.id === rowOrId) : rowOrId
  return row?.managedByRuntime === true
}

function canCopyRuntimeManagedKey(row: ApiKeyRow) {
  return row.managedByRuntime === true && row.id === 'batshit_token'
}

function isDockerManagedRuntime(row: ApiKeyRow) {
  return row.runtimeLabel?.toLowerCase().includes('docker') === true
}

function isMacManagedRuntime(row: ApiKeyRow) {
  return row.runtimeLabel?.toLowerCase().includes('mac') === true
}

function runtimeManagedMessage(row: ApiKeyRow) {
  if (isMacManagedRuntime(row)) {
    return `${row.label} is already generated by the Mac runtime. Copy it only for older/custom service-token workflows when needed.`
  }
  if (isDockerManagedRuntime(row)) {
    return `${row.label} is managed by the Docker runtime. Update .env.docker and restart containers to change it.`
  }
  return `${row.label} is managed by the source runtime. Update root .env and restart services to change it.`
}

function runtimeManagedHelp(row: ApiKeyRow) {
  if (isMacManagedRuntime(row)) {
    return 'Runtime Doctor already generated this token. Copy it only for older/custom service-token workflows when needed.'
  }
  if (isDockerManagedRuntime(row)) {
    return 'Update .env.docker and restart containers to change it.'
  }
  return "If you'd like to change this, update BATSHIT_TOKEN in the root .env file and restart services."
}

function runtimeManagedStoredLabel(row: ApiKeyRow) {
  if (row.defaultedByRuntime) return 'Default value'
  return row.id === 'batshit_token' ? 'Runtime token' : 'Runtime value'
}

function startRowEdit(row: ApiKeyRow) {
  if (isRuntimeManagedService(row)) {
    toast.info(runtimeManagedMessage(row))
    return
  }

  clearAutosaveResetTimer(row.id)
  updateRow(row.id, (current) => ({
    ...current,
    visible: true,
    editing: true,
    inputValue: current.inputType === 'text' ? current.masked : '',
    saveError: null,
    saveState: 'idle'
  }))
}

function cancelRowEdit(row: ApiKeyRow) {
  clearAutosaveResetTimer(row.id)
  updateRow(row.id, (current) => ({
    ...current,
    visible: current.status === 'ready',
    editing: false,
    inputValue: '',
    saveError: null,
    saveState: 'idle'
  }))
}

async function loadKeys() {
  isLoading = true
  loadError = null

  try {
    const response = await fetch('/api/settings/api-keys')
    if (!response.ok) {
      throw new Error(await readApiKeysLoadError(response))
    }
    const payload = await response.json()
    const keys = payload?.keys ?? {}

    keyRows = SERVICES.map((definition) => {
      const record = keys[definition.id]
      return {
        ...definition,
        masked: record?.masked ?? '',
        status: record?.status ?? 'needs-config',
        updatedAt: record?.updatedAt ?? '',
        managedByRuntime: record?.managedByRuntime === true,
        defaultedByRuntime: record?.defaultedByRuntime === true,
        runtimeLabel: typeof record?.runtimeLabel === 'string' ? record.runtimeLabel : undefined,
        inputValue: '',
        editing: false,
        visible: record?.status === 'ready',
        saveState: 'idle',
        saveError: null,
        saving: false,
        testing: false,
        deleting: false
      } satisfies ApiKeyRow
    })
  } catch (error) {
    console.error('Failed to load API keys:', error)
    loadError = error instanceof Error ? error.message : API_KEYS_LOAD_ERROR_MESSAGE
  } finally {
    isLoading = false
  }
}

async function loadGatewayToken() {
  gatewayTokenLoading = true
  gatewayTokenError = null
  try {
    const resp = await fetch('/api/mcp/gateway/token')
    if (!resp.ok) throw new Error('Failed to load gateway token')
    const data = await resp.json()
    gatewayToken = data?.token ?? null
  } catch (error) {
    console.error('Failed to load gateway token:', error)
    gatewayTokenError = error instanceof Error ? error.message : 'Failed to load gateway token'
  } finally {
    gatewayTokenLoading = false
  }
}

function formatUpdatedAt(value: string) {
  if (!value) return '...'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '...'
  return `Updated ${date.toLocaleString()}`
}

function toggleGroup(groupId: string) {
  openGroupId = openGroupId === groupId ? null : groupId
}

async function persistRowValue(serviceId: string) {
  const row = keyRows.find((entry) => entry.id === serviceId)
  const key = row?.inputValue.trim() ?? ''
  if (!row) return

  if (isRuntimeManagedService(row)) {
    toast.info(runtimeManagedMessage(row))
    return
  }

  if (!key) {
    updateRow(serviceId, (current) => ({
      ...current,
      saveState: 'error',
      saveError: row.inputType === 'text' ? 'Enter a value before saving.' : 'Paste a key before saving.'
    }))
    return
  }

  updateRow(serviceId, (current) => ({
    ...current,
    saving: true,
    saveState: 'saving',
    saveError: null
  }))

  try {
    const response = await fetch('/api/settings/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: serviceId, apiKey: key })
    })

    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to save API key')
    }

    updateRow(serviceId, (current) => ({
      ...current,
      masked: payload?.masked ?? summarizeStoredValue(current, key),
      status: 'ready',
      updatedAt: new Date().toISOString(),
      inputValue: '',
      editing: false,
      visible: true,
      saving: false,
      saveState: 'saved',
      saveError: null
    }))
    scheduleAutosaveReset(serviceId)
    if (row.scope === 'provider') {
      dispatchModelConnectionsUpdated('api-keys')
    }

    const runtimeManagedKeys = new Set(['batshit_token', 'batshit_artifact_complete_url'])
    if (runtimeManagedKeys.has(serviceId)) {
      await syncServiceEnv()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save API key'
    updateRow(serviceId, (current) => ({
      ...current,
      saving: false,
      saveState: 'error',
      saveError: message
    }))
  }
}

async function testKey(row: ApiKeyRow) {
  if (isRuntimeManagedService(row)) {
    toast.info(runtimeManagedMessage(row))
    return
  }

  updateRow(row.id, (current) => ({ ...current, testing: true }))

  try {
    let key = row.inputValue.trim()
    if (!key && row.status === 'ready') {
      key = (await retrieveStoredKey(row.id)) ?? ''
    }

    if (!key) {
      toast.warning(row.status === 'ready' ? 'Stored value could not be loaded for testing.' : 'Enter a value to test.')
      return
    }

    const response = await fetch('/api/settings/api-keys/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: row.id, apiKey: key })
    })

    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      const message = payload?.error || 'API key test failed'
      throw new Error(message)
    }

    const message = payload?.message || `${row.label} key format looks valid.`
    if (payload?.verified === true) {
      toast.success(message)
    } else {
      toast.info(message)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to test API key'
    toast.error(message)
  } finally {
    updateRow(row.id, (current) => ({ ...current, testing: false }))
  }
}

async function deleteKey(row: ApiKeyRow) {
  if (isRuntimeManagedService(row)) {
    toast.info(runtimeManagedMessage(row))
    return
  }

  if (row.status === 'needs-config') {
    toast.info('No key stored for this service.')
    return
  }

  clearAutosaveResetTimer(row.id)
  updateRow(row.id, (current) => ({ ...current, deleting: true }))

  try {
    const response = await fetch('/api/settings/api-keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: row.id })
    })

    if (!response.ok) {
      throw new Error('Failed to delete API key')
    }

    toast.success(`${row.label} key removed.`)
    updateRow(row.id, (current) => ({
      ...current,
      masked: '',
      status: 'needs-config',
      updatedAt: '',
      inputValue: '',
      editing: false,
      visible: false,
      deleting: false,
      saveState: 'idle',
      saveError: null
    }))
    if (row.scope === 'provider') {
      dispatchModelConnectionsUpdated('api-keys')
    }

    const runtimeManagedKeys = new Set(['batshit_token', 'batshit_artifact_complete_url'])
    if (runtimeManagedKeys.has(row.id)) {
      await fetch('/api/runtime/service-env', { method: 'DELETE' })
      serviceEnvSyncError = null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete API key'
    toast.error(message)
    updateRow(row.id, (current) => ({ ...current, deleting: false }))
  }
}

async function retrieveStoredKey(serviceId: string) {
  const resp = await fetch('/api/settings/api-keys/retrieve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: serviceId })
  })
  if (!resp.ok) return null
  const data = await resp.json().catch(() => null)
  return typeof data?.apiKey === 'string' ? data.apiKey : null
}

async function copyKey(row: ApiKeyRow) {
  if (row.copying) return
  if (isRuntimeManagedService(row) && !canCopyRuntimeManagedKey(row)) {
    toast.info(runtimeManagedMessage(row))
    return
  }

  updateRow(row.id, (current) => ({ ...current, copying: true }))
  try {
    const value = await retrieveStoredKey(row.id)
    if (value) {
      await copyTextToClipboard(value)
      toast.success('Copied')
    } else {
      throw new Error('Key not found')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to copy key'
    toast.error(message)
  } finally {
    updateRow(row.id, (current) => ({ ...current, copying: false }))
  }
}

async function copyGatewayToken() {
  if (!gatewayToken || gatewayTokenCopying) return
  gatewayTokenCopying = true
  try {
    await copyTextToClipboard(gatewayToken)
    toast.success('Copied')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to copy token')
  } finally {
    gatewayTokenCopying = false
  }
}

function getServiceIconRef(row: ApiKeyServiceDefinition): IconRef {
  return row.iconRef ?? DEFAULT_API_KEY_ICON_REF
}
</script>

<div class="batshit-settings-surface">
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-center gap-1.5">
        <KeyRound class="h-4 w-4" />
        <h3 class="batshit-settings-section-title">API Keys</h3>
        <SettingsInfoMenu ariaLabel="About API Keys" contentClass="w-80">
          <p>
            Store provider credentials securely so the model catalog can enable direct and gateway
            connections without editing <code>.env</code>.
          </p>
        </SettingsInfoMenu>
      </div>
      <div class="batshit-settings-pill is-warning">
        <span class="inline-flex items-center gap-1.5">
          <ShieldAlert class="h-3.5 w-3.5" />
          Secrets stay encrypted before storage
        </span>
      </div>
    </div>

    {#if loadError}
      <Card.Root class="batshit-settings-card-danger">
        <Card.Content class="batshit-settings-card-content-spacious">{loadError}</Card.Content>
      </Card.Root>
    {:else if showNoSavedApiKeysNotice}
      <div class="batshit-settings-note is-dashed">
        {API_KEYS_EMPTY_MESSAGE}
      </div>
    {/if}

    {#if isLoading}
      <Card.Root class="batshit-settings-card batshit-settings-card-default">
        <Card.Content class="batshit-settings-card-content-spacious flex items-center gap-2">
          <Loader2 class="h-4 w-4 animate-spin" />
          Loading API keys…
        </Card.Content>
      </Card.Root>
    {:else if !loadError}
      {#each GROUPS as group}
        <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-l1-card batshit-api-key-group-card">
          <Collapsible.Root open={openGroupId === group.id}>
            {@const readyCount = group.kind !== 'custom' ? getGroupReadyCount(group) : null}
            <button
              type="button"
              class={`batshit-settings-collapsible-trigger batshit-settings-l1-card-header batshit-api-key-group-trigger flex w-full items-center justify-between gap-4 text-left ${openGroupId === group.id ? 'is-open' : ''}`}
              aria-expanded={openGroupId === group.id}
              onclick={() => toggleGroup(group.id)}
            >
              <span class="batshit-settings-accordion-card-main">
                <span class="batshit-settings-accordion-card-icon">
                  <KeyRound class="h-4 w-4" />
                </span>
                <span class="batshit-settings-accordion-card-title">{group.label}</span>
                {#if group.description}
                  <span
                    class="batshit-settings-accordion-card-info"
                    role="presentation"
                    onclick={(event) => event.stopPropagation()}
                    onkeydown={(event) => event.stopPropagation()}
                  >
                    <SettingsInfoMenu ariaLabel={`About ${group.label}`} contentClass="w-80">
                      <p>{group.description}</p>
                    </SettingsInfoMenu>
                  </span>
                {/if}
              </span>
              <span class="batshit-settings-accordion-card-side">
                {#if readyCount !== null}
                  <Badge variant="secondary">
                    {readyCount}
                    Saved
                  </Badge>
                {/if}
                <ChevronDown
                  class={`batshit-settings-accordion-card-chevron h-4 w-4 shrink-0 ${openGroupId === group.id ? 'rotate-180' : ''}`}
                />
              </span>
            </button>
            <Collapsible.Content class="batshit-api-key-group-content">
              {#if group.includeGatewayToken}
                <div class="batshit-api-key-token-row">
                  <div class="batshit-api-key-row-main">
                    <span class="batshit-api-key-icon-frame">
                      <IconRenderer
                        ref={DOCKER_ICON_REF}
                        label="Docker"
                        iconClass="h-4 w-4"
                        imageClass="object-contain"
                      />
                    </span>
                    <div class="batshit-api-key-identity">
                      <div class="batshit-api-key-title-line">
                        <p class="batshit-settings-form-label">Docker MCP Gateway Token</p>
                        <SettingsInfoMenu ariaLabel="About Docker MCP Gateway Token" contentClass="w-80">
                          <p>
                            Optional token for a Docker MCP Gateway or host-side controller. Leave this blank unless that
                            gateway/controller is configured, then paste it into your n8n MCP Client headers as
                            <code>Authorization: Bearer &lt;token&gt;</code>.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                  </div>
                  <div class="batshit-api-key-token-control">
                    <Input
                      type="password"
                      readonly
                      value={gatewayToken ?? ''}
                      placeholder={gatewayTokenLoading ? 'Loading…' : 'Not configured'}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label="Copy Docker MCP Gateway token"
                      title="Copy token"
                      disabled={!gatewayToken || gatewayTokenCopying}
                      onclick={copyGatewayToken}
                    >
                      {#if gatewayTokenCopying}
                        <Loader2 class="animate-spin" />
                      {:else}
                        <Copy  />
                      {/if}
                    </Button>
                  </div>
                  {#if gatewayTokenError}
                    <p class="batshit-settings-form-help is-danger">{gatewayTokenError}</p>
                  {/if}
                </div>

                {#if serviceEnvSyncError}
                  <Card.Root class="batshit-settings-card-danger">
                    <Card.Content class="batshit-settings-card-content-spacious space-y-2">
                      <p class="batshit-settings-inline-strong">batshit-server Auto-Sync Failed</p>
                      <p>{serviceEnvSyncError}</p>
                      <p class="text-xs text-destructive/90">
                        Host fallback: save <code>BATSHIT_TOKEN=...</code> in <code>{SERVICE_ENV_PATH}</code>. Docker fallback:
                        update <code>BATSHIT_TOKEN</code> in <code>.env.docker</code> and restart the Compose stack. Keep
                        <code>BATSHIT_ARTIFACT_COMPLETE_URL</code> as default unless you intentionally use a different internal host.
                      </p>
                    </Card.Content>
                  </Card.Root>
                {/if}
              {/if}

              {#if group.kind === 'custom'}
                <CustomProvidersSettingsPanel embedded />
              {:else}
                {@const visibleRows = getGroupRows(group)}
                {@const hiddenRows = getGroupHiddenRows(group)}
                {#if visibleRows.length > 0}
                  <div class="batshit-api-key-list">
                    {#each visibleRows as row}
                      <div class={`batshit-api-key-row ${row.editing ? 'is-editing' : ''}`}>
                      <div class="batshit-api-key-row-main">
                        <span class="batshit-api-key-icon-frame">
                          <IconRenderer
                            ref={getServiceIconRef(row)}
                            label={row.label}
                            iconClass="h-4 w-4"
                            imageClass="object-contain"
                          />
                        </span>
                        <div class="batshit-api-key-identity">
                          <div class="batshit-api-key-title-line">
                            <p class="batshit-settings-form-label">{row.label}</p>
                            <SettingsInfoMenu ariaLabel={`About ${row.label}`} contentClass="w-80">
                              <p>{row.description}</p>
                            </SettingsInfoMenu>
                          </div>
                          <div class="batshit-api-key-meta">
                            <Badge variant={row.status === 'ready' ? 'secondary' : 'outline'}>
                              {row.status === 'ready' ? 'Ready' : 'Not Configured'}
                            </Badge>
                            {#if row.connectionHint}
                              <Badge variant="outline">{row.connectionHint}</Badge>
                            {/if}
                            <span>
                              {row.managedByRuntime
                                ? row.runtimeLabel ?? 'Runtime managed'
                                : row.defaultedByRuntime
                                  ? 'Default'
                                  : formatUpdatedAt(row.updatedAt)}
                            </span>
                          </div>
                          {#if row.masked}
                            <p class="batshit-api-key-stored">
                              <CheckCircle2 class="h-3.5 w-3.5" />
                              {row.managedByRuntime || row.defaultedByRuntime
                                ? runtimeManagedStoredLabel(row)
                                : 'Stored as'} {row.masked}
                            </p>
                          {/if}
                          {#if row.managedByRuntime}
                            <p class="batshit-settings-form-help">
                              {runtimeManagedHelp(row)}
                            </p>
                          {:else if row.defaultedByRuntime}
                            <p class="batshit-settings-form-help">
                              {row.runtimeLabel ?? 'Using default'}; save an override only for custom networking.
                            </p>
                          {/if}
                        </div>
                      </div>

                      {#if !isRuntimeManagedService(row)}
                        <div class="batshit-api-key-actions">
                          <SettingsSaveStatus
                            state={row.saveError ? 'error' : row.saveState}
                            error={row.saveError}
                            savedLabel="Saved"
                            sticky={false}
                          />
                          {#if row.editing}
                            <Button
                              size="icon"
                              variant="secondary"
                              aria-label={`Save ${row.label}`}
                              title="Save"
                              onclick={() => persistRowValue(row.id)}
                              disabled={row.saving || !row.inputValue.trim()}
                            >
                              {#if row.saving}
                                <Loader2 class="animate-spin" />
                              {:else}
                                <Save  />
                              {/if}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Cancel editing ${row.label}`}
                              title="Cancel"
                              onclick={() => cancelRowEdit(row)}
                              disabled={row.saving}
                            >
                              <X  />
                            </Button>
                          {:else}
                            <Button
                              size="icon"
                              variant="outline"
                              aria-label={`Edit ${row.label}`}
                              title="Edit"
                              onclick={() => startRowEdit(row)}
                            >
                              <Pencil  />
                            </Button>
                          {/if}
                          <Button
                            size="sm"
                            variant="outline"
                            onclick={() => testKey(row)}
                            disabled={row.testing || (!row.inputValue.trim() && row.status !== 'ready')}
                          >
                            {#if row.testing}
                              <Loader2 class="animate-spin" />
                            {/if}
                            Test
                          </Button>
                          {#if row.canGenerate}
                            <Button
                              size="icon"
                              variant="outline"
                              aria-label={`Generate ${row.label}`}
                              title="Generate"
                              onclick={() => {
                                const generated = generateHex(32)
                                if (!row.editing) startRowEdit(row)
                                setRowInputValue(row.id, generated)
                              }}
                            >
                              <Sparkles  />
                            </Button>
                            <Button
                              size="icon"
                              variant="outline"
                              aria-label={`Copy ${row.label}`}
                              title="Copy token"
                              disabled={row.copying || row.status === 'needs-config'}
                              onclick={() => copyKey(row)}
                            >
                              {#if row.copying}
                                <Loader2 class="animate-spin" />
                              {:else}
                                <Copy  />
                              {/if}
                            </Button>
                          {/if}
                          <Button
                            size="icon"
                            variant="ghost"

                            aria-label={`Delete ${row.label}`}
                            title="Delete"
                            onclick={() => deleteKey(row)}
                            disabled={row.deleting || row.status === 'needs-config'}
                          >
                            {#if row.deleting}
                              <Loader2 class="animate-spin" />
                            {:else}
                              <Trash2  />
                            {/if}
                          </Button>
                        </div>
                      {:else if canCopyRuntimeManagedKey(row)}
                        <div class="batshit-api-key-actions">
                          <Button
                            size="icon"
                            variant="outline"
                            aria-label={`Copy ${row.label}`}
                            title="Copy runtime token"
                            disabled={row.copying || row.status === 'needs-config'}
                            onclick={() => copyKey(row)}
                          >
                            {#if row.copying}
                              <Loader2 class="animate-spin" />
                            {:else}
                              <Copy  />
                            {/if}
                          </Button>
                        </div>
                      {/if}

                      {#if row.editing}
                        <div class="batshit-api-key-edit-row">
                          <Input
                            class="batshit-api-key-edit-input"
                            type={row.inputType ?? 'password'}
                            placeholder={
                              row.inputType === 'text'
                                ? 'Enter value…'
                                : row.masked
                                  ? 'Paste a new key to replace the stored one…'
                                  : 'Paste API key…'
                            }
                            value={row.inputValue}
                            oninput={(event) => {
                              const target = event.currentTarget as HTMLInputElement
                              setRowInputValue(row.id, target.value)
                            }}
                          />
                        </div>
                      {/if}
                    </div>
                    {/each}
                  </div>
                {/if}

                {#if group.allowAdd && hiddenRows.length > 0}
                <div class="batshit-api-key-add-row">
                  <Select.Root
                    type="single"
                    value={addServiceSelections[group.id] ?? ''}
                    onValueChange={(value) => handleAddServiceSelection(group.id, value)}
                  >
                    <Select.Trigger
                      class="batshit-api-key-add-trigger justify-between"
                    >
                      <span class="flex min-w-0 items-center gap-2">
                        <Plus class="h-3.5 w-3.5 shrink-0" />
                        <span class="truncate">Add New API Key</span>
                      </span>
                    </Select.Trigger>
                    <Select.Content>
                      {#each hiddenRows as row}
                        <Select.Item value={row.id}>
                          <div class="flex min-w-0 items-center gap-2">
                            <span class="batshit-api-key-select-icon">
                              <IconRenderer
                                ref={getServiceIconRef(row)}
                                label={row.label}
                                iconClass="h-3.5 w-3.5"
                                imageClass="object-contain"
                              />
                            </span>
                            <span class="truncate">{row.label}</span>
                          </div>
                        </Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
                {/if}
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>
        </Card.Root>
      {/each}
    {/if}
  </div>
</div>
