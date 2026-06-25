<script lang="ts">
	import { Home, MessageSquare, Settings, FileText, MessageCirclePlus, User, Archive } from '@lucide/svelte';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte';
	import { goto } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
import SessionItem from './SessionItem.svelte';
import FolderTree from '$lib/components/sidebar/FolderTree.svelte';
import { SessionService } from '$lib/services/sessions';
import * as sessionStore from '$lib/stores/session.svelte';
import * as agentStore from '$lib/stores/agents.svelte';
import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte';
import type { ChatSessionRow } from '$lib/types/database';
import { foldersStore } from '$lib/stores/folders.svelte';
import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';
import { resolveSessionStoredAgentId } from '$lib/components/agents/sessionTargetSync';
import { evaluateActiveChatCapacity } from '$lib/utils/activeChatCapacity';
	
	const { data } = $props();
	
	type SettingsTab =
		| 'user'
		| 'agents'
		| 'groups'
		| 'models'
		| 'local-ai'
		| 'api-keys'
		| 'clips'
		| 'projects'
		| 'artifacts'
		| 'tools'
		| 'mcp'
		| 'slash-commands'
		| 'voice'
		| '3d-goons'
		| 'theme'
		| 'admin'
		| 'dev';
	type SettingsToolsTab = 'gateway-settings' | 'tool-grid' | 'zip-options';

	// State for settings panel
	let settingsPanelOpen = $state(false);
	let settingsInitialTab = $state<SettingsTab>('agents');
	let settingsInitialAgentId = $state<string | null>(null);
	let settingsInitialModelId = $state<string | null>(null);
	let settingsInitialToolsTab = $state<SettingsToolsTab | null>(null);
	let settingsInitialArtifactId = $state<string | null>(null);
	let settingsProjectsMode = $state<'list' | 'create' | null>(null);
	let settingsProjectsModeNonce = $state(0);
	
	// Session management
	let sessionService = $state<SessionService | null>(null);
	let sessions = $state<sessionStore.ChatSession[]>([]);
	let currentSessionId = $state<string | null>(null);
	let showArchived = $state(false);
	let newChatPending = $state(false);
	const newChatCapacityDecision = $derived.by(() =>
		evaluateActiveChatCapacity({
			activeRuns: chatRunRegistry.getActiveRunStates(),
			currentSessionId: null
		})
	);
	const newChatAtCapacity = $derived(!newChatCapacityDecision.allowed);
	const newChatDisabled = $derived(newChatPending || newChatAtCapacity);
	const newChatDisabledLabel = $derived(
		newChatAtCapacity
			? 'Max three active chats at a time'
			: 'New Chat'
	);

	// Initialize session service and load sessions AND folders
	onMount(async () => {
		if (data?.user) {
			sessionService = new SessionService();
			try {
				// Load folders first
				await foldersStore.loadFolders();
				
				await sessionService.loadSessions(data.user.id, showArchived);
				sessions = sessionStore.getSessions();
				currentSessionId = sessionStore.getCurrentSessionId();
			} catch (error) {
				console.error('Error loading sessions:', error);
			}
		}
	});

	// Global open-settings hook (used by Projects dropdown + other UI)
	onMount(() => {
		const handleOpenSettings = (event: Event) => {
			const detail = (event as CustomEvent)?.detail as {
				tab?: SettingsTab | 'zips';
				mode?: string;
				toolsTab?: SettingsToolsTab;
				artifactId?: string;
				agentId?: string;
				modelId?: string;
			} | undefined;
			settingsInitialArtifactId = detail?.artifactId ?? null;
			settingsInitialAgentId =
				detail?.tab === 'agents'
					? detail.agentId ?? resolveDefaultSettingsAgentId()
					: null;
			settingsInitialModelId =
				detail?.tab === 'models'
					? detail.modelId ?? null
					: null;
			if (detail?.tab) {
				if (detail.tab === 'zips') {
					settingsInitialTab = 'tools';
					settingsInitialToolsTab = 'zip-options';
				} else {
					settingsInitialTab = detail.tab;
					settingsInitialToolsTab =
						detail.tab === 'tools' ? (detail.toolsTab ?? 'gateway-settings') : null;
				}
			}
			if (detail?.tab === 'projects') {
				const mode = detail?.mode === 'create' ? 'create' : 'list';
				settingsProjectsMode = mode;
				settingsProjectsModeNonce += 1;
			} else {
				settingsProjectsMode = null;
			}
			settingsPanelOpen = true;
		};

		window.addEventListener('batshit:open-settings', handleOpenSettings as EventListener);

		return () => {
			window.removeEventListener('batshit:open-settings', handleOpenSettings as EventListener);
		};
	});
	
	// Use derived state for reactive sessions
	const reactiveState = $derived(sessionStore.sessionState);
	const reactiveSessions = $derived(reactiveState.sessions);
	const reactiveCurrentSessionId = $derived(reactiveState.currentSessionId);

	// Reload sessions when showArchived changes
	// Using untrack() to only react to showArchived, not sessionService/data.user
	$effect(() => {
		// Only track showArchived - untrack everything else to prevent cascading effects
		const service = untrack(() => sessionService);
		const user = untrack(() => data?.user);

		if (service && user) {
			service.loadSessions(user.id, showArchived);
		}
	});
	
	// Create new session with optional folder
		async function handleNewChat(folderId?: string, source = 'unknown') {
			if (!sessionService || !data?.user) return;
			if (newChatAtCapacity) {
				return;
			}
			if (newChatPending) {
				return;
			}
		newChatPending = true;
		
		// If no folderId provided, use the default folder
		let targetFolderId = folderId;
		try {
			if (!targetFolderId) {
				// Ensure folders are loaded
				if (foldersStore.folders.length === 0) {
					await foldersStore.loadFolders();
				}

				const defaultFolder = foldersStore.defaultFolder;
				targetFolderId = defaultFolder?.id;

				// If still no default folder, the API will create one
				if (!targetFolderId) {
					console.warn('No default folder found, API will create one');
				}
			}

				await sessionService.createSession(data.user.id, targetFolderId, agentStore.getCurrentAgentId());
			// Reload sessions to update the UI with the new session
			await sessionService.loadSessions(data.user.id, showArchived);
			// Update local sessions variable to ensure UI refresh
			sessions = sessionStore.getSessions();
			currentSessionId = sessionStore.getCurrentSessionId();
			goto('/');
		} catch (error) {
			console.error('Error creating session:', error);
		} finally {
			newChatPending = false;
		}
	}
	
		// Handle session selection
		function handleSessionSelect(session: ChatSessionRow) {
			sessionStore.setCurrentSessionId(session.id);
			goto('/');
		}
	
	

	// This is our custom Batshit sidebar component
	const menuItems = [
		{
			title: 'Chat',
			icon: MessageSquare,
			href: '/',
			badge: null
		},
		{
			title: 'Memories',
			icon: FileText,
			href: '/memories',
			badge: null
		},
		{
			title: 'Settings',
			icon: Settings,
			href: '/settings',
			badge: null
		}
	];
	
	
