<script lang="ts">
/**
 * Dynamic MCP dropdown for ChatBar.
 *
 * ChatBar now surfaces the same full Tool Settings Grid used in Agent Settings,
 * so discoverability and zip controls can be adjusted in-chat without context
 * switching.
 */
import { onDestroy, untrack } from 'svelte'
import { Button } from '$lib/components/ui/button'
import { Badge } from '$lib/components/ui/badge'
import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
import { debounce } from '$lib/utils/debounce'
import {
  RefreshCcw,
  Wrench
} from '@lucide/svelte'
import AgentMcpDefaultsCard from '$lib/components/settings/agent/AgentMcpDefaultsCard.svelte'
import {
	SHARED_NON_MCP_TOOL_GRID_CONFIG,
	SHARED_NON_MCP_TOOL_GRID_ROWS,
	type SharedNonMcpToolGridRowConfig,
	type SharedNonMcpToolGridRowId
} from '$lib/components/tools/toolGridConfig'
import {
	CLI_TOOL_GRID_GROUP_NAME,
	CLI_TOOL_GRID_ID,
	normalizeCliToolGridSettings
} from '$lib/utils/toolGridCli'
import { getToolGridDefaultAutoZip, getToolGridDefaultNumber } from '$lib/utils/toolGridZipDefaults'
import { getCurrentAgentId, getAgents, updateAgentSettings } from '$lib/stores/agents.svelte'
import { getUserSettings } from '$lib/stores/userSettings.svelte'
import { isCliPrimaryAgentType, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import {
	buildDcmDisplaySettingsSignature,
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
import type { IconRef } from '$lib/icons/iconTypes'
import type {
	AgentDcmDisplaySettings,
	AgentDcmGroupDisplayMode,
	DcmGroupDisplayMode,
	DcmToolDisplayMode,
	GatewayDcmDisplaySettings,
	MCPGateway,
	MCPToolSelections
} from '$lib/types/database'
import { toast } from 'svelte-sonner'

interface GatewayToolRow {
	id: string
	name: string
	description?: string
}

interface GatewayMcpGroup {
	id: string
	name: string
	tools: GatewayToolRow[]
}

interface GatewayMCPs {
	[gatewayId: string]: GatewayMcpGroup[] | 'error'
}

interface CliToolCatalogRow {
	toolId: string
	status?: string
}

interface Props {
	userId?: string
	onMCPsChange?: (selectedGateways: string[]) => void
	onToolSelectionsChange?: (selections: MCPToolSelections) => void
	settingsData?: any
}

let {
	userId,
	onMCPsChange = () => {},
	onToolSelectionsChange = () => {},
	settingsData = null
}: Props = $props()

function normalizeWebhookUrl(url: string | undefined): string {
	if (!url) return ''
	const trimmed = url.replace(/\/$/, '')
	const match = trimmed.match(/https?:\/\/[^\/]+(.*)$/)
	const path = match ? match[1] : trimmed
	return path.replace(/^\/webhook\//, '/')
}

function normalizeGatewaySelection(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const normalized = value
		.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
		.filter((entry) => entry.length > 0)
	return Array.from(new Set(normalized))
}

function normalizeToolSelections(value: unknown): MCPToolSelections {
	if (!Array.isArray(value)) return []
	return value
		.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
		.filter((entry) => entry.length > 0)
}

function normalizeCliToolSelections(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return Array.from(
		new Set(
			value
				.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
				.filter((entry) => entry.length > 0)
		)
	).sort()
}

const ZIP_AUTO_INHERIT = '__inherit__'
const ZIP_PERMISSION_INHERIT = '__inherit__'
const ZIP_LAYOUT_INHERIT = '__inherit__'

interface CustomToolZipFormEntry {
	tool_name: string
	buffer_size: string
	zip_threshold: string
	auto_zip: string
}

interface ToolZipOverrideSnapshot {
	buffer_size: string
	zip_threshold: string
	auto_zip: string
	inherited_buffer_size?: number
	inherited_zip_threshold?: number
	inherited_auto_zip?: boolean
}

type NonMcpZipRowId = SharedNonMcpToolGridRowId
type NonMcpZipRow = { id: NonMcpZipRowId; label: string; iconRef: IconRef }

interface NonMcpZipOverrideSnapshot {
	buffer_size: string
	zip_threshold: string
	auto_zip: string
	inherited_buffer_size?: number
	inherited_zip_threshold?: number
	inherited_auto_zip?: boolean
	min_buffer: number
}

const NON_MCP_ZIP_ROW_ORDER: NonMcpZipRow[] =
	SHARED_NON_MCP_TOOL_GRID_ROWS

const NON_MCP_ZIP_ROW_CONFIG: Record<NonMcpZipRowId, SharedNonMcpToolGridRowConfig> =
	SHARED_NON_MCP_TOOL_GRID_CONFIG as Record<NonMcpZipRowId, SharedNonMcpToolGridRowConfig>

function buildGroupKey(gatewayId: string, groupName: string): string {
	return `${gatewayId}::${groupName}`
}

function buildToolKey(gatewayId: string, toolName: string): string {
	return `${gatewayId}::${toolName}`
}

const createDefaultGatewayDcmDefaults = createDefaultGatewayDcmDisplaySettings
const normalizeGatewayDcmDefaults = normalizeGatewayDcmDisplaySettings
const buildDcmSignature = buildDcmDisplaySettingsSignature

function buildCustomToolZipSignature(source: CustomToolZipFormEntry[]): string {
	const normalized = [...source]
		.map((entry) => ({
			tool_name: entry.tool_name.trim(),
			buffer_size: entry.buffer_size,
			zip_threshold: entry.zip_threshold,
			auto_zip: entry.auto_zip || ZIP_AUTO_INHERIT
		}))
		.filter((entry) => entry.tool_name.length > 0)
		.sort((left, right) => left.tool_name.localeCompare(right.tool_name))
	return JSON.stringify(normalized)
}

function buildNonMcpZipSignature(source: Record<NonMcpZipRowId, CustomToolZipFormEntry>): string {
	const normalized = NON_MCP_ZIP_ROW_ORDER.map((row) => {
		const entry = source[row.id]
		return {
			id: row.id,
			buffer_size: entry?.buffer_size ?? '',
			zip_threshold: entry?.zip_threshold ?? '',
			auto_zip: entry?.auto_zip ?? ZIP_AUTO_INHERIT
		}
	})
	return JSON.stringify(normalized)
}

function mapGroupModeToDefaultToolMode(groupMode: DcmGroupDisplayMode): DcmToolDisplayMode {
	if (groupMode === 'group+tools+names') return 'name-only'
	if (groupMode === 'hidden' || groupMode === 'group-only') return 'hidden'
	return 'name+hint'
}

function extractAgentDcmDisplaySettings(agent: any): AgentDcmDisplaySettings {
	return normalizeDcmDisplaySettings(agent?.dcmDisplaySettings ?? agent?.dcm_display_settings ?? null)
}

function isHiddenInternalTool(toolId: string): boolean {
	const normalized = toolId?.toLowerCase?.() ?? ''
	if (!normalized) return false
	return (
		normalized.startsWith('mcp_fabric_') ||
		normalized.startsWith('batshit_server_dynamic_mcp_') ||
		normalized === 'batshit_server_fetch_zip'
	)
}

function parseBooleanSetting(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase()
		if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
		if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
	}
	return null
}

function getNativeToolsSettings(
	agent: { provider_specific_settings?: Record<string, any> | null } | null | undefined
): Record<string, unknown> {
	const providerSettings = agent?.provider_specific_settings
	if (!providerSettings || typeof providerSettings !== 'object' || Array.isArray(providerSettings)) {
		return {}
	}
	const nested = providerSettings.nativeTools
	if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
		return {}
	}
	return nested as Record<string, unknown>
}

function normalizeCliToolId(value: unknown): string {
	return typeof value === 'string' ? value.trim() : ''
}

// State
let isOpen = $state(false)
let gateways = $state<MCPGateway[]>([])
let selectedGateways = $state<Set<string>>(new Set())
let selectedCliToolIds = $state<string[]>([])
let selectedCliToolIdsExplicit = $state(false)
let dcmDisplaySettings = $state<AgentDcmDisplaySettings>(createDefaultDcmDisplaySettings())
let loading = $state(false)
let error = $state<string | null>(null)
let gatewayMCPs = $state<GatewayMCPs>({})
let loadingTools = $state<{ [gatewayId: string]: boolean }>({})
let activeCliToolIds = $state<Set<string>>(new Set())
let cliToolCatalogLoaded = $state(false)
let persistReady = $state(false)
let saveStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle')
let saveError = $state<string | null>(null)
let saveResetTimer: ReturnType<typeof setTimeout> | null = null
let mcpLastSaved = $state<Date | null>(null)
let mcpRenderNonce = $state(0)

let zipAgentControlEnabled = $state(ZIP_PERMISSION_INHERIT)
let zipAiViewMode = $state(ZIP_LAYOUT_INHERIT)
let customToolZipOverrides = $state<CustomToolZipFormEntry[]>([])
let nonMcpZipOverrides = $state<Record<NonMcpZipRowId, CustomToolZipFormEntry>>(
	createInheritedNonMcpZipOverrides()
)
let zipSaveState = $state<'idle' | 'saving' | 'saved'>('idle')
let zipSaveError = $state<string | null>(null)
let zipLastSaved = $state<Date | null>(null)
let zipSaveResetTimer: ReturnType<typeof setTimeout> | null = null

function clearSaveResetTimer() {
	if (saveResetTimer) {
		clearTimeout(saveResetTimer)
		saveResetTimer = null
	}
}

function clearZipSaveResetTimer() {
	if (zipSaveResetTimer) {
		clearTimeout(zipSaveResetTimer)
		zipSaveResetTimer = null
	}
}

function scheduleSaveReset() {
	clearSaveResetTimer()
	saveResetTimer = setTimeout(() => {
		saveStatus = 'idle'
		saveResetTimer = null
	}, 1500)
}

function scheduleZipSaveReset() {
	clearZipSaveResetTimer()
	zipSaveResetTimer = setTimeout(() => {
		zipSaveState = 'idle'
		zipSaveResetTimer = null
	}, 1500)
}

onDestroy(() => {
	clearSaveResetTimer()
	clearZipSaveResetTimer()
})

let interactiveGateways = $derived(gateways.filter((gateway) => gateway.type !== 'n8n-mcp-client'))
let effectiveSelectedGatewayIds = $derived(selectedGateways)

let gatewayDefaultsById = $derived.by(() => {
	const map = new Map<string, GatewayDcmDisplaySettings>()
	for (const gateway of gateways) {
		map.set(gateway.id, normalizeGatewayDcmDefaults((gateway as any).dcmDisplayDefaults ?? null))
	}
	return map
})

let liveUserSettings = $derived(getUserSettings())
let effectiveUserSettings = $derived(liveUserSettings ?? settingsData?.userSettings ?? null)

let globalCliToolGridSettings = $derived(
	normalizeCliToolGridSettings(effectiveUserSettings?.global_tool_grid_settings?.cli ?? null)
)

let syntheticGateways = $derived(
	gateways.filter((gateway) => {
		if (gateway.type !== 'n8n-mcp-client') return false
		if (currentAgent?.webhook_url && gateway.metadata?.workflowWebhook) {
			const normalizedAgentWebhook = normalizeWebhookUrl(currentAgent.webhook_url)
			const normalizedWorkflowWebhook = normalizeWebhookUrl(gateway.metadata.workflowWebhook as string)
			return normalizedWorkflowWebhook === normalizedAgentWebhook
		}
		return false
	})
)

let currentAgent = $derived.by(() => {
	const agentId = getCurrentAgentId()
	const agents = getAgents()
	return agents.find((agent) => agent.id === agentId)
})

let nativeDynamicMcpEnabled = $derived.by(() => {
	const parsed = parseBooleanSetting(getNativeToolsSettings(currentAgent).dynamicMcpEnabled)
	return parsed === null ? true : parsed
})

let nativeCliToolsEnabled = $derived.by(() => {
	const parsed = parseBooleanSetting(getNativeToolsSettings(currentAgent).cliToolsEnabled)
	return parsed === null ? true : parsed
})

let lastAgentId = $state<string | undefined>()
let lastGatewaySignature = $state<string | undefined>()
let lastDcmSignature = $state<string | undefined>()
let lastToolSelectionSignature = $state<string | undefined>()
let lastCliToolSignature = $state<string | undefined>()
let lastZipSignature = $state<string | undefined>()
let lastEffectiveGatewaySignature = $state<string | undefined>()

let normalizedDcmDisplaySettings = $derived(normalizeDcmDisplaySettings(dcmDisplaySettings))

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

function getGlobalGroupMode(gatewayId: string, groupName: string): DcmGroupDisplayMode {
	const defaults = gatewayDefaultsById.get(gatewayId) ?? createDefaultGatewayDcmDefaults()
	const mode = defaults.groups[groupName]
	if (typeof mode === 'string' && VALID_GLOBAL_GROUP_MODES.has(mode as DcmGroupDisplayMode)) {
		return mode as DcmGroupDisplayMode
	}
	return 'group+tools+hints'
}

function getGlobalToolMode(gatewayId: string, toolName: string): DcmToolDisplayMode {
	const defaults = gatewayDefaultsById.get(gatewayId) ?? createDefaultGatewayDcmDefaults()
	const mode = defaults.tools[toolName]
	if (typeof mode === 'string' && VALID_TOOL_MODES.has(mode as DcmToolDisplayMode)) {
		return mode as DcmToolDisplayMode
	}
	return 'inherit'
}

function resolveEffectiveGroupMode(
	gatewayId: string,
	groupName: string,
	agentGroupMode: AgentDcmGroupDisplayMode
): DcmGroupDisplayMode {
	if (agentGroupMode === 'use-global') {
		return getGlobalGroupMode(gatewayId, groupName)
	}
	if (VALID_GLOBAL_GROUP_MODES.has(agentGroupMode as DcmGroupDisplayMode)) {
		return agentGroupMode as DcmGroupDisplayMode
	}
	return 'group+tools+hints'
}

function resolveEffectiveToolMode(
	gatewayId: string,
	groupName: string,
	toolName: string
): DcmToolDisplayMode {
	const agentGroupMode = getGroupMode(gatewayId, groupName)
	const effectiveGroupMode = resolveEffectiveGroupMode(gatewayId, groupName, agentGroupMode)
	const agentToolMode = getToolMode(gatewayId, toolName)

	if (agentToolMode !== 'inherit') {
		return agentToolMode
	}

	const agentGroupOverride = agentGroupMode !== 'use-global'
	if (agentGroupOverride) {
		return mapGroupModeToDefaultToolMode(effectiveGroupMode)
	}

	const globalToolMode = getGlobalToolMode(gatewayId, toolName)
	if (globalToolMode !== 'inherit') {
		return globalToolMode
	}

	return mapGroupModeToDefaultToolMode(effectiveGroupMode)
}

function getCliGlobalGroupMode(groupName: string): DcmGroupDisplayMode {
	const mode = globalCliToolGridSettings.dcmDisplayDefaults.groups[groupName]
	if (typeof mode === 'string' && VALID_GLOBAL_GROUP_MODES.has(mode as DcmGroupDisplayMode)) {
		return mode as DcmGroupDisplayMode
	}
	return 'group+tools+hints'
}

function getCliGlobalToolMode(toolName: string): DcmToolDisplayMode {
	const mode = globalCliToolGridSettings.dcmDisplayDefaults.tools[toolName]
	if (typeof mode === 'string' && VALID_TOOL_MODES.has(mode as DcmToolDisplayMode)) {
		return mode as DcmToolDisplayMode
	}
	return 'inherit'
}

function resolveEffectiveCliGroupMode(): DcmGroupDisplayMode {
	const agentGroupMode = getGroupMode(CLI_TOOL_GRID_ID, CLI_TOOL_GRID_GROUP_NAME)
	if (agentGroupMode === 'use-global') {
		return getCliGlobalGroupMode(CLI_TOOL_GRID_GROUP_NAME)
	}
	if (VALID_GLOBAL_GROUP_MODES.has(agentGroupMode as DcmGroupDisplayMode)) {
		return agentGroupMode as DcmGroupDisplayMode
	}
	return 'group+tools+hints'
}

function resolveEffectiveCliToolMode(toolId: string): DcmToolDisplayMode {
	const agentGroupMode = getGroupMode(CLI_TOOL_GRID_ID, CLI_TOOL_GRID_GROUP_NAME)
	const effectiveGroupMode = resolveEffectiveCliGroupMode()
	const agentToolMode = getToolMode(CLI_TOOL_GRID_ID, toolId)

	if (agentToolMode !== 'inherit') {
		return agentToolMode
	}

	if (agentGroupMode !== 'use-global') {
		return mapGroupModeToDefaultToolMode(effectiveGroupMode)
	}

	const globalToolMode = getCliGlobalToolMode(toolId)
	if (globalToolMode !== 'inherit') {
		return globalToolMode
	}

	return mapGroupModeToDefaultToolMode(effectiveGroupMode)
}

function isCliToolDiscoverable(toolId: string): boolean {
	const groupMode = resolveEffectiveCliGroupMode()
	if (groupMode === 'hidden') return false
	return resolveEffectiveCliToolMode(toolId) !== 'hidden'
}

function isMcpToolDiscoverable(gatewayId: string, groupName: string, toolName: string): boolean {
	const effectiveGroupMode = resolveEffectiveGroupMode(
		gatewayId,
		groupName,
		getGroupMode(gatewayId, groupName)
	)
	if (effectiveGroupMode === 'hidden') return false
	return resolveEffectiveToolMode(gatewayId, groupName, toolName) !== 'hidden'
}

function toZipPermissionValue(value: boolean | null | undefined): string {
	if (value === true) return 'enabled'
	if (value === false) return 'disabled'
	return ZIP_PERMISSION_INHERIT
}

function toZipLayoutValue(value: unknown): string {
	return value === 'inline' || value === 'appended' ? value : ZIP_LAYOUT_INHERIT
}

function toAutoZipValue(value: boolean | null | undefined): string {
	if (value === true) return 'enabled'
	if (value === false) return 'disabled'
	return ZIP_AUTO_INHERIT
}

function normalizeCustomToolZipOverrides(value: unknown): CustomToolZipFormEntry[] {
	if (!Array.isArray(value)) return []
	const next: CustomToolZipFormEntry[] = []
	for (const item of value) {
		if (!item || typeof item !== 'object') continue
		const toolName = String((item as any).tool_name ?? '').trim()
		if (!toolName) continue
		const rawBuffer = (item as any).buffer_size
		const rawThreshold = (item as any).zip_threshold
		next.push({
			tool_name: toolName,
			buffer_size: typeof rawBuffer === 'number' && Number.isFinite(rawBuffer) ? String(rawBuffer) : '',
			zip_threshold:
				typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)
					? String(rawThreshold)
					: '',
			auto_zip: toAutoZipValue((item as any).auto_zip)
		})
	}
	return next.sort((left, right) => left.tool_name.localeCompare(right.tool_name))
}

