<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import * as Dialog from '$lib/components/ui/dialog'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
  import { CHATGPT_PLAN_USAGE_URL, type ChatgptPlanAccountSummary } from '$lib/utils/chatgptPlanConnection'

  let accounts = $state<ChatgptPlanAccountSummary[]>([])
  let loading = $state(true), busy = $state(false), waiting = $state(false), error = $state(''), welcome = $state(false)
  let authorizationUrl = $state(''), eligible = $state(true)
  let poll: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  async function action(body: Record<string, unknown>) {
    const response = await fetch('/api/settings/chatgpt-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) {
      if (data.code === 'runtime_ineligible') eligible = false
      throw new Error(data.error || 'ChatGPT connection could not be updated.')
    }
    return data
  }
  async function load() {
    try {
      const data = await action({ action: 'status' })
      if (disposed) return
      accounts = data.accounts; waiting = data.attempt.state === 'waiting'
      if (data.attempt.state === 'error') error = 'ChatGPT sign-in could not complete. Continue with ChatGPT to try again.'
      else error = ''
      if (data.attempt.cleanup === 'unconfirmed') error = 'Remote credential cleanup could not be confirmed. Manage the Batshit connection in ChatGPT settings before connecting again.'
      if (data.attempt.state === 'complete' && accounts.some(account => account.id === data.attempt.accountId && account.state === 'ready')) {
        dispatchModelConnectionsUpdated('api-keys')
        authorizationUrl = ''
        const key = 'batshit:chatgpt-plan-welcome'
        if (!localStorage.getItem(key)) { welcome = true; localStorage.setItem(key, 'shown') }
      }
      if (waiting) poll = setTimeout(load, 1000)
    } catch (failure) { if (!disposed) error = failure instanceof Error ? failure.message : 'ChatGPT connection could not load.' }
    finally { if (!disposed) loading = false }
  }
  async function start(accountId?: string) {
    if (busy || loading) return
    busy = true; error = ''
    try {
      const data = await action({ action: 'start', accountId })
      authorizationUrl = data.authorizationUrl
      window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer')
      waiting = true; if (poll) clearTimeout(poll); poll = setTimeout(load, 1000)
    } catch (failure) { error = failure instanceof Error ? failure.message : 'ChatGPT sign-in could not start.' }
    finally { busy = false }
  }
  async function disconnect(accountId: string) {
    busy = true; error = ''
    try {
      const result = await action({ action: 'disconnect', accountId })
      await load(); dispatchModelConnectionsUpdated('api-keys')
      if (result.remoteRevocation !== 'confirmed') error = 'Disconnected from Batshit. OpenAI revocation could not be confirmed; manage the Batshit connection in ChatGPT.'
    } catch (failure) { error = failure instanceof Error ? failure.message : 'ChatGPT disconnect could not complete.' }
    finally { busy = false }
  }
  async function cancel() {
    busy = true
    try { await action({ action: 'cancel' }); authorizationUrl = ''; if (poll) clearTimeout(poll); await load() }
    catch (failure) { error = failure instanceof Error ? failure.message : 'ChatGPT sign-in cancellation failed.' }
    finally { busy = false }
  }
  onMount(() => { void load() })
  onDestroy(() => { disposed = true; if (poll) clearTimeout(poll) })
</script>

<Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-l1-card" data-testid="chatgpt-plan-connection">
  <Card.Header class="batshit-settings-l1-card-header">
    <div class="flex items-center gap-2">
      <IconRenderer ref={{ kind: 'brand', slug: 'openai-mono' }} iconClass="h-4 w-4" label="OpenAI" />
      <h4 class="batshit-settings-section-title">ChatGPT Plan</h4>
      <SettingsInfoMenu ariaLabel="About ChatGPT Plan" contentClass="w-80">
        <p>Connect your ChatGPT plan to normal API agents and Compact. Available models and app limits come from your ChatGPT account. OpenAI API keys remain a separate paid connection.</p>
      </SettingsInfoMenu>
    </div>
  </Card.Header>
  <Card.Content class="batshit-settings-card-content-spacious space-y-3">
    {#if loading}<p class="batshit-settings-note">Loading ChatGPT connection…</p>{/if}
    {#if error}<div class="batshit-settings-note is-danger" role="alert">{error}</div>{/if}
    {#each accounts as account (account.id)}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0"><p class="truncate">{account.email || 'ChatGPT account'}</p><p class="batshit-settings-note">{account.state === 'ready' ? 'Connected' : account.state === 'identity-only' ? 'Signed in; plan use was not granted' : account.state === 'reconnect' ? 'Reconnect required' : 'Disconnected'}{account.revocationStatus === 'unconfirmed' ? ' · OpenAI revocation unconfirmed' : ''}</p></div>
        <div class="flex items-center gap-2">
          {#if account.state === 'disconnected' || account.state === 'reconnect'}<Button variant="outline" size="sm" disabled={busy || waiting} onclick={() => start(account.id)}>Continue with ChatGPT</Button>{/if}
          {#if account.state !== 'disconnected'}<Button variant="outline" size="sm" disabled={busy} onclick={() => disconnect(account.id)}>Disconnect</Button>{/if}
        </div>
      </div>
    {/each}
    <div class="flex flex-wrap items-center gap-3">
      {#if waiting}<p class="batshit-settings-note">Finish sign-in in your browser.</p>{#if authorizationUrl}<a class="batshit-settings-link" href={authorizationUrl} target="_blank" rel="noopener noreferrer">Open ChatGPT Sign-In</a>{/if}<Button variant="outline" size="sm" disabled={busy} onclick={cancel}>Cancel Sign-In</Button>
      {:else}<Button variant="outline" size="sm" disabled={busy || loading || !eligible} onclick={() => start()}>Continue with ChatGPT</Button>{/if}
      <a class="batshit-settings-link" href={CHATGPT_PLAN_USAGE_URL} target="_blank" rel="noopener noreferrer">Manage ChatGPT Usage</a>
      {#if error && !waiting}<Button variant="ghost" size="sm" disabled={busy} onclick={load}>Retry Status</Button>{/if}
    </div>
  </Card.Content>
</Card.Root>

<Dialog.Root bind:open={welcome}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>You’re using your ChatGPT plan</Dialog.Title>
      <Dialog.Description>Eligible AI requests in Batshit use your ChatGPT plan. Select ChatGPT Plan in Models, then choose that preset for an API agent. Review usage and app limits in ChatGPT settings.</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer class="gap-2">
      <a class="batshit-settings-link" href={CHATGPT_PLAN_USAGE_URL} target="_blank" rel="noopener noreferrer">Manage ChatGPT Usage</a>
      <Button variant="outline" onclick={() => welcome = false}>Got It</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
