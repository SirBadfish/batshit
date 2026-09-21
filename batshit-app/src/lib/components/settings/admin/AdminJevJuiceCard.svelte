<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Zap } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import { Input } from '$lib/components/ui/input'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import type { TypesafeConfig, TypesafeKeyStatus } from '$lib/types/typesafe'
  import { JEV_JUICE_NAME, TYPESAFE_VENDOR_NAME } from '$lib/utils/jevJuice'
  import { JEV_IN_CHAT_WAIT_LABEL, JEV_INCOMING_TEXT_SCREEN_LABEL } from '$lib/utils/jevJuiceControl'

  /**
   * SA-120 P0 (DL-120-01/13) — the instance-level Jev Juice card: the master switch,
   * the pinned model id, the per-attempt timeout, and (SA-120 P8, LS-059, DL-120-16) the
   * In-Chat Wait Limit, the one number a user tunes: how long a send waits on Jev before it
   * goes out without that feature. The TypeSafe key and its Test button
   * live in Settings → API Keys with every other key (Josh, 2026-09-17 review); this card
   * only says when the key is missing and points there.
   * SA-120 P7 adds the ONE feature switch that lives on this record, **Screen Incoming
   * Text** (LS-057; no "Jev Juice:" prefix, because the card itself is the feature's name):
   * its lane spans agent DMs, wake-up webhooks, and skill imports, and no agent, group, or
   * user settings block owns all three.
   * It owns its own record (`batshit:typesafe_config` through `/api/settings/typesafe`)
   * rather than riding the Admin `admin_settings` blob, because the server reads it on
   * every Jev call and it has its own validation (a pinned model id only).
   *
   * Save contract (FM "Settings Auto-Save Contract"): hydrate under `untrack`, compare a
   * signature against the persisted one, debounce the PUT, and on failure show the error
   * and wait for the next deliberate edit instead of retrying in a loop.
   */
  interface Props {
    disabled?: boolean
  }

  let { disabled = false }: Props = $props()

  const PINNED_MODEL_ID_PATTERN = /^jev-\d+\.\d+(?:\.\d+)?$/
  const SAVE_DEBOUNCE_MS = 500

  let loading = $state(true)
  let loadError = $state<string | null>(null)
  let enabled = $state(false)
  let modelId = $state('jev-1.13.0')
  let attemptTimeoutMs = $state(5000)
  let inChatWaitMs = $state(750)
  let screenIncomingText = $state(false)
  let keyStatus = $state<TypesafeKeyStatus>({ present: false, source: null })
  let limits = $state({
    pinnedModelId: 'jev-1.13.0',
    attemptTimeoutMinMs: 500,
    attemptTimeoutMaxMs: 30000,
    inChatWaitMinMs: 200,
    inChatWaitMaxMs: 30000
  })
  let persistedSignature = $state<string | null>(null)
  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle')
  let saveError = $state<string | null>(null)

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let savedResetTimer: ReturnType<typeof setTimeout> | null = null

  function signatureOf(values: {
    enabled: boolean
    modelId: string
    attemptTimeoutMs: number
    inChatWaitMs: number
    screenIncomingText?: boolean
  }) {
    return JSON.stringify({
      enabled: values.enabled,
      modelId: values.modelId.trim(),
      attemptTimeoutMs: values.attemptTimeoutMs,
      inChatWaitMs: values.inChatWaitMs,
      screenIncomingText: values.screenIncomingText === true
    })
  }

  const signature = $derived(signatureOf({ enabled, modelId, attemptTimeoutMs, inChatWaitMs, screenIncomingText }))

  /** The missing-key note: quiet while everything is off, a warning once the master switch is on. */
  const keyMissing = $derived(!loading && !keyStatus.present)

  function openApiKeys() {
    window.dispatchEvent(new CustomEvent('batshit:open-settings', { detail: { tab: 'api-keys' } }))
  }

  function applyConfig(config: TypesafeConfig) {
    enabled = config.enabled
    modelId = config.modelId
    attemptTimeoutMs = config.attemptTimeoutMs
    inChatWaitMs = config.inChatWaitMs
    screenIncomingText = config.screenIncomingText === true
    persistedSignature = signatureOf(config)
  }

  async function load() {
    loading = true
    loadError = null
    try {
      const response = await fetch('/api/settings/typesafe')
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `Failed to load ${JEV_JUICE_NAME} settings.`)
      untrack(() => {
        applyConfig(payload.config as TypesafeConfig)
        keyStatus = payload.key ?? { present: false, source: null }
        if (payload.limits) limits = payload.limits
      })
    } catch (error) {
      loadError = error instanceof Error ? error.message : `Failed to load ${JEV_JUICE_NAME} settings.`
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
  })

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (savedResetTimer) clearTimeout(savedResetTimer)
  })

  function validateDraft(): string | null {
    if (!PINNED_MODEL_ID_PATTERN.test(modelId.trim())) {
      return `Model must be a pinned Jev id such as ${limits.pinnedModelId}. jev-latest is not allowed here.`
    }
    if (
      !Number.isInteger(attemptTimeoutMs) ||
      attemptTimeoutMs < limits.attemptTimeoutMinMs ||
      attemptTimeoutMs > limits.attemptTimeoutMaxMs
    ) {
      return `Timeout must be a whole number from ${limits.attemptTimeoutMinMs} to ${limits.attemptTimeoutMaxMs} ms.`
    }
    if (!Number.isInteger(inChatWaitMs) || inChatWaitMs < limits.inChatWaitMinMs || inChatWaitMs > limits.inChatWaitMaxMs) {
      return `${JEV_IN_CHAT_WAIT_LABEL} must be a whole number from ${limits.inChatWaitMinMs} to ${limits.inChatWaitMaxMs} ms.`
    }
    return null
  }

  async function persist(expectedSignature: string) {
    const validationError = validateDraft()
    if (validationError) {
      saveState = 'error'
      saveError = validationError
      return
    }
    saveState = 'saving'
    saveError = null
    try {
      const response = await fetch('/api/settings/typesafe', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, modelId: modelId.trim(), attemptTimeoutMs, inChatWaitMs, screenIncomingText })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `Failed to save ${JEV_JUICE_NAME} settings.`)
      // Only re-baseline if the user has not typed again while the request was in flight.
      if (signature === expectedSignature) {
        applyConfig(payload.config as TypesafeConfig)
      } else {
        persistedSignature = signatureOf(payload.config as TypesafeConfig)
      }
      if (payload.key) keyStatus = payload.key
      saveState = 'saved'
      if (savedResetTimer) clearTimeout(savedResetTimer)
      savedResetTimer = setTimeout(() => {
        if (saveState === 'saved') saveState = 'idle'
      }, 2000)
    } catch (error) {
      saveState = 'error'
      saveError = error instanceof Error ? error.message : `Failed to save ${JEV_JUICE_NAME} settings.`
    }
  }

  // Autosave: runs only after hydration and only when the draft differs from what is stored.
  $effect(() => {
    const next = signature
    if (loading || persistedSignature === null) return
    if (next === persistedSignature) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist(next)
    }, SAVE_DEBOUNCE_MS)
  })