function createInheritedNonMcpZipOverrides(): Record<NonMcpZipRowId, CustomToolZipFormEntry> {
	return Object.fromEntries(
		NON_MCP_ZIP_ROW_ORDER.map((row) => {
			const config = NON_MCP_ZIP_ROW_CONFIG[row.id]
			return [
				row.id,
				{
					tool_name: config.mode === 'custom' ? config.toolName : row.id,
				buffer_size: '',
				zip_threshold: '',
				auto_zip: ZIP_AUTO_INHERIT
			}
			]
		})
	) as Record<NonMcpZipRowId, CustomToolZipFormEntry>
}

function normalizeNonMcpZipOverrides(agent: Record<string, any> | null | undefined) {
	const next = createInheritedNonMcpZipOverrides()
	for (const row of NON_MCP_ZIP_ROW_ORDER) {
		const config = NON_MCP_ZIP_ROW_CONFIG[row.id]
		if (config.mode === 'custom') continue
		const rawBuffer = agent?.[config.bufferField]
		const rawThreshold = agent?.[config.thresholdField]
		const rawAuto = agent?.[config.autoField]
		next[row.id] = {
			tool_name: row.id,
			buffer_size:
				typeof rawBuffer === 'number' && Number.isFinite(rawBuffer) ? String(rawBuffer) : '',
			zip_threshold:
				typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)
					? String(rawThreshold)
					: '',
			auto_zip: toAutoZipValue(typeof rawAuto === 'boolean' ? rawAuto : null)
		}
	}
	return next
}

