<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { RefreshCw } from '@lucide/svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import {
    PINOKIO_ARTIFACT_KIND_LABELS,
    PINOKIO_ARTIFACT_KINDS,
    isPinokioKind,
    type PinokioArtifactKind
  } from '$lib/artifacts/pinokioArtifact'
  import {
    LOCAL_PINOKIO_MACHINE, LOCAL_PINOKIO_MACHINE_ID, isPinokioMachineList,
    readPinokioMachineSelector, type PinokioMachine
  } from '$lib/pinokio/machines'
  import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'

  /**
   * SA-072 P2/P3 (DL-09): the three rows the "Pinokio App" power source adds under Artifact Power
   * Source: the app kind (the real `source_type`), saved computer and installed app
   * (`pinokio_app_id`). The address is never stored; Batshit asks Pinokio on every run. The
   * recipe that calls the app (`pinokio_runtime`) is the Artifact Creator's job, not a form.
   */
  interface Props {
    metadata: Record<string, any>
    onChange: (metadata: Record<string, any>) => void
    disabled?: boolean
  }

  type PinokioAppOption = { appId: string; title: string; state: string }

  let { metadata, onChange, disabled = false }: Props = $props()

  let machines = $state<PinokioMachine[]>([LOCAL_PINOKIO_MACHINE])
  let machinesLoaded = $state(false)
  let machinesError = $state<string | null>(null)
  let machineRead = $state(0)
  let mounted = $state(false)
  let apps = $state<PinokioAppOption[]>([])
  let loading = $state(false)
  let note = $state<string | null>(null)
  let machineSequence = 0
  let appSequence = 0
  let appController: AbortController | null = null
  let appsTarget = $state<string | null>(null)

  const kind = $derived<PinokioArtifactKind>(isPinokioKind(metadata?.source_type) ? metadata.source_type : 'comfyui')
  const appId = $derived(typeof metadata?.pinokio_app_id === 'string' ? metadata.pinokio_app_id : '')
  const selectedApp = $derived(apps.find((app) => app.appId === appId) ?? null)
  const machineId = $derived(readPinokioMachineSelector(metadata)?.machineId ?? 'invalid')
  const selectedMachine = $derived(machines.find((machine) => machine.id === machineId) ?? null)
  const machineLabel = $derived(selectedMachine?.label ?? (machineId === 'invalid' ? 'Unresolved saved computer' : machineId))
  const targetKey = $derived(JSON.stringify([machineId, selectedMachine?.revision]))
  const appChoicesReady = $derived(appsTarget === targetKey && !loading)

  function changeMachine(value: string) {
    if (!mounted || disabled || value === machineId || !machines.some((machine) => machine.id === value)) return
    const next = { ...metadata }
    delete next.pinokio_machine_revision
    // Artifact saves shallow-merge sparse metadata; omission would keep the previous remote ID.
    // This runs only for a deliberate changed choice, so untouched absent-local metadata stays absent.
    next.pinokio_machine_id = value
    onChange(next)
  }

  async function loadMachines() {
    const sequence = ++machineSequence
    // Invalidate app reads immediately, including a response from the previous target revision.
    appController?.abort()
    appSequence += 1
    apps = []
    appsTarget = null
    machinesLoaded = false
    machinesError = null
    try {
      const response = await fetch('/api/pinokio/machines')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !isPinokioMachineList(payload?.machines)) {
        throw new Error(payload?.error || 'Batshit could not read the saved Pinokio connections.')
      }
      if (!mounted || sequence !== machineSequence) return
      machines = payload.machines
      machinesLoaded = true
    } catch (error) {
      if (!mounted || sequence !== machineSequence) return
      machinesError = error instanceof Error ? error.message : 'Batshit could not read the saved Pinokio connections.'
    } finally {
      if (mounted && sequence === machineSequence) machineRead += 1
    }
  }

  async function loadApps(targetId: string, revision: number | undefined, confirmed: boolean, savedListLoaded: boolean) {
    const sequence = ++appSequence
    appController?.abort()
    const controller = new AbortController()
    appController = controller
    apps = []
    appsTarget = null
    loading = true
    note = null
    if (targetId !== LOCAL_PINOKIO_MACHINE_ID && (!savedListLoaded || !confirmed || revision === undefined)) {
      note = !savedListLoaded ? 'Reload the saved connections to check this computer.'
        : !selectedMachine ? 'The saved computer is unavailable. Choose a saved connection to change this artifact.'
        : 'Reconnect this computer in Settings before using its apps.'
      loading = false
      return
    }
    try {
      const query = targetId === LOCAL_PINOKIO_MACHINE_ID ? ''
        : `?${new URLSearchParams({ machineId: targetId, revision: String(revision) })}`
      const response = await fetch(`/api/pinokio/apps${query}`, { signal: controller.signal })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) throw new Error(payload?.error || 'Batshit could not list the Pinokio apps.')
      if (!mounted || sequence !== appSequence) return
      if (targetId !== LOCAL_PINOKIO_MACHINE_ID && (payload.machineId !== targetId || payload.machineRevision !== revision)) {
        throw new Error('The Pinokio connection changed. Refresh its apps before choosing one.')
      }
      if (!Array.isArray(payload.apps) || !payload.apps.every((app: any) =>
        app && typeof app.appId === 'string' && typeof app.title === 'string' && typeof app.state === 'string')) {
        throw new Error('Batshit could not read the Pinokio app list.')
      }
      apps = payload.apps
      appsTarget = JSON.stringify([targetId, revision])
      note = payload.message ?? (apps.length === 0 ? 'Pinokio has no apps installed yet.' : null)
    } catch (error) {
      if (!mounted || sequence !== appSequence) return
      note = error instanceof Error ? error.message : 'Batshit could not list the Pinokio apps.'
    } finally {
      if (mounted && sequence === appSequence) loading = false
    }
  }

  $effect(() => {
    const target = machineId
    const revision = selectedMachine?.revision
    const confirmed = selectedMachine?.bindingState === 'confirmed'
    const loaded = machinesLoaded
    void machineRead
    if (mounted) untrack(() => void loadApps(target, revision, confirmed, loaded))
  })

  onMount(() => {
    mounted = true
    void loadMachines()
    const refresh = () => void loadMachines()
    window.addEventListener(LIVE_SETTINGS_EVENTS.pinokioMachinesUpdated, refresh)
    return () => {
      mounted = false
      machineSequence += 1
      appSequence += 1
      appController?.abort()
      window.removeEventListener(LIVE_SETTINGS_EVENTS.pinokioMachinesUpdated, refresh)
    }
  })
