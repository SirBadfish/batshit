<script lang="ts">
	import { ChevronDown, Settings, PlusCircle, Edit } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte';
	import { DEFAULT_AGENT_ICON_REF, DEFAULT_GROUP_ICON_REF } from '$lib/icons/iconCatalog';
	import { normalizeIconRef } from '$lib/icons/iconLegacy';
	import { normalizeAvatarIconFit } from '$lib/icons/iconTypes';
	import * as agentStore from '$lib/stores/agents.svelte';
	import * as sessionStore from '$lib/stores/session.svelte';
	import * as groupStore from '$lib/stores/groups.svelte';
	import { GroupService } from '$lib/services/groups';
	import { DatabaseService } from '$lib/services/databaseRedis.client';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';
	import {
		resolveSessionTargetAgentId,
		shouldAutoSyncSessionTarget
	} from '$lib/components/agents/sessionTargetSync';
	import {
		getPrimaryAgentDisplayLabel,
		normalizePrimaryAgentType
	} from '$lib/utils/primaryAgentType';
	import { isFixedSession, resolveFixedSessionAgentId } from '$lib/utils/fixedSession';
	
const { data } = $props();
const AGENT_CREATE_SENTINEL = '__create__';
const groupService = new GroupService();

// State
let open = $state(false);
let settingsPanelOpen = $state(false);
let settingsPanelInitialAgentId = $state<string | null>(null);
let settingsPanelInitialTab = $state<'agents' | 'groups' | 'models' | 'user'>('agents');
let groupsReady = $state(false);
let agentsReady = $state(false);
let clearedGroupId = $state<string | null>(null);
let lastAutoSyncedSessionId = $state<string | null>(null);
let missingFixedAgentNoticeSessionId = $state<string | null>(null);
	
	// Get reactive values
const agents = $derived(agentStore.getAgents());
const currentAgent = $derived(agentStore.getCurrentAgent());
const groups = $derived(groupStore.getGroups());
const sessionState = $derived(sessionStore.sessionState);
const currentSession = $derived.by(
	() => sessionState.sessions.find((session) => session.id === sessionState.currentSessionId) || null
);
const activeGroupId = $derived(currentSession?.metadata?.group_chat?.group_id || null);
const activeGroup = $derived(
	activeGroupId ? groups.find((group) => group.id === activeGroupId) || null : null
);
const onboardingSettings = $derived(data?.userSettings?.onboarding_settings ?? null);
const firstRunSetupFinished = $derived(
	Boolean(onboardingSettings?.setup_completed_at || onboardingSettings?.setup_skipped_at)
);

function getValidGroupAgentIds(group: { agent_ids?: string[] | null }) {
	return (group.agent_ids || []).filter((id) => agents.some((agent) => agent.id === id));
}

function isGroupRunnable(group: { agent_ids?: string[] | null }) {
	return getValidGroupAgentIds(group).length >= 2;
}

function getFirstAvailableAgent(agentList: agentStore.Agent[]) {
	return agentList[0] ?? null;
}

$effect(() => {
	if (!settingsPanelOpen) {
		settingsPanelInitialAgentId = null;
	}
});

$effect(() => {
	if (!activeGroup || !Array.isArray(activeGroup.agent_ids) || activeGroup.agent_ids.length === 0) {
		return;
	}
	const anchorId = activeGroup.agent_ids.find((id) => agents.some((agent) => agent.id === id));
	if (anchorId && currentAgent?.id !== anchorId) {
		agentStore.setCurrentAgentId(anchorId);
	}
});

