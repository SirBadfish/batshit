<script lang="ts">
  import { refuse, type SettingsTarget } from '$lib/appActions/catalog'
  import { appActionsHaveDrafts, type ActionContext } from '$lib/appActions/owners'

import { onDestroy, onMount, untrack } from 'svelte'
import { createModelPresetAutosave, getModelPresetDrafts, runModelPresetSave, waitForModelPresetSaves } from '../models/modelPresetAutosave'
import * as Card from '$lib/components/ui/card'
import { Input } from '$lib/components/ui/input'
import * as Label from '$lib/components/ui/label'
import { Button } from '$lib/components/ui/button'
import SamplerOrderEditor from '../models/SamplerOrderEditor.svelte'
import * as Select from '$lib/components/ui/select'
import * as ToggleGroup from '$lib/components/ui/toggle-group'
import { Textarea } from '$lib/components/ui/textarea'
import * as Switch from '$lib/components/ui/switch'
import * as Collapsible from '$lib/components/ui/collapsible'
import * as Tooltip from '$lib/components/ui/tooltip'
import { Badge } from '$lib/components/ui/badge'
import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
import ModelCatalogViewerDialog from '$lib/components/settings/models/ModelCatalogViewerDialog.svelte'
import SavedModelsSidebar from '$lib/components/settings/models/SavedModelsSidebar.svelte'
import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
import { confirmDialog } from '$lib/stores/confirmDialog'
import { toast } from '$lib/components/ui/sonner/settings-toast'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Trash2
} from '@lucide/svelte'
import {
  filterParameters,
  isParameterSupportedInN8N,
  isParameterSuppressedForModel,
  resolveParameterProvider
} from '$lib/utils/parameterFilter'
import {
  describeUnlistedSelectValue,
  formatDefaultInput,
  fromInputValue,
  resolveSavedSelectValue,
  toInputValue
} from '$lib/utils/parameterValueAdapter'
import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import type {
    SavedModel,
    ModelCompatibility,
    ModelCapabilities,
    ModelEnrichmentSnapshot,
    ModelVoiceSessionConfig,
    ImageTransport,
    ModelPurpose
  } from '$lib/types/savedModels'
import type { ParameterDefinition, ParameterValue } from '$lib/data/parameter-schemas'
import { getParameterSchema } from '$lib/data/parameter-schemas'
import { acknowledgeOllamaPresetCapabilities, projectOllamaPresetCapabilities } from '$lib/utils/ollamaModelCapabilities'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import { isTieredPricing } from '$lib/types/savedModels'
import { determineModelCompatibility, isN8NSupported } from '$lib/data/model-compatibility-registry'
import {
  CODEX_SUBMODEL_CHOICES,
  CODEX_XHIGH_REASONING_HELPER_TEXT,
  supportsCodexXhighReasoning
} from '$lib/data/codex-models'
import type { CodexPermissionMode } from '$lib/types/codex'
import {
  autoSelectConnectionForModel,
  getSavedModelBadgeProvider,
  isModelAllowedForConnection,
  resolveConnectionServiceFromId
} from '$lib/utils/modelConnections'
import {
  buildConnectionScopedCatalogModels,
  findConnectionScopedCatalogPreset,
  resolveConnectionScopedCatalogModel,
  type ConnectionScopedCatalogModel
} from '$lib/utils/catalogConnectionScope'
import { canonicalizeCatalogDeveloperId } from '$lib/utils/catalogDeveloperIdentity'
import { resolveCatalogIds } from '$lib/utils/modelIdResolver'
import {
  resolvePresetMaxOutputTokenResolution,
  resolvePresetMaxOutputTokens
} from '$lib/utils/modelOutputTokens'
import type { CatalogModel, CatalogConnectionOption } from '$lib/types/modelCatalog'
import { isManualEntryCatalogConnection } from '$lib/utils/modelCatalogConnectionMode'
import {
  CATALOG_ROLE_OPTIONS,
  almostEqual,
  formatCompatibilityLabel,
  formatCurrencyDisplay,
  formatDeveloperLabel,
  formatFlexibleNumberDisplay,
  formatGroupedIntegerDisplay,
  formatN8NStatus,
  formatParameterDisplayValue,
  formatPrice,
  getConnectionIconMeta,
  matchesCatalogRole,
  normalizeCatalogRole,
  parameterSupportLabel,
  parseFormattedInteger,
  parseFormattedNumber,
  resolveConnectionIconKey,
  toComparableNumber,
  type CatalogRoleFilter
} from '$lib/components/settings/models/modelSettingsFormatters'
import {
  buildCatalogPresetPricing,
  buildPresetPricingFromForm,
  parsePresetContextWindow
} from '$lib/components/settings/models/modelPresetPayload'
import {
  describeLocalContextNote,
  describeServedModelNote,
  findServingModel,
  localModelName
} from '$lib/components/settings/models/localProgramNotes'
import {
  resolveCatalogConnectionLimits,
  resolveCatalogConnectionPricing
} from '$lib/utils/catalogConnectionLimits'
import { isFlatFeePlanConnection } from '$lib/utils/catalogPricing'
import { isChatgptPlanConnection, CHATGPT_PLAN_PARAMETERS } from '$lib/utils/chatgptPlanConnection'
import { themeStore } from '$lib/stores/theme'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
	import * as savedModelsStore from '$lib/stores/savedModels.svelte'
import * as compatibilityMatrixStore from '$lib/stores/compatibilityMatrix.svelte'
import {
  inferLiveKitSpeechToSpeechConfig,
  normalizeModelVoiceSessionConfig,
  resolveModelVoiceSessionConfig
} from '$lib/utils/modelVoiceSession'

  const SAVE_DEBOUNCE_MS = 600
  const CREATE_SENTINEL = '__create__'
  const MODIFIED_BADGE_CLASS = 'batshit-settings-pill is-warning'
  const ESTIMATED_BADGE_CLASS = 'batshit-settings-pill is-info'

  type PanelData = {
    user?: { id: string } | null
    userSettings?: any
  } | null

  interface PricingTierFormRow {
    key: string
    from: string
    to: string
    cost: string
  }

  type CustomParamType = 'string' | 'number' | 'boolean' | 'json'

  interface CustomParamRow {
    id: string
    key: string
    type: CustomParamType
    value: string
  }

  interface ModelFormState {
    id: string | null
    modelName: string
    modelId: string
    provider: string
    catalogModelId: string | null
    effectiveModelId: string | null
    purpose: ModelPurpose
    purposeOverride: ModelPurpose | null
    contextWindow: string
    pricingInputMode: 'flat' | 'tiered'
    pricingInput: string
    pricingInputTiers: PricingTierFormRow[]
    pricingOutput: string
    pricingCachedInput: string
    parameterValues: Record<string, string>
    /**
     * SA-102 P1 (DL-102-01): names the user deliberately emptied in THIS editing
     * session. UI-only — never saved, never part of the auto-save signature. It
     * exists so the default-seeding effect below can tell "never set" (seed it)
     * from "cleared on purpose" (leave it blank so the request omits it).
     */
    clearedParameterNames: string[]
    customParameterRows: CustomParamRow[]
    customParametersJson: string
    compatibility: ModelCompatibility | null
    capabilities: ModelCapabilities | null
    imageTransport: ImageTransport
    isVercelImport: boolean
    vercelSourceId: string | null
    vercelDisplayName: string | null
    enrichment: ModelEnrichmentSnapshot | null
    voiceSession: ModelVoiceSessionConfig | null
    connectionId: string | null
    connectionType: 'vercel-gateway' | 'direct' | 'openrouter' | null
    connectionService: string | null
    connectionUseDeveloperPrefix: boolean
  }

  interface CodexConfigRow {
    id: string
    key: string
    value: string
  }

  interface CodexFormOptions {
    permissionMode: CodexPermissionMode
    model: string
    reasoningEffort: 'default' | 'low' | 'medium' | 'high' | 'xhigh'
    streamingEffect: boolean
    search: boolean
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
    approval: 'never' | 'on-request'
    addDirs: string[]
    enableFeatures: string[]
    disableFeatures: string[]
    configOverrides: CodexConfigRow[]
    workingDirectoryMode: 'project' | 'custom'
    customWorkingDirectory: string
  }

  const CODEX_REASONING_OPTIONS: Array<{
    value: CodexFormOptions['reasoningEffort']
    label: string
    helper: string
  }> = [
    { value: 'default', label: 'Auto', helper: 'Use provider default' },
    { value: 'low', label: 'Low', helper: 'Faster, fewer deliberations' },
    { value: 'medium', label: 'Medium', helper: 'Balanced effort' },
    { value: 'high', label: 'High', helper: 'Slowest, more careful planning' },
    { value: 'xhigh', label: 'Extra High', helper: CODEX_XHIGH_REASONING_HELPER_TEXT }
  ]

  const CODEX_PERMISSION_PRESETS: Record<
    CodexPermissionMode,
    { sandbox: CodexFormOptions['sandbox']; approval: CodexFormOptions['approval'] }
  > = {
    chat: { sandbox: 'read-only', approval: 'never' },
    agent: { sandbox: 'workspace-write', approval: 'on-request' },
    agent_full: { sandbox: 'danger-full-access', approval: 'never' }
  }
  const CODEX_PERMISSION_OPTIONS: Array<{ value: CodexPermissionMode; label: string; helper: string }> = [
    { value: 'chat', label: 'Chat', helper: 'Read-only, never prompts' },
    { value: 'agent', label: 'Agent', helper: 'Workspace write, ask when needed' },
    { value: 'agent_full', label: 'Agent (full)', helper: 'Full access, run without prompts' }
  ]
  const CODEX_SANDBOX_OPTIONS = [
    { value: 'read-only', label: 'Read-only' },
    { value: 'workspace-write', label: 'Workspace write' },
    { value: 'danger-full-access', label: 'Danger full access' }
  ] as const
  const CODEX_APPROVAL_OPTIONS = [
    { value: 'never', label: 'Never' },
    { value: 'on-request', label: 'On request' }
  ] as const

const EMPTY_FORM: ModelFormState = {
    id: null,
    modelName: '',
    modelId: '',
    provider: '',
    catalogModelId: null,
    effectiveModelId: null,
    purpose: 'chat',
    purposeOverride: null,
    contextWindow: '',
    pricingInputMode: 'flat',
    pricingInput: '',
  pricingInputTiers: [],
  pricingOutput: '',
  pricingCachedInput: '',
  parameterValues: {},
  clearedParameterNames: [],
  customParameterRows: [],
  customParametersJson: '',
  compatibility: null,
  capabilities: null,
  imageTransport: 'auto',
  isVercelImport: false,
  vercelSourceId: null,
  vercelDisplayName: null,
  enrichment: null,
  voiceSession: null,
  connectionId: null,
  connectionType: null,
  connectionService: null,
  connectionUseDeveloperPrefix: false
}

type CatalogProviderOption = {
  label: string
  value: string
  n8nSupported: boolean
}

const CAPABILITY_LABELS: { key: keyof ModelCapabilities; label: string }[] = [
  { key: 'streaming', label: 'Streaming' },
  { key: 'vision', label: 'Vision' },
  { key: 'tools', label: 'Tool Calling' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'jsonMode', label: 'JSON Mode' },
  { key: 'cacheControl', label: 'Cache Control' },
  { key: 'longContext', label: 'Long Context' },
  { key: 'code', label: 'Code' },
  { key: 'fast', label: 'Fast' },
  { key: 'audio', label: 'Audio' },
  { key: 'image', label: 'Image' }
]
const MODEL_PURPOSE_OPTIONS: Array<{
  value: ModelPurpose
  label: string
  helper: string
}> = [
  { value: 'chat', label: 'Chat (Agents)', helper: 'Available to API agents and chat model pickers' },
  { value: 'visual', label: 'Media', helper: 'Image, video, and 3D generation presets' },
  { value: 'audio', label: 'Audio', helper: 'Speech, transcription, and audio-only presets' },
  { value: 'utility', label: 'Utility', helper: 'Embeddings, reranking, classification, and similar tasks' }
]

const IMAGE_TRANSPORT_OPTIONS: Array<{ value: ImageTransport; label: string; helper: string }> = [
  { value: 'auto', label: 'Automatic', helper: 'Let Batshit pick the image format this program accepts.' },
  { value: 'url', label: 'Force URL', helper: 'Use fetchable image URLs instead of data URLs.' }
]

type SpeechToSpeechVoiceOption = {
  value: string
  label: string
}

const SPEECH_TO_SPEECH_VOICE_OPTIONS: Record<string, SpeechToSpeechVoiceOption[]> = {
  openai: [
    { value: 'marin', label: 'Marin' },
    { value: 'alloy', label: 'Alloy' },
    { value: 'ash', label: 'Ash' },
    { value: 'ballad', label: 'Ballad' },
    { value: 'coral', label: 'Coral' },
    { value: 'echo', label: 'Echo' },
    { value: 'sage', label: 'Sage' },
    { value: 'shimmer', label: 'Shimmer' },
    { value: 'verse', label: 'Verse' }
  ],
  google: [
    { value: 'Puck', label: 'Puck' },
    { value: 'Aoede', label: 'Aoede' },
    { value: 'Charon', label: 'Charon' },
    { value: 'Fenrir', label: 'Fenrir' },
    { value: 'Kore', label: 'Kore' },
    { value: 'Leda', label: 'Leda' },
    { value: 'Orus', label: 'Orus' },
    { value: 'Zephyr', label: 'Zephyr' },
    { value: 'Achernar', label: 'Achernar' },
    { value: 'Achird', label: 'Achird' },
    { value: 'Algenib', label: 'Algenib' },
    { value: 'Algieba', label: 'Algieba' },
    { value: 'Alnilam', label: 'Alnilam' },
    { value: 'Autonoe', label: 'Autonoe' },
    { value: 'Callirrhoe', label: 'Callirrhoe' },
    { value: 'Despina', label: 'Despina' },
    { value: 'Enceladus', label: 'Enceladus' },
    { value: 'Erinome', label: 'Erinome' },
    { value: 'Gacrux', label: 'Gacrux' },
    { value: 'Iapetus', label: 'Iapetus' },
    { value: 'Laomedeia', label: 'Laomedeia' },
    { value: 'Pulcherrima', label: 'Pulcherrima' },
    { value: 'Rasalgethi', label: 'Rasalgethi' },
    { value: 'Sadachbia', label: 'Sadachbia' },
    { value: 'Sadaltager', label: 'Sadaltager' },
    { value: 'Schedar', label: 'Schedar' },
    { value: 'Sulafat', label: 'Sulafat' },
    { value: 'Umbriel', label: 'Umbriel' },
    { value: 'Vindemiatrix', label: 'Vindemiatrix' },
    { value: 'Zubenelgenubi', label: 'Zubenelgenubi' }
  ],
  xai: [
    { value: 'ara', label: 'Ara' },
    { value: 'eve', label: 'Eve' },
    { value: 'leo', label: 'Leo' },
    { value: 'rex', label: 'Rex' },
    { value: 'sal', label: 'Sal' }
  ]
}

const HIDDEN_INLINE_COMPATIBILITY_NOTES = new Set([
  'Available only for Batshit direct mode (no n8n webhook support yet)'
])

// SA-102 P1: derived from the ONE runtime definition list, so a runtime added
// to LOCAL_AI_SERVER_DEFINITIONS is local here too without a second edit.
const LOCAL_PROVIDER_LABELS = new Map<string, string>(
  LOCAL_AI_SERVER_DEFINITIONS.map((definition) => [definition.id, definition.label])
)

function resolveLocalProviderId(form: Pick<ModelFormState, 'connectionService' | 'provider'>): string | null {
  const connectionService = form.connectionService?.trim().toLowerCase() ?? ''
  if (connectionService && LOCAL_PROVIDER_LABELS.has(connectionService)) return connectionService
  const provider = form.provider?.trim().toLowerCase() ?? ''
  if (provider && LOCAL_PROVIDER_LABELS.has(provider)) return provider
  return null
}

function isLocalProvider(form: ModelFormState): boolean {
  return resolveLocalProviderId(form) !== null
}

/**
 * SA-102 P1 (DL-102-16): user-facing copy names the PROGRAM, never "runtime".
 * Josh's rule: a local-AI user knows what LM Studio is; "runtime" is a word he
 * did not know three months ago and most local-AI users will not either.
 */
function resolveLocalProgramLabel(form: ModelFormState): string | null {
  const id = resolveLocalProviderId(form)
  return id ? (LOCAL_PROVIDER_LABELS.get(id) ?? null) : null
}

function resolveToolsToggleValue(form: ModelFormState): boolean {
  const explicit = form.capabilities?.tools
  if (explicit === true || explicit === false) return explicit
  return isLocalProvider(form) ? false : true
}

function updateToolsCapability(enabled: boolean) {
  const nextCapabilities: ModelCapabilities = {
    ...(editingForm.capabilities ?? {})
  }
  nextCapabilities.tools = enabled
  editingForm = {
    ...editingForm,
    capabilities: nextCapabilities
  }
}

	function formatConnectionLabel(connectionId?: string | null) {
	  if (!connectionId || connectionId === 'none') return 'No connection'
	  const match = connectionOptions.find((option) => option.id === connectionId)
	  if (match?.label) return match.label
	  if (connectionId === 'vercel-gateway') return 'Vercel Gateway'
	  if (connectionId === 'openrouter') return 'OpenRouter'
	  if (connectionId.startsWith('direct:')) {
	    const provider = connectionId.split(':')[1] ?? 'direct'
	    return `${provider} (Direct)`
	  }
	  return connectionId
	}

function getAppliedProviderId(form: ModelFormState) {
  if (!form.connectionType) return ''
  if (form.connectionType === 'vercel-gateway') return 'vercel-gateway'
  if (form.connectionType === 'openrouter') return 'openrouter'
  if (form.connectionType === 'direct') {
    const service = form.connectionService?.trim()
    if (service) return service
    const inferred = resolveConnectionServiceFromId(form.connectionId)
    if (inferred) return inferred
    const provider = form.provider?.trim()
    if (provider) return provider
    return ''
  }
  return form.connectionId ?? ''
}

function resolveLiveKitSpeechToSpeechFormConfig(
  form: Pick<ModelFormState, 'provider' | 'modelId' | 'voiceSession'>
): ModelVoiceSessionConfig | null {
  const inferred = inferLiveKitSpeechToSpeechConfig(form.provider, form.modelId)
  const explicit = normalizeModelVoiceSessionConfig(form.voiceSession)
  const base = inferred ?? explicit
  if (!base) return null

  const explicitVoiceMatchesProvider = explicit?.providerId === base.providerId
  const voiceId = explicitVoiceMatchesProvider ? explicit?.defaultVoiceId || base.defaultVoiceId : base.defaultVoiceId
  return {
    ...base,
    defaultModelId: form.modelId.trim() || base.defaultModelId,
    defaultVoiceId: voiceId
  }
}

function getSpeechToSpeechVoiceOptions(config: ModelVoiceSessionConfig | null | undefined) {
  return config ? SPEECH_TO_SPEECH_VOICE_OPTIONS[config.providerId] ?? [] : []
}

function updateSpeechToSpeechVoice(voiceId: string) {
  const config = resolveLiveKitSpeechToSpeechFormConfig(editingForm)
  if (!config) return

  editingForm = {
    ...editingForm,
    voiceSession: {
      ...config,
      defaultVoiceId: voiceId.trim() || undefined
    }
  }
}

function getBadgeProviderForModel(model: SavedModel) {
  return getSavedModelBadgeProvider(model)
}

function compareCatalogLabels(a?: string | null, b?: string | null) {
  return (a ?? '').localeCompare(b ?? '', undefined, {
    sensitivity: 'base',
    numeric: true
  })
}

function getModelConnections(model?: CatalogModel | null) {
  if (!model) return []
  const baseConnections = model.availableConnections?.length
    ? [...model.availableConnections]
    : model.connectionId
      ? [model.connectionId]
      : []

  const inferred = connectionOptions
    .filter((option) => isModelAllowedForConnection(model, option))
    .map((option) => option.id)

  const variants = Object.keys(model.idVariants ?? {})

  return Array.from(new Set([...baseConnections, ...inferred, ...variants]))
}

const connectionsRequiringManualModel = new Set(['direct:huggingface'])
const connectionProviderHints = new Map([
  ['direct:huggingface', 'huggingface'],
  ['azure-openai', 'azure-openai'],
  ['aws-bedrock', 'aws-bedrock'],
  ['google-vertex', 'google-vertex'],
  ['direct:ollama', 'ollama'],
  ['direct:dmr', 'dmr'],
  ['direct:lmstudio', 'lmstudio'],
  ['direct:llama-cpp', 'llama-cpp'],
  ['direct:vllm', 'vllm']
])
const n8nOnlyConnections = new Set(['azure-openai', 'aws-bedrock', 'google-vertex', 'direct:huggingface'])
function allowModelForConnection(model: CatalogModel, connection: CatalogConnectionOption) {
  if (!n8nOnlyConnections.has(connection.id)) return true
  const explicitConnections = new Set(
    [model.connectionId, ...(model.availableConnections ?? [])].filter(
      (value): value is string => Boolean(value)
    )
  )
  return explicitConnections.has(connection.id)
}

  let {
    data = null,
    initialModelId = null,
    active = false
  }: { data?: PanelData; initialModelId?: string | null; active?: boolean } = $props()

  let models = $state<SavedModel[]>([])
  type PresetType = 'chat' | 'visual' | 'audio' | 'utility'

  function resolvePresetType(model: SavedModel): PresetType {
    const purpose = model.purpose
    if (purpose === 'visual' || purpose === 'audio' || purpose === 'utility') return purpose
    return 'chat'
  }

  const chatModels = $derived.by(() => models.filter((model) => resolvePresetType(model) === 'chat'))
  const visualModels = $derived.by(() => models.filter((model) => resolvePresetType(model) === 'visual'))
  const audioModels = $derived.by(() => models.filter((model) => resolvePresetType(model) === 'audio'))
  const utilityModels = $derived.by(() => models.filter((model) => resolvePresetType(model) === 'utility'))

  let chatSectionOpen = $state(true)
  let visualSectionOpen = $state(false)
  let audioSectionOpen = $state(false)
  let utilitySectionOpen = $state(false)
  let isLoading = $state(true)
  let listError = $state<string | null>(null)
  let catalogModels = $state<CatalogModel[]>([])
  let connectionOptions = $state<CatalogConnectionOption[]>([])
  let catalogLoading = $state(false)
  let catalogError = $state<string | null>(null)
  let selectedCatalogProvider = $state('')
  let selectedCatalogModelId = $state('')
  let catalogRoleFilter = $state<CatalogRoleFilter>('all')
  let catalogSelectionDirty = $state(false)
  let lastAutomaticCatalogSyncSignature = ''
  let catalogViewerOpen = $state(false)
  let catalogDetailsOpen = $state(false)
  let wasActive = $state(false)
  let catalogViewerProvider = $state('all')
  let catalogViewerConnection = $state('all')
  let catalogViewerRole = $state<CatalogRoleFilter>('all')
  let catalogViewerSearch = $state('')
  let catalogViewerLimit = $state(100)
  let lastCatalogViewerFilterSignature = ''
  let selectedConnectionId = $state<string | null>(null)
  let lastSyncedConnectionSignature: string | null = null
  let isEnriching = $state(false)
  let enrichmentWarning = $state<string | null>(null)
  /** BL-517: presets whose model the AI Gateway no longer lists (kept, never deleted by a load). */
  let unlistedNotice = $state<{ count: number; names: string[] } | null>(null)

  let selectedModelId = $state<string | null>(null)
  let editingForm = $state<ModelFormState>({ ...EMPTY_FORM })
  let formPersistedSignature = $state<string | null>(null)
  let numericDraftActive = $state(false)
  let formSelection = 0
  let panelDisposed = false
  const presetDrafts = getModelPresetDrafts<ModelFormState, ReturnType<typeof createDefaultCodexOptions>, SavedModel>()
  let creationContinuation: { selection: number; draft: ReturnType<typeof capturePresetDraft> | null } | null = null
  let creatingNew = $state(false)
  let suppressDraftAutoCreate = $state(false)
  let lastDraftCreateAttemptSignature = $state<string | null>(null)

let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
let saveError = $state<string | null>(null)
let n8nCompatibilitySyncing = $state(false)
let n8nCompatibilitySyncError = $state<string | null>(null)
  let deleteBusy = $state(false)
  let deleteDisclosureOpen = $state(false)

