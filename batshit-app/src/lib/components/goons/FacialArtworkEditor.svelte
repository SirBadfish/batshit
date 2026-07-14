<script lang="ts">
  import { RotateCcw } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import FacialArtworkAccordion from './FacialArtworkAccordion.svelte'
  import FacialArtworkPhysicalSlider from './FacialArtworkPhysicalSlider.svelte'
  import FacialArtworkSurfaceEditor from './FacialArtworkSurfaceEditor.svelte'
  import {
    createDefaultFacialArtworkState,
    type FacialArtworkDefinitionV2,
    type FacialArtworkProvenance,
    type FacialArtworkRoleId,
    type FacialArtworkStateV2,
    type FacialArtworkUpload
  } from '$lib/goons/facialArtwork'
  import { cloneFacialArtworkState } from '$lib/goons/facialArtwork.editor'
  import {
    createDefaultEyeAppearanceState,
    readEyeAppearanceControl,
    updateEyeAppearanceControl,
    type EyeAppearanceControlId,
    type EyeAppearanceDefinitionV1,
    type EyeAppearanceStateV1
  } from '$lib/goons/eyeAppearance'

  type SectionId = 'brows' | 'lashes' | 'iris-pupil' | 'highlight' | 'sclera'

  type Props = {
    definition: FacialArtworkDefinitionV2
    eyeAppearanceDefinition: EyeAppearanceDefinitionV1
    valueState: FacialArtworkStateV2
    eyeAppearanceState: EyeAppearanceStateV1
    disabled?: boolean
    onChange: (state: FacialArtworkStateV2) => void
    onEyeAppearanceChange: (state: EyeAppearanceStateV1) => void
    onUpload: (
      roleId: FacialArtworkRoleId,
      file: File,
      provenance: FacialArtworkProvenance
    ) => Promise<FacialArtworkUpload>
    onUploadBusyChange?: (busy: boolean) => void
  }

  let {
    definition,
    eyeAppearanceDefinition,
    valueState,
    eyeAppearanceState,
    disabled = false,
    onChange,
    onEyeAppearanceChange,
    onUpload,
    onUploadBusyChange
  }: Props = $props()

  let openSection = $state<SectionId | null>('brows')
  let sourceKind = $state<FacialArtworkProvenance['sourceKind']>('user-authored')
  let author = $state('')
  let license = $state('User-owned artwork')
  let rightsConfirmed = $state(false)

  const defaultArtworkState = $derived.by(() => createDefaultFacialArtworkState(definition))
  const defaultEyeAppearanceState = $derived.by(() =>
    createDefaultEyeAppearanceState(eyeAppearanceDefinition)
  )
  const provenanceReady = $derived(Boolean(author.trim() && license.trim() && rightsConfirmed))
  const uploadProvenance = $derived.by<FacialArtworkProvenance | null>(() =>
    provenanceReady
      ? {
          sourceKind,
          author: author.trim(),
          license: license.trim(),
          rightsConfirmed: true
        }
      : null
  )

  const sectionRoleIds: Record<SectionId, FacialArtworkRoleId[]> = {
    brows: ['brows'],
    lashes: ['lashes_eye_outline'],
    'iris-pupil': ['iris', 'pupil'],
    highlight: ['eye_highlight'],
    sclera: ['sclera']
  }

  const sectionEyeControlIds: Partial<Record<SectionId, EyeAppearanceControlId[]>> = {
    'iris-pupil': ['iris_size', 'pupil_size'],
    sclera: [
      'sclera_scale',
      'sclera_tilt',
      'sclera_horizontal_position',
      'sclera_vertical_position',
      'sclera_depth'
    ]
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

  const changedSectionCount = $derived(
    (Object.keys(sectionRoleIds) as SectionId[]).filter(sectionChanged).length
  )

  function roleSummary(roleId: FacialArtworkRoleId): string {
    const role = valueState.roles[roleId]
    const eyes = role.mode === 'shared' ? [role.shared] : [role.left, role.right]
    const artworkCount = eyes.filter((eye) => Boolean(eye.artwork)).length
    if (role.mode === 'per-eye') {
      return artworkCount > 0 ? `Customized, ${artworkCount} PNG${artworkCount === 1 ? '' : 's'}` : 'Customized'
    }
    return artworkCount > 0 ? 'Same for both, PNG added' : 'Same for both'
  }

  function resetSection(sectionId: SectionId) {
    if (disabled) return
    const artwork = cloneFacialArtworkState(valueState)
    for (const roleId of sectionRoleIds[sectionId]) {
      artwork.roles[roleId] = structuredClone(defaultArtworkState.roles[roleId])
    }
    onChange(artwork)

    let eyeAppearance = eyeAppearanceState
    for (const controlId of sectionEyeControlIds[sectionId] ?? []) {
      eyeAppearance = updateEyeAppearanceControl(
        eyeAppearance,
        controlId,
        readEyeAppearanceControl(defaultEyeAppearanceState, controlId)
      )
    }
    if (eyeAppearance !== eyeAppearanceState) onEyeAppearanceChange(eyeAppearance)
  }

  function resetAll() {
    if (disabled) return
    onChange(cloneFacialArtworkState(defaultArtworkState))
    onEyeAppearanceChange(structuredClone(defaultEyeAppearanceState))
  }

  function eyeControl(id: EyeAppearanceControlId) {
    return eyeAppearanceDefinition.controls.find((control) => control.id === id)!
  }

  const irisSizeControl = $derived(eyeControl('iris_size'))
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
    <div>
      <p class="facial-artwork-toolbar-title">Facial appearance</p>
      <p class="facial-artwork-summary" aria-live="polite">
        {changedSectionCount} of 5 sections changed
      </p>
    </div>
    <Button variant="outline" size="sm" onclick={resetAll} disabled={disabled || changedSectionCount === 0}>
      <RotateCcw aria-hidden="true" /> Reset All
    </Button>
  </div>

  <section class="facial-artwork-provenance" aria-labelledby="facial-artwork-credit-title">
    <div>
      <h4 id="facial-artwork-credit-title">Upload Credit</h4>
      <p>Saved with each PNG so its source and usage rights stay inspectable.</p>
    </div>
    <div class="facial-artwork-credit-grid">
      <label>
        <span>Source</span>
        <select bind:value={sourceKind} disabled={disabled}>
          <option value="user-authored">User-authored</option>
          <option value="comfyui-generated">ComfyUI-generated</option>
          <option value="approved-external">Approved external source</option>
        </select>
      </label>
      <label>
        <span>Author or source</span>
        <input bind:value={author} placeholder="Name or source" disabled={disabled} />
      </label>
      <label>
        <span>License or rights note</span>
        <input bind:value={license} placeholder="License or ownership" disabled={disabled} />
      </label>
      <label class="facial-artwork-rights">
        <input type="checkbox" bind:checked={rightsConfirmed} disabled={disabled} />
        <span>I confirm I have permission to use this artwork.</span>
      </label>
    </div>
    {#if !provenanceReady}
      <p class="facial-artwork-credit-help" role="status">
        Complete the credit and rights confirmation before uploading.
      </p>
    {/if}
  </section>

  <div class="facial-artwork-accordions">
    <FacialArtworkAccordion
      id="brows"
      title="Brows"
      summary={roleSummary('brows')}
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
        description="Add transparent brow artwork fitted to the brow canvases."
        leftLabel="Left Brow"
        rightLabel="Right Brow"
        sharedMirrorHelp="The right brow mirrors the left automatically."
        {disabled}
        provenance={uploadProvenance}
        {onChange}
        {onUpload}
        {onUploadBusyChange}
      />
    </FacialArtworkAccordion>

    <FacialArtworkAccordion
      id="lashes"
      title="Lashes & Eye Outline"
      summary={roleSummary('lashes_eye_outline')}
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
        description="Add lashes, liner, or another transparent outline around the eyes."
        leftLabel="Left Eye"
        rightLabel="Right Eye"
        sharedMirrorHelp="The right lashes and outline mirror the left automatically."
        {disabled}
        provenance={uploadProvenance}
        {onChange}
        {onUpload}
        {onUploadBusyChange}
      />
    </FacialArtworkAccordion>

    <FacialArtworkAccordion
      id="iris-pupil"
      title="Iris & Pupil"
      summary={`${roleSummary('iris')}; ${roleSummary('pupil')}`}
      open={openSection === 'iris-pupil'}
      changed={sectionChanged('iris-pupil')}
      {disabled}
      onToggle={() => toggleSection('iris-pupil')}
      onReset={() => resetSection('iris-pupil')}
    >
      <section class="facial-artwork-subsection">
        <FacialArtworkSurfaceEditor
          {definition}
          {valueState}
          roleId="iris"
          label="Iris"
          description="Choose a solid iris color, then optionally layer custom artwork over it."
          {disabled}
          provenance={uploadProvenance}
          {onChange}
          {onUpload}
          {onUploadBusyChange}
        />
        <div class="facial-artwork-physical-group">
          <p>Physical Size</p>
          <span>Linked across both eyes. Zero keeps the package-fitted result.</span>
          <FacialArtworkPhysicalSlider
            id="facial-artwork-iris-size"
            label={irisSizeControl.label}
            value={eyeAppearanceState.irisSize}
            range={[irisSizeControl.minimum, irisSizeControl.maximum]}
            step={irisSizeControl.step}
            {disabled}
            onChange={(value) => updateEyeControl('iris_size', value)}
          />
        </div>
      </section>

      <section class="facial-artwork-subsection facial-artwork-subsection-divided">
        <FacialArtworkSurfaceEditor
          {definition}
          {valueState}
          roleId="pupil"
          label="Pupil"
          description="Choose a solid pupil color, then optionally layer custom artwork over it."
          {disabled}
          provenance={uploadProvenance}
          {onChange}
          {onUpload}
          {onUploadBusyChange}
        />
        <div class="facial-artwork-physical-group">
          <p>Physical Size</p>
          <span>Linked across both eyes. Zero keeps the package-fitted result.</span>
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
      title="Eye Highlight"
      summary={roleSummary('eye_highlight')}
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
        description="Add optional catchlight artwork over the iris and pupil."
        {disabled}
        provenance={uploadProvenance}
        {onChange}
        {onUpload}
        {onUploadBusyChange}
      />
    </FacialArtworkAccordion>

    <FacialArtworkAccordion
      id="sclera"
      title="Sclera"
      summary={roleSummary('sclera')}
      open={openSection === 'sclera'}
      changed={sectionChanged('sclera')}
      {disabled}
      onToggle={() => toggleSection('sclera')}
      onReset={() => resetSection('sclera')}
    >
      <section class="facial-artwork-subsection">
        <FacialArtworkSurfaceEditor
          {definition}
          {valueState}
          roleId="sclera"
          label="Surface"
          description="Set the whites of the eyes, then optionally layer custom artwork over the color."
          {disabled}
          provenance={uploadProvenance}
          {onChange}
          {onUpload}
          {onUploadBusyChange}
        />
      </section>

      <section class="facial-artwork-subsection facial-artwork-subsection-divided" aria-labelledby="facial-artwork-sclera-fit-title">
        <div class="facial-artwork-fit-heading">
          <h5 id="facial-artwork-sclera-fit-title">Sclera Fit</h5>
          <p>Linked across both eyes. Zero keeps the automatic package fit.</p>
        </div>
        <div class="facial-artwork-fit-controls">
          {#each [
            ['sclera_scale', eyeAppearanceState.scleraFit.scale],
            ['sclera_tilt', eyeAppearanceState.scleraFit.tilt],
            ['sclera_horizontal_position', eyeAppearanceState.scleraFit.horizontal],
            ['sclera_vertical_position', eyeAppearanceState.scleraFit.vertical],
            ['sclera_depth', eyeAppearanceState.scleraFit.depth]
          ] as entry (entry[0])}
            {@const controlId = entry[0] as EyeAppearanceControlId}
            {@const control = eyeControl(controlId)}
            <FacialArtworkPhysicalSlider
              id={`facial-artwork-${controlId}`}
              label={control.label}
              value={entry[1] as number}
              range={[control.minimum, control.maximum]}
              step={control.step}
              {disabled}
              onChange={(value) => updateEyeControl(controlId, value)}
            />
          {/each}
        </div>
      </section>
    </FacialArtworkAccordion>
  </div>
</div>

<style>
  .facial-artwork-editor,
  .facial-artwork-accordions,
  .facial-artwork-subsection,
  .facial-artwork-physical-group,
  .facial-artwork-fit-heading,
  .facial-artwork-fit-controls {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .facial-artwork-editor {
    container-type: inline-size;
    gap: 12px;
  }

  .facial-artwork-toolbar,
  .facial-artwork-rights {
    display: flex;
    align-items: center;
  }

  .facial-artwork-toolbar {
    justify-content: space-between;
    gap: 10px;
  }

  .facial-artwork-toolbar-title,
  .facial-artwork-provenance h4,
  .facial-artwork-physical-group p,
  .facial-artwork-fit-heading h5,
  .facial-artwork-fit-heading p {
    margin: 0;
  }

  .facial-artwork-toolbar-title,
  .facial-artwork-provenance h4 {
    font-size: 0.75rem;
    font-weight: 650;
  }

  .facial-artwork-summary,
  .facial-artwork-provenance p,
  .facial-artwork-credit-help {
    margin: 2px 0 0;
    color: var(--muted-foreground);
    font-size: 0.675rem;
    line-height: 1.45;
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

  .facial-artwork-credit-grid label:not(.facial-artwork-rights) {
    display: grid;
    min-width: 0;
    gap: 4px;
  }

  .facial-artwork-credit-grid label > span {
    color: var(--muted-foreground);
    font-size: 0.625rem;
  }

  .facial-artwork-credit-grid select,
  .facial-artwork-credit-grid input:not([type='checkbox']) {
    min-width: 0;
    min-height: 2rem;
    padding: 0 8px;
    border: 1px solid var(--input);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground);
    font-size: 0.75rem;
  }

  .facial-artwork-credit-grid select:focus-visible,
  .facial-artwork-credit-grid input:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .facial-artwork-rights {
    grid-column: 1 / -1;
    gap: 7px;
  }

  .facial-artwork-rights input {
    accent-color: var(--primary);
  }

  .facial-artwork-accordions {
    gap: 7px;
  }

  .facial-artwork-subsection {
    gap: 10px;
  }

  .facial-artwork-subsection-divided {
    padding-top: 12px;
    border-top: 1px solid color-mix(in oklch, var(--border) 72%, transparent);
  }

  .facial-artwork-physical-group {
    gap: 7px;
    padding-top: 2px;
  }

  .facial-artwork-physical-group > p,
  .facial-artwork-fit-heading h5 {
    color: var(--foreground);
    font-size: 0.6875rem;
    font-weight: 650;
  }

  .facial-artwork-physical-group > span,
  .facial-artwork-fit-heading p {
    color: var(--muted-foreground);
    font-size: 0.59375rem;
    line-height: 1.4;
  }

  .facial-artwork-fit-heading,
  .facial-artwork-fit-controls {
    gap: 3px;
  }

  .facial-artwork-fit-controls {
    gap: 12px;
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
      align-items: flex-start;
    }
  }
</style>
