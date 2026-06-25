<script lang="ts">
  import { Trash2, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import type { GoonClosetItem, GoonSceneDefinition } from '$lib/types/goons'

  interface Props {
    sceneDeleteConfirmOpen?: boolean
    closetDeleteConfirmOpen?: boolean
    scenePendingDelete: GoonSceneDefinition | null
    closetPendingDelete: GoonClosetItem | null
    closetDeleteBusyId?: string | null
    onClearScenePendingDelete: () => void
    onClearClosetPendingDelete: () => void
    onConfirmDeleteScene: () => void | Promise<void>
    onConfirmRemoveClosetItem: () => void | Promise<void>
  }

  let {
    sceneDeleteConfirmOpen = $bindable(false),
    closetDeleteConfirmOpen = $bindable(false),
    scenePendingDelete,
    closetPendingDelete,
    closetDeleteBusyId = null,
    onClearScenePendingDelete,
    onClearClosetPendingDelete,
    onConfirmDeleteScene,
    onConfirmRemoveClosetItem
  }: Props = $props()

  function cancelSceneDelete() {
    sceneDeleteConfirmOpen = false
    onClearScenePendingDelete()
  }

  function cancelClosetDelete() {
    closetDeleteConfirmOpen = false
    onClearClosetPendingDelete()
  }
</script>

<Dialog.Root bind:open={sceneDeleteConfirmOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Delete Scene?</Dialog.Title>
      <Dialog.Description>
        {#if scenePendingDelete}
          This will permanently delete `{scenePendingDelete.name || 'Unnamed Scene'}` from your
          Scene library.
        {:else}
          This will permanently delete the selected Scene from your Scene library.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <div class="space-y-2 text-sm text-muted-foreground">
      <p>This action cannot be undone.</p>
    </div>
    <Dialog.Footer class="gap-2">
      <Button variant="ghost" onclick={cancelSceneDelete}>
        <X aria-hidden="true" />
        Cancel
      </Button>
      <Button
        variant="destructive"
        onclick={onConfirmDeleteScene}
        disabled={!scenePendingDelete}
      >
        <Trash2 aria-hidden="true" />
        Delete Scene
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={closetDeleteConfirmOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Remove Global Closet Item?</Dialog.Title>
      <Dialog.Description>
        {#if closetPendingDelete}
          This will remove `{closetPendingDelete.name || 'Unnamed Closet Item'}` from the
          Global Closet and clean up any saved Goon references to it.
        {:else}
          This will remove the selected item from the Global Closet.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <div class="space-y-2 text-sm text-muted-foreground">
      <p>Any affected Wardrobe rows will fall back to `Original` for that slot.</p>
    </div>
    <Dialog.Footer class="gap-2">
      <Button
        variant="ghost"
        onclick={cancelClosetDelete}
        disabled={Boolean(closetDeleteBusyId)}
      >
        <X aria-hidden="true" />
        Cancel
      </Button>
      <Button
        variant="destructive"
        onclick={onConfirmRemoveClosetItem}
        disabled={!closetPendingDelete || Boolean(closetDeleteBusyId)}
      >
        {closetDeleteBusyId ? 'Removing…' : 'Remove Item'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
