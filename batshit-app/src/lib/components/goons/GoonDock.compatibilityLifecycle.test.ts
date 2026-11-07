import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import type { GoonRecord } from '$lib/types/goons'
import { setGoons, setGoonsOwner } from '$lib/stores/goons.svelte'
import { setGoonAnimationLibrary, setGoonAnimationLibraryOwner } from '$lib/stores/goonAnimationLibrary.svelte'
import { confirmUserSettings, resetUserSettings } from '$lib/stores/userSettings.svelte'

const rig = vi.hoisted(() => ({ engines: [] as any[], loads: [] as any[] }))

vi.mock('$lib/goons/engine', () => {
  class FakeEngine {
    options: any
    disposed = false
    constructor(_element: HTMLElement, options: any) {
      this.options = options
      const proxy = new Proxy(this, {
        get(target, key) {
          if (key in target) return Reflect.get(target, key)
          if (key === 'getAnimationCatalog' || key === 'getMaterialNames') return () => []
          if (key === 'getCameraState' || key === 'captureMountedRuntimeState') return () => null
          if (key === 'syncAnimations' || key === 'setFacialArtworkState') return async () => {}
          return () => {}
        }
      })
      rig.engines.push(proxy)
      return proxy
    }
    async init() {}
    dispose() { this.disposed = true }
    setCompatibilityHandler(handler: unknown) { this.options.onCompatibility = handler }
    setPerformanceHandler() {}
  }
  return { GoonEngine: FakeEngine }
})

vi.mock('$lib/goons/mountedLiveGoon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/goons/mountedLiveGoon')>()
  return {
    ...actual,
    loadMountedLiveGoon: (engine: any, plan: any) => new Promise((resolve, reject) => {
      rig.loads.push({ engine, plan, resolve, reject })
    })
  }
})

import GoonDock from './GoonDock.svelte'

function goon(id: string, model: string): GoonRecord {
  return {
    id, user_id: 'compat-user', name: id, kind: 'vrm',
    files: { vrm: { url: `/uploads/${model}.vrm`, filename: `${model}.vrm` }, animations: [] },
    created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z'
  }
}

function accept(load: any) {
  const plan = load.plan
  load.resolve({
    status: 'loaded', kind: plan.kind, sceneSignature: plan.sceneSignature,
    baseLoopSignature: plan.baseLoopSignature, animationSignature: plan.animationSignature,
    closetSignature: plan.closetSignature, animationCatalog: [], materialNames: [],
    appearanceDialsSignature: plan.appearanceDialsSignature,
    facialArtworkSignature: plan.facialArtworkSignature,
    eyeAppearanceSignature: plan.eyeAppearanceSignature,
    oralAppearanceSignature: plan.oralAppearanceSignature,
    viewFov: plan.viewFov, cameraMode: plan.cameraMode
  })
}

beforeEach(() => {
  rig.engines.length = 0
  rig.loads.length = 0
  setGoonsOwner('compat-user')
  setGoonAnimationLibraryOwner('compat-user')
  setGoonAnimationLibrary({ vrma: [] })
  confirmUserSettings({})
})
afterEach(() => { cleanup(); setGoons([]); setGoonAnimationLibrary(null); resetUserSettings(); vi.restoreAllMocks() })

