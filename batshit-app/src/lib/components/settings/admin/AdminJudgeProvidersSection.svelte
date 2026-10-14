<script lang="ts">
  import { Loader2, Plus, RefreshCw, Trash2, Zap } from '@lucide/svelte'
  import * as Card from '$lib/components/ui/card'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import { Badge } from '$lib/components/ui/badge'
  import { Button, buttonVariants } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { cn } from '$lib/utils'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import type { JudgeProvider, JudgeProviderRecord, TypesafeKeyStatus } from '$lib/types/typesafe'
  import {
    ADDABLE_JUDGE_KINDS,
    builtinTypesafeProvider,
    CLOUDFLARE_JUDGE_MODELS,
    JUDGE_KIND_LABELS,
    judgeKeyService,
    judgePrivacyClass,
    judgePrivacySentence,
    MAX_JUDGE_PROVIDERS,
    newJudgeProviderId,
    normalizeJudgeBaseUrl,
    OLLAMA_DEFAULT_BASE_URL,
    profileJudgeLimits,
    SYSTEMONE_URL_PRESETS,
    withReportedInputTokens
  } from '$lib/utils/judgeProviders'

  /**
   * SA-120 P10a (DL-120-18) — the judges on the Admin Judge Juice card: the built-in TypeSafe judge (its model is
   * the record's `modelId`, LS-048) and every judge the user added (Ollama, Cloudflare Workers AI, a System One URL).
   * A visible region only: the parent card owns the draft, the signature, and the one autosave, so every edit here
   * goes up through `onProvidersChange` / `onModelIdChange` as a new list (no prop is changed in place).
   * Keys are not here: they stay rows in Settings → API Keys (Josh, 2026-09-17), and a judge says when its key is
   * missing and links there. Test asks the SAVED judge one fixed sample question, so it waits while an edit is unsaved.
   */
  interface Props {
    providers: JudgeProviderRecord[]
    modelId: string
    keys: Record<string, TypesafeKeyStatus>
    /** The Default Judge cannot be removed (review round 1, S6): pick another default first. */
    defaultProviderId: string
    disabled: boolean
    /** True while the draft differs from what is saved (or a save is on its way): Test would test the old judge. */
    unsaved: boolean
    onProvidersChange: (next: JudgeProviderRecord[]) => void
    onModelIdChange: (next: string) => void
    onOpenApiKeys: () => void
  }

  let { providers, modelId, keys, defaultProviderId, disabled, unsaved, onProvidersChange, onModelIdChange, onOpenApiKeys }: Props =
    $props()

  type SelectValue = string | string[] | null | undefined
  type TestState = { running: boolean; ok: boolean | null; message: string | null }
  type ModelList = { loading: boolean; error: string | null; models: Array<{ name: string; contextTokens: number | null }> | null }

  let tests = $state<Record<string, TestState>>({})
  let modelLists = $state<Record<string, ModelList>>({})

  const typesafeJudge = $derived(builtinTypesafeProvider({ modelId }))
  const canAdd = $derived(!disabled && providers.length < MAX_JUDGE_PROVIDERS)

  function normalizeSelectValue(value: SelectValue): string {
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
  }

  function privacyBadge(provider: Pick<JudgeProvider, 'kind' | 'baseUrl'>): string {
    const privacy = judgePrivacyClass(provider)
    if (privacy === 'local') return 'This Computer'
    if (privacy === 'lan') return 'Local Network'
    return 'Leaves This Computer'
  }

  function keyNeedFor(provider: Pick<JudgeProvider, 'kind' | 'sendsKey'>): { service: string; present: boolean } | null {
    const service = judgeKeyService(provider)
    if (!service) return null
    return { service, present: keys[service]?.present === true }
  }

  function keyRowName(service: string): string {
    if (service === 'cloudflare_workers_ai') return 'Cloudflare Workers AI (Judge Juice)'
    if (service === 'systemone_url') return 'System One URL (Judge Juice)'
    return 'TypeSafe (Judge Juice)'
  }

  function limitsText(provider: JudgeProvider): string {
    const reported = provider.kind === 'ollama' ? modelLists[provider.id]?.models?.find((model) => model.name === provider.modelId)?.contextTokens : null
    const limits = withReportedInputTokens(profileJudgeLimits(provider), reported ?? null)
    return `Takes up to ${limits.maxQuestions} questions, ${limits.maxChoiceOptions} options in one pick, and about ${limits.maxInputTokens.toLocaleString('en-US')} tokens of text${limits.tokensSource === 'reported' ? ' (reported by Ollama)' : ''}. A bigger request is not sent.`
  }

  function update(id: string, patch: Partial<JudgeProviderRecord>) {
    onProvidersChange(providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)))
  }

  function addJudge(choice: string) {
    if (!canAdd || !choice) return
    const ids = providers.map((provider) => provider.id)
    let record: JudgeProviderRecord
    if (choice === 'ollama') {
      record = { id: newJudgeProviderId('ollama', ids), kind: 'ollama', label: 'Ollama', baseUrl: OLLAMA_DEFAULT_BASE_URL, modelId: '' }
    } else if (choice === 'cloudflare') {
      record = { id: newJudgeProviderId('cloudflare', ids), kind: 'cloudflare', label: 'Cloudflare', accountId: '', modelId: 'clef-flash' }
    } else {
      const preset = SYSTEMONE_URL_PRESETS.find((entry) => `systemone_url:${entry.label}` === choice)
      record = {
        id: newJudgeProviderId('systemone_url', ids),
        kind: 'systemone_url',
        label: preset?.label ?? 'System One URL',
        baseUrl: preset?.baseUrl ?? 'http://127.0.0.1:8080',
        modelId: '',
        sendsKey: preset?.sendsKey ?? false
      }
    }
    onProvidersChange([...providers, record])
  }

  function removeJudge(id: string) {
    onProvidersChange(providers.filter((provider) => provider.id !== id))
    const { [id]: _test, ...restTests } = tests
    tests = restTests
    const { [id]: _list, ...restLists } = modelLists
    modelLists = restLists
  }

  async function findOllamaModels(provider: JudgeProviderRecord) {
    const baseUrl = normalizeJudgeBaseUrl(provider.baseUrl)
    if (!baseUrl) {
      modelLists = { ...modelLists, [provider.id]: { loading: false, error: 'Enter the Ollama address first.', models: null } }
      return
    }
    modelLists = { ...modelLists, [provider.id]: { loading: true, error: null, models: null } }
    try {
      const response = await fetch('/api/settings/typesafe/ollama-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || 'Batshit could not read the Ollama model list.')
      modelLists = { ...modelLists, [provider.id]: { loading: false, error: null, models: payload.models ?? [] } }
    } catch (error) {
      modelLists = {
        ...modelLists,
        [provider.id]: { loading: false, error: error instanceof Error ? error.message : 'Batshit could not read the Ollama model list.', models: null }
      }
    }
  }

  async function testJudge(id: string) {
    tests = { ...tests, [id]: { running: true, ok: null, message: null } }
    try {
      const response = await fetch('/api/settings/typesafe/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: id })
      })
      const payload = await response.json().catch(() => null)
      const ok = response.ok && payload?.ok === true
      tests = { ...tests, [id]: { running: false, ok, message: ok ? payload.message : payload?.error || 'The test failed.' } }
    } catch (error) {
      tests = { ...tests, [id]: { running: false, ok: false, message: error instanceof Error ? error.message : 'The test failed.' } }
    }
  }

  function notListedWarning(provider: JudgeProviderRecord): string | null {
    const list = modelLists[provider.id]?.models
    if (!list || !provider.modelId.trim()) return null
    return list.some((model) => model.name === provider.modelId.trim())
      ? null
      : 'Ollama does not list this model as a decision model. Pick one from the list, or pull one first (ollama pull clef-flash).'
  }
