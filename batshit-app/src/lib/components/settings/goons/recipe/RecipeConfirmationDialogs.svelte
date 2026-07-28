<script lang="ts">
  import { History, RotateCcw, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'

  type Props = {
    cleanResetOpen?: boolean
    restoreOpen?: boolean
    previousRevision?: number | null
    busy?: 'clean-reset' | 'restore' | null
    onCloseCleanReset: () => void
    onConfirmCleanReset: () => void | Promise<void>
    onCloseRestore: () => void
    onConfirmRestore: () => void | Promise<void>
  }

  let {
    cleanResetOpen = false,
    restoreOpen = false,
    previousRevision = null,
    busy = null,
    onCloseCleanReset,
    onConfirmCleanReset,
    onCloseRestore,
    onConfirmRestore
  }: Props = $props()

  function handleCleanResetOpenChange(nextOpen: boolean) {
    if (!nextOpen && busy === null) onCloseCleanReset()
  }

  function handleRestoreOpenChange(nextOpen: boolean) {
    if (!nextOpen && busy === null) onCloseRestore()
  }
</script>

{#if cleanResetOpen}
  <Dialog.Root open onOpenChange={handleCleanResetOpenChange}>
    <Dialog.Content class="batshit-settings-dialog sm:max-w-lg">
      <Dialog.Header>
        <Dialog.Title>Reset Appearance and Update?</Dialog.Title>
        <Dialog.Description>
          This Goon file cannot safely preserve the affected appearance values. Continuing resets them to their supported defaults before applying the update.
        </Dialog.Description>
      </Dialog.Header>
      <div class="batshit-settings-muted-panel space-y-1">
        <p class="batshit-settings-form-label is-danger">Your current Goon will not change unless the updated version passes every check.</p>
        <p class="batshit-settings-caption">Batshit will never guess how to carry incompatible appearance values forward.</p>
      </div>
      <Dialog.Footer class="gap-2">
        <Button variant="ghost" onclick={onCloseCleanReset} disabled={busy !== null}>
          <X aria-hidden="true" />
          Cancel
        </Button>
        <Button variant="destructive" onclick={onConfirmCleanReset} disabled={busy !== null}>
          <RotateCcw aria-hidden="true" />
          {busy === 'clean-reset' ? 'Resetting…' : 'Reset Appearance and Update'}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

{#if restoreOpen}
  <Dialog.Root open onOpenChange={handleRestoreOpenChange}>
    <Dialog.Content class="batshit-settings-dialog sm:max-w-lg">
      <Dialog.Header>
        <Dialog.Title>Restore Previous Version?</Dialog.Title>
        <Dialog.Description>
          Restore the complete previous verified Goon version. The current version stays active unless the restore succeeds.
        </Dialog.Description>
      </Dialog.Header>
      <div class="batshit-settings-muted-panel space-y-1">
        <p class="batshit-settings-form-label">The restore is all-or-nothing.</p>
        <p class="batshit-settings-caption">
          Batshit restores the Goon file and its saved appearance together, then verifies them before activation.
        </p>
        {#if previousRevision !== null}
          <details class="pt-2">
            <summary class="batshit-settings-child-label cursor-pointer">Technical Details</summary>
            <p class="batshit-settings-code-caption mt-2">Recipe revision {previousRevision}</p>
          </details>
        {/if}
      </div>
      <Dialog.Footer class="gap-2">
        <Button variant="ghost" onclick={onCloseRestore} disabled={busy !== null}>
          <X aria-hidden="true" />
          Cancel
        </Button>
        <Button onclick={onConfirmRestore} disabled={busy !== null}>
          <History aria-hidden="true" />
          {busy === 'restore' ? 'Restoring…' : 'Restore Previous Version'}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
