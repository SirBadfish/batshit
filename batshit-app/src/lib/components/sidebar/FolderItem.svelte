<script lang="ts">
  import { CheckCircle2, Folder, FolderOpen, MessageCirclePlus, MoreVertical, Trash2, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import type { ChatFolderRow, ChatSessionRow } from '$lib/types/database'
  import { foldersStore } from '$lib/stores/folders.svelte'
  import SessionItem from '$lib/components/batshit-sidebar/SessionItem.svelte'
  import { SessionService } from '$lib/services/sessions'
  import { dndzone, TRIGGERS } from 'svelte-dnd-action'
  import { flip } from 'svelte/animate'
  import { toast } from 'svelte-sonner'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  
  interface Props {
    folder: ChatFolderRow
    sessions: ChatSessionRow[]
    currentSessionId?: string
    sessionService?: any
    onSessionSelect: (session: ChatSessionRow) => void
    onCreateSession: (folderId: string, source?: string) => void
    onRenameFolder?: (folder: ChatFolderRow) => void
    onDeleteFolder?: (folder: ChatFolderRow) => void
    onDeleteFolderWithSessions?: (folder: ChatFolderRow) => void
  }
  
  let { 
    folder, 
    sessions = [],
    currentSessionId,
    sessionService,
    onSessionSelect,
    onCreateSession,
    onRenameFolder,
    onDeleteFolder,
    onDeleteFolderWithSessions
  }: Props = $props()
  
let isRenaming = $state(false)
let newName = $state('')
let isExpanded = $state(false)
let lastExpanded = $state<boolean | null>(null)
let isDragging = $state(false)
let bulkDeleteMode = $state(false)
let folderMenuOpen = $state(false)
let selectedSessionIds = $state<Set<string>>(new Set())
let createChatLabel = $derived(`Create new chat in ${folder.name}`)
let folderSettingsLabel = $derived(
  folder.is_default ? `${folder.name} default chat folder settings` : `${folder.name} chat folder settings`
)
  
  // Filter sessions for this folder
  let folderSessions = $derived(
    sessions.filter(s => s.folder_id === folder.id && !s.archived)
      .sort((a, b) => {
        // Sort by last modified, most recent first
        const aTime = new Date(a.last_modified_at || a.created_at).getTime()
        const bTime = new Date(b.last_modified_at || b.created_at).getTime()
        return bTime - aTime
      })
  )
  
let sessionCount = $derived(folderSessions.length)
let selectableSessionIds = $derived(folderSessions.map((session) => session.id))
let allSessionsSelected = $derived(
  selectableSessionIds.length > 0 && selectedSessionIds.size === selectableSessionIds.length
)

	$effect(() => {
	  if (folder.is_expanded !== lastExpanded) {
	    isExpanded = folder.is_expanded
	    lastExpanded = folder.is_expanded
	  }
	})

	$effect(() => {
	  if (!selectedSessionIds.size) return
	  const validIds = new Set(folderSessions.map((session) => session.id))
	  const filtered = Array.from(selectedSessionIds).filter((id) => validIds.has(id))
  if (filtered.length !== selectedSessionIds.size) {
    selectedSessionIds = new Set(filtered)
  }
})
  
	  function toggleExpanded() {
	    const nextExpanded = !isExpanded
	    isExpanded = nextExpanded
	    foldersStore.updateFolder(folder.id, { is_expanded: nextExpanded })
	  }
  
  async function handleRename() {
    if (newName && newName !== folder.name) {
      const success = await foldersStore.renameFolder(folder.id, newName)
      if (success) {
        folder.name = newName
      }
    }
    isRenaming = false
  }
  
  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      handleRename()
    } else if (e.key === 'Escape') {
      newName = folder.name
      isRenaming = false
    }
  }
  
function startRenaming() {
  isRenaming = true
  newName = folder.name
  setTimeout(() => {
    const input = document.querySelector(`#folder-rename-${folder.id}`) as HTMLInputElement
    input?.select()
  }, 0)
}

function toggleBulkDeleteMode() {
  bulkDeleteMode = !bulkDeleteMode
  if (!bulkDeleteMode) {
    selectedSessionIds = new Set()
  }
}

function toggleSessionSelection(sessionId: string, checked: boolean) {
  const next = new Set(selectedSessionIds)
  if (checked) {
    next.add(sessionId)
  } else {
    next.delete(sessionId)
  }
  selectedSessionIds = next
}

function isSessionSelected(sessionId: string) {
  return selectedSessionIds.has(sessionId)
}

