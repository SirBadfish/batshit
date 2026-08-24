<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import { downloadBlob, exportBackupNatively } from '$lib/utils/download'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import AutoCompactSettingsCard from '$lib/components/settings/AutoCompactSettingsCard.svelte'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import SystemPromptEditor from '$lib/components/settings/SystemPromptEditor.svelte'
  import AdminBackupRestoreCard from '$lib/components/settings/admin/AdminBackupRestoreCard.svelte'
  import AdminCoreSystemPromptsCard from '$lib/components/settings/admin/AdminCoreSystemPromptsCard.svelte'
  import AdminDiagnosticsCard from '$lib/components/settings/admin/AdminDiagnosticsCard.svelte'
  import AdminDynamicSchemaHintsCard from '$lib/components/settings/admin/AdminDynamicSchemaHintsCard.svelte'
  import AdminGoonAssetCleanupCard from '$lib/components/settings/admin/AdminGoonAssetCleanupCard.svelte'
  import AdminUtilityCards from '$lib/components/settings/admin/AdminUtilityCards.svelte'
  import AdminWebSearchCard from '$lib/components/settings/admin/AdminWebSearchCard.svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import {
    ChevronDown,
    Download,
    ExternalLink,
    RefreshCw,
    ShieldCheck,
    Trash2,
    Wrench
  } from '@lucide/svelte'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import type { UserSettingsRow } from '$lib/types/database'
  import {
    DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS,
    DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT,
    DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT,
    DEFAULT_DCM_TOOL_NAME_THRESHOLD,
    DEFAULT_GOON_LIP_SYNC_LAB_ENABLED,
    DEFAULT_N8N_EXECUTION_SEARCH_LIMIT,
    DEFAULT_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE,
    MAX_DCM_SCHEMA_HINT_LIMIT,
    MAX_DCM_SCHEMA_HINT_MAX_CHARS,
    MAX_DCM_TOOL_NAME_THRESHOLD,
    MAX_N8N_EXECUTION_SEARCH_LIMIT,
    MIN_DCM_SCHEMA_HINT_MAX_CHARS,
    WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS,
    WEB_SEARCH_PROVIDER_LABELS,
    clampNumber,
    formatBackupBytes,
    normalizeExaSearchType,
    normalizeWebSearchProvider,
    normalizeWebSearchProviderForAvailability,
    type AdminSettingsState,
    type BackupPreflightSummary,
    type CoreSystemPromptDetail,
    type CoreSystemPromptSummary,
    type DiagnosticsPreviewSummary,
    type ExaSearchType,
    type GoonAssetAuditSummary,
    type GoonAssetCleanupResult,
    type NativeWebSearchProvider
  } from '$lib/components/settings/admin/adminSettingsTypes'

  const SAVE_DEBOUNCE_MS = 500
  const fbxPlatformOptions: Array<{ value: FbxInstallPlatform; label: string }> = [
    { value: 'darwin-x64', label: 'macOS (Intel/x64 • Apple Silicon via Rosetta)' },
    { value: 'windows-x64', label: 'Windows (x64)' },
    { value: 'linux-x64', label: 'Linux (x64)' }
  ]
  const cloudflaredPlatformOptions: Array<{ value: CloudflaredInstallPlatform; label: string }> = [
    { value: 'darwin-x64', label: 'macOS (Intel/x64 • Apple Silicon via Rosetta)' },
    { value: 'windows-x64', label: 'Windows (x64)' },
    { value: 'linux-x64', label: 'Linux (x64)' }
  ]

  type FbxInstallPlatform = 'darwin-x64' | 'linux-x64' | 'windows-x64'
  type CloudflaredInstallPlatform = 'darwin-x64' | 'linux-x64' | 'windows-x64'
  type FbxInstallStatus = {
    installed: boolean
    supported?: boolean
    dockerUnsupported?: boolean
    supportLevel?: 'native-managed' | 'docker-deferred' | 'docker-worker' | 'docker-worker-missing'
    reason?: string | null
    installHelp?: string
    defaultPlatform?: FbxInstallPlatform
    testedVersion?: string
    checksumNote?: string
    manifest?: {
      platform?: FbxInstallPlatform
      version?: string
      releaseTag?: string
      binaryName?: string
      installedAt?: string
      checksumNote?: string
    } | null
    worker?: {
      running: boolean
      url: string
      checkedAt: string
      error: string | null
      health?: {
        status?: string
        version?: string
        fbx2gltfVersion?: string
        maxBytes?: number
        workDir?: string
      } | null
    } | null
  }
  type AgentBrowserRuntimeStatus = {
    installed: boolean
    supported?: boolean
    dockerUnsupported?: boolean
    supportLevel?: 'native-cli' | 'docker-sidecar' | 'docker-deferred'
    installScope?: 'native-cli' | 'docker-sidecar'
    command: string | null
    version: string | null
    reason: string | null
    installCommand: string
    installHelp: string
    testedVersion?: string
    runtimeMatchesTestedVersion?: boolean | null
  }
  type CloudflaredRuntimeStatus = {
    installed: boolean
    supported?: boolean
    dockerUnsupported?: boolean
    supportLevel?: 'native-managed' | 'docker-deferred' | 'docker-sidecar'
    command: string | null
    version: string | null
    reason: string | null
    testedVersion?: string
    installScope?: 'none' | 'batshit-managed' | 'system' | 'docker-sidecar'
    managedInstallPresent?: boolean
    installCommand: string
    installHelp: string
    defaultPlatform?: CloudflaredInstallPlatform
    manifest?: {
      version?: string
      releaseTag?: string
      installedAt?: string
      checksumVerified?: boolean
      checksumVerifiedAt?: string
    } | null
    tunnel?: {
      running: boolean
      publicUrl: string | null
      targetUrl: string | null
      pid: number | null
      startedAt: string | null
      lastError: string | null
    }
    dockerSidecar?: {
      status: string
      publicUrl: string | null
      targetUrl: string | null
      lastSeenAt: string | null
      statePath: string
      stale: boolean
    } | null
  }
  type N8nRuntimeStatus = {
    mode: 'mac-app' | 'docker' | 'native'
    healthy: boolean
    reachable: boolean
    status: number | null
    effectiveUrl: string
    healthUrl: string
    urlSource: 'saved-api-url' | 'runtime-env' | 'default-localhost'
    apiKeyConfigured: boolean
    error: string | null
    launch: {
      startSupported: false
      browserOpenSupported: false
      reason: string
    }
  }
  type RuntimeContextStatus = {
    success?: boolean
    mode: 'mac-app' | 'docker' | 'native'
    label: string
    macApp: boolean
    containerized: boolean
    runtimeOwner: string | null
    runtimeEnv: string | null
    adminCards: {
      macAppRequiredRuntime: boolean
      appleContainerSandbox: boolean
      dockerSandbox: boolean
    }
  }
  type MacRuntimeAction = 'doctor' | 'start' | 'restart' | 'stop' | 'appleContainerStart'
  type MacRuntimeDoctorAction = {
    id: string
    severity: 'blocker' | 'repairable' | 'warning' | string
    title: string
    detail: string
    repairCommand?: MacRuntimeAction
    repairLabel?: string
    externalUrl?: string
    externalLabel?: string
  }
  type MacRuntimeToolStatus = {
    available?: boolean
    installed?: boolean
    healthy?: boolean
    skipped?: boolean
    supported?: boolean
    version?: string | null
    path?: string | null
    error?: string | null
  }
  type MacRuntimeServiceStatus = {
    label?: string
    available?: boolean
    healthy?: boolean
    skipped?: boolean
    optional?: boolean
    pidAlive?: boolean
    external?: boolean
    dataDir?: string | null
    healthUrl?: string | null
    error?: string | null
  }
  type MacRuntimeDoctorReport = {
    ok?: boolean
    generatedAt?: string
    appUrl?: string
    error?: string | null
    paths?: {
      data?: string
      logs?: string
    }
    tools?: Record<string, MacRuntimeToolStatus | undefined>
    services?: Record<string, MacRuntimeServiceStatus | undefined>
    actions?: MacRuntimeDoctorAction[]
    releaseNotes?: Record<string, string>
  }
  type MacRuntimeRequiredItem = {
    key: string
    label: string
    optional?: boolean
    status?: MacRuntimeToolStatus | MacRuntimeServiceStatus
  }
  type RuntimeAddonPrepareStatus = {
    running: boolean
    canStartAutomatically: boolean
    operatorCommand: string
    nextSteps: string[]
    operator: {
      configured: boolean
      available: boolean
      reason: string | null
      url: string | null
    }
  }

  function isDockerFbxStatus(status: FbxInstallStatus | null) {
    return (
      status?.supportLevel === 'docker-worker' ||
      status?.supportLevel === 'docker-worker-missing' ||
      status?.dockerUnsupported === true
    )
  }

  type RuntimeStatusTone = 'ok' | 'warning' | 'bad' | 'checking'

  const macRuntimeCommands: Record<MacRuntimeAction, string> = {
    doctor: 'batshit.runtime.doctor',
    start: 'batshit.runtime.start',
    restart: 'batshit.runtime.restart',
    stop: 'batshit.runtime.stop',
    appleContainerStart: 'batshit.runtime.appleContainerStart'
  }

  function runtimeStatusBadgeClass(tone: RuntimeStatusTone) {
    return `batshit-settings-child-label runtime-status-badge is-${tone}`
  }

  type SandboxRuntimeStatus = {
    success?: boolean
    available: boolean
    installed?: boolean
    supported?: boolean
    dockerUnsupported?: boolean
    containerized?: boolean
    backend: 'docker_sandbox' | 'apple_container'
    policy: string
    version: string | null
    cli?: 'sbx' | 'docker-sandbox' | null
    image?: string | null
    network?: string | null
    reason: string | null
    installUrl?: string
  }
  type PanelData = {
    user?: {
      id: string
      email?: string | null
    } | null
    userSettings?: UserSettingsRow | null
  } | null

  let {
    data = null,
    initialSection = null,
    initialAction = null,
    initialSectionNonce = 0
  }: {
    data?: PanelData
    initialSection?: 'diagnostics' | null
    initialAction?: 'preview' | null
    initialSectionNonce?: number
  } = $props()

  let adminSettings = $state<AdminSettingsState>(normaliseAdminSettings(null))
  let persistedSignature = $state(makeSignature(normaliseAdminSettings(null)))
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let isLoading = $state(true)
  let webSearchProvidersLoading = $state(false)
  let webSearchProvidersError = $state<string | null>(null)
  let availableWebSearchProviders = $state<Record<'exa' | 'perplexity', boolean>>({
    exa: false,
    perplexity: false
  })
  let fbxInstallStatus = $state<FbxInstallStatus | null>(null)
  let fbxAddonStatus = $state<RuntimeAddonPrepareStatus | null>(null)

  $effect(() => {
    if (!isLoading) return
    const next = normaliseAdminSettings(data?.userSettings)
    adminSettings = next
    persistedSignature = makeSignature(next)
  })
  let fbxInstallBusy = $state(false)
  let fbxInstallPlatform = $state<FbxInstallPlatform>('darwin-x64')
  let agentBrowserRuntimeStatus = $state<AgentBrowserRuntimeStatus | null>(null)
  let agentBrowserAddonStatus = $state<RuntimeAddonPrepareStatus | null>(null)
  let agentBrowserRuntimeBusy = $state(false)
  let agentBrowserRuntimeError = $state<string | null>(null)
  let cloudflaredRuntimeStatus = $state<CloudflaredRuntimeStatus | null>(null)
  let cloudflaredAddonStatus = $state<RuntimeAddonPrepareStatus | null>(null)
  let cloudflaredBusy = $state(false)
  let cloudflaredError = $state<string | null>(null)
  let cloudflaredPlatform = $state<CloudflaredInstallPlatform>('darwin-x64')
  let runtimeContext = $state<RuntimeContextStatus | null>(null)
  let runtimeContextError = $state<string | null>(null)
  let n8nRuntimeStatus = $state<N8nRuntimeStatus | null>(null)
  let n8nRuntimeBusy = $state(false)
  let n8nRuntimeError = $state<string | null>(null)
  let macRuntimeReport = $state<MacRuntimeDoctorReport | null>(null)
  let macRuntimeBusy = $state<MacRuntimeAction | null>(null)
  let macRuntimeError = $state<string | null>(null)
  let macRuntimeBridgeAvailable = $state<boolean | null>(null)
  const macRuntimeRequiredItems = $derived.by<MacRuntimeRequiredItem[]>(() => {
    const tools = macRuntimeReport?.tools ?? {}
    const services = macRuntimeReport?.services ?? {}
    return [
      { key: 'node', label: 'Node.js', status: tools.node },
      { key: 'npm', label: 'npm', status: tools.npm },
      { key: 'redis', label: 'Redis', status: services.redis },
      { key: 'redisCli', label: 'redis-cli', status: tools.redisCli },
      { key: 'ffmpeg', label: 'FFmpeg', status: tools.ffmpeg },
      { key: 'appleContainer', label: 'Apple Container', optional: true, status: tools.appleContainer }
    ].filter((item) => item.status?.skipped !== true)
  })
  let sandboxRuntimeStatus = $state<SandboxRuntimeStatus | null>(null)
  let sandboxBusy = $state(false)
  let sandboxRecoverBusy = $state(false)
  let sandboxError = $state<string | null>(null)
  let appleSandboxRuntimeStatus = $state<SandboxRuntimeStatus | null>(null)
  let appleSandboxBusy = $state(false)
  let appleSandboxRecoverBusy = $state(false)
  let appleSandboxError = $state<string | null>(null)
  let openRuntimeCardId = $state<string | null>('agent-browser')
  let backupExportBusy = $state(false)
  let backupPreflightBusy = $state(false)
  let backupRestoreBusy = $state(false)
  let backupSelectedFile = $state<File | null>(null)
  let backupStageId = $state<string | null>(null)
  let backupStageProgress = $state<number | null>(null)
  let backupPreflight = $state<BackupPreflightSummary | null>(null)
  let backupError = $state<string | null>(null)
  let backupConfirmReplace = $state(false)
  let diagnosticsPreviewBusy = $state(false)
  let diagnosticsExportBusy = $state(false)
  let diagnosticsPreview = $state<DiagnosticsPreviewSummary | null>(null)
  let diagnosticsError = $state<string | null>(null)
  let diagnosticsCardOpen = $state(false)
  let diagnosticsSectionElement = $state<HTMLDivElement | null>(null)
  let lastHandledInitialSectionNonce = $state(-1)
  let goonAssetAuditBusy = $state(false)
  let goonAssetCleanupBusy = $state(false)
  let goonAssetAudit = $state<GoonAssetAuditSummary | null>(null)
  let goonAssetCleanupError = $state<string | null>(null)
  let coreSystemPrompts = $state<CoreSystemPromptSummary[]>([])
  let coreSystemPromptsLoading = $state(false)
  let coreSystemPromptsError = $state<string | null>(null)
  let corePromptEditorOpen = $state(false)
  let selectedCorePrompt = $state<CoreSystemPromptDetail | null>(null)
  let corePromptDraft = $state('')
  let corePromptBusyId = $state<string | null>(null)
  const webSearchProviderOptions = $derived.by<
    Array<{ value: NativeWebSearchProvider; label: string }>
  >(() => {
    const options: Array<{ value: NativeWebSearchProvider; label: string }> = [
      { value: 'duckduckgo-html', label: WEB_SEARCH_PROVIDER_LABELS['duckduckgo-html'] }
    ]
    if (availableWebSearchProviders.exa) {
      options.push({ value: 'exa', label: WEB_SEARCH_PROVIDER_LABELS.exa })
    }
    if (availableWebSearchProviders.perplexity) {
      options.push({ value: 'perplexity', label: WEB_SEARCH_PROVIDER_LABELS.perplexity })
    }
    if (adminSettings.webSearchDefaultProvider === 'exa' && !availableWebSearchProviders.exa) {
      options.push({ value: 'exa', label: `${WEB_SEARCH_PROVIDER_LABELS.exa} (key missing)` })
    }
    if (
      adminSettings.webSearchDefaultProvider === 'perplexity' &&
      !availableWebSearchProviders.perplexity
    ) {
      options.push({
        value: 'perplexity',
        label: `${WEB_SEARCH_PROVIDER_LABELS.perplexity} (key missing)`
      })
    }
    return options
  })

  onMount(async () => {
    await loadSettings()
    const context = await loadRuntimeContext()
    const runtimeLoads: Array<Promise<unknown>> = [
      loadCoreSystemPrompts(),
      loadWebSearchProviderAvailability(),
      loadFbxInstallStatus(),
      loadAgentBrowserRuntimeStatus(),
      loadCloudflaredRuntimeStatus(),
      loadN8nRuntimeStatus(),
      loadSandboxRuntimeStatus()
    ]

    if (context?.adminCards.appleContainerSandbox) {
      runtimeLoads.push(loadAppleSandboxRuntimeStatus())
    }
    if (context?.adminCards.macAppRequiredRuntime && updateMacRuntimeBridgeState()) {
      runtimeLoads.push(runMacRuntimeDoctor('doctor', { notify: false }))
    }

    await Promise.all(runtimeLoads)
  })

  function toggleRuntimeCard(id: string) {
    openRuntimeCardId = openRuntimeCardId === id ? null : id
  }

  function replaceCorePromptSummary(prompt: CoreSystemPromptDetail | CoreSystemPromptSummary) {
    coreSystemPrompts = coreSystemPrompts.map((entry) => (entry.id === prompt.id ? prompt : entry))
  }

  async function loadCoreSystemPrompts() {
    coreSystemPromptsLoading = true
    coreSystemPromptsError = null
    try {
      const response = await fetch('/api/admin/system-prompts')
      const result = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(result?.error || 'Failed to load core system prompts')
      }
      coreSystemPrompts = Array.isArray(result?.prompts) ? result.prompts : []
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load core system prompts'
      coreSystemPromptsError = message
      toast.error(message)
    } finally {
      coreSystemPromptsLoading = false
    }
  }

  async function openCorePromptEditor(id: string) {
    if (corePromptBusyId) return
    corePromptBusyId = id
    try {
      const response = await fetch(`/api/admin/system-prompts/${encodeURIComponent(id)}`)
      const result = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(result?.error || 'Failed to load core system prompt')
      }
      selectedCorePrompt = result.prompt
      corePromptDraft = result.prompt?.value ?? ''
      corePromptEditorOpen = true
      replaceCorePromptSummary(result.prompt)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load core system prompt')
    } finally {
      corePromptBusyId = null
    }
  }

  async function saveCorePrompt(value: string) {
    const prompt = selectedCorePrompt
    if (!prompt) return

    corePromptBusyId = prompt.id
    try {
      const response = await fetch(`/api/admin/system-prompts/${encodeURIComponent(prompt.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      })
      const result = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(result?.error || 'Failed to save core system prompt')
      }
      selectedCorePrompt = result.prompt
      corePromptDraft = result.prompt?.value ?? value
      replaceCorePromptSummary(result.prompt)
      toast.success('Core system prompt saved')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save core system prompt')
    } finally {
      corePromptBusyId = null
    }
  }

  async function resetCorePrompt(prompt: CoreSystemPromptSummary) {
    if (corePromptBusyId) return
    const confirmed = await confirmDialog({
      title: 'Reset Core Prompt?',
      description: [
        `${prompt.label} will be replaced with the packaged Batshit default.`,
        'Any custom edits for this prompt will be lost.'
      ],
      confirmLabel: 'Reset to Default',
      cancelLabel: 'Cancel'
    })
    if (!confirmed) return

    corePromptBusyId = prompt.id
    try {
      const response = await fetch(
        `/api/admin/system-prompts/${encodeURIComponent(prompt.id)}/reset`,
        { method: 'POST' }
      )
      const result = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(result?.error || 'Failed to reset core system prompt')
      }
      replaceCorePromptSummary(result.prompt)
      if (selectedCorePrompt?.id === prompt.id) {
        selectedCorePrompt = result.prompt
        corePromptDraft = result.prompt?.value ?? ''
      }
      toast.success('Core system prompt reset to Batshit default')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset core system prompt')
    } finally {
      corePromptBusyId = null
    }
  }

  const debouncedSave = debounce(async (payload: any) => {
    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save admin settings')
        throw new Error(message)
      }

      const result = await response.json()
      const updatedSettings: UserSettingsRow | null = result?.settings ?? null

      untrack(() => {
        persistedSignature = makeSignature(adminSettings)
        saveState = 'saved'
        saveError = null
      })

      if (updatedSettings) {
        setUserSettings(updatedSettings)
      }
    } catch (error) {
      console.error('Admin settings save failed:', error)
      untrack(() => {
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save admin settings'
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
    if (isLoading) return

    const signature = makeSignature(adminSettings)
    if (signature === persistedSignature) {
      return
    }

    saveState = 'saving'
    saveError = null

    debouncedSave({
      admin_settings: {
        n8n_execution_search_limit: adminSettings.n8nExecutionSearchLimit,
        dcm_schema_hint_required_limit: adminSettings.dcmSchemaHintRequiredLimit,
        dcm_schema_hint_optional_limit: adminSettings.dcmSchemaHintOptionalLimit,
        dcm_schema_hint_max_chars: adminSettings.dcmSchemaHintMaxChars,
        dcm_tool_name_threshold: adminSettings.dcmToolNameThreshold,
        goon_lip_sync_lab_enabled: adminSettings.goonLipSyncLabEnabled,
        web_search_default_provider: adminSettings.webSearchDefaultProvider,
        web_search_exa_type: adminSettings.webSearchExaType,
        web_search_perplexity_max_tokens_per_page:
          adminSettings.webSearchPerplexityMaxTokensPerPage
      },
      updated_at: new Date().toISOString()
    })
  })

  async function loadSettings() {
    try {
      const response = await fetch('/api/user/settings')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load admin settings')
        throw new Error(message)
      }

      const result = await response.json()
      const remoteSettings: UserSettingsRow | null = result?.settings ?? null

      applySettings(remoteSettings ?? data?.userSettings ?? null)

      if (remoteSettings) {
        setUserSettings(remoteSettings)
      }
    } catch (error) {
      console.error('Admin settings load failed:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to load admin settings')
      applySettings(data?.userSettings ?? null)
      untrack(() => {
        saveError = error instanceof Error ? error.message : 'Failed to load admin settings'
      })
    } finally {
      untrack(() => {
        isLoading = false
        persistedSignature = makeSignature(adminSettings)
      })
    }
  }

  async function loadFbxInstallStatus() {
    if (fbxInstallBusy) return
    fbxInstallBusy = true
    try {
      const res = await fetch('/api/goons/animations/converter')
      if (!res.ok) return
      const data = await res.json()
      fbxInstallStatus = data
      const addonRes = await fetch('/api/runtime-addons/fbx2vrma?prepare=1')
      if (addonRes.ok) {
        const addonData = await addonRes.json()
        fbxAddonStatus = addonData?.addon ?? null
      }
      if (data?.manifest?.platform) {
        fbxInstallPlatform = data.manifest.platform
      } else if (data?.defaultPlatform) {
        fbxInstallPlatform = data.defaultPlatform
      }
    } catch (error) {
      console.error('[AdminSettings] Failed to load FBX converter status:', error)
      toast.error('Failed to load FBX converter status')
    } finally {
      fbxInstallBusy = false
    }
  }

  async function handleFbxDockerAddonControl(operation: 'start' | 'stop') {
    if (fbxInstallBusy) return
    fbxInstallBusy = true
    let shouldRefresh = false
    try {
      const res = await fetch('/api/runtime-addons/fbx2vrma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation })
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || data?.success !== true) {
        throw new Error(data?.error || `Failed to ${operation} FBX-to-VRMA Docker worker`)
      }
      shouldRefresh = true
      toast.success(operation === 'start' ? 'FBX-to-VRMA worker started' : 'FBX-to-VRMA worker stopped')
    } catch (error: any) {
      toast.error(error?.message || `Failed to ${operation} FBX-to-VRMA Docker worker`)
    } finally {
      fbxInstallBusy = false
    }
    if (shouldRefresh) {
      await loadFbxInstallStatus()
    }
  }

  async function handleFbxInstall() {
    if (fbxInstallBusy) return
    fbxInstallBusy = true
    try {
      const res = await fetch('/api/goons/animations/converter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: fbxInstallPlatform })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || 'Failed to install FBX converter')
      }
      const data = await res.json()
      fbxInstallStatus = data
      toast.success('FBX converter installed')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to install FBX converter')
    } finally {
      fbxInstallBusy = false
    }
  }

  async function handleFbxUninstall() {
    if (fbxInstallBusy) return
    fbxInstallBusy = true
    try {
      const res = await fetch('/api/goons/animations/converter', {
        method: 'DELETE'
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || 'Failed to uninstall FBX converter')
      }
      const data = await res.json()
      fbxInstallStatus = data
      toast.success('FBX converter uninstalled')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to uninstall FBX converter')
    } finally {
      fbxInstallBusy = false
    }
  }

  async function loadAgentBrowserRuntimeStatus() {
    if (agentBrowserRuntimeBusy) return
    agentBrowserRuntimeBusy = true
    agentBrowserRuntimeError = null

    try {
      const response = await fetch('/api/native-tools/agent-browser/runtime')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load Agent Browser runtime status')
        throw new Error(message)
      }
      const payload = (await response.json()) as AgentBrowserRuntimeStatus
      agentBrowserRuntimeStatus = payload
      if (payload.supportLevel === 'docker-sidecar' || payload.installScope === 'docker-sidecar') {
        const addonResponse = await fetch('/api/runtime-addons/agent-browser?prepare=1')
        if (addonResponse.ok) {
          const addonPayload = await addonResponse.json()
          agentBrowserAddonStatus = addonPayload?.addon ?? null
        }
      } else {
        agentBrowserAddonStatus = null
      }
    } catch (error) {
      console.error('[AdminSettings] Failed to load Agent Browser runtime status:', error)
      agentBrowserRuntimeStatus = null
      agentBrowserAddonStatus = null
      agentBrowserRuntimeError =
        error instanceof Error ? error.message : 'Failed to load Agent Browser runtime status'
    } finally {
      agentBrowserRuntimeBusy = false
    }
  }

  async function handleAgentBrowserDockerAddonControl(operation: 'start' | 'stop') {
    if (agentBrowserRuntimeBusy) return
    agentBrowserRuntimeBusy = true
    agentBrowserRuntimeError = null
    let shouldRefresh = false

    try {
      const response = await fetch('/api/runtime-addons/agent-browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error || `Failed to ${operation} Agent Browser sidecar`)
      }
      shouldRefresh = true
      toast.success(operation === 'start' ? 'Agent Browser sidecar started' : 'Agent Browser sidecar stopped')
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to ${operation} Agent Browser sidecar`
      agentBrowserRuntimeError = message
      toast.error(message)
    } finally {
      agentBrowserRuntimeBusy = false
    }

    if (shouldRefresh) {
      await loadAgentBrowserRuntimeStatus()
    }
  }

  async function handleAgentBrowserInstall() {
    if (agentBrowserRuntimeBusy) return
    agentBrowserRuntimeBusy = true
    agentBrowserRuntimeError = null

    try {
      const response = await fetch('/api/native-tools/agent-browser/runtime', {
        method: 'POST'
      })
      const payload = await response.json().catch(() => null)
      const installed = payload?.installed === true
      if (!response.ok || !installed) {
        throw new Error(payload?.reason || payload?.error || 'Failed to install Agent Browser runtime')
      }
      agentBrowserRuntimeStatus = payload as AgentBrowserRuntimeStatus
      toast.success('Agent Browser runtime installed')
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to install Agent Browser runtime'
      agentBrowserRuntimeError = message
      toast.error(message)
    } finally {
      agentBrowserRuntimeBusy = false
    }
  }

  async function handleAgentBrowserUninstall() {
    if (agentBrowserRuntimeBusy) return
    agentBrowserRuntimeBusy = true
    agentBrowserRuntimeError = null

    try {
      const response = await fetch('/api/native-tools/agent-browser/runtime', {
        method: 'DELETE'
      })
      const payload = await response.json().catch(() => null)
      const uninstalled = payload?.uninstalled === true
      if (!response.ok || !uninstalled) {
        throw new Error(
          payload?.reason || payload?.error || 'Failed to uninstall Agent Browser runtime'
        )
      }
      agentBrowserRuntimeStatus = {
        ...(agentBrowserRuntimeStatus ?? {
          command: null,
          version: null,
          reason: null,
          installCommand:
            payload?.installCommand ?? 'Use Settings -> Admin -> Agent Browser Runtime',
          installHelp:
            payload?.installHelp ??
            'Install exact tested version from Settings -> Admin -> Agent Browser Runtime.'
        }),
        installed: false,
        command: payload?.command ?? null,
        version: payload?.version ?? null,
        reason: payload?.reason ?? null
      }
      toast.success('Agent Browser runtime uninstalled')
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to uninstall Agent Browser runtime'
      agentBrowserRuntimeError = message
      toast.error(message)
    } finally {
      agentBrowserRuntimeBusy = false
    }
  }

  async function loadCloudflaredRuntimeStatus() {
    if (cloudflaredBusy) return
    cloudflaredBusy = true
    cloudflaredError = null

    try {
      const response = await fetch('/api/native-tools/cloudflared/runtime')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load Cloudflared runtime status')
        throw new Error(message)
      }
      const payload = (await response.json()) as CloudflaredRuntimeStatus
      cloudflaredRuntimeStatus = payload
      const addonResponse = await fetch('/api/runtime-addons/cloudflared?prepare=1')
      if (addonResponse.ok) {
        const addonPayload = await addonResponse.json()
        cloudflaredAddonStatus = addonPayload?.addon ?? null
      }
      if (payload.defaultPlatform) {
        cloudflaredPlatform = payload.defaultPlatform
      }
    } catch (error) {
      console.error('[AdminSettings] Failed to load Cloudflared runtime status:', error)
      cloudflaredRuntimeStatus = null
      cloudflaredError =
        error instanceof Error ? error.message : 'Failed to load Cloudflared runtime status'
    } finally {
      cloudflaredBusy = false
    }
  }

  async function loadRuntimeContext(): Promise<RuntimeContextStatus | null> {
    runtimeContextError = null

    try {
      const response = await fetch('/api/runtime/context')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load runtime context')
        throw new Error(message)
      }
      const payload = (await response.json()) as RuntimeContextStatus
      runtimeContext = payload
      if (
        payload.adminCards.macAppRequiredRuntime &&
        openRuntimeCardId === 'agent-browser'
      ) {
        openRuntimeCardId = 'mac-required'
      }
      if (!payload.adminCards.appleContainerSandbox) {
        appleSandboxRuntimeStatus = null
        appleSandboxError = null
      }
      return payload
    } catch (error) {
      console.error('[AdminSettings] Failed to load runtime context:', error)
      runtimeContext = null
      runtimeContextError =
        error instanceof Error ? error.message : 'Failed to load runtime context'
      return null
    }
  }

  type ZeroNativeBridge = {
    invoke?: (command: string, payload?: Record<string, unknown>) => Promise<unknown>
  }

  function getZeroNativeBridge(): ZeroNativeBridge | undefined {
    return (window as Window & { zero?: ZeroNativeBridge }).zero
  }

  function updateMacRuntimeBridgeState() {
    macRuntimeBridgeAvailable = Boolean(getZeroNativeBridge()?.invoke)
    return macRuntimeBridgeAvailable
  }

  function unwrapMacRuntimeResponse(value: unknown): unknown {
    if (
      value &&
      typeof value === 'object' &&
      'result' in value &&
      value.result &&
      typeof value.result === 'object'
    ) {
      return value.result
    }
    return value
  }

  function applyMacRuntimeResult(value: unknown, fallbackError: string) {
    const unwrapped = unwrapMacRuntimeResponse(value)
    if (!unwrapped || typeof unwrapped !== 'object') {
      macRuntimeError = fallbackError
      return
    }
    const payload = unwrapped as Record<string, unknown>
    const next =
      payload.status && typeof payload.status === 'object'
        ? (payload.status as MacRuntimeDoctorReport)
        : (payload as MacRuntimeDoctorReport)

    macRuntimeReport = next
    if (payload.success === false || (next.ok === false && next.error)) {
      macRuntimeError =
        (typeof payload.error === 'string' && payload.error) ||
        next.error ||
        fallbackError
    }
  }

  async function runMacRuntimeDoctor(
    action: MacRuntimeAction,
    options: { notify?: boolean } = {}
  ) {
    if (macRuntimeBusy) return
    const notify = options.notify ?? true
    macRuntimeBusy = action
    macRuntimeError = null

    try {
      const bridge = getZeroNativeBridge()
      if (!bridge?.invoke) {
        macRuntimeBridgeAvailable = false
        throw new Error('Runtime Doctor controls are available inside Batshit.app.')
      }
      macRuntimeBridgeAvailable = true
      const value = await bridge.invoke(macRuntimeCommands[action], {})
      applyMacRuntimeResult(value, `Runtime Doctor ${action} failed.`)
      if (notify && action !== 'doctor' && !macRuntimeError) {
        toast.success(action === 'restart' ? 'Mac runtime restarted' : 'Mac runtime updated')
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Runtime Doctor ${action} failed.`
      macRuntimeError = message
      if (notify) toast.error(message)
    } finally {
      macRuntimeBusy = null
    }
  }

  async function loadN8nRuntimeStatus() {
    if (n8nRuntimeBusy) return
    n8nRuntimeBusy = true
    n8nRuntimeError = null

    try {
      const response = await fetch('/api/native-tools/n8n/runtime')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load n8n runtime status')
        throw new Error(message)
      }
      n8nRuntimeStatus = (await response.json()) as N8nRuntimeStatus
    } catch (error) {
      console.error('[AdminSettings] Failed to load n8n runtime status:', error)
      n8nRuntimeStatus = null
      n8nRuntimeError =
        error instanceof Error ? error.message : 'Failed to load n8n runtime status'
    } finally {
      n8nRuntimeBusy = false
    }
  }

  async function handleCloudflaredDockerAddonControl(operation: 'start' | 'stop') {
    if (cloudflaredBusy) return
    cloudflaredBusy = true
    cloudflaredError = null
    let shouldRefresh = false

    try {
      const response = await fetch('/api/runtime-addons/cloudflared', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error || `Failed to ${operation} Cloudflared sidecar`)
      }
      shouldRefresh = true
      toast.success(operation === 'start' ? 'Cloudflared sidecar started' : 'Cloudflared sidecar stopped')
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to ${operation} Cloudflared sidecar`
      cloudflaredError = message
      toast.error(message)
    } finally {
      cloudflaredBusy = false
    }

    if (shouldRefresh) {
      await loadCloudflaredRuntimeStatus()
    }
  }

  async function handleCloudflaredInstall() {
    if (cloudflaredBusy) return
    cloudflaredBusy = true
    cloudflaredError = null

    try {
      const response = await fetch('/api/native-tools/cloudflared/runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: cloudflaredPlatform })
      })
      const payload = await response.json().catch(() => null)
      const installed = payload?.installed === true
      if (!response.ok || !installed) {
        throw new Error(payload?.reason || payload?.error || 'Failed to install Cloudflared runtime')
      }
      cloudflaredRuntimeStatus = payload as CloudflaredRuntimeStatus
      toast.success('Cloudflared runtime installed')
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to install Cloudflared runtime'
      cloudflaredError = message
      toast.error(message)
    } finally {
      cloudflaredBusy = false
    }
  }

  async function handleCloudflaredUninstall() {
    if (cloudflaredBusy) return
    cloudflaredBusy = true
    cloudflaredError = null

    try {
      const response = await fetch('/api/native-tools/cloudflared/runtime', {
        method: 'DELETE'
      })
      const payload = await response.json().catch(() => null)
      const uninstalled = payload?.uninstalled === true
      if (!response.ok || !uninstalled) {
        throw new Error(payload?.reason || payload?.error || 'Failed to uninstall Cloudflared runtime')
      }
      cloudflaredRuntimeStatus = payload?.status as CloudflaredRuntimeStatus
      if (typeof payload?.reason === 'string' && payload.reason.trim().length > 0) {
        toast.success(payload.reason)
      } else {
        toast.success('Cloudflared runtime uninstalled')
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to uninstall Cloudflared runtime'
      cloudflaredError = message
      toast.error(message)
    } finally {
      cloudflaredBusy = false
    }
  }

  async function loadSandboxRuntimeStatus() {
    if (sandboxBusy) return
    sandboxBusy = true
    sandboxError = null

    try {
      const response = await fetch('/api/native-tools/sandbox/status')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load sandbox status')
        throw new Error(message)
      }
      const payload = (await response.json()) as SandboxRuntimeStatus
      sandboxRuntimeStatus = payload
    } catch (error) {
      console.error('[AdminSettings] Failed to load sandbox status:', error)
      sandboxRuntimeStatus = null
      sandboxError = error instanceof Error ? error.message : 'Failed to load sandbox status'
    } finally {
      sandboxBusy = false
    }
  }

  async function loadAppleSandboxRuntimeStatus() {
    if (appleSandboxBusy) return
    appleSandboxBusy = true
    appleSandboxError = null

    try {
      const response = await fetch('/api/native-tools/sandbox/status?backend=apple_container')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load Apple Container status')
        throw new Error(message)
      }
      const payload = (await response.json()) as SandboxRuntimeStatus
      appleSandboxRuntimeStatus = payload
    } catch (error) {
      console.error('[AdminSettings] Failed to load Apple Container status:', error)
      appleSandboxRuntimeStatus = null
      appleSandboxError =
        error instanceof Error ? error.message : 'Failed to load Apple Container status'
    } finally {
      appleSandboxBusy = false
    }
  }

  async function handleSandboxRecover() {
    if (sandboxRecoverBusy) return
    sandboxRecoverBusy = true
    sandboxError = null

    try {
      const response = await fetch('/api/native-tools/sandbox/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error?.message || payload?.error || 'Failed to recover sandbox')
      }

      sandboxRuntimeStatus = payload?.status ?? null
      const workspace = payload?.workspaceRoot
      if (typeof workspace === 'string' && workspace.trim().length > 0) {
        toast.success(`Sandbox recovered (${workspace})`)
      } else {
        toast.success('Sandbox recovered')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to recover sandbox'
      sandboxError = message
      toast.error(message)
    } finally {
      sandboxRecoverBusy = false
      await loadSandboxRuntimeStatus()
    }
  }

  async function handleAppleSandboxRecover() {
    if (appleSandboxRecoverBusy) return
    appleSandboxRecoverBusy = true
    appleSandboxError = null

    try {
      const response = await fetch('/api/native-tools/sandbox/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: 'apple_container' })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error?.message || payload?.error || 'Failed to start Apple Container')
      }

      appleSandboxRuntimeStatus = payload?.status ?? null
      toast.success('Apple Container sandbox ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start Apple Container'
      appleSandboxError = message
      toast.error(message)
    } finally {
      appleSandboxRecoverBusy = false
      await loadAppleSandboxRuntimeStatus()
    }
  }

  function isSandboxOperatorRequired() {
    return (
      sandboxRuntimeStatus?.containerized === true &&
      sandboxRuntimeStatus.available !== true &&
      sandboxRuntimeStatus.dockerUnsupported !== true
    )
  }

  function canRecoverSandbox() {
    return sandboxRuntimeStatus?.available === true
  }

  function sandboxRecoverLabel() {
    if (sandboxRuntimeStatus?.containerized) {
      return sandboxRecoverBusy ? 'Repairing…' : 'Repair Sandbox'
    }
    return sandboxRecoverBusy ? 'Recovering…' : 'Recover Sandbox'
  }

  function appleSandboxRecoverLabel() {
    if (appleSandboxRuntimeStatus?.installed === false) return 'Install Required'
    return appleSandboxRecoverBusy ? 'Starting…' : 'Start Apple Container'
  }

  function macRuntimeActionTone(action: MacRuntimeDoctorAction): RuntimeStatusTone {
    if (action.severity === 'blocker') return 'bad'
    if (action.severity === 'repairable') return 'warning'
    return 'warning'
  }

  function macRuntimeSummaryTone(): RuntimeStatusTone {
    if (macRuntimeBusy) return 'checking'
    if (macRuntimeReport?.ok) return 'ok'
    if (macRuntimeReport) return 'warning'
    if (macRuntimeBridgeAvailable === false || macRuntimeError) return 'warning'
    return 'checking'
  }

  function macRuntimeSummaryLabel() {
    if (macRuntimeBusy) return 'Checking…'
    if (macRuntimeReport?.ok) return 'Ready'
    if (macRuntimeReport) return 'Needs Attention'
    if (macRuntimeBridgeAvailable === false) return 'Open In App'
    return 'Not Checked'
  }

  function macRuntimeItemTone(item: MacRuntimeRequiredItem): RuntimeStatusTone {
    const status = item.status
    if (status?.healthy === true || (status?.healthy === undefined && status?.available)) {
      return 'ok'
    }
    if (item.optional) return 'warning'
    return 'bad'
  }

  function macRuntimeItemLabel(item: MacRuntimeRequiredItem) {
    const status = item.status
    if (status?.healthy === true || (status?.healthy === undefined && status?.available)) {
      return 'Ready'
    }
    if (item.optional) return 'Optional'
    return 'Needs setup'
  }

  async function loadWebSearchProviderAvailability() {
    if (webSearchProvidersLoading) return
    webSearchProvidersLoading = true
    webSearchProvidersError = null

    try {
      const response = await fetch('/api/settings/api-keys')
      if (!response.ok) {
        const message = await extractError(
          response,
          'Failed to load web search provider key status'
        )
        throw new Error(message)
      }

      const payload = await response.json()
      const keys = payload?.keys ?? {}
      const nextAvailability = {
        exa: keys?.exa?.status === 'ready',
        perplexity: keys?.perplexity?.status === 'ready'
      }
      availableWebSearchProviders = nextAvailability

      const normalizedProvider = normalizeWebSearchProviderForAvailability(
        adminSettings.webSearchDefaultProvider,
        nextAvailability
      )
      if (normalizedProvider !== adminSettings.webSearchDefaultProvider) {
        adminSettings.webSearchDefaultProvider = normalizedProvider
      }
    } catch (error) {
      console.error('Failed to load web search provider availability:', error)
      webSearchProvidersError =
        error instanceof Error
          ? error.message
          : 'Failed to load web search provider key status'
      availableWebSearchProviders = {
        exa: false,
        perplexity: false
      }
    } finally {
      webSearchProvidersLoading = false
    }
  }

  async function handleBackupExport(includeSecrets = false) {
    if (backupExportBusy) return
    if (includeSecrets) {
      const confirmed = await confirmDialog({
        title: 'Export Backup With Secrets?',
        description: [
          'This backup may contain saved API keys, tokens, webhook auth, and other private connection details.',
          'Store it somewhere private. Only use this when you intentionally need a full instance transfer.'
        ],
        confirmLabel: 'Export With Secrets',
        cancelLabel: 'Cancel'
      })
      if (!confirmed) return
    }

    backupExportBusy = true
    backupError = null
    try {
      const nativeResult = await exportBackupNatively(includeSecrets)
      if (nativeResult) {
        if (!nativeResult.canceled) {
          toast.success(includeSecrets ? 'Backup with secrets exported' : 'Backup exported')
        }
        return
      }

      const response = await fetch('/api/admin/backup/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          includeSecrets,
          confirmIncludeSecrets: includeSecrets
        })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to export backup')
        throw new Error(message)
      }

      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const filenameMatch = disposition.match(/filename="([^"]+)"/)
      const filename = filenameMatch?.[1] ?? 'batshit-backup.zip'
      const result = await downloadBlob(blob, filename, {
        title: 'Export Batshit Backup',
        mimeType: 'application/zip'
      })
      if (!result.canceled) {
        toast.success(includeSecrets ? 'Backup with secrets exported' : 'Backup exported')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export backup'
      backupError = message
      toast.error(message)
    } finally {
      backupExportBusy = false
    }
  }

  async function handleDiagnosticsPreview() {
    if (diagnosticsPreviewBusy) return

    diagnosticsPreviewBusy = true
    diagnosticsError = null
    try {
      const response = await fetch('/api/admin/diagnostics/preview')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to preview diagnostics')
        throw new Error(message)
      }

      const result = await response.json()
      if (!result?.preview) {
        throw new Error('Diagnostics preview did not return preview data')
      }
      diagnosticsPreview = result.preview as DiagnosticsPreviewSummary
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to preview diagnostics'
      diagnosticsError = message
      toast.error(message)
    } finally {
      diagnosticsPreviewBusy = false
    }
  }

  async function handleDiagnosticsExport() {
    if (diagnosticsExportBusy) return
    if (!diagnosticsPreview) {
      await handleDiagnosticsPreview()
      return
    }

    diagnosticsExportBusy = true
    diagnosticsError = null
    try {
      const response = await fetch('/api/admin/diagnostics/export', {
        method: 'POST'
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to export diagnostics')
        throw new Error(message)
      }

      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const filenameMatch = disposition.match(/filename="([^"]+)"/)
      const filename = filenameMatch?.[1] ?? diagnosticsPreview.filename ?? 'batshit-diagnostics.zip'
      const result = await downloadBlob(blob, filename, {
        title: 'Export Batshit Diagnostics',
        mimeType: 'application/zip'
      })
      if (!result.canceled) {
        toast.success('Diagnostics exported')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export diagnostics'
      diagnosticsError = message
      toast.error(message)
    } finally {
      diagnosticsExportBusy = false
    }
  }

  $effect(() => {
    if (initialSection !== 'diagnostics') return
    if (initialSectionNonce === lastHandledInitialSectionNonce) return

    lastHandledInitialSectionNonce = initialSectionNonce
    diagnosticsCardOpen = true

    void tick().then(() => {
      diagnosticsSectionElement?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      if (initialAction === 'preview') {
        void handleDiagnosticsPreview()
      }
    })
  })

  async function handleBackupFileSelected(event: Event) {
    const input = event.target as HTMLInputElement
    backupSelectedFile = input.files?.[0] ?? null
    backupPreflight = null
    backupStageId = null
    backupStageProgress = null
    backupConfirmReplace = false
    backupError = null

    if (backupSelectedFile) {
      await handleBackupPreflight()
    }
  }

  async function stageBackupFile(file: File) {
    const ticketResponse = await fetch('/api/admin/backup/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, bytes: file.size })
    })
    if (!ticketResponse.ok) {
      throw new Error(await extractError(ticketResponse, 'Failed to prepare backup staging'))
    }
    const ticket = await ticketResponse.json()
    if (!ticket?.stageId || !ticket?.ticket || !ticket?.uploadUrl) {
      throw new Error('Backup staging did not return a usable upload ticket')
    }

    backupStageProgress = 0
    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open('PUT', ticket.uploadUrl)
      request.setRequestHeader('Content-Type', 'application/zip')
      request.setRequestHeader('x-batshit-upload-ticket', ticket.ticket)
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return
        backupStageProgress = Math.min(99, Math.round((event.loaded / event.total) * 100))
      }
      request.onerror = () => reject(new Error('Backup staging connection failed'))
      request.onabort = () => reject(new Error('Backup staging was canceled'))
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          backupStageProgress = 100
          resolve()
          return
        }
        let message = 'Failed to stage backup'
        try {
          message = JSON.parse(request.responseText)?.error || message
        } catch {
          // Keep the stable fallback when the server did not return JSON.
        }
        reject(new Error(message))
      }
      request.send(file)
    })
    backupStageId = ticket.stageId
    return ticket.stageId as string
  }

  async function handleBackupPreflight() {
    if (!backupSelectedFile || backupPreflightBusy) return
    backupPreflightBusy = true
    backupError = null
    try {
      const stageId = backupStageId ?? (await stageBackupFile(backupSelectedFile))
      const response = await fetch('/api/admin/backup/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId })
      })
      if (!response.ok) {
        const message = await extractError(response, 'Failed to inspect backup')
        throw new Error(message)
      }
      backupPreflight = (await response.json()) as BackupPreflightSummary
      toast.success('Backup inspected')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to inspect backup'
      backupError = message
      toast.error(message)
    } finally {
      backupPreflightBusy = false
      if (backupStageProgress === 100) backupStageProgress = null
    }
  }

  async function handleBackupRestore() {
    if (!backupSelectedFile || !backupStageId || backupRestoreBusy) return
    if (backupPreflight?.requiresDestructiveConfirmation && !backupConfirmReplace) {
      backupError = 'Confirm replace-current-data before restoring this backup.'
      return
    }

    backupRestoreBusy = true
    backupError = null
    try {
      const response = await fetch('/api/admin/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageId: backupStageId,
          confirmReplace: backupConfirmReplace
        })
      })
      if (!response.ok) {
        const message = await extractError(response, 'Failed to restore backup')
        throw new Error(message)
      }
      await response.json().catch(() => null)
      toast.success('Backup restored. Reloading Batshit...')
      window.setTimeout(() => {
        window.location.reload()
      }, 900)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore backup'
      backupError = message
      toast.error(message)
    } finally {
      backupRestoreBusy = false
    }
  }

	  async function loadGoonAssetAudit(showToast = true) {
	    if (goonAssetAuditBusy || goonAssetCleanupBusy) return
	    goonAssetAuditBusy = true
	    goonAssetCleanupError = null
	    try {
	      const response = await fetch('/api/admin/goon-assets')
	      if (!response.ok) {
	        const message = await extractError(response, 'Failed to inspect Goon assets')
	        throw new Error(message)
	      }

	      const result = await response.json()
	      goonAssetAudit = result?.audit ?? null
	      if (showToast) {
	        toast.success('Goon assets inspected')
	      }
	    } catch (error) {
	      const message = error instanceof Error ? error.message : 'Failed to inspect Goon assets'
	      goonAssetCleanupError = message
	      toast.error(message)
	    } finally {
	      goonAssetAuditBusy = false
	    }
	  }

	  async function handleGoonAssetCleanup() {
	    if (goonAssetCleanupBusy || goonAssetAuditBusy) return
	    if (!goonAssetAudit) {
	      await loadGoonAssetAudit(false)
	    }
	    if (!goonAssetAudit || goonAssetAudit.orphanRecordCount <= 0) {
	      toast.success('No orphaned Goon assets found')
	      return
	    }

	    const confirmed = await confirmDialog({
	      title: 'Clean Orphaned Goon Assets?',
	      description: [
	        'Batshit will delete only uploaded Goon files and upload records that are not referenced by current Goons, Motion Vault, Closet, or Scenes.',
	        `This will remove ${goonAssetAudit.orphanRecordCount} orphaned record${
	          goonAssetAudit.orphanRecordCount === 1 ? '' : 's'
	        } (${formatBackupBytes(goonAssetAudit.orphanBytes)}).`
	      ],
	      confirmLabel: 'Clean Orphans',
	      cancelLabel: 'Cancel'
	    })
	    if (!confirmed) return

	    goonAssetCleanupBusy = true
	    goonAssetCleanupError = null
	    try {
	      const response = await fetch('/api/admin/goon-assets', {
	        method: 'POST',
	        headers: { 'Content-Type': 'application/json' },
	        body: JSON.stringify({ confirmDeleteOrphans: true })
	      })
	      const result = await response.json().catch(() => null)
	      if (!response.ok) {
	        throw new Error(result?.error || 'Failed to clean up Goon assets')
	      }

	      const cleanup: GoonAssetCleanupResult | null = result?.cleanup ?? null
	      const deletedCount = cleanup?.deletedCount ?? 0
	      toast.success(
	        deletedCount > 0
	          ? `Cleaned ${deletedCount} orphaned Goon asset${deletedCount === 1 ? '' : 's'}`
	          : 'No orphaned Goon assets found'
	      )
	      await loadGoonAssetAudit(false)
	    } catch (error) {
	      const message = error instanceof Error ? error.message : 'Failed to clean up Goon assets'
	      goonAssetCleanupError = message
	      toast.error(message)
	    } finally {
	      goonAssetCleanupBusy = false
	    }
	  }


	  function applySettings(settings: UserSettingsRow | null) {
    const next = normaliseAdminSettings(settings)
    untrack(() => {
      adminSettings = next
    })
  }

  function normaliseAdminSettings(settings?: UserSettingsRow | null): AdminSettingsState {
    const admin = (settings?.admin_settings as Record<string, any>) ?? {}
    return {
      n8nExecutionSearchLimit: clampNumber(
        admin.n8n_execution_search_limit ?? DEFAULT_N8N_EXECUTION_SEARCH_LIMIT,
        1,
        MAX_N8N_EXECUTION_SEARCH_LIMIT
      ),
      dcmSchemaHintRequiredLimit: clampNumber(
        admin.dcm_schema_hint_required_limit ?? DEFAULT_DCM_SCHEMA_HINT_REQUIRED_LIMIT,
        1,
        MAX_DCM_SCHEMA_HINT_LIMIT
      ),
      dcmSchemaHintOptionalLimit: clampNumber(
        admin.dcm_schema_hint_optional_limit ?? DEFAULT_DCM_SCHEMA_HINT_OPTIONAL_LIMIT,
        0,
        MAX_DCM_SCHEMA_HINT_LIMIT
      ),
      dcmSchemaHintMaxChars: clampNumber(
        admin.dcm_schema_hint_max_chars ?? DEFAULT_DCM_SCHEMA_HINT_MAX_CHARS,
        MIN_DCM_SCHEMA_HINT_MAX_CHARS,
        MAX_DCM_SCHEMA_HINT_MAX_CHARS
      ),
      dcmToolNameThreshold: clampNumber(
        admin.dcm_tool_name_threshold ?? DEFAULT_DCM_TOOL_NAME_THRESHOLD,
        1,
        MAX_DCM_TOOL_NAME_THRESHOLD
      ),
      goonLipSyncLabEnabled:
        typeof admin.goon_lip_sync_lab_enabled === 'boolean'
          ? admin.goon_lip_sync_lab_enabled
          : DEFAULT_GOON_LIP_SYNC_LAB_ENABLED,
      webSearchDefaultProvider: normalizeWebSearchProvider(
        admin.web_search_default_provider
      ),
      webSearchExaType: normalizeExaSearchType(
        admin.web_search_exa_type ?? admin.webSearchExaType
      ),
      webSearchPerplexityMaxTokensPerPage: clampNumber(
        admin.web_search_perplexity_max_tokens_per_page ??
          admin.webSearchPerplexityMaxTokensPerPage ??
          DEFAULT_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE,
        WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS[0],
        WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS[
          WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS.length - 1
        ]
      )
    }
  }

  function makeSignature(state: AdminSettingsState) {
    return JSON.stringify(state)
  }

  function n8nUrlSourceLabel(source?: N8nRuntimeStatus['urlSource']) {
    if (source === 'saved-api-url') return 'Settings -> API Keys'
    if (source === 'runtime-env') return 'Runtime environment'
    return 'Default localhost'
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const result = await response.json()
      if (typeof result?.error === 'string') return result.error
    } catch (err) {
      // ignore
    }

    try {
      const text = await response.text()
      if (text) return text
    } catch (err) {
      // ignore
    }

    return fallback
  }
	</script>

