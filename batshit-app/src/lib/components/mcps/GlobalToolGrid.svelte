<script lang="ts">
  import { onDestroy } from 'svelte'
  import * as Switch from '$lib/components/ui/switch'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import GlobalZipControlStrip from '$lib/components/mcps/GlobalZipControlStrip.svelte'
  import NonMcpZipRowsSection from '$lib/components/mcps/NonMcpZipRowsSection.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import ToolGridIdentityIcon from '$lib/components/tools/ToolGridIdentityIcon.svelte'
  import {
    DEFAULT_CLI_TOOL_ICON_REF,
    DEFAULT_MCP_GATEWAY_ICON_REF,
    DEFAULT_MCP_GROUP_ICON_REF
  } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import type { IconRef } from '$lib/icons/iconTypes'
  import {
    buildGatewayGroupsFromCache,
    resolveGatewayToolGroups,
    type GatewayToolsResponse,
    type ToolGridGroupRow
  } from '$lib/components/mcps/gatewayToolCatalog'
  import {
    Loader2,
    RefreshCw,
    Check,
    ChevronDown,
    Clock3,
    Grid3X3,
    Infinity,
    Signal,
    SignalMedium,
    Zap,
    RotateCcw
  } from '@lucide/svelte'
  import { debounce } from '$lib/utils/debounce'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import {
    formatToolGridInheritedZipBehaviorLabel,
    formatToolGridZipBehaviorLabel,
    SHARED_NON_MCP_TOOL_GRID_CONFIG,
    SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS,
    SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS,
    TOOL_GRID_BATSHIT_SECTION_ICON_REF,
    TOOL_GRID_OTHER_SECTION_ICON_REF,
    type SharedNonMcpToolGridRowConfig,
    type SharedNonMcpToolGridRowId,
    type ToolGridAutoZipValue
  } from '$lib/components/tools/toolGridConfig'
	  import {
	    CLI_TOOL_GRID_GROUP_NAME,
	    CLI_TOOL_GRID_ID,
	    createDefaultCliToolGridSettings,
	    normalizeCliToolGridSettings
	  } from '$lib/utils/toolGridCli'
	  import {
	    ARTIFACT_TOOL_GRID_GROUP_NAME,
	    ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS,
	    createDefaultArtifactToolGridSettings,
	    createDefaultFabricToolGridSettings,
	    FABRIC_TOOL_GRID_GROUP_NAME,
	    FABRIC_TOOL_GRID_INFO_PARAGRAPHS,
	    normalizeArtifactToolGridSettings,
	    normalizeFabricToolGridSettings,
	    TOOL_GRID_ARTIFACT_ICON_REF,
	    TOOL_GRID_FABRIC_ICON_REF,
	    type BrokerFamilyToolGridKey
	  } from '$lib/utils/toolGridBrokerFamilies'
	  import type { BrokerFamilyRowControls } from '$lib/components/tools/brokerFamilyRowControls'
	  import {
	    createDefaultGatewayDcmDisplaySettings,
	    normalizeGatewayDcmDisplaySettings,
	    normalizeLegacyDcmGroupMode as normalizeLegacyGroupMode,
	    normalizeLegacyDcmToolMode,
	    VALID_DCM_GLOBAL_GROUP_MODES as VALID_GROUP_MODES,
	    VALID_DCM_TOOL_DISPLAY_MODES as VALID_TOOL_MODES
	  } from '$lib/utils/dcmDisplaySettings'
	  import { getToolGridDefaultAutoZip, getToolGridDefaultNumber } from '$lib/utils/toolGridZipDefaults'
  import {
    MAX_ZIP_THRESHOLD,
    normalizeZipBufferInputValue,
    normalizeZipThresholdInputValue
  } from '$lib/utils/zipBufferInput'
  import type {
    DcmGroupDisplayMode,
    DcmToolDisplayMode,
    GatewayDcmDisplaySettings,
    MCPGateway,
    UserSettingsRow
  } from '$lib/types/database'

  interface CliToolCatalogRow {
    toolId: string
    title: string
    description?: string
    riskLevel?: string
    iconRef: IconRef
  }

  type GroupRow = ToolGridGroupRow

  interface GatewayRow {
    id: string
    name: string
    iconRef: IconRef
    enabled: boolean
    defaults: GatewayDcmDisplaySettings
    groups: GroupRow[]
  }

  type SaveState = 'idle' | 'saving' | 'saved' | 'error'
  type GroupIconMode = 'group-only' | 'group+tools+names' | 'group+tools+hints'
  type ToolIconMode = 'name-only' | 'name+hint'
  type AutoZipValue = ToolGridAutoZipValue

  type CustomToolSetting = {
    tool_name: string
    buffer_size?: number
    zip_threshold?: number
    auto_zip?: boolean
    zip_disabled?: boolean
  }

  type BulkZipDraft = {
    buffer_size: string
    zip_threshold: string
  }

  type BulkZipPatch = {
    buffer_size?: string
    zip_threshold?: string
  }

  type GlobalZipSettings = {
    buffer_size_all_other_tools?: number
    zip_threshold_all_other_tools?: number
    auto_zip_all_other_tools?: boolean
    custom_tool_settings?: CustomToolSetting[]
    [key: string]: unknown
  }

  interface ToolZipOverride {
    buffer_size: string
    zip_threshold: string
    auto_zip: AutoZipValue
    inherited_buffer_size: number
    inherited_zip_threshold: number
    inherited_auto_zip: boolean
    inherited_zip_disabled: boolean
  }

  type GlobalZipNumericField =
    | 'buffer_size_image'
    | 'zip_threshold_image'
    | 'buffer_size_subagent'
    | 'zip_threshold_subagent'
    | 'buffer_size_read_file'
    | 'zip_threshold_read_file'
    | 'buffer_size_execute_command'
    | 'zip_threshold_execute_command'
    | 'buffer_size_write_file'
    | 'zip_threshold_write_file'
    | 'buffer_size_edit_file'
    | 'zip_threshold_edit_file'
    | 'buffer_size_list_files'
    | 'zip_threshold_list_files'
    | 'buffer_size_all_other_tools'
    | 'zip_threshold_all_other_tools'

  type GlobalZipAutoField =
    | 'auto_zip_image'
    | 'auto_zip_subagent'
    | 'auto_zip_read_file'
    | 'auto_zip_execute_command'
    | 'auto_zip_write_file'
    | 'auto_zip_edit_file'
    | 'auto_zip_list_files'
    | 'auto_zip_all_other_tools'

  type OtherZipRowId = SharedNonMcpToolGridRowId

  type OtherZipRowConfig = SharedNonMcpToolGridRowConfig

  interface OtherZipRowOverride {
    buffer_size: string
    zip_threshold: string
    auto_zip: AutoZipValue
    inherited_buffer_size: number
    inherited_zip_threshold: number
    inherited_auto_zip: boolean
    inherited_zip_disabled: boolean
    min_buffer: number
  }

  interface Props {
    userId?: string | null
  }

  let { userId = null }: Props = $props()

  const GROUP_DISPLAY_OPTIONS: Array<{ value: DcmGroupDisplayMode; label: string }> = [
    { value: 'group+tools+hints', label: 'Group + tools + hints' },
    { value: 'group+tools+names', label: 'Group + tool names' },
    { value: 'group-only', label: 'Group only' }
  ]

  const TOOL_DISPLAY_OPTIONS: Array<{ value: DcmToolDisplayMode; label: string }> = [
    { value: 'inherit', label: 'Inherit group/default' },
    { value: 'name+hint', label: 'Name + hint' },
    { value: 'name-only', label: 'Name only' }
  ]

  const MIN_BUFFER = 1
  const MIN_IMAGE_BUFFER = 0
  const MAX_BUFFER = 50
  const BATSHIT_ROWS_KEY = '__batshit_rows__'
  const OTHER_ROWS_KEY = '__other_rows__'
  const TOOL_GRID_TABLE_CLASS = 'w-full min-w-[820px] table-fixed text-xs'
  const TOOL_GRID_FIRST_COLUMN_CLASS = 'w-[35%]'
  const TOOL_GRID_OTHER_COLUMN_CLASS = 'w-[13%]'
  const DEFAULT_GLOBAL_ZIP_AGENT_CONTROL_ENABLED = true
  const DEFAULT_GLOBAL_ZIP_AI_VIEW_MODE = 'appended' as const
  const DEFAULT_GLOBAL_ZIP_TOOL_NOTES_ENABLED = true
  const GLOBAL_RESET_SAVE_KEY = '__global_tool_grid_reset__'

  const OTHER_ZIP_ROW_CONFIG: Record<OtherZipRowId, OtherZipRowConfig> =
    SHARED_NON_MCP_TOOL_GRID_CONFIG as Record<OtherZipRowId, OtherZipRowConfig>

  const BATSHIT_ROW_ORDER: OtherZipRowId[] = SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS
  const OTHER_ROW_ORDER: OtherZipRowId[] = SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS

  let loading = $state(false)
  let loadError = $state<string | null>(null)
  let gateways = $state<GatewayRow[]>([])
  let cliToolCatalog = $state<CliToolCatalogRow[]>([])

  let saveStateByGateway = $state<Record<string, SaveState>>({})
  let saveErrorByGateway = $state<Record<string, string>>({})
  let saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let saveResetTimers = new Map<string, ReturnType<typeof setTimeout>>()

  let openTopLevelAccordionItemKey = $state<string | null>(null)
  let openNestedAccordionItemKey = $state<string | null>(null)
  let groupRestoreModes = $state<Record<string, DcmGroupDisplayMode>>({})
  let toolRestoreModes = $state<Record<string, DcmToolDisplayMode>>({})

  let globalZipSettingsRaw = $state<GlobalZipSettings>({})
  let globalCliToolGridSettings = $state(createDefaultCliToolGridSettings())
  let globalFabricToolGridSettings = $state(createDefaultFabricToolGridSettings())
  let globalArtifactToolGridSettings = $state(createDefaultArtifactToolGridSettings())
  let customToolSettings = $state<CustomToolSetting[]>([])
  let bulkZipDrafts = $state<Record<string, BulkZipDraft>>({})
  let zipAgentControlEnabled = $state(false)
  let zipAiViewMode = $state<'inline' | 'appended'>('appended')
  let zipToolNotesEnabled = $state(true)
  let zipSaveState = $state<SaveState>('idle')
  let zipSaveError = $state<string | null>(null)
  let zipResetTimer: ReturnType<typeof setTimeout> | null = null
  let globalResetBusy = $state(false)

  const topLevelAccordionRowClass = 'batshit-settings-accordion-row'
  const nestedAccordionRowClass = 'batshit-settings-accordion-row is-nested'

  const gatewaySaveStatusState = $derived.by(() => {
    const states = Object.values(saveStateByGateway)
    if (states.some((state) => state === 'saving')) return 'saving'
    if (states.some((state) => state === 'error')) return 'error'
    if (states.some((state) => state === 'saved')) return 'saved'
    return 'idle'
  })

  const gatewaySaveStatusError = $derived.by(() => {
    const firstErrorKey = Object.keys(saveErrorByGateway)[0]
    return firstErrorKey ? saveErrorByGateway[firstErrorKey] ?? null : null
  })

  const createDefaultGatewayDcmDisplayDefaults = createDefaultGatewayDcmDisplaySettings
  const normalizeGatewayDcmDisplayDefaults = normalizeGatewayDcmDisplaySettings
  const normalizeLegacyToolMode = normalizeLegacyDcmToolMode

  function normalizeForSave(value: GatewayDcmDisplaySettings): GatewayDcmDisplaySettings {
    return normalizeGatewayDcmDisplayDefaults(value)
  }

  function sortByName<T extends { name: string }>(rows: T[]): T[] {
    return [...rows].sort((left, right) => left.name.localeCompare(right.name))
  }

  function getGroupIconRef(group: GroupRow): IconRef {
    return normalizeIconRef(group.iconRef, DEFAULT_MCP_GROUP_ICON_REF)
  }

  function getCliToolIconRef(tool: CliToolCatalogRow): IconRef {
    return normalizeIconRef(tool.iconRef, DEFAULT_CLI_TOOL_ICON_REF)
  }

  function normalizeGlobalZipSettings(value: unknown): GlobalZipSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return { ...(value as Record<string, unknown>) }
  }

  function normalizeCustomToolSettings(value: unknown): CustomToolSetting[] {
    if (!Array.isArray(value)) return []

    const next: CustomToolSetting[] = []
    const seen = new Set<string>()

    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const toolName = typeof (entry as { tool_name?: unknown }).tool_name === 'string'
        ? (entry as { tool_name: string }).tool_name.trim()
        : ''
      if (!toolName || seen.has(toolName)) continue
      seen.add(toolName)

      const item: CustomToolSetting = { tool_name: toolName }
      const rawBuffer = (entry as { buffer_size?: unknown }).buffer_size
      const rawThreshold = (entry as { zip_threshold?: unknown }).zip_threshold
      const rawAutoZip = (entry as { auto_zip?: unknown }).auto_zip
      const rawZipDisabled = (entry as { zip_disabled?: unknown }).zip_disabled

      if (typeof rawBuffer === 'number' && Number.isFinite(rawBuffer)) {
        item.buffer_size = clampNumber(rawBuffer, 1, 50)
      }
      if (typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)) {
        item.zip_threshold = clampNumber(rawThreshold, 0, 100000)
      }
      if (typeof rawAutoZip === 'boolean') {
        item.auto_zip = rawAutoZip
      }
      if (typeof rawZipDisabled === 'boolean') {
        item.zip_disabled = rawZipDisabled
      }

      next.push(item)
    }

    return next.sort((left, right) => left.tool_name.localeCompare(right.tool_name))
  }

  async function loadZipSettings() {
    if (!userId) return

    try {
      const response = await fetch('/api/user/settings')
      if (!response.ok) {
        throw new Error('Failed to load zip defaults')
      }

      const payload = (await response.json()) as { settings?: UserSettingsRow | null }
      const settings = payload?.settings ?? null
      const global = normalizeGlobalZipSettings(settings?.global_zip_settings)
      const globalToolGridSettings = normalizeCliToolGridSettings(
        settings?.global_tool_grid_settings?.cli ?? null
      )
      const nextFabricToolGridSettings = normalizeFabricToolGridSettings(
        settings?.global_tool_grid_settings?.fabric ?? null
      )
      const nextArtifactToolGridSettings = normalizeArtifactToolGridSettings(
        settings?.global_tool_grid_settings?.artifact ?? null
      )
      const custom = normalizeCustomToolSettings(global.custom_tool_settings)
      const legacyPermission =
        global.zip_control_mode === 'agent'
          ? true
          : global.zip_control_mode === 'user'
            ? false
            : undefined

      globalZipSettingsRaw = global
      globalCliToolGridSettings = globalToolGridSettings
      globalFabricToolGridSettings = nextFabricToolGridSettings
      globalArtifactToolGridSettings = nextArtifactToolGridSettings
      customToolSettings = custom
      zipAgentControlEnabled =
        typeof global.zip_agent_control_enabled === 'boolean'
          ? global.zip_agent_control_enabled
          : legacyPermission ?? DEFAULT_GLOBAL_ZIP_AGENT_CONTROL_ENABLED
      zipAiViewMode = global.zip_ai_view_mode === 'inline' ? 'inline' : 'appended'
      zipToolNotesEnabled =
        typeof global.zip_tool_notes_enabled === 'boolean'
          ? global.zip_tool_notes_enabled
          : DEFAULT_GLOBAL_ZIP_TOOL_NOTES_ENABLED
    } catch (error) {
      console.warn('[GlobalToolGrid] Failed loading zip defaults', error)
      zipSaveError =
        error instanceof Error ? error.message : 'Failed to load zip defaults'
    }
  }

  async function loadGateways() {
    if (!userId) {
      gateways = []
      return
    }

    loading = true
    loadError = null

    try {
      const response = await fetch('/api/mcp/gateways')
      if (!response.ok) {
        throw new Error('Failed to load MCP gateways')
      }

      const payload = await response.json()
      const allGateways = Array.isArray(payload?.gateways)
        ? (payload.gateways as MCPGateway[])
        : []

      const interactiveGateways = allGateways
        .filter((gateway) => gateway.type !== 'n8n-mcp-client')
        .sort((left, right) => left.name.localeCompare(right.name))

      const rows = await Promise.all(
        interactiveGateways.map(async (gateway) => {
          if (!gateway.enabled) {
            return {
              id: gateway.id,
              name: gateway.name,
              iconRef: normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF),
              enabled: false,
              defaults: normalizeGatewayDcmDisplayDefaults(gateway.dcmDisplayDefaults),
              groups: buildGatewayGroupsFromCache(gateway)
            } satisfies GatewayRow
          }

          try {
            const toolsResponse = await fetch(`/api/mcp/gateways/${gateway.id}/tools`)
            if (!toolsResponse.ok) {
              throw new Error(`Failed to load tools for ${gateway.name}`)
            }

            const toolsPayload = (await toolsResponse.json()) as GatewayToolsResponse

            return {
              id: gateway.id,
              name: gateway.name,
              iconRef: normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF),
              enabled: true,
              defaults: normalizeGatewayDcmDisplayDefaults(gateway.dcmDisplayDefaults),
              groups: resolveGatewayToolGroups(gateway, toolsPayload)
            } satisfies GatewayRow
          } catch (error) {
            console.warn('[GlobalToolGrid] Failed loading gateway tools', gateway.id, error)
            return {
              id: gateway.id,
              name: gateway.name,
              iconRef: normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF),
              enabled: gateway.enabled,
              defaults: normalizeGatewayDcmDisplayDefaults(gateway.dcmDisplayDefaults),
              groups: buildGatewayGroupsFromCache(gateway)
            } satisfies GatewayRow
          }
        })
      )

      const cliToolsResponse = await fetch('/api/cli-tools')
      if (!cliToolsResponse.ok) {
        throw new Error('Failed to load CLI tools')
      }
      const cliToolsPayload = (await cliToolsResponse.json()) as {
        tools?: Array<Record<string, unknown>>
      }
      cliToolCatalog = Array.isArray(cliToolsPayload.tools)
        ? cliToolsPayload.tools
            .filter((tool) => (tool.status ?? 'active') === 'active')
            .map((tool) => ({
              toolId: typeof tool.toolId === 'string' ? tool.toolId : '',
              title:
                typeof tool.title === 'string' && tool.title.trim().length > 0
                  ? tool.title
                  : typeof tool.toolId === 'string'
                    ? tool.toolId
                    : 'CLI Tool',
              description:
                typeof tool.description === 'string' ? tool.description : undefined,
              riskLevel: typeof tool.riskLevel === 'string' ? tool.riskLevel : undefined,
              iconRef: normalizeIconRef(
                tool.iconRef ?? tool.icon_ref ?? tool.iconHint,
                DEFAULT_CLI_TOOL_ICON_REF
              )
            }))
            .filter((tool) => tool.toolId.trim().length > 0)
            .sort((left, right) => left.toolId.localeCompare(right.toolId))
        : []

      gateways = rows
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Failed to load global tool grid'
    } finally {
      loading = false
    }
  }

  function clearSaveTimer(gatewayId: string) {
    const existing = saveTimers.get(gatewayId)
    if (existing) {
      clearTimeout(existing)
      saveTimers.delete(gatewayId)
    }
  }

  function clearSaveResetTimer(gatewayId: string) {
    const existing = saveResetTimers.get(gatewayId)
    if (existing) {
      clearTimeout(existing)
      saveResetTimers.delete(gatewayId)
    }
  }

  function clearZipResetTimer() {
    if (zipResetTimer) {
      clearTimeout(zipResetTimer)
      zipResetTimer = null
    }
  }

  function setGatewaySaveState(gatewayId: string, state: SaveState, error?: string) {
    saveStateByGateway = { ...saveStateByGateway, [gatewayId]: state }
    if (state === 'error' && error) {
      saveErrorByGateway = { ...saveErrorByGateway, [gatewayId]: error }
      return
    }
    if (saveErrorByGateway[gatewayId]) {
      const next = { ...saveErrorByGateway }
      delete next[gatewayId]
      saveErrorByGateway = next
    }
  }

  async function saveGatewayDefaults(gatewayId: string) {
    const row = gateways.find((entry) => entry.id === gatewayId)
    if (!row) return

    setGatewaySaveState(gatewayId, 'saving')
    clearSaveResetTimer(gatewayId)

    try {
      const response = await fetch(`/api/mcp/gateways/${gatewayId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: row.enabled,
          dcmDisplayDefaults: normalizeForSave(row.defaults)
        })
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        const message =
          typeof payload?.error === 'string' && payload.error.trim().length > 0
            ? payload.error
            : 'Failed to save Global Tool Grid defaults'
        throw new Error(message)
      }

      setGatewaySaveState(gatewayId, 'saved')
      const resetTimer = setTimeout(() => {
        setGatewaySaveState(gatewayId, 'idle')
        saveResetTimers.delete(gatewayId)
      }, 1400)
      saveResetTimers.set(gatewayId, resetTimer)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save Global Tool Grid defaults'
      setGatewaySaveState(gatewayId, 'error', message)
    }
  }

  function queueSaveGateway(gatewayId: string) {
    clearSaveTimer(gatewayId)
    const timer = setTimeout(() => {
      saveTimers.delete(gatewayId)
      void saveGatewayDefaults(gatewayId)
    }, 420)
    saveTimers.set(gatewayId, timer)
  }

  function queueSaveZipSettings() {
    zipSaveState = 'saving'
    zipSaveError = null
    clearZipResetTimer()
    debouncedSaveZipSettings()
  }

  function createDefaultGlobalToolGridZipSettings(): GlobalZipSettings {
    return {
      zip_agent_control_enabled: DEFAULT_GLOBAL_ZIP_AGENT_CONTROL_ENABLED,
      zip_ai_view_mode: DEFAULT_GLOBAL_ZIP_AI_VIEW_MODE,
      zip_tool_notes_enabled: DEFAULT_GLOBAL_ZIP_TOOL_NOTES_ENABLED
    }
  }

  async function saveUserToolGridDefaults(
    nextGlobalZipSettings: GlobalZipSettings,
    nextCliToolGridSettings: ReturnType<typeof createDefaultCliToolGridSettings>,
    nextFabricToolGridSettings: ReturnType<typeof createDefaultFabricToolGridSettings> =
      globalFabricToolGridSettings,
    nextArtifactToolGridSettings: ReturnType<typeof createDefaultArtifactToolGridSettings> =
      globalArtifactToolGridSettings
  ): Promise<UserSettingsRow | null> {
    const response = await fetch('/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        global_zip_settings: nextGlobalZipSettings,
        global_tool_grid_settings: {
          cli: {
            discoverableToolIds: [...nextCliToolGridSettings.discoverableToolIds],
            dcmDisplayDefaults: nextCliToolGridSettings.dcmDisplayDefaults
          },
          fabric: { dcmDisplayDefaults: nextFabricToolGridSettings.dcmDisplayDefaults },
          artifact: { dcmDisplayDefaults: nextArtifactToolGridSettings.dcmDisplayDefaults }
        },
        updated_at: new Date().toISOString()
      })
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      const message =
        typeof payload?.error === 'string' && payload.error.trim().length > 0
          ? payload.error
          : 'Failed to save Global Tool Grid defaults'
      throw new Error(message)
    }

    const payload = (await response.json()) as { settings?: UserSettingsRow | null }
    return payload?.settings ?? null
  }

  function updateZipControlPermission(enabled: boolean) {
    zipAgentControlEnabled = enabled
    queueSaveZipSettings()
  }

  function updateZipAiViewMode(mode: 'inline' | 'appended') {
    zipAiViewMode = mode
    queueSaveZipSettings()
  }

  function updateZipToolNotesEnabled(enabled: boolean) {
    zipToolNotesEnabled = enabled
    queueSaveZipSettings()
  }

  const debouncedSaveZipSettings = debounce(async () => {
    if (!userId) return

    try {
      const nextGlobalZipSettings: GlobalZipSettings = {
        ...globalZipSettingsRaw,
        zip_agent_control_enabled: zipAgentControlEnabled,
        zip_ai_view_mode: zipAiViewMode,
        zip_tool_notes_enabled: zipToolNotesEnabled,
        custom_tool_settings: [...customToolSettings]
      }

      const settings = await saveUserToolGridDefaults(
        nextGlobalZipSettings,
        globalCliToolGridSettings
      )
      globalZipSettingsRaw = nextGlobalZipSettings
      zipSaveState = 'saved'
      zipSaveError = null

      if (settings) {
        setUserSettings(settings)
      }

      zipResetTimer = setTimeout(() => {
        zipSaveState = 'idle'
        zipResetTimer = null
      }, 1500)
    } catch (error) {
      zipSaveState = 'error'
      zipSaveError = error instanceof Error ? error.message : 'Failed to save tool zip defaults'
    }
  }, 450)

  async function resetGlobalToolGridDefaults() {
    if (!userId || globalResetBusy) return

    globalResetBusy = true
    clearZipResetTimer()
    setGatewaySaveState(GLOBAL_RESET_SAVE_KEY, 'saving')
    zipSaveState = 'saving'
    zipSaveError = null

    try {
      const nextGlobalZipSettings = createDefaultGlobalToolGridZipSettings()
      const nextCliToolGridSettings = createDefaultCliToolGridSettings()
      const nextGateways = gateways.map((gateway) => ({
        ...gateway,
        enabled: true,
        defaults: createDefaultGatewayDcmDisplayDefaults()
      }))

      await Promise.all(
        nextGateways.map(async (gateway) => {
          const response = await fetch(`/api/mcp/gateways/${gateway.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enabled: gateway.enabled,
              dcmDisplayDefaults: gateway.defaults
            })
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            const message =
              typeof payload?.error === 'string' && payload.error.trim().length > 0
                ? payload.error
                : `Failed to reset ${gateway.name}`
            throw new Error(message)
          }
        })
      )

      const settings = await saveUserToolGridDefaults(
        nextGlobalZipSettings,
        nextCliToolGridSettings
      )

      gateways = nextGateways
      globalZipSettingsRaw = nextGlobalZipSettings
      globalCliToolGridSettings = nextCliToolGridSettings
      customToolSettings = []
      bulkZipDrafts = {}
      zipAgentControlEnabled = DEFAULT_GLOBAL_ZIP_AGENT_CONTROL_ENABLED
      zipAiViewMode = DEFAULT_GLOBAL_ZIP_AI_VIEW_MODE
      zipToolNotesEnabled = DEFAULT_GLOBAL_ZIP_TOOL_NOTES_ENABLED
      saveErrorByGateway = {}
      saveStateByGateway = { [GLOBAL_RESET_SAVE_KEY]: 'saved' }
      zipSaveState = 'saved'

      if (settings) {
        setUserSettings(settings)
      }

      const resetTimer = setTimeout(() => {
        setGatewaySaveState(GLOBAL_RESET_SAVE_KEY, 'idle')
        saveResetTimers.delete(GLOBAL_RESET_SAVE_KEY)
      }, 1400)
      saveResetTimers.set(GLOBAL_RESET_SAVE_KEY, resetTimer)
      zipResetTimer = setTimeout(() => {
        zipSaveState = 'idle'
        zipResetTimer = null
      }, 1500)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to reset Global Tool Grid defaults'
      setGatewaySaveState(GLOBAL_RESET_SAVE_KEY, 'error', message)
      zipSaveState = 'error'
      zipSaveError = message
    } finally {
      globalResetBusy = false
    }
  }

  function updateGatewayRow(gatewayId: string, mutate: (next: GatewayRow) => void) {
    gateways = gateways.map((gateway) => {
      if (gateway.id !== gatewayId) return gateway
      const nextGateway: GatewayRow = {
        ...gateway,
        defaults: normalizeGatewayDcmDisplayDefaults(gateway.defaults),
        groups: gateway.groups.map((group) => ({
          ...group,
          tools: [...group.tools]
        }))
      }
      mutate(nextGateway)
      return nextGateway
    })
    queueSaveGateway(gatewayId)
  }

  function updateGatewayDefaults(gatewayId: string, mutate: (next: GatewayDcmDisplaySettings) => void) {
    updateGatewayRow(gatewayId, (gateway) => {
      const nextDefaults = normalizeGatewayDcmDisplayDefaults(gateway.defaults)
      mutate(nextDefaults)
      gateway.defaults = nextDefaults
    })
  }

  function handleGatewayEnabledChange(gatewayId: string, enabled: boolean) {
    updateGatewayRow(gatewayId, (gateway) => {
      gateway.enabled = enabled
    })
  }

  function buildGroupKey(gatewayId: string, groupName: string): string {
    return `${gatewayId}::${groupName}`
  }

  function buildSourceKey(gatewayId: string): string {
    return `mcp-source::${gatewayId}`
  }

  function buildToolKey(gatewayId: string, toolName: string): string {
    return `${gatewayId}::${toolName}`
  }

  function getGroupMode(gateway: GatewayRow, groupName: string): DcmGroupDisplayMode {
    const mode = gateway.defaults.groups[groupName]
    if (VALID_GROUP_MODES.has(mode as DcmGroupDisplayMode)) {
      return mode as DcmGroupDisplayMode
    }
    return 'group+tools+hints'
  }

  function getToolMode(gateway: GatewayRow, toolName: string): DcmToolDisplayMode {
    const mode = gateway.defaults.tools[toolName]
    if (VALID_TOOL_MODES.has(mode as DcmToolDisplayMode)) {
      return mode as DcmToolDisplayMode
    }
    return 'inherit'
  }

  function getCliGroupMode(): DcmGroupDisplayMode {
    const mode = globalCliToolGridSettings.dcmDisplayDefaults.groups[CLI_TOOL_GRID_GROUP_NAME]
    if (VALID_GROUP_MODES.has(mode as DcmGroupDisplayMode)) {
      return mode as DcmGroupDisplayMode
    }
    return 'group+tools+hints'
  }

  function getCliToolMode(toolId: string): DcmToolDisplayMode {
    const mode = globalCliToolGridSettings.dcmDisplayDefaults.tools[toolId]
    if (VALID_TOOL_MODES.has(mode as DcmToolDisplayMode)) {
      return mode as DcmToolDisplayMode
    }
    return 'inherit'
  }

  function isCliToolVisible(toolId: string): boolean {
    return globalCliToolGridSettings.discoverableToolIds.includes(toolId)
  }

  function updateGlobalCliToolGridSettings(
    mutate: (next: ReturnType<typeof createDefaultCliToolGridSettings>) => void
  ) {
    const next = {
      discoverableToolIds: [...globalCliToolGridSettings.discoverableToolIds],
      dcmDisplayDefaults: normalizeGatewayDcmDisplayDefaults(
        globalCliToolGridSettings.dcmDisplayDefaults
      )
    }
    mutate(next)
    globalCliToolGridSettings = next
    queueSaveZipSettings()
  }

  // SA-096 P3: Fabric and Artifact global defaults. Same shape as the CLI handlers; the
  // family's own default mode is the one the normalizer seeds, so "back to default" is a
  // delete rather than a hard-coded 'group+tools+hints'.
  function getBrokerFamilySettings(key: BrokerFamilyToolGridKey) {
    return key === 'fabric' ? globalFabricToolGridSettings : globalArtifactToolGridSettings
  }

  function getBrokerFamilyGroupName(key: BrokerFamilyToolGridKey): string {
    return key === 'fabric' ? FABRIC_TOOL_GRID_GROUP_NAME : ARTIFACT_TOOL_GRID_GROUP_NAME
  }

  function getBrokerFamilyGroupMode(key: BrokerFamilyToolGridKey): DcmGroupDisplayMode {
    const mode = getBrokerFamilySettings(key).dcmDisplayDefaults.groups[
      getBrokerFamilyGroupName(key)
    ]
    return VALID_GROUP_MODES.has(mode as DcmGroupDisplayMode)
      ? (mode as DcmGroupDisplayMode)
      : 'group+tools+hints'
  }

  function updateBrokerFamilyToolGridSettings(
    key: BrokerFamilyToolGridKey,
    mutate: (next: ReturnType<typeof createDefaultFabricToolGridSettings>) => void
  ) {
    const next = {
      dcmDisplayDefaults: normalizeGatewayDcmDisplayDefaults(
        getBrokerFamilySettings(key).dcmDisplayDefaults
      )
    }
    mutate(next)
    const normalized =
      key === 'fabric'
        ? normalizeFabricToolGridSettings(next)
        : normalizeArtifactToolGridSettings(next)
    if (key === 'fabric') {
      globalFabricToolGridSettings = normalized
    } else {
      globalArtifactToolGridSettings = normalized
    }
    queueSaveZipSettings()
  }

  function handleBrokerFamilyGroupModeChange(key: BrokerFamilyToolGridKey, value: string) {
    const mode = normalizeLegacyGroupMode(value)
    if (!mode || mode === 'hidden') return
    updateBrokerFamilyToolGridSettings(key, (next) => {
      next.dcmDisplayDefaults.groups[getBrokerFamilyGroupName(key)] = mode
    })
  }

  /**
   * SA-096: the Discoverable + Display Detail pair for a broker family, rendered on the
   * existing `Fabric Controls` / `Artifact Tools` rows inside the `Batshit Tools`
   * accordion. Global defaults always show zip columns, so those rows are the family's
   * only home here and the name never appears twice in the grid.
   */
  function buildBrokerFamilyControls(key: BrokerFamilyToolGridKey): BrokerFamilyRowControls {
    const groupName = getBrokerFamilyGroupName(key)
    const mode = getBrokerFamilyGroupMode(key)

    return {
      label: groupName,
      iconRef: key === 'fabric' ? TOOL_GRID_FABRIC_ICON_REF : TOOL_GRID_ARTIFACT_ICON_REF,
      visible: mode !== 'hidden',
      value: mode,
      iconMode: normalizeGroupIconMode(mode),
      options: GROUP_DISPLAY_OPTIONS,
      optionIconMode: (value) => normalizeGroupIconMode(value as DcmGroupDisplayMode),
      modeLabel: (value) => getGroupModeLabel(value as DcmGroupDisplayMode),
      infoParagraphs:
        key === 'fabric' ? FABRIC_TOOL_GRID_INFO_PARAGRAPHS : ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS,
      onVisibleChange: (visible) => handleBrokerFamilyGroupToggle(key, visible),
      onModeChange: (value) => handleBrokerFamilyGroupModeChange(key, value)
    }
  }

  function getBrokerFamilyControlsForRow(
    rowId: SharedNonMcpToolGridRowId
  ): BrokerFamilyRowControls | null {
    if (rowId === 'fabric_find') return buildBrokerFamilyControls('fabric')
    if (rowId === 'artifact_find') return buildBrokerFamilyControls('artifact')
    return null
  }

  function handleBrokerFamilyGroupToggle(key: BrokerFamilyToolGridKey, visible: boolean) {
    updateBrokerFamilyToolGridSettings(key, (next) => {
      if (visible) {
        delete next.dcmDisplayDefaults.groups[getBrokerFamilyGroupName(key)]
      } else {
        next.dcmDisplayDefaults.groups[getBrokerFamilyGroupName(key)] = 'hidden'
      }
    })
  }

  function handleCliGroupModeChange(value: string) {
    const mode = normalizeLegacyGroupMode(value)
    if (!mode || mode === 'hidden') return
    updateGlobalCliToolGridSettings((next) => {
      if (mode === 'group+tools+hints') {
        delete next.dcmDisplayDefaults.groups[CLI_TOOL_GRID_GROUP_NAME]
      } else {
        next.dcmDisplayDefaults.groups[CLI_TOOL_GRID_GROUP_NAME] = mode
      }
    })
  }

  function handleCliToolModeChange(toolId: string, value: string) {
    const mode = normalizeLegacyToolMode(value)
    if (!mode || mode === 'hidden') return
    updateGlobalCliToolGridSettings((next) => {
      if (mode === 'inherit') {
        delete next.dcmDisplayDefaults.tools[toolId]
      } else {
        next.dcmDisplayDefaults.tools[toolId] = mode
      }
    })
  }

  function handleCliGroupToggle(visible: boolean) {
    updateGlobalCliToolGridSettings((next) => {
      if (visible) {
        delete next.dcmDisplayDefaults.groups[CLI_TOOL_GRID_GROUP_NAME]
      } else {
        next.dcmDisplayDefaults.groups[CLI_TOOL_GRID_GROUP_NAME] = 'hidden'
      }
    })

    if (!visible && openTopLevelAccordionItemKey === CLI_TOOL_GRID_ID) {
      openTopLevelAccordionItemKey = null
    }
  }

  function handleCliToolToggle(toolId: string, visible: boolean) {
    updateGlobalCliToolGridSettings((next) => {
      const current = new Set(next.discoverableToolIds)
      if (visible) {
        current.add(toolId)
      } else {
        current.delete(toolId)
      }
      next.discoverableToolIds = Array.from(current).sort((left, right) =>
        left.localeCompare(right)
      )
    })
  }

  function isGroupVisible(gateway: GatewayRow, groupName: string): boolean {
    return getGroupMode(gateway, groupName) !== 'hidden'
  }

  function isToolVisible(gateway: GatewayRow, groupName: string, toolName: string): boolean {
    const groupMode = getGroupMode(gateway, groupName)
    if (groupMode === 'hidden' || groupMode === 'group-only') {
      return false
    }
    return getToolMode(gateway, toolName) !== 'hidden'
  }

  function handleGroupModeChange(gatewayId: string, groupName: string, value: string) {
    const mode = normalizeLegacyGroupMode(value)
    if (!mode || mode === 'hidden') return
    const key = buildGroupKey(gatewayId, groupName)
    groupRestoreModes = { ...groupRestoreModes, [key]: mode }

    updateGatewayDefaults(gatewayId, (next) => {
      if (mode === 'group+tools+hints') {
        delete next.groups[groupName]
      } else {
        next.groups[groupName] = mode
      }
    })
  }

  function handleToolModeChange(gatewayId: string, toolName: string, value: string) {
    const mode = normalizeLegacyToolMode(value)
    if (!mode || mode === 'hidden') return
    const key = buildToolKey(gatewayId, toolName)
    toolRestoreModes = { ...toolRestoreModes, [key]: mode }

    updateGatewayDefaults(gatewayId, (next) => {
      if (mode === 'inherit') {
        delete next.tools[toolName]
      } else {
        next.tools[toolName] = mode
      }
    })
  }

  function handleGroupToggle(gatewayId: string, groupName: string, visible: boolean) {
    updateGatewayDefaults(gatewayId, (next) => {
      const key = buildGroupKey(gatewayId, groupName)
      const currentMode = normalizeLegacyGroupMode(next.groups[groupName]) ?? 'group+tools+hints'

      if (visible) {
        const restoreMode = groupRestoreModes[key] ?? 'group+tools+hints'
        if (restoreMode === 'group+tools+hints') {
          delete next.groups[groupName]
        } else {
          next.groups[groupName] = restoreMode
        }
      } else {
        if (currentMode !== 'hidden') {
          groupRestoreModes = { ...groupRestoreModes, [key]: currentMode }
        }
        next.groups[groupName] = 'hidden'
      }
    })

    if (!visible && openNestedAccordionItemKey === buildGroupKey(gatewayId, groupName)) {
      openNestedAccordionItemKey = null
    }
  }

  function handleToolToggle(gatewayId: string, toolName: string, visible: boolean) {
    updateGatewayDefaults(gatewayId, (next) => {
      const key = buildToolKey(gatewayId, toolName)
      const currentMode = normalizeLegacyToolMode(next.tools[toolName]) ?? 'inherit'

      if (visible) {
        const restoreMode = toolRestoreModes[key] ?? 'inherit'
        if (restoreMode === 'inherit') {
          delete next.tools[toolName]
        } else {
          next.tools[toolName] = restoreMode
        }
      } else {
        if (currentMode !== 'hidden') {
          toolRestoreModes = { ...toolRestoreModes, [key]: currentMode }
        }
        next.tools[toolName] = 'hidden'
      }
    })
  }

  function mapGroupModeToDefaultToolMode(groupMode: DcmGroupDisplayMode): DcmToolDisplayMode {
    if (groupMode === 'group+tools+names') return 'name-only'
    if (groupMode === 'hidden' || groupMode === 'group-only') return 'hidden'
    return 'name+hint'
  }

  function getToolDisableReason(
    groupMode: DcmGroupDisplayMode,
    gatewayEnabled: boolean = true
  ): string | null {
    if (!gatewayEnabled) return 'Gateway is disabled globally'
    if (groupMode === 'hidden') return 'Group is hidden'
    if (groupMode === 'group-only') return 'Group-only mode hides tools'
    return null
  }

  function getRawGlobalNumber(field: string): number | undefined {
    const raw = globalZipSettingsRaw[field]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }

  function getRawGlobalBoolean(field: string): boolean | undefined {
    const raw = globalZipSettingsRaw[field]
    return typeof raw === 'boolean' ? raw : undefined
  }

  function getInheritedBufferSize(): number {
    const raw = getRawGlobalNumber('buffer_size_all_other_tools')
    return clampNumber(
      raw ?? getToolGridDefaultNumber('buffer_size_all_other_tools') ?? 1,
      MIN_BUFFER,
      MAX_BUFFER
    )
  }

  function getInheritedZipThreshold(): number {
    const raw = getRawGlobalNumber('zip_threshold_all_other_tools')
    return clampNumber(
      raw ?? getToolGridDefaultNumber('zip_threshold_all_other_tools') ?? 0,
      0,
      MAX_ZIP_THRESHOLD
    )
  }

  function getInheritedAutoZip(): boolean {
    return (
      getRawGlobalBoolean('auto_zip_all_other_tools') ??
      getToolGridDefaultAutoZip('auto_zip_all_other_tools')
    ) === true
  }

  function getInheritedZipDisabled(): boolean {
    return getRawGlobalBoolean('zip_disabled_all_other_tools') === true
  }

  function formatDefaultNumberValue(
    value: number | undefined,
    defaultValue: number | undefined
  ): string {
    if (typeof value !== 'number') return ''
    return typeof defaultValue === 'number' && value === defaultValue ? '' : String(value)
  }

  function formatDefaultAutoZipValue(
    autoZip: boolean | undefined,
    zipDisabled: boolean | undefined,
    defaultAutoZip: boolean | undefined
  ): AutoZipValue {
    if (zipDisabled === true) return 'off'
    if (typeof autoZip !== 'boolean') return 'inherit'
    return typeof defaultAutoZip === 'boolean' && autoZip === defaultAutoZip
      ? 'inherit'
      : autoZip
        ? 'enabled'
        : 'disabled'
  }

  function formatInheritedNumberValue(
    value: number | undefined,
    inheritedValue: number
  ): string {
    if (typeof value !== 'number') return ''
    return value === inheritedValue ? '' : String(value)
  }

  function formatInheritedAutoZipValue(
    autoZip: boolean | undefined,
    zipDisabled: boolean | undefined,
    inheritedAutoZip: boolean,
    inheritedZipDisabled: boolean
  ): AutoZipValue {
    if (zipDisabled === true) return 'off'
    if (typeof autoZip !== 'boolean') return 'inherit'
    if (inheritedZipDisabled) return autoZip ? 'enabled' : 'disabled'
    return autoZip === inheritedAutoZip ? 'inherit' : autoZip ? 'enabled' : 'disabled'
  }

  function getToolZipOverride(toolName: string): ToolZipOverride {
    const existing = customToolSettings.find((tool) => tool.tool_name === toolName)
    const inherited_buffer_size = getInheritedBufferSize()
    const inherited_zip_threshold = getInheritedZipThreshold()
    const inherited_auto_zip = getInheritedAutoZip()
    const inherited_zip_disabled = getInheritedZipDisabled()

    return {
      buffer_size: formatInheritedNumberValue(existing?.buffer_size, inherited_buffer_size),
      zip_threshold: formatInheritedNumberValue(
        existing?.zip_threshold,
        inherited_zip_threshold
      ),
      auto_zip: formatInheritedAutoZipValue(
        existing?.auto_zip,
        existing?.zip_disabled,
        inherited_auto_zip,
        inherited_zip_disabled
      ),
      inherited_buffer_size,
      inherited_zip_threshold,
      inherited_auto_zip,
      inherited_zip_disabled
    }
  }

  function clampNumber(value: unknown, min: number, max: number): number {
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
    if (!Number.isFinite(numeric)) return min
    return Math.min(Math.max(numeric, min), max)
  }

  function normalizeZipBufferInput(
    event: Event,
    minBuffer: number
  ): string {
    const input = event.currentTarget as HTMLInputElement
    const normalized = normalizeZipBufferInputValue(input.value, minBuffer)
    if (input.value !== normalized) {
      input.value = normalized
    }
    return normalized
  }

  function normalizeZipThresholdInput(event: Event): string {
    const input = event.currentTarget as HTMLInputElement
    const normalized = normalizeZipThresholdInputValue(input.value)

    if (input.value !== normalized) {
      input.value = normalized
    }
    return normalized
  }

  function getBulkZipDraft(key: string): BulkZipDraft {
    return bulkZipDrafts[key] ?? { buffer_size: '', zip_threshold: '' }
  }

  function updateBulkZipDraft(key: string, patch: Partial<BulkZipDraft>) {
    bulkZipDrafts = {
      ...bulkZipDrafts,
      [key]: {
        ...getBulkZipDraft(key),
        ...patch
      }
    }
  }

  function getBulkZipPatch(key: string): BulkZipPatch | null {
    const draft = getBulkZipDraft(key)
    const patch: BulkZipPatch = {}
    if (draft.buffer_size.trim()) {
      patch.buffer_size = draft.buffer_size
    }
    if (draft.zip_threshold.trim()) {
      patch.zip_threshold = draft.zip_threshold
    }
    return Object.keys(patch).length > 0 ? patch : null
  }

  function canApplyBulkZipDraft(key: string): boolean {
    return getBulkZipPatch(key) !== null
  }

  function applyBulkZipToTools(key: string, toolNames: string[]) {
    const patch = getBulkZipPatch(key)
    if (!patch) return

    const uniqueToolNames = Array.from(
      new Set(toolNames.map((toolName) => toolName.trim()).filter(Boolean))
    )
    for (const toolName of uniqueToolNames) {
      updateToolZipOverride(toolName, patch)
    }
  }

  function getCliToolIds(): string[] {
    return cliToolCatalog.map((tool) => tool.toolId)
  }

  function getGroupToolIds(group: GroupRow): string[] {
    return group.tools.map((tool) => tool.id)
  }

  function getOtherZipRowOverride(rowId: OtherZipRowId): OtherZipRowOverride {
    const config = OTHER_ZIP_ROW_CONFIG[rowId]
    if (config.mode === 'custom') {
      const existing = customToolSettings.find((tool) => tool.tool_name === config.toolName)
      return {
        buffer_size: formatDefaultNumberValue(existing?.buffer_size, config.defaultBuffer),
        zip_threshold: formatDefaultNumberValue(
          existing?.zip_threshold,
          config.defaultThreshold
        ),
        auto_zip: formatDefaultAutoZipValue(
          existing?.auto_zip,
          existing?.zip_disabled,
          config.defaultAutoZip
        ),
        inherited_buffer_size: config.defaultBuffer,
        inherited_zip_threshold: config.defaultThreshold,
        inherited_auto_zip: config.defaultAutoZip,
        inherited_zip_disabled: false,
        min_buffer: config.minBuffer
      }
    }
    const bufferRaw = getRawGlobalNumber(config.bufferField)
    const thresholdRaw = getRawGlobalNumber(config.thresholdField)
    const autoRaw = getRawGlobalBoolean(config.autoField)
    const disabledField = config.autoField.replace(/^auto_zip_/, 'zip_disabled_')
    const disabledRaw = getRawGlobalBoolean(disabledField)

    return {
      buffer_size: formatDefaultNumberValue(
        typeof bufferRaw === 'number' ? clampNumber(bufferRaw, config.minBuffer, MAX_BUFFER) : undefined,
        config.defaultBuffer
      ),
      zip_threshold: formatDefaultNumberValue(
        typeof thresholdRaw === 'number'
          ? clampNumber(thresholdRaw, 0, MAX_ZIP_THRESHOLD)
          : undefined,
        config.defaultThreshold
      ),
      auto_zip: formatDefaultAutoZipValue(autoRaw, disabledRaw, config.defaultAutoZip),
      inherited_buffer_size: config.defaultBuffer,
      inherited_zip_threshold: config.defaultThreshold,
      inherited_auto_zip: config.defaultAutoZip,
      inherited_zip_disabled: false,
      min_buffer: config.minBuffer
    }
  }

  function updateToolZipOverride(
    toolName: string,
    updates: { buffer_size?: string; zip_threshold?: string; auto_zip?: string }
  ) {
    const current = customToolSettings.find((tool) => tool.tool_name === toolName)
    const next: CustomToolSetting = current ? { ...current } : { tool_name: toolName }

    if (updates.buffer_size !== undefined) {
      const raw = updates.buffer_size.trim()
      if (raw.length === 0) {
        delete next.buffer_size
      } else {
        next.buffer_size = clampNumber(raw, MIN_BUFFER, MAX_BUFFER)
      }
    }

    if (updates.zip_threshold !== undefined) {
      const raw = updates.zip_threshold.trim()
      if (raw.length === 0) {
        delete next.zip_threshold
      } else {
        next.zip_threshold = clampNumber(raw, 0, MAX_ZIP_THRESHOLD)
      }
    }

    if (updates.auto_zip !== undefined) {
      if (updates.auto_zip === 'off') {
        next.zip_disabled = true
        delete next.auto_zip
      } else if (updates.auto_zip === 'enabled') {
        delete next.zip_disabled
        next.auto_zip = true
      } else if (updates.auto_zip === 'disabled') {
        delete next.zip_disabled
        next.auto_zip = false
      } else {
        delete next.auto_zip
        delete next.zip_disabled
      }
    }

    const hasOverrides =
      typeof next.buffer_size === 'number' ||
      typeof next.zip_threshold === 'number' ||
      typeof next.auto_zip === 'boolean' ||
      typeof next.zip_disabled === 'boolean'

    let nextSettings = customToolSettings.filter((tool) => tool.tool_name !== toolName)
    if (hasOverrides) {
      nextSettings = [...nextSettings, next]
    }

    customToolSettings = nextSettings.sort((left, right) =>
      left.tool_name.localeCompare(right.tool_name)
    )

    queueSaveZipSettings()
  }

  function updateOtherZipRowOverride(
    rowId: OtherZipRowId,
    updates: { buffer_size?: string; zip_threshold?: string; auto_zip?: string }
  ) {
    const config = OTHER_ZIP_ROW_CONFIG[rowId]
    if (config.mode === 'custom') {
      const current = customToolSettings.find((tool) => tool.tool_name === config.toolName)
      const next: CustomToolSetting = current
        ? { ...current }
        : { tool_name: config.toolName }

      if (updates.buffer_size !== undefined) {
        const raw = updates.buffer_size.trim()
        if (raw.length === 0) {
          delete next.buffer_size
        } else {
          next.buffer_size = clampNumber(raw, config.minBuffer, MAX_BUFFER)
        }
      }

      if (updates.zip_threshold !== undefined) {
        const raw = updates.zip_threshold.trim()
        if (raw.length === 0) {
          delete next.zip_threshold
        } else {
          next.zip_threshold = clampNumber(raw, 0, MAX_ZIP_THRESHOLD)
        }
      }

      if (updates.auto_zip !== undefined) {
        if (updates.auto_zip === 'off') {
          next.zip_disabled = true
          delete next.auto_zip
        } else if (updates.auto_zip === 'enabled') {
          delete next.zip_disabled
          next.auto_zip = true
        } else if (updates.auto_zip === 'disabled') {
          delete next.zip_disabled
          next.auto_zip = false
        } else {
          delete next.auto_zip
          delete next.zip_disabled
        }
      }

      const hasOverrides =
        typeof next.buffer_size === 'number' ||
        typeof next.zip_threshold === 'number' ||
        typeof next.auto_zip === 'boolean' ||
        typeof next.zip_disabled === 'boolean'

      let nextSettings = customToolSettings.filter((tool) => tool.tool_name !== config.toolName)
      if (hasOverrides) {
        nextSettings = [...nextSettings, next]
      }
      customToolSettings = nextSettings.sort((left, right) =>
        left.tool_name.localeCompare(right.tool_name)
      )
      queueSaveZipSettings()
      return
    }
    const nextGlobalZipSettings: GlobalZipSettings = { ...globalZipSettingsRaw }

    if (updates.buffer_size !== undefined) {
      const raw = updates.buffer_size.trim()
      if (raw.length === 0) {
        delete nextGlobalZipSettings[config.bufferField]
      } else {
        nextGlobalZipSettings[config.bufferField] = clampNumber(
          raw,
          config.minBuffer,
          MAX_BUFFER
        )
      }
    }

    if (updates.zip_threshold !== undefined) {
      const raw = updates.zip_threshold.trim()
      if (raw.length === 0) {
        delete nextGlobalZipSettings[config.thresholdField]
      } else {
        nextGlobalZipSettings[config.thresholdField] = clampNumber(
          raw,
          0,
          MAX_ZIP_THRESHOLD
        )
      }
    }

    if (updates.auto_zip !== undefined) {
      const disabledField = config.autoField.replace(/^auto_zip_/, 'zip_disabled_')
      if (updates.auto_zip === 'off') {
        nextGlobalZipSettings[disabledField] = true
        delete nextGlobalZipSettings[config.autoField]
      } else if (updates.auto_zip === 'enabled') {
        delete nextGlobalZipSettings[disabledField]
        nextGlobalZipSettings[config.autoField] = true
      } else if (updates.auto_zip === 'disabled') {
        delete nextGlobalZipSettings[disabledField]
        nextGlobalZipSettings[config.autoField] = false
      } else {
        delete nextGlobalZipSettings[config.autoField]
        delete nextGlobalZipSettings[disabledField]
      }
    }

    globalZipSettingsRaw = nextGlobalZipSettings
    queueSaveZipSettings()
  }

  function getInheritedNumberLabel(value: number | undefined): string {
    return typeof value === 'number' ? String(value) : ''
  }

  function getInheritedZipBehaviorLabel(
    autoZip: boolean | undefined,
    zipDisabled: boolean | undefined
  ): string {
    return formatToolGridInheritedZipBehaviorLabel(autoZip, zipDisabled)
  }

  function isEffectiveAutoZipEnabled(
    value: AutoZipValue | undefined,
    inheritedAutoZip: boolean | undefined,
    inheritedZipDisabled: boolean | undefined
  ): boolean {
    if (value === 'off') return false
    if (value === 'enabled') return true
    if (value === 'disabled') return false
    if (inheritedZipDisabled === true) return false
    return inheritedAutoZip === true
  }

  function isEffectiveZipDisabled(
    value: AutoZipValue | undefined,
    inheritedZipDisabled: boolean | undefined
  ): boolean {
    if (value === 'off') return true
    if (value === 'inherit') return inheritedZipDisabled === true
    return false
  }

  function toggleTopLevelAccordionItem(itemKey: string) {
    openTopLevelAccordionItemKey =
      openTopLevelAccordionItemKey === itemKey ? null : itemKey
    openNestedAccordionItemKey = null
  }

  function toggleNestedAccordionItem(itemKey: string) {
    openNestedAccordionItemKey =
      openNestedAccordionItemKey === itemKey ? null : itemKey
  }

  function isInteractiveHeaderElement(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest('button, a, input, select, textarea, [contenteditable="true"]'))
  }

  function handleTopLevelHeaderClick(event: MouseEvent, itemKey: string) {
    if (isInteractiveHeaderElement(event.target)) {
      return
    }
    toggleTopLevelAccordionItem(itemKey)
  }

  function handleGroupHeaderClick(event: MouseEvent, groupKey: string) {
    if (isInteractiveHeaderElement(event.target)) {
      return
    }
    toggleNestedAccordionItem(groupKey)
  }

  function normalizeGroupIconMode(mode: DcmGroupDisplayMode): GroupIconMode {
    if (mode === 'group-only' || mode === 'hidden') return 'group-only'
    if (mode === 'group+tools+names') return 'group+tools+names'
    return 'group+tools+hints'
  }

  function normalizeToolIconMode(mode: DcmToolDisplayMode): ToolIconMode {
    return mode === 'name-only' ? 'name-only' : 'name+hint'
  }

  function getToolIconMode(groupMode: DcmGroupDisplayMode, toolMode: DcmToolDisplayMode): ToolIconMode {
    if (toolMode === 'inherit') {
      return normalizeToolIconMode(mapGroupModeToDefaultToolMode(groupMode))
    }
    return normalizeToolIconMode(toolMode)
  }

  function getZipBehaviorIconMode(
    value: AutoZipValue,
    inheritedAutoZip: boolean,
    inheritedZipDisabled: boolean
  ): 'enabled' | 'disabled' | 'off' {
    if (value === 'off') return 'off'
    if (value === 'enabled') return 'enabled'
    if (value === 'disabled') return 'disabled'
    if (inheritedZipDisabled) return 'off'
    return inheritedAutoZip ? 'enabled' : 'disabled'
  }

  function getZipBehaviorLabel(
    value: AutoZipValue,
    inheritedAutoZip: boolean,
    inheritedZipDisabled: boolean
  ): string {
    return formatToolGridZipBehaviorLabel(value, inheritedAutoZip, inheritedZipDisabled, 'default')
  }

  function iconToneClass(isInherited: boolean): string {
    return isInherited ? 'text-zinc-400' : 'text-white'
  }

  function inheritTriggerClass(isInherited: boolean): string {
    return isInherited ? 'is-inherited' : 'is-explicit'
  }

  function getGroupModeLabel(value: DcmGroupDisplayMode): string {
    return GROUP_DISPLAY_OPTIONS.find((option) => option.value === value)?.label ?? 'Group + tools + hints'
  }

  function getToolModeLabel(value: DcmToolDisplayMode): string {
    return TOOL_DISPLAY_OPTIONS.find((option) => option.value === value)?.label ?? 'Inherit group/default'
  }

  $effect(() => {
    if (!userId) return
    void loadGateways()
    void loadZipSettings()
  })

  onDestroy(() => {
    for (const timer of saveTimers.values()) {
      clearTimeout(timer)
    }
    for (const timer of saveResetTimers.values()) {
      clearTimeout(timer)
    }
    saveTimers.clear()
    saveResetTimers.clear()
    clearZipResetTimer()
  })