describe('GoonDock compatibility report ownership', () => {
  it('mounts the Goon and valid motion while malformed optional rows stay visibly unverified', async () => {
    const target = goon('a', 'a')
    target.files.animations = [
      { url: '/valid.vrma', filename: 'valid.vrma' },
      { url: '/bad.glb', filename: 42 } as any
    ]
    setGoons([target])
    const reports = vi.fn()
    render(GoonDock, { open: true, goon: target, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(1))
    const load = rig.loads[0]
    const planned = [...load.plan.animationPlan.eager, ...load.plan.animationPlan.deferred]
    expect(planned.map((file: { url: string }) => file.url)).toContain('/valid.vrma')
    expect(planned.map((file: { url: string }) => file.url)).not.toContain('/bad.glb')
    expect(screen.getByRole('status').textContent).toContain('Motion data unverified')
    load.engine.options.onCompatibility({ tier: 'A', issues: [] })
    accept(load)
    await tick()
    expect(reports).not.toHaveBeenCalled()
  })

  it('buffers the incoming report and suppresses a late prior Goon report', async () => {
    const first = goon('a', 'a')
    const second = goon('b', 'b')
    setGoons([first, second])
    const reports = vi.fn()
    const view = render(GoonDock, { open: true, goon: first, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(1))
    const loadA = rig.loads[0]
    const reportA = { tier: 'A', issues: ['from A'] }
    loadA.engine.options.onCompatibility(reportA)
    expect(reports).not.toHaveBeenCalled()
    accept(loadA)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(1))

    await view.rerender({ open: true, goon: second, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(2))
    const loadB = rig.loads[1]
    loadA.engine.options.onCompatibility?.({ tier: 'C', issues: ['stale A'] })
    loadB.engine.options.onCompatibility({ tier: 'B', issues: ['from B'] })
    expect(reports).toHaveBeenCalledTimes(1)
    accept(loadB)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(2))
    expect(reports.mock.calls.map(([report]) => report.issues)).toEqual([['from A'], ['from B']])
  })

  it('rejects a late report from the previous model of the same Goon', async () => {
    const original = goon('a', 'original')
    const replacement = goon('a', 'replacement')
    setGoons([original])
    const reports = vi.fn()
    const view = render(GoonDock, { open: true, goon: original, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(1))
    const first = rig.loads[0]
    first.engine.options.onCompatibility({ tier: 'A', issues: ['old model'] })
    accept(first)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(1))
    setGoons([replacement])
    await view.rerender({ open: true, goon: replacement, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(2))
    first.engine.options.onCompatibility?.({ tier: 'C', issues: ['late old model'] })
    const next = rig.loads[1]
    next.engine.options.onCompatibility({ tier: 'B', issues: ['new model'] })
    expect(reports).toHaveBeenCalledTimes(1)
    accept(next)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(2))
    expect(reports.mock.calls.map(([report]) => report.issues)).toEqual([['old model'], ['new model']])
  })

  it('keeps A visible and rejects pending B after an A-to-B-to-A selection', async () => {
    const a = goon('a', 'a')
    const b = goon('b', 'b')
    setGoons([a, b])
    const reports = vi.fn()
    const view = render(GoonDock, { open: true, goon: a, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(1))
    const firstA = rig.loads[0]
    firstA.engine.options.onCompatibility({ tier: 'A', issues: ['first A'] })
    accept(firstA)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(1))
    await view.rerender({ open: true, goon: b, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(2))
    const pendingB = rig.loads[1]
    await view.rerender({ open: true, goon: a, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(3))
    const nextA = rig.loads[2]
    pendingB.engine.options.onCompatibility({ tier: 'B', issues: ['stale B'] })
    accept(pendingB)
    await waitFor(() => expect(pendingB.engine.disposed).toBe(true))
    expect(firstA.engine.disposed).toBe(false)
    expect(reports).toHaveBeenCalledTimes(1)
    nextA.engine.options.onCompatibility({ tier: 'A', issues: ['new A'] })
    accept(nextA)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(2))
    expect(reports.mock.calls.map(([report]) => report.issues)).toEqual([['first A'], ['new A']])
  })

  it('holds a report while motion inventory is unconfirmed and publishes only after the same inputs are confirmed', async () => {
    const a = goon('a', 'a')
    setGoons([a])
    setGoonAnimationLibrary(null)
    const reports = vi.fn()
    render(GoonDock, { open: true, goon: a, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(1))
    const load = rig.loads[0]
    load.engine.options.onCompatibility({ tier: 'A', issues: ['held'] })
    accept(load)
    await waitFor(() => expect(load.engine.disposed).toBe(false))
    expect(reports).not.toHaveBeenCalled()
    setGoonAnimationLibrary({ vrma: [] })
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(1))
    expect(reports.mock.calls[0][0].issues).toEqual(['held'])
  })

  it('keeps the visible A when its replacement fails and the superseded B later finishes', async () => {
    const a = goon('a', 'a')
    const b = goon('b', 'b')
    setGoons([a, b])
    const reports = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(GoonDock, { open: true, goon: a, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(1))
    const firstA = rig.loads[0]
    firstA.engine.options.onCompatibility({ tier: 'A', issues: ['first A'] })
    accept(firstA)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(1))
    await view.rerender({ open: true, goon: b, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(2))
    const pendingB = rig.loads[1]
    await view.rerender({ open: true, goon: a, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(3))
    const replacementA = rig.loads[2]
    replacementA.reject(new Error('A replacement failed'))
    await waitFor(() => expect(replacementA.engine.disposed).toBe(true))
    accept(pendingB)
    await waitFor(() => expect(pendingB.engine.disposed).toBe(true))
    expect(firstA.engine.disposed).toBe(false)
    expect(reports).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
  })

  it('does not revive an old report guard when the same motion inputs return', async () => {
    const a = goon('a', 'a')
    setGoons([a])
    const reports = vi.fn()
    render(GoonDock, { open: true, goon: a, onCompatibilityReport: reports })
    await waitFor(() => expect(rig.loads).toHaveLength(1))
    const load = rig.loads[0]
    load.engine.options.onCompatibility({ tier: 'A', issues: ['original'] })
    accept(load)
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(1))
    const oldCurrent = reports.mock.calls[0][2] as () => boolean
    expect(oldCurrent()).toBe(true)
    const changed = { ...a, files: { ...a.files, animations: [{ url: '/new.vrma', filename: 'new.vrma' }] } }
    setGoons([changed])
    await tick()
    await waitFor(() => expect(oldCurrent()).toBe(false))
    setGoons([a])
    await tick()
    await waitFor(() => expect(oldCurrent()).toBe(false))
    load.engine.options.onCompatibility({ tier: 'A', issues: ['current'] })
    await waitFor(() => expect(reports).toHaveBeenCalledTimes(2))
    expect(oldCurrent()).toBe(false)
  })
})
