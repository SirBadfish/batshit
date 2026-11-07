<script lang="ts">
  import * as Select from '$lib/components/ui/select'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { TYPESAFE_FEATURES } from '$lib/utils/jevJuice'
  import { DEFAULT_LIVE_FILE_READS_ENABLED, LIVE_FILE_READS_HELP, LIVE_FILE_READS_LABEL } from '$lib/utils/liveFileReads'
  import { REFRESHED_FILE_READS_GLOBAL_HINT } from '$lib/utils/refreshedFileReadsSettings'

  // Agent zip control is retired (decision 7, 2026-10-23); startup removes its keys
  // (`retiredZipControlFields.ts`).
  interface Props {
    showSmartZip?: boolean
    zipAiViewMode: 'inline' | 'appended'
    zipToolNotesEnabled: boolean
    /** SA-120 P5 (LS-054): the ONE global smart zip switch. Off by default. */
    jevSmartZipEnabled: boolean
    /** SA-137 P4a: the saved global Refreshed File Reads value; null is absent (the factory value, `DEFAULT_LIVE_FILE_READS_ENABLED`). */
    liveFileReadsValue: boolean | null
    /**
     * Round 2 (R2-2): why Refreshed File Reads cannot run on this computer
     * (`globalRefreshedFileReadsAvailability`: host reasons only), or null. The switch shows as
     * unavailable with this sentence; the saved value is never changed or saved because of it.
     */
    liveFileReadsUnavailableReason?: string | null
    /**
     * Plain notes under the switch that do not lock it (the host could not be read; the global Zip
     * view is inline). With none, and no reason, the short hint shows.
     */
    liveFileReadsNotes?: string[]
    onZipAiViewModeChange: (mode: 'inline' | 'appended') => void
    onZipToolNotesEnabledChange: (enabled: boolean) => void
    onJevSmartZipEnabledChange: (enabled: boolean) => void
    onLiveFileReadsValueChange: (value: boolean | null) => void
  }

  let {
    showSmartZip = true,
    zipAiViewMode,
    zipToolNotesEnabled,
    jevSmartZipEnabled,
    liveFileReadsValue,
    liveFileReadsUnavailableReason = null,
    liveFileReadsNotes = [],
    onZipAiViewModeChange,
    onZipToolNotesEnabledChange,
    onJevSmartZipEnabledChange,
    onLiveFileReadsValueChange
  }: Props = $props()

  // The reason and the notes describe the switch for assistive technology; ids are per mounted
  // strip, so two strips on a page never share one.
  const uid = $props.id()
  const reasonId = `${uid}-live-reads-reason`
  const noteId = (index: number) => `${uid}-live-reads-note-${index}`
  const showHint = $derived(!liveFileReadsUnavailableReason && liveFileReadsNotes.length === 0)
  const hintId = `${uid}-live-reads-hint`
  const liveFileReadsDescribedBy = $derived(
    [
      liveFileReadsUnavailableReason ? reasonId : null,
      ...liveFileReadsNotes.map((_, index) => noteId(index)),
      showHint ? hintId : null
    ]
      .filter(Boolean)
      .join(' ') || undefined
  )

  // SA-137 D13: the factory value, named from the one constant the resolver uses.
  const liveFileReadsDefaultLabel = `Default (${DEFAULT_LIVE_FILE_READS_ENABLED ? 'On' : 'Off'})`
  const liveFileReadsSelected = $derived(
    liveFileReadsValue === null ? 'default' : liveFileReadsValue ? 'enabled' : 'disabled'
  )
  const liveFileReadsSelectedLabel = $derived(
    liveFileReadsValue === null ? liveFileReadsDefaultLabel : liveFileReadsValue ? 'Enabled' : 'Disabled'
  )
</script>

