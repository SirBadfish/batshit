<script lang="ts">
  import { X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { resolveGoonMotionLane } from '$lib/goons/animationLoadPlan'
  import type {
    GoonCueDefinition,
    GoonFileRef,
    GoonPosture,
    GoonPostureDefinition,
    GoonSceneDefinition
  } from '$lib/types/goons'

  type PackCueScope = 'global' | 'goon'

  type PackCueExportOption = {
    key: string
    kind: 'mood' | 'emote'
    cue: GoonCueDefinition
    emojis: string[]
    scope: PackCueScope
    sourceGoonId?: string
    sourceGoonName?: string
    motionFile: GoonFileRef | null
  }

  type PackCueGroup = {
    key: string
    label: string
    moods: PackCueExportOption[]
    emotes: PackCueExportOption[]
  }

  type PackSceneExportOption = {
    key: string
    sceneId: string
    scene: GoonSceneDefinition
  }

  // One option per unified motion; `files` holds every format version
  // (.vrma / .glb) that exports with it.
  type PackMotionExportOption = {
    key: string
    files: GoonFileRef[]
    label: string
  }

  type PortablePackCueEntry = {
    cue: GoonCueDefinition
    emojis: string[]
    scope: PackCueScope
    sourceGoonId?: string
    sourceGoonName?: string
    motion?: GoonFileRef | null
  }

  type PortablePackManifest = {
    version: 6
    exportedAt: string
    name: string
    postures: GoonPostureDefinition[]
    motions?: GoonFileRef[]
    moods: PortablePackCueEntry[]
    emotes: PortablePackCueEntry[]
    scenes: GoonSceneDefinition[]
  }

  type PendingImportPack = {
    manifest: PortablePackManifest
    entries: Record<string, Uint8Array>
    fileName: string
  }

  interface Props {
    exportOpen: boolean
    importOpen: boolean
    packSceneOptions: PackSceneExportOption[]
    globalPackMotionOptions: PackMotionExportOption[]
    globalPackMoodOptions: PackCueExportOption[]
    globalPackEmoteOptions: PackCueExportOption[]
    goonPackCueGroups: PackCueGroup[]
    exportPackSelections: Record<string, boolean>
    exportPackBusy: boolean
    pendingImportPack: PendingImportPack | null
    libraryImportBusy: boolean
    onTogglePackSelection: (key: string, selected: boolean) => void
    onExportSelected: () => void | Promise<void>
    onCancelImport: () => void
    onConfirmImport: () => void | Promise<void>
    getPostureLabel: (posture?: GoonPosture | '' | null) => string
  }

  let {
    exportOpen = $bindable(false),
    importOpen = $bindable(false),
    packSceneOptions,
    globalPackMotionOptions,
    globalPackMoodOptions,
    globalPackEmoteOptions,
    goonPackCueGroups,
    exportPackSelections,
    exportPackBusy,
    pendingImportPack,
    libraryImportBusy,
    onTogglePackSelection,
    onExportSelected,
    onCancelImport,
    onConfirmImport,
    getPostureLabel
  }: Props = $props()

  const allExportPackKeys = $derived.by(() => [
    ...packSceneOptions.map((option) => option.key),
    ...globalPackMotionOptions.map((option) => option.key),
    ...globalPackMoodOptions.map((option) => option.key),
    ...globalPackEmoteOptions.map((option) => option.key),
    ...goonPackCueGroups.flatMap((group) => [
      ...group.moods.map((option) => option.key),
      ...group.emotes.map((option) => option.key)
    ])
  ])
  const selectedExportPackCount = $derived(
    allExportPackKeys.filter((key) => Boolean(exportPackSelections[key])).length
  )
  const totalExportPackCount = $derived(allExportPackKeys.length)

  function setAllExportPackSelections(selected: boolean) {
    for (const key of allExportPackKeys) {
      if (Boolean(exportPackSelections[key]) !== selected) {
        onTogglePackSelection(key, selected)
      }
    }
  }
</script>

<Dialog.Root bind:open={exportOpen}>
  <Dialog.Content class="sm:max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
    <Dialog.Header>
      <Dialog.Title>Export Pack</Dialog.Title>
      <Dialog.Description>
        Choose the Scenes, Motions, global cues, and goon-local cues to include in this portable
        pack zip.
      </Dialog.Description>
    </Dialog.Header>
    {#if totalExportPackCount > 0}
      <div class="flex flex-wrap items-center justify-between gap-3 border-y border-border/60 py-3">
        <p class="batshit-settings-caption">
          {selectedExportPackCount} of {totalExportPackCount} selected
        </p>
        <div class="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selectedExportPackCount === totalExportPackCount}
            onclick={() => setAllExportPackSelections(true)}
          >
            Select All
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selectedExportPackCount === 0}
            onclick={() => setAllExportPackSelections(false)}
          >
            Clear
          </Button>
        </div>
      </div>
    {/if}
    <div class="flex-1 overflow-y-auto space-y-6 pr-1">
      <div class="space-y-2">
        <div class="batshit-settings-section-title">Scenes</div>
        {#if packSceneOptions.length === 0}
          <p class="batshit-settings-caption">No scenes available yet.</p>
        {:else}
          <div class="space-y-2">
            {#each packSceneOptions as option (option.key)}
              <label class="batshit-settings-option-card flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={Boolean(exportPackSelections[option.key])}
                  onchange={(event) =>
                    onTogglePackSelection(
                      option.key,
                      (event.currentTarget as HTMLInputElement).checked
                    )}
                />
                <div class="min-w-0">
                  <div class="batshit-settings-form-label">{option.scene.name}</div>
                  <div class="batshit-settings-caption">
                    Includes skybox, room shell/builder, props, markers, and linked textures.
                  </div>
                </div>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-2">
        <div class="batshit-settings-section-title">Motions</div>
        {#if globalPackMotionOptions.length === 0}
          <p class="batshit-settings-caption">No Motion Vault items available.</p>
        {:else}
          <div class="space-y-2">
            {#each globalPackMotionOptions as option (option.key)}
              {@const primaryFile = option.files[0]}
              {@const formatLabels = option.files
                .map((file) => (resolveGoonMotionLane(file) === 'glb' ? 'GLB' : 'VRMA'))
                .join(' + ')}
              <label class="batshit-settings-option-card flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={Boolean(exportPackSelections[option.key])}
                  onchange={(event) =>
                    onTogglePackSelection(
                      option.key,
                      (event.currentTarget as HTMLInputElement).checked
                    )}
                />
                <div class="min-w-0">
                  <div class="batshit-settings-form-label">{option.label}</div>
                  <div class="batshit-settings-caption">
                    {formatLabels ? `${formatLabels} · ` : ''}{(primaryFile?.tags ?? []).length > 0
                      ? `${(primaryFile?.tags ?? []).join(', ')} · `
                      : ''}{primaryFile?.motionMeta?.playback ?? 'Motion Vault item'}
                  </div>
                </div>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-2">
        <div class="batshit-settings-section-title">Global Moods</div>
        {#if globalPackMoodOptions.length === 0}
          <p class="batshit-settings-caption">No global moods available.</p>
        {:else}
          <div class="space-y-2">
            {#each globalPackMoodOptions as option (option.key)}
              <label class="batshit-settings-option-card flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={Boolean(exportPackSelections[option.key])}
                  onchange={(event) =>
                    onTogglePackSelection(
                      option.key,
                      (event.currentTarget as HTMLInputElement).checked
                    )}
                />
                <div class="min-w-0">
                  <div class="batshit-settings-form-label">{option.cue.name}</div>
                  <div class="batshit-settings-caption">
                    {option.cue.description || 'Global mood'}
                  </div>
                </div>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-2">
        <div class="batshit-settings-section-title">Global Emotes</div>
        {#if globalPackEmoteOptions.length === 0}
          <p class="batshit-settings-caption">No global emotes available.</p>
        {:else}
          <div class="space-y-2">
            {#each globalPackEmoteOptions as option (option.key)}
              <label class="batshit-settings-option-card flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={Boolean(exportPackSelections[option.key])}
                  onchange={(event) =>
                    onTogglePackSelection(
                      option.key,
                      (event.currentTarget as HTMLInputElement).checked
                    )}
                />
                <div class="min-w-0">
                  <div class="batshit-settings-form-label">{option.cue.name}</div>
                  <div class="batshit-settings-caption">
                    {option.emojis.length > 0
                      ? `${option.emojis.join(' ')} · `
                      : ''}{option.cue.description || 'Global emote'}
                  </div>
                </div>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      {#if goonPackCueGroups.length > 0}
        {#each goonPackCueGroups as group (group.key)}
          <div class="space-y-3">
            <div class="batshit-settings-section-title">{group.label} Local Cues</div>
            {#if group.moods.length > 0}
              <div class="space-y-2">
                <div class="batshit-settings-child-label">Moods</div>
                {#each group.moods as option (option.key)}
                  <label class="batshit-settings-option-card flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={Boolean(exportPackSelections[option.key])}
                      onchange={(event) =>
                        onTogglePackSelection(
                          option.key,
                          (event.currentTarget as HTMLInputElement).checked
                        )}
                    />
                    <div class="min-w-0">
                      <div class="batshit-settings-form-label">{option.cue.name}</div>
                      <div class="batshit-settings-caption">
                        {option.cue.description || 'Per-goon mood override'}
                      </div>
                    </div>
                  </label>
                {/each}
              </div>
            {/if}
            {#if group.emotes.length > 0}
              <div class="space-y-2">
                <div class="batshit-settings-child-label">Emotes</div>
                {#each group.emotes as option (option.key)}
                  <label class="batshit-settings-option-card flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={Boolean(exportPackSelections[option.key])}
                      onchange={(event) =>
                        onTogglePackSelection(
                          option.key,
                          (event.currentTarget as HTMLInputElement).checked
                        )}
                    />
                    <div class="min-w-0">
                      <div class="batshit-settings-form-label">{option.cue.name}</div>
                      <div class="batshit-settings-form-label">
                        {option.emojis.length > 0
                          ? `${option.emojis.join(' ')} · `
                          : ''}{option.cue.description || 'Per-goon emote override'}
                      </div>
                    </div>
                  </label>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
    <Dialog.Footer class="gap-2">
      <Button variant="ghost" onclick={() => (exportOpen = false)}>
        <X aria-hidden="true" />

        Cancel
      </Button>
      <Button onclick={onExportSelected} disabled={exportPackBusy}>
        {exportPackBusy ? 'Exporting…' : 'Export Selected Pack'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={importOpen}>
  <Dialog.Content class="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
    <Dialog.Header>
      <Dialog.Title>Import Pack</Dialog.Title>
      <Dialog.Description>
        Review everything included in this pack before importing it into Goon Kitchen.
      </Dialog.Description>
    </Dialog.Header>
    {#if pendingImportPack}
      <div class="flex-1 overflow-y-auto space-y-5 pr-1">
        <div class="batshit-settings-muted-panel space-y-1">
          <div>File: {pendingImportPack.fileName}</div>
          <div>
            Imported goon-local moods and emotes will be added to Goon Kitchen as reusable content.
            Standalone motions will be added to the Motion Vault.
          </div>
        </div>

        {#if pendingImportPack.manifest.postures.length > 0}
          <div class="space-y-2">
            <div class="batshit-settings-form-label">Custom Postures</div>
            {#each pendingImportPack.manifest.postures as posture (`posture-${posture.id}`)}
              <div class="rounded-md border p-3">
                <div class="batshit-settings-form-label">{posture.name}</div>
                <div class="batshit-settings-form-label">
                  Base Posture: {getPostureLabel(posture.basePosture)}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if (pendingImportPack.manifest.motions?.length ?? 0) > 0}
          <div class="space-y-2">
            <div class="batshit-settings-form-label">Motions</div>
            {#each pendingImportPack.manifest.motions ?? [] as motion, index (`motion-${index}-${motion.filename}`)}
              <div class="rounded-md border p-3">
                <div class="batshit-settings-form-label">
                  {motion.displayName || motion.originalName || motion.filename}
                </div>
                <div class="batshit-settings-caption">
                  {(motion.tags ?? []).length > 0 ? `${(motion.tags ?? []).join(', ')} · ` : ''}
                  {motion.motionMeta?.playback ?? 'Motion Vault item'}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if pendingImportPack.manifest.scenes.length > 0}
          <div class="space-y-2">
            <div class="batshit-settings-form-label">Scenes</div>
            {#each pendingImportPack.manifest.scenes as scene (scene.id)}
              <div class="rounded-md border p-3">
                <div class="batshit-settings-form-label">{scene.name}</div>
                <div class="batshit-settings-caption">
                  Includes skybox, room shell/builder, props, markers, and linked textures.
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if pendingImportPack.manifest.moods.length > 0}
          <div class="space-y-2">
            <div class="batshit-settings-form-label">Moods</div>
            {#each pendingImportPack.manifest.moods as entry, index (`mood-${index}-${entry.cue.name}`)}
              <div class="rounded-md border p-3">
                <div class="batshit-settings-form-label">{entry.cue.name}</div>
                <div class="batshit-settings-form-label">
                  {entry.scope === 'goon' && entry.sourceGoonName
                    ? `${entry.sourceGoonName} local mood`
                    : 'Global mood'}
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if pendingImportPack.manifest.emotes.length > 0}
          <div class="space-y-2">
            <div class="batshit-settings-form-label">Emotes</div>
            {#each pendingImportPack.manifest.emotes as entry, index (`emote-${index}-${entry.cue.name}`)}
              <div class="rounded-md border p-3">
                <div class="batshit-settings-form-label">{entry.cue.name}</div>
                <div class="batshit-settings-form-label">
                  {entry.scope === 'goon' && entry.sourceGoonName
                    ? `${entry.sourceGoonName} local emote`
                    : 'Global emote'}
                  {entry.emojis.length > 0 ? ` · ${entry.emojis.join(' ')}` : ''}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <Dialog.Footer class="gap-2">
      <Button
        variant="ghost"
        onclick={() => {
          importOpen = false
          onCancelImport()
        }}
      >
        <X aria-hidden="true" />

        Cancel
      </Button>
      <Button onclick={onConfirmImport} disabled={libraryImportBusy || !pendingImportPack}>
        {libraryImportBusy ? 'Importing…' : 'Confirm Import'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
