<script lang="ts">
  import { Download, ImagePlus, Trash2 } from '@lucide/svelte'
  import * as ToggleGroup from '$lib/components/ui/toggle-group'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import { downloadBlob } from '$lib/utils/download'
  import {
    createFacialArtworkArtworkLayer,
    resolveFacialArtworkAssetUrl,
    resolveFacialArtworkTemplateOrientation,
    resolveFacialArtworkTemplateVariant,
    type FacialArtworkArtworkLayer,
    type FacialArtworkDefinition,
    type FacialArtworkEyeState,
    type FacialArtworkLongitudeBounds,
    type FacialArtworkOrientation,
    type FacialArtworkPlanarBounds,
    type FacialArtworkPlanarTransform,
    type FacialArtworkProvenance,
    type FacialArtworkRoleId,
    type FacialArtworkSide,
    type FacialArtworkState,
    type FacialArtworkUpload
  } from '$lib/goons/facialArtwork'
  import {
    resolveFacialArtworkEyeState,
    setFacialArtworkRoleMode,
    updateFacialArtworkEyeState
  } from '$lib/goons/facialArtwork.editor'

  type Props = {
    definition: FacialArtworkDefinition
    valueState: FacialArtworkState
    roleId: FacialArtworkRoleId
    label: string
    leftLabel?: string
    rightLabel?: string
    disabled?: boolean
    provenance: FacialArtworkProvenance | null
    onChange: (state: FacialArtworkState) => void
    onUpload: (
      roleId: FacialArtworkRoleId,
      file: File,
      provenance: FacialArtworkProvenance,
      orientation: FacialArtworkOrientation
    ) => Promise<FacialArtworkUpload>
    onUploadBusyChange?: (busy: boolean) => void
  }

  let {
    definition,
    valueState,
    roleId,
    label,
    leftLabel = 'Left Eye',
    rightLabel = 'Right Eye',
    disabled = false,
    provenance,
    onChange,
    onUpload,
    onUploadBusyChange
  }: Props = $props()

  let activeSide = $state<FacialArtworkSide>('left')
  let fileInput = $state<HTMLInputElement | null>(null)
  let uploadBusy = $state(false)
  let uploadError = $state('')
  let downloadBusy = $state<'template' | null>(null)
  let downloadError = $state('')
  let collapseChoiceOpen = $state(false)

  const role = $derived(definition.roles.find((candidate) => candidate.id === roleId)!)
  const template = $derived(definition.templates.find((candidate) => candidate.id === role.template)!)
  const roleState = $derived(valueState.roles[roleId])
  const perEye = $derived(roleState.mode === 'per-eye')
  const eyeState = $derived(resolveFacialArtworkEyeState(valueState, roleId, activeSide))
  const uploadSide = $derived(perEye ? activeSide : 'shared')
  const uploadOrientation = $derived(resolveFacialArtworkTemplateOrientation(template, uploadSide))
  const templateVariant = $derived(resolveFacialArtworkTemplateVariant(template, uploadOrientation))
  const hasBaseColor = $derived(eyeState.baseColor !== null)
  const fileInputId = $derived(`facial-artwork-file-${roleId}-${perEye ? activeSide : 'shared'}`)
  const collapseChoiceId = $derived(`facial-artwork-${roleId}-collapse-choice`)
  const planarControlDefinitions = [
    ['translateU', 'Artwork Horizontal Position', 0.005],
    ['translateV', 'Artwork Vertical Position', 0.005],
    ['scale', 'Artwork Scale', 0.01],
    ['rotationDegrees', 'Artwork Rotation', 1]
  ] as const
  const editablePlanarControls = $derived(
    planarControlDefinitions.filter(([key]) => role.editableTransforms.includes(key))
  )

  function updateEye(update: (state: FacialArtworkEyeState) => FacialArtworkEyeState) {
    if (disabled && !uploadBusy) return
    onChange(updateFacialArtworkEyeState(valueState, { roleId, side: activeSide }, update))
  }

  function setRoleMode(mode: 'shared' | 'per-eye') {
    if (disabled || roleState.mode === mode) return
    try {
      onChange(setFacialArtworkRoleMode(valueState, roleId, mode))
      collapseChoiceOpen = false
      if (mode === 'shared') activeSide = 'left'
    } catch {
      if (mode === 'shared' && roleState.mode === 'per-eye') {
        collapseChoiceOpen = true
        return
      }
      throw new Error(`Unable to change ${label} eye matching`)
    }
  }

  function collapseToShared(side: FacialArtworkSide) {
    if (disabled || roleState.mode !== 'per-eye') return
    onChange(setFacialArtworkRoleMode(valueState, roleId, 'shared', side))
    activeSide = 'left'
    collapseChoiceOpen = false
  }

  function setVisible(visible: boolean) {
    if (visible && !eyeState.artwork) return
    updateEye((current) => ({ ...current, visible }))
  }

  function setBaseColor(value: string) {
    if (!/^#[a-f0-9]{6}$/i.test(value)) return
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    updateEye((current) => ({ ...current, baseColor: [rgb[0], rgb[1], rgb[2]] }))
  }

  function setArtworkTint(value: string) {
    if (!/^#[a-f0-9]{6}$/i.test(value)) return
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    updateArtwork((artwork) => ({
      ...artwork,
      tint: [rgb[0], rgb[1], rgb[2], artwork.tint[3]]
    }))
  }

  function colorHex(value: readonly number[]) {
    return `#${value
      .slice(0, 3)
      .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
      .join('')}`
  }

  function updateArtwork(
    update: (artwork: FacialArtworkArtworkLayer) => FacialArtworkArtworkLayer
  ) {
    updateEye((current) => ({
      ...current,
      artwork: current.artwork ? update(current.artwork) : null
    }))
  }

  function updateArtworkTransform(key: string, value: number) {
    updateArtwork((artwork) => ({
      ...artwork,
      transform: { ...artwork.transform, [key]: value }
    }) as FacialArtworkArtworkLayer)
  }

  function removeArtwork() {
    updateEye((current) => ({
      ...current,
      visible: current.baseColor !== null,
      artwork: null
    }))
  }

  async function handleFile(file: File | undefined) {
    if (!file || disabled || !provenance || uploadBusy) return
    uploadBusy = true
    uploadError = ''
    onUploadBusyChange?.(true)
    try {
      const upload = await onUpload(roleId, file, provenance, uploadOrientation)
      const artwork = createFacialArtworkArtworkLayer(definition, roleId, upload)
      updateEye((current) => ({ ...current, visible: true, artwork }))
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error)
    } finally {
      uploadBusy = false
      onUploadBusyChange?.(false)
    }
  }

  function normalizeSliderValue(value: number | number[]): number {
    return typeof value === 'number' ? value : value[0] ?? 0
  }

  function formatNumber(value: number) {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  }

  function longitudeBounds(): FacialArtworkLongitudeBounds {
    return role.transformBounds as FacialArtworkLongitudeBounds
  }

  function planarBounds(): FacialArtworkPlanarBounds {
    return role.transformBounds as FacialArtworkPlanarBounds
  }

  function downloadFilename(path: string) {
    const basename = path.split('/').pop()?.trim() || `${roleId}.png`
    return `template-${basename}`
  }

  async function downloadTemplateAsset(event: MouseEvent, path: string) {
    event.preventDefault()
    if (downloadBusy) return
    downloadBusy = 'template'
    downloadError = ''
    try {
      const url = resolveFacialArtworkAssetUrl(path)
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Download failed (${response.status}).`)
      }
      const blob = await response.blob()
      await downloadBlob(blob, downloadFilename(path), {
        title: `Save ${label} Template`,
        mimeType: 'image/png'
      })
    } catch (error) {
      downloadError = error instanceof Error ? error.message : String(error)
    } finally {
      downloadBusy = null
    }
  }
</script>

<div class="facial-artwork-surface" aria-busy={uploadBusy}>
  <div class="facial-artwork-template-row">
    <span>{template.dimensions[0]} × {template.dimensions[1]} PNG · {templateVariant.label}</span>
    <div class="facial-artwork-downloads">
      <a
        href={resolveFacialArtworkAssetUrl(templateVariant.guide.path)}
        download
        aria-label={`Download ${templateVariant.label} Template`}
        aria-busy={downloadBusy === 'template'}
        onclick={(event) => void downloadTemplateAsset(event, templateVariant.guide.path)}
      >
        <Download aria-hidden="true" /> {downloadBusy === 'template' ? 'Saving…' : 'Template'}
      </a>
    </div>
  </div>

  {#if downloadError}
    <p class="facial-artwork-error" role="alert">Could not save template: {downloadError}</p>
  {/if}

  <ToggleGroup.Root
    type="single"
    value={perEye ? 'per-eye' : 'shared'}
    variant="outline"
    size="sm"
    class="facial-artwork-toggle-group"
    aria-label={`${label} eye matching`}
    onValueChange={(value: string) => {
      if (value === 'shared' || value === 'per-eye') setRoleMode(value)
    }}
  >
    <ToggleGroup.Item value="shared" class="facial-artwork-toggle-option" {disabled}>
      Same for both
    </ToggleGroup.Item>
    <ToggleGroup.Item value="per-eye" class="facial-artwork-toggle-option" {disabled}>
      Customize each eye
    </ToggleGroup.Item>
  </ToggleGroup.Root>

  {#if collapseChoiceOpen && perEye}
    <div class="facial-artwork-collapse-choice" role="group" aria-labelledby={collapseChoiceId}>
      <p id={collapseChoiceId}>The two eyes differ. Choose which anatomical side to use for both.</p>
      <div>
        <button type="button" disabled={disabled} onclick={() => collapseToShared('left')}
          >Use Goon's Left (viewer's right)</button
        >
        <button type="button" disabled={disabled} onclick={() => collapseToShared('right')}
          >Use Goon's Right (viewer's left)</button
        >
        <button type="button" onclick={() => (collapseChoiceOpen = false)}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if perEye}
    <ToggleGroup.Root
      type="single"
      value={activeSide}
      variant="outline"
      size="sm"
      class="facial-artwork-toggle-group"
      aria-label={`${label} side`}
      onValueChange={(value: string) => {
        if (value === 'left' || value === 'right') activeSide = value
      }}
    >
      <ToggleGroup.Item value="left" class="facial-artwork-toggle-option">{leftLabel}</ToggleGroup.Item>
      <ToggleGroup.Item value="right" class="facial-artwork-toggle-option">{rightLabel}</ToggleGroup.Item>
    </ToggleGroup.Root>
  {/if}

  {#if !hasBaseColor}
    <ToggleGroup.Root
      type="single"
      value={eyeState.visible ? 'artwork' : 'hidden'}
      variant="outline"
      size="sm"
      class="facial-artwork-toggle-group"
      aria-label={`${label} visibility`}
      onValueChange={(value: string) => {
        if (value === 'hidden') setVisible(false)
        if (value === 'artwork') setVisible(true)
      }}
    >
      <ToggleGroup.Item value="hidden" class="facial-artwork-toggle-option" {disabled}>
        Hidden
      </ToggleGroup.Item>
      <ToggleGroup.Item
        value="artwork"
        class="facial-artwork-toggle-option"
        disabled={disabled || !eyeState.artwork}
      >Artwork</ToggleGroup.Item>
    </ToggleGroup.Root>
  {/if}

  {#if eyeState.baseColor}
    <label class="facial-artwork-color-control">
      <span>Base Color</span>
      <span class="facial-artwork-color-value">{colorHex(eyeState.baseColor)}</span>
      <input
        type="color"
        value={colorHex(eyeState.baseColor)}
        aria-label={`${label} base color`}
        disabled={disabled}
        oninput={(event) => setBaseColor((event.currentTarget as HTMLInputElement).value)}
      />
    </label>
  {/if}

  <div class="facial-artwork-file-row">
    <input
      id={fileInputId}
      class="sr-only"
      type="file"
      accept="image/png,.png"
      bind:this={fileInput}
      disabled={disabled || !provenance || uploadBusy}
      onchange={(event) => {
        const input = event.currentTarget as HTMLInputElement
        void handleFile(input.files?.[0]).finally(() => (input.value = ''))
      }}
    />
    <Button
      variant="outline"
      size="sm"
      onclick={() => fileInput?.click()}
      disabled={disabled || !provenance || uploadBusy}
    >
      <ImagePlus aria-hidden="true" />
      {uploadBusy ? 'Validating...' : eyeState.artwork ? 'Replace PNG' : 'Upload PNG'}
    </Button>
    {#if eyeState.artwork}
      <Button variant="ghost" size="sm" onclick={removeArtwork} disabled={disabled || uploadBusy}>
        <Trash2 aria-hidden="true" /> Remove
      </Button>
    {/if}
  </div>

  {#if !provenance}
    <p class="facial-artwork-upload-help">Complete Upload Credit before adding a PNG.</p>
  {/if}
  {#if uploadError}
    <p class="facial-artwork-error" role="alert">{uploadError}</p>
  {/if}

  {#if eyeState.artwork}
    {@const artwork = eyeState.artwork}
    <div class="facial-artwork-file-proof">
      <span title={artwork.upload.filename}>{artwork.upload.filename}</span>
      <code title={artwork.upload.sha256}>{artwork.upload.sha256.slice(0, 12)}…</code>
      <span
        title={`${artwork.upload.provenance.sourceKind} · ${artwork.upload.provenance.license}`}
      >{artwork.upload.provenance.author}</span>
    </div>

    <div class="facial-artwork-art-controls">
      <label class="facial-artwork-color-control">
        <span>Artwork Tint</span>
        <span class="facial-artwork-color-value">{colorHex(artwork.tint)}</span>
        <input
          type="color"
          value={colorHex(artwork.tint)}
          aria-label={`${label} artwork tint`}
          disabled={disabled}
          oninput={(event) => setArtworkTint((event.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <label class="facial-artwork-slider-control">
        <span><span>Artwork Opacity</span><output>{Math.round(artwork.opacity * 100)}%</output></span>
        <Slider
          type="single"
          value={artwork.opacity}
          min={0}
          max={1}
          step={0.01}
          fillFrom={0}
          aria-label={`${label} artwork opacity`}
          disabled={disabled}
          onValueChange={(value: number | number[]) =>
            updateArtwork((current) => ({ ...current, opacity: normalizeSliderValue(value) }))}
        />
      </label>

      {#if artwork.mapping === 'longitude' && role.mapping === 'longitude'}
        {@const bounds = longitudeBounds().longitudeDegrees}
        <label class="facial-artwork-slider-control">
          <span>
            <span>Artwork Rotation</span>
            <output>{formatNumber(artwork.transform.longitudeDegrees)}°</output>
          </span>
          <Slider
            type="single"
            value={artwork.transform.longitudeDegrees}
            min={bounds[0]}
            max={bounds[1]}
            step={1}
            fillFrom={0}
            showAnchorMarker={bounds[0] < 0 && bounds[1] > 0}
            aria-label={`${label} artwork rotation`}
            disabled={disabled}
            onValueChange={(value: number | number[]) =>
              updateArtworkTransform('longitudeDegrees', normalizeSliderValue(value))}
          />
        </label>
      {:else if artwork.mapping !== 'longitude' && role.mapping !== 'longitude'}
        {#each editablePlanarControls as control (control[0])}
          {@const key = control[0] as keyof FacialArtworkPlanarTransform}
          {@const bounds = planarBounds()[key]}
          <label class="facial-artwork-slider-control">
            <span>
              <span>{control[1]}</span>
              <output>{formatNumber(artwork.transform[key])}{key === 'rotationDegrees' ? '°' : ''}</output>
            </span>
            <Slider
              type="single"
              value={artwork.transform[key]}
              min={bounds[0]}
              max={bounds[1]}
              step={control[2] as number}
              fillFrom={key === 'scale' ? 1 : 0}
              showAnchorMarker={bounds[0] < (key === 'scale' ? 1 : 0) && bounds[1] > (key === 'scale' ? 1 : 0)}
              aria-label={`${label} ${control[1]}`}
              disabled={disabled}
              onValueChange={(value: number | number[]) =>
                updateArtworkTransform(key, normalizeSliderValue(value))}
            />
          </label>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .facial-artwork-surface,
  .facial-artwork-art-controls,
  .facial-artwork-slider-control {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .facial-artwork-surface {
    gap: 10px;
  }

  .facial-artwork-upload-help,
  .facial-artwork-collapse-choice p,
  .facial-artwork-error {
    margin: 0;
  }

  .facial-artwork-upload-help,
  .facial-artwork-collapse-choice p {
    max-width: 68ch;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    line-height: 1.45;
  }

  .facial-artwork-template-row,
  .facial-artwork-downloads,
  .facial-artwork-file-row,
  .facial-artwork-file-proof,
  .facial-artwork-color-control,
  .facial-artwork-slider-control > span {
    display: flex;
    align-items: center;
  }

  .facial-artwork-template-row,
  .facial-artwork-slider-control > span {
    justify-content: space-between;
  }

  .facial-artwork-template-row {
    flex-wrap: wrap;
    gap: 7px;
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .facial-artwork-downloads,
  .facial-artwork-file-row,
  .facial-artwork-file-proof {
    flex-wrap: wrap;
  }

  .facial-artwork-downloads {
    gap: 4px;
  }

  .facial-artwork-downloads a {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    gap: 4px;
    padding: 0 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--foreground);
  }

  .facial-artwork-downloads a:hover {
    background: var(--muted);
  }

  .facial-artwork-downloads a:focus-visible,
  .facial-artwork-color-control input:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .facial-artwork-downloads :global(svg) {
    width: 12px;
    height: 12px;
  }

  :global(.facial-artwork-toggle-group) {
    width: 100%;
  }

  :global(.facial-artwork-toggle-option) {
    min-width: 0 !important;
    min-height: 32px;
    padding-inline: 10px !important;
    font-size: 0.65rem;
    font-weight: 500;
    line-height: 1.25;
    white-space: normal;
  }

  .facial-artwork-collapse-choice {
    display: grid;
    gap: 7px;
    padding: 8px;
    border: 1px solid color-mix(in oklch, var(--primary) 26%, var(--border));
    border-radius: 7px;
    background: color-mix(in oklch, var(--primary) 7%, var(--background));
  }

  .facial-artwork-collapse-choice > div {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .facial-artwork-collapse-choice button {
    min-height: 30px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--foreground);
    background: var(--background);
    font-size: 0.625rem;
  }

  .facial-artwork-collapse-choice button:hover:not(:disabled) {
    background: var(--muted);
  }

  .facial-artwork-collapse-choice button:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .facial-artwork-file-row {
    gap: 5px;
  }

  .facial-artwork-error {
    color: var(--destructive);
    font-size: 0.675rem;
    line-height: 1.4;
  }

  .facial-artwork-file-proof {
    gap: 8px;
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .facial-artwork-file-proof span:first-child {
    overflow: hidden;
    min-width: 0;
    max-width: 34ch;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .facial-artwork-file-proof code {
    font-size: inherit;
  }

  .facial-artwork-color-control {
    min-height: 32px;
    justify-content: flex-start;
    gap: 8px;
    font-size: 0.675rem;
  }

  .facial-artwork-color-control input {
    width: 36px;
    height: 28px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: transparent;
  }

  .facial-artwork-color-value,
  .facial-artwork-slider-control output {
    margin-left: auto;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }

  .facial-artwork-art-controls {
    gap: 10px;
    padding-top: 2px;
  }

  .facial-artwork-slider-control {
    gap: 5px;
    font-size: 0.675rem;
  }

  @container (max-width: 320px) {
    .facial-artwork-template-row {
      align-items: flex-start;
      flex-direction: column;
    }

    .facial-artwork-downloads {
      width: 100%;
    }

    .facial-artwork-downloads a {
      flex: 1;
      justify-content: center;
    }
  }

</style>