function toggleAllSessionSelection() {
  selectedSessionIds = allSessionsSelected ? new Set() : new Set(selectableSessionIds)
}

async function handleSetAsDefault() {
  await foldersStore.setDefaultFolder(folder.id)
}

async function handleBulkDeleteSessions() {
  if (!sessionService || selectedSessionIds.size === 0) {
    return
  }
  const count = selectedSessionIds.size
  const confirmed = await confirmDialog({
    title: `Delete ${count} session${count === 1 ? '' : 's'}?`,
    description: 'This permanently deletes the selected chat sessions. This action cannot be undone.',
    confirmLabel: 'Delete Sessions',
    tone: 'destructive'
  })
  if (!confirmed) {
    return
  }

  const loadingToast = toast.loading('Deleting sessions...')
  try {
    await sessionService.deleteSessions(Array.from(selectedSessionIds))
    toast.success(`Deleted ${count} session${count === 1 ? '' : 's'}`)
    selectedSessionIds = new Set()
    bulkDeleteMode = false
  } catch (error) {
    console.error('Failed to bulk delete sessions:', error)
    toast.error('Failed to delete sessions')
  } finally {
    toast.dismiss(loadingToast)
  }
}

  // Handle drag and drop
  function handleDndConsider(e: CustomEvent) {
    const { items, info } = e.detail
    folderSessions = items
    isDragging = info.trigger === TRIGGERS.DRAG_STARTED
  }

  async function handleDndFinalize(e: CustomEvent) {
    const { items, info } = e.detail
    folderSessions = items
    isDragging = false

    // If the item was dropped from another folder
    if (info.trigger === TRIGGERS.DROPPED_INTO_ZONE) {
      const droppedItem = items.find((item: ChatSessionRow) => item.id === info.id)
      if (droppedItem && droppedItem.folder_id !== folder.id) {
        // Move the session to this folder
        const result = await foldersStore.moveSessionsToFolder(folder.id, [droppedItem.id])
        if (result.success) {
          // Update the session's folder_id
          droppedItem.folder_id = folder.id
          // Reload sessions to update UI
          if (sessionService) {
            await sessionService.loadSessions(folder.user_id, false)
          }
        }
      }
    }
  }
</script>

