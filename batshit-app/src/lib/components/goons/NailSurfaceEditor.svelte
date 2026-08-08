<script lang="ts">
  import { Download, ImagePlus, Link2, Power, Unlink2 } from '@lucide/svelte'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Slider } from '$lib/components/ui/slider'
  import GoonsFieldLabel from './GoonsFieldLabel.svelte'
  import FacialArtworkAccordion from './FacialArtworkAccordion.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { downloadBlob } from '$lib/utils/download'
  import {
    countChangedNailSurfaceControls,
    createDefaultNailSurfaceState,
    nailSurfaceHexToRgb,
    nailSurfaceRgbToHex,
    type NailArtworkUploadV1,
    type NailFamily,
    type NailFinish,
    type NailSurfaceDefinitionV1,
    type NailSurfaceStateV1
  } from '$lib/goons/nailSurface'
  import type { FacialArtworkProvenance } from '$lib/goons/facialArtwork'
  import {
    resolveFacialArtworkUploadProvenance,
    type FacialArtworkUploadCreditDraft,
    type FacialArtworkUploadSourceKind
  } from '$lib/goons/facialArtwork.provenance'

  type Props = {
    definition: NailSurfaceDefinitionV1
    valueState: NailSurfaceStateV1
    ownerDisplayName: string
    creditDraft: FacialArtworkUploadCreditDraft
    surfaceEnabled: boolean
    disabled?: boolean
    onCreditDraftChange: (draft: FacialArtworkUploadCreditDraft) => void
    onChange: (state: NailSurfaceStateV1) => void
    onSurfaceEnabledChange: (enabled: boolean) => void
    onUpload: (
      family: NailFamily,
      file: File,
      provenance: FacialArtworkProvenance
    ) => Promise<NailArtworkUploadV1>
    onUploadBusyChange?: (busy: boolean) => void
  }

  let {
    definition,
    valueState,
    ownerDisplayName,
    creditDraft,
    surfaceEnabled,
    disabled = false,
    onCreditDraftChange,
    onChange,
    onSurfaceEnabledChange,
    onUpload,
    onUploadBusyChange
  }: Props = $props()

  let open = $state(false)
  let fingerFileInput = $state<HTMLInputElement | null>(null)
  let toeFileInput = $state<HTMLInputElement | null>(null)
  let uploadFamily = $state<NailFamily | null>(null)
  let uploadError = $state('')
  let downloadFamily = $state<NailFamily | null>(null)
  let downloadError = $state('')

  const families = [
    { id: 'fingers', label: 'Fingernails', singular: 'Finger Nail' },
    { id: 'toes', label: 'Toenails', singular: 'Toe Nail' }
  ] as const
  const finishOptions: Array<{ value: NailFinish; label: string }> = [
    { value: 'natural', label: 'Natural' },
    { value: 'matte', label: 'Matte' },
    { value: 'glossy', label: 'Glossy' }
  ]
  const sourceOptions: Array<{ value: FacialArtworkUploadSourceKind; label: string }> = [
    { value: 'user-authored', label: 'My artwork' },
    { value: 'comfyui-generated', label: 'Made by me with ComfyUI' },
    { value: 'approved-external', label: 'External artwork I may use' }
  ]

  const changed = $derived(
    countChangedNailSurfaceControls(definition, valueState) > 0 || !surfaceEnabled
  )
  const sourceLabel = $derived(
    sourceOptions.find((option) => option.value === creditDraft.sourceKind)?.label ?? 'Choose source'
  )
  const selfAuthored = $derived(creditDraft.sourceKind !== 'approved-external')
  const provenanceResolution = $derived.by(() =>
    resolveFacialArtworkUploadProvenance({ ...creditDraft, ownerDisplayName })
  )
  const uploadProvenance = $derived<FacialArtworkProvenance | null>(
    provenanceResolution.provenance
  )

  function updateCreditDraft(update: Partial<FacialArtworkUploadCreditDraft>) {
    onCreditDraftChange({ ...creditDraft, ...update })
  }

  function updateGeometry(
    family: NailFamily,
    field: 'length' | 'width' | 'arch',
    value: number | number[]
  ) {
    const next = typeof value === 'number' ? value : value[0]
    if (typeof next !== 'number') return
    onChange({
      ...valueState,
      geometry: {
        ...valueState.geometry,
        [family]: { ...valueState.geometry[family], [field]: next }
      }
    })
  }

  function updateShape(family: NailFamily, value: string) {
    const options = definition.controls[family].shape.options as string[]
    if (!options.includes(value)) return
    onChange({
      ...valueState,
      geometry: {
        ...valueState.geometry,
        [family]: { ...valueState.geometry[family], shape: value }
      }
    } as NailSurfaceStateV1)
  }

  function updateColor(family: NailFamily, value: string) {
    const color = nailSurfaceHexToRgb(value)
    if (!color) return
    const linked = valueState.appearance.linked
    onChange({
      ...valueState,
      appearance: {
        ...valueState.appearance,
        fingers: {
          ...valueState.appearance.fingers,
          color: linked || family === 'fingers' ? color : valueState.appearance.fingers.color
        },
        toes: {
          ...valueState.appearance.toes,
          color: linked || family === 'toes' ? color : valueState.appearance.toes.color
        }
      }
    })
  }

  function updateFinish(family: NailFamily, finish: string) {
    if (!finishOptions.some((option) => option.value === finish)) return
    const value = finish as NailFinish
    const linked = valueState.appearance.linked
    onChange({
      ...valueState,
      appearance: {
        ...valueState.appearance,
        fingers: {
          ...valueState.appearance.fingers,
          finish: linked || family === 'fingers' ? value : valueState.appearance.fingers.finish
        },
        toes: {
          ...valueState.appearance.toes,
          finish: linked || family === 'toes' ? value : valueState.appearance.toes.finish
        }
      }
    })
  }

  function updateLinked(linked: boolean) {
    onChange({
      ...valueState,
      appearance: {
        ...valueState.appearance,
        linked,
        toes: linked
          ? {
              ...valueState.appearance.toes,
              color: [...valueState.appearance.fingers.color],
              finish: valueState.appearance.fingers.finish
            }
          : valueState.appearance.toes
      }
    })
  }

  function clearArtwork(family: NailFamily) {
    onChange({
      ...valueState,
      appearance: {
        ...valueState.appearance,
        [family]: { ...valueState.appearance[family], artwork: null }
      }
    })
  }

  async function downloadTemplate(family: NailFamily, event: MouseEvent) {
    event.preventDefault()
    if (downloadFamily) return
    downloadFamily = family
    downloadError = ''
    try {
      const template = definition.templates[family]
      const response = await fetch(`/${template.guide.path}`)
      if (!response.ok) throw new Error(`Download failed (${response.status}).`)
      await downloadBlob(await response.blob(), `batshit-${family}-nail-artwork-template.png`, {
        title: `Save ${family === 'fingers' ? 'Fingernail' : 'Toenail'} Artwork Template`,
        mimeType: 'image/png'
      })
    } catch (error) {
      downloadError = error instanceof Error ? error.message : String(error)
    } finally {
      downloadFamily = null
    }
  }

  async function handleFile(family: NailFamily, file: File | undefined) {
    if (!file || disabled || uploadFamily || !uploadProvenance) return
    uploadFamily = family
    uploadError = ''
    onUploadBusyChange?.(true)
    try {
      const artwork = await onUpload(family, file, uploadProvenance)
      onChange({
        ...valueState,
        appearance: {
          ...valueState.appearance,
          [family]: { ...valueState.appearance[family], artwork }
        }
      })
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error)
    } finally {
      uploadFamily = null
      onUploadBusyChange?.(false)
    }
  }

  function formatControl(value: number) {
    return `${Math.round(value * 100)}%`
  }

  function displayShape(value: string) {
    return value
      .split('-')
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(' ')
  }
