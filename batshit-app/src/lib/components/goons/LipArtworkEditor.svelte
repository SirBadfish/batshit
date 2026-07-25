<script lang="ts">
  import { Download, ImagePlus, RotateCcw } from '@lucide/svelte'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Slider } from '$lib/components/ui/slider'
  import GoonsFieldLabel from './GoonsFieldLabel.svelte'
  import FacialArtworkAccordion from './FacialArtworkAccordion.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { downloadBlob } from '$lib/utils/download'
  import {
    lipArtworkHexToRgb,
    lipArtworkRgbToHex,
    type LipArtworkDefinitionV2,
    type LipArtworkStateV2,
    type LipArtworkUpload
  } from '$lib/goons/lipArtwork'
  import type { FacialArtworkProvenance } from '$lib/goons/facialArtwork'
  import {
    resolveFacialArtworkUploadProvenance,
    type FacialArtworkUploadCreditDraft,
    type FacialArtworkUploadSourceKind
  } from '$lib/goons/facialArtwork.provenance'

  type Props = {
    definition: LipArtworkDefinitionV2
    valueState: LipArtworkStateV2 | null
    ownerDisplayName: string
    creditDraft: FacialArtworkUploadCreditDraft
    disabled?: boolean
    onCreditDraftChange: (draft: FacialArtworkUploadCreditDraft) => void
    onChange: (state: LipArtworkStateV2 | null) => void
    onUpload: (file: File, provenance: FacialArtworkProvenance) => Promise<LipArtworkUpload>
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

  let open = $state(false)
  let fileInput = $state<HTMLInputElement | null>(null)
  let uploadBusy = $state(false)
  let uploadError = $state('')
  let downloadBusy = $state(false)
  let downloadError = $state('')

  const sourceOptions: Array<{ value: FacialArtworkUploadSourceKind; label: string }> = [
    { value: 'user-authored', label: 'My artwork' },
    { value: 'comfyui-generated', label: 'Made by me with ComfyUI' },
    { value: 'approved-external', label: 'External artwork I may use' }
  ]
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

  async function downloadTemplate(event: MouseEvent) {
    event.preventDefault()
    if (downloadBusy) return
    downloadBusy = true
    downloadError = ''
    try {
      const response = await fetch(`/${definition.template.guide.path}`)
      if (!response.ok) throw new Error(`Download failed (${response.status}).`)
      await downloadBlob(await response.blob(), 'batshit-lip-artwork-template.png', {
        title: 'Save Lip Artwork Template',
        mimeType: 'image/png'
      })
    } catch (error) {
      downloadError = error instanceof Error ? error.message : String(error)
    } finally {
      downloadBusy = false
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file || disabled || uploadBusy || !uploadProvenance) return
    uploadBusy = true
    uploadError = ''
    onUploadBusyChange?.(true)
    try {
      const artwork = await onUpload(file, uploadProvenance)
      onChange({
        schemaVersion: 'lip-artwork-state/v2',
        definitionSha256: definition.definitionSha256,
        artwork,
        tint: [1, 1, 1],
        opacity: 1
      })
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error)
    } finally {
      uploadBusy = false
      onUploadBusyChange?.(false)
    }
  }

  function updateTint(value: string) {
    const tint = lipArtworkHexToRgb(value)
    if (valueState && tint) onChange({ ...valueState, tint })
  }

  function updateOpacity(value: number | number[]) {
    const opacity = typeof value === 'number' ? value : value[0]
    if (valueState && typeof opacity === 'number') onChange({ ...valueState, opacity })
  }
</script>

<FacialArtworkAccordion
  id="lip-artwork"
  title="Lip Artwork"
  info={[
    'The Template is a front-view guide: cyan is the package-authored base-lip reference, but this experiment does not require you to cover all of it. Pale gray is additional safe room and pink is forbidden. Paint on a separate transparent layer, then hide the guide before export.',
    'Upload a transparent PNG that controls the exact painted lip shape and alpha.',
    'Lip Color and Opacity stay independent, so you can recolor the same artwork without changing its edge.',
    'Reset restores the artwork authored in the installed Goon package.'
  ]}
  {open}
  changed={valueState !== null}
  {disabled}
  onToggle={() => (open = !open)}
  onReset={() => onChange(null)}
