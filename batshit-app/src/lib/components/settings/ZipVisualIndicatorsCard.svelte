<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import * as Label from '$lib/components/ui/label'
  import * as Switch from '$lib/components/ui/switch'
  import { Separator } from '$lib/components/ui/separator'
  import { Eye, Loader2 } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import type { UserSettingsRow } from '$lib/types/database'

  const SAVE_DEBOUNCE_MS = 500

  type VisualSettings = {
    showZippedBadges: boolean
    zippedBadgesHoverOnly: boolean
    showZippedBorders: boolean
    zippedBordersHoverOnly: boolean
    showUnzippedBadges: boolean
    unzippedBadgesHoverOnly: boolean
    showUnzippedBorders: boolean
    unzippedBordersHoverOnly: boolean
  }

  type PanelData = {
    user?: { id: string } | null
    userSettings?: UserSettingsRow | null
  } | null

  interface Props {
    data?: PanelData
  }

  let { data = null }: Props = $props()

  const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
    showZippedBadges: true,
    zippedBadgesHoverOnly: false,
    showZippedBorders: true,
    zippedBordersHoverOnly: true,
    showUnzippedBadges: true,
    unzippedBadgesHoverOnly: false,
    showUnzippedBorders: true,
    unzippedBordersHoverOnly: true
  }

  const userId = $derived(data?.user?.id ?? null)

  let visualSettings = $state<VisualSettings>({ ...DEFAULT_VISUAL_SETTINGS })
  let isLoading = $state(true)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let persistedSignature = $state(makeSignature(DEFAULT_VISUAL_SETTINGS))

  onMount(async () => {
    if (!userId) {
      isLoading = false
      return
    }
    await loadSettings()
  })

  const debouncedSave = debounce(async (payload: Record<string, unknown>) => {
    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save visual indicator settings')
        throw new Error(message)
      }

      const result = await response.json()
      const updated: UserSettingsRow | null = result?.settings ?? null

      untrack(() => {
        persistedSignature = makeSignature(visualSettings)
        saveState = 'saved'
        saveError = null
      })

      if (updated) {
        setUserSettings(updated)
      }
    } catch (error) {
      console.error('Zip visual indicator save failed:', error)
      untrack(() => {
        saveState = 'idle'
        saveError =
          error instanceof Error ? error.message : 'Failed to save visual indicator settings'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (saveState === 'saved') {
            saveState = 'idle'
          }
        })
      }, 1800)
    }
  }, SAVE_DEBOUNCE_MS)

  $effect(() => {
    if (isLoading || !userId) return

    const signature = makeSignature(visualSettings)
    if (signature === persistedSignature) {
      return
    }

    saveState = 'saving'
    saveError = null

    debouncedSave({
      show_zipped_badges: visualSettings.showZippedBadges,
      zipped_badges_hover_only: visualSettings.zippedBadgesHoverOnly,
      show_zipped_borders: visualSettings.showZippedBorders,
      zipped_borders_hover_only: visualSettings.zippedBordersHoverOnly,
      show_unzipped_badges: visualSettings.showUnzippedBadges,
      unzipped_badges_hover_only: visualSettings.unzippedBadgesHoverOnly,
      show_unzipped_borders: visualSettings.showUnzippedBorders,
      unzipped_borders_hover_only: visualSettings.unzippedBordersHoverOnly,
      updated_at: new Date().toISOString()
    })
  })

  async function loadSettings() {
    try {
      const response = await fetch('/api/user/settings')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load visual indicator settings')
        throw new Error(message)
      }

      const result = await response.json()
      const remoteSettings: UserSettingsRow | null = result?.settings ?? null
      applySettings(remoteSettings ?? data?.userSettings ?? null)

      if (remoteSettings) {
        setUserSettings(remoteSettings)
      }
    } catch (error) {
      console.error('Zip visual indicator load failed:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to load visual indicator settings')
      applySettings(data?.userSettings ?? null)
      untrack(() => {
        saveError =
          error instanceof Error ? error.message : 'Failed to load visual indicator settings'
      })
    } finally {
      untrack(() => {
        isLoading = false
        persistedSignature = makeSignature(visualSettings)
      })
    }
  }

  function applySettings(settings: UserSettingsRow | null) {
    const next: VisualSettings = {
      ...DEFAULT_VISUAL_SETTINGS,
      showZippedBadges: settings?.show_zipped_badges ?? DEFAULT_VISUAL_SETTINGS.showZippedBadges,
      zippedBadgesHoverOnly:
        settings?.zipped_badges_hover_only ?? DEFAULT_VISUAL_SETTINGS.zippedBadgesHoverOnly,
      showZippedBorders:
        settings?.show_zipped_borders ?? DEFAULT_VISUAL_SETTINGS.showZippedBorders,
      zippedBordersHoverOnly:
        settings?.zipped_borders_hover_only ?? DEFAULT_VISUAL_SETTINGS.zippedBordersHoverOnly,
      showUnzippedBadges:
        settings?.show_unzipped_badges ?? DEFAULT_VISUAL_SETTINGS.showUnzippedBadges,
      unzippedBadgesHoverOnly:
        settings?.unzipped_badges_hover_only ?? DEFAULT_VISUAL_SETTINGS.unzippedBadgesHoverOnly,
      showUnzippedBorders:
        settings?.show_unzipped_borders ?? DEFAULT_VISUAL_SETTINGS.showUnzippedBorders,
      unzippedBordersHoverOnly:
        settings?.unzipped_borders_hover_only ?? DEFAULT_VISUAL_SETTINGS.unzippedBordersHoverOnly
    }

    untrack(() => {
      visualSettings = next
    })
  }

  function makeSignature(visual: VisualSettings) {
    return JSON.stringify({ visual })
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const payload = await response.json()
      return payload?.error || payload?.message || fallback
    } catch {
      return fallback
    }
  }
