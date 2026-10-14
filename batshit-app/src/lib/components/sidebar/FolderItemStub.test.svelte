<script lang="ts">
  // Test stand-in for FolderItem: one button per folder that calls the tree's
  // "Delete Folder + Sessions" handler, without the dropdown menu around it.
  import type { ChatFolderRow } from '$lib/types/database'

  let {
    folder,
    onDeleteFolderWithSessions
  }: {
    folder: ChatFolderRow
    onDeleteFolderWithSessions?: (folder: ChatFolderRow) => void
    [key: string]: unknown
  } = $props()
</script>

<button type="button" onclick={() => onDeleteFolderWithSessions?.(folder)}>
  Delete {folder.name} with its chats
</button>