</script>

<SettingsAccordionCard name="admin-settings-cards" title={JEV_JUICE_NAME} icon={Zap} contentClass="space-y-4">
  {#snippet info()}
    <SettingsInfoMenu ariaLabel={`About ${JEV_JUICE_NAME}`} contentClass="w-96">
      <p>
        {JEV_JUICE_NAME} hands small yes-or-no and pick-one judgments to Jev, a model made by
        {TYPESAFE_VENDOR_NAME}, so your agent has less to juggle. Jev cannot write text and never
        talks to you: Batshit asks it questions and uses the answers.
      </p>
      <p>
        Everything here is off until you turn it on. Each {JEV_JUICE_NAME} feature has its own
        switch and says exactly what text it sends. When a feature is on, that text leaves this
        computer and goes to {TYPESAFE_VENDOR_NAME}'s servers.
      </p>
      <p>
        Needs a {TYPESAFE_VENDOR_NAME} key in Settings → API Keys. The key's Test button there sends
        one fixed sample question, even while this card is off, and never sends your chats.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  {#snippet actions()}
    <SettingsSaveStatus state={saveError ? 'error' : saveState} error={saveError} sticky={false} />
  {/snippet}

  {#if loadError}
    <p class="batshit-settings-form-help is-danger">{loadError}</p>
  {/if}

  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="jev-juice-enabled">
            Allow {JEV_JUICE_NAME}
          </Label.Root>
          <SettingsInfoMenu ariaLabel={`About Allow ${JEV_JUICE_NAME}`}>
            <p>
              The master switch. Off means Batshit sends nothing to {TYPESAFE_VENDOR_NAME}, no matter
              what any feature switch says. On lets the features you turn on run.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control is-inline-status">
        <Switch.Root
          id="jev-juice-enabled"
          checked={enabled}
          onCheckedChange={(checked) => (enabled = checked === true)}
          disabled={disabled || loading}
        />
      </div>
    </div>

    {#if keyMissing}
      <p
        class={`batshit-settings-form-help ${enabled ? 'is-warning' : ''}`}
        data-testid="jev-juice-missing-key"
      >
        No {TYPESAFE_VENDOR_NAME} key yet, so nothing here can run. Add it in
        <button type="button" class="batshit-settings-inline-link" onclick={openApiKeys}>
          Settings → API Keys
        </button>
        under {TYPESAFE_VENDOR_NAME} ({JEV_JUICE_NAME}).
      </p>
    {/if}

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="jev-juice-screen-incoming-text">
            {JEV_INCOMING_TEXT_SCREEN_LABEL}
          </Label.Root>
          <SettingsInfoMenu ariaLabel={`About ${JEV_INCOMING_TEXT_SCREEN_LABEL}`} contentClass="w-96">
            <p>
              This feature allows Jev to screen text that reaches your agents but did not come from
              you: DMs from other agents, messages from wake-up webhooks, and skills you import. With
              this on, Batshit shows each one to Jev when it arrives. Jev says if it looks like a
              takeover attempt, hidden instructions, or an unwanted request, and how much harm it
              could do. Messages from your own schedules are not checked, because you wrote those.
            </p>
            <p>
              A flag is a warning only. You see it in the Agent DMs drawer, on the DM card in a chat,
              in a notice above an approval card in a chat the message started, and in the skill
              import box. The agent that reads the text is told too. Nothing is blocked, and nothing
              is approved for you. No flag does not mean safe: Jev can be wrong.
            </p>
            <p>
              What leaves this computer when it is on: the subject and text of each agent DM and
              wake-up webhook message, and the text of SKILL.md when you import a skill.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control is-inline-status">
        <Switch.Root
          id="jev-juice-screen-incoming-text"
          checked={screenIncomingText}
          onCheckedChange={(checked) => (screenIncomingText = checked === true)}
          disabled={disabled || loading}
        />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="jev-juice-model">Model</Label.Root>
          <SettingsInfoMenu ariaLabel="About the Jev model id">
            <p>
              A pinned Jev model id, such as {limits.pinnedModelId}. Batshit refuses jev-latest here so
              answers stay reproducible; change this on purpose when {TYPESAFE_VENDOR_NAME} ships a new
              version.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="jev-juice-model"
          type="text"
          value={modelId}
          disabled={disabled || loading}
          oninput={(event) => (modelId = (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="jev-juice-timeout">
            Per-Attempt Timeout (ms)
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About the per-attempt timeout">
            <p>
              How long one request to {TYPESAFE_VENDOR_NAME} may take before Batshit gives up on it.
              Features that run while a message is being sent stop sooner, at the {JEV_IN_CHAT_WAIT_LABEL}
              below, and skip themselves when Jev is slow, so the message still goes out.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="jev-juice-timeout"
          type="number"
          min={limits.attemptTimeoutMinMs}
          max={limits.attemptTimeoutMaxMs}
          step={100}
          value={attemptTimeoutMs}
          disabled={disabled || loading}
          oninput={(event) => {
            const parsed = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10)
            attemptTimeoutMs = Number.isNaN(parsed) ? 0 : parsed
          }}
        />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="jev-juice-in-chat-wait">
            {JEV_IN_CHAT_WAIT_LABEL} (ms)
          </Label.Root>
          <SettingsInfoMenu ariaLabel={`About the ${JEV_IN_CHAT_WAIT_LABEL}`} contentClass="w-96">
            <p>
              How long a message you send may wait for Jev. This covers the {JEV_JUICE_NAME} features
              that run while your message is being sent: skill and tool hints, the group speaker pick,
              recall by meaning, and smart zip. If Jev has not answered by this limit, the message goes
              out without that feature and a small note under the reply says so.
            </p>
            <p>
              750 ms (three quarters of a second) is the default. Set it higher, such as 5000 (five
              seconds), if you would rather wait for Jev than skip it. There is no off: a long limit
              means "let Jev finish". Turn it back down if every send starts to feel slow.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id="jev-juice-in-chat-wait"
          type="number"
          min={limits.inChatWaitMinMs}
          max={limits.inChatWaitMaxMs}
          step={50}
          value={inChatWaitMs}
          disabled={disabled || loading}
          oninput={(event) => {
            const parsed = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10)
            inChatWaitMs = Number.isNaN(parsed) ? 0 : parsed
          }}
        />
      </div>
    </div>
  </div>
</SettingsAccordionCard>