$effect(() => {
	if (!agentsReady) return;
	const sessionId = currentSession?.id ?? null;
	if (!sessionId) {
		lastAutoSyncedSessionId = null;
		missingFixedAgentNoticeSessionId = null;
		return;
	}
	const fixedSessionAgentId = resolveFixedSessionAgentId(currentSession);
	const fixedSessionAgentMissing = Boolean(
		fixedSessionAgentId && !agents.some((agent) => agent.id === fixedSessionAgentId)
	);
	if (fixedSessionAgentMissing && missingFixedAgentNoticeSessionId !== sessionId) {
		missingFixedAgentNoticeSessionId = sessionId;
		toast.error("This Infinite Session's saved agent no longer exists. Delete the session or restore that agent before continuing.");
	} else if (!fixedSessionAgentMissing) {
		missingFixedAgentNoticeSessionId = null;
	}
	if (!shouldAutoSyncSessionTarget(sessionId, lastAutoSyncedSessionId)) return;

	const sessionTargetAgentId = resolveSessionTargetAgentId({
		session: currentSession,
		availableAgentIds: agents.map((agent) => agent.id),
		currentAgentId: currentAgent?.id ?? null
	});
	lastAutoSyncedSessionId = sessionId;
	if (!sessionTargetAgentId) {
		return;
	}

	agentStore.setCurrentAgentId(sessionTargetAgentId);
});

async function loadGroups() {
	try {
		const loaded = await groupService.loadGroups();
		groupStore.setGroups(loaded);
	} catch (error) {
		console.error('Failed to load groups:', error);
		groupStore.setGroups([]);
	} finally {
		groupsReady = true;
	}
}
	
	// Load agents on mount
	onMount(async () => {
		if (data?.user?.id) {
			try {
				await Promise.all([
					agentStore.loadAgents(data.user.id),
					loadGroups(),
				]);
				agentsReady = true;

				const loadedAgents = agentStore.getAgents();
				const firstAvailableAgent = getFirstAvailableAgent(loadedAgents);

				// If no agents exist, prompt user to create one
				if (loadedAgents.length === 0 && firstRunSetupFinished) {
					settingsPanelInitialTab = 'agents';
					settingsPanelInitialAgentId = AGENT_CREATE_SENTINEL;
					settingsPanelOpen = true;
				} else {
					// Try to restore last selected agent from localStorage
					const lastSelectedAgentId = localStorage.getItem('lastSelectedAgent');
					const lastSelectedAgent = loadedAgents.find(a => a.id === lastSelectedAgentId);

					if (lastSelectedAgentId && lastSelectedAgent) {
						// Restore last selected agent if it still exists
						agentStore.setCurrentAgentId(lastSelectedAgentId);
					} else if (firstAvailableAgent) {
						agentStore.setCurrentAgentId(firstAvailableAgent.id);
					} else if (!agentStore.getCurrentAgent()) {
						agentStore.setCurrentAgentId(null);
					}
				}
			} catch (error) {
				console.error('Failed to load agent selector data:', error);
				toast.error(error instanceof Error ? error.message : 'Failed to load agents.');
				agentsReady = agentStore.getAgents().length > 0;
			}
		}
	});