function getGlobalZipSettings(): Record<string, any> | null {
	const raw = effectiveUserSettings?.global_zip_settings
	return raw && typeof raw === 'object' ? (raw as Record<string, any>) : null
}

function getGlobalCustomToolSetting(toolName: string): Record<string, any> | null {
	const global = getGlobalZipSettings()
	const custom = Array.isArray(global?.custom_tool_settings) ? global.custom_tool_settings : []
	const match = custom.find((tool: any) => String(tool?.tool_name ?? '').trim() === toolName)
	return match && typeof match === 'object' ? (match as Record<string, any>) : null
}

function getGlobalZipNumber(field: string): number | undefined {
	const global = getGlobalZipSettings()
	const value = global?.[field]
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getEffectiveGlobalZipNumber(field: string): number | undefined {
	const explicit = getGlobalZipNumber(field)
	return explicit ?? getToolGridDefaultNumber(field)
}

function getGlobalZipBoolean(field: string): boolean | undefined {
	const global = getGlobalZipSettings()
	const value = global?.[field]
	return typeof value === 'boolean' ? value : undefined
}

function getEffectiveGlobalZipBoolean(field: string): boolean | undefined {
	const explicit = getGlobalZipBoolean(field)
	return explicit ?? getToolGridDefaultAutoZip(field)
}

function getToolZipOverride(toolName: string): ToolZipOverrideSnapshot {
	const normalizedName = toolName.trim()
	const custom = customToolZipOverrides.find((tool) => tool.tool_name === normalizedName)
	const globalCustom = getGlobalCustomToolSetting(normalizedName)
	return {
		buffer_size: custom?.buffer_size ?? '',
		zip_threshold: custom?.zip_threshold ?? '',
		auto_zip: custom?.auto_zip ?? ZIP_AUTO_INHERIT,
		inherited_buffer_size:
			typeof globalCustom?.buffer_size === 'number'
				? globalCustom.buffer_size
				: getEffectiveGlobalZipNumber('buffer_size_all_other_tools'),
		inherited_zip_threshold:
			typeof globalCustom?.zip_threshold === 'number'
				? globalCustom.zip_threshold
				: getEffectiveGlobalZipNumber('zip_threshold_all_other_tools'),
		inherited_auto_zip:
			typeof globalCustom?.auto_zip === 'boolean'
				? globalCustom.auto_zip
				: getEffectiveGlobalZipBoolean('auto_zip_all_other_tools')
	}
}

function getNonMcpZipOverrideById(rowId: string): NonMcpZipOverrideSnapshot {
	const config = NON_MCP_ZIP_ROW_CONFIG[rowId as NonMcpZipRowId]
	if (!config) {
		return {
			buffer_size: '',
			zip_threshold: '',
			auto_zip: ZIP_AUTO_INHERIT,
			min_buffer: 2
		}
	}
	if (config.mode === 'custom') {
		const toolName = config.toolName
		const custom = customToolZipOverrides.find((tool) => tool.tool_name === toolName)
		const globalCustom = getGlobalCustomToolSetting(toolName)
		const inheritedAutoZip =
			typeof globalCustom?.auto_zip === 'boolean' ? globalCustom.auto_zip : config.defaultAutoZip
		return {
			buffer_size: custom?.buffer_size ?? '',
			zip_threshold: custom?.zip_threshold ?? '',
			auto_zip: custom?.auto_zip ?? ZIP_AUTO_INHERIT,
			inherited_buffer_size:
				typeof globalCustom?.buffer_size === 'number'
					? globalCustom.buffer_size
					: config.defaultBuffer,
			inherited_zip_threshold:
				typeof globalCustom?.zip_threshold === 'number'
					? globalCustom.zip_threshold
					: config.defaultThreshold,
			inherited_auto_zip: inheritedAutoZip,
			min_buffer: config.minBuffer
		}
	}
	const local = nonMcpZipOverrides[config.id] ?? createInheritedNonMcpZipOverrides()[config.id]
	return {
		buffer_size: local.buffer_size,
		zip_threshold: local.zip_threshold,
		auto_zip: local.auto_zip,
		inherited_buffer_size: getEffectiveGlobalZipNumber(config.bufferField),
		inherited_zip_threshold: getEffectiveGlobalZipNumber(config.thresholdField),
		inherited_auto_zip: getEffectiveGlobalZipBoolean(config.autoField),
		min_buffer: config.minBuffer
	}
}

function handleNonMcpZipOverrideChangeById(
	rowId: string,
	patch: Partial<Pick<NonMcpZipOverrideSnapshot, 'buffer_size' | 'zip_threshold' | 'auto_zip'>>
) {
	const config = NON_MCP_ZIP_ROW_CONFIG[rowId as NonMcpZipRowId]
	if (!config) return
	if (config.mode === 'custom') {
		const toolName = config.toolName
		const current =
			customToolZipOverrides.find((tool) => tool.tool_name === toolName) ??
			{ tool_name: toolName, buffer_size: '', zip_threshold: '', auto_zip: ZIP_AUTO_INHERIT }
		const next: CustomToolZipFormEntry = {
			tool_name: toolName,
			buffer_size: patch.buffer_size ?? current.buffer_size,
			zip_threshold: patch.zip_threshold ?? current.zip_threshold,
			auto_zip: patch.auto_zip ?? current.auto_zip ?? ZIP_AUTO_INHERIT
		}
		const nextList = customToolZipOverrides
			.filter((tool) => tool.tool_name !== toolName)
			.concat(next)
			.sort((left, right) => left.tool_name.localeCompare(right.tool_name))
		customToolZipOverrides = nextList
		queuePersistZipSettings('tool-grid-custom-zip-change')
		return
	}

	const current = nonMcpZipOverrides[config.id] ?? createInheritedNonMcpZipOverrides()[config.id]
	const next: CustomToolZipFormEntry = {
		tool_name: config.id,
		buffer_size: patch.buffer_size ?? current.buffer_size,
		zip_threshold: patch.zip_threshold ?? current.zip_threshold,
		auto_zip: patch.auto_zip ?? current.auto_zip ?? ZIP_AUTO_INHERIT
	}

	nonMcpZipOverrides = {
		...nonMcpZipOverrides,
		[config.id]: next
	}
	queuePersistZipSettings('tool-grid-non-mcp-zip-change')
}

function parseOptionalNumber(value: string): number | undefined {
	const trimmed = value.trim()
	if (!trimmed) return undefined
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) return undefined
	return parsed
}

