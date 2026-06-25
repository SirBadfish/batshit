<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
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
  import { debounce } from '$lib/utils/debounce'
  import {
    MAX_ZIP_THRESHOLD,
    normalizeZipBufferInputValue,
    normalizeZipThresholdInputValue
  } from '$lib/utils/zipBufferInput'
	  import {
	    CLI_TOOL_GRID_GROUP_NAME,
	    CLI_TOOL_GRID_ID,
	    createDefaultCliToolGridSettings,
	    normalizeCliToolGridSettings,
	    normalizeCliToolIdList
	  } from '$lib/utils/toolGridCli'
	  import {
	    cloneDcmDisplaySettings,
	    createDefaultDcmDisplaySettings,
	    createDefaultGatewayDcmDisplaySettings,
	    normalizeDcmDisplaySettings,
	    normalizeGatewayDcmDisplaySettings,
	    VALID_AGENT_DCM_GROUP_MODES as VALID_GROUP_MODES,
	    VALID_DCM_GLOBAL_GROUP_MODES as VALID_GLOBAL_GROUP_MODES,
	    VALID_DCM_GROUP_DISPLAY_PREFERENCES as VALID_GROUP_PREFERENCES,
	    VALID_DCM_TOOL_DISPLAY_MODES as VALID_TOOL_MODES,
	    VALID_DCM_TOOL_DISPLAY_PREFERENCES as VALID_TOOL_PREFERENCES
	  } from '$lib/utils/dcmDisplaySettings'
  import {
    SHARED_NON_MCP_TOOL_GRID_CONFIG,
    SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS,
    SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS,
    TOOL_GRID_BATSHIT_SECTION_ICON_REF,
    TOOL_GRID_OTHER_SECTION_ICON_REF,
    type SharedNonMcpToolGridRowConfig,
    type SharedNonMcpToolGridRowId
  } from '$lib/components/tools/toolGridConfig'
  import type {
    AgentDcmDisplaySettings,
    AgentDcmGroupDisplayPreference,
    AgentDcmGroupDisplayMode,
    AgentDcmToolDisplayPreference,
    DcmGroupDisplayMode,
    DcmToolDisplayMode,
    GatewayDcmDisplaySettings,
    MCPGateway,
    MCPToolSelections
  } from '$lib/types/database'
  import {
    AlertCircle,
    Check,
    ChevronDown,
    Clock3,
    Eye,
    Grid3X3,
    Infinity,
    Loader2,
    RefreshCcw,
    RotateCcw,
    Signal,
    SignalMedium,
    Zap
  } from '@lucide/svelte'
  import type { PrimaryAgentType } from '$lib/utils/primaryAgentType'
  import { isManagedPrimaryAgentType } from '$lib/utils/primaryAgentType'

  interface PreviewTokenEstimates {
    enabled?: number
    dcm?: number
    total?: number
  }

  interface PreviewCounts {
    enabledTools?: number
    availableTools?: number
    dcmTools?: number
    groups?: number
  }

  interface PreviewPayload {
    text?: string
    tokenEstimates?: PreviewTokenEstimates
    counts?: PreviewCounts
  }

  interface CliToolCatalogRow {
    toolId: string
    title: string
    description?: string
    riskLevel?: string
    iconRef: IconRef
  }

  type DcmGroupRow = ToolGridGroupRow

  interface DcmGatewayRow {
    id: string
    name: string
    iconRef: IconRef
    globalDefaults: GatewayDcmDisplaySettings
    groups: DcmGroupRow[]
  }

  interface ToolZipOverrideSnapshot {
    buffer_size: string
    zip_threshold: string
    auto_zip: string
    inherited_buffer_size?: number
    inherited_zip_threshold?: number
    inherited_auto_zip?: boolean
    inherited_zip_disabled?: boolean
  }

  type ToolZipOverridePatch = Partial<
    Pick<ToolZipOverrideSnapshot, 'buffer_size' | 'zip_threshold' | 'auto_zip'>
  >

  type BulkZipDraft = {
    buffer_size: string
    zip_threshold: string
  }

  type BulkZipPatch = {
    buffer_size?: string
    zip_threshold?: string
  }

  interface NonMcpZipRow {
    id: SharedNonMcpToolGridRowId
    label: string
    iconRef: IconRef
  }

  interface NonMcpZipOverrideSnapshot {
    buffer_size: string
    zip_threshold: string
    auto_zip: string
    inherited_buffer_size?: number
    inherited_zip_threshold?: number
    inherited_auto_zip?: boolean
    inherited_zip_disabled?: boolean
    min_buffer: number
  }

  type SectionZipAutoValue = 'inherit' | 'enabled' | 'disabled' | 'off'

  interface SectionNonMcpZipOverrideSnapshot {
    buffer_size: string
    zip_threshold: string
    auto_zip: SectionZipAutoValue
    inherited_buffer_size: number
    inherited_zip_threshold: number
    inherited_auto_zip: boolean
    inherited_zip_disabled: boolean
    min_buffer: number
  }

  type SectionNonMcpZipOverridePatch = Partial<
    Pick<SectionNonMcpZipOverrideSnapshot, 'buffer_size' | 'zip_threshold' | 'auto_zip'>
  >

  type NonMcpZipOverridePatch = Partial<
    Pick<NonMcpZipOverrideSnapshot, 'buffer_size' | 'zip_threshold' | 'auto_zip'>
  >

  interface Props {
    agentId?: string | null
    agentType?: PrimaryAgentType
    userId?: string | null
    defaultMCPGateways: string[]
    defaultMCPToolSelections: MCPToolSelections
    defaultCliToolIds?: string[] | null
    cliToolIdsExplicit?: boolean
    dcmDisplaySettings: AgentDcmDisplaySettings
    mcpSaveState: 'idle' | 'saving' | 'saved'
    mcpSaveError?: string | null
    mcpLastSaved?: Date | null
    mcpRenderNonce: number
    nativeDynamicMcpEnabled?: boolean | null
    nativeCliToolsEnabled?: boolean | null
    isCodexMode?: boolean
    onGatewaysChange: (gateways: string[]) => void
    onDcmDisplaySettingsChange: (settings: AgentDcmDisplaySettings) => void
    onCliToolIdsChange?: (toolIds: string[]) => void
    getToolZipOverride: (toolName: string) => ToolZipOverrideSnapshot
    onToolZipOverrideChange: (toolName: string, patch: ToolZipOverridePatch) => void
    showZipControls?: boolean
    showCardHeader?: boolean
    showZipModeControls?: boolean
    showPostTableControls?: boolean
    showGridIntroBlock?: boolean
    fullWidthTable?: boolean
    compactDropdownMode?: boolean
    toolGridTitle?: string
    zipAgentControlEnabled?: string
    zipAiViewMode?: string
    zipToolNotesEnabled?: string
    nonMcpZipRows?: NonMcpZipRow[]
    getNonMcpZipOverride: (rowId: string) => NonMcpZipOverrideSnapshot
    onNonMcpZipOverrideChange: (rowId: string, patch: NonMcpZipOverridePatch) => void
    onZipAgentControlChange: (value: string) => void
    onZipAiViewModeChange: (value: string) => void
    onZipToolNotesChange?: (value: string) => void
    onResetToGlobalSettings?: () => void
    zipSaveState?: 'idle' | 'saving' | 'saved'
    zipSaveError?: string | null
    zipValidationError?: string | null
    zipLastSaved?: Date | null
    accordionName?: string
    defaultOpen?: boolean
    cardCollapsible?: boolean
  }

  let {
    agentId = null,
    agentType = 'n8n',
    userId = null,
    defaultMCPGateways = [],
    defaultMCPToolSelections = [],
    defaultCliToolIds = [],
    cliToolIdsExplicit = true,
    dcmDisplaySettings = { version: 1, groups: {}, tools: {} },
    mcpSaveState = 'idle',
    mcpSaveError = null,
    mcpLastSaved = null,
    mcpRenderNonce = 0,
    nativeDynamicMcpEnabled = null,
    nativeCliToolsEnabled = null,
    isCodexMode = false,
    onGatewaysChange,
    onDcmDisplaySettingsChange,
    onCliToolIdsChange = () => {},
    getToolZipOverride = () => ({
      buffer_size: '',
      zip_threshold: '',
      auto_zip: '__inherit__'
    }),
    onToolZipOverrideChange = () => {},
    showZipControls = true,
    showCardHeader = true,
    showZipModeControls = true,
    showPostTableControls = true,
    showGridIntroBlock = true,
    fullWidthTable = false,
    compactDropdownMode = false,
    toolGridTitle = 'Tool Settings Grid',
    zipAgentControlEnabled = '__inherit__',
    zipAiViewMode = '__inherit__',
    zipToolNotesEnabled = '__inherit__',
    nonMcpZipRows = [],
    getNonMcpZipOverride = () => ({
      buffer_size: '',
      zip_threshold: '',
      auto_zip: '__inherit__',
      min_buffer: 2
    }),
    onNonMcpZipOverrideChange = () => {},
    onZipAgentControlChange = () => {},
    onZipAiViewModeChange = () => {},
    onZipToolNotesChange = () => {},
    onResetToGlobalSettings = () => {},
    zipSaveState = 'idle',
    zipSaveError = null,
    zipValidationError = null,
    zipLastSaved = null,
    accordionName = 'agent-tool-grid-cards',
    defaultOpen = false,
    cardCollapsible = true
  }: Props = $props()

  const ZIP_AUTO_INHERIT = '__inherit__'
  const ZIP_PERMISSION_INHERIT = '__inherit__'
  const ZIP_LAYOUT_INHERIT = '__inherit__'
  const ZIP_NOTES_INHERIT = '__inherit__'

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
      onToolZipOverrideChange(toolName, patch)
    }
  }

  function applyBulkZipToNonMcpRows(key: string, rowIds: string[]) {
    const patch = getBulkZipPatch(key)
    if (!patch) return

    for (const rowId of rowIds) {
      onNonMcpZipOverrideChange(rowId, patch)
    }
  }

  function getCliToolIds(): string[] {
    return cliToolCatalog.map((tool) => tool.toolId)
  }

  function getGroupToolIds(group: DcmGroupRow): string[] {
    return group.tools.map((tool) => tool.id)
  }

  function getNonMcpRowIds(rows: NonMcpZipRow[]): SharedNonMcpToolGridRowId[] {
    return rows.map((row) => row.id)
  }

  const GROUP_DISPLAY_OPTIONS: Array<{
    value: AgentDcmGroupDisplayPreference
    label: string
  }> = [
    { value: 'use-global', label: 'Inherit Gateway Default' },
    { value: 'group+tools+hints', label: 'Group + Tools + Hints' },
    { value: 'group+tools+names', label: 'Group + Tool Names' },
    { value: 'group-only', label: 'Group Only' }
  ]

  const TOOL_DISPLAY_OPTIONS: Array<{
    value: AgentDcmToolDisplayPreference
    label: string
  }> = [
    { value: 'inherit', label: 'Inherit Group/Default' },
    { value: 'name+hint', label: 'Name + Hint' },
    { value: 'name-only', label: 'Name Only' }
  ]

  type GroupIconMode = 'group-only' | 'group+tools+names' | 'group+tools+hints'
  type ToolIconMode = 'name-only' | 'name+hint'
  type AutoZipIconMode = 'enabled' | 'disabled' | 'off'

  let previewOpen = $state(false)
  let previewLoading = $state(false)
  let previewError = $state<string | null>(null)
  let previewData = $state<PreviewPayload | null>(null)
  let previewSignature = $state<string | null>(null)

  let dcmCatalogLoading = $state(false)
  let dcmCatalogError = $state<string | null>(null)
  let dcmCatalog = $state<DcmGatewayRow[]>([])
  let cliToolCatalog = $state<CliToolCatalogRow[]>([])
  let globalCliToolGridSettings = $state(createDefaultCliToolGridSettings())
  let dcmCatalogSignature = $state<string | null>(null)
  let openTopLevelAccordionItemKey = $state<string | null>(null)
  let openNestedAccordionItemKey = $state<string | null>(null)
  let bulkZipDrafts = $state<Record<string, BulkZipDraft>>({})

  const topLevelAccordionRowClass = 'batshit-settings-accordion-row'
  const nestedAccordionRowClass = 'batshit-settings-accordion-row is-nested'
  const BATSHIT_ROWS_KEY = '__batshit_tool_rows__'
  const OTHER_ROWS_KEY = '__other_tool_rows__'
  const nonMcpRowConfig = SHARED_NON_MCP_TOOL_GRID_CONFIG as Record<
    SharedNonMcpToolGridRowId,
    SharedNonMcpToolGridRowConfig
  >

  const normalizedEnabledToolNames = $derived.by(() => {
    const values = Array.isArray(defaultMCPToolSelections)
      ? defaultMCPToolSelections
      : []
    return new Set(values.map((name) => normalizeToolName(name)).filter(Boolean))
  })

  const normalizedDcmDisplaySettings = $derived(
    normalizeDcmDisplaySettings(dcmDisplaySettings)
  )

  const dynamicMcpEnabled = $derived.by(() =>
    typeof nativeDynamicMcpEnabled === 'boolean'
      ? nativeDynamicMcpEnabled
      : hasDynamicMcpTools(normalizedEnabledToolNames)
  )

  const effectiveCliToolIds = $derived.by(() =>
    cliToolIdsExplicit
      ? normalizeCliToolIdList(defaultCliToolIds)
      : globalCliToolGridSettings.discoverableToolIds
  )

  const cliToolsEnabled = $derived.by(() =>
    typeof nativeCliToolsEnabled === 'boolean'
      ? nativeCliToolsEnabled
      : effectiveCliToolIds.length > 0
  )

  const columnCount = $derived(showZipControls ? 6 : 3)

  const zipToolGridTableSizeClass = $derived(
    compactDropdownMode ? 'min-w-[720px]' : 'min-w-[740px]'
  )
  const fixedZipToolGridTableSizeClass = $derived(
    compactDropdownMode ? 'w-[720px] min-w-[720px]' : 'w-[740px] min-w-[740px]'
  )
  const toolGridItemColumnClass = $derived(
    compactDropdownMode && showZipControls ? 'w-[220px]' : 'w-[240px]'
  )

  const toolGridTableClass = $derived(
    fullWidthTable
      ? `w-full ${showZipControls ? zipToolGridTableSizeClass : 'min-w-[440px]'} table-fixed text-xs`
      : `${showZipControls ? fixedZipToolGridTableSizeClass : 'w-[440px] min-w-[440px]'} table-fixed text-xs`
  )

  const batshitRowIdSet = new Set<string>(SHARED_NON_MCP_TOOL_GRID_BATSHIT_ROW_IDS)
  const otherRowIdSet = new Set<string>(SHARED_NON_MCP_TOOL_GRID_OTHER_ROW_IDS)

  const batshitNonMcpRows = $derived.by(() =>
    nonMcpZipRows.filter((row) => batshitRowIdSet.has(row.id))
  )

  const otherNonMcpRows = $derived.by(() =>
    nonMcpZipRows.filter((row) => otherRowIdSet.has(row.id))
  )
  const hasToolGridRows = $derived(
    dcmCatalog.length > 0 ||
      cliToolCatalog.length > 0 ||
      (showZipControls &&
        (batshitNonMcpRows.length > 0 || otherNonMcpRows.length > 0))
  )
  const initialCompactCatalogLoad = $derived(
    compactDropdownMode &&
      dcmCatalogLoading &&
      dcmCatalog.length === 0 &&
      cliToolCatalog.length === 0
  )

  const toolGridInfoText = $derived(
    showZipControls
      ? 'Configure discoverability, display-detail preferences, and zip behavior in one grid for MCP tools, CLI tools, and zip-enabled rows. Discoverability and display-detail settings control what appears in the DCM (Dynamic Current Message). Zip columns set per-row overrides, blank fields inherit defaults, and these controls do not execute tools directly. Chat Bar toggles use the same saved state, and hiding rows does not erase the last display-detail preference.'
      : 'Configure discoverability and display-detail preferences in one grid for MCP tools and CLI tools. These controls affect what appears in the DCM (Dynamic Current Message) and which tools the current agent or subagent can discover. Hiding rows does not erase the last display-detail preference.'
  )

  const effectiveCliToolIdSet = $derived(new Set(effectiveCliToolIds))

  const createDefaultGatewayDcmDisplayDefaults = createDefaultGatewayDcmDisplaySettings
  const normalizeGatewayDcmDefaults = normalizeGatewayDcmDisplaySettings

  function normalizeToolName(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
  }

  function hasDynamicMcpTools(enabledTools: Set<string>): boolean {
    const hasFind =
      enabledTools.has('batshit_server_dynamic_mcp_find') ||
      enabledTools.has('dynamic_mcp_find') ||
      enabledTools.has('native_dynamic_mcp_find')
    const hasUse =
      enabledTools.has('batshit_server_dynamic_mcp_use') ||
      enabledTools.has('dynamic_mcp_use') ||
      enabledTools.has('native_dynamic_mcp_use')
    return hasFind && hasUse
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

  function getGroupMode(gatewayId: string, groupName: string): AgentDcmGroupDisplayMode {
    const key = buildGroupKey(gatewayId, groupName)
    const mode = normalizedDcmDisplaySettings.groups[key]
    return VALID_GROUP_MODES.has(mode) ? mode : 'use-global'
  }

  function getToolMode(gatewayId: string, toolName: string): DcmToolDisplayMode {
    const key = buildToolKey(gatewayId, toolName)
    const mode = normalizedDcmDisplaySettings.tools[key]
    return VALID_TOOL_MODES.has(mode) ? mode : 'inherit'
  }

  function getGroupPreference(gatewayId: string, groupName: string): AgentDcmGroupDisplayPreference {
    const key = buildGroupKey(gatewayId, groupName)
    const explicit = normalizedDcmDisplaySettings.groupDisplayPreferences?.[key]
    if (explicit && VALID_GROUP_PREFERENCES.has(explicit)) {
      return explicit
    }
    const mode = getGroupMode(gatewayId, groupName)
    if (mode !== 'hidden' && VALID_GROUP_PREFERENCES.has(mode)) {
      return mode
    }
    return 'use-global'
  }

  function getToolPreference(gatewayId: string, toolName: string): AgentDcmToolDisplayPreference {
    const key = buildToolKey(gatewayId, toolName)
    const explicit = normalizedDcmDisplaySettings.toolDisplayPreferences?.[key]
    if (explicit && VALID_TOOL_PREFERENCES.has(explicit)) {
      return explicit
    }
    const mode = getToolMode(gatewayId, toolName)
    if (mode !== 'hidden' && VALID_TOOL_PREFERENCES.has(mode)) {
      return mode
    }
    return 'inherit'
  }

  function isGatewayEnabled(gatewayId: string): boolean {
    return defaultMCPGateways.includes(gatewayId)
  }

  function isGroupVisible(gatewayId: string, groupName: string): boolean {
    return getGroupMode(gatewayId, groupName) !== 'hidden'
  }

  function isToolVisible(gatewayId: string, toolName: string): boolean {
    return getToolMode(gatewayId, toolName) !== 'hidden'
  }

  function getGlobalGroupMode(gateway: DcmGatewayRow, groupName: string): DcmGroupDisplayMode {
    const mode = gateway.globalDefaults.groups[groupName]
    if (VALID_GLOBAL_GROUP_MODES.has(mode as DcmGroupDisplayMode)) {
      return mode as DcmGroupDisplayMode
    }
    return 'group+tools+hints'
  }

  function getGlobalToolMode(gateway: DcmGatewayRow, toolName: string): DcmToolDisplayMode {
    const mode = gateway.globalDefaults.tools[toolName]
    if (VALID_TOOL_MODES.has(mode as DcmToolDisplayMode)) {
      return mode as DcmToolDisplayMode
    }
    return 'inherit'
  }

  function buildCliGatewayRow(): DcmGatewayRow {
    return {
      id: CLI_TOOL_GRID_ID,
      name: CLI_TOOL_GRID_GROUP_NAME,
      iconRef: DEFAULT_CLI_TOOL_ICON_REF,
      globalDefaults: globalCliToolGridSettings.dcmDisplayDefaults,
      groups: []
    }
  }

  function isCliToolVisible(toolId: string): boolean {
    return effectiveCliToolIdSet.has(toolId)
  }

  function handleCliToolVisibilityToggle(toolId: string, visible: boolean) {
    const next = new Set(effectiveCliToolIds)
    if (visible) {
      next.add(toolId)
    } else {
      next.delete(toolId)
    }
    onCliToolIdsChange(Array.from(next).sort((left, right) => left.localeCompare(right)))
  }

  function resolveEffectiveGroupMode(
    gateway: DcmGatewayRow,
    groupName: string,
    agentGroupMode: AgentDcmGroupDisplayMode
  ): DcmGroupDisplayMode {
    if (agentGroupMode === 'use-global') {
      return getGlobalGroupMode(gateway, groupName)
    }
    if (VALID_GLOBAL_GROUP_MODES.has(agentGroupMode as DcmGroupDisplayMode)) {
      return agentGroupMode as DcmGroupDisplayMode
    }
    return 'group+tools+hints'
  }

  function updateDcmDisplaySettings(
    mutate: (next: AgentDcmDisplaySettings) => void
  ) {
    const next = cloneDcmDisplaySettings(normalizedDcmDisplaySettings)
    mutate(next)
    onDcmDisplaySettingsChange(next)
  }

  function handleGroupModeChange(
    gatewayId: string,
    groupName: string,
    value: string
  ) {
    if (!value || !VALID_GROUP_PREFERENCES.has(value as AgentDcmGroupDisplayPreference)) return

    const key = buildGroupKey(gatewayId, groupName)
    const mode = value as AgentDcmGroupDisplayPreference

    updateDcmDisplaySettings((next) => {
      next.groupDisplayPreferences = { ...(next.groupDisplayPreferences ?? {}) }
      next.groupDisplayPreferences[key] = mode
      if (mode === 'use-global') {
        delete next.groups[key]
      } else {
        next.groups[key] = mode
      }
    })
  }

  function handleToolModeChange(
    gatewayId: string,
    toolName: string,
    value: string
  ) {
    if (!value || !VALID_TOOL_PREFERENCES.has(value as AgentDcmToolDisplayPreference)) return

    const key = buildToolKey(gatewayId, toolName)
    const mode = value as AgentDcmToolDisplayPreference

    updateDcmDisplaySettings((next) => {
      next.toolDisplayPreferences = { ...(next.toolDisplayPreferences ?? {}) }
      next.toolDisplayPreferences[key] = mode
      if (mode === 'inherit') {
        delete next.tools[key]
      } else {
        next.tools[key] = mode
      }
    })
  }

  function handleGatewayToggle(gatewayId: string, checked: boolean) {
    const nextGateways = new Set(defaultMCPGateways)
    if (checked) {
      nextGateways.add(gatewayId)
    } else {
      nextGateways.delete(gatewayId)
    }
    onGatewaysChange(Array.from(nextGateways))
  }

  function handleGroupVisibilityToggle(gatewayId: string, groupName: string, visible: boolean) {
    const key = buildGroupKey(gatewayId, groupName)
    updateDcmDisplaySettings((next) => {
      next.groupDisplayPreferences = { ...(next.groupDisplayPreferences ?? {}) }
      const currentMode = next.groups[key]
      if (visible) {
        const restoreMode = next.groupDisplayPreferences[key] ?? 'use-global'
        if (restoreMode === 'use-global') {
          delete next.groups[key]
        } else {
          next.groups[key] = restoreMode
        }
      } else {
        if (currentMode && currentMode !== 'hidden') {
          next.groupDisplayPreferences[key] = currentMode
        } else if (!next.groupDisplayPreferences[key]) {
          next.groupDisplayPreferences[key] = 'use-global'
        }
        next.groups[key] = 'hidden'
      }
    })

    if (!visible && openNestedAccordionItemKey === key) {
      openNestedAccordionItemKey = null
    }
  }

  function handleToolVisibilityToggle(gatewayId: string, toolName: string, visible: boolean) {
    const key = buildToolKey(gatewayId, toolName)
    updateDcmDisplaySettings((next) => {
      next.toolDisplayPreferences = { ...(next.toolDisplayPreferences ?? {}) }
      const currentMode = next.tools[key]
      if (visible) {
        const restoreMode = next.toolDisplayPreferences[key] ?? 'inherit'
        if (restoreMode === 'inherit') {
          delete next.tools[key]
        } else {
          next.tools[key] = restoreMode
        }
      } else {
        if (currentMode && currentMode !== 'hidden') {
          next.toolDisplayPreferences[key] = currentMode
        } else if (!next.toolDisplayPreferences[key]) {
          next.toolDisplayPreferences[key] = 'inherit'
        }
        next.tools[key] = 'hidden'
      }
    })
  }

  function getToolDisableReason(
    gatewayEnabled: boolean,
    groupMode: DcmGroupDisplayMode
  ): string | null {
    if (!dynamicMcpEnabled) return 'Dynamic MCP disabled'
    if (!gatewayEnabled) return 'Gateway is hidden'
    if (groupMode === 'hidden' || groupMode === 'group-only') return 'Group mode hides tools'
    return null
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

  function getGroupModeLabel(value: AgentDcmGroupDisplayPreference): string {
    return GROUP_DISPLAY_OPTIONS.find((option) => option.value === value)?.label ?? 'Inherit Gateway Default'
  }

  function getToolModeLabel(value: AgentDcmToolDisplayPreference): string {
    return TOOL_DISPLAY_OPTIONS.find((option) => option.value === value)?.label ?? 'Inherit Group/Default'
  }

  function getZipPermissionLabel(value: string): string {
    if (value === 'enabled') return 'Enabled'
    if (value === 'disabled') return 'Disabled'
    return 'Use Global Default'
  }

  function getZipLayoutLabel(value: string): string {
    if (value === 'inline') return 'Inline'
    if (value === 'appended') return 'Appended (Recommended)'
    return 'Use Global Default'
  }

  function getZipNotesLabel(value: string): string {
    if (value === 'enabled') return 'Enabled'
    if (value === 'disabled') return 'Disabled'
    return 'Use Global Default'
  }

  function normalizeGroupIconMode(mode: DcmGroupDisplayMode): GroupIconMode {
    if (mode === 'group-only' || mode === 'hidden') return 'group-only'
    if (mode === 'group+tools+names') return 'group+tools+names'
    return 'group+tools+hints'
  }

  function normalizeToolIconMode(mode: DcmToolDisplayMode): ToolIconMode {
    return mode === 'name-only' ? 'name-only' : 'name+hint'
  }

  function getGroupIconModeForPreference(
    gateway: DcmGatewayRow,
    groupName: string,
    groupMode: AgentDcmGroupDisplayMode,
    preference: AgentDcmGroupDisplayPreference
  ): GroupIconMode {
    if (preference === 'use-global') {
      return normalizeGroupIconMode(resolveEffectiveGroupMode(gateway, groupName, groupMode))
    }
    return normalizeGroupIconMode(preference)
  }

  function getInheritedToolIconMode(
    groupMode: AgentDcmGroupDisplayMode,
    effectiveGroupMode: DcmGroupDisplayMode,
    globalToolMode: DcmToolDisplayMode
  ): ToolIconMode {
    if (
      groupMode === 'use-global' &&
      (globalToolMode === 'name-only' || globalToolMode === 'name+hint')
    ) {
      return normalizeToolIconMode(globalToolMode)
    }
    return effectiveGroupMode === 'group+tools+names' ? 'name-only' : 'name+hint'
  }

  function getToolIconModeForPreference(
    groupMode: AgentDcmGroupDisplayMode,
    effectiveGroupMode: DcmGroupDisplayMode,
    globalToolMode: DcmToolDisplayMode,
    preference: AgentDcmToolDisplayPreference
  ): ToolIconMode {
    if (preference === 'inherit') {
      return getInheritedToolIconMode(groupMode, effectiveGroupMode, globalToolMode)
    }
    return preference === 'name-only' ? 'name-only' : 'name+hint'
  }

  function getZipBehaviorIconMode(
    value: string | undefined,
    inheritedAutoZip: boolean | undefined,
    inheritedZipDisabled: boolean | undefined
  ): AutoZipIconMode {
    if (value === 'off') return 'off'
    if (value === 'enabled') return 'enabled'
    if (value === 'disabled') return 'disabled'
    if (inheritedZipDisabled === true) return 'off'
    return inheritedAutoZip === true ? 'enabled' : 'disabled'
  }

  function iconToneClass(isInherited: boolean): string {
    return isInherited ? 'text-zinc-400' : 'text-white'
  }

  function getGroupIconRef(group: DcmGroupRow): IconRef {
    return normalizeIconRef(group.iconRef, DEFAULT_MCP_GROUP_ICON_REF)
  }

  function getCliToolIconRef(tool: CliToolCatalogRow): IconRef {
    return normalizeIconRef(tool.iconRef, DEFAULT_CLI_TOOL_ICON_REF)
  }

  function inheritTriggerClass(isInherited: boolean): string {
    return isInherited ? 'is-inherited' : 'is-explicit'
  }

  function normalizeToolZipAutoZip(value: string | undefined): string {
    if (value === 'enabled' || value === 'disabled' || value === 'off') return value
    return ZIP_AUTO_INHERIT
  }

  function toSectionZipAutoValue(value: string | undefined): SectionZipAutoValue {
    if (value === 'enabled' || value === 'disabled' || value === 'off') return value
    return 'inherit'
  }

  function toPanelZipAutoValue(value: SectionZipAutoValue | undefined): string | undefined {
    if (value === undefined) return undefined
    return value === 'inherit' ? ZIP_AUTO_INHERIT : value
  }

  function getSectionNonMcpZipOverride(
    rowId: SharedNonMcpToolGridRowId
  ): SectionNonMcpZipOverrideSnapshot {
    const override = getNonMcpZipOverride(rowId)
    return {
      ...override,
      auto_zip: toSectionZipAutoValue(override.auto_zip),
      inherited_buffer_size: override.inherited_buffer_size ?? override.min_buffer,
      inherited_zip_threshold: override.inherited_zip_threshold ?? 0,
      inherited_auto_zip: override.inherited_auto_zip ?? false,
      inherited_zip_disabled: override.inherited_zip_disabled ?? false
    }
  }

  function updateSectionNonMcpZipOverride(
    rowId: SharedNonMcpToolGridRowId,
    patch: SectionNonMcpZipOverridePatch
  ) {
    onNonMcpZipOverrideChange(rowId, {
      ...patch,
      auto_zip: toPanelZipAutoValue(patch.auto_zip)
    })
  }

  function getInheritedNumberLabel(value: number | undefined): string {
    if (typeof value === 'number') return String(value)
    return ''
  }

  function getInheritedZipBehaviorLabel(
    autoZip: boolean | undefined,
    zipDisabled: boolean | undefined
  ): string {
    if (zipDisabled === true) return 'Off'
    return autoZip === true ? 'Auto' : 'Normal'
  }

  function isEffectiveAutoZipEnabled(
    value: string | undefined,
    inheritedAutoZip: boolean | undefined,
    inheritedZipDisabled: boolean | undefined
  ): boolean {
    const normalized = normalizeToolZipAutoZip(value)
    if (normalized === 'off') return false
    if (normalized === 'enabled') return true
    if (normalized === 'disabled') return false
    if (inheritedZipDisabled === true) return false
    return inheritedAutoZip === true
  }

  function isEffectiveZipDisabled(
    value: string | undefined,
    inheritedZipDisabled: boolean | undefined
  ): boolean {
    const normalized = normalizeToolZipAutoZip(value)
    if (normalized === 'off') return true
    if (normalized === ZIP_AUTO_INHERIT) return inheritedZipDisabled === true
    return false
  }

  function getZipBehaviorLabel(
    value: string | undefined,
    inheritedAutoZip: boolean | undefined,
    inheritedZipDisabled: boolean | undefined
  ): string {
    const normalized = normalizeToolZipAutoZip(value)
    if (normalized === ZIP_AUTO_INHERIT) {
      return `Inherit (${getInheritedZipBehaviorLabel(inheritedAutoZip, inheritedZipDisabled)})`
    }
    if (normalized === 'enabled') return 'Auto'
    if (normalized === 'off') return 'Off'
    return 'Normal'
  }

  function buildPreviewSignature() {
    return JSON.stringify({
      agentId,
      defaultMCPGateways,
      defaultMCPToolSelections,
      effectiveCliToolIds,
      nativeDynamicMcpEnabled,
      nativeCliToolsEnabled,
      dcmDisplaySettings: normalizedDcmDisplaySettings,
      isCodexMode
    })
  }

  function buildDcmCatalogSignature() {
    return JSON.stringify({
      userId,
      mcpRenderNonce
    })
  }

  async function loadPreview(signature: string) {
    if (!agentId) return

    previewLoading = true
    previewError = null

    try {
      const response = await fetch('/api/mcp/tools/dcm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          selectedGateways: defaultMCPGateways,
          toolSelections: defaultMCPToolSelections,
          selectedCliToolIds: effectiveCliToolIds,
          nativeDynamicMcpEnabled,
          nativeCliToolsEnabled,
          dcmDisplaySettings: normalizedDcmDisplaySettings,
          isCodexMode: isCodexMode === true
        })
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || 'Failed to load DCM preview')
      }

      const result = (await response.json()) as PreviewPayload
      if (previewSignature !== signature) return
      previewData = result
    } catch (error) {
      if (previewSignature !== signature) return
      previewError = error instanceof Error ? error.message : 'Failed to load DCM preview'
    } finally {
      if (previewSignature === signature) {
        previewLoading = false
      }
    }
  }

  async function loadDcmCatalog(signature: string) {
    if (!userId) return

    dcmCatalogLoading = true
    dcmCatalogError = null

    try {
      const settingsResponse = await fetch('/api/user/settings')
      if (!settingsResponse.ok) {
        throw new Error('Failed to load global Tool Grid defaults')
      }
      const settingsPayload = (await settingsResponse.json()) as {
        settings?: { global_tool_grid_settings?: { cli?: Record<string, unknown> } | null } | null
      }
      const nextGlobalCliSettings = normalizeCliToolGridSettings(
        settingsPayload?.settings?.global_tool_grid_settings?.cli ?? null
      )

      const gatewayResponse = await fetch('/api/mcp/gateways?enabled=true')
      if (!gatewayResponse.ok) {
        throw new Error('Failed to load MCP gateways')
      }

      const gatewayPayload = await gatewayResponse.json()
      const gateways = Array.isArray(gatewayPayload?.gateways)
        ? (gatewayPayload.gateways as MCPGateway[])
        : []

      const interactiveGateways = gateways
        .filter((gateway) => gateway.enabled && gateway.type !== 'n8n-mcp-client')
        .sort((left, right) => left.name.localeCompare(right.name))

      const gatewayRows = await Promise.all(
        interactiveGateways.map(async (gateway) => {
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
              globalDefaults: normalizeGatewayDcmDefaults(gateway.dcmDisplayDefaults),
              groups: resolveGatewayToolGroups(gateway, toolsPayload)
            }
          } catch (error) {
            console.warn(
              '[Agent MCP DCM Display] Failed to load tools for gateway:',
              gateway.id,
              error
            )
            return {
              id: gateway.id,
              name: gateway.name,
              iconRef: normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF),
              globalDefaults: createDefaultGatewayDcmDisplayDefaults(),
              groups: buildGatewayGroupsFromCache(gateway)
            }
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
      const nextCliToolCatalog = Array.isArray(cliToolsPayload.tools)
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

      if (dcmCatalogSignature !== signature) return
      globalCliToolGridSettings = nextGlobalCliSettings
      cliToolCatalog = nextCliToolCatalog
      dcmCatalog = gatewayRows
    } catch (error) {
      if (dcmCatalogSignature !== signature) return
      dcmCatalogError =
        error instanceof Error ? error.message : 'Failed to load DCM display controls'
    } finally {
      if (dcmCatalogSignature === signature) {
        dcmCatalogLoading = false
      }
    }
  }

  const debouncedLoadPreview = debounce(loadPreview, 350)
  const debouncedLoadDcmCatalog = debounce(loadDcmCatalog, 250)

  function refreshToolGridCatalog() {
    if (!userId) return
    const signature = `${buildDcmCatalogSignature()}::manual:${Date.now()}`
    dcmCatalogSignature = signature
    void loadDcmCatalog(signature)
  }

  $effect(() => {
    if (!previewOpen) return
    if (!agentId) return

    const signature = buildPreviewSignature()
    if (signature === previewSignature) return

    previewSignature = signature
    debouncedLoadPreview(signature)
  })

  $effect(() => {
    if (!userId) return

    const signature = buildDcmCatalogSignature()
    if (signature === dcmCatalogSignature) return

    dcmCatalogSignature = signature
    debouncedLoadDcmCatalog(signature)
  })

  function togglePreview() {
    previewOpen = !previewOpen
    if (!previewOpen) {
      previewError = null
    }
  }

  const tokenEstimates = $derived(previewData?.tokenEstimates ?? {})
  const previewCounts = $derived(previewData?.counts ?? {})
  const previewText = $derived(previewData?.text ?? '')
</script>

<SettingsAccordionCard
  name={accordionName}
  title={toolGridTitle}
  icon={Grid3X3}
  open={defaultOpen}
  collapsible={cardCollapsible}
  class={compactDropdownMode ? 'batshit-settings-tool-grid-dropdown-card' : ''}
  contentClass={compactDropdownMode ? 'batshit-settings-tool-grid-dropdown-content' : 'space-y-4'}
>
  {#if showCardHeader}
    {#snippet info()}
        <SettingsInfoMenu ariaLabel={`About ${toolGridTitle}`}>
          {toolGridInfoText}
        </SettingsInfoMenu>
    {/snippet}

    {#snippet actions()}
      <div class="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onclick={refreshToolGridCatalog} disabled={dcmCatalogLoading || !userId}>
          <RefreshCcw class={`${dcmCatalogLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        {#if showZipControls}
          <SettingsSaveStatus
            state={zipSaveError || zipValidationError ? 'error' : zipSaveState}
            error={zipSaveError ?? zipValidationError}
            savingLabel="Saving Tool Grid zip settings..."
            savedLabel="Saved"
            sticky={false}
          />
        {/if}
        <SettingsSaveStatus
          state={mcpSaveError ? 'error' : mcpSaveState}
          error={mcpSaveError}
          savingLabel="Saving Tool Grid settings..."
          savedLabel="Saved"
          sticky={false}
        />
      </div>
    {/snippet}
  {/if}
    {#if showGridIntroBlock && !showCardHeader}
      <div class="space-y-3 batshit-settings-muted-panel">
        <div class="flex items-center gap-1.5">
          <p class="batshit-settings-form-label">{toolGridTitle}</p>
          <SettingsInfoMenu ariaLabel={`About ${toolGridTitle}`}>
            {toolGridInfoText}
          </SettingsInfoMenu>
        </div>
      </div>
    {/if}

    {#if !dynamicMcpEnabled}
      <div class="batshit-settings-inline-alert is-warning">
        {#if isManagedPrimaryAgentType(agentType) && typeof nativeDynamicMcpEnabled === 'boolean'}
          Dynamic MCP is disabled for this agent. MCP rows stay read-only until you turn it on in Agent Settings <code>Batshit Tools</code>, but CLI tool rows can still be managed here.
        {:else if isManagedPrimaryAgentType(agentType) && isCodexMode}
          Dynamic MCP is disabled for this agent. MCP rows stay read-only until you turn it on in Agent Settings <code>Batshit Tools</code>, but CLI tool rows can still be managed here.
        {:else}
          Dynamic MCP is disabled for this agent. Enable the native Dynamic MCP toggle in Agent Settings to edit MCP discoverability controls; CLI tool rows can still be managed here.
        {/if}
      </div>
    {/if}

    {#if !cliToolsEnabled}
      <div class="batshit-settings-inline-alert is-warning">
        CLI Tools are disabled for this agent. CLI tool rows stay read-only until you turn them on in Agent Settings <code>Batshit Tools</code>.
      </div>
    {/if}

    {#if !showCardHeader && !compactDropdownMode}
      <div class="sticky top-2 z-[3] flex justify-end">
        <div class="flex max-w-full items-center justify-end gap-2">
          <Button variant="outline" size="sm" onclick={refreshToolGridCatalog} disabled={dcmCatalogLoading || !userId}>
            <RefreshCcw class={`${dcmCatalogLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {#if showZipControls}
            <SettingsSaveStatus
              state={zipSaveError || zipValidationError ? 'error' : zipSaveState}
              error={zipSaveError ?? zipValidationError}
              savingLabel="Saving Tool Grid zip settings..."
              savedLabel="Saved"
              sticky={false}
            />
          {/if}
          <SettingsSaveStatus
            state={mcpSaveError ? 'error' : mcpSaveState}
            error={mcpSaveError}
            savingLabel="Saving Tool Grid settings..."
            savedLabel="Saved"
            sticky={false}
          />
        </div>
      </div>
    {/if}

    {#if showZipModeControls}
      {#if showZipControls}
        <div class="grid gap-3 md:grid-cols-3">
          <label class="space-y-1">
            <span class="batshit-settings-form-label-line"><span class="batshit-settings-form-label">Zip Control Permissions</span>
              <SettingsInfoMenu ariaLabel="About Zip Control Permissions">
                Lets the AI request unzip or zip changes and save Tool Notes through Batshit's hidden zip-control block. Changes apply on the next user message.
                {#if isCodexMode}
                  CLI caution: Codex and Claude CLI already apply their own context-management behavior. Batshit ZCP adds another layer.
                {/if}
              </SettingsInfoMenu>
            </span>
            <Select.Root
              type="single"
              value={zipAgentControlEnabled}
              onValueChange={(value) => onZipAgentControlChange(value ?? ZIP_PERMISSION_INHERIT)}
            >
              <Select.Trigger
                class={`batshit-settings-select-compact w-full ${inheritTriggerClass(zipAgentControlEnabled === ZIP_PERMISSION_INHERIT)}`}
                size="sm"
              >
                {getZipPermissionLabel(zipAgentControlEnabled)}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={ZIP_PERMISSION_INHERIT} label="Use Global Default">
                  Use Global Default
                </Select.Item>
                <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
                <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
              </Select.Content>
            </Select.Root>
          </label>

          <label class="space-y-1">
            <span class="batshit-settings-form-label-line"><span class="batshit-settings-form-label">AI Zip Layout</span>
              <SettingsInfoMenu ariaLabel="About AI Zip Layout">
                Controls how unzipped content is delivered back to the AI. Inline expands content where the zip reference appears. Appended keeps the chat clean and adds an organized unzip index plus unzipped-content block at the end.
              </SettingsInfoMenu>
            </span>
            <Select.Root
              type="single"
              value={zipAiViewMode}
              onValueChange={(value) => onZipAiViewModeChange(value ?? ZIP_LAYOUT_INHERIT)}
            >
              <Select.Trigger
                class={`batshit-settings-select-compact w-full ${inheritTriggerClass(zipAiViewMode === ZIP_LAYOUT_INHERIT)}`}
                size="sm"
              >
                {getZipLayoutLabel(zipAiViewMode)}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={ZIP_LAYOUT_INHERIT} label="Use Global Default">
                  Use Global Default
                </Select.Item>
                <Select.Item value="inline" label="Inline">Inline</Select.Item>
                <Select.Item value="appended" label="Appended (Recommended)">Appended (Recommended)</Select.Item>
              </Select.Content>
            </Select.Root>
          </label>

          <label class="space-y-1">
            <span class="batshit-settings-form-label-line"><span class="batshit-settings-form-label">Tool Notes</span>
              <SettingsInfoMenu ariaLabel="About Tool Notes">
                Lets the AI save short summaries of important tool results so useful facts remain visible after raw tool output is zipped.
              </SettingsInfoMenu>
            </span>
            <Select.Root
              type="single"
              value={zipToolNotesEnabled}
              onValueChange={(value) => onZipToolNotesChange(value ?? ZIP_NOTES_INHERIT)}
            >
              <Select.Trigger
                class={`batshit-settings-select-compact w-full ${inheritTriggerClass(zipToolNotesEnabled === ZIP_NOTES_INHERIT)}`}
                size="sm"
              >
                {getZipNotesLabel(zipToolNotesEnabled)}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={ZIP_NOTES_INHERIT} label="Use Global Default">
                  Use Global Default
                </Select.Item>
                <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
                <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
              </Select.Content>
            </Select.Root>
          </label>
        </div>
      {:else}
        <div class="batshit-settings-inline-alert is-dashed">
          Zip overrides are managed by the native n8n AI Agent node for this agent type.
        </div>
      {/if}
    {/if}

    <div class={`batshit-settings-table-frame ${compactDropdownMode ? 'is-chatbar-tool-grid' : ''}`}>
      {#if compactDropdownMode && !showCardHeader}
        <Button
          variant="outline"
          size="icon"
          class="batshit-settings-tool-grid-refresh-button"
          onclick={refreshToolGridCatalog}
          disabled={dcmCatalogLoading || !userId}
          aria-label="Refresh Tool Grid"
          title="Refresh Tool Grid"
        >
          <RefreshCcw class={`${dcmCatalogLoading ? 'animate-spin' : ''}`} />
        </Button>
      {/if}
      <table class={toolGridTableClass}>
        <colgroup>
          <col class={toolGridItemColumnClass} />
          <col class="w-[100px]" />
          <col class="w-[100px]" />
          {#if showZipControls}
            <col class="w-[100px]" />
            <col class="w-[100px]" />
            <col class="w-[100px]" />
          {/if}
        </colgroup>
        <thead class="batshit-settings-table-head">
          <tr>
            <th class="batshit-settings-table-head-cell">Item</th>
            <th class="batshit-settings-table-head-cell">Discoverable</th>
            <th class="batshit-settings-table-head-cell">Display Detail</th>
            {#if showZipControls}
              <th class="batshit-settings-table-head-cell">Zip Buffer</th>
              <th class="batshit-settings-table-head-cell">Zip Threshold</th>
              <th class="batshit-settings-table-head-cell">Zip Behavior</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#if (dcmCatalogLoading && !hasToolGridRows) || initialCompactCatalogLoad}
            <tr class="batshit-settings-table-row">
              <td colspan={columnCount} class="batshit-settings-table-cell is-empty">
                <div class="batshit-settings-caption flex items-center gap-2">
                  <Loader2 class="h-3 w-3 animate-spin" />
                  Loading MCP and CLI tool rows...
                </div>
              </td>
            </tr>
          {:else if dcmCatalogError}
            <tr class="batshit-settings-table-row">
              <td colspan={columnCount} class="batshit-settings-table-cell is-empty">
                <div class="batshit-settings-inline-alert is-danger">
                  {dcmCatalogError}
                </div>
              </td>
            </tr>
          {:else}
            {#if !dcmCatalogLoading && dcmCatalog.length === 0 && cliToolCatalog.length === 0 && !hasToolGridRows}
              <tr class="batshit-settings-table-row">
                <td colspan={columnCount} class="batshit-settings-table-cell is-muted is-empty">
                  No Tool Grid rows discovered yet. Enable gateways or add CLI tools, then refresh tool discovery.
                </td>
              </tr>
            {/if}

            {#if showZipControls && batshitNonMcpRows.length > 0}
              <NonMcpZipRowsSection
                sectionKey={BATSHIT_ROWS_KEY}
                title="Batshit Tools"
                sectionIconRef={TOOL_GRID_BATSHIT_SECTION_ICON_REF}
                typeLabel="Batshit Tool"
                rowIds={getNonMcpRowIds(batshitNonMcpRows)}
                rowConfig={nonMcpRowConfig}
                open={openTopLevelAccordionItemKey === BATSHIT_ROWS_KEY}
                {topLevelAccordionRowClass}
                tableClass={toolGridTableClass}
                firstColumnClass={toolGridItemColumnClass}
                otherColumnClass="w-[100px]"
                getRowOverride={getSectionNonMcpZipOverride}
                onUpdateRowOverride={updateSectionNonMcpZipOverride}
                onHeaderClick={handleTopLevelHeaderClick}
                onToggle={toggleTopLevelAccordionItem}
                showBulkZipApply
                bulkZipApplyLabel="Batshit Tools"
              />
            {/if}

            {#if cliToolCatalog.length > 0}
              {@const cliGateway = buildCliGatewayRow()}
              {@const cliGroupName = CLI_TOOL_GRID_GROUP_NAME}
              {@const cliGroupKey = buildGroupKey(CLI_TOOL_GRID_ID, cliGroupName)}
              {@const cliRowKey = CLI_TOOL_GRID_ID}
              {@const cliGroupMode = getGroupMode(CLI_TOOL_GRID_ID, cliGroupName)}
              {@const cliGroupPreference = getGroupPreference(CLI_TOOL_GRID_ID, cliGroupName)}
              {@const cliGroupVisible = isGroupVisible(CLI_TOOL_GRID_ID, cliGroupName)}
              {@const cliEffectiveGroupMode = resolveEffectiveGroupMode(cliGateway, cliGroupName, cliGroupMode)}
              {@const cliGroupExpanded = openTopLevelAccordionItemKey === cliRowKey}
              {@const cliGroupIconMode = getGroupIconModeForPreference(
                cliGateway,
                cliGroupName,
                cliGroupMode,
                cliGroupPreference
              )}
              <Collapsible.Root open={cliGroupExpanded}>
                <tr
                  class={`${topLevelAccordionRowClass} cursor-pointer ${!cliToolsEnabled ? 'opacity-60' : ''}`}
                  onclick={(event) => handleTopLevelHeaderClick(event, cliRowKey)}
                >
                  <td class="batshit-settings-table-cell is-strong">
                    <div class="batshit-settings-tool-grid-label">
                      <ToolGridIdentityIcon
                        ref={DEFAULT_CLI_TOOL_ICON_REF}
                        typeLabel="Tool Group"
                        name={cliGroupName}
                      />
                      <span class="batshit-settings-tool-grid-name block truncate" title={cliGroupName}>{cliGroupName}</span>
                    </div>
                  </td>
                  <td class="batshit-settings-table-cell">
                    <Switch.Root
                      checked={cliGroupVisible}
                    disabled={!cliToolsEnabled}
                    onCheckedChange={(checked) =>
                        {
                          const nextVisible = checked === true
                          handleGroupVisibilityToggle(CLI_TOOL_GRID_ID, cliGroupName, nextVisible)
                          if (!nextVisible && openTopLevelAccordionItemKey === cliRowKey) {
                            openTopLevelAccordionItemKey = null
                          }
                        }}
                  />
                  </td>
                  <td class="batshit-settings-table-cell">
                    <div class={`flex items-center gap-2 ${showZipControls ? '' : 'justify-between'}`}>
                      {#if cliGroupVisible}
                        <Select.Root
                          type="single"
                          value={cliGroupPreference}
                          disabled={!cliToolsEnabled}
                          onValueChange={(value) =>
                            value && handleGroupModeChange(CLI_TOOL_GRID_ID, cliGroupName, value)}
                        >
                          <Select.Trigger
                            class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(cliGroupPreference === 'use-global')}`}
                            size="sm"
                            title={getGroupModeLabel(cliGroupPreference)}
                          >
                            <span class="inline-flex h-4 w-4 items-center justify-center">
                              {#if cliGroupIconMode === 'group-only'}
                                <Zap class={`h-3.5 w-3.5 ${iconToneClass(cliGroupPreference === 'use-global')}`} />
                              {:else if cliGroupIconMode === 'group+tools+names'}
                                <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(cliGroupPreference === 'use-global')}`} />
                              {:else}
                                <Signal class={`h-3.5 w-3.5 ${iconToneClass(cliGroupPreference === 'use-global')}`} />
                              {/if}
                            </span>
                            <span class="sr-only">{getGroupModeLabel(cliGroupPreference)}</span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each GROUP_DISPLAY_OPTIONS as option}
                              {@const optionIconMode = option.value === 'use-global'
                                ? getGroupIconModeForPreference(cliGateway, cliGroupName, cliGroupMode, option.value)
                                : normalizeGroupIconMode(option.value)}
                              <Select.Item value={option.value} label={option.label}>
                                <span class="flex items-center gap-2">
                                  <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                    {#if optionIconMode === 'group-only'}
                                      <Zap class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'use-global')}`} />
                                    {:else if optionIconMode === 'group+tools+names'}
                                      <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'use-global')}`} />
                                    {:else}
                                      <Signal class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'use-global')}`} />
                                    {/if}
                                  </span>
                                  <span>{option.label}</span>
                                </span>
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      {/if}
                      {#if !showZipControls}
                        <Collapsible.Trigger
                          class="ml-auto flex items-center justify-end shrink-0"
                          aria-expanded={cliGroupExpanded}
                          aria-label={`Toggle CLI tools for ${cliGroupName}`}
                          onclick={() => toggleTopLevelAccordionItem(cliRowKey)}
                        >
                          <ChevronDown class={`h-3.5 w-3.5 transition-transform ${cliGroupExpanded ? 'rotate-180' : ''}`} />
                        </Collapsible.Trigger>
                      {/if}
                    </div>
                  </td>
                  {#if showZipControls}
                    <td class="batshit-settings-table-cell">
                      <input
                        type="number"
                        min="1"
                        class="batshit-settings-grid-input batshit-settings-tool-grid-bulk-input"
                        value={getBulkZipDraft(cliRowKey).buffer_size}
                        placeholder="All"
                        aria-label={`Zip buffer to apply to ${cliGroupName}`}
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
                          aria-label={`Zip threshold to apply to ${cliGroupName}`}
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
                          aria-label={`Apply zip buffer and threshold to ${cliGroupName}`}
                          title={`Apply zip buffer and threshold to ${cliGroupName}`}
                          onclick={() => applyBulkZipToTools(cliRowKey, getCliToolIds())}
                        >
                          <Check class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                    <td class="batshit-settings-table-cell">
                      <div class="batshit-settings-tool-grid-row-actions">
                        <SettingsInfoMenu
                          ariaLabel={`About applying zip numbers to ${cliGroupName}`}
                          side="left"
                          align="end"
                          class="batshit-settings-tool-grid-bulk-info"
                          contentClass="w-72"
                        >
                          Enter a Zip Buffer, Zip Threshold, or both, then press the check to copy
                          those numbers to every CLI tool row for this agent. Blank fields stay
                          unchanged, and Zip Behavior stays unchanged.
                        </SettingsInfoMenu>
                        <Collapsible.Trigger
                          class="ml-auto flex items-center justify-end"
                          aria-expanded={cliGroupExpanded}
                          aria-label={`Toggle CLI tools for ${cliGroupName}`}
                          onclick={() => toggleTopLevelAccordionItem(cliRowKey)}
                        >
                          <ChevronDown class={`h-3.5 w-3.5 transition-transform ${cliGroupExpanded ? 'rotate-180' : ''}`} />
                        </Collapsible.Trigger>
                      </div>
                    </td>
                  {/if}
                </tr>

                <tr class="batshit-settings-table-row is-flush">
                  <td colspan={columnCount} class="batshit-settings-table-cell is-flush">
                    <Collapsible.Content class="overflow-hidden">
                      <table class={toolGridTableClass}>
                        <colgroup>
                          <col class={toolGridItemColumnClass} />
                          <col class="w-[100px]" />
                          <col class="w-[100px]" />
                          {#if showZipControls}
                            <col class="w-[100px]" />
                            <col class="w-[100px]" />
                            <col class="w-[100px]" />
                          {/if}
                        </colgroup>
                        <tbody>
                          {#each cliToolCatalog as tool (tool.toolId)}
                            {@const toolVisible = isCliToolVisible(tool.toolId)}
                            {@const toolPreference = getToolPreference(CLI_TOOL_GRID_ID, tool.toolId)}
                            {@const toolMode = getToolMode(CLI_TOOL_GRID_ID, tool.toolId)}
                            {@const globalToolMode = getGlobalToolMode(cliGateway, tool.toolId)}
                            {@const toolZipOverride = getToolZipOverride(tool.toolId)}
                            {@const toolAutoZip = normalizeToolZipAutoZip(toolZipOverride.auto_zip)}
                            {@const toolAutoZipIconMode = getZipBehaviorIconMode(toolAutoZip, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                            {@const toolAutoZipActive = isEffectiveAutoZipEnabled(toolZipOverride.auto_zip, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                            {@const toolZipDisabled = isEffectiveZipDisabled(toolZipOverride.auto_zip, toolZipOverride.inherited_zip_disabled)}
                            {@const toolZipInputsDisabled = toolAutoZipActive || toolZipDisabled}
                            {@const toolZipBehaviorLabel = getZipBehaviorLabel(toolAutoZip, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                            {@const disableReason = !cliToolsEnabled
                              ? 'CLI Tools disabled'
                              : cliEffectiveGroupMode === 'hidden' || cliEffectiveGroupMode === 'group-only'
                                ? 'Group mode hides tools'
                                : null}
                            {@const toolIconMode = getToolIconModeForPreference(
                              cliGroupMode,
                              cliEffectiveGroupMode,
                              globalToolMode,
                              toolPreference
                            )}
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
                                  {#if disableReason}
                                    <span class="shrink-0 batshit-settings-pill">
                                      {disableReason}
                                    </span>
                                  {:else if toolVisible && toolMode === 'inherit'}
                                    <span
                                      class="shrink-0 batshit-settings-pill"
                                      title={cliGroupMode === 'use-global'
                                        ? `Global: ${globalToolMode === 'inherit' ? 'group default' : globalToolMode}`
                                        : 'Group default'}
                                    >
                                      {cliGroupMode === 'use-global'
                                        ? 'Global'
                                        : 'Group'}
                                    </span>
                                  {/if}
                                </div>
                              </td>
                              <td class="batshit-settings-table-cell">
                                <Switch.Root
                                  checked={toolVisible}
                                  disabled={Boolean(disableReason)}
                                  onCheckedChange={(checked) =>
                                    handleCliToolVisibilityToggle(tool.toolId, checked === true)}
                                />
                              </td>
                              <td class="batshit-settings-table-cell">
                                {#if !disableReason}
                                  <Select.Root
                                    type="single"
                                    value={toolPreference}
                                    disabled={Boolean(disableReason)}
                                    onValueChange={(value) =>
                                      value && handleToolModeChange(CLI_TOOL_GRID_ID, tool.toolId, value)}
                                  >
                                    <Select.Trigger
                                      class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(toolPreference === 'inherit')}`}
                                      size="sm"
                                      title={getToolModeLabel(toolPreference)}
                                    >
                                      <span class="inline-flex h-4 w-4 items-center justify-center">
                                        {#if toolIconMode === 'name-only'}
                                          <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(toolPreference === 'inherit')}`} />
                                        {:else}
                                          <Signal class={`h-3.5 w-3.5 ${iconToneClass(toolPreference === 'inherit')}`} />
                                        {/if}
                                      </span>
                                      <span class="sr-only">{getToolModeLabel(toolPreference)}</span>
                                    </Select.Trigger>
                                    <Select.Content>
                                      {#each TOOL_DISPLAY_OPTIONS as option}
                                        {@const optionIconMode = option.value === 'inherit'
                                          ? getInheritedToolIconMode(cliGroupMode, cliEffectiveGroupMode, globalToolMode)
                                          : option.value === 'name-only'
                                            ? 'name-only'
                                            : 'name+hint'}
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
                              {#if showZipControls}
                                <td class="batshit-settings-table-cell">
                                  <input
                                    type={toolZipInputsDisabled ? 'text' : 'number'}
                                    min="1"
                                    class="batshit-settings-grid-input"
                                    value={toolZipInputsDisabled ? '-' : toolZipOverride.buffer_size}
                                    placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZipOverride.inherited_buffer_size)}
                                    disabled={toolZipInputsDisabled}
                                    oninput={(event) =>
                                      onToolZipOverrideChange(tool.toolId, {
                                        buffer_size: normalizeZipBufferInput(event, 1)
                                      })}
                                  />
                                </td>
                                <td class="batshit-settings-table-cell">
                                  <input
                                    type={toolZipInputsDisabled ? 'text' : 'number'}
                                    min="0"
                                    class="batshit-settings-grid-input"
                                    value={toolZipInputsDisabled ? '-' : toolZipOverride.zip_threshold}
                                    placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZipOverride.inherited_zip_threshold)}
                                    disabled={toolZipInputsDisabled}
                                    oninput={(event) =>
                                      onToolZipOverrideChange(tool.toolId, {
                                        zip_threshold: (event.currentTarget as HTMLInputElement).value
                                      })}
                                  />
                                </td>
                                <td class="batshit-settings-table-cell">
                                  <Select.Root
                                    type="single"
                                    value={toolAutoZip}
                                    onValueChange={(value) =>
                                      onToolZipOverrideChange(tool.toolId, {
                                        auto_zip: value ?? ZIP_AUTO_INHERIT
                                      })}
                                  >
                                    <Select.Trigger
                                      class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(toolAutoZip === ZIP_AUTO_INHERIT)}`}
                                      size="sm"
                                      title={toolZipBehaviorLabel}
                                    >
                                      <span class="inline-flex h-4 w-4 items-center justify-center">
                                        {#if toolAutoZipIconMode === 'off'}
                                          <Infinity class={`h-3.5 w-3.5 ${iconToneClass(toolAutoZip === ZIP_AUTO_INHERIT)}`} />
          {:else if toolAutoZipIconMode === 'enabled'}
            <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(toolAutoZip === ZIP_AUTO_INHERIT)}`} />
          {:else}
            <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(toolAutoZip === ZIP_AUTO_INHERIT)}`} />
          {/if}
                                      </span>
                                      <span class="sr-only">
                                        {toolZipBehaviorLabel}
                                      </span>
                                    </Select.Trigger>
                                    <Select.Content>
                                      <Select.Item
                                        value={ZIP_AUTO_INHERIT}
                                        label={getZipBehaviorLabel(ZIP_AUTO_INHERIT, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                                      >
                                        <span class="flex items-center gap-2">
                                          <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                            {#if toolAutoZipIconMode === 'off'}
                                              <Infinity class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                              {:else if toolAutoZipIconMode === 'enabled'}
                                                <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                              {:else}
                                                <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                              {/if}
                                          </span>
                                          <span>Inherit ({getInheritedZipBehaviorLabel(toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)})</span>
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
                              {/if}
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                    </Collapsible.Content>
                  </td>
                </tr>
              </Collapsible.Root>
            {/if}

            {#each dcmCatalog as gateway}
              {@const gatewayEnabled = isGatewayEnabled(gateway.id)}
              {@const sourceKey = buildSourceKey(gateway.id)}
              {@const sourceExpanded = openTopLevelAccordionItemKey === sourceKey}
              <Collapsible.Root open={sourceExpanded}>
                <tr
                  class={`${topLevelAccordionRowClass} cursor-pointer ${!dynamicMcpEnabled ? 'opacity-60' : ''}`}
                  onclick={(event) => handleTopLevelHeaderClick(event, sourceKey)}
                >
                  <td class="batshit-settings-table-cell is-strong">
                    <div class="batshit-settings-tool-grid-label">
                      <ToolGridIdentityIcon
                        ref={gateway.iconRef}
                        typeLabel="MCP Source"
                        name={gateway.name}
                      />
                      <span class="batshit-settings-tool-grid-name block truncate" title={`MCP Source: ${gateway.name}`}>
                        {gateway.name}
                      </span>
                    </div>
                  </td>
                  <td class="batshit-settings-table-cell">
                    <Switch.Root
                      checked={gatewayEnabled}
                      disabled={!dynamicMcpEnabled}
                      onCheckedChange={(checked) => handleGatewayToggle(gateway.id, checked === true)}
                    />
                  </td>
                  <td class="batshit-settings-table-cell">
                    {#if !showZipControls}
                      <div class="flex justify-end">
                        <Collapsible.Trigger
                          class="flex items-center justify-end shrink-0"
                          aria-expanded={sourceExpanded}
                          aria-label={`Toggle groups for MCP Source ${gateway.name}`}
                          onclick={() => toggleTopLevelAccordionItem(sourceKey)}
                        >
                          <ChevronDown class={`h-3.5 w-3.5 transition-transform ${sourceExpanded ? 'rotate-180' : ''}`} />
                        </Collapsible.Trigger>
                      </div>
                    {/if}
                  </td>
                  {#if showZipControls}
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
                  {/if}
                </tr>

                <tr class="batshit-settings-table-row is-flush">
                  <td colspan={columnCount} class="batshit-settings-table-cell is-flush">
                    <Collapsible.Content class="overflow-hidden">
                      <table class={toolGridTableClass}>
                        <colgroup>
                          <col class={toolGridItemColumnClass} />
                          <col class="w-[100px]" />
                          <col class="w-[100px]" />
                          {#if showZipControls}
                            <col class="w-[100px]" />
                            <col class="w-[100px]" />
                            <col class="w-[100px]" />
                          {/if}
                        </colgroup>
                        <tbody>
                          {#if gateway.groups.length === 0}
                            <tr class="batshit-settings-table-row">
                              <td colspan={columnCount} class="batshit-settings-table-cell is-muted is-empty is-nested">
                                No groups discovered in this MCP Source.
                              </td>
                            </tr>
                          {/if}

                          {#each gateway.groups as group}
                            {@const groupKey = buildGroupKey(gateway.id, group.name)}
                            {@const groupMode = getGroupMode(gateway.id, group.name)}
                            {@const groupVisible = isGroupVisible(gateway.id, group.name)}
                            {@const groupPreference = getGroupPreference(gateway.id, group.name)}
                            {@const effectiveGroupMode = resolveEffectiveGroupMode(gateway, group.name, groupMode)}
                            {@const groupToggleDisabled = !dynamicMcpEnabled || !gatewayEnabled}
                            {@const groupExpanded = openNestedAccordionItemKey === groupKey}
                            {@const groupIconMode = getGroupIconModeForPreference(
                              gateway,
                              group.name,
                              groupMode,
                              groupPreference
                            )}
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
                                    onCheckedChange={(checked) =>
                                      handleGroupVisibilityToggle(gateway.id, group.name, checked === true)}
                                  />
                                </td>
                                <td class="batshit-settings-table-cell">
                                  <div class={`flex items-center gap-2 ${showZipControls ? '' : 'justify-between'}`}>
                                    {#if groupVisible}
                                      <Select.Root
                                        type="single"
                                        value={groupPreference}
                                        disabled={groupToggleDisabled}
                                        onValueChange={(value) =>
                                          value && handleGroupModeChange(gateway.id, group.name, value)}
                                      >
                                        <Select.Trigger
                                          class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(groupPreference === 'use-global')}`}
                                          size="sm"
                                          title={getGroupModeLabel(groupPreference)}
                                        >
                                          <span class="inline-flex h-4 w-4 items-center justify-center">
                                            {#if groupIconMode === 'group-only'}
                                              <Zap class={`h-3.5 w-3.5 ${iconToneClass(groupPreference === 'use-global')}`} />
                                            {:else if groupIconMode === 'group+tools+names'}
                                              <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(groupPreference === 'use-global')}`} />
                                            {:else}
                                              <Signal class={`h-3.5 w-3.5 ${iconToneClass(groupPreference === 'use-global')}`} />
                                            {/if}
                                          </span>
                                          <span class="sr-only">{getGroupModeLabel(groupPreference)}</span>
                                        </Select.Trigger>
                                        <Select.Content>
                                          {#each GROUP_DISPLAY_OPTIONS as option}
                                            {@const optionIconMode = option.value === 'use-global'
                                              ? getGroupIconModeForPreference(gateway, group.name, groupMode, option.value)
                                              : normalizeGroupIconMode(option.value)}
                                            <Select.Item value={option.value} label={option.label}>
                                              <span class="flex items-center gap-2">
                                                <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                                  {#if optionIconMode === 'group-only'}
                                                    <Zap class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'use-global')}`} />
                                                  {:else if optionIconMode === 'group+tools+names'}
                                                    <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'use-global')}`} />
                                                  {:else}
                                                    <Signal class={`h-3.5 w-3.5 ${iconToneClass(option.value === 'use-global')}`} />
                                                  {/if}
                                                </span>
                                                <span>{option.label}</span>
                                              </span>
                                            </Select.Item>
                                          {/each}
                                        </Select.Content>
                                      </Select.Root>
                                    {/if}
                                    {#if !showZipControls}
                                      <Collapsible.Trigger
                                        class="ml-auto flex items-center justify-end shrink-0"
                                        aria-expanded={groupExpanded}
                                        aria-label={`Toggle tools for group ${group.name}`}
                                        onclick={() => toggleNestedAccordionItem(groupKey)}
                                      >
                                        <ChevronDown class={`h-3.5 w-3.5 transition-transform ${groupExpanded ? 'rotate-180' : ''}`} />
                                      </Collapsible.Trigger>
                                    {/if}
                                  </div>
                                </td>
                                {#if showZipControls}
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
                                        group for this agent. Blank fields stay unchanged, and Zip
                                        Behavior stays unchanged.
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
                                {/if}
                              </tr>

                              <tr class="batshit-settings-table-row is-flush">
                                <td colspan={columnCount} class="batshit-settings-table-cell is-flush">
                                  <Collapsible.Content class="overflow-hidden">
                                    <table class={toolGridTableClass}>
                                      <colgroup>
                                        <col class={toolGridItemColumnClass} />
                                        <col class="w-[100px]" />
                                        <col class="w-[100px]" />
                                        {#if showZipControls}
                                          <col class="w-[100px]" />
                                          <col class="w-[100px]" />
                                          <col class="w-[100px]" />
                                        {/if}
                                      </colgroup>
                                      <tbody>
                                        {#each group.tools as tool (tool.id)}
                                          {@const toolVisible = isToolVisible(gateway.id, tool.id)}
                                          {@const toolPreference = getToolPreference(gateway.id, tool.id)}
                                          {@const toolMode = getToolMode(gateway.id, tool.id)}
                                          {@const globalToolMode = getGlobalToolMode(gateway, tool.id)}
                                          {@const toolZipOverride = getToolZipOverride(tool.id)}
                                          {@const toolAutoZip = normalizeToolZipAutoZip(toolZipOverride.auto_zip)}
                                          {@const toolAutoZipIconMode = getZipBehaviorIconMode(toolAutoZip, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                                          {@const toolAutoZipActive = isEffectiveAutoZipEnabled(toolZipOverride.auto_zip, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                                          {@const toolZipDisabled = isEffectiveZipDisabled(toolZipOverride.auto_zip, toolZipOverride.inherited_zip_disabled)}
                                          {@const toolZipInputsDisabled = toolAutoZipActive || toolZipDisabled}
                                          {@const toolZipBehaviorLabel = getZipBehaviorLabel(toolAutoZip, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                                          {@const disableReason = getToolDisableReason(gatewayEnabled, effectiveGroupMode)}
                                          {@const toolToggleDisabled = Boolean(disableReason)}
                                          {@const toolIconMode = getToolIconModeForPreference(
                                            groupMode,
                                            effectiveGroupMode,
                                            globalToolMode,
                                            toolPreference
                                          )}
                                          <tr class="batshit-settings-table-row is-l3">
                                            <td class="batshit-settings-table-cell is-muted is-nested">
                                              <div class="flex min-w-0 items-center gap-2">
                                                <span class="batshit-settings-tool-grid-name min-w-0 truncate font-mono text-[11px]" title={tool.name}>
                                                  {tool.name}
                                                </span>
                                                {#if disableReason}
                                                  <span class="shrink-0 batshit-settings-pill">
                                                    {disableReason}
                                                  </span>
                                                {:else if toolVisible && toolMode === 'inherit'}
                                                  <span
                                                    class="shrink-0 batshit-settings-pill"
                                                    title={groupMode === 'use-global'
                                                      ? `Global: ${globalToolMode === 'inherit' ? 'group default' : globalToolMode}`
                                                      : 'Group default'}
                                                  >
                                                    {groupMode === 'use-global'
                                                      ? 'Global'
                                                      : 'Group'}
                                                  </span>
                                                {/if}
                                              </div>
                                            </td>
                                            <td class="batshit-settings-table-cell">
                                              <Switch.Root
                                                checked={toolVisible}
                                                disabled={toolToggleDisabled}
                                                onCheckedChange={(checked) =>
                                                  handleToolVisibilityToggle(gateway.id, tool.id, checked === true)}
                                              />
                                            </td>
                                            <td class="batshit-settings-table-cell">
                                              {#if toolVisible}
                                                <Select.Root
                                                  type="single"
                                                  value={toolPreference}
                                                  disabled={toolToggleDisabled}
                                                  onValueChange={(value) =>
                                                    value && handleToolModeChange(gateway.id, tool.id, value)}
                                                >
                                                  <Select.Trigger
                                                    class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(toolPreference === 'inherit')}`}
                                                    size="sm"
                                                    title={getToolModeLabel(toolPreference)}
                                                  >
                                                    <span class="inline-flex h-4 w-4 items-center justify-center">
                                                      {#if toolIconMode === 'name-only'}
                                                        <SignalMedium class={`h-3.5 w-3.5 ${iconToneClass(toolPreference === 'inherit')}`} />
                                                      {:else}
                                                        <Signal class={`h-3.5 w-3.5 ${iconToneClass(toolPreference === 'inherit')}`} />
                                                      {/if}
                                                    </span>
                                                    <span class="sr-only">{getToolModeLabel(toolPreference)}</span>
                                                  </Select.Trigger>
                                                  <Select.Content>
                                                    {#each TOOL_DISPLAY_OPTIONS as option}
                                                      {@const optionIconMode = option.value === 'inherit'
                                                        ? getInheritedToolIconMode(groupMode, effectiveGroupMode, globalToolMode)
                                                        : option.value === 'name-only'
                                                          ? 'name-only'
                                                          : 'name+hint'}
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
                                            {#if showZipControls}
                                              <td class="batshit-settings-table-cell">
                                                <input
                                                  type={toolZipInputsDisabled ? 'text' : 'number'}
                                                  min="1"
                                                  class="batshit-settings-grid-input"
                                                  value={toolZipInputsDisabled ? '-' : toolZipOverride.buffer_size}
                                                  placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZipOverride.inherited_buffer_size)}
                                                  disabled={toolZipInputsDisabled}
                                                  oninput={(event) =>
                                                    onToolZipOverrideChange(tool.id, {
                                                      buffer_size: normalizeZipBufferInput(event, 1)
                                                    })}
                                                />
                                              </td>
                                              <td class="batshit-settings-table-cell">
                                                <input
                                                  type={toolZipInputsDisabled ? 'text' : 'number'}
                                                  min="0"
                                                  class="batshit-settings-grid-input"
                                                  value={toolZipInputsDisabled ? '-' : toolZipOverride.zip_threshold}
                                                  placeholder={toolZipInputsDisabled ? '-' : getInheritedNumberLabel(toolZipOverride.inherited_zip_threshold)}
                                                  disabled={toolZipInputsDisabled}
                                                  oninput={(event) =>
                                                    onToolZipOverrideChange(tool.id, {
                                                      zip_threshold: (event.currentTarget as HTMLInputElement).value
                                                    })}
                                                />
                                              </td>
                                              <td class="batshit-settings-table-cell">
                                                <Select.Root
                                                  type="single"
                                                  value={toolAutoZip}
                                                  onValueChange={(value) =>
                                                    onToolZipOverrideChange(tool.id, {
                                                      auto_zip: value ?? ZIP_AUTO_INHERIT
                                                    })}
                                                >
                                                  <Select.Trigger
                                                    class={`batshit-settings-grid-select-trigger ${inheritTriggerClass(toolAutoZip === ZIP_AUTO_INHERIT)}`}
                                                    size="sm"
                                                    title={toolZipBehaviorLabel}
                                                  >
                                                    <span class="inline-flex h-4 w-4 items-center justify-center">
                                                      {#if toolAutoZipIconMode === 'off'}
                                                        <Infinity class={`h-3.5 w-3.5 ${iconToneClass(toolAutoZip === ZIP_AUTO_INHERIT)}`} />
                                                      {:else if toolAutoZipIconMode === 'enabled'}
                                                        <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(toolAutoZip === ZIP_AUTO_INHERIT)}`} />
                                                      {:else}
                                                        <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(toolAutoZip === ZIP_AUTO_INHERIT)}`} />
                                                      {/if}
                                                    </span>
                                                    <span class="sr-only">
                                                      {toolZipBehaviorLabel}
                                                    </span>
                                                  </Select.Trigger>
                                                  <Select.Content>
                                                    <Select.Item
                                                      value={ZIP_AUTO_INHERIT}
                                                      label={getZipBehaviorLabel(ZIP_AUTO_INHERIT, toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)}
                                                    >
                                                      <span class="flex items-center gap-2">
                                                        <span class="inline-flex h-4 w-4 items-center justify-center shrink-0">
                                                          {#if toolAutoZipIconMode === 'off'}
                                                            <Infinity class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                                          {:else if toolAutoZipIconMode === 'enabled'}
                                                            <BatshitIcon id="zip" class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                                          {:else}
                                                            <Clock3 class={`h-3.5 w-3.5 ${iconToneClass(true)}`} />
                                                          {/if}
                                                        </span>
                                                        <span>Inherit ({getInheritedZipBehaviorLabel(toolZipOverride.inherited_auto_zip, toolZipOverride.inherited_zip_disabled)})</span>
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
                                            {/if}
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

            {#if showZipControls && otherNonMcpRows.length > 0}
              <NonMcpZipRowsSection
                sectionKey={OTHER_ROWS_KEY}
                title="Other"
                sectionIconRef={TOOL_GRID_OTHER_SECTION_ICON_REF}
                typeLabel="Other Tool"
                rowIds={getNonMcpRowIds(otherNonMcpRows)}
                rowConfig={nonMcpRowConfig}
                open={openTopLevelAccordionItemKey === OTHER_ROWS_KEY}
                {topLevelAccordionRowClass}
                tableClass={toolGridTableClass}
                firstColumnClass={toolGridItemColumnClass}
                otherColumnClass="w-[100px]"
                getRowOverride={getSectionNonMcpZipOverride}
                onUpdateRowOverride={updateSectionNonMcpZipOverride}
                onHeaderClick={handleTopLevelHeaderClick}
                onToggle={toggleTopLevelAccordionItem}
                showBulkZipApply
                bulkZipApplyLabel="Other"
                flattenSingleRow
              />
            {/if}
          {/if}
        </tbody>
      </table>
    </div>

    {#if showPostTableControls}
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onclick={onResetToGlobalSettings}>
          <RotateCcw aria-hidden="true" />
          Reset to global settings
        </Button>
        <Button
          variant="ghost"
          size="sm"

          onclick={togglePreview}
          disabled={!agentId}
        >
          <Eye  />
          {previewOpen ? 'Hide DCM preview' : 'Preview Tool DCM'}
        </Button>
        <div class="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {#if showZipControls}
            <SettingsSaveStatus
              state={zipSaveError || zipValidationError ? 'error' : zipSaveState}
              error={zipSaveError ?? zipValidationError}
              savingLabel="Saving Tool Grid zip settings..."
              savedLabel="Saved"
              sticky={false}
            />
          {/if}
          <SettingsSaveStatus
            state={mcpSaveError ? 'error' : mcpSaveState}
            error={mcpSaveError}
            savingLabel="Saving Tool Grid settings..."
            savedLabel="Saved"
            sticky={false}
          />
        </div>
      </div>

      {#if previewOpen}
        <div class="batshit-settings-muted-panel space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="batshit-settings-form-label">Tool DCM preview</div>
            {#if previewLoading}
              <div class="batshit-settings-caption flex items-center gap-2">
                <Loader2 class="h-3 w-3 animate-spin" />
                Loading...
              </div>
            {/if}
          </div>

          {#if !agentId}
            <div class="batshit-settings-form-label">Select an agent to preview Tool Grid output.</div>
          {:else if previewError}
            <div class="batshit-settings-inline-alert is-danger">
              {previewError}
            </div>
          {:else if previewLoading}
            <div class="batshit-settings-form-label">Loading preview...</div>
          {:else if previewData}
            <div class="space-y-3 text-xs text-muted-foreground">
              <div class="flex flex-wrap gap-3">
                <span>Enabled tools: {previewCounts.enabledTools ?? 0}</span>
                <span>DCM tools: {previewCounts.dcmTools ?? 0}</span>
                <span>Available tools: {previewCounts.availableTools ?? 0}</span>
              </div>
              <div class="flex flex-wrap gap-3">
                <span>Enabled tokens: {tokenEstimates.enabled ?? 0}</span>
                <span>DCM tokens: {tokenEstimates.dcm ?? 0}</span>
                <span>Total Tool DCM footprint: {tokenEstimates.total ?? 0}</span>
              </div>

              <pre class="whitespace-pre-wrap text-xs text-foreground">{previewText || 'No discoverable tools left to list.'}</pre>

              <div class="batshit-settings-muted-panel">
                This preview shows what the Tool Grid will surface in the DCM for this agent after
                gateway/group/tool discoverability filters and display-detail rules are applied.
              </div>
              <div class="batshit-settings-muted-panel">
                Preview updates are based on the agent’s current MCP and CLI discoverability plus
                display-detail settings. Inherited/default large groups may collapse, while explicit
                group display choices are shown as selected.
              </div>
            </div>
          {:else}
            <div class="batshit-settings-form-label">No preview data available.</div>
          {/if}
        </div>
      {/if}
    {/if}
</SettingsAccordionCard>