$effect(() => {
	if (!groupsReady || !agentsReady) return;
	if (!activeGroupId) {
		clearedGroupId = null;
		return;
	}

	const group = groups.find((item) => item.id === activeGroupId);
	if (!group) {
		if (clearedGroupId !== activeGroupId) {
			clearedGroupId = activeGroupId;
			persistGroupSelection(null);
			toast.error('Selected group no longer exists. Switched back to single-agent.');
		}
		return;
	}

	const validAgentIds = getValidGroupAgentIds(group);
	if (validAgentIds.length < 2) {
		if (clearedGroupId !== activeGroupId) {
			clearedGroupId = activeGroupId;
			persistGroupSelection(null);
			toast.error('Selected group no longer has enough agents. Switched back to single-agent.');
		}
	}
});
	// Handle agent selection
	async function handleSelect(agentId: string) {
		const agent = agents.find((item) => item.id === agentId);
		// 2026-08-29: an Infinite Session is one agent's life — the picker is frozen
		// to that agent (the group-refusal pattern; a server-side episode guard backstops).
		if (isFixedSession(currentSession) && currentAgent && agentId !== currentAgent.id) {
			const ownerName = getAgentDisplayName(currentAgent);
			toast.error(`This Infinite Session is ${ownerName}'s.`, {
				description:
					'Infinite Sessions stay with one agent for life. Start a regular chat to talk to someone else.'
			});
			return;
		}
		agentStore.setCurrentAgentId(agentId);
		await persistGroupSelection(null);
		open = false;
	}

	async function handleSelectGroup(groupId: string) {
		const group = groups.find((item) => item.id === groupId);
		if (!group) return;

		// SA-104 P5 (DL-104-12): Infinite Sessions are single-agent; group entry is refused
		// here, at the fixed-transition route, and at send-routed's group config load.
		if (isFixedSession(currentSession)) {
			toast.error('Infinite Sessions do not support group chat.', {
				description: 'This chat is one agent living in one ongoing conversation. Use a regular session for groups.'
			});
			return;
		}

		const validAgentIds = getValidGroupAgentIds(group);

		if (!isGroupRunnable(group)) {
			toast.error('Groups need at least 2 agents to run group chat.');
			return;
		}

		const anchorId = validAgentIds[0] || currentAgent?.id || agents[0]?.id || null;
		if (anchorId) {
			agentStore.setCurrentAgentId(anchorId);
		}

		await persistGroupSelection(groupId);
		open = false;
	}

	async function persistGroupSelection(groupId: string | null) {
		const session = sessionStore.getCurrentSession();
		if (!session?.id) return;

		const nextMetadata: Record<string, any> = {
			...(session.metadata || {})
		};

		if (groupId) {
			nextMetadata.group_chat = { group_id: groupId };
		} else {
			delete nextMetadata.group_chat;
		}

		try {
			const dbService = new DatabaseService();
			await dbService.updateSession(session.id, { metadata: nextMetadata });
			sessionStore.updateSession(session.id, { metadata: nextMetadata });
		} catch (error) {
			console.error('Failed to update group selection:', error);
			toast.error('Failed to update group selection.');
		}
	}
	
	// Handle manage agents click
function handleManageClick() {
	open = false;
	settingsPanelInitialAgentId = null;
	settingsPanelInitialTab = 'agents';
	settingsPanelOpen = true;
}

function handleManageGroupsClick() {
	open = false;
	settingsPanelInitialAgentId = null;
	settingsPanelInitialTab = 'groups';
	settingsPanelOpen = true;
}

// Handle create new agent click
function handleCreateClick() {
	open = false;
	settingsPanelInitialTab = 'agents';
	settingsPanelInitialAgentId = AGENT_CREATE_SENTINEL;
	settingsPanelOpen = true;
}

