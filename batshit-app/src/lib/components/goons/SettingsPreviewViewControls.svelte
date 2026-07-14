<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import { Camera, Eye, House, RotateCcw, Settings2 } from '@lucide/svelte'
  import type { GoonEngineQuality } from '$lib/goons/engine'
  import type { GoonFramingPreset } from '$lib/goons/cameraNavigation'
  import type { GoonCameraMode } from '$lib/types/goons'

  type SettingsPreviewViewControlsProps = {
    disabled?: boolean
    showReset?: boolean
    resetAriaLabel?: string
    resetTitle?: string
    onReset?: (() => void) | undefined
    fov: number
    minFov: number
    maxFov: number
    onFovChange?: ((value: number | number[]) => void) | undefined
    onFramePreset?: ((preset: GoonFramingPreset) => void) | undefined
    cameraMode?: GoonCameraMode
    indoorCameraAvailable?: boolean
    onCameraModeChange?: ((mode: GoonCameraMode) => void) | undefined
    quality?: GoonEngineQuality | null
    qualityOptions?: Array<{ value: GoonEngineQuality; label: string }>
    onQualityChange?: ((value: GoonEngineQuality) => void) | undefined
    eyeContactEnabled?: boolean
    onEyeContactToggle?: (() => void) | undefined
  }

  let {
    disabled = false,
    showReset = false,
    resetAriaLabel = 'Reset preview view controls',
    resetTitle = 'Reset preview view controls',
    onReset = undefined,
    fov,
    minFov,
    maxFov,
    onFovChange = undefined,
    onFramePreset = undefined,
    cameraMode = 'free',
    indoorCameraAvailable = false,
    onCameraModeChange = undefined,
    quality = null,
    qualityOptions = [],
    onQualityChange = undefined,
    eyeContactEnabled = true,
    onEyeContactToggle = undefined
  }: SettingsPreviewViewControlsProps = $props()

  const qualityLabel = $derived.by(
    () => qualityOptions.find((option) => option.value === quality)?.label || 'Auto'
  )

  const showQuality = $derived(Boolean(onQualityChange && qualityOptions.length > 0))
  const showEyeContact = $derived(Boolean(onEyeContactToggle))
</script>