function toZipPayloadCustomTools(): Array<{
	tool_name: string
	buffer_size?: number
	zip_threshold?: number
	auto_zip?: boolean
}> {
	const next: Array<{
		tool_name: string
		buffer_size?: number
		zip_threshold?: number
		auto_zip?: boolean
	}> = []

	for (const tool of customToolZipOverrides) {
		const toolName = tool.tool_name.trim()
		if (!toolName) continue
		const buffer = parseOptionalNumber(tool.buffer_size)
		const threshold = parseOptionalNumber(tool.zip_threshold)
		const autoZip =
			tool.auto_zip === 'enabled' ? true : tool.auto_zip === 'disabled' ? false : undefined
		if (buffer === undefined && threshold === undefined && autoZip === undefined) continue
		next.push({
			tool_name: toolName,
			buffer_size: buffer,
			zip_threshold: threshold,
			auto_zip: autoZip
		})
	}

	return next.sort((left, right) => left.tool_name.localeCompare(right.tool_name))
}

async function persistMcpSettings(reason: string) {
	if (!currentAgent?.id || !persistReady) return

	saveStatus = 'saving'
	saveError = null
	clearSaveResetTimer()

		try {
			const nextGateways = Array.from(selectedGateways)
			const nextDcmDisplaySettings = cloneDcmDisplaySettings(normalizedDcmDisplaySettings)
				await updateAgentSettings(currentAgent.id, {
					defaultMCPGateways: nextGateways,
					dcmDisplaySettings: nextDcmDisplaySettings,
					defaultTools: selectedCliToolIdsExplicit ? [...selectedCliToolIds] : null
				})
				saveStatus = 'saved'
			mcpLastSaved = new Date()
			scheduleSaveReset()
	} catch (saveFailure) {
		const message = saveFailure instanceof Error ? saveFailure.message : 'Failed to save MCP settings'
		saveStatus = 'error'
		saveError = message
		console.error('[MCPsDropdown] Failed to persist MCP settings', { reason, error: saveFailure })
		toast.error('Failed to save MCP settings', { description: message })
	}
}

