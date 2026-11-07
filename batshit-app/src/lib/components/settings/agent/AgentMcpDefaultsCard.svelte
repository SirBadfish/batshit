<script lang="ts">
  import { cliGroupEnablePatch, assertCliGlobalSettingsRead } from '$lib/utils/cliToolGridEnable'
  import ToolGridEnableCell, { type ToolGridEnableControl } from '$lib/components/tools/ToolGridEnableCell.svelte'
  import BrokerFamilyDiscoverabilityCells from '$lib/components/tools/BrokerFamilyDiscoverabilityCells.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import ToolGridSection from '$lib/components/mcps/ToolGridSection.svelte'
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
  import { getUserSettings, getUserSettingsReadState } from '$lib/stores/userSettings.svelte'
  import { LIVE_FILE_READS_HELP, LIVE_FILE_READS_LABEL, resolveLiveFileReadsEnabled, resolveZipAiViewModeOf } from '$lib/utils/liveFileReads'
  import { resolveZipToolNotesEnabled } from '$lib/utils/replyControl'
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
	    ARTIFACT_TOOL_GRID_GROUP_NAME,
	    ARTIFACT_TOOL_GRID_ID,
	    ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS,
	    createDefaultArtifactToolGridSettings,
	    createDefaultFabricToolGridSettings,
	    FABRIC_TOOL_GRID_GROUP_NAME,
	    FABRIC_TOOL_GRID_DISPLAY_NAME,
	    FABRIC_TOOL_GRID_ID,
	    FABRIC_TOOL_GRID_INFO_PARAGRAPHS,
	    normalizeArtifactToolGridSettings,
	    normalizeFabricToolGridSettings,
	    TOOL_GRID_ARTIFACT_ICON_REF,
	    TOOL_GRID_FABRIC_ICON_REF
	  } from '$lib/utils/toolGridBrokerFamilies'
	  import {
    resolveBrokerFamilies,
    resolveBrokerToolToggles,
    type ToolHostScope
  } from '$lib/utils/brokerAvailability'
	  import BrokerFamilyToolGridRow from '$lib/components/tools/BrokerFamilyToolGridRow.svelte'
  import type { BrokerFamilyRowControls } from '$lib/components/tools/brokerFamilyRowControls'
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
    apiUtilityProjection?: 'registered' | 'unprepared' | 'not-applicable'
    text?: string
    tokenEstimates?: PreviewTokenEstimates
    counts?: PreviewCounts
    hintBudget?: {
      limit: number
      budgetedTokens: number
      featureTokens: number
    }
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
    subjectKind?: 'primary' | 'subagent'
    toolHostScope?: ToolHostScope
    userId?: string | null
    defaultMCPGateways: string[]
    defaultMCPToolSelections: MCPToolSelections
    defaultCliToolIds?: string[] | null
    cliToolIdsExplicit?: boolean
    dcmDisplaySettings: AgentDcmDisplaySettings
    mcpSaveState: 'idle' | 'saving' | 'saved'
    enableSaveState?: 'idle' | 'saving' | 'saved'
    enableSaveError?: string | null
    mcpSaveError?: string | null
    mcpLastSaved?: Date | null
    mcpRenderNonce: number
    nativeDynamicMcpEnabled?: boolean | null
    nativeCliToolsEnabled?: boolean | null
    /**
     * The agent's native-tool settings object. SA-096 P3 reads the remaining broker
     * toggles from it through the shared resolver instead of adding one prop per toggle,
     * so the grid's idea of a reachable family cannot drift from registration's.
     */
    nativeToolSettings?: Record<string, unknown> | null
    discoveryReadOnly?: boolean
    getEnableControl?: (id: SharedNonMcpToolGridRowId | 'mcp_tools' | 'cli_tools') => ToolGridEnableControl | null
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
    zipAiViewMode?: string
    zipToolNotesEnabled?: string
    /** SA-137 P4a: this agent's own Refreshed File Reads choice ('__inherit__', 'enabled' or 'disabled'). */
    liveFileReads?: string
    /**
     * Round 2 (R2-2): why Refreshed File Reads cannot run for this agent now
     * (`refreshedFileReadsUnavailableReason`), or null. The switch shows as unavailable with this
     * sentence; the saved choice is never changed or saved because of it.
     */
    liveFileReadsUnavailableReason?: string | null
    /** Draw that reason in the warning tone: the setting resolves ON, is unavailable, and the check is done. */
    liveFileReadsWarn?: boolean
    /** A plain note under the switch that does not lock it (the host could not be read). */
    liveFileReadsNote?: string | null
    nonMcpZipRows?: NonMcpZipRow[]
    getNonMcpZipOverride: (rowId: string) => NonMcpZipOverrideSnapshot
    onNonMcpZipOverrideChange: (rowId: string, patch: NonMcpZipOverridePatch) => void
    onZipAiViewModeChange: (value: string) => void
    onZipToolNotesChange?: (value: string) => void
    onLiveFileReadsChange?: (value: string) => void
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
    subjectKind,
    toolHostScope = 'api',
    userId = null,
    defaultMCPGateways = [],
    defaultMCPToolSelections = [],
    defaultCliToolIds = [],
    cliToolIdsExplicit = true,
    dcmDisplaySettings = { version: 1, groups: {}, tools: {} },
    mcpSaveState = 'idle',
    enableSaveState = 'idle',
    enableSaveError = null,
    mcpSaveError = null,
    mcpLastSaved = null,
    mcpRenderNonce = 0,
    nativeDynamicMcpEnabled = null,
    nativeCliToolsEnabled = null,
    nativeToolSettings = null,
    discoveryReadOnly = false,
    getEnableControl = () => null,
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
    zipAiViewMode = '__inherit__',
    zipToolNotesEnabled = '__inherit__',
    liveFileReads = '__inherit__',
    liveFileReadsUnavailableReason = null,
    liveFileReadsWarn = false,
    liveFileReadsNote = null,
    nonMcpZipRows = [],
    getNonMcpZipOverride = () => ({
      buffer_size: '',
      zip_threshold: '',
      auto_zip: '__inherit__',
      min_buffer: 2
    }),
    onNonMcpZipOverrideChange = () => {},
    onZipAiViewModeChange = () => {},
    onZipToolNotesChange = () => {},
    onLiveFileReadsChange = () => {},
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
  // SA-129 DL-06 (BL-1484): no select for the zip control permission here. The parked permission
  // reads only a hidden experiment key that no Settings form reads or writes; the startup sweep
  // removes the retired keys.
  const ZIP_LAYOUT_INHERIT = '__inherit__'
  const ZIP_NOTES_INHERIT = '__inherit__'
  const LIVE_READS_INHERIT = '__inherit__'
  // The reason and the note are the switch's description for assistive technology; ids are per
  // mounted card, so two cards on a page never share one.
  const uid = $props.id()
  const liveReadsReasonId = `${uid}-live-reads-reason`
  const liveReadsNoteId = `${uid}-live-reads-note`
  const liveReadsDescribedBy = $derived(
    [liveFileReadsUnavailableReason ? liveReadsReasonId : null, liveFileReadsNote ? liveReadsNoteId : null]
      .filter(Boolean)
      .join(' ') || undefined
  )
  // SA-137 P4a: Refreshed File Reads refresh an API Primary agent's open Read File results; a Subagent's
  // delegated run and a CLI agent never do, so only an API Primary agent gets the control.
  const showLiveFileReads = $derived(subjectKind === 'primary' && toolHostScope === 'api')

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
  let previewOwnerIdentity = ''
  let previewOwnerGeneration = 0

  let dcmCatalogLoading = $state(false)
  let dcmCatalogError = $state<string | null>(null)
  let dcmCatalog = $state<DcmGatewayRow[]>([])
  let cliToolCatalog = $state<CliToolCatalogRow[]>([])
  let globalCliSettingsReady = $state(false)
  let globalCliToolGridSettings = $state(createDefaultCliToolGridSettings())
  let globalFabricToolGridSettings = $state(createDefaultFabricToolGridSettings())
  let globalArtifactToolGridSettings = $state(createDefaultArtifactToolGridSettings())
  let dcmCatalogSignature = $state<string | null>(null)
  let openTopLevelAccordionItemKey = $state<string | null>(null)
  let openSourceAccordionItemKey = $state<string | null>(null)
  let openNestedAccordionItemKey = $state<string | null>(null)
  let bulkZipDrafts = $state<Record<string, BulkZipDraft>>({})

  const topLevelAccordionRowClass = 'batshit-settings-accordion-row'
  const nestedAccordionRowClass = 'batshit-settings-accordion-row is-nested'
  const BATSHIT_ROWS_KEY = '__batshit_tool_rows__'
  const MCP_ROWS_KEY = '__mcp_tool_rows__'
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

  // SA-096 P3: which broker families this agent can actually reach. Derived from the one
  // shared rule set, never restated here, so the grid cannot offer a row for a family the
  // broker would refuse on this runtime.
  const brokerRuntime = $derived(toolHostScope)
  const brokerFamilies = $derived.by(() =>
    resolveBrokerFamilies({
      runtime: brokerRuntime,
      toggles: {
        ...resolveBrokerToolToggles(nativeToolSettings),
        dynamicMcpEnabled,
        cliToolsEnabled
      },
      hasCliTools: effectiveCliToolIds.length > 0
    })
  )
  const fabricFamilyEnabled = $derived(brokerFamilies.includes('fabric') || brokerFamilies.includes('batshit'))
  const artifactFamilyEnabled = $derived(brokerFamilies.includes('artifact'))

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

  const batshitNonMcpRows = $derived.by(() => {
    const rows = nonMcpZipRows.filter((row) => batshitRowIdSet.has(row.id))
    return getEnableControl('typed_file_tools') ? [{ ...SHARED_NON_MCP_TOOL_GRID_CONFIG.typed_file_tools }, ...rows] : rows
  })

  const otherNonMcpRows = $derived.by(() =>
    nonMcpZipRows.filter((row) => otherRowIdSet.has(row.id))
  )
  const hasToolGridRows = $derived(
    getEnableControl('bash') !== null || dcmCatalog.length > 0 ||
      cliToolCatalog.length > 0 ||
      fabricFamilyEnabled ||
      artifactFamilyEnabled ||
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
      ? 'Configure discoverability, display-detail preferences, and zip behavior in one grid for MCP tools, CLI tools, and zip-enabled rows. Discoverability and display-detail settings control the tool index in Agent Setup. Zip columns set per-row overrides, blank fields inherit defaults, and these controls do not execute tools directly. Chat Bar toggles use the same saved state, and hiding rows does not erase the last display-detail preference.'
      : 'Configure discoverability and display-detail preferences in one grid for MCP tools and CLI tools. These controls affect the tool index in Agent Setup and which tools the current agent or subagent can discover. Hiding rows does not erase the last display-detail preference.'
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

  // SA-096 P3: Fabric and Artifact use the same synthetic-gateway shape as CLI Tools, so
  // every resolution helper below is the shared one. Nothing family-specific is decided here.
  function buildBrokerFamilyGatewayRow(
    gatewayId: string,
    groupName: string,
    iconRef: IconRef,
    globalDefaults: GatewayDcmDisplaySettings
  ): DcmGatewayRow {
    return { id: gatewayId, name: groupName, iconRef, globalDefaults, groups: [] }
  }

  function brokerFamilyOptionIconMode(
    gateway: DcmGatewayRow,
    groupName: string,
    optionValue: string
  ): GroupIconMode {
    return optionValue === 'use-global'
      ? getGroupIconModeForPreference(
          gateway,
          groupName,
          getGroupMode(gateway.id, groupName),
          optionValue as AgentDcmGroupDisplayPreference
        )
      : normalizeGroupIconMode(optionValue as DcmGroupDisplayMode)
  }

  /**
   * SA-096: one description of a broker family's Discoverable + Display Detail controls,
   * used by both placements — the `Fabric & Utilities` / `Artifact Tools` rows inside the
   * `Batshit Tools` accordion where zip columns exist, and the standalone top-level row
   * on the discoverability-only surfaces. Building it once is what keeps a family from
   * ever rendering twice with two behaviors.
   */
  function buildBrokerFamilyControls(
    gatewayId: string,
    groupName: string,
    iconRef: IconRef,
    globalDefaults: GatewayDcmDisplaySettings,
    infoParagraphs: string[],
    displayName: string = groupName
  ): BrokerFamilyRowControls {
    const gateway = buildBrokerFamilyGatewayRow(gatewayId, groupName, iconRef, globalDefaults)
    const preference = getGroupPreference(gatewayId, groupName)

    return {
      label: displayName,
      disabled: discoveryReadOnly,
      iconRef,
      visible: isGroupVisible(gatewayId, groupName),
      value: preference,
      iconMode: getGroupIconModeForPreference(
        gateway,
        groupName,
        getGroupMode(gatewayId, groupName),
        preference
      ),
      options: GROUP_DISPLAY_OPTIONS,
      optionIconMode: (value) => brokerFamilyOptionIconMode(gateway, groupName, value),
      modeLabel: (value) => getGroupModeLabel(value as AgentDcmGroupDisplayPreference),
      infoParagraphs: [
        ...infoParagraphs,
        'The Agent Tool Grid Enable choice controls Artifact tools. Display Detail chooses the group, names or input hints. Artifact access and permission checks still apply.'
      ],
      triggerClass: (value) => inheritTriggerClass(value === 'use-global'),
      toneClass: (value) => iconToneClass(value === 'use-global'),
      onVisibleChange: (visible) => handleGroupVisibilityToggle(gatewayId, groupName, visible),
      onModeChange: (value) => handleGroupModeChange(gatewayId, groupName, value)
    }
  }

  function getFabricFamilyControls(): BrokerFamilyRowControls {
    return buildBrokerFamilyControls(
      FABRIC_TOOL_GRID_ID,
      FABRIC_TOOL_GRID_GROUP_NAME,
      TOOL_GRID_FABRIC_ICON_REF,
      globalFabricToolGridSettings.dcmDisplayDefaults,
      FABRIC_TOOL_GRID_INFO_PARAGRAPHS,
      FABRIC_TOOL_GRID_DISPLAY_NAME
    )
  }

  function getArtifactFamilyControls(): BrokerFamilyRowControls {
    return buildBrokerFamilyControls(
      ARTIFACT_TOOL_GRID_ID,
      ARTIFACT_TOOL_GRID_GROUP_NAME,
      TOOL_GRID_ARTIFACT_ICON_REF,
      globalArtifactToolGridSettings.dcmDisplayDefaults,
      ARTIFACT_TOOL_GRID_INFO_PARAGRAPHS
    )
  }

  /**
   * Maps the two `Batshit Tools` zip rows that are also broker families onto their
   * controls. Every other row, and any family this agent cannot reach, returns null so
   * those two columns stay empty.
   */
  function getBrokerFamilyControlsForRow(
    rowId: SharedNonMcpToolGridRowId
  ): BrokerFamilyRowControls | null {
    if (rowId === 'fabric_find') return null
    if (rowId === 'artifact_find') {
      return artifactFamilyEnabled || getEnableControl('artifact_find') ? { ...getArtifactFamilyControls(), visible: true } : null
    }
    return null
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
    if (discoveryReadOnly) return 'Read the saved CLI Tools choice before editing discovery.'
    if (!dynamicMcpEnabled) return 'Dynamic MCP disabled'
    if (!gatewayEnabled) return 'Gateway is hidden'
    if (groupMode === 'hidden' || groupMode === 'group-only') return 'Group mode hides tools'
    return null
  }

  function toggleTopLevelAccordionItem(itemKey: string) {
    openTopLevelAccordionItemKey =
      openTopLevelAccordionItemKey === itemKey ? null : itemKey
    openSourceAccordionItemKey = null
    openNestedAccordionItemKey = null
  }

  function toggleSourceAccordionItem(itemKey: string) {
    openSourceAccordionItemKey = openSourceAccordionItemKey === itemKey ? null : itemKey
    openNestedAccordionItemKey = null
  }

  function handleSourceHeaderClick(event: MouseEvent, itemKey: string) {
    if (!isInteractiveHeaderElement(event.target)) toggleSourceAccordionItem(itemKey)
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

  function getZipLayoutLabel(value: string): string {
    if (value === 'inline') return 'Inline'
    if (value === 'appended') return 'Appended (Recommended)'
    if (getUserSettingsReadState() !== 'confirmed') return 'Use Global Default'
    return `Use Global Default (${resolveZipAiViewModeOf(null, getUserSettings()?.global_zip_settings) === 'inline' ? 'Inline' : 'Appended'})`
  }

  function getZipNotesLabel(value: string): string {
    if (value === 'enabled') return 'Enabled (Recommended)'
    if (value === 'disabled') return 'Disabled'
    if (getUserSettingsReadState() !== 'confirmed') return 'Use Global Default'
    return `Use Global Default (${resolveZipToolNotesEnabled(null, getUserSettings()?.global_zip_settings) ? 'Enabled' : 'Disabled'})`
  }

  function getLiveFileReadsLabel(value: string): string {
    if (value === 'enabled') return 'Enabled'
    if (value === 'disabled') return 'Disabled'
    if (getUserSettingsReadState() !== 'confirmed') return 'Use Global Default'
    return `Use Global Default (${resolveLiveFileReadsEnabled(null, getUserSettings()?.global_zip_settings) ? 'Enabled' : 'Disabled'})`
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
    const settingsReadState = getUserSettingsReadState()
    const admin = settingsReadState === 'confirmed' ? getUserSettings()?.admin_settings : null
    return JSON.stringify({
      userId,
      agentId,
      subjectKind: subjectKind ?? null,
      defaultMCPGateways,
      defaultMCPToolSelections,
      effectiveCliToolIds,
      nativeDynamicMcpEnabled,
      nativeCliToolsEnabled,
      dcmDisplaySettings: normalizedDcmDisplaySettings,
      brokerRuntime,
      // A confirmed Admin save refreshes the preview without touching the Tool Grid draft.
      // A value-only or failed initial read cannot certify default hint settings.
      adminHintSettings: settingsReadState === 'confirmed' ? {
        readState: settingsReadState,
        requiredLimit: admin?.dcm_schema_hint_required_limit ?? null,
        optionalLimit: admin?.dcm_schema_hint_optional_limit ?? null,
        maxChars: admin?.dcm_schema_hint_max_chars ?? null,
        toolNameThreshold: admin?.dcm_tool_name_threshold ?? null,
        totalTokens: admin?.dcm_schema_hint_total_tokens ?? null
      } : { readState: settingsReadState }
    })
  }

  function buildDcmCatalogSignature() {
    return JSON.stringify({
      userId,
      mcpRenderNonce
    })
  }

  async function loadPreview(signature: string) {
    if (!agentId || buildPreviewSignature() !== signature) return
    const ownerGeneration = previewOwnerGeneration
    const isCurrent = () => previewOwnerGeneration === ownerGeneration &&
      previewSignature === signature && buildPreviewSignature() === signature

    previewLoading = true
    previewError = null

    try {
      const response = await fetch('/api/mcp/tools/dcm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          subjectKind,
          selectedGateways: defaultMCPGateways,
          toolSelections: defaultMCPToolSelections,
          selectedCliToolIds: effectiveCliToolIds,
          nativeDynamicMcpEnabled,
          nativeCliToolsEnabled,
          dcmDisplaySettings: normalizedDcmDisplaySettings,
          // SA-096 P4: the preview has to use this agent's own broker rules, otherwise it
          // shows a Fabric or Artifact group the agent's runtime would never serve.
          runtime: brokerRuntime
        })
      })

      if (!response.ok) {
        const text = await response.text()
        let message = text
        try {
          const failure = JSON.parse(text)
          if (typeof failure?.error === 'string') message = failure.error
        } catch {
          // Non-JSON failures keep their existing readable response text.
        }
        throw new Error(message || 'Failed to load Agent Setup tool preview')
      }

      const result = (await response.json()) as PreviewPayload
      if (!isCurrent()) return
      previewData = result
    } catch (error) {
      if (!isCurrent()) return
      previewError = error instanceof Error ? error.message : 'Failed to load Agent Setup tool preview'
    } finally {
      if (isCurrent()) {
        previewLoading = false
      }
    }
  }

  async function loadDcmCatalog(signature: string) {
    if (!userId) return

    dcmCatalogLoading = true
    dcmCatalogError = null
    globalCliSettingsReady = false

    try {
      const settingsResponse = await fetch('/api/user/settings')
      if (!settingsResponse.ok) {
        throw new Error('Failed to load global Tool Grid defaults')
      }
      const settingsPayload = (await settingsResponse.json()) as {
        settings?: {
          global_tool_grid_settings?: {
            cli?: Record<string, unknown>
            fabric?: Record<string, unknown>
            artifact?: Record<string, unknown>
          } | null
        } | null
      }
      assertCliGlobalSettingsRead(settingsPayload)
      const nextGlobalCliSettings = normalizeCliToolGridSettings(
        settingsPayload?.settings?.global_tool_grid_settings?.cli ?? null
      )
      const nextGlobalFabricSettings = normalizeFabricToolGridSettings(
        settingsPayload?.settings?.global_tool_grid_settings?.fabric ?? null
      )
      const nextGlobalArtifactSettings = normalizeArtifactToolGridSettings(
        settingsPayload?.settings?.global_tool_grid_settings?.artifact ?? null
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
      globalCliSettingsReady = true
      globalCliToolGridSettings = nextGlobalCliSettings
      globalFabricToolGridSettings = nextGlobalFabricSettings
      globalArtifactToolGridSettings = nextGlobalArtifactSettings
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
    const identity = JSON.stringify([userId, agentId, subjectKind ?? null])
    if (identity === previewOwnerIdentity) return
    previewOwnerIdentity = identity
    previewOwnerGeneration += 1
    previewSignature = null
    previewData = null
    previewError = null
    previewLoading = false
  })

  $effect(() => {
    if (!previewOpen) return
    if (!agentId) return

    const signature = buildPreviewSignature()
    if (signature === previewSignature) return

    previewSignature = signature
    previewData = null
    previewError = null
    previewLoading = true
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
  const previewHintBudget = $derived.by(() => {
    const budget = previewData?.hintBudget
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return null
    return Number.isFinite(budget.limit) && budget.limit > 0 &&
      Number.isFinite(budget.budgetedTokens) && budget.budgetedTokens >= 0 &&
      Number.isFinite(budget.featureTokens) && budget.featureTokens >= 0
      ? budget
      : null
  })
</script>

{#snippet independentEnableRows(showDisplay: boolean, includeSections = false)}

              {#each ['bash', 'typed_file_tools', 'web_search', 'agent_browser_actions', 'artifact_find', 'fabric_find', ...(includeSections ? ['mcp_tools', 'cli_tools'] : [])] as id}
                {@const rowId = id as SharedNonMcpToolGridRowId}
                {@const config = id === 'mcp_tools' ? { label: 'MCP Tools', iconRef: { kind: 'brand', slug: 'mcp-mono' } as IconRef } : id === 'cli_tools' ? { label: 'CLI Tools', iconRef: DEFAULT_CLI_TOOL_ICON_REF } : nonMcpRowConfig[rowId]}
                {@const enable = getEnableControl(id as SharedNonMcpToolGridRowId | 'mcp_tools' | 'cli_tools')}
                {#if enable}
                  <tr class={topLevelAccordionRowClass}>
                    <td class="batshit-settings-table-cell is-strong is-nested">
                      <div class="batshit-settings-tool-grid-label">
                        <ToolGridIdentityIcon ref={config.iconRef} typeLabel="Batshit Tool" name={config.label} />
                        <span class="batshit-settings-tool-grid-name block truncate">{config.label}</span>
                        {#if subjectKind === 'subagent' && rowId === 'fabric_find' && enable.notice}
                          <SettingsInfoMenu ariaLabel={`About ${config.label}`} contentClass="w-80"><p>{enable.notice}</p></SettingsInfoMenu>
                        {/if}
                      </div>
                    </td>
                    <ToolGridEnableCell control={id === 'cli_tools' && dcmCatalogError ? { ...enable, disabled: enable.disabled || !enable.checked, notice: [enable.notice, 'Read global CLI Tools defaults before enabling.'].filter(Boolean).join(' ') } : subjectKind === 'subagent' && rowId === 'fabric_find' ? { ...enable, notice: null } : enable} label={config.label} />
                    {#if showDisplay && rowId === 'artifact_find'}<BrokerFamilyDiscoverabilityCells controls={{ ...getArtifactFamilyControls(), visible: true }} showDiscoverable={false} />
                    {:else}<td class="batshit-settings-table-cell"></td>{/if}
                  </tr>
                {/if}
              {/each}

{/snippet}

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
        {#if enableSaveState !== 'idle' || enableSaveError}
          <SettingsSaveStatus state={enableSaveError ? 'error' : enableSaveState} error={enableSaveError}
            savingLabel="Saving tool choices..." savedLabel="Tool choices saved" sticky={false} />
        {/if}
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
        MCP Tools are disabled for this agent. Enable MCP Tools in the agent's Tool Grid to edit MCP discovery.
      </div>
    {/if}

    {#if !cliToolsEnabled}
      <div class="batshit-settings-inline-alert is-warning">
        CLI Tools are disabled for this agent. Enable CLI Tools in the agent's Tool Grid to edit CLI discovery.
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
                <Select.Item value={ZIP_LAYOUT_INHERIT} label={getZipLayoutLabel(ZIP_LAYOUT_INHERIT)}>
                  {getZipLayoutLabel(ZIP_LAYOUT_INHERIT)}
                </Select.Item>
                <Select.Item value="inline" label="Inline">Inline</Select.Item>
                <Select.Item value="appended" label="Appended (Recommended)">Appended (Recommended)</Select.Item>
              </Select.Content>
            </Select.Root>
          </label>

          <label class="space-y-1">
            <span class="batshit-settings-form-label-line"><span class="batshit-settings-form-label">Tool Notes</span>
              <SettingsInfoMenu ariaLabel="About Tool Notes">
                Lets the agent save short notes about important tool results, so the facts it needs stay in view after the full result is compressed and it reads files again less. Recommended.
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
                <Select.Item value={ZIP_NOTES_INHERIT} label={getZipNotesLabel(ZIP_NOTES_INHERIT)}>
                  {getZipNotesLabel(ZIP_NOTES_INHERIT)}
                </Select.Item>
                <Select.Item value="enabled" label="Enabled (Recommended)">Enabled (Recommended)</Select.Item>
                <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
              </Select.Content>
            </Select.Root>
          </label>

          {#if showLiveFileReads}
            <div class="space-y-1">
              <label class="space-y-1">
                <span class="batshit-settings-form-label-line"><span class="batshit-settings-form-label">{LIVE_FILE_READS_LABEL}</span>
                  <SettingsInfoMenu ariaLabel={`About ${LIVE_FILE_READS_LABEL}`}>
                    {LIVE_FILE_READS_HELP}
                  </SettingsInfoMenu>
                </span>
                <Select.Root
                  type="single"
                  value={liveFileReads}
                  disabled={Boolean(liveFileReadsUnavailableReason)}
                  onValueChange={(value) => onLiveFileReadsChange(value ?? LIVE_READS_INHERIT)}
                >
                  <Select.Trigger
                    class={`batshit-settings-select-compact w-full ${inheritTriggerClass(liveFileReads === LIVE_READS_INHERIT)}`}
                    size="sm"
                    data-testid="agent-live-file-reads-select"
                    aria-describedby={liveReadsDescribedBy}
                  >
                    {getLiveFileReadsLabel(liveFileReads)}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value={LIVE_READS_INHERIT} label={getLiveFileReadsLabel(LIVE_READS_INHERIT)}>
                      {getLiveFileReadsLabel(LIVE_READS_INHERIT)}
                    </Select.Item>
                    <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
                    <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
              {#if liveFileReadsUnavailableReason}
                <p
                  id={liveReadsReasonId}
                  class={`batshit-settings-form-help${liveFileReadsWarn ? ' is-warning' : ''}`}
                  data-testid="agent-live-file-reads-unavailable"
                >{liveFileReadsUnavailableReason}</p>
              {/if}
              {#if liveFileReadsNote}
                <p id={liveReadsNoteId} class="batshit-settings-form-help" data-testid="agent-live-file-reads-note">{liveFileReadsNote}</p>
              {/if}
            </div>
          {/if}
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
            <th class="batshit-settings-table-head-cell">Enable</th>
            <th class="batshit-settings-table-head-cell">Display Detail</th>
            {#if showZipControls}
              <th class="batshit-settings-table-head-cell">Zip Buffer</th>
              <th class="batshit-settings-table-head-cell">Zip Threshold</th>
              <th class="batshit-settings-table-head-cell">Zip Behavior</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#if dcmCatalogError && getEnableControl('bash')}
            <tr class={topLevelAccordionRowClass}><td colspan={columnCount} class="batshit-settings-table-cell is-strong"><span class="batshit-settings-tool-grid-name">Batshit Tools</span></td></tr>
            {@render independentEnableRows(false, true)}
          {/if}
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
                getBrokerFamilyControls={getBrokerFamilyControlsForRow}
                {getEnableControl}
                showBrokerDiscoverable={false}
                onHeaderClick={handleTopLevelHeaderClick}
                onToggle={toggleTopLevelAccordionItem}
                showBulkZipApply
                bulkZipApplyLabel="Batshit Tools"
              />
            {/if}

            {#if !showZipControls && getEnableControl('bash')}
              <ToolGridSection
                title="Batshit Tools"
                iconRef={TOOL_GRID_BATSHIT_SECTION_ICON_REF}
                open={openTopLevelAccordionItemKey === BATSHIT_ROWS_KEY}
                tableClass={toolGridTableClass}
                firstColumnClass={toolGridItemColumnClass}
                otherColumnClass="w-[100px]"
                {showZipControls}
                onHeaderClick={(event) => handleTopLevelHeaderClick(event, BATSHIT_ROWS_KEY)}
                onToggle={() => toggleTopLevelAccordionItem(BATSHIT_ROWS_KEY)}
              >
                {@render independentEnableRows(true)}
              </ToolGridSection>
            {:else if !showZipControls && artifactFamilyEnabled}
              <BrokerFamilyToolGridRow controls={{ ...getArtifactFamilyControls(), visible: true }} rowClass={topLevelAccordionRowClass} showDiscoverable={false} />
            {/if}

            {#if cliToolCatalog.length > 0 || getEnableControl('cli_tools')}
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
                  {#if getEnableControl('cli_tools')}
                    {@const enable = getEnableControl('cli_tools')!}
                    <ToolGridEnableCell control={{
                      ...enable,
                      checked: enable.draftChecked ?? (enable.checked && cliEffectiveGroupMode !== 'hidden'),
                      disabled: enable.disabled || !globalCliSettingsReady && !(enable.draftChecked ?? (enable.checked && cliEffectiveGroupMode !== 'hidden')),
                      onChange: (checked) => enable.onChange(checked, checked ? cliGroupEnablePatch(normalizedDcmDisplaySettings, getGlobalGroupMode(cliGateway, cliGroupName)) : undefined)
                    }} label="CLI Tools" />
                  {:else}
                  <td class="batshit-settings-table-cell">
                    <Switch.Root
                      checked={cliGroupVisible}
                    disabled={!cliToolsEnabled || discoveryReadOnly}
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
                  {/if}
                  <td class="batshit-settings-table-cell">
                    <div class={`flex items-center gap-2 ${showZipControls ? '' : 'justify-between'}`}>
                      {#if cliGroupVisible}
                        <Select.Root
                          type="single"
                          value={cliGroupPreference}
                          disabled={!cliToolsEnabled || discoveryReadOnly}
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
                          {#if cliToolCatalog.length === 0}
                            <tr class="batshit-settings-table-row"><td colspan={columnCount} class="batshit-settings-table-cell is-muted is-empty">No saved CLI tools yet.</td></tr>
                          {/if}
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
                            {@const disableReason = discoveryReadOnly ? 'Read the saved CLI Tools choice before editing discovery.' : !cliToolsEnabled
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

            <ToolGridSection
              title="MCP Tools"
              iconRef={{ kind: 'brand', slug: 'mcp-mono' }}
              open={openTopLevelAccordionItemKey === MCP_ROWS_KEY}
              tableClass={`${toolGridTableClass} batshit-settings-tool-grid-mcp-sources`}
              firstColumnClass={toolGridItemColumnClass}
              otherColumnClass="w-[100px]"
              {showZipControls}
              enableControl={getEnableControl('mcp_tools')}
              onHeaderClick={(event) => handleTopLevelHeaderClick(event, MCP_ROWS_KEY)}
              onToggle={() => toggleTopLevelAccordionItem(MCP_ROWS_KEY)}
            >
              {#if dcmCatalog.length === 0}
                <tr class="batshit-settings-table-row"><td colspan={columnCount} class="batshit-settings-table-cell is-muted is-empty">No MCP sources discovered yet.</td></tr>
              {/if}
            {#each dcmCatalog as gateway}
              {@const gatewayEnabled = isGatewayEnabled(gateway.id)}
              {@const sourceKey = buildSourceKey(gateway.id)}
              {@const sourceExpanded = openSourceAccordionItemKey === sourceKey}
              <Collapsible.Root open={sourceExpanded}>
                <tr
                  class={`${nestedAccordionRowClass} cursor-pointer ${!dynamicMcpEnabled ? 'opacity-60' : ''}`}
                  onclick={(event) => handleSourceHeaderClick(event, sourceKey)}
                >
                  <td class="batshit-settings-table-cell is-strong">
                    <div class="batshit-settings-tool-grid-label is-source">
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
                      disabled={!dynamicMcpEnabled || discoveryReadOnly}
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
                          onclick={() => toggleSourceAccordionItem(sourceKey)}
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
                        onclick={() => toggleSourceAccordionItem(sourceKey)}
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
                            {@const groupToggleDisabled = discoveryReadOnly || !dynamicMcpEnabled || !gatewayEnabled}
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
                                                <span class="batshit-settings-tool-grid-name truncate font-mono text-[11px]" title={tool.name}>
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

            </ToolGridSection>

            {#if showZipControls && otherNonMcpRows.length > 0}
              <NonMcpZipRowsSection
                sectionKey={OTHER_ROWS_KEY}
                title="All Other Tools"
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
        <Button variant="outline" size="sm" onclick={onResetToGlobalSettings} disabled={discoveryReadOnly}>
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
          {previewOpen ? 'Hide Agent Setup Preview' : 'Preview Agent Setup Tools'}
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
            <div class="batshit-settings-form-label">Agent Setup Tool Preview</div>
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
                <span>Listed tools: {previewCounts.dcmTools ?? 0}</span>
                <span>Available tools: {previewCounts.availableTools ?? 0}</span>
              </div>
              <div class="flex flex-wrap gap-3">
                <span>Enabled tool token estimate: {tokenEstimates.enabled ?? 'Unknown'}</span>
                <span>Tool index token estimate: {tokenEstimates.dcm ?? 'Unknown'}</span>
                <span>Combined tool token estimate: {tokenEstimates.total ?? 'Unknown'}</span>
              </div>
              {#if previewHintBudget}
                <div class="flex flex-wrap gap-3">
                  <span>Scalable tool hint token estimate: {previewHintBudget.budgetedTokens} / {previewHintBudget.limit}</span>
                  <span>Fixed feature hint token estimate: {previewHintBudget.featureTokens}</span>
                </div>
              {/if}

              {#if brokerRuntime === 'api' && previewData.apiUtilityProjection !== 'registered'}
                <div class="batshit-settings-caption is-warning">
                  Runtime utility hints are not computed by this preview. These estimates cover
                  the listed metadata; the actual message can include more.
                </div>
              {/if}

              <pre class="whitespace-pre-wrap text-xs text-foreground">{previewText || (brokerRuntime === 'api' ? 'No computed tool groups in this preview.' : 'No discoverable tools left to list.')}</pre>

              <div class="batshit-settings-muted-panel">
                This previews the tool portion of Agent Setup after discoverability filters and
                display-detail rules. Token estimates use characters divided by four, rounded up.
                The separate enabled skills catalog is outside this preview and its tool hint budget.
              </div>
              <div class="batshit-settings-muted-panel">
                Preview updates are based on the agent’s current MCP and CLI discoverability plus
                display-detail settings. Inherited/default large groups may collapse. Explicit
                group display choices can show more tools, within the total tool hint budget. Fixed
                feature hints are separate from that budget, so total Agent Setup can be larger.
              </div>
            </div>
          {:else}
            <div class="batshit-settings-form-label">No preview data available.</div>
          {/if}
        </div>
      {/if}
    {/if}
</SettingsAccordionCard>
