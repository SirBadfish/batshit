<script lang="ts">
	/**
	 * Gateway Card Component (Svelte 5)
	 * Story 5.22: Type-agnostic gateway display
	 *
	 * Displays Docker Gateway, n8n MCP Trigger, or any gateway type
	 * CRITICAL: Uses Svelte 5 runes ($state, $props, $derived)
	 */
	import { Button } from '$lib/components/ui/button'
	import * as Card from '$lib/components/ui/card'
	import { Badge } from '$lib/components/ui/badge'
	import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
	import { DEFAULT_MCP_GATEWAY_ICON_REF } from '$lib/icons/iconCatalog'
	import { normalizeIconRef } from '$lib/icons/iconLegacy'
	import {
		CheckCircle, AlertCircle, Loader2, Settings,
		RefreshCw, Trash2, ExternalLink
	} from '@lucide/svelte'
	import type { MCPGateway } from '$lib/types/database'
	import { toast } from 'svelte-sonner'

	interface Props {
		gateway: MCPGateway
		viewMode?: 'grid' | 'list'
		onEdit?: () => void
		onDelete?: () => void
		onTest?: () => void
		onRefresh?: () => void
    showFooterActions?: boolean
    showHeaderRefresh?: boolean
	}

	let {
		gateway,
		viewMode = 'grid',
		onEdit = () => {},
		onDelete = () => {},
		onTest = () => {},
		onRefresh = () => {},
    showFooterActions = true,
    showHeaderRefresh = false
	}: Props = $props()

	// Local state
	let showTools = $state(false)
	let refreshing = $state(false)

	let gatewayIconRef = $derived.by(() => normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF))

	// Get type display name
	        let typeDisplay = $derived.by(() => {
	                switch (gateway.type) {
	                        case 'docker-catalog':
	                                return 'Docker Catalog'
	                        case 'n8n-mcp-trigger':
	                                return 'n8n MCP Trigger'
	                        case 'n8n-instance-mcp':
	                                return 'n8n Instance MCP'
	                        case 'stdio':
	                                return 'STDIO MCP'
	                        case 'n8n-mcp-client':
	                                return 'n8n MCP Client node'
	                        case 'custom':
	                                return 'Custom Gateway'
	                        default:
	                                return gateway.type
	                }
	        })

        let readOnly = $derived(gateway.type === 'n8n-mcp-client')

	// Status color
let statusColor = $derived.by(() => {
	if (!gateway.enabled) return 'text-gray-400'
	if (gateway.type === 'stdio' && gateway.stdioConfig?.lastTestStatus === 'failed') {
		return 'text-red-500'
	}

	// Could enhance with actual health check status
	return 'batshit-success-text'
})

let stdioCommand = $derived.by(() => {
	if (gateway.type !== 'stdio') return null
	const command = gateway.stdioConfig?.command?.trim() || ''
	if (!command) return null
	const args = Array.isArray(gateway.stdioConfig?.args) ? gateway.stdioConfig?.args.filter(Boolean) : []
	return [command, ...args].join(' ')
})

let stdioStatus = $derived.by(() => {
	if (gateway.type !== 'stdio') return null
	switch (gateway.stdioConfig?.lastTestStatus) {
		case 'passed':
			return 'Last test passed'
		case 'failed':
			return gateway.stdioConfig?.lastError?.trim() || 'Last test failed'
		default:
			return 'Not tested yet'
	}
})

// Tool metadata helpers
let metadata = $derived.by(() => (gateway?.metadata && typeof gateway.metadata === 'object')
	? gateway.metadata as Record<string, any>
	: {}
)
let workflowName = $derived.by(() => {
	const meta = metadata
	return typeof meta.workflowName === 'string' ? meta.workflowName : undefined
})
let nodeName = $derived.by(() => {
	const meta = metadata
	return typeof meta.nodeName === 'string' ? meta.nodeName : undefined
})
let toolNamesFromMetadata = $derived.by(() => {
	const meta = metadata
	return Array.isArray(meta.toolNames) ? meta.toolNames as string[] : undefined
})

// Tool count
let toolCount = $derived.by(() => {
	const discovered = gateway.discoveredTools?.length || 0
	const fromMetadata = toolNamesFromMetadata?.length || 0
	const stdioCount = gateway.type === 'stdio' ? gateway.stdioConfig?.toolCount || 0 : 0
	return Math.max(discovered, fromMetadata, stdioCount)
})

