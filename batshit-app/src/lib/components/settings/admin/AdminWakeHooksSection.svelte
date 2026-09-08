<script lang="ts">
  import { Check, Copy, Loader2, Plus, RotateCw, Trash2, Webhook } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import * as Card from '$lib/components/ui/card'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { MAX_WAKE_WEBHOOK_CALLS_PER_HOUR } from '$lib/utils/dmControl'
  import type { WakeHookDeliveryMode, WakeHookSummary } from '$lib/types/wakeHook'

  /**
   * SA-113 P3 (DL-113-09) — the "Wake-up webhooks" list inside the Agent Wake-ups card.
   *
   * One hook = one URL + one token + one recipient agent. The token is shown ONCE, at
   * creation and after a rotate, because only its sha256 is stored.
   */

  interface EligibleAgent {
    id: string
    name: string
    dms_enabled: boolean
    wake_enabled: boolean
  }

  interface Props {
    disabled: boolean
  }

  let { disabled }: Props = $props()

  let hooks = $state<WakeHookSummary[]>([])
  let agents = $state<EligibleAgent[]>([])
  let loading = $state(true)
  let loadError = $state<string | null>(null)
  let busyHookId = $state<string | null>(null)

  let createOpen = $state(false)
  let creating = $state(false)
  let newName = $state('')
  let newAgentId = $state('')
  let newDeliver = $state<WakeHookDeliveryMode>('wake')

  let revealOpen = $state(false)
  let revealedToken = $state('')
  let revealedHook = $state<WakeHookSummary | null>(null)
  let copiedToken = $state(false)
  let copiedCurl = $state(false)

  const agentById = $derived(new Map(agents.map((agent) => [agent.id, agent])))
  // Only an agent with Agent DMs on can receive a webhook item: the DM lands in its inbox
  // and is closed with sys.dm.done, neither of which exists while that switch is off.
  const selectableAgents = $derived(agents.filter((agent) => agent.dms_enabled))

  /**
   * The address to paste into n8n.
   *
   * `localhost` is rewritten to `127.0.0.1` on purpose, the same rule Batshit's own n8n callback base applies
   * to `N8N_BATSHIT_FRONTEND_URL`: Node resolves `localhost` to IPv6 `::1` first and Batshit
   * listens on IPv4, so an n8n HTTP node pointed at `http://localhost:5620` fails with "the
   * service refused the connection" while Batshit is running perfectly. Handing the user a
   * URL that does not work in the tool this feature exists for would be a trap.
   */
  function hookUrl(hookId: string): string {
    const origin = typeof window === 'undefined' ? 'http://127.0.0.1:5620' : window.location.origin
    return `${origin.replace(/\/\/localhost(?=[:/]|$)/, '//127.0.0.1')}/api/wake/${hookId}`
  }

  function curlFor(hookId: string, token: string): string {
    return [
      `curl -X POST ${hookUrl(hookId)} \\`,
      `  -H "Authorization: Bearer ${token}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '{"message":"Say good morning and list today'"'"'s open DMs."}'`
    ].join('\n')
  }

  function formatDate(value: string | null | undefined): string {
    if (!value) return 'never'
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'never'
  }

  async function load() {
    loading = true
    loadError = null
    try {
      const response = await fetch('/api/wake-hooks')
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not load wake-up webhooks.')
      }
      hooks = payload.hooks ?? []
      agents = payload.agents ?? []
      if (!newAgentId) newAgentId = selectableAgents[0]?.id ?? ''
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Could not load wake-up webhooks.'
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  /**
   * Re-read whenever the user opens the Agent Wake-ups card.
   *
   * `SettingsAccordionCard` is a `<details>`, so this section mounts with the whole Admin
   * panel and its `$effect` runs once. But `dms_enabled` is edited in AGENT Settings and
   * read here to decide which agents a webhook may point at, so a list read on panel mount
   * goes stale the moment the user turns Agent DMs on in the other tab. Opening the card is
   * exactly when the answer has to be current.
   */
  function refreshOnOpen(node: HTMLElement) {
    const details = node.closest('details')
    if (!details) return
    const onToggle = () => {
      if (details.open) void load()
    }
    details.addEventListener('toggle', onToggle)
    return { destroy: () => details.removeEventListener('toggle', onToggle) }
  }

  async function createHook() {
    if (!newName.trim() || !newAgentId) return
    creating = true
    try {
      const response = await fetch('/api/wake-hooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          agentId: newAgentId,
          deliverDefault: newDeliver
        })
      })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not create the wake-up webhook.')
      }
      hooks = [payload.hook, ...hooks]
      revealedToken = payload.token
      revealedHook = payload.hook
      copiedToken = false
      copiedCurl = false
      createOpen = false
      revealOpen = true
      newName = ''
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the wake-up webhook.')
    } finally {
      creating = false
    }
  }

  async function patchHook(hook: WakeHookSummary, patch: Record<string, unknown>) {
    busyHookId = hook.id
    try {
      const response = await fetch(`/api/wake-hooks/${hook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not update the wake-up webhook.')
      }
      hooks = hooks.map((entry) => (entry.id === hook.id ? payload.hook : entry))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the wake-up webhook.')
    } finally {
      busyHookId = null
    }
  }

  async function rotateHook(hook: WakeHookSummary) {
    busyHookId = hook.id
    try {
      const response = await fetch(`/api/wake-hooks/${hook.id}/rotate`, { method: 'POST' })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not rotate the token.')
      }
      hooks = hooks.map((entry) => (entry.id === hook.id ? payload.hook : entry))
      revealedToken = payload.token
      revealedHook = payload.hook
      copiedToken = false
      copiedCurl = false
      revealOpen = true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not rotate the token.')
    } finally {
      busyHookId = null
    }
  }

  async function revokeHook(hook: WakeHookSummary) {
    if (
      !confirm(
        `Revoke "${hook.name}"? Its token stops working immediately and anything calling it will start failing.`
      )
    ) {
      return
    }
    busyHookId = hook.id
    try {
      const response = await fetch(`/api/wake-hooks/${hook.id}`, { method: 'DELETE' })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not revoke the wake-up webhook.')
      }
      hooks = hooks.filter((entry) => entry.id !== hook.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke the wake-up webhook.')
    } finally {
      busyHookId = null
    }
  }

  async function copyValue(value: string, mark: 'token' | 'curl' | 'url') {
    try {
      await copyTextToClipboard(value)
      if (mark === 'token') copiedToken = true
      if (mark === 'curl') copiedCurl = true
      if (mark === 'url') toast.success('Webhook URL copied.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not copy.')
    }
  }
</script>

<div class="batshit-settings-subsection" use:refreshOnOpen>
  <div class="batshit-settings-action-row">
    <div class="batshit-settings-form-label-line">
      <span class="batshit-settings-parent-label">Wake-up Webhooks</span>
      <SettingsInfoMenu ariaLabel="About Wake-up Webhooks" contentClass="w-80">
        <p>
          A webhook lets a program outside Batshit start a chat for one agent: a schedule, an n8n
          workflow, a Slack or Discord bridge, a finished build.
        </p>
        <p>
          Each webhook has its own address and its own password (a token). The token is shown once
          when you create it and is never stored, so copy it then. Revoke or rotate it any time.
        </p>
        <p>
          Each webhook may be called {MAX_WAKE_WEBHOOK_CALLS_PER_HOUR} times an hour. Wake-ups also stay
          inside the normal per-agent limits, and the master switch above turns all of them off.
        </p>
      </SettingsInfoMenu>
    </div>
    <Button
      type="button"
      variant="outline"
      size="sm"
      onclick={() => (createOpen = true)}
      disabled={disabled || loading || selectableAgents.length === 0}
    >
      <Plus class="size-4" aria-hidden="true" />
      New Webhook
    </Button>
  </div>

  {#if loading}
    <p class="batshit-settings-form-meta">
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      Loading webhooks...
    </p>
  {:else if loadError}
    <p class="batshit-settings-form-meta is-error">{loadError}</p>
  {:else if selectableAgents.length === 0}
    <p class="batshit-settings-form-help">
      No agent has Agent DMs turned on yet. A webhook writes a DM to one agent, so turn on Agent
      DMs for that agent in Agent Settings first.
    </p>
  {:else if hooks.length === 0}
    <p class="batshit-settings-form-help">
      No wake-up webhooks yet. Create one to let n8n, a schedule, or any other program start a chat
      for one of your agents.
    </p>
  {:else}
    <div class="batshit-settings-group">
      {#each hooks as hook (hook.id)}
        {@const agent = agentById.get(hook.agentId)}
        <Card.Root class="batshit-settings-display-card">
          <Card.Content class="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between">
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <Webhook class="size-4 shrink-0" aria-hidden="true" />
                <span class="batshit-settings-child-label truncate">{hook.name}</span>
                <Badge variant="outline">{agent?.name ?? hook.agentId}</Badge>
                <Badge variant="outline">
                  {hook.deliverDefault === 'wake' ? 'Starts a chat' : 'Waits in the inbox'}
                </Badge>
                {#if !hook.enabled}
                  <Badge variant="secondary">Paused</Badge>
                {/if}
                {#if agent && !agent.wake_enabled}
                  <Badge variant="secondary">Agent cannot be woken</Badge>
                {/if}
              </div>
              <div class="batshit-settings-form-meta">
                <code class="rounded">{hookUrl(hook.id)}</code>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onclick={() => copyValue(hookUrl(hook.id), 'url')}
                >
                  <Copy class="size-3" aria-hidden="true" />
                  Copy URL
                </Button>
              </div>
              <p class="batshit-settings-form-help">
                Token {hook.tokenPrefix}...{hook.tokenSuffix} · created {formatDate(hook.createdAt)} ·
                last used {formatDate(hook.lastUsedAt)} · {hook.useCount} call{hook.useCount === 1
                  ? ''
                  : 's'}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Switch.Root
                checked={hook.enabled}
                onCheckedChange={(checked) => patchHook(hook, { enabled: checked === true })}
                disabled={disabled || busyHookId === hook.id}
                aria-label={hook.enabled ? 'Pause this webhook' : 'Resume this webhook'}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onclick={() => rotateHook(hook)}
                disabled={disabled || busyHookId === hook.id}
                title="Issue a new token; the old one stops working"
              >
                {#if busyHookId === hook.id}
                  <Loader2 class="size-4 animate-spin" aria-hidden="true" />
                {:else}
                  <RotateCw class="size-4" aria-hidden="true" />
                {/if}
                Rotate
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onclick={() => revokeHook(hook)}
                disabled={disabled || busyHookId === hook.id}
                title="Revoke this webhook"
              >
                <Trash2 class="size-4" aria-hidden="true" />
                Revoke
              </Button>
            </div>
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  {/if}
</div>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>New Wake-up Webhook</Dialog.Title>
      <Dialog.Description>
        One address and one token that lets an outside program write to one agent.
      </Dialog.Description>
    </Dialog.Header>

    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="wake-hook-name">Name</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Input
            id="wake-hook-name"
            bind:value={newName}
            placeholder="Nightly build report"
            maxlength={80}
          />
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="wake-hook-agent">Agent</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root type="single" value={newAgentId} onValueChange={(v) => (newAgentId = v ?? '')}>
            <Select.Trigger id="wake-hook-agent" class="w-full">
              <span class="truncate">
                {agentById.get(newAgentId)?.name ?? 'Choose an agent'}
              </span>
            </Select.Trigger>
            <Select.Content>
              {#each selectableAgents as agent (agent.id)}
                <Select.Item value={agent.id}>{agent.name}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label" for="wake-hook-deliver">
              What a Call Does
            </Label.Root>
            <SettingsInfoMenu ariaLabel="About what a call does">
              <p>
                "Start a chat now" wakes the agent: Batshit opens a chat with the message as the
                first thing said, and the agent answers.
              </p>
              <p>
                "Leave it in the inbox" writes the message without starting anything. The agent sees
                it the next time it takes a turn.
              </p>
              <p>Each call can override this.</p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root
            type="single"
            value={newDeliver}
            onValueChange={(v) => (newDeliver = v === 'wait' ? 'wait' : 'wake')}
          >
            <Select.Trigger id="wake-hook-deliver" class="w-full">
              <span class="truncate">
                {newDeliver === 'wake' ? 'Start a chat now' : 'Leave it in the inbox'}
              </span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="wake">Start a chat now</Select.Item>
              <Select.Item value="wait">Leave it in the inbox</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
      <Button type="button" onclick={createHook} disabled={creating || !newName.trim() || !newAgentId}>
        {#if creating}
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        {/if}
        Create
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={revealOpen}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Copy this token now</Dialog.Title>
      <Dialog.Description>
        Batshit stores only a fingerprint of it, so this is the one time it can be shown. If you
        lose it, rotate the webhook for a new one.
      </Dialog.Description>
    </Dialog.Header>

    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-group">
        <span class="batshit-settings-form-label">Token</span>
        <code class="block break-all rounded p-2">{revealedToken}</code>
      </div>
      {#if revealedHook}
        <div class="batshit-settings-form-group">
          <span class="batshit-settings-form-label">Try it</span>
          <pre class="overflow-x-auto rounded p-2 text-xs"><code
            >{curlFor(revealedHook.id, revealedToken)}</code
          ></pre>
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={() => copyValue(revealedToken, 'token')}>
        {#if copiedToken}
          <Check class="size-4" aria-hidden="true" />
          Copied
        {:else}
          <Copy class="size-4" aria-hidden="true" />
          Copy token
        {/if}
      </Button>
      {#if revealedHook}
        <Button
          type="button"
          variant="outline"
          onclick={() => copyValue(curlFor(revealedHook!.id, revealedToken), 'curl')}
        >
          {#if copiedCurl}
            <Check class="size-4" aria-hidden="true" />
            Copied
          {:else}
            <Copy class="size-4" aria-hidden="true" />
            Copy the example
          {/if}
        </Button>
      {/if}
      <Button type="button" onclick={() => (revealOpen = false)}>Done</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
