<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { Bot, CheckCircle2, Circle, ExternalLink, KeyRound, Loader2, MessageCircle, RefreshCcw, Settings, Sparkles } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import * as agentStore from '$lib/stores/agents.svelte'
  import * as savedModelsStore from '$lib/stores/savedModels.svelte'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'

  type SetupStepId = 'api-keys' | 'models' | 'agents'

  type OnboardingStatus = {
    apiKeys: {
      readyCount: number
      readyKeys: Array<{ id: string; label: string; source: string }>
    }
    modelPresets: {
      count: number
    }
    agents: {
      count: number
    }
    onboarding: {
      completedAt: string | null
      skippedAt: string | null
      finished: boolean
      shouldShow: boolean
    }
  }

  const { data = null } = $props<{ data?: any }>()

  let status = $state<OnboardingStatus | null>(null)
  let loading = $state(true)
  let refreshBusy = $state(false)
  let finishBusy = $state(false)
  let hidden = $state(false)
  let wizardActivated = $state(false)
  let statusError = $state<string | null>(null)

  const agents = $derived(agentStore.getAgents())
  const savedModels = $derived(savedModelsStore.getSavedModels())
  const apiKeyCount = $derived(status?.apiKeys.readyCount ?? 0)
  const modelCount = $derived(Math.max(status?.modelPresets.count ?? 0, savedModels.length))
  const agentCount = $derived(Math.max(status?.agents.count ?? 0, agents.length))
  const apiKeysComplete = $derived(apiKeyCount > 0)
  const modelsComplete = $derived(modelCount > 0)
  const agentsComplete = $derived(agentCount > 0)
  const setupComplete = $derived(apiKeysComplete && modelsComplete && agentsComplete)
  const finished = $derived(Boolean(status?.onboarding.finished))
  const shouldRender = $derived(wizardActivated && !hidden && !finished)
  const activeStep = $derived.by<SetupStepId>(() => {
    if (!apiKeysComplete) return 'api-keys'
    if (!modelsComplete) return 'models'
    return 'agents'
  })

  const steps = $derived.by(() => [
    {
      id: 'api-keys' as const,
      label: 'API Keys',
      title: 'Connect at least one provider',
      body:
        'Add an API key for a provider of your choice, or a few if you wish. You can add more later anytime.',
      complete: apiKeysComplete,
      countLabel:
        apiKeyCount === 0
          ? 'None connected'
          : `${apiKeyCount} connected`,
      actionLabel: 'Open API Keys',
      icon: KeyRound
    },
    {
      id: 'models' as const,
      label: 'Model Presets',
      title: 'Create one chat Model Preset',
      body:
        'A Model Preset tells Batshit which provider connection and model to use. You can create as many more Model Presets as you want later.',
      complete: modelsComplete,
      countLabel:
        modelCount === 0
          ? 'None created'
          : `${modelCount} created`,
      actionLabel: 'Open Model Presets',
      icon: Sparkles
    },
    {
      id: 'agents' as const,
      label: 'First Agent',
      title: 'Create your first Primary Agent',
      body:
        'Pick the Model Preset you just made and create a starter agent. This first agent is not permanent; rename, edit, or delete it later.',
      complete: agentsComplete,
      countLabel:
        agentCount === 0
          ? 'None created'
          : `${agentCount} created`,
      actionLabel: 'Open Agents',
      icon: Bot
    }
  ])

  async function loadStatus(options: { quiet?: boolean } = {}) {
    if (options.quiet) {
      refreshBusy = true
    } else {
      loading = true
    }
    statusError = null

    try {
      const response = await fetch('/api/onboarding/status')
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load setup status')
      }
      status = payload as OnboardingStatus
      if (status.onboarding.shouldShow) {
        wizardActivated = true
      }
    } catch (error) {
      console.error('[FirstRunSetupWizard] Failed to load setup status:', error)
      statusError = error instanceof Error ? error.message : 'Failed to load setup status'
    } finally {
      loading = false
      refreshBusy = false
    }
  }

  function openSettings(stepId: SetupStepId) {
    const detail =
      stepId === 'api-keys'
        ? { tab: 'api-keys' }
        : stepId === 'models'
          ? { tab: 'models', modelId: '__create__' }
          : { tab: 'agents', agentId: '__create__' }

    window.dispatchEvent(new CustomEvent('batshit:open-settings', { detail }))
  }

  async function markOnboarding(action: 'complete' | 'skip') {
    finishBusy = true
    try {
      const response = await fetch('/api/onboarding/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to update setup status')
      }

      if (payload?.settings) {
        setUserSettings(payload.settings)
      }
      if (payload?.status) {
        status = payload.status
      }
      hidden = true
      window.dispatchEvent(new CustomEvent('batshit:onboarding-finished', { detail: { action } }))
      toast.success(action === 'complete' ? 'Setup complete' : 'Setup skipped for now')
    } catch (error) {
      console.error('[FirstRunSetupWizard] Failed to update setup status:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to update setup status')
    } finally {
      finishBusy = false
    }
  }

  onMount(() => {
    if (data?.user?.id) {
      void Promise.allSettled([
        agentStore.loadAgents(data.user.id),
        savedModelsStore.loadSavedModels()
      ])
    }

    void loadStatus()

    const refresh = () => {
      void loadStatus({ quiet: true })
    }

    window.addEventListener('focus', refresh)
    window.addEventListener('batshit:onboarding-refresh', refresh)
    window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, refresh)

    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('batshit:onboarding-refresh', refresh)
      window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, refresh)
    }
  })
