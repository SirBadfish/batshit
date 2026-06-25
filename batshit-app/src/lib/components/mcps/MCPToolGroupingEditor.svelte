<script lang="ts">
	/**
	 * MCP Tool Grouping Editor (Transfer List Pattern)
	 * Story 5.23: Direct tool-to-group assignment for n8n MCP Trigger Gateways
	 *
	 * CRITICAL: Uses Svelte 5 runes ($state, $props, $derived)
	 *
	 * UI Pattern: Transfer List
	 * - Left: Available tools (checkboxes, preserves natural order)
	 * - Right: Preview of selected group's tools
	 * - Controls: Add/Remove buttons, Group selector dropdown
	 */
	import {
  Button } from '$lib/components/ui/button'
	import { Label } from '$lib/components/ui/label'
	import { Input } from '$lib/components/ui/input'
	import { Checkbox } from '$lib/components/ui/checkbox'
	import { Card } from '$lib/components/ui/card'
	import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
	import IconPicker from '$lib/components/icons/IconPicker.svelte'
	import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
	import { DEFAULT_MCP_GROUP_ICON_REF } from '$lib/icons/iconCatalog'
	import { normalizeIconRef } from '$lib/icons/iconLegacy'
	import { ArrowLeft,
  Check,
  Plus,
  Trash2,
  X
} from '@lucide/svelte'
	import type { IconRef } from '$lib/icons/iconTypes'
	import type { MCPToolGrouping } from '$lib/types/database'

	interface Props {
		availableTools: string[]  // All tools from gateway (preserves order!)
		groupings: MCPToolGrouping[]
		onChange: (newGroupings: MCPToolGrouping[]) => void
		toolMetadata?: Record<string, { mcpName?: string }>
		showNewGroupInput?: boolean
	}

	let {
		availableTools = [],
		groupings = [],
		onChange,
		toolMetadata = {},
		showNewGroupInput = $bindable(false)
	}: Props = $props()

	// Local state for UI interactions
	let selectedToolIds = $state<string[]>([]) // Use array instead of Set for better reactivity
	let selectedAssignedToolIds = $state<string[]>([])
	let selectedGroupIndex = $state<number | null>(null)
	let newGroupName = $state('')

	// Reactive count of selected tools
	let selectedToolCount = $derived(selectedToolIds.length)

	// Currently selected group
	let selectedGroup = $derived.by(() => {
		if (selectedGroupIndex === null || !groupings[selectedGroupIndex]) {
			return null
		}
		return groupings[selectedGroupIndex]
	})

	// Tools that are already assigned to groups
	let assignedTools = $derived.by(() => {
		const assigned = new Set<string>()
		for (const group of groupings) {
			for (const toolId of group.toolIds) {
				assigned.add(toolId)
			}
		}
		return assigned
	})

	// Unassigned tools (not in any group)
	let unassignedTools = $derived.by(() => {
		return availableTools.filter(toolId => !assignedTools.has(toolId))
	})

	// Tools in the selected group
	let selectedGroupTools = $derived.by(() => {
		if (!selectedGroup) return []
		return selectedGroup.toolIds
	})

	// Check if all unassigned tools are selected
	let allUnassignedSelected = $derived.by(() => {
		if (unassignedTools.length === 0) return false
		return unassignedTools.every(toolId => selectedToolIds.includes(toolId))
	})

	let selectedAssignedToolCount = $derived(selectedAssignedToolIds.length)

	let allAssignedSelected = $derived.by(() => {
		if (selectedGroupTools.length === 0) return false
		return selectedGroupTools.every(toolId => selectedAssignedToolIds.includes(toolId))
	})

	let needsGroupSelectionHint = $derived(selectedToolCount > 0 && !selectedGroup)

	$effect(() => {
		const currentGroupTools = new Set(selectedGroupTools)
		const nextSelectedAssignedToolIds = selectedAssignedToolIds.filter((toolId) => currentGroupTools.has(toolId))
		if (nextSelectedAssignedToolIds.length !== selectedAssignedToolIds.length) {
			selectedAssignedToolIds = nextSelectedAssignedToolIds
		}
	})

	// Toggle tool selection
		function toggleToolSelection(toolId: string) {
			if (selectedToolIds.includes(toolId)) {
				selectedToolIds = selectedToolIds.filter(id => id !== toolId)
			} else {
				selectedToolIds = [...selectedToolIds, toolId]
			}
		}

	// Select all unassigned tools
	function selectAllUnassigned() {
		selectedToolIds = [...unassignedTools]
	}

	// Clear all selections
	function clearSelection() {
		selectedToolIds = []
	}

	function toggleAssignedToolSelection(toolId: string) {
		if (selectedAssignedToolIds.includes(toolId)) {
			selectedAssignedToolIds = selectedAssignedToolIds.filter(id => id !== toolId)
		} else {
			selectedAssignedToolIds = [...selectedAssignedToolIds, toolId]
		}
	}

	function selectAllAssigned() {
		selectedAssignedToolIds = [...selectedGroupTools]
	}

	function clearAssignedSelection() {
		selectedAssignedToolIds = []
	}

	// Add selected tools to current group
	function addToGroup() {
		if (!selectedGroup || selectedToolCount === 0) return

		const newGroupings = [...groupings]
		const groupToUpdate = newGroupings[selectedGroupIndex!]

		// Add selected tools to group (preserve order from availableTools)
		groupToUpdate.toolIds = [...groupToUpdate.toolIds, ...selectedToolIds]

		// Clear selection
		selectedToolIds = []

		onChange(newGroupings)
	}

	function removeFromGroup() {
		if (!selectedGroup || selectedAssignedToolCount === 0) return

		const newGroupings = [...groupings]
		const groupToUpdate = newGroupings[selectedGroupIndex!]

		groupToUpdate.toolIds = groupToUpdate.toolIds.filter(id => !selectedAssignedToolIds.includes(id))
		selectedAssignedToolIds = []

		onChange(newGroupings)
	}

	// Create new group
	function createGroup() {
		if (!newGroupName.trim()) return

		const newGroup: MCPToolGrouping = {
			mcpName: newGroupName.trim(),
			toolIds: []
		}

		const newGroupings = [...groupings, newGroup]
		const newIndex = newGroupings.length - 1

		// Reset input
		newGroupName = ''
		showNewGroupInput = false
		selectedAssignedToolIds = []

		// Update groupings
		onChange(newGroupings)

			// Select the new group after a tick to ensure parent has updated groupings prop
			setTimeout(() => {
				selectedGroupIndex = newIndex
			}, 0)
		}

	// Delete group (moves tools back to unassigned)
	function deleteGroup(index: number) {
		const newGroupings = groupings.filter((_, i) => i !== index)

		// Deselect if this was selected
		if (selectedGroupIndex === index) {
			selectedGroupIndex = null
		} else if (selectedGroupIndex !== null && selectedGroupIndex > index) {
			selectedGroupIndex = selectedGroupIndex - 1
		}

		onChange(newGroupings)
	}

	function selectGroup(index: number) {
		selectedGroupIndex = index
	}

	function getGroupIconRef(group: MCPToolGrouping) {
		return normalizeIconRef(group.icon_ref, DEFAULT_MCP_GROUP_ICON_REF)
	}

	function updateGroupIcon(index: number, iconRef: IconRef) {
		const newGroupings = groupings.map((group, groupIndex) =>
			groupIndex === index ? { ...group, icon_ref: iconRef } : group
		)
		onChange(newGroupings)
	}