</script>

{#if !userId}
  <div class="batshit-settings-group batshit-settings-caption">
    Sign in to edit zip visual indicator settings.
  </div>
{:else if isLoading}
  <div class="batshit-settings-group batshit-settings-caption flex items-center gap-2">
    <Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
    <span>Loading zip visual indicator settings...</span>
  </div>
{:else}
  <SettingsAccordionCard
    name="zip-options-cards"
    title="Visual Indicators"
    icon={Eye}
    contentClass="space-y-6"
    open
  >
    {#snippet info()}
        <SettingsInfoMenu ariaLabel="About Visual Indicators" contentClass="w-96">
          <p>
            Control how zipped and manually expanded content looks in chat.
          </p>
          <p class="mt-2">
            These settings only change visuals. They do not change what tools can run or what the
            model receives.
          </p>
        </SettingsInfoMenu>
    {/snippet}
    {#snippet actions()}
      <SettingsSaveStatus
        state={saveError ? 'error' : saveState}
        error={saveError}
        savingLabel="Saving visual settings..."
        savedLabel="Saved"
        sticky={false}
      />
    {/snippet}
      <div class="space-y-4">
        <p class="batshit-settings-section-title">Zipped Content (compressed)</p>
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-toggle-row is-spine-toggle">
            <Label.Root class="batshit-settings-parent-label">Show Token Badges</Label.Root>
            <Switch.Root bind:checked={visualSettings.showZippedBadges} />
          </div>
          <div class="batshit-settings-toggle-row is-child is-spine-toggle">
            <Label.Root class={`batshit-settings-child-label ${visualSettings.showZippedBadges ? '' : 'is-disabled'}`}>
              Only on Hover
            </Label.Root>
            <Switch.Root
              bind:checked={visualSettings.zippedBadgesHoverOnly}
              disabled={!visualSettings.showZippedBadges}
            />
          </div>
          <div class="batshit-settings-toggle-row is-spine-toggle">
            <Label.Root class="batshit-settings-parent-label">Show Red Borders</Label.Root>
            <Switch.Root bind:checked={visualSettings.showZippedBorders} />
          </div>
          <div class="batshit-settings-toggle-row is-child is-spine-toggle">
            <Label.Root class={`batshit-settings-child-label ${visualSettings.showZippedBorders ? '' : 'is-disabled'}`}>
              Only on Hover
            </Label.Root>
            <Switch.Root
              bind:checked={visualSettings.zippedBordersHoverOnly}
              disabled={!visualSettings.showZippedBorders}
            />
          </div>
        </div>
      </div>

      <Separator />

      <div class="space-y-4">
        <p class="batshit-settings-section-title">Unzipped Content (manually expanded)</p>
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-toggle-row is-spine-toggle">
            <Label.Root class="batshit-settings-parent-label">Show Badges</Label.Root>
            <Switch.Root bind:checked={visualSettings.showUnzippedBadges} />
          </div>
          <div class="batshit-settings-toggle-row is-child is-spine-toggle">
            <Label.Root class={`batshit-settings-child-label ${visualSettings.showUnzippedBadges ? '' : 'is-disabled'}`}>
              Only on Hover
            </Label.Root>
            <Switch.Root
              bind:checked={visualSettings.unzippedBadgesHoverOnly}
              disabled={!visualSettings.showUnzippedBadges}
            />
          </div>
          <div class="batshit-settings-toggle-row is-spine-toggle">
            <Label.Root class="batshit-settings-parent-label">Show Borders</Label.Root>
            <Switch.Root bind:checked={visualSettings.showUnzippedBorders} />
          </div>
          <div class="batshit-settings-toggle-row is-child is-spine-toggle">
            <Label.Root class={`batshit-settings-child-label ${visualSettings.showUnzippedBorders ? '' : 'is-disabled'}`}>
              Only on Hover
            </Label.Root>
            <Switch.Root
              bind:checked={visualSettings.unzippedBordersHoverOnly}
              disabled={!visualSettings.showUnzippedBorders}
            />
          </div>
        </div>
      </div>
  </SettingsAccordionCard>
{/if}
