<script lang="ts">
  import { Palette } from '@lucide/svelte'
  import * as ToggleGroup from '$lib/components/ui/toggle-group'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { APP_LOOKS, applyAppLook, isAppLook, resolveAppLook, type AppLook } from '$lib/appearance/appLook'
  import {
    confirmUserSettings,
    getUserSettings,
    getUserSettingsReadError,
    getUserSettingsReadState
  } from '$lib/stores/userSettings.svelte'

  // The app's look (Josh, 2026-10-29). One click saves it; nothing saves on open. The root
  // layout keeps <html data-look> on the saved look, and other windows repaint when the
  // settings route publishes the save (src/lib/appearance/).
  const LOOK_LABELS: Record<AppLook, string> = { cave: 'Cave', minimal: 'Minimal', og: 'OG' }

  const ready = $derived(getUserSettingsReadState() === 'confirmed')
  const savedLook = $derived(resolveAppLook(getUserSettings()))
  let pendingLook = $state<AppLook | null>(null)
  let error = $state<string | null>(null)
  const shownLook = $derived(pendingLook ?? savedLook)

  async function chooseLook(next: string) {
    // A second click on the chosen look clears a single toggle group: not a choice.
    if (!isAppLook(next) || next === savedLook || pendingLook) return
    pendingLook = next
    error = null
    applyAppLook(next)
    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appearance_settings: { look: next } })
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body?.settings) throw new Error(body?.error || `The look was not saved (${response.status}).`)
      confirmUserSettings(body.settings)
    } catch (cause) {
      // Back to the saved look. A save whose answer was lost still reaches every window
      // through the settings event if it landed; it is never sent again from here.
      applyAppLook(savedLook)
      error = cause instanceof Error && cause.message ? cause.message : 'The look was not saved.'
    } finally {
      pendingLook = null
    }
  }
</script>

<div class="space-y-4">
  <div class="flex items-center gap-1">
    <Palette class="h-5 w-5 text-muted-foreground" aria-hidden="true" />
    <h3 class="batshit-settings-section-title">Themes</h3>
    <SettingsInfoMenu ariaLabel="About themes">
      <p>Pick how Batshit looks. The choice is saved for your account and changes every open window at once.</p>
    </SettingsInfoMenu>
  </div>

  <div class="batshit-settings-subsection">
    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <span class="batshit-settings-form-label" id="theme-look-label">Look</span>
            <SettingsInfoMenu ariaLabel="About looks">
              <p><strong>Cave</strong> is the Bat Cave look of batshit.ai: carved panels, a faint stone grain, a little smoke in the chat light.</p>
              <p><strong>Minimal</strong> keeps the same colours and carved edges, with no textures and no motion.</p>
              <p><strong>OG</strong> is the look Batshit had before Cave, kept for now so you can compare.</p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control is-inline-status">
          <ToggleGroup.Root
            type="single"
            value={shownLook}
            onValueChange={(value: string) => void chooseLook(value)}
            variant="outline"
            size="sm"
            class="max-w-full"
            aria-labelledby="theme-look-label"
            disabled={!ready || pendingLook !== null}
          >
            {#each APP_LOOKS as look (look)}
              <ToggleGroup.Item value={look} class="batshit-settings-toggle-filter">{LOOK_LABELS[look]}</ToggleGroup.Item>
            {/each}
          </ToggleGroup.Root>
          {#if pendingLook}<span class="batshit-settings-form-meta">Saving</span>{/if}
        </div>
      </div>
    </div>
  </div>

  {#if !ready && getUserSettingsReadState() === 'failed'}
    <div class="batshit-settings-inline-alert is-danger">Your settings could not load ({getUserSettingsReadError()}), so the look cannot be changed yet.</div>
  {/if}
  {#if error}
    <div class="batshit-settings-inline-alert is-danger">{error}</div>
  {/if}
</div>
