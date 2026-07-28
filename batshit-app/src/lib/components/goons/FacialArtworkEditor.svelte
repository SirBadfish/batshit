<script lang="ts">
  import { RotateCcw } from '@lucide/svelte'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import GoonsFieldLabel from '$lib/components/goons/GoonsFieldLabel.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import FacialArtworkAccordion from './FacialArtworkAccordion.svelte'
  import FacialArtworkPhysicalSlider from './FacialArtworkPhysicalSlider.svelte'
  import FacialArtworkSurfaceEditor from './FacialArtworkSurfaceEditor.svelte'
  import {
    createDefaultFacialArtworkState,
    type FacialArtworkDefinitionV4,
    type FacialArtworkOrientation,
    type FacialArtworkProvenance,
    type FacialArtworkRoleId,
    type FacialArtworkStateV4,
    type FacialArtworkUpload
  } from '$lib/goons/facialArtwork'
  import { cloneFacialArtworkState } from '$lib/goons/facialArtwork.editor'
  import {
    resolveFacialArtworkUploadProvenance,
    type FacialArtworkUploadCreditDraft,
    type FacialArtworkUploadSourceKind
  } from '$lib/goons/facialArtwork.provenance'
  import {
    createDefaultEyeAppearanceState,
    readEyeAppearanceControl,
    updateEyeAppearanceControl,
    type EyeAppearanceControlId,
    type EyeAppearanceDefinitionV3,
    type EyeAppearanceStateV3
  } from '$lib/goons/eyeAppearance'

  export type FacialArtworkEditorScope = 'brows' | 'eyes'
  type SectionId = 'brows' | 'lashes' | 'iris' | 'pupil' | 'highlight' | 'sclera'

  type Props = {
    scope: FacialArtworkEditorScope
    definition: FacialArtworkDefinitionV4
    eyeAppearanceDefinition: EyeAppearanceDefinitionV3
    valueState: FacialArtworkStateV4
    eyeAppearanceState: EyeAppearanceStateV3
    ownerDisplayName: string
    creditDraft: FacialArtworkUploadCreditDraft
    disabled?: boolean
    onCreditDraftChange: (draft: FacialArtworkUploadCreditDraft) => void
    onChange: (state: FacialArtworkStateV4) => void
    onEyeAppearanceChange: (state: EyeAppearanceStateV3) => void
    onUpload: (
      roleId: FacialArtworkRoleId,
      file: File,
      provenance: FacialArtworkProvenance,
      orientation: FacialArtworkOrientation
    ) => Promise<FacialArtworkUpload>
    onUploadBusyChange?: (busy: boolean) => void
  }

  let {
    scope,
    definition,
    eyeAppearanceDefinition,
    valueState,
    eyeAppearanceState,
    ownerDisplayName,
    creditDraft,
    disabled = false,
    onCreditDraftChange,
    onChange,
    onEyeAppearanceChange,
    onUpload,
    onUploadBusyChange
  }: Props = $props()

  let openSection = $state<SectionId | null>(null)

  const sourceOptions: Array<{ value: FacialArtworkUploadSourceKind; label: string }> = [
    { value: 'user-authored', label: 'My artwork' },
    { value: 'comfyui-generated', label: 'Made by me with ComfyUI' },
    { value: 'approved-external', label: 'External artwork I may use' }
  ]
  const scopedSectionIds = $derived<SectionId[]>(
    scope === 'brows' ? ['brows'] : ['lashes', 'iris', 'pupil', 'highlight', 'sclera']
  )
  const sourceLabel = $derived(
    sourceOptions.find((option) => option.value === creditDraft.sourceKind)?.label ?? 'Choose source'
  )
  const defaultArtworkState = $derived.by(() => createDefaultFacialArtworkState(definition))
  const defaultEyeAppearanceState = $derived.by(() =>
    createDefaultEyeAppearanceState(eyeAppearanceDefinition)
  )
  const provenanceResolution = $derived.by(() =>
    resolveFacialArtworkUploadProvenance({
      ...creditDraft,
      ownerDisplayName
    })
  )
  const uploadProvenance = $derived<FacialArtworkProvenance | null>(
    provenanceResolution.provenance
  )
  const selfAuthored = $derived(creditDraft.sourceKind !== 'approved-external')

  const sectionRoleIds: Record<SectionId, FacialArtworkRoleId[]> = {
    brows: ['brows'],
    lashes: ['lashes_eye_outline'],
    iris: ['iris'],
    pupil: ['pupil'],
    highlight: ['eye_highlight'],
    sclera: ['sclera']
  }

  const sectionEyeControlIds: Partial<Record<SectionId, EyeAppearanceControlId[]>> = {
    iris: ['iris_size', 'iris_vertical_position'],
    pupil: ['pupil_size']
  }

  function updateCreditDraft(update: Partial<FacialArtworkUploadCreditDraft>) {
    onCreditDraftChange({ ...creditDraft, ...update })
  }

  function sectionChanged(sectionId: SectionId): boolean {
    const artworkChanged = sectionRoleIds[sectionId].some(
      (roleId) =>
        JSON.stringify(valueState.roles[roleId]) !==
        JSON.stringify(defaultArtworkState.roles[roleId])
    )
    const eyeChanged = (sectionEyeControlIds[sectionId] ?? []).some(
      (controlId) =>
        readEyeAppearanceControl(eyeAppearanceState, controlId) !==
        readEyeAppearanceControl(defaultEyeAppearanceState, controlId)
    )
    return artworkChanged || eyeChanged
  }

  const changedSectionCount = $derived(scopedSectionIds.filter(sectionChanged).length)

  function resetSections(sectionIds: SectionId[]) {
    if (disabled) return
    const artwork = cloneFacialArtworkState(valueState)
    for (const sectionId of sectionIds) {
      for (const roleId of sectionRoleIds[sectionId]) {
        artwork.roles[roleId] = structuredClone(defaultArtworkState.roles[roleId])
      }
    }
    onChange(artwork)

    let eyeAppearance = eyeAppearanceState
    for (const sectionId of sectionIds) {
      for (const controlId of sectionEyeControlIds[sectionId] ?? []) {
        eyeAppearance = updateEyeAppearanceControl(
          eyeAppearance,
          controlId,
          readEyeAppearanceControl(defaultEyeAppearanceState, controlId)
        )
      }
    }
    if (eyeAppearance !== eyeAppearanceState) onEyeAppearanceChange(eyeAppearance)
  }

  function resetSection(sectionId: SectionId) {
    resetSections([sectionId])
  }

  function resetAll() {
    resetSections(scopedSectionIds)
  }

  function eyeControl(id: EyeAppearanceControlId) {
    return eyeAppearanceDefinition.controls.find((control) => control.id === id)!
  }

  const irisSizeControl = $derived(eyeControl('iris_size'))
  const irisVerticalPositionControl = $derived(eyeControl('iris_vertical_position'))
  const pupilSizeControl = $derived(eyeControl('pupil_size'))

  function updateEyeControl(id: EyeAppearanceControlId, value: number) {
    if (disabled) return
    onEyeAppearanceChange(updateEyeAppearanceControl(eyeAppearanceState, id, value))
  }

  function toggleSection(sectionId: SectionId) {
    openSection = openSection === sectionId ? null : sectionId
  }
