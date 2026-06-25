<script lang="ts">
  import { Trash2, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'

  interface Props {
    open?: boolean
    title: string
    description: string
    saving: boolean
    continueLabel: string
    onClose: () => void
    onDiscard: () => void | Promise<void>
    onSave: () => void | Promise<void>
  }

  let {
    open = $bindable(false),
    title,
    description,
    saving,
    continueLabel,
    onClose,
    onDiscard,
    onSave
  }: Props = $props()

  function handleOpenChange(nextOpen: boolean) {
    open = nextOpen
    if (!nextOpen) {
      onClose()
    }
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Content class="bs-unsaved-dialog-content">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>
        {description}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="bs-unsaved-dialog-footer gap-2">
      <Button variant="ghost" onclick={onClose}>
        <X aria-hidden="true" />
        Stay Here
      </Button>
      <Button variant="outline" onclick={onDiscard}>
        <Trash2 aria-hidden="true" />
        Discard Changes
      </Button>
      <Button onclick={onSave} disabled={saving}>
        {saving ? 'Saving…' : continueLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
