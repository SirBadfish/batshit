<script lang="ts">
	/**
	 * n8n MCP Trigger Gateway Form (Svelte 5)
	 * Story 5.22: Allows users to add n8n MCP Trigger gateways
	 *
	 * CRITICAL: Uses Svelte 5 runes ($state, $props, $effect)
	 * Pattern: Follows standard dialog pattern used across settings sheets
	 */
	import * as Dialog from '$lib/components/ui/dialog'
	import {
  Button } from '$lib/components/ui/button'
	import { Input } from '$lib/components/ui/input'
	import { Label } from '$lib/components/ui/label'
	import IconPicker from '$lib/components/icons/IconPicker.svelte'
	import type { IconRef } from '$lib/icons/iconTypes'
	import { Loader2,
  X
} from '@lucide/svelte'
	import { toast } from 'svelte-sonner'

	interface Props {
		open?: boolean
		onOpenChange?: (open: boolean) => void
		onSuccess?: () => void
		userId?: string
		gatewayType?: 'n8n-mcp-trigger' | 'n8n-instance-mcp'
	}

	let {
		open = false,
		onOpenChange = () => {},
		onSuccess = () => {},
		userId,
		gatewayType = 'n8n-mcp-trigger'
	}: Props = $props()

	const title = $derived(gatewayType === 'n8n-instance-mcp' ? 'Add n8n Instance MCP Gateway' : 'Add n8n MCP Trigger Gateway')
	const description = $derived(
		gatewayType === 'n8n-instance-mcp'
			? 'Connect to the n8n instance-level MCP server (workflows marked "Available in MCP").'
			: 'Connect to an n8n workflow with an MCP Server Trigger node to expose tools.'
	)
	const N8N_INSTANCE_MCP_URL = 'http://localhost:5678/mcp-server/http'

	// Form state using $state
	let name = $state('')
	let url = $state('')
	let iconRef = $state<IconRef>({ kind: 'brand', slug: 'n8n-color' })
	let submitting = $state(false)

	// Reset form when dialog opens
	$effect(() => {
		if (open) {
			name = ''
			url = gatewayType === 'n8n-instance-mcp' ? N8N_INSTANCE_MCP_URL : 'http://localhost:5678/mcp/'
			iconRef = { kind: 'brand', slug: 'n8n-color' }
		}
	})

	// Validate form
	let isValid = $derived.by(() => {
		if (!name.trim()) return false
		if (!url.trim()) return false

		// Basic URL validation
		try {
			new URL(url)
			return true
		} catch {
			return false
		}
	})

	// Handle form submission
	async function handleSubmit() {
		if (!isValid || !userId) {
			toast.error('Please fill in all required fields')
			return
		}

		submitting = true
		try {
		const response = await fetch('/api/mcp/gateways', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				userId,
				name: name.trim(),
				type: gatewayType,
				icon_ref: iconRef,
				url: url.trim(),
				enabled: true
			})
		})

			if (!response.ok) {
				const error = await response.json()
				throw new Error(error.error || 'Failed to create gateway')
			}

		toast.success(`${gatewayType === 'n8n-instance-mcp' ? 'n8n Instance MCP' : 'n8n MCP Trigger'} gateway added successfully`)
			onOpenChange(false)
			onSuccess()
		} catch (error) {
			console.error('[N8nGatewayForm] Error creating gateway:', error)
			toast.error(error instanceof Error ? error.message : 'Failed to add gateway')
		} finally {
			submitting = false
		}
	}

	// Handle cancel
	function handleCancel() {
		onOpenChange(false)
	}
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
	<Dialog.Content class="batshit-settings-dialog sm:max-w-[525px]">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>
				{description}
			</Dialog.Description>
		</Dialog.Header>

		<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-4 py-4">
			<!-- Gateway Name -->
			<div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
				<div class="space-y-2">
					<Label for="gateway-name">
						Gateway Name <span class="batshit-settings-required-marker">*</span>
					</Label>
					<Input
						id="gateway-name"
						type="text"
						placeholder="e.g., Code Tools, Research Tools"
						bind:value={name}
						disabled={submitting}
						required
					/>
					<p class="batshit-settings-form-help">
						A descriptive name for this collection of MCPs
					</p>
				</div>
				<div class="space-y-2">
					<Label>Icon</Label>
					<IconPicker bind:value={iconRef} disabled={submitting} triggerLabel="Choose Icon" onlineSearchHint={name} />
				</div>
			</div>

			<!-- Gateway URL -->
			<div class="space-y-2">
				<Label for="gateway-url">
					MCP Endpoint URL <span class="batshit-settings-required-marker">*</span>
				</Label>
				<Input
					id="gateway-url"
					type="text"
					placeholder={gatewayType === 'n8n-instance-mcp' ? N8N_INSTANCE_MCP_URL : 'http://localhost:5678/mcp/your-path'}
					bind:value={url}
					disabled={submitting}
					required
				/>
				<p class="batshit-settings-form-help">
					{gatewayType === 'n8n-instance-mcp'
						? 'The instance-wide MCP endpoint (Admin → Settings → MCP).'
						: 'The MCP endpoint URL from your n8n MCP Server Trigger node'}
				</p>
			</div>

			{#if gatewayType === 'n8n-instance-mcp'}
				<p class="batshit-settings-caption">
					Auth tokens are managed in <span class="batshit-settings-form-label">Settings → API Keys</span> (n8n Instance MCP Token).
				</p>
			{/if}

			<!-- Help Text -->
			<div class="batshit-settings-note">
				<p class="batshit-settings-form-label">Setup Instructions:</p>
				{#if gatewayType === 'n8n-instance-mcp'}
					<ol class="list-decimal list-inside space-y-1">
						<li>In n8n, enable the instance MCP server and generate a token.</li>
						<li>Mark workflows as "Available in MCP" to expose them.</li>
						<li>Paste the instance MCP URL (e.g., /mcp-server/http) here.</li>
					</ol>
				{:else}
					<ol class="list-decimal list-inside space-y-1">
						<li>Create n8n workflow with MCP Server Trigger node</li>
						<li>Set custom path (e.g., "code-tools")</li>
						<li>Add MCP Client nodes for your tools</li>
						<li>Copy the MCP endpoint URL to this form</li>
					</ol>
				{/if}
			</div>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={handleCancel}
					disabled={submitting}
				>
					<X aria-hidden="true" />
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={!isValid || submitting}
				>
					{#if submitting}
						<Loader2 class="animate-spin" />
						Adding...
					{:else}
						Add Gateway
					{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
