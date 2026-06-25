<script lang="ts">
  import {
    AlertOctagon,
    Archive,
    Check,
    Edit2,
    FileText,
    Lock,
    MoreHorizontal,
    Save,
    Trash2
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Input } from '$lib/components/ui/input'
  import * as Switch from '$lib/components/ui/switch'

  type MarkdownViewMode = 'full' | 'summary'

  interface Props {
    sessionId: string
    sessionName: string
    menuLabel: string
    currentEditName: string
    currentEditId: string
    nameSaveSuccess: boolean
    idSaveSuccess: boolean
    isIdEditingDisabled: boolean
    checkingMessageState: boolean
    isSessionLocked: boolean
    lockUpdatePending: boolean
    isArchived: boolean
    onMenuOpenChange: (open: boolean) => void | Promise<void>
    onNameSave: () => void | Promise<void>
    onIdSave: () => void | Promise<void>
    onLockToggle: (checked: boolean) => void | Promise<void>
    onViewMarkdown: (mode: MarkdownViewMode) => void | Promise<void>
    onArchive: () => void | Promise<void>
    onUnarchive: () => void | Promise<void>
    onDelete: () => void | Promise<void>
  }

  let {
    sessionId,
    sessionName,
    menuLabel,
    currentEditName = $bindable(''),
    currentEditId = $bindable(''),
    nameSaveSuccess,
    idSaveSuccess,
    isIdEditingDisabled,
    checkingMessageState,
    isSessionLocked,
    lockUpdatePending,
    isArchived,
    onMenuOpenChange,
    onNameSave,
    onIdSave,
    onLockToggle,
    onViewMarkdown,
    onArchive,
    onUnarchive,
    onDelete
  }: Props = $props()
</script>