async function persistZipSettings(reason: string) {
	if (!currentAgent?.id || !persistReady) return

	zipSaveState = 'saving'
	zipSaveError = null
	clearZipSaveResetTimer()

	try {
		const zipPermission =
			zipAgentControlEnabled === 'enabled'
				? true
				: zipAgentControlEnabled === 'disabled'
					? false
					: null
		const zipLayout =
			zipAiViewMode === 'inline' || zipAiViewMode === 'appended' ? zipAiViewMode : null
		const customToolPayload = toZipPayloadCustomTools()
			const nonMcpPayload: Record<string, number | boolean | null> = {}
			for (const row of NON_MCP_ZIP_ROW_ORDER) {
				const config = NON_MCP_ZIP_ROW_CONFIG[row.id]
				if (config.mode === 'custom') continue
				const local = nonMcpZipOverrides[row.id] ?? createInheritedNonMcpZipOverrides()[row.id]
				const buffer = parseOptionalNumber(local.buffer_size)
				const threshold = parseOptionalNumber(local.zip_threshold)
			const autoZip =
				local.auto_zip === 'enabled'
					? true
					: local.auto_zip === 'disabled'
						? false
						: null
			nonMcpPayload[config.bufferField] = buffer ?? null
			nonMcpPayload[config.thresholdField] = threshold ?? null
			nonMcpPayload[config.autoField] = autoZip
		}

			await updateAgentSettings(currentAgent.id, {
				zip_agent_control_enabled: zipPermission,
			zip_ai_view_mode: zipLayout,
			custom_tool_settings: customToolPayload,
				...nonMcpPayload
			})

			zipSaveState = 'saved'
		zipLastSaved = new Date()
		scheduleZipSaveReset()
	} catch (saveFailure) {
		const message =
			saveFailure instanceof Error ? saveFailure.message : 'Failed to save zip settings'
		zipSaveState = 'idle'
		zipSaveError = message
		console.error('[MCPsDropdown] Failed to persist zip settings', { reason, error: saveFailure })
		toast.error('Failed to save tool zip settings', { description: message })
	}
}

const debouncedPersistZipSettings = debounce((reason: string) => {
	void persistZipSettings(reason)
}, 250)

function queuePersistZipSettings(reason: string) {
	debouncedPersistZipSettings(reason)
}

function handleMcpGatewaysChange(gateways: string[]) {
	selectedGateways = new Set(gateways)
	onMCPsChange(gateways)
	onToolSelectionsChange(normalizeToolSelections(currentAgent?.defaultMCPToolSelections))
	void persistMcpSettings('tool-grid-gateway-change')
}