let effectiveToolList = $derived.by(() => {
	const fromMetadata = toolNamesFromMetadata
	if (fromMetadata && fromMetadata.length > 0) {
		return fromMetadata
	}
	return gateway.discoveredTools || []
})

	// Last discovery formatted
	let lastDiscoveryFormatted = $derived.by(() => {
		if (!gateway.lastDiscovery) return 'Never'

		const date = new Date(gateway.lastDiscovery)
		const now = new Date()
		const diffMs = now.getTime() - date.getTime()
		const diffMins = Math.floor(diffMs / 60000)

		if (diffMins < 1) return 'Just now'
		if (diffMins < 60) return `${diffMins}m ago`
		if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`
		return `${Math.floor(diffMins / 1440)}d ago`
	})

	// Handle refresh
	async function handleRefresh() {
		refreshing = true
		try {
			await onRefresh()
		} finally {
			refreshing = false
		}
	}
</script>

{#if viewMode === 'grid'}
	<!-- Grid View Card -->
	<Card.Root class="batshit-settings-display-card">
		{#if !readOnly}
			<Card.Header>
				<div class="flex items-start justify-between">
					<div class="flex items-center gap-2 flex-1 min-w-0">
						<IconRenderer
							ref={gatewayIconRef}
							label={gateway.name}
							class="h-5 w-5 flex-shrink-0"
							iconClass="h-5 w-5 text-muted-foreground"
							imageClass="h-5 w-5 object-contain"
						/>
						<div class="min-w-0 flex-1">
							<Card.Title class="text-base truncate">{gateway.name}</Card.Title>
							<Card.Description class="batshit-settings-form-label">
								<Badge variant="outline" class="text-xs mt-1">
									{typeDisplay}
								</Badge>
							</Card.Description>
						</div>
					</div>
          <div class="flex items-center gap-2">
            {#if gateway.enabled && !(gateway.type === 'stdio' && gateway.stdioConfig?.lastTestStatus === 'failed')}
              <CheckCircle class="h-4 w-4 {statusColor} flex-shrink-0" />
            {:else}
              <AlertCircle class="h-4 w-4 {gateway.enabled ? statusColor : 'text-gray-400'} flex-shrink-0" />
            {/if}
            {#if showHeaderRefresh}
              <Button
                variant="outline"
                size="icon"

                onclick={handleRefresh}
                disabled={refreshing || !gateway.enabled}
                title="Refresh MCP source"
              >
                <RefreshCw class={refreshing ? 'animate-spin' : ''} />
              </Button>
            {/if}
          </div>
				</div>
			</Card.Header>
		{:else}
			<!-- Simplified header for n8n-mcp-client -->
			<Card.Header>
				<div class="flex items-center gap-2">
					<IconRenderer
						ref={gatewayIconRef}
						label={gateway.name}
						class="h-5 w-5 flex-shrink-0"
						iconClass="h-5 w-5 text-muted-foreground"
						imageClass="h-5 w-5 object-contain"
					/>
					<Badge variant="outline" class="batshit-settings-form-label">
						{typeDisplay}
					</Badge>
				</div>
			</Card.Header>
		{/if}

		<Card.Content class="space-y-3">
			{#if readOnly}
				<!-- Simplified view for n8n-mcp-client -->
				<div class="rounded-md border border-dashed border-muted-foreground/30 bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
					<div class="batshit-settings-inline-strong is-primary">
						Detected MCP Client Node
					</div>
					{#if workflowName || nodeName}
						<div class="mt-1 space-y-1">
							{#if workflowName}
								<div>Agent: <span class="batshit-settings-inline-strong">{workflowName}</span></div>
							{/if}
							{#if nodeName}
								<div>Node: <span class="batshit-settings-inline-strong">{nodeName}</span></div>
							{/if}
						</div>
					{/if}
					{#if gateway.url}
						<div class="mt-1 truncate">
							<ExternalLink class="inline h-3 w-3 mr-1" />
							{gateway.url}
						</div>
					{/if}
					<div class="mt-1">
						Managed inside n8n. Displayed here for awareness only.
					</div>
				</div>
			{:else}
				<!-- Gateway URL -->
				{#if gateway.url}
					<div class="text-xs text-muted-foreground truncate">
						<ExternalLink class="inline h-3 w-3 mr-1" />
						{gateway.url}
					</div>
				{:else if stdioCommand}
					<div class="text-xs text-muted-foreground truncate">
						{stdioCommand}
					</div>
				{/if}

				{#if stdioStatus}
					<div class="batshit-settings-form-label">
						{stdioStatus}
					</div>
				{/if}

				<!-- Stats -->
				<div class="flex items-center gap-4 text-sm">
					<div>
						<span class="batshit-settings-inline-strong">{toolCount}</span>
						<span class="text-muted-foreground ml-1">tools</span>
					</div>
					{#if gateway.lastDiscovery}
						<div class="batshit-settings-form-label">
							Updated {lastDiscoveryFormatted}
						</div>
					{/if}
				</div>

				<!-- Tools List (Expandable) -->
				{#if toolCount > 0}
					<div class="pt-2 border-t">
						<Button
							variant="ghost"
							size="sm"
						 class="batshit-button-full batshit-button-align-start"
							onclick={() => showTools = !showTools}
						>
							<span class="batshit-settings-form-label">
								{showTools ? 'Hide' : 'Show'} {toolCount} tool{toolCount !== 1 ? 's' : ''}
							</span>
						</Button>

						{#if showTools}
							<div class="mt-2 pl-2 space-y-1 max-h-40 overflow-y-auto">
								{#each effectiveToolList as tool}
									<div class="batshit-settings-form-label">• {tool}</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			{/if}
		</Card.Content>

                {#if showFooterActions}
                <Card.Footer class="flex gap-2">
                        {#if readOnly}
                                <div class="text-xs text-muted-foreground px-1 py-2">
                                        Auto-discovered from n8n workflow
                                </div>
                        {:else}
                                <Button
                                        variant="outline"
                                        size="sm"
                                        onclick={onEdit}
                                        class="batshit-button-flex"
                                >
                                        <Settings  />
                                        Settings
                                </Button>

                                <Button
                                        variant="outline"
                                        size="sm"
                                        onclick={handleRefresh}
                                        disabled={refreshing || !gateway.enabled}
                                >
                                        <RefreshCw class={refreshing ? 'animate-spin' : ''} />
                                </Button>

                                <Button
                                        variant="outline"
                                        size="sm"
                                        onclick={onDelete}

                                >
                                        <Trash2  />
                                </Button>
                        {/if}
                </Card.Footer>
                {/if}
	</Card.Root>
{:else}
	<!-- List View -->
	<div class="flex items-center gap-4 p-4 border rounded-lg hover:border-primary transition-colors">
		{#if readOnly}
			<!-- Simplified list view for n8n-mcp-client -->
			<div class="flex items-center gap-3 flex-1 min-w-0">
				<IconRenderer
					ref={gatewayIconRef}
					label={gateway.name}
					class="h-5 w-5 flex-shrink-0"
					iconClass="h-5 w-5 text-muted-foreground"
					imageClass="h-5 w-5 object-contain"
				/>
				<Badge variant="outline" class="flex-shrink-0">
					{typeDisplay}
				</Badge>
			</div>

			<!-- Metadata -->
			<div class="text-xs text-muted-foreground flex-shrink-0 px-2 text-left">
				<div class="batshit-settings-inline-strong is-primary">Detected MCP Client Node</div>
				{#if workflowName}
					<div>Agent: <span class="batshit-settings-inline-strong">{workflowName}</span></div>
				{/if}
				{#if nodeName}
					<div>Node: <span class="batshit-settings-inline-strong">{nodeName}</span></div>
				{/if}
				{#if gateway.url}
					<div class="truncate" style="max-width: 300px;">
						<ExternalLink class="inline h-3 w-3 mr-1" />
						{gateway.url}
					</div>
				{/if}
				<div>Managed inside n8n</div>
			</div>
		{:else}
			<!-- Standard list view for regular gateways -->
			<!-- Icon & Name -->
			<div class="flex items-center gap-3 flex-1 min-w-0">
				<IconRenderer
					ref={gatewayIconRef}
					label={gateway.name}
					class="h-5 w-5 flex-shrink-0"
					iconClass="h-5 w-5 text-muted-foreground"
					imageClass="h-5 w-5 object-contain"
				/>
				<div class="min-w-0 flex-1">
					<div class="batshit-settings-inline-strong truncate">{gateway.name}</div>
					<div class="text-sm text-muted-foreground truncate">{gateway.url || stdioCommand || typeDisplay}</div>
				</div>
			</div>

			<!-- Type Badge -->
			<Badge variant="outline" class="flex-shrink-0">
				{typeDisplay}
			</Badge>

			<!-- Tool Count -->
			<div class="text-sm text-muted-foreground flex-shrink-0 w-20 text-center">
				{toolCount} tool{toolCount !== 1 ? 's' : ''}
			</div>

			<!-- Status -->
			<div class="flex-shrink-0">
				{#if gateway.enabled && !(gateway.type === 'stdio' && gateway.stdioConfig?.lastTestStatus === 'failed')}
					<CheckCircle class="h-4 w-4 {statusColor}" />
				{:else}
					<AlertCircle class="h-4 w-4 {gateway.enabled ? statusColor : 'text-gray-400'}" />
				{/if}
			</div>

			<!-- Actions -->
			<div class="flex gap-2 flex-shrink-0">
				<Button variant="outline" size="sm" onclick={onEdit}>
					<Settings  />
				</Button>
				<Button variant="outline" size="sm" onclick={handleRefresh} disabled={refreshing || !gateway.enabled}>
					<RefreshCw class={refreshing ? 'animate-spin' : ''} />
				</Button>
				<Button variant="outline" size="sm" onclick={onDelete} class="is-danger">
					<Trash2  />
				</Button>
			</div>
		{/if}
	</div>
{/if}
