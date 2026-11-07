<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import AppActionsPermissionFields from './AppActionsPermissionFields.svelte'
  import AppActionsPolicySummary from './AppActionsPolicySummary.svelte'
  import { registerAppActionDraft } from '$lib/appActions/owners'
  import { onUserChannelEvent } from '$lib/services/userChannel'
  import {
    APP_ACTIONS_MANAGEMENT_ROUTES, APP_ACTIONS_PORTABLE_DEFAULT_LIFETIME_MS,
    APP_ACTIONS_PORTABLE_MAX_LIFETIME_MS, defaultAppActionsPolicy, isAppActionsPortableGrantResponse,
    APP_ACTIONS_PORTABLE_REFRESH_EVENT,
    type AppActionsPolicy, type AppActionsPortableGrantResponse
  } from '$lib/appActions/settings/managementContract'

  let { tokenId, disabled = false, onSaved = () => {} }: { tokenId: string; disabled?: boolean; onSaved?: () => void } = $props()
  let saved = $state<AppActionsPortableGrantResponse | null>(null)
  let latest = $state<AppActionsPortableGrantResponse | null>(null)
  let draft = $state<AppActionsPolicy>(defaultAppActionsPolicy(true))
  let expiresText = $state('')
  let initialSignature = $state('')
  let preciseExpiry = ''
  let preciseExpiryText = ''
  let loading = $state(false)
  let readFailed = $state(false)
  let saving = $state(false)
  let uncertain = $state(false)
  let savedReadbackUnavailable = $state(false)
  let error = $state('')
  let notice = $state('')
  let alive = false
  let sequence = 0
  let refreshPending = false
  const signature = $derived(JSON.stringify([draft, expiresText]))
  const dirty = $derived(saved !== null && signature !== initialSignature)
  const stale = $derived(latest !== null && saved !== null && latest.authorityGeneration !== saved.authorityGeneration)
  function localDate(value: string) {
    const date = new Date(value)
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }
  function install(payload: AppActionsPortableGrantResponse) {
    // Compute the complete saved form from plain data before changing any editor state.
    const nextSaved = structuredClone($state.snapshot(payload))
    const nextDraft = structuredClone(nextSaved.grant?.policy ?? defaultAppActionsPolicy(true))
    const nextPreciseExpiry = nextSaved.grant?.expiresAt ?? new Date(Date.now() + APP_ACTIONS_PORTABLE_DEFAULT_LIFETIME_MS).toISOString()
    const nextExpiresText = localDate(nextPreciseExpiry)
    const nextSignature = JSON.stringify([nextDraft, nextExpiresText])
    saved = nextSaved
    latest = null
    draft = nextDraft
    preciseExpiry = nextPreciseExpiry
    expiresText = nextExpiresText
    preciseExpiryText = nextExpiresText
    initialSignature = nextSignature
    notice = ''
  }
  async function load() {
    if (saving) { refreshPending = true; return }
    const request = ++sequence
    loading = true
    error = ''
    try {
      const response = await fetch(APP_ACTIONS_MANAGEMENT_ROUTES.portableGrant(tokenId), { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !isAppActionsPortableGrantResponse(payload) || payload.tokenId !== tokenId) {
        throw new Error(payload?.error || 'Portable App Actions access could not be read.')
      }
      if (!alive || request !== sequence) return
      readFailed = false
      if (saved && dirty) {
        latest = payload
        if (payload.authorityGeneration !== saved.authorityGeneration) notice = 'This token changed. Your draft is kept. Review its saved access before saving.'
      } else install(payload)
      if (uncertain) notice = 'The current saved access was read. The earlier save response remains unconfirmed.'
      if (savedReadbackUnavailable) notice = 'The access save was confirmed. Its current saved value was checked.'
      uncertain = false
      savedReadbackUnavailable = false
    } catch (failure) {
      if (alive && request === sequence) { readFailed = true; error = failure instanceof Error ? failure.message : 'Portable App Actions access could not be read.' }
    } finally { if (alive && request === sequence) loading = false }
  }
  async function save(remove = false) {
    if (!saved || loading || saving || disabled || stale || uncertain || savedReadbackUnavailable || readFailed || !remove && !dirty) return
    const expiry = new Date(expiresText === preciseExpiryText ? preciseExpiry : expiresText)
    if (!remove && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now() || expiry.getTime() - Date.now() > APP_ACTIONS_PORTABLE_MAX_LIFETIME_MS)) {
      error = 'Choose an expiry in the future, no more than 30 days from now.'
      return
    }
    const captured = { expectedAuthorityGeneration: saved.authorityGeneration,
      grant: remove ? null : { policy: $state.snapshot(draft), expiresAt: expiry.toISOString() } }
    saving = true
    sequence += 1
    error = ''
    notice = ''
    let readAfter = false
    let knownRefusal = false
    let knownSaved = false
    try {
      const response = await fetch(APP_ACTIONS_MANAGEMENT_ROUTES.portableGrant(tokenId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(captured)
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        readAfter = response.status === 409
        knownRefusal = [400, 401, 403, 404, 409].includes(response.status)
        knownSaved = response.status === 503 && payload?.success === false &&
          payload.code === 'AUTHORITY_SAVED_READBACK_UNAVAILABLE' && typeof payload.error === 'string' && !!payload.error.trim()
        throw new Error(payload?.error || 'Portable App Actions access could not be saved.')
      }
      if (!isAppActionsPortableGrantResponse(payload) || payload.tokenId !== tokenId) throw new Error('The save response could not be confirmed. Check the saved access.')
      if (!alive) return
      install(payload)
      notice = remove ? 'App Actions access removed. Other token families are unchanged.' : 'App Actions access saved. Ask first still requires approval for each protected operation.'
      onSaved()
    } catch (failure) {
      if (!alive) return
      savedReadbackUnavailable = knownSaved
      uncertain = !knownRefusal && !knownSaved
      error = failure instanceof Error ? failure.message : 'The save outcome is unconfirmed. Check the saved access.'
    } finally { saving = false; if (alive && (readAfter || refreshPending)) { refreshPending = false; void load() } }
  }
  onMount(() => {
    alive = true
    void load()
    const stopDraft = registerAppActionDraft(() => dirty || saving || uncertain || savedReadbackUnavailable)
    const stopEvents = onUserChannelEvent(event => {
      if (event.type === 'reconnected' || event.type === APP_ACTIONS_PORTABLE_REFRESH_EVENT && event.tokenId === tokenId) void load()
    })
    return () => { alive = false; sequence += 1; stopDraft(); stopEvents() }
  })
</script>

<div class="batshit-settings-form-stack">
  {#if !saved}
    <p class="batshit-settings-form-meta" role={error ? 'alert' : 'status'}>{error || 'Loading App Actions access…'}</p>
    {#if error}<Button type="button" size="sm" variant="outline" onclick={load} disabled={loading}>Retry Portable App Actions Access</Button>{/if}
  {:else}
    <fieldset disabled={loading || saving || disabled || uncertain || savedReadbackUnavailable || readFailed} inert={loading || saving || disabled || uncertain || savedReadbackUnavailable || readFailed}>
      <AppActionsPermissionFields policy={draft} subjects={saved.subjects} portable disabled={loading || saving || disabled || uncertain || savedReadbackUnavailable || readFailed}
        onChange={next => { if (!loading && !saving && !disabled && !uncertain && !savedReadbackUnavailable && !readFailed) draft = next }} />
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy"><Label.Root for={`app-actions-expiry-${tokenId}`} class="batshit-settings-form-label">App Actions Expiry</Label.Root>
          <p class="batshit-settings-form-meta">This scope defaults to 24 hours and lasts at most 30 days. Other token families keep their current lifetime.</p>
        </div>
        <div class="batshit-settings-form-control"><Input id={`app-actions-expiry-${tokenId}`} type="datetime-local" value={expiresText}
          disabled={loading || saving || disabled || uncertain || savedReadbackUnavailable || readFailed} oninput={event => { expiresText = event.currentTarget.value }} /></div>
      </div>
    </fieldset>
    {#if error}<p class="batshit-settings-form-meta is-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="batshit-settings-form-meta" role="status">{notice}</p>{/if}
    {#if uncertain}<p class="batshit-settings-form-meta is-warning">The save outcome is unconfirmed. Check the saved access before making another change.</p>{/if}
    {#if savedReadbackUnavailable}<p class="batshit-settings-form-meta is-warning">The access was saved. Check its current saved value before another change.</p>{/if}
    {#if stale && latest}
      <details><summary class="batshit-settings-child-label">Review Saved Access</summary>
        {#if latest.grant}<AppActionsPolicySummary policy={latest.grant.policy} />
          <p class="batshit-settings-caption">Expires {new Date(latest.grant.expiresAt).toLocaleString()}</p>
        {:else}<p class="batshit-settings-caption">This token has no saved App Actions grant.</p>{/if}
        <div class="batshit-settings-field-cluster">
          <Button type="button" size="sm" variant="outline" onclick={() => { if (latest) install(latest) }}>Use Saved Access</Button>
          <Button type="button" size="sm" variant="outline" onclick={() => { if (latest) { saved = latest; latest = null; initialSignature = JSON.stringify([saved.grant?.policy ?? defaultAppActionsPolicy(true), saved.grant ? localDate(saved.grant.expiresAt) : expiresText]) } }}>Keep My Draft</Button>
        </div>
      </details>
    {/if}
    <div class="batshit-settings-field-cluster">
      <Button type="button" size="sm" disabled={!dirty || loading || saving || disabled || stale || uncertain || savedReadbackUnavailable || readFailed} onclick={() => save()}>Save Portable App Actions Access</Button>
      {#if saved.grant}<Button type="button" size="sm" variant="outline" disabled={loading || saving || disabled || stale || uncertain || savedReadbackUnavailable || readFailed} onclick={() => save(true)}>Remove App Actions Access</Button>{/if}
      <Button type="button" size="sm" variant="outline" disabled={loading || saving} onclick={load}>Check Saved Access</Button>
    </div>
  {/if}
</div>
