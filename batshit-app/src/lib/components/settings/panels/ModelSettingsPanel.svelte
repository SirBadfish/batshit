<script lang="ts">
import { onMount, untrack } from 'svelte'
import { debounce } from '$lib/utils/debounce'
import * as Card from '$lib/components/ui/card'
import { Input } from '$lib/components/ui/input'
import * as Label from '$lib/components/ui/label'
import { Button } from '$lib/components/ui/button'
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
  isParameterSuppressedForModel
} from '$lib/utils/parameterFilter'
import { formatDefaultInput, fromInputValue, toInputValue } from '$lib/utils/parameterValueAdapter'
import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import type {
    SavedModel,
    PricingTier,
    ModelCompatibility,
    ModelCapabilities,
    ModelEnrichmentSnapshot,
    ModelVoiceSessionConfig,
    ImageTransport
  } from '$lib/types/savedModels'
import type { ParameterDefinition, ParameterValue } from '$lib/data/parameter-schemas'
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
  resolveConnectionScopedCatalogModel,
  type ConnectionScopedCatalogModel
} from '$lib/utils/catalogConnectionScope'
import { resolveCatalogIds } from '$lib/utils/modelIdResolver'
import {
  resolvePresetMaxOutputTokenResolution,
  resolvePresetMaxOutputTokens
} from '$lib/utils/modelOutputTokens'
import type { CatalogModel, CatalogConnectionOption } from '$lib/types/modelCatalog'
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
import { themeStore } from '$lib/stores/theme'
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
    contextWindow: string
    pricingInputMode: 'flat' | 'tiered'
    pricingInput: string
    pricingInputTiers: PricingTierFormRow[]
    pricingOutput: string
    pricingCachedInput: string
    parameterValues: Record<string, string>
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
    approval: 'never' | 'on-request' | 'on-failure' | 'untrusted'
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
    agent: { sandbox: 'workspace-write', approval: 'on-failure' },
    agent_full: { sandbox: 'danger-full-access', approval: 'never' }
  }
  const CODEX_PERMISSION_OPTIONS: Array<{ value: CodexPermissionMode; label: string; helper: string }> = [
    { value: 'chat', label: 'Chat', helper: 'Read-only, never prompts' },
    { value: 'agent', label: 'Agent', helper: 'Workspace write, ask on failure' },
    { value: 'agent_full', label: 'Agent (full)', helper: 'Full access, run without prompts' }
  ]
  const CODEX_SANDBOX_OPTIONS = [
    { value: 'read-only', label: 'Read-only' },
    { value: 'workspace-write', label: 'Workspace write' },
    { value: 'danger-full-access', label: 'Danger full access' }
  ] as const
  const CODEX_APPROVAL_OPTIONS = [
    { value: 'never', label: 'Never' },
    { value: 'on-failure', label: 'On failure' },
    { value: 'on-request', label: 'On request' },
    { value: 'untrusted', label: 'Untrusted' }
  ] as const

