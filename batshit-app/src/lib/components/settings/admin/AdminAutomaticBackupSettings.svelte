<script lang="ts">
  import { onMount } from 'svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import type { AutomaticBackupConfig, AutomaticBackupView } from '$lib/types/automaticBackup'
  import { formatBackupBytes, formatBackupDate } from './adminSettingsTypes'

  let { disabled = false }: { disabled?: boolean } = $props()

  type Draft = Pick<AutomaticBackupConfig, 'enabled' | 'cadence' | 'folder' | 'afterUpdates'>
  const ENDPOINT = '/api/admin/backup/automatic'
  let view = $state<AutomaticBackupView | null>(null)
  let baseline = $state<AutomaticBackupConfig | null>(null)
  let draft = $state<Draft | null>(null)
  let loading = $state(true)
  let recovering = $state(false)
  let saving = $state(false)
  let readError = $state('')
  let saveError = $state('')
  let saveNotice = $state('')
  let unknownNotice = $state('')
  let recoveryRequired = $state(false)
  let disposed = false
  let readSequence = 0
  let configEpoch = 0

  function sameDraft(a: Draft, b: Draft) {
    return a.enabled === b.enabled && a.cadence === b.cadence &&
      a.folder === b.folder && a.afterUpdates === b.afterUpdates
  }

  const dirty = $derived(Boolean(draft && baseline && !sameDraft(draft, baseline)))
  const controlsDisabled = $derived(disabled || saving || recovering || Boolean(view?.running))
  const savedChanged = $derived(Boolean(dirty && view && baseline && view.config.revision !== baseline.revision))

  function bounded(value: string) { return value.slice(0, 400) }
  function record(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }
  function nullableString(value: unknown) { return value === null || typeof value === 'string' }
  function isView(value: unknown): value is AutomaticBackupView {
    if (!record(value) || !record(value.config) || !record(value.startup)) return false
    const { config, startup } = value
    return typeof config.revision === 'string' && config.revision.length > 0 &&
      typeof config.ownerUserId === 'string' && config.ownerUserId.length > 0 &&
      typeof config.enabled === 'boolean' && ['daily', 'weekly'].includes(config.cadence) &&
      nullableString(config.folder) && typeof config.afterUpdates === 'boolean' &&
      nullableString(config.enabledAt) && typeof value.defaultFolder === 'string' &&
      typeof startup.ready === 'boolean' && typeof startup.buildId === 'string' &&
      typeof startup.dataGeneration === 'string' && (startup.error === undefined || typeof startup.error === 'string') &&
      (startup.warning === undefined || typeof startup.warning === 'string') &&
      typeof value.running === 'boolean' && nullableString(value.nextDueAt) &&
      nullableString(value.lastAttemptAt) && nullableString(value.error) &&
      Number.isInteger(value.retainedCount) && value.retainedCount >= 0 &&
      (value.lastSuccess === null || (record(value.lastSuccess) &&
        typeof value.lastSuccess.createdAt === 'string' && typeof value.lastSuccess.path === 'string' &&
        Number.isFinite(value.lastSuccess.bytes) && value.lastSuccess.bytes >= 0)) &&
      Array.isArray(value.cleanupFailures) && value.cleanupFailures.every((item: unknown) =>
        record(item) && typeof item.path === 'string' && typeof item.message === 'string') &&
      Array.isArray(value.preservedFolders) && value.preservedFolders.every((item: unknown) =>
        record(item) && typeof item.folder === 'string' && Number.isInteger(item.backupCount) && item.backupCount >= 0) &&
      Array.isArray(value.preservedFiles) && value.preservedFiles.every((item: unknown) =>
        record(item) && typeof item.path === 'string' && typeof item.originalPath === 'string' && typeof item.message === 'string') &&
      Array.isArray(value.unavailableCopies) && value.unavailableCopies.every((item: unknown) =>
        record(item) && typeof item.path === 'string' && ['missing', 'changed', 'unreadable'].includes(item.state) && typeof item.message === 'string')
  }

  function replaceSettings(config: AutomaticBackupConfig) {
    baseline = { ...config }
    draft = { enabled: config.enabled, cadence: config.cadence, folder: config.folder, afterUpdates: config.afterUpdates }
    configEpoch += 1
  }

  async function load(replaceDraft = false) {
    if (disposed || (loading && baseline) || saving || recovering) return
    const sequence = ++readSequence
    const epoch = configEpoch
    const mayFollow = !dirty && !recoveryRequired
    loading = true
    recovering = replaceDraft
    readError = ''
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store' })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok || !isView(payload)) {
        throw new Error(record(payload) && typeof payload.error === 'string' ? bounded(payload.error) : 'Automatic backup settings could not be read.')
      }
      if (disposed || sequence !== readSequence) return
      view = payload
      // Status is live; an original dirty/save/unknown settings base never follows a poll.
      if (replaceDraft || (mayFollow && !dirty && !saving && !recoveryRequired && epoch === configEpoch)) {
        replaceSettings(payload.config)
        if (replaceDraft) {
          recoveryRequired = false
          saveError = ''
          saveNotice = 'Saved settings loaded.'
        }
      }
    } catch (failure) {
      if (!disposed && sequence === readSequence) {
        readError = failure instanceof Error ? bounded(failure.message) : 'Automatic backup settings could not be read.'
      }
    } finally {
      if (!disposed && sequence === readSequence) {
        loading = false
        recovering = false
      }
    }
  }

  function edit(patch: Partial<Draft>) {
    if (!draft || controlsDisabled) return
    draft = { ...draft, ...patch }
    saveNotice = ''
  }

  async function save() {
    if (!baseline || !draft || !dirty || controlsDisabled || recoveryRequired) return
    if (draft.folder !== null && !(/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(draft.folder))) {
      saveError = 'Enter an absolute folder path, or choose Use Default.'
      return
    }
    const sent = { ...draft }
    const originalBaseline = baseline
    const epoch = ++configEpoch
    readSequence += 1
    loading = false
    saving = true
    saveError = ''
    saveNotice = ''
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: originalBaseline.revision, ...sent })
      })
      const payload: unknown = await response.json().catch(() => null)
      if (disposed) return
      if (!response.ok) {
        const message = record(payload) && typeof payload.error === 'string' ? bounded(payload.error) : 'Automatic backup settings could not be saved.'
        if ([400, 401, 403, 409].includes(response.status)) {
          saveError = message
          recoveryRequired = response.status === 409
          return
        }
        throw new Error(message)
      }
      if (!isView(payload) || payload.config.ownerUserId !== originalBaseline.ownerUserId ||
        payload.config.revision === originalBaseline.revision || payload.config.enabled !== sent.enabled ||
        payload.config.cadence !== sent.cadence || payload.config.afterUpdates !== sent.afterUpdates ||
        (sent.folder === null ? payload.config.folder !== null : !payload.config.folder)) {
        throw new Error('The save did not return a confirmed settings record.')
      }
      if (epoch !== configEpoch || baseline?.revision !== originalBaseline.revision) return
      view = payload
      // Acknowledgement advances only the captured baseline, never later draft text.
      baseline = { ...payload.config }
      // The server resolves a chosen directory. Reflect that normalization only in the
      // still-captured folder draft, without marking any later edit as saved.
      if (draft?.folder === sent.folder) draft = { ...draft, folder: payload.config.folder }
      configEpoch += 1
      saveNotice = 'Automatic backup settings saved.'
    } catch (failure) {
      if (disposed) return
      unknownNotice = 'A settings save has an unknown outcome. Loading current saved settings does not confirm that earlier save.'
      saveError = failure instanceof Error ? bounded(failure.message) : 'The save could not be confirmed.'
      recoveryRequired = true
    } finally {
      if (!disposed) saving = false
    }
  }

  onMount(() => {
    void load()
    const refresh = () => { void load() }
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      readSequence += 1
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  })
</script>