</script>

{#if shouldRender}
  <section class="first-run-setup" aria-labelledby="first-run-setup-title">
    <div class="first-run-shell">
      <div class="first-run-header">
        <div>
          <div class="first-run-badge">
            <Badge variant="outline">First-time setup</Badge>
          </div>
          <h1 id="first-run-setup-title">Quickstart setup wizard to show you the ropes</h1>
          <p>
            Each step will take you into the settings panel. Click "Close" to come back here after each step.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onclick={() => loadStatus({ quiet: true })}
          disabled={loading || refreshBusy}
        >
          {#if refreshBusy}
            <Loader2 class="first-run-button-icon animate-spin" />
          {:else}
            <RefreshCcw class="first-run-button-icon" />
          {/if}
          Check progress
        </Button>
      </div>

      {#if statusError}
        <div class="first-run-error">
          {statusError}
        </div>
      {/if}

      {#if setupComplete}
        <div class="first-run-complete" aria-live="polite">
          <div class="first-run-complete-icon">
            <CheckCircle2 />
          </div>
          <div>
            <h2>Good shit, well done.</h2>
            <p>
              Now, send a message to make sure you're wired. Then, go to Settings &gt; Agents to play with your agent settings.
            </p>
            <p>
              Just a heads up, Batshit isn't like every frontend you've used before. You won't know how to use everything without learning a few things. Check out
              <a href="https://docs.batshit.ai" target="_blank" rel="noopener noreferrer">
                https://docs.batshit.ai
                <ExternalLink aria-hidden="true" />
              </a>
              to learn the basics.
            </p>
          </div>
        </div>

        <div class="first-run-footer">
          <p>
            You're ready to send the first message.
          </p>
          <div class="first-run-actions">
            <Button
              onclick={() => markOnboarding('complete')}
              disabled={finishBusy}
            >
              {#if finishBusy}
                <Loader2 class="first-run-button-icon animate-spin" />
              {:else}
                <MessageCircle class="first-run-button-icon" />
              {/if}
              Close / Start chat
            </Button>
          </div>
        </div>
      {:else}
        <div class="first-run-grid" aria-busy={loading}>
          {#each steps as step}
            {@const StepIcon = step.icon}
            <article class:active={activeStep === step.id && !step.complete} class:complete={step.complete}>
              <div class="first-run-step-topline">
                <div class="first-run-step-index">
                  {#if step.complete}
                    <CheckCircle2 />
                  {:else}
                    <Circle />
                  {/if}
                </div>
                <span>{step.label}</span>
                <Badge variant={step.complete ? 'default' : 'outline'}>{step.countLabel}</Badge>
              </div>

              <div class="first-run-step-icon">
                <StepIcon />
              </div>

              <h2>{step.title}</h2>
              <p>{step.body}</p>

              {#if step.id === 'api-keys' && status?.apiKeys.readyKeys.length}
                <div class="first-run-key-list" aria-label="Connected AI provider keys">
                  {#each status.apiKeys.readyKeys.slice(0, 4) as key}
                    <span>{key.label}</span>
                  {/each}
                </div>
              {/if}

              <Button
                variant={activeStep === step.id && !step.complete ? 'default' : 'outline'}
                onclick={() => openSettings(step.id)}
              >
                <Settings class="first-run-button-icon" />
                {step.actionLabel}
              </Button>
            </article>
          {/each}
        </div>

        <div class="first-run-footer">
          <p>
            Add one key, one Model Preset, and one agent now. Add more keys, Model Presets, and agents later from Settings.
          </p>
          <div class="first-run-actions">
            <Button
              variant="ghost"
              onclick={() => markOnboarding('skip')}
              disabled={finishBusy}
            >
              STFU, skip this
            </Button>
          </div>
        </div>
      {/if}
    </div>
  </section>
{/if}

<style>
  .first-run-setup {
    position: absolute;
    inset: 0;
    z-index: calc(var(--z-overlay) - 1);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 2rem;
    background:
      linear-gradient(180deg, color-mix(in oklab, var(--background) 92%, transparent), var(--background)),
      var(--background);
  }

  .first-run-shell {
    width: min(1120px, 100%);
    border: 1px solid var(--bs-app-shell-line);
    border-radius: 8px;
    background: var(--bs-app-surface);
    box-shadow: 0 24px 60px oklch(0 0 0 / 0.34);
  }

  .first-run-header,
  .first-run-footer {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.25rem;
    padding: 1.25rem;
  }

  .first-run-header {
    border-bottom: 1px solid var(--bs-app-shell-line);
  }

  .first-run-footer {
    align-items: center;
    border-top: 1px solid var(--bs-app-shell-line);
  }

  .first-run-badge {
    margin-bottom: 0.75rem;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    color: var(--bs-app-title);
    font-size: 1.5rem;
    font-weight: 650;
    line-height: 1.2;
  }

  h2 {
    color: var(--bs-app-title);
    font-size: 1rem;
    font-weight: 650;
    line-height: 1.3;
  }

  p {
    color: var(--bs-app-muted-text);
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .first-run-header p {
    margin-top: 0.5rem;
    max-width: 44rem;
  }

  .first-run-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0;
  }

  .first-run-complete {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 1rem;
    padding: 1.5rem 1.25rem 1.75rem;
  }

  .first-run-complete-icon {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    place-items: center;
    border: 1px solid color-mix(in oklab, var(--bs-app-success, #22c55e) 42%, var(--bs-app-shell-line));
    border-radius: 8px;
    color: var(--bs-app-success, #22c55e);
    background: color-mix(in oklab, var(--bs-app-success, #22c55e) 10%, var(--bs-app-surface));
  }

  .first-run-complete-icon :global(svg) {
    width: 1.35rem;
    height: 1.35rem;
  }

  .first-run-complete h2 {
    font-size: 1.25rem;
  }

  .first-run-complete p {
    max-width: 52rem;
    margin-top: 0.75rem;
  }

  .first-run-complete a {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--bs-app-primary);
    font-weight: 650;
    text-decoration: none;
  }

  .first-run-complete a:hover {
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }

  .first-run-complete a :global(svg) {
    width: 0.875rem;
    height: 0.875rem;
  }

  article {
    display: flex;
    min-height: 22rem;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    border-right: 1px solid var(--bs-app-shell-line);
  }

  article:last-child {
    border-right: 0;
  }

  article.active {
    background: color-mix(in oklab, var(--bs-app-primary) 8%, transparent);
  }

  article.complete {
    background: color-mix(in oklab, var(--bs-app-success, #22c55e) 6%, transparent);
  }

  .first-run-step-topline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
    font-weight: 650;
    text-transform: uppercase;
  }

  .first-run-step-topline :global(.badge),
  .first-run-step-topline :global([data-slot='badge']) {
    margin-left: auto;
    text-transform: none;
  }

  .first-run-step-index,
  .first-run-step-index :global(svg),
  :global(.first-run-button-icon) {
    width: 1rem;
    height: 1rem;
    flex: 0 0 auto;
  }

  .first-run-step-icon {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border: 1px solid var(--bs-app-shell-line);
    border-radius: 8px;
    color: var(--bs-app-primary);
    background: var(--bs-app-inset-surface);
  }

  .first-run-step-icon :global(svg) {
    width: 1.1rem;
    height: 1.1rem;
  }

  .first-run-key-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    min-height: 1.75rem;
  }

  .first-run-key-list span {
    border: 1px solid var(--bs-app-shell-line);
    border-radius: 999px;
    padding: 0.2rem 0.5rem;
    color: var(--bs-app-text);
    font-size: 0.75rem;
    background: var(--bs-app-inset-surface);
  }

  article :global(button) {
    margin-top: auto;
    width: 100%;
  }

  .first-run-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 0 0 auto;
  }

  .first-run-error {
    margin: 1rem 1.25rem 0;
    border: 1px solid color-mix(in oklab, var(--destructive) 45%, transparent);
    border-radius: 8px;
    padding: 0.75rem;
    color: var(--destructive);
    background: color-mix(in oklab, var(--destructive) 10%, transparent);
    font-size: 0.875rem;
  }

  @media (max-width: 900px) {
    .first-run-setup {
      align-items: flex-start;
      padding: 1rem;
    }

    .first-run-header,
    .first-run-footer,
    .first-run-actions,
    .first-run-complete {
      flex-direction: column;
      align-items: stretch;
    }

    .first-run-grid {
      grid-template-columns: 1fr;
    }

    .first-run-complete {
      display: flex;
    }

    article {
      min-height: 0;
      border-right: 0;
      border-bottom: 1px solid var(--bs-app-shell-line);
    }

    article:last-child {
      border-bottom: 0;
    }
  }
</style>