</script>

<FacialArtworkAccordion
  id="nail-surface"
  title="Nails"
  info={[
    'Fingernails and toenails are solid, lit surfaces with independent geometry and artwork.',
    'Arch adds the left-to-right C curve while keeping both sidewalls seated.',
    'Very narrow Fingernail Width plus Pointed shape and extra Length creates a straight fantasy claw profile.',
    'Toenails leave the seated nail bed on a straight free edge instead of wrapping around the toe tip.',
    'Turn Use Nail Surface off when the Base Color Artwork already contains the fingernails and toenails you want.'
  ]}
  {open}
  {changed}
  {disabled}
  onToggle={() => (open = !open)}
  onReset={() => {
    onChange(createDefaultNailSurfaceState(definition))
    onSurfaceEnabledChange(true)
  }}
>
  <div class="nail-surface-editor">
    <div class="nail-link-row">
      <span class="nail-link-icon"><Power aria-hidden="true" /></span>
      <div>
        <GoonsFieldLabel
          label="Use Nail Surface"
          info="Turn this off to hide Batshit's separate fingernail and toenail meshes completely, revealing only nails painted into Base Color Artwork."
          ariaLabel="About Using Nail Surface"
        />
        <p>{surfaceEnabled ? 'Nail meshes are visible' : 'Nail meshes are off'}</p>
      </div>
      <Switch.Root
        checked={surfaceEnabled}
        onCheckedChange={onSurfaceEnabledChange}
        {disabled}
        aria-label="Use Nail Surface"
      />
    </div>
    <div class="nail-link-row">
      <span class="nail-link-icon">
        {#if valueState.appearance.linked}
          <Link2 aria-hidden="true" />
        {:else}
          <Unlink2 aria-hidden="true" />
        {/if}
      </span>
      <div>
        <GoonsFieldLabel
          label="Link Finger & Toe Color"
          info="Linked mode keeps Nail Color and Finish together. Geometry and artwork remain independent."
          ariaLabel="About Linked Nail Color"
        />
        <p>Color and Finish only</p>
      </div>
      <Switch.Root
        checked={valueState.appearance.linked}
        onCheckedChange={updateLinked}
        {disabled}
        aria-label="Link Finger and Toe Nail Color"
      />
    </div>

    <section class="nail-upload-credit" aria-label="Nail Artwork Upload Credit">
      <GoonsFieldLabel
        label="Artwork Upload Credit"
        info="Batshit saves source and permission details with every uploaded nail PNG."
        ariaLabel="About Nail Artwork Upload Credit"
      />
      <div class="nail-credit-grid">
        <label>
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
            <Select.Trigger class="w-full" aria-label="Source" {disabled}>{sourceLabel}</Select.Trigger>
            <Select.Content>
              {#each sourceOptions as option (option.value)}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </label>
        {#if selfAuthored}
          <div>
            <span>Credited to</span>
            <div class="nail-credit-display bs-input">
              <span>{ownerDisplayName.trim() || 'Your display name is missing'}</span>
              <SettingsInfoMenu ariaLabel="About Nail Artwork Credit" align="end">
                <p>Uploading confirms you created this artwork and may use it.</p>
              </SettingsInfoMenu>
            </div>
          </div>
        {:else}
          <label>
            <span>Artist or source</span>
            <Input
              value={creditDraft.externalAuthor}
              placeholder="Name or source"
              {disabled}
              oninput={(event) =>
                updateCreditDraft({ externalAuthor: (event.currentTarget as HTMLInputElement).value })}
            />
          </label>
          <label>
            <span>License or permission note</span>
            <Input
              value={creditDraft.externalLicense}
              placeholder="License or permission"
              {disabled}
              oninput={(event) =>
                updateCreditDraft({ externalLicense: (event.currentTarget as HTMLInputElement).value })}
            />
          </label>
          <label class="nail-rights">
            <input
              type="checkbox"
              checked={creditDraft.externalRightsConfirmed}
              {disabled}
              onchange={(event) =>
                updateCreditDraft({
                  externalRightsConfirmed: (event.currentTarget as HTMLInputElement).checked
                })}
            />
            <span>I confirm I have permission to use this artwork.</span>
          </label>
        {/if}
      </div>
      {#if !uploadProvenance}
        <p class="nail-help" role="status">{provenanceResolution.missingReason}</p>
      {/if}
    </section>

    {#each families as family (family.id)}
      {@const controls = definition.controls[family.id]}
      {@const geometry = valueState.geometry[family.id]}
      {@const appearance = valueState.appearance[family.id]}
      {@const template = definition.templates[family.id]}
      <section class="nail-family">
        <div class="nail-family-heading">
          <div>
            <h4>{family.label}</h4>
            <p>{template.dimensions[0]} × {template.dimensions[1]} PNG · ten labeled slots</p>
          </div>
          <a
            href={`/${template.guide.path}`}
            download
            aria-busy={downloadFamily === family.id}
            onclick={(event) => void downloadTemplate(family.id, event)}
          >
            <Download aria-hidden="true" />
            {downloadFamily === family.id ? 'Saving…' : 'Template'}
          </a>
        </div>

        {#each ['length', 'width', 'arch'] as field}
          {@const control = controls[field as 'length' | 'width' | 'arch']}
          <label class="nail-slider-control">
            <span>
              <GoonsFieldLabel
                label={control.label}
                info={control.description}
                ariaLabel={`About ${control.label}`}
              />
              <output>{formatControl(geometry[field as 'length' | 'width' | 'arch'])}</output>
            </span>
            <Slider
              type="single"
              value={geometry[field as 'length' | 'width' | 'arch']}
              min={control.minimum}
              max={control.maximum}
              step={control.step}
              fillFrom={control.default}
              showAnchorMarker={control.minimum < control.default && control.maximum > control.default}
              aria-label={control.label}
              {disabled}
              onValueChange={(value: number | number[]) =>
                updateGeometry(
                  family.id,
                  field as 'length' | 'width' | 'arch',
                  value
                )}
            />
          </label>
        {/each}

        <label class="nail-select-control">
          <GoonsFieldLabel
            label={controls.shape.label}
            info={family.id === 'fingers'
              ? 'Round, Soft Square, Almond, or Pointed. Shape never swaps topology.'
              : 'Toenails support the anatomy-safe Round and Soft Square presets.'}
            ariaLabel={`About ${controls.shape.label}`}
          />
          <Select.Root
            type="single"
            value={geometry.shape}
            items={controls.shape.options.map((value) => ({ value, label: displayShape(value) }))}
            onValueChange={(value: string) => updateShape(family.id, value)}
          >
            <Select.Trigger class="w-full" aria-label={controls.shape.label} {disabled}>
              {displayShape(geometry.shape)}
            </Select.Trigger>
            <Select.Content>
              {#each controls.shape.options as option (option)}
                <Select.Item value={option}>{displayShape(option)}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </label>

        <div class="nail-appearance-grid">
          <label class="nail-color-control">
            <GoonsFieldLabel
              label={`${family.singular} Color`}
              info="Transparent Nail Artwork pixels reveal this literal solid color."
              ariaLabel={`About ${family.singular} Color`}
            />
            <span>{nailSurfaceRgbToHex(appearance.color)}</span>
            <input
              type="color"
              value={nailSurfaceRgbToHex(appearance.color)}
              aria-label={`${family.singular} Color`}
              {disabled}
              oninput={(event) =>
                updateColor(family.id, (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label class="nail-select-control">
            <GoonsFieldLabel
              label={`${family.singular} Finish`}
              info="Natural, Matte, and Glossy are light-reactive material presets."
              ariaLabel={`About ${family.singular} Finish`}
            />
            <Select.Root
              type="single"
              value={appearance.finish}
              items={finishOptions}
              onValueChange={(value: string) => updateFinish(family.id, value)}
            >
              <Select.Trigger class="w-full" aria-label={`${family.singular} Finish`} {disabled}>
                {finishOptions.find((option) => option.value === appearance.finish)?.label}
              </Select.Trigger>
              <Select.Content>
                {#each finishOptions as option (option.value)}
                  <Select.Item value={option.value}>{option.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </label>
        </div>

        {#if family.id === 'fingers'}
          <input
            bind:this={fingerFileInput}
            class="nail-file-input"
            type="file"
            accept="image/png,.png"
            aria-label="Choose Fingernail Artwork PNG"
            onchange={(event) => {
              const input = event.currentTarget as HTMLInputElement
              void handleFile('fingers', input.files?.[0])
              input.value = ''
            }}
          />
        {:else}
          <input
            bind:this={toeFileInput}
            class="nail-file-input"
            type="file"
            accept="image/png,.png"
            aria-label="Choose Toenail Artwork PNG"
            onchange={(event) => {
              const input = event.currentTarget as HTMLInputElement
              void handleFile('toes', input.files?.[0])
              input.value = ''
            }}
          />
        {/if}
        <div class="nail-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || uploadFamily !== null || !uploadProvenance}
            onclick={() =>
              (family.id === 'fingers' ? fingerFileInput : toeFileInput)?.click()}
          >
            <ImagePlus aria-hidden="true" />
            {uploadFamily === family.id
              ? 'Checking PNG…'
              : appearance.artwork
                ? 'Replace PNG'
                : 'Upload PNG'}
          </Button>
          {#if appearance.artwork}
            <Button
              variant="ghost"
              size="sm"
              {disabled}
              onclick={() => clearArtwork(family.id)}
            >
              Use Nail Color Only
            </Button>
            <span class="nail-file-name">{appearance.artwork.filename}</span>
          {/if}
        </div>
      </section>
    {/each}

    {#if downloadError}
      <p class="nail-error" role="alert">Could not save template: {downloadError}</p>
    {/if}
    {#if uploadError}
      <p class="nail-error" role="alert">{uploadError}</p>
    {/if}
    <p class="nail-help">
      Opaque artwork stays literal. Transparent pixels reveal Nail Color and never cut holes in the nail.
    </p>
  </div>
</FacialArtworkAccordion>

<style>
  .nail-surface-editor,
  .nail-family,
  .nail-slider-control,
  .nail-select-control,
  .nail-credit-grid,
  .nail-credit-grid > label,
  .nail-credit-grid > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .nail-surface-editor {
    gap: 14px;
  }

  .nail-family {
    gap: 11px;
    padding: 12px;
    border: 1px solid var(--bs-settings-inner-line);
    border-radius: 8px;
    background: color-mix(in srgb, var(--background) 55%, transparent);
  }

  .nail-family-heading,
  .nail-family-heading a,
  .nail-link-row,
  .nail-link-icon,
  .nail-slider-control > span,
  .nail-color-control,
  .nail-actions,
  .nail-credit-display,
  .nail-rights {
    display: flex;
    min-width: 0;
    align-items: center;
  }

  .nail-family-heading,
  .nail-slider-control > span {
    justify-content: space-between;
    gap: 8px;
  }

  .nail-family-heading h4 {
    color: var(--foreground);
    font-size: 0.72rem;
    font-weight: 700;
  }

  .nail-family-heading p,
  .nail-link-row p,
  .nail-help,
  .nail-file-name {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    line-height: 1.45;
  }

  .nail-family-heading a {
    flex-shrink: 0;
    gap: 5px;
    color: var(--primary);
    font-size: 0.625rem;
    font-weight: 650;
  }

  .nail-family-heading a :global(svg),
  .nail-actions :global(svg),
  .nail-link-icon :global(svg) {
    width: 14px;
    height: 14px;
  }

  .nail-link-row {
    gap: 9px;
    padding: 10px 12px;
    border: 1px solid var(--bs-settings-inner-line);
    border-radius: 8px;
  }

  .nail-link-row > div {
    min-width: 0;
    flex: 1;
  }

  .nail-link-icon {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    justify-content: center;
    border-radius: 6px;
    background: var(--bs-settings-hover);
    color: var(--primary);
  }

  .nail-slider-control,
  .nail-select-control {
    gap: 7px;
  }

  .nail-slider-control :global(.batshit-goons-field-label),
  .nail-color-control :global(.batshit-goons-field-label) {
    min-width: 0;
    flex: 1;
  }

  .nail-slider-control output,
  .nail-color-control > span {
    flex-shrink: 0;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }

  .nail-appearance-grid,
  .nail-credit-grid {
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .nail-color-control {
    align-self: end;
    gap: 8px;
    min-height: 32px;
  }

  .nail-color-control input[type='color'] {
    width: 30px;
    height: 24px;
    flex-shrink: 0;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--background);
    cursor: pointer;
  }

  .nail-upload-credit {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
  }

  .nail-credit-grid > label,
  .nail-credit-grid > div {
    gap: 5px;
  }

  .nail-credit-grid label > span,
  .nail-credit-grid > div > span {
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .nail-credit-display {
    height: 2rem;
    justify-content: space-between;
    gap: 6px;
    padding: 0 0.58rem;
    font-size: 0.7rem;
  }

  .nail-rights {
    grid-column: 1 / -1;
    flex-direction: row !important;
    gap: 7px !important;
  }

  .nail-actions {
    flex-wrap: wrap;
    gap: 7px;
  }

  .nail-file-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nail-file-input {
    display: none;
  }

  .nail-error {
    color: var(--destructive);
    font-size: 0.625rem;
    line-height: 1.45;
  }

  @media (max-width: 560px) {
    .nail-appearance-grid,
    .nail-credit-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