// Handle edit agent click
function handleEditClick(e: Event, agentId: string) {
	e.stopPropagation();
	open = false;

	settingsPanelInitialAgentId = agentId;
	settingsPanelInitialTab = 'agents';
	settingsPanelOpen = true;
}
	
	// Get agent display name
	function getAgentDisplayName(agent: agentStore.Agent) {
		return agent.displayName || 'Unnamed Agent';
	}

	function getGroupDisplayName(group: { name?: string | null; id: string }) {
		return group.name || 'Untitled Group';
	}

	function getGroupAvatarUrl(group: { avatar_url?: string | null }) {
		return typeof group.avatar_url === 'string' && group.avatar_url.trim().length > 0
			? group.avatar_url
			: null;
	}

	function getAgentAvatarUrl(agent: agentStore.Agent) {
		return agent.avatar_url || agent.avatar || (agent.avatar_icon_ref ? null : '/assets/batshit_default_AI_Avatar_1.png');
	}

	function getAgentAvatarIconRef(agent: agentStore.Agent) {
		return agent.avatar_icon_ref ? normalizeIconRef(agent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF) : null;
	}

	function getGroupAvatarIconRef(group: { avatar_icon_ref?: unknown }) {
		return normalizeIconRef(group.avatar_icon_ref, DEFAULT_GROUP_ICON_REF);
	}

	function getGroupAvatarIconFit(group: { avatar_icon_fit?: unknown }) {
		return normalizeAvatarIconFit(group.avatar_icon_fit);
	}

	function getIconRefKey(iconRef: unknown) {
		if (!iconRef) return '';
		if (typeof iconRef === 'string') return iconRef;
		try {
			return JSON.stringify(iconRef);
		} catch {
			return String(iconRef);
		}
	}

	function getAgentAvatarKey(agent: agentStore.Agent) {
		return [
			agent.id,
			agent.avatar_url ?? '',
			agent.avatar ?? '',
			getIconRefKey(agent.avatar_icon_ref),
			normalizeAvatarIconFit(agent.avatar_icon_fit)
		].join(':');
	}

	function getGroupAvatarKey(group: { id: string; avatar_url?: string | null; avatar_icon_ref?: unknown; avatar_icon_fit?: unknown }) {
		return [
			group.id,
			group.avatar_url ?? '',
			getIconRefKey(group.avatar_icon_ref),
			getGroupAvatarIconFit(group)
		].join(':');
	}

	function getCurrentTargetControlLabel() {
		if (activeGroup) {
			return `Select chat target (current group: ${getGroupDisplayName(activeGroup)})`;
		}
		if (currentAgent) {
			return `Select chat target (current agent: ${getAgentDisplayName(currentAgent)})`;
		}
		return 'Select chat target';
	}
	
	// Get agent initials for fallback avatar
	function getAgentInitials(agent: agentStore.Agent) {
		const name = agent.displayName || 'AG';
		return name.split(' ').map(word => word[0]).join('').toUpperCase().slice(0, 2);
	}

	function getGroupInitials(name: string) {
		const safeName = name || 'Group';
		return safeName.split(' ').map(word => word[0]).join('').toUpperCase().slice(0, 2);
	}

	function getAgentTypeBadgeClass(agent: agentStore.Agent) {
		return `batshit-agent-type-badge agent-selector-type-badge is-agent-type-${normalizePrimaryAgentType(agent)}`;
	}

	function getAgentTypeBadgeLabel(agent: agentStore.Agent) {
		return getPrimaryAgentDisplayLabel(normalizePrimaryAgentType(agent));
	}
</script>

