<script module lang="ts">
  import type { AgentBrowserOperationalSettings } from '$lib/utils/toolOperationalSettings'

  export type AgentBrowserOperationalPatch = Partial<Omit<AgentBrowserOperationalSettings, 'executablePath' | 'session' | 'profilePath'>> & {
    executablePath?: string | null
    session?: string | null
    profilePath?: string | null
  }
</script>

<script lang="ts">
  import { Globe } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'

  interface Props {
    values: AgentBrowserOperationalSettings
    disabled: boolean
    /** Factual runtime information supplied by the parent, never inferred in the browser. */
    dockerMode?: boolean
    onChange: (patch: AgentBrowserOperationalPatch) => void
  }

  let { values, disabled, dockerMode = false, onChange }: Props = $props()

  const runtimeOptions = [
    { value: 'chromium', label: 'Separate Chromium (recommended)' },
    { value: 'chrome-cdp', label: 'Current Chrome via CDP' }
  ] as const
  const providerOptions = [
    { value: 'local', label: 'Local browser runtime' },
    { value: 'browserbase', label: 'Browserbase (cloud)' },
    { value: 'browseruse', label: 'Browser Use (cloud)' },
    { value: 'kernel', label: 'Kernel (cloud)' }
  ] as const
  const optionalFields = [
    { key: 'executablePath', label: 'Browser Executable Path (Optional)', placeholder: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      help: 'Override the browser binary path when local defaults are not ideal.', wide: true },
    { key: 'session', label: 'Default Session Name (Optional)', placeholder: 'default',
      help: 'Uses this session name unless the browser command already supplies one.', wide: false },
    { key: 'profilePath', label: 'Default Profile Path (Optional)', placeholder: '~/.batshit/ab-profile',
      help: 'Uses this profile for persistent cookies or login state unless the browser command already supplies one.', wide: true }
  ] as const

  function emit(patch: AgentBrowserOperationalPatch, hostOnly = false) {
    if (disabled || hostOnly && dockerMode) return
    onChange(patch)
  }
  function selected(value: string | string[] | null | undefined) {
    return Array.isArray(value) ? value[0] : value
  }
  function changeRuntime(value: string | string[] | null | undefined) {
    const next = selected(value)
    if (next === 'chromium' || next === 'chrome-cdp') emit({ runtimeMode: next }, true)
  }
  function changeProvider(value: string | string[] | null | undefined) {
    const next = selected(value)
    if (next === 'local' || next === 'browserbase' || next === 'browseruse' || next === 'kernel') emit({ provider: next })
  }
  function changeNumber(key: 'cdpPort' | 'timeoutMs', event: Event) {
    const raw = (event.currentTarget as HTMLInputElement).value
    if (!raw.trim()) return
    const next = Number(raw)
    const [minimum, maximum] = key === 'cdpPort' ? [1, 65535] : [1000, 120000]
    if (Number.isInteger(next) && next >= minimum && next <= maximum) emit({ [key]: next }, key === 'cdpPort')
  }
  function changeOptional(key: 'executablePath' | 'session' | 'profilePath', event: Event) {
    emit({ [key]: (event.currentTarget as HTMLInputElement).value.trim() || null }, true)
  }
  function changeFlags(event: Event) {
    const text = (event.currentTarget as HTMLTextAreaElement).value
    // Keep line text while editing. The parent owns draft/save normalization and receipts.
    emit({ extraFlags: text === '' ? [] : text.split(/\r?\n/) })
  }
</script>