</script>

<SettingsAccordionCard
  name="global-tool-grid-cards"
  title="Global Tool Settings Grid"
  icon={Grid3X3}
  open
  contentClass="space-y-4"
>
  {#snippet info()}
      <SettingsInfoMenu ariaLabel="About Global Tool Settings Grid" contentClass="w-96">
        <p>
          Configure global MCP gateway enablement, discoverability defaults, and shared zip
          overrides in one place.
        </p>
        <p class="mt-2">
          Discoverability and display-detail controls affect what tool names and hints Batshit can
          include in the DCM (Dynamic Current Message). They do not execute tools directly.
        </p>
        <p class="mt-2">
          Agents can inherit these defaults inside their own Agent Tool Grid Settings.
        </p>
      </SettingsInfoMenu>
  {/snippet}

  {#snippet actions()}
    <div class="flex items-center justify-end gap-2">
      <Button variant="outline" size="sm" onclick={loadGateways} disabled={loading || !userId}>
        <RefreshCw class={`${loading ? 'animate-spin' : ''}`} />
        Refresh
      </Button>
      <SettingsSaveStatus
        state={gatewaySaveStatusError ? 'error' : gatewaySaveStatusState}
        error={gatewaySaveStatusError}
        savingLabel="Saving Global Tool Grid settings..."
        savedLabel="Saved"
        sticky={false}
      />
      <SettingsSaveStatus
        state={zipSaveError ? 'error' : zipSaveState}
        error={zipSaveError}
        savingLabel="Saving Tool Grid zip settings..."
        savedLabel="Saved"
        sticky={false}
      />
    </div>
  {/snippet}

    <GlobalZipControlStrip
      {zipAgentControlEnabled}
      {zipAiViewMode}
      {zipToolNotesEnabled}
      onZipControlPermissionChange={updateZipControlPermission}
      onZipAiViewModeChange={updateZipAiViewMode}
      onZipToolNotesEnabledChange={updateZipToolNotesEnabled}
    />

    {#if loading}
      <div class="flex items-center gap-2 batshit-settings-inline-alert">
        <Loader2 class="h-3.5 w-3.5 animate-spin" />
        Loading gateway tool metadata...
      </div>
    {:else if loadError}
      <div class="batshit-settings-inline-alert is-danger">
        {loadError}
      </div>
    {:else if gateways.length === 0 && cliToolCatalog.length === 0 && BATSHIT_ROW_ORDER.length === 0 && OTHER_ROW_ORDER.length === 0}
      <div class="batshit-settings-inline-alert is-dashed">
        No Global Tool Grid rows found yet. Add or enable gateways in MCP Sources, or create CLI tools.
      </div>
    {:else}
      <div class="batshit-settings-table-frame">
        <table class={TOOL_GRID_TABLE_CLASS}>
          <colgroup>
            <col class={TOOL_GRID_FIRST_COLUMN_CLASS} />
            <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
            <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
            <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
            <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
            <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
          </colgroup>
          <thead class="batshit-settings-table-head">
            <tr>
              <th class="batshit-settings-table-head-cell">Item</th>
              <th class="batshit-settings-table-head-cell">Discoverable</th>
              <th class="batshit-settings-table-head-cell">Display Detail</th>
              <th class="batshit-settings-table-head-cell">Zip Buffer</th>
              <th class="batshit-settings-table-head-cell">Zip Threshold</th>
              <th class="batshit-settings-table-head-cell">Zip Behavior</th>
            </tr>
          </thead>
          <tbody>
            <NonMcpZipRowsSection
              sectionKey={BATSHIT_ROWS_KEY}
              title="Batshit Tools"
              sectionIconRef={TOOL_GRID_BATSHIT_SECTION_ICON_REF}
              typeLabel="Batshit Tool"
              rowIds={BATSHIT_ROW_ORDER}
              rowConfig={OTHER_ZIP_ROW_CONFIG}
              open={openTopLevelAccordionItemKey === BATSHIT_ROWS_KEY}
              {topLevelAccordionRowClass}
              tableClass={TOOL_GRID_TABLE_CLASS}
              firstColumnClass={TOOL_GRID_FIRST_COLUMN_CLASS}
              otherColumnClass={TOOL_GRID_OTHER_COLUMN_CLASS}
              getRowOverride={getOtherZipRowOverride}
              onUpdateRowOverride={updateOtherZipRowOverride}
              getBrokerFamilyControls={getBrokerFamilyControlsForRow}
              onHeaderClick={handleTopLevelHeaderClick}
              onToggle={toggleTopLevelAccordionItem}
              showBulkZipApply
              bulkZipApplyLabel="Batshit Tools"
            />

            {#if cliToolCatalog.length > 0}
              {@const cliGroupMode = getCliGroupMode()}
              {@const cliGroupVisible = cliGroupMode !== 'hidden'}
              {@const cliRowKey = CLI_TOOL_GRID_ID}
              {@const cliGroupExpanded = openTopLevelAccordionItemKey === cliRowKey}
              {@const cliGroupIconMode = normalizeGroupIconMode(cliGroupMode)}
              <Collapsible.Root open={cliGroupExpanded}>
                <tr
                  class={`${topLevelAccordionRowClass} cursor-pointer`}
                  onclick={(event) => handleTopLevelHeaderClick(event, cliRowKey)}
                >
                  <td class="batshit-settings-table-cell is-strong">
                    <div class="batshit-settings-tool-grid-label">
                      <ToolGridIdentityIcon
                        ref={DEFAULT_CLI_TOOL_ICON_REF}
                        typeLabel="Tool Group"
                        name={CLI_TOOL_GRID_GROUP_NAME}
                      />
                      <span class="batshit-settings-tool-grid-name block truncate" title={CLI_TOOL_GRID_GROUP_NAME}>
                        {CLI_TOOL_GRID_GROUP_NAME}
                      </span>
                    </div>
                  </td>
                  <td class="batshit-settings-table-cell">
                    <Switch.Root
                      checked={cliGroupVisible}
                      onCheckedChange={(checked) => handleCliGroupToggle(checked === true)}
                    />
                  </td>
                  <td class="batshit-settings-table-cell">
                    {#if cliGroupVisible}
                      <Select.Root
                        type="single"
                        value={cliGroupMode}
                        onValueChange={(value) => value && handleCliGroupModeChange(value)}
                      >
                        <Select.Trigger
                          class="batshit-settings-grid-select-trigger"
                          size="sm"
                          title={getGroupModeLabel(cliGroupMode)}
                        >
                          <span class="inline-flex h-4 w-4 items-center justify-center">
                            {#if cliGroupIconMode === 'group-only'}
                              <Zap class="h-3.5 w-3.5 text-white" />
                            {:else if cliGroupIconMode === 'group+tools+names'}
                              <SignalMedium class="h-3.5 w-3.5 text-white" />
                            {:else}
                              <Signal class="h-3.5 w-3.5 text-white" />
                            {/if}
                          </span>
                          <span class="sr-only">{getGroupModeLabel(cliGroupMode)}</span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each GROUP_DISPLAY_OPTIONS as option}
                            {@const optionIconMode = normalizeGroupIconMode(option.value)}
                            <Select.Item value={option.value} label={option.label}>
                              <span class="flex items-center gap-2">
                                <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                  {#if optionIconMode === 'group-only'}
                                    <Zap class="h-3.5 w-3.5 text-white" />
                                  {:else if optionIconMode === 'group+tools+names'}
                                    <SignalMedium class="h-3.5 w-3.5 text-white" />
                                  {:else}
                                    <Signal class="h-3.5 w-3.5 text-white" />
                                  {/if}
                                </span>
                                <span>{option.label}</span>
                              </span>
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    {/if}
                  </td>
                  <td class="batshit-settings-table-cell">
                    <input
                      type="number"
                      min="1"
                      class="batshit-settings-grid-input batshit-settings-tool-grid-bulk-input"
                      value={getBulkZipDraft(cliRowKey).buffer_size}
                      placeholder="All"
                      aria-label={`Zip buffer to apply to ${CLI_TOOL_GRID_GROUP_NAME}`}
                      oninput={(event) =>
                        updateBulkZipDraft(cliRowKey, {
                          buffer_size: normalizeZipBufferInput(event, 1)
                        })}
                    />
                  </td>
                  <td class="batshit-settings-table-cell">
                    <div class="batshit-settings-tool-grid-bulk-cell">
                      <input
                        type="number"
                        min="0"
                        max={String(MAX_ZIP_THRESHOLD)}
                        class="batshit-settings-grid-input batshit-settings-tool-grid-bulk-input"
                        value={getBulkZipDraft(cliRowKey).zip_threshold}
                        placeholder="All"
                        aria-label={`Zip threshold to apply to ${CLI_TOOL_GRID_GROUP_NAME}`}
                        oninput={(event) =>
                          updateBulkZipDraft(cliRowKey, {
                            zip_threshold: normalizeZipThresholdInput(event)
                          })}
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        class="batshit-settings-tool-grid-bulk-apply"
                        disabled={!canApplyBulkZipDraft(cliRowKey)}
                        aria-label={`Apply zip buffer and threshold to ${CLI_TOOL_GRID_GROUP_NAME}`}
                        title={`Apply zip buffer and threshold to ${CLI_TOOL_GRID_GROUP_NAME}`}
                        onclick={() => applyBulkZipToTools(cliRowKey, getCliToolIds())}
                      >
                        <Check class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                  <td class="batshit-settings-table-cell">
                    <div class="batshit-settings-tool-grid-row-actions">
                      <SettingsInfoMenu
                        ariaLabel={`About applying zip numbers to ${CLI_TOOL_GRID_GROUP_NAME}`}
                        side="left"
                        align="end"
                        class="batshit-settings-tool-grid-bulk-info"
                        contentClass="w-72"
                      >
                        Enter a Zip Buffer, Zip Threshold, or both, then press the check to copy
                        those numbers to every CLI tool row. Blank fields stay unchanged, and Zip
                        Behavior stays unchanged.
                      </SettingsInfoMenu>
                      <Collapsible.Trigger
                        class="ml-auto flex items-center justify-end"
                        aria-expanded={cliGroupExpanded}
                        aria-label={`Toggle CLI tools for ${CLI_TOOL_GRID_GROUP_NAME}`}
                        onclick={() => toggleTopLevelAccordionItem(cliRowKey)}
                      >
                        <ChevronDown class={`h-3.5 w-3.5 transition-transform ${cliGroupExpanded ? 'rotate-180' : ''}`} />
                      </Collapsible.Trigger>
                    </div>
                  </td>
                </tr>

                <tr class="batshit-settings-table-row is-flush">
                  <td colspan="6" class="batshit-settings-table-cell is-flush">
                    <Collapsible.Content class="overflow-hidden">
                      <table class={TOOL_GRID_TABLE_CLASS}>
                        <colgroup>
                          <col class={TOOL_GRID_FIRST_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                        </colgroup>
                        <tbody>
                          {#each cliToolCatalog as tool (tool.toolId)}
                            {@const toolVisible = isCliToolVisible(tool.toolId)}
                            {@const toolMode = getCliToolMode(tool.toolId)}
                            {@const toolDisableReason = getToolDisableReason(cliGroupMode)}
                            {@const toolIconMode = getToolIconMode(cliGroupMode, toolMode)}
                            {@const toolZip = getToolZipOverride(tool.toolId)}
                            {@const autoZipIconMode = getZipBehaviorIconMode(toolZip.auto_zip, toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                            {@const toolAutoZipActive = isEffectiveAutoZipEnabled(toolZip.auto_zip, toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                            {@const toolZipDisabled = isEffectiveZipDisabled(toolZip.auto_zip, toolZip.inherited_zip_disabled)}
                            {@const toolZipInputsDisabled = toolAutoZipActive || toolZipDisabled}
                            {@const toolZipBehaviorLabel = getZipBehaviorLabel(toolZip.auto_zip, toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                            <tr class={`batshit-settings-table-row `}>
                              <td class="batshit-settings-table-cell is-muted is-nested">
                                <div class="flex min-w-0 items-center gap-2">
                                  <ToolGridIdentityIcon
                                    ref={getCliToolIconRef(tool)}
                                    typeLabel="CLI Tool"
                                    name={tool.title}
                                  />
                                  <div class="min-w-0">
                                    <span class="batshit-settings-tool-grid-name block truncate" title={tool.title}>
                                      {tool.title}
                                    </span>
                                    <span class="block truncate font-mono text-[11px]" title={tool.toolId}>
                                      {tool.toolId}
                                    </span>
                                  </div>
                                  {#if toolDisableReason}
                                    <span class="shrink-0 batshit-settings-pill">
                                      {toolDisableReason}
                                    </span>
                                  {:else if toolVisible && toolMode === 'inherit'}
                                    <span class="shrink-0 batshit-settings-pill">
                                      Group default
                                    </span>
                                  {/if}
                                </div>
                              </td>
                              <td class="batshit-settings-table-cell">
                                <Switch.Root
                                  checked={toolVisible}
                                  disabled={Boolean(toolDisableReason)}
                                  onCheckedChange={(checked) => handleCliToolToggle(tool.toolId, checked === true)}
                                />
                              </td>
                              <td class="batshit-settings-table-cell">
                                {#if !toolDisableReason}
                                  <Select.Root
                                    type="single"
                                    value={toolMode === 'hidden' ? 'inherit' : toolMode}
                                    disabled={Boolean(toolDisableReason)}
                                    onValueChange={(value) => value && handleCliToolModeChange(tool.toolId, value)}
                                  >
                                    <Select.Trigger
                                      class={`batshit-settings-grid-select-trigger ${inheritTriggerClass((toolMode === 'hidden' ? 'inherit' : toolMode) === 'inherit')}`}
                                      size="sm"
                                      title={getToolModeLabel(toolMode === 'hidden' ? 'inherit' : toolMode)}
                                    >
                                      <span class="inline-flex h-4 w-4 items-center justify-center">
                                        {#if toolIconMode === 'name-only'}
                                          <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass((toolMode === 'hidden' ? 'inherit' : toolMode) === 'inherit')}`} />
                                        {:else}
                                          <Signal class={`h-3.5 w-3.5 ${iconToneClass((toolMode === 'hidden' ? 'inherit' : toolMode) === 'inherit')}`} />
                                        {/if}
                                      </span>
                                      <span class="sr-only">{getToolModeLabel(toolMode === 'hidden' ? 'inherit' : toolMode)}</span>
                                    </Select.Trigger>
                                    <Select.Content>
                                      {#each TOOL_DISPLAY_OPTIONS as option}
                                        {@const optionIconMode = getToolIconMode(cliGroupMode, option.value)}
                                        <Select.Item value={option.value} label={option.label}>
                                          <span class="flex items-center gap-2">
                                            <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                              {#if optionIconMode === 'name-only'}
                                                <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'inherit')}`} />
                                              {:else}
                                                <Signal class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'inherit')}`} />
                                              {/if}
                                            </span>
                                            <span>{option.label}</span>
                                          </span>
                                        </Select.Item>
                                      {/each}
                                    </Select.Content>
                                  </Select.Root>
                                {/if}
                              </td>
                              <td class="batshit-settings-table-cell">
                                <input
                                  type={toolZipInputsDisabled ? 'text' : 'number'}
                                  min="1"
                                  class="batshit-settings-grid-input"
                                  value={toolZipInputsDisabled ? '-' : toolZip.buffer_size}
                                  placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZip.inherited_buffer_size)}
                                  disabled={toolZipInputsDisabled}
                                  oninput={(event) =>
                                    updateToolZipOverride(tool.toolId, {
                                      buffer_size: normalizeZipBufferInput(event, 1)
                                    })}
                                />
                              </td>
                              <td class="batshit-settings-table-cell">
                                <input
                                  type={toolZipInputsDisabled ? 'text' : 'number'}
                                  min="0"
                                  class="batshit-settings-grid-input"
                                  value={toolZipInputsDisabled ? '-' : toolZip.zip_threshold}
                                  placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZip.inherited_zip_threshold)}
                                  disabled={toolZipInputsDisabled}
                                  oninput={(event) =>
                                    updateToolZipOverride(tool.toolId, {
                                      zip_threshold: (event.currentTarget as HTMLInputElement).value
                                    })}
                                />
                              </td>
                              <td class="batshit-settings-table-cell">
                                <Select.Root
                                  type="single"
                                  value={toolZip.auto_zip}
                                  onValueChange={(value) =>
                                    updateToolZipOverride(tool.toolId, {
                                      auto_zip: value ?? 'inherit'
                                    })}
                                >
                                  <Select.Trigger
                                    class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(toolZip.auto_zip === 'inherit')}`}
                                    size="sm"
                                    title={toolZipBehaviorLabel}
                                  >
                                    <span class="inline-flex h-4 w-4 items-center justify-center">
                                      {#if autoZipIconMode === 'off'}
                                        <Infinity class={`h-3.5 w-3.5 ${iconToneClass(toolZip.auto_zip === 'inherit')}`} />
                                      {:else if autoZipIconMode === 'enabled'}
                                        <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(toolZip.auto_zip === 'inherit')}`} />
                                      {:else}
                                        <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(toolZip.auto_zip === 'inherit')}`} />
                                      {/if}
                                    </span>
                                    <span class="sr-only">
                                      {toolZipBehaviorLabel}
                                    </span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    <Select.Item
                                      value="inherit"
                                      label={getZipBehaviorLabel('inherit', toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                                    >
                                      <span class="flex items-center gap-2">
                                        <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                          {#if autoZipIconMode === 'off'}
                                            <Infinity class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                          {:else if autoZipIconMode === 'enabled'}
                                            <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                          {:else}
                                            <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                          {/if}
                                        </span>
                                        <span>{getZipBehaviorLabel('inherit', toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}</span>
                                      </span>
                                    </Select.Item>
                                    <Select.Item value="disabled" label="Normal">
                                      <span class="flex items-center gap-2">
                                        <Clock3 class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
                                        <span>Normal</span>
                                      </span>
                                    </Select.Item>
                                    <Select.Item value="enabled" label="Auto">
                                      <span class="flex items-center gap-2">
                                        <BatshitIcon id="zip" class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
                                        <span>Auto</span>
                                      </span>
                                    </Select.Item>
                                    <Select.Item value="off" label="Off">
                                      <span class="flex items-center gap-2">
                                        <Infinity class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
                                        <span>Off</span>
                                      </span>
                                    </Select.Item>
                                  </Select.Content>
                                </Select.Root>
                              </td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    </Collapsible.Content>
                  </td>
                </tr>
              </Collapsible.Root>
            {/if}

            {#each gateways as gateway (gateway.id)}
              {@const sourceKey = buildSourceKey(gateway.id)}
              {@const sourceExpanded = openTopLevelAccordionItemKey === sourceKey}
              <Collapsible.Root open={sourceExpanded}>
                <tr
                  class={`${topLevelAccordionRowClass} cursor-pointer ${!gateway.enabled ? 'opacity-70' : ''}`}
                  onclick={(event) => handleTopLevelHeaderClick(event, sourceKey)}
                >
                  <td class="batshit-settings-table-cell is-strong">
                    <div class="batshit-settings-tool-grid-label">
                      <ToolGridIdentityIcon
                        ref={gateway.iconRef}
                        typeLabel="MCP Source"
                        name={gateway.name}
                      />
                      <span class="batshit-settings-tool-grid-name block truncate" title={`MCP Source: ${gateway.name}`}>{gateway.name}</span>
                      {#if !gateway.enabled}
                        <span class="shrink-0 batshit-settings-pill text-muted-foreground">
                          Disabled Globally
                        </span>
                      {/if}
                    </div>
                  </td>
                  <td class="batshit-settings-table-cell">
                    <Switch.Root
                      checked={gateway.enabled}
                      onCheckedChange={(checked) => handleGatewayEnabledChange(gateway.id, checked === true)}
                    />
                  </td>
                  <td class="batshit-settings-table-cell"></td>
                  <td class="batshit-settings-table-cell"></td>
                  <td class="batshit-settings-table-cell"></td>
                  <td class="batshit-settings-table-cell">
                    <Collapsible.Trigger
                      class="ml-auto flex items-center justify-end"
                      aria-expanded={sourceExpanded}
                      aria-label={`Toggle groups for MCP Source ${gateway.name}`}
                      onclick={() => toggleTopLevelAccordionItem(sourceKey)}
                    >
                      <ChevronDown class={`h-3.5 w-3.5 transition-transform ${sourceExpanded ? 'rotate-180' : ''}`} />
                    </Collapsible.Trigger>
                  </td>
                </tr>

                <tr class="batshit-settings-table-row is-flush">
                  <td colspan="6" class="batshit-settings-table-cell is-flush">
                    <Collapsible.Content class="overflow-hidden">
                      <table class={TOOL_GRID_TABLE_CLASS}>
                        <colgroup>
                          <col class={TOOL_GRID_FIRST_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                          <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                        </colgroup>
                        <tbody>
                          {#if gateway.groups.length === 0}
                            <tr class="batshit-settings-table-row">
                              <td colspan="6" class="batshit-settings-table-cell is-muted is-empty is-nested">
                                {gateway.enabled
                                  ? 'No groups discovered in this MCP Source.'
                                  : 'This MCP Source is disabled globally. Turn it back on to refresh its groups.'}
                              </td>
                            </tr>
                          {/if}

                          {#each gateway.groups as group (group.id)}
                            {@const groupKey = buildGroupKey(gateway.id, group.name)}
                            {@const groupMode = getGroupMode(gateway, group.name)}
                            {@const groupVisible = isGroupVisible(gateway, group.name)}
                            {@const groupExpanded = openNestedAccordionItemKey === groupKey}
                            {@const groupIconMode = normalizeGroupIconMode(groupMode)}
                            {@const groupToggleDisabled = !gateway.enabled}
                            <Collapsible.Root open={groupExpanded}>
                              <tr
                                class={`${nestedAccordionRowClass} cursor-pointer ${groupToggleDisabled ? 'opacity-60' : ''}`}
                                onclick={(event) => handleGroupHeaderClick(event, groupKey)}
                              >
                                <td class="batshit-settings-table-cell is-strong">
                                  <div class="batshit-settings-tool-grid-label is-group">
                                    <ToolGridIdentityIcon
                                      ref={getGroupIconRef(group)}
                                      typeLabel="MCP Group"
                                      name={group.name}
                                    />
                                    <span class="batshit-settings-tool-grid-name block truncate" title={`MCP Group: ${group.name}`}>{group.name}</span>
                                  </div>
                                </td>
                                <td class="batshit-settings-table-cell">
                                  <Switch.Root
                                    checked={groupVisible}
                                    disabled={groupToggleDisabled}
                                    onCheckedChange={(checked) => handleGroupToggle(gateway.id, group.name, checked === true)}
                                  />
                                </td>
                                <td class="batshit-settings-table-cell">
                                  {#if groupVisible}
                                    <Select.Root
                                      type="single"
                                      value={groupMode === 'hidden' ? 'group+tools+hints' : groupMode}
                                      disabled={groupToggleDisabled}
                                      onValueChange={(value) => value && handleGroupModeChange(gateway.id, group.name, value)}
                                    >
                                      <Select.Trigger
                                        class="batshit-settings-grid-select-trigger"
                                        size="sm"
                                        title={getGroupModeLabel(groupMode)}
                                      >
                                        <span class="inline-flex h-4 w-4 items-center justify-center">
                                          {#if groupIconMode === 'group-only'}
                                            <Zap class="h-3.5 w-3.5 text-white" />
                                          {:else if groupIconMode === 'group+tools+names'}
                                            <SignalMedium class="h-3.5 w-3.5 text-white" />
                                          {:else}
                                            <Signal class="h-3.5 w-3.5 text-white" />
                                          {/if}
                                        </span>
                                        <span class="sr-only">{getGroupModeLabel(groupMode)}</span>
                                      </Select.Trigger>
                                      <Select.Content>
                                        {#each GROUP_DISPLAY_OPTIONS as option}
                                          {@const optionIconMode = normalizeGroupIconMode(option.value)}
                                          <Select.Item value={option.value} label={option.label}>
                                            <span class="flex items-center gap-2">
                                              <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                                {#if optionIconMode === 'group-only'}
                                                  <Zap class="h-3.5 w-3.5 text-white" />
                                                {:else if optionIconMode === 'group+tools+names'}
                                                  <SignalMedium class="h-3.5 w-3.5 text-white" />
                                                {:else}
                                                  <Signal class="h-3.5 w-3.5 text-white" />
                                                {/if}
                                              </span>
                                              <span>{option.label}</span>
                                            </span>
                                          </Select.Item>
                                        {/each}
                                      </Select.Content>
                                    </Select.Root>
                                  {/if}
                                </td>
                                <td class="batshit-settings-table-cell">
                                  <input
                                    type="number"
                                    min="1"
                                    class="batshit-settings-grid-input batshit-settings-tool-grid-bulk-input"
                                    value={getBulkZipDraft(groupKey).buffer_size}
                                    placeholder="All"
                                    aria-label={`Zip buffer to apply to MCP group ${group.name}`}
                                    oninput={(event) =>
                                      updateBulkZipDraft(groupKey, {
                                        buffer_size: normalizeZipBufferInput(event, 1)
                                      })}
                                  />
                                </td>
                                <td class="batshit-settings-table-cell">
                                  <div class="batshit-settings-tool-grid-bulk-cell">
                                    <input
                                      type="number"
                                      min="0"
                                      max={String(MAX_ZIP_THRESHOLD)}
                                      class="batshit-settings-grid-input batshit-settings-tool-grid-bulk-input"
                                      value={getBulkZipDraft(groupKey).zip_threshold}
                                      placeholder="All"
                                      aria-label={`Zip threshold to apply to MCP group ${group.name}`}
                                      oninput={(event) =>
                                        updateBulkZipDraft(groupKey, {
                                          zip_threshold: normalizeZipThresholdInput(event)
                                        })}
                                    />
                                    <Button
                                      variant="outline"
                                      size="icon"
                                      class="batshit-settings-tool-grid-bulk-apply"
                                      disabled={!canApplyBulkZipDraft(groupKey)}
                                      aria-label={`Apply zip buffer and threshold to MCP group ${group.name}`}
                                      title={`Apply zip buffer and threshold to MCP group ${group.name}`}
                                      onclick={() => applyBulkZipToTools(groupKey, getGroupToolIds(group))}
                                    >
                                      <Check class="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </td>
                                <td class="batshit-settings-table-cell">
                                  <div class="batshit-settings-tool-grid-row-actions">
                                    <SettingsInfoMenu
                                      ariaLabel={`About applying zip numbers to MCP group ${group.name}`}
                                      side="left"
                                      align="end"
                                      class="batshit-settings-tool-grid-bulk-info"
                                      contentClass="w-72"
                                    >
                                      Enter a Zip Buffer, Zip Threshold, or both, then press the
                                      check to copy those numbers to every tool row in this MCP
                                      group. Blank fields stay unchanged, and Zip Behavior stays
                                      unchanged.
                                    </SettingsInfoMenu>
                                    <Collapsible.Trigger
                                      class="ml-auto flex items-center justify-end"
                                      aria-expanded={groupExpanded}
                                      aria-label={`Toggle tools for group ${group.name}`}
                                      onclick={() => toggleNestedAccordionItem(groupKey)}
                                    >
                                      <ChevronDown class={`h-3.5 w-3.5 transition-transform ${groupExpanded ? 'rotate-180' : ''}`} />
                                    </Collapsible.Trigger>
                                  </div>
                                </td>
                              </tr>

                              <tr class="batshit-settings-table-row is-flush">
                                <td colspan="6" class="batshit-settings-table-cell is-flush">
                                  <Collapsible.Content class="overflow-hidden">
                                    <table class={TOOL_GRID_TABLE_CLASS}>
                                      <colgroup>
                                        <col class={TOOL_GRID_FIRST_COLUMN_CLASS} />
                                        <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                                        <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                                        <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                                        <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                                        <col class={TOOL_GRID_OTHER_COLUMN_CLASS} />
                                      </colgroup>
                                      <tbody>
                                        {#each group.tools as tool (tool.id)}
                                          {@const toolVisible = isToolVisible(gateway, group.name, tool.id)}
                                          {@const toolMode = getToolMode(gateway, tool.id)}
                                          {@const toolDisableReason = getToolDisableReason(groupMode, gateway.enabled)}
                                          {@const toolToggleDisabled = Boolean(toolDisableReason)}
                                          {@const toolIconMode = getToolIconMode(groupMode, toolMode)}
                                          {@const toolZip = getToolZipOverride(tool.id)}
                                          {@const autoZipIconMode = getZipBehaviorIconMode(toolZip.auto_zip, toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                                          {@const toolAutoZipActive = isEffectiveAutoZipEnabled(toolZip.auto_zip, toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                                          {@const toolZipDisabled = isEffectiveZipDisabled(toolZip.auto_zip, toolZip.inherited_zip_disabled)}
                                          {@const toolZipInputsDisabled = toolAutoZipActive || toolZipDisabled}
                                          {@const toolZipBehaviorLabel = getZipBehaviorLabel(toolZip.auto_zip, toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                                          <tr class={`batshit-settings-table-row `}>
                                            <td class="batshit-settings-table-cell is-muted is-nested">
                                              <div class="flex min-w-0 items-center gap-2">
                                                <span class="batshit-settings-tool-grid-name min-w-0 truncate font-mono text-[11px]" title={tool.name}>
                                                  {tool.name}
                                                </span>
                                                {#if toolDisableReason}
                                                  <span class="shrink-0 batshit-settings-pill">
                                                    {toolDisableReason}
                                                  </span>
                                                {:else if toolVisible && toolMode === 'inherit'}
                                                  <span class="shrink-0 batshit-settings-pill">
                                                    Group default
                                                  </span>
                                                {/if}
                                              </div>
                                            </td>
                                            <td class="batshit-settings-table-cell">
                                              <Switch.Root
                                                checked={toolVisible}
                                                disabled={toolToggleDisabled}
                                                onCheckedChange={(checked) =>
                                                  handleToolToggle(gateway.id, tool.id, checked === true)}
                                              />
                                            </td>
                                            <td class="batshit-settings-table-cell">
                                              {#if toolVisible}
                                                <Select.Root
                                                  type="single"
                                                  value={toolMode === 'hidden' ? 'inherit' : toolMode}
                                                  disabled={toolToggleDisabled}
                                                  onValueChange={(value) => value && handleToolModeChange(gateway.id, tool.id, value)}
                                                >
                                                  <Select.Trigger
                                                    class={`batshit-settings-grid-select-trigger ${inheritTriggerClass((toolMode === 'hidden' ? 'inherit' : toolMode) === 'inherit')}`}
                                                    size="sm"
                                                    title={getToolModeLabel(toolMode === 'hidden' ? 'inherit' : toolMode)}
                                                  >
                                                    <span class="inline-flex h-4 w-4 items-center justify-center">
                                                      {#if toolIconMode === 'name-only'}
                                                        <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass((toolMode === 'hidden' ? 'inherit' : toolMode) === 'inherit')}`} />
                                                      {:else}
                                                        <Signal class={`h-3.5 w-3.5 ${iconToneClass((toolMode === 'hidden' ? 'inherit' : toolMode) === 'inherit')}`} />
                                                      {/if}
                                                    </span>
                                                    <span class="sr-only">{getToolModeLabel(toolMode === 'hidden' ? 'inherit' : toolMode)}</span>
                                                  </Select.Trigger>
                                                  <Select.Content>
                                                    {#each TOOL_DISPLAY_OPTIONS as option}
                                                      {@const optionIconMode = getToolIconMode(groupMode, option.value)}
                                                      <Select.Item value={option.value} label={option.label}>
                                                        <span class="flex items-center gap-2">
                                                          <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                                            {#if optionIconMode === 'name-only'}
                                                              <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'inherit')}`} />
                                                            {:else}
                                                              <Signal class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'inherit')}`} />
                                                            {/if}
                                                          </span>
                                                          <span>{option.label}</span>
                                                        </span>
                                                      </Select.Item>
                                                    {/each}
                                                  </Select.Content>
                                                </Select.Root>
                                              {/if}
                                            </td>
                                            <td class="batshit-settings-table-cell">
                                              <input
                                                type={toolZipInputsDisabled ? 'text' : 'number'}
                                                min="1"
                                                class="batshit-settings-grid-input"
                                                value={toolZipInputsDisabled ? '-' : toolZip.buffer_size}
                                                placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZip.inherited_buffer_size)}
                                                disabled={toolZipInputsDisabled}
                                                oninput={(event) =>
                                                  updateToolZipOverride(tool.id, {
                                                    buffer_size: normalizeZipBufferInput(event, 1)
                                                  })}
                                              />
                                            </td>
                                            <td class="batshit-settings-table-cell">
                                              <input
                                                type={toolZipInputsDisabled ? 'text' : 'number'}
                                                min="0"
                                                class="batshit-settings-grid-input"
                                                value={toolZipInputsDisabled ? '-' : toolZip.zip_threshold}
                                                placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZip.inherited_zip_threshold)}
                                                disabled={toolZipInputsDisabled}
                                                oninput={(event) =>
                                                  updateToolZipOverride(tool.id, {
                                                    zip_threshold: (event.currentTarget as HTMLInputElement).value
                                                  })}
                                              />
                                            </td>
                                            <td class="batshit-settings-table-cell">
                                              <Select.Root
                                                type="single"
                                                value={toolZip.auto_zip}
                                                onValueChange={(value) =>
                                                  updateToolZipOverride(tool.id, {
                                                    auto_zip: value ?? 'inherit'
                                                  })}
                                              >
                                                <Select.Trigger
                                                  class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(toolZip.auto_zip === 'inherit')}`}
                                                  size="sm"
                                                  title={toolZipBehaviorLabel}
                                                >
                                                  <span class="inline-flex h-4 w-4 items-center justify-center">
                                                    {#if autoZipIconMode === 'off'}
                                                      <Infinity class={`h-3.5 w-3.5 ${iconToneClass(toolZip.auto_zip === 'inherit')}`} />
                                                      {:else if autoZipIconMode === 'enabled'}
                                                        <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(toolZip.auto_zip === 'inherit')}`} />
                                                      {:else}
                                                        <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(toolZip.auto_zip === 'inherit')}`} />
                                                      {/if}
                                                  </span>
                                                  <span class="sr-only">
                                                    {toolZipBehaviorLabel}
                                                  </span>
                                                </Select.Trigger>
                                                <Select.Content>
                                                  <Select.Item
                                                    value="inherit"
                                                    label={getZipBehaviorLabel('inherit', toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}
                                                  >
                                                    <span class="flex items-center gap-2">
                                                      <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                                        {#if autoZipIconMode === 'off'}
                                                          <Infinity class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                                          {:else if autoZipIconMode === 'enabled'}
                                                            <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                                          {:else}
                                                            <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                                          {/if}
                                                      </span>
                                                      <span>{getZipBehaviorLabel('inherit', toolZip.inherited_auto_zip, toolZip.inherited_zip_disabled)}</span>
                                                    </span>
                                                  </Select.Item>
                                                  <Select.Item value="disabled" label="Normal">
                                                    <span class="flex items-center gap-2">
                                                      <Clock3 class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
                                                      <span>Normal</span>
                                                    </span>
                                                  </Select.Item>
                                                  <Select.Item value="enabled" label="Auto">
                                                    <span class="flex items-center gap-2">
                                                      <BatshitIcon id="zip" class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
                                                      <span>Auto</span>
                                                    </span>
                                                  </Select.Item>
                                                  <Select.Item value="off" label="Off">
                                                    <span class="flex items-center gap-2">
                                                      <Infinity class={`h-3.5 w-3.5 shrink-0 ${iconToneClass(false)}`} />
                                                      <span>Off</span>
                                                    </span>
                                                  </Select.Item>
                                                </Select.Content>
                                              </Select.Root>
                                            </td>
                                          </tr>
                                        {/each}
                                      </tbody>
                                    </table>
                                  </Collapsible.Content>
                                </td>
                              </tr>
                            </Collapsible.Root>
                          {/each}
                        </tbody>
                      </table>
                    </Collapsible.Content>
                  </td>
                </tr>
              </Collapsible.Root>
            {/each}

            <NonMcpZipRowsSection
              sectionKey={OTHER_ROWS_KEY}
              title="Other"
              sectionIconRef={TOOL_GRID_OTHER_SECTION_ICON_REF}
              typeLabel="Other Tool"
              rowIds={OTHER_ROW_ORDER}
              rowConfig={OTHER_ZIP_ROW_CONFIG}
              open={openTopLevelAccordionItemKey === OTHER_ROWS_KEY}
              {topLevelAccordionRowClass}
              tableClass={TOOL_GRID_TABLE_CLASS}
              firstColumnClass={TOOL_GRID_FIRST_COLUMN_CLASS}
              otherColumnClass={TOOL_GRID_OTHER_COLUMN_CLASS}
              getRowOverride={getOtherZipRowOverride}
              onUpdateRowOverride={updateOtherZipRowOverride}
              onHeaderClick={handleTopLevelHeaderClick}
              onToggle={toggleTopLevelAccordionItem}
              showBulkZipApply
              bulkZipApplyLabel="Other"
              flattenSingleRow
            />
          </tbody>
        </table>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={resetGlobalToolGridDefaults}
          disabled={!userId || loading || globalResetBusy}
        >
          <RotateCcw aria-hidden="true" />
          Reset to defaults
        </Button>
      </div>
    {/if}
</SettingsAccordionCard>