function handleUserSettingsClick() {
	settingsInitialTab = 'user';
	settingsInitialAgentId = null;
	settingsInitialToolsTab = null;
	settingsInitialArtifactId = null;
	settingsProjectsMode = null;
	settingsPanelOpen = true;
}

function resolveDefaultSettingsAgentId() {
	const agents = agentStore.getAgents();
	const availableAgentIds = agents.map((agent) => agent.id);
	const sessionAgentId = resolveSessionStoredAgentId({
		session: sessionStore.getCurrentSession(),
		availableAgentIds
	});
	if (sessionAgentId) return sessionAgentId;

	const currentAgentId = agentStore.getCurrentAgentId();
	if (currentAgentId && availableAgentIds.includes(currentAgentId)) return currentAgentId;

	return agents[0]?.id ?? null;
}

function handleUiSettingsClick() {
	settingsInitialTab = 'agents';
	settingsInitialAgentId = resolveDefaultSettingsAgentId();
	settingsInitialToolsTab = null;
	settingsInitialArtifactId = null;
	settingsProjectsMode = null;
	settingsPanelOpen = true;
}
</script>

<style>
	/* Reduce gap between session items */
	:global(.sessions-menu) {
		gap: 0.125rem !important; /* 2px instead of default 4px */
	}

	:global(.main-sidebar-tab-trigger) {
		position: absolute;
		top: 7px;
		right: -32px;
		z-index: var(--z-controls);
		width: 32px;
		height: 32px;
		padding: 0;
		border-width: 1px 1px 1px 0;
		border-style: solid;
		border-color: var(--bs-app-shell-line);
		border-radius: 0 6px 6px 0;
		background: var(--sidebar-background);
		color: var(--muted-foreground);
		box-shadow: none;
		transition:
			background-color 150ms ease-out,
			border-color 150ms ease-out,
			color 150ms ease-out;
	}

	:global(.main-sidebar-tab-trigger:hover) {
		background: var(--bs-app-inset-surface-hover);
		color: var(--bs-app-title);
	}

	:global(.main-sidebar-tab-trigger:focus-visible) {
		border-color: var(--bs-app-primary-soft);
		box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
	}

	:global(.main-sidebar-tab-trigger svg) {
		width: 16px;
		height: 16px;
	}

	:global(.batshit-sidebar) {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: visible;
		background: var(--background);
		color: var(--bs-app-text);
	}

	:global(.batshit-sidebar [data-slot="sidebar-inner"]) {
		overflow: hidden;
	}

	:global(.main-sidebar-header),
	:global(.main-sidebar-footer) {
		height: auto;
		padding: 0.5rem 0.25rem;
		gap: 0.25rem;
	}

	.main-sidebar-header-row,
	.main-sidebar-logo-cell,
	.main-sidebar-footer-actions {
		display: flex;
		align-items: center;
	}

	.main-sidebar-header-row {
		justify-content: space-between;
		padding: 0 0.25rem;
	}

	.main-sidebar-logo-cell {
		min-width: 0;
	}

	.batshit-logo {
		width: 36px;
		height: 18px;
		object-fit: contain;
		flex-shrink: 0;
	}

	:global(.main-sidebar-new-chat-expanded),
	:global(.main-sidebar-new-chat-collapsed),
	:global(.main-sidebar-settings-button) {
		width: 40px;
		height: 40px;
	}

	:global(.main-sidebar-new-chat-expanded) {
		display: flex;
	}

	.main-sidebar-new-chat-tooltip-trigger {
		display: inline-flex;
		cursor: not-allowed;
		border-radius: 0.375rem;
	}

	.main-sidebar-collapsed-new-chat {
		display: none;
		justify-content: center;
		padding: 0.25rem;
	}

	:global(.main-sidebar-new-chat-icon),
	:global(.main-sidebar-settings-icon) {
		width: 16px;
		height: 16px;
	}

	:global(.main-sidebar-settings-icon) {
		width: 16px;
		height: 16px;
	}

	:global(.main-sidebar-content) {
		flex: 1 1 auto;
		min-width: 0;
		overflow-x: hidden;
	}

	:global(.main-sidebar-session-group) {
		height: 100%;
		min-width: 0;
		overflow-x: hidden;
		overflow-y: auto;
	}

	.main-sidebar-empty {
		padding: 2rem 1rem;
		color: var(--bs-app-muted-text);
		text-align: center;
		font-size: 0.875rem;
	}

	:global(.main-sidebar-footer) {
		margin-top: auto;
		padding-bottom: 0.5rem;
	}

	.main-sidebar-archive-button,
	.main-sidebar-user-button {
		border: 0;
		background: transparent;
		color: var(--bs-app-text);
		cursor: pointer;
		transition: background-color 150ms ease-out;
	}

	.main-sidebar-archive-button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: calc(100% - 8px);
		margin: 0 0.25rem 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.375rem;
	}

	.main-sidebar-archive-button:hover,
	.main-sidebar-user-button:hover {
		background: var(--bs-app-inset-surface-hover);
	}

	:global(.main-sidebar-footer-icon) {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.main-sidebar-footer-label {
		color: var(--bs-app-muted-text);
		font-size: 0.75rem;
	}

	.main-sidebar-footer-actions {
		gap: 0.25rem;
		padding: 0 0.25rem;
	}

	.main-sidebar-user-button {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.5rem;
		border-radius: 0.375rem;
	}

	:global(.main-sidebar-user-avatar) {
		width: 32px;
		height: 32px;
	}

	:global(.main-sidebar-user-fallback) {
		background: var(--primary);
		color: var(--primary-foreground);
		font-size: 0.75rem;
	}

	.main-sidebar-user-label {
		color: var(--bs-app-text);
		font-size: 0.75rem;
		font-weight: 500;
	}

	:global(.main-sidebar-settings-button) {
		border: 1px solid var(--bs-app-inner-line);
	}

	.main-sidebar-screen-reader {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	:global([data-slot="sidebar"][data-state="collapsed"] .batshit-sidebar) {
		width: var(--sidebar-width-icon) !important;
	}

	:global([data-slot="sidebar"][data-state="collapsed"] .batshit-sidebar [data-slot="sidebar-inner"]) {
		overflow: hidden;
	}

	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-new-chat-expanded),
	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-content),
	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-archive-button),
	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-user-label) {
		display: none;
	}

	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-collapsed-new-chat) {
		display: flex;
	}

	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-footer-actions) {
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0;
	}

	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-user-button) {
		justify-content: center;
		flex: 0 0 auto;
		padding: 0.25rem;
	}

	:global([data-slot="sidebar"][data-state="collapsed"] .main-sidebar-settings-button) {
		order: -1;
	}
