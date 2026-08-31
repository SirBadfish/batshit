<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import Mic from '@lucide/svelte/icons/mic'
  import Radio from '@lucide/svelte/icons/radio'
  import { themeStore } from '$lib/stores/theme'
  import { getProviderIconEntry, needsDarkModeInvert } from '$lib/utils/brandingIcons'

  let {
    providerId = null,
    label = 'Provider',
    class: className = 'h-4 w-4',
    fallback = null
  }: {
    providerId?: string | null
    label?: string
    class?: string
    fallback?: 'tts' | 'stt' | 'runtime' | null
  } = $props()

  const brandingProviderId = $derived(providerId === 'google' ? 'google-gemini' : providerId)
  const iconEntry = $derived(
    brandingProviderId ? getProviderIconEntry(brandingProviderId, $themeStore) : null
  )
  const iconFilter = $derived(
    iconEntry?.slug && needsDarkModeInvert(iconEntry.icon) && $themeStore === 'dark'
      ? 'brightness(0) invert(1)'
      : null
  )
</script>

{#if iconEntry?.slug}
  <img
    src={iconEntry.icon}
    alt=""
    aria-hidden="true"
    title={label}
    class={`${className} shrink-0 object-contain`}
    style:filter={iconFilter}
  />
{:else if fallback === 'tts'}
  <AudioLines class={className} aria-hidden="true" />
{:else if fallback === 'stt'}
  <Mic class={className} aria-hidden="true" />
{:else if fallback === 'runtime'}
  <Radio class={className} aria-hidden="true" />
{/if}