</script>

<div class="batshit-settings-form-row">
  <div class="batshit-settings-form-copy">
    <div class="batshit-settings-form-label-line">
      <Label.Root class="batshit-settings-form-label">App Kind</Label.Root>
      <SettingsInfoMenu ariaLabel="About the Pinokio app kind" contentClass="w-80">
        <p>
          What the app is. Batshit calls it the way that kind of app expects, and the badge reads
          "ComfyUI via Pinokio", "Gradio via Pinokio", or "Custom API via Pinokio".
        </p>
      </SettingsInfoMenu>
    </div>
  </div>
  <div class="batshit-settings-form-control">
    <Select.Root
      type="single"
      value={kind}
      {disabled}
      onValueChange={(value) => { if (mounted && !disabled) onChange({ ...metadata, source_type: value }) }}
    >
      <Select.Trigger>{PINOKIO_ARTIFACT_KIND_LABELS[kind]}</Select.Trigger>
      <Select.Content>
        {#each PINOKIO_ARTIFACT_KINDS as option (option)}
          <Select.Item value={option} label={PINOKIO_ARTIFACT_KIND_LABELS[option]}>
            {PINOKIO_ARTIFACT_KIND_LABELS[option]}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</div>

<div class="batshit-settings-form-row">
  <div class="batshit-settings-form-copy">
    <div class="batshit-settings-form-label-line">
      <Label.Root class="batshit-settings-form-label">Computer</Label.Root>
      <SettingsInfoMenu ariaLabel="About the Pinokio computer" contentClass="w-80">
        <p>Choose This computer or a saved Pinokio connection from Settings. Pinokio only needs to run on the computer serving the app. A saved connection does not mean it is online.</p>
      </SettingsInfoMenu>
    </div>
  </div>
  <div class="batshit-settings-form-control">
    <Select.Root type="single" value={machineId} {disabled} onValueChange={changeMachine}>
      <Select.Trigger aria-label="Pinokio computer">{machineLabel}</Select.Trigger>
      <Select.Content>
        {#if !selectedMachine}
          <Select.Item value={machineId} label={machineLabel} disabled>{machineLabel} (unavailable)</Select.Item>
        {/if}
        {#each machines as machine (machine.id)}
          <Select.Item value={machine.id} label={machine.label}>
            {machine.label}{machine.bindingState === 'needs_confirmation' ? ' (reconnect required)' : ''}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    {#if machinesError}<p class="batshit-settings-form-meta is-warning">{machinesError}</p>{/if}
  </div>
</div>

<div class="batshit-settings-form-row">
  <div class="batshit-settings-form-copy">
    <div class="batshit-settings-form-label-line">
      <Label.Root class="batshit-settings-form-label">Pinokio App</Label.Root>
      <SettingsInfoMenu ariaLabel="About the Pinokio app" contentClass="w-80">
        <p>
          An app installed in Pinokio on the selected computer. Batshit asks Pinokio where the app answers
          every time the artifact runs. When the app is not running, the artifact offers
          "Start with Pinokio", and Batshit starts it only after you confirm. Batshit never
          installs, stops, or deletes Pinokio apps.
        </p>
      </SettingsInfoMenu>
    </div>
  </div>
  <div class="batshit-settings-form-control">
    <div class="batshit-settings-field-cluster">
      <Select.Root
        type="single"
        value={appId}
        disabled={disabled || !appChoicesReady}
        onValueChange={(value) => {
          if (mounted && !disabled && appChoicesReady && apps.some((app) => app.appId === value)) onChange({ ...metadata, pinokio_app_id: value })
        }}
      >
        <Select.Trigger aria-label="Pinokio app">
          {#if selectedApp}
            {selectedApp.title} · {machineLabel}
          {:else if appId}
            {appId}
          {:else}
            Choose an installed app
          {/if}
        </Select.Trigger>
        <Select.Content>
          {#if appId && !selectedApp}
            <Select.Item value={appId} label={appId}>{appId} (not found in Pinokio)</Select.Item>
          {/if}
          {#each apps as app (app.appId)}
            <Select.Item value={app.appId} label={app.title}>
              <div class="flex min-w-0 flex-col">
                <span class="truncate">{app.title}</span>
                <span class="batshit-settings-caption truncate">{app.appId} · {machineLabel} · {app.state}</span>
              </div>
            </Select.Item>
          {/each}
          {#if apps.length === 0 && !appId}
            <Select.Label>{loading ? 'Loading apps…' : 'No Pinokio apps found'}</Select.Label>
          {/if}
        </Select.Content>
      </Select.Root>
      <Button variant="ghost" size="icon" onclick={() => void loadMachines()} disabled={loading} title="Refresh the Pinokio apps">
        <RefreshCw class={loading ? 'animate-spin' : ''} />
      </Button>
    </div>
    {#if note}
      <p class="batshit-settings-form-meta is-warning">{note}</p>
    {/if}
  </div>
</div>