<DropdownMenu.Root onOpenChange={onMenuOpenChange}>
  <DropdownMenu.Trigger
    class="session-item-menu-trigger"
    onclick={(event) => event.stopPropagation()}
    aria-label={menuLabel}
    title={menuLabel}
    data-testid={`chat-session-settings-button-${sessionId}`}
  >
    <span class="session-item-screen-reader">{menuLabel}</span>
    <MoreHorizontal class="session-item-menu-icon" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="right"
    align="start"
    class="session-menu-content"
    data-sidebar-overlay-popover="true"
  >
    <div class="session-menu-section">
      <div class="session-menu-row">
        <Edit2 class="session-menu-icon" />
        <Input
          type="text"
          placeholder="Edit Name"
          bind:value={currentEditName}
          class="session-menu-input"
          onkeydown={(event) => event.key === 'Enter' && onNameSave()}
        />
        <Button
          size="icon"
          variant="ghost"
          class="session-menu-icon-button"
          onclick={onNameSave}
          aria-label={`Save session name for ${sessionName}`}
          title={`Save session name for ${sessionName}`}
        >
          <Save class="session-menu-success-icon" />
        </Button>
        {#if nameSaveSuccess}
          <Check class="session-menu-success-icon" />
        {/if}
      </div>
      <p class="session-menu-note">Name is arbitrary, change it to whatever you want.</p>
    </div>

    <DropdownMenu.Separator />

    <div class="session-menu-section">
      <div class="session-menu-row">
        <AlertOctagon class="session-menu-icon" />
        <Input
          type="text"
          placeholder="Edit Session ID"
          bind:value={currentEditId}
          class={`session-menu-input ${isIdEditingDisabled ? 'is-disabled' : ''}`}
          disabled={isIdEditingDisabled || checkingMessageState}
          onkeydown={(event) => event.key === 'Enter' && !isIdEditingDisabled && onIdSave()}
        />
        {#if !isIdEditingDisabled && !checkingMessageState}
          <Button
            size="icon"
            variant="ghost"
            class="session-menu-icon-button"
            onclick={onIdSave}
            aria-label={`Save session ID for ${sessionName}`}
            title={`Save session ID for ${sessionName}`}
          >
            <Save class="session-menu-success-icon" />
          </Button>
        {/if}
        {#if idSaveSuccess}
          <Check class="session-menu-success-icon" />
        {/if}
      </div>
      <p class="session-menu-note">
        Current ID: <span class="session-menu-code">{sessionId}</span>
      </p>
      <p class="session-menu-note">
        {#if checkingMessageState}
          Checking if Session ID is still editable...
        {:else if isSessionLocked}
          <strong>Note:</strong> Unlock the session first to edit the Session ID.
        {:else}
          <strong>Note:</strong> You can only change the ID before sending any messages.
        {/if}
      </p>
    </div>

    <DropdownMenu.Separator />

    <div class="session-menu-section">
      <div class="session-menu-lock-row">
        <div class="session-menu-lock-copy">
          <div class="session-menu-label-row">
            <Lock class="session-menu-icon" />
            <span>Lock Session</span>
          </div>
          <p class="session-menu-note">Locked sessions cannot be deleted until unlocked.</p>
        </div>
        <Switch.Root
          checked={isSessionLocked}
          disabled={lockUpdatePending}
          onCheckedChange={(checked) => onLockToggle(Boolean(checked))}
        />
      </div>
    </div>

    <DropdownMenu.Separator />

    <DropdownMenu.Item onclick={() => onViewMarkdown('full')}>
      <FileText class="session-menu-item-icon" />
      <span class="session-menu-item-stack">
        <span>View Chat as Markdown</span>
        <span class="session-menu-item-help">with tool results</span>
      </span>
    </DropdownMenu.Item>

    <DropdownMenu.Item onclick={() => onViewMarkdown('summary')}>
      <FileText class="session-menu-item-icon" />
      <span class="session-menu-item-stack">
        <span>View Chat as Markdown</span>
        <span class="session-menu-item-help">without tool results</span>
      </span>
    </DropdownMenu.Item>

    <DropdownMenu.Separator />

    {#if isArchived}
      <DropdownMenu.Item onclick={onUnarchive}>
        <Archive class="session-menu-item-icon" />
        Unarchive Session
      </DropdownMenu.Item>
    {:else}
      <DropdownMenu.Item onclick={onArchive}>
        <Archive class="session-menu-item-icon" />
        Archive Session
      </DropdownMenu.Item>
    {/if}

    <DropdownMenu.Item
      class="session-menu-danger-item"
      onclick={onDelete}
      disabled={isSessionLocked}
    >
      <Trash2 class="session-menu-item-icon" />
      Delete Session
    </DropdownMenu.Item>
    {#if isSessionLocked}
      <p class="session-menu-locked-note">Unlock this session before deleting.</p>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  .session-item-screen-reader {
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

  :global(.session-item-menu-trigger) {
    display: inline-flex;
    flex: 0 0 0;
    align-items: center;
    justify-content: center;
    height: 1.5rem;
    width: 0;
    min-width: 0;
    margin-left: 0;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition:
      flex-basis 150ms ease-out,
      width 150ms ease-out,
      margin-left 150ms ease-out,
      opacity 150ms ease-out,
      background-color 150ms ease-out,
      color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.session-item-button:hover .session-item-menu-trigger),
  :global(.session-item-button:focus-within .session-item-menu-trigger),
  :global(.session-item-menu-trigger[data-state='open']) {
    flex-basis: 1.5rem;
    width: 1.5rem;
    margin-left: 0.5rem;
    overflow: visible;
    opacity: 1;
    pointer-events: auto;
  }

  :global(.session-item-menu-trigger:hover) {
    background-color: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.session-item-menu-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--bs-app-primary-faint);
    outline-offset: 2px;
  }

  :global(.session-item-menu-icon),
  :global(.session-menu-icon),
  :global(.session-menu-success-icon),
  :global(.session-menu-item-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.session-menu-icon) {
    color: var(--bs-app-muted-text);
  }

  :global(.session-menu-success-icon) {
    color: var(--success-color);
  }

  :global(.session-menu-item-icon) {
    align-self: flex-start;
    margin-right: 0.5rem;
  }

  :global(.session-menu-content) {
    width: 15rem;
  }

  .session-menu-section {
    padding: 0.5rem;
  }

  .session-menu-row,
  .session-menu-label-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .session-menu-lock-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .session-menu-lock-copy {
    min-width: 0;
  }

  .session-menu-label-row {
    font-size: 0.875rem;
  }

  :global(.session-menu-input) {
    flex: 1 1 auto;
    height: 32px;
    font-size: 0.75rem;
    font-weight: 450;
    line-height: 1.2;
  }

  :global(.session-menu-input.is-disabled) {
    cursor: not-allowed;
    opacity: 0.6;
  }

  :global(.session-menu-icon-button) {
    width: 32px;
    height: 32px;
  }

  .session-menu-note,
  .session-menu-locked-note,
  .session-menu-item-help {
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  .session-menu-note {
    margin: 0.25rem 0 0 1.5rem;
  }

  .session-menu-code {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  }

  .session-menu-item-stack {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
  }

  :global(.session-menu-danger-item) {
    color: var(--destructive);
  }

  :global(.session-menu-danger-item:focus) {
    color: var(--destructive);
  }

  :global(.session-menu-danger-item[data-disabled]) {
    color: var(--bs-app-muted-text);
  }

  .session-menu-locked-note {
    margin: 0;
    padding: 0 0.5rem 0.5rem;
  }
</style>