</style>

<Sidebar.Sidebar collapsible="icon" class="batshit-sidebar" data-sidebar="sidebar">
	<!-- Tab-style trigger button (always on outside) -->
	<Sidebar.SidebarTrigger class="main-sidebar-tab-trigger" />
	
	<Sidebar.SidebarHeader class="main-sidebar-header">
		<!-- Header content -->
		<div class="main-sidebar-header-row">
			<!-- Batshit Icon -->
			<div class="main-sidebar-logo-cell">
				<img
					src="/batshit-logo-small.png"
					alt="Batshit"
					class="batshit-logo"
				/>
			</div>
			
			<!-- New Chat Button - only show when expanded -->
			{#if newChatAtCapacity}
				<Tooltip.Provider delayDuration={250} skipDelayDuration={0}>
					<Tooltip.Root disableHoverableContent>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<span {...props} class="main-sidebar-new-chat-tooltip-trigger">
									<Button
										variant="ghost"
										class="main-sidebar-new-chat-expanded"
										onclick={() => handleNewChat(undefined, 'sidebar-header-expanded')}
										disabled={newChatDisabled}
										aria-label={newChatDisabledLabel}
										data-testid="sidebar-new-chat-button-expanded"
									>
										<MessageCirclePlus class="main-sidebar-new-chat-icon" />
										<span class="main-sidebar-screen-reader">New Chat</span>
									</Button>
								</span>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right" align="center" sideOffset={8}>
							Max three active chats at a time
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			{:else}
				<Button
					variant="ghost"
					class="main-sidebar-new-chat-expanded"
					onclick={() => handleNewChat(undefined, 'sidebar-header-expanded')}
					disabled={newChatDisabled}
					aria-label="New Chat"
					title="New Chat"
					data-testid="sidebar-new-chat-button-expanded"
				>
					<MessageCirclePlus class="main-sidebar-new-chat-icon" />
					<span class="main-sidebar-screen-reader">New Chat</span>
				</Button>
			{/if}
		</div>
		
		<!-- New Chat Button - show when collapsed -->
		<div class="main-sidebar-collapsed-new-chat">
			{#if newChatAtCapacity}
				<Tooltip.Provider delayDuration={250} skipDelayDuration={0}>
					<Tooltip.Root disableHoverableContent>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<span {...props} class="main-sidebar-new-chat-tooltip-trigger">
									<Button
										size="icon"
										variant="ghost"
										class="main-sidebar-new-chat-collapsed"
										onclick={() => handleNewChat(undefined, 'sidebar-header-collapsed')}
										disabled={newChatDisabled}
										aria-label={newChatDisabledLabel}
										data-testid="sidebar-new-chat-button-collapsed"
									>
										<MessageCirclePlus class="main-sidebar-new-chat-icon" />
										<span class="main-sidebar-screen-reader">New Chat</span>
									</Button>
								</span>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right" align="center" sideOffset={8}>
							Max three active chats at a time
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			{:else}
				<Button
					size="icon"
					variant="ghost"
					class="main-sidebar-new-chat-collapsed"
					onclick={() => handleNewChat(undefined, 'sidebar-header-collapsed')}
					disabled={newChatDisabled}
					aria-label="New Chat"
					title="New Chat"
					data-testid="sidebar-new-chat-button-collapsed"
				>
					<MessageCirclePlus class="main-sidebar-new-chat-icon" />
					<span class="main-sidebar-screen-reader">New Chat</span>
				</Button>
			{/if}
		</div>
	</Sidebar.SidebarHeader>

	<Sidebar.SidebarContent class="main-sidebar-content">
		<Sidebar.SidebarGroup class="main-sidebar-session-group">
			<Sidebar.SidebarGroupContent>
				{#if reactiveSessions.length === 0}
					<div class="main-sidebar-empty">
						{#if showArchived}
							No archived sessions.
						{:else}
							No sessions yet. Click + to start a new chat.
						{/if}
					</div>
				{:else if !showArchived}
					<!-- Show folder tree for active sessions -->
					<FolderTree
						sessions={reactiveSessions}
						currentSessionId={reactiveCurrentSessionId || undefined}
						{sessionService}
						onSessionSelect={handleSessionSelect}
						onCreateSession={handleNewChat}
					/>
				{:else}
					<!-- Show flat list for archived sessions -->
					<Sidebar.SidebarMenu class="sessions-menu">
						{#each reactiveSessions as session (session.id)}
							{#if sessionService}
								<SessionItem 
									{session} 
									isSelected={reactiveCurrentSessionId === session.id}
									{sessionService}
									isArchived={showArchived}
								/>
							{/if}
						{/each}
					</Sidebar.SidebarMenu>
				{/if}
			</Sidebar.SidebarGroupContent>
		</Sidebar.SidebarGroup>
	</Sidebar.SidebarContent>

	<Sidebar.SidebarFooter class="main-sidebar-footer">
		<!-- Archive Button -->
		<button 
			onclick={() => showArchived = !showArchived}
			class="main-sidebar-archive-button"
			aria-label={showArchived ? "Show active sessions" : "Show archived sessions"}
			title={showArchived ? "Show active sessions" : "Show archived sessions"}
			data-testid="toggle-archives-button"
			data-ab-control="toggle-archives"
		>
			<Archive class="main-sidebar-footer-icon" />
			<span class="main-sidebar-footer-label">Archives</span>
		</button>

		<!-- Settings and User buttons -->
		<div class="main-sidebar-footer-actions">
			<button 
				onclick={handleUserSettingsClick}
				class="main-sidebar-user-button"
				aria-label="Open user settings"
				title="Open user settings"
				data-testid="open-user-settings-button"
				data-ab-control="open-user-settings"
			>
				<EntityAvatar
					avatarUrl={data?.userSettings?.avatar_url || (data?.userSettings?.avatar_icon_ref ? null : '/assets/batshit_default_User_Avatar.png')}
					iconRef={data?.userSettings?.avatar_icon_ref ?? null}
					iconFit={data?.userSettings?.avatar_icon_fit ?? 'fill'}
					label={data?.userSettings?.displayName || data?.user?.email || 'User'}
					fallback={data?.userSettings?.displayName || data?.user?.email || 'User'}
					class="main-sidebar-user-avatar main-sidebar-user-fallback"
					iconClass="text-primary-foreground"
				/>
				<span class="main-sidebar-user-label">
					{data?.userSettings?.displayName || data?.user?.email || 'User'}
				</span>
			</button>
			<Button 
				variant="ghost" 
				size="icon" 
				onclick={handleUiSettingsClick} 
				aria-label="Open settings"
				title="Open Settings"
				data-testid="open-settings-button"
				data-ab-control="open-settings"
				class="main-sidebar-settings-button"
			>
				<Settings class="main-sidebar-settings-icon" />
			</Button>
		</div>
	</Sidebar.SidebarFooter>

	<Sidebar.SidebarRail />
</Sidebar.Sidebar>

<!-- New Settings Panel -->
<SettingsPanel
	bind:open={settingsPanelOpen}
	data={data}
	initialTab={settingsInitialTab}
	initialAgentId={settingsInitialAgentId}
	initialModelId={settingsInitialModelId}
	initialToolsTab={settingsInitialToolsTab}
	initialArtifactId={settingsInitialArtifactId}
	initialProjectsMode={settingsProjectsMode}
	initialProjectsModeNonce={settingsProjectsModeNonce}
/>
