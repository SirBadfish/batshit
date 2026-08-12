<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import {
    BrushCleaning,
    Check,
    Eraser,
    Eye,
    EyeOff,
    Paintbrush,
    RotateCcw
  } from '@lucide/svelte'
  import {
    HAIR_MOTION_PAINT_CONTRACT,
    compressHairMotionTriangleRanges,
    expandHairMotionTriangleRanges,
    parseHairMotionPaint,
    type HairMotionPaintV1
  } from '$lib/goons/hairMotionPaint'
  import type {
    HairImportMotionPaintPick,
    HairImportMotionPaintTopology
  } from '$lib/goons/engine'

  type DraftRegion = {
    id: string
    label: string
    enabled: boolean
    triangles: Record<string, number[]>
  }

  type Props = {
    topology: HairImportMotionPaintTopology
    initialPaint: HairMotionPaintV1 | null
    onPreview: (paint: HairMotionPaintV1, activeRegionId: string | null) => void | Promise<void>
    onPick: (
      clientX: number,
      clientY: number,
      brushRadiusPx: number
    ) => HairImportMotionPaintPick | null
    onSetGoonVisible: (visible: boolean) => void
    onSetMeshVisible: (meshNode: string, visible: boolean) => void
    onSave: (paint: HairMotionPaintV1) => void
    onCancel: () => void
  }

  let {
    topology,
    initialPaint,
    onPreview,
    onPick,
    onSetGoonVisible,
    onSetMeshVisible,
    onSave,
    onCancel
  }: Props = $props()

  const mountedTopology = untrack(() => topology)
  const mountedPaint = untrack(() => initialPaint)
  const initialRegion = buildInitialRegion(mountedPaint)
  const topologyByName = new Map(
    mountedTopology.meshes.map((mesh) => [mesh.meshNode, mesh])
  )
  let editorRoot: HTMLDivElement | null = $state(null)
  let region = $state<DraftRegion>(initialRegion)
  let tool = $state<'paint' | 'erase'>('paint')
  let brushRadius = $state(18)
  let shiftHeld = $state(false)
  let painting = $state(false)
  let pointerId = $state<number | null>(null)
  let pointerCaptureElement: HTMLElement | null = null
  let pointerVisible = $state(false)
  let pointerX = $state(0)
  let pointerY = $state(0)
  let history = $state<DraftRegion[]>([])
  let status = $state<string | null>(null)
  let previewFrame: number | null = null
  let goonVisible = $state(true)
  let meshVisibility = $state<Record<string, boolean>>(
    Object.fromEntries(mountedTopology.meshes.map((mesh) => [mesh.meshNode, true]))
  )

  const selectedTriangleCount = $derived.by(() =>
    Object.values(region.triangles).reduce((sum, triangles) => sum + triangles.length, 0)
  )
  const hiddenObjectCount = $derived(
    (goonVisible ? 0 : 1) +
      Object.values(meshVisibility).filter((visible) => visible === false).length
  )

  function buildInitialRegion(paint: HairMotionPaintV1 | null): DraftRegion {
    const normalized = paint ? parseHairMotionPaint(paint) : null
    const triangles = new Map<string, Set<number>>()
    for (const painted of normalized?.regions ?? []) {
      if (!painted.enabled) continue
      for (const mesh of painted.meshes) {
        const selected = triangles.get(mesh.meshNode) ?? new Set<number>()
        for (const triangle of expandHairMotionTriangleRanges(
          mesh.triangleRanges,
          mesh.triangleCount
        )) {
          selected.add(triangle)
        }
        triangles.set(mesh.meshNode, selected)
      }
    }
    return {
      id: 'paint-region-001',
      label: 'Custom Motion',
      enabled: true,
      triangles: Object.fromEntries(
        [...triangles].map(([meshNode, selected]) => [
          meshNode,
          [...selected].sort((left, right) => left - right)
        ])
      )
    }
  }

  function cloneRegion(value = region): DraftRegion {
    return {
      ...value,
      triangles: Object.fromEntries(
        Object.entries(value.triangles).map(([meshNode, triangles]) => [meshNode, [...triangles]])
      )
    }
  }

  function buildPaint(value = region): HairMotionPaintV1 {
    return parseHairMotionPaint({
      contract: HAIR_MOTION_PAINT_CONTRACT,
      regions: [{
        id: value.id,
        label: value.label,
        enabled: true,
        meshes: Object.entries(value.triangles)
          .map(([meshNode, triangles]) => {
            const mesh = topologyByName.get(meshNode)
            if (!mesh || triangles.length === 0) return null
            return {
              meshNode,
              triangleCount: mesh.triangleCount,
              triangleRanges: compressHairMotionTriangleRanges(triangles, mesh.triangleCount)
            }
          })
          .filter((mesh): mesh is NonNullable<typeof mesh> => Boolean(mesh))
      }]
    })
  }

  function preview() {
    if (previewFrame !== null || typeof window === 'undefined') return
    previewFrame = window.requestAnimationFrame(() => {
      previewFrame = null
      status = null
      try {
        Promise.resolve(onPreview(buildPaint(), null)).catch((error) => {
          status = error instanceof Error ? error.message : 'The painted motion preview could not update.'
        })
      } catch (error) {
        status = error instanceof Error ? error.message : 'The painted motion preview could not update.'
      }
    })
  }

  function pushHistory() {
    history = [...history.slice(-39), cloneRegion()]
  }

  function clearPaint() {
    pushHistory()
    region = { ...region, triangles: {} }
    preview()
  }

  function undo() {
    const previous = history.at(-1)
    if (!previous) return
    region = cloneRegion(previous)
    history = history.slice(0, -1)
    preview()
  }

  function toggleGoonVisibility() {
    goonVisible = !goonVisible
    onSetGoonVisible(goonVisible)
  }

  function toggleMeshVisibility(meshNode: string) {
    const visible = !(meshVisibility[meshNode] ?? true)
    meshVisibility = { ...meshVisibility, [meshNode]: visible }
    onSetMeshVisible(meshNode, visible)
  }

  function updatePointerPosition(event: PointerEvent) {
    if (!editorRoot) return
    const rect = editorRoot.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    pointerVisible = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
    pointerX = Math.min(Math.max(x, 0), rect.width)
    pointerY = Math.min(Math.max(y, 0), rect.height)
  }

  function applyPointer(event: PointerEvent) {
    const pick = onPick(event.clientX, event.clientY, brushRadius)
    if (!pick || meshVisibility[pick.meshNode] === false) return
    const next = cloneRegion()
    const current = new Set(next.triangles[pick.meshNode] ?? [])
    for (const triangle of pick.triangleIndices) {
      if (tool === 'erase') current.delete(triangle)
      else current.add(triangle)
    }
    if (current.size > 0) next.triangles[pick.meshNode] = [...current].sort((a, b) => a - b)
    else delete next.triangles[pick.meshNode]
    region = next
    preview()
  }

  function releasePointerCapture(id: number | null) {
    if (id === null || !pointerCaptureElement) return
    try {
      if (pointerCaptureElement.hasPointerCapture?.(id)) {
        pointerCaptureElement.releasePointerCapture(id)
      }
    } catch {
      // The browser may already have released capture after cancellation.
    }
    pointerCaptureElement = null
  }

  function stopStroke(id: number | null = pointerId) {
    releasePointerCapture(id)
    painting = false
    pointerId = null
  }

  function handlePointerDown(event: PointerEvent) {
    updatePointerPosition(event)
    if (event.button !== 0 || (!event.shiftKey && !shiftHeld)) return
    event.preventDefault()
    event.stopPropagation()
    pushHistory()
    painting = true
    pointerId = event.pointerId
    pointerCaptureElement = event.currentTarget as HTMLElement
    pointerCaptureElement.setPointerCapture?.(event.pointerId)
    applyPointer(event)
  }

  function handlePointerMove(event: PointerEvent) {
    updatePointerPosition(event)
    if (!painting || pointerId !== event.pointerId) return
    if (!event.shiftKey && !shiftHeld) {
      stopStroke(event.pointerId)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    applyPointer(event)
  }

  function handlePointerUp(event: PointerEvent) {
    updatePointerPosition(event)
    if (pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    stopStroke(event.pointerId)
  }

  function handleWindowKeyDown(event: KeyboardEvent) {
    if (event.key === 'Shift') shiftHeld = true
  }

  function handleWindowKeyUp(event: KeyboardEvent) {
    if (event.key !== 'Shift') return
    shiftHeld = false
    if (painting) stopStroke()
  }

  function handleWindowPointerMove(event: PointerEvent) {
    updatePointerPosition(event)
    shiftHeld = event.shiftKey
    if (painting && pointerId === event.pointerId && !event.shiftKey) stopStroke(event.pointerId)
  }

  function save() {
    if (selectedTriangleCount === 0) {
      status = 'Paint at least one Hair area before applying motion.'
      return
    }
    onSave(buildPaint())
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleWindowKeyDown)
    window.addEventListener('keyup', handleWindowKeyUp)
    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }

  onDestroy(() => {
    if (previewFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(previewFrame)
      previewFrame = null
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleWindowKeyDown)
      window.removeEventListener('keyup', handleWindowKeyUp)
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
    stopStroke()
  })

  $effect(() => {
    preview()
  })
</script>

<div
  bind:this={editorRoot}
  class="pointer-events-none absolute inset-0 z-30"
  role="application"
  aria-label="Paint Hair motion"
>
  <div class="pointer-events-none absolute inset-0 border-2 border-cyan-400/70"></div>
  {#if pointerVisible}
    <div
      class={`pointer-events-none absolute z-40 rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.5)] ${
        shiftHeld || painting
          ? 'border-cyan-300 bg-cyan-300/10'
          : 'border-muted-foreground/70 bg-background/10'
      }`}
      style={`left: ${pointerX}px; top: ${pointerY}px; width: ${brushRadius * 2}px; height: ${brushRadius * 2}px; transform: translate(-50%, -50%);`}
      aria-hidden="true"
    ></div>
  {/if}
  <div
    class={`absolute inset-0 touch-none ${shiftHeld || painting ? 'pointer-events-auto cursor-none' : 'pointer-events-none'}`}
    role="application"
    aria-label="Hair motion paint surface"
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointercancel={handlePointerUp}
  ></div>

  <div class="hair-motion-paint-toolbar pointer-events-auto" role="group" aria-label="Hair motion paint controls">
    <div class="flex min-w-0 flex-1 items-center gap-1.5">
      <Button type="button" variant={tool === 'paint' ? 'default' : 'outline'} size="icon" aria-label="Paint motion" title="Paint motion" onclick={() => (tool = 'paint')}>
        <Paintbrush />
      </Button>
      <Button type="button" variant={tool === 'erase' ? 'default' : 'outline'} size="icon" aria-label="Erase motion" title="Erase motion" onclick={() => (tool = 'erase')}>
        <Eraser />
      </Button>
      <label class="flex min-w-0 max-w-44 flex-1 items-center gap-2">
        <span class="sr-only">Brush size</span>
        <input type="range" min="2" max="64" step="1" value={brushRadius} class="batshit-settings-range-input min-w-16 flex-1" oninput={(event) => (brushRadius = Number(event.currentTarget.value))} />
        <span class="w-9 text-right text-[10px] text-muted-foreground">{brushRadius}px</span>
      </label>
    </div>
    <div class="hair-motion-paint-primary-actions">
      <Button type="button" variant="ghost" size="icon" aria-label="Undo" title="Undo" disabled={history.length === 0} onclick={undo}><RotateCcw /></Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Clear all painted motion" title="Clear all paint" onclick={clearPaint}><BrushCleaning /></Button>
    </div>
    <div class="hair-motion-paint-visibility">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="batshit-button batshit-button-medium batshit-button-medium-secondary batshit-button-medium-icon bs-button bs-button-ghost bs-button-size-icon hair-motion-paint-visibility-trigger"
          aria-label={`Paint visibility${hiddenObjectCount > 0 ? `, ${hiddenObjectCount} hidden` : ''}`}
          title="Choose what is visible while painting"
        >
          {#if hiddenObjectCount > 0}<EyeOff />{:else}<Eye />{/if}
          {#if hiddenObjectCount > 0}
            <span class="hair-motion-paint-hidden-count" aria-hidden="true">{hiddenObjectCount}</span>
          {/if}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="hair-motion-paint-visibility-menu">
          <DropdownMenu.Label>Visible While Painting</DropdownMenu.Label>
          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem
            checked={goonVisible}
            onCheckedChange={(checked) => {
              if (Boolean(checked) !== goonVisible) toggleGoonVisibility()
            }}
          >
            <span class="hair-motion-paint-visibility-name">Goon</span>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator />
          {#each mountedTopology.meshes as mesh (mesh.meshNode)}
            <DropdownMenu.CheckboxItem
              checked={meshVisibility[mesh.meshNode] !== false}
              onCheckedChange={(checked) => {
                if (Boolean(checked) !== (meshVisibility[mesh.meshNode] !== false)) {
                  toggleMeshVisibility(mesh.meshNode)
                }
              }}
            >
              <span class="hair-motion-paint-visibility-name" title={mesh.meshNode}>{mesh.meshNode}</span>
            </DropdownMenu.CheckboxItem>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
    <div class="hair-motion-paint-exit-actions">
      <Button type="button" variant="outline" size="sm" aria-label="Cancel painting" onclick={onCancel}>Cancel</Button>
      <Button type="button" size="sm" aria-label="Apply painted motion" disabled={selectedTriangleCount === 0} onclick={save}><Check />Done</Button>
    </div>
    <div class="hair-motion-paint-status">
      <span>{selectedTriangleCount.toLocaleString()} painted triangles</span>
      <span class={status ? 'text-destructive' : 'text-muted-foreground'}>{status ?? 'Shift-drag paints. Orbit to reach the back of each strand.'}</span>
    </div>
  </div>
</div>

<style>
  .hair-motion-paint-toolbar {
    position: absolute;
    right: 12px;
    bottom: 12px;
    width: min(620px, calc(100% - 24px));
    display: grid;
    grid-template-columns: minmax(180px, 1fr) auto auto auto;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: oklch(from var(--background) l c h / 0.94);
    padding: 8px;
    box-shadow: 0 16px 36px rgb(0 0 0 / 0.36);
    backdrop-filter: blur(10px);
  }

  .hair-motion-paint-primary-actions,
  .hair-motion-paint-exit-actions,
  .hair-motion-paint-visibility {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .hair-motion-paint-primary-actions,
  .hair-motion-paint-exit-actions {
    justify-content: flex-end;
  }

  .hair-motion-paint-visibility-trigger {
    position: relative;
  }

  .hair-motion-paint-hidden-count {
    position: absolute;
    top: -0.25rem;
    right: -0.25rem;
    display: grid;
    min-width: 1rem;
    height: 1rem;
    place-items: center;
    border: 1px solid var(--background);
    border-radius: 999px;
    background: var(--primary);
    color: var(--primary-foreground);
    padding: 0 0.2rem;
    font-size: 0.58rem;
    line-height: 1;
  }

  :global(.hair-motion-paint-visibility-menu) {
    width: min(22rem, calc(100vw - 2rem));
    max-height: min(22rem, calc(100vh - 5rem));
  }

  :global(.hair-motion-paint-visibility-name) {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hair-motion-paint-status {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    border-top: 1px solid oklch(from var(--border) l c h / 0.6);
    padding-top: 5px;
    font-size: 0.625rem;
  }

  @media (max-width: 620px) {
    .hair-motion-paint-toolbar {
      grid-template-columns: minmax(140px, 1fr) auto auto auto;
    }
  }
</style>