<div class="batshit-settings-surface">
  <div class="space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-center gap-1.5">
        <ShieldCheck class="h-4 w-4 text-primary" />
        <h3 class="batshit-settings-section-title">Admin</h3>
        <SettingsInfoMenu ariaLabel="About Admin Settings" contentClass="w-80">
          <p>
            These are advanced Batshit-wide controls for runtime installs, search defaults, and
            prompt-size tuning. Most users can ignore this panel.
          </p>
        </SettingsInfoMenu>
      </div>
      <SettingsSaveStatus
        state={saveError ? 'error' : saveState}
        error={saveError}
        savedLabel="Admin Settings Saved"
        sticky={false}
      />
    </div>

    <AutoCompactSettingsCard data={data} accordionName="admin-settings-cards" open />

    <AdminCoreSystemPromptsCard
      prompts={coreSystemPrompts}
      loading={coreSystemPromptsLoading}
      error={coreSystemPromptsError}
      busyId={corePromptBusyId}
      onRetry={loadCoreSystemPrompts}
      onEdit={openCorePromptEditor}
      onReset={resetCorePrompt}
    />

    <AdminBackupRestoreCard
      exportBusy={backupExportBusy}
      preflightBusy={backupPreflightBusy}
      stageProgress={backupStageProgress}
      restoreBusy={backupRestoreBusy}
      selectedFile={backupSelectedFile}
      preflight={backupPreflight}
      error={backupError}
      confirmReplace={backupConfirmReplace}
      onConfirmReplaceChange={(checked) => (backupConfirmReplace = checked)}
      onExport={handleBackupExport}
      onFileSelected={handleBackupFileSelected}
      onPreflight={handleBackupPreflight}
      onRestore={handleBackupRestore}
    />

    <div bind:this={diagnosticsSectionElement}>
      <AdminDiagnosticsCard
        open={diagnosticsCardOpen}
        openNonce={initialSectionNonce}
        previewBusy={diagnosticsPreviewBusy}
        exportBusy={diagnosticsExportBusy}
        preview={diagnosticsPreview}
        error={diagnosticsError}
        onPreview={handleDiagnosticsPreview}
        onExport={handleDiagnosticsExport}
      />
    </div>

    <AdminGoonAssetCleanupCard
      auditBusy={goonAssetAuditBusy}
      cleanupBusy={goonAssetCleanupBusy}
      audit={goonAssetAudit}
      error={goonAssetCleanupError}
      onInspect={loadGoonAssetAudit}
      onCleanup={handleGoonAssetCleanup}
    />

    <AdminUtilityCards
      goonLipSyncLabEnabled={adminSettings.goonLipSyncLabEnabled}
      n8nExecutionSearchLimit={adminSettings.n8nExecutionSearchLimit}
      disabled={isLoading}
      onGoonLipSyncLabEnabledChange={(checked) =>
        (adminSettings.goonLipSyncLabEnabled = checked)}
      onN8nExecutionSearchLimitChange={(value) =>
        (adminSettings.n8nExecutionSearchLimit = value)}
    />

    <AdminWebSearchCard
      defaultProvider={adminSettings.webSearchDefaultProvider}
      exaType={adminSettings.webSearchExaType}
      perplexityMaxTokensPerPage={adminSettings.webSearchPerplexityMaxTokensPerPage}
      providerOptions={webSearchProviderOptions}
      providerAvailability={availableWebSearchProviders}
      loadingProviders={webSearchProvidersLoading}
      providerError={webSearchProvidersError}
      disabled={isLoading}
      onProviderChange={(provider) => (adminSettings.webSearchDefaultProvider = provider)}
      onExaTypeChange={(exaType) => (adminSettings.webSearchExaType = exaType)}
      onPerplexityMaxTokensPerPageChange={(tokens) =>
        (adminSettings.webSearchPerplexityMaxTokensPerPage = tokens)}
    />

    <AdminDynamicSchemaHintsCard
      requiredLimit={adminSettings.dcmSchemaHintRequiredLimit}
      optionalLimit={adminSettings.dcmSchemaHintOptionalLimit}
      toolNameThreshold={adminSettings.dcmToolNameThreshold}
      maxChars={adminSettings.dcmSchemaHintMaxChars}
      disabled={isLoading}
      onRequiredLimitChange={(value) => (adminSettings.dcmSchemaHintRequiredLimit = value)}
      onOptionalLimitChange={(value) => (adminSettings.dcmSchemaHintOptionalLimit = value)}
      onToolNameThresholdChange={(value) => (adminSettings.dcmToolNameThreshold = value)}
      onMaxCharsChange={(value) => (adminSettings.dcmSchemaHintMaxChars = value)}
    />

    <SettingsAccordionCard
      name="admin-settings-cards"
      title="Runtimes"
      icon={Download}
      contentClass="space-y-3"
    >
      {#snippet info()}
        <SettingsInfoMenu ariaLabel="About Runtimes" contentClass="w-80">
          <p>
            Batshit-managed installs and health checks for local helper runtimes live here. Only
            one runtime section opens at a time.
          </p>
        </SettingsInfoMenu>
      {/snippet}
        <div class="space-y-3">
          {#if runtimeContextError}
            <p class="batshit-settings-form-help is-danger">{runtimeContextError}</p>
          {/if}

          <div class="batshit-settings-disclosure-row">
            <Collapsible.Root open={openRuntimeCardId === 'n8n'}>
              <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
                <div class="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
                    aria-expanded={openRuntimeCardId === 'n8n'}
                    onclick={() => toggleRuntimeCard('n8n')}
                  >
                    n8n Runtime
                  </button>
                  <SettingsInfoMenu ariaLabel="About n8n Runtime" contentClass="w-80">
                    <p>
                      Status for the n8n instance Batshit will call for n8n agents, workflow
                      inspection, and Execution Viewer hydration.
                    </p>
                  </SettingsInfoMenu>
                </div>
                <button
                  type="button"
                  class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
                  aria-expanded={openRuntimeCardId === 'n8n'}
                  onclick={() => toggleRuntimeCard('n8n')}
                >
                  {#if n8nRuntimeBusy}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('checking')}>Checking…</Badge>
                  {:else if n8nRuntimeStatus?.healthy}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Connected</Badge>
                  {:else if n8nRuntimeStatus}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Not Reachable</Badge>
                  {/if}
                  <ChevronDown class={`h-4 w-4 transition-transform ${openRuntimeCardId === 'n8n' ? 'rotate-180' : ''}`} />
                </button>
              </div>
              <Collapsible.Content class="space-y-3 px-4 pb-4">
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={loadN8nRuntimeStatus}
                    disabled={n8nRuntimeBusy}
                  >
                    <RefreshCw class={`${n8nRuntimeBusy ? 'animate-spin' : ''}`} />
                    {n8nRuntimeBusy ? 'Checking…' : 'Refresh'}
                  </Button>
                </div>
                {#if n8nRuntimeStatus}
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {n8nRuntimeStatus.mode === 'docker'
                        ? 'Docker'
                        : n8nRuntimeStatus.mode === 'mac-app'
                          ? 'Mac app'
                          : 'Native'}
                    </Badge>
                    <Badge variant="outline">
                      {n8nRuntimeStatus.apiKeyConfigured ? 'API key configured' : 'API key optional/missing'}
                    </Badge>
                    {#if n8nRuntimeStatus.status}
                      <Badge variant="outline">HTTP {n8nRuntimeStatus.status}</Badge>
                    {/if}
                  </div>
                  <p class="batshit-settings-form-label break-all">
                    URL: <code>{n8nRuntimeStatus.effectiveUrl}</code>
                  </p>
                  <p class="batshit-settings-form-label">
                    URL source: {n8nUrlSourceLabel(n8nRuntimeStatus.urlSource)}
                  </p>
                  <p class="batshit-settings-form-label">
                    {n8nRuntimeStatus.launch.reason}
                  </p>
                  {#if n8nRuntimeStatus.error}
                    <p class="batshit-settings-form-help is-danger">{n8nRuntimeStatus.error}</p>
                  {/if}
                {:else if n8nRuntimeError}
                  <p class="batshit-settings-form-help is-danger">{n8nRuntimeError}</p>
                {:else}
                  <p class="batshit-settings-form-label">n8n status has not been checked yet.</p>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>

          {#if runtimeContext?.adminCards.macAppRequiredRuntime}
            <div class="batshit-settings-disclosure-row">
              <Collapsible.Root open={openRuntimeCardId === 'mac-required'}>
                <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
                      aria-expanded={openRuntimeCardId === 'mac-required'}
                      onclick={() => toggleRuntimeCard('mac-required')}
                    >
                      Mac App Required Runtime
                    </button>
                    <SettingsInfoMenu ariaLabel="About Mac App Required Runtime" contentClass="w-80">
                      <p>
                        Runtime Doctor checks the required local pieces for the packaged Mac app.
                        Docker installs use their own Compose runtime, so this section only appears
                        inside the Mac app runtime.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                  <button
                    type="button"
                    class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
                    aria-expanded={openRuntimeCardId === 'mac-required'}
                    onclick={() => toggleRuntimeCard('mac-required')}
                  >
                    <Badge variant="outline" class={runtimeStatusBadgeClass(macRuntimeSummaryTone())}>
                      {macRuntimeSummaryLabel()}
                    </Badge>
                    <ChevronDown class={`h-4 w-4 transition-transform ${openRuntimeCardId === 'mac-required' ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                <Collapsible.Content class="space-y-3 px-4 pb-4">
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => runMacRuntimeDoctor('doctor')}
                      disabled={macRuntimeBusy !== null}
                    >
                      <RefreshCw class={`${macRuntimeBusy === 'doctor' ? 'animate-spin' : ''}`} />
                      {macRuntimeBusy === 'doctor' ? 'Checking…' : 'View Runtime Doctor'}
                    </Button>
                    <Button
                      size="sm"
                      onclick={() => runMacRuntimeDoctor('start')}
                      disabled={macRuntimeBusy !== null}
                    >
                      {macRuntimeBusy === 'start' ? 'Starting…' : 'Start or Repair Runtime'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => runMacRuntimeDoctor('restart')}
                      disabled={macRuntimeBusy !== null}
                    >
                      {macRuntimeBusy === 'restart' ? 'Restarting…' : 'Restart Runtime'}
                    </Button>
                  </div>

                  {#if macRuntimeBridgeAvailable === false}
                    <p class="batshit-settings-form-help is-danger">
                      Runtime Doctor controls are available inside Batshit.app.
                    </p>
                  {/if}

                  {#if macRuntimeReport}
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{runtimeContext.label}</Badge>
                      {#if macRuntimeReport.generatedAt}
                        <Badge variant="outline">
                          Checked {new Date(macRuntimeReport.generatedAt).toLocaleTimeString()}
                        </Badge>
                      {/if}
                    </div>

                    <div class="grid gap-2 sm:grid-cols-2">
                      {#each macRuntimeRequiredItems as item}
                        <div class="flex items-center justify-between gap-3 border border-border/60 px-3 py-2 text-sm">
                          <span class="min-w-0 truncate">{item.label}</span>
                          <Badge variant="outline" class={runtimeStatusBadgeClass(macRuntimeItemTone(item))}>
                            {macRuntimeItemLabel(item)}
                          </Badge>
                        </div>
                      {/each}
                    </div>

                    {#if macRuntimeReport.actions?.length}
                      <div class="space-y-2">
                        {#each macRuntimeReport.actions as action}
                          <div class="space-y-1 border border-border/60 px-3 py-2">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <Badge variant="outline" class={runtimeStatusBadgeClass(macRuntimeActionTone(action))}>
                                {action.severity}
                              </Badge>
                              <span class="batshit-settings-form-label flex-1">{action.title}</span>
                              {#if action.repairCommand}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onclick={() => runMacRuntimeDoctor(action.repairCommand ?? 'doctor')}
                                  disabled={macRuntimeBusy !== null}
                                >
                                  {action.repairLabel ?? 'Repair'}
                                </Button>
                              {/if}
                              {#if action.externalUrl}
                                <a
                                  class="inline-flex h-8 items-center gap-1.5 border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
                                  href={action.externalUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <ExternalLink class="h-4 w-4" />
                                  {action.externalLabel ?? 'Open'}
                                </a>
                              {/if}
                            </div>
                            <p class="batshit-settings-form-label">{action.detail}</p>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <p class="batshit-settings-form-label">Core Mac app runtime checks are clean.</p>
                    {/if}

                    {#if macRuntimeReport.paths?.data}
                      <p class="batshit-settings-form-label break-all">
                        Data: <code>{macRuntimeReport.paths.data}</code>
                      </p>
                    {/if}
                    {#if macRuntimeReport.paths?.logs}
                      <p class="batshit-settings-form-label break-all">
                        Logs: <code>{macRuntimeReport.paths.logs}</code>
                      </p>
                    {/if}
                  {:else if macRuntimeError}
                    <p class="batshit-settings-form-help is-danger">{macRuntimeError}</p>
                  {:else}
                    <p class="batshit-settings-form-label">
                      View Runtime Doctor to check the Mac app required runtime.
                    </p>
                  {/if}
                </Collapsible.Content>
              </Collapsible.Root>
            </div>
          {/if}

          <div class="batshit-settings-disclosure-row">
            <Collapsible.Root open={openRuntimeCardId === 'agent-browser'}>
              <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
                <div class="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
                    aria-expanded={openRuntimeCardId === 'agent-browser'}
                    onclick={() => toggleRuntimeCard('agent-browser')}
                  >
                    Agent Browser Runtime
                  </button>
                  <SettingsInfoMenu ariaLabel="About Agent Browser Runtime" contentClass="w-80">
                    <p>Native runtime used by Agent Browser tools.</p>
                  </SettingsInfoMenu>
                </div>
                <button
                  type="button"
                  class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
                  aria-expanded={openRuntimeCardId === 'agent-browser'}
                  onclick={() => toggleRuntimeCard('agent-browser')}
                >
                  {#if agentBrowserRuntimeBusy}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('checking')}>Checking…</Badge>
                  {:else if agentBrowserRuntimeStatus?.supportLevel === 'docker-sidecar' && agentBrowserRuntimeStatus?.installed}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Sidecar Active</Badge>
                  {:else if agentBrowserRuntimeStatus?.supportLevel === 'docker-sidecar'}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('warning')}>Sidecar Stopped</Badge>
                  {:else if agentBrowserRuntimeStatus?.dockerUnsupported}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Unavailable</Badge>
                  {:else if agentBrowserRuntimeStatus?.installed}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Installed</Badge>
                  {:else if agentBrowserRuntimeStatus}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Not Installed</Badge>
                  {/if}
                  <ChevronDown class={`h-4 w-4 transition-transform ${openRuntimeCardId === 'agent-browser' ? 'rotate-180' : ''}`} />
                </button>
              </div>
              <Collapsible.Content class="space-y-3 px-4 pb-4">
                {#if !agentBrowserRuntimeStatus || agentBrowserRuntimeStatus.supportLevel !== 'docker-sidecar'}
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onclick={handleAgentBrowserInstall}
                      disabled={agentBrowserRuntimeBusy || agentBrowserRuntimeStatus?.dockerUnsupported === true}
                    >
                      {agentBrowserRuntimeBusy
                        ? 'Installing…'
                        : agentBrowserRuntimeStatus?.installed
                          ? 'Reinstall Agent Browser'
                          : 'Install Agent Browser'}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onclick={handleAgentBrowserUninstall}
                      disabled={
                        agentBrowserRuntimeBusy ||
                        !agentBrowserRuntimeStatus?.installed ||
                        agentBrowserRuntimeStatus?.dockerUnsupported === true
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Uninstall
                    </Button>
                  </div>
                {/if}
                {#if agentBrowserRuntimeStatus?.supportLevel === 'docker-sidecar'}
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onclick={() => handleAgentBrowserDockerAddonControl('start')}
                      disabled={
                        agentBrowserRuntimeBusy ||
                        agentBrowserRuntimeStatus?.installed === true ||
                        agentBrowserAddonStatus?.operator?.available !== true
                      }
                    >
                      Start Sidecar
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onclick={() => handleAgentBrowserDockerAddonControl('stop')}
                      disabled={
                        agentBrowserRuntimeBusy ||
                        agentBrowserRuntimeStatus?.installed !== true ||
                        agentBrowserAddonStatus?.operator?.available !== true
                      }
                    >
                      Stop Sidecar
                    </Button>
                  </div>
                  {#if agentBrowserAddonStatus?.operator?.reason}
                    <p class="batshit-settings-form-label">{agentBrowserAddonStatus.operator.reason}</p>
                  {/if}
                  {#if agentBrowserAddonStatus?.operatorCommand}
                    <p class="batshit-settings-form-label">
                      Operator command: <code>{agentBrowserAddonStatus.operatorCommand}</code>
                    </p>
                  {/if}
                {/if}
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={loadAgentBrowserRuntimeStatus}
                    disabled={agentBrowserRuntimeBusy}
                  >
                    <RefreshCw  />
                    Refresh
                  </Button>
                </div>
                {#if agentBrowserRuntimeStatus?.installScope === 'docker-sidecar'}
                  <p class="batshit-settings-form-label">Source: Docker Compose Agent Browser sidecar.</p>
                {/if}
                <p class="batshit-settings-form-label">
                  {agentBrowserRuntimeStatus?.installHelp ??
                    'Install exact tested version from Settings -> Admin -> Agent Browser Runtime.'}
                </p>
                {#if agentBrowserRuntimeStatus?.version}
                  <p class="batshit-settings-form-label">
                    Version: <code>{agentBrowserRuntimeStatus.version}</code>
                  </p>
                {/if}
                {#if agentBrowserRuntimeStatus?.testedVersion}
                  <p class="batshit-settings-form-label">
                    Batshit tested pin: <code>{agentBrowserRuntimeStatus.testedVersion}</code>
                    {#if agentBrowserRuntimeStatus.runtimeMatchesTestedVersion === false}
                      <span> (current runtime differs)</span>
                    {/if}
                  </p>
                {/if}
                {#if agentBrowserRuntimeStatus?.reason}
                  <p class="batshit-settings-form-label">{agentBrowserRuntimeStatus.reason}</p>
                {/if}
                {#if agentBrowserRuntimeError}
                  <p class="batshit-settings-form-help is-danger">{agentBrowserRuntimeError}</p>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>

          <div class="batshit-settings-disclosure-row">
            <Collapsible.Root open={openRuntimeCardId === 'cloudflared'}>
              <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
                <div class="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
                    aria-expanded={openRuntimeCardId === 'cloudflared'}
                    onclick={() => toggleRuntimeCard('cloudflared')}
                  >
                    Cloudflared Runtime
                  </button>
                  <SettingsInfoMenu ariaLabel="About Cloudflared Runtime" contentClass="w-80">
                    <p>Managed tunnel runtime used by Clip Settings.</p>
                  </SettingsInfoMenu>
                </div>
                <button
                  type="button"
                  class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
                  aria-expanded={openRuntimeCardId === 'cloudflared'}
                  onclick={() => toggleRuntimeCard('cloudflared')}
                >
                  {#if cloudflaredBusy}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('checking')}>Checking…</Badge>
                  {:else if cloudflaredRuntimeStatus?.supportLevel === 'docker-sidecar' && cloudflaredRuntimeStatus?.tunnel?.running}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Sidecar Active</Badge>
                  {:else if cloudflaredRuntimeStatus?.supportLevel === 'docker-sidecar'}
                    <Badge
                      variant="outline"
                      class={runtimeStatusBadgeClass(
                        cloudflaredRuntimeStatus?.dockerSidecar?.status === 'starting'
                          ? 'checking'
                          : 'warning'
                      )}
                    >
                      {cloudflaredRuntimeStatus?.dockerSidecar?.status === 'starting' ? 'Sidecar Starting' : 'Sidecar Stopped'}
                    </Badge>
                  {:else if cloudflaredRuntimeStatus?.dockerUnsupported}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Unavailable</Badge>
                  {:else if cloudflaredRuntimeStatus?.installed}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Installed</Badge>
                  {:else if cloudflaredRuntimeStatus}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Not Installed</Badge>
                  {/if}
                  <ChevronDown class={`h-4 w-4 transition-transform ${openRuntimeCardId === 'cloudflared' ? 'rotate-180' : ''}`} />
                </button>
              </div>
              <Collapsible.Content class="space-y-3 px-4 pb-4">
                {#if !cloudflaredRuntimeStatus || cloudflaredRuntimeStatus.supportLevel === 'native-managed'}
                <div class="flex flex-wrap items-center gap-2">
                  <Select.Root
                    type="single"
                    value={cloudflaredPlatform}
                    disabled={cloudflaredRuntimeStatus?.supportLevel !== 'native-managed'}
                    onValueChange={(value: string) =>
                      (cloudflaredPlatform = value as CloudflaredInstallPlatform)}
                  >
                    <Select.Trigger class="w-[220px] overflow-hidden">
                      <span class="block w-full truncate">
                        {cloudflaredPlatformOptions.find((option) => option.value === cloudflaredPlatform)
                          ?.label || 'Select OS'}
                      </span>
                    </Select.Trigger>
                    <Select.Content>
                      {#each cloudflaredPlatformOptions as option}
                        <Select.Item value={option.value}>{option.label}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                  <Button
                    size="sm"
                    onclick={handleCloudflaredInstall}
                    disabled={cloudflaredBusy || cloudflaredRuntimeStatus?.supportLevel !== 'native-managed'}
                  >
                    {cloudflaredBusy
                      ? 'Installing…'
                      : cloudflaredRuntimeStatus?.installed
                        ? 'Reinstall Cloudflared'
                        : 'Install Cloudflared'}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onclick={handleCloudflaredUninstall}
                    disabled={
                      cloudflaredBusy ||
                      !cloudflaredRuntimeStatus?.installed ||
                      cloudflaredRuntimeStatus?.supportLevel !== 'native-managed'
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    Uninstall
                  </Button>
                </div>
                {/if}
                {#if cloudflaredRuntimeStatus?.version}
                  <p class="batshit-settings-form-label">
                    Version: <code>{cloudflaredRuntimeStatus.version}</code>
                  </p>
                {/if}
                {#if cloudflaredRuntimeStatus?.testedVersion}
                  <p class="batshit-settings-form-label">
                    Batshit tested pin: <code>{cloudflaredRuntimeStatus.testedVersion}</code>
                  </p>
                {/if}
                {#if cloudflaredRuntimeStatus?.manifest?.releaseTag}
                  <p class="batshit-settings-form-label">
                    Batshit pinned release: <code>{cloudflaredRuntimeStatus.manifest.releaseTag}</code>
                  </p>
                {/if}
                {#if cloudflaredRuntimeStatus?.manifest?.installedAt}
                  <p class="batshit-settings-form-label">
                    Installed {new Date(cloudflaredRuntimeStatus.manifest.installedAt).toLocaleString()}
                  </p>
                {/if}
                {#if cloudflaredRuntimeStatus?.manifest?.checksumVerified}
                  <p class="batshit-settings-form-label">
                    SHA256 verified against the official GitHub asset digest.
                  </p>
                {/if}
                {#if cloudflaredRuntimeStatus?.installScope === 'system'}
                  <p class="batshit-settings-form-label">Source: system-managed install (outside Batshit).</p>
                {:else if cloudflaredRuntimeStatus?.installScope === 'batshit-managed'}
                  <p class="batshit-settings-form-label">Source: Batshit-managed install.</p>
                {:else if cloudflaredRuntimeStatus?.installScope === 'docker-sidecar'}
                  <p class="batshit-settings-form-label">Source: Docker Compose cloudflared sidecar.</p>
                  {#if cloudflaredRuntimeStatus?.dockerSidecar?.targetUrl}
                    <p class="batshit-settings-form-label">
                      Target: <code>{cloudflaredRuntimeStatus.dockerSidecar.targetUrl}</code>
                    </p>
                  {/if}
                  {#if cloudflaredRuntimeStatus?.dockerSidecar?.publicUrl}
                    <p class="batshit-settings-form-label break-all">
                      Public URL: <code>{cloudflaredRuntimeStatus.dockerSidecar.publicUrl}</code>
                    </p>
                  {/if}
                  {#if cloudflaredRuntimeStatus?.dockerSidecar?.lastSeenAt}
                    <p class="batshit-settings-form-label">
                      Last heartbeat {new Date(cloudflaredRuntimeStatus.dockerSidecar.lastSeenAt).toLocaleString()}
                    </p>
                  {/if}
                {/if}
                {#if cloudflaredRuntimeStatus?.supportLevel === 'docker-sidecar' || cloudflaredRuntimeStatus?.dockerUnsupported}
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onclick={() => handleCloudflaredDockerAddonControl('start')}
                      disabled={
                        cloudflaredBusy ||
                        cloudflaredRuntimeStatus?.tunnel?.running === true ||
                        cloudflaredAddonStatus?.operator?.available !== true
                      }
                    >
                      Start Sidecar
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onclick={() => handleCloudflaredDockerAddonControl('stop')}
                      disabled={
                        cloudflaredBusy ||
                        cloudflaredRuntimeStatus?.tunnel?.running !== true ||
                        cloudflaredAddonStatus?.operator?.available !== true
                      }
                    >
                      Stop Sidecar
                    </Button>
                  </div>
                  {#if cloudflaredAddonStatus?.operator?.reason}
                    <p class="batshit-settings-form-label">{cloudflaredAddonStatus.operator.reason}</p>
                  {/if}
                  {#if cloudflaredAddonStatus?.operatorCommand}
                    <p class="batshit-settings-form-label">
                      Operator command: <code>{cloudflaredAddonStatus.operatorCommand}</code>
                    </p>
                  {/if}
                {/if}
                {#if cloudflaredRuntimeStatus?.installHelp}
                  <p class="batshit-settings-form-label">{cloudflaredRuntimeStatus.installHelp}</p>
                {/if}
                {#if cloudflaredRuntimeStatus?.reason}
                  <p class="batshit-settings-form-label">{cloudflaredRuntimeStatus.reason}</p>
                {/if}
                {#if cloudflaredError}
                  <p class="batshit-settings-form-help is-danger">{cloudflaredError}</p>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>

          {#if runtimeContext?.adminCards.appleContainerSandbox}
            <div class="batshit-settings-disclosure-row">
              <Collapsible.Root open={openRuntimeCardId === 'apple-sandbox'}>
                <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
                      aria-expanded={openRuntimeCardId === 'apple-sandbox'}
                      onclick={() => toggleRuntimeCard('apple-sandbox')}
                    >
                      Apple Container Sandbox
                    </button>
                    <SettingsInfoMenu ariaLabel="About Apple Container Sandbox" contentClass="w-80">
                      <p>
                        Default Mac sandbox for Agent Mode Bash. If it is selected and unavailable,
                        Bash fails clearly instead of switching to Docker or local shell.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                  <button
                    type="button"
                    class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
                    aria-expanded={openRuntimeCardId === 'apple-sandbox'}
                    onclick={() => toggleRuntimeCard('apple-sandbox')}
                  >
                    {#if appleSandboxBusy || appleSandboxRecoverBusy}
                      <Badge variant="outline" class={runtimeStatusBadgeClass('checking')}>Checking…</Badge>
                    {:else if appleSandboxRuntimeStatus?.supported === false}
                      <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Unsupported</Badge>
                    {:else if appleSandboxRuntimeStatus?.available}
                      <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Available</Badge>
                    {:else if appleSandboxRuntimeStatus}
                      <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Unavailable</Badge>
                    {/if}
                    <ChevronDown class={`h-4 w-4 transition-transform ${openRuntimeCardId === 'apple-sandbox' ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                <Collapsible.Content class="space-y-3 px-4 pb-4">
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={loadAppleSandboxRuntimeStatus}
                      disabled={appleSandboxBusy || appleSandboxRecoverBusy}
                    >
                      <RefreshCw class="h-4 w-4" />
                      Refresh
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onclick={handleAppleSandboxRecover}
                      disabled={
                        appleSandboxRecoverBusy ||
                        appleSandboxBusy ||
                        appleSandboxRuntimeStatus?.supported === false ||
                        appleSandboxRuntimeStatus?.installed === false
                      }
                    >
                      {appleSandboxRecoverLabel()}
                    </Button>
                    {#if appleSandboxRuntimeStatus?.installed === false && appleSandboxRuntimeStatus?.installUrl}
                      <a
                        class="inline-flex h-8 items-center gap-1.5 border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
                        href={appleSandboxRuntimeStatus.installUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink class="h-4 w-4" />
                        Install Apple Container
                      </a>
                    {/if}
                  </div>
                  {#if appleSandboxRuntimeStatus?.version}
                    <p class="batshit-settings-form-label">
                      Version: <code>{appleSandboxRuntimeStatus.version}</code>
                    </p>
                  {/if}
                  {#if appleSandboxRuntimeStatus?.image}
                    <p class="batshit-settings-form-label">
                      Image: <code>{appleSandboxRuntimeStatus.image}</code>
                    </p>
                  {/if}
                  {#if appleSandboxRuntimeStatus?.network}
                    <p class="batshit-settings-form-label">
                      Network: <code>{appleSandboxRuntimeStatus.network}</code>
                    </p>
                  {/if}
                  <p class="batshit-settings-form-label">
                    Network policy: <code>{appleSandboxRuntimeStatus?.policy ?? 'internal-network'}</code>
                  </p>
                  {#if appleSandboxRuntimeStatus?.reason}
                    <p class="batshit-settings-form-label">{appleSandboxRuntimeStatus.reason}</p>
                  {/if}
                  {#if appleSandboxError}
                    <p class="batshit-settings-form-help is-danger">{appleSandboxError}</p>
                  {/if}
                </Collapsible.Content>
              </Collapsible.Root>
            </div>
          {/if}

          <div class="batshit-settings-disclosure-row">
            <Collapsible.Root open={openRuntimeCardId === 'sandbox'}>
              <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
                <div class="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
                    aria-expanded={openRuntimeCardId === 'sandbox'}
                    onclick={() => toggleRuntimeCard('sandbox')}
                  >
                    Docker Sandbox Runtime
                  </button>
                  <SettingsInfoMenu ariaLabel="About Docker Sandbox Runtime" contentClass="w-80">
                    <p>
                      Isolated backend for Agent Mode shell and tool runs. Docker installs reach it
                      through the Batshit host operator.
                    </p>
                  </SettingsInfoMenu>
                </div>
                <button
                  type="button"
                  class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
                  aria-expanded={openRuntimeCardId === 'sandbox'}
                  onclick={() => toggleRuntimeCard('sandbox')}
                >
                  {#if sandboxBusy || sandboxRecoverBusy}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('checking')}>Checking…</Badge>
                  {:else if sandboxRuntimeStatus?.dockerUnsupported}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Disabled</Badge>
                  {:else if isSandboxOperatorRequired()}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('warning')}>Operator Required</Badge>
                  {:else if sandboxRuntimeStatus?.available}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>
                      {sandboxRuntimeStatus?.containerized ? 'Operator Active' : 'Available'}
                    </Badge>
                  {:else if sandboxRuntimeStatus}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Unavailable</Badge>
                  {/if}
                  <ChevronDown class={`h-4 w-4 transition-transform ${openRuntimeCardId === 'sandbox' ? 'rotate-180' : ''}`} />
                </button>
              </div>
              <Collapsible.Content class="space-y-3 px-4 pb-4">
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onclick={loadSandboxRuntimeStatus}
                    disabled={sandboxBusy || sandboxRecoverBusy}
                  >
                    <RefreshCw class="h-4 w-4" />
                    Refresh
                  </Button>
                  <Button
                    variant={sandboxRuntimeStatus?.containerized ? 'outline' : 'default'}
                    size="sm"
                    onclick={handleSandboxRecover}
                    disabled={sandboxRecoverBusy || sandboxBusy || !canRecoverSandbox()}
                  >
                    {#if sandboxRuntimeStatus?.containerized}
                      <Wrench class="h-4 w-4" />
                    {/if}
                    {sandboxRecoverLabel()}
                  </Button>
                </div>
                {#if sandboxRuntimeStatus?.version}
                  <p class="batshit-settings-form-label">
                    Version: <code>{sandboxRuntimeStatus.version}</code>
                  </p>
                {/if}
                {#if sandboxRuntimeStatus?.containerized}
                  <p class="batshit-settings-form-label">
                    Docker installs use the Batshit host operator for isolated Sandbox runs. The
                    app-container shell remains the separate local backend.
                  </p>
                {/if}
                {#if sandboxRuntimeStatus?.cli}
                  <p class="batshit-settings-form-label">
                    CLI: <code>{sandboxRuntimeStatus.cli}</code>
                  </p>
                {/if}
                <p class="batshit-settings-form-label">
                  Network policy: <code>{sandboxRuntimeStatus?.policy ?? 'deny'}</code>
                </p>
                {#if sandboxRuntimeStatus?.reason}
                  <p class="batshit-settings-form-label">{sandboxRuntimeStatus.reason}</p>
                {/if}
                {#if sandboxError}
                  <p class="batshit-settings-form-help is-danger">{sandboxError}</p>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>

          <div class="batshit-settings-disclosure-row">
            <Collapsible.Root open={openRuntimeCardId === 'fbx'}>
              <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
                <div class="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
                    aria-expanded={openRuntimeCardId === 'fbx'}
                    onclick={() => toggleRuntimeCard('fbx')}
                  >
                    FBX -&gt; VRMA Converter
                  </button>
                  <SettingsInfoMenu ariaLabel="About FBX to VRMA Converter" contentClass="w-80">
                    {#if isDockerFbxStatus(fbxInstallStatus)}
                      <p>
                        Docker installs use the optional FBX-to-VRMA worker sidecar. Native
                        converter install buttons are not used inside the app container.
                      </p>
                    {:else}
                      <p>Pinned FBX2glTF binary used for animation conversion.</p>
                    {/if}
                  </SettingsInfoMenu>
                </div>
                <button
                  type="button"
                  class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
                  aria-expanded={openRuntimeCardId === 'fbx'}
                  onclick={() => toggleRuntimeCard('fbx')}
                >
                  {#if fbxInstallBusy}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('checking')}>Checking…</Badge>
                  {:else if fbxInstallStatus?.supportLevel === 'docker-worker'}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Worker Active</Badge>
                  {:else if fbxInstallStatus?.supportLevel === 'docker-worker-missing'}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('warning')}>Worker Waiting</Badge>
                  {:else if fbxInstallStatus?.dockerUnsupported}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('warning')}>Deferred in Docker</Badge>
                  {:else if fbxInstallStatus?.installed}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('ok')}>Installed</Badge>
                  {:else if fbxInstallStatus}
                    <Badge variant="outline" class={runtimeStatusBadgeClass('bad')}>Not Installed</Badge>
                  {/if}
                  <ChevronDown class={`h-4 w-4 transition-transform ${openRuntimeCardId === 'fbx' ? 'rotate-180' : ''}`} />
                </button>
              </div>
              <Collapsible.Content class="space-y-3 px-4 pb-4">
                {#if !isDockerFbxStatus(fbxInstallStatus)}
                  <div class="flex flex-wrap items-center gap-2">
                    <Select.Root
                      type="single"
                      value={fbxInstallPlatform}
                      disabled={fbxInstallStatus?.supportLevel !== 'native-managed'}
                      onValueChange={(value: string) => (fbxInstallPlatform = value as FbxInstallPlatform)}
                    >
                      <Select.Trigger class="w-[220px] overflow-hidden">
                        <span class="block w-full truncate">
                          {fbxPlatformOptions.find((option) => option.value === fbxInstallPlatform)?.label ||
                            'Select OS'}
                        </span>
                      </Select.Trigger>
                      <Select.Content>
                        {#each fbxPlatformOptions as option}
                          <Select.Item value={option.value}>{option.label}</Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                    <Button
                      size="sm"
                      onclick={handleFbxInstall}
                      disabled={fbxInstallBusy || fbxInstallStatus?.supportLevel !== 'native-managed'}
                    >
                      {fbxInstallBusy
                        ? 'Installing…'
                        : fbxInstallStatus?.installed
                          ? 'Reinstall Converter'
                          : 'Install Converter'}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onclick={handleFbxUninstall}
                      disabled={
                        fbxInstallBusy ||
                        !fbxInstallStatus?.installed ||
                        fbxInstallStatus?.supportLevel !== 'native-managed'
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Uninstall
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={loadFbxInstallStatus}
                      disabled={fbxInstallBusy}
                    >
                      <RefreshCw  />
                      Refresh
                    </Button>
                  </div>
                {:else}
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={loadFbxInstallStatus}
                      disabled={fbxInstallBusy}
                    >
                      <RefreshCw class={`${fbxInstallBusy ? 'animate-spin' : ''}`} />
                      {fbxInstallBusy ? 'Checking…' : 'Refresh'}
                    </Button>
                  </div>
                {/if}
                {#if fbxInstallStatus?.supportLevel === 'docker-worker'}
                  <p class="batshit-settings-form-label">
                    Docker worker active at <code>{fbxInstallStatus.worker?.url}</code>
                  </p>
                  {#if fbxInstallStatus.worker?.health?.version || fbxInstallStatus.worker?.health?.fbx2gltfVersion}
                    <p class="batshit-settings-form-label">
                      Worker version: <code>{fbxInstallStatus.worker?.health?.version || fbxInstallStatus.worker?.health?.fbx2gltfVersion}</code>
                    </p>
                  {/if}
                  {#if fbxInstallStatus.worker?.checkedAt}
                    <p class="batshit-settings-form-label">
                      Last checked {new Date(fbxInstallStatus.worker.checkedAt).toLocaleString()}
                    </p>
                  {/if}
                  <p class="batshit-settings-form-label">
                    Docker uses the Compose worker sidecar for FBX conversion. Native
                    install/reinstall is hidden for Docker installs.
                  </p>
                {:else if fbxInstallStatus?.dockerUnsupported || fbxInstallStatus?.supportLevel === 'docker-worker-missing'}
                  {#if fbxInstallStatus?.reason}
                    <p class="batshit-settings-form-label">{fbxInstallStatus.reason}</p>
                  {/if}
                  {#if fbxInstallStatus.worker?.error}
                    <p class="batshit-settings-form-label">
                      Last worker check: <code>{fbxInstallStatus.worker.error}</code>
                    </p>
                  {/if}
                {:else}
                  <p class="batshit-settings-form-label">
                    Select the OS for the machine running batshit. macOS uses the x64 build; Apple Silicon
                    still needs Rosetta for this binary.
                  </p>
                {/if}
                {#if fbxInstallStatus?.supportLevel === 'docker-worker' || fbxInstallStatus?.supportLevel === 'docker-worker-missing'}
                  {#if fbxAddonStatus?.operator?.available === true}
                    <div class="flex flex-wrap items-center gap-2">
                      {#if fbxInstallStatus?.supportLevel === 'docker-worker-missing'}
                        <Button
                          size="sm"
                          onclick={() => handleFbxDockerAddonControl('start')}
                          disabled={fbxInstallBusy}
                        >
                          Start Worker
                        </Button>
                      {:else}
                        <Button
                          size="sm"
                          variant="outline"
                          onclick={() => handleFbxDockerAddonControl('stop')}
                          disabled={fbxInstallBusy}
                        >
                          Stop Worker
                        </Button>
                      {/if}
                    </div>
                  {:else}
                    {#if fbxAddonStatus?.operator?.reason}
                      <p class="batshit-settings-form-label">{fbxAddonStatus.operator.reason}</p>
                    {/if}
                    {#if fbxAddonStatus?.operatorCommand}
                      <p class="batshit-settings-form-label">
                        Start from Terminal: <code>{fbxAddonStatus.operatorCommand}</code>
                      </p>
                    {/if}
                  {/if}
                {/if}
                {#if fbxInstallStatus?.manifest?.installedAt}
                  <p class="batshit-settings-form-label">
                    Installed {new Date(fbxInstallStatus.manifest.installedAt).toLocaleString()}
                  </p>
                {/if}
                {#if fbxInstallStatus?.manifest?.releaseTag}
                  <p class="batshit-settings-form-label">
                    Batshit pinned release: <code>{fbxInstallStatus.manifest.releaseTag}</code>
                  </p>
                {/if}
                {#if fbxInstallStatus?.testedVersion && !fbxInstallStatus?.manifest?.releaseTag}
                  <p class="batshit-settings-form-label">
                    Batshit pinned release: <code>{fbxInstallStatus.testedVersion}</code>
                  </p>
                {/if}
                {#if fbxInstallStatus?.manifest?.checksumNote || fbxInstallStatus?.checksumNote}
                  <p class="batshit-settings-form-label">
                    {fbxInstallStatus?.manifest?.checksumNote || fbxInstallStatus?.checksumNote}
                  </p>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          </div>
        </div>
    </SettingsAccordionCard>
  </div>
</div>

<SystemPromptEditor
  bind:open={corePromptEditorOpen}
  title={selectedCorePrompt?.label ?? 'Core System Prompt'}
  description={selectedCorePrompt?.description ?? ''}
  warning={selectedCorePrompt?.warning}
  prompt={corePromptDraft}
  readOnly={false}
  width="large"
  onSave={saveCorePrompt}
/>

<style>
  :global(.core-prompt-status-badge) {
    --core-prompt-status-border: var(--bs-app-success-line);
    --core-prompt-status-bg: var(--bs-app-success-bg);
    --core-prompt-status-text: var(--bs-app-success-text);
    border-color: var(--core-prompt-status-border);
    background: var(--core-prompt-status-bg);
    color: var(--core-prompt-status-text);
  }

  :global(.core-prompt-status-badge.is-customized) {
    --core-prompt-status-border: oklch(0.78 0.08 62 / 0.28);
    --core-prompt-status-bg: oklch(0.16 0.05 62 / 0.3);
    --core-prompt-status-text: oklch(0.84 0.07 68);
  }

  :global(.runtime-status-badge) {
    --runtime-status-color: oklch(0.68 0.08 255);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border-color: color-mix(in oklch, var(--runtime-status-color) 48%, transparent);
    background: color-mix(in oklch, var(--runtime-status-color) 12%, transparent);
    color: color-mix(in oklch, var(--runtime-status-color) 82%, oklch(0.94 0.006 289.95));
  }

  :global(.runtime-status-badge::before) {
    content: '';
    width: 0.42rem;
    height: 0.42rem;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--runtime-status-color);
    box-shadow: 0 0 0 1px color-mix(in oklch, var(--runtime-status-color) 35%, transparent);
  }

  :global(.runtime-status-badge.is-ok) {
    --runtime-status-color: oklch(0.72 0.115 185);
  }

  :global(.runtime-status-badge.is-warning) {
    --runtime-status-color: oklch(0.78 0.11 82);
  }

  :global(.runtime-status-badge.is-bad) {
    --runtime-status-color: oklch(0.64 0.275 358);
  }

  :global(.runtime-status-badge.is-checking) {
    --runtime-status-color: oklch(0.68 0.08 255);
  }
</style>
