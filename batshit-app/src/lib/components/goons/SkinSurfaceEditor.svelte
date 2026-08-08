<script lang="ts">
  import { ImagePlus } from '@lucide/svelte'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import FacialArtworkAccordion from './FacialArtworkAccordion.svelte'
  import GoonsFieldLabel from './GoonsFieldLabel.svelte'
  import type { FacialArtworkProvenance } from '$lib/goons/facialArtwork'
  import {
    resolveFacialArtworkUploadProvenance,
    type FacialArtworkUploadCreditDraft,
    type FacialArtworkUploadSourceKind
  } from '$lib/goons/facialArtwork.provenance'
  import {
    createDefaultSkinAppearanceState,
    setCustomSkinSurfaceUpload,
    skinAppearanceHexToRgb,
    skinAppearanceRgbToHex,
    updateSkinAppearanceSurface,
    type SkinAppearanceDefinitionV1,
    type SkinAppearanceStateV2
  } from '$lib/goons/skinAppearance'
  import {
    SKIN_SURFACE_MAP_ROLES,
    type SkinSurfaceMapRole,
    type SkinSurfaceUploadV1
  } from '$lib/goons/skinSurface'

  type Props = {
    definition: SkinAppearanceDefinitionV1
    valueState: SkinAppearanceStateV2
    ownerDisplayName: string
    creditDraft: FacialArtworkUploadCreditDraft
    disabled?: boolean
    onCreditDraftChange: (draft: FacialArtworkUploadCreditDraft) => void
    onChange: (state: SkinAppearanceStateV2) => void
    onUpload: (
      role: SkinSurfaceMapRole,
      file: File,
      provenance: FacialArtworkProvenance
    ) => Promise<SkinSurfaceUploadV1>
    onUploadBusyChange?: (busy: boolean) => void
  }

  let {
    definition,
    valueState,
    ownerDisplayName,
    creditDraft,
    disabled = false,
    onCreditDraftChange,
    onChange,
    onUpload,
    onUploadBusyChange
  }: Props = $props()

  let openRole = $state<SkinSurfaceMapRole | null>('baseColor')
  let uploadBusyRole = $state<SkinSurfaceMapRole | null>(null)
  let uploadError = $state('')
  let baseColorInput = $state<HTMLInputElement | null>(null)
  let normalInput = $state<HTMLInputElement | null>(null)
  let roughnessInput = $state<HTMLInputElement | null>(null)
  let metallicInput = $state<HTMLInputElement | null>(null)

  const sourceOptions: Array<{
    value: FacialArtworkUploadSourceKind
    label: string
  }> = [
    { value: 'user-authored', label: 'My artwork' },
    { value: 'comfyui-generated', label: 'Made by me with ComfyUI' },
    { value: 'approved-external', label: 'External artwork I may use' }
  ]
  const sourceLabel = $derived(
    sourceOptions.find((option) => option.value === creditDraft.sourceKind)?.label ??
      'Choose source'
  )
  const selfAuthored = $derived(creditDraft.sourceKind !== 'approved-external')
  const provenanceResolution = $derived.by(() =>
    resolveFacialArtworkUploadProvenance({ ...creditDraft, ownerDisplayName })
  )
  const uploadProvenance = $derived<FacialArtworkProvenance | null>(
    provenanceResolution.provenance
  )
  const defaults = $derived(createDefaultSkinAppearanceState(definition))

  const roleCopy = $derived.by<Record<
    SkinSurfaceMapRole,
    {
      label: string
      short: string
      info: string[]
      format: string
    }
  >>(() => ({
    baseColor: {
      label: 'Base Color Artwork',
      short: 'Base Color',
      format: `${definition.canvas.width} × ${definition.canvas.height} · sRGB PNG`,
      info: [
        'Base Color carries pigment and painted variation, not scene lighting or surface depth.',
        'Artwork Tint is the one overall skin-color control. White artwork becomes the selected tint exactly.',
        'Package restores the artwork embedded in the installed Goon. Custom uses your validated full UV atlas.'
      ]
    },
    normal: {
      label: 'Normal Map',
      short: 'Normal',
      format: '2048 × 2048 · OpenGL RGB PNG',
      info: [
        'Normal changes how shallow form reacts to light. It does not contain skin color or replace geometry.',
        'Use an OpenGL/glTF tangent-space normal. Batshit validates and normalizes the vectors.',
        'None removes Normal shading; Strength controls the effect without rebaking the map.'
      ]
    },
    roughness: {
      label: 'Roughness Map',
      short: 'Roughness',
      format: '2048 × 2048 · grayscale PNG',
      info: [
        'Roughness controls how broad or sharp reflected light appears. White is rough; black is smooth.',
        'Batshit stores it as linear data and places it in the channel Three.js reads.',
        'None uses the package-declared uniform skin roughness.'
      ]
    },
    metallic: {
      label: 'Metallic Map',
      short: 'Metallic',
      format: '2048 × 2048 · grayscale PNG',
      info: [
        'Metallic marks actual metal regions. Normal human skin should remain black/dielectric.',
        'This slot supports cyborg, robotic, jewelry-like, or other intentionally metallic skin artwork.',
        'None uses dielectric zero.'
      ]
    }
  }))

  function updateCreditDraft(update: Partial<FacialArtworkUploadCreditDraft>) {
    onCreditDraftChange({ ...creditDraft, ...update })
  }

  function inputFor(role: SkinSurfaceMapRole) {
    return role === 'baseColor'
      ? baseColorInput
      : role === 'normal'
        ? normalInput
        : role === 'roughness'
          ? roughnessInput
          : metallicInput
  }

  function changed(role: SkinSurfaceMapRole) {
    return (
      JSON.stringify(valueState.surface[role]) !==
      JSON.stringify(defaults.surface[role])
    )
  }

  function modeOptions(role: SkinSurfaceMapRole) {
    return role === 'baseColor'
      ? [
          { value: 'package', label: 'Package' },
          { value: 'custom', label: 'Custom' }
        ]
      : [
          { value: 'package', label: 'Package' },
          { value: 'custom', label: 'Custom' },
          { value: 'none', label: 'None' }
        ]
  }

  function setMode(role: SkinSurfaceMapRole, mode: string) {
    const allowed = modeOptions(role).some((option) => option.value === mode)
    if (!allowed) return
    if (mode === 'custom' && !valueState.surface[role].custom) {
      inputFor(role)?.click()
      return
    }
    onChange(
      updateSkinAppearanceSurface(definition, valueState, role, {
        mode,
        ...(mode === 'custom'
          ? {}
          : { custom: null })
      })
    )
  }

  function resetRole(role: SkinSurfaceMapRole) {
    onChange(
      updateSkinAppearanceSurface(
        definition,
        valueState,
        role,
        structuredClone(defaults.surface[role])
      )
    )
  }

  function updateTint(value: string) {
    const tint = skinAppearanceHexToRgb(value)
    if (!tint) return
    onChange(
      updateSkinAppearanceSurface(definition, valueState, 'baseColor', { tint })
    )
  }

  function updateNormalStrength(value: string) {
    const strength = Number(value)
    if (!Number.isFinite(strength)) return
    onChange(
      updateSkinAppearanceSurface(definition, valueState, 'normal', { strength })
    )
  }

  async function handleFile(role: SkinSurfaceMapRole, file: File | undefined) {
    if (!file || disabled || uploadBusyRole || !uploadProvenance) return
    uploadBusyRole = role
    uploadError = ''
    onUploadBusyChange?.(true)
    try {
      const upload = await onUpload(role, file, uploadProvenance)
      onChange(setCustomSkinSurfaceUpload(definition, valueState, role, upload))
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error)
      openRole = role
    } finally {
      uploadBusyRole = null
      onUploadBusyChange?.(false)
    }
  }
