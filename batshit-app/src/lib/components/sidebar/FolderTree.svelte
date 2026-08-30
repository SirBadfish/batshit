<script lang="ts">
  import { onMount } from 'svelte'
  import { FolderPlus, Infinity as InfinityIcon, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import FolderItem from './FolderItem.svelte'
  import SessionItem from '$lib/components/batshit-sidebar/SessionItem.svelte'
  import * as Sidebar from '$lib/components/ui/sidebar'
  import type { ChatSessionRow } from '$lib/types/database'
  import { foldersStore } from '$lib/stores/folders.svelte'
  import { isFixedSession } from '$lib/utils/fixedSession'
  import { toast } from 'svelte-sonner'
  import { confirmDialog } from '$lib/stores/confirmDialog'

  interface Props {
    sessions: ChatSessionRow[]
    currentSessionId?: string
    sessionService?: any
    onSessionSelect: (session: ChatSessionRow) => void
    onCreateSession: (folderId?: string, source?: string) => void
  }

  let {
    sessions = [],
    currentSessionId,
    sessionService,
    onSessionSelect,
    onCreateSession
  }: Props = $props()

  let isCreatingFolder = $state(false)
  let newFolderName = $state('')
  let foldersForDisplay = $derived(
    foldersStore.sortFoldersForDisplay(foldersStore.folders, sessions)
  )
  // SA-104 P5: Infinite Sessions render in one pinned section above the folders.
  // It is deliberately NOT a dndzone: Infinite Sessions cannot be dragged out and
  // nothing can be dropped in — the exclusion is structural in both directions.
  let fixedSessions = $derived(
    sessions
      .filter((session) => !session.archived && isFixedSession(session))
      .sort((a, b) => {
        const aTime = new Date(a.last_modified_at || a.created_at).getTime()
        const bTime = new Date(b.last_modified_at || b.created_at).getTime()
        return bTime - aTime
      })
  )
  
  // Load folders on mount
  onMount(() => {
    foldersStore.loadFolders()
  })
  
  async function handleCreateFolder() {
    const validation = foldersStore.validateFolderName(newFolderName)
    if (!validation.valid) {
      toast.error(validation.error || 'Invalid folder name')
      return
    }
    
    const newFolder = await foldersStore.createFolder(newFolderName)
    if (newFolder) {
      toast.success(`Created folder "${newFolderName}"`)
      newFolderName = ''
      isCreatingFolder = false
    } else {
      toast.error('Failed to create folder')
    }
  }
  
  function handleCreateFolderKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      handleCreateFolder()
    } else if (e.key === 'Escape') {
      newFolderName = ''
      isCreatingFolder = false
    }
  }
  
  async function handleDeleteFolder(folder: any) {
    if (folder.is_default) {
      toast.error('Cannot delete the default folder.')
      return
    }
    const confirmed = await confirmDialog({
      title: `Delete folder "${folder.name}"?`,
      description: 'All chats in this folder will be moved to the default folder.',
      confirmLabel: 'Delete Folder',
      tone: 'destructive'
    })
    if (!confirmed) {
      return
    }
    
    const result = await foldersStore.deleteFolder(folder.id)
    if (result.success) {
      if (sessionService) {
        await sessionService.loadSessions(folder.user_id, false)
      }
      toast.success('Folder deleted')
    } else {
      toast.error(result.error || 'Failed to delete folder')
    }
  }

  async function handleDeleteFolderWithSessions(folder: any) {
    if (folder.is_default) {
      toast.error('Cannot delete the default folder.')
      return
    }

    const sessionCount = sessions.filter(
      (session) => session.folder_id === folder.id && !session.archived
    ).length
    const confirmed = await confirmDialog({
      title: `Delete "${folder.name}" and ${sessionCount} chat${sessionCount === 1 ? '' : 's'}?`,
      description:
        sessionCount > 0
          ? 'This permanently deletes every chat session in this folder. Locked sessions must be unlocked first. This action cannot be undone.'
          : 'This folder has no active chat sessions. The folder will be permanently deleted.',
      confirmLabel: 'Delete Folder + Sessions',
      tone: 'destructive'
    })
    if (!confirmed) {
      return
    }

    const result = await foldersStore.deleteFolder(folder.id, {
      deleteSessions: true
    })
    if (result.success) {
      if (sessionService) {
        await sessionService.loadSessions(folder.user_id, false)
      }
      toast.success(
        result.deleted_sessions
          ? `Deleted folder and ${result.deleted_sessions} chat${result.deleted_sessions === 1 ? '' : 's'}`
          : 'Folder deleted'
      )
    } else {
      toast.error(result.error || 'Failed to delete folder and sessions')
    }
  }
  
  function handleCreateSessionInFolder(folderId: string, source = 'folder-row') {
    onCreateSession(folderId, source)
  }
  
  // Action to focus element when it mounts
  function focusOnMount(node: HTMLElement) {
    setTimeout(() => {
      node.focus()
    }, 0)
  }
