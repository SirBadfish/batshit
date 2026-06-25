<script lang="ts">
  import { Search } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import { Badge } from '$lib/components/ui/badge'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    EXA_SEARCH_TYPE_LABELS,
    WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS,
    WEB_SEARCH_PROVIDER_LABELS,
    clampNumber,
    normalizeExaSearchType,
    type ExaSearchType,
    type NativeWebSearchProvider
  } from './adminSettingsTypes'

  type SelectValue = string | string[] | null | undefined

  interface Props {
    defaultProvider: NativeWebSearchProvider
    exaType: ExaSearchType
    perplexityMaxTokensPerPage: number
    providerOptions: Array<{ value: NativeWebSearchProvider; label: string }>
    providerAvailability: Record<'exa' | 'perplexity', boolean>
    loadingProviders: boolean
    providerError: string | null
    disabled: boolean
    onProviderChange: (provider: NativeWebSearchProvider) => void
    onExaTypeChange: (exaType: ExaSearchType) => void
    onPerplexityMaxTokensPerPageChange: (tokens: number) => void
  }

  let {
    defaultProvider,
    exaType,
    perplexityMaxTokensPerPage,
    providerOptions,
    providerAvailability,
    loadingProviders,
    providerError,
    disabled,
    onProviderChange,
    onExaTypeChange,
    onPerplexityMaxTokensPerPageChange
  }: Props = $props()

  function normalizeSelectValue(value: SelectValue) {
    return Array.isArray(value) ? value[0] : (value ?? '')
  }

  function normalizeProviderValue(value: string): NativeWebSearchProvider {
    return value === 'exa' || value === 'perplexity' ? value : 'duckduckgo-html'
  }
</script>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Web Search"
  icon={Search}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Web Search Defaults" contentClass="w-80">
      <p>
        Choose the global defaults for Batshit's native web search tool. Agents can inherit these or
        override them in Agent Settings.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="web-search-default-provider">
            Global Default Web Search Provider
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Global Default Web Search Provider" contentClass="w-80">
            <p>
              DuckDuckGo is always available. Exa and Perplexity appear here after their API keys
              are saved in Settings -> API Keys.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <div class="batshit-settings-form-control-group">
          <Select.Root
            type="single"
            value={defaultProvider as unknown as string}
            onValueChange={(value) => onProviderChange(normalizeProviderValue(normalizeSelectValue(value)))}
            disabled={disabled || loadingProviders}
          >
            <Select.Trigger id="web-search-default-provider" class="w-full">
              <span class="truncate">{WEB_SEARCH_PROVIDER_LABELS[defaultProvider]}</span>
            </Select.Trigger>
            <Select.Content>
              {#each providerOptions as option}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <div class="batshit-settings-form-meta">
            <Badge variant="outline">
              Exa {providerAvailability.exa ? 'Ready' : 'Needs Key'}
            </Badge>
            <Badge variant="outline">
              Perplexity {providerAvailability.perplexity ? 'Ready' : 'Needs Key'}
            </Badge>
          </div>
        </div>
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label" for="web-search-exa-type">
            Default Exa Search Type
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Default Exa Search Type">
            <p>Choose the default search depth Batshit requests when the Exa provider is used.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root
          type="single"
          value={exaType as unknown as string}
          onValueChange={(value) => onExaTypeChange(normalizeExaSearchType(normalizeSelectValue(value)))}
          disabled={disabled}
        >
          <Select.Trigger id="web-search-exa-type" class="w-full">
            <span class="truncate">{EXA_SEARCH_TYPE_LABELS[exaType]}</span>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="auto">{EXA_SEARCH_TYPE_LABELS.auto}</Select.Item>
            <Select.Item value="fast">{EXA_SEARCH_TYPE_LABELS.fast}</Select.Item>
            <Select.Item value="neural">{EXA_SEARCH_TYPE_LABELS.neural}</Select.Item>
            <Select.Item value="deep">{EXA_SEARCH_TYPE_LABELS.deep}</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root
            class="batshit-settings-form-label"
            for="web-search-perplexity-max-tokens-per-page"
          >
            Default Perplexity Max Tokens/Page
          </Label.Root>
          <SettingsInfoMenu ariaLabel="About Default Perplexity Max Tokens Per Page">
            <p>Controls how much text Batshit asks Perplexity to return per fetched page.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root
          type="single"
          value={String(perplexityMaxTokensPerPage)}
          onValueChange={(value) =>
            onPerplexityMaxTokensPerPageChange(
              clampNumber(
                normalizeSelectValue(value),
                WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS[0],
                WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS[
                  WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS.length - 1
                ]
              )
            )}
          disabled={disabled}
        >
          <Select.Trigger id="web-search-perplexity-max-tokens-per-page" class="w-full">
            <span class="truncate">{perplexityMaxTokensPerPage}</span>
          </Select.Trigger>
          <Select.Content>
            {#each WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS as option}
              <Select.Item value={String(option)}>{option}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    </div>
  </div>
  {#if providerError}
    <p class="batshit-settings-form-help is-danger">{providerError}</p>
  {/if}
</SettingsAccordionCard>
