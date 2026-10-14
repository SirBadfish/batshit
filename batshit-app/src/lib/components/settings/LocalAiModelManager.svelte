<script lang="ts">
  /**
   * Native capability-gated model residency controls through Batshit.
   *
   * Unlike OllamaModelManager and DmrModelManager, this talks to Batshit's own
   * server route rather than to the program directly (DL-124-12): a local
   * program may carry an encrypted API key the browser must never see, and
   * Docker loopback rewriting lives server-side.
   */
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Input } from '$lib/components/ui/input'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Button } from '$lib/components/ui/button'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { RefreshCw, AlertCircle, Play, Square, RotateCcw } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { LIVE_SETTINGS_EVENTS, dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'

  type ManagedModel = {
    id: string
    label: string
    loaded: boolean
    busy?: boolean
    sleeping?: boolean
    unloaded?: boolean
    failure?: string
    sizeBytes?: number | null
    contextLength?: number | null
    format?: string | null
    path?: string | null
  }
  type RunningSnapshot = {
    model: string | null
    contextLength: number | null
    chatTemplates: boolean | null
    guidance: boolean | null
  }
  type ManagementState = {
    programId: string
    connectionKey?: string
    label: string
    manageable: boolean
    reason?: string
    canLoad: boolean
    canUnload: boolean
    canUnloadCurrent?: boolean
    canDownload: boolean
    restartsOnSwitch: boolean
    models: ManagedModel[]
    settingsFiles?: string[]
    running?: RunningSnapshot
    canRestoreStartup?: boolean
    canApplyProfile?: boolean
    requiresVerifiedProfile?: boolean
    registeredSetup?: { registrationId: string; models: { id: string; nativeRef: string; servedName: string; baseConfig: string }[] }
    managedContextActive?: boolean
    managedContextReason?: string
  }

  let { programId, enabled = true, connectionReady = true, onAvailabilityChange }: { programId: string; enabled?: boolean; connectionReady?: boolean; onAvailabilityChange?: () => void } = $props()

  /** KoboldCpp's own control word for "the model and settings it started with". */
  const STARTUP_MODEL = 'initial_model'
  const CURRENT_MODEL = 'unload_model'
  /** Select items cannot carry an empty value, so "no settings file" gets a name. */
  const NO_SETTINGS_FILE = '__koboldcpp_defaults__'
  /** A big model takes far longer than the 4 s measured on a small one. */
  const RESTART_POLL_MS = 2000
  const RESTART_GIVE_UP_MS = 180_000

  let management = $state<ManagementState | null>(null)
  let isLoading = $state(false)
  let busyModelId = $state<string | null>(null)
  let waitingForRestart = $state(false)
  /**
   * BL-101: the saved-settings file a `.gguf` starts from. Not saved anywhere,
   * the same as KoboldCpp's own Lite UI: it is a choice made at the moment of
   * switching, and an empty choice means KoboldCpp's defaults.
   */
  let baseConfig = $state('')
  let contextModel = $state('')
  let contextTokens = $state('')
  let profile = $state('')
  let expectedModel = $state('')
  let expectedContext = $state('')
  let quiescenceConfirmed = $state(false)
  let profileNotice = $state<string | null>(null)
  let profileApplying = $state(false)
  const fieldId = $props.id()
  let alive = true
  let requestRevision = 0
  let refreshQueued = false
  let modelError = $state<string | null>(null)
  let lastScope: { programId: string; enabled: boolean; connectionReady: boolean } | null = null

  function flushQueuedRefresh() {
    if (alive && refreshQueued && enabled && connectionReady && !isLoading && busyModelId === null && !waitingForRestart) {
      refreshQueued = false
      void refresh()
    }
  }

  function invalidateModels() {
    if (profileApplying) profileNotice = 'The previous connection changed while its profile action was running. Its outcome is unverified here. Check that KoboldCpp instance before another action.'
    requestRevision += 1
    management = null
    modelError = null
    profile = ''
    contextModel = ''
    contextTokens = ''
    expectedModel = ''
    expectedContext = ''
    quiescenceConfirmed = false
    refreshQueued = true
    flushQueuedRefresh()
  }

  $effect(() => {
    const scope = { programId, enabled, connectionReady }
    untrack(() => {
      const prior = lastScope
      lastScope = scope
      if (prior && (prior.programId !== scope.programId || prior.enabled !== scope.enabled || prior.connectionReady !== scope.connectionReady)) invalidateModels()
    })
  })

  function assertCurrentScope(scope: { programId: string; revision: number }) {
    if (!alive || !enabled || !connectionReady || programId !== scope.programId || requestRevision !== scope.revision) {
      throw new Error('The connection changed before the program confirmed the model state. Refresh the saved connection.')
    }
  }

  const settingsFiles = $derived(management?.settingsFiles ?? null)
  // A file that vanished from the folder since it was picked is no longer a
  // choice; the server would refuse it anyway.
  const chosenSettingsFile = $derived(
    baseConfig && settingsFiles?.includes(baseConfig) ? baseConfig : ''
  )
  const selectedProfile = $derived(profile && settingsFiles?.includes(profile) ? profile : '')
  const validExpectedContext = $derived(Number.isSafeInteger(Number(expectedContext)) && Number(expectedContext) >= 256 && Number(expectedContext) <= 524288)
  const canApply = $derived(management?.canApplyProfile && selectedProfile && expectedModel.trim().length > 0 && expectedModel.trim().length <= 512 && validExpectedContext && quiescenceConfirmed && enabled && connectionReady && !isLoading && busyModelId === null && !waitingForRestart)
  const registeredModels = $derived(management?.registeredSetup?.models.filter(m => management?.models.some(native => native.id === m.nativeRef && native.format === 'gguf') && settingsFiles?.includes(m.baseConfig)) ?? [])
  const selectedContextModel = $derived(registeredModels.find(m => m.id === contextModel))
  const validContextTokens = $derived(/^[0-9]+$/.test(contextTokens) && Number.isSafeInteger(Number(contextTokens)) && Number(contextTokens) >= 256 && Number(contextTokens) <= 524288)
  const canApplyContext = $derived(management?.managedContextActive && management.canApplyProfile && selectedContextModel && validContextTokens && quiescenceConfirmed && enabled && connectionReady && !isLoading && busyModelId === null && !waitingForRestart)
  const hasModelFiles = $derived(management?.models.some((model) => model.format === 'gguf') ?? false)

  onMount(() => {
    const handleConnectionsUpdated = () => invalidateModels()
    void refresh()
    window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, handleConnectionsUpdated)
    return () => window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, handleConnectionsUpdated)
  })
  onDestroy(() => {
    alive = false
  })

  async function readState(targetProgramId = programId): Promise<{ success: boolean; state?: ManagementState; error?: string }> {
    const response = await fetch(
      `/api/settings/local-ai/models?program=${encodeURIComponent(targetProgramId)}`
    )
    return await response.json()
  }

  /**
   * KoboldCpp restarts itself to switch models. Measured at 4 to 8 seconds for
   * 3B and 9B models, and a bigger one takes longer, so ask until it answers
   * instead of guessing a delay and then reporting it as unreachable.
   */
  async function waitForRestart(scope: { programId: string; revision: number }) {
    waitingForRestart = true
    const giveUpAt = Date.now() + RESTART_GIVE_UP_MS
    try {
      // Give it a moment to go down first, or the old server answers the poll.
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS))
      while (alive && Date.now() < giveUpAt) {
        try {
          const payload = await readState(scope.programId)
          assertCurrentScope(scope)
          if (payload?.success && payload.state?.manageable) {
            management = payload.state
            return
          }
        } catch {
          assertCurrentScope(scope)
          // Still restarting.
        }
        await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS))
      }
      if (alive) throw new Error('The program has not confirmed its restart yet. Refresh to check it.')
    } finally {
      waitingForRestart = false
    }
  }

  async function refresh() {
    if (!alive) return
    if (!enabled || !connectionReady || isLoading || busyModelId !== null || waitingForRestart) {
      refreshQueued = true
      return
    }
    const scope = { programId, revision: requestRevision }
    isLoading = true
    modelError = null
    try {
      const payload = await readState(scope.programId)
      if (!alive || !enabled || !connectionReady || programId !== scope.programId || requestRevision !== scope.revision) return
      if (!payload?.success || !payload.state) throw new Error(payload?.error ?? 'Could not read models')
      management = payload.state
      onAvailabilityChange?.()
    } catch (error) {
      if (alive && requestRevision === scope.revision && programId === scope.programId && enabled && connectionReady) {
        management = null
        modelError = `${error instanceof Error ? error.message : 'Could not read models'}. Refresh to try again.`
      }
    } finally {
      isLoading = false
      flushQueuedRefresh()
    }
  }

  async function waitForResidency(action: 'load' | 'unload', modelId: string, expectedConnectionKey: string, scope: { programId: string; revision: number }) {
    const giveUpAt = Date.now() + RESTART_GIVE_UP_MS
    while (alive && Date.now() < giveUpAt) {
      const payload = await readState(scope.programId)
      assertCurrentScope(scope)
      if (payload.success && payload.state?.manageable) {
        if (payload.state.connectionKey !== expectedConnectionKey) {
          throw new Error('The connection changed before the program confirmed the model state.')
        }
        management = payload.state
        const model = management.models.find((entry) => entry.id === modelId)
        if (action === 'load' && model?.failure) throw new Error(model.failure)
        if (action === 'load' && model?.sleeping) throw new Error('The model is sleeping with its memory released. A new chat request wakes it automatically.')
        const confirmedUnloaded = !model || (scope.programId === 'llama-cpp'
          ? model.unloaded === true
          : !model.loaded && !model.sleeping && !model.busy)
        if (action === 'unload' ? confirmedUnloaded : model?.loaded) return
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS))
    }
    if (alive) throw new Error('The program has not confirmed the model state yet. Refresh to check it.')
  }

  async function act(action: 'load' | 'unload', model: { id: string; format?: string | null }) {
    if (!enabled || !connectionReady || !management?.connectionKey) {
      toast.error('Refresh the saved connection before using model controls.')
      return
    }
    const scope = { programId, revision: requestRevision }
    const expectedConnectionKey = management.connectionKey
    modelError = null
    busyModelId = model.id
    // BL-101: only a bare model file needs a base. A settings file carries its
    // own, and the startup model goes back to exactly what KoboldCpp began with.
    const base = action === 'load' && model.format === 'gguf' ? chosenSettingsFile : ''
    try {
      const response = await fetch('/api/settings/local-ai/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          program: programId,
          action,
          modelId: model.id,
          expectedConnectionKey,
          ...(base ? { baseConfig: base } : {})
        })
      })
      const payload = await response.json()
      assertCurrentScope(scope)
      if (payload?.success) {
        toast.success(payload.message ?? 'Done')
        if (payload.restarted) await waitForRestart(scope)
        else if (payload.pending) await waitForResidency(action, model.id, expectedConnectionKey, scope)
        else await refresh()
        // BL-134: the program now serves another model (and KoboldCpp maybe
        // another size), so open Models tabs and model pickers reload what
        // /api/models says about it.
        assertCurrentScope(scope)
        dispatchModelConnectionsUpdated('local-ai')
      } else {
        modelError = payload?.message ?? payload?.error ?? 'That did not work. Refresh and try again.'
        toast.error(modelError ?? 'That did not work.')
      }
    } catch (error) {
      if (alive) {
        modelError = error instanceof Error ? error.message : 'That did not work. Refresh and try again.'
        toast.error(modelError)
      }
    } finally {
      busyModelId = null
      flushQueuedRefresh()
    }
  }

  async function enableContextEditing() {
    if (!management?.registeredSetup || !management.connectionKey || busyModelId !== null || !connectionReady || !enabled) return
    const scope = { programId, revision: requestRevision }
    busyModelId = 'registration'
    try {
      const response = await fetch('/api/settings/local-ai/models', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ program: 'koboldcpp', action: 'enable-managed-context', registrationId: management.registeredSetup.registrationId, expectedConnectionKey: management.connectionKey })
      })
      const answer = await response.json()
      assertCurrentScope(scope)
      if (!answer.success) throw new Error(answer.message ?? answer.error ?? 'Could not enable local context editing.')
    } catch (error) {
      if (alive) profileNotice = error instanceof Error ? error.message : 'Could not enable local context editing.'
    } finally {
      busyModelId = null
      dispatchModelConnectionsUpdated('local-ai')
      flushQueuedRefresh()
    }
  }

  async function applyProfile(managedContext = false) {
    if (!(managedContext ? canApplyContext : canApply) || !management?.connectionKey || !management.running?.model || !management.running.contextLength) return
    const scope = { programId, revision: requestRevision }
    const expectation = {
      expectedConnectionKey: management.connectionKey,
      observedModel: management.running.model,
      observedContext: management.running.contextLength,
      expectedModel: expectedModel.trim(),
      expectedContext: Number(expectedContext),
      quiescenceConfirmed
    }
    const selected = managedContext ? selectedContextModel!.id : selectedProfile
    const intent = managedContext ? {
      expectedConnectionKey: management.connectionKey, observedModel: management.running.model,
      observedContext: management.running.contextLength, quiescenceConfirmed,
      registrationId: management.registeredSetup!.registrationId, modelId: selected,
      contextTokens: Number(contextTokens)
    } : undefined
    profileApplying = true
    busyModelId = selected
    profileNotice = null
    quiescenceConfirmed = false
    try {
      const response = await fetch('/api/settings/local-ai/models', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(managedContext ? { program: scope.programId, action: 'apply-context', intent } : { program: scope.programId, action: 'apply-profile', modelId: selected, expectation })
      })
      const payload = await response.json()
      assertCurrentScope(scope)
      profileNotice = payload?.message ?? payload?.error ?? 'The profile action has no verified result. Check KoboldCpp before another action; do not retry automatically.'
      if (payload?.success) toast.success(profileNotice ?? 'Profile verified.')
      else toast.error(profileNotice ?? 'Profile could not be verified.')
      // A mismatch or uncertain answer can still follow a real native restart.
      // Refresh consumers after every dispatched attempt; this is not acceptance.
    } catch (error) {
      if (alive && requestRevision === scope.revision && programId === scope.programId && enabled && connectionReady) {
        profileNotice = 'The profile action lost its answer. KoboldCpp may have changed. Refresh its state before another action; do not retry automatically.'
        toast.error(profileNotice)
      }
    } finally {
      profileApplying = false
      // The dispatched request can change the previous instance even after
      // this view becomes obsolete. Every consumer must invalidate its catalog.
      dispatchModelConnectionsUpdated('local-ai')
      busyModelId = null
      flushQueuedRefresh()
    }
  }

  /** BL-101: what KoboldCpp says it is running, so a reset is never silent. */
  function describeRunning(running: RunningSnapshot) {
    const parts: string[] = []
    if (running.model) {
      parts.push(
        running.contextLength
          ? `Running ${running.model} at ${running.contextLength.toLocaleString()} tokens.`
          : `Running ${running.model}.`
      )
    } else {
      parts.push('No model loaded.')
    }
    const switches: string[] = []
    if (running.chatTemplates !== null) {
      switches.push(`chat templates ${running.chatTemplates ? 'on' : 'off'}`)
    }
    if (running.guidance !== null) switches.push(`guidance ${running.guidance ? 'on' : 'off'}`)
    if (switches.length) {
      const text = switches.join(', ')
      parts.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`)
    }
    if (running.contextLength) {
      parts.push('To increase the loaded ceiling, apply a saved KoboldCpp settings file with a larger Context Size, or restart it in its launcher. Changing a Batshit preset does not enlarge it.')
    }
    return parts.join(' ')
  }

  function formatSize(bytes?: number | null) {
    if (typeof bytes !== 'number' || bytes <= 0) return null
    const gb = bytes / 1024 ** 3
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
  }
</script>

<div class="batshit-settings-card-content-spacious space-y-4">
  <div class="flex items-center justify-between">
    <span class="batshit-settings-form-label">
      {management?.models.length ? `${management.models.length} available` : ''}
    </span>
    <div class="flex items-center gap-1">
      {#if management?.canUnloadCurrent && !management.models.some(model => model.loaded) && enabled && connectionReady}
        <Button variant="outline" size="sm" title="Unload the model this KoboldCpp server is currently serving for every connected app" disabled={busyModelId !== null || waitingForRestart} onclick={() => act('unload', { id: CURRENT_MODEL })}>
          <Square />
          {busyModelId === CURRENT_MODEL ? 'Working' : 'Unload Current Model'}
        </Button>
      {/if}
      {#if management?.canRestoreStartup && enabled && connectionReady}
        <Button
          variant="outline"
          size="sm"
          title="Go back to the model and settings it was started with"
          disabled={busyModelId !== null || waitingForRestart}
          onclick={() => act('load', { id: STARTUP_MODEL })}
        >
          <RotateCcw />
          {busyModelId === STARTUP_MODEL ? 'Working' : 'Restore Startup Model'}
        </Button>
      {/if}
      <Button
        variant="outline"
        size="icon"
        onclick={refresh}
        disabled={isLoading || !enabled || !connectionReady || waitingForRestart}
      >
        <RefreshCw class={isLoading ? 'animate-spin' : ''} />
      </Button>
    </div>
  </div>

  {#if profileNotice && enabled && connectionReady}
    <div class="batshit-settings-inline-alert is-warning" role="status">{profileNotice}</div>
  {/if}

  {#if modelError && enabled && connectionReady}
    <div class="batshit-settings-inline-alert is-warning flex items-start gap-2" role="alert">
      <AlertCircle class="h-4 w-4 shrink-0" />
      <span class="batshit-settings-form-label">{modelError}</span>
      <Button variant="outline" size="sm" onclick={refresh} disabled={isLoading || busyModelId !== null || waitingForRestart}>Retry</Button>
    </div>
  {/if}

  {#if !connectionReady}
    <p class="batshit-settings-caption">Save the connection before using model controls.</p>
  {:else if !enabled}
    <div class="batshit-settings-inline-alert is-warning flex items-center gap-2">
      <AlertCircle class="h-4 w-4" />
      <span class="batshit-settings-form-label">
        Turn this program on above to manage its models.
      </span>
    </div>
  {:else if isLoading && !management}
    <p class="batshit-settings-caption">Checking.</p>
  {:else if management && !management.manageable}
    {#if management.running}
      <p class="batshit-settings-caption">{describeRunning(management.running)}</p>
    {/if}
    {#if programId === 'koboldcpp' && management.running?.model}
      <p class="batshit-settings-caption">
        The loaded model is available for chat. Admin mode is optional and only needed to switch models here.
      </p>
    {/if}
    <div class="batshit-settings-inline-alert is-warning flex items-start gap-2">
      <AlertCircle class="h-4 w-4 shrink-0" />
      <span class="batshit-settings-form-label">{management.reason}</span>
    </div>
  {:else if management}
    {#if waitingForRestart}
      <p class="batshit-settings-caption">Waiting for {management.label} to come back.</p>
    {:else if management.restartsOnSwitch}
      <p class="batshit-settings-caption">
        Switching models restarts {management.label}, so it goes quiet for a few seconds.
      </p>
    {/if}

    {#if management.running && !waitingForRestart}
      <p class="batshit-settings-caption">{describeRunning(management.running)}</p>
    {/if}

    {#if programId === 'koboldcpp'}
      <p class="batshit-settings-caption">
        Use a unique local admin password. KoboldCpp startup output can print it, and Save Config can write it in plain text. Do not share unredacted output or save a config after entering the password. Batshit stores its copy encrypted.
      </p>
      {#if management.managedContextActive && management.canApplyProfile}
        <div class="space-y-3">
          <div class="batshit-settings-form-row">
            <Label.Root for={fieldId + '-installed-model'} class="batshit-settings-form-label">Model</Label.Root>
            <div class="batshit-settings-form-control">
              <Select.Root type="single" value={contextModel || NO_SETTINGS_FILE} onValueChange={(value) => {
                contextModel = value && value !== NO_SETTINGS_FILE ? value : ''
                quiescenceConfirmed = false
              }}>
                <Select.Trigger id={fieldId + '-installed-model'} class="w-full justify-between" disabled={busyModelId !== null}>
                  {selectedContextModel?.nativeRef || 'Choose installed model'}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value={NO_SETTINGS_FILE}>Choose installed model</Select.Item>
                  {#each registeredModels as model (model.id)}<Select.Item value={model.id}>{model.nativeRef}</Select.Item>{/each}
                </Select.Content>
              </Select.Root>
            </div>
          </div>
          <div class="batshit-settings-form-row">
            <Label.Root for={fieldId + '-context-tokens'} class="batshit-settings-form-label">Context Tokens</Label.Root>
            <div class="batshit-settings-form-control">
              <Input id={fieldId + '-context-tokens'} type="text" inputmode="numeric" bind:value={contextTokens} placeholder="60000" disabled={busyModelId !== null} />
            </div>
          </div>
          <p class="batshit-settings-caption">Enter the actual context to load, from 256 to 524,288 tokens. Batshit preserves this model's enrolled settings and changes only context. The model must fit your computer's memory.</p>
          <p class="batshit-settings-caption">Leave KoboldCpp and its Terminal window running. Restart affects every app sharing this server and clears its context cache. Another client can still start a request after the idle check.</p>
          <div class="flex items-start gap-2">
            <Checkbox class="mt-0.5" id={fieldId + '-managed-idle'} bind:checked={quiescenceConfirmed} disabled={busyModelId !== null} />
            <Label.Root for={fieldId + '-managed-idle'} class="batshit-settings-form-label">No chats in any app using this KoboldCpp server are generating or waiting for a response.</Label.Root>
          </div>
          {#if !selectedContextModel || !validContextTokens || !quiescenceConfirmed}
            <p class="batshit-settings-caption">Choose an installed model, enter a whole context token count, and confirm all chats are idle to apply.</p>
          {/if}
          <Button variant="outline" size="sm" disabled={!canApplyContext} onclick={() => applyProfile(true)}>
            {profileApplying ? 'Checking restart and loaded context' : 'Apply and Restart'}
          </Button>
        </div>
      {:else}
        <p class="batshit-settings-caption">{management.managedContextReason}</p>
        {#if management.registeredSetup}
          <Button variant="outline" size="sm" disabled={busyModelId !== null || !connectionReady || !enabled} onclick={enableContextEditing}>Enable Registered Local Setup</Button>
        {/if}
      {/if}
      {#if management.canApplyProfile && !management.managedContextActive}
        <div class="space-y-3">
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <Label.Root for={fieldId + '-profile'} class="batshit-settings-form-label">Saved KoboldCpp Settings</Label.Root>
              <p class="batshit-settings-caption">Choose a native .kcpps or .kcppt file from the authorized folder. Its contents control the model, context and other settings; Batshit cannot inspect them.</p>
            </div>
            <div class="batshit-settings-form-control">
              <Select.Root type="single" value={selectedProfile || NO_SETTINGS_FILE} onValueChange={(value) => {
                profile = value && value !== NO_SETTINGS_FILE ? value : ''
                expectedModel = management?.running?.model ?? ''
                expectedContext = ''
                quiescenceConfirmed = false
              }}>
                <Select.Trigger id={fieldId + '-profile'} class="w-full justify-between" disabled={busyModelId !== null}>
                  {selectedProfile || 'Choose saved settings'}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value={NO_SETTINGS_FILE}>Choose saved settings</Select.Item>
                  {#each settingsFiles ?? [] as file (file)}<Select.Item value={file}>{file}</Select.Item>{/each}
                </Select.Content>
              </Select.Root>
            </div>
          </div>
          <p class="batshit-settings-caption">The following fields check the served model and context only. They do not change the selected file or set KoboldCpp's allocation. Enter what that file should load; do not rely on its filename. KoboldCpp can recover startup settings after a failed load, so matching values cannot prove the selected file succeeded.</p>
          <div class="batshit-settings-form-row">
            <Label.Root for={fieldId + '-model'} class="batshit-settings-form-label">Expected Served Model</Label.Root>
            <Input id={fieldId + '-model'} bind:value={expectedModel} disabled={busyModelId !== null} />
          </div>
          <div class="batshit-settings-form-row">
            <Label.Root for={fieldId + '-context'} class="batshit-settings-form-label">Expected Real Context (tokens)</Label.Root>
            <Input id={fieldId + '-context'} type="number" min={256} max={524288} step={1} bind:value={expectedContext} disabled={busyModelId !== null} />
          </div>
          <p class="batshit-settings-caption">This restarts the whole KoboldCpp server, interrupts its clients and clears its context cache. Wait for all chats to finish first. Leave KoboldCpp and its Terminal window running. The idle check and restart are separate; another client can still start a request between them.</p>
          <div class="flex items-start gap-2">
            <Checkbox class="mt-0.5" id={fieldId + '-idle'} bind:checked={quiescenceConfirmed} disabled={busyModelId !== null} />
            <Label.Root for={fieldId + '-idle'} class="batshit-settings-form-label">No chats in any app using this KoboldCpp server are generating or waiting for a response.</Label.Root>
          </div>
          <Button variant="outline" size="sm" disabled={!canApply} onclick={() => applyProfile()}>
            {busyModelId === selectedProfile ? 'Checking restart and served model/context' : 'Apply saved settings and restart model'}
          </Button>
        </div>
      {:else}
        <p class="batshit-settings-caption">Saved-profile changes require password-protected admin access, single-model mode and a known loaded model/context. Refresh after configuring these in KoboldCpp.</p>
      {/if}
    {/if}

    {#if settingsFiles && hasModelFiles && management.canLoad && !management.managedContextActive}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label">Settings for Model Files</Label.Root>
            <SettingsInfoMenu ariaLabel="About Settings for Model Files" contentClass="w-80">
              <p>
                A .gguf model file loads with {management.label}'s default settings, not the ones it
                was started with. A context size, --jinja or --enableguidance you started it with is
                dropped.
              </p>
              <p>
                To keep yours, save them as a .kcpps settings file in the same folder (the
                {management.label} launcher's Save Config does this) and pick it here. If
                {management.label} was started with --baseconfig, it uses that file when nothing is
                picked.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          {#if settingsFiles.length}
            <Select.Root
              type="single"
              value={chosenSettingsFile || NO_SETTINGS_FILE}
              onValueChange={(value) => {
                const picked = Array.isArray(value) ? value[0] : value
                baseConfig = picked && picked !== NO_SETTINGS_FILE ? picked : ''
              }}
            >
              <Select.Trigger class="w-full justify-between">
                {chosenSettingsFile || `${management.label} Defaults`}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={NO_SETTINGS_FILE}>{management.label} Defaults</Select.Item>
                {#each settingsFiles as file (file)}
                  <Select.Item value={file}>{file}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          {:else}
            <p class="batshit-settings-caption">
              {management.label} defaults. No .kcpps settings file in its folder yet.
            </p>
          {/if}
        </div>
      </div>
    {/if}

    {#if management.models.length === 0}
      <p class="batshit-settings-caption">{management.reason ?? 'No models found.'}</p>
    {:else}
      <div class="space-y-2">
        {#each management.models as model (model.id)}
          <div class="batshit-settings-model-row flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="batshit-settings-form-label batshit-model-id truncate">{model.label}</div>
              <div class="flex items-center gap-2">
                {#if model.failure}
                  <span class="batshit-settings-caption">{model.failure}</span>
                {/if}
                {#if model.busy}
                  <span class="batshit-settings-status-badge">Loading</span>
                {:else if model.sleeping}
                  <span class="batshit-settings-status-badge">Sleeping · chat wakes it</span>
                {:else if model.loaded}
                  <span class="batshit-settings-status-badge is-success">Loaded</span>
                {/if}
                {#if formatSize(model.sizeBytes)}
                  <span class="batshit-settings-form-label">{formatSize(model.sizeBytes)}</span>
                {/if}
                {#if model.format}
                  <span class="batshit-settings-status-badge">{model.format}</span>
                {/if}
                {#if model.contextLength}
                  <span class="batshit-settings-form-label">
                    {model.contextLength.toLocaleString()} tokens
                  </span>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1">
              {#if (model.loaded || model.sleeping) && management.canUnload}
                <Button
                  variant="ghost"
                  size="icon"
                  title="Unload"
                  disabled={busyModelId !== null || waitingForRestart || model.busy}
                  onclick={() => act('unload', model)}
                >
                  <Square />
                </Button>
              {:else if management.canLoad && !management.managedContextActive && !model.sleeping && !(management.requiresVerifiedProfile && model.format === 'config')}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyModelId !== null || waitingForRestart || model.busy}
                  onclick={() => act('load', model)}
                >
                  <Play />
                  {busyModelId === model.id ? 'Working' : 'Load'}
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
