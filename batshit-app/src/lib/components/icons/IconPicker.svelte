<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Tabs from '$lib/components/ui/tabs'
  import { Button, type ButtonSize, type ButtonVariant } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { DEFAULT_ICON_REF, findCatalogEntry, getIconCatalogEntries, searchIconCatalog } from '$lib/icons/iconCatalog'
  import { iconRefKey } from '$lib/icons/iconTypes'
  import type {
    CustomIconDisplaySettings,
    CustomIconRecord,
    IconCatalogCategory,
    IconCatalogEntry,
    IconLibraryPrefs,
    IconRef
  } from '$lib/icons/iconTypes'
  import { iconLibraryService } from '$lib/services/iconLibraryService'
  import { setCustomIconRecords } from '$lib/stores/iconLibrary.svelte'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import { cn } from '$lib/utils'
  import Clock3 from '@lucide/svelte/icons/clock-3'
  import Check from '@lucide/svelte/icons/check'
  import Download from '@lucide/svelte/icons/download'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Globe2 from '@lucide/svelte/icons/globe-2'
  import Info from '@lucide/svelte/icons/info'
  import Loader2 from '@lucide/svelte/icons/loader-2'
  import Palette from '@lucide/svelte/icons/palette'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Search from '@lucide/svelte/icons/search'
  import Star from '@lucide/svelte/icons/star'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'
  import { toast } from 'svelte-sonner'
  import type { OnlineIconCandidate, OnlineIconProviderId } from '$lib/services/iconLibraryService'

  type PickerTab = IconCatalogCategory | 'custom'
  type PickerMode = 'dialog' | 'inline'

  let {
    value = $bindable<IconRef | null>(DEFAULT_ICON_REF),
    customIcons = null,
    open = false,
    disabled = false,
    triggerLabel = 'Choose Icon',
    triggerVariant = 'outline',
    triggerSize = 'sm',
    triggerClass = '',
    triggerIconClass = 'h-4 w-4 rounded bg-muted/40',
    triggerIconInnerClass = 'h-3.5 w-3.5',
    mode = 'dialog',
    title = 'Choose Icon',
    description = 'Pick a Batshit icon, brand logo, file icon, or uploaded custom icon.',
    onlineSearchHint = '',
    onOpenChange = (_open: boolean) => {},
    onSelect = (_icon: IconRef) => {},
    onUploadRequested = null,
    onCustomIconsChange = (_icons: CustomIconRecord[]) => {}
  }: {
    value?: IconRef | null
    customIcons?: CustomIconRecord[] | null
    open?: boolean
    disabled?: boolean
    triggerLabel?: string
    triggerVariant?: ButtonVariant
    triggerSize?: ButtonSize
    triggerClass?: string
    triggerIconClass?: string
    triggerIconInnerClass?: string
    mode?: PickerMode
    title?: string
    description?: string
    onlineSearchHint?: string
    onOpenChange?: (open: boolean) => void
    onSelect?: (icon: IconRef) => void
    onUploadRequested?: (() => void) | null
    onCustomIconsChange?: (icons: CustomIconRecord[]) => void
  } = $props()

  let query = $state('')
  let activeTab = $state<PickerTab>('general')
  let internalCustomIcons = $state<CustomIconRecord[]>([])
  let customIconsLoaded = $state(false)
  let libraryPrefs = $state<IconLibraryPrefs>({ favorites: [], recents: [] })
  let prefsLoaded = $state(false)
  let librarySnapshotLoading = $state(false)
  let uploading = $state(false)
  let uploadInput = $state<HTMLInputElement | null>(null)
  let onlineMode = $state(false)
  let onlineProviders = $state<OnlineIconProviderId[]>(['lobe-icons', 'simple-icons'])
  let onlineResults = $state<OnlineIconCandidate[]>([])
  let onlineLoading = $state(false)
  let onlineSearched = $state(false)
  let onlineError = $state('')
  let onlineImportingId = $state<string | null>(null)
  let customColorIconId = $state<string | null>(null)
  let customColorValue = $state('#F4F1EA')
  let customColorSaving = $state(false)

  const ONLINE_PROVIDER_OPTIONS: Array<{ id: OnlineIconProviderId; label: string }> = [
    { id: 'lobe-icons', label: 'Lobe' },
    { id: 'simple-icons', label: 'Simple' }
  ]
  const LIGHT_MONO_ICON_HEX = '#F4F1EA'
  const DARK_MONO_ICON_HEX = '#171717'

  const catalogEntries = $derived(getIconCatalogEntries())
  const filteredCatalog = $derived.by(() => searchIconCatalog(query, catalogEntries))
  const isSearching = $derived(query.trim().length > 0)
  const resolvedCustomIcons = $derived(customIcons ?? internalCustomIcons)
  const favoriteRefs = $derived(libraryPrefs.favorites.slice(0, 12))
  const recentRefs = $derived(
    libraryPrefs.recents
      .filter((ref) => !libraryPrefs.favorites.some((favorite) => iconRefKey(favorite) === iconRefKey(ref)))
      .slice(0, 12)
  )
  const filteredCustomIcons = $derived.by(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return resolvedCustomIcons
    return resolvedCustomIcons.filter((icon) => {
      return (
        icon.name.toLowerCase().includes(normalized) ||
        icon.tags.some((tag) => tag.toLowerCase().includes(normalized))
      )
    })
  })
  const searchResultCount = $derived(filteredCatalog.length + filteredCustomIcons.length)
  const isInlineMode = $derived(mode === 'inline')
  const customColorIcon = $derived.by(() => {
    if (!customColorIconId) return null
    return resolvedCustomIcons.find((icon) => icon.id === customColorIconId) ?? null
  })

  function entriesForCategory(category: IconCatalogCategory): IconCatalogEntry[] {
    return filteredCatalog.filter((entry) => entry.category === category)
  }

  function selectIcon(next: IconRef) {
    value = next
    onSelect(next)
    void rememberRecent(next)
    if (!isInlineMode) {
      open = false
      onOpenChange(false)
    }
  }

  function providerEnabled(provider: OnlineIconProviderId) {
    return onlineProviders.includes(provider)
  }

  function toggleOnlineProvider(provider: OnlineIconProviderId) {
    if (providerEnabled(provider)) {
      if (onlineProviders.length === 1) return
      onlineProviders = onlineProviders.filter((entry) => entry !== provider)
    } else {
      onlineProviders = [...onlineProviders, provider]
    }
  }

  function setCustomIconList(nextIcons: CustomIconRecord[]) {
    setCustomIconRecords(nextIcons)
    if (customIcons === null) {
      internalCustomIcons = nextIcons
    }
    onCustomIconsChange(nextIcons)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isInlineMode) return
    open = nextOpen
    onOpenChange(nextOpen)
    if (nextOpen && (!customIconsLoaded || !prefsLoaded)) {
      void loadLibrarySnapshot()
    }
  }

  function isSelected(ref: IconRef) {
    return iconRefKey(value) === iconRefKey(ref)
  }

  function isFavorite(ref: IconRef) {
    const key = iconRefKey(ref)
    return libraryPrefs.favorites.some((entry) => iconRefKey(entry) === key)
  }

  function labelForRef(ref: IconRef) {
    const catalogEntry = findCatalogEntry(ref)
    if (catalogEntry) return catalogEntry.label
    if (ref.kind === 'custom') {
      return resolvedCustomIcons.find((entry) => entry.id === ref.iconId)?.name ?? 'Custom Icon'
    }
    return iconRefKey(ref)
  }

  function compactRefs(refs: IconRef[]) {
    const seen = new Set<string>()
    return refs.filter((ref) => {
      const key = iconRefKey(ref)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async function loadLibrarySnapshot(): Promise<IconLibraryPrefs> {
    if (librarySnapshotLoading) return libraryPrefs
    librarySnapshotLoading = true
    try {
      const snapshot = await iconLibraryService.list()
      setCustomIconList(snapshot.icons)
      libraryPrefs = snapshot.prefs
      customIconsLoaded = true
      prefsLoaded = true
      return snapshot.prefs
    } catch (error) {
      console.error('[IconPicker] Failed to load custom icons:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to load custom icons')
      throw error
    } finally {
      librarySnapshotLoading = false
    }
  }

  async function ensurePrefsLoaded() {
    if (prefsLoaded) return libraryPrefs
    return await loadLibrarySnapshot()
  }

  async function rememberRecent(ref: IconRef) {
    try {
      const currentPrefs = await ensurePrefsLoaded()
      const nextPrefs = await iconLibraryService.addRecent(ref, currentPrefs)
      libraryPrefs = nextPrefs
      prefsLoaded = true
    } catch (error) {
      console.error('[IconPicker] Failed to update recent icons:', error)
    }
  }

  async function toggleFavorite(ref: IconRef) {
    try {
      const currentPrefs = await ensurePrefsLoaded()
      const key = iconRefKey(ref)
      const nextFavorites = isFavorite(ref)
        ? currentPrefs.favorites.filter((entry) => iconRefKey(entry) !== key)
        : [ref, ...currentPrefs.favorites.filter((entry) => iconRefKey(entry) !== key)].slice(0, 40)

      libraryPrefs = await iconLibraryService.updatePrefs({
        ...currentPrefs,
        favorites: nextFavorites
      })
      prefsLoaded = true
    } catch (error) {
      console.error('[IconPicker] Failed to update favorite icons:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to update favorite icons')
    }
  }

  function requestUpload() {
    if (onUploadRequested) {
      onUploadRequested()
      return
    }
    uploadInput?.click()
  }

  async function searchOnline() {
    if (!query.trim() && onlineSearchHint.trim()) {
      query = onlineSearchHint.trim()
    }
    if (!query.trim()) {
      toast.error('Enter an icon name to search online')
      return
    }

    onlineMode = true
    onlineLoading = true
    onlineSearched = true
    onlineError = ''
    try {
      onlineResults = await iconLibraryService.searchOnline({
        query,
        providers: onlineProviders,
        limit: 24
      })
    } catch (error) {
      console.error('[IconPicker] Failed to search online icons:', error)
      onlineResults = []
      onlineError = error instanceof Error ? error.message : 'Failed to search online icons'
      toast.error(onlineError)
    } finally {
      onlineLoading = false
    }
  }

  async function importOnlineIcon(candidate: OnlineIconCandidate, useImmediately: boolean) {
    onlineImportingId = candidate.id
    try {
      const icon = await iconLibraryService.importOnline(candidate)
      setCustomIconList([icon, ...resolvedCustomIcons.filter((entry) => entry.id !== icon.id)])
      customIconsLoaded = true
      const ref = { kind: 'custom', iconId: icon.id } satisfies IconRef

      if (useImmediately) {
        selectIcon(ref)
      } else {
        const currentPrefs = await ensurePrefsLoaded()
        libraryPrefs = await iconLibraryService.addRecent(ref, currentPrefs)
        prefsLoaded = true
        activeTab = 'custom'
        toast.success('Icon downloaded to your library')
      }
    } catch (error) {
      console.error('[IconPicker] Failed to import online icon:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to download icon')
    } finally {
      onlineImportingId = null
    }
  }

  async function handleFileUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    uploading = true
    try {
      const icon = await iconLibraryService.upload(file)
      setCustomIconList([icon, ...resolvedCustomIcons.filter((entry) => entry.id !== icon.id)])
      customIconsLoaded = true
      activeTab = 'custom'
      selectIcon({ kind: 'custom', iconId: icon.id })
      toast.success('Custom icon uploaded')
    } catch (error) {
      console.error('[IconPicker] Failed to upload custom icon:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to upload custom icon')
    } finally {
      uploading = false
    }
  }

  async function renameCustomIcon(icon: CustomIconRecord) {
    const nextName = window.prompt('Rename custom icon', icon.name)?.trim()
    if (!nextName || nextName === icon.name) return

    try {
      const updated = await iconLibraryService.update(icon.id, { name: nextName })
      setCustomIconList(resolvedCustomIcons.map((entry) => (entry.id === icon.id ? updated : entry)))
      toast.success('Custom icon renamed')
    } catch (error) {
      console.error('[IconPicker] Failed to rename custom icon:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to rename custom icon')
    }
  }

  function normalizeHexColor(input: string) {
    const match = input.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
    if (!match) return null
    const raw = match[1]
    const expanded =
      raw.length === 3
        ? raw
            .split('')
            .map((character) => `${character}${character}`)
            .join('')
        : raw
    return `#${expanded.toUpperCase()}`
  }

  function colorSwatchForIcon(icon: CustomIconRecord) {
    const mode = icon.display?.colorMode ?? 'original'
    if (mode === 'brand') return icon.source?.brandHex ?? 'transparent'
    if (mode === 'light') return LIGHT_MONO_ICON_HEX
    if (mode === 'dark') return DARK_MONO_ICON_HEX
    if (mode === 'custom') return icon.display?.customHex ?? 'transparent'
    return icon.source?.brandHex ?? 'transparent'
  }

  function initialCustomHexForIcon(icon: CustomIconRecord) {
    if (icon.display?.colorMode === 'custom') {
      return icon.display.customHex ?? LIGHT_MONO_ICON_HEX
    }
    return icon.source?.brandHex || LIGHT_MONO_ICON_HEX
  }

  function startCustomHexEdit(icon: CustomIconRecord) {
    if (icon.mimeType !== 'image/svg+xml') {
      toast.error('Color overrides are only available for SVG icons')
      return
    }

    customColorIconId = icon.id
    customColorValue = initialCustomHexForIcon(icon)
  }

  function cancelCustomHexEdit() {
    customColorIconId = null
    customColorValue = LIGHT_MONO_ICON_HEX
  }

  async function updateCustomIconColor(icon: CustomIconRecord, display: CustomIconDisplaySettings | null) {
    if (icon.mimeType !== 'image/svg+xml') {
      toast.error('Color overrides are only available for SVG icons')
      return
    }

    try {
      const updated = await iconLibraryService.update(icon.id, { display })
      setCustomIconList(resolvedCustomIcons.map((entry) => (entry.id === icon.id ? updated : entry)))
      toast.success(display?.colorMode === 'original' || display === null ? 'Icon color reset' : 'Icon color updated')
    } catch (error) {
      console.error('[IconPicker] Failed to update custom icon color:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to update icon color')
    }
  }

  async function saveCustomHexColor() {
    if (!customColorIcon) return
    const normalized = normalizeHexColor(customColorValue)
    if (!normalized) {
      toast.error('Enter a valid hex color, like #7C3AED')
      return
    }

    customColorSaving = true
    try {
      await updateCustomIconColor(customColorIcon, { colorMode: 'custom', customHex: normalized })
      customColorIconId = null
      customColorValue = LIGHT_MONO_ICON_HEX
    } finally {
      customColorSaving = false
    }
  }

  async function deleteCustomIcon(icon: CustomIconRecord) {
    const confirmed = await confirmDialog({
      title: `Delete "${icon.name}"?`,
      description: 'This removes the icon from your custom icon library and clears it from favorites and recents.',
      confirmLabel: 'Delete Icon',
      tone: 'destructive'
    })
    if (!confirmed) return

    try {
      await iconLibraryService.delete(icon.id)
      setCustomIconList(resolvedCustomIcons.filter((entry) => entry.id !== icon.id))
      const deletedKey = iconRefKey({ kind: 'custom', iconId: icon.id })
      const currentPrefs = await ensurePrefsLoaded()
      libraryPrefs = await iconLibraryService.updatePrefs({
        favorites: currentPrefs.favorites.filter((entry) => iconRefKey(entry) !== deletedKey),
        recents: currentPrefs.recents.filter((entry) => iconRefKey(entry) !== deletedKey)
      })
      if (iconRefKey(value) === iconRefKey({ kind: 'custom', iconId: icon.id })) {
        value = DEFAULT_ICON_REF
        onSelect(DEFAULT_ICON_REF)
      }
      toast.success('Custom icon deleted')
    } catch (error) {
      console.error('[IconPicker] Failed to delete custom icon:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete custom icon')
    }
  }

  $effect(() => {
    if (!isInlineMode || (customIconsLoaded && prefsLoaded) || librarySnapshotLoading) return
    void loadLibrarySnapshot()
  })
</script>

{#snippet pickerContent()}
  <div class="flex min-h-0 flex-col gap-4">
      <div class="flex gap-2">
        <div class="relative min-w-0 flex-1">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input bind:value={query} placeholder="Search icons, logos, and file types" class="pl-9" />
        </div>
        <Button type="button" variant={onlineMode ? 'default' : 'outline'} onclick={searchOnline} disabled={onlineLoading}>
          {#if onlineLoading}
            <Loader2 class="animate-spin" />
          {:else}
            <Globe2  />
          {/if}
          Find Online
        </Button>
      </div>

      {#if customColorIcon}
        {@const colorRef = { kind: 'custom', iconId: customColorIcon.id } satisfies IconRef}
        <div class="flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 p-3">
          <IconRenderer
            ref={colorRef}
            customIcons={resolvedCustomIcons}
            class="h-10 w-10 rounded-md bg-background"
            iconClass="h-6 w-6"
            label={customColorIcon.name}
          />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">Custom hex</div>
            <div class="truncate text-xs text-muted-foreground">{customColorIcon.name}</div>
          </div>
          <input
            type="color"
            value={normalizeHexColor(customColorValue) ?? LIGHT_MONO_ICON_HEX}
            class="h-8 w-10 shrink-0 cursor-pointer rounded-md border bg-background p-1"
            aria-label="Choose custom icon color"
            onchange={(event) => {
              customColorValue = (event.currentTarget as HTMLInputElement).value.toUpperCase()
            }}
          />
          <Input
            bind:value={customColorValue}
            class="h-8 w-28 font-mono text-xs uppercase"
            placeholder="#7C3AED"
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveCustomHexColor()
              }
            }}
          />
          <Button type="button" size="sm" disabled={customColorSaving} onclick={() => void saveCustomHexColor()}>
            {#if customColorSaving}
              <Loader2 class="animate-spin" />
            {/if}
            Apply
          </Button>
          <Button type="button" variant="ghost" size="icon" onclick={cancelCustomHexEdit}>
            <X  />
          </Button>
        </div>
      {/if}

      {#if onlineMode}
        <div class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              {#each ONLINE_PROVIDER_OPTIONS as provider}
                <Button
                  type="button"
                  variant={providerEnabled(provider.id) ? 'default' : 'outline'}
                  size="sm"
                  onclick={() => toggleOnlineProvider(provider.id)}
                >
                  {provider.label}
                </Button>
              {/each}
              <Button type="button" variant="outline" size="sm" onclick={searchOnline} disabled={onlineLoading || !query.trim()}>
                {#if onlineLoading}
                  <Loader2 class="animate-spin" />
                {:else}
                  <Search  />
                {/if}
                Search
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" onclick={() => (onlineMode = false)}>
              <X  />
              Library
            </Button>
          </div>

          {#if onlineLoading}
            <div class="flex min-h-36 items-center justify-center rounded-md border text-sm text-muted-foreground">
              <Loader2 class="mr-2 h-4 w-4 animate-spin" />
              Searching providers...
            </div>
          {:else if onlineError}
            <div class="flex min-h-36 items-center justify-center rounded-md border border-destructive/40 text-sm text-destructive">
              {onlineError}
            </div>
          {:else if onlineSearched && onlineResults.length === 0}
            <div class="flex min-h-36 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              No online icons found.
            </div>
          {:else}
            <div
              class={cn(
                'grid grid-cols-2 gap-2 pr-1 md:grid-cols-3',
                isInlineMode ? 'overflow-visible' : 'max-h-[500px] overflow-y-auto'
              )}
            >
              {#each onlineResults as candidate}
                <div class="group flex min-h-32 flex-col justify-between gap-3 rounded-md border bg-background p-3 transition hover:bg-accent/70">
                  <div class="flex items-start gap-3">
                    <span
                      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted/40 [&_svg]:h-6 [&_svg]:w-6 [&_svg]:max-h-full [&_svg]:max-w-full"
                    >
                      {#if candidate.previewSvg}
                        {@html candidate.previewSvg}
                      {:else}
                        <Globe2 class="h-5 w-5 text-muted-foreground" />
                      {/if}
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-sm font-medium">{candidate.title}</div>
                      <div class="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                        <span class="rounded border px-1.5 py-0.5">{candidate.providerLabel}</span>
                        {#if candidate.licenseType}
                          <span class="rounded border px-1.5 py-0.5">{candidate.licenseType}</span>
                        {/if}
                        {#if candidate.guidelinesUrl}
                          <a
                            href={candidate.guidelinesUrl}
                            target="_blank"
                            rel="noreferrer"
                            class="inline-flex h-[1.375rem] w-[1.375rem] items-center justify-center rounded border text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title="Brand guidelines"
                            aria-label={`Open ${candidate.title} brand guidelines`}
                          >
                            <Info class="h-3 w-3" aria-hidden="true" />
                          </a>
                        {/if}
                      </div>
                      <div class="mt-1 truncate text-[11px] text-muted-foreground">{candidate.slug}</div>
                    </div>
                  </div>

                  <div class="flex items-center justify-between gap-2">
                    <div class="flex items-center gap-1">
                      {#if candidate.sourceUrl}
                        <Button type="button" variant="ghost" size="icon" href={candidate.sourceUrl} target="_blank">
                          <ExternalLink  />
                        </Button>
                      {/if}
                    </div>
                    <div class="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={onlineImportingId === candidate.id}
                        onclick={() => importOnlineIcon(candidate, false)}
                      >
                        {#if onlineImportingId === candidate.id}
                          <Loader2 class="animate-spin" />
                        {:else}
                          <Download  />
                        {/if}
                        Download
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={onlineImportingId === candidate.id}
                        onclick={() => importOnlineIcon(candidate, true)}
                      >
                        <Check aria-hidden="true" />

                        Use
                      </Button>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if !isSearching && (favoriteRefs.length > 0 || recentRefs.length > 0)}
        <div
          class={cn(
            'grid gap-3',
            isInlineMode || favoriteRefs.length === 0 || recentRefs.length === 0 ? 'grid-cols-1' : 'md:grid-cols-2'
          )}
        >
          {#if favoriteRefs.length > 0}
            <section class="min-w-0 rounded-md border bg-muted/20 p-3">
              <div class="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Star class="h-3.5 w-3.5 fill-current" />
                Favorites
              </div>
              <div class="flex gap-2 overflow-x-auto pb-1">
                {#each compactRefs(favoriteRefs) as ref}
                  <button
                    type="button"
                    class={cn(
                      'flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-background transition hover:bg-accent',
                      isSelected(ref) && 'border-primary bg-primary/10'
                    )}
                    title={labelForRef(ref)}
                    onclick={() => selectIcon(ref)}
                  >
                    <IconRenderer
                      {ref}
                      customIcons={resolvedCustomIcons}
                      class="h-8 w-8 rounded-md bg-muted/40"
                      iconClass="h-5 w-5"
                      label={labelForRef(ref)}
                    />
                  </button>
                {/each}
              </div>
            </section>
          {/if}

          {#if recentRefs.length > 0}
            <section class="min-w-0 rounded-md border bg-muted/20 p-3">
              <div class="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Clock3 class="h-3.5 w-3.5" />
                Recent
              </div>
              <div class="flex gap-2 overflow-x-auto pb-1">
                {#each compactRefs(recentRefs) as ref}
                  <button
                    type="button"
                    class={cn(
                      'flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-background transition hover:bg-accent',
                      isSelected(ref) && 'border-primary bg-primary/10'
                    )}
                    title={labelForRef(ref)}
                    onclick={() => selectIcon(ref)}
                  >
                    <IconRenderer
                      {ref}
                      customIcons={resolvedCustomIcons}
                      class="h-8 w-8 rounded-md bg-muted/40"
                      iconClass="h-5 w-5"
                      label={labelForRef(ref)}
                    />
                  </button>
                {/each}
              </div>
            </section>
          {/if}
        </div>
      {/if}

      {#if isSearching}
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <p>{searchResultCount} {searchResultCount === 1 ? 'result' : 'results'}</p>
          </div>

          {#if searchResultCount === 0}
            <div class="flex min-h-36 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              No icons found.
            </div>
          {:else}
            <div
              class={cn(
                'grid grid-cols-4 gap-2 pr-1 sm:grid-cols-5 md:grid-cols-6',
                isInlineMode ? 'overflow-visible' : 'max-h-[500px] overflow-y-auto'
              )}
            >
              {#each filteredCatalog as entry}
                <div
                  class={cn(
                    'group relative flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border bg-background p-2 text-center transition hover:bg-accent',
                    isSelected(entry.ref) && 'border-primary bg-primary/10'
                  )}
                >
                  <button
                    type="button"
                    class="flex w-full flex-1 flex-col items-center justify-center gap-2"
                    onclick={() => selectIcon(entry.ref)}
                  >
                    <IconRenderer
                      ref={entry.ref}
                      class="h-9 w-9 rounded-md bg-muted/40"
                      iconClass="h-5 w-5"
                      label={entry.label}
                    />
                    <span class="line-clamp-2 text-xs leading-tight text-muted-foreground group-hover:text-foreground">
                      {entry.label}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    class={cn(
                      'absolute right-1 top-1 h-6 w-6 opacity-0 transition group-hover:opacity-100',
                      isFavorite(entry.ref) && 'opacity-100 text-amber-400 hover:text-amber-400'
                    )}
                    title={isFavorite(entry.ref) ? 'Remove favorite' : 'Add favorite'}
                    onclick={() => toggleFavorite(entry.ref)}
                  >
                    <Star class={cn('h-3.5 w-3.5', isFavorite(entry.ref) && 'fill-current')} />
                  </Button>
                </div>
              {/each}

              {#each filteredCustomIcons as icon}
                {@const ref = { kind: 'custom', iconId: icon.id } satisfies IconRef}
                <div
                  class={cn(
                    'group flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border bg-background p-2 text-center transition hover:bg-accent',
                    isSelected(ref) && 'border-primary bg-primary/10'
                  )}
                >
                  <button
                    type="button"
                    class="flex w-full flex-1 flex-col items-center justify-center gap-2"
                    onclick={() => selectIcon(ref)}
                  >
                    <IconRenderer
                      ref={ref}
                      customIcons={resolvedCustomIcons}
                      class="h-9 w-9 rounded-md bg-muted/40"
                      iconClass="h-5 w-5"
                      label={icon.name}
                    />
                    <span class="line-clamp-2 text-xs leading-tight text-muted-foreground group-hover:text-foreground">
                      {icon.name}
                    </span>
                  </button>
                  <div class="flex items-center justify-center gap-1 opacity-70 transition group-hover:opacity-100">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      class={cn('h-6 w-6', isFavorite(ref) && 'text-amber-400 hover:text-amber-400')}
                      title={isFavorite(ref) ? 'Remove favorite' : 'Add favorite'}
                      onclick={() => toggleFavorite(ref)}
                    >
                      <Star class={cn('h-3.5 w-3.5', isFavorite(ref) && 'fill-current')} />
                    </Button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger
                        class="relative inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                        title="Set custom icon color"
                        disabled={icon.mimeType !== 'image/svg+xml'}
                      >
                        <Palette class="h-3.5 w-3.5" />
                        <span
                          class="absolute bottom-0 right-0 h-2 w-2 rounded-full border border-background"
                          style:background-color={colorSwatchForIcon(icon)}
                        ></span>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end" class="w-48">
                        <DropdownMenu.Label>Icon color</DropdownMenu.Label>
                        <DropdownMenu.Item onSelect={() => updateCustomIconColor(icon, { colorMode: 'original' })}>
                          Original SVG
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          disabled={!icon.source?.brandHex}
                          onSelect={() => updateCustomIconColor(icon, { colorMode: 'brand' })}
                        >
                          <span
                            class="mr-2 h-2.5 w-2.5 rounded-full border"
                            style:background-color={icon.source?.brandHex ?? 'transparent'}
                          ></span>
                          Brand color
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => updateCustomIconColor(icon, { colorMode: 'light' })}>
                          <span
                            class="mr-2 h-2.5 w-2.5 rounded-full border"
                            style:background-color={LIGHT_MONO_ICON_HEX}
                          ></span>
                          Light mono
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => updateCustomIconColor(icon, { colorMode: 'dark' })}>
                          <span
                            class="mr-2 h-2.5 w-2.5 rounded-full border"
                            style:background-color={DARK_MONO_ICON_HEX}
                          ></span>
                          Dark mono
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item onSelect={() => startCustomHexEdit(icon)}>Custom hex...</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"

                      title="Rename custom icon"
                      onclick={() => renameCustomIcon(icon)}
                    >
                      <Pencil  />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"

                      title="Delete custom icon"
                      onclick={() => deleteCustomIcon(icon)}
                    >
                      <Trash2  />
                    </Button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <Tabs.Root bind:value={activeTab} class="min-h-0">
        <Tabs.List class="grid w-full grid-cols-5">
          <Tabs.Trigger value="general">General</Tabs.Trigger>
          <Tabs.Trigger value="brand">Logos</Tabs.Trigger>
          <Tabs.Trigger value="fileType">Files</Tabs.Trigger>
          <Tabs.Trigger value="batshit">Batshit</Tabs.Trigger>
          <Tabs.Trigger value="custom">Custom</Tabs.Trigger>
        </Tabs.List>

        {#each ['general', 'brand', 'fileType', 'batshit'] as category}
          <Tabs.Content value={category} class="mt-3">
            <div
              class={cn(
                'grid grid-cols-4 gap-2 pr-1 sm:grid-cols-5 md:grid-cols-6',
                isInlineMode ? 'overflow-visible' : 'max-h-[420px] overflow-y-auto'
              )}
            >
              {#each entriesForCategory(category as IconCatalogCategory) as entry}
                <div
                  class={cn(
                    'group relative flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border bg-background p-2 text-center transition hover:bg-accent',
                    isSelected(entry.ref) && 'border-primary bg-primary/10'
                  )}
                >
                  <button
                    type="button"
                    class="flex w-full flex-1 flex-col items-center justify-center gap-2"
                    onclick={() => selectIcon(entry.ref)}
                  >
                    <IconRenderer
                      ref={entry.ref}
                      class="h-9 w-9 rounded-md bg-muted/40"
                      iconClass="h-5 w-5"
                      label={entry.label}
                    />
                    <span class="line-clamp-2 text-xs leading-tight text-muted-foreground group-hover:text-foreground">
                      {entry.label}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    class={cn(
                      'absolute right-1 top-1 h-6 w-6 opacity-0 transition group-hover:opacity-100',
                      isFavorite(entry.ref) && 'opacity-100 text-amber-400 hover:text-amber-400'
                    )}
                    title={isFavorite(entry.ref) ? 'Remove favorite' : 'Add favorite'}
                    onclick={() => toggleFavorite(entry.ref)}
                  >
                    <Star class={cn('h-3.5 w-3.5', isFavorite(entry.ref) && 'fill-current')} />
                  </Button>
                </div>
              {/each}
            </div>
          </Tabs.Content>
        {/each}

        <Tabs.Content value="custom" class="mt-3">
          <div class="mb-3 flex items-center justify-between gap-3">
            <p class="text-sm text-muted-foreground">
              Uploaded SVG and PNG icons can be reused anywhere assignable icons are supported.
            </p>
            {#if onUploadRequested || customIcons === null}
              <Button type="button" variant="outline" size="sm" disabled={uploading} onclick={requestUpload}>
                <Upload  />
                {uploading ? 'Uploading' : 'Upload'}
              </Button>
            {/if}
            {#if customIcons === null}
              <input
                bind:this={uploadInput}
                type="file"
                accept=".svg,.png,image/svg+xml,image/png"
                class="hidden"
                onchange={handleFileUpload}
              />
            {/if}
          </div>
          {#if filteredCustomIcons.length === 0}
            <div class="flex min-h-36 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              No custom icons yet.
            </div>
          {:else}
            <div
              class={cn(
                'grid grid-cols-4 gap-2 pr-1 sm:grid-cols-5 md:grid-cols-6',
                isInlineMode ? 'overflow-visible' : 'max-h-[380px] overflow-y-auto'
              )}
            >
              {#each filteredCustomIcons as icon}
                {@const ref = { kind: 'custom', iconId: icon.id } satisfies IconRef}
                <div
                  class={cn(
                    'group flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border bg-background p-2 text-center transition hover:bg-accent',
                    isSelected(ref) && 'border-primary bg-primary/10'
                  )}
                >
                  <button
                    type="button"
                    class="flex w-full flex-1 flex-col items-center justify-center gap-2"
                    onclick={() => selectIcon(ref)}
                  >
                    <IconRenderer
                      ref={ref}
                      customIcons={resolvedCustomIcons}
                      class="h-9 w-9 rounded-md bg-muted/40"
                      iconClass="h-5 w-5"
                      label={icon.name}
                    />
                    <span class="line-clamp-2 text-xs leading-tight text-muted-foreground group-hover:text-foreground">
                      {icon.name}
                    </span>
                  </button>
                  <div class="flex items-center justify-center gap-1 opacity-70 transition group-hover:opacity-100">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      class={cn('h-6 w-6', isFavorite(ref) && 'text-amber-400 hover:text-amber-400')}
                      title={isFavorite(ref) ? 'Remove favorite' : 'Add favorite'}
                      onclick={() => toggleFavorite(ref)}
                    >
                      <Star class={cn('h-3.5 w-3.5', isFavorite(ref) && 'fill-current')} />
                    </Button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger
                        class="relative inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                        title="Set custom icon color"
                        disabled={icon.mimeType !== 'image/svg+xml'}
                      >
                        <Palette class="h-3.5 w-3.5" />
                        <span
                          class="absolute bottom-0 right-0 h-2 w-2 rounded-full border border-background"
                          style:background-color={colorSwatchForIcon(icon)}
                        ></span>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end" class="w-48">
                        <DropdownMenu.Label>Icon color</DropdownMenu.Label>
                        <DropdownMenu.Item onSelect={() => updateCustomIconColor(icon, { colorMode: 'original' })}>
                          Original SVG
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          disabled={!icon.source?.brandHex}
                          onSelect={() => updateCustomIconColor(icon, { colorMode: 'brand' })}
                        >
                          <span
                            class="mr-2 h-2.5 w-2.5 rounded-full border"
                            style:background-color={icon.source?.brandHex ?? 'transparent'}
                          ></span>
                          Brand color
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => updateCustomIconColor(icon, { colorMode: 'light' })}>
                          <span
                            class="mr-2 h-2.5 w-2.5 rounded-full border"
                            style:background-color={LIGHT_MONO_ICON_HEX}
                          ></span>
                          Light mono
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => updateCustomIconColor(icon, { colorMode: 'dark' })}>
                          <span
                            class="mr-2 h-2.5 w-2.5 rounded-full border"
                            style:background-color={DARK_MONO_ICON_HEX}
                          ></span>
                          Dark mono
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item onSelect={() => startCustomHexEdit(icon)}>Custom hex...</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"

                      title="Rename custom icon"
                      onclick={() => renameCustomIcon(icon)}
                    >
                      <Pencil  />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"

                      title="Delete custom icon"
                      onclick={() => deleteCustomIcon(icon)}
                    >
                      <Trash2  />
                    </Button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </Tabs.Content>
        </Tabs.Root>
      {/if}
  </div>
{/snippet}

{#if isInlineMode}
  <section class="flex min-h-0 flex-col gap-4">
    {#if title || description}
      <div class="space-y-1">
        {#if title}
          <h2 class="batshit-settings-panel-title">{title}</h2>
        {/if}
        {#if description}
          <p class="batshit-settings-caption">{description}</p>
        {/if}
      </div>
    {/if}
    {@render pickerContent()}
  </section>
{:else}
  <Dialog.Root {open} onOpenChange={handleOpenChange}>
    <Button
      type="button"
      variant={triggerVariant}
      size={triggerSize}
      {disabled}
      class={cn('justify-start', triggerClass)}
      onclick={() => handleOpenChange(true)}
    >
      <IconRenderer
        ref={value}
        customIcons={resolvedCustomIcons}
        class={triggerIconClass}
        iconClass={triggerIconInnerClass}
      />
      <span>{triggerLabel}</span>
    </Button>
    <Dialog.Content class="batshit-settings-dialog sm:max-w-[860px] max-h-[88vh] overflow-hidden">
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
        {#if description}
          <Dialog.Description>
            {description}
          </Dialog.Description>
        {/if}
      </Dialog.Header>

      {@render pickerContent()}
    </Dialog.Content>
  </Dialog.Root>
{/if}
