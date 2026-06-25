<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import * as Card from '$lib/components/ui/card'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Switch from '$lib/components/ui/switch'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
  import ArtifactSourceBadge from '$lib/components/artifacts/ArtifactSourceBadge.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import {
    ChevronDown,
    Copy,
    Download,
    FileCode,
    FileText,
    Loader2,
    MessageSquare,
    Pencil,
    Plus,
    RefreshCcw,
    Trash2
  } from '@lucide/svelte'
  import type { UserSettingsRow } from '$lib/types/database'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { DEFAULT_ARTIFACT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import type { CustomIconRecord, IconRef, IconLibraryPrefs } from '$lib/icons/iconTypes'
  import { iconLibraryService } from '$lib/services/iconLibraryService'
  import { artifactService, type ArtifactRow } from '$lib/services/artifactService'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { downloadText } from '$lib/utils/download'
  import {
    applyBatshitArtifactStructureSetting,
    artifactRuntimeSchemaReady,
    artifactStructureValidationCanBeDeferred,
    buildArtifactStructureEnforcementMessage,
    DEFAULT_ARTIFACT_SCAFFOLD_CONTENT,
    hasFabricFieldsMetadata,
    isBatshitArtifactStructureEnforced,
    isRunOnlyMetadata,
    validateBatshitArtifactStructure
  } from '$lib/artifacts/structureEnforcement'
  import {
    applyArtifactPowerSourceToMetadata,
    ARTIFACT_POWER_SOURCE_OPTIONS,
    getArtifactPowerSourceOption,
    resolveArtifactPowerSource,
    type ArtifactPowerSource
  } from '$lib/artifacts/artifactPowerSource'
  import { resolveArtifactAgentUseEligibility } from '$lib/artifacts/agentUseEligibility'
  import {
    dispatchArtifactDeleted,
    dispatchArtifactDraftPreview,
    dispatchArtifactUpdated
  } from '$lib/utils/liveSettingsEvents'

  type PanelData = {
    user?: {
      id: string
      email?: string | null
    } | null
    userSettings?: UserSettingsRow | null
  } | null

  type ArtifactMode = 'edit' | 'published'

  const DEFAULT_ARTIFACT_AUTOSAVE_DEBOUNCE_MS = 600
  const artifactPlacementOptions = [
    {
      value: null,
      label: 'No Zone',
      description: 'Keep this artifact unpublished while you work on it.',
      batshitIcon: 'zone-none'
    },
    {
      value: 'header',
      label: 'Header',
      description: 'Publish as a header icon.',
      batshitIcon: 'zone-headerbar'
    },
    {
      value: 'panel',
      label: 'Panel',
      description: 'Publish in the panel rail.',
      batshitIcon: 'zone-side-panel'
    },
    {
      value: 'trigger',
      label: 'Trigger',
      description: 'Publish in the Trigger dropdown.',
      batshitIcon: 'zone-trigger-menu'
    }
  ] as const

  let {
    data = null,
    initialArtifactId = null
  }: {
    data?: PanelData
    initialArtifactId?: string | null
  } = $props()

  const userId = $derived(data?.user?.id ?? null)

  let artifacts = $state<ArtifactRow[]>([])
  let artifactsLoading = $state(false)
  let artifactsError = $state<string | null>(null)
  let selectedArtifactId = $state<string | null>(null)
  let selectedArtifact = $derived(
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null
  )

  let editableIconRef = $state<IconRef>(DEFAULT_ARTIFACT_ICON_REF)
  let customIcons = $state<CustomIconRecord[]>([])
  let iconLibraryPrefs = $state<IconLibraryPrefs>({ favorites: [], recents: [] })
  let iconUploadInput = $state<HTMLInputElement | null>(null)
  let iconUploading = $state(false)
  let editableName = $state('')
  let slug = $state('')
  let slugEdited = $state(false)
  let powerSource = $state<ArtifactPowerSource>('built_in')
  let webhookUrl = $state('')
  let systemPrompt = $state('')
  let zone = $state<string | null>(null)
  let editorContent = $state('')
  let versionNote = $state('')
  let blueprintContent = $state('')
  let pendingMetadata = $state<Record<string, any>>({})
  let systemPromptEditorOpen = $state(false)
  let contentEditorOpen = $state(false)
  let blueprintEditorOpen = $state(false)
  let artifactHydrating = $state(false)
  let artifactPersistedSignature = $state<string | null>(null)
  let deleteDisclosureOpen = $state(false)
  let deleteBusy = $state(false)

  // Agent Use controls
  let agentUseEnabled = $state(true)
  let agentUseAllAgents = $state(false)
  let agentAllowlist = $state<string[]>([])
  let lastAppliedInitialArtifactId = $state<string | null>(null)

  let artifactSaveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let artifactSaveError = $state<string | null>(null)
  let artifactSaveResetTimeout: ReturnType<typeof setTimeout> | null = null
  let artifactAutosaveTimeout: ReturnType<typeof setTimeout> | null = null
  let queuedArtifactAutosave = $state<{
    artifactId: string
    signature: string
    payload: Record<string, any>
  } | null>(null)
  let artifactDetailLoadSerial = 0
  const artifactStructureEnforced = $derived.by(() =>
    isBatshitArtifactStructureEnforced(pendingMetadata)
  )

  const artifactStructureValidation = $derived.by(() =>
    validateBatshitArtifactStructure(editorContent, pendingMetadata)
  )

  const selectedPowerSourceOption = $derived(getArtifactPowerSourceOption(powerSource))

  const selectedPowerSourcePreviewArtifact = $derived.by(() => {
    if (!selectedArtifact) return null
    return {
      ...selectedArtifact,
      brain_type: selectedPowerSourceOption.brainType,
      metadata: applyArtifactPowerSourceToMetadata(pendingMetadata, powerSource)
    }
  })

  const selectedAgentUseEligibility = $derived.by(() =>
    resolveArtifactAgentUseEligibility({
      ...(selectedArtifact ?? {}),
      brain_type: selectedPowerSourceOption.brainType,
      ai_enabled: selectedPowerSourceOption.brainType !== 'none',
      metadata: applyArtifactPowerSourceToMetadata(pendingMetadata, powerSource),
      icon_ref: editableIconRef
    })
  )

  onMount(() => {
    void loadIconLibrary()
    void loadArtifacts(false)

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data?.type !== 'batshit:artifact:ready') return
      if (!selectedArtifactId || event.data.artifactId !== selectedArtifactId) return

      const fabricFields = event.data.fabricFields
      if (!Array.isArray(fabricFields)) return

      pendingMetadata = {
        ...(pendingMetadata || {}),
        fabric_fields: fabricFields
      }
    }

    window.addEventListener('message', handleMessage)

    return () => {
      window.removeEventListener('message', handleMessage)
    }
  })

  function resolveArtifactIconRef(artifact: ArtifactRow | null | undefined) {
    return normalizeIconRef(artifact?.icon_ref ?? artifact?.icon, DEFAULT_ARTIFACT_ICON_REF)
  }

  async function loadIconLibrary() {
    try {
      const snapshot = await iconLibraryService.list()
      customIcons = snapshot.icons
      iconLibraryPrefs = snapshot.prefs
    } catch (error) {
      console.error('Failed to load icon library:', error)
    }
  }

  function requestIconUpload() {
    iconUploadInput?.click()
  }

  async function handleIconUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    iconUploading = true
    try {
      const icon = await iconLibraryService.upload(file)
      customIcons = [icon, ...customIcons.filter((entry) => entry.id !== icon.id)]
      editableIconRef = { kind: 'custom', iconId: icon.id }
      iconLibraryPrefs = await iconLibraryService.addRecent(editableIconRef, iconLibraryPrefs)
      toast.success('Icon added to your library.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload icon.')
    } finally {
      iconUploading = false
      input.value = ''
    }
  }

  onDestroy(() => {
    if (artifactSaveResetTimeout) {
      clearTimeout(artifactSaveResetTimeout)
      artifactSaveResetTimeout = null
    }
    if (artifactAutosaveTimeout) {
      clearTimeout(artifactAutosaveTimeout)
      artifactAutosaveTimeout = null
    }
    dispatchDraftPreview(null)
  })

  $effect(() => {
    if (!slugEdited) {
      slug = slugifyName(editableName || selectedArtifact?.name || 'artifact')
    }
  })

  $effect(() => {
    if (!selectedArtifact) return

    artifactHydrating = true
    untrack(() => {
      editableIconRef = resolveArtifactIconRef(selectedArtifact)
      editableName = selectedArtifact.name || 'Untitled Artifact'
      slug = selectedArtifact.slug || slugifyName(selectedArtifact.name || 'artifact')
      slugEdited = false
      webhookUrl = selectedArtifact.webhook_url || ''
      editorContent = selectedArtifact.content || ''
      versionNote = ''
      zone = resolveZone(selectedArtifact)
      blueprintContent = selectedArtifact.blueprint || ''
      pendingMetadata = selectedArtifact.metadata || {}
      systemPrompt = selectedArtifact.system_prompt || selectedArtifact.custom_prompt || ''
      const agentUseEligibility = resolveArtifactAgentUseEligibility(selectedArtifact)
      agentUseEnabled = agentUseEligibility.eligible && selectedArtifact.agent_use_enabled !== false
      agentUseAllAgents =
        (agentUseEligibility.eligible &&
          (selectedArtifact as any).agent_access_scope === 'all') ||
        (agentUseEligibility.eligible &&
          (selectedArtifact as any).agent_access_scope !== 'selected' &&
          selectedArtifact.agent_use_enabled !== true &&
          !Array.isArray(selectedArtifact.agent_allowlist))
      agentAllowlist = agentUseEligibility.eligible && Array.isArray(selectedArtifact.agent_allowlist)
        ? [...selectedArtifact.agent_allowlist]
        : []

      powerSource = resolveArtifactPowerSource(selectedArtifact)
      artifactSaveState = 'idle'
      artifactSaveError = null
      artifactPersistedSignature = makeArtifactAutosaveSignature()
    })
    artifactHydrating = false
  })

  function hasFullArtifactDetail(artifact: ArtifactRow | null) {
    if (!artifact) return false
    if (typeof artifact.content !== 'string') return false
    if (!Array.isArray(artifact.versions)) return false
    return artifact.versions.every((version) => typeof version.content === 'string')
  }

  $effect(() => {
    const artifact = selectedArtifact
    if (!artifact || hasFullArtifactDetail(artifact)) return
    const serial = ++artifactDetailLoadSerial

    artifactService.getArtifact(artifact.id)
      .then((detail) => {
        if (!detail || serial !== artifactDetailLoadSerial) return
        artifacts = artifacts.map((entry) => (entry.id === detail.id ? detail : entry))
      })
      .catch((error) => {
        if (serial !== artifactDetailLoadSerial) return
        console.error('Failed to load artifact detail in settings:', error)
        artifactsError = error instanceof Error ? error.message : 'Failed to load artifact detail'
      })
  })

  $effect(() => {
    const artifact = selectedArtifact
    if (!artifact || artifact.mode === 'published') {
      dispatchDraftPreview(null)
      return
    }
    if (!resolveZone(artifact)) {
      dispatchDraftPreview(null)
      return
    }
    dispatchDraftPreview(artifact.id)
  })

  // Deep-link: auto-select artifact when initialArtifactId is provided
  $effect(() => {
    if (!initialArtifactId) {
      if (lastAppliedInitialArtifactId) lastAppliedInitialArtifactId = null
      return
    }
    if (initialArtifactId === lastAppliedInitialArtifactId) return
    if (artifactsLoading) return

    const target = artifacts.find((a) => a.id === initialArtifactId)
    if (!target) return

    untrack(() => {
      selectedArtifactId = target.id
    })
    lastAppliedInitialArtifactId = target.id
  })

  async function loadArtifacts(preserveSelection = true) {
    if (!userId) return

    artifactsLoading = true
    artifactsError = null
    const previousId = preserveSelection ? selectedArtifactId : null

    try {
      artifacts = await artifactService.getArtifacts(userId)
      if (artifacts.length === 0) {
        selectedArtifactId = null
        return
      }

      if (preserveSelection && previousId && artifacts.some((artifact) => artifact.id === previousId)) {
        selectedArtifactId = previousId
      } else if (!selectedArtifactId || !artifacts.some((artifact) => artifact.id === selectedArtifactId)) {
        selectedArtifactId = artifacts[0]?.id ?? null
      }
    } catch (error) {
      console.error('Failed to load artifacts in settings:', error)
      artifactsError = error instanceof Error ? error.message : 'Failed to load artifacts'
    } finally {
      artifactsLoading = false
    }
  }

  async function createArtifact() {
    if (!userId) {
      toast.error('Sign in first to create artifacts.')
      return
    }

    try {
      await flushArtifactAutosave()
      const created = await artifactService.createArtifact({
        name: 'New Artifact',
        type: 'html',
        content: DEFAULT_ARTIFACT_SCAFFOLD_CONTENT,
        mode: 'edit'
      })
      artifacts = [created, ...artifacts]
      selectedArtifactId = created.id
      artifactSaveState = 'idle'
      artifactSaveError = null
      notifyArtifactUpdated(created.id)
      toast.success('New artifact created.')
    } catch (error) {
      console.error('Failed to create artifact:', error)
      toast.error('Failed to create artifact')
    }
  }

  async function handleArtifactSelect(artifact: ArtifactRow | null) {
    await flushArtifactAutosave()
    selectedArtifactId = artifact?.id ?? null
  }

  async function handleArtifactDelete(artifactId: string) {
    try {
      deleteBusy = true
      await flushArtifactAutosave()
      await artifactService.deleteArtifact(artifactId)
      const remaining = artifacts.filter((a) => a.id !== artifactId)
      artifacts = remaining
      if (selectedArtifactId === artifactId) {
        selectedArtifactId = remaining[0]?.id ?? null
      }
      deleteDisclosureOpen = false
      notifyArtifactDeleted(artifactId)
      toast.success('Artifact deleted.')
    } catch (error) {
      console.error('Failed to delete artifact:', error)
      toast.error('Failed to delete artifact')
      throw error
    } finally {
      deleteBusy = false
    }
  }

  function deriveArtifactModeFromZone(zoneValue: string | null | undefined): ArtifactMode {
    return zoneValue ? 'published' : 'edit'
  }

  function getArtifactPlacementLabel(zoneValue: string | null | undefined): string {
    if (zoneValue === 'header') return 'Header'
    if (zoneValue === 'panel') return 'Panel'
    if (zoneValue === 'trigger') return 'Trigger'
    return 'Unpublished (Draft)'
  }

  function getArtifactPlacementDescription(zoneValue: string | null | undefined): string {
    if (zoneValue === 'header') return 'Published as a header icon.'
    if (zoneValue === 'panel') return 'Published as a panel artifact.'
    if (zoneValue === 'trigger') return 'Published in the Trigger dropdown.'
    return 'No Zone keeps this artifact unpublished while you work on it.'
  }

  function getArtifactStatusBadgeLabel(zoneValue: string | null | undefined): string {
    if (zoneValue === 'header') return 'Published to Header'
    if (zoneValue === 'panel') return 'Published to Panel'
    if (zoneValue === 'trigger') return 'Published to Trigger'
    return 'Unpublished (Draft)'
  }

  function handlePowerSourceChange(value: string) {
    const next = value as ArtifactPowerSource
    powerSource = next
    pendingMetadata = applyArtifactPowerSourceToMetadata(pendingMetadata, next)
  }

  function makeArtifactAutosaveSignature() {
    const sourceOption = getArtifactPowerSourceOption(powerSource)
    return JSON.stringify({
      icon_ref: editableIconRef,
      name: editableName.trim(),
      slug: slug.trim(),
      powerSource,
      webhookUrl: sourceOption.usesWebhook ? webhookUrl.trim() : '',
      zone: zone || null,
      mode: deriveArtifactModeFromZone(zone),
      agentUseEnabled,
      agentUseAllAgents,
      agentAllowlist: [...agentAllowlist],
      metadata: pendingMetadata
    })
  }

  function buildArtifactPayload(options?: {
    systemPromptValue?: string
    contentValue?: string
    blueprintValue?: string
    versionDescription?: string | null
    zoneValue?: string | null
  }) {
    const artifact = selectedArtifact
    if (!artifact) return null

    const nextZone = options?.zoneValue ?? zone
    const targetMode = deriveArtifactModeFromZone(nextZone)
    const sourceOption = getArtifactPowerSourceOption(powerSource)
    const metadata = applyArtifactPowerSourceToMetadata(pendingMetadata, powerSource)
    const agentUseEligibility = resolveArtifactAgentUseEligibility({
      ...artifact,
      brain_type: sourceOption.brainType,
      ai_enabled: sourceOption.brainType !== 'none',
      metadata,
      icon_ref: editableIconRef
    })
    const payloadAgentUseEnabled = agentUseEligibility.eligible ? agentUseEnabled : false
    const payloadAgentUseAllAgents = agentUseEligibility.eligible && agentUseAllAgents
    const payloadAgentAllowlist = agentUseEligibility.eligible ? agentAllowlist : []

    const payload: Record<string, any> = {
      icon_ref: editableIconRef,
      icon: null,
      name: editableName.trim() || 'Untitled Artifact',
      slug: slug?.trim() || null,
      content: options?.contentValue ?? editorContent,
      versionDescription: options?.versionDescription || undefined,
      brain_type: sourceOption.brainType,
      ai_enabled: sourceOption.brainType !== 'none',
      webhook_url: sourceOption.usesWebhook ? (webhookUrl.trim() || null) : null,
      system_prompt: sourceOption.acceptsSystemPrompt
        ? ((options?.systemPromptValue ?? systemPrompt) || null)
        : null,
      custom_prompt: sourceOption.acceptsSystemPrompt
        ? ((options?.systemPromptValue ?? systemPrompt) || null)
        : null,
      zone: nextZone || null,
      blueprint: options?.blueprintValue ?? (blueprintContent || null),
      widget_position: null,
      agent_use_enabled: payloadAgentUseEnabled,
      agent_access_scope: payloadAgentUseAllAgents ? 'all' : 'selected',
      agent_allowlist: payloadAgentAllowlist,
      metadata,
      sessionId: artifact.last_edited_session || artifact.created_in_session || '',
      mode: targetMode
    }

    return {
      artifactId: artifact.id,
      payload,
      targetMode
    }
  }

  async function putArtifactPayload(artifactId: string, payload: Record<string, any>) {
    const targetMode = (payload.mode ?? 'edit') as ArtifactMode
    const structureValidation = validateBatshitArtifactStructure(
      String(payload.content ?? ''),
      (payload.metadata as Record<string, any>) ?? {}
    )
    if (
      structureValidation.enforced &&
      !structureValidation.ok &&
      !artifactStructureValidationCanBeDeferred(String(payload.content ?? ''), targetMode)
    ) {
      throw new Error(buildArtifactStructureEnforcementMessage(structureValidation))
    }

    const runtimeSchemaReady =
      hasFabricFieldsMetadata((payload.metadata as Record<string, any>) ?? {}) ||
      isRunOnlyMetadata((payload.metadata as Record<string, any>) ?? {})

    let nextPayload = { ...payload }
    if (nextPayload.agent_use_enabled && targetMode === 'published' && !runtimeSchemaReady) {
      nextPayload = {
        ...nextPayload,
        agent_use_enabled: false
      }
    }

    const response = await fetch(`/api/artifacts/${artifactId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextPayload)
    })

    if (!response.ok) {
      const message = await response.text()
      throw new Error(message || 'Failed to save artifact')
    }

    return (await response.json()) as ArtifactRow
  }

  function markArtifactSaved() {
    artifactSaveState = 'saved'
    artifactSaveError = null
    if (artifactSaveResetTimeout) {
      clearTimeout(artifactSaveResetTimeout)
    }
    artifactSaveResetTimeout = setTimeout(() => {
      if (artifactSaveState === 'saved') {
        artifactSaveState = 'idle'
      }
    }, 1600)
  }

  function applyUpdatedArtifact(updated: ArtifactRow, signature?: string | null) {
    artifacts = artifacts.map((item) => (item.id === updated.id ? updated : item))
    if (selectedArtifactId === updated.id) {
      untrack(() => {
        pendingMetadata = updated.metadata || pendingMetadata
        const agentUseEligibility = resolveArtifactAgentUseEligibility(updated)
        agentUseEnabled = agentUseEligibility.eligible && updated.agent_use_enabled !== false
        agentUseAllAgents = agentUseEligibility.eligible && (updated as any).agent_access_scope === 'all'
        agentAllowlist = agentUseEligibility.eligible && Array.isArray(updated.agent_allowlist)
          ? [...updated.agent_allowlist]
          : []
        artifactPersistedSignature = signature ?? makeArtifactAutosaveSignature()
      })
    }
    notifyArtifactUpdated(updated.id)
  }

  async function persistQueuedArtifactAutosave() {
    const queued = queuedArtifactAutosave
    if (!queued) return

    queuedArtifactAutosave = null

    try {
      const updated = await putArtifactPayload(queued.artifactId, queued.payload)
      applyUpdatedArtifact(updated, queued.signature)
      markArtifactSaved()
    } catch (error) {
      console.error('Failed to autosave artifact:', error)
      artifactSaveState = 'idle'
      artifactSaveError = error instanceof Error ? error.message : 'Failed to save artifact'
      throw error
    }
  }

  function queueArtifactAutosave(artifactId: string, signature: string, payload: Record<string, any>) {
    if (artifactAutosaveTimeout) {
      clearTimeout(artifactAutosaveTimeout)
    }

    queuedArtifactAutosave = { artifactId, signature, payload }
    artifactAutosaveTimeout = setTimeout(() => {
      artifactAutosaveTimeout = null
      void persistQueuedArtifactAutosave().catch(() => {
        // inline save errors are surfaced through the sticky save-status chip
      })
    }, DEFAULT_ARTIFACT_AUTOSAVE_DEBOUNCE_MS)
  }

  async function flushArtifactAutosave() {
    if (artifactAutosaveTimeout) {
      clearTimeout(artifactAutosaveTimeout)
      artifactAutosaveTimeout = null
    }
    if (!queuedArtifactAutosave) return
    await persistQueuedArtifactAutosave()
  }

  async function saveArtifactEditorValue(options: {
    systemPromptValue?: string
    contentValue?: string
    blueprintValue?: string
  }) {
    const built = buildArtifactPayload({
      ...options,
      versionDescription: versionNote || null
    })
    if (!built) return

    const updated = await putArtifactPayload(built.artifactId, built.payload)
    applyUpdatedArtifact(updated, null)
    versionNote = ''
    markArtifactSaved()
  }

  function dispatchDraftPreview(artifactId: string | null) {
    dispatchArtifactDraftPreview(artifactId)
  }

  function notifyArtifactUpdated(artifactId: string) {
    dispatchArtifactUpdated(artifactId)
  }

  function notifyArtifactDeleted(artifactId: string) {
    dispatchArtifactDeleted(artifactId)
  }

  function setArtifactStructureEnforced(enabled: boolean) {
    pendingMetadata = applyBatshitArtifactStructureSetting(pendingMetadata, enabled)
  }

  function setAgentUseEnabled(enabled: boolean) {
    if (!enabled) {
      agentUseEnabled = false
      return
    }

    if (!selectedAgentUseEligibility.eligible) {
      agentUseEnabled = false
      agentUseAllAgents = false
      return
    }

    if (!artifactRuntimeSchemaReady(pendingMetadata)) {
      agentUseEnabled = false
      return
    }

    agentUseEnabled = true
  }

  function slugifyName(value: string) {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '') || 'artifact'
    )
  }

  $effect(() => {
    if (!selectedArtifact || artifactHydrating) return

    const signature = makeArtifactAutosaveSignature()
    if (!artifactPersistedSignature || signature === artifactPersistedSignature) {
      return
    }

    const built = buildArtifactPayload()
    if (!built) return

    artifactSaveState = 'saving'
    artifactSaveError = null
    queueArtifactAutosave(built.artifactId, signature, built.payload)
  })

  async function saveSystemPromptFromEditor(nextValue: string) {
    await saveArtifactEditorValue({ systemPromptValue: nextValue })
  }

  async function saveContentFromEditor(nextValue: string) {
    await saveArtifactEditorValue({ contentValue: nextValue })
  }

  async function saveBlueprintFromEditor(nextValue: string) {
    await saveArtifactEditorValue({ blueprintValue: nextValue })
  }

  async function copyContent() {
    const content = editorContent
    if (!content) {
      toast.error('No content to copy.')
      return
    }
    try {
      await copyTextToClipboard(content)
      toast.success('Content copied to clipboard.')
    } catch {
      toast.error('Failed to copy content.')
    }
  }

  async function downloadArtifact() {
    if (!editorContent) {
      toast.error('No content to download.')
      return
    }
    try {
      const result = await downloadText(editorContent, `${slug || editableName || 'artifact'}.html`, {
        title: 'Download Artifact HTML',
        mimeType: 'text/html'
      })
      if (!result.canceled) toast.success('Artifact download started.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to download artifact.')
    }
  }

  function resolveZone(artifact: ArtifactRow | null): string | null {
    if (!artifact) return null
    if (artifact.zone) return artifact.zone
    if (artifact.widget_position === 'header-icon') return 'header'
    if (artifact.widget_position === 'header-dropdown') return 'trigger'
    if (artifact.widget_position === 'panel-tab') return 'panel'
    return null
  }

</script>

<div class="space-y-4">
  <input
    bind:this={iconUploadInput}
    type="file"
    accept="image/svg+xml,image/png,.svg,.png"
    class="hidden"
    onchange={handleIconUpload}
  />

  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex items-center gap-2">
      <BatshitIcon id="artifacts" class="h-5 w-5 text-muted-foreground" />
      <h3 class="batshit-settings-section-title">Artifacts</h3>
      <SettingsInfoMenu ariaLabel="About Artifacts" contentClass="w-80">
        <p>
          Artifacts are saved tools and mini-apps that can live in Batshit zones. `No Zone` keeps an
          artifact unpublished while you build it, and assigning a real zone makes it live there.
        </p>
      </SettingsInfoMenu>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" onclick={() => void loadArtifacts()}>
        <RefreshCcw  />
        Refresh
      </Button>
      <Button variant="outline" size="sm" onclick={() => void createArtifact()}>
        <Plus  />
        New Artifact
      </Button>
    </div>
  </div>

  <div class="batshit-settings-surface">
    <div class="space-y-4">
      {#if artifactsLoading}
        <div class="flex items-center justify-center batshit-settings-empty-state">
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          Loading artifacts…
        </div>
      {:else if artifactsError}
        <Card.Root class="batshit-settings-card batshit-settings-card-default">
          <Card.Header>
            <Card.Title class="batshit-settings-title-danger flex items-center gap-2">
              <BatshitIcon id="artifacts" class="h-4 w-4" />
              Failed to Load Artifacts
            </Card.Title>
            <Card.Description>{artifactsError}</Card.Description>
          </Card.Header>
          <Card.Content>
            <Button variant="outline" onclick={() => void loadArtifacts()}>
              <RefreshCcw  />
              Retry
            </Button>
          </Card.Content>
        </Card.Root>
      {:else}
        <div class="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <Card.Root class="batshit-settings-card batshit-settings-card-default">
            <Card.Header class="pb-2">
              <div class="flex items-center gap-1">
                <Card.Title class="flex items-center gap-2">
                  <BatshitIcon id="artifacts" class="h-4 w-4" />
                  Saved Artifacts
                </Card.Title>
                <SettingsInfoMenu ariaLabel="About Saved Artifacts">
                  <p>
                    Pick an artifact to edit. The saved list replaces the old gallery-style catalog for
                    settings work.
                  </p>
                </SettingsInfoMenu>
              </div>
            </Card.Header>
            <Card.Content class="batshit-settings-card-content-flush">
              {#if artifacts.length === 0}
                <div class="batshit-settings-empty-state">
                  No artifacts yet. Create one to start building a new zone tool.
                </div>
              {:else}
                <div class="settings-sidebar-items">
                  {#each artifacts as artifact (artifact.id)}
                    {@const artifactZone = resolveZone(artifact)}
                    <button
                      type="button"
                      class="settings-sidebar-item settings-sidebar-item-with-avatar"
                      data-state={artifact.id === selectedArtifactId ? 'active' : 'inactive'}
                      onclick={() => void handleArtifactSelect(artifact)}
                    >
                      <div class="settings-sidebar-item-media pt-0.5">
                        <span class="relative inline-flex shrink-0">
                          <div class="batshit-settings-icon-frame h-9 w-9 text-base">
                            <IconRenderer
                              ref={resolveArtifactIconRef(artifact)}
                              {customIcons}
                              label={artifact.name || 'Artifact'}
                              iconClass="h-5 w-5 text-muted-foreground"
                            />
                          </div>
                          <ArtifactSourceBadge artifact={artifact} class="absolute -bottom-1 -right-1" />
                        </span>
                      </div>
                      <div class="settings-sidebar-item-content">
                        <span class="settings-sidebar-item-title truncate">
                          {artifact.name || 'Untitled Artifact'}
                        </span>
                        <span class="settings-sidebar-item-subtext truncate">
                          {getArtifactPlacementLabel(artifactZone)}
                        </span>
                      </div>
                    </button>
                  {/each}
                </div>
              {/if}
            </Card.Content>
          </Card.Root>

          <div class="space-y-4">
            {#if selectedArtifact}
              <SettingsAccordionCard
                name="artifact-detail-cards"
                title="Artifact Settings"
                batshitIcon="artifacts"
                contentClass="space-y-4"
                open
              >
                {#snippet info()}
                      <SettingsInfoMenu ariaLabel="About Artifact Settings" contentClass="w-80">
                        <p>
                          Placement drives publish state now. `No Zone` keeps this artifact as a
                          draft, and assigning a real zone makes it live there.
                        </p>
                      </SettingsInfoMenu>
                {/snippet}
                {#snippet actions()}
                  <div class="batshit-settings-badge-row flex flex-wrap items-center justify-end gap-2">
                    {#if selectedPowerSourcePreviewArtifact}
                      <ArtifactSourceBadge artifact={selectedPowerSourcePreviewArtifact} showLabel size="sm" />
                    {/if}
                    <span class="inline-flex items-center batshit-settings-pill is-strong">
                      {getArtifactStatusBadgeLabel(zone)}
                    </span>
                    <SettingsSaveStatus
                      state={artifactSaveError ? 'error' : artifactSaveState}
                      error={artifactSaveError}
                      savedLabel="Artifact Saved"
                    />
                  </div>
                {/snippet}
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label">Artifact Name</Label.Root>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input bind:value={editableName} />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label">Icon</Label.Root>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <IconPicker
                          bind:value={editableIconRef}
                          {customIcons}
                          triggerLabel={iconUploading ? 'Uploading...' : 'Choose Icon'}
                          onUploadRequested={requestIconUpload}
                          onCustomIconsChange={(icons) => (customIcons = icons)}
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label">Slug</Label.Root>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          value={slug}
                          oninput={(event) => {
                            slug = (event.currentTarget as HTMLInputElement).value
                            slugEdited = true
                          }}
                          placeholder="artifact_slug"
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label">Artifact Power Source</Label.Root>
                          <SettingsInfoMenu ariaLabel="About Artifact Power Source" contentClass="w-80">
                            <p>
                              Choose what powers this artifact. This sets the source badge and maps
                              to the correct runtime fields behind the scenes.
                            </p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={powerSource}
                          onValueChange={handlePowerSourceChange}
                        >
                          <Select.Trigger>
                            <span data-slot="select-value" class="flex items-center gap-2 text-sm">
                              <IconRenderer
                                ref={selectedPowerSourceOption.iconRef}
                                label={selectedPowerSourceOption.label}
                                class="h-5 w-5"
                                iconClass="h-4 w-4"
                              />
                              {selectedPowerSourceOption.label}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each ARTIFACT_POWER_SOURCE_OPTIONS as option (option.value)}
                              <Select.Item value={option.value} label={option.label}>
                                <div class="flex min-w-0 items-center gap-2">
                                  <IconRenderer
                                    ref={option.iconRef}
                                    label={option.label}
                                    class="h-5 w-5 shrink-0"
                                    iconClass="h-4 w-4"
                                  />
                                  <div class="min-w-0">
                                    <div class="batshit-settings-form-label truncate">{option.label}</div>
                                    <div class="truncate text-xs text-muted-foreground">{option.description}</div>
                                  </div>
                                </div>
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      </div>
                    </div>

                    {#if selectedPowerSourceOption.usesWebhook}
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <Label.Root class="batshit-settings-form-label">Webhook URL</Label.Root>
                          </div>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Input
                            placeholder="https://your-endpoint/webhook"
                            bind:value={webhookUrl}
                          />
                        </div>
                      </div>
                    {/if}
                  </div>

              </SettingsAccordionCard>

              <SettingsAccordionCard
                name="artifact-detail-cards"
                title="Placement"
                batshitIcon="zones"
                contentClass="space-y-3"
              >
                {#snippet info()}
                    <SettingsInfoMenu ariaLabel="About Artifact Placement" contentClass="w-80">
                      <p>
                        `No Zone` keeps the artifact unpublished. Choosing `Header`, `Panel`, or
                        `Trigger` publishes it into that zone.
                      </p>
                    </SettingsInfoMenu>
                {/snippet}
                  <div class="batshit-settings-note is-dashed">
                    {getArtifactPlacementDescription(zone)}
                  </div>
                  <div class="grid gap-2 sm:grid-cols-2">
                    {#each artifactPlacementOptions as option}
                      <button
                        type="button"
                        class={`batshit-settings-option-card ${zone === option.value ? 'is-selected' : ''}`}
                        onclick={() => (zone = option.value)}
                      >
                        <div class="flex items-center gap-2">
                          <BatshitIcon id={option.batshitIcon} class="h-4 w-4 text-muted-foreground" />
                          <span class="batshit-settings-form-label">{option.label}</span>
                        </div>
                        <p class="mt-2 text-xs text-muted-foreground">{option.description}</p>
                      </button>
                    {/each}
                  </div>
              </SettingsAccordionCard>

              <SettingsAccordionCard
                name="artifact-detail-cards"
                title="Runtime Readiness & Agent Use"
                batshitIcon="artifacts"
                contentClass="space-y-4"
              >
                {#snippet info()}
                    <SettingsInfoMenu ariaLabel="About Runtime Readiness and Agent Use" contentClass="w-80">
                      <p>
                        This card covers the Builder Kit/Fabric readiness rule plus the artifact-level
                        agent gate. Selected-agent assignment still lives in `Agent Settings -> Access`.
                      </p>
                    </SettingsInfoMenu>
                {/snippet}
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-toggle-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <p class="batshit-settings-parent-label">Enforce Batshit Artifact Structure</p>
                          <SettingsInfoMenu ariaLabel="About Enforce Batshit Artifact Structure" contentClass="w-80">
                            <p>
                              Default-on guardrail for Builder Kit and Fabric runtime wiring. Turn this
                              off only when you intentionally want a raw/manual artifact without Batshit
                              structure enforcement.
                            </p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <Switch.Root
                        checked={artifactStructureEnforced}
                        onCheckedChange={(checked) => setArtifactStructureEnforced(checked === true)}
                      />
                    </div>
                  </div>

                  {#if artifactStructureEnforced}
                    {#if artifactStructureValidationCanBeDeferred(editorContent, deriveArtifactModeFromZone(zone))}
                      <div class="batshit-settings-note is-dashed">
                        Blank scaffold artifacts can exist first. As soon as real content is saved,
                        Builder Kit plus Fabric become required unless you turn this off.
                      </div>
                    {:else if !artifactStructureValidation.ok}
                      <div class="batshit-settings-inline-alert is-warning space-y-2">
                        <p class="batshit-settings-form-label">
                          This artifact will not save until these are fixed:
                        </p>
                        {#each artifactStructureValidation.issues as issue (issue.code)}
                          <p class="batshit-settings-form-label">- {issue.message}</p>
                        {/each}
                      </div>
                    {:else}
                      <div class="batshit-settings-inline-alert is-success">
                        Structure check passed. Builder Kit and Fabric requirements are present for
                        the current draft.
                      </div>
                    {/if}
                  {:else}
                    <div class="batshit-settings-note is-dashed">
                      Raw/manual HTML can save for this artifact until you turn structure
                      enforcement back on.
                    </div>
                  {/if}

                  {#if !selectedAgentUseEligibility.eligible}
                    <p class="batshit-settings-caption px-3">
                      {selectedAgentUseEligibility.message}
                    </p>
                  {:else}
                    <div class="batshit-settings-form-stack">
                      <div class="batshit-settings-toggle-row">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <p class="batshit-settings-parent-label">Agent Use</p>
                            <SettingsInfoMenu ariaLabel="About Agent Use" contentClass="w-80">
                              <p>
                                Allows AI agents to discover this artifact through the runtime wrappers.
                                This is the artifact-level master switch.
                              </p>
                            </SettingsInfoMenu>
                          </div>
                        </div>
                        <Switch.Root
                          checked={agentUseEnabled}
                          onCheckedChange={(checked) => setAgentUseEnabled(checked === true)}
                        />
                      </div>

                      <div class={`batshit-settings-toggle-row ${agentUseEnabled ? '' : 'opacity-50'}`}>
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <p class="batshit-settings-parent-label">Enable For All Agents</p>
                            <SettingsInfoMenu ariaLabel="About Enable For All Agents" contentClass="w-80">
                              <p>Turn this on to make the artifact available to every agent.</p>
                              <p class="mt-2">
                                Leave it off when you want selected-agent access managed in
                                `Agent Settings -> Access`.
                              </p>
                              <p class="mt-2">
                                Existing selected-agent assignments stay preserved behind the scenes when
                                this global toggle is off.
                              </p>
                            </SettingsInfoMenu>
                          </div>
                        </div>
                        <Switch.Root bind:checked={agentUseAllAgents} disabled={!agentUseEnabled} />
                      </div>
                    </div>

                    {#if agentUseEnabled && !artifactRuntimeSchemaReady(pendingMetadata)}
                      <div class="batshit-settings-note is-dashed">
                        This artifact is not agent-ready yet. Add Fabric fields or run-only metadata
                        before enabling agent use.
                      </div>
                    {/if}

                    {#if !agentUseEnabled}
                      <div class="batshit-settings-note is-dashed">
                        Agents cannot discover or use this artifact until you turn Agent Use on.
                      </div>
                    {/if}
                  {/if}
              </SettingsAccordionCard>

              <SettingsAccordionCard
                name="artifact-detail-cards"
                title="Artifact Editors"
                batshitIcon="artifacts"
                contentClass="space-y-3"
              >
                {#snippet info()}
                    <SettingsInfoMenu ariaLabel="About Artifact Editors" contentClass="w-80">
                      <p>
                        Multiline fields follow the Lane D manual-save rule. Use the editor popups for
                        prompts, code, and blueprint notes instead of inline textareas.
                      </p>
                    </SettingsInfoMenu>
                {/snippet}
                <div class="batshit-settings-form-stack">
                  {#if selectedPowerSourceOption.acceptsSystemPrompt}
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <MessageSquare class="h-3.5 w-3.5 text-muted-foreground" />
                          <p class="batshit-settings-form-label">Artifact System Prompt</p>
                          <SettingsInfoMenu ariaLabel="About Artifact System Prompt">
                            <p>Runtime instructions for this artifact's selected power source.</p>
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control is-compact-action">
                        <Button type="button" variant="outline" size="sm" onclick={() => (systemPromptEditorOpen = true)}>
                          <Pencil aria-hidden="true" />

                          Edit
                        </Button>
                      </div>
                    </div>
                  {/if}

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <FileCode class="h-3.5 w-3.5 text-muted-foreground" />
                          <p class="batshit-settings-form-label">Artifact HTML / Code</p>
                          <SettingsInfoMenu ariaLabel="About Artifact HTML / Code">
                            <p>Main artifact source. Use the editor popup for focused code changes.</p>
                          </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <div class="batshit-settings-spine-control-cell">
                        <Button type="button" variant="outline" size="sm" onclick={() => (contentEditorOpen = true)}>
                          <Pencil aria-hidden="true" />

                          Edit
                        </Button>
                        <Button type="button" variant="ghost" size="icon" onclick={copyContent} title="Copy HTML to clipboard">
                          <Copy  />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" onclick={downloadArtifact} title="Download HTML">
                          <Download  />
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <FileText class="h-3.5 w-3.5 text-muted-foreground" />
                          <p class="batshit-settings-form-label">Blueprint / Build Notes</p>
                          <SettingsInfoMenu ariaLabel="About Blueprint / Build Notes">
                            <p>Markdown notes for how the artifact works or what still needs work.</p>
                          </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-compact-action">
                      <Button type="button" variant="outline" size="sm" onclick={() => (blueprintEditorOpen = true)}>
                        <Pencil aria-hidden="true" />

                        Edit
                      </Button>
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Next Version Note</Label.Root>
                        <SettingsInfoMenu ariaLabel="About Version Notes">
                          <p>
                            This note is attached to the next manual editor save so you can explain what
                            changed in the saved version.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        placeholder="Optional note for the next prompt/code/blueprint save"
                        bind:value={versionNote}
                      />
                    </div>
                  </div>
                </div>
              </SettingsAccordionCard>

              <Collapsible.Root bind:open={deleteDisclosureOpen}>
                <div>
                  <Collapsible.Trigger class="batshit-settings-delete-trigger">
                    <span class="batshit-settings-delete-trigger-label">
                      <Trash2 class="batshit-settings-delete-trigger-icon" />
                      Delete Artifact
                    </span>
                    <ChevronDown
                      class={`batshit-settings-delete-chevron ${deleteDisclosureOpen ? 'is-open' : ''}`}
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content class="batshit-settings-delete-content">
                    <div class="batshit-settings-delete-content-inner">
                      <div class="batshit-settings-delete-copy">
                        <p>Permanently removes this artifact and any current zone placement.</p>
                        <p>Use this when the artifact should be retired or rebuilt cleanly.</p>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        class="batshit-settings-delete-action"
                        onclick={() => void handleArtifactDelete(selectedArtifact.id)}
                        disabled={deleteBusy}
                      >
                        {#if deleteBusy}
                          <Loader2 class="batshit-settings-delete-action-icon is-spinning" />
                        {:else}
                          <Trash2 class="batshit-settings-delete-action-icon" />
                        {/if}
                        Delete Artifact
                      </Button>
                    </div>
                  </Collapsible.Content>
                </div>
              </Collapsible.Root>
            {:else}
              <Card.Root class="batshit-settings-card batshit-settings-card-default">
                <Card.Header>
                  <Card.Title class="flex items-center gap-2">
                    <BatshitIcon id="artifacts" class="h-4 w-4" />
                    Artifact Settings
                  </Card.Title>
                  <Card.Description>Select an artifact from the saved list or create a new one.</Card.Description>
                </Card.Header>
              </Card.Root>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<SettingsTextEditor
  bind:open={systemPromptEditorOpen}
  title="Artifact System Prompt"
  description="Edit the runtime instructions for this artifact's selected power source."
  value={systemPrompt}
  placeholder="Runtime instructions for this artifact"
  width="large"
  onSave={saveSystemPromptFromEditor}
/>

<SettingsTextEditor
  bind:open={contentEditorOpen}
  title="Artifact HTML / Code"
  description="Edit the artifact source in a dedicated save flow."
  value={editorContent}
  placeholder={DEFAULT_ARTIFACT_SCAFFOLD_CONTENT}
  width="full"
  onSave={saveContentFromEditor}
/>

<SettingsTextEditor
  bind:open={blueprintEditorOpen}
  title="Artifact Blueprint / Build Notes"
  description="Use markdown for build notes, TODOs, and implementation guidance."
  value={blueprintContent}
  placeholder="Use markdown for build notes and progress."
  width="large"
  onSave={saveBlueprintFromEditor}
/>