<SettingsAccordionCard name="admin-settings-cards" title="Agent Browser Defaults" icon={Globe} contentClass="space-y-4">
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Global Agent Browser Defaults" contentClass="w-80">
      <p>Choose the global operational defaults for Agent Browser. Each agent's browser access remains a separate choice.</p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="batshit-settings-form-stack">
    {#if dockerMode}
      <div class="batshit-settings-muted-panel space-y-1">
        <p class="batshit-settings-form-label">Docker Sidecar Runtime</p>
        <p class="batshit-settings-code-caption">
          Uses the Agent Browser sidecar. Desktop Chrome/CDP, visibility, executable path, session and profile
          defaults are not applied here; their saved values are kept. Provider, timeout and Extra CLI Flags still apply.
        </p>
      </div>
    {:else}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label" for="admin-agent-browser-live-view">Live Browser Visibility</Label.Root>
            <SettingsInfoMenu ariaLabel="About Global Live Browser Visibility">
              <p>Show browser actions in a visible window. Turn this off for hidden/headless execution.</p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control is-inline-status">
          <Switch.Root id="admin-agent-browser-live-view" checked={values.liveViewEnabled}
            onCheckedChange={(checked) => emit({ liveViewEnabled: checked === true }, true)} {disabled} />
        </div>
      </div>
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label" for="admin-agent-browser-runtime">Browser Runtime Mode</Label.Root>
            <SettingsInfoMenu ariaLabel="About Global Browser Runtime Mode">
              <p>Chrome CDP drives an existing Chrome session with remote debugging enabled.</p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root type="single" value={values.runtimeMode} onValueChange={changeRuntime} {disabled}>
            <Select.Trigger id="admin-agent-browser-runtime" class="w-full">
              <span class="truncate">{runtimeOptions.find(option => option.value === values.runtimeMode)?.label}</span>
            </Select.Trigger>
            <Select.Content>
              {#each runtimeOptions as option}<Select.Item value={option.value}>{option.label}</Select.Item>{/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>
      {#if values.runtimeMode === 'chrome-cdp'}
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label.Root class="batshit-settings-form-label" for="admin-agent-browser-cdp-port">Chrome CDP Port</Label.Root>
              <SettingsInfoMenu ariaLabel="About Global Chrome CDP Port">
                <p>Use Chrome's remote debugging port, usually <code>9222</code>.</p>
              </SettingsInfoMenu>
            </div>
          </div>
          <div class="batshit-settings-form-control">
            <Input id="admin-agent-browser-cdp-port" type="number" min="1" max="65535" step="1"
              value={values.cdpPort} oninput={(event) => changeNumber('cdpPort', event)} {disabled} />
          </div>
        </div>
      {/if}
    {/if}

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <Label.Root class="batshit-settings-form-label" for="admin-agent-browser-timeout">Agent Browser Timeout (ms)</Label.Root>
      </div>
      <div class="batshit-settings-form-control">
        <Input id="admin-agent-browser-timeout" type="number" min="1000" max="120000" step="1"
          value={values.timeoutMs} oninput={(event) => changeNumber('timeoutMs', event)} {disabled} />
      </div>
    </div>
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="admin-agent-browser-provider">Cloud Provider (Optional)</Label.Root>
          <SettingsInfoMenu ariaLabel="About Global Agent Browser Cloud Provider">
            <p>Local browser runtime is the default. Cloud providers require their credentials in API Keys.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root type="single" value={values.provider} onValueChange={changeProvider} {disabled}>
          <Select.Trigger id="admin-agent-browser-provider" class="w-full">
            <span class="truncate">{providerOptions.find(option => option.value === values.provider)?.label}</span>
          </Select.Trigger>
          <Select.Content>
            {#each providerOptions as option}<Select.Item value={option.value}>{option.label}</Select.Item>{/each}
          </Select.Content>
        </Select.Root>
      </div>
    </div>
    {#if !dockerMode}
      {#each optionalFields as field}
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label.Root class="batshit-settings-form-label" for={`admin-agent-browser-${field.key}`}>{field.label}</Label.Root>
              <SettingsInfoMenu ariaLabel={`About Global ${field.label}`}><p>{field.help}</p></SettingsInfoMenu>
            </div>
          </div>
          <div class={`batshit-settings-form-control ${field.wide ? 'is-wide' : ''}`}>
            <Input id={`admin-agent-browser-${field.key}`} placeholder={field.placeholder} value={values[field.key] ?? ''}
              oninput={(event) => changeOptional(field.key, event)} {disabled} />
          </div>
        </div>
      {/each}
    {/if}
    <div class="batshit-settings-form-row is-tall">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="admin-agent-browser-extra-flags">Extra CLI Flags (Advanced)</Label.Root>
          <SettingsInfoMenu ariaLabel="About Global Agent Browser Extra CLI Flags">
            <p>Extra flags appended to Agent Browser commands. Use one flag per line.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Textarea id="admin-agent-browser-extra-flags" rows={3} value={values.extraFlags.join('\n')}
          oninput={changeFlags} placeholder="One flag per line" {disabled} />
      </div>
    </div>
  </div>
</SettingsAccordionCard>