let codexDirDraft = $state('')
let codexEnableDraft = $state('')
let codexDisableDraft = $state('')
let codexOptions = $state(createDefaultCodexOptions())
let lastAppliedInitialModelId = $state<string | null>(null)
let formValidationError = $state<string | null>(null)
let lastInvalidModelSignature = $state<string | null>(null)

  // SA-017: `xhigh` reasoning effort is only allowed for compatible Codex models.
  $effect(() => {
    if (codexOptions.reasoningEffort !== 'xhigh') return
    if (supportsCodexXhighReasoning(codexOptions.model)) return
    codexOptions = { ...codexOptions, reasoningEffort: 'high' }
  })

  const hasSelection = $derived(!creatingNew && !!selectedModelId)
  const isExistingModel = $derived(hasSelection && !!selectedModelId)
  const showCatalogFirstEmptyState = $derived(!creatingNew && !selectedModelId)
  const canCreate = $derived(
    editingForm.modelName.trim().length > 0 &&
      editingForm.modelId.trim().length > 0 &&
      editingForm.provider.trim().length > 0 &&
      editingForm.connectionType !== null
  )
  const sortedConnectionOptions = $derived.by(() =>
    [...connectionOptions].sort((a, b) =>
      compareCatalogLabels(formatConnectionLabel(a.id), formatConnectionLabel(b.id))
    )
  )
  const catalogProviderOptions = $derived.by<CatalogProviderOption[]>(() => {
    if (!catalogModels.length) return []
    if (manualEntryConnectionActive) return []
    const scopedModels = buildConnectionScopedCatalogModels(
      catalogModels.filter((model) => {
        if (
          selectedConnection &&
          (!isModelAllowedForConnection(model, selectedConnection) ||
            !allowModelForConnection(model, selectedConnection))
        ) {
          return false
        }
        return matchesCatalogRole(model, catalogRoleFilter)
      }),
      selectedConnection
    )
    const unique = new Map<string, CatalogProviderOption>()
    for (const scopedModel of scopedModels) {
      if (!unique.has(scopedModel.canonicalDeveloperId)) {
        unique.set(scopedModel.canonicalDeveloperId, {
          label: formatDeveloperLabel(scopedModel.canonicalDeveloperId),
          value: scopedModel.canonicalDeveloperId,
          n8nSupported: isN8NSupported(scopedModel.canonicalDeveloperId)
        })
      }
    }
    return Array.from(unique.values()).sort((a, b) => compareCatalogLabels(a.label, b.label))
  })

  $effect(() => {
    if (active && !wasActive) {
      catalogRoleFilter = 'all'
      catalogDetailsOpen = false
    }
    wasActive = active
  })

  $effect(() => {
    if (catalogSelectionDirty) return
    if (!catalogModels.length) return
    const provider = editingForm.provider?.trim() ?? ''
    const modelId = editingForm.modelId?.trim() ?? ''
    const sourceId = editingForm.catalogModelId?.trim() || editingForm.vercelSourceId?.trim() || ''
    if (!provider && !modelId && !sourceId) return
    const signature = `${selectedConnectionId}|${sourceId}|${provider}|${modelId}`
    if (signature === lastAutomaticCatalogSyncSignature) return
    lastAutomaticCatalogSyncSignature = signature
    syncCatalogSelectionFromEditingForm()
  })

  let filteredCatalogEntries = $state<ConnectionScopedCatalogModel[]>([])
  let selectedCatalogEntry = $state<ConnectionScopedCatalogModel | null>(null)
  let selectedCatalogModel = $state<CatalogModel | null>(null)
  const activePresetRole = $derived.by<'chat' | 'visual' | 'audio' | 'utility'>(() => {
    if (creatingNew || selectedModelId) {
      return editingForm.purpose
    }

    if (catalogRoleFilter !== 'all' && catalogRoleFilter !== 'vision') {
      return catalogRoleFilter
    }

    if (selectedCatalogModel) {
      return normalizeCatalogRole(selectedCatalogModel.purpose ?? null)
    }

    return 'chat'
  })
  const catalogViewerBaseModels = $derived.by(() => {
    if (!catalogModels.length) return []

    const connectionFilter = catalogViewerConnection
    let baseModels = catalogModels
    if (connectionFilter === 'none') {
      baseModels = catalogModels.filter((model) => getModelConnections(model).length === 0)
    } else if (connectionFilter !== 'all') {
      const selected = connectionOptions.find((option) => option.id === connectionFilter) ?? null
      if (!selected) {
        baseModels = catalogModels.filter((model) => getModelConnections(model).includes(connectionFilter))
      } else {
        baseModels = catalogModels.filter(
          (model) => isModelAllowedForConnection(model, selected) && allowModelForConnection(model, selected)
        )
      }
    }

    if (catalogViewerRole === 'all') {
      return baseModels
    }

    return baseModels.filter((model) => matchesCatalogRole(model, catalogViewerRole))
  })
  const catalogViewerProviderOptions = $derived.by(() => {
    const set = new Set<string>()
    for (const model of catalogViewerBaseModels) {
      if (model.provider) {
        set.add(canonicalizeCatalogDeveloperId(model.provider))
      }
    }
    return Array.from(set).sort((a, b) =>
      compareCatalogLabels(formatDeveloperLabel(a), formatDeveloperLabel(b))
    )
  })
  const catalogViewerConnectionOptions = $derived.by(() => {
    const set = new Set<string>()
    for (const model of catalogModels) {
      const connections = getModelConnections(model)
      if (!connections.length) {
        set.add('none')
      } else {
        connections.forEach((connection) => set.add(connection))
      }
    }
    return Array.from(set).sort((a, b) =>
      compareCatalogLabels(formatConnectionLabel(a), formatConnectionLabel(b))
    )
  })
  const catalogViewerFilteredRows = $derived.by(() => {
    if (!catalogViewerBaseModels.length) return []
    const providerFilter = catalogViewerProvider
    const query = catalogViewerSearch.trim().toLowerCase()

    let rows = catalogViewerBaseModels
    if (providerFilter !== 'all') {
      rows = rows.filter(
        (model) => canonicalizeCatalogDeveloperId(model.provider) === providerFilter
      )
    }
    if (query.length) {
      rows = rows.filter((model) => {
        const haystack = `${model.displayName} ${model.name} ${model.provider} ${canonicalizeCatalogDeveloperId(model.provider)} ${model.connectionId ?? ''}`.toLowerCase()
        return haystack.includes(query)
      })
    }

    return rows
  })
  const catalogViewerRows = $derived.by(() => catalogViewerFilteredRows.slice(0, catalogViewerLimit))
  const catalogViewerFilteredCount = $derived.by(() => catalogViewerFilteredRows.length)
  const catalogViewerFallbackProvider = $derived.by(() => {
    if (catalogViewerConnection === 'all' || catalogViewerConnection === 'none') return null
    const viewerOption =
      connectionOptions.find((option) => option.id === catalogViewerConnection) ?? null
    if (!viewerOption) return null
    return resolveConnectionIconKey(viewerOption)
  })
  const selectedConnection = $derived.by<CatalogConnectionOption | null>(() => {
    if (!selectedConnectionId) return null
    return connectionOptions.find((option) => option.id === selectedConnectionId) ?? null
  })
  const catalogFallbackProvider = $derived.by(() => {
    if (!selectedConnection) return null
    return resolveConnectionIconKey(selectedConnection)
  })
  const isCustomConnection = $derived.by(() => {
    return Boolean(selectedConnection?.id?.startsWith('direct:custom_'))
  })
  const manualEntryConnectionActive = $derived.by(() => {
    if (!selectedConnection) return false
    return isManualEntryCatalogConnection(selectedConnection.id)
  })
  const connectionNeedsManualModel = $derived.by(() => {
    if (!selectedConnection) return false
    return connectionsRequiringManualModel.has(selectedConnection.id)
  })
  const appliedConnection = $derived.by<CatalogConnectionOption | null>(() => {
    if (!editingForm.connectionId) return null
    return connectionOptions.find((option) => option.id === editingForm.connectionId) ?? null
  })
  let activeParameterDefinitions = $state<ParameterDefinition[]>([])
  let parameterSections = $state<{
    id: 'core' | 'reasoning' | 'visual' | 'audio' | 'utility' | 'provider'
    title: string
    info: string
    basicItems: ParameterDefinition[]
    advancedItems: ParameterDefinition[]
  }[]>([])
  let parameterSectionOpen = $state<Record<string, boolean>>({})
  let customParametersJsonError = $state<string | null>(null)
  const isCodexModel = $derived.by(() => isCodexForm(editingForm))
  // SA-102 P1 (DL-102-16): the program that owns this model's defaults, by name.
  const localProgramLabel = $derived.by(() => resolveLocalProgramLabel(editingForm))
  const localProviderId = $derived.by(() => resolveLocalProviderId(editingForm))

  /**
   * BL-104: the model a local program answers EVERY request with, whatever the
   * preset names. KoboldCpp serves one model, so after a switch a preset saved
   * for another model still runs, on this one, and the editor says so.
   */
  /** BL-68: the window the catalog lists for the selected connection, not always the row's. */
  const selectedCatalogContextWindow = $derived.by(() =>
    selectedCatalogModel
      ? resolveCatalogConnectionLimits(selectedCatalogModel, selectedConnectionId).contextWindow
      : undefined
  )
  /** BL-132: likewise the price the catalog lists for the selected connection. */
  const selectedCatalogPricing = $derived.by(() =>
    selectedCatalogModel
      ? resolveCatalogConnectionPricing(selectedCatalogModel, selectedConnectionId).pricing
      : undefined
  )
  /** BL-658 / BL-296: a flat-fee plan connection bills a monthly fee, not this per-token price. */
  const selectedConnectionIsFlatFeePlan = $derived.by(() => isFlatFeePlanConnection(selectedConnectionId))
  const localServingModel = $derived.by(() => findServingModel(catalogModels, localProviderId))
  const effectiveFormCapabilities = $derived.by(() => getFormCapabilities(editingForm))
  const localServedModelNote = $derived.by(() =>
    describeServedModelNote({
      programId: localProviderId,
      programLabel: localProgramLabel,
      presetModelId: editingForm.modelId,
      serving: localServingModel
    })
  )

  /**
   * SA-102 P4 (DL-102-04): what the local program says it is ACTUALLY running
   * this model with, next to the ceiling the preset stores. Josh's own 27B
   * loads at 208,384 under a 262,144 ceiling.
   *
   * BL-104: a program that serves one model to every request reports that
   * model's size for any preset, which is how the send path already budgets.
   * Its reading wins over whichever catalog row the browser shows, and a preset
   * saved for another model still gets it, naming the model that really runs.
   */
  const localContextStatus = $derived.by(() =>
    describeLocalContextNote({
      programId: localProviderId,
      programLabel: localProgramLabel,
      reading: localServingModel?.localContext ?? selectedCatalogEntry?.model?.localContext,
      presetContextWindow: parseFormattedInteger(editingForm.contextWindow) || null,
      requestedContextWindow: localProviderId === 'ollama'
        ? parseFormattedInteger(editingForm.parameterValues.ollamaNumCtx ?? '') || null : null,
      runningModelName:
        localServedModelNote && localProviderId && localServingModel
          ? localModelName(localProviderId, localServingModel.name)
          : null
    })
  )

  /** SA-102 P4 (DL-102-11): open-ended text, never a two-value enum. */
  const localModelFormat = $derived.by(() => {
    const raw = selectedCatalogEntry?.model?.format
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null
  })
  /**
   * SA-125 supersedes SA-102's DL-102-15 here. Ollama now speaks its NATIVE
   * `/api/chat`, where top_k, min_p, repeat_penalty, repeat_last_n and num_ctx
   * all genuinely apply (measured 2026-09-20 with a pinned seed; the same values
   * on `/v1` were byte-identical to baseline). Batshit sends them directly, so
   * the Modelfile is no longer the only answer.
   *
   * The commands stay because ONE thing still needs them: Mirostat was accepted
   * by Ollama and changed nothing, in both modes, so Batshit does not offer it.
   * A user who wants to try it anyway needs the recipe, prefilled with this
   * model's name.
   */
  const ollamaModelfileCommands = $derived.by(() => {
    if (localProviderId !== 'ollama') return null
    const model = (editingForm.modelId || 'your-model').trim()
    const base = model.split(':')[0] || model
    return {
      model,
      show: `ollama show --modelfile ${model} > Modelfile`,
      parameter: 'PARAMETER top_k 40',
      create: `ollama create ${base}-custom -f Modelfile`,
      // Still useful as a server-wide default; the per-preset Context size
      // field is now the normal route.
      contextEnv: 'OLLAMA_CONTEXT_LENGTH=32768 ollama serve'
    }
  })
  const activeVoiceSessionConfig = $derived(resolveLiveKitSpeechToSpeechFormConfig(editingForm))
  const activeVoiceSessionVoiceOptions = $derived(
    getSpeechToSpeechVoiceOptions(activeVoiceSessionConfig)
  )
  const CUSTOM_PARAMETERS_SECTION_ID = 'custom-parameters'

  $effect(() => {
    const baseModels = selectedConnection
      ? catalogModels.filter(
          (model) =>
            isModelAllowedForConnection(model, selectedConnection) &&
            allowModelForConnection(model, selectedConnection)
        )
      : catalogModels

    const roleScoped =
      catalogRoleFilter === 'all'
        ? baseModels
        : baseModels.filter((model) => matchesCatalogRole(model, catalogRoleFilter))

    const scopedModels = buildConnectionScopedCatalogModels(roleScoped, selectedConnection)

    filteredCatalogEntries = selectedCatalogProvider
      ? scopedModels.filter((model) => model.canonicalDeveloperId === selectedCatalogProvider)
      : scopedModels
  })

  $effect(() => {
    const providerOptions = catalogProviderOptions
    if (!providerOptions.length) {
      if (selectedCatalogProvider) {
        selectedCatalogProvider = ''
      }
      return
    }

    if (
      selectedCatalogProvider &&
      !providerOptions.some((option) => option.value === selectedCatalogProvider)
    ) {
      selectedCatalogProvider = providerOptions[0].value
    }
  })

  $effect(() => {
    if (!manualEntryConnectionActive) return
    if (selectedCatalogProvider) {
      selectedCatalogProvider = ''
    }
    if (selectedCatalogModelId) {
      selectedCatalogModelId = ''
    }
  })

  $effect(() => {
    const signature = `${catalogViewerProvider}|${catalogViewerConnection}|${catalogViewerRole}|${catalogViewerSearch.trim().toLowerCase()}`
    if (signature !== lastCatalogViewerFilterSignature) {
      lastCatalogViewerFilterSignature = signature
      catalogViewerLimit = 100
    }
  })

  $effect(() => {
    if (catalogViewerProvider === 'all') return
    if (catalogViewerProviderOptions.includes(catalogViewerProvider)) return
    catalogViewerProvider = 'all'
  })

  $effect(() => {
    const hasFormConnection =
      Boolean(editingForm.connectionId) ||
      Boolean(editingForm.connectionType) ||
      Boolean(editingForm.connectionService)

    const options = connectionOptions

    if (!hasFormConnection) {
      lastSyncedConnectionSignature = null
      return
    }

    const signature = `${editingForm.connectionId ?? ''}:${editingForm.connectionType ?? ''}:${
      editingForm.connectionService ?? ''
    }`

    function ensureFallbackSelection() {
      if (!options.length) {
        if (selectedConnectionId !== null) {
          selectedConnectionId = null
        }
        return
      }

      if (
        !catalogSelectionDirty &&
        editingForm.connectionId &&
        options.some((option) => option.id === editingForm.connectionId)
      ) {
        if (selectedConnectionId !== editingForm.connectionId) {
          selectedConnectionId = editingForm.connectionId
        }
        return
      }

      if (selectedConnectionId && options.some((option) => option.id === selectedConnectionId)) {
        return
      }

      const fallback = options.find((option) => option.status === 'ready') ?? options[0]
      selectedConnectionId = fallback?.id ?? null
    }

    if (signature !== lastSyncedConnectionSignature) {
      lastSyncedConnectionSignature = signature
      if (
        !catalogSelectionDirty &&
        editingForm.connectionId &&
        options.some((option) => option.id === editingForm.connectionId)
      ) {
        selectedConnectionId = editingForm.connectionId
      } else {
        ensureFallbackSelection()
      }
      return
    }

    ensureFallbackSelection()
  })

  $effect(() => {
    if (!filteredCatalogEntries.length) {
      selectedCatalogEntry = null
      selectedCatalogModel = null
      return
    }
    selectedCatalogEntry =
      filteredCatalogEntries.find((model) => model.catalogId === selectedCatalogModelId) ?? null
    selectedCatalogModel = selectedCatalogEntry?.model ?? null
  })

  $effect(() => {
    if (filteredCatalogEntries.length) return
    if (selectedCatalogModelId) {
      selectedCatalogModelId = ''
    }
  })

  $effect(() => {
    const provider = resolveParameterProvider(
      editingForm.provider || selectedCatalogEntry?.developerId || '',
      { type: editingForm.connectionType, service: editingForm.connectionService },
    )
    const modelId = editingForm.modelId || selectedCatalogEntry?.modelId || ''
    const vercelId = editingForm.catalogModelId || editingForm.vercelSourceId || selectedCatalogModel?.id || ''

    activeParameterDefinitions = filterParameters({
      provider,
      modelId,
      vercelId,
      capabilities: effectiveFormCapabilities,
      connection: editingForm.connectionType ?? undefined,
      purpose: activePresetRole,
      matrixEntries
    }).filter(definition => !isChatgptPlanConnection(editingForm.connectionId) || CHATGPT_PLAN_PARAMETERS.has(definition.name))
  })

  const PARAMETER_SECTION_ORDER = {
    core: 10,
    reasoning: 20,
    visual: 30,
    audio: 40,
    utility: 50,
    provider: 60
  } as const

  function resolveParameterSectionId(
    section?: ParameterDefinition['section']
  ): 'core' | 'reasoning' | 'visual' | 'audio' | 'utility' | 'provider' {
    if (section === 'reasoning') return 'reasoning'
    if (section === 'vision' || section === 'visual') return 'visual'
    if (section === 'audio') return 'audio'
    if (section === 'utility') return 'utility'
    if (section === 'provider') return 'provider'
    return 'core'
  }

  function getParameterProviderFamily(definition: ParameterDefinition): string | null {
    const providerOptionKey = definition.providerOptionKey?.split('.')[0]?.trim().toLowerCase()
    if (providerOptionKey) return providerOptionKey

    const name = definition.name.trim().toLowerCase()
    if (name.startsWith('openai')) return 'openai'
    if (name.startsWith('anthropic')) return 'anthropic'
    if (name.startsWith('google')) return 'google'
    if (name.startsWith('groq')) return 'groq'
    if (name.startsWith('mistral')) return 'mistral'

    return null
  }

  function formatProviderFamilyLabel(family?: string | null) {
    const normalized = family?.trim().toLowerCase() ?? ''
    if (!normalized) return 'Provider'
    if (normalized === 'vercel-gateway') return 'Vercel AI Gateway'
    return formatDeveloperLabel(normalized)
  }

  /**
   * BL-58 / SA-125 follow-up: whether to badge a connection as n8n-usable.
   *
   * This used to be hardcoded static text on every row, which made it a badge
   * that carried no information and, worse, said something false: the CLI
   * connections report `n8nStatus: 'locked'` and every other row reports
   * `'unknown'`, so nothing actually reported compatible. Local programs are
   * `n8n: false` / `batshit_only` in their own compatibility records too.
   *
   * Two gates now. n8n is no longer a Primary Agent type at all — it is only a
   * Workflow Subagent platform — so a user without one never needs to see the
   * badge, and `hasWorkflowSubagents` already existed for exactly that. Beyond
   * that, only a connection whose own data says `ready` earns the badge.
   */
  function showsN8nBadge(option: { id: string; n8nStatus?: string } | null | undefined) {
    if (!option) return false
    if (!n8nCompatibilityState.hasWorkflowSubagents) return false
    return option.n8nStatus === 'ready'
  }

  function resolveProviderSectionTitle(
    items: ParameterDefinition[],
    provider?: string | null
  ) {
    const families = Array.from(
      new Set(items.map((definition) => getParameterProviderFamily(definition)).filter(Boolean))
    ) as string[]

    if (families.length === 1) {
      return `${formatProviderFamilyLabel(families[0])} Options`
    }

    if (provider?.trim()) {
      return `${formatProviderFamilyLabel(provider)} Options`
    }

    return 'Provider Options'
  }

  function resolveParameterSectionInfo(
    sectionId: 'core' | 'reasoning' | 'visual' | 'audio' | 'utility' | 'provider',
    title: string
  ) {
    if (sectionId === 'core') {
      return 'Common controls most people look for first. Leave any field blank to use the provider default.'
    }
    if (sectionId === 'reasoning') {
      return 'Controls for models that support extra thinking or reasoning behavior.'
    }
    if (sectionId === 'visual') {
      return 'Image and multimodal settings that appear only when this preset supports visual inputs or outputs.'
    }
    if (sectionId === 'audio') {
      return 'Speech and voice settings that appear only for audio-capable presets.'
    }
    if (sectionId === 'utility') {
      return 'Specialized settings for utility presets such as embeddings, rerankers, or classifiers.'
    }
    return `${title} contains extra controls that only apply to this provider family.`
  }

  function booleanRecordEquals(
    left: Record<string, boolean>,
    right: Record<string, boolean>
  ) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.length !== rightKeys.length) return false
    for (let i = 0; i < leftKeys.length; i += 1) {
      const key = leftKeys[i]
      if (key !== rightKeys[i]) return false
      if (left[key] !== right[key]) return false
    }
    return true
  }

  function getTopLevelParameterAccordionIds(
    sections: Array<{ id: 'core' | 'reasoning' | 'visual' | 'audio' | 'utility' | 'provider' }> = parameterSections
  ) {
    return [...sections.map((section) => section.id), CUSTOM_PARAMETERS_SECTION_ID]
  }

  function toggleParameterSection(sectionId: string) {
    const shouldOpen = parameterSectionOpen[sectionId] !== true
    const nextSectionOpen: Record<string, boolean> = {}

    getTopLevelParameterAccordionIds().forEach((id) => {
      nextSectionOpen[id] = shouldOpen && id === sectionId
    })

    if (!booleanRecordEquals(parameterSectionOpen, nextSectionOpen)) {
      parameterSectionOpen = nextSectionOpen
    }
  }

  $effect(() => {
    if (!activeParameterDefinitions.length) {
      parameterSections = []
      if (!booleanRecordEquals(parameterSectionOpen, {})) {
        parameterSectionOpen = {}
      }
      return
    }

    const groups = new Map<
      'core' | 'reasoning' | 'visual' | 'audio' | 'utility' | 'provider',
      ParameterDefinition[]
    >()
    for (const definition of activeParameterDefinitions) {
      if (definition.name === 'maxTokens') continue
      const key = resolveParameterSectionId(definition.section)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(definition)
    }

    const provider =
      editingForm.provider || selectedCatalogEntry?.developerId || editingForm.connectionService || ''

    const nextSections = Array.from(groups.entries())
      .map(([sectionId, items]) => {
        const basicItems = items.filter((definition) => !definition.advanced)
        const advancedItems = items.filter((definition) => definition.advanced)
        const title =
          sectionId === 'core'
            ? 'Common'
            : sectionId === 'reasoning'
              ? 'Reasoning'
              : sectionId === 'visual'
                ? 'Visual'
                : sectionId === 'audio'
                  ? 'Audio'
                  : sectionId === 'utility'
                    ? 'Utility'
                    : resolveProviderSectionTitle(items, provider)

        return {
          id: sectionId,
          title,
          info: resolveParameterSectionInfo(sectionId, title),
          basicItems,
          advancedItems
        }
      })
      .sort((left, right) => PARAMETER_SECTION_ORDER[left.id] - PARAMETER_SECTION_ORDER[right.id])

    const nextSectionOpen: Record<string, boolean> = {}
    const topLevelIds = getTopLevelParameterAccordionIds(nextSections)
    const currentOpenId = topLevelIds.find((id) => parameterSectionOpen[id] === true) ?? null
    nextSections.forEach((section) => {
      nextSectionOpen[section.id] = currentOpenId !== null && section.id === currentOpenId
    })
    nextSectionOpen[CUSTOM_PARAMETERS_SECTION_ID] = currentOpenId === CUSTOM_PARAMETERS_SECTION_ID

    parameterSections = nextSections

    if (!booleanRecordEquals(parameterSectionOpen, nextSectionOpen)) {
      parameterSectionOpen = nextSectionOpen
    }
  })

  // The model is always the user's explicit choice. Auto-picking the first row handed a first-run
  // user the list's oldest entry (Claude 3 Haiku, OpenAI's legacy babbage-002), BL-66. When the
  // chosen model leaves the list (another developer or role filter), ask again instead of swapping.
  $effect(() => {
    if (!selectedCatalogProvider) return
    if (!filteredCatalogEntries.length) return
    if (!selectedCatalogModelId) return
    if (!filteredCatalogEntries.some((model) => model.catalogId === selectedCatalogModelId)) {
      selectedCatalogModelId = ''
    }
  })

  $effect(() => {
    if (!activeParameterDefinitions.length) return
    const nextValues = { ...editingForm.parameterValues }
    let changed = false

    const clearedNames = new Set(editingForm.clearedParameterNames)
    for (const definition of activeParameterDefinitions) {
      if (nextValues[definition.name] !== undefined) continue
      if (definition.defaultValue === undefined) continue
      // SA-102 P1 (DL-102-01): never refill a field the user emptied on purpose.
      if (clearedNames.has(definition.name)) continue
      const formatted = formatParameterDisplayValue(definition, formatDefaultInput(definition))
      if (!formatted.length) continue
      nextValues[definition.name] = formatted
      changed = true
    }

    if (changed) {
      editingForm = { ...editingForm, parameterValues: nextValues }
    }
  })

  $effect(() => {
    const raw = editingForm.customParametersJson?.trim() ?? ''
    if (!raw.length) {
      customParametersJsonError = null
      return
    }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        customParametersJsonError = 'Custom JSON must be an object (key/value map).'
        return
      }
      customParametersJsonError = null
    } catch {
      customParametersJsonError = 'Custom JSON is not valid JSON.'
    }
  })

  function createTierKey() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return `tier_${Math.random().toString(36).slice(2, 10)}`
  }

  function createTierRow(): PricingTierFormRow {
    return {
      key: createTierKey(),
      from: '',
      to: '',
      cost: ''
    }
  }

  function createConfigRow(initial?: Partial<CodexConfigRow>): CodexConfigRow {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `codex_cfg_${Math.random().toString(36).slice(2, 10)}`
    return {
      id,
      key: initial?.key ?? '',
      value: initial?.value ?? ''
    }
  }

  const CUSTOM_PARAM_TYPE_OPTIONS: Array<{ value: CustomParamType; label: string }> = [
    { value: 'string', label: 'String' },
    { value: 'number', label: 'Number' },
    { value: 'boolean', label: 'Boolean' },
    { value: 'json', label: 'JSON' }
  ]

  function createCustomParamRow(initial?: Partial<CustomParamRow>): CustomParamRow {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `custom_${Math.random().toString(36).slice(2, 10)}`
    return {
      id,
      key: initial?.key ?? '',
      type: initial?.type ?? 'string',
      value: initial?.value ?? ''
    }
  }

  function inferCustomParamType(value: unknown): CustomParamType {
    if (value === null || value === undefined) return 'string'
    if (typeof value === 'boolean') return 'boolean'
    if (typeof value === 'number') return 'number'
    if (typeof value === 'object') return 'json'
    return 'string'
  }

  function formatCustomValue(value: unknown, type: CustomParamType): string {
    if (value === null || value === undefined) return ''
    if (type === 'json') {
      try {
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      } catch {
        return ''
      }
    }
    if (type === 'number') {
      return formatFlexibleNumberDisplay(value)
    }
    return String(value)
  }

  function updateCodexOptions(updater: (current: CodexFormOptions) => CodexFormOptions) {
    codexOptions = updater(codexOptions)
  }

  function setCodexPermissionMode(mode: CodexPermissionMode) {
    const preset = CODEX_PERMISSION_PRESETS[mode]
    updateCodexOptions((current) => ({
      ...current,
      permissionMode: mode,
      sandbox: preset.sandbox,
      approval: preset.approval
    }))
  }

  function addCodexListValue(
    key: 'addDirs' | 'enableFeatures' | 'disableFeatures',
    value: string
  ) {
    const trimmed = value.trim()
    if (!trimmed.length) return
    updateCodexOptions((current) => {
      if (current[key].includes(trimmed)) {
        return current
      }
      return {
        ...current,
        [key]: [...current[key], trimmed]
      }
    })
  }

  function removeCodexListValue(
    key: 'addDirs' | 'enableFeatures' | 'disableFeatures',
    index: number
  ) {
    updateCodexOptions((current) => ({
      ...current,
      [key]: current[key].filter((_, idx) => idx !== index)
    }))
  }

  function addCodexConfig() {
    updateCodexOptions((current) => ({
      ...current,
      configOverrides: [...current.configOverrides, createConfigRow()]
    }))
  }

  function updateCodexConfig(id: string, field: 'key' | 'value', value: string) {
    updateCodexOptions((current) => ({
      ...current,
      configOverrides: current.configOverrides.map((row) =>
        row.id === id ? { ...row, [field]: value } : row
      )
    }))
  }

  function removeCodexConfig(id: string) {
    updateCodexOptions((current) => ({
      ...current,
      configOverrides: current.configOverrides.filter((row) => row.id !== id)
    }))
  }

  function createDefaultCodexOptions(): CodexFormOptions {
    return {
      permissionMode: 'chat',
      model: CODEX_SUBMODEL_CHOICES[0]?.value ?? 'gpt-6-astra',
      reasoningEffort: 'default',
      streamingEffect: false,
      search: true,
      sandbox: CODEX_PERMISSION_PRESETS.chat.sandbox,
      approval: CODEX_PERMISSION_PRESETS.chat.approval,
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      workingDirectoryMode: 'project',
      customWorkingDirectory: ''
    }
  }

  function isCodexForm(form: ModelFormState): boolean {
    const provider = form.provider?.toLowerCase() ?? ''
    const service = form.connectionService?.toLowerCase() ?? ''
    const connectionId = form.connectionId?.toLowerCase() ?? ''
    const connectionType = form.connectionType?.toLowerCase() ?? ''
    const modelId = form.modelId?.toLowerCase() ?? ''

    return (
      provider.includes('codex') ||
      service.includes('codex') ||
      connectionId.includes('codex') ||
      connectionType.includes('codex') ||
      modelId.includes('codex')
    )
  }

  function toStringList(value: unknown): string[] {
    if (!value) return []
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
    }
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    }
    return []
  }

  function normaliseCodexOptions(settings?: Record<string, any> | null): CodexFormOptions {
    const options = createDefaultCodexOptions()
    if (!settings) return options

    if (settings.codex_permission_mode === 'agent' || settings.codex_permission_mode === 'agent_full') {
      options.permissionMode = settings.codex_permission_mode
    }

    options.model =
      typeof settings.codex_model === 'string' && settings.codex_model.trim().length
        ? settings.codex_model.trim()
        : options.model

    if (
      settings.codex_reasoning_effort === 'low' ||
      settings.codex_reasoning_effort === 'medium' ||
      settings.codex_reasoning_effort === 'high' ||
      settings.codex_reasoning_effort === 'xhigh'
    ) {
      options.reasoningEffort = settings.codex_reasoning_effort
    }

    options.streamingEffect = Boolean(settings.codex_streaming_effect)
    options.search = settings.codex_search === false ? false : true

    const preset = CODEX_PERMISSION_PRESETS[options.permissionMode]
    options.sandbox =
      settings.codex_sandbox === 'workspace-write' || settings.codex_sandbox === 'danger-full-access'
        ? settings.codex_sandbox
        : settings.codex_sandbox === 'read-only'
          ? 'read-only'
          : preset.sandbox

    options.approval =
      settings.codex_approval === 'on-request' ||
      settings.codex_approval === 'on-failure' ||
      settings.codex_approval === 'untrusted'
        ? 'on-request'
        : settings.codex_approval === 'never'
          ? 'never'
          : preset.approval

    options.addDirs = toStringList(settings.codex_additional_dirs)
    options.enableFeatures = toStringList(settings.codex_feature_enable)
    options.disableFeatures = toStringList(settings.codex_feature_disable)

    if (Array.isArray(settings.codex_config_overrides)) {
      options.configOverrides = settings.codex_config_overrides
        .map((entry: any) => {
          if (!entry || typeof entry !== 'object') return null
          const key = typeof entry.key === 'string' ? entry.key : ''
          const value = typeof entry.value === 'string' ? entry.value : entry.value !== undefined ? String(entry.value) : ''
          return createConfigRow({ key, value })
        })
        .filter((row: CodexConfigRow | null): row is CodexConfigRow => Boolean(row))
    }

    options.workingDirectoryMode =
      settings.codex_workdir_mode === 'custom' ? 'custom' : 'project'
    options.customWorkingDirectory =
      typeof settings.codex_custom_workdir === 'string' ? settings.codex_custom_workdir : ''

    return options
  }

  const matrixEntries = $derived.by(() => compatibilityMatrixStore.getMatrixEntries())
  const n8nCompatibilityState = $derived.by(() => compatibilityMatrixStore.getN8nState())
  const showN8nParameterSupport = $derived(
    n8nCompatibilityState.hasWorkflowSubagents && n8nCompatibilityState.localSnapshotAvailable
  )

  async function refreshN8nParameterCompatibility(
    trigger: 'model-card-open' | 'model-card-manual'
  ) {
    n8nCompatibilitySyncing = true
    n8nCompatibilitySyncError = null
    try {
      const response = await fetch('/api/admin/compatibility-matrix/n8n-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger })
      })
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to refresh n8n parameter support'))
      }
      await compatibilityMatrixStore.loadCompatibilityMatrix()
      if (trigger === 'model-card-manual') {
        toast.success('n8n parameter support refreshed')
      }
    } catch (error) {
      n8nCompatibilitySyncError =
        error instanceof Error ? error.message : 'Failed to refresh n8n parameter support'
      if (trigger === 'model-card-manual') toast.error(n8nCompatibilitySyncError)
    } finally {
      n8nCompatibilitySyncing = false
    }
  }

  async function refreshN8nParameterCompatibilityOnOpen() {
    const state = compatibilityMatrixStore.getN8nState()
    n8nCompatibilitySyncError = state.syncStatus?.status === 'error'
      ? state.syncStatus.error
      : null
    if (!state.hasWorkflowSubagents) return
    const fetchedAtMs = state.fetchedAt ? new Date(state.fetchedAt).getTime() : 0
    const fresh = Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs < 24 * 60 * 60 * 1000
    if (fresh) return
    await refreshN8nParameterCompatibility('model-card-open')
  }

  onMount(async () => {
    await Promise.all([loadModels(), loadCatalog(), compatibilityMatrixStore.loadCompatibilityMatrix()])
    await refreshN8nParameterCompatibilityOnOpen()
  })

  /**
   * BL-134 (LS-007, LS-011): a saved key, a custom provider, a Local AI save, or
   * a model switch on a Local AI model card changes what this tab's catalog
   * says (connection states, local program rows, KoboldCpp's served model), so
   * an open tab reloads it, the same load its Refresh button runs.
   */
  onMount(() => {
    const handleModelConnectionsUpdated = () => {
      void loadCatalog()
    }
    window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, handleModelConnectionsUpdated)
    return () => {
      window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, handleModelConnectionsUpdated)
    }
  })

  async function loadModels() {
    isLoading = true
    listError = null

    try {
      // A reopened editor must read after its predecessor's completed saves settle.
      await waitForModelPresetSaves()
      if (panelDisposed) return
      const response = await fetch('/api/user/saved-models')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load models')
        throw new Error(message)
      }
      const result = await response.json()
      const loaded: SavedModel[] = Array.isArray(result) ? result : result?.models ?? []
      models = loaded ?? []
      savedModelsStore.setSavedModels(models)

      const unlisted: Array<{ modelName: string }> = Array.isArray(result)
        ? []
        : result?.meta?.unlisted ?? []
      unlistedNotice = unlisted.length
        ? {
            count: unlisted.length,
            names: unlisted.map((entry) => entry.modelName)
          }
        : null

      if (initialModelId === CREATE_SENTINEL) {
        selectFirstModelOrShowCatalogLanding()
        lastAppliedInitialModelId = CREATE_SENTINEL
      } else if (initialModelId) {
        if (!applyInitialModelSelection(initialModelId)) {
          selectFirstModelOrShowCatalogLanding()
        }
      } else {
        selectFirstModelOrShowCatalogLanding()
      }
    } catch (error) {
      console.error('Failed to load models:', error)
      listError = error instanceof Error ? error.message : 'Failed to load models'
      models = []
      showCatalogLanding()
    } finally {
      isLoading = false
    }
  }

  /** BL-134: only the newest catalog load may apply its answer; an older one is stale. */
  let catalogLoadSequence = 0
  /**
   * BL-295: a Refresh (`?refresh=1`, which re-reads the registry) has not
   * answered yet. A load that replaces it (a connection change) refreshes too,
   * or the Refresh's answer is dropped for the cached catalog it was replacing.
   */
  let catalogRefreshPending = false

  async function loadCatalog(forceRefresh = false) {
    const sequence = ++catalogLoadSequence
    const refresh = forceRefresh || catalogRefreshPending
    catalogRefreshPending = refresh
    catalogLoading = true
    catalogError = null

    try {
      const endpoint = refresh ? '/api/models?refresh=1' : '/api/models'
      const response = await fetch(endpoint)
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load model catalog')
        throw new Error(message)
      }
      const payload = await response.json()
      if (sequence !== catalogLoadSequence) return
      const models = payload?.data?.models ?? []
      const connections = payload?.data?.connections ?? []
      catalogModels = models
      connectionOptions = connections
      if (!catalogSelectionDirty) {
        syncCatalogSelectionFromEditingForm()
      }

    } catch (error) {
      if (sequence !== catalogLoadSequence) return
      console.error('Failed to load catalog:', error)
      catalogError = error instanceof Error ? error.message : 'Failed to load catalog'
    } finally {
      if (sequence === catalogLoadSequence) {
        catalogLoading = false
        catalogRefreshPending = false
      }
    }
  }


  function applyInitialModelSelection(targetId: string | null | undefined) {
    if (!targetId) {
      return false
    }
    const match = models.find((model) => model.id === targetId)
    if (!match) {
      return false
    }

    selectModel(match)
    lastAppliedInitialModelId = targetId
    return true
  }

  function capturePresetDraft() {
    return {
      form: $state.snapshot(editingForm), codex: $state.snapshot(codexOptions),
      signature: makeFormSignature(editingForm), persistedSignature: formPersistedSignature,
      error: saveError, failedSignature: saveError ? lastInvalidModelSignature : null, numericDraft: numericDraftActive,
      payload: !numericDraftActive && canCreate && !validateModelForm(editingForm) ? buildModelPayload(editingForm) : null
    }
  }

  function retainCurrentPresetDraft() {
    if (creatingNew && saveState === 'saving' && creationContinuation?.selection === formSelection) {
      creationContinuation.draft = capturePresetDraft()
    }
    if (creatingNew && saveError) presetDrafts.set(CREATE_SENTINEL, capturePresetDraft())
    if (!selectedModelId || creatingNew) return
    if (makeFormSignature(editingForm) !== formPersistedSignature || presetAutosave.hasWork(selectedModelId)) {
      presetDrafts.set(selectedModelId, capturePresetDraft())
    } else {
      presetDrafts.delete(selectedModelId)
    }
  }

  function selectModel(model: SavedModel) {
    retainCurrentPresetDraft()
    formSelection += 1
    numericDraftActive = false
    creatingNew = false
    suppressDraftAutoCreate = false
    lastDraftCreateAttemptSignature = null
    selectedModelId = model.id
    const retained = presetDrafts.get(model.id)
    numericDraftActive = retained?.numericDraft ?? false
    editingForm = retained?.form ?? normaliseModel(model)
    codexOptions = retained?.codex ?? normaliseCodexOptions(model.settings ?? null)
    formPersistedSignature = retained?.persistedSignature ?? makeFormSignature(editingForm)
    formValidationError = null
    lastInvalidModelSignature = retained?.failedSignature ?? null
    saveState = presetAutosave.hasWork(model.id) ? 'saving' : 'idle'
    saveError = retained?.error ?? null
    enrichmentWarning = null
    catalogSelectionDirty = false
    lastAutomaticCatalogSyncSignature = ''
    selectedConnectionId = editingForm.connectionId
    lastSyncedConnectionSignature = null
    const presetProvider = model.provider?.trim().toLowerCase() ?? ''
    if (!catalogSelectionDirty) {
      selectedCatalogProvider = canonicalizeCatalogDeveloperId(presetProvider)
      const presetModelId =
        model.catalogModelId ??
        model.vercelSourceId ??
        (presetProvider && model.modelId ? `${presetProvider}/${model.modelId}` : model.modelId ?? '')
      selectedCatalogModelId = presetModelId ?? ''
    }
    syncCatalogSelectionFromEditingForm()
  }

  function showCatalogLanding() {
    retainCurrentPresetDraft()
    formSelection += 1
    numericDraftActive = false
    creatingNew = false
    suppressDraftAutoCreate = false
    lastDraftCreateAttemptSignature = null
    selectedModelId = null
    editingForm = { ...EMPTY_FORM }
    codexOptions = createDefaultCodexOptions()
    formPersistedSignature = null
    saveState = 'idle'
    saveError = null
    formValidationError = null
    lastInvalidModelSignature = null
    enrichmentWarning = null
    catalogSelectionDirty = false
    lastAutomaticCatalogSyncSignature = ''
    selectedConnectionId = null
    lastSyncedConnectionSignature = null
    selectedCatalogProvider = ''
    selectedCatalogModelId = ''
  }

  function startCreate() {
    showCatalogLanding()
    // An explicit new catalog/manual choice replaces the recoverable failed create draft.
    presetDrafts.delete(CREATE_SENTINEL)
    creatingNew = true
  }

  function selectFirstModelOrShowCatalogLanding() {
    const failedCreate = presetDrafts.get(CREATE_SENTINEL)
    if (failedCreate) {
      showCatalogLanding()
      creatingNew = true
      editingForm = failedCreate.form
      codexOptions = failedCreate.codex
      numericDraftActive = failedCreate.numericDraft
      lastDraftCreateAttemptSignature = failedCreate.signature
      saveError = failedCreate.error
      selectedConnectionId = editingForm.connectionId
      syncCatalogSelectionFromEditingForm()
      return
    }
    if (models.length > 0) {
      selectModel(models[0])
      return
    }

    showCatalogLanding()
  }

  $effect(() => {
    if (!initialModelId) {
      if (lastAppliedInitialModelId) {
        lastAppliedInitialModelId = null
      }
      return
    }

    if (initialModelId === CREATE_SENTINEL) {
      if (lastAppliedInitialModelId !== CREATE_SENTINEL) {
        selectFirstModelOrShowCatalogLanding()
        lastAppliedInitialModelId = CREATE_SENTINEL
      }
      return
    }

    if (isLoading) {
      return
    }

    if (selectedModelId === initialModelId) {
      lastAppliedInitialModelId = initialModelId
      return
    }

    if (lastAppliedInitialModelId === initialModelId) {
      return
    }

    if (!applyInitialModelSelection(initialModelId)) {
      // If no match yet, leave lastAppliedInitialModelId unchanged so we can retry
    }
  })

  const presetAutosave = createModelPresetAutosave({
    delay: SAVE_DEBOUNCE_MS,
    settled: () => untrack(() => {
      if (selectedModelId && presetAutosave.hasWork(selectedModelId)) saveState = 'saving'
    }),
    save: persistPresetDraft
  })

  async function persistPresetDraft(draft: { id: string; payload: SavedModel; signature: string; persistedSignature?: string | null; selection: number }) {
    const isCurrent = () => !panelDisposed && selectedModelId === draft.id
    try {
      const submittedForm = JSON.parse(draft.signature) as ModelFormState
      const previous = savedModelsStore.getSavedModels().find(model => model.id === draft.id)
      if (previous) {
        // A successor may have been queued before an earlier save confirmed
        // its inferred flags. Preserve those flags only when the captured
        // baseline did not already hold an explicit choice being replaced.
        const baseline = JSON.parse(draft.persistedSignature ?? draft.signature) as ModelFormState
        const capabilities = acknowledgeOllamaPresetCapabilities(draft.payload, formCapabilitySubject(baseline), previous, previous)
        if (capabilities !== (draft.payload.capabilities ?? null)) {
          draft.payload = { ...draft.payload, capabilities: capabilities ?? undefined }
          draft.signature = withSignatureCapabilities(draft.signature, capabilities)
        }
      }
      const response = await fetch('/api/user/saved-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft.payload)
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save model')
        throw new Error(message)
      }

      const result = await response.json()
      const updated: SavedModel | null = result?.model ?? null
      if (!updated || updated.id !== draft.id) throw new Error('The model save returned no matching preset.')

      if (updated && !panelDisposed) {
        models = models.map((model) => (model.id === updated.id ? updated : model))
      }
      savedModelsStore.upsertSavedModel(updated)

      untrack(() => {
        const submittedCapabilities = acknowledgeOllamaPresetCapabilities(
          formCapabilitySubject(submittedForm), formCapabilitySubject(submittedForm), draft.payload, updated
        )
        const acknowledgedSignature = withSignatureCapabilities(draft.signature, submittedCapabilities)
        const retained = presetDrafts.get(draft.id)
        if (retained) {
          retained.form = acknowledgeOllamaForm(retained.form, submittedForm, draft.payload, updated)
          retained.signature = withSignatureCapabilities(retained.signature, retained.form.capabilities)
          if (retained.payload) {
            const capabilities = acknowledgeOllamaPresetCapabilities(retained.payload, formCapabilitySubject(submittedForm), draft.payload, updated)
            retained.payload = { ...retained.payload, capabilities: capabilities ?? undefined }
          }
          retained.persistedSignature = acknowledgedSignature
          retained.error = null
          retained.failedSignature = null
          if (retained.signature === acknowledgedSignature) presetDrafts.delete(draft.id)
        }
        if (!isCurrent()) return
        // Acknowledge only the submitted draft. Later edits stay in the form.
        editingForm = acknowledgeOllamaForm(editingForm, submittedForm, draft.payload, updated)
        formPersistedSignature = acknowledgedSignature
        lastInvalidModelSignature = null
        const matchesSubmittedDraft = makeFormSignature(editingForm) === acknowledgedSignature
        if (matchesSubmittedDraft) formValidationError = null
        saveState = matchesSubmittedDraft ? 'saved' : 'idle'
        saveError = null
      })
    } catch (error) {
      console.error('Model save failed:', error)
      if (!isCurrent()) toast.error(`Could not save model preset "${draft.payload.modelName}": ${error instanceof Error ? error.message : 'Failed to save model'}`)
      untrack(() => {
        const retained = presetDrafts.get(draft.id)
        if (retained) {
          retained.error = error instanceof Error ? error.message : 'Failed to save model'
          retained.failedSignature = draft.signature
        }
        if (!isCurrent()) return
        lastInvalidModelSignature = draft.signature
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save model'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (isCurrent() && saveState === 'saved') {
            saveState = 'idle'
          }
        })
      }, 2000)
    }
  }

  onDestroy(() => {
    retainCurrentPresetDraft()
    panelDisposed = true
    presetAutosave.dispose()
  })

  function beginNumericDraft() {
    numericDraftActive = true
    formValidationError = null
    if (selectedModelId) presetAutosave.cancelPending(selectedModelId)
    if (selectedModelId && !presetAutosave.hasWork(selectedModelId)) saveState = 'idle'
  }

  function finishNumericDraft() {
    for (const [label, raw] of [
      ['Context Window', editingForm.contextWindow],
      ['Max Output Tokens', getParameterValue('maxTokens')]
    ]) {
      const text = raw.trim()
      if (!text) continue
      const value = Number(text.replace(/,/g, ''))
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
        formValidationError = `${label} must be a positive whole number, or blank${label === 'Context Window' ? ' for unknown context' : ' for a safe estimate'}.`
        numericDraftActive = true
        saveState = 'idle'
        return
      }
    }
    formValidationError = null
    formatField('contextWindow', formatGroupedIntegerDisplay)
    applySafeMaxOutputToEditingForm(getParameterValue('maxTokens'))
    numericDraftActive = false
  }

  function commitNumericDraftOnEnter(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    finishNumericDraft()
  }

