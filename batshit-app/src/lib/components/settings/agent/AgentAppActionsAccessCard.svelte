<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { ShieldCheck } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import AppActionsPermissionFields from './AppActionsPermissionFields.svelte'
  import AppActionsPolicySummary from './AppActionsPolicySummary.svelte'
  import { registerAppActionDraft } from '$lib/appActions/owners'
  import { onUserChannelEvent } from '$lib/services/userChannel'
  import {
    APP_ACTIONS_MANAGEMENT_ROUTES, APP_ACTIONS_POLICY_REFRESH_FAMILY,
    defaultAppActionsPolicy, isAppActionsNativePolicyResponse,
    type AppActionsNativePolicyResponse, type AppActionsPolicy
  } from '$lib/appActions/settings/managementContract'

  let { agentId, sectionClass = '', active = true }: { agentId: string; sectionClass?: string; active?: boolean } = $props()
  let saved = $state<AppActionsNativePolicyResponse | null>(null)
  let latest = $state<AppActionsNativePolicyResponse | null>(null)
  let draft = $state<AppActionsPolicy>(defaultAppActionsPolicy())
  let loading = $state(false)
  let readFailed = $state(false)
  let saving = $state(false)
  let error = $state('')
  let notice = $state('')
  let uncertain = $state(false)
  let savedReadbackUnavailable = $state(false)
  let savedNotice = $state(false)
  let mounted = $state(false)
  let attempted = false
  let alive = false
  let readSequence = 0
  let refreshPending = false
  const dirty = $derived(saved !== null && JSON.stringify(draft) !== JSON.stringify(saved.policy))
  const stale = $derived(latest !== null && saved !== null && (latest.generation !== saved.generation || latest.subjectRevision !== saved.subjectRevision))

  function install(payload: AppActionsNativePolicyResponse) {
    // A reviewed `latest` value is a state proxy. Prepare independent plain copies before
    // moving the baseline, so a preparation failure cannot mark an old draft as current.
    const nextSaved = structuredClone($state.snapshot(payload))
    const nextDraft = structuredClone(nextSaved.policy)
    saved = nextSaved
    latest = null
    draft = nextDraft
    notice = ''
  }
  async function load() {
    if (saving) { refreshPending = true; return }
    const sequence = ++readSequence
    loading = true
    error = ''
    try {
      const response = await fetch(APP_ACTIONS_MANAGEMENT_ROUTES.nativePolicy(agentId), { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !isAppActionsNativePolicyResponse(payload) || payload.agentId !== agentId) {
        throw new Error(payload?.error || 'App Actions access could not be read.')
      }
      if (!alive || sequence !== readSequence) return
      readFailed = false
      if (saved && dirty) {
        latest = payload
        if (payload.generation !== saved.generation || payload.subjectRevision !== saved.subjectRevision) notice = 'The saved policy changed. Your draft is kept. Review the saved policy before saving.'
      } else install(payload)
      if (uncertain) notice = 'The current saved policy was read. The earlier save response remains unconfirmed.'
      if (savedReadbackUnavailable) notice = 'The policy save was confirmed. Its current saved value was checked.'
      uncertain = false
      savedReadbackUnavailable = false
    } catch (failure) {
      if (alive && sequence === readSequence) { readFailed = true; error = failure instanceof Error ? failure.message : 'App Actions access could not be read.' }
    } finally {
      if (alive && sequence === readSequence) loading = false
    }
  }
  function keepDraft() {
    if (!latest || saving || loading) return
    saved = latest
    latest = null
    notice = 'Your draft is kept against the policy you just reviewed. Save to apply it.'
  }
  async function save() {
    if (!saved || loading || saving || stale || uncertain || savedReadbackUnavailable || readFailed || !dirty) return
    const captured = { expectedGeneration: saved.generation, expectedSubjectRevision: saved.subjectRevision, policy: $state.snapshot(draft) }
    saving = true
    savedNotice = false
    error = ''
    notice = ''
    readSequence += 1
    let readAfter = false
    let knownRefusal = false
    let knownSaved = false
    try {
      const response = await fetch(APP_ACTIONS_MANAGEMENT_ROUTES.nativePolicy(agentId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(captured)
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        readAfter = response.status === 409
        knownRefusal = [400, 401, 403, 404, 409].includes(response.status)
        knownSaved = response.status === 503 && payload?.success === false &&
          payload.code === 'AUTHORITY_SAVED_READBACK_UNAVAILABLE' && typeof payload.error === 'string' && !!payload.error.trim()
        throw new Error(payload?.error || 'App Actions access could not be saved.')
      }
      if (!isAppActionsNativePolicyResponse(payload) || payload.agentId !== agentId) {
        uncertain = true
        throw new Error('The save response could not be confirmed. Check the saved policy before making another change.')
      }
      if (!alive) return
      install(payload)
      savedNotice = true
      notice = 'Access saved. Individual actions still check their current permissions.'
    } catch (failure) {
      if (!alive) return
      savedReadbackUnavailable = knownSaved
      uncertain = !knownRefusal && !knownSaved
      error = failure instanceof Error ? failure.message : 'The save outcome is unconfirmed. Check the saved policy.'
    } finally {
      saving = false
      if (alive && (readAfter || refreshPending)) { refreshPending = false; void load() }
    }
  }
  onMount(() => {
    alive = true
    mounted = true
    const stopDraft = registerAppActionDraft(() => dirty || saving || uncertain || savedReadbackUnavailable)
    const stopEvents = onUserChannelEvent(event => {
      if (attempted && (event.type === 'reconnected' || event.type === 'agent_settings_changed' && event.agentId === agentId && event.family === APP_ACTIONS_POLICY_REFRESH_FAMILY)) void load()
    })
    return () => { alive = false; readSequence += 1; stopDraft(); stopEvents() }
  })
  $effect(() => {
    if (mounted && active) untrack(() => { if (!attempted) { attempted = true; void load() } })
  })
</script>

<SettingsAccordionCard name="agent-access-cards" title="App Actions" icon={ShieldCheck} class={sectionClass} contentClass="space-y-3">
  {#snippet info()}<SettingsInfoMenu ariaLabel="About App Actions">Choose which agents this Primary Agent may inspect and change. Only you can save these permissions.</SettingsInfoMenu>{/snippet}
  {#snippet actions()}<SettingsSaveStatus state={saving ? 'saving' : error ? 'error' : savedNotice ? 'saved' : 'idle'} {error} />{/snippet}
  {#if !saved}
    <div class="batshit-settings-inline-alert" role={error ? 'alert' : 'status'}>{error || 'Loading App Actions access…'}</div>
    {#if error}<Button type="button" size="sm" variant="outline" onclick={load} disabled={loading}>Retry App Actions Access</Button>{/if}
  {:else}
    <fieldset disabled={loading || saving || uncertain || savedReadbackUnavailable || readFailed || !active} inert={loading || saving || uncertain || savedReadbackUnavailable || readFailed || !active}>
      <AppActionsPermissionFields policy={draft} subjects={saved.subjects} disabled={loading || saving || uncertain || savedReadbackUnavailable || readFailed || !active}
        onChange={next => { if (!loading && !saving && !uncertain && !savedReadbackUnavailable && !readFailed && active) { draft = next; savedNotice = false } }} />
    </fieldset>
    {#if notice}<p class="batshit-settings-form-meta" role="status">{notice}</p>{/if}
    {#if uncertain}<p class="batshit-settings-form-meta is-warning">The save outcome is unconfirmed. Check the saved policy before making another change.</p>{/if}
    {#if savedReadbackUnavailable}<p class="batshit-settings-form-meta is-warning">The policy was saved. Check its current saved value before another change.</p>{/if}
    {#if stale && latest}
      <details><summary class="batshit-settings-child-label">Review Saved Policy</summary>
        <AppActionsPolicySummary policy={latest.policy} />
        <div class="batshit-settings-field-cluster">
          <Button type="button" size="sm" variant="outline" onclick={() => { if (latest) install(latest) }}>Use Saved Policy</Button>
          <Button type="button" size="sm" variant="outline" onclick={keepDraft}>Keep My Draft</Button>
        </div>
      </details>
    {/if}
    <div class="batshit-settings-field-cluster">
      <Button type="button" size="sm" onclick={save} disabled={!dirty || loading || saving || stale || uncertain || savedReadbackUnavailable || readFailed || !active}>Save App Actions Access</Button>
      <Button type="button" size="sm" variant="outline" onclick={load} disabled={loading || saving}>Check Saved Policy</Button>
    </div>
  {/if}
</SettingsAccordionCard>