function handleMcpDcmDisplaySettingsChange(settings: AgentDcmDisplaySettings) {
	dcmDisplaySettings = cloneDcmDisplaySettings(normalizeDcmDisplaySettings(settings))
	void persistMcpSettings('tool-grid-dcm-change')
}

function handleCliToolSelectionsChange(toolIds: string[]) {
	selectedCliToolIds = [...toolIds]
	selectedCliToolIdsExplicit = true
	void persistMcpSettings('tool-surface-cli-change')
}

function handleMcpToolZipOverrideChange(
	toolName: string,
	patch: Partial<Pick<ToolZipOverrideSnapshot, 'buffer_size' | 'zip_threshold' | 'auto_zip'>>
) {
	const normalizedName = toolName.trim()
	if (!normalizedName) return

	const current = customToolZipOverrides.find((tool) => tool.tool_name === normalizedName)
	const nextEntry: CustomToolZipFormEntry = {
		tool_name: normalizedName,
		buffer_size: current?.buffer_size ?? '',
		zip_threshold: current?.zip_threshold ?? '',
		auto_zip: current?.auto_zip ?? ZIP_AUTO_INHERIT,
		...patch
	}

	const withoutCurrent = customToolZipOverrides.filter((tool) => tool.tool_name !== normalizedName)
	const isEmptyOverride =
		!nextEntry.buffer_size &&
		!nextEntry.zip_threshold &&
		(nextEntry.auto_zip === ZIP_AUTO_INHERIT || !nextEntry.auto_zip)
	const nextCustomTools = isEmptyOverride
		? withoutCurrent
		: [...withoutCurrent, nextEntry].sort((left, right) =>
				left.tool_name.localeCompare(right.tool_name)
			)

	const currentSignature = JSON.stringify(customToolZipOverrides)
	const nextSignature = JSON.stringify(nextCustomTools)
	if (currentSignature === nextSignature) return

	customToolZipOverrides = nextCustomTools
	queuePersistZipSettings('tool-grid-tool-zip-change')
}

function handleZipAgentControlChange(value: string) {
	zipAgentControlEnabled = value || ZIP_PERMISSION_INHERIT
	queuePersistZipSettings('tool-grid-zip-permission')
}

function handleZipAiViewModeChange(value: string) {
	zipAiViewMode = value || ZIP_LAYOUT_INHERIT
	queuePersistZipSettings('tool-grid-zip-layout')
}

function handleResetZipOverrides() {
	zipAgentControlEnabled = ZIP_PERMISSION_INHERIT
	zipAiViewMode = ZIP_LAYOUT_INHERIT
	customToolZipOverrides = []
	nonMcpZipOverrides = createInheritedNonMcpZipOverrides()
	queuePersistZipSettings('tool-grid-zip-reset')
}

function handleClearDefaults() {
	selectedGateways = new Set()
	dcmDisplaySettings = createDefaultDcmDisplaySettings()
	zipAgentControlEnabled = ZIP_PERMISSION_INHERIT
	zipAiViewMode = ZIP_LAYOUT_INHERIT
	customToolZipOverrides = []
	nonMcpZipOverrides = createInheritedNonMcpZipOverrides()
	onMCPsChange([])
	onToolSelectionsChange(normalizeToolSelections(currentAgent?.defaultMCPToolSelections))
	void persistMcpSettings('tool-grid-clear-defaults')
	queuePersistZipSettings('tool-grid-clear-defaults')
}

function handleDropdownBackdropPointerDown(event: PointerEvent, node: HTMLElement) {
	if (event.target === node) {
		isOpen = false
	}
}

function closeOnDropdownBackdropPointerDown(node: HTMLElement) {
	const handlePointerDown = (event: PointerEvent) => handleDropdownBackdropPointerDown(event, node)
	node.addEventListener('pointerdown', handlePointerDown)
	return {
		destroy() {
			node.removeEventListener('pointerdown', handlePointerDown)
		}
	}
}

$effect(() => {
	if (userId) {
		void fetchGateways()
		void fetchCliToolCatalog()
	} else {
		activeCliToolIds = new Set()
		cliToolCatalogLoaded = false
	}
})

$effect(() => {
	const currentGatewaySignature = JSON.stringify(normalizeGatewaySelection(currentAgent?.defaultMCPGateways))
	const currentDcmSignature = buildDcmSignature(extractAgentDcmDisplaySettings(currentAgent))
	const currentToolSelectionSignature = JSON.stringify(
		normalizeToolSelections(currentAgent?.defaultMCPToolSelections)
	)
	const currentCliToolSignature = JSON.stringify(
		Array.isArray(currentAgent?.defaultTools) || Array.isArray((currentAgent as any)?.default_tools)
			? normalizeCliToolSelections(currentAgent?.defaultTools ?? (currentAgent as any)?.default_tools)
			: null
	)
	const currentZipSignature = JSON.stringify({
		zip_agent_control_enabled: toZipPermissionValue(currentAgent?.zip_agent_control_enabled),
		zip_ai_view_mode: toZipLayoutValue(currentAgent?.zip_ai_view_mode),
		custom_tool_settings: normalizeCustomToolZipOverrides(currentAgent?.custom_tool_settings),
		non_mcp_rows: normalizeNonMcpZipOverrides(currentAgent as Record<string, any>)
	})

	const agentChanged = currentAgent?.id !== lastAgentId
	const gatewaysChanged = currentGatewaySignature !== lastGatewaySignature
	const dcmChanged = currentDcmSignature !== lastDcmSignature
	const selectionsChanged = currentToolSelectionSignature !== lastToolSelectionSignature
	const cliToolsChanged = currentCliToolSignature !== lastCliToolSignature
	const zipChanged = currentZipSignature !== lastZipSignature

	if (agentChanged || gatewaysChanged || dcmChanged || selectionsChanged || cliToolsChanged || zipChanged) {
		persistReady = false
		lastAgentId = currentAgent?.id
		lastGatewaySignature = currentGatewaySignature
		lastDcmSignature = currentDcmSignature
		lastToolSelectionSignature = currentToolSelectionSignature
		lastCliToolSignature = currentCliToolSignature
		lastZipSignature = currentZipSignature

		const defaultGateways = normalizeGatewaySelection(currentAgent?.defaultMCPGateways)
		selectedGateways = new Set(defaultGateways)
		selectedCliToolIdsExplicit =
			Array.isArray(currentAgent?.defaultTools) || Array.isArray((currentAgent as any)?.default_tools)
		selectedCliToolIds = normalizeCliToolSelections(
			currentAgent?.defaultTools ?? (currentAgent as any)?.default_tools
		)
		dcmDisplaySettings = cloneDcmDisplaySettings(extractAgentDcmDisplaySettings(currentAgent))
			zipAgentControlEnabled = toZipPermissionValue(currentAgent?.zip_agent_control_enabled)
			zipAiViewMode = toZipLayoutValue(currentAgent?.zip_ai_view_mode)
			customToolZipOverrides = normalizeCustomToolZipOverrides(currentAgent?.custom_tool_settings)
			nonMcpZipOverrides = normalizeNonMcpZipOverrides(currentAgent as Record<string, any>)
			mcpRenderNonce += 1
		clearSaveResetTimer()
		clearZipSaveResetTimer()
		saveStatus = 'idle'
		saveError = null
		zipSaveState = 'idle'
		zipSaveError = null
		onMCPsChange(defaultGateways)
		onToolSelectionsChange(normalizeToolSelections(currentAgent?.defaultMCPToolSelections))

		untrack(() => {
			for (const gatewayId of defaultGateways) {
				void fetchGatewayTools(gatewayId)
			}
		})
		persistReady = Boolean(currentAgent?.id)
	}
})