<style>
	/* Reduce font size for all dropdown items to match ModelSelector */
	:global(.agent-selector-dropdown [role="menuitem"]),
	:global(.agent-selector-dropdown [role="menuitemradio"]) {
		font-size: 0.75rem;
	}
	
	:global(.agent-selector-dropdown [role="menuitemradio"] > span) {
		font-size: 0.75rem;
	}

	:global(.agent-selector-dropdown) {
		width: max-content;
		min-width: 16.25rem;
		max-width: min(26.25rem, calc(100vw - 2rem));
	}

	:global(.agent-selector-dropdown .bs-dropdown-item) {
		min-width: 0;
	}

	:global(.agent-selector-trigger) {
		width: max-content;
		min-width: 10rem;
		max-width: min(20rem, 34vw);
	}

	:global(.agent-selector-dropdown .agent-selector-menu-item) {
		min-width: 0;
	}
	
	.agent-selector-item {
		font-size: 0.75rem;
	}

	.agent-selector-trigger-inner,
	.agent-selector-menu-row,
	.agent-selector-menu-item,
	.agent-selector-label {
		min-width: 0;
	}
	
	.agent-selector-trigger-text {
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1;
	}

	.agent-selector-label {
		overflow: hidden;
	}

	.agent-selector-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.agent-selector-menu-label {
		min-width: 0;
		flex: 1 1 auto;
	}

	.agent-selector-type-badge {
		min-height: 1rem;
		padding: 0 0.34rem;
		font-size: 0.58rem;
		line-height: 1rem;
	}

	.agent-selector-group-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--bs-app-inner-line);
		border-radius: 999px;
		padding: 0 0.34rem;
		color: var(--bs-app-muted-text);
		font-size: 0.58rem;
		font-weight: 650;
		line-height: 1rem;
	}

	.agent-selector-group-badge {
		background: var(--bs-app-field);
		color: var(--bs-app-label);
	}

	.agent-selector-menu-row.is-unavailable {
		opacity: 0.48;
	}

	.agent-selector-menu-row.is-unavailable .agent-selector-menu-item {
		cursor: not-allowed;
	}

	.agent-selector-unavailable-reason {
		color: var(--bs-app-muted-text);
		font-size: 0.62rem;
		font-weight: 500;
		line-height: 1rem;
		white-space: nowrap;
	}

	@container chat-column (max-width: 650px) {
		:global(.agent-selector-trigger) {
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
		class="inline-flex items-center justify-between whitespace-nowrap rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 pl-1 pr-3 py-1 agent-selector-trigger"
		aria-label={getCurrentTargetControlLabel()}
		title={getCurrentTargetControlLabel()}
		data-testid="agent-selector"
		data-ab-control="chat-target"
	>
		<div class="flex items-center gap-2 flex-1 agent-selector-trigger-inner">
			{#if activeGroup}
				{#key getGroupAvatarKey(activeGroup)}
					<EntityAvatar
						avatarUrl={getGroupAvatarUrl(activeGroup)}
						iconRef={getGroupAvatarIconRef(activeGroup)}
						iconFit={getGroupAvatarIconFit(activeGroup)}
						label={getGroupDisplayName(activeGroup)}
						fallback={getGroupInitials(activeGroup.name || activeGroup.id)}
						class="h-6 w-6"
					/>
				{/key}
				<span class="agent-selector-trigger-text flex items-center gap-1 agent-selector-label">
					<span class="agent-selector-name">{getGroupDisplayName(activeGroup)}</span>
					<span class="agent-selector-group-badge">
						Group
					</span>
				</span>
			{:else if currentAgent}
				{#key getAgentAvatarKey(currentAgent)}
					<EntityAvatar
						avatarUrl={getAgentAvatarUrl(currentAgent)}
						iconRef={getAgentAvatarIconRef(currentAgent)}
						iconFit={currentAgent.avatar_icon_fit}
						label={getAgentDisplayName(currentAgent)}
						fallback={getAgentInitials(currentAgent)}
						class="h-6 w-6"
					/>
				{/key}
				<span class="agent-selector-trigger-text flex items-center gap-1 agent-selector-label">
					<span class="agent-selector-name">{getAgentDisplayName(currentAgent)}</span>
					<span class={getAgentTypeBadgeClass(currentAgent)}>
						{getAgentTypeBadgeLabel(currentAgent)}
					</span>
				</span>
			{:else}
				<span class="text-muted-foreground agent-selector-trigger-text">Select Agent or Group</span>
			{/if}
		</div>
		<ChevronDown class="h-4 w-4 text-muted-foreground shrink-0" />
	</DropdownMenu.Trigger>
	
	<DropdownMenu.Content align="start" class="agent-selector-dropdown">
		<DropdownMenu.Label>Select Chat Target</DropdownMenu.Label>

		<DropdownMenu.Label class="text-[10px] uppercase tracking-wide text-muted-foreground">
			Agents
		</DropdownMenu.Label>

		{#if agents.length > 0}
			{#each agents as agent (agent.id)}
				{@const frozenReason =
					isFixedSession(currentSession) && currentAgent && agent.id !== currentAgent.id
						? 'Infinite Session'
						: null}
				{@const unavailableReason = frozenReason}
				<div class="agent-selector-menu-row flex items-center gap-2 {agent.id === currentAgent?.id ? 'border-l-2 border-r-2 border-primary pl-2 pr-2' : 'pl-3 pr-3'}" class:is-unavailable={Boolean(unavailableReason)}>
					<DropdownMenu.Item
						onSelect={() => handleSelect(agent.id)}
						disabled={Boolean(unavailableReason)}
						class="agent-selector-menu-item flex items-center gap-2 flex-1"
						aria-label={`Switch chat target to ${getAgentDisplayName(agent)}`}
						title={unavailableReason ?? `Switch chat target to ${getAgentDisplayName(agent)}`}
					>
						<EntityAvatar
							avatarUrl={getAgentAvatarUrl(agent)}
							iconRef={getAgentAvatarIconRef(agent)}
							iconFit={agent.avatar_icon_fit}
							label={getAgentDisplayName(agent)}
							fallback={getAgentInitials(agent)}
							class="h-6 w-6"
						/>
						<span class="agent-selector-item agent-selector-menu-label flex items-center gap-1 agent-selector-label">
							<span class="agent-selector-name">{getAgentDisplayName(agent)}</span>
							<span class={getAgentTypeBadgeClass(agent)}>
								{getAgentTypeBadgeLabel(agent)}
							</span>
							{#if unavailableReason}
								<span class="agent-selector-unavailable-reason">{unavailableReason}</span>
							{/if}
						</span>
					</DropdownMenu.Item>
					<button
						onclick={(e) => handleEditClick(e, agent.id)}
						class="ml-auto p-1 hover:bg-accent rounded transition-colors shrink-0"
						aria-label={`Edit agent ${getAgentDisplayName(agent)}`}
						title={`Edit agent ${getAgentDisplayName(agent)}`}
					>
						<Edit class="h-3 w-3" />
					</button>
				</div>
			{/each}
		{:else}
			<DropdownMenu.Item disabled>
				<span class="text-muted-foreground">No agents available</span>
			</DropdownMenu.Item>
		{/if}

		<DropdownMenu.Separator />

		<DropdownMenu.Label class="text-[10px] uppercase tracking-wide text-muted-foreground">
			Groups
		</DropdownMenu.Label>

			{#if groups.length > 0}
				{#each groups as group (group.id)}
					{@const validAgentIds = getValidGroupAgentIds(group)}
					{@const isRunnable = validAgentIds.length >= 2}
					{@const groupFrozen = isFixedSession(currentSession)}
					<div class="agent-selector-menu-row flex items-center gap-2 {group.id === activeGroupId ? 'border-l-2 border-r-2 border-primary pl-2 pr-2' : 'pl-3 pr-3'}" class:is-unavailable={groupFrozen}>
						<DropdownMenu.Item
							onSelect={() => handleSelectGroup(group.id)}
							disabled={!isRunnable || groupFrozen}
							class="agent-selector-menu-item flex items-center gap-2 flex-1"
							aria-label={`Switch chat target to group ${getGroupDisplayName(group)}`}
							title={`Switch chat target to group ${getGroupDisplayName(group)}`}
						>
							<EntityAvatar
								avatarUrl={getGroupAvatarUrl(group)}
								iconRef={getGroupAvatarIconRef(group)}
								iconFit={getGroupAvatarIconFit(group)}
								label={getGroupDisplayName(group)}
								fallback={getGroupInitials(group.name || group.id)}
								class="h-6 w-6"
							/>
							<span class="agent-selector-item agent-selector-menu-label flex items-center gap-1 agent-selector-label">
								<span class="agent-selector-name">{getGroupDisplayName(group)}</span>
								<span class="agent-selector-group-badge">
									Group
								</span>
								{#if groupFrozen}
									<span class="agent-selector-unavailable-reason">Infinite Session</span>
								{:else if !isRunnable}
									<span class="text-[10px] text-muted-foreground">(Need 2 agents)</span>
								{/if}
							</span>
							<span class="text-[10px] text-muted-foreground">
								{validAgentIds.length}
							</span>
						</DropdownMenu.Item>
					</div>
				{/each}
		{:else}
			<DropdownMenu.Item disabled>
				<span class="text-muted-foreground">No groups yet</span>
			</DropdownMenu.Item>
		{/if}

		<DropdownMenu.Separator />

		<DropdownMenu.Item onSelect={handleManageGroupsClick} class="agent-selector-item">
			<Settings class="h-4 w-4 mr-2" />
			<span>Manage Groups...</span>
		</DropdownMenu.Item>

		<DropdownMenu.Item onSelect={handleManageClick} class="agent-selector-item">
			<Settings class="h-4 w-4 mr-2" />
			<span>Manage Agents...</span>
		</DropdownMenu.Item>

		<DropdownMenu.Item onSelect={handleCreateClick} class="agent-selector-item">
			<PlusCircle class="h-4 w-4 mr-2" />
			<span>Create New Agent...</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<SettingsPanel
	bind:open={settingsPanelOpen}
	initialTab={settingsPanelInitialTab}
	initialAgentId={settingsPanelInitialAgentId}
	{data}
/>