>
  <div class="lip-artwork-editor" aria-busy={uploadBusy}>
    <div class="lip-artwork-template-row">
      <span>{definition.template.dimensions[0]} × {definition.template.dimensions[1]} PNG</span>
      <a
        href={`/${definition.template.guide.path}`}
        download
        aria-busy={downloadBusy}
        onclick={(event) => void downloadTemplate(event)}
      >
        <Download aria-hidden="true" />
        {downloadBusy ? 'Saving…' : 'Template'}
      </a>
    </div>
    {#if downloadError}
      <p class="lip-artwork-error" role="alert">Could not save template: {downloadError}</p>
    {/if}

    <section class="lip-artwork-credit" aria-label="Lip Artwork Upload Credit">
      <GoonsFieldLabel
        label="Upload Credit"
        info="Batshit saves source and permission details with every uploaded PNG."
        ariaLabel="About Lip Artwork Upload Credit"
      />
      <div class="lip-artwork-credit-grid">
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
            <div class="lip-artwork-credit-display bs-input">
              <span>{ownerDisplayName.trim() || 'Your display name is missing'}</span>
              <SettingsInfoMenu ariaLabel="About Lip Artwork Credit" align="end">
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
          <label class="lip-artwork-rights">
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
        <p class="lip-artwork-help" role="status">{provenanceResolution.missingReason}</p>
      {/if}
    </section>

    <input
      bind:this={fileInput}
      class="lip-artwork-file-input"
      type="file"
      accept="image/png,.png"
      aria-label="Choose Lip Artwork PNG"
      onchange={(event) => {
        const input = event.currentTarget as HTMLInputElement
        void handleFile(input.files?.[0])
        input.value = ''
      }}
    />
    <div class="lip-artwork-actions">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || uploadBusy || !uploadProvenance}
        onclick={() => fileInput?.click()}
      >
        <ImagePlus aria-hidden="true" />
        {uploadBusy ? 'Checking PNG…' : valueState ? 'Replace PNG' : 'Upload PNG'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || valueState === null}
        onclick={() => onChange(null)}
      >
        <RotateCcw aria-hidden="true" /> Use Package Artwork
      </Button>
    </div>
    {#if uploadError}
      <p class="lip-artwork-error" role="alert">{uploadError}</p>
    {/if}

    {#if valueState}
      <label class="lip-artwork-color">
        <GoonsFieldLabel
          label="Lip Color"
          info="Multiplies the uploaded PNG color without changing its alpha or painted edge."
          ariaLabel="About Lip Color"
        />
        <span>{lipArtworkRgbToHex(valueState.tint)}</span>
        <input
          type="color"
          value={lipArtworkRgbToHex(valueState.tint)}
          aria-label="Lip Color"
          {disabled}
          oninput={(event) => updateTint((event.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <label class="lip-artwork-opacity">
        <span>
          <GoonsFieldLabel
            label="Opacity"
            info="Changes artwork strength while preserving the PNG edge."
            ariaLabel="About Lip Artwork Opacity"
          />
          <output>{Math.round(valueState.opacity * 100)}%</output>
        </span>
        <Slider
          type="single"
          value={valueState.opacity}
          min={0}
          max={1}
          step={0.01}
          fillFrom={1}
          aria-label="Lip Artwork Opacity"
          {disabled}
          onValueChange={updateOpacity}
        />
      </label>
      <p class="lip-artwork-file-name">{valueState.artwork.filename}</p>
    {:else}
      <p class="lip-artwork-help">Using the lip artwork built into this Goon package.</p>
    {/if}
  </div>
</FacialArtworkAccordion>

<style>
  .lip-artwork-editor,
  .lip-artwork-opacity,
  .lip-artwork-credit-grid,
  .lip-artwork-credit-grid > label,
  .lip-artwork-credit-grid > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .lip-artwork-editor {
    gap: 12px;
  }

  .lip-artwork-template-row,
  .lip-artwork-actions,
  .lip-artwork-color,
  .lip-artwork-opacity > span,
  .lip-artwork-credit-display,
  .lip-artwork-rights {
    display: flex;
    min-width: 0;
    align-items: center;
  }

  .lip-artwork-template-row,
  .lip-artwork-opacity > span {
    justify-content: space-between;
    gap: 8px;
  }

  .lip-artwork-template-row,
  .lip-artwork-help,
  .lip-artwork-file-name,
  .lip-artwork-error {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
  }

  .lip-artwork-template-row a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--foreground);
    font-weight: 600;
  }

  .lip-artwork-template-row a :global(svg),
  .lip-artwork-actions :global(svg) {
    width: 14px;
    height: 14px;
  }

  .lip-artwork-credit {
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: color-mix(in srgb, var(--muted) 30%, transparent);
  }

  .lip-artwork-credit-grid {
    gap: 9px;
    margin-top: 8px;
  }

  .lip-artwork-credit-grid > label,
  .lip-artwork-credit-grid > div {
    gap: 5px;
  }

  .lip-artwork-credit-grid > label > span,
  .lip-artwork-credit-grid > div > span {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-weight: 600;
  }

  .lip-artwork-credit-display {
    justify-content: space-between;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
  }

  .lip-artwork-rights {
    flex-direction: row !important;
    gap: 8px !important;
  }

  .lip-artwork-file-input {
    display: none;
  }

  .lip-artwork-actions {
    flex-wrap: wrap;
    gap: 8px;
  }

  .lip-artwork-color {
    gap: 8px;
  }

  .lip-artwork-color :global(.batshit-goons-field-label),
  .lip-artwork-opacity :global(.batshit-goons-field-label) {
    min-width: 0;
    flex: 1;
  }

  .lip-artwork-color > span,
  .lip-artwork-opacity output {
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-variant-numeric: tabular-nums;
  }

  .lip-artwork-color input[type='color'] {
    width: 30px;
    height: 24px;
    flex-shrink: 0;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--background);
  }

  .lip-artwork-opacity {
    gap: 7px;
  }

  .lip-artwork-error {
    color: var(--destructive);
  }
</style>