<div class={`grid gap-3 md:grid-cols-2 ${showSmartZip ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
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
        Lets the agent save short notes about important tool results, so the facts it needs stay
        in view after the full result is compressed and it reads files again less. Recommended.
      </SettingsInfoMenu>
    </span>
    <Select.Root
      type="single"
      value={zipToolNotesEnabled ? 'enabled' : 'disabled'}
      onValueChange={(value) => onZipToolNotesEnabledChange((value ?? 'enabled') === 'enabled')}
    >
      <Select.Trigger class="batshit-settings-select-compact w-full" size="sm">
        {zipToolNotesEnabled ? 'Enabled (Recommended)' : 'Disabled'}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="enabled" label="Enabled (Recommended)">Enabled (Recommended)</Select.Item>
        <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
      </Select.Content>
    </Select.Root>
  </label>

  {#if showSmartZip}
  <label class="space-y-1">
    <span class="batshit-settings-form-label-line">
      <span class="batshit-settings-form-label">{TYPESAFE_FEATURES.smart_zip.switchLabel}</span>
      <SettingsInfoMenu ariaLabel="About Judge Juice smart zip" contentClass="w-80">
        <p>
          Before each reply, Batshit asks your judge which compressed tool results your message
          needs. It holds the one or two it is sure about open for that message (they compress again
          by themselves after two messages) and only names the rest. After each reply it asks whether
          the agent is done with the results that are still expanded, and zips the finished ones early.
        </p>
        <p>
          Anything Batshit changes this way shows the Judge Juice mark on its zip badge, and the agent
          is told each time. Your own Hold, Release and Zip now, and the agent's holds, always win,
          and every zip setting below keeps working. Holding a result open costs tokens on the
          messages that need it; zipping finished results early saves them.
        </p>
        <p>
          When this is on, the text of your message, the finished reply, and the one-line label of
          each compressed or expanded tool result (the tool, what it was used on, such as a file path, a
          command, search words, or a web address, and its status and size) are sent to the judge
          chosen in Settings → Admin → Judge Juice (Jev at TypeSafe unless you changed it), on every
          message, for every agent; the card there says where each judge runs. The contents of the
          results are never sent. Off by default; needs Judge Juice turned on in Settings → Admin.
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
  {/if}

  <div class="space-y-1">
    <label class="space-y-1">
      <span class="batshit-settings-form-label-line">
        <span class="batshit-settings-form-label">{LIVE_FILE_READS_LABEL}</span>
        <SettingsInfoMenu ariaLabel={`About ${LIVE_FILE_READS_LABEL}`}>
          {LIVE_FILE_READS_HELP}
        </SettingsInfoMenu>
      </span>
      <Select.Root
        type="single"
        value={liveFileReadsSelected}
        disabled={Boolean(liveFileReadsUnavailableReason)}
        onValueChange={(value) =>
          onLiveFileReadsValueChange(value === 'enabled' ? true : value === 'disabled' ? false : null)}
      >
        <Select.Trigger
          class="batshit-settings-select-compact w-full"
          size="sm"
          data-testid="global-live-file-reads-select"
          aria-describedby={liveFileReadsDescribedBy}
        >
          {liveFileReadsSelectedLabel}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="default" label={liveFileReadsDefaultLabel}>{liveFileReadsDefaultLabel}</Select.Item>
          <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
          <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
        </Select.Content>
      </Select.Root>
    </label>
    {#if liveFileReadsUnavailableReason}
      <p id={reasonId} class="batshit-settings-form-help is-warning" data-testid="global-live-file-reads-reason">{liveFileReadsUnavailableReason}</p>
    {/if}
    {#each liveFileReadsNotes as note, index (index)}
      <p id={noteId(index)} class="batshit-settings-form-help" data-testid="global-live-file-reads-note">{note}</p>
    {/each}
    {#if showHint}
      <p id={hintId} class="batshit-settings-form-help" data-testid="global-live-file-reads-hint">{REFRESHED_FILE_READS_GLOBAL_HINT}</p>
    {/if}
  </div>
</div>
