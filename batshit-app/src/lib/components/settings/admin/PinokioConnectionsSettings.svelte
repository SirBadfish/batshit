<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import {
    isPinokioControlHost, isPinokioControlPort, isPinokioMachineList,
    isPinokioRemoteMachine, type PinokioRemoteMachine
  } from '$lib/pinokio/machines'
  import { LIVE_SETTINGS_EVENTS, dispatchPinokioMachinesUpdated } from '$lib/utils/liveSettingsEvents'

  let machines = $state<PinokioRemoteMachine[]>([])
  let loading = $state(true)
  let loaded = $state(false)
  let busy = $state(false)
  let loadError = $state('')
  let actionError = $state('')
  let notice = $state('')
  let address = $state('')
  let label = $state('')
  let editing = $state<PinokioRemoteMachine | null>(null)
  let removal = $state<PinokioRemoteMachine | null>(null)
  let reviewRequired = $state(false)
  let disposed = false
  let readSequence = 0
  let publishing = false
  let refreshPending = false

  function endpoint(machine: PinokioRemoteMachine) {
    return `${machine.controlProtocol}://${machine.controlHost}:${machine.controlPort}`
  }

  // Convenience syntax only. The shared guards and session route remain authoritative.
  function parseAddress(value: string) {
    const raw = value.trim()
    const explicit = /^(https?):\/\/([0-9.]+)(?::([0-9]+))?\/?$/i.exec(raw)
    const plain = /^([0-9.]+)(?::([0-9]+))?$/.exec(raw)
    const controlProtocol: 'http' | 'https' = explicit?.[1].toLowerCase() === 'https' ? 'https' : 'http'
    const controlHost = explicit?.[2] ?? plain?.[1]
    const port = explicit?.[3] ?? plain?.[2]
    const controlPort = port ? Number(port) : explicit ? (controlProtocol === 'https' ? 443 : 80) : 42000
    if ((!explicit && !plain) || !isPinokioControlHost(controlHost) || !isPinokioControlPort(controlPort)) {
      throw new Error('Enter a private IPv4 address, optionally with a port, or an http:// or https:// address without credentials, a path, a query, or a fragment.')
    }
    return { controlProtocol, controlHost, controlPort }
  }

  const dirty = $derived(editing ? label !== editing.label || address !== endpoint(editing) : Boolean(label || address))
  const canWrite = $derived(loaded && !loading && !busy && !reviewRequired)

  async function load() {
    if (busy) { refreshPending = true; return }
    const sequence = ++readSequence
    loading = true
    loadError = ''
    try {
      const response = await fetch('/api/pinokio/machines')
      const payload = await response.json().catch(() => null)
      if (!response.ok || !isPinokioMachineList(payload?.machines)) {
        throw new Error(payload?.error || 'Batshit could not read the saved Pinokio connections.')
      }
      if (disposed || sequence !== readSequence) return
      machines = payload.machines.filter(isPinokioRemoteMachine)
      loaded = true
      if (editing && machines.find((machine) => machine.id === editing?.id)?.version !== editing.version) {
        reviewRequired = true
        actionError = 'This connection changed or was removed elsewhere. Your draft is kept. Review the saved list before making another change.'
      }
    } catch (failure) {
      if (disposed || sequence !== readSequence) return
      loaded = false
      loadError = failure instanceof Error ? failure.message : 'Batshit could not read the saved Pinokio connections.'
    } finally {
      if (!disposed && sequence === readSequence) loading = false
    }
  }

  function resetDraft() {
    if (busy || !loaded || loading) return
    editing = null
    removal = null
    label = ''
    address = ''
    actionError = ''
    notice = ''
    reviewRequired = false
  }

  function edit(machine: PinokioRemoteMachine) {
    if (!canWrite || dirty) return
    editing = { ...machine }
    label = machine.label
    address = endpoint(machine)
    actionError = ''
    notice = ''
    removal = null
  }

  async function mutate(method: 'POST' | 'PUT' | 'DELETE', machine: PinokioRemoteMachine | null, body: Record<string, unknown>) {
    if (!canWrite) return
    busy = true
    readSequence += 1
    actionError = ''
    notice = ''
    let refreshAfter = false
    let outcomeKnown = false
    try {
      const response = await fetch(`/api/pinokio/machines${machine ? `/${machine.id}` : ''}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        outcomeKnown = [400, 401, 403, 404, 409].includes(response.status)
        if (response.status !== 400) {
          reviewRequired = true
          if (response.status === 404 || response.status === 409) refreshAfter = true
          else loaded = false
        }
        throw new Error(response.status === 409 || response.status === 404
          ? `${payload?.error || 'This connection changed elsewhere.'} Your draft is kept. Review the saved list before making another change.`
          : response.status >= 500
            ? 'Batshit could not confirm whether the connection changed. Reload the saved list before making another change.'
            : payload?.error || 'The Pinokio connection could not be changed.')
      }
      if (method === 'DELETE' ? payload?.success !== true
        : !isPinokioRemoteMachine(payload?.machine) || (machine && payload.machine.id !== machine.id)) {
        loaded = false
        reviewRequired = true
        throw new Error('Batshit could not confirm whether the connection changed. Reload the saved list before making another change.')
      }
      outcomeKnown = true
      const saved = method === 'DELETE' ? null : payload.machine as PinokioRemoteMachine
      publishing = true
      dispatchPinokioMachinesUpdated({ machineId: saved?.id ?? machine!.id, ...(saved ? { revision: saved.revision } : {}) })
      publishing = false
      if (disposed) return
      machines = saved ? [...machines.filter((row) => row.id !== saved.id), saved] : machines.filter((row) => row.id !== machine!.id)
      editing = null
      removal = null
      label = ''
      address = ''
      reviewRequired = false
      notice = method === 'DELETE' ? 'Connection removed. Apps and Artifacts were kept.' : 'Connection saved. Availability is checked when you use it.'
      refreshAfter = true
    } catch (failure) {
      let message = failure instanceof Error ? failure.message : 'The Pinokio connection could not be changed.'
      // A transport failure may follow a stored write; never retry that mutation automatically.
      if (!outcomeKnown) {
        loaded = false
        reviewRequired = true
        message = 'Batshit could not confirm whether the connection changed. Reload the saved list before making another change.'
        publishing = true
        dispatchPinokioMachinesUpdated(machine ? { machineId: machine.id } : {})
        publishing = false
      }
      if (disposed) toast.error(message)
      else actionError = message
    } finally {
      busy = false
      if (!disposed && (refreshAfter || refreshPending)) {
        refreshPending = false
        void load()
      }
    }
  }

  function save() {
    if (!canWrite || !dirty) return
    let target: ReturnType<typeof parseAddress>
    try { target = parseAddress(address) }
    catch (failure) { actionError = failure instanceof Error ? failure.message : 'Check the Pinokio address.'; return }
    const nextLabel = label.trim() || target.controlHost
    if (nextLabel.length > 100) { actionError = 'Use a connection label of 100 characters or fewer.'; return }
    if (!editing) { void mutate('POST', null, { label: nextLabel, ...target }); return }
    const body: Record<string, unknown> = { expectedVersion: editing.version }
    if (nextLabel !== editing.label) body.label = nextLabel
    if (target.controlHost !== editing.controlHost) body.controlHost = target.controlHost
    if (target.controlPort !== editing.controlPort) body.controlPort = target.controlPort
    if (target.controlProtocol !== editing.controlProtocol) body.controlProtocol = target.controlProtocol
    void mutate('PUT', editing, body)
  }

  onMount(() => {
    void load()
    const refresh = () => { if (!publishing) void load() }
    window.addEventListener(LIVE_SETTINGS_EVENTS.pinokioMachinesUpdated, refresh)
    return () => {
      disposed = true
      readSequence += 1
      window.removeEventListener(LIVE_SETTINGS_EVENTS.pinokioMachinesUpdated, refresh)
    }
  })
</script>

<div class="batshit-settings-subsection" data-testid="pinokio-connections">
  <div class="batshit-settings-action-row">
    <div class="batshit-settings-form-label-line">
      <h4 class="batshit-settings-parent-label">Other Computers</h4>
      <SettingsInfoMenu ariaLabel="About Pinokio Connections" contentClass="w-80">
        <p>Save the private LAN address of a computer running Pinokio. This computer does not need Pinokio installed. Without a scheme, the address uses HTTP on port 42000. An explicit HTTP or HTTPS URL keeps its scheme and usual port unless you specify one.</p>
        <p>Saving selects the address; it does not check availability or start an app. A restored connection needs Reconnect before use. Removing a connection keeps its apps and Artifacts. App starts still need approval.</p>
      </SettingsInfoMenu>
    </div>
    <Button variant="ghost" size="sm" onclick={load} disabled={loading || busy}>Refresh Connections</Button>
  </div>
  {#if loading}<p class="batshit-settings-form-meta">Loading connections…</p>{/if}
  {#if loadError}
    <div role="alert">
      <p class="batshit-settings-form-meta is-error">{loadError} Connections cannot be changed until the saved list loads.</p>
      <Button variant="outline" size="sm" onclick={load} disabled={loading || busy}>Retry Connections</Button>
    </div>
  {/if}
  <div class="batshit-settings-group">
    {#each machines as machine (machine.id)}
      <div class="batshit-settings-toggle-row">
        <div class="batshit-settings-form-copy">
          <p class="batshit-settings-child-label">{machine.label}</p>
          <p class="batshit-settings-caption break-all">{endpoint(machine)} · {machine.bindingState === 'confirmed' ? 'Saved' : 'Reconnect needed'}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          {#if machine.bindingState === 'needs_confirmation'}
            <Button variant="outline" size="sm" disabled={!canWrite || dirty} onclick={() => mutate('PUT', machine, { expectedVersion: machine.version, reconnect: true })} aria-label={`Reconnect ${machine.label}`}>Reconnect</Button>
          {/if}
          <Button variant="outline" size="sm" disabled={!canWrite || dirty} onclick={() => edit(machine)} aria-label={`Edit ${machine.label}`}>Edit</Button>
          <Button variant="ghost" size="sm" disabled={!canWrite || dirty} onclick={() => removal = { ...machine }} aria-label={`Remove ${machine.label}`}>Remove</Button>
        </div>
      </div>
    {/each}
    {#if loaded && !loading && machines.length === 0}<p class="batshit-settings-form-meta">No other computers saved.</p>{/if}
  </div>
  {#if removal}
    <div class="batshit-settings-action-row">
      <p class="batshit-settings-form-meta">Remove {removal.label} from Batshit? Its apps and Artifacts will be kept.</p>
      <Button variant="outline" size="sm" disabled={!canWrite} onclick={() => removal && mutate('DELETE', removal, { expectedVersion: removal.version })}>Remove Connection</Button>
      <Button variant="ghost" size="sm" disabled={busy} onclick={() => removal = null}>Cancel Removal</Button>
    </div>
  {/if}
  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy"><Label.Root for="pinokio-address" class="batshit-settings-form-label">Pinokio Address</Label.Root></div>
      <div class="batshit-settings-form-control is-wide"><Input id="pinokio-address" bind:value={address} disabled={!canWrite || Boolean(removal)} placeholder="192.168.1.10:42000" autocomplete="off" spellcheck={false} /></div>
    </div>
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy"><Label.Root for="pinokio-label" class="batshit-settings-form-label">Label (Optional)</Label.Root></div>
      <div class="batshit-settings-form-control"><Input id="pinokio-label" bind:value={label} disabled={!canWrite || Boolean(removal)} maxlength={100} placeholder="Gaming PC" autocomplete="off" /></div>
    </div>
  </div>
  {#if actionError}<p class="batshit-settings-form-meta is-error" role="alert">{actionError}</p>{/if}
  {#if notice}<p class="batshit-settings-form-meta is-success" role="status">{notice}</p>{/if}
  <div class="batshit-settings-action-row">
    <Button variant="outline" size="sm" disabled={!canWrite || Boolean(removal) || !dirty || !address.trim()} onclick={save}>{busy ? 'Saving…' : editing ? 'Save Changes' : 'Save Connection'}</Button>
    {#if dirty || editing || reviewRequired}
      <Button variant="ghost" size="sm" disabled={busy || loading || !loaded} onclick={resetDraft}>{reviewRequired ? 'Review Complete, Reset Form' : 'Cancel Edit'}</Button>
    {/if}
  </div>
</div>
