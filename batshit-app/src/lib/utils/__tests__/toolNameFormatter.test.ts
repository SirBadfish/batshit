import { describe, expect, it } from 'vitest'
import { formatToolDisplayName, stripGatewayPrefix } from '../toolNameFormatter'

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

describe('stripGatewayPrefix', () => {
	it('removes sanitized gateway prefix for display only', () => {
		expect(stripGatewayPrefix('My_Gateway_read_file', 'My Gateway')).toBe('read_file')
	})

	it('leaves name untouched when prefix missing', () => {
		expect(stripGatewayPrefix('read_file', 'OtherGateway')).toBe('read_file')
	})
})