<div class="folder-item">
  <Collapsible.Root open={isExpanded}>
    <div class="folder-row-header">
      <Collapsible.Trigger
        class="folder-row-trigger"
        onclick={toggleExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} folder ${folder.name}`}
        title={`${isExpanded ? 'Collapse' : 'Expand'} folder ${folder.name}`}
        data-testid={`folder-toggle-${folder.id}`}
      >
        {#if isExpanded}
          <FolderOpen class="folder-row-icon" />
        {:else}
          <Folder class="folder-row-icon" />
        {/if}
        
        {#if isRenaming}
          <input
            id="folder-rename-{folder.id}"
            type="text"
            bind:value={newName}
            onblur={handleRename}
            onkeydown={handleRenameKeydown}
            class="folder-row-rename-input"
            onclick={(e) => e.stopPropagation()}
          />
        {:else}
          <span class="folder-row-title">
            {folder.name}
            {#if folder.is_default}
              <span class="folder-row-default-badge">Default</span>
            {/if}
          </span>
        {/if}
      </Collapsible.Trigger>
      
      <div class={`folder-row-actions ${folderMenuOpen ? 'is-open' : ''}`}>
        <Button
          variant="ghost"
          size="icon"
          class="folder-row-icon-button"
          onclick={() => onCreateSession(folder.id, 'folder-row')}
          aria-label={createChatLabel}
          title={createChatLabel}
          data-testid={`chat-folder-new-chat-button-${folder.id}`}
        >
          <span class="folder-row-screen-reader">{createChatLabel}</span>
          <MessageCirclePlus class="folder-row-new-chat-icon" />
        </Button>
        
        <DropdownMenu.Root onOpenChange={(open) => (folderMenuOpen = open)}>
            <DropdownMenu.Trigger
              class="folder-row-menu-trigger"
              aria-label={folderSettingsLabel}
              title={folderSettingsLabel}
              data-testid={`chat-folder-settings-button-${folder.id}`}
            >
              <span class="folder-row-screen-reader">{folderSettingsLabel}</span>
              <MoreVertical class="folder-row-small-icon" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content
              side="right"
              align="start"
              class="folder-row-menu-content"
              data-sidebar-overlay-popover="true"
            >
              {#if folder.is_default}
                <div class="folder-row-menu-note">(default)</div>
                <DropdownMenu.Separator />
              {/if}
              <DropdownMenu.Item onclick={startRenaming}>
                Rename
              </DropdownMenu.Item>
              {#if !folder.is_default}
                <DropdownMenu.Item onclick={() => handleSetAsDefault()}>
                  Set as Default
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Item onclick={toggleBulkDeleteMode}>
                {bulkDeleteMode ? 'Cancel Bulk Delete' : 'Bulk Delete Sessions'}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              {#if folder.is_default}
                <DropdownMenu.Item disabled class="folder-row-menu-muted">
                  Cannot delete default
                </DropdownMenu.Item>
              {:else}
                <DropdownMenu.Item 
                  onclick={() => onDeleteFolder?.(folder)}
                  class="folder-row-menu-danger"
                >
                  Delete Folder Only
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onclick={() => onDeleteFolderWithSessions?.(folder)}
                  class="folder-row-menu-danger"
                >
                  Delete Folder + Sessions
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
      </div>
    </div>
    
    <Collapsible.Content>
      {#if bulkDeleteMode}
        <div class="folder-row-bulk-actions">
          <Button
            variant="destructive"
            size="sm"
            class="folder-row-bulk-button"
            disabled={selectedSessionIds.size === 0}
            onclick={handleBulkDeleteSessions}
          >
            <Trash2 class="folder-row-button-icon" />
            Delete Selected ({selectedSessionIds.size})
          </Button>
          <div class="folder-row-bulk-secondary-actions">
            <Button
              variant="ghost"
              size="sm"
              onclick={toggleAllSessionSelection}
              class="folder-row-bulk-button"
              disabled={folderSessions.length === 0}
            >
              <CheckCircle2 class="folder-row-button-icon" />
              {allSessionsSelected ? 'Clear All' : 'Select All'}
            </Button>
            <Button variant="ghost" size="sm" onclick={toggleBulkDeleteMode} class="folder-row-bulk-button">
              <X class="folder-row-button-icon" />
              Cancel
            </Button>
          </div>
        </div>
      {/if}
      <ul 
        class="folder-row-session-list"
        use:dndzone={{
          items: folderSessions,
          dropTargetStyle: { 
            outline: '2px dashed var(--bs-app-primary-soft)',
            borderRadius: '0.375rem',
            backgroundColor: 'var(--bs-app-primary-faint)'
          },
          dragDisabled: false,
          dropFromOthersDisabled: false,
          type: 'sessions'
        }}
        onconsider={handleDndConsider}
        onfinalize={handleDndFinalize}
      >
        {#each folderSessions as session (session.id)}
          <li class={`folder-row-session-item ${bulkDeleteMode ? 'is-bulk-delete' : ''}`} animate:flip={{ duration: 200 }}>
            <div class="folder-row-session">
              {#if bulkDeleteMode}
                <input
                  type="checkbox"
                  class="folder-row-session-checkbox"
                  checked={isSessionSelected(session.id)}
                  onchange={(event) => toggleSessionSelection(session.id, (event.target as HTMLInputElement).checked)}
                />
              {/if}
              <div class={`folder-row-session-shell ${bulkDeleteMode ? 'is-bulk-disabled' : ''}`}>
                <SessionItem
                  {session}
                  isSelected={session.id === currentSessionId}
                  {sessionService}
                  isArchived={false}
                />
              </div>
            </div>
          </li>
        {/each}
        
        {#if folderSessions.length === 0}
          <li class="folder-row-session-item">
            <div class="folder-row-empty">
              No chats in this folder
            </div>
          </li>
        {/if}
      </ul>
    </Collapsible.Content>
  </Collapsible.Root>
</div>

<style>
  .folder-item {
    width: 100%;
  }
  
  .folder-row-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    cursor: pointer;
    user-select: none;
  }

  .folder-row-header:hover .folder-row-actions,
  .folder-row-header:focus-within .folder-row-actions,
  .folder-row-actions.is-open {
    flex-basis: 3.25rem;
    width: 3.25rem;
    gap: 0.25rem;
    overflow: visible;
    opacity: 1;
    pointer-events: auto;
  }

  :global(.folder-row-trigger) {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  :global(.folder-row-icon) {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--bs-app-muted-text);
  }

  .folder-row-rename-input {
    flex: 1 1 auto;
    border: 0;
    border-bottom: 1px solid var(--bs-app-primary-soft);
    background: transparent;
    color: var(--bs-app-field-text);
    font-size: 0.75rem;
    outline: none;
  }

  .folder-row-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    overflow: hidden;
    color: var(--bs-app-title);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    font-weight: 700;
  }

  .folder-row-default-badge {
    padding: 0.125rem 0.375rem;
    border-radius: 999px;
    background: var(--bs-app-field);
    color: var(--bs-app-muted-text);
    font-size: 0.625rem;
    text-transform: uppercase;
  }

  .folder-row-actions {
    display: flex;
    flex: 0 0 0;
    align-items: center;
    gap: 0;
    width: 0;
    min-width: 0;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition:
      flex-basis 150ms ease-out,
      width 150ms ease-out,
      opacity 150ms ease-out;
  }

  :global(.folder-row-icon-button),
  :global(.folder-row-menu-trigger) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    color: var(--bs-app-text);
    font-size: 0.75rem;
    font-weight: 500;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.folder-row-menu-trigger) {
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  :global(.folder-row-icon-button:hover),
  :global(.folder-row-menu-trigger:hover) {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.folder-row-menu-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
  }

  :global(.folder-row-small-icon) {
    width: 12px;
    height: 12px;
  }

  :global(.folder-row-new-chat-icon) {
    width: 14px;
    height: 14px;
  }

  :global(.folder-row-menu-content) {
    width: 220px;
  }

  .folder-row-menu-note {
    padding: 0.375rem 0.5rem;
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  :global(.folder-row-menu-muted) {
    color: var(--bs-app-muted-text);
  }

  :global(.folder-row-menu-danger) {
    color: var(--destructive);
  }

  .folder-row-bulk-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    font-size: 0.75rem;
  }

  .folder-row-bulk-secondary-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
    min-width: 0;
  }

  :global(.folder-row-bulk-button) {
    width: 100%;
    height: 1.5rem;
    justify-content: center;
    gap: 0.3rem;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 620;
    line-height: 1;
    letter-spacing: 0;
    box-shadow: none;
  }

  :global(.folder-row-bulk-button.bs-button-destructive) {
    border-color: color-mix(in oklab, var(--destructive) 42%, var(--bs-app-line));
    background: color-mix(in oklab, var(--destructive) 34%, var(--bs-app-field));
    color: color-mix(in oklab, var(--destructive) 18%, var(--bs-app-primary-foreground));
  }

  :global(.folder-row-bulk-button.bs-button-destructive:hover:not(:disabled)) {
    border-color: color-mix(in oklab, var(--destructive) 60%, var(--bs-app-line-strong));
    background: color-mix(in oklab, var(--destructive) 44%, var(--bs-app-field-hover));
    color: var(--bs-app-primary-foreground);
  }

  :global(.folder-row-bulk-button.bs-button-ghost) {
    border-color: transparent;
    background: transparent;
    color: var(--bs-app-text);
    font-weight: 560;
  }

  :global(.folder-row-bulk-button.bs-button-ghost:hover:not(:disabled)) {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.folder-row-button-icon) {
    width: 0.8rem;
    height: 0.8rem;
  }

  .folder-row-session-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    min-width: 0;
    overflow-x: hidden;
    padding-left: 0;
    list-style: none;
  }

  .folder-row-session-item {
    min-width: 0;
    list-style: none;
  }

  .folder-row-session {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
  }

  .folder-row-session-checkbox {
    width: 16px;
    height: 16px;
    accent-color: var(--destructive);
  }

  .folder-row-session-shell {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
  }

  .folder-row-session-shell.is-bulk-disabled {
    pointer-events: none;
    opacity: 0.7;
  }

  .folder-row-empty {
    padding: 0.25rem 0.5rem;
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
    font-style: italic;
  }

  .folder-row-screen-reader {
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
  
  /* Ensure no bullets on any list items */
  .folder-item ul {
    list-style: none !important;
    min-height: 30px; /* Ensure drop zone has minimum height */
  }
  
  .folder-item li {
    list-style: none !important;
    cursor: move; /* Show that items are draggable */
    transition: transform 0.2s;
  }
  
  .folder-row-session-item:not(.is-bulk-delete):hover {
    transform: translateX(2px);
  }
  
  .folder-item li::before {
    content: none !important;
  }
  
  /* Style for item being dragged */
  :global(.folder-item [aria-grabbed="true"]) {
    opacity: 0.5;
    cursor: grabbing !important;
  }
  
  /* Style for drop zone when dragging over */
  :global(.folder-item .droppable) {
    background-color: var(--bs-app-primary-faint);
  }
</style>
