<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { TYPESAFE_FEATURES } from '$lib/utils/jevJuice'

  interface Props {
    zipAgentControlEnabled: boolean
    zipAiViewMode: 'inline' | 'appended'
    zipToolNotesEnabled: boolean
    /** SA-120 P5 (LS-054): the ONE global smart zip switch. Off by default. */
    jevSmartZipEnabled: boolean
    onZipControlPermissionChange: (enabled: boolean) => void
    onZipAiViewModeChange: (mode: 'inline' | 'appended') => void
    onZipToolNotesEnabledChange: (enabled: boolean) => void
    onJevSmartZipEnabledChange: (enabled: boolean) => void
  }

  let {
    zipAgentControlEnabled,
    zipAiViewMode,
    zipToolNotesEnabled,
    jevSmartZipEnabled,
    onZipControlPermissionChange,
    onZipAiViewModeChange,
    onZipToolNotesEnabledChange,
    onJevSmartZipEnabledChange
  }: Props = $props()
</script>

<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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

  <label class="space-y-1">
    <span class="batshit-settings-form-label-line">
      <span class="batshit-settings-form-label">{TYPESAFE_FEATURES.smart_zip.switchLabel}</span>
      <SettingsInfoMenu ariaLabel="About Jev Juice smart zip" contentClass="w-80">
        <p>
          Before each reply, Batshit asks TypeSafe's Jev model which zipped tool results your message
          needs. It unzips the one or two it is sure about for that message (they zip again by
          themselves after two messages) and only names the rest. After each reply it asks whether
          the agent is done with the results that are still open, and zips the finished ones early.
        </p>
        <p>
          Anything Batshit changes this way shows the Jev Juice mark on its zip badge, and the agent
          is told each time. Your own unzip and zip, pins, and the agent's zip control always win,
          and every zip setting below keeps working. Unzipping costs tokens on the messages that
          need it; zipping finished results early saves them.
        </p>
        <p>
          When this is on, the text of your message, the finished reply, and the one-line label of
          each zipped or open tool result (the tool, what it was used on, such as a file path, a
          command, search words, or a web address, and its status and size) leave this computer and
          go to TypeSafe's servers, on every message, for every agent. The contents of the results
          are never sent. Off by default; needs Jev Juice turned on in Settings → Admin.
        </p>
      </SettingsInfoMenu>
    </span>
    <Select.Root
      type="single"
      value={jevSmartZipEnabled ? 'enabled' : 'disabled'}
      onValueChange={(value) => onJevSmartZipEnabledChange((value ?? 'disabled') === 'enabled')}
    >
      <Select.Trigger
        class="batshit-settings-select-compact w-full"
        size="sm"
        data-testid="global-jev-smart-zip-select"
      >
        {jevSmartZipEnabled ? 'Enabled' : 'Disabled'}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
        <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
      </Select.Content>
    </Select.Root>
  </label>
</div>
