<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'

  interface Props {
    zipAgentControlEnabled: boolean
    zipAiViewMode: 'inline' | 'appended'
    zipToolNotesEnabled: boolean
    onZipControlPermissionChange: (enabled: boolean) => void
    onZipAiViewModeChange: (mode: 'inline' | 'appended') => void
    onZipToolNotesEnabledChange: (enabled: boolean) => void
  }

  let {
    zipAgentControlEnabled,
    zipAiViewMode,
    zipToolNotesEnabled,
    onZipControlPermissionChange,
    onZipAiViewModeChange,
    onZipToolNotesEnabledChange
  }: Props = $props()
</script>

<div class="grid gap-3 md:grid-cols-3">
  <label class="space-y-1">
    <span class="batshit-settings-form-label-line">
      <span class="batshit-settings-form-label">Zip Control Permissions</span>
      <SettingsInfoMenu ariaLabel="About Zip Control Permissions">
        Lets the AI request unzip or zip changes and save Tool Notes through Batshit's hidden
        zip-control block. Changes apply on the next user message.
        Mode 4 caution: provider-native CLI runtimes already do some of their own context
        compression, so Batshit ZCP can become a second overlapping memory-management layer.
      </SettingsInfoMenu>
    </span>
    <Select.Root
      type="single"
      value={zipAgentControlEnabled ? 'enabled' : 'disabled'}
      onValueChange={(value) => onZipControlPermissionChange((value ?? 'disabled') === 'enabled')}
    >
      <Select.Trigger class="batshit-settings-select-compact w-full" size="sm">
        {zipAgentControlEnabled ? 'Enabled' : 'Disabled'}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
        <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
      </Select.Content>
    </Select.Root>
  </label>

  <label class="space-y-1">
    <span class="batshit-settings-form-label-line">
      <span class="batshit-settings-form-label">AI Zip Layout</span>
      <SettingsInfoMenu ariaLabel="About AI Zip Layout">
        Controls how unzipped content is delivered back to the AI. Inline expands content where
        the zip reference appears. Appended keeps the chat clean and adds an organized unzip index
        plus unzipped-content block at the end.
      </SettingsInfoMenu>
    </span>
    <Select.Root
      type="single"
      value={zipAiViewMode}
      onValueChange={(value) =>
        onZipAiViewModeChange((value ?? 'appended') === 'inline' ? 'inline' : 'appended')}
    >
      <Select.Trigger class="batshit-settings-select-compact w-full" size="sm">
        {zipAiViewMode === 'appended' ? 'Appended (Recommended)' : 'Inline'}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="inline" label="Inline">Inline</Select.Item>
        <Select.Item value="appended" label="Appended (Recommended)">Appended (Recommended)</Select.Item>
      </Select.Content>
    </Select.Root>
  </label>

  <label class="space-y-1">
    <span class="batshit-settings-form-label-line">
      <span class="batshit-settings-form-label">Tool Notes</span>
      <SettingsInfoMenu ariaLabel="About Tool Notes">
        Lets the AI save short summaries of important tool results so useful facts remain visible
        after raw tool output is zipped.
      </SettingsInfoMenu>
    </span>
    <Select.Root
      type="single"
      value={zipToolNotesEnabled ? 'enabled' : 'disabled'}
      onValueChange={(value) => onZipToolNotesEnabledChange((value ?? 'enabled') === 'enabled')}
    >
      <Select.Trigger class="batshit-settings-select-compact w-full" size="sm">
        {zipToolNotesEnabled ? 'Enabled' : 'Disabled'}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
        <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
      </Select.Content>
    </Select.Root>
  </label>
</div>
