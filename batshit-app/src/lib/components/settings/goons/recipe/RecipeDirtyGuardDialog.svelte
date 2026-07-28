<script lang="ts">
  import { Save, Trash2, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'

  type Props = {
    open?: boolean
    busy?: 'saving' | 'discarding' | null
    onCancel: () => void
    onSaveAndContinue: () => void | Promise<void>
    onDiscardAndContinue: () => void | Promise<void>
  }

  let {
    open = false,
    busy = null,
    onCancel,
    onSaveAndContinue,
    onDiscardAndContinue
  }: Props = $props()

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && busy === null) onCancel()
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content class="batshit-settings-dialog sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Save appearance changes before updating the Goon file?</Dialog.Title>
      <Dialog.Description>
        The file update cannot overwrite unsaved appearance edits. Save them, discard them, or cancel and keep editing.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="gap-2">
      <Button variant="ghost" onclick={onCancel} disabled={busy !== null}>
        <X aria-hidden="true" />
        Cancel
      </Button>
      <Button variant="outline" onclick={onDiscardAndContinue} disabled={busy !== null}>
        <Trash2 aria-hidden="true" />
        {busy === 'discarding' ? 'Discarding…' : 'Discard & Continue'}
      </Button>
      <Button onclick={onSaveAndContinue} disabled={busy !== null}>
        <Save aria-hidden="true" />
        {busy === 'saving' ? 'Saving…' : 'Save & Continue'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
