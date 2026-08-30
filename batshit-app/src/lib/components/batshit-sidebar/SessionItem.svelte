<script lang="ts">
	import { Archive, LoaderCircle } from '@lucide/svelte';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import SessionAvatar from '$lib/components/batshit-sidebar/SessionAvatar.svelte';
	import SessionItemMenu from '$lib/components/batshit-sidebar/SessionItemMenu.svelte';
	import ProjectQuickViewDialog from '$lib/components/projects/ProjectQuickViewDialog.svelte';
	import { DEFAULT_AGENT_ICON_REF, DEFAULT_GROUP_ICON_REF } from '$lib/icons/iconCatalog';
	import { normalizeIconRef } from '$lib/icons/iconLegacy';
	import { normalizeAvatarIconFit } from '$lib/icons/iconTypes';
	import * as agentStore from '$lib/stores/agents.svelte';
	import * as groupStore from '$lib/stores/groups.svelte';
	import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte';
	import {
		AlertDialog,
		AlertDialogAction,
		AlertDialogCancel,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '$lib/components/ui/alert-dialog';
	import type { ChatSession } from '$lib/stores/session.svelte';
	import { SessionService } from '$lib/services/sessions';
	import { isFixedSession } from '$lib/utils/fixedSession';
	
	interface Props {
		session: ChatSession;
		isSelected: boolean;
		sessionService: SessionService | null;
		isArchived?: boolean;
	}
	
	const { session, isSelected, sessionService, isArchived = false }: Props = $props();
	const groupChatEnabled = $derived(Boolean(session?.metadata?.group_chat?.group_id))
	const sessionGroupId = $derived(readString(session?.metadata?.group_chat?.group_id))
	const sessionGroup = $derived(sessionGroupId ? groupStore.getGroupById(sessionGroupId) : null)
	const sessionAgentId = $derived(
		readString(
			session.agent_id,
			session?.metadata?.last_agent_id,
			session?.metadata?.lastAgentId,
			session?.metadata?.agent_id,
			session?.metadata?.agentId
		)
	)
	const sessionAgent = $derived.by(() => {
		if (sessionGroupId) return null
		const currentAgent = agentStore.getCurrentAgent()
		if (isSelected && currentAgent) return currentAgent
		return sessionAgentId ? agentStore.getAgentById(sessionAgentId) : null
	})
	const sessionAvatarLabel = $derived(
		sessionGroupId
			? sessionGroup?.name || 'Group'
			: sessionAgent?.displayName || 'AI'
	)
	const sessionAvatarUrl = $derived(
		sessionGroupId
			? readString(sessionGroup?.avatar_url)
			: sessionAgent?.avatar_url || sessionAgent?.avatar || (sessionAgent?.avatar_icon_ref ? null : '/assets/batshit_default_AI_Avatar_1.png')
	)
	const sessionGroupAvatarIconRef = $derived(
		sessionGroupId ? normalizeIconRef(sessionGroup?.avatar_icon_ref, DEFAULT_GROUP_ICON_REF) : null
	)
	const sessionGroupAvatarIconFit = $derived(
		sessionGroupId ? normalizeAvatarIconFit(sessionGroup?.avatar_icon_fit) : 'fill'
	)
	const sessionAvatarIconRef = $derived(
		sessionGroupId
			? sessionGroupAvatarIconRef
			: sessionAgent?.avatar_icon_ref
				? normalizeIconRef(sessionAgent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF)
				: null
	)
	const sessionAvatarIconFit = $derived(
		sessionGroupId ? sessionGroupAvatarIconFit : normalizeAvatarIconFit(sessionAgent?.avatar_icon_fit)
	)
	const sessionAvatarFallback = $derived(sessionGroupId ? 'GR' : 'AI')
	const sessionTitle = $derived(session.name || session.id)
	const isSessionLocked = $derived(Boolean(session.locked))
	const sessionMenuLabel = $derived(`${sessionTitle} chat session settings`)
	const sessionRunState = $derived.by(() => chatRunRegistry.getRunState(session.id))
	const isSessionRunning = $derived(chatRunRegistry.isRunActive(sessionRunState))
	const sessionRunLabel = $derived.by(() => {
		if (!isSessionRunning) return null
		if (sessionRunState.status === 'stopping') return 'Stopping'
		if (sessionRunState.status === 'tooling') return 'Using tools'
		if (sessionRunState.status === 'submitting') return 'Starting'
		return 'Running'
	})
	
	// State for editing
		let currentEditName = $state('');
		let currentEditId = $state('');
	let nameSaveSuccess = $state(false);
	let idSaveSuccess = $state(false);
	let showDeleteDialog = $state(false);
	let markdownQuickViewOpen = $state(false);
	let markdownQuickViewContent = $state('');
	let markdownQuickViewError = $state<string | null>(null);
	let markdownQuickViewLoading = $state(false);
	let markdownQuickViewPath = $state('');
	let markdownQuickViewSize = $state<number | null>(null);
	let hasSessionMessages = $state(false);
	let checkingMessageState = $state(false);
	let lockUpdatePending = $state(false);
	const isIdEditingDisabled = $derived(Boolean(isSessionLocked || hasSessionMessages))

	// SA-104 P5: Infinite Session state + the one-way transition flow.
	const isSessionFixed = $derived(isFixedSession(session))
	const canBecomeFixed = $derived(
		!isSessionFixed && !hasSessionMessages && !session.archived && !groupChatEnabled
	)
	let showFixedConfirmDialog = $state(false)
	let fixedUpdatePending = $state(false)
	let episodeSummary = $state<{
		openedAt: string | null
		holdUntil: string | null
		closedCount: number
		hasWhiteboard: boolean
		whiteboardUpdatedAt: string | null
	} | null>(null)

	function requestFixedSession() {
		if (!canBecomeFixed || fixedUpdatePending) return
		showFixedConfirmDialog = true
	}

	async function confirmFixedSession() {
		if (!sessionService || fixedUpdatePending) return
		fixedUpdatePending = true
		try {
			await sessionService.makeSessionFixed(session.id)
			showFixedConfirmDialog = false
			const { toast } = await import('svelte-sonner')
			toast.success('This chat is now an Infinite Session. It is locked and pinned to the top of the sidebar.')
		} catch (error) {
			console.error('Failed to make session fixed:', error)
			const { toast } = await import('svelte-sonner')
			toast.error(error instanceof Error ? error.message : 'Failed to make this an Infinite Session.')
		} finally {
			fixedUpdatePending = false
		}
	}

	async function refreshEpisodeSummary() {
		if (!isSessionFixed) {
			episodeSummary = null
			return
		}
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/episodes`)
			if (!response.ok) return
			const payload = await response.json()
			episodeSummary = {
				openedAt: payload?.open?.opened_at ?? null,
				holdUntil: payload?.open?.hold_until ?? null,
				closedCount: Number(payload?.closedCount) || 0,
				hasWhiteboard: Boolean(payload?.open?.whiteboard),
				whiteboardUpdatedAt: payload?.open?.whiteboard_updated_at ?? null
			}
		} catch (error) {
			console.warn('Failed to load episode state:', error)
		}
	}

	function readString(...values: unknown[]): string | null {
		for (const value of values) {
			if (typeof value !== 'string') continue
			const trimmed = value.trim()
			if (trimmed.length > 0) return trimmed
		}
		return null
	}

	async function handleMenuOpenChange(open: boolean) {
		if (!open) return;
		currentEditName = session.name || session.id;
		currentEditId = session.id;
		await Promise.all([refreshSessionMessageState(), refreshEpisodeSummary()]);
	}

	async function refreshSessionMessageState() {
		if (!sessionService) return;
		checkingMessageState = true;
		try {
			hasSessionMessages = await sessionService.sessionHasMessages(session.id);
			if (hasSessionMessages) {
				currentEditId = session.id;
			}
		} finally {
			checkingMessageState = false;
		}
	}
	
	// Handle name save
	async function handleNameSave() {
		if (!sessionService) return;
		try {
			await sessionService.updateSessionName(session.id, currentEditName);
			nameSaveSuccess = true;
			setTimeout(() => {
				nameSaveSuccess = false;
			}, 2000);
		} catch (error) {
			console.error('Failed to update session name:', error);
		}
	}
	
	// Handle ID save
	async function handleIdSave() {
		if (!sessionService || isIdEditingDisabled || !currentEditId || currentEditId.trim() === '') return;
		
		try {
			const success = await sessionService.updateSessionId(session.id, currentEditId.trim());
			if (!success) {
				const { toast } = await import('svelte-sonner');
				toast.error('Cannot update: Session is locked, ID exists, or this session already has messages.');
				currentEditId = session.id;
			} else {
				idSaveSuccess = true;
				// Show success toast
				const { toast } = await import('svelte-sonner');
				toast.success(`Session ID updated to ${currentEditId.trim()}`);
				setTimeout(() => {
					idSaveSuccess = false;
				}, 2000);
			}
		} catch (error) {
			console.error('Failed to update session ID:', error);
			const { toast } = await import('svelte-sonner');
			toast.error('Error updating session ID. Check console for details.');
			currentEditId = session.id;
		}
	}
	
	// Handle session selection
	function handleSelect() {
		sessionService?.selectSession(session.id);
	}

	async function handleLockToggle(checked: boolean) {
		if (!sessionService || lockUpdatePending) return;
		lockUpdatePending = true;
		try {
			await sessionService.updateSessionLock(session.id, checked);
			const { toast } = await import('svelte-sonner');
			toast.success(checked ? 'Session locked. Unlock it before deleting.' : 'Session unlocked.');
		} catch (error) {
			console.error('Failed to update session lock:', error);
			const { toast } = await import('svelte-sonner');
			toast.error('Failed to update lock state. Please try again.');
		} finally {
			lockUpdatePending = false;
		}
	}

	async function handleViewMarkdown(toolResultMode: 'full' | 'summary') {
		if (typeof window === 'undefined') return;
		const url = new URL(`/api/sessions/${encodeURIComponent(session.id)}/markdown`, window.location.origin);
		if (toolResultMode === 'summary') {
			url.searchParams.set('toolResults', 'summary');
		}

		markdownQuickViewOpen = true;
		markdownQuickViewLoading = true;
		markdownQuickViewError = null;
		markdownQuickViewContent = '';
		markdownQuickViewSize = null;
		markdownQuickViewPath = `${sessionTitle} ${toolResultMode === 'summary' ? '(without tool results)' : '(with tool results)'}.md`;

		try {
			const response = await fetch(url.toString(), { headers: { Accept: 'text/markdown' } });
			if (!response.ok) {
				const message = await response.text().catch(() => '');
				throw new Error(message || `Failed to load markdown transcript (${response.status})`);
			}
			const markdown = await response.text();
			markdownQuickViewContent = markdown;
			markdownQuickViewSize = new Blob([markdown]).size;
		} catch (error) {
			console.error('Failed to open session markdown quick view:', error);
			markdownQuickViewError =
				error instanceof Error ? error.message : 'Failed to load markdown transcript.';
		} finally {
			markdownQuickViewLoading = false;
		}
	}
	
	// Handle session deletion
	async function handleDelete() {
		if (isSessionLocked) {
			const { toast } = await import('svelte-sonner');
			toast.error('Session is locked. Unlock it before deleting.');
			return;
		}
		showDeleteDialog = true;
	}

	async function confirmDelete() {
		try {
			// Show loading toast
			const { toast } = await import('svelte-sonner');
			const loadingToast = toast.loading('Deleting session...');
			
			// Attempt deletion
			const success = await sessionService?.deleteSession(session.id);
			
			// Dismiss loading toast
			toast.dismiss(loadingToast);
			
			if (success) {
				// Show success message
				toast.success('Session deleted successfully');
				showDeleteDialog = false;
			} else {
				// Show error if deletion returned false
				toast.error('Failed to delete session. Please try again.');
				console.error('Session deletion returned false for:', session.id);
			}
		} catch (error) {
			// Handle any errors that occur
			const { toast } = await import('svelte-sonner');
			console.error('Failed to delete session:', error);
			
			// Show user-friendly error message
			if (error instanceof Error && /locked/i.test(error.message)) {
				toast.error('Session is locked. Unlock it before deleting.');
			} else if (error instanceof Error) {
				toast.error(`Failed to delete session: ${error.message}`);
			} else {
				toast.error('Failed to delete session. Please check the console for details.');
			}
		}
	}
	
	// Handle session archiving
	async function handleArchive() {
		try {
			const { toast } = await import('svelte-sonner');
			const loadingToast = toast.loading('Archiving session...');
			
			const success = await sessionService?.archiveSession(session.id);
			
			toast.dismiss(loadingToast);
			
			if (success) {
				toast.success('Session archived successfully');
			} else {
				toast.error('Failed to archive session. Please try again.');
			}
		} catch (error) {
			const { toast } = await import('svelte-sonner');
			console.error('Failed to archive session:', error);
			toast.error('Failed to archive session. Please check the console for details.');
		}
	}
	
	// Handle session unarchiving
	async function handleUnarchive() {
		try {
			const { toast } = await import('svelte-sonner');
			const loadingToast = toast.loading('Unarchiving session...');
			
			const success = await sessionService?.unarchiveSession(session.id);
			
			toast.dismiss(loadingToast);
			
			if (success) {
				toast.success('Session unarchived successfully');
			} else {
				toast.error('Failed to unarchive session. Please try again.');
			}
		} catch (error) {
			const { toast } = await import('svelte-sonner');
			console.error('Failed to unarchive session:', error);
			toast.error('Failed to unarchive session. Please check the console for details.');
		}
	}
</script>

<style>
	/* Use :global() for classes that Svelte can't detect are used */
	:global(.session-item-button) {
		width: 100%;
		max-width: 100%;
		min-width: 0;
		height: auto;
		overflow: hidden;
		padding: 0.5rem 0.75rem; /* Reduced from default ~0.75rem 1rem */
	}

	:global(.session-item-button.is-selected) {
		background: var(--sidebar-accent);
	}
	
	.session-item-text {
		font-size: 0.813rem; /* 13px - same as dropdowns */
		line-height: 1.2;
	}
	
	.session-item-container {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		min-width: 0;
		overflow: hidden;
		gap: 0;
	}
	
	.session-item-name {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-left: 0.5rem;
		max-width: 100%;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}

	.session-item-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-item-run-status {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		margin-left: 0.25rem;
		color: var(--bs-app-primary);
		line-height: 1;
		width: 0.75rem;
		height: 0.75rem;
	}

	:global(.session-item-run-status-icon) {
		width: 0.75rem;
		height: 0.75rem;
		animation: session-item-spin 1s linear infinite;
	}

	@keyframes session-item-spin {
		to {
			transform: rotate(360deg);
		}
	}

	:global(.session-item-title-tooltip-trigger) {
		display: inline-flex;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
	}

	:global(.session-item-title-tooltip) {
		max-width: min(22rem, calc(100vw - 2rem));
		white-space: normal;
		text-align: left;
		overflow-wrap: anywhere;
	}

	.session-item-name.is-archived {
		color: var(--bs-app-muted-text);
	}

	:global(.session-item-archived-icon) {
		width: 12px;
		height: 12px;
		flex-shrink: 0;
	}

	.session-item-group-badge {
		margin-left: 0.5rem;
		padding: 0.125rem 0.375rem;
		border: 1px solid color-mix(in oklab, var(--primary) 30%, transparent);
		border-radius: 999px;
		background: color-mix(in oklab, var(--primary) 10%, transparent);
		color: var(--primary);
		font-size: 0.5625rem;
		font-weight: 600;
	}
	
	:global(.session-delete-action) {
		background: var(--destructive);
		color: var(--destructive-foreground);
	}

	:global(.session-delete-action:hover) {
		background: color-mix(in oklab, var(--destructive) 90%, black);
	}

</style>

<Sidebar.SidebarMenuItem>
	<Sidebar.SidebarMenuButton 
		class={`session-item-button ${isSelected ? 'is-selected' : ''}`}
		onclick={handleSelect}
		aria-label={`Open chat session ${sessionTitle}`}
		data-testid={`session-row-${session.id}`}
	>
		<div class="session-item-container">
			<SessionAvatar
				avatarUrl={sessionAvatarUrl}
				avatarLabel={sessionAvatarLabel}
				iconRef={sessionAvatarIconRef}
				iconFit={sessionAvatarIconFit}
				fallback={sessionAvatarFallback}
			/>
			<span class={`session-item-text session-item-name ${session.archived ? 'is-archived' : ''}`}>
				{#if session.archived}
					<Archive class="session-item-archived-icon" />
				{/if}
				<Tooltip.Provider delayDuration={900} skipDelayDuration={0}>
					<Tooltip.Root disableHoverableContent>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<span {...props} class="session-item-title-tooltip-trigger">
									<span class="session-item-title">{sessionTitle}</span>
								</span>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="right" align="center" sideOffset={8} class="session-item-title-tooltip">
							{sessionTitle}
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
				{#if groupChatEnabled}
					<span class="session-item-group-badge">
						Group
					</span>
				{/if}
				{#if isSessionFixed}
					<span class="session-item-group-badge session-item-fixed-badge" title="Infinite Session: one agent, one ongoing conversation">
						Infinite
					</span>
				{/if}
				{#if sessionRunLabel}
					<span
						class="session-item-run-status"
						aria-label={`${sessionTitle} is ${sessionRunLabel.toLowerCase()}`}
						title={sessionRunLabel}
						data-testid={`session-run-status-${session.id}`}
					>
						<LoaderCircle class="session-item-run-status-icon" aria-hidden="true" />
					</span>
				{/if}
			</span>
			<SessionItemMenu
				menuLabel={sessionMenuLabel}
				sessionId={session.id}
				sessionName={sessionTitle}
				bind:currentEditName
				bind:currentEditId
				{nameSaveSuccess}
				{idSaveSuccess}
				{isIdEditingDisabled}
				{checkingMessageState}
				{isSessionLocked}
				{lockUpdatePending}
				{isArchived}
				{isSessionFixed}
				{canBecomeFixed}
				{fixedUpdatePending}
				{groupChatEnabled}
				{episodeSummary}
				onMenuOpenChange={handleMenuOpenChange}
				onNameSave={handleNameSave}
				onIdSave={handleIdSave}
				onLockToggle={handleLockToggle}
				onFixedRequest={requestFixedSession}
				onViewMarkdown={handleViewMarkdown}
				onArchive={handleArchive}
				onUnarchive={handleUnarchive}
				onDelete={handleDelete}
			/>
		</div>
	</Sidebar.SidebarMenuButton>
</Sidebar.SidebarMenuItem>

<AlertDialog bind:open={showDeleteDialog}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Delete Session?</AlertDialogTitle>
			<AlertDialogDescription>
				{#if isSessionLocked}
					This session is locked. Unlock it to allow deletion.
				{:else}
					This will permanently delete this session. This action cannot be undone.
				{/if}
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel onclick={() => (showDeleteDialog = false)}>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmDelete} class="session-delete-action" disabled={isSessionLocked}>
				Delete Session
			</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

<AlertDialog bind:open={showFixedConfirmDialog}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Make This an Infinite Session?</AlertDialogTitle>
			<AlertDialogDescription>
				An Infinite Session is one agent living in one ongoing conversation. It is locked
				against deletion, pinned to the top of the sidebar, and cannot go back to being a
				regular chat. Group chat is not available in Infinite Sessions. Tip: set a custom
				Session ID in this menu first, because the ID cannot change after the first
				message.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel onclick={() => (showFixedConfirmDialog = false)}>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmFixedSession} disabled={fixedUpdatePending}>
				Make Infinite Session
			</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

<ProjectQuickViewDialog
	bind:open={markdownQuickViewOpen}
	path={markdownQuickViewPath}
	content={markdownQuickViewContent}
	loading={markdownQuickViewLoading}
	error={markdownQuickViewError}
	size={markdownQuickViewSize}
	mtime={null}
	language="markdown"
	tooLarge={false}
	previewLimitBytes={Number.MAX_SAFE_INTEGER}
/>