$effect(() => {
	const signature = JSON.stringify(Array.from(effectiveSelectedGatewayIds).sort())
	if (lastEffectiveGatewaySignature === signature) {
		return
	}

	lastEffectiveGatewaySignature = signature

	untrack(() => {
		for (const gatewayId of effectiveSelectedGatewayIds) {
			void fetchGatewayTools(gatewayId)
		}
	})
})

async function fetchGateways() {
	if (!userId) return

	loading = true
	error = null

	try {
		const response = await fetch(`/api/mcp/gateways?userId=${userId}&enabled=true`)
		if (!response.ok) {
			throw new Error(`Failed to load gateways: ${response.statusText}`)
		}
		const data = await response.json()
		gateways = data.gateways || []
	} catch (loadError) {
		error = loadError instanceof Error ? loadError.message : 'Failed to load gateways'
		console.error('[MCPsDropdown] Error loading gateways:', loadError)
	} finally {
		loading = false
	}

	const validIds = new Set(
		gateways.filter((gateway) => gateway.type !== 'n8n-mcp-client').map((gateway) => gateway.id)
	)
	const filteredSelection = Array.from(selectedGateways).filter((id) => validIds.has(id))
	if (filteredSelection.length !== selectedGateways.size) {
		selectedGateways = new Set(filteredSelection)
		onMCPsChange(filteredSelection)
	}
}

async function fetchCliToolCatalog() {
	if (!userId) return

	cliToolCatalogLoaded = false

	try {
		const response = await fetch('/api/cli-tools')
		if (!response.ok) {
			throw new Error(`Failed to load CLI tools: ${response.statusText}`)
		}
		const data = (await response.json()) as { tools?: CliToolCatalogRow[] }
		const nextActiveIds = new Set<string>()
		for (const tool of Array.isArray(data.tools) ? data.tools : []) {
			const toolId = normalizeCliToolId(tool?.toolId)
			if (!toolId) continue
			if ((tool.status ?? 'active') !== 'active') continue
			nextActiveIds.add(toolId)
		}
		activeCliToolIds = nextActiveIds
		cliToolCatalogLoaded = true
	} catch (loadError) {
		activeCliToolIds = new Set()
		cliToolCatalogLoaded = false
		console.warn('[MCPsDropdown] Failed to load CLI tool catalog for badge count:', loadError)
	}
}

async function refreshToolCatalogs() {
	await Promise.all([fetchGateways(), fetchCliToolCatalog()])
}

async function fetchGatewayTools(gatewayId: string) {
	if (gatewayMCPs[gatewayId] && gatewayMCPs[gatewayId] !== 'error') return

	loadingTools = { ...loadingTools, [gatewayId]: true }

	try {
		const response = await fetch(`/api/mcp/gateways/${gatewayId}/tools`)
		if (!response.ok) {
			console.error(`[MCPsDropdown] Error loading tools for gateway ${gatewayId}`)
			gatewayMCPs = { ...gatewayMCPs, [gatewayId]: 'error' }
			return
		}
		const data = await response.json()
		const filteredGroups = (data.mcps || [])
			.map((mcp: any) => ({
				...mcp,
				tools: Array.isArray(mcp?.tools)
					? mcp.tools
							.map((tool: any) => {
								const toolId = String(tool?.id ?? tool?.name ?? '').trim()
								if (!toolId || isHiddenInternalTool(toolId)) return null
								return {
									id: toolId,
									name: String(tool?.name ?? toolId).trim() || toolId,
									description: typeof tool?.description === 'string' ? tool.description : undefined
								} satisfies GatewayToolRow
							})
							.filter((tool: GatewayToolRow | null): tool is GatewayToolRow => Boolean(tool))
					: []
			}))
			.filter((mcp: any) => Array.isArray(mcp.tools) && mcp.tools.length > 0)
		gatewayMCPs = { ...gatewayMCPs, [gatewayId]: filteredGroups }
	} catch (loadError) {
		console.error(`[MCPsDropdown] Error loading tools for gateway ${gatewayId}:`, loadError)
		gatewayMCPs = { ...gatewayMCPs, [gatewayId]: 'error' }
	} finally {
		loadingTools = { ...loadingTools, [gatewayId]: false }
	}
}

let discoverableToolCount = $derived.by(() => {
	if (!nativeDynamicMcpEnabled) return 0
	let count = 0
	for (const gatewayId of effectiveSelectedGatewayIds) {
		const groups = gatewayMCPs[gatewayId]
		if (!Array.isArray(groups)) continue
		for (const group of groups) {
			const agentGroupMode = getGroupMode(gatewayId, group.name)
			const groupMode = resolveEffectiveGroupMode(gatewayId, group.name, agentGroupMode)
			if (groupMode === 'hidden') continue
			for (const tool of group.tools) {
				if (isMcpToolDiscoverable(gatewayId, group.name, tool.id)) {
					count += 1
				}
			}
		}
	}
	return count
})