</script>

<div class="space-y-4">
	<!-- Groups Management -->
	<div class="space-y-2">
		<!-- Existing groups -->
		{#if groupings.length === 0}
			<div class="batshit-settings-note is-centered">
				No groups created yet. Use “Add MCP Group” to create the first one.
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-2">
				{#each groupings as group, index}
					<div
						class="batshit-settings-choice-tile {selectedGroupIndex === index ? 'is-selected' : ''}"
					>
						<div class="flex items-start justify-between gap-2">
							<button
								type="button"
								onclick={() => selectGroup(index)}
								class="batshit-settings-choice-tile-main"
							>
								<IconRenderer
									ref={getGroupIconRef(group)}
									label={group.mcpName}
									class="batshit-settings-choice-tile-icon"
									iconClass="h-3.5 w-3.5"
								/>
								<div class="flex-1 min-w-0">
									<div class="batshit-settings-form-label truncate">{group.mcpName}</div>
									<div class="batshit-settings-caption">{group.toolIds.length} tools</div>
								</div>
							</button>
							<div class="batshit-settings-choice-tile-actions">
								<IconPicker
									value={getGroupIconRef(group)}
									triggerLabel={group.icon_ref ? 'Icon' : 'Add Icon'}
									onlineSearchHint={group.mcpName}
									triggerVariant="ghost"
									triggerSize="sm"
									triggerClass="batshit-button-medium-secondary"
									triggerIconClass="h-4 w-4 rounded bg-muted/40"
									triggerIconInnerClass="h-3 w-3"
									onSelect={(iconRef) => updateGroupIcon(index, iconRef)}
								/>
								<Button
									size="sm"
									variant="ghost"
									onclick={(e) => {
										e.stopPropagation()
										deleteGroup(index)
									}}
								 class="batshit-button-shrink-0"
									title={`Delete ${group.mcpName}`}
								>
									<Trash2  />
								</Button>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}

		{#if showNewGroupInput}
			<div class="flex gap-2">
				<Input
					type="text"
					placeholder="New MCP group name"
					bind:value={newGroupName}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							createGroup()
						} else if (e.key === 'Escape') {
							showNewGroupInput = false
							newGroupName = ''
						}
					}}
					class="flex-1"
					autofocus
				/>
				<Button
					size="sm"
					onclick={createGroup}
					disabled={!newGroupName.trim()}
				>
					<Plus aria-hidden="true" />
					Create
				</Button>
				<Button
					size="sm"
					variant="outline"
					onclick={() => {
						showNewGroupInput = false
						newGroupName = ''
					}}
				>
					<X aria-hidden="true" />

					Cancel
				</Button>
			</div>
		{/if}
	</div>

	<!-- Transfer List Container -->
	<div class="space-y-2">
		<div class="flex items-center gap-1.5">
			<h4 class="batshit-settings-section-title">Tool Grouping</h4>
			<SettingsInfoMenu ariaLabel="About Tool Grouping" contentClass="w-96">
				<p>
					Select tools on the left, choose a group, and assign those tools into the
					selected MCP group shown on the right.
				</p>
				<p class="mt-2">
					Batshit uses Dynamic MCP discovery, so grouping plays an important role in making
					these tools easier for the AI to find. It is usually best not to leave tools
					unassigned.
				</p>
			</SettingsInfoMenu>
		</div>

		<div class="grid grid-cols-2 gap-4">
			<!-- Left: Unassigned Tools -->
			<Card class="batshit-settings-card is-compact !block">
				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<Label class="batshit-settings-form-label">
							Unassigned Tools ({unassignedTools.length})
						</Label>
						<div class="flex items-center gap-1">
							{#if unassignedTools.length > 0}
								{#if allUnassignedSelected}
									<Button
										size="sm"
										variant="ghost"
										onclick={clearSelection}

									>
										<X aria-hidden="true" />
										Clear All
									</Button>
								{:else}
									<Button
										size="sm"
										variant="ghost"
										onclick={selectAllUnassigned}

									>
										<Check aria-hidden="true" />
										Select All
									</Button>
								{/if}
							{/if}
							<Button
								size="sm"
								onclick={addToGroup}
								disabled={selectedToolCount === 0 || !selectedGroup}

							>
								<Plus aria-hidden="true" />
								Add →
							</Button>
						</div>
					</div>

					<!-- Unassigned tools list -->
					<div class="max-h-64 overflow-y-auto">
						{#if unassignedTools.length === 0}
							<div class="batshit-settings-note is-centered">
								All tools assigned!
							</div>
						{:else}
							<div class="space-y-0.5">
								{#each unassignedTools as toolId}
									<div class="batshit-settings-list-item w-full">
										<Checkbox
											checked={selectedToolIds.includes(toolId)}
											onCheckedChange={(checked: boolean) => {
												const nextChecked = checked === true
												const isChecked = selectedToolIds.includes(toolId)
												if (nextChecked !== isChecked) {
													toggleToolSelection(toolId)
												}
											}}
											class="shrink-0"
										/>
										<div class="flex-1 min-w-0">
											<span class="batshit-settings-code-caption block truncate">{toolId}</span>
											{#if toolMetadata?.[toolId]?.mcpName}
												<span class="batshit-settings-pill mt-0.5">
													{toolMetadata[toolId].mcpName}
												</span>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</Card>

			<!-- Right: Selected Group -->
			<Card class="batshit-settings-card is-compact !block">
				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<Label class={`batshit-settings-form-label ${needsGroupSelectionHint ? 'is-warning' : ''}`}>
							{#if selectedGroup}
								{selectedGroup.mcpName} ({selectedGroupTools.length} tools)
							{:else}
								Select a Group
							{/if}
						</Label>
						<div class="flex items-center gap-1">
							{#if selectedGroup && selectedGroupTools.length > 0}
								{#if allAssignedSelected}
									<Button
										size="sm"
										variant="ghost"
										onclick={clearAssignedSelection}

									>
										<X aria-hidden="true" />
										Clear All
									</Button>
								{:else}
									<Button
										size="sm"
										variant="ghost"
										onclick={selectAllAssigned}

									>
										<Check aria-hidden="true" />
										Select All
									</Button>
								{/if}
							{/if}
							<Button
								size="sm"
								variant="outline"
								onclick={removeFromGroup}
								disabled={selectedAssignedToolCount === 0 || !selectedGroup}

							>
								<Trash2 aria-hidden="true" />
								<ArrowLeft  />
								Remove
							</Button>
						</div>
					</div>

					<!-- Group tools list -->
					<div class="max-h-64 overflow-y-auto">
						{#if !selectedGroup}
							<div class={`batshit-settings-note is-centered ${needsGroupSelectionHint ? 'is-warning' : ''}`}>
								Select a group above
							</div>
						{:else if selectedGroupTools.length === 0}
							<div class="batshit-settings-note is-centered">
								No tools in this group
							</div>
						{:else}
							<div class="space-y-0.5">
								{#each selectedGroupTools as toolId}
									<div class="batshit-settings-list-item is-selected">
										<Checkbox
											checked={selectedAssignedToolIds.includes(toolId)}
											onCheckedChange={(checked: boolean) => {
												const nextChecked = checked === true
												const isChecked = selectedAssignedToolIds.includes(toolId)
												if (nextChecked !== isChecked) {
													toggleAssignedToolSelection(toolId)
												}
											}}
											class="shrink-0"
										/>
										<div class="flex-1 min-w-0">
											<span class="batshit-settings-code-caption block truncate">{toolId}</span>
											{#if toolMetadata?.[toolId]?.mcpName}
												<span class="batshit-settings-pill mt-0.5">
													{toolMetadata[toolId].mcpName}
												</span>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</Card>
		</div>

	</div>
</div>