<div class="batshit-settings-subsection">
  <div class="batshit-settings-form-label-line">
    <h4 class="batshit-settings-parent-label">Automatic Backups</h4>
    <SettingsInfoMenu ariaLabel="About Automatic Backups" contentClass="w-80">
      <p>
        Save these settings to allow Batshit to create automatic backups. Backups run while the app
        is open. If a backup became due while it was closed, Batshit makes one catch-up backup after
        startup checks succeed.
      </p>
      <p>
        Batshit keeps the latest two successfully completed and verified backups. The first success
        leaves one copy until the next success. Creating a replacement needs temporary room for a
        third copy. A failed backup keeps the existing completed copies.
      </p>
      <p>
        Automatic backups exclude secrets. They include supported Batshit data and assets, but not
        the app itself, source code, model weights or external runtime binaries.
      </p>
      <p>
        Choose an existing absolute folder path visible to the Batshit server. Save validates the
        chosen directory; saving with Use Default creates Batshit's default folder when needed. In Docker,
        paths are inside the container. A host folder needs a persistent bind mount.
      </p>
      <p>
        Changing folders leaves old backups in their old folder. Batshit does not sweep old folders
        or silently redirect a missing or unusable destination.
      </p>
    </SettingsInfoMenu>
  </div>

  {#if readError}
    <div class="batshit-settings-inline-alert is-danger" role="alert">
      <p>{baseline ? 'Status could not refresh. Your settings draft is kept.' : 'Automatic backup controls are hidden until saved settings can be read.'} {readError}</p>
      <Button type="button" size="sm" variant="outline" onclick={() => load()} disabled={loading || saving}>Retry Automatic Backup Read</Button>
    </div>
  {:else if !baseline}
    <p class="batshit-settings-form-meta" role="status">Loading automatic backup settings…</p>
  {/if}

  {#if baseline && draft && view}
    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="automatic-backups-enabled">Enable Automatic Backups</Label.Root>
        </div>
        <div class="batshit-settings-form-control is-inline-status">
          <Switch.Root id="automatic-backups-enabled" checked={draft.enabled} onCheckedChange={(checked) => edit({ enabled: checked === true })} disabled={controlsDisabled} />
        </div>
      </div>
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="automatic-backups-cadence">Backup Schedule</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root type="single" value={draft.cadence} onValueChange={(value) => { if (value === 'daily' || value === 'weekly') edit({ cadence: value }) }} disabled={controlsDisabled}>
            <Select.Trigger id="automatic-backups-cadence"><span>{draft.cadence === 'daily' ? 'Daily' : 'Weekly'}</span></Select.Trigger>
            <Select.Content>
              <Select.Item value="daily" label="Daily" />
              <Select.Item value="weekly" label="Weekly" />
            </Select.Content>
          </Select.Root>
        </div>
      </div>
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="automatic-backups-folder">Backup Folder</Label.Root>
        </div>
        <div class="batshit-settings-form-control is-wide">
          <div class="batshit-settings-field-cluster">
            <div class="batshit-settings-field-lane">
              <Input id="automatic-backups-folder" value={draft.folder ?? ''} placeholder={view.defaultFolder} oninput={(event) => edit({ folder: event.currentTarget.value })} disabled={controlsDisabled} />
            </div>
            <Button type="button" size="sm" variant="outline" onclick={() => edit({ folder: null })} disabled={controlsDisabled || draft.folder === null}>Use Default</Button>
          </div>
          <p class="batshit-settings-form-meta break-all">{draft.folder === null ? 'Default folder: ' : 'Chosen folder: '}{draft.folder ?? view.defaultFolder}</p>
        </div>
      </div>
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label" for="automatic-backups-after-updates">Back up After Successful App Updates</Label.Root>
            <SettingsInfoMenu ariaLabel="About Backups After App Updates" contentClass="w-80">
              <p>After a new build's migrations and startup checks succeed, back up the resulting data. The most recent successful backup remains as the second copy. Failed or unfinished checks do not replace it.</p>
              <p>Later normal backups still keep only the latest two. Development source edits are not detected as app updates.</p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control is-inline-status">
          <Switch.Root id="automatic-backups-after-updates" checked={draft.afterUpdates} onCheckedChange={(checked) => edit({ afterUpdates: checked === true })} disabled={controlsDisabled} />
        </div>
      </div>
    </div>

    <div class="batshit-settings-action-row">
      <Button type="button" size="sm" onclick={save} disabled={controlsDisabled || recoveryRequired || !dirty}>{saving ? 'Saving Settings…' : 'Save Settings'}</Button>
      {#if recoveryRequired || savedChanged}
        <Button type="button" size="sm" variant="outline" onclick={() => load(true)} disabled={controlsDisabled || loading}>Load Saved Settings</Button>
      {/if}
      {#if dirty}<span class="batshit-settings-form-meta">Unsaved changes</span>{/if}
    </div>
    {#if saveError}<p class="batshit-settings-form-meta is-error" role="alert">{saveError}</p>{/if}
    {#if unknownNotice}<p class="batshit-settings-form-meta is-warning" role="status">{unknownNotice}</p>{/if}
    {#if recoveryRequired}<p class="batshit-settings-form-meta is-warning">Your draft is kept. Load Saved Settings to replace it before saving again.</p>
    {:else if savedChanged}<p class="batshit-settings-form-meta is-warning">Saved settings changed elsewhere. Your unsaved edits are being kept.</p>{/if}
    {#if saveNotice}<p class="batshit-settings-form-meta is-success" role="status">{saveNotice}</p>{/if}

    <div class="batshit-settings-group" aria-label="Automatic Backup Status">
      {#if view.running}
        <p class="batshit-settings-form-meta" role="status">An automatic backup is running. Settings are temporarily read-only.</p>
      {:else if !view.startup.ready}
        <p class="batshit-settings-form-meta is-warning" role="status">Automatic backups are waiting for successful startup checks.{view.startup.error ? ` ${bounded(view.startup.error)}` : ''}</p>
      {/if}
      {#if view.error}<p class="batshit-settings-form-meta is-error" role="alert">Last backup attempt failed: {bounded(view.error)}</p>{/if}
      {#if view.startup.warning}<p class="batshit-settings-form-meta is-warning" role="status">{bounded(view.startup.warning)}</p>{/if}
      <p class="batshit-settings-form-meta">Verified backups in this folder: {view.retainedCount}. {view.retainedCount === 1 ? 'One copy is available until the next successful backup.' : 'Batshit retains the latest two.'}</p>
      <p class="batshit-settings-form-meta">Last successful backup: {view.lastSuccess ? formatBackupDate(view.lastSuccess.createdAt) : 'None yet'}</p>
      {#if view.lastSuccess}<p class="batshit-settings-form-meta break-all">{view.lastSuccess.path} ({formatBackupBytes(view.lastSuccess.bytes)})</p>{/if}
      <p class="batshit-settings-form-meta">Next due: {view.nextDueAt ? formatBackupDate(view.nextDueAt) : (view.config.enabled ? 'Waiting for startup checks' : 'Automatic backups are off')}</p>
      {#each view.cleanupFailures as failure}
        <p class="batshit-settings-form-meta is-warning break-all">Backup file needs attention: {failure.path}. {bounded(failure.message)}</p>
      {/each}
      {#each view.preservedFolders as previous}
        <p class="batshit-settings-form-meta break-all">Old folder preserved: {previous.folder} ({previous.backupCount} backups outside this folder's managed pair).</p>
      {/each}
      {#each view.preservedFiles as previous}
        <p class="batshit-settings-form-meta is-warning break-all">File preserved: {previous.path}. {bounded(previous.message)}</p>
      {/each}
      {#each view.unavailableCopies as copy}
        <p class="batshit-settings-form-meta is-warning break-all">Backup unavailable ({copy.state}): {copy.path}. {bounded(copy.message)}</p>
      {/each}
    </div>
  {/if}
</div>