</script>

<div class="facial-artwork-editor">
  <div class="facial-artwork-toolbar">
    <span class="facial-artwork-change-count" aria-live="polite">
      {changedSectionCount} changed
    </span>
    <Button variant="outline" size="sm" onclick={resetAll} disabled={disabled || changedSectionCount === 0}>
      <RotateCcw aria-hidden="true" /> Reset Artwork
    </Button>
  </div>

  <section class="facial-artwork-provenance" aria-label={`${scope === 'brows' ? 'Brow' : 'Eye'} Upload Credit`}>
    <GoonsFieldLabel
      label="Upload Credit"
      info="Choose where the artwork came from. Batshit saves this credit with every PNG."
      ariaLabel={`About ${scope === 'brows' ? 'Brow' : 'Eye'} Upload Credit`}
    />
    <div class="facial-artwork-credit-grid">
      <label class="facial-artwork-credit-field">
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
          <Select.Trigger class="w-full" aria-label="Source" disabled={disabled}>
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
        <div class="facial-artwork-credit-field">
          <span>Credited to</span>
          <div class="facial-artwork-credit-display bs-input">
            <span>{ownerDisplayName.trim() || 'Your display name is missing'}</span>
            <SettingsInfoMenu ariaLabel="About Artwork Credit Confirmation" align="end">
              <p>
                {creditDraft.sourceKind === 'comfyui-generated'
                  ? 'Uploading confirms you created this output and may use it.'
                  : 'Uploading confirms this is your work and you may use it.'}
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
      {:else}
        <label class="facial-artwork-credit-field">
          <span>Artist or source</span>
          <Input
            value={creditDraft.externalAuthor}
            placeholder="Name or source"
            disabled={disabled}
            oninput={(event) =>
              updateCreditDraft({ externalAuthor: (event.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label class="facial-artwork-credit-field">
          <span>License or permission note</span>
          <Input
            value={creditDraft.externalLicense}
            placeholder="License or permission"
            disabled={disabled}
            oninput={(event) =>
              updateCreditDraft({ externalLicense: (event.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label class="facial-artwork-rights">
          <input
            type="checkbox"
            checked={creditDraft.externalRightsConfirmed}
            disabled={disabled}
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
      <p class="facial-artwork-credit-help" role="status">
        {provenanceResolution.missingReason}
      </p>
    {/if}
  </section>

  <div class="goon-level-3-accordion-list">
    {#if scope === 'brows'}
      <FacialArtworkAccordion
        id="brows"
        title="Brow Artwork"
        info={[
          'Add transparent brow artwork fitted to the brow canvases.',
          "Canonical Goon Left artwork mirrors to the Goon's Right automatically."
        ]}
        open={openSection === 'brows'}
        changed={sectionChanged('brows')}
        {disabled}
        onToggle={() => toggleSection('brows')}
        onReset={() => resetSection('brows')}
      >
        <FacialArtworkSurfaceEditor
          {definition}
          {valueState}
          roleId="brows"
          label="Brow Artwork"
          leftLabel="Goon's Left Brow (viewer's right)"
          rightLabel="Goon's Right Brow (viewer's left)"
          {disabled}
          provenance={uploadProvenance}
          {onChange}
          {onUpload}
          {onUploadBusyChange}
        />
      </FacialArtworkAccordion>
    {:else}
      <FacialArtworkAccordion
        id="lashes"
        title="Lash & Outline Artwork"
        info={[
          'Add lashes, liner, or another transparent outline around the eyes.',
          "Canonical Goon Left artwork mirrors to the Goon's Right automatically.",
          'Use the open-eye Template as a reference layer. The dark gridded region covers the upper lid, lower lid, both corners, and wing; pink is forbidden. Paint on a separate transparent layer, then hide or remove the Template before exporting your PNG. Batshit enforces the exact paintable region automatically.'
        ]}
        open={openSection === 'lashes'}
        changed={sectionChanged('lashes')}
        {disabled}
        onToggle={() => toggleSection('lashes')}
        onReset={() => resetSection('lashes')}
      >
        <FacialArtworkSurfaceEditor
          {definition}
          {valueState}
          roleId="lashes_eye_outline"
          label="Lash & Outline Artwork"
          leftLabel="Goon's Left Eye (viewer's right)"
          rightLabel="Goon's Right Eye (viewer's left)"
          {disabled}
          provenance={uploadProvenance}
          {onChange}
          {onUpload}
          {onUploadBusyChange}
        />
      </FacialArtworkAccordion>

      <FacialArtworkAccordion
        id="iris"
        title="Iris Artwork"
        info="Choose a solid iris color, then optionally layer custom artwork over it."
        open={openSection === 'iris'}
        changed={sectionChanged('iris')}
        {disabled}
        onToggle={() => toggleSection('iris')}
        onReset={() => resetSection('iris')}
      >
        <section class="facial-artwork-subsection">
          <FacialArtworkSurfaceEditor
            {definition}
            {valueState}
            roleId="iris"
            label="Iris"
            {disabled}
            provenance={uploadProvenance}
            {onChange}
            {onUpload}
            {onUploadBusyChange}
          />
          <div class="facial-artwork-physical-group">
            <GoonsFieldLabel
              label="Physical Size & Position"
              info="Linked across both eyes. Position moves Iris, Pupil, and Highlight together without changing gaze."
              ariaLabel="About Iris Physical Size and Position"
            />
            <FacialArtworkPhysicalSlider
              id="facial-artwork-iris-size"
              label={irisSizeControl.label}
              value={eyeAppearanceState.irisSize}
              range={[irisSizeControl.minimum, irisSizeControl.maximum]}
              step={irisSizeControl.step}
              {disabled}
              onChange={(value) => updateEyeControl('iris_size', value)}
            />
            <FacialArtworkPhysicalSlider
              id="facial-artwork-iris-vertical-position"
              label={irisVerticalPositionControl.label}
              description="Move both irises up or down. Pupils and highlights stay centered with them."
              value={eyeAppearanceState.irisVerticalPosition}
              range={[
                irisVerticalPositionControl.minimum,
                irisVerticalPositionControl.maximum
              ]}
              step={irisVerticalPositionControl.step}
              {disabled}
              onChange={(value) => updateEyeControl('iris_vertical_position', value)}
            />
          </div>
        </section>
      </FacialArtworkAccordion>

      <FacialArtworkAccordion
        id="pupil"
        title="Pupil Artwork"
        info="Choose a solid pupil color, then optionally layer custom artwork over it."
        open={openSection === 'pupil'}
        changed={sectionChanged('pupil')}
        {disabled}
        onToggle={() => toggleSection('pupil')}
        onReset={() => resetSection('pupil')}
      >
        <section class="facial-artwork-subsection">
          <FacialArtworkSurfaceEditor
            {definition}
            {valueState}
            roleId="pupil"
            label="Pupil"
            {disabled}
            provenance={uploadProvenance}
            {onChange}
            {onUpload}
            {onUploadBusyChange}
          />
          <div class="facial-artwork-physical-group">
            <GoonsFieldLabel
              label="Physical Size"
              info="Relative to Iris Size. 1 keeps the neutral ratio; 0 hides the pupil."
              ariaLabel="About Pupil Physical Size"
            />
            <FacialArtworkPhysicalSlider
              id="facial-artwork-pupil-size"
              label={pupilSizeControl.label}
              value={eyeAppearanceState.pupilSize}
              range={[pupilSizeControl.minimum, pupilSizeControl.maximum]}
              step={pupilSizeControl.step}
              {disabled}
              onChange={(value) => updateEyeControl('pupil_size', value)}
            />
          </div>
        </section>
      </FacialArtworkAccordion>

      <FacialArtworkAccordion
        id="highlight"
        title="Eye Highlight Artwork"
        info="Add one continuous catchlight layer across the iris and pupil."
        open={openSection === 'highlight'}
        changed={sectionChanged('highlight')}
        {disabled}
        onToggle={() => toggleSection('highlight')}
        onReset={() => resetSection('highlight')}
      >
        <FacialArtworkSurfaceEditor
          {definition}
          {valueState}
          roleId="eye_highlight"
          label="Highlight Artwork"
          {disabled}
          provenance={uploadProvenance}
          {onChange}
          {onUpload}
          {onUploadBusyChange}
        />
      </FacialArtworkAccordion>

      <FacialArtworkAccordion
        id="sclera"
        title="Sclera Artwork"
        info="Set the whites of the eyes, then optionally layer custom artwork over the color."
        open={openSection === 'sclera'}
        changed={sectionChanged('sclera')}
        {disabled}
        onToggle={() => toggleSection('sclera')}
        onReset={() => resetSection('sclera')}
      >
        <FacialArtworkSurfaceEditor
          {definition}
          {valueState}
          roleId="sclera"
          label="Surface"
          {disabled}
          provenance={uploadProvenance}
          {onChange}
          {onUpload}
          {onUploadBusyChange}
        />
      </FacialArtworkAccordion>
    {/if}
  </div>
</div>

<style>
  .facial-artwork-editor,
  .facial-artwork-subsection,
  .facial-artwork-physical-group {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .facial-artwork-editor {
    container-type: inline-size;
    gap: 12px;
    padding-top: 0.75rem;
    border-top: 1px solid var(--bs-settings-inner-line);
  }

  .facial-artwork-toolbar,
  .facial-artwork-rights {
    display: flex;
    align-items: center;
  }

  .facial-artwork-toolbar {
    justify-content: flex-end;
    gap: 10px;
  }

  .facial-artwork-change-count {
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .facial-artwork-provenance {
    display: grid;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in oklch, var(--muted) 42%, transparent);
  }

  .facial-artwork-credit-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .facial-artwork-credit-field {
    display: grid;
    min-width: 0;
    gap: 4px;
  }

  .facial-artwork-credit-field > span {
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .facial-artwork-credit-display {
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 0.875rem;
  }

  .facial-artwork-credit-display > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .facial-artwork-rights {
    grid-column: 1 / -1;
    gap: 7px;
    color: var(--foreground);
    font-size: 0.6875rem;
  }

  .facial-artwork-rights input {
    accent-color: var(--primary);
  }

  .facial-artwork-credit-help {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.675rem;
    line-height: 1.45;
  }

  .facial-artwork-subsection,
  .facial-artwork-physical-group {
    gap: 10px;
  }

  .facial-artwork-physical-group {
    padding-top: 2px;
  }

  @container (max-width: 340px) {
    .facial-artwork-credit-grid {
      grid-template-columns: 1fr;
    }

    .facial-artwork-rights {
      grid-column: auto;
      align-items: flex-start;
    }

    .facial-artwork-toolbar {
      flex-wrap: wrap;
    }
  }
</style>
