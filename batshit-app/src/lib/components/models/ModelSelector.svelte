<script lang="ts">
import { ChevronDown, Settings, Plus, Edit, Bot } from '@lucide/svelte';
import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
import * as Avatar from '$lib/components/ui/avatar';
import { onMount, onDestroy, untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import type { SavedModel } from '$lib/types/savedModels';
import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte';
import * as agentStore from '$lib/stores/agents.svelte';
import * as savedModelsStore from '$lib/stores/savedModels.svelte';
import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';
import { getSavedModelBadgeProvider, resolveSavedModelConnection } from '$lib/utils/modelConnections';
import type { CatalogConnectionOption } from '$lib/types/modelCatalog';
import { getModelPresetAvailability } from '$lib/utils/modelPresetAvailability';
import { buildPickedPresetSelection } from '$lib/utils/modelPresetPick';
import { MODEL_SELECTION_REVISION_HEADER, captureModelSelectionBaseline, sameModelSelection, withModelSelection, type ModelSelectionBaseline } from '$lib/appActions/settings/modelSelectionBaseline';
import { onUserChannelEvent } from '$lib/services/userChannel';
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents';
	
	// Props
let {
	sessionId,
	data = null
}: {
	sessionId?: string;
	data?: any;
} = $props();

const MODEL_CREATE_SENTINEL = '__create__';
	
	// State
let open = $state(false);
let settingsPanelOpen = $state(false);
let settingsPanelInitialTab = $state<'models' | 'agents' | 'user'>('models');
let settingsPanelInitialModelId = $state<string | null>(null);

// Get saved models from shared store (reactive)
	const savedModels = $derived(savedModelsStore.getSavedModels());
	const isChatPreset = (model: SavedModel) => (model.purpose ? model.purpose === 'chat' : true);
	const chatModels = $derived.by(() => savedModels.filter(isChatPreset));
	
// Get current agent to determine default model
const currentAgent = $derived(agentStore.getCurrentAgent());
let connectionOptions = $state<CatalogConnectionOption[] | null>(null);
let connectionOptionsLoading = $state(false);
let connectionOptionsError = $state<string | null>(null);
let connectionReadGeneration = 0;
let activeConnectionRead: number | null = null;
let pendingConnectionRead = false;
let selectionBaseline = $state<ModelSelectionBaseline | null>(null);
let selectionReadError = $state<string | null>(null);
let selectionSaving = $state(false);
let selectionReadGeneration = 0;
let alive = true;
onDestroy(() => { alive = false; selectionReadGeneration += 1; connectionReadGeneration += 1; pendingConnectionRead = false; });

async function loadSelectionBaseline() {
  const shown = currentAgent;
  const generation = ++selectionReadGeneration;
  selectionBaseline = null;
  selectionReadError = null;
  if (!shown) return;
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(shown.id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('The saved model selection could not be read. Close and reopen this menu to retry.');
    const row = await response.json();
    const baseline = captureModelSelectionBaseline('agent', row, response.headers.get(MODEL_SELECTION_REVISION_HEADER));
    if (!baseline || baseline.id !== shown.id || row.user_id !== shown.user_id) throw new Error('The saved model selection is unavailable. Close and reopen this menu to retry.');
    if (!alive || generation !== selectionReadGeneration || currentAgent?.id !== shown.id || !open) return;
    if (currentAgent.user_id !== shown.user_id || currentAgent.agentType !== shown.agentType || !sameModelSelection('agent', shown as unknown as Record<string, unknown>, currentAgent as unknown as Record<string, unknown>)) {
      throw new Error('The model changed while this menu was opening. Close and reopen it to review the saved choice.');
    }
    agentStore.updateAgent(shown.id, { ...withModelSelection('agent', currentAgent as unknown as Record<string, unknown>, row), agentType: row.agentType } as Partial<agentStore.Agent>);
    selectionBaseline = baseline;
  } catch (error) {
    if (alive && generation === selectionReadGeneration && currentAgent?.id === shown.id && open) selectionReadError = error instanceof Error ? error.message : 'The saved model selection could not be read.';
  }
}

const selectionAgentId = $derived(currentAgent?.id ?? null);
$effect(() => {
  open;
  selectionAgentId;
  untrack(() => { if (open && !selectionSaving) void loadSelectionBaseline(); else if (!open) { selectionReadGeneration += 1; selectionBaseline = null; } });
});

const modelMenuItems = $derived.by(() => {
	const items = chatModels.map((model) => ({
		model,
		availability: getModelPresetAvailability({
			model,
			agentType: 'api',
			connectionOptions
		})
	}));
	items.sort((a, b) => Number(a.availability.disabled) - Number(b.availability.disabled));
	return items;
});

async function loadConnectionOptions(options: { force?: boolean } = {}) {
	if (connectionOptionsLoading) { if (activeConnectionRead !== connectionReadGeneration) pendingConnectionRead = true; return; }
	if (connectionOptions && !options.force) return;
	const generation = connectionReadGeneration;
	activeConnectionRead = generation;
	connectionOptionsLoading = true;
	connectionOptionsError = null;
	try {
		const response = await fetch('/api/models?include=connections');
		if (!response.ok) {
			throw new Error(`Failed to load model connections (${response.status})`);
		}
		const payload = await response.json();
		if (!alive || generation !== connectionReadGeneration) return;
		const connections = payload?.data?.connections;
		if (!Array.isArray(connections) || connections.some((option) =>
			!option || typeof option !== 'object' || Array.isArray(option) ||
			typeof option.id !== 'string' || !option.id.trim() ||
			(option.status !== 'ready' && option.status !== 'locked')
		)) {
			throw new Error('Connection status could not be read. Close and reopen this menu to retry.');
		}
		connectionOptions = connections;
	} catch (error) {
		if (!alive || generation !== connectionReadGeneration) return;
		console.error('[ModelSelector] Failed to load model connections:', error);
		connectionOptionsError = error instanceof Error ? error.message : 'Failed to load model connections';
	} finally {
		activeConnectionRead = null;
		if (alive) {
			connectionOptionsLoading = false;
			if (pendingConnectionRead) { pendingConnectionRead = false; void loadConnectionOptions({ force: true }); }
		}
	}
}
function invalidateConnectionOptions() {
	connectionReadGeneration += 1;
	connectionOptions = null;
	connectionOptionsError = null;
}

// Once per mount. The load reads and writes the states its own fetch flips (loading, options,
// error), so it runs untracked: a tracked call re-ran on a failed answer, forever (BL-977). A failed
// load shows its error and does not retry by itself; the modelConnectionsUpdated handler below reloads.
$effect(() => {
	untrack(() => {
		void loadConnectionOptions();
	});
});

// The user opening the menu while the last load failed asks once more (a retry the user drives, so
// the menu recovers without a reload). The ONLY dependency is the menu's open state; the error the
// load itself flips is read untracked, so the retry cannot re-run itself: one retry per open.
$effect(() => {
	if (!open) return;
	untrack(() => {
		if (connectionOptionsError || !connectionOptions) void loadConnectionOptions({ force: true });
	});
});

function resolveActiveSavedModel(agent: agentStore.Agent | null, models: SavedModel[]) {
	if (!agent) return null;

	const presetId = agent.primary_model_preset_id?.trim();
	if (presetId) {
		const byId = models.find((model) => model.id === presetId);
		if (byId) return byId;
	}

	const rawDeveloperId = agent.primary_model_provider?.trim() ?? '';
	const rawModelId = agent.primary_model_name?.trim() ?? '';
	if (!rawDeveloperId && !rawModelId) return null;

	let developerId = rawDeveloperId;
	let modelId = rawModelId;
	if (rawModelId.includes('/')) {
		const [parsedDeveloperId, ...rest] = rawModelId.split('/');
		const parsedModelId = rest.join('/').trim();
		if (!developerId && parsedDeveloperId.trim()) developerId = parsedDeveloperId.trim();
		if (parsedModelId) modelId = parsedModelId;
	}

	let matches = models.filter((model) => model.provider === developerId && model.modelId === modelId);
	if (!matches.length) return null;

	const agentConnection = agent.primary_model_connection ?? null;
	if (agentConnection) {
		const refined = matches.filter((model) => {
			const connection = resolveSavedModelConnection(model);
			if (connection.type !== agentConnection.type) return false;
			if (agentConnection.service && connection.service !== agentConnection.service) return false;
			return true;
		});
		if (refined.length) matches = refined;
	}

	return matches[0] ?? null;
}

const activeModel = $derived.by(() => {
	return resolveActiveSavedModel(currentAgent, chatModels);
});

const modelTriggerLabel = $derived.by(() => {
	const currentLabel = getModelDisplayName(activeModel);
	return currentLabel ? `Chat model (${currentLabel})` : 'Chat model';
});

$effect(() => {
	if (!settingsPanelOpen) {
		settingsPanelInitialModelId = null;
	}
});
		
// Load saved models on mount
onMount(() => {
	const handleModelConnectionsUpdated = () => {
		invalidateConnectionOptions();
		void loadConnectionOptions({ force: true });
	};

	window.addEventListener(
		LIVE_SETTINGS_EVENTS.modelConnectionsUpdated,
		handleModelConnectionsUpdated
	);

	void savedModelsStore.loadSavedModels();
	const stopSettingsEvents = onUserChannelEvent((event) => {
		// The shared channel owns one pure stored-list refresh. Reconnect invalidates
		// cached connection observations without a catalog/account read or draft rebase.
		if (event.type === 'reconnected') invalidateConnectionOptions();
	});

	return () => {
		stopSettingsEvents();
		window.removeEventListener(
			LIVE_SETTINGS_EVENTS.modelConnectionsUpdated,
			handleModelConnectionsUpdated
		);
	};
});
	
	// Load saved models from API (delegate to store)
	async function loadSavedModels() {
		return savedModelsStore.loadSavedModels();
	}

	function formatSetupCommandDescription(option: CatalogConnectionOption | null | undefined) {
		const setupCommand = option?.setupCommand;
		if (!setupCommand) return undefined;
		const workingDirectory = option.setupWorkingDirectory?.trim();
		if (option.setupContext === 'docker' && workingDirectory) {
			return `Run from ${workingDirectory}: ${setupCommand}`;
		}
		return `Run: ${setupCommand}`;
	}

		// Handle model selection
	async function handleSelectModel(presetId: string) {
		const baseline = selectionBaseline;
		const ownerId = currentAgent?.id;
		if (!ownerId || !baseline || baseline.id !== ownerId || selectionSaving || connectionOptionsLoading || !connectionOptions || connectionOptionsError) return;
			// Find the saved model
		const selectedModel = chatModels.find((model) => model.id === presetId);
		if (selectedModel) {
			const availability = getModelPresetAvailability({
				model: selectedModel,
				agentType: 'api',
				connectionOptions
			});
			if (availability.disabled) {
				toast.error(availability.reason ?? 'This model preset is not selectable right now.', {
					description: formatSetupCommandDescription(availability.connectionOption)
				});
				return;
			}
		}
		
		if (selectedModel && currentAgent) {
			selectionSaving = true;
			try {
        // Primary/no-seed keeps its ORIGINAL model-group hash; the optional native pair is
        // not a substitute or an extra gate. Detach the exact issued pick before any await.
        const issued = JSON.parse(JSON.stringify({
					...buildPickedPresetSelection(selectedModel),
					expectedModelSelection: baseline.revision
				}));
				await agentStore.updateAgentSettings(ownerId, issued);
			} catch (error) {
				console.error('Failed to update agent model:', error);
				const knownRefusal = ['model_selection_base_required', 'model_selection_settings_changed', 'model_preset_unavailable', 'cli_selection_changes_unadopted_native_controls', 'MANAGED_PROFILE_SOURCE_CHANGED'].includes((error as { code?: string }).code ?? '');
				toast.error(knownRefusal ? 'The model changed while you were choosing. Your selection was not saved. Reopen the menu and choose again.' : 'This model save is unconfirmed. Reopen the menu to read the saved selection before making a new choice.');
			} finally {
				selectionBaseline = null;
				selectionSaving = false;
			}
		}

		open = false;
}
	
	// Get model display name
	function getModelDisplayName(model: SavedModel | null) {
		if (!model) return 'Select Model';
		return model.modelName || model.modelId;
	}
	
	// Handle edit model click
function handleEditClick(e: Event, presetId: string) {
	e.stopPropagation();
	open = false;
	// Find the model to edit
	const modelToEdit = savedModels.find((model) => model.id === presetId);
	if (!modelToEdit) return;

	settingsPanelInitialTab = 'models';
	settingsPanelInitialModelId = modelToEdit.id;
	settingsPanelOpen = true;
}

</script>

<style>
	/* Reduce font size for all dropdown items */
	:global(.model-selector-dropdown [role="menuitem"]),
	:global(.model-selector-dropdown [role="menuitemradio"]) {
		font-size: 0.75rem;
	}
	
	:global(.model-selector-dropdown [role="menuitemradio"] > div) {
		font-size: 0.75rem;
	}

	:global(.model-selector-dropdown) {
		width: max-content;
		min-width: 18rem;
		max-width: min(30rem, calc(100vw - 2rem));
	}

	:global(.model-selector-dropdown .bs-dropdown-item) {
		min-width: 0;
	}

	:global(.model-selector-trigger) {
		width: fit-content;
		min-width: 10rem;
		max-width: min(18rem, 32vw);
		flex: 0 1 auto;
	}
	
	.model-selector-item {
		font-size: 0.75rem;
	}
	
	.model-selector-trigger-text {
		font-size: 0.75rem;
	}

	.model-selector-menu-row,
	.model-selector-menu-label {
		min-width: 0;
	}

	:global(.model-selector-menu-item) {
		min-width: 0;
	}

	.model-selector-name,
	.model-selector-model-id {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-selector-model-id {
		font-family: var(--bs-font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
	}

	.model-selector-menu-label {
		flex: 1 1 auto;
	}

	@container chat-column (max-width: 650px) {
		:global(.model-selector-trigger) {
			width: 60px;
			min-width: 60px;
			max-width: 60px;
			padding-left: 0.5rem;
			padding-right: 0.5rem;
		}
	}
</style>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger 
		class="inline-flex items-center justify-between whitespace-nowrap rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 pl-1 pr-3 py-1 model-selector-trigger"
		aria-label={modelTriggerLabel}
		title={modelTriggerLabel}
		data-testid="model-selector"
		data-ab-control="chat-model"
	>
		<div class="flex items-center gap-2 flex-1 min-w-0">
			{#if activeModel}
				<ModelProviderIcon 
					modelId={activeModel?.modelId || ''} 
					modelName={activeModel?.modelName || ''}
					provider={activeModel?.provider || ''} 
					size="md"
					showOverlay={true}
					badgeProvider={activeModel ? getSavedModelBadgeProvider(activeModel) : undefined}
				/>
			{:else}
				<Bot class="h-6 w-6 shrink-0 text-muted-foreground" />
			{/if}
			<span class="truncate model-selector-trigger-text model-selector-label">
				{getModelDisplayName(activeModel)}
			</span>
		</div>
		<ChevronDown class="h-4 w-4 text-muted-foreground shrink-0" />
	</DropdownMenu.Trigger>
	
	<DropdownMenu.Content align="start" class="model-selector-dropdown">
		<DropdownMenu.Label>Available Models</DropdownMenu.Label>
		{#if selectionReadError}
			<DropdownMenu.Item disabled>{selectionReadError}</DropdownMenu.Item>
		{:else if currentAgent && !selectionBaseline}
			<DropdownMenu.Item disabled>Reading saved model selection…</DropdownMenu.Item>
		{/if}

		{#if connectionOptionsLoading}
			<DropdownMenu.Item disabled>
				<span class="text-muted-foreground">Loading connection status…</span>
			</DropdownMenu.Item>
		{:else if connectionOptionsError}
			<DropdownMenu.Item disabled>
				<span class="text-muted-foreground">{connectionOptionsError}</span>
			</DropdownMenu.Item>
		{:else if !connectionOptions}
			<DropdownMenu.Item disabled><span class="text-muted-foreground">Reopen this menu to refresh connection status.</span></DropdownMenu.Item>
		{/if}
		
		{#if modelMenuItems.length > 0}
			{#each modelMenuItems as item (item.model.id)}
					{@const model = item.model}
					{@const availability = item.availability}
					<div class="model-selector-menu-row flex items-center gap-2 {model.id === activeModel?.id ? 'border-l-2 border-r-2 border-primary-text pl-2 pr-2' : 'pl-3 pr-3'}">
						<DropdownMenu.Item
							onSelect={() => handleSelectModel(model.id)}
							class="model-selector-menu-item flex items-center gap-2 flex-1 text-sm"
							disabled={availability.disabled || !selectionBaseline || selectionSaving || connectionOptionsLoading || !connectionOptions || Boolean(connectionOptionsError)}
						>
							<ModelProviderIcon 
								modelId={model.modelId} 
								modelName={model.modelName}
								provider={model.provider} 
								size="md"
								showOverlay={true}
								badgeProvider={getSavedModelBadgeProvider(model)}
							/>
							<div class="model-selector-menu-label">
								<div class="flex items-center gap-1 truncate model-selector-item">
									<span class="model-selector-name">{getModelDisplayName(model)}</span>
								</div>
								<div class="batshit-model-id text-[11px] text-muted-foreground model-selector-model-id">
									{model.modelId}
								</div>
				</div>
			</DropdownMenu.Item>
						<button
							onclick={(e) => handleEditClick(e, model.id)}
							class="ml-auto p-1 hover:bg-accent rounded transition-colors shrink-0"
							aria-label={`Edit model ${getModelDisplayName(model)}`}
							title={`Edit model ${getModelDisplayName(model)}`}
						>
							<Edit class="h-3 w-3" />
						</button>
					</div>
			{/each}
		{:else}
			<DropdownMenu.Item disabled>
				<span class="text-muted-foreground">
					{#if savedModels.length === 0}
						No saved models
					{/if}
				</span>
			</DropdownMenu.Item>
		{/if}
		
		<DropdownMenu.Separator />
		
		<DropdownMenu.Item
			onSelect={() => {
				open = false;
				settingsPanelInitialTab = 'models';
				settingsPanelInitialModelId = null;
				settingsPanelOpen = true;
			}}
			class="model-selector-item"
		>
			<Settings class="h-4 w-4 mr-2" />
			<span>Manage Models...</span>
		</DropdownMenu.Item>
		
		<DropdownMenu.Item
			onSelect={() => {
				open = false;
				settingsPanelInitialTab = 'models';
				settingsPanelInitialModelId = MODEL_CREATE_SENTINEL;
				settingsPanelOpen = true;
			}}
			class="model-selector-item"
		>
			<Plus class="h-4 w-4 mr-2" />
			<span>Add New Model...</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<SettingsPanel
	bind:open={settingsPanelOpen}
	initialTab={settingsPanelInitialTab}
	initialModelId={settingsPanelInitialModelId}
	{data}
/>
