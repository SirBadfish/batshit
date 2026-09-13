import { describe, expect, it } from 'vitest'
import {
	formatBatshitToolTargetDisplayName,
	formatToolDisplayName,
	stripGatewayPrefix
} from '../toolNameFormatter'

/**
 * SA-118 Guard 2 (DL-118-11) — the alias rows deleted because the derivation already says
 * the same thing, with the EXACT string each one produced before it was deleted.
 *
 * Captured by running the real formatter over every alias id twice: once as shipped, once
 * with the alias lookup disabled so the prefix path answered. A row only qualified when the
 * two runs agreed. This table is what proves the deletion changed no visible name; if the
 * fallback or a prefix label is ever weakened, these go red rather than silently renaming a
 * card the user recognises.
 */
const DELETED_ALIAS_ROWS: ReadonlyArray<readonly [string, string]> = [
	['sys.artifact.create', 'Artifact Create'],
	['sys.artifact.list', 'Artifact List'],
	['sys.artifact.update', 'Artifact Edit'],
	['sys.artifact.publish', 'Artifact Publish'],
	['sys.artifact.rollback', 'Artifact Rollback'],
	['sys.artifact.analyze_url', 'Artifact Analyze URL'],
	['sys.comfyui.workflows', 'ComfyUI Workflows'],
	['sys.comfyui.object_info', 'ComfyUI Object Info'],
	['sys.model_catalog.search', 'Model Catalog Search'],
	['sys.dm.send', 'Agent DM Send'],
	['sys.dm.read', 'Agent DM Read'],
	['sys.dm.claim', 'Agent DM Claim'],
	['sys.dm.done', 'Agent DM Done'],
	['sys.dm.blocked', 'Agent DM Blocked'],
	['sys.schedule.list', 'Schedule List'],
	['sys.schedule.create', 'Schedule Create'],
	['sys.schedule.delete', 'Schedule Delete']
]

describe('formatToolDisplayName', () => {
	it('uses current product labels for first-party tool aliases', () => {
		expect(formatToolDisplayName('batshit_server_read_file')).toBe('Read File')
		expect(formatToolDisplayName('batshit-server Execute Command')).toBe('Bash')
		expect(formatToolDisplayName('batshit_server_bash_execute')).toBe('Bash')
		expect(formatToolDisplayName('native_bash_execute')).toBe('Bash')
		expect(formatToolDisplayName('batshit_server_dynamic_mcp_use')).toBe('MCP Tool')
		expect(formatToolDisplayName('native_cli_tool_find')).toBe('Dynamic Tool Search')
		expect(formatToolDisplayName('runtime_addon_prepare')).toBe('Runtime Add-on Prepare')
		expect(formatToolDisplayName('runtime_addon_start')).toBe('Runtime Add-on Start')
	})

	it('formats Batshit Fabric and artifact refs as human tool labels', () => {
		expect(formatToolDisplayName('fabric:sys.artifact.create')).toBe('Artifact Create')
		expect(formatToolDisplayName('sys.artifact.apply_patch')).toBe('Artifact Edit')
		expect(formatToolDisplayName('fabric:sys.artifact.run_logs.get')).toBe('Artifact Logs')
		expect(formatToolDisplayName('fabric:sys.model_catalog.search')).toBe('Model Catalog Search')
		expect(formatToolDisplayName('fabric:sys.zip.fetch')).toBe('Fetch Zip')
		expect(formatToolDisplayName('fabric:sys.comfyui.workflows')).toBe('ComfyUI Workflows')
		expect(formatToolDisplayName('fabric:sys.comfyui.object_info')).toBe('ComfyUI Object Info')
		expect(formatToolDisplayName('artifact:use.artifact.nano_banana_2')).toBe('Artifact Run')
		expect(formatToolDisplayName('fabric:sys.cli_tool.list')).toBe('CLI Tool List')
	})

	it('keeps Batshit branding lowercase for unknown names', () => {
		expect(formatToolDisplayName('BATSHIT')).toBe('batshit')
		expect(formatToolDisplayName('N8N_connector')).toBe('n8n Connector')
	})

	it('keeps MCP uppercase', () => {
		expect(formatToolDisplayName('mcp_gateway_tool')).toBe('MCP Gateway Tool')
	})

	it('title-cases other words', () => {
		expect(formatToolDisplayName('firecrawl_search')).toBe('Firecrawl Search')
		expect(formatToolDisplayName('redis-get')).toBe('Redis Get')
	})
})

describe('formatBatshitToolTargetDisplayName — SA-118 Guard 2', () => {
	it.each(DELETED_ALIAS_ROWS)('still names %s exactly as its deleted alias did', (id, expected) => {
		expect(formatBatshitToolTargetDisplayName(id)).toBe(expected)
		expect(formatToolDisplayName(`fabric:${id}`)).toBe(expected)
	})

	it('names a sys.* control that no table has ever heard of', () => {
		// The failure three stories hand-patched in a row: an unregistered family returned null,
		// null meant "not a Fabric control", and the call rendered as an untitled tool card and
		// (since SA-116) a BLANK approval card, while working perfectly on the wire.
		expect(formatBatshitToolTargetDisplayName('sys.future.thing')).toBe('Future Thing')
		expect(formatBatshitToolTargetDisplayName('fabric:sys.future.thing')).toBe('Future Thing')
		expect(formatBatshitToolTargetDisplayName('sys.weather_report.fetch_today')).toBe(
			'Weather Report Fetch Today'
		)
		// The family words go through the same casing rules as the suffix.
		expect(formatBatshitToolTargetDisplayName('sys.dm_digest.list')).toBe('DM Digest List')
	})

	it('still returns null for a target that is not a sys.* control id', () => {
		// `null` is load-bearing: it is how a CLI tool id, an MCP tool, and a plain tool name
		// say "not a Fabric control" so the caller can use its own title instead.
		expect(formatBatshitToolTargetDisplayName('cli:my-tool')).toBeNull()
		expect(formatBatshitToolTargetDisplayName('read_file')).toBeNull()
		expect(formatBatshitToolTargetDisplayName('sys.future')).toBeNull()
		expect(formatBatshitToolTargetDisplayName('sys.future.')).toBeNull()
		expect(formatBatshitToolTargetDisplayName(undefined)).toBeNull()
	})
})

describe('stripGatewayPrefix', () => {
	it('removes sanitized gateway prefix for display only', () => {
		expect(stripGatewayPrefix('My_Gateway_read_file', 'My Gateway')).toBe('read_file')
	})

	it('leaves name untouched when prefix missing', () => {
		expect(stripGatewayPrefix('read_file', 'OtherGateway')).toBe('read_file')
	})
})