$effect(() => {
  if (!isExistingModel || numericDraftActive) return
  const signature = makeFormSignature(editingForm)
  if (signature === formPersistedSignature && selectedModelId) {
    untrack(() => {
      presetAutosave.cancelPending(selectedModelId!)
      if (!presetAutosave.hasWork(selectedModelId!)) saveState = 'idle'
    })
    return
  }
  if (
    !formPersistedSignature ||
    signature === formPersistedSignature ||
    signature === lastInvalidModelSignature
  ) {
    return
  }

  if (!canCreate) {
    return
  }

  const validation = validateModelForm(editingForm)
  formValidationError = validation
  if (validation) {
    lastInvalidModelSignature = signature
    saveState = 'idle'
    return
  }

  lastInvalidModelSignature = null
  formValidationError = null
  saveState = 'saving'
  saveError = null

  const payload = buildModelPayload(editingForm)
  if (!isChatgptPlanConnection(editingForm.connectionId) &&
    payload.settings?.maxTokens !== parseFormattedInteger(editingForm.parameterValues.maxTokens ?? '')) {
    // Normalize a completed dirty form before acknowledging it, never a focused numeric draft.
    untrack(() => applySafeMaxOutputToEditingForm(editingForm.parameterValues.maxTokens))
    return
  }
  if (!payload.id && selectedModelId) {
      payload.id = selectedModelId
    }

    untrack(() => presetAutosave.schedule({
      id: payload.id,
      payload,
      signature,
      persistedSignature: formPersistedSignature,
      selection: formSelection
    }))
  })

  $effect(() => {
    if (!creatingNew) return
    if (suppressDraftAutoCreate || saveState === 'saving' || numericDraftActive) return

    const signature = makeFormSignature(editingForm)
    if (!canCreate || signature === lastDraftCreateAttemptSignature) {
      return
    }

    const validation = validateModelForm(editingForm)
    formValidationError = validation
    if (validation) {
      lastInvalidModelSignature = signature
      saveState = 'idle'
      return
    }

    lastInvalidModelSignature = null
    formValidationError = null
    lastDraftCreateAttemptSignature = signature
    void handleCreate({ suppressValidationToast: true })
  })

  async function handleCreate(options?: { successMessage?: string; suppressValidationToast?: boolean }) {
    if (!canCreate) {
      if (!options?.suppressValidationToast) {
        toast.error('Display name, developer ID, and model ID are required.')
      }
      return
    }

    const validation = validateModelForm(editingForm)
    formValidationError = validation
    if (validation) {
      lastInvalidModelSignature = makeFormSignature(editingForm)
      if (!options?.suppressValidationToast) {
        toast.error(validation)
      }
      return
    }

    lastInvalidModelSignature = null
    formValidationError = null
    if (creatingNew) {
      lastDraftCreateAttemptSignature = makeFormSignature(editingForm)
    }
    saveState = 'saving'
    saveError = null
    const selection = formSelection
    const signature = makeFormSignature(editingForm)
    const isCurrent = () => !panelDisposed && selection === formSelection
    const continuation = { selection, draft: null as ReturnType<typeof capturePresetDraft> | null }
    creationContinuation = continuation

    try {
      const payload = buildModelPayload(editingForm)
      await runModelPresetSave(async () => {
      const response = await fetch('/api/user/saved-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to create model')
        throw new Error(message)
      }

      const result = await response.json()
      const created: SavedModel | null = result?.model ?? null
      if (!created?.id) throw new Error('The model create returned no saved preset.')

      if (created) {
        if (!panelDisposed) models = [created, ...models.filter((model) => model.id !== created.id)]
        savedModelsStore.upsertSavedModel(created)
        presetDrafts.delete(CREATE_SENTINEL)
        const submittedForm = JSON.parse(signature) as ModelFormState
        const submittedCapabilities = acknowledgeOllamaPresetCapabilities(
          formCapabilitySubject(submittedForm), formCapabilitySubject(submittedForm), payload, created
        )
        const acknowledgedSignature = withSignatureCapabilities(signature, submittedCapabilities)
        if (continuation.draft && continuation.draft.signature !== signature) {
          const retained = continuation.draft
          const retainedForm = acknowledgeOllamaForm(retained.form, submittedForm, payload, created)
          const retainedSignature = withSignatureCapabilities(retained.signature, retainedForm.capabilities)
          const retainedPayload = retained.payload ? {
            ...retained.payload,
            capabilities: acknowledgeOllamaPresetCapabilities(retained.payload, formCapabilitySubject(submittedForm), payload, created) ?? undefined
          } : null
          presetDrafts.set(created.id, {
            ...retained,
            form: { ...retainedForm, id: created.id },
            payload: retainedPayload,
            signature: JSON.stringify({ ...JSON.parse(retainedSignature), id: created.id }),
            persistedSignature: JSON.stringify({ ...JSON.parse(acknowledgedSignature), id: created.id })
          })
          if (!isCurrent() && !retained.numericDraft && retainedPayload) {
            // This completed successor stays inside the admitted create, before remount reads.
            await persistPresetDraft({
              id: created.id,
              payload: { ...retainedPayload, id: created.id },
              signature: JSON.stringify({ ...JSON.parse(retainedSignature), id: created.id }),
              persistedSignature: JSON.stringify({ ...JSON.parse(acknowledgedSignature), id: created.id }),
              selection
            })
          }
        }
        if (isCurrent()) {
          if (makeFormSignature(editingForm) === signature) {
            selectModel(created)
          } else {
            // The create acknowledgement gives this draft its id, without undoing later typing.
            editingForm = { ...acknowledgeOllamaForm(editingForm, submittedForm, payload, created), id: created.id }
            selectedModelId = created.id
            creatingNew = false
            formPersistedSignature = JSON.stringify({ ...JSON.parse(acknowledgedSignature), id: created.id })
          }
        }
        toast.success(options?.successMessage ?? 'Model preset created')
      }
      })
    } catch (error) {
      console.error('Model creation failed:', error)
      const message = error instanceof Error ? error.message : 'Failed to create model'
      const failedDraft = isCurrent() ? capturePresetDraft() : continuation.draft
      if (failedDraft) presetDrafts.set(CREATE_SENTINEL, {
        ...failedDraft, error: message, failedSignature: failedDraft.signature
      })
      if (isCurrent()) {
        saveError = message
        lastDraftCreateAttemptSignature = makeFormSignature(editingForm)
        toast.error(saveError)
      } else {
        toast.error(`Could not create model preset: ${message}`)
      }
    } finally {
      if (isCurrent()) saveState = 'idle'
    }
  }

  async function handleCopyIntoNewPreset() {
    if (isEnriching || saveState === 'saving') return

    const activeConnectionId = selectedConnectionId

    if (manualEntryConnectionActive || connectionNeedsManualModel) {
      startCreate()
      selectedConnectionId = activeConnectionId
      applyManualConnectionDefaults()
      applySelectedConnectionToForm()
      catalogSelectionDirty = false
      toast.success('Manual preset started. Enter the basic info and it will create automatically.')
      return
    }

    if (!selectedCatalogModel) {
      toast.error('Select a model from the catalog first.')
      return
    }

    const sourceModel = selectedCatalogModel
    const applyTarget = resolveCatalogApplyTarget(sourceModel)
    if (!applyTarget.resolvedIds) {
      // Refuse before startCreate() resets the pickers, so the user keeps their selection and
      // sees why (BL-66: this used to fail silently with an empty form).
      toast.error(missingCatalogIdentityMessage(applyTarget.connection, applyTarget.connectionId))
      return
    }
    startCreate()
    // startCreate resets the draft state; pause auto-create after that reset while
    // catalog copy/enrichment finishes so only the final selected connection is saved.
    suppressDraftAutoCreate = true
    selectedConnectionId = activeConnectionId
    prefillFromCatalogModel(sourceModel)
    applySelectedConnectionToForm()
    isEnriching = true
    enrichmentWarning = null

    try {
      if (sourceModel.source !== 'vercel') {
        const { data, warnings } = buildCatalogEnrichmentFromModel(sourceModel)
        applyEnrichment(data)
        enrichmentWarning = warnings.length ? warnings.join(' ') : null
        if (warnings.length) {
          toast.warning('Catalog data copied with warnings', {
            description: warnings.join(' ')
          })
        }
        catalogSelectionDirty = false
        await handleCreate({ successMessage: 'Model preset created' })
        return
      }

      try {
        const response = await fetch('/api/user/saved-models/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vercelModelId: sourceModel.id,
            connectionId: activeConnectionId,
            forceRefresh: false
          })
        })

        if (!response.ok) {
          const message = await extractError(response, 'Failed to fetch model metadata')
          throw new Error(message)
        }

        const payload = await response.json()
        if (!payload?.data) {
          throw new Error('Enrichment payload missing data')
        }

        applyEnrichment(payload.data as SavedModel)
        enrichmentWarning = payload.warning ?? null
        catalogSelectionDirty = false
      } catch (error) {
        console.error('Model enrichment failed:', error)
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to fetch metadata from Vercel, using catalog snapshot.'
        let fallback: ReturnType<typeof buildCatalogEnrichmentFromModel>
        try {
          fallback = buildCatalogEnrichmentFromModel(sourceModel)
        } catch (fallbackError) {
          // Clear the half-filled draft so draft auto-create cannot save it, then say why.
          showCatalogLanding()
          toast.error('Model preset not created', {
            description: fallbackError instanceof Error ? fallbackError.message : message
          })
          return
        }
        const { data, warnings } = fallback
        applyEnrichment(data)
        enrichmentWarning = [message, ...warnings].join(' ')
        catalogSelectionDirty = false
        toast.warning('Vercel metadata unavailable, using catalog snapshot', {
          description: message
        })
      }

      await handleCreate({ successMessage: 'Model preset created' })
    } finally {
      isEnriching = false
      suppressDraftAutoCreate = false
    }
  }

  async function handleOverwriteSelectedPreset() {
    if (!selectedModelId) return
    const confirmed = await confirmDialog({
      title: 'Overwrite selected preset?',
      description: getOverwriteConfirmationMessage(),
      confirmLabel: 'Overwrite Preset'
    })
    if (!confirmed) return
    await handleEnrich()
  }

  async function handleDelete() {
    if (!selectedModelId) return
    const confirmed = await confirmDialog({
      title: 'Delete this saved model?',
      description: 'This permanently removes the selected saved model preset.',
      confirmLabel: 'Delete Model',
      tone: 'destructive'
    })
    if (!confirmed) return

    deleteBusy = true
    try {
      const response = await fetch(`/api/user/saved-models?id=${encodeURIComponent(selectedModelId)}`, {
        method: 'DELETE'
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to delete model')
        throw new Error(message)
      }

      const deletedId = selectedModelId
      models = models.filter((model) => model.id !== deletedId)
      savedModelsStore.removeSavedModel(deletedId)
      selectFirstModelOrShowCatalogLanding()
      presetDrafts.delete(deletedId)
      toast.success('Model deleted')
    } catch (error) {
      console.error('Model deletion failed:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete model')
    } finally {
      deleteBusy = false
    }
  }

  function updateField<K extends keyof ModelFormState>(key: K, value: string) {
    editingForm = { ...editingForm, [key]: value }
  }

  function formatField<K extends keyof ModelFormState>(key: K, formatter: (value: string) => string) {
    const current = String(editingForm[key] ?? '')
    const formatted = formatter(current)
    if (formatted === current) return
    editingForm = { ...editingForm, [key]: formatted }
  }

  function updateParameterValue(name: string, value: string) {
    // SA-102 P1 (DL-102-01): emptying a field is a decision, not an absence.
    // Record it so the seeding effect stops refilling it from defaultValue.
    const cleared = new Set(editingForm.clearedParameterNames)
    if (value.trim().length === 0) {
      cleared.add(name)
    } else {
      cleared.delete(name)
    }
    editingForm = {
      ...editingForm,
      parameterValues: {
        ...editingForm.parameterValues,
        [name]: value
      },
      clearedParameterNames: [...cleared]
    }
  }

  function getParameterValue(name: string) {
    return editingForm.parameterValues[name] ?? ''
  }

  function formatParameterValue(definition: ParameterDefinition) {
    const current = getParameterValue(definition.name)
    const formatted = formatParameterDisplayValue(definition, current)
    if (formatted === current) return
    updateParameterValue(definition.name, formatted)
  }

  /**
   * DL-102-16 names the local program that decides a blank field. Ollama
   * Thinking instead names the adapter's off default (BL-1261).
   * Cloud presets keep their wording.
   */
  function blankChoiceLabel(definition: ParameterDefinition, cloudLabel: string): string {
    return localProgramLabel ? resolveParameterPlaceholder(definition) : cloudLabel
  }

  function resolveParameterPlaceholder(definition: ParameterDefinition): string {
    if (localProviderId === 'ollama' && definition.name === 'ollamaThink') {
      return 'Default (off)'
    }
    if (localProgramLabel) {
      return `Not sent, ${localProgramLabel} decides`
    }
    return (
      formatParameterDisplayValue(definition, definition.placeholder ?? '') ||
      definition.placeholder ||
      ''
    )
  }

  function getParameterHint(definition: ParameterDefinition) {
    const hint =
      definition.helperText?.trim() ||
      definition.description?.trim() ||
      definition.placeholder?.trim() ||
      ''
    return hint.length ? hint : 'No hint available yet.'
  }

  function isResponseFormatParameter(definition: ParameterDefinition) {
    return definition.name === 'responseFormat'
  }

  function showResponseFormatWarning(definition: ParameterDefinition) {
    return isResponseFormatParameter(definition) && getParameterValue(definition.name).trim().length > 0
  }

  /**
   * BL-866: a saved choice the model does not offer (Claude Sonnet 5.5 has no Enabled) is shown
   * as it was saved, with the sentence a send would be refused with, so nothing is swapped
   * behind the user's back.
   */
  function getUnlistedChoiceNotice(definition: ParameterDefinition) {
    if (definition.inputType !== 'select') return null
    return describeUnlistedSelectValue(
      definition,
      getParameterValue(definition.name),
      editingForm.modelId || selectedCatalogEntry?.modelId || null
    )
  }

  function addCustomParamRow() {
    editingForm = {
      ...editingForm,
      customParameterRows: [...editingForm.customParameterRows, createCustomParamRow()]
    }
  }

  function updateCustomParamRow(id: string, updater: (row: CustomParamRow) => CustomParamRow) {
    editingForm = {
      ...editingForm,
      customParameterRows: editingForm.customParameterRows.map((row) =>
        row.id === id ? updater(row) : row
      )
    }
  }

  function formatCustomParamRowValue(id: string) {
    const row = editingForm.customParameterRows.find((entry) => entry.id === id)
    if (!row || row.type === 'json' || row.type === 'string' || row.type === 'boolean') return
    const formatted = formatCustomValue(row.value, row.type)
    if (formatted === row.value) return
    updateCustomParamRow(id, (current) => ({ ...current, value: formatted }))
  }

  function removeCustomParamRow(id: string) {
    editingForm = {
      ...editingForm,
      customParameterRows: editingForm.customParameterRows.filter((row) => row.id !== id)
    }
  }

  function setPricingInputMode(mode: 'flat' | 'tiered') {
    if (mode === 'flat') {
      editingForm = {
        ...editingForm,
        pricingInputMode: 'flat',
        pricingInputTiers: []
      }
    } else {
      editingForm = {
        ...editingForm,
        pricingInputMode: 'tiered',
        pricingInputTiers:
          editingForm.pricingInputTiers.length === 0 ? [createTierRow()] : editingForm.pricingInputTiers
      }
    }
    formValidationError = null
    lastInvalidModelSignature = null
  }

  function addPricingTier() {
    editingForm = {
      ...editingForm,
      pricingInputTiers: [...editingForm.pricingInputTiers, createTierRow()]
    }
  }

  function updatePricingTier(key: string, field: 'from' | 'to' | 'cost', value: string) {
    editingForm = {
      ...editingForm,
      pricingInputTiers: editingForm.pricingInputTiers.map((tier) =>
        tier.key === key ? { ...tier, [field]: value } : tier
      )
    }
  }

  function formatPricingTierField(key: string, field: 'from' | 'to' | 'cost') {
    const tier = editingForm.pricingInputTiers.find((entry) => entry.key === key)
    if (!tier) return
    const current = tier[field]
    const formatted =
      field === 'cost' ? formatCurrencyDisplay(current) : formatFlexibleNumberDisplay(current)
    if (formatted === current) return
    updatePricingTier(key, field, formatted)
  }

  function removePricingTier(key: string) {
    editingForm = {
      ...editingForm,
      pricingInputTiers: editingForm.pricingInputTiers.filter((tier) => tier.key !== key)
    }
  }

  function buildParameterValueMap(model: SavedModel): Record<string, string> {
    if (!model.settings) return {}
    const definitions = getHydrationParameterDefinitions(model)
    const mapped: Record<string, string> = {}
    for (const definition of definitions) {
      if (model.settings[definition.name] === undefined) continue
      mapped[definition.name] = formatParameterDisplayValue(
        definition,
        toInputValue(definition, model.settings[definition.name])
      )
    }

    return mapped
  }

  function getFormCapabilities(form: ModelFormState) {
    return projectOllamaPresetCapabilities(formCapabilitySubject(form), catalogModels)
  }

  function formCapabilitySubject(form: ModelFormState) {
    return {
      provider: form.provider,
      modelId: form.modelId,
      effectiveModelId: form.effectiveModelId,
      capabilities: form.capabilities,
      connection: {
        id: form.connectionId ?? undefined,
        type: form.connectionType ?? 'direct',
        service: form.connectionService ?? undefined
      }
    }
  }

  function acknowledgeOllamaForm(form: ModelFormState, original: ModelFormState, submitted: SavedModel, confirmed: SavedModel): ModelFormState {
    const capabilities = acknowledgeOllamaPresetCapabilities(formCapabilitySubject(form), formCapabilitySubject(original), submitted, confirmed)
    return capabilities === form.capabilities ? form : { ...form, capabilities }
  }

  function withSignatureCapabilities(signature: string, capabilities: ModelCapabilities | null): string {
    const snapshot = JSON.parse(signature)
    if (JSON.stringify(snapshot.capabilities ?? null) === JSON.stringify(capabilities)) return signature
    return JSON.stringify({ ...snapshot, capabilities })
  }

  function getHydrationParameterDefinitions(model: SavedModel): ParameterDefinition[] {
    const definitions = filterParameters({
      provider: resolveParameterProvider(model.provider, model.connection),
      modelId: model.modelId,
      vercelId: model.catalogModelId ?? model.vercelSourceId ?? undefined,
      capabilities: projectOllamaPresetCapabilities(model, catalogModels),
      connection: model.connection?.type ?? undefined,
      purpose: resolvePresetType(model),
      matrixEntries
    }).filter(definition => !isChatgptPlanConnection(model.connection?.id) || CHATGPT_PLAN_PARAMETERS.has(definition.name))
    // Preserve an already saved Thinking value even if optional metadata has
    // not arrived. Hydrating a known field does not advertise its capability.
    if (model.connection?.type === 'direct' && model.connection.service === 'ollama' &&
        model.settings?.ollamaThink !== undefined && !definitions.some(definition => definition.name === 'ollamaThink')) {
      const thinking = getParameterSchema('ollama').base.find(definition => definition.name === 'ollamaThink')
      if (thinking) definitions.push(thinking)
    }
    return definitions
  }

  function getFormLoadedContext(form: Pick<ModelFormState, 'provider' | 'connectionService' | 'connectionId' | 'catalogModelId' | 'modelId'>) {
    const program = resolveLocalProviderId(form)
    if (!program || form.connectionId !== `direct:${program}`) return undefined
    const serving = findServingModel(catalogModels, program)
    const connection = connectionOptions.find(option => option.id === form.connectionId) ?? null
    const matched = serving ?? findConnectionScopedCatalogPreset(catalogModels, connection, {
      provider: form.provider,
      modelId: form.modelId,
      targetId: form.catalogModelId
    })
    return matched?.localContext?.source === 'loaded' ? matched.localContext.loadedContextWindow : undefined
  }

  function resolveSafeFormMaxOutputTokens(maxOutputTokens: string | number | null | undefined, contextWindow: unknown, loadedContextWindow?: unknown) {
    return resolvePresetMaxOutputTokens({
      maxOutputTokens,
      contextWindow,
      loadedContextWindow
    })
  }

  function resolveSafeFormMaxOutputTokenResolution(
    maxOutputTokens: string | number | null | undefined,
    contextWindow: unknown,
    loadedContextWindow?: unknown
  ) {
    return resolvePresetMaxOutputTokenResolution({
      maxOutputTokens,
      contextWindow,
      loadedContextWindow
    })
  }

  function ensureSafeMaxOutputValue(parameterValues: Record<string, string>, contextWindow: unknown) {
    const safeMaxOutputTokens = resolveSafeFormMaxOutputTokens(parameterValues.maxTokens, contextWindow)
    return {
      ...parameterValues,
      maxTokens: formatGroupedIntegerDisplay(safeMaxOutputTokens)
    }
  }

  function withMaxOutputResolution(
    enrichment: ModelEnrichmentSnapshot | null | undefined,
    resolution: ReturnType<typeof resolvePresetMaxOutputTokenResolution>
  ): ModelEnrichmentSnapshot {
    const preserveExistingEstimate =
      !resolution.estimated &&
      enrichment?.maxOutputTokensEstimated === true &&
      enrichment.maxOutputTokens === resolution.maxOutputTokens
    const estimated = resolution.estimated || preserveExistingEstimate

    return {
      ...(enrichment ?? {
        source: 'provider-manager' as const,
        fetchedAt: new Date().toISOString()
      }),
      maxOutputTokens: resolution.maxOutputTokens,
      maxOutputTokensEstimated: estimated || undefined,
      maxOutputTokensEstimateReason:
        resolution.reason === 'provided'
          ? preserveExistingEstimate
            ? enrichment?.maxOutputTokensEstimateReason
            : undefined
          : resolution.reason
    }
  }

  function applySafeMaxOutputToEditingForm(rawMaxOutputTokens: string | number | null | undefined) {
    if (isChatgptPlanConnection(editingForm.connectionId)) return
    const contextWindow = parseFormattedInteger(editingForm.contextWindow) || 0
    const resolution = resolveSafeFormMaxOutputTokenResolution(rawMaxOutputTokens, contextWindow, getFormLoadedContext(editingForm))

    editingForm = {
      ...editingForm,
      parameterValues: {
        ...editingForm.parameterValues,
        maxTokens: formatGroupedIntegerDisplay(resolution.maxOutputTokens)
      },
      enrichment: withMaxOutputResolution(editingForm.enrichment, resolution)
    }
  }

  function buildCustomParameterRows(model: SavedModel): CustomParamRow[] {
    if (!model.settings) return []
    const parameterProvider = resolveParameterProvider(model.provider, model.connection)
    const definitions = getHydrationParameterDefinitions(model)
    const known = new Set(definitions.map((definition) => definition.name))
    const rows: CustomParamRow[] = []

    for (const [key, value] of Object.entries(model.settings)) {
      if (key.startsWith('codex_')) continue
      if (known.has(key)) continue
      if (
        isParameterSuppressedForModel(key, {
          provider: parameterProvider,
          modelId: model.modelId,
          vercelId: model.catalogModelId ?? model.vercelSourceId
        })
      ) {
        continue
      }
      const type = inferCustomParamType(value)
      rows.push(createCustomParamRow({
        key,
        type,
        value: formatCustomValue(value, type)
      }))
    }

    return rows
  }

  function normaliseModel(model: SavedModel): ModelFormState {
    const inputPricing = model.pricing?.input

    let pricingInputMode: 'flat' | 'tiered' = 'flat'
    let pricingInput = ''
    let pricingInputTiers: PricingTierFormRow[] = []

    if (inputPricing !== undefined && inputPricing !== null) {
      if (isTieredPricing(inputPricing)) {
        pricingInputMode = 'tiered'
        pricingInputTiers = inputPricing.map((tier) => ({
          key: createTierKey(),
          from: tier.from !== undefined ? formatFlexibleNumberDisplay(tier.from) : '',
          to: tier.to !== undefined ? formatFlexibleNumberDisplay(tier.to) : '',
          cost: tier.costPerMillion !== undefined ? formatCurrencyDisplay(tier.costPerMillion) : ''
        }))
      } else {
        pricingInput = extractPrice(inputPricing)
      }
    }

    const contextWindow = model.contextWindow ?? 0
    const maxOutputResolution = resolveSafeFormMaxOutputTokenResolution(model.settings?.maxTokens ?? null, contextWindow)
    const plan = isChatgptPlanConnection(model.connection?.id)
    const parameterValues = plan ? buildParameterValueMap(model) : ensureSafeMaxOutputValue(buildParameterValueMap(model), contextWindow)
    const enrichment = withAppliedBaselineFields(model.enrichment ?? null, {
      modelName: model.modelName,
      modelId: model.modelId,
      provider: model.provider,
      connectionId: model.connection?.id ?? null,
      maxOutputTokens: parameterValues.maxTokens ?? null,
      contextWindow,
      pricingInput:
        model.pricing && !isTieredPricing(model.pricing.input) ? model.pricing.input : null,
      pricingOutput:
        model.pricing && !isTieredPricing(model.pricing.output) ? model.pricing.output : null,
      pricingCachedInput: model.pricing?.cachedInput,
      capabilities: model.capabilities ?? null,
      vercelSourceId: model.vercelSourceId ?? null
    })
    // The plan has no output-token setting; an estimate-only snapshot would
    // falsely mark every missing identity baseline as Modified (BL-1067).
    const resolvedEnrichment = plan ? enrichment : withMaxOutputResolution(enrichment, maxOutputResolution)

    return {
      id: model.id ?? null,
      modelName: model.modelName ?? '',
      modelId: model.modelId ?? '',
      provider: model.provider ?? '',
      catalogModelId: model.catalogModelId ?? null,
      effectiveModelId: model.effectiveModelId ?? null,
      purpose: resolvePresetType(model),
      purposeOverride: model.purposeOverride ?? null,
      contextWindow: contextWindow ? formatGroupedIntegerDisplay(contextWindow) : '',
      pricingInputMode,
      pricingInput,
      pricingInputTiers,
      pricingOutput: extractPrice(model.pricing?.output),
      pricingCachedInput: extractPrice(model.pricing?.cachedInput),
      parameterValues,
      clearedParameterNames: [],
      customParameterRows: buildCustomParameterRows(model),
      customParametersJson: '',
      compatibility: model.compatibility ?? null,
      capabilities: model.capabilities ?? null,
      imageTransport: model.imageTransport === 'url' ? 'url' : 'auto',
      isVercelImport: model.isVercelImport ?? false,
      vercelSourceId: model.vercelSourceId ?? null,
      vercelDisplayName: model.vercelDisplayName ?? null,
      enrichment: resolvedEnrichment,
      voiceSession: resolveModelVoiceSessionConfig(model) ?? null,
      connectionId: model.connection?.id ?? null,
      connectionType: model.connection?.type ?? (model.isVercelImport ? 'vercel-gateway' : 'direct'),
      connectionService:
        model.connection?.service ??
        resolveConnectionServiceFromId(model.connection?.id) ??
        (model.provider ?? null),
      connectionUseDeveloperPrefix: model.connection?.useDeveloperPrefix ?? false
    }
  }

  function extractPrice(value: any): string {
    if (typeof value === 'number') return formatCurrencyDisplay(value)
    return ''
  }

  function validateModelForm(form: ModelFormState): string | null {
    if (customParametersJsonError) {
      return customParametersJsonError
    }
    if (!form.connectionType) {
      return 'Select a connection for this model.'
    }
    if (form.pricingInputMode === 'tiered') {
      if (form.pricingInputTiers.length === 0) {
        return 'Add at least one pricing tier or switch back to a single price.'
      }

      for (const [index, tier] of form.pricingInputTiers.entries()) {
        if (!tier.from.trim() || !tier.to.trim() || !tier.cost.trim()) {
          return `Pricing tier #${index + 1} requires from, to, and cost values.`
        }

        const from = parseFormattedNumber(tier.from)
        const to = parseFormattedNumber(tier.to)
        const cost = parseFormattedNumber(tier.cost)

        if (from === undefined || to === undefined || cost === undefined) {
          return `Pricing tier #${index + 1} must contain valid numeric values.`
        }

        if (from < 0 || to <= from) {
          return `Pricing tier #${index + 1} must have "to" greater than "from" and both ≥ 0.`
        }

        if (cost < 0) {
          return `Pricing tier #${index + 1} cost must be zero or positive.`
        }
      }
    }

    return null
  }

  function buildParameterSettings(form: ModelFormState) {
    const definitions = filterParameters({
      provider: resolveParameterProvider(
        form.provider || selectedCatalogEntry?.developerId || undefined,
        { type: form.connectionType, service: form.connectionService },
      ),
      modelId: form.modelId || selectedCatalogEntry?.modelId || undefined,
      vercelId: form.catalogModelId || form.vercelSourceId || selectedCatalogModel?.id || undefined,
      capabilities: getFormCapabilities(form),
      connection: form.connectionType ?? undefined,
      purpose: activePresetRole,
      matrixEntries
    })

    const settings: Record<string, ParameterValue> = {}
    // A restriction or metadata outage may hide Thinking; retain its saved
    // value on unrelated edits without changing whether runtime may send it.
    if (form.connectionType === 'direct' && form.connectionService === 'ollama' &&
        form.parameterValues.ollamaThink !== undefined && !definitions.some(definition => definition.name === 'ollamaThink')) {
      const thinking = getParameterSchema('ollama').base.find(definition => definition.name === 'ollamaThink')
      if (thinking) definitions.push(thinking)
    }
    for (const definition of definitions) {
      if (isChatgptPlanConnection(form.connectionId) && !CHATGPT_PLAN_PARAMETERS.has(definition.name)) continue
      const raw = form.parameterValues[definition.name]
      if (raw === undefined || raw.trim().length === 0) {
        continue
      }
      const parsed = fromInputValue(definition, raw)
      if (parsed !== undefined) {
        settings[definition.name] = parsed
      }
    }

    return settings
  }

  function parseCustomJson(value: string): Record<string, ParameterValue> | null {
    const trimmed = value.trim()
    if (!trimmed.length) return null
    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null
      }
      return parsed as Record<string, ParameterValue>
    } catch {
      return null
    }
  }

  function buildCustomSettings(form: ModelFormState): Record<string, ParameterValue> {
    const settings: Record<string, ParameterValue> = {}

    for (const row of form.customParameterRows) {
      const key = row.key.trim()
      if (!key.length) continue

      let parsed: ParameterValue | undefined
      switch (row.type) {
        case 'boolean':
          if (!row.value.trim().length) {
            parsed = undefined
            break
          }
          parsed = row.value.trim().toLowerCase() === 'true'
          break
        case 'number': {
          const numeric = parseFormattedNumber(row.value)
          parsed = Number.isFinite(numeric) ? numeric : undefined
          break
        }
        case 'json': {
          const jsonValue = parseCustomJson(row.value)
          parsed = jsonValue ?? undefined
          break
        }
        default:
          parsed = row.value
      }

      if (parsed !== undefined) {
        settings[key] = parsed
      }
    }

    const jsonOverride = parseCustomJson(form.customParametersJson)
    if (jsonOverride) {
      Object.assign(settings, jsonOverride)
    }

    return settings
  }

  function buildModelPayload(form: ModelFormState): SavedModel {
    const now = new Date().toISOString()

    // BL-67: blank sends nothing, zero is real. An unknown price or context window
    // stays absent so the Token Panel says Unknown instead of an exact $0.00.
    const pricing = buildPresetPricingFromForm(form)
    const contextWindow = parsePresetContextWindow(form.contextWindow)
    const maxOutputResolution = resolveSafeFormMaxOutputTokenResolution(form.parameterValues.maxTokens ?? null, contextWindow, getFormLoadedContext(form))
    const settings = buildParameterSettings(form)
    if (!isChatgptPlanConnection(form.connectionId)) settings.maxTokens = maxOutputResolution.maxOutputTokens
    const customSettings = buildCustomSettings(form)
    const includeCodexSettings = isCodexForm(form)
    const codexSettings = includeCodexSettings ? buildCodexSettingsPayload(codexOptions) : {}
    const voiceSession = resolveLiveKitSpeechToSpeechFormConfig(form)

    const mergedSettings =
      Object.keys({
        ...(settings || {}),
        ...(customSettings || {}),
        ...codexSettings
      }).length > 0
        ? {
            ...(settings || {}),
            ...(customSettings || {}),
            ...codexSettings
          }
        : undefined

    return {
      id: form.id ?? '',
      modelName: form.modelName.trim(),
      modelId: form.modelId.trim(),
      provider: form.provider.trim(),
      catalogModelId: form.catalogModelId ?? undefined,
      effectiveModelId: form.effectiveModelId ?? undefined,
      purpose: form.purpose,
      purposeOverride: form.purposeOverride ?? undefined,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      pricing,
      settings: mergedSettings,
      capabilities: getFormCapabilities(form) ?? undefined,
      voiceSession: voiceSession ?? undefined,
      compatibility: form.compatibility ?? undefined,
      imageTransport: form.imageTransport !== 'auto' ? form.imageTransport : undefined,
      isVercelImport: form.isVercelImport,
      vercelSourceId: form.vercelSourceId ?? undefined,
      vercelDisplayName: form.vercelDisplayName ?? undefined,
      enrichment: isChatgptPlanConnection(form.connectionId) ? undefined : withMaxOutputResolution(form.enrichment ?? {
        source: 'provider-manager',
        fetchedAt: now
      }, maxOutputResolution),
      connection: form.connectionType
        ? {
            id: form.connectionId ?? undefined,
            type: form.connectionType,
            service: form.connectionService ?? undefined,
            useDeveloperPrefix: form.connectionUseDeveloperPrefix ? true : undefined
          }
        : undefined,
      createdAt: now,
      updatedAt: now
    }
  }

  function buildCodexSettingsPayload(options: CodexFormOptions): Record<string, any> {
    const overrides = options.configOverrides
      .map((row) => ({
        key: row.key.trim(),
        value: row.value
      }))
      .filter((row) => row.key.length > 0)

    const workdir = options.customWorkingDirectory.trim()
    return {
      codex_permission_mode: options.permissionMode,
      codex_model: options.model,
      codex_reasoning_effort:
        options.reasoningEffort === 'default' ? undefined : options.reasoningEffort,
      codex_streaming_effect: options.streamingEffect,
      codex_search: options.search,
      codex_sandbox: options.sandbox,
      codex_approval: options.approval,
      codex_additional_dirs: options.addDirs,
      codex_feature_enable: options.enableFeatures,
      codex_feature_disable: options.disableFeatures,
      codex_config_overrides: overrides,
      codex_workdir_mode: options.workingDirectoryMode,
      codex_custom_workdir:
        options.workingDirectoryMode === 'custom' && workdir.length > 0 ? workdir : undefined
    }
  }

  // Which connection a catalog row would be applied through, and its exact provider identity there.
  // Pure: callers check it BEFORE touching the form, so a row that cannot run on the chosen
  // connection is refused up front instead of half-applying (BL-66).
  function resolveCatalogApplyTarget(model: CatalogModel) {
    const currentConnection = selectedConnection
    const needsAutoSelection =
      !currentConnection ||
      !isModelAllowedForConnection(model, currentConnection) ||
      !allowModelForConnection(model, currentConnection)

    let connectionId = selectedConnectionId
    let connection = currentConnection
    let autoSelectedConnectionId: string | null = null
    if (needsAutoSelection) {
      const nextConnection = autoSelectConnectionForModel(connectionOptions, model)
      if (nextConnection) {
        autoSelectedConnectionId = nextConnection.id
        connectionId = nextConnection.id
        connection = nextConnection
      }
    }

    const resolvedIds = resolveCatalogIds({
      connectionId,
      connection,
      developerId: model.provider,
      modelId: model.name,
      idVariants: model.idVariants ?? null
    })
    return { connectionId, connection, autoSelectedConnectionId, resolvedIds }
  }

  function missingCatalogIdentityMessage(
    connection: CatalogConnectionOption | null,
    connectionId: string | null
  ) {
    const label = connection?.label || connectionId || 'this connection'
    return `This model has no exact identifier for ${label}, so it cannot run there. Pick another model, or refresh the catalog.`
  }

  function prefillFromCatalogModel(model: CatalogModel) {
    const target = resolveCatalogApplyTarget(model)
    if (target.autoSelectedConnectionId) {
      selectedConnectionId = target.autoSelectedConnectionId
    }
    const resolvedIds = target.resolvedIds
    if (!resolvedIds) {
      formValidationError = missingCatalogIdentityMessage(target.connection, target.connectionId)
      return
    }
    const connectionForVariant = target.connection
    const hostedCatalogIdentity = !['local', 'n8n-only', 'codex', 'claude-cli'].includes(model.source ?? '')
    const isGatewaySelection = connectionForVariant?.transport === 'vercel-gateway'
    editingForm = {
      ...editingForm,
      provider: resolvedIds.developerId,
      modelId: resolvedIds.modelId,
      catalogModelId: hostedCatalogIdentity ? model.id : null,
      effectiveModelId: resolvedIds.effectiveModelId,
      purpose: normalizeCatalogRole(model.purpose ?? null),
      purposeOverride: null,
      modelName: editingForm.modelName || model.displayName,
      isVercelImport: isGatewaySelection,
      vercelSourceId: isGatewaySelection ? model.id : null
    }
  }

  function applySelectedConnectionToForm() {
    const connection = selectedConnection
    editingForm = {
      ...editingForm,
      connectionId: connection?.id ?? null,
      connectionType: connection?.transport ?? null,
      connectionService: connection?.service ?? null,
      connectionUseDeveloperPrefix: isCustomConnection
        ? editingForm.connectionUseDeveloperPrefix
        : false
    }
  }

  function applyManualConnectionDefaults() {
    if (!selectedConnection) return
    const providerHint = isCustomConnection
      ? ''
      : connectionProviderHints.get(selectedConnection.id) ||
        selectedConnection.service ||
        selectedConnection.id

    editingForm = {
      ...editingForm,
      provider: providerHint ?? '',
      modelId: '',
      modelName: '',
      contextWindow: '',
      pricingInput: '',
      pricingOutput: '',
      pricingCachedInput: '',
      pricingInputMode: 'flat',
      pricingInputTiers: [],
      isVercelImport: false,
      catalogModelId: null,
      effectiveModelId: null,
      vercelSourceId: null,
      vercelDisplayName: null,
      enrichment: null,
      voiceSession: null,
      capabilities: null,
      compatibility: providerHint ? determineModelCompatibility(providerHint) : null,
      parameterValues: {},
      clearedParameterNames: [],
      connectionUseDeveloperPrefix: false
    }
  }

  function getNewPresetActionLabel() {
    if (manualEntryConnectionActive || connectionNeedsManualModel) {
      return 'Start Manual Preset'
    }
    return 'Use to Create New Preset'
  }

  function getOverwriteConfirmationMessage() {
    return [
      'This updates the basic model info, connection details, supported features, compatibility badges, pricing, context window, and Max Output Tokens.',
      'Your other model parameters, custom parameters, and image transport setting will stay exactly as they are.'
    ].join('\n')
  }

  function syncCatalogSelectionFromEditingForm() {
    if (!catalogModels.length) {
      selectedCatalogProvider = selectedCatalogProvider || ''
      return
    }

    const baselineProvider = normalizedField(editingForm.enrichment?.provider)
    const baselineModelId = normalizedField(editingForm.enrichment?.modelId)
    const providerModified =
      baselineProvider.length > 0 && normalizedField(editingForm.provider) !== baselineProvider
    const modelModified =
      baselineModelId.length > 0 && normalizedField(editingForm.modelId) !== baselineModelId

    if (providerModified || modelModified) {
      if (!providerModified && editingForm.provider) {
        selectedCatalogProvider = canonicalizeCatalogDeveloperId(editingForm.provider)
      } else {
        selectedCatalogProvider = ''
      }
      selectedCatalogModelId = ''
      return
    }

    const targetId =
      editingForm.catalogModelId ||
      editingForm.vercelSourceId ||
      (editingForm.provider && editingForm.modelId ? `${editingForm.provider}/${editingForm.modelId}` : null)

    if (!targetId) {
      selectedCatalogProvider = ''
      selectedCatalogModelId = ''
      return
    }

    const match = findConnectionScopedCatalogPreset(catalogModels, selectedConnection, {
      targetId,
      provider: editingForm.provider,
      modelId: editingForm.modelId
    })

    if (match) {
      const scopedMatch = resolveConnectionScopedCatalogModel(match, selectedConnection)
      selectedCatalogProvider = scopedMatch.canonicalDeveloperId
      selectedCatalogModelId = match.id
    } else {
      selectedCatalogProvider = ''
      selectedCatalogModelId = ''
    }
  }

  function handleCatalogProviderSelect(value: string | string[]) {
    const nextValue = Array.isArray(value) ? value[0] ?? '' : value ?? ''
    selectedCatalogProvider = nextValue
    catalogSelectionDirty = true
    // A new developer means a new model list; the user picks from it (no first-row default).
    selectedCatalogModelId = ''
  }

  function handleCatalogModelSelect(value: string | string[]) {
    const nextValue = Array.isArray(value) ? value[0] ?? '' : value ?? ''
    selectedCatalogModelId = nextValue
    catalogSelectionDirty = true
  }

  function toCatalogNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim().length) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }

  function catalogFeaturesToCapabilities(features?: Record<string, any> | null): ModelCapabilities | null {
    if (!features) return null
    const capabilityKeys: Array<keyof ModelCapabilities> = [
      'streaming',
      'vision',
      'tools',
      'reasoning',
      'jsonMode',
      'cacheControl',
      'longContext',
      'code',
      'fast',
      'audio',
      'image'
    ]
    const mapped: ModelCapabilities = {}

    for (const key of capabilityKeys) {
      if (features[key] === true) {
        mapped[key] = true
      }
    }
    if (features.longContext === undefined && typeof features.maxTokens === 'number') {
      if (features.maxTokens >= 128_000) {
        mapped.longContext = true
      }
    }

    return Object.keys(mapped).length ? mapped : null
  }

  function buildCatalogEnrichmentFromModel(model: CatalogModel) {
    const baselineModelName = editingForm.modelName?.trim() || model.displayName
    const baselineConnectionId = editingForm.connectionId ?? selectedConnectionId ?? undefined
    const resolvedIds = resolveCatalogIds({
      connectionId: baselineConnectionId,
      connection: selectedConnection,
      developerId: model.provider,
      modelId: model.name,
      idVariants: model.idVariants ?? null
    })
    if (!resolvedIds) {
      throw new Error(
        `The Model Catalog is missing the exact identifier for ${baselineConnectionId || 'this connection'}.`
      )
    }
    const baselineModelId = resolvedIds.modelId
    const baselineProvider = resolvedIds.developerId
    const hostedCatalogIdentity = !['local', 'n8n-only', 'codex', 'claude-cli'].includes(model.source ?? '')
    const isGatewaySelection = selectedConnection?.transport === 'vercel-gateway'
    // BL-68: the chosen connection's own limits when its variant carries them.
    // BL-67: a window of 0 (or less) is not a window; it is unknown.
    const connectionLimits = resolveCatalogConnectionLimits(model, baselineConnectionId)
    const rawMaxOutputTokens = connectionLimits.maxOutputTokens
    const plan = isChatgptPlanConnection(baselineConnectionId)
    // BL-132: and the chosen connection's own price when its variant carries one.
    const connectionPricing = resolveCatalogConnectionPricing(model, baselineConnectionId).pricing
    const pricingInput = toCatalogNumber(connectionPricing?.input)
    const pricingOutput = toCatalogNumber(connectionPricing?.output)
    const pricingCached = toCatalogNumber(connectionPricing?.cachedInput)
    const contextWindow =
      connectionLimits.contextWindow !== undefined ? Math.round(connectionLimits.contextWindow) : undefined
    const maxOutputResolution = resolveSafeFormMaxOutputTokenResolution(rawMaxOutputTokens, contextWindow,
      model.source === 'local' && model.localContext?.source === 'loaded' ? model.localContext.loadedContextWindow : undefined)
    const baselineMaxOutputTokens = maxOutputResolution.maxOutputTokens
    const capabilities = catalogFeaturesToCapabilities(model.features ?? null)
    const compatibility = determineModelCompatibility(
      canonicalizeCatalogDeveloperId(model.provider)
    )

    const pricing: { input?: number; output?: number; cachedInput?: number } = {}
    if (pricingInput !== undefined) pricing.input = pricingInput
    if (pricingOutput !== undefined) pricing.output = pricingOutput
    if (pricingCached !== undefined) pricing.cachedInput = pricingCached

    const warnings: string[] = []
    if (!plan && Object.keys(pricing).length === 0) {
      warnings.push('Pricing not provided in catalog entry.')
    }
    if (!plan && contextWindow === undefined) {
      warnings.push('Context window missing from catalog entry.')
    }
    if (!plan && rawMaxOutputTokens === undefined) {
      warnings.push(`Max Output Tokens missing from catalog entry; using ${baselineMaxOutputTokens.toLocaleString()}.`)
    } else if (!plan && rawMaxOutputTokens !== undefined && baselineMaxOutputTokens !== Math.floor(rawMaxOutputTokens)) {
      warnings.push(`Catalog Max Output Tokens looked unsafe; using ${baselineMaxOutputTokens.toLocaleString()}.`)
    }
    if (!capabilities) {
      warnings.push('Capabilities not reported by the catalog entry.')
    }

    const enrichment: ModelEnrichmentSnapshot = {
      source: 'provider-manager',
      fetchedAt: new Date().toISOString(),
      modelName: baselineModelName,
      modelId: baselineModelId,
      ...(!plan ? {
        maxOutputTokens: baselineMaxOutputTokens,
        maxOutputTokensEstimated: maxOutputResolution.estimated,
        maxOutputTokensEstimateReason: maxOutputResolution.reason === 'provided' ? undefined : maxOutputResolution.reason
      } : {}),
      contextWindow,
      pricing: Object.keys(pricing).length ? pricing : undefined,
      capabilities: capabilities ?? undefined,
      provider: baselineProvider || undefined,
      connectionId: baselineConnectionId,
      identifier: resolvedIds.effectiveModelId
    }

    // BL-67: copy only the prices the row lists; a missing half is not invented as 0.
    const pricingPayload = buildCatalogPresetPricing({
      input: pricingInput,
      output: pricingOutput,
      cachedInput: pricingCached
    })

    const data: Partial<SavedModel> = {
      modelName: baselineModelName,
      modelId: baselineModelId,
      provider: baselineProvider,
      catalogModelId: hostedCatalogIdentity ? model.id : undefined,
      effectiveModelId: resolvedIds.effectiveModelId,
      purpose: normalizeCatalogRole(model.purpose ?? null),
      contextWindow: contextWindow ?? undefined,
      pricing: pricingPayload,
      capabilities: capabilities ?? undefined,
      compatibility,
      isVercelImport: isGatewaySelection,
      vercelSourceId: isGatewaySelection ? model.id : undefined,
      vercelDisplayName: model.displayName,
      settings: plan ? undefined : {
        maxTokens: baselineMaxOutputTokens
      },
      enrichment
    }

    return { data, warnings }
  }

  function withAppliedBaselineFields(
    snapshot: ModelEnrichmentSnapshot | null | undefined,
    fields: {
      modelName?: string | null
      modelId?: string | null
      provider?: string | null
      connectionId?: string | null
      maxOutputTokens?: string | number | null
      contextWindow?: string | number | null
      pricingInput?: string | number | null
      pricingOutput?: string | number | null
      pricingCachedInput?: string | number | null
      capabilities?: ModelCapabilities | null
      vercelSourceId?: string | null
    }
  ) {
    if (!snapshot) return snapshot ?? null

    const normalizedProvider = fields.provider?.trim().toLowerCase() || undefined
    const normalizedModelId = fields.modelId?.trim() || undefined
    const normalizedConnectionId = fields.connectionId?.trim() || undefined
    const nextPricing = { ...(snapshot.pricing ?? {}) }
    const inputValue = toComparableNumber(fields.pricingInput)
    const outputValue = toComparableNumber(fields.pricingOutput)
    const cachedValue = toComparableNumber(fields.pricingCachedInput)

    if (nextPricing.input === undefined && inputValue !== undefined) {
      nextPricing.input = inputValue
    }
    if (nextPricing.output === undefined && outputValue !== undefined) {
      nextPricing.output = outputValue
    }
    if (nextPricing.cachedInput === undefined && cachedValue !== undefined) {
      nextPricing.cachedInput = cachedValue
    }

    return {
      ...snapshot,
      modelName: snapshot.modelName ?? (fields.modelName?.trim() || undefined),
      modelId: snapshot.modelId ?? normalizedModelId,
      maxOutputTokens: snapshot.maxOutputTokens ?? toComparableNumber(fields.maxOutputTokens),
      provider: snapshot.provider ?? normalizedProvider,
      connectionId: snapshot.connectionId ?? normalizedConnectionId,
      contextWindow: snapshot.contextWindow ?? toComparableNumber(fields.contextWindow),
      pricing: Object.keys(nextPricing).length ? nextPricing : undefined,
      capabilities: snapshot.capabilities ?? fields.capabilities ?? undefined,
      identifier:
        snapshot.identifier ??
        fields.vercelSourceId?.trim() ??
        (normalizedProvider && normalizedModelId ? `${normalizedProvider}/${normalizedModelId}` : undefined)
    } satisfies ModelEnrichmentSnapshot
  }

  function applyCatalogMetadata(model: CatalogModel, context: 'fallback' | 'vercel-error' = 'fallback') {
    const { data, warnings } = buildCatalogEnrichmentFromModel(model)
    applyEnrichment(data)
    enrichmentWarning = warnings.length ? warnings.join(' ') : null

    if (warnings.length) {
      toast.warning('Catalog metadata applied with warnings', {
        description: warnings.join(' ')
      })
    } else if (context === 'fallback') {
      toast.success('Model metadata updated from catalog')
    } else {
      toast.success('Vercel metadata unavailable, used catalog snapshot instead')
    }
  }

  function handleConnectionSelect(value: string | string[]) {
    const nextValue = Array.isArray(value) ? value[0] : value
    if (!nextValue) return
    selectedConnectionId = nextValue
    catalogSelectionDirty = true
  }

  function applyEnrichment(data: Partial<SavedModel>) {
    const next: ModelFormState = { ...editingForm }

    if (data.modelName) next.modelName = data.modelName
    if (data.modelId) next.modelId = data.modelId
    if (data.provider) next.provider = data.provider
    // BL-67: every caller hands in a whole catalog row, so a window or price the row
    // does not list is unknown: clear the field (it saves as absent) instead of keeping
    // the previous model's value or writing a fake 0. A listed 0 price stays 0.
    next.contextWindow =
      typeof data.contextWindow === 'number' && data.contextWindow > 0
        ? formatGroupedIntegerDisplay(data.contextWindow)
        : ''
    next.pricingInputMode = 'flat'
    next.pricingInputTiers = []
    next.pricingInput =
      typeof data.pricing?.input === 'number' ? formatCurrencyDisplay(data.pricing.input) : ''
    next.pricingOutput =
      typeof data.pricing?.output === 'number' ? formatCurrencyDisplay(data.pricing.output) : ''
    next.pricingCachedInput =
      typeof data.pricing?.cachedInput === 'number'
        ? formatCurrencyDisplay(data.pricing.cachedInput)
        : ''

    if (data.settings && typeof data.settings.maxTokens === 'number') {
      next.parameterValues = {
        ...next.parameterValues,
        maxTokens: formatGroupedIntegerDisplay(data.settings.maxTokens)
      }
    }

    next.capabilities = data.capabilities ?? next.capabilities
    next.compatibility = data.compatibility ?? next.compatibility
    next.catalogModelId = data.catalogModelId ?? next.catalogModelId
    next.effectiveModelId = data.effectiveModelId ?? next.effectiveModelId
    if (data.purpose && !next.purposeOverride) next.purpose = data.purpose
    next.isVercelImport = data.isVercelImport ?? next.isVercelImport
    next.vercelSourceId = data.vercelSourceId ?? next.vercelSourceId
    next.vercelDisplayName = data.vercelDisplayName ?? next.vercelDisplayName
    next.voiceSession = normalizeModelVoiceSessionConfig(data.voiceSession) ?? next.voiceSession
    next.enrichment = withAppliedBaselineFields(data.enrichment ?? null, {
      modelName: next.modelName,
      modelId: next.modelId,
      provider: next.provider,
      connectionId: next.connectionId ?? selectedConnectionId ?? null,
      maxOutputTokens: next.parameterValues.maxTokens ?? null,
      contextWindow: next.contextWindow,
      pricingInput: next.pricingInputMode === 'flat' ? next.pricingInput : null,
      pricingOutput: next.pricingOutput,
      pricingCachedInput: next.pricingCachedInput,
      capabilities: next.capabilities ?? null,
      vercelSourceId: next.vercelSourceId ?? null
    })

    editingForm = next
  }

  function normalizedField(value?: string | null) {
    return value?.trim().toLowerCase() ?? ''
  }

  function getCatalogBaselineDisplayName() {
    return editingForm.vercelDisplayName?.trim() || editingForm.enrichment?.modelName?.trim() || ''
  }

  function isCatalogBaselineFieldModified(
    field:
      | 'modelName'
      | 'connectionId'
      | 'provider'
      | 'modelId'
      | 'maxOutputTokens'
      | 'pricingInput'
      | 'pricingOutput'
      | 'pricingCachedInput'
      | 'contextWindow'
  ) {
    const snapshot = editingForm.enrichment
    if (!snapshot) return false

    switch (field) {
      case 'modelName':
        return normalizedField(getCatalogBaselineDisplayName()) !== normalizedField(editingForm.modelName)
      case 'connectionId':
        return normalizedField(snapshot.connectionId) !== normalizedField(editingForm.connectionId)
      case 'provider':
        return normalizedField(snapshot.provider) !== normalizedField(editingForm.provider)
      case 'modelId':
        return normalizedField(snapshot.modelId) !== normalizedField(editingForm.modelId)
      case 'maxOutputTokens':
        return (
          snapshot.maxOutputTokens !== undefined &&
          snapshot.maxOutputTokens !== (toComparableNumber(getParameterValue('maxTokens')) ?? 0)
        )
      case 'pricingInput':
        if (editingForm.pricingInputMode === 'tiered') return true
        return (
          snapshot.pricing?.input !== undefined &&
          !almostEqual(snapshot.pricing.input, toComparableNumber(editingForm.pricingInput) ?? 0)
        )
      case 'pricingOutput':
        return (
          snapshot.pricing?.output !== undefined &&
          !almostEqual(snapshot.pricing.output, toComparableNumber(editingForm.pricingOutput) ?? 0)
        )
      case 'pricingCachedInput':
        return (
          snapshot.pricing?.cachedInput !== undefined &&
          !almostEqual(snapshot.pricing.cachedInput, toComparableNumber(editingForm.pricingCachedInput) ?? 0)
        )
      case 'contextWindow':
        return (
          snapshot.contextWindow !== undefined &&
          snapshot.contextWindow !== (toComparableNumber(editingForm.contextWindow) ?? 0)
        )
      default:
        return false
    }
  }

  function hasCatalogBaselineInfoModifications() {
    return (
      isCatalogBaselineFieldModified('modelName') ||
      isCatalogBaselineFieldModified('connectionId') ||
      isCatalogBaselineFieldModified('provider') ||
      isCatalogBaselineFieldModified('modelId') ||
      isCatalogBaselineFieldModified('maxOutputTokens') ||
      isCatalogBaselineFieldModified('pricingInput') ||
      isCatalogBaselineFieldModified('pricingOutput') ||
      isCatalogBaselineFieldModified('pricingCachedInput') ||
      isCatalogBaselineFieldModified('contextWindow')
    )
  }

  function detectEnrichmentOverrides(): boolean {
    if (!editingForm.enrichment) return false
    const snapshot = editingForm.enrichment

    const maxOutputMatches =
      snapshot.maxOutputTokens === undefined ||
      snapshot.maxOutputTokens === (toComparableNumber(getParameterValue('maxTokens')) ?? 0)
    const contextMatches =
      snapshot.contextWindow === undefined ||
      snapshot.contextWindow === (toComparableNumber(editingForm.contextWindow) ?? 0)
    const pricing = snapshot.pricing ?? {}
    const inputMatches =
      pricing.input === undefined ||
      (editingForm.pricingInputMode === 'flat' &&
        almostEqual(pricing.input, toComparableNumber(editingForm.pricingInput) ?? 0))
    const outputMatches =
      pricing.output === undefined ||
      almostEqual(pricing.output, toComparableNumber(editingForm.pricingOutput) ?? 0)
    const cachedMatches =
      pricing.cachedInput === undefined ||
      almostEqual(pricing.cachedInput, toComparableNumber(editingForm.pricingCachedInput) ?? 0)
    const tieredOverride = editingForm.pricingInputMode === 'tiered'

    return !(contextMatches && inputMatches && outputMatches && cachedMatches && maxOutputMatches && !tieredOverride)
  }

  function restoreDefaultsFromEnrichment() {
    if (!editingForm.enrichment) return
    const snapshot = editingForm.enrichment
    const pricing = snapshot.pricing ?? {}

    editingForm = {
      ...editingForm,
      parameterValues:
        snapshot.maxOutputTokens !== undefined
          ? {
              ...editingForm.parameterValues,
              maxTokens: formatGroupedIntegerDisplay(snapshot.maxOutputTokens)
            }
          : editingForm.parameterValues,
      contextWindow:
        snapshot.contextWindow !== undefined
          ? formatGroupedIntegerDisplay(snapshot.contextWindow)
          : editingForm.contextWindow,
      pricingInputMode: pricing.input !== undefined ? 'flat' : editingForm.pricingInputMode,
      pricingInputTiers: pricing.input !== undefined ? [] : editingForm.pricingInputTiers,
      pricingInput:
        pricing.input !== undefined ? formatCurrencyDisplay(pricing.input ?? 0) : editingForm.pricingInput,
      pricingOutput:
        pricing.output !== undefined ? formatCurrencyDisplay(pricing.output ?? 0) : editingForm.pricingOutput,
      pricingCachedInput:
        pricing.cachedInput !== undefined
          ? formatCurrencyDisplay(pricing.cachedInput ?? 0)
          : editingForm.pricingCachedInput
    }
  }

  async function handleEnrich(forceRefresh = false) {
    if (manualEntryConnectionActive) {
      applyManualConnectionDefaults()
      applySelectedConnectionToForm()
      catalogSelectionDirty = false
      toast.success('Manual provider applied. Fill in the details below.')
      return
    }

    if (!selectedCatalogModel) {
      toast.error('Select a model from the catalog first.')
      return
    }

    const applyTarget = resolveCatalogApplyTarget(selectedCatalogModel)
    if (!applyTarget.resolvedIds) {
      // Refuse before the existing preset's connection fields change (BL-66).
      toast.error(missingCatalogIdentityMessage(applyTarget.connection, applyTarget.connectionId))
      return
    }

    prefillFromCatalogModel(selectedCatalogModel)
    applySelectedConnectionToForm()
    isEnriching = true
    enrichmentWarning = null

    if (selectedCatalogModel.source !== 'vercel') {
      applyCatalogMetadata(selectedCatalogModel, 'fallback')
      catalogSelectionDirty = false
      isEnriching = false
      return
    }

    try {
      const response = await fetch('/api/user/saved-models/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vercelModelId: selectedCatalogModel.id,
          connectionId: selectedConnectionId,
          forceRefresh
        })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to fetch model metadata')
        throw new Error(message)
      }

      const payload = await response.json()
      if (!payload?.data) {
        throw new Error('Enrichment payload missing data')
      }

      applyEnrichment(payload.data as SavedModel)
      enrichmentWarning = payload.warning ?? null
      catalogSelectionDirty = false
      toast.success('Model metadata updated')
    } catch (error) {
      console.error('Model enrichment failed:', error)
      const message =
        error instanceof Error ? error.message : 'Failed to fetch metadata from Vercel, using catalog snapshot.'
      toast.warning('Falling back to catalog metadata', {
        description: message
      })
      applyCatalogMetadata(selectedCatalogModel, 'vercel-error')
      catalogSelectionDirty = false
    } finally {
      isEnriching = false
    }
  }

  function makeFormSignature(form: ModelFormState) {
    return JSON.stringify({
      ...form,
      // SA-102 P1: UI-only editing state, never persisted and never a change.
      clearedParameterNames: undefined,
      parameterValues: Object.fromEntries(
        Object.entries(form.parameterValues).sort(([a], [b]) => a.localeCompare(b))
      ),
      pricingInputTiers: form.pricingInputTiers.map(({ from, to, cost }) => ({
        from,
        to,
        cost
      })),
      codexOptions: {
        model: codexOptions.model,
        reasoningEffort: codexOptions.reasoningEffort,
        permissionMode: codexOptions.permissionMode,
        streamingEffect: codexOptions.streamingEffect,
        search: codexOptions.search,
        sandbox: codexOptions.sandbox,
        approval: codexOptions.approval,
        addDirs: [...codexOptions.addDirs],
        enableFeatures: [...codexOptions.enableFeatures],
        disableFeatures: [...codexOptions.disableFeatures],
        configOverrides: codexOptions.configOverrides.map(({ key, value }) => ({
          key,
          value
        })),
        workingDirectoryMode: codexOptions.workingDirectoryMode,
        customWorkingDirectory: codexOptions.customWorkingDirectory
      }
    })
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const data = await response.json()
      return data?.error || data?.message || fallback
    } catch {
      return fallback
    }
  }

  export function readAppActionState() {
    return {
      entityId: selectedModelId,
      busy: isLoading || saveState === 'saving' || deleteBusy,
      dirty: creatingNew || (formPersistedSignature !== null && makeFormSignature(editingForm) !== formPersistedSignature),
      error: listError
    }
  }
  export function selectAppActionTarget(target: SettingsTarget, context: ActionContext) {
    context.check()
    if (appActionsHaveDrafts()) refuse('unsaved_changes')
    const model = models.find(model => model.id === target.modelId)
    if (!model) refuse('missing_entity')
    if (readAppActionState().busy) refuse('busy')
    selectModel(model)
  }

