<script lang="ts">
  import { getBrandIconPath, getFileTypeIconPath, normalizeFileTypeIconId } from '$lib/icons/iconCatalog'
  import { getLucideIconComponent } from '$lib/icons/lucideIconRegistry'
  import type { CustomIconRecord, IconRef } from '$lib/icons/iconTypes'
  import {
    areCustomIconRecordsLoaded,
    ensureCustomIconRecordsLoaded,
    getCustomIconRecords
  } from '$lib/stores/iconLibrary.svelte'
  import { themeStore } from '$lib/stores/theme'
  import { cn } from '$lib/utils'
  import { needsDarkModeInvert } from '$lib/utils/brandingIcons'
  import BatshitIcon from './BatshitIcon.svelte'
  import FileText from '@lucide/svelte/icons/file-text'

  let {
    ref,
    customIcons = [],
    label = '',
    class: className = '',
    iconClass = 'h-4 w-4',
    imageClass = 'object-contain',
    autoLoadCustomIcons = true,
    forceDarkModeInvert = false
  }: {
    ref?: IconRef | null
    customIcons?: CustomIconRecord[]
    label?: string
    class?: string
    iconClass?: string
    imageClass?: string
    autoLoadCustomIcons?: boolean
    forceDarkModeInvert?: boolean
  } = $props()

  const resolvedCustomIcons = $derived(customIcons.length > 0 ? customIcons : getCustomIconRecords())
  const customIconRecordsLoaded = $derived(customIcons.length > 0 || areCustomIconRecordsLoaded())

  const customIcon = $derived.by(() => {
    if (ref?.kind !== 'custom') return null
    return resolvedCustomIcons.find((entry) => entry.id === ref.iconId) ?? null
  })

  const customIconPath = $derived.by(() => {
    if (ref?.kind !== 'custom') return null
    if (!customIcon && customIconRecordsLoaded) return null
    const path = customIcon?.path ?? `/api/icons/custom/${ref.iconId}`
    if (!customIcon?.updatedAt) return path
    return `${path}?v=${encodeURIComponent(customIcon.updatedAt)}`
  })

  const brandPath = $derived.by(() => {
    if (ref?.kind !== 'brand') return null
    return getBrandIconPath(ref.slug)
  })

  const brandFilter = $derived(
    brandPath && needsDarkModeInvert(brandPath) && (forceDarkModeInvert || $themeStore === 'dark')
      ? 'brightness(0) invert(1)'
      : null
  )

  const customFilter = $derived(
    forceDarkModeInvert && ref?.kind === 'custom' ? 'brightness(1.35) saturate(1.18)' : null
  )

  const fileTypePath = $derived.by(() => {
    if (ref?.kind !== 'fileType') return null
    return getFileTypeIconPath(ref.id)
  })

  const lucideId = $derived.by(() => {
    if (!ref) return 'sparkles'
    if (ref.kind === 'lucide') return ref.id
    if (ref.kind === 'fileType') return normalizeFileTypeIconId(ref.id)
    return 'sparkles'
  })

  const LucideComponent = $derived.by(() => getLucideIconComponent(lucideId))

  const title = $derived(label || customIcon?.name || '')

  $effect(() => {
    if (!autoLoadCustomIcons || ref?.kind !== 'custom' || resolvedCustomIcons.length > 0) return
    void ensureCustomIconRecordsLoaded().catch((error) => {
      console.error('[IconRenderer] Failed to load custom icons:', error)
    })
  })
</script>

<span class={cn('inline-flex items-center justify-center overflow-hidden', className)} title={title || undefined}>
  {#if ref?.kind === 'brand' && brandPath}
    <img src={brandPath} alt={title} class={cn(imageClass, iconClass)} style:filter={brandFilter} />
  {:else if ref?.kind === 'custom' && customIconPath}
    <img src={customIconPath} alt={title} class={cn(imageClass, iconClass)} style:filter={customFilter} />
  {:else if ref?.kind === 'fileType' && fileTypePath}
    <img src={fileTypePath} alt={title} class={cn(imageClass, iconClass)} />
  {:else if ref?.kind === 'batshit'}
    <BatshitIcon id={ref.id} title={title} class={iconClass} />
  {:else if ref?.kind === 'lucide' || ref?.kind === 'fileType'}
    <LucideComponent class={iconClass} aria-hidden="true" />
  {:else}
    <FileText class={iconClass} aria-hidden="true" />
  {/if}
</span>