<div class="settings-preview-view-controls">
  {#if showReset}
    <Button
      variant="ghost"
      size="sm"
      class="settings-preview-icon-button"
      onclick={() => onReset?.()}
      disabled={disabled}
      aria-label={resetAriaLabel}
      title={resetTitle}
    >
      <RotateCcw class="settings-preview-button-icon" />
    </Button>
  {/if}

  {#if onCameraModeChange}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="settings-preview-menu-icon-trigger"
        disabled={disabled}
        aria-label={cameraMode === 'indoor' ? 'Indoor Camera' : 'Free Camera'}
        title={cameraMode === 'indoor' ? 'Indoor Camera' : 'Free Camera'}
      >
        {#if cameraMode === 'indoor'}
          <House class="settings-preview-button-icon" />
        {:else}
          <Camera class="settings-preview-button-icon" />
        {/if}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="settings-preview-menu settings-preview-menu-compact settings-preview-menu-camera">
        <div class="settings-preview-menu-stack">
          <div class="settings-preview-menu-label">Camera</div>
          <div class="settings-preview-quality-grid">
            <Button
              variant={cameraMode === 'indoor' ? 'default' : 'outline'}
              size="sm"
              class="settings-preview-camera-button"
              disabled={!indoorCameraAvailable}
              onclick={() => onCameraModeChange?.('indoor')}
            ><House class="settings-preview-button-icon" /> Indoor Camera</Button>
            <Button
              variant={cameraMode === 'free' ? 'default' : 'outline'}
              size="sm"
              class="settings-preview-camera-button"
              onclick={() => onCameraModeChange?.('free')}
            ><Camera class="settings-preview-button-icon" /> Free Camera</Button>
          </div>
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}

  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="settings-preview-fov-trigger"
      disabled={disabled}
      aria-label={`Field of view: ${Math.round(fov)}`}
      title={`Field of view: ${Math.round(fov)} (Shift + Scroll)`}
    >
      FOV
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="settings-preview-menu">
      <div class="settings-preview-menu-stack">
        <div class="settings-preview-menu-row">
          <span class="settings-preview-menu-label">Field of View</span>
          <span class="settings-preview-menu-value">{Math.round(fov)}</span>
        </div>
        <Slider
          type="single"
          value={fov}
          onValueChange={(value: number | number[]) => onFovChange?.(value)}
          min={minFov}
          max={maxFov}
          step={1}
          class="settings-preview-slider"
        />
        {#if onFramePreset}
          <div class="settings-preview-framing-block">
            <span class="settings-preview-menu-label">Framing</span>
            <div class="settings-preview-framing-grid" role="group" aria-label="Preview framing">
              <Button
                variant="outline"
                size="sm"
                class="settings-preview-framing-button"
                onclick={() => onFramePreset?.('headshot')}
              >Headshot</Button>
              <Button
                variant="outline"
                size="sm"
                class="settings-preview-framing-button"
                onclick={() => onFramePreset?.('portrait')}
              >Portrait</Button>
              <Button
                variant="outline"
                size="sm"
                class="settings-preview-framing-button"
                onclick={() => onFramePreset?.('full-body')}
              >Full Body</Button>
            </div>
          </div>
        {/if}
        <p class="settings-preview-menu-help">Scroll covers close-up through exterior framing. FOV remains available for manual lens control.</p>
      </div>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  {#if showQuality}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="settings-preview-menu-icon-trigger"
        disabled={disabled}
        aria-label={`Quality: ${qualityLabel}`}
        title={`Quality: ${qualityLabel}`}
      >
        <Settings2 class="settings-preview-button-icon" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="settings-preview-menu settings-preview-menu-compact">
        <div class="settings-preview-menu-stack">
          <div class="settings-preview-menu-label">Quality</div>
          <div class="settings-preview-quality-grid">
            {#each qualityOptions as option}
              <Button
                variant={quality === option.value ? 'default' : 'outline'}
                size="sm"
                class="settings-preview-quality-button"
                onclick={() => onQualityChange?.(option.value)}
              >
                {option.label}
              </Button>
            {/each}
          </div>
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}

  {#if showEyeContact}
    <Button
      variant={eyeContactEnabled ? 'default' : 'ghost'}
      size="sm"
      class="settings-preview-icon-button"
      onclick={() => onEyeContactToggle?.()}
      disabled={disabled}
      aria-label={eyeContactEnabled ? 'Disable eye contact' : 'Enable eye contact'}
      title={eyeContactEnabled ? 'Disable eye contact' : 'Enable eye contact'}
    >
      <Eye class="settings-preview-button-icon" />
    </Button>
  {/if}
</div>

<style>
  .settings-preview-view-controls {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    border-left: 1px solid oklch(from var(--border) l c h / 0.7);
    padding-left: 8px;
  }

  :global(.settings-preview-icon-button),
  :global(.settings-preview-menu-icon-trigger),
  :global(.settings-preview-fov-trigger) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
  }

  :global(.settings-preview-icon-button),
  :global(.settings-preview-menu-icon-trigger) {
    width: 32px;
    height: 32px;
  }

  :global(.settings-preview-button-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.settings-preview-fov-trigger) {
    min-width: 40px;
    height: 32px;
    border-radius: 6px;
    padding-inline: 8px;
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  :global(.settings-preview-fov-trigger:hover),
  :global(.settings-preview-menu-icon-trigger:hover) {
    background: oklch(from var(--accent) l c h / 0.4);
  }

  :global(.settings-preview-fov-trigger:focus-visible),
  :global(.settings-preview-menu-icon-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--ring);
  }

  :global(.settings-preview-menu) {
    width: 220px;
    padding: 12px;
  }

  :global(.settings-preview-menu-compact) {
    padding: 8px;
  }

  :global(.settings-preview-menu-camera) {
    width: 292px;
  }

  .settings-preview-menu-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .settings-preview-menu-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .settings-preview-menu-label,
  .settings-preview-menu-value,
  .settings-preview-menu-help,
  :global(.settings-preview-quality-button) {
    font-size: 0.625rem;
  }

  .settings-preview-menu-label {
    color: var(--muted-foreground);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .settings-preview-menu-value {
    color: var(--foreground);
    font-weight: 500;
  }

  :global(.settings-preview-slider) {
    flex: 1 1 0;
  }

  .settings-preview-menu-help {
    color: var(--muted-foreground);
  }

  .settings-preview-framing-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 2px;
  }

  .settings-preview-framing-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  :global(.settings-preview-framing-button) {
    width: 100%;
    height: 28px;
    padding-inline: 6px;
    font-size: 0.5625rem;
  }

  .settings-preview-quality-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  :global(.settings-preview-quality-button) {
    width: 100%;
    height: 28px;
    padding-inline: 8px;
  }

  :global(.settings-preview-camera-button) {
    width: 100%;
    height: 28px;
    padding-inline: 8px;
    white-space: nowrap;
  }
</style>