let cliToolCount = $derived.by(() => {
	if (!nativeCliToolsEnabled || !cliToolCatalogLoaded) return 0
	const selectedIds = selectedCliToolIdsExplicit
		? selectedCliToolIds
		: globalCliToolGridSettings.discoverableToolIds
	if (!Array.isArray(selectedIds)) return 0
	const discoverableIds = new Set<string>()
	for (const entry of selectedIds) {
		const toolId = normalizeCliToolId(entry)
		if (toolId && activeCliToolIds.has(toolId) && isCliToolDiscoverable(toolId)) {
			discoverableIds.add(toolId)
		}
	}
	return discoverableIds.size
})
let totalToolsSelected = $derived(discoverableToolCount + cliToolCount)
let contextBadgeTitle = $derived(totalToolsSelected > 0 ? `${totalToolsSelected} tools configured` : undefined)
</script>

<DropdownMenu.Root bind:open={isOpen}>
	<DropdownMenu.Trigger
		class="batshit-settings-icon-trigger relative"
		aria-label="Tools"
		title="Tools"
		data-testid="tools-button"
		data-ab-control="tools"
	>
		<Wrench class="h-4 w-4" />
		{#if totalToolsSelected > 0}
			<Badge
					class="batshit-settings-count-badge"
					variant="secondary"
					title={contextBadgeTitle}
				>
					{totalToolsSelected}
				</Badge>
		{/if}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		align="start"
		class="mcp-tools-dropdown-content batshit-settings-sheet"
		forceMount={true}
	>
		<div
			class={`mcp-tools-dropdown-scroll ${!loading && !error && interactiveGateways.length > 0 ? 'is-tool-grid-shell' : ''}`}
			use:closeOnDropdownBackdropPointerDown
		>
				{#if loading}
					<div class="mcp-tools-dropdown-state batshit-settings-caption">Loading gateways...</div>
				{:else if error}
					<div class="mcp-tools-dropdown-state batshit-settings-form-help is-danger">
						<p>Error: {error}</p>
						<Button variant="outline" size="sm" onclick={refreshToolCatalogs} class="mt-2"><RefreshCcw aria-hidden="true" />Retry</Button>
					</div>
				{:else if interactiveGateways.length === 0}
					<div class="mcp-tools-dropdown-state batshit-settings-caption">
						No MCP gateways available.
					</div>
				{:else}
					<AgentMcpDefaultsCard
						agentId={currentAgent?.id ?? null}
						agentType={normalizePrimaryAgentType(currentAgent)}
						userId={userId ?? null}
						defaultMCPGateways={Array.from(selectedGateways)}
						defaultMCPToolSelections={normalizeToolSelections(currentAgent?.defaultMCPToolSelections)}
						defaultCliToolIds={selectedCliToolIds}
						cliToolIdsExplicit={selectedCliToolIdsExplicit}
						dcmDisplaySettings={dcmDisplaySettings}
						mcpSaveState={saveStatus === 'error' ? 'idle' : saveStatus}
						mcpSaveError={saveStatus === 'error' ? saveError : null}
						mcpLastSaved={mcpLastSaved}
						mcpRenderNonce={mcpRenderNonce}
						nativeDynamicMcpEnabled={nativeDynamicMcpEnabled}
						nativeCliToolsEnabled={nativeCliToolsEnabled}
						isCodexMode={isCliPrimaryAgentType(normalizePrimaryAgentType(currentAgent))}
						onGatewaysChange={handleMcpGatewaysChange}
						onDcmDisplaySettingsChange={handleMcpDcmDisplaySettingsChange}
						onCliToolIdsChange={handleCliToolSelectionsChange}
						getToolZipOverride={getToolZipOverride}
						onToolZipOverrideChange={handleMcpToolZipOverrideChange}
						showZipControls={true}
						showCardHeader={false}
						showZipModeControls={false}
						showPostTableControls={false}
						showGridIntroBlock={false}
						fullWidthTable={true}
						compactDropdownMode={true}
						defaultOpen={true}
						cardCollapsible={false}
						zipAgentControlEnabled={zipAgentControlEnabled}
						zipAiViewMode={zipAiViewMode}
						nonMcpZipRows={NON_MCP_ZIP_ROW_ORDER}
						getNonMcpZipOverride={getNonMcpZipOverrideById}
						onNonMcpZipOverrideChange={handleNonMcpZipOverrideChangeById}
						onZipAgentControlChange={handleZipAgentControlChange}
						onZipAiViewModeChange={handleZipAiViewModeChange}
						zipSaveState={zipSaveState}
						zipSaveError={zipSaveError}
						zipValidationError={null}
						zipLastSaved={zipLastSaved}
					/>
				{/if}

			{#if syntheticGateways.length > 0}
				<div class="batshit-settings-card-subtle-frame is-compact mt-3 space-y-2">
					<div class="batshit-settings-section-title">
						Detected MCP Client Nodes
					</div>
					<div class="batshit-settings-caption">
						These are MCP Client nodes connected directly to your AI Agent node in n8n. Manage
						them in n8n or create an MCP Server Trigger for Batshit management.
					</div>
					<div class="space-y-2">
						{#each syntheticGateways as gateway}
							<div class="batshit-settings-note is-dashed">
								{#if gateway.metadata?.nodeName}
									<div>Node: <span class="batshit-settings-form-label">{gateway.metadata.nodeName}</span></div>
								{/if}
								{#if gateway.url}
									<div class="truncate">Server: {gateway.url}</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>

	</DropdownMenu.Content>
</DropdownMenu.Root>

<style>
	:global(.mcp-tools-dropdown-content) {
		display: flex;
		width: min(780px, calc(100vw - 1.5rem));
		max-width: calc(100vw - 1.5rem);
		max-height: 640px;
		flex-direction: column;
		overflow: hidden;
		z-index: var(--z-popover);
		border: 0;
		border-radius: var(--bs-settings-radius-lg);
		background: transparent;
		padding: 0;
		box-shadow: 0 16px 36px color-mix(in oklch, black 42%, transparent);
	}

	:global(.mcp-tools-dropdown-content[data-state='closed']) {
		display: none;
		pointer-events: none;
	}

	.mcp-tools-dropdown-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 0;
	}

	.mcp-tools-dropdown-scroll.is-tool-grid-shell {
		min-height: 0;
	}

	:global(.mcp-tools-dropdown-content .batshit-settings-table-frame.is-chatbar-tool-grid) {
		border-color: var(--bs-app-popover-line, oklch(0.64 0.022 282 / 0.2));
	}

	.mcp-tools-dropdown-state {
		border: 1px solid var(--bs-settings-card-rim);
		border-radius: var(--bs-settings-radius-lg);
		background: var(--bs-settings-accordion-content);
		padding: 1rem;
		text-align: center;
	}
</style>