</script>

<section class="skin-surface-stack" aria-label="Skin Surface Artwork">
  <section class="skin-surface-credit" aria-label="Skin Surface Upload Credit">
    <GoonsFieldLabel
      label="Upload Credit"
      info="Batshit saves source and permission details separately with every uploaded skin map."
      ariaLabel="About Skin Surface Upload Credit"
    />
    <div class="grid gap-2 sm:grid-cols-2">
      <label class="space-y-1 text-[0.625rem] text-muted-foreground">
        <span>Source</span>
        <Select.Root
          type="single"
          value={creditDraft.sourceKind}
          items={sourceOptions}
          onValueChange={(value: string) => {
            if (sourceOptions.some((option) => option.value === value)) {
              updateCreditDraft({ sourceKind: value as FacialArtworkUploadSourceKind })
            }
          }}
        >
          <Select.Trigger class="w-full" aria-label="Skin map source" {disabled}>
            {sourceLabel}
          </Select.Trigger>
          <Select.Content>
            {#each sourceOptions as option (option.value)}
              <Select.Item value={option.value}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </label>
      {#if selfAuthored}
        <div class="space-y-1 text-[0.625rem] text-muted-foreground">
          <span>Credited to</span>
          <div class="bs-input flex items-center justify-between gap-2">
            <span>{ownerDisplayName.trim() || 'Your display name is missing'}</span>
            <SettingsInfoMenu ariaLabel="About Skin Surface Credit" align="end">
              <p>Uploading confirms you created this map and may use it.</p>
            </SettingsInfoMenu>
          </div>
        </div>
      {:else}
        <label class="space-y-1 text-[0.625rem] text-muted-foreground">
          <span>Artist or source</span>
          <Input
            value={creditDraft.externalAuthor}
            placeholder="Name or source"
            {disabled}
            oninput={(event) =>
              updateCreditDraft({
                externalAuthor: (event.currentTarget as HTMLInputElement).value
              })}
          />
        </label>
        <label class="space-y-1 text-[0.625rem] text-muted-foreground">
          <span>License or permission note</span>
          <Input
            value={creditDraft.externalLicense}
            placeholder="License or permission"
            {disabled}
            oninput={(event) =>
              updateCreditDraft({
                externalLicense: (event.currentTarget as HTMLInputElement).value
              })}
          />
        </label>
        <label class="flex items-start gap-2 text-[0.625rem] text-muted-foreground sm:col-span-2">
          <input
            type="checkbox"
            checked={creditDraft.externalRightsConfirmed}
            {disabled}
            onchange={(event) =>
              updateCreditDraft({
                externalRightsConfirmed: (event.currentTarget as HTMLInputElement).checked
              })}
          />
          <span>I confirm I have permission to use these maps.</span>
        </label>
      {/if}
    </div>
    {#if !uploadProvenance}
      <p class="text-[0.625rem] text-muted-foreground" role="status">
        {provenanceResolution.missingReason}
      </p>
    {/if}
  </section>

  <input
    bind:this={baseColorInput}
    class="sr-only"
    type="file"
    accept="image/png,.png"
    aria-label="Choose Base Color Artwork PNG"
    onchange={(event) => {
      const input = event.currentTarget as HTMLInputElement
      void handleFile('baseColor', input.files?.[0])
      input.value = ''
    }}
  />
  <input
    bind:this={normalInput}
    class="sr-only"
    type="file"
    accept="image/png,.png"
    aria-label="Choose Normal Map PNG"
    onchange={(event) => {
      const input = event.currentTarget as HTMLInputElement
      void handleFile('normal', input.files?.[0])
      input.value = ''
    }}
  />
  <input
    bind:this={roughnessInput}
    class="sr-only"
    type="file"
    accept="image/png,.png"
    aria-label="Choose Roughness Map PNG"
    onchange={(event) => {
      const input = event.currentTarget as HTMLInputElement
      void handleFile('roughness', input.files?.[0])
      input.value = ''
    }}
  />
  <input
    bind:this={metallicInput}
    class="sr-only"
    type="file"
    accept="image/png,.png"
    aria-label="Choose Metallic Map PNG"
    onchange={(event) => {
      const input = event.currentTarget as HTMLInputElement
      void handleFile('metallic', input.files?.[0])
      input.value = ''
    }}
  />

  {#each SKIN_SURFACE_MAP_ROLES as role (role)}
    {@const slot = valueState.surface[role]}
    {@const copy = roleCopy[role]}
    {@const options = modeOptions(role)}
    <FacialArtworkAccordion
      id={`skin-surface-${role}`}
      title={copy.label}
      info={copy.info}
      open={openRole === role}
      forceMount
      changed={changed(role)}
      {disabled}
      onToggle={() => (openRole = openRole === role ? null : role)}
      onReset={() => resetRole(role)}
    >
      <div class="space-y-3" aria-busy={uploadBusyRole === role}>
        <div class="flex items-center justify-between gap-3 text-[0.625rem] text-muted-foreground">
          <span>{copy.format}</span>
          {#if slot.custom}<span class="truncate">{slot.custom.filename}</span>{/if}
        </div>

        <label class="space-y-1 text-[0.625rem] text-muted-foreground">
          <span>Source</span>
          <Select.Root
            type="single"
            value={slot.mode}
            items={options}
            onValueChange={(mode: string) => setMode(role, mode)}
          >
            <Select.Trigger class="w-full" aria-label={`${copy.short} source`} {disabled}>
              {options.find((option) => option.value === slot.mode)?.label ?? 'Package'}
            </Select.Trigger>
            <Select.Content>
              {#each options as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </label>

        <Button
          variant="outline"
          size="sm"
          disabled={disabled || Boolean(uploadBusyRole) || !uploadProvenance}
          onclick={() => inputFor(role)?.click()}
        >
          <ImagePlus aria-hidden="true" />
          {uploadBusyRole === role
            ? 'Checking PNG…'
            : slot.custom
              ? 'Replace Custom PNG'
              : 'Upload Custom PNG'}
        </Button>

        {#if role === 'baseColor'}
          <label class="skin-surface-tint">
            <div class="min-w-0 flex-1">
              <GoonsFieldLabel
                label="Artwork Tint"
                info="The one overall skin-color control. It multiplies Package or Custom Base Color in sRGB; white Custom artwork starts at the former Base Skin default."
                ariaLabel="About Artwork Tint"
              />
              <span class="text-[0.625rem] uppercase text-muted-foreground">
                {skinAppearanceRgbToHex(valueState.surface.baseColor.tint)}
              </span>
            </div>
            <input
              type="color"
              value={skinAppearanceRgbToHex(valueState.surface.baseColor.tint)}
              aria-label="Artwork Tint"
              {disabled}
              oninput={(event) =>
                updateTint((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        {:else if role === 'normal' && slot.mode !== 'none'}
          <label class="space-y-2 text-[0.625rem] text-muted-foreground">
            <div class="flex items-center justify-between gap-3">
              <span>Strength</span>
              <span>{Math.round(valueState.surface.normal.strength * 100)}%</span>
            </div>
            <input
              class="w-full"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={valueState.surface.normal.strength}
              aria-label="Normal Map strength"
              {disabled}
              oninput={(event) =>
                updateNormalStrength((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        {/if}

        {#if uploadError && openRole === role}
          <p class="batshit-settings-form-error" role="alert">{uploadError}</p>
        {/if}
      </div>
    </FacialArtworkAccordion>
  {/each}
</section>

<style>
  .skin-surface-stack {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
  }

  .skin-surface-credit {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 2px 0 8px;
  }

  .skin-surface-tint {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    border-radius: 6px;
    padding: 8px 12px;
  }

  .skin-surface-tint input[type='color'] {
    width: 34px;
    height: 30px;
    flex-shrink: 0;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--background);
    cursor: pointer;
  }

  .skin-surface-tint input[type='color']:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }
</style>