</script>

<div class="space-y-4">
  <div class="flex items-center gap-2">
    <div class="flex items-center gap-1">
      <BatshitIcon id="models" class="h-5 w-5 text-muted-foreground" />
      <h3 class="batshit-settings-section-title">Models</h3>
      <SettingsInfoMenu ariaLabel="About Models">
        <p>
          Save model presets once, then reuse them across agents and other Batshit surfaces without re-entering pricing, capability, and parameter defaults every time.
        </p>
      </SettingsInfoMenu>
    </div>
  </div>

  <div class="batshit-settings-surface space-y-4">
    {#if unlistedNotice}
      <div class="batshit-settings-inline-alert is-warning">
        {unlistedNotice.count === 1
          ? '1 preset uses a model Vercel AI Gateway no longer lists. Agents that use it cannot send until you pick another model for them.'
          : `${unlistedNotice.count} presets use models Vercel AI Gateway no longer lists. Agents that use them cannot send until you pick another model for them.`}
        {#if unlistedNotice.names.length}
          <span class="batshit-settings-caption ml-1">
            {unlistedNotice.names.slice(0, 3).join(', ')}
            {#if unlistedNotice.names.length > 3}
              &nbsp;+{unlistedNotice.names.length - 3} more
            {/if}
          </span>
        {/if}
      </div>
    {/if}

    <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-display-card batshit-settings-model-catalog-card">
      <Card.Header class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="space-y-1">
          <div class="flex items-center gap-1">
            <Card.Title class="flex items-center gap-2">
              <BatshitIcon id="model-catalog" class="h-4 w-4" />
              Browse Model Catalog
            </Card.Title>
            <SettingsInfoMenu ariaLabel="About Model Catalog" contentClass="w-80">
              <p>
                Browse the shared model catalog and copy provider, pricing, capability, and ID data
                into the preset below when you want a fast starting point.
              </p>
              <p class="mt-2">
                The catalog is a helper, not the preset itself. After you copy catalog data into a
                preset, you can still customize the preset fields independently.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <ToggleGroup.Root
            type="single"
            bind:value={catalogRoleFilter}
            variant="outline"
            size="sm"
            class="max-w-full"
            aria-label="Catalog model type filter"
            disabled={catalogLoading || manualEntryConnectionActive}
          >
            {#each CATALOG_ROLE_OPTIONS as option (option.value)}
              <ToggleGroup.Item value={option.value} class="batshit-settings-toggle-filter">
                {option.label}
              </ToggleGroup.Item>
            {/each}
          </ToggleGroup.Root>
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Button
                variant="ghost"
                size="icon"

                onclick={() => loadCatalog(true)}
                disabled={catalogLoading}
              >
                <RefreshCcw class={`${catalogLoading ? 'animate-spin' : ''}`} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>Refresh catalog</Tooltip.Content>
          </Tooltip.Root>
        </div>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="grid gap-4 md:grid-cols-3">
          <div class="space-y-1.5">
            <Label.Root class="batshit-settings-form-label">Provider</Label.Root>
            {#if sortedConnectionOptions.length}
              <Select.Root
                type="single"
                value={selectedConnectionId ?? undefined}
                onValueChange={handleConnectionSelect}
                disabled={catalogLoading}
              >
                <Select.Trigger class="w-full">
                  <span class="flex items-center justify-between gap-2 truncate text-left">
                    <span class="flex items-center gap-2 truncate">
                      {#if selectedConnection}
                        {@const iconMeta = getConnectionIconMeta(selectedConnection, $themeStore)}
                        <img
                          src={iconMeta.icon}
                          alt={`${selectedConnection.label} icon`}
                          class="h-4 w-4 object-contain"
                          style:filter={iconMeta.filter || null}
                        />
                      {/if}
                      <span class="truncate">{selectedConnection?.label || 'Choose provider'}</span>
                    </span>
                  </span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Group>
                    {#each sortedConnectionOptions as option}
                      {@const iconMeta = getConnectionIconMeta(option, $themeStore)}
                      <Select.Item value={option.id}>
                        <div class="flex items-center justify-between gap-3">
                          <span class="flex items-center gap-2 truncate">
                            <img
                              src={iconMeta.icon}
                              alt={`${option.label} icon`}
                              class="h-4 w-4 object-contain"
                              style:filter={iconMeta.filter || null}
                            />
                            <span class="truncate">{option.label}</span>
                          </span>
                          <div class="flex items-center gap-2">
                            {#if !n8nOnlyConnections.has(option.id)}
                              <Badge
                                variant={option.status === 'ready' ? 'secondary' : 'outline'}
                                class="batshit-settings-child-label flex items-center gap-1"
                              >
                                {#if option.status === 'ready'}
                                  <CheckCircle2 class="h-3 w-3" />
                                {/if}
                                <span>Batshit · {option.status === 'ready' ? 'ready' : 'compatible'}</span>
                              </Badge>
                            {/if}
                            {#if showsN8nBadge(option)}
                              <Badge variant="outline" class="batshit-settings-child-label">
                                n8n · compatible
                              </Badge>
                            {/if}
                          </div>
                        </div>
                      </Select.Item>
                    {/each}
                  </Select.Group>
                </Select.Content>
              </Select.Root>
            {:else}
              <p class="batshit-settings-form-label">
                Add provider API keys via Settings → API Keys to enable direct connections.
              </p>
            {/if}
          </div>
          <div class="space-y-1.5">
            <Label.Root class="batshit-settings-form-label">Developer</Label.Root>
            <Select.Root
              type="single"
              value={selectedCatalogProvider || undefined}
              onValueChange={handleCatalogProviderSelect}
              disabled={catalogLoading || manualEntryConnectionActive || !catalogProviderOptions.length}
            >
              <Select.Trigger class="w-full">
                <span class="flex items-center justify-between gap-2 truncate text-left">
                  <span class="flex items-center gap-2 truncate">
                    {#if selectedCatalogProvider && !manualEntryConnectionActive}
                      <ModelProviderIcon
                        modelId={`${selectedCatalogProvider}/preview`}
                        modelName={formatDeveloperLabel(selectedCatalogProvider)}
                        provider={selectedCatalogProvider}
                        size="sm"
                        showOverlay={false}
                        badgeProvider={catalogFallbackProvider ?? undefined}
                      />
                    {/if}
                    <span>
                      {#if manualEntryConnectionActive}
                        Enter manually
                      {:else}
                        {(selectedCatalogProvider ? formatDeveloperLabel(selectedCatalogProvider) : '') ||
                          (catalogLoading
                            ? 'Loading...'
                            : catalogProviderOptions.length
                              ? 'Choose developer'
                              : 'No developers available')}
                      {/if}
                    </span>
                  </span>
                </span>
              </Select.Trigger>
              {#if catalogProviderOptions.length}
                <Select.Content>
                  {#each catalogProviderOptions as option}
                    <Select.Item value={option.value}>
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center gap-2 truncate">
                          <ModelProviderIcon
                            modelId={`${option.value}/preview`}
                            modelName={option.label}
                            provider={option.value}
                            size="sm"
                            showOverlay={false}
                            badgeProvider={catalogFallbackProvider ?? undefined}
                          />
                          <span class="truncate">{option.label}</span>
                        </div>
                      </div>
                    </Select.Item>
                  {/each}
                </Select.Content>
              {/if}
            </Select.Root>
          </div>
          <div class="space-y-1.5">
            <Label.Root class="batshit-settings-form-label">Model</Label.Root>
            <Select.Root
              type="single"
              value={selectedCatalogModelId || undefined}
              onValueChange={handleCatalogModelSelect}
              disabled={
                catalogLoading || manualEntryConnectionActive || !filteredCatalogEntries.length
              }
            >
              <Select.Trigger class="w-full">
                <span class="flex items-center justify-between gap-2 truncate text-left">
                  <span class="flex items-center gap-2 truncate">
                    {#if selectedCatalogEntry && !manualEntryConnectionActive}
                      <ModelProviderIcon
                        modelId={selectedCatalogEntry.effectiveModelId}
                        modelName={selectedCatalogEntry.displayName}
                        provider={selectedCatalogEntry.developerId}
                        size="sm"
                        showOverlay={false}
                        badgeProvider={catalogFallbackProvider ?? undefined}
                      />
                    {/if}
                    <span class="truncate">
                      {#if manualEntryConnectionActive}
                        Enter manually
                      {:else}
                        {selectedCatalogEntry?.displayName ||
                          (catalogLoading
                            ? 'Loading...'
                            : filteredCatalogEntries.length
                              ? 'Choose model'
                              : 'No models available')}
                      {/if}
                    </span>
                  </span>
                </span>
              </Select.Trigger>
              {#if filteredCatalogEntries.length}
                <Select.Content>
                  {#each filteredCatalogEntries as entry}
                    <Select.Item value={entry.catalogId}>
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center gap-2 truncate">
                          <ModelProviderIcon
                            modelId={entry.effectiveModelId}
                            modelName={entry.displayName}
                            provider={entry.developerId}
                            size="sm"
                            showOverlay={false}
                            badgeProvider={catalogFallbackProvider ?? undefined}
                          />
                          <div class="flex flex-col truncate">
                            <span class="truncate">{entry.displayName}</span>
                            <span class="batshit-settings-model-select-id truncate">
                              {entry.effectiveModelId}
                            </span>
                          </div>
                        </div>
                      </div>
                    </Select.Item>
                  {/each}
                </Select.Content>
              {/if}
            </Select.Root>
          </div>
        </div>
        {#if selectedConnection?.status === 'locked' && selectedConnection.service && LOCAL_PROVIDER_LABELS.has(selectedConnection.service)}
          <div class="batshit-settings-inline-alert is-warning" role="status">
            {selectedConnection.label} is disabled. Enable it in Settings → Local AI to discover its models.
          </div>
        {/if}
        {#if manualEntryConnectionActive}
          <div class="batshit-settings-note is-dashed">
            <p>No catalog available yet. Choose a connection, then copy its provider defaults into the preset and enter the developer and model ID manually below.</p>
            <p class="mt-2">
              Tip: When a manual connection expects a namespaced identifier, use
              <code>developer/model</code> exactly as the provider documents it. Custom providers can either use the toggle below
              or put the full identifier directly in the Model ID field.
            </p>
          </div>
        {:else if connectionNeedsManualModel}
          <div class="batshit-settings-note is-dashed">
            HuggingFace connections don’t expose a model catalog. Copy the provider defaults into the preset, then enter the exact repository/model ID manually below (for example: <code>mistralai/Mixtral-8x7B-Instruct-v0.1</code>).
          </div>
        {/if}
        {#if selectedCatalogModel}
          {@const selectedCatalogIds = resolveCatalogIds({
            connectionId: selectedConnection?.id ?? null,
            connection: selectedConnection,
            developerId: selectedCatalogEntry?.developerId ?? selectedCatalogModel.provider,
            modelId: selectedCatalogEntry?.modelId ?? selectedCatalogModel.name,
            idVariants: selectedCatalogModel.idVariants ?? null
          })}
          {@const selectedCatalogCapabilities = catalogFeaturesToCapabilities(
            selectedCatalogModel.features ?? null
          )}
          <Collapsible.Root bind:open={catalogDetailsOpen}>
            <div class="batshit-settings-disclosure-row is-catalog-details">
              <Collapsible.Trigger class="batshit-settings-disclosure-trigger batshit-settings-catalog-details-trigger">
                <div class="batshit-settings-catalog-details-copy">
                  <div class="batshit-settings-form-label-line">
                    <ModelProviderIcon
                      modelId={selectedCatalogEntry?.effectiveModelId ?? selectedCatalogModel.id}
                      modelName={selectedCatalogModel.displayName}
                      provider={selectedCatalogEntry?.developerId ?? selectedCatalogModel.provider}
                      size="sm"
                      showOverlay={false}
                      badgeProvider={catalogFallbackProvider ?? undefined}
                    />
                    <span class="batshit-settings-catalog-details-title truncate">{selectedCatalogModel.displayName}</span>
                    <span class="batshit-settings-catalog-details-separator">|</span>
                    <span class="batshit-settings-form-label">View Details</span>
                  </div>
                </div>
                <ChevronDown class={`h-4 w-4 shrink-0 transition-transform ${catalogDetailsOpen ? 'rotate-180' : ''}`} />
              </Collapsible.Trigger>
              <Collapsible.Content class="batshit-settings-disclosure-content">
                <div class="space-y-2 text-[11px] text-muted-foreground">
                  <div class="space-y-1">
                    <p>
                      <span class="batshit-settings-inline-strong">Canonical ID:</span>
                      <span class="batshit-model-id ml-1">{selectedCatalogModel.canonicalId || selectedCatalogModel.id}</span>
                    </p>
                    {#if selectedCatalogIds}
                      <p>
                        <span class="batshit-settings-inline-strong">Selected effective ID:</span>
                        <span class="batshit-model-id ml-1">{selectedCatalogIds.effectiveModelId}</span>
                      </p>
                    {/if}
                  </div>
                  {#if selectedConnectionIsFlatFeePlan}
                    <p class="flex flex-wrap gap-3">
                      <span>Token plan</span>
                    </p>
                  {:else if selectedCatalogPricing}
                    <p class="flex flex-wrap gap-3">
                      {#if selectedCatalogPricing.input !== undefined}
                        <span>Input ${formatPrice(selectedCatalogPricing.input)}/M</span>
                      {/if}
                      {#if selectedCatalogPricing.output !== undefined}
                        <span>Output ${formatPrice(selectedCatalogPricing.output)}/M</span>
                      {/if}
                      {#if selectedCatalogPricing.cachedInput !== undefined}
                        <span>Cached ${formatPrice(selectedCatalogPricing.cachedInput)}/M</span>
                      {/if}
                    </p>
                  {/if}
                  {#if selectedCatalogContextWindow}
                    <p>
                      Context: {selectedCatalogContextWindow.toLocaleString()} tokens
                    </p>
                  {/if}
                  {#if selectedCatalogModel.publishedMetadata}
                    <p>
                      Published model context: {selectedCatalogModel.publishedMetadata.contextWindow.toLocaleString()} tokens.
                      Published max output: {selectedCatalogModel.publishedMetadata.maxOutputTokens.toLocaleString()} tokens.
                    </p>
                    <p>
                      ChatGPT account context and output limits are unknown. Published limits do not set this preset's budget.
                      <a href={selectedCatalogModel.publishedMetadata.sourceUrl} target="_blank" rel="noopener noreferrer">OpenAI model documentation</a>
                      (verified {selectedCatalogModel.publishedMetadata.verifiedAt}).
                    </p>
                  {/if}
                  {#if selectedConnection}
                    <div class="flex flex-wrap items-center gap-2">
                      <span>Selected connection: <span class="batshit-model-id">{selectedConnection.id}</span></span>
                      {#if !n8nOnlyConnections.has(selectedConnection.id)}
                        <Badge
                          variant={selectedConnection.status === 'ready' ? 'secondary' : 'outline'}
                          class="flex items-center gap-1 text-[10px]"
                        >
                          {#if selectedConnection.status === 'ready'}
                            <CheckCircle2 class="h-3 w-3" />
                          {/if}
                          <span>Batshit · {selectedConnection.status === 'ready' ? 'ready' : 'compatible'}</span>
                        </Badge>
                      {/if}
                      {#if showsN8nBadge(selectedConnection)}
                        <Badge variant="outline" class="batshit-settings-child-label">
                          n8n · compatible
                        </Badge>
                      {/if}
                    </div>
                  {/if}
                  {#if getModelConnections(selectedCatalogModel).length}
                    <p class="flex flex-wrap items-center gap-2">
                      <span>Available via:</span>
                      {#each getModelConnections(selectedCatalogModel) as connectionId (connectionId)}
                        <Badge variant="outline" class="batshit-settings-child-label">
                          {formatConnectionLabel(connectionId)}
                        </Badge>
                      {/each}
                    </p>
                  {/if}
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="batshit-settings-inline-strong">Capabilities:</span>
                    {#if selectedCatalogCapabilities}
                      {#each CAPABILITY_LABELS as capability (capability.key)}
                        {#if selectedCatalogCapabilities[capability.key]}
                          <Badge variant="outline" class="batshit-settings-child-label">
                            {capability.label}
                          </Badge>
                        {/if}
                      {/each}
                    {:else}
                      <span>Not reported</span>
                    {/if}
                  </div>
                  {#if selectedCatalogModel.idVariants && Object.keys(selectedCatalogModel.idVariants).length > 1}
                    <div class="space-y-1">
                      <p class="batshit-settings-inline-strong">Known ID variants:</p>
                      {#each Object.entries(selectedCatalogModel.idVariants) as [connectionId, variant] (connectionId)}
                        <div class="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" class="batshit-settings-child-label">
                            {formatConnectionLabel(connectionId)}
                          </Badge>
                          <span class="batshit-model-id break-all">{variant.effectiveId}</span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                  {#if selectedCatalogModel.description}
                    <p>
                      {selectedCatalogModel.description}
                    </p>
                  {/if}
                </div>
              </Collapsible.Content>
            </div>
          </Collapsible.Root>
        {/if}
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="default"
              onclick={handleCopyIntoNewPreset}
              disabled={((!manualEntryConnectionActive && !connectionNeedsManualModel && !selectedCatalogModel) || catalogLoading || isEnriching)}

            >
              {#if isEnriching}
                <Loader2 class="animate-spin" />
              {:else}
                <Sparkles  />
              {/if}
              {getNewPresetActionLabel()}
            </Button>
            {#if selectedModelId && !manualEntryConnectionActive && !connectionNeedsManualModel}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onclick={handleOverwriteSelectedPreset}
                disabled={!selectedCatalogModel || catalogLoading || isEnriching}
              >
                <Check aria-hidden="true" />
                Overwrite Selected Preset
              </Button>
            {/if}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onclick={() => (catalogViewerOpen = !catalogViewerOpen)}
            class="batshit-settings-form-label"
          >
            <BatshitIcon id="model-catalog" class="h-4 w-4" />
            {catalogViewerOpen ? 'Hide Catalog Viewer' : 'Show Catalog Viewer'}
          </Button>
        </div>
        <ModelCatalogViewerDialog
          bind:open={catalogViewerOpen}
          {catalogLoading}
          bind:catalogViewerConnection
          bind:catalogViewerProvider
          bind:catalogViewerRole
          bind:catalogViewerSearch
          bind:catalogViewerLimit
          {catalogViewerConnectionOptions}
          {catalogViewerProviderOptions}
          {catalogViewerRows}
          {catalogViewerFilteredCount}
          {catalogViewerFallbackProvider}
          {connectionOptions}
          capabilities={CAPABILITY_LABELS}
          {formatDeveloperLabel}
          {getConnectionIconMeta}
          {getModelConnections}
          {formatConnectionLabel}
          {formatPrice}
          {catalogFeaturesToCapabilities}
        />
        {#if catalogError}
          <p class="batshit-settings-form-help is-danger">{catalogError}</p>
        {/if}
      </Card.Content>
    </Card.Root>

    <div class="grid gap-4 lg:grid-cols-[260px_1fr]">
      <SavedModelsSidebar
        {isLoading}
        {listError}
        {models}
        {chatModels}
        {visualModels}
        {audioModels}
        {utilityModels}
        {selectedModelId}
        {creatingNew}
        {getBadgeProviderForModel}
        onSelectModel={selectModel}
        bind:chatSectionOpen
        bind:visualSectionOpen
        bind:audioSectionOpen
        bind:utilitySectionOpen
      />

  <div class="space-y-4">
	      {#if enrichmentWarning}
	        <div class="batshit-settings-inline-alert is-warning flex items-center gap-2">
	          <AlertCircle class="h-4 w-4" />
	          <span>{enrichmentWarning}</span>
	        </div>
	      {/if}
        {#if showCatalogFirstEmptyState}
          <Card.Root class="batshit-settings-card batshit-settings-card-default">
            <Card.Header>
              <div class="flex items-center gap-1">
                <Card.Title class="flex items-center gap-2">
                  <BatshitIcon id="model-catalog" class="h-4 w-4" />
                  Start With the Model Catalog
                </Card.Title>
                <SettingsInfoMenu ariaLabel="About Starting a Model Preset">
                  <p>
                    Choose a provider, developer, and model above, then click <span class="batshit-settings-inline-strong">Use to Create New Preset</span>.
                  </p>
                  <p class="mt-2">
                    Batshit creates the preset immediately from the catalog data, and after that all further edits autosave normally.
                  </p>
                </SettingsInfoMenu>
              </div>
            </Card.Header>
            <Card.Content class="batshit-settings-card-caption batshit-settings-card-content-spacious">
              {#if manualEntryConnectionActive || connectionNeedsManualModel}
                This connection needs manual model details. Click <span class="batshit-settings-inline-strong">Start Manual Preset</span>, then enter the display name, developer ID, and model ID to create it.
              {:else}
                Pick a catalog entry above to create your first saved model preset.
              {/if}
            </Card.Content>
          </Card.Root>
        {:else}
		      <SettingsAccordionCard
            name="model-settings-cards"
            title={creatingNew ? 'Create Model Preset' : selectedModelId ? 'Edit Model Preset' : 'Model Settings'}
            batshitIcon="models"
            contentClass="space-y-6"
            open
          >
            {#snippet info()}
                {#if hasCatalogBaselineInfoModifications()}
                  <SettingsInfoMenu
                    tone="amber"
                    ariaLabel="About modified catalog fields"
                  >
                    <p>
                      <span class="batshit-settings-inline-strong">Modified</span> marks fields you changed after the
                      last catalog apply.
                    </p>
                    <p class="mt-2">
                      <span class="batshit-settings-inline-strong">Overwrite Selected Preset</span> will reset those
                      top-card fields back to the catalog baseline.
                    </p>
                  </SettingsInfoMenu>
                {/if}
	            <SettingsInfoMenu ariaLabel="About Model Presets">
	              <p>
	                Model presets give your favorite models friendly names plus saved defaults for
	                pricing, compatibility, and parameter behavior.
	              </p>
	            </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
	            {#if (!creatingNew && selectedModelId) || saveError}
              <SettingsSaveStatus
	                state={saveError ? 'error' : saveState}
	                error={saveError}
	                savedLabel="Model Saved"
	                sticky={false}
              />
              {#if saveError}
                <Button variant="outline" size="sm" disabled={numericDraftActive || saveState === 'saving'} onclick={() => {
                  lastInvalidModelSignature = null
                  lastDraftCreateAttemptSignature = null
                  saveError = null
                }}>Retry Save</Button>
              {/if}
	            {/if}
            {/snippet}
		          <div class="batshit-settings-form-stack">
		            <div class="batshit-settings-form-row">
		              <div class="batshit-settings-form-copy">
		                <div class="batshit-settings-form-label-line">
		                  <Label.Root class="batshit-settings-form-label">Display Name</Label.Root>
	                  {#if isCatalogBaselineFieldModified('modelName')}
	                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
	                  {/if}
		                  <SettingsInfoMenu ariaLabel="About Display Name">
		                    <p>What you want to call this model inside batshit.</p>
		                  </SettingsInfoMenu>
		                </div>
		              </div>
		              <div class="batshit-settings-form-control">
		                <Input
		                  value={editingForm.modelName}
		                  placeholder="Claude 3 Sonnet"
		                  oninput={(event) => updateField('modelName', (event.target as HTMLInputElement).value)}
		                />
		              </div>
		            </div>

		            <div class="batshit-settings-form-row">
		              <div class="batshit-settings-form-copy">
		                <div class="batshit-settings-form-label-line">
		                  <Label.Root class="batshit-settings-form-label">Provider ID</Label.Root>
		                  {#if isCatalogBaselineFieldModified('connectionId')}
		                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
		                  {/if}
		                  <SettingsInfoMenu ariaLabel="About Provider ID">
		                    <p>
		                      This is the active connection/provider Batshit will route through for this
		                      preset. It is copied from the catalog selection.
		                    </p>
		                  </SettingsInfoMenu>
		                </div>
		              </div>
		              <div class="batshit-settings-form-control">
		                <div class="batshit-settings-form-control-group">
		                  <Input
		                    value={getAppliedProviderId(editingForm)}
		                    placeholder="Apply selection from the catalog"
		                    readonly
		                    class="batshit-settings-selector-trigger is-disabled"
		                  />
		                  {#if appliedConnection}
		                    <div class="batshit-settings-form-meta">
		                      {#if !n8nOnlyConnections.has(appliedConnection.id)}
		                        <Badge
		                          variant={appliedConnection.status === 'ready' ? 'secondary' : 'outline'}
		                          class="batshit-settings-child-label flex items-center gap-1"
		                        >
		                          {#if appliedConnection.status === 'ready'}
		                            <CheckCircle2 class="h-3 w-3" />
		                          {/if}
		                          <span>Batshit · {appliedConnection.status === 'ready' ? 'ready' : 'compatible'}</span>
		                        </Badge>
		                      {/if}
		                      {#if showsN8nBadge(appliedConnection)}
		                        <Badge variant="outline" class="batshit-settings-child-label">
		                          n8n · compatible
		                        </Badge>
		                      {/if}
		                    </div>
		                  {:else if editingForm.connectionId}
		                    <p class="batshit-settings-form-meta">
		                      {getAppliedProviderId(editingForm)} isn’t available yet. Configure it in Settings → API Keys.
		                    </p>
		                  {/if}
		                </div>
		              </div>
		            </div>

		            <div class="batshit-settings-form-row">
		              <div class="batshit-settings-form-copy">
		                <div class="batshit-settings-form-label-line">
		                  <Label.Root class="batshit-settings-form-label">Developer ID</Label.Root>
	                  {#if isCatalogBaselineFieldModified('provider')}
	                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
	                  {/if}
		                  <SettingsInfoMenu ariaLabel="About Developer ID">
		                    <p>
		                      Use developer IDs like <code>anthropic</code>, <code>openai</code>, or
		                      <code>mistral</code>. Batshit uses this together with the model ID to route the
		                      preset correctly.
		                    </p>
		                  </SettingsInfoMenu>
		                </div>
		              </div>
		              <div class="batshit-settings-form-control">
		                <div class="batshit-settings-form-control-group">
		                  <Input
		                    value={editingForm.provider}
		                    placeholder="anthropic"
		                    oninput={(event) => updateField('provider', (event.target as HTMLInputElement).value)}
		                  />
		                  {#if editingForm.isVercelImport || (editingForm.compatibility?.note && !HIDDEN_INLINE_COMPATIBILITY_NOTES.has(editingForm.compatibility.note))}
		                    <div class="batshit-settings-form-meta">
		                      {#if editingForm.isVercelImport}
		                        <Badge variant="outline">Vercel import</Badge>
		                      {/if}
		                      {#if editingForm.compatibility?.note && !HIDDEN_INLINE_COMPATIBILITY_NOTES.has(editingForm.compatibility.note)}
		                        <span>{editingForm.compatibility.note}</span>
		                      {/if}
		                    </div>
		                  {/if}
		                </div>
		              </div>
		            </div>

		            <div class="batshit-settings-form-row">
		              <div class="batshit-settings-form-copy">
		                <div class="batshit-settings-form-label-line">
		                  <Label.Root class="batshit-settings-form-label">Model ID</Label.Root>
		                  {#if isCatalogBaselineFieldModified('modelId')}
		                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
		                  {/if}
		                  <SettingsInfoMenu ariaLabel="About Model ID">
		                    <p>
		                      Exact model identifier Batshit sends to the provider, such as
		                      <code>gpt-5.4</code> or <code>claude-sonnet-4.6</code>.
		                    </p>
		                  </SettingsInfoMenu>
		                </div>
		              </div>
		              <div class="batshit-settings-form-control">
		                <Input
		                  value={editingForm.modelId}
		                  placeholder="claude-3-sonnet-20240229"
		                  class="batshit-model-id"
		                  oninput={(event) => updateField('modelId', (event.target as HTMLInputElement).value)}
		                />
		                {#if localServedModelNote}
		                  <p class={`batshit-settings-form-meta ${localServedModelNote.tone}`}>
		                    {localServedModelNote.text}
		                  </p>
		                {/if}
		              </div>
		            </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Root class="batshit-settings-form-label">Preset Category</Label.Root>
                      <SettingsInfoMenu ariaLabel="About Preset Category">
                        <p>
                          Automatic uses the Model Catalog classification. Choose a category manually
                          when a provider reports the model incorrectly. Chat presets are available to
                          API agents; Utility is intended for embeddings, reranking, and similar tasks.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={editingForm.purposeOverride ?? 'auto'}
                      onValueChange={(value) => {
                        const nextValue = Array.isArray(value) ? value[0] : value
                        if (!nextValue) return
                        if (nextValue === 'auto') {
                          editingForm = { ...editingForm, purposeOverride: null }
                          return
                        }
                        const purpose = nextValue as ModelPurpose
                        editingForm = {
                          ...editingForm,
                          purpose,
                          purposeOverride: purpose
                        }
                      }}
                    >
                      <Select.Trigger>
                        <span>
                          {#if editingForm.purposeOverride}
                            {MODEL_PURPOSE_OPTIONS.find((option) => option.value === editingForm.purpose)?.label ?? 'Chat (Agents)'}
                          {:else}
                            Automatic ({MODEL_PURPOSE_OPTIONS.find((option) => option.value === editingForm.purpose)?.label ?? 'Chat (Agents)'})
                          {/if}
                        </span>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="auto">
                          <div class="flex flex-col">
                            <span>Automatic</span>
                            <span class="batshit-settings-form-label">Use the Model Catalog category</span>
                          </div>
                        </Select.Item>
                        {#each MODEL_PURPOSE_OPTIONS as option (option.value)}
                          <Select.Item value={option.value}>
                            <div class="flex flex-col">
                              <span>{option.label}</span>
                              <span class="batshit-settings-form-label">{option.helper}</span>
                            </div>
                          </Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>

                {#if activeVoiceSessionConfig}
                  <div class="batshit-settings-form-row is-tall">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Speech-to-Speech Voice</Label.Root>
                        <Badge variant="outline" class="batshit-settings-pill is-info">
                          {activeVoiceSessionConfig.providerLabel ?? 'LiveKit'}
                        </Badge>
                        <SettingsInfoMenu ariaLabel="About Speech-to-Speech Voice">
                          <p>
                            This voice is sent to the LiveKit speech-to-speech adapter for this
                            model preset. It is separate from normal TTS engine voices.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <div class="batshit-settings-form-control-group">
                        <Input
                          value={activeVoiceSessionConfig.defaultVoiceId ?? ''}
                          placeholder="Use provider default"
                          list="speech-to-speech-voice-options"
                          oninput={(event) =>
                            updateSpeechToSpeechVoice((event.target as HTMLInputElement).value)
                          }
                        />
                        {#if activeVoiceSessionVoiceOptions.length}
                          <datalist id="speech-to-speech-voice-options">
                            {#each activeVoiceSessionVoiceOptions as option (option.value)}
                              <option value={option.value}>{option.label}</option>
                            {/each}
                          </datalist>
                        {/if}
                        <div class="batshit-settings-form-meta">
                          <Badge variant="outline">LiveKit</Badge>
                          <Badge variant="outline">{activeVoiceSessionConfig.mode}</Badge>
                          {#if activeVoiceSessionConfig.defaultModelId}
                            <span>{activeVoiceSessionConfig.defaultModelId}</span>
                          {/if}
                        </div>
                      </div>
                    </div>
                  </div>
                {/if}

		            {#if effectiveFormCapabilities}
		              <div class="batshit-settings-form-row is-tall">
		                <div class="batshit-settings-form-copy">
		                  <div class="batshit-settings-form-label-line">
		                    <Label.Root class="batshit-settings-form-label">Supported Features</Label.Root>
		                    <SettingsInfoMenu ariaLabel="About Supported Features">
		                      <p>
		                        Capability badges show what this preset advertises for routing, prompts,
		                        tool calling, vision, context, and related model behavior.
		                      </p>
		                    </SettingsInfoMenu>
		                  </div>
		                </div>
		                <div class="batshit-settings-form-control">
		                  <div class="batshit-settings-form-meta">
		                    {#each CAPABILITY_LABELS as capability}
		                      {#if effectiveFormCapabilities[capability.key]}
		                        <Badge variant="outline">{capability.label}</Badge>
		                      {/if}
		                    {/each}
                        {#if isChatgptPlanConnection(editingForm.connectionId) && editingForm.capabilities?.vision === false}
                          <p>Image input is disabled for this preset. Overwrite Selected Preset reapplies the catalog's supported features.</p>
                        {/if}
		                  </div>
		                </div>
		              </div>
		            {/if}

		            {#if isCustomConnection}
		              <div class="batshit-settings-form-row">
		                <div class="batshit-settings-form-copy">
		                  <div class="batshit-settings-form-label-line">
		                    <p class="batshit-settings-form-label">Custom Model ID Format</p>
		                    <SettingsInfoMenu ariaLabel="About Custom Model ID Format">
		                      <p>
		                        When enabled, Batshit sends <code>developer/model</code> to this provider
		                        instead of just the bare model ID.
		                      </p>
		                    </SettingsInfoMenu>
		                  </div>
		                </div>
		                <div class="batshit-settings-form-control">
		                  <div class="batshit-settings-form-inline-actions">
		                    <span class="batshit-settings-form-meta">{editingForm.connectionUseDeveloperPrefix ? 'Enabled' : 'Disabled'}</span>
		                    <Switch.Root
		                      checked={editingForm.connectionUseDeveloperPrefix}
		                      onCheckedChange={(checked: boolean) => {
		                        editingForm = { ...editingForm, connectionUseDeveloperPrefix: checked }
		                      }}
		                    />
		                  </div>
		                </div>
		              </div>
		            {/if}

		            {#if isChatgptPlanConnection(editingForm.connectionId)}
                <p class="batshit-settings-note">ChatGPT plan inference has no API token price. Manage plan usage in ChatGPT; quota percentages and resets are not reported here.</p>
              {:else}
		            <div class="batshit-settings-form-row is-tall">
		              <div class="batshit-settings-form-copy">
		                <div class="batshit-settings-form-label-line">
		                  <Label.Root class="batshit-settings-form-label">Input Cost ($ / 1M Tokens)</Label.Root>
                    {#if isCatalogBaselineFieldModified('pricingInput')}
                      <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
                    {/if}
		                  <SettingsInfoMenu ariaLabel="About Input Pricing">
		                    <p>
		                      Track how pricing scales as usage grows. Use a single price when billing is flat
		                      or tiered pricing when the provider changes cost at different usage bands.
		                    </p>
		                  </SettingsInfoMenu>
		                </div>
		              </div>
		              <div class="batshit-settings-form-control">
		                <div class="batshit-settings-form-control-group">
		                  <div class="batshit-settings-pricing-mode-group">
			                    {#if editingForm.enrichment && detectEnrichmentOverrides()}
			                      <Button type="button" size="sm" variant="ghost" onclick={restoreDefaultsFromEnrichment}>
			                        <RotateCcw aria-hidden="true" />
			                        Restore Defaults
			                      </Button>
			                    {/if}
		                    <Button
		                      type="button"
		                      size="sm"
		                      variant={editingForm.pricingInputMode === 'flat' ? 'secondary' : 'outline'}

			                      onclick={() => setPricingInputMode('flat')}
			                    >
			                      <CheckCircle2 aria-hidden="true" />
			                      Single Price
			                    </Button>
		                    <Button
		                      type="button"
		                      size="sm"
		                      variant={editingForm.pricingInputMode === 'tiered' ? 'secondary' : 'outline'}

			                      onclick={() => setPricingInputMode('tiered')}
			                    >
			                      <Plus aria-hidden="true" />
			                      Tiered
			                    </Button>
		                  </div>
		                  {#if editingForm.pricingInputMode === 'flat'}
		                    <Input
		                      type="text"
	                      inputmode="decimal"
		                      value={editingForm.pricingInput}
		                      placeholder="$3.000"
		                      oninput={(event) => updateField('pricingInput', (event.target as HTMLInputElement).value)}
	                      onblur={() => formatField('pricingInput', formatCurrencyDisplay)}
		                    />
		                  {:else}
		                    <div class="batshit-settings-pricing-tier-list">
		                      {#each editingForm.pricingInputTiers as tier (tier.key)}
		                        <div class="batshit-settings-pricing-tier-row">
		                          <div class="batshit-settings-pricing-tier-grid">
		                            <label class="batshit-settings-pricing-tier-field">
		                              <span class="batshit-settings-form-label">From (M Tokens)</span>
		                              <Input
		                                type="text"
	                                inputmode="decimal"
		                                value={tier.from}
		                                placeholder="0"
		                                oninput={(event) =>
		                                  updatePricingTier(tier.key, 'from', (event.target as HTMLInputElement).value)
		                                }
	                                onblur={() => formatPricingTierField(tier.key, 'from')}
		                              />
		                            </label>
		                            <label class="batshit-settings-pricing-tier-field">
		                              <span class="batshit-settings-form-label">To (M Tokens)</span>
		                              <Input
		                                type="text"
	                                inputmode="decimal"
		                                value={tier.to}
		                                placeholder="1"
		                                oninput={(event) =>
		                                  updatePricingTier(tier.key, 'to', (event.target as HTMLInputElement).value)
		                                }
	                                onblur={() => formatPricingTierField(tier.key, 'to')}
		                              />
		                            </label>
		                            <label class="batshit-settings-pricing-tier-field">
		                              <span class="batshit-settings-form-label">Cost ($ / 1M)</span>
		                              <Input
		                                type="text"
	                                inputmode="decimal"
		                                value={tier.cost}
		                                placeholder="$3.000"
		                                oninput={(event) =>
		                                  updatePricingTier(tier.key, 'cost', (event.target as HTMLInputElement).value)
		                                }
	                                onblur={() => formatPricingTierField(tier.key, 'cost')}
		                              />
		                            </label>
		                          </div>
		                          <div class="batshit-settings-pricing-tier-actions">
		                            <Button variant="ghost" size="sm" onclick={() => removePricingTier(tier.key)}>
		                              <Trash2  />
		                              Remove Tier
		                            </Button>
		                          </div>
		                        </div>
		                      {/each}
		                      <Button type="button" variant="outline" size="sm" onclick={addPricingTier}>
		                        <Plus  />
		                        Add Tier
		                      </Button>
		                    </div>
		                  {/if}
		                </div>
		              </div>
		            </div>
	            <div class="batshit-settings-form-row">
	              <div class="batshit-settings-form-copy">
	                <div class="batshit-settings-form-label-line">
	                  <Label.Root class="batshit-settings-form-label">Output Cost ($ / 1M Tokens)</Label.Root>
	                  {#if isCatalogBaselineFieldModified('pricingOutput')}
	                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
	                  {/if}
	                  <SettingsInfoMenu ariaLabel="About Output Pricing">
	                    <p>Estimated price for generated output tokens, measured per 1 million tokens.</p>
	                  </SettingsInfoMenu>
	                </div>
	              </div>
	              <div class="batshit-settings-form-control">
	                <Input
	                  type="text"
                    inputmode="decimal"
	                  value={editingForm.pricingOutput}
	                  placeholder="$15.000"
	                  oninput={(event) => updateField('pricingOutput', (event.target as HTMLInputElement).value)}
                    onblur={() => formatField('pricingOutput', formatCurrencyDisplay)}
	                />
	              </div>
	            </div>

	            <div class="batshit-settings-form-row">
	              <div class="batshit-settings-form-copy">
	                <div class="batshit-settings-form-label-line">
	                  <Label.Root class="batshit-settings-form-label">Cached Input ($ / 1M Tokens)</Label.Root>
	                  {#if isCatalogBaselineFieldModified('pricingCachedInput')}
	                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
	                  {/if}
	                  <SettingsInfoMenu ariaLabel="About Cached Input Pricing">
	                    <p>
	                      Optional cached-input price for providers that bill cache reads separately.
	                    </p>
	                  </SettingsInfoMenu>
	                </div>
	              </div>
	              <div class="batshit-settings-form-control">
	                <Input
	                  type="text"
                    inputmode="decimal"
	                  value={editingForm.pricingCachedInput}
	                  placeholder="$0.300"
	                  oninput={(event) =>
	                    updateField('pricingCachedInput', (event.target as HTMLInputElement).value)
	                  }
                    onblur={() => formatField('pricingCachedInput', formatCurrencyDisplay)}
	                />
	              </div>
	            </div>
	            {/if}

	            <div class="batshit-settings-form-row">
	              <div class="batshit-settings-form-copy">
	                <div class="batshit-settings-form-label-line">
	                  <Label.Root class="batshit-settings-form-label">Context Window</Label.Root>
                  {#if isCatalogBaselineFieldModified('contextWindow')}
                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
                  {/if}
	                  <SettingsInfoMenu ariaLabel="About Context Window">
	                    <p>Total tokens supported by this model. Leave blank when you want Batshit to treat it as unknown.</p>
                      {#if isChatgptPlanConnection(editingForm.connectionId)}
                        <p>The published model ceiling does not establish this ChatGPT account's effective context budget. Leave blank unless you have verified that budget.</p>
                      {/if}
	                  </SettingsInfoMenu>
	                </div>
	              </div>
	              <div class="batshit-settings-form-control">
	                <Input
	                  type="text"
                    inputmode="numeric"
	                  value={editingForm.contextWindow}
	                  placeholder={isChatgptPlanConnection(editingForm.connectionId) ? 'Unknown' : '200,000'}
                    onfocus={beginNumericDraft}
                    onkeydown={commitNumericDraftOnEnter}
	                  oninput={(event) => {
                      beginNumericDraft()
                      updateField('contextWindow', (event.target as HTMLInputElement).value)
                    }}
                    onblur={finishNumericDraft}
	                />
	                {#if localContextStatus}
	                  <p class={`batshit-settings-form-meta ${localContextStatus.tone}`}>
	                    {localContextStatus.text}
	                  </p>
	                  {#if localContextStatus.ttl}
	                    <p class="batshit-settings-form-meta">{localContextStatus.ttl}</p>
	                  {/if}
	                {/if}
	                {#if localProviderId === 'ollama'}
	                  <p class="batshit-settings-form-meta">
	                    Batshit can set Ollama's context size directly now. Use the Context size
	                    field below. Leave it blank to keep whatever Ollama already loaded.
	                    Changing it makes Ollama reload the model, which takes a moment and clears
	                    its prompt cache, so set it once rather than per chat.
	                  </p>
	                {/if}
	              </div>
	            </div>

	            {#if localModelFormat}
	              <div class="batshit-settings-form-row">
	                <div class="batshit-settings-form-copy">
	                  <div class="batshit-settings-form-label-line">
	                    <Label.Root class="batshit-settings-form-label">Model Format</Label.Root>
	                    <SettingsInfoMenu ariaLabel="About Model Format">
	                      <p>
	                        The file format this model is in, exactly as {localProgramLabel ?? 'the program'}
	                        reports it. On an Apple Silicon Mac an MLX build of a model usually runs
	                        faster than the same model in GGUF.
	                      </p>
	                      <p class="mt-2">
	                        Batshit shows whatever it is told here, so a format other than MLX or GGUF
	                        appears under its own name.
	                      </p>
	                    </SettingsInfoMenu>
	                  </div>
	                </div>
	                <div class="batshit-settings-form-control is-inline-status">
	                  <Badge variant="outline" class="batshit-settings-child-label">{localModelFormat}</Badge>
	                </div>
	              </div>
	            {/if}

	            <div class="batshit-settings-form-row">
	              <div class="batshit-settings-form-copy">
	                <div class="batshit-settings-form-label-line">
	                  <Label.Root class="batshit-settings-form-label">Max Output Tokens</Label.Root>
                  {#if isCatalogBaselineFieldModified('maxOutputTokens')}
                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
                  {/if}
                  {#if editingForm.enrichment?.maxOutputTokensEstimated}
                    <Badge variant="outline" class={ESTIMATED_BADGE_CLASS}>Estimated</Badge>
                  {/if}
	                  <SettingsInfoMenu ariaLabel="About Max Output Tokens">
	                    <p>Limits how many tokens the model can emit per response when the provider supports that control.</p>
                    {#if editingForm.enrichment?.maxOutputTokensEstimated}
                      <p class="mt-2">
                        Batshit filled this with a safe default because the catalog
                        {editingForm.enrichment.maxOutputTokensEstimateReason === 'unsafe'
                          ? 'reported an unsafe context-sized value'
                          : 'did not provide a trusted output limit'}.
                      </p>
                    {/if}
	                  </SettingsInfoMenu>
	                </div>
	              </div>
	              <div class="batshit-settings-form-control">
	                <Input
	                  type="text"
                    inputmode="numeric"
	                  value={isChatgptPlanConnection(editingForm.connectionId) ? '' : getParameterValue('maxTokens')}
                    disabled={isChatgptPlanConnection(editingForm.connectionId)}
	                  placeholder={isChatgptPlanConnection(editingForm.connectionId) ? 'Managed by ChatGPT' : '4,000'}
                    onfocus={beginNumericDraft}
                    onkeydown={commitNumericDraftOnEnter}
	                  oninput={(event) => {
                      beginNumericDraft()
                      updateParameterValue('maxTokens', (event.target as HTMLInputElement).value)
                    }}
                    onblur={finishNumericDraft}
	                />
	              </div>
	            </div>
	          </div>
	      </SettingsAccordionCard>

	      <SettingsAccordionCard
          name="model-settings-cards"
          title="Settings and Parameters"
          batshitIcon="parameters"
          contentClass="space-y-6"
        >
          {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Settings and Parameters">
                <p>
                  The Model Catalog apply buttons only reset the top
                  <span class="batshit-settings-inline-strong">Edit Model Preset</span> fields.
                </p>
                <p class="mt-2">
                  The deeper settings and parameter controls in this section stay exactly as you
                  set them unless you change them here yourself.
                </p>
              </SettingsInfoMenu>
              {#if showN8nParameterSupport}
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <button
                      type="button"
                      class="batshit-settings-model-support-legend-trigger"
                      aria-label="About API and n8n parameter support markers"
                    >
                      <CheckCircle2 class="h-3.5 w-3.5 text-[var(--batshit-primary)]" />
                      <CheckCircle2 class="h-3.5 w-3.5 text-[var(--n8n-brand)]" />
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Content class="max-w-[240px] text-left">
                    <p>A Batshit-colored check means the parameter works in API presets.</p>
                    <p class="mt-2">
                      A second n8n-colored check means the same parameter also works in n8n Chat
                      Model nodes used by Workflow Subagents.
                    </p>
                  </Tooltip.Content>
                </Tooltip.Root>
              {/if}
              {#if n8nCompatibilityState.hasWorkflowSubagents}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onclick={() => void refreshN8nParameterCompatibility('model-card-manual')}
                  disabled={n8nCompatibilitySyncing}
                >
                  {#if n8nCompatibilitySyncing}
                    <Loader2 class="animate-spin" />
                  {:else}
                    <RefreshCcw />
                  {/if}
                  Refresh n8n
                </Button>
              {/if}
          {/snippet}
	        {#if n8nCompatibilitySyncError && n8nCompatibilityState.hasWorkflowSubagents}
	          <div class="batshit-settings-inline-alert is-warning">
	            Batshit could not reach n8n to check which settings its nodes accept. Your preset is
	            unaffected; only the n8n column of the compatibility notes is out of date.
	          </div>
	        {/if}
		          <div class="batshit-settings-form-stack">
		            <div class="batshit-settings-toggle-row is-spine-toggle">
		              <div>
		                <div class="batshit-settings-form-label-line">
		                  <p class="batshit-settings-parent-label">Supported Tools</p>
		                  <SettingsInfoMenu ariaLabel="About Supports Tools">
		                    <p>
		                      Turn this off for models that do not support tool calling, which is common for
		                      some local runtimes.
		                    </p>
		                  </SettingsInfoMenu>
		                </div>
		              </div>
		              <div class="batshit-settings-form-control is-inline-status">
		                <Switch.Root
		                  checked={resolveToolsToggleValue(editingForm)}
		                  onCheckedChange={(checked: boolean) => updateToolsCapability(checked)}
		                />
		              </div>
		            </div>

		            <div class="batshit-settings-form-row">
		              <div class="batshit-settings-form-copy">
		                <div class="batshit-settings-form-label-line">
		                  <p class="batshit-settings-form-label">Image Transport</p>
		                  <SettingsInfoMenu ariaLabel="About Image Transport">
		                    <p>
		                      Leave this on Automatic unless a specific model needs fetchable image
		                      URLs. Automatic data URLs are still structured image inputs, not prompt
		                      text.
		                    </p>
		                  </SettingsInfoMenu>
		                </div>
		              </div>
		              <div class="batshit-settings-form-control">
		                <Select.Root
		                  type="single"
		                  value={editingForm.imageTransport}
		                  onValueChange={(value) => {
		                    const nextValue = Array.isArray(value) ? value[0] : value
		                    if (!nextValue) return
		                    editingForm = { ...editingForm, imageTransport: nextValue as ImageTransport }
		                  }}
		                >
		                  <Select.Trigger>
		                    <span>
		                      {IMAGE_TRANSPORT_OPTIONS.find((option) => option.value === editingForm.imageTransport)?.label ||
		                        'Automatic'}
		                    </span>
		                  </Select.Trigger>
		                  <Select.Content>
		                    {#each IMAGE_TRANSPORT_OPTIONS as option (option.value)}
		                      <Select.Item value={option.value}>
		                        <div class="flex flex-col">
		                          <span>{option.label}</span>
		                          <span class="batshit-settings-form-label">{option.helper}</span>
		                        </div>
		                      </Select.Item>
		                    {/each}
		                  </Select.Content>
		                </Select.Root>
		              </div>
		            </div>
		          </div>

		          {#if !isCodexModel}
		            <div class="space-y-4">
		              <div class="flex items-center justify-between gap-4">
		                <div class="space-y-1">
		                  <div class="flex items-center gap-1">
		                    <p class="batshit-settings-form-label">{localProgramLabel ? `Managed by ${localProgramLabel}` : 'Model Parameters'}</p>
		                    <SettingsInfoMenu ariaLabel="About Model Parameters">
		                      <p>
		                        Settings auto-filter based on provider support, connection rules, and
		                        model capabilities.
		                      </p>
		                      <p class="mt-2">
		                        Common knobs live under <span class="batshit-settings-inline-strong">Common</span>,
		                        while provider-only extras move into sections like
		                        <span class="batshit-settings-inline-strong"> OpenAI Options</span> when they apply.
		                      </p>
		                      <p class="mt-2">
		                        {localProviderId === 'ollama'
                          ? 'Every field here is optional. Blank fields let Ollama decide, except Thinking: Batshit requests it off by default. Choose true to request thinking. Custom Parameters can override that choice. Values you enter apply to this request only.'
                          : localProgramLabel
                          ? `Every field here is optional. Leave a field blank and ${localProgramLabel} decides that value, using its own per-model setting. Fill a field in and this preset wins for that value, on this request only.`
                          : 'Leave any field blank to use the provider default instead.'}
		                      </p>
		                      {#if localProgramLabel}
		                        <p class="mt-2">
		                          Changing any of these does not throw away {localProgramLabel}'s memory of
		                          your conversation, so a second message still starts faster than the first.
		                          Editing the agent's system prompt does, and so does a conversation
		                          growing past the size the model was loaded with.
		                        </p>
		                      {/if}
		                      {#if ollamaModelfileCommands}
		                        <p class="mt-2">
		                          Batshit now sends Top K, Min P, repeat penalty, the repeat window and
		                          the context size straight to Ollama, so you do not need a Modelfile for
		                          those. Mirostat is the exception: Ollama accepted it but it changed
		                          nothing when we measured it, so Batshit does not offer a box that does
		                          nothing. If you want to try it anyway, it lives in a Modelfile, which
		                          you write yourself. To set one for
		                          <code>{ollamaModelfileCommands.model}</code>:
		                        </p>
		                        <p>1. <code>{ollamaModelfileCommands.show}</code></p>
		                        <p>
		                          2. Open the new <code>Modelfile</code> and add a line such as
		                          <code>{ollamaModelfileCommands.parameter}</code>
		                        </p>
		                        <p>3. <code>{ollamaModelfileCommands.create}</code></p>
		                        <p>4. Pick the new model in Batshit.</p>
		                        <p class="mt-2">
		                          To change the context size for every model at once, rather than per
		                          preset, start Ollama with
		                          <code>{ollamaModelfileCommands.contextEnv}</code>.
		                        </p>
		                        <p class="mt-2">
		                          <a
		                            href="https://docs.ollama.com/modelfile"
		                            target="_blank"
		                            rel="noreferrer noopener"
		                          >Ollama's Modelfile reference</a>
		                        </p>
		                      {/if}
		                    </SettingsInfoMenu>
		                  </div>
		                </div>
		                {#if !activeParameterDefinitions.length}
	                  <Badge variant="secondary">Auto Managed</Badge>
	                {/if}
	              </div>

			              <div class="batshit-settings-form-stack batshit-settings-parameter-accordion-stack">
			                {#if !activeParameterDefinitions.length}
			                  <div class="batshit-settings-form-row">
			                    <div class="batshit-settings-form-copy">
			                      <div class="batshit-settings-form-label-line">
			                        <p class="batshit-settings-form-label">Available Parameters</p>
			                      </div>
			                    </div>
			                    <div class="batshit-settings-form-control">
			                      <p class="batshit-settings-form-help">This model does not expose configurable parameters.</p>
			                    </div>
			                  </div>
			                {:else}
                        {#snippet parameterFields(parameters: ParameterDefinition[])}
                          <div class="batshit-settings-form-stack">
                            {#each parameters as parameter (parameter.name)}
                              {@const parameterSupportsN8N = isParameterSupportedInN8N(parameter, {
                                provider: editingForm.provider || selectedCatalogEntry?.developerId || '',
                                model: editingForm.modelId || selectedCatalogEntry?.modelId || '',
                                matrixEntries
                              })}
                              {@const responseFormatWarningVisible = showResponseFormatWarning(parameter)}
                              {@const unlistedChoiceNotice = getUnlistedChoiceNotice(parameter)}
	                              <div class="batshit-settings-form-row">
                                <div class="batshit-settings-form-copy">
                                  <div class="batshit-settings-form-label-line">
                                    <Label.Root class="batshit-settings-form-label">{parameter.label}</Label.Root>
                                    <SettingsInfoMenu ariaLabel={`About ${parameter.label}`}>
                                      <p>{getParameterHint(parameter)}</p>
                                    </SettingsInfoMenu>
                                    <span
                                      class="batshit-settings-parameter-support-icons"
                                      title={parameterSupportLabel(showN8nParameterSupport && parameterSupportsN8N)}
                                      aria-label={parameterSupportLabel(showN8nParameterSupport && parameterSupportsN8N)}
                                    >
                                      <Check class="h-3 w-3 text-[var(--batshit-primary)]" />
                                      {#if showN8nParameterSupport && parameterSupportsN8N}
                                        <Check class="h-3 w-3 text-[var(--n8n-brand)]" />
                                      {/if}
                                    </span>
                                    {#if responseFormatWarningVisible}
                                      <SettingsInfoMenu
                                        ariaLabel="Response Format Warning"
                                        tone="amber"
                                        contentClass="w-80"
                                      >
                                        <p>
                                          Batshit Chat expects the normal provider response format.
                                          Only override this for special-purpose presets, such as
                                          artifact or structured-output workflows that truly need it.
                                        </p>
                                      </SettingsInfoMenu>
                                    {/if}
                                    {#if unlistedChoiceNotice}
                                      <SettingsInfoMenu
                                        ariaLabel={`${parameter.label} not available`}
                                        tone="amber"
                                        contentClass="w-80"
                                      >
                                        <p>{unlistedChoiceNotice}</p>
                                      </SettingsInfoMenu>
                                    {/if}
                                  </div>
                                </div>
                                <div class="batshit-settings-form-control">
                                  <div class="batshit-settings-form-control-group">
                                    {#if parameter.inputType === 'boolean'}
                                      <Select.Root
                                        type="single"
                                        value={(getParameterValue(parameter.name) || '') as unknown as string}
                                        onValueChange={(value) =>
                                          updateParameterValue(
                                            parameter.name,
                                            Array.isArray(value) ? value[0] : (value as string)
                                          )
                                        }
                                      >
                                        <Select.Trigger>
                                          <span>
                                            {#if getParameterValue(parameter.name)}
                                              {getParameterValue(parameter.name)}
                                            {:else}
                                              {blankChoiceLabel(parameter, 'Select option')}
                                            {/if}
                                          </span>
                                        </Select.Trigger>
                                        <Select.Content>
                                          <Select.Item value="">{blankChoiceLabel(parameter, 'Use provider default')}</Select.Item>
                                          <Select.Item value="true">true</Select.Item>
                                          <Select.Item value="false">false</Select.Item>
                                        </Select.Content>
                                      </Select.Root>
                                    {:else if parameter.inputType === 'select'}
                                      <!-- BL-866: a saved choice this model replaces shows as its replacement, also after a model change -->
                                      {@const shownChoice = resolveSavedSelectValue(parameter, getParameterValue(parameter.name) || '')}
                                      <Select.Root
                                        type="single"
                                        value={shownChoice as unknown as string}
                                        onValueChange={(value) =>
                                          updateParameterValue(
                                            parameter.name,
                                            Array.isArray(value) ? value[0] : (value as string)
                                          )
                                        }
                                      >
                                        <Select.Trigger>
                                          <span>
                                            {#if shownChoice}
                                              {parameter.options?.find((option) => option.value === shownChoice)?.label ??
                                                shownChoice}
                                            {:else}
                                              {blankChoiceLabel(parameter, 'Select option')}
                                            {/if}
                                          </span>
                                        </Select.Trigger>
                                        <Select.Content>
                                          <!--
                                            SA-102 follow-up: only render the built-in empty option when the
                                            schema does not already carry one. The tri-state booleans
                                            (parallelToolCalls, store, strictJsonSchema,
                                            openaiWebSearchExternalAccess, includeThoughts) ship their own
                                            { label: 'Default', value: '' }, and two Select.Items sharing
                                            value="" both highlight as selected while switching between them
                                            does nothing.
                                          -->
                                          {#if !(parameter.options ?? []).some((option) => option.value === '')}
                                            <Select.Item value="">{blankChoiceLabel(parameter, 'Use provider default')}</Select.Item>
                                          {/if}
                                          {#each parameter.options ?? [] as option (option.value)}
                                            <Select.Item value={option.value}>{option.label}</Select.Item>
                                          {/each}
                                        </Select.Content>
                                      </Select.Root>
                                    {:else if parameter.inputType === 'sampler-order'}
                                      <SamplerOrderEditor
                                        value={getParameterValue(parameter.name)}
                                        onChange={(next) => updateParameterValue(parameter.name, next)}
                                      />
                                    {:else if parameter.inputType === 'textarea' || parameter.inputType === 'json' || parameter.inputType === 'string-array'}
                                      <Textarea
                                        rows={parameter.inputType === 'json' ? 6 : 3}
                                        value={getParameterValue(parameter.name)}
                                        placeholder={resolveParameterPlaceholder(parameter)}
                                        oninput={(event) =>
                                          updateParameterValue(
                                            parameter.name,
                                            (event.target as HTMLTextAreaElement).value
                                          )
                                        }
                                      />
                                    {:else}
                                      <Input
                                        type="text"
                                        inputmode={parameter.inputType === 'integer' ? 'numeric' : 'decimal'}
                                        value={getParameterValue(parameter.name)}
                                        placeholder={resolveParameterPlaceholder(parameter)}
                                        oninput={(event) =>
                                          updateParameterValue(
                                            parameter.name,
                                            (event.target as HTMLInputElement).value
                                          )
                                        }
                                        onblur={() => formatParameterValue(parameter)}
                                      />
                                    {/if}
                                    {#if responseFormatWarningVisible}
                                      <div class="batshit-settings-form-help is-warning flex items-center gap-1">
                                        <AlertCircle class="h-3.5 w-3.5 shrink-0" />
                                        <span>Structured response override is active for this preset.</span>
                                      </div>
                                    {/if}
                                  </div>
                                </div>
                              </div>
                            {/each}
                          </div>
                        {/snippet}

			                  {#each parameterSections as section (section.id)}
		                      {@const totalItems = section.basicItems.length + section.advancedItems.length}
		                      <Collapsible.Root open={parameterSectionOpen[section.id] ?? false}>
		                        <div class="batshit-settings-disclosure-row">
		                          <div class="batshit-settings-disclosure-trigger batshit-settings-parameter-trigger-row">
		                            <button
		                              type="button"
		                              class="batshit-settings-parameter-trigger-main"
		                              aria-expanded={parameterSectionOpen[section.id] ?? false}
		                              onclick={() => toggleParameterSection(section.id)}
		                            >
		                              <span class="batshit-settings-parameter-trigger-title">
		                                <span class="batshit-settings-form-label">{section.title}</span>
		                                <Badge variant="outline" class="batshit-settings-child-label">{totalItems}</Badge>
		                              </span>
		                            </button>
		                            <div class="batshit-settings-parameter-trigger-actions">
		                              <SettingsInfoMenu ariaLabel={`About ${section.title}`}>
		                                <p>{section.info}</p>
		                              </SettingsInfoMenu>
		                              <button
		                                type="button"
		                                class="batshit-settings-parameter-chevron-button"
		                                aria-label={`${parameterSectionOpen[section.id] ? 'Collapse' : 'Expand'} ${section.title}`}
		                                aria-expanded={parameterSectionOpen[section.id] ?? false}
		                                onclick={() => toggleParameterSection(section.id)}
		                              >
		                                <ChevronDown class={`batshit-settings-toggle-disclosure-chevron ${parameterSectionOpen[section.id] ? 'is-open' : ''}`} />
		                              </button>
		                            </div>
		                          </div>
		                          <Collapsible.Content class="batshit-settings-disclosure-content batshit-settings-subitem-lines">
		                            {#if section.basicItems.length || section.advancedItems.length}
		                              {@render parameterFields([...section.basicItems, ...section.advancedItems])}
		                            {/if}
		                          </Collapsible.Content>
		                        </div>
		                      </Collapsible.Root>
			                  {/each}
			                {/if}

			                <Collapsible.Root open={parameterSectionOpen[CUSTOM_PARAMETERS_SECTION_ID] ?? false}>
			                  <div class="batshit-settings-disclosure-row">
			                    <div class="batshit-settings-disclosure-trigger batshit-settings-parameter-trigger-row">
		                        <button
		                          type="button"
		                          class="batshit-settings-parameter-trigger-main"
		                          aria-expanded={parameterSectionOpen[CUSTOM_PARAMETERS_SECTION_ID] ?? false}
		                          onclick={() => toggleParameterSection(CUSTOM_PARAMETERS_SECTION_ID)}
		                        >
			                        <span class="batshit-settings-parameter-trigger-title">
			                          <span class="batshit-settings-form-label">Custom Parameters</span>
		                            <Badge variant="outline" class="batshit-settings-child-label">
		                              {editingForm.customParameterRows.length}
		                            </Badge>
			                        </span>
		                        </button>
			                      <div class="batshit-settings-parameter-trigger-actions">
			                        <SettingsInfoMenu ariaLabel="About Custom Parameters">
			                          <p>
			                            Add provider-specific parameters not listed above. Values entered in Custom JSON
			                            override matching keys from the row-based editor.
			                          </p>
			                          {#if localProgramLabel}
			                            <p class="mt-2">
			                              These now reach {localProgramLabel} exactly as you type them. Before, they
			                              were silently dropped before the request left Batshit.
			                            </p>
			                          {/if}
			                        </SettingsInfoMenu>
		                          <button
		                            type="button"
		                            class="batshit-settings-parameter-chevron-button"
		                            aria-label={`${parameterSectionOpen[CUSTOM_PARAMETERS_SECTION_ID] ? 'Collapse' : 'Expand'} Custom Parameters`}
		                            aria-expanded={parameterSectionOpen[CUSTOM_PARAMETERS_SECTION_ID] ?? false}
		                            onclick={() => toggleParameterSection(CUSTOM_PARAMETERS_SECTION_ID)}
		                          >
		                            <ChevronDown class={`batshit-settings-toggle-disclosure-chevron ${parameterSectionOpen[CUSTOM_PARAMETERS_SECTION_ID] ? 'is-open' : ''}`} />
		                          </button>
			                      </div>
			                    </div>
			                    <Collapsible.Content class="batshit-settings-disclosure-content batshit-settings-subitem-lines">
		                      <div class="batshit-settings-form-stack">
		                        <div class="batshit-settings-form-row is-tall">
		                          <div class="batshit-settings-form-copy">
		                            <div class="batshit-settings-form-label-line">
		                              <p class="batshit-settings-form-label">Custom Rows</p>
		                            </div>
		                          </div>
		                          <div class="batshit-settings-form-control">
		                            <div class="batshit-settings-form-control-group">
		                              {#if !editingForm.customParameterRows.length}
		                                <p class="batshit-settings-form-help">No custom parameters yet.</p>
		                              {/if}
		                              {#each editingForm.customParameterRows as row (row.id)}
		                                <div class="batshit-settings-custom-parameter-row">
		                                  <Input
		                                    placeholder="parameter_key"
		                                    value={row.key}
		                                    oninput={(event) =>
		                                      updateCustomParamRow(row.id, (current) => ({
		                                        ...current,
		                                        key: (event.target as HTMLInputElement).value
		                                      }))
		                                    }
		                                  />
		                                  <Select.Root
		                                    type="single"
		                                    value={row.type}
		                                    onValueChange={(value) =>
		                                      updateCustomParamRow(row.id, (current) => ({
		                                        ...current,
		                                        type: (Array.isArray(value) ? value[0] : value) as CustomParamType
		                                      }))
		                                    }
		                                  >
		                                    <Select.Trigger>
		                                      <span>
		                                        {CUSTOM_PARAM_TYPE_OPTIONS.find((option) => option.value === row.type)?.label ?? 'Type'}
		                                      </span>
		                                    </Select.Trigger>
		                                    <Select.Content>
		                                      {#each CUSTOM_PARAM_TYPE_OPTIONS as option (option.value)}
		                                        <Select.Item value={option.value}>{option.label}</Select.Item>
		                                      {/each}
		                                    </Select.Content>
		                                  </Select.Root>
		                                  {#if row.type === 'boolean'}
		                                    <Select.Root
		                                      type="single"
		                                      value={row.value || ''}
		                                      onValueChange={(value) =>
		                                        updateCustomParamRow(row.id, (current) => ({
		                                          ...current,
		                                          value: Array.isArray(value) ? value[0] : (value as string)
		                                        }))
		                                      }
		                                    >
		                                      <Select.Trigger>
		                                        <span>{row.value ? row.value : 'Select option'}</span>
		                                      </Select.Trigger>
		                                      <Select.Content>
		                                        <Select.Item value="true">true</Select.Item>
		                                        <Select.Item value="false">false</Select.Item>
		                                      </Select.Content>
		                                    </Select.Root>
		                                  {:else if row.type === 'json'}
		                                    <Textarea
		                                      rows={2}
		                                      value={row.value}
		                                      placeholder={'{"key":"value"}'}
		                                      oninput={(event) =>
		                                        updateCustomParamRow(row.id, (current) => ({
		                                          ...current,
		                                          value: (event.target as HTMLTextAreaElement).value
		                                        }))
		                                      }
		                                    />
		                                  {:else}
		                                    <Input
		                                      type="text"
		                                      inputmode={row.type === 'number' ? 'decimal' : undefined}
		                                      value={row.value}
		                                      placeholder={row.type === 'number' ? '0.0' : 'value'}
		                                      oninput={(event) =>
		                                        updateCustomParamRow(row.id, (current) => ({
		                                          ...current,
		                                          value: (event.target as HTMLInputElement).value
		                                        }))
		                                      }
		                                      onblur={() => formatCustomParamRowValue(row.id)}
		                                    />
		                                  {/if}
		                                  <Button
		                                    type="button"
		                                    size="sm"
		                                    variant="ghost"

		                                    onclick={() => removeCustomParamRow(row.id)}
		                                  >
		                                    <Trash2  />
		                                  </Button>
		                                </div>
		                              {/each}
		                              <Button type="button" size="sm" variant="secondary" onclick={addCustomParamRow}>
		                                <Plus  /> Add custom parameter
		                              </Button>
		                            </div>
		                          </div>
		                        </div>

		                        <div class="batshit-settings-form-row is-tall">
		                          <div class="batshit-settings-form-copy">
		                            <div class="batshit-settings-form-label-line">
		                              <Label.Root class="batshit-settings-form-label">Custom JSON</Label.Root>
		                              <SettingsInfoMenu ariaLabel="About Custom JSON">
		                                <p>Values entered here override matching keys from the row-based editor.</p>
		                              </SettingsInfoMenu>
		                            </div>
		                          </div>
		                          <div class="batshit-settings-form-control">
		                            <div class="batshit-settings-form-control-group">
		                              <Textarea
		                                rows={4}
		                                value={editingForm.customParametersJson}
		                                placeholder={'{"parameter_key": "value"}'}
		                                oninput={(event) =>
		                                  updateField('customParametersJson', (event.target as HTMLTextAreaElement).value)
		                                }
		                              />
		                              {#if customParametersJsonError}
		                                <p class="batshit-settings-form-help is-danger">{customParametersJsonError}</p>
		                              {/if}
		                            </div>
		                          </div>
		                        </div>
		                      </div>
		                    </Collapsible.Content>
			                  </div>
			                </Collapsible.Root>
			              </div>
				            </div>
	          {/if}

	          {#if isCodexModel}
	            <div class="batshit-settings-inline-alert is-dashed">
	              Manage Codex CLI defaults per agent now. Open Agent Settings for any Codex agent to configure
	              permission modes, sandboxes, feature flags, and working directories. This preset only stores the
	              underlying model parameters.
	            </div>
	          {/if}
	      </SettingsAccordionCard>

        {#if saveError}
          <div class="flex items-center gap-2 batshit-settings-inline-alert is-danger">
            <AlertCircle class="h-4 w-4" aria-hidden="true" />
            <span>{saveError}</span>
          </div>
        {:else if formValidationError}
          <div class="flex items-center gap-2 batshit-settings-inline-alert is-danger">
            <AlertCircle class="h-4 w-4" aria-hidden="true" />
            <span>{formValidationError}</span>
          </div>
        {/if}

        {#if !creatingNew && selectedModelId}
          <Collapsible.Root bind:open={deleteDisclosureOpen}>
            <div>
              <Collapsible.Trigger class="batshit-settings-delete-trigger">
                <span class="batshit-settings-delete-trigger-label">
                  <Trash2 class="batshit-settings-delete-trigger-icon" />
                  Delete Model
                </span>
                <ChevronDown
                  class={`batshit-settings-delete-chevron ${deleteDisclosureOpen ? 'is-open' : ''}`}
                />
              </Collapsible.Trigger>
              <Collapsible.Content class="batshit-settings-delete-content">
                <div class="batshit-settings-delete-content-inner">
                  <div class="batshit-settings-delete-copy">
                    <p>Permanently removes this saved model preset from Batshit.</p>
                    <p>Use this when the preset is obsolete or you want to rebuild it cleanly.</p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    class="batshit-settings-delete-action"
                    onclick={handleDelete}
                    disabled={deleteBusy}
                  >
                    {#if deleteBusy}
                      <Loader2 class="batshit-settings-delete-action-icon is-spinning" />
                    {:else}
                      <Trash2 class="batshit-settings-delete-action-icon" />
                    {/if}
                    Delete Model
                  </Button>
                </div>
              </Collapsible.Content>
            </div>
          </Collapsible.Root>
        {/if}
        {/if}
      </div>

  </div>
</div>
</div>