const EMPTY_FORM: ModelFormState = {
    id: null,
    modelName: '',
    modelId: '',
    provider: '',
    contextWindow: '',
    pricingInputMode: 'flat',
    pricingInput: '',
  pricingInputTiers: [],
  pricingOutput: '',
  pricingCachedInput: '',
  parameterValues: {},
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

const IMAGE_TRANSPORT_OPTIONS: Array<{ value: ImageTransport; label: string; helper: string }> = [
  { value: 'auto', label: 'Use runtime default', helper: 'Follow the Local AI runtime transport.' },
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

const LOCAL_PROVIDER_IDS = new Set(['ollama', 'dmr', 'lmstudio', 'llama-cpp', 'vllm'])

function isLocalProvider(form: ModelFormState): boolean {
  const connectionService = form.connectionService?.trim().toLowerCase() ?? ''
  if (connectionService && LOCAL_PROVIDER_IDS.has(connectionService)) return true
  const provider = form.provider?.trim().toLowerCase() ?? ''
  return provider ? LOCAL_PROVIDER_IDS.has(provider) : false
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
const manualEntryConnections = new Set([
  'direct:huggingface',
  'direct:togetherai',
  'direct:fireworks',
  'direct:baseten',
  'direct:cerebras'
])
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
  let purgeNotice = $state<{ count: number; names: string[] } | null>(null)
  let suppressCatalogAutoModelSelection = $state(false)

  let selectedModelId = $state<string | null>(null)
  let editingForm = $state<ModelFormState>({ ...EMPTY_FORM })
  let formPersistedSignature = $state<string | null>(null)
  let creatingNew = $state(false)
  let suppressDraftAutoCreate = $state(false)
  let lastDraftCreateAttemptSignature = $state<string | null>(null)

let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
let saveError = $state<string | null>(null)
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
      if (!unique.has(scopedModel.developerId)) {
        unique.set(scopedModel.developerId, {
          label: formatDeveloperLabel(scopedModel.developerId),
          value: scopedModel.developerId,
          n8nSupported: isN8NSupported(scopedModel.developerId)
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
    const sourceId = editingForm.vercelSourceId?.trim() ?? ''
    if (!provider && !modelId && !sourceId) return
    const signature = `${sourceId}|${provider}|${modelId}`
    if (signature === lastAutomaticCatalogSyncSignature) return
    lastAutomaticCatalogSyncSignature = signature
    syncCatalogSelectionFromEditingForm()
  })

  let filteredCatalogEntries = $state<ConnectionScopedCatalogModel[]>([])
  let selectedCatalogEntry = $state<ConnectionScopedCatalogModel | null>(null)
  let selectedCatalogModel = $state<CatalogModel | null>(null)
  const activePresetRole = $derived.by<'chat' | 'visual' | 'audio' | 'utility'>(() => {
    if (!creatingNew && selectedModelId) {
      const selectedPreset = models.find((model) => model.id === selectedModelId) ?? null
      if (selectedPreset) {
        return resolvePresetType(selectedPreset)
      }
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
        set.add(model.provider)
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
      rows = rows.filter((model) => model.provider === providerFilter)
    }
    if (query.length) {
      rows = rows.filter((model) => {
        const haystack = `${model.displayName} ${model.name} ${model.provider} ${model.connectionId ?? ''}`.toLowerCase()
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
    return manualEntryConnections.has(selectedConnection.id) || isCustomConnection
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
      ? scopedModels.filter((model) => model.developerId === selectedCatalogProvider)
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
    const provider = editingForm.provider || selectedCatalogEntry?.developerId || ''
    const modelId = editingForm.modelId || selectedCatalogEntry?.modelId || ''
    const vercelId = editingForm.vercelSourceId || selectedCatalogModel?.id || ''

    activeParameterDefinitions = filterParameters({
      provider,
      modelId,
      vercelId,
      capabilities: editingForm.capabilities ?? null,
      connection: editingForm.connectionType ?? undefined,
      purpose: activePresetRole,
      matrixEntries
    })
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

  $effect(() => {
    if (!selectedCatalogProvider) return
    if (!filteredCatalogEntries.length) return
    if (suppressCatalogAutoModelSelection && !selectedCatalogModelId) return
    if (
      !selectedCatalogModelId ||
      !filteredCatalogEntries.some((model) => model.catalogId === selectedCatalogModelId)
    ) {
      selectedCatalogModelId = filteredCatalogEntries[0].catalogId
    }
  })

  $effect(() => {
    if (!activeParameterDefinitions.length) return
    const nextValues = { ...editingForm.parameterValues }
    let changed = false

    for (const definition of activeParameterDefinitions) {
      if (nextValues[definition.name] !== undefined) continue
      if (definition.defaultValue === undefined) continue
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
      model: CODEX_SUBMODEL_CHOICES[0]?.value ?? 'gpt-5',
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
        ? settings.codex_approval
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

  onMount(async () => {
    await Promise.all([loadModels(), loadCatalog(), compatibilityMatrixStore.loadCompatibilityMatrix()])
  })

  async function loadModels() {
    isLoading = true
    listError = null

    try {
      const response = await fetch('/api/user/saved-models')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load models')
        throw new Error(message)
      }
      const result = await response.json()
      const loaded: SavedModel[] = Array.isArray(result) ? result : result?.models ?? []
      models = loaded ?? []
      savedModelsStore.setSavedModels(models)

      const purged = Array.isArray(result)
        ? []
        : result?.meta?.purged ?? []
      purgeNotice = purged.length
        ? {
            count: purged.length,
            names: purged.map((entry: { modelName: string }) => entry.modelName)
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

  async function loadCatalog(forceRefresh = false) {
    catalogLoading = true
    catalogError = null

    try {
      const endpoint = forceRefresh ? '/api/models?refresh=1' : '/api/models'
      const response = await fetch(endpoint)
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load model catalog')
        throw new Error(message)
      }
      const payload = await response.json()
      const models = payload?.data?.models ?? []
      const connections = payload?.data?.connections ?? []
      catalogModels = models
      connectionOptions = connections
      if (!catalogSelectionDirty) {
        syncCatalogSelectionFromEditingForm()
      }

    } catch (error) {
      console.error('Failed to load catalog:', error)
      catalogError = error instanceof Error ? error.message : 'Failed to load catalog'
    } finally {
      catalogLoading = false
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

  function selectModel(model: SavedModel) {
    creatingNew = false
    suppressDraftAutoCreate = false
    lastDraftCreateAttemptSignature = null
    suppressCatalogAutoModelSelection = false
    selectedModelId = model.id
    editingForm = normaliseModel(model)
    codexOptions = normaliseCodexOptions(model.settings ?? null)
    formPersistedSignature = makeFormSignature(editingForm)
    formValidationError = null
    lastInvalidModelSignature = null
    saveState = 'idle'
    saveError = null
    enrichmentWarning = null
    catalogSelectionDirty = false
    lastAutomaticCatalogSyncSignature = ''
    selectedConnectionId = editingForm.connectionId
    lastSyncedConnectionSignature = null
    const presetProvider = model.provider?.trim().toLowerCase() ?? ''
    if (!catalogSelectionDirty) {
      selectedCatalogProvider = presetProvider
      const presetModelId =
        model.vercelSourceId ??
        (presetProvider && model.modelId ? `${presetProvider}/${model.modelId}` : model.modelId ?? '')
      selectedCatalogModelId = presetModelId ?? ''
    }
    syncCatalogSelectionFromEditingForm()
  }

  function showCatalogLanding() {
    creatingNew = false
    suppressDraftAutoCreate = false
    lastDraftCreateAttemptSignature = null
    suppressCatalogAutoModelSelection = false
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
    creatingNew = true
  }

  function selectFirstModelOrShowCatalogLanding() {
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

  const debouncedSave = debounce(async (payload: SavedModel) => {
    try {
      const response = await fetch('/api/user/saved-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save model')
        throw new Error(message)
      }

      const result = await response.json()
      const updated: SavedModel | null = result?.model ?? null

      if (updated) {
        models = models.map((model) => (model.id === updated.id ? updated : model))
        editingForm = normaliseModel(updated)
        selectedModelId = updated.id
        formPersistedSignature = makeFormSignature(editingForm)
        savedModelsStore.upsertSavedModel(updated)
      }

      untrack(() => {
        lastInvalidModelSignature = null
        formValidationError = null
        saveState = 'saved'
        saveError = null
      })
    } catch (error) {
      console.error('Model save failed:', error)
      untrack(() => {
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save model'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (saveState === 'saved') {
            saveState = 'idle'
          }
        })
      }, 2000)
    }
  }, SAVE_DEBOUNCE_MS)

$effect(() => {
  if (!isExistingModel) return
  const signature = makeFormSignature(editingForm)
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
  if (!payload.id && selectedModelId) {
      payload.id = selectedModelId
    }

    debouncedSave(payload)
  })

  $effect(() => {
    if (!creatingNew) return
    if (suppressDraftAutoCreate || saveState === 'saving') return

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

    try {
      const payload = buildModelPayload(editingForm)
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

      if (created) {
        models = [created, ...models.filter((model) => model.id !== created.id)]
        selectModel(created)
        savedModelsStore.upsertSavedModel(created)
        toast.success(options?.successMessage ?? 'Model preset created')
      } else {
        toast.success(options?.successMessage ?? 'Model preset created')
        await loadModels()
      }
    } catch (error) {
      console.error('Model creation failed:', error)
      saveError = error instanceof Error ? error.message : 'Failed to create model'
      toast.error(saveError)
    } finally {
      saveState = 'idle'
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
        const { data, warnings } = buildCatalogEnrichmentFromModel(sourceModel)
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

      models = models.filter((model) => model.id !== selectedModelId)
      savedModelsStore.removeSavedModel(selectedModelId)
      selectFirstModelOrShowCatalogLanding()
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
    editingForm = {
      ...editingForm,
      parameterValues: {
        ...editingForm.parameterValues,
        [name]: value
      }
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
    const definitions = filterParameters({
      provider: model.provider,
      modelId: model.modelId,
      vercelId: model.vercelSourceId ?? undefined,
      capabilities: model.capabilities ?? null,
      connection: model.connection?.type ?? undefined,
      purpose: resolvePresetType(model),
      matrixEntries
    })
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

  function resolveSafeFormMaxOutputTokens(maxOutputTokens: string | number | null | undefined, contextWindow: unknown) {
    return resolvePresetMaxOutputTokens({
      maxOutputTokens,
      contextWindow
    })
  }

  function resolveSafeFormMaxOutputTokenResolution(
    maxOutputTokens: string | number | null | undefined,
    contextWindow: unknown
  ) {
    return resolvePresetMaxOutputTokenResolution({
      maxOutputTokens,
      contextWindow
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
    const contextWindow = parseFormattedInteger(editingForm.contextWindow) || 0
    const resolution = resolveSafeFormMaxOutputTokenResolution(rawMaxOutputTokens, contextWindow)

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
    const definitions = filterParameters({
      provider: model.provider,
      modelId: model.modelId,
      vercelId: model.vercelSourceId ?? undefined,
      capabilities: model.capabilities ?? null,
      connection: model.connection?.type ?? undefined,
      purpose: resolvePresetType(model),
      matrixEntries
    })
    const known = new Set(definitions.map((definition) => definition.name))
    const rows: CustomParamRow[] = []

    for (const [key, value] of Object.entries(model.settings)) {
      if (key.startsWith('codex_')) continue
      if (known.has(key)) continue
      if (
        isParameterSuppressedForModel(key, {
          provider: model.provider,
          modelId: model.modelId,
          vercelId: model.vercelSourceId
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
    const parameterValues = ensureSafeMaxOutputValue(buildParameterValueMap(model), contextWindow)
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
    const resolvedEnrichment = withMaxOutputResolution(enrichment, maxOutputResolution)

    return {
      id: model.id ?? null,
      modelName: model.modelName ?? '',
      modelId: model.modelId ?? '',
      provider: model.provider ?? '',
      contextWindow: contextWindow ? formatGroupedIntegerDisplay(contextWindow) : '',
      pricingInputMode,
      pricingInput,
      pricingInputTiers,
      pricingOutput: extractPrice(model.pricing?.output),
      pricingCachedInput: extractPrice(model.pricing?.cachedInput),
      parameterValues,
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
      provider: form.provider || selectedCatalogEntry?.developerId || undefined,
      modelId: form.modelId || selectedCatalogEntry?.modelId || undefined,
      vercelId: form.vercelSourceId || selectedCatalogModel?.id || undefined,
      capabilities: form.capabilities ?? null,
      connection: form.connectionType ?? undefined,
      purpose: activePresetRole,
      matrixEntries
    })

    const settings: Record<string, ParameterValue> = {}
    for (const definition of definitions) {
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

    let pricingInput: number | PricingTier[] = 0
    if (form.pricingInputMode === 'tiered') {
      const tiers: (PricingTier | null)[] = form.pricingInputTiers.map((tier) => {
        const from = parseFormattedNumber(tier.from)
        const to = parseFormattedNumber(tier.to)
        const cost = parseFormattedNumber(tier.cost)

        if (from === undefined || to === undefined || cost === undefined) {
          return null
        }
        if (from < 0 || to <= 0 || cost < 0) {
          return null
        }

        return {
          from,
          to,
          costPerMillion: cost
        } as PricingTier
      })

      const filtered = tiers.filter((tier): tier is PricingTier => tier !== null)
      pricingInput = filtered.length > 0 ? filtered.sort((a, b) => a.from - b.from) : 0
    } else {
      const parsed = parseFormattedNumber(form.pricingInput)
      pricingInput = parsed ?? 0
    }

    const contextWindow = form.contextWindow ? parseFormattedInteger(form.contextWindow) || 0 : 0
    const maxOutputResolution = resolveSafeFormMaxOutputTokenResolution(form.parameterValues.maxTokens ?? null, contextWindow)
    const settings = buildParameterSettings(form)
    settings.maxTokens = maxOutputResolution.maxOutputTokens
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
      contextWindow,
      pricing: {
        input: pricingInput,
        output: form.pricingOutput ? parseFormattedNumber(form.pricingOutput) || 0 : 0,
        cachedInput: form.pricingCachedInput ? parseFormattedNumber(form.pricingCachedInput) || undefined : undefined
      },
      settings: mergedSettings,
      capabilities: form.capabilities ?? undefined,
      voiceSession: voiceSession ?? undefined,
      compatibility: form.compatibility ?? undefined,
      imageTransport: form.imageTransport !== 'auto' ? form.imageTransport : undefined,
      isVercelImport: form.isVercelImport,
      vercelSourceId: form.vercelSourceId ?? undefined,
      vercelDisplayName: form.vercelDisplayName ?? undefined,
      enrichment: withMaxOutputResolution(form.enrichment ?? {
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

  function prefillFromCatalogModel(model: CatalogModel) {
    const currentConnection = selectedConnection
    const needsAutoSelection =
      !currentConnection ||
      !isModelAllowedForConnection(model, currentConnection) ||
      !allowModelForConnection(model, currentConnection)

    let connectionIdForVariant = selectedConnectionId
    let connectionForVariant = currentConnection
    if (needsAutoSelection) {
      const nextConnection = autoSelectConnectionForModel(connectionOptions, model)
      if (nextConnection) {
        selectedConnectionId = nextConnection.id
        connectionIdForVariant = nextConnection.id
        connectionForVariant = nextConnection
      }
    }

    const resolvedIds = resolveCatalogIds({
      connectionId: connectionIdForVariant,
      connection: connectionForVariant,
      developerId: model.provider,
      modelId: model.name,
      idVariants: model.idVariants ?? null
    })
    editingForm = {
      ...editingForm,
      provider: resolvedIds?.developerId ?? model.provider,
      modelId: resolvedIds?.modelId ?? model.name,
      modelName: editingForm.modelName || model.displayName,
      isVercelImport: model.source === 'vercel',
      vercelSourceId: model.source === 'vercel' ? model.id : null
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
      vercelSourceId: null,
      vercelDisplayName: null,
      enrichment: null,
      voiceSession: null,
      capabilities: null,
      compatibility: providerHint ? determineModelCompatibility(providerHint) : null,
      parameterValues: {},
      connectionUseDeveloperPrefix: false
    }
  }

  function normalizeCatalogIdentifier(value?: string | null) {
    return value?.toLowerCase().trim() ?? ''
  }

  function getNewPresetActionLabel() {
    if (manualEntryConnectionActive || connectionNeedsManualModel) {
      return 'Start Manual Preset'
    }
    return 'Use to Create New Preset'
  }

  function getOverwriteConfirmationMessage() {
    return [
      'This updates the basic model info, connection details, compatibility badges, pricing, context window, and Max Output Tokens.',
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
      suppressCatalogAutoModelSelection = true
      if (!providerModified && editingForm.provider) {
        selectedCatalogProvider = editingForm.provider
      } else {
        selectedCatalogProvider = ''
      }
      selectedCatalogModelId = ''
      return
    }

    const targetId =
      editingForm.vercelSourceId ||
      (editingForm.provider && editingForm.modelId ? `${editingForm.provider}/${editingForm.modelId}` : null)

    if (!targetId) {
      selectedCatalogProvider = ''
      selectedCatalogModelId = ''
      return
    }

    const normalizedTarget = normalizeCatalogIdentifier(targetId)
    const match =
      catalogModels.find(
        (model) =>
          normalizeCatalogIdentifier(model.id) === normalizedTarget ||
          normalizeCatalogIdentifier(model.canonicalId) === normalizedTarget ||
          Object.values(model.idVariants ?? {}).some(
            (variant) => normalizeCatalogIdentifier(variant.effectiveId) === normalizedTarget
          )
      ) ??
      catalogModels.find(
        (model) => model.provider === editingForm.provider && model.name === editingForm.modelId
      ) ??
      catalogModels.find((model) =>
        Object.values(model.idVariants ?? {}).some(
          (variant) => variant.developerId === editingForm.provider && variant.modelId === editingForm.modelId
        )
      )

    if (match) {
      const scopedMatch = resolveConnectionScopedCatalogModel(match, selectedConnection)
      suppressCatalogAutoModelSelection = false
      selectedCatalogProvider = scopedMatch.developerId
      selectedCatalogModelId = match.id
    } else {
      suppressCatalogAutoModelSelection = false
      selectedCatalogProvider = ''
      selectedCatalogModelId = ''
    }
  }

  function handleCatalogProviderSelect(value: string | string[]) {
    const nextValue = Array.isArray(value) ? value[0] ?? '' : value ?? ''
    selectedCatalogProvider = nextValue
    suppressCatalogAutoModelSelection = false
    catalogSelectionDirty = true
    if (!nextValue) {
      selectedCatalogModelId = ''
      return
    }

    const baseModels = selectedConnection
      ? catalogModels.filter(
          (model) =>
            isModelAllowedForConnection(model, selectedConnection) &&
            allowModelForConnection(model, selectedConnection)
        )
      : catalogModels
    const candidates = buildConnectionScopedCatalogModels(baseModels, selectedConnection).filter(
      (model) => model.developerId === nextValue
    )
    selectedCatalogModelId = candidates[0]?.catalogId ?? ''
  }

  function handleCatalogModelSelect(value: string | string[]) {
    const nextValue = Array.isArray(value) ? value[0] ?? '' : value ?? ''
    selectedCatalogModelId = nextValue
    suppressCatalogAutoModelSelection = false
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
    const baselineModelId = editingForm.modelId?.trim() || model.name
    const baselineProvider = editingForm.provider?.trim() || model.provider
    const baselineConnectionId = editingForm.connectionId ?? selectedConnectionId ?? undefined
    const rawMaxOutputTokens = toCatalogNumber(model.maxOutputTokens)
    const pricingInput = toCatalogNumber(model.pricing?.input)
    const pricingOutput = toCatalogNumber(model.pricing?.output)
    const pricingCached = toCatalogNumber(model.pricing?.cachedInput)
    const rawContext = toCatalogNumber(model.contextWindow)
    const contextWindow = rawContext !== undefined ? Math.max(0, Math.round(rawContext)) : undefined
    const maxOutputResolution = resolveSafeFormMaxOutputTokenResolution(rawMaxOutputTokens, contextWindow)
    const baselineMaxOutputTokens = maxOutputResolution.maxOutputTokens
    const capabilities = catalogFeaturesToCapabilities(model.features ?? null)
    const compatibility = determineModelCompatibility(model.provider)

    const pricing: { input?: number; output?: number; cachedInput?: number } = {}
    if (pricingInput !== undefined) pricing.input = pricingInput
    if (pricingOutput !== undefined) pricing.output = pricingOutput
    if (pricingCached !== undefined) pricing.cachedInput = pricingCached

    const warnings: string[] = []
    if (Object.keys(pricing).length === 0) {
      warnings.push('Pricing not provided in catalog entry.')
    }
    if (contextWindow === undefined) {
      warnings.push('Context window missing from catalog entry.')
    }
    if (rawMaxOutputTokens === undefined) {
      warnings.push(`Max Output Tokens missing from catalog entry; using ${baselineMaxOutputTokens.toLocaleString()}.`)
    } else if (baselineMaxOutputTokens !== Math.floor(rawMaxOutputTokens)) {
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
      maxOutputTokens: baselineMaxOutputTokens,
      maxOutputTokensEstimated: maxOutputResolution.estimated,
      maxOutputTokensEstimateReason:
        maxOutputResolution.reason === 'provided' ? undefined : maxOutputResolution.reason,
      contextWindow,
      pricing: Object.keys(pricing).length ? pricing : undefined,
      capabilities: capabilities ?? undefined,
      provider: baselineProvider || undefined,
      connectionId: baselineConnectionId,
      identifier:
        model.source === 'vercel'
          ? model.id
          : baselineProvider && baselineModelId
            ? `${baselineProvider}/${baselineModelId}`
            : undefined
    }

    const pricingPayload =
      pricingInput !== undefined || pricingOutput !== undefined || pricingCached !== undefined
        ? {
            input: pricingInput ?? 0,
            output: pricingOutput ?? 0,
            ...(pricingCached !== undefined ? { cachedInput: pricingCached } : {})
          }
        : undefined

    const data: Partial<SavedModel> = {
      modelName: baselineModelName,
      modelId: baselineModelId,
      provider: baselineProvider,
      contextWindow: contextWindow ?? undefined,
      pricing: pricingPayload,
      capabilities: capabilities ?? undefined,
      compatibility,
      isVercelImport: model.source === 'vercel',
      vercelSourceId: model.source === 'vercel' ? model.id : undefined,
      vercelDisplayName: model.displayName,
      settings: {
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
    if (typeof data.contextWindow === 'number') {
      next.contextWindow = data.contextWindow ? formatGroupedIntegerDisplay(data.contextWindow) : ''
    }

    if (data.pricing) {
      if (data.pricing.input !== undefined) {
        next.pricingInputMode = 'flat'
        next.pricingInputTiers = []
        next.pricingInput = formatCurrencyDisplay(data.pricing.input ?? 0)
      }
      if (data.pricing.output !== undefined) {
        next.pricingOutput = formatCurrencyDisplay(data.pricing.output ?? 0)
      }
      if (data.pricing.cachedInput !== undefined) {
        next.pricingCachedInput =
          data.pricing.cachedInput === undefined ? '' : formatCurrencyDisplay(data.pricing.cachedInput ?? 0)
      }
    }

    if (data.settings && typeof data.settings.maxTokens === 'number') {
      next.parameterValues = {
        ...next.parameterValues,
        maxTokens: formatGroupedIntegerDisplay(data.settings.maxTokens)
      }
    }

    next.capabilities = data.capabilities ?? next.capabilities
    next.compatibility = data.compatibility ?? next.compatibility
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
    {#if purgeNotice}
      <div class="batshit-settings-inline-alert is-warning">
        Removed {purgeNotice.count} deprecated model{purgeNotice.count === 1 ? '' : 's'} from your presets.
        {#if purgeNotice.names.length}
          <span class="batshit-settings-caption ml-1">
            {purgeNotice.names.slice(0, 3).join(', ')}
            {#if purgeNotice.names.length > 3}
              &nbsp;+{purgeNotice.names.length - 3} more
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
                            <Badge variant="outline" class="batshit-settings-child-label">
                              n8n · compatible
                            </Badge>
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
        {#if manualEntryConnectionActive}
          <div class="batshit-settings-note is-dashed">
            <p>No catalog available yet. Choose a connection, then copy its provider defaults into the preset and enter the developer and model ID manually below.</p>
            <p class="mt-2">
              Tip: For multi-tenant providers (Together.ai, Fireworks, Baseten, Cerebras), use
              <code>developer/model</code> so Batshit can route correctly. Custom providers can either use the toggle below
              or put <code>developer/model</code> directly in the Model ID field.
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
                  {#if selectedCatalogModel.pricing}
                    <p class="flex flex-wrap gap-3">
                      {#if selectedCatalogModel.pricing.input !== undefined}
                        <span>Input ${formatPrice(selectedCatalogModel.pricing.input)}/M</span>
                      {/if}
                      {#if selectedCatalogModel.pricing.output !== undefined}
                        <span>Output ${formatPrice(selectedCatalogModel.pricing.output)}/M</span>
                      {/if}
                      {#if selectedCatalogModel.pricing.cachedInput !== undefined}
                        <span>Cached ${formatPrice(selectedCatalogModel.pricing.cachedInput)}/M</span>
                      {/if}
                    </p>
                  {/if}
                  {#if selectedCatalogModel.contextWindow}
                    <p>
                      Context: {selectedCatalogModel.contextWindow.toLocaleString()} tokens
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
                      <Badge variant="outline" class="batshit-settings-child-label">
                        n8n · compatible
                      </Badge>
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
	              <p class="mt-2">
	                <span class="batshit-settings-inline-strong is-success">✓</span> means the preset works in
	                both n8n and Batshit. <span class="batshit-settings-inline-strong is-danger">*</span> means it
	                is Batshit direct only.
	              </p>
	            </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
	            {#if !creatingNew && selectedModelId}
	              <SettingsSaveStatus
	                state={saveError ? 'error' : saveState}
	                error={saveError}
	                savedLabel="Model Saved"
	                sticky={false}
	              />
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
		                      <Badge variant="outline" class="batshit-settings-child-label">
		                        n8n · compatible
		                      </Badge>
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

		            {#if editingForm.capabilities}
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
		                      {#if editingForm.capabilities[capability.key]}
		                        <Badge variant="outline">{capability.label}</Badge>
		                      {/if}
		                    {/each}
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

	            <div class="batshit-settings-form-row">
	              <div class="batshit-settings-form-copy">
	                <div class="batshit-settings-form-label-line">
	                  <Label.Root class="batshit-settings-form-label">Context Window</Label.Root>
                  {#if isCatalogBaselineFieldModified('contextWindow')}
                    <Badge variant="outline" class={MODIFIED_BADGE_CLASS}>Modified</Badge>
                  {/if}
	                  <SettingsInfoMenu ariaLabel="About Context Window">
	                    <p>Total tokens supported by this model. Leave blank when you want Batshit to treat it as unknown.</p>
	                  </SettingsInfoMenu>
	                </div>
	              </div>
	              <div class="batshit-settings-form-control">
	                <Input
	                  type="text"
                    inputmode="numeric"
	                  value={editingForm.contextWindow}
	                  placeholder="200,000"
	                  oninput={(event) => updateField('contextWindow', (event.target as HTMLInputElement).value)}
                    onblur={() => {
                      formatField('contextWindow', formatGroupedIntegerDisplay)
                      applySafeMaxOutputToEditingForm(getParameterValue('maxTokens'))
                    }}
	                />
	              </div>
	            </div>

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
	                  value={getParameterValue('maxTokens')}
	                  placeholder="4,000"
	                  oninput={(event) => updateParameterValue('maxTokens', (event.target as HTMLInputElement).value)}
                    onblur={() => applySafeMaxOutputToEditingForm(getParameterValue('maxTokens'))}
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
              <Tooltip.Root>
                <Tooltip.Trigger>
                  <button
                    type="button"
                    class="batshit-settings-model-support-legend-trigger"
                    aria-label="About API and n8n parameter support markers"
                  >
                    <CheckCircle2 class="h-3.5 w-3.5 text-[var(--batshit-primary)]" />
                    <CheckCircle2 class="h-3.5 w-3.5 text-[var(--n8n-primary)]" />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Content class="max-w-[240px] text-left">
                  <p>A Batshit-colored check means the parameter works in API presets.</p>
                  <p class="mt-2">
                    When a second n8n-colored check appears, that same parameter also works in n8n
                    Chat Model nodes.
                  </p>
                </Tooltip.Content>
              </Tooltip.Root>
          {/snippet}
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
		                      Use the runtime default unless a specific model needs fetchable image
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
		                        'Use runtime default'}
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
		                    <p class="batshit-settings-form-label">Model Parameters</p>
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
		                        Leave any field blank to use the provider default instead.
		                      </p>
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
	                              <div class="batshit-settings-form-row">
                                <div class="batshit-settings-form-copy">
                                  <div class="batshit-settings-form-label-line">
                                    <Label.Root class="batshit-settings-form-label">{parameter.label}</Label.Root>
                                    <SettingsInfoMenu ariaLabel={`About ${parameter.label}`}>
                                      <p>{getParameterHint(parameter)}</p>
                                    </SettingsInfoMenu>
                                    <span
                                      class="batshit-settings-parameter-support-icons"
                                      title={parameterSupportLabel(parameterSupportsN8N)}
                                      aria-label={parameterSupportLabel(parameterSupportsN8N)}
                                    >
                                      <Check class="h-3 w-3 text-[var(--batshit-primary)]" />
                                      {#if parameterSupportsN8N}
                                        <Check class="h-3 w-3 text-[var(--n8n-primary)]" />
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
                                              Select option
                                            {/if}
                                          </span>
                                        </Select.Trigger>
                                        <Select.Content>
                                          <Select.Item value="">Use provider default</Select.Item>
                                          <Select.Item value="true">true</Select.Item>
                                          <Select.Item value="false">false</Select.Item>
                                        </Select.Content>
                                      </Select.Root>
                                    {:else if parameter.inputType === 'select'}
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
                                              {parameter.options?.find((option) => option.value === getParameterValue(parameter.name))?.label ??
                                                getParameterValue(parameter.name)}
                                            {:else}
                                              Select option
                                            {/if}
                                          </span>
                                        </Select.Trigger>
                                        <Select.Content>
                                          <Select.Item value="">Use provider default</Select.Item>
                                          {#each parameter.options ?? [] as option (option.value)}
                                            <Select.Item value={option.value}>{option.label}</Select.Item>
                                          {/each}
                                        </Select.Content>
                                      </Select.Root>
                                    {:else if parameter.inputType === 'textarea' || parameter.inputType === 'json' || parameter.inputType === 'string-array'}
                                      <Textarea
                                        rows={parameter.inputType === 'json' ? 6 : 3}
                                        value={getParameterValue(parameter.name)}
                                        placeholder={parameter.placeholder}
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
                                        placeholder={formatParameterDisplayValue(parameter, parameter.placeholder ?? '') || parameter.placeholder}
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
