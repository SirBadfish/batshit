<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Copy } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import CliRuntimeManagerCard from '$lib/components/settings/CliRuntimeManagerCard.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'
  import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_USAGE_URL, type ClaudePlanUnavailableCode } from '$lib/utils/claudePlanConnection'
  import { formatCliLoginHelp, formatCliLoginNote } from '$lib/utils/cliLoginHelp'

  type Code = ClaudePlanUnavailableCode
  type Status = { state: 'ready'; installed: boolean; version?: string }
    | { state: 'unavailable'; installed: boolean; code: Code; setupCommand?: string; setupContext?: 'docker' | 'native'; setupWorkingDirectory?: string }

  /** One plain sentence per status. Raw CLI text and paths stay in the server log. */
  const SENTENCES: Record<Code, string> = {
    not_installed: 'Claude Code is not installed yet. Install it below.',
    executable_unusable: 'Batshit cannot use this Claude Code: it is not the exact version Batshit was tested with, or it could not run. Install or update it below, then press Check Again.',
    signed_out: 'Claude Code is installed but not signed in. Sign in with the command below, then press Check Again.',
    not_plan: "Claude Code is set up to use an API key, a sign-in token or a cloud provider instead of a Claude plan. Remove that from Claude Code's settings, sign in with the command below, then press Check Again.",
    status_unreadable: "Claude Code's sign-in does not show a Claude plan, or Batshit could not read it. Sign in with your Claude plan using the command below, then press Check Again.",
    runtime_unavailable: 'Claude Code is ready, but this Batshit build cannot use the Claude plan yet.',
    disabled: 'Claude Code is turned off for this Batshit install.'
  }

  let status = $state<Status | null>(null)
  let loading = $state(true), error = $state(''), stale = $state(false)
  let disposed = false
  const SIGN_IN_CODES: Code[] = ['signed_out', 'not_plan', 'status_unreadable']
  const signIn = $derived(status?.state === 'unavailable' && SIGN_IN_CODES.includes(status.code) && status.setupCommand ? status : null)
  const sentence = $derived(!status ? '' : status.state === 'ready' ? `Ready${status.version ? `. Claude Code ${status.version}.` : '.'}` : SENTENCES[status.code])
  const loginNote = formatCliLoginNote({ id: CLAUDE_PLAN_CONNECTION_ID })

  /** Opening the card only reads. A user's Check Again looks again and tells mounted pickers to refresh (LS-007). */
  async function load(announce = false) {
    loading = true
    try {
      const response = await fetch(announce ? '/api/settings/claude-plan?fresh=1' : '/api/settings/claude-plan')
      const data = await response.json().catch(() => null)
      if (!response.ok || !data) throw new Error(data?.error || 'Claude plan status could not load.')
      if (disposed) return
      status = data; error = ''; stale = false
      if (announce) dispatchModelConnectionsUpdated('api-keys')
    } catch (failure) { if (!disposed) { error = failure instanceof Error ? failure.message : 'Claude plan status could not load.'; stale = status !== null } }
    finally { if (!disposed) loading = false }
  }
  async function copySignIn(command: string) {
    try { await copyTextToClipboard(command); toast.success('Claude Code login command copied') }
    catch { toast.error('Failed to copy the Claude Code login command') }
  }
  onMount(() => { void load() })
  onDestroy(() => { disposed = true })
</script>

<Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-l1-card" data-testid="claude-plan-connection">
  <Card.Header class="batshit-settings-l1-card-header">
    <div class="flex items-center gap-2">
      <IconRenderer ref={{ kind: 'brand', slug: 'claude-mono' }} iconClass="h-4 w-4" label="Claude" />
      <h4 class="batshit-settings-section-title">Claude Plan</h4>
      <SettingsInfoMenu ariaLabel="About Claude Plan" contentClass="w-80">
        <p>Use your own Claude Code, signed in with your Claude plan, as the model for Primary Agents, Subagents, Workers and Compact. Batshit runs every tool. Replies count against your Claude plan's usage limits; Anthropic API keys remain a separate paid connection.</p>
      </SettingsInfoMenu>
    </div>
  </Card.Header>
  <Card.Content class="batshit-settings-card-content-spacious space-y-3">
    {#if loading && !status}<p class="batshit-settings-note">Checking Claude Code…</p>{/if}
    {#if error}<div class="batshit-settings-note is-danger" role="alert">{error}</div>{/if}
    {#if status}
      <p class="batshit-settings-note" data-testid="claude-plan-status">{stale ? `Last known: ${sentence}` : sentence}</p>
      {#if status.state === 'unavailable' && status.code === 'disabled'}
        <p class="batshit-settings-caption">Setting: <code>BATSHIT_CLAUDE_PROVIDER_ENABLED=false</code></p>
      {/if}
    {/if}
    {#if status?.state !== 'unavailable' || status.code !== 'disabled'}
      <!-- Its own install/remove already tells mounted pickers (`runtime` source); this card only re-reads. -->
      <CliRuntimeManagerCard runtime="claude" onChanged={() => load()} />
    {/if}
    {#if signIn}
      <div class="batshit-settings-inline-alert is-dashed space-y-2">
        <p class="batshit-settings-form-meta">{formatCliLoginHelp(signIn.setupContext, signIn.setupWorkingDirectory)}</p>
        {#if signIn.setupContext === 'docker' && signIn.setupWorkingDirectory}
          <p class="batshit-settings-form-meta">Run from: <code class="break-all rounded px-1 py-0.5">{signIn.setupWorkingDirectory}</code></p>
        {/if}
        {#if loginNote}<p class="batshit-settings-form-meta is-warning">{loginNote}</p>{/if}
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded px-2 py-1 text-[11px]">{signIn.setupCommand}</code>
          <Button type="button" variant="ghost" size="icon" class="h-8 w-8 shrink-0" title="Copy Claude Code login command" aria-label="Copy Claude Code login command"
            onclick={() => copySignIn(signIn.setupCommand!)}>
            <Copy class="h-4 w-4" />
          </Button>
        </div>
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" disabled={loading} onclick={() => load(true)}>Check Again</Button>
      <Button variant="outline" size="sm" href={CLAUDE_PLAN_USAGE_URL} target="_blank" rel="noopener noreferrer">Check Claude Usage</Button>
    </div>
  </Card.Content>
</Card.Root>
