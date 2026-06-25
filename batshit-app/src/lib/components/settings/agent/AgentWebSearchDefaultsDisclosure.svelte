<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'

  type SelectValue = string | string[] | null | undefined

  type SelectOption = {
    value: string
    label: string
  }

  interface Props {
    open?: boolean
    entityLabel: string
    titleInfoAriaLabel: string
    defaultsInfoAriaLabel: string
    providerInfoAriaLabel: string
    exaInfoAriaLabel: string
    perplexityInfoAriaLabel: string
    available: boolean
    enabled: boolean
    toolName: string | null
    unavailableMessage: string | null
    providerValue: string
    providerLabel: string
    providerInheritValue: string
    providerInheritLabel: string
    providerOptions: SelectOption[]
    providerLoading: boolean
    providerError: string | null
    exaTypeValue: string
    exaTypeLabel: string
    exaTypeInheritValue: string
    exaTypeInheritLabel: string
    exaTypeOptions: SelectOption[]
    perplexityValue: string
    perplexityLabel: string
    perplexityInheritValue: string
    perplexityInheritLabel: string
    perplexityOptions: number[]
    onEnabledChange: (enabled: boolean) => void
    onProviderValueChange: (value: string) => void
    onExaTypeValueChange: (value: string) => void
    onPerplexityMaxTokensValueChange: (value: string) => void
  }

  let {
    open = $bindable(false),
    entityLabel,
    titleInfoAriaLabel,
    defaultsInfoAriaLabel,
    providerInfoAriaLabel,
    exaInfoAriaLabel,
    perplexityInfoAriaLabel,
    available,
    enabled,
    toolName,
    unavailableMessage,
    providerValue,
    providerLabel,
    providerInheritValue,
    providerInheritLabel,
    providerOptions,
    providerLoading,
    providerError,
    exaTypeValue,
    exaTypeLabel,
    exaTypeInheritValue,
    exaTypeInheritLabel,
    exaTypeOptions,
    perplexityValue,
    perplexityLabel,
    perplexityInheritValue,
    perplexityInheritLabel,
    perplexityOptions,
    onEnabledChange,
    onProviderValueChange,
    onExaTypeValueChange,
    onPerplexityMaxTokensValueChange
  }: Props = $props()

  const active = $derived(available && enabled)

  function normalizeSelectValue(value: SelectValue) {
    return Array.isArray(value) ? value[0] : (value ?? '')
  }

  function handleEnabledChange(checked: boolean) {
    onEnabledChange(checked)
    if (!checked) {
      open = false
    }
  }
</script>

<Collapsible.Root bind:open>
  <div class="batshit-settings-toggle-disclosure-row">
    <div class="batshit-settings-toggle-disclosure-header">
      <div class="batshit-settings-toggle-disclosure-copy">
        <div class="flex items-center gap-1.5">
          <p class="batshit-settings-parent-label">Web Search</p>
          <SettingsInfoMenu ariaLabel={titleInfoAriaLabel}>
            {#if available}
              Enables <code>{toolName}</code> for live web results.
            {:else}
              {unavailableMessage}
            {/if}
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-toggle-disclosure-control">
        <Switch.Root
          checked={active}
          onCheckedChange={(checked) => handleEnabledChange(checked === true)}
          disabled={!available}
        />
        {#if active}
          <Collapsible.Trigger class="batshit-settings-toggle-disclosure-trigger">
            <span class="batshit-settings-toggle-disclosure-label">Web Search Defaults</span>
            <SettingsInfoMenu ariaLabel={defaultsInfoAriaLabel}>
              Pick the provider and optional Exa or Perplexity tuning for this {entityLabel}.
            </SettingsInfoMenu>
            <ChevronDown
              class={`batshit-settings-toggle-disclosure-chevron ${open ? 'is-open' : ''}`}
            />
          </Collapsible.Trigger>
        {/if}
      </div>
    </div>
    {#if active}
      <Collapsible.Content class="batshit-settings-disclosure-content batshit-settings-subitem-lines">
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label.Label class="batshit-settings-form-label">
                  Default Web Search Provider
                </Label.Label>
                <SettingsInfoMenu ariaLabel={providerInfoAriaLabel}>
                  Inherit uses the Admin global default. DuckDuckGo works with no key.
                  Exa and Perplexity appear after saving keys in API Keys <code>Web Search</code>.
                  These integrations use search APIs, not chat model selection.
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control-group">
              <Select.Root
                type="single"
                value={providerValue as unknown as string}
                onValueChange={(value) => onProviderValueChange(normalizeSelectValue(value))}
                disabled={providerLoading}
              >
                <Select.Trigger class="justify-between">
                  <span class="truncate">{providerLabel}</span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value={providerInheritValue}>
                    {providerInheritLabel}
                  </Select.Item>
                  {#each providerOptions as option}
                    <Select.Item value={option.value}>{option.label}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              {#if providerError}
                <p class="batshit-settings-form-help is-danger">
                  {providerError}
                </p>
              {/if}
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label.Label class="batshit-settings-form-label">Exa Search Type</Label.Label>
                <SettingsInfoMenu ariaLabel={exaInfoAriaLabel}>
                  Used when the resolved provider is Exa.
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Select.Root
                type="single"
                value={exaTypeValue as unknown as string}
                onValueChange={(value) => onExaTypeValueChange(normalizeSelectValue(value))}
              >
                <Select.Trigger class="justify-between">
                  <span class="truncate">{exaTypeLabel}</span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value={exaTypeInheritValue}>
                    {exaTypeInheritLabel}
                  </Select.Item>
                  {#each exaTypeOptions as option}
                    <Select.Item value={option.value}>{option.label}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label.Label class="batshit-settings-form-label">
                  Perplexity Max Tokens/Page
                </Label.Label>
                <SettingsInfoMenu ariaLabel={perplexityInfoAriaLabel}>
                  Used when the resolved provider is Perplexity.
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Select.Root
                type="single"
                value={perplexityValue as unknown as string}
                onValueChange={(value) =>
                  onPerplexityMaxTokensValueChange(normalizeSelectValue(value))}
              >
                <Select.Trigger class="justify-between">
                  <span class="truncate">{perplexityLabel}</span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value={perplexityInheritValue}>
                    {perplexityInheritLabel}
                  </Select.Item>
                  {#each perplexityOptions as option}
                    <Select.Item value={String(option)}>{option}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          </div>
        </div>
      </Collapsible.Content>
    {/if}
  </div>
</Collapsible.Root>