</script>

{#snippet keyNote(provider: Pick<JudgeProvider, 'kind' | 'sendsKey'>)}
  {@const need = keyNeedFor(provider)}
  {#if need && !need.present}
    <p class="batshit-settings-form-help is-warning" data-testid="judge-missing-key">
      No key saved for this judge yet. Add it in
      <button type="button" class="batshit-settings-inline-link" onclick={onOpenApiKeys}>Settings → API Keys</button>
      under {keyRowName(need.service)}.
    </p>
  {/if}
{/snippet}

{#snippet testRow(id: string, name: string)}
  {@const test = tests[id]}
  <Button
    type="button"
    variant="outline"
    size="sm"
    onclick={() => testJudge(id)}
    disabled={disabled || unsaved || test?.running === true}
    aria-label={`Test ${name}`}
    title={unsaved ? 'Wait for the card to save, then test.' : 'Ask this judge one fixed sample question (never your chats).'}
  >
    {#if test?.running}
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
    {/if}
    Test
  </Button>
{/snippet}

{#snippet testResult(id: string)}
  {@const test = tests[id]}
  {#if test?.message}
    <p class={`batshit-settings-form-meta ${test.ok ? 'is-success' : 'is-error'}`} data-testid={`judge-test-result-${id}`}>
      {test.message}
    </p>
  {/if}
{/snippet}

<div class="batshit-settings-subsection">
  <div class="batshit-settings-action-row">
    <div class="batshit-settings-form-label-line">
      <span class="batshit-settings-parent-label">Judges</span>
      <SettingsInfoMenu ariaLabel="About Judges" contentClass="w-96">
        <p>
          A judge is the model that answers Judge Juice's questions. TypeSafe's Jev is built in. You can add a judge
          that runs on this computer or on another computer on your network through Ollama, a hosted judge on
          Cloudflare Workers AI, or any other program that offers a System One address.
        </p>
        <p>
          Each judge says where your text goes. Pick the judge every feature uses, and a different one for a single
          feature, under Which Judge below. Test sends one fixed sample question, never your chats, even while Judge
          Juice is off.
        </p>
      </SettingsInfoMenu>
    </div>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class={cn(buttonVariants({ size: 'sm' }), 'batshit-button batshit-button-medium batshit-button-medium-primary')}
        disabled={!canAdd}
      >
        <Plus class="h-4 w-4" />
        Add Judge
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {#each ADDABLE_JUDGE_KINDS as kind}
          {#if kind === 'systemone_url'}
            {#each SYSTEMONE_URL_PRESETS as preset}
              <DropdownMenu.Item onclick={() => addJudge(`systemone_url:${preset.label}`)}>
                {JUDGE_KIND_LABELS.systemone_url}: {preset.label}
              </DropdownMenu.Item>
            {/each}
            <DropdownMenu.Item onclick={() => addJudge('systemone_url')}>{JUDGE_KIND_LABELS.systemone_url}: Other</DropdownMenu.Item>
          {:else}
            <DropdownMenu.Item onclick={() => addJudge(kind)}>{JUDGE_KIND_LABELS[kind]}</DropdownMenu.Item>
          {/if}
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  <div class="batshit-settings-group">
    <Card.Root class="batshit-settings-display-card" data-testid="judge-card-typesafe">
      <Card.Content class="space-y-3 p-4">
        <div class="batshit-settings-action-row">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <Zap class="size-4 shrink-0" aria-hidden="true" />
            <span class="batshit-settings-child-label truncate">TypeSafe</span>
            <Badge variant="outline">Built In</Badge>
            <Badge variant="outline">{privacyBadge(typesafeJudge)}</Badge>
          </div>
          {@render testRow(typesafeJudge.id, 'TypeSafe')}
        </div>
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label.Root class="batshit-settings-form-label" for="jev-juice-model">TypeSafe Model</Label.Root>
              <SettingsInfoMenu ariaLabel="About the Jev model id">
                <p>
                  A pinned Jev model id, such as jev-1.13.0. Batshit refuses jev-latest here so answers stay
                  reproducible; change this on purpose when TypeSafe ships a new version.
                </p>
              </SettingsInfoMenu>
            </div>
          </div>
          <div class="batshit-settings-form-control">
            <Input
              id="jev-juice-model"
              type="text"
              value={modelId}
              disabled={disabled}
              oninput={(event) => onModelIdChange((event.currentTarget as HTMLInputElement).value)}
            />
          </div>
        </div>
        <p class="batshit-settings-form-help">{judgePrivacySentence(typesafeJudge)}</p>
        {@render testResult(typesafeJudge.id)}
      </Card.Content>
    </Card.Root>

    {#each providers as provider (provider.id)}
      {@const list = modelLists[provider.id]}
      {@const warning = provider.kind === 'ollama' ? notListedWarning(provider) : null}
      <Card.Root class="batshit-settings-display-card" data-testid={`judge-card-${provider.id}`}>
        <Card.Content class="space-y-3 p-4">
          <div class="batshit-settings-action-row">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <Zap class="size-4 shrink-0" aria-hidden="true" />
              <span class="batshit-settings-child-label truncate">{provider.label || JUDGE_KIND_LABELS[provider.kind]}</span>
              <Badge variant="outline">{JUDGE_KIND_LABELS[provider.kind]}</Badge>
              <Badge variant="outline">{privacyBadge(provider)}</Badge>
            </div>
            <!-- BL-1449: `.batshit-settings-action-row > .flex` gives a bare `flex` child the full row width (meant for a row's sole full-width wrapper), so this action group must not carry the bare `flex` token or it takes the whole row and the title group wraps under it (overlapping badges). -->
            <div class="inline-flex shrink-0 items-center gap-2">
              {@render testRow(provider.id, provider.label || JUDGE_KIND_LABELS[provider.kind])}
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onclick={() => removeJudge(provider.id)}
                disabled={disabled || provider.id === defaultProviderId}
                aria-label={`Remove ${provider.label || JUDGE_KIND_LABELS[provider.kind]}`}
                title={provider.id === defaultProviderId
                  ? 'Pick another Default Judge first'
                  : 'Remove this judge; features that chose it go back to the Default Judge'}
              >
                <Trash2 class="size-4" aria-hidden="true" />
                Remove
              </Button>
            </div>
          </div>

          <div class="batshit-settings-form-stack">
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <Label.Root class="batshit-settings-form-label" for={`judge-label-${provider.id}`}>Name</Label.Root>
              </div>
              <div class="batshit-settings-form-control">
                <Input
                  id={`judge-label-${provider.id}`}
                  type="text"
                  value={provider.label}
                  disabled={disabled}
                  oninput={(event) => update(provider.id, { label: (event.currentTarget as HTMLInputElement).value })}
                />
              </div>
            </div>

            {#if provider.kind === 'cloudflare'}
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-form-label" for={`judge-account-${provider.id}`}>Account ID</Label.Root>
                    <SettingsInfoMenu ariaLabel="About the Cloudflare account id">
                      <p>The 32-character account id from the Cloudflare dashboard (Workers AI, then Use REST API).</p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control">
                  <Input
                    id={`judge-account-${provider.id}`}
                    type="text"
                    value={provider.accountId ?? ''}
                    disabled={disabled}
                    oninput={(event) => update(provider.id, { accountId: (event.currentTarget as HTMLInputElement).value })}
                  />
                </div>
              </div>
            {:else}
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-form-label" for={`judge-url-${provider.id}`}>Address</Label.Root>
                    <SettingsInfoMenu ariaLabel="About the judge address">
                      <p>
                        {#if provider.kind === 'ollama'}
                          Where Ollama runs: http://127.0.0.1:11434 on this computer, or the other computer's address on
                          your network, such as http://192.168.1.20:11434. Batshit adds /v1/systemone.
                        {:else}
                          The program's address. Batshit adds /v1/systemone, so enter the part before it.
                        {/if}
                      </p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control is-wide">
                  <Input
                    id={`judge-url-${provider.id}`}
                    type="url"
                    value={provider.baseUrl ?? ''}
                    disabled={disabled}
                    oninput={(event) => update(provider.id, { baseUrl: (event.currentTarget as HTMLInputElement).value })}
                  />
                </div>
              </div>
            {/if}

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label.Root class="batshit-settings-form-label" for={`judge-model-${provider.id}`}>Model</Label.Root>
                  {#if provider.kind === 'ollama'}
                    <SettingsInfoMenu ariaLabel="About the Ollama judge model">
                      <p>
                        A model Ollama lists as a decision model, such as clef-flash (ollama pull clef-flash). Find
                        Models asks this Ollama for its list; you can also type a name.
                      </p>
                    </SettingsInfoMenu>
                  {/if}
                </div>
              </div>
              <div class="batshit-settings-form-control">
                {#if provider.kind === 'cloudflare'}
                  <Select.Root
                    type="single"
                    value={provider.modelId}
                    onValueChange={(value) => update(provider.id, { modelId: normalizeSelectValue(value) })}
                    disabled={disabled}
                  >
                    <Select.Trigger id={`judge-model-${provider.id}`} class="w-full">
                      <span class="truncate">{provider.modelId || 'Choose a model'}</span>
                    </Select.Trigger>
                    <Select.Content>
                      {#each CLOUDFLARE_JUDGE_MODELS as model}
                        <Select.Item value={model}>{model}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                {:else}
                  <div class="batshit-settings-field-cluster">
                    <div class="batshit-settings-field-lane">
                      <Input
                        id={`judge-model-${provider.id}`}
                        type="text"
                        value={provider.modelId}
                        placeholder={provider.kind === 'ollama' ? 'clef-flash' : 'model name'}
                        disabled={disabled}
                        oninput={(event) => update(provider.id, { modelId: (event.currentTarget as HTMLInputElement).value })}
                      />
                    </div>
                    {#if provider.kind === 'ollama'}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => findOllamaModels(provider)}
                        disabled={disabled || list?.loading === true}
                      >
                        {#if list?.loading}
                          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
                        {:else}
                          <RefreshCw class="size-4" aria-hidden="true" />
                        {/if}
                        Find Models
                      </Button>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>

            {#if provider.kind === 'ollama' && list?.models}
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <Label.Root class="batshit-settings-form-label" for={`judge-model-pick-${provider.id}`}>Decision Models</Label.Root>
                </div>
                <div class="batshit-settings-form-control">
                  {#if list.models.length === 0}
                    <p class="batshit-settings-form-meta is-warning">
                      This Ollama has no decision model yet. Pull one first, such as ollama pull clef-flash.
                    </p>
                  {:else}
                    <Select.Root
                      type="single"
                      value={provider.modelId}
                      onValueChange={(value) => update(provider.id, { modelId: normalizeSelectValue(value) })}
                      disabled={disabled}
                    >
                      <Select.Trigger id={`judge-model-pick-${provider.id}`} class="w-full">
                        <span class="truncate">Pick a decision model</span>
                      </Select.Trigger>
                      <Select.Content>
                        {#each list.models as model}
                          <Select.Item value={model.name}>
                            {model.name}{model.contextTokens ? ` (${model.contextTokens.toLocaleString('en-US')} tokens)` : ''}
                          </Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  {/if}
                </div>
              </div>
            {/if}
            {#if list?.error}
              <p class="batshit-settings-form-meta is-error">{list.error}</p>
            {/if}
            {#if warning}
              <p class="batshit-settings-form-meta is-warning">{warning}</p>
            {/if}

            {#if provider.kind === 'systemone_url'}
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Root class="batshit-settings-form-label" for={`judge-sends-key-${provider.id}`}>Send Key</Label.Root>
                    <SettingsInfoMenu ariaLabel="About Send Key">
                      <p>
                        Turn on for a hosted service that needs a key, such as Liquid AI. The key is the System One URL
                        row in Settings → API Keys. A program on this computer usually needs none.
                      </p>
                      <p>
                        One judge at a time can send this key, and only over an https address (or to a program on this
                        computer).
                      </p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control is-inline-status">
                  <Switch.Root
                    id={`judge-sends-key-${provider.id}`}
                    checked={provider.sendsKey === true}
                    onCheckedChange={(checked) => update(provider.id, { sendsKey: checked === true })}
                    disabled={disabled}
                  />
                </div>
              </div>
            {/if}
          </div>

          {@render keyNote(provider)}
          <p class="batshit-settings-form-help" data-testid={`judge-privacy-${provider.id}`}>{judgePrivacySentence(provider)}</p>
          <p class="batshit-settings-form-meta">{limitsText(provider)}</p>
          {@render testResult(provider.id)}
        </Card.Content>
      </Card.Root>
    {/each}
  </div>
</div>
