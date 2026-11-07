import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from '$app/state'

import {
  createGoon,
  deleteGoon,
  loadGoons,
  loadGoonAnimationLibrary,
  updateGoonAnimationLibraryMetadata,
  uploadGoonAnimationToLibrary,
  GoonMotionVersionExistsError,
  updateGoon as updateGoonRecord,
  deleteGoonFacialArtwork,
  persistGoonCamera,
  resetRetiredGoonHair,
  uploadAdvancedGoonPackage,
  uploadGoonFacialArtwork,
  uploadGoonLipArtwork,
  uploadGoonNailArtwork,
  uploadGuidedDufClothesVrm
} from './goons'
import { getGoons, getGoonsReadState, getGoonsMotionSourceRevision, setGoons, setGoonsOwner, updateGoon as updateGoonStore } from '$lib/stores/goons.svelte'
import { getGoonAnimationLibrary, getGoonAnimationLibraryReadState, setGoonAnimationLibrary, setGoonAnimationLibraryOwner } from '$lib/stores/goonAnimationLibrary.svelte'
import type { GoonRecord } from '$lib/types/goons'
import * as agentStore from '$lib/stores/agents.svelte'
import { isValidGoonMotionSources } from '$lib/goons/goonCompatibilityBasis'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('goons service create flow', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    ;(page.data as any).user = { id: 'user_1' }
    setGoonsOwner('user_1')
    setGoonAnimationLibraryOwner('user_1')
  })

  afterEach(() => {
    global.fetch = originalFetch
    setGoonsOwner(null)
    setGoonAnimationLibraryOwner(null)
    agentStore.setAgents([])
    ;(page.data as any).user = { id: 'josh' }
    vi.restoreAllMocks()
  })

  it.each(['http', 'network', 'json', 'shape'])('keeps the last Motion library unverified on a %s read failure', async (kind) => {
    setGoonAnimationLibrary({ vrma: [{ url: '/wave.glb', filename: 'wave.glb' }] })
    const previous = getGoonAnimationLibrary()
    global.fetch = vi.fn(async () => {
      if (kind === 'network') throw new Error('Read connection failed')
      if (kind === 'http') return new Response('Unavailable', { status: 503 })
      if (kind === 'json') return new Response('{invalid', { status: 200 })
      return new Response(JSON.stringify({ library: { vrma: 'invalid' } }), { status: 200 })
    }) as typeof fetch
    await expect(loadGoonAnimationLibrary()).rejects.toThrow()
    expect(getGoonAnimationLibrary()).toBe(previous)
    expect(getGoonAnimationLibrary().vrma[0]?.filename).toBe('wave.glb')
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ confirmed: false, loading: false })
    expect(getGoonAnimationLibraryReadState().error).toBeTruthy()
  })

  it('treats a valid empty Motion library as confirmed empty', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [] } }), { status: 200 })) as typeof fetch
    await expect(loadGoonAnimationLibrary()).resolves.toEqual({ vrma: [] })
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ confirmed: true, loading: false, error: null })
  })

  it('retains the last Motion library when a successful response contains an unusable row', async () => {
    setGoonAnimationLibrary({ vrma: [{ url: '/kept.glb', filename: 'kept.glb' }] })
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      ownerId: 'user_1', library: { vrma: [{ filename: 'broken.glb' }] }
    }), { status: 200 })) as typeof fetch
    await expect(loadGoonAnimationLibrary()).rejects.toThrow('invalid')
    expect(getGoonAnimationLibrary().vrma[0].filename).toBe('kept.glb')
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ confirmed: false })
  })

  it('does not treat a malformed library envelope as a valid bare empty library', async () => {
    setGoonAnimationLibrary({ vrma: [{ url: '/kept.glb', filename: 'kept.glb' }] })
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      ownerId: 'user_1', library: null, vrma: []
    }), { status: 200 })) as typeof fetch
    await expect(loadGoonAnimationLibrary()).rejects.toThrow('invalid')
    expect(getGoonAnimationLibrary().vrma[0].filename).toBe('kept.glb')
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ confirmed: false })
  })

  it('does not invalidate motion sources for a report-only Goon update', () => {
    const goon = { id: 'a', user_id: 'user_1', name: 'A', files: { animations: [] } } as GoonRecord
    setGoons([goon])
    const revision = getGoonsMotionSourceRevision()
    updateGoonStore('a', { compatibility: { tier: 'A' } }, 'user_1')
    expect(getGoonsMotionSourceRevision()).toBe(revision)
    updateGoonStore('a', { files: { animations: [{ url: '/wave.glb', filename: 'wave.glb' }] } }, 'user_1')
    expect(getGoonsMotionSourceRevision()).toBeGreaterThan(revision)
  })

  it.each(['success', 'failure'])('does not let an older Motion read %s replace or poison a newer one', async (outcome) => {
    const oldResponse = deferred<Response>()
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/new.glb', filename: 'new.glb' }] } }), { status: 200 })
    ) as typeof fetch
    const oldRead = loadGoonAnimationLibrary().catch((error) => error)
    await loadGoonAnimationLibrary()
    if (outcome === 'success') oldResponse.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/old.glb', filename: 'old.glb' }] } }), { status: 200 }))
    else oldResponse.reject(new Error('late failure'))
    await oldRead
    expect(getGoonAnimationLibrary().vrma.map((file) => file.filename)).toEqual(['new.glb'])
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_1', confirmed: true, loading: false, error: null })
  })

  it('does not reuse an old account read after an A-to-B-to-A owner change', async () => {
    const oldResponse = deferred<Response>()
    global.fetch = vi.fn().mockReturnValue(oldResponse.promise) as typeof fetch
    const oldRead = loadGoonAnimationLibrary().catch((error) => error)
    ;(page.data as any).user = { id: 'user_2' }
    setGoonsOwner('user_2'); setGoonAnimationLibraryOwner('user_2')
    setGoonAnimationLibrary({ vrma: [{ url: '/b.glb', filename: 'b.glb' }] })
    ;(page.data as any).user = { id: 'user_1' }
    setGoonsOwner('user_1'); setGoonAnimationLibraryOwner('user_1')
    setGoonAnimationLibrary({ vrma: [{ url: '/fresh-a.glb', filename: 'fresh-a.glb' }] })
    oldResponse.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/old-a.glb', filename: 'old-a.glb' }] } }), { status: 200 }))
    await oldRead
    expect(getGoonAnimationLibrary().vrma.map((file) => file.filename)).toEqual(['fresh-a.glb'])
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_1', confirmed: true, error: null })
  })

  it('binds a new authenticated account before accepting its Motion library', async () => {
    const oldResponse = deferred<Response>()
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_2', library: { vrma: [{ url: '/b.glb', filename: 'b.glb' }] } }), { status: 200 })
    ) as typeof fetch
    setGoonAnimationLibrary({ vrma: [{ url: '/a.glb', filename: 'a.glb' }] })
    const oldRead = loadGoonAnimationLibrary().catch((error) => error)
    ;(page.data as any).user = { id: 'user_2' }
    await loadGoonAnimationLibrary()
    oldResponse.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/old-a.glb', filename: 'old-a.glb' }] } }), { status: 200 }))
    await oldRead
    expect(getGoonAnimationLibrary().vrma.map((file) => file.filename)).toEqual(['b.glb'])
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_2', confirmed: true, error: null })
  })

  it('does not apply a prior account’s delayed Motion mutation acknowledgement', async () => {
    const oldResponse = deferred<Response>()
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_2', library: { vrma: [{ url: '/b.glb', filename: 'b.glb' }] } }), { status: 200 })
    ) as typeof fetch
    const oldWrite = updateGoonAnimationLibraryMetadata('a.glb', { displayName: 'A' }).catch((error) => error)
    ;(page.data as any).user = { id: 'user_2' }
    await loadGoonAnimationLibrary()
    oldResponse.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/a.glb', filename: 'a.glb' }] } }), { status: 200 }))
    await oldWrite
    expect(getGoonAnimationLibrary().vrma.map((file) => file.filename)).toEqual(['b.glb'])
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_2', confirmed: true, error: null })
  })

  it('re-reads after a confirmed late Motion mutation instead of applying its old acknowledgement', async () => {
    const oldResponse = deferred<Response>()
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/new.glb', filename: 'new.glb' }] } }), { status: 200 })
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/actually-current.glb', filename: 'actually-current.glb' }] } }), { status: 200 })
    ) as typeof fetch
    const oldWrite = updateGoonAnimationLibraryMetadata('old.glb', { displayName: 'Old' })
    await loadGoonAnimationLibrary()
    oldResponse.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/old.glb', filename: 'old.glb' }] } }), { status: 200 }))
    expect((await oldWrite).vrma[0].filename).toBe('actually-current.glb')
    expect(getGoonAnimationLibrary().vrma.map((file) => file.filename)).toEqual(['actually-current.glb'])
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_1', confirmed: true, error: null })
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('does not let an older failed Motion mutation poison a newer confirmed read', async () => {
    const oldResponse = deferred<Response>()
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/new.glb', filename: 'new.glb' }] } }), { status: 200 })
    ) as typeof fetch
    const oldWrite = updateGoonAnimationLibraryMetadata('old.glb', { displayName: 'Old' }).catch((error) => error)
    await loadGoonAnimationLibrary()
    oldResponse.reject(new Error('late failure'))
    await oldWrite
    expect(getGoonAnimationLibrary().vrma[0].filename).toBe('new.glb')
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_1', confirmed: true, error: null })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('coalesces conflicting Motion acknowledgements and re-reads after the last one settles', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const intermediate = deferred<Response>()
    global.fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [] } }), { status: 200 }))
      .mockReturnValueOnce(intermediate.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/final.glb', filename: 'final.glb' }] } }), { status: 200 })) as typeof fetch
    const firstWrite = updateGoonAnimationLibraryMetadata('a.glb', { displayName: 'A' })
    const secondWrite = updateGoonAnimationLibraryMetadata('b.glb', { displayName: 'B' })
    await loadGoonAnimationLibrary()
    first.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [] } }), { status: 200 }))
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(4))
    second.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [] } }), { status: 200 }))
    intermediate.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/intermediate.glb', filename: 'intermediate.glb' }] } }), { status: 200 }))
    const results = await Promise.all([firstWrite, secondWrite])
    expect(results.map((result) => result.vrma[0]?.filename)).toEqual(['final.glb', 'final.glb'])
    expect(getGoonAnimationLibrary().vrma[0]?.filename).toBe('final.glb')
    expect(global.fetch).toHaveBeenCalledTimes(5)
  })

  it('keeps confirmed Motion data when a duplicate upload is definitely refused', async () => {
    setGoonAnimationLibrary({ vrma: [{ url: '/kept.glb', filename: 'kept.glb' }] })
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 'motion_version_exists', error: 'Already exists', conflict: { motionName: 'kept', lane: 'glb' }
    }), { status: 409 })) as typeof fetch
    await expect(uploadGoonAnimationToLibrary(new File(['x'], 'kept.glb'))).rejects.toBeInstanceOf(GoonMotionVersionExistsError)
    expect(getGoonAnimationLibrary().vrma[0]?.filename).toBe('kept.glb')
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_1', confirmed: true, loading: false, error: null })
  })

  it('refuses another account’s library response while preserving the last same-owner copy', async () => {
    setGoonAnimationLibrary({ vrma: [{ url: '/kept.glb', filename: 'kept.glb' }] })
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ownerId: 'user_2', library: { vrma: [] } }), { status: 200 })) as typeof fetch
    await expect(loadGoonAnimationLibrary()).rejects.toThrow('invalid')
    expect(getGoonAnimationLibrary().vrma[0]?.filename).toBe('kept.glb')
    expect(getGoonAnimationLibraryReadState()).toMatchObject({ owner: 'user_1', confirmed: false })
  })

  it.each(['http', 'network', 'json', 'shape'])('keeps the exact last loaded list on a %s read failure', async kind => {
    setGoons([{ id: 'last-known', name: 'Kept Goon', files: {} } as GoonRecord])
    const previous = getGoons()
    global.fetch = vi.fn(async () => {
      if (kind === 'network') throw new Error('Read connection failed')
      if (kind === 'http') return new Response(JSON.stringify({ error: 'Legacy closet needs recovery', details: 'No saved item was changed' }), { status: 409 })
      if (kind === 'json') return new Response('{invalid', { status: 200 })
      return new Response(JSON.stringify({ unexpected: [] }), { status: 200 })
    }) as typeof fetch
    await expect(loadGoons()).rejects.toThrow()
    expect(getGoons()).toBe(previous)
    expect(getGoons()[0]?.id).toBe('last-known')
    expect(getGoonsReadState()).toMatchObject({ owner: 'user_1', confirmed: false, loading: false })
    expect(getGoonsReadState().error).toBeTruthy()
    if (kind === 'http') expect(getGoonsReadState().error).toBe('Legacy closet needs recovery: No saved item was changed')
  })

  it('accepts an authoritative empty list and clears a previous read error', async () => {
    setGoons([{ id: 'last-known', name: 'Kept Goon' } as GoonRecord])
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ownerId: 'user_1', goons: [] }), { status: 200 })) as typeof fetch
    await expect(loadGoons()).resolves.toEqual([])
    expect(getGoons()).toEqual([])
    expect(getGoonsReadState()).toMatchObject({ owner: 'user_1', confirmed: true, loading: false, error: null })
  })

  it.each([
    { rows: [{ user_id: 'user_1', files: {} }] },
    { rows: [{ id: 'a', user_id: 'user_1', name: { invalid: true }, files: {} }] },
    { rows: [{ id: 'a', user_id: 'user_1', files: {} }, { id: 'a', user_id: 'user_1', files: {} }] }
  ])('retains the last Goon list when an apparent success has malformed or duplicate rows', async ({ rows }) => {
    setGoons([{ id: 'kept', user_id: 'user_1', name: 'Kept', files: {} } as GoonRecord])
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ownerId: 'user_1', goons: rows }), { status: 200 })) as typeof fetch
    await expect(loadGoons()).rejects.toThrow('invalid')
    expect(getGoons().map((goon) => goon.id)).toEqual(['kept'])
    expect(getGoonsReadState()).toMatchObject({ confirmed: false })
  })

  it('keeps an owned Goon visible while its malformed motion source is unverified', async () => {
    const row = { id: 'a', user_id: 'user_1', name: 'Kept', files: { animations: 'broken' } }
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ownerId: 'user_1', goons: [row] }), { status: 200 })) as typeof fetch
    await expect(loadGoons()).resolves.toEqual([row])
    expect(getGoons()[0].name).toBe('Kept')
    expect(isValidGoonMotionSources(getGoons()[0])).toBe(false)
  })

  it.each(['success', 'failure'])('does not let an older Goon list read %s replace a newer confirmed list', async (outcome) => {
    const oldResponse = deferred<Response>()
    const latest = { id: 'new', user_id: 'user_1', name: 'New', files: {} }
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', goons: [latest] }), { status: 200 })
    ) as typeof fetch
    const oldRead = loadGoons().catch((error) => error)
    await loadGoons()
    if (outcome === 'success') oldResponse.resolve(new Response(JSON.stringify({ ownerId: 'user_1', goons: [] }), { status: 200 }))
    else oldResponse.reject(new Error('late failure'))
    await oldRead
    expect(getGoons()).toEqual([latest])
    expect(getGoonsReadState()).toMatchObject({ owner: 'user_1', confirmed: true, loading: false, error: null })
  })

  it('re-reads after a confirmed late Goon mutation instead of applying its old acknowledgement', async () => {
    const oldResponse = deferred<Response>()
    const latest = { id: 'a', user_id: 'user_1', name: 'New', files: {} }
    setGoons([{ ...latest, name: 'Before' } as GoonRecord])
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', goons: [latest] }), { status: 200 })
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', goons: [{ ...latest, name: 'Actually current' }] }), { status: 200 })
    ) as typeof fetch
    const oldWrite = updateGoonRecord('a', { name: 'Old' })
    await loadGoons()
    oldResponse.resolve(new Response(JSON.stringify({ goon: { ...latest, name: 'Old' } }), { status: 200 }))
    expect((await oldWrite).name).toBe('Actually current')
    expect(getGoons()).toEqual([{ ...latest, name: 'Actually current' }])
    expect(getGoonsReadState()).toMatchObject({ owner: 'user_1', confirmed: true, error: null })
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  it('does not let an older failed Goon mutation poison a newer confirmed list', async () => {
    const oldResponse = deferred<Response>()
    const latest = { id: 'a', user_id: 'user_1', name: 'New', files: {} }
    setGoons([{ ...latest, name: 'Before' } as GoonRecord])
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_1', goons: [latest] }), { status: 200 })
    ) as typeof fetch
    const oldWrite = updateGoonRecord('a', { name: 'Old' }).catch((error) => error)
    await loadGoons()
    oldResponse.reject(new Error('late failure'))
    await oldWrite
    expect(getGoons()).toEqual([latest])
    expect(getGoonsReadState()).toMatchObject({ owner: 'user_1', confirmed: true, error: null })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not apply a prior account’s delayed Goon mutation acknowledgement', async () => {
    const oldResponse = deferred<Response>()
    const oldGoon = { id: 'a', user_id: 'user_1', name: 'A', files: {} }
    const newGoon = { id: 'b', user_id: 'user_2', name: 'B', files: {} }
    setGoons([oldGoon as GoonRecord])
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      new Response(JSON.stringify({ ownerId: 'user_2', goons: [newGoon] }), { status: 200 })
    ) as typeof fetch
    const oldWrite = updateGoonRecord('a', { name: 'Changed' }).catch((error) => error)
    ;(page.data as any).user = { id: 'user_2' }
    await loadGoons()
    oldResponse.resolve(new Response(JSON.stringify({ goon: { ...oldGoon, name: 'Changed' } }), { status: 200 }))
    await oldWrite
    expect(getGoons()).toEqual([newGoon])
    expect(getGoonsReadState()).toMatchObject({ owner: 'user_2', confirmed: true, error: null })
  })

  it('refreshes current agent assignments instead of applying a stale delete acknowledgement', async () => {
    const oldResponse = deferred<Response>()
    const oldGoon = { id: 'a', user_id: 'user_1', name: 'A', files: {} }
    setGoons([oldGoon as GoonRecord])
    agentStore.setAgents([{ id: 'agent-a', user_id: 'user_1', displayName: 'Kept', goon_id: 'a' } as any])
    global.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ownerId: 'user_1', goons: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ownerId: 'user_1', goons: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'agent-a', user_id: 'user_1', goon_id: 'replacement' }), { status: 200 })) as typeof fetch
    const deleting = deleteGoon('a')
    await loadGoons()
    oldResponse.resolve(new Response(JSON.stringify({ ownerId: 'user_1', success: true, clearedAgentIds: ['agent-a'] }), { status: 200 }))
    await deleting
    expect(agentStore.getAgentById('agent-a')).toMatchObject({ displayName: 'Kept', goon_id: 'replacement' })
    expect(getGoons()).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(4)
  })

  it('keeps a newer Agent assignment when the Goon list did not change during deletion', async () => {
    const response = deferred<Response>()
    setGoons([{ id: 'a', user_id: 'user_1', name: 'A', files: {} } as GoonRecord])
    agentStore.setAgents([{ id: 'agent-a', user_id: 'user_1', displayName: 'Kept', goon_id: 'a' } as any])
    global.fetch = vi.fn().mockReturnValueOnce(response.promise) as typeof fetch
    const deleting = deleteGoon('a')
    agentStore.updateAgent('agent-a', { goon_id: 'replacement' })
    response.resolve(new Response(JSON.stringify({ ownerId: 'user_1', success: true, clearedAgentIds: ['agent-a'] }), { status: 200 }))
    await deleting
    expect(agentStore.getAgentById('agent-a')).toMatchObject({ displayName: 'Kept', goon_id: 'replacement' })
    expect(getGoons()).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('reports an unresolved Agent assignment if that Agent changed but still names the deleted Goon', async () => {
    const response = deferred<Response>()
    setGoons([{ id: 'a', user_id: 'user_1', name: 'A', files: {} } as GoonRecord])
    agentStore.setAgents([{ id: 'agent-a', user_id: 'user_1', displayName: 'Before', goon_id: 'a' } as any])
    global.fetch = vi.fn().mockReturnValueOnce(response.promise) as typeof fetch
    const deleting = deleteGoon('a')
    agentStore.updateAgent('agent-a', { displayName: 'Newer edit' })
    response.resolve(new Response(JSON.stringify({ ownerId: 'user_1', success: true, clearedAgentIds: ['agent-a'] }), { status: 200 }))
    await expect(deleting).rejects.toThrow('was deleted, but its agent assignments could not be confirmed')
    expect(agentStore.getAgentById('agent-a')).toMatchObject({ displayName: 'Newer edit', goon_id: 'a' })
    expect(getGoons()).toEqual([])
  })

  it('reports a successful Goon update distinctly when its reconciliation read fails', async () => {
    const response = deferred<Response>()
    const goon = { id: 'a', user_id: 'user_1', name: 'A', files: {} } as GoonRecord
    setGoons([goon])
    global.fetch = vi.fn().mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 })) as typeof fetch
    const updating = updateGoonRecord('a', { name: 'Saved' })
    updateGoonStore('a', { name: 'Newer local' })
    response.resolve(new Response(JSON.stringify({ goon: { ...goon, name: 'Saved' } }), { status: 200 }))
    await expect(updating).rejects.toThrow('update succeeded, but its current state is unavailable')
    expect(getGoons()[0].name).toBe('Newer local')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('reports a successful Goon deletion distinctly when its reconciliation read fails', async () => {
    const response = deferred<Response>()
    setGoons([{ id: 'a', user_id: 'user_1', name: 'A', files: {} } as GoonRecord])
    global.fetch = vi.fn().mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 })) as typeof fetch
    const deleting = deleteGoon('a')
    updateGoonStore('a', { name: 'Newer local' })
    response.resolve(new Response(JSON.stringify({ ownerId: 'user_1', success: true, clearedAgentIds: [] }), { status: 200 }))
    await expect(deleting).rejects.toThrow('was deleted, but its current state is unavailable')
    expect(getGoons()[0].name).toBe('Newer local')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('reports a successful Motion update distinctly when its reconciliation read fails', async () => {
    const response = deferred<Response>()
    setGoonAnimationLibrary({ vrma: [{ url: '/wave.glb', filename: 'wave.glb' }] })
    global.fetch = vi.fn().mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 })) as typeof fetch
    const updating = updateGoonAnimationLibraryMetadata('wave.glb', { displayName: 'Saved' })
    setGoonAnimationLibrary({ vrma: [{ url: '/wave.glb', filename: 'wave.glb', displayName: 'Newer local' }] })
    response.resolve(new Response(JSON.stringify({ ownerId: 'user_1', library: { vrma: [{ url: '/wave.glb', filename: 'wave.glb', displayName: 'Saved' }] } }), { status: 200 }))
    await expect(updating).rejects.toThrow('Motion update succeeded, but its current library is unavailable')
    expect(getGoonAnimationLibrary().vrma[0].displayName).toBe('Newer local')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('persists editor camera changes without invalidating the global Goon collection', async () => {
    const original = {
      id: 'goon_custom_1',
      user_id: 'user_1',
      name: 'Unsaved editor draft owner',
      camera: { position: [0, 1, 2] }
    } as GoonRecord
    setGoons([original])
    const storedBefore = getGoons()[0]
    const camera = { position: [2, 3, 4] } as NonNullable<GoonRecord['camera']>
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_custom_1')
      expect(init?.method).toBe('PUT')
      expect(JSON.parse(String(init?.body))).toEqual({ camera })
      return new Response(
        JSON.stringify({
          goon: {
            ...original,
            camera,
            updated_at: '2026-08-10T00:00:00.000Z'
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    await persistGoonCamera(original.id, camera)

    expect(getGoons()).toHaveLength(1)
    expect(getGoons()[0]).toBe(storedBefore)
    expect(getGoons()[0]?.camera).toEqual({ position: [0, 1, 2] })
  })

  it('resets retired Hair through the dedicated Recipe route and refreshes the stored Goon', async () => {
    const original = {
      id: 'goon_custom_1',
      user_id: 'user_1',
      name: 'Hair recovery owner',
      files: {},
      recipe: { contract: 'goon-recipe/v2', writeVersion: 4 },
      hairState: { schemaVersion: 'hair-state/v1' }
    } as unknown as GoonRecord
    const recovered = structuredClone(original)
    recovered.recipe = { contract: 'goon-recipe/v2', writeVersion: 5 } as GoonRecord['recipe']
    delete recovered.hairState
    setGoons([original])
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_custom_1/recipe/recover-retired-hair')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ expectedWriteVersion: 4 })
      return new Response(JSON.stringify({ goon: recovered }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch

    await expect(resetRetiredGoonHair(original.id, 4)).resolves.toEqual(recovered)
    expect(getGoons()[0]).toEqual(recovered)
  })

  it('submits custom goon creation with kind=custom', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('kind')).toBe('custom')
      expect((form.get('file') as File | null)?.name).toBe('kiriko.bgoon')

      return new Response(
        JSON.stringify({
          id: 'goon_custom_1',
          user_id: 'user_1',
          name: 'Kiriko Custom',
          kind: 'custom',
          files: { animations: [] },
          customAvatar: {},
          created_at: '2026-03-24T00:00:00.000Z',
          updated_at: '2026-03-24T00:00:00.000Z'
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['package'], 'kiriko.bgoon', {
      type: 'application/octet-stream'
    })
    const goon = await createGoon({ kind: 'custom', file })

    expect(goon.kind).toBe('custom')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('submits advanced blender goon creation with the guided source profile', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('kind')).toBe('vrm')
      expect(form.get('sourceProfile')).toBe('guided-custom-vrm')
      expect((form.get('file') as File | null)?.name).toBe('kiriko-guided.bgoon')

      return new Response(
        JSON.stringify({
          id: 'goon_guided_1',
          user_id: 'user_1',
          name: 'Kiriko Guided',
          kind: 'vrm',
          sourceProfile: 'guided-custom-vrm',
          files: { animations: [] },
          guidedAvatar: {},
          created_at: '2026-04-16T00:00:00.000Z',
          updated_at: '2026-04-16T00:00:00.000Z'
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['package'], 'kiriko-guided.bgoon', {
      type: 'application/octet-stream'
    })
    const goon = await createGoon({ sourceProfile: 'guided-custom-vrm', file })

    expect(goon.sourceProfile).toBe('guided-custom-vrm')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces json upload errors as plain text', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'File too large. 350 MB or smaller.' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch

    const file = new File(['package'], 'kiriko.bgoon', {
      type: 'application/octet-stream'
    })

    await expect(createGoon({ kind: 'custom', file })).rejects.toThrow(
      'File too large. 350 MB or smaller.'
    )
  })

  it('uploads guided DUF clothes vrms through the dedicated route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_guided_1/duf-clothes')
      const form = init?.body as FormData
      expect((form.get('file') as File | null)?.name).toBe('kiriko-duf.vrm')

      return new Response(
        JSON.stringify({
          file: {
            url: '/uploads/kiriko-duf.vrm',
            filename: 'kiriko-duf.vrm',
            mimetype: 'model/vrm'
          }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['vrm'], 'kiriko-duf.vrm', { type: 'model/vrm' })
    const uploaded = await uploadGuidedDufClothesVrm('goon_guided_1', file)

    expect(uploaded.url).toBe('/uploads/kiriko-duf.vrm')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uploads advanced blender package updates through the dedicated route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_guided_1/advanced-package')
      const form = init?.body as FormData
      expect((form.get('file') as File | null)?.name).toBe('kiriko-v2.bgoon')

      return new Response(
        JSON.stringify({
          files: {
            package: {
              url: '/uploads/kiriko-v2.bgoon',
              filename: 'kiriko-v2.bgoon',
              mimetype: 'application/zip'
            },
            vrm: {
              url: '/uploads/kiriko-v2_avatar.vrm',
              filename: 'kiriko-v2_avatar.vrm',
              mimetype: 'model/vrm'
            },
            manifest: {
              url: '/uploads/kiriko-v2_avatar.json',
              filename: 'kiriko-v2_avatar.json',
              mimetype: 'application/json'
            }
          },
          manifestData: {
            summary: { name: 'Kiriko V2', contractVersion: 1 },
            outfitPieces: [{ id: 'jacket', label: 'Jacket', runtimeNodeNames: ['Jacket'] }],
            outfitPresets: [
              {
                id: 'all_original',
                name: 'All Original',
                piecesOn: ['jacket']
              }
            ]
          }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    })

    global.fetch = fetchMock as typeof fetch

    const file = new File(['package'], 'kiriko-v2.bgoon', {
      type: 'application/octet-stream'
    })
    const uploaded = await uploadAdvancedGoonPackage('goon_guided_1', file)

    expect(uploaded.package.url).toBe('/uploads/kiriko-v2.bgoon')
    expect(uploaded.vrm.url).toBe('/uploads/kiriko-v2_avatar.vrm')
    expect(uploaded.manifestSummary?.name).toBe('Kiriko V2')
    expect(uploaded.outfitPieces[0]?.id).toBe('jacket')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uploads exact facial-artwork metadata through the Goon-owned route', async () => {
    const definitionSha256 = 'a'.repeat(64)
    const guideSha256 = 'b'.repeat(64)
    const maskSha256 = 'd'.repeat(64)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_custom_1/facial-artwork')
      const form = init?.body as FormData
      expect(form.get('role')).toBe('brows')
      expect(form.get('definitionSha256')).toBe(definitionSha256)
      expect(form.get('templateId')).toBe('brow-canvas')
      expect(form.get('templateVersion')).toBe('2.0.0')
      expect(form.get('orientation')).toBe('anatomical-left')
      expect(form.get('guideSha256')).toBe(guideSha256)
      expect(form.get('maskSha256')).toBe(maskSha256)
      expect(JSON.parse(String(form.get('provenance')))).toEqual({
        sourceKind: 'user-authored',
        author: 'Fixture Artist',
        license: 'User-owned',
        rightsConfirmed: true
      })
      return new Response(
        JSON.stringify({
          artwork: {
            role: 'brows',
            url: '/uploads/goon_facial_artwork/brow-left.png',
            filename: 'brow-left.png',
            size: 123,
            mimeType: 'image/png',
            sha256: 'c'.repeat(64),
            template: {
              id: 'brow-canvas',
              version: '2.0.0',
              orientation: 'anatomical-left',
              guideSha256,
              maskSha256
            },
            provenance: {
              sourceKind: 'user-authored',
              author: 'Fixture Artist',
              license: 'User-owned',
              rightsConfirmed: true
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    global.fetch = fetchMock as typeof fetch

    const result = await uploadGoonFacialArtwork(
      'goon_custom_1',
      new File(['png'], 'brow.png', { type: 'image/png' }),
      {
        role: 'brows',
        definitionSha256,
        templateId: 'brow-canvas',
        templateVersion: '2.0.0',
        orientation: 'anatomical-left',
        guideSha256,
        maskSha256,
        provenance: {
          sourceKind: 'user-authored',
          author: 'Fixture Artist',
          license: 'User-owned',
          rightsConfirmed: true
        }
      }
    )
    expect(result).toMatchObject({ role: 'brows', filename: 'brow-left.png' })
  })

  it('treats referenced facial-artwork deletion as a safe shared-reference result', async () => {
    global.fetch = vi.fn(async () => new Response('', { status: 409 })) as typeof fetch
    await expect(deleteGoonFacialArtwork('goon_custom_1', 'shared.png')).resolves.toBe(false)
  })

  it('uploads Lip Artwork without exposing package template proof to the browser', async () => {
    const definitionSha256 = 'a'.repeat(64)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_custom_1/lip-artwork')
      const form = init?.body as FormData
      expect([...form.keys()].sort()).toEqual(['definitionSha256', 'file', 'provenance'])
      expect(form.get('definitionSha256')).toBe(definitionSha256)
      return new Response(
        JSON.stringify({
          artwork: {
            url: '/uploads/goon_facial_artwork/lips.png',
            filename: 'lips.png',
            size: 123,
            mimeType: 'image/png',
            sha256: 'b'.repeat(64)
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    global.fetch = fetchMock as typeof fetch

    await expect(
      uploadGoonLipArtwork('goon_custom_1', new File(['png'], 'lips.png', { type: 'image/png' }), {
        definitionSha256,
        provenance: {
          sourceKind: 'user-authored',
          author: 'Fixture Artist',
          license: 'User-owned',
          rightsConfirmed: true
        }
      })
    ).resolves.toMatchObject({ filename: 'lips.png' })
  })

  it('uploads family-bound Nail Artwork without exposing trusted template proof to the browser', async () => {
    const definitionSha256 = 'a'.repeat(64)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/goons/goon_custom_1/nail-artwork')
      const form = init?.body as FormData
      expect([...form.keys()].sort()).toEqual(['definitionSha256', 'family', 'file', 'provenance'])
      expect(form.get('family')).toBe('fingers')
      return new Response(
        JSON.stringify({
          artwork: {
            schemaVersion: 'nail-artwork/v1',
            family: 'fingers',
            url: '/uploads/goon_nail_artwork/fingers.png',
            filename: 'fingers.png',
            size: 123,
            mimeType: 'image/png',
            sha256: 'b'.repeat(64)
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    global.fetch = fetchMock as typeof fetch

    await expect(
      uploadGoonNailArtwork(
        'goon_custom_1',
        new File(['png'], 'fingers.png', { type: 'image/png' }),
        {
          family: 'fingers',
          definitionSha256,
          provenance: {
            sourceKind: 'user-authored',
            author: 'Fixture Artist',
            license: 'User-owned',
            rightsConfirmed: true
          }
        }
      )
    ).resolves.toMatchObject({ family: 'fingers', filename: 'fingers.png' })
  })
})