</script>

<div class="folder-tree">
  {#if fixedSessions.length > 0}
    <div class="folder-tree-fixed-section" data-testid="fixed-sessions-section">
      <div class="folder-tree-header">
        <span class="folder-tree-title folder-tree-fixed-title">
          <InfinityIcon class="folder-tree-fixed-icon" aria-hidden="true" />
          Infinite Sessions
        </span>
      </div>
      <Sidebar.SidebarMenu class="folder-tree-fixed-list">
        {#each fixedSessions as session (session.id)}
          {#if sessionService}
            <SessionItem
              {session}
              isSelected={session.id === currentSessionId}
              {sessionService}
              isArchived={false}
            />
          {/if}
        {/each}
      </Sidebar.SidebarMenu>
    </div>
  {/if}

  <div class="folder-tree-header">
    <span class="folder-tree-title">Folders</span>
    <Button
      variant="ghost"
      size="icon"
      class="folder-tree-icon-button"
      onclick={() => isCreatingFolder = true}
      aria-label="Create chat folder"
      title="Create chat folder"
      data-testid="create-chat-folder-button"
    >
      <FolderPlus class="folder-tree-icon" />
    </Button>
  </div>
  
  {#if isCreatingFolder}
    <div class="folder-tree-create">
      <div class="folder-tree-create-row">
        <input
          type="text"
          bind:value={newFolderName}
          placeholder="New folder name..."
          use:focusOnMount
          onblur={() => {
            if (newFolderName) {
              handleCreateFolder()
            } else {
              isCreatingFolder = false
            }
          }}
          onkeydown={handleCreateFolderKeydown}
          class="folder-tree-input"
        />
        <Button
          variant="ghost"
          size="icon"
          class="folder-tree-icon-button"
          aria-label="Cancel creating folder"
          title="Cancel creating folder"
          onclick={() => {
            isCreatingFolder = false
            newFolderName = ''
          }}
        >
          <X class="folder-tree-icon" />
        </Button>
      </div>
    </div>
  {/if}
  
  {#if foldersStore.loading}
    <div class="folder-tree-state">
      Loading folders...
    </div>
  {:else if foldersStore.error}
    <div class="folder-tree-state is-error">
      {foldersStore.error}
    </div>
  {:else}
    <div class="folder-tree-list">
      {#each foldersForDisplay as folder}
        <FolderItem
          {folder}
          {sessions}
          {currentSessionId}
          {sessionService}
          {onSessionSelect}
          onCreateSession={handleCreateSessionInFolder}
          onDeleteFolder={handleDeleteFolder}
          onDeleteFolderWithSessions={handleDeleteFolderWithSessions}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .folder-tree {
    width: 100%;
  }

  .folder-tree-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.25rem;
    padding: 0.25rem 0.5rem;
  }

  .folder-tree-fixed-section {
    margin-bottom: 0.5rem;
  }

  .folder-tree-fixed-title {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .folder-tree-fixed-section :global(.folder-tree-fixed-icon) {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }

  :global(.folder-tree-fixed-list) {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .folder-tree-title {
    color: var(--bs-app-label);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  :global(.folder-tree-icon-button) {
    width: 24px;
    height: 24px;
  }

  :global(.folder-tree-icon) {
    width: 12px;
    height: 12px;
  }

  .folder-tree-create {
    margin-bottom: 0.5rem;
    padding: 0.25rem 0.5rem;
  }

  .folder-tree-create-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .folder-tree-input {
    flex: 1 1 auto;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 6px;
    background: var(--bs-app-field);
    color: var(--bs-app-field-text);
    font-size: 0.75rem;
    outline: none;
  }

  .folder-tree-input:focus {
    box-shadow: 0 0 0 1px var(--bs-app-primary-soft);
  }

  .folder-tree-state {
    padding: 1rem 0.5rem;
    color: var(--bs-app-muted-text);
    text-align: center;
    font-size: 0.75rem;
  }

  .folder-tree-state.is-error {
    color: var(--destructive);
  }

  .folder-tree-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
</style>
