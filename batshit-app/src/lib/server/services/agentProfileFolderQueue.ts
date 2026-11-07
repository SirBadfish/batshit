import { AsyncLocalStorage } from 'node:async_hooks'
import { getManagedAgentRootDir } from './batshitHome'
import { managedProfileResource } from './managedProfileResource'

type ResourceState = { tail: Promise<void>; generation: number; queued: number; captures: number; uncertain: boolean }
type QueueGlobal = typeof globalThis & { __batshitAgentProfileFolderQueueV2?: Map<string, ResourceState> }
const states = () => ((globalThis as QueueGlobal).__batshitAgentProfileFolderQueueV2 ??= new Map())
type HeldState = { resource: string; state: ResourceState; active: boolean }
const held = new AsyncLocalStorage<ReadonlyMap<string, ProfileFolderTurn>>()
const turns = new WeakMap<object, HeldState>()
const preparations = new WeakMap<object, { resource: string; profileId: string; root: string;
  state: ResourceState; generation: number; released: boolean }>()
declare const turnBrand: unique symbol
declare const preparationBrand: unique symbol
export type ProfileFolderTurn = Readonly<{ readonly [turnBrand]: true }>
export type ProfileFolderPreparation = Readonly<{ readonly [preparationBrand]: true }>

export class ProfileFolderChangedError extends Error {
  readonly code = 'PROFILE_FOLDER_SOURCE_CHANGED'
  constructor() { super('The original managed profile preparation is no longer current.') }
}
class ProfileFolderOutcomeUncertainError extends ProfileFolderChangedError {}
export function isProfileFolderOutcomeUncertain(error: unknown): boolean {
  return error instanceof ProfileFolderOutcomeUncertainError
}

function resource(profileId: string, root = getManagedAgentRootDir()) {
  return managedProfileResource(profileId, root)
}
function stateFor(key: string) {
  let state = states().get(key)
  if (!state) { state = { tail: Promise.resolve(), generation: 0, queued: 0, captures: 0, uncertain: false }; states().set(key, state) }
  return state
}
function retire(key: string, state: ResourceState) {
  if (!state.uncertain && !state.queued && !state.captures && states().get(key) === state) states().delete(key)
}

/** Original pre-preparation generation; a recreated idle queue cannot accept its old identity. */
export function captureProfileFolderPreparation(profileId: string): ProfileFolderPreparation {
  const root = getManagedAgentRootDir(), key = resource(profileId, root), state = stateFor(key)
  state.captures++
  const value = Object.freeze({}) as ProfileFolderPreparation
  preparations.set(value, { resource: key, profileId, root, state, generation: state.generation, released: false })
  return value
}

export function releaseProfileFolderPreparation(value: ProfileFolderPreparation): void {
  const original = preparations.get(value)
  if (!original || original.released) return
  original.released = true
  original.state.captures--
  retire(original.resource, original.state)
}

export function assertProfileFolderPreparation(value: ProfileFolderPreparation, turn?: ProfileFolderTurn): void {
  const original = preparations.get(value)
  if (!original || original.released || original.state.uncertain || states().get(original.resource) !== original.state ||
    original.generation !== original.state.generation || resource(original.profileId, original.root) !== original.resource ||
    resource(original.profileId) !== original.resource) throw original?.state.uncertain
      ? new ProfileFolderOutcomeUncertainError() : new ProfileFolderChangedError()
  if (turn) {
    const current = turns.get(turn)
    if (!current?.active || current.state !== original.state || current.resource !== original.resource ||
      held.getStore()?.get(current.resource) !== turn) throw new ProfileFolderChangedError()
  }
}

/** An actually issued write with no definitive result keeps only this resource unavailable. */
export function markProfileFolderUncertain(turn: ProfileFolderTurn): void {
  const current = turns.get(turn)
  if (!current?.active || held.getStore()?.get(current.resource) !== turn) throw new ProfileFolderChangedError()
  current.state.uncertain = true
}

export function markProfileFoldersUncertain(profileIds: readonly string[]): void {
  for (const profileId of profileIds) {
    const turn = held.getStore()?.get(resource(profileId))
    if (!turn) throw new ProfileFolderChangedError()
    markProfileFolderUncertain(turn)
  }
}

export function advanceProfileFolderTurns(profileIds: readonly string[]): void {
  for (const profileId of new Set(profileIds)) {
    const turn = held.getStore()?.get(resource(profileId))
    if (!turn) throw new ProfileFolderChangedError()
    advanceProfileFolderGeneration(turn)
  }
}

/** Only an actual held resource turn may invalidate earlier prepared file/source bytes. */
export function advanceProfileFolderGeneration(turn: ProfileFolderTurn): void {
  const current = turns.get(turn)
  if (!current?.active || held.getStore()?.get(current.resource) !== turn ||
    states().get(current.resource) !== current.state || current.state.generation >= Number.MAX_SAFE_INTEGER) throw new ProfileFolderChangedError()
  current.state.generation++
}

export function assertProfileFolderTurn(turn: ProfileFolderTurn, profileId: string): void {
  const current = turns.get(turn)
  if (!current?.active || held.getStore()?.get(current.resource) !== turn ||
    current.state.uncertain || current.resource !== resource(profileId) || states().get(current.resource) !== current.state) throw current?.state.uncertain
      ? new ProfileFolderOutcomeUncertainError() : new ProfileFolderChangedError()
}

/** Existing folder turn, now keyed by the actual root and canonical physical profile resource. */
export async function withProfileFolderTurn<T>(profileId: string, action: (turn: ProfileFolderTurn) => Promise<T>): Promise<T> {
  const key = resource(profileId), inherited = held.getStore()?.get(key)
  if (inherited) { assertProfileFolderTurn(inherited, profileId); return action(inherited) }
  const state = stateFor(key), previous = state.tail
  let release!: () => void
  const mine = new Promise<void>(resolve => { release = resolve })
  state.tail = previous.then(() => mine)
  state.queued++
  await previous
  const turn = Object.freeze({}) as ProfileFolderTurn
  const current = { resource: key, state, active: true }
  turns.set(turn, current)
  const context = new Map(held.getStore() ?? [])
  context.set(key, turn)
  try {
    return await held.run(context, () => {
      if (state.uncertain) throw new ProfileFolderOutcomeUncertainError()
      return action(turn)
    })
  } finally {
    current.active = false
    state.queued--
    release()
    retire(key, state)
  }
}

export async function withPreparedProfileFolderTurn<T>(value: ProfileFolderPreparation,
  action: (turn: ProfileFolderTurn) => Promise<T>): Promise<T> {
  const original = preparations.get(value)
  if (!original || original.released) throw new ProfileFolderChangedError()
  return withProfileFolderTurn(original.profileId, async turn => {
    assertProfileFolderPreparation(value, turn)
    return action(turn)
  })
}

/** Population changes hold only their actual old/new resources, in one stable order. */
export async function withProfileFolderTurns<T>(profileIds: readonly string[], action: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(profileIds)].sort((a, b) => resource(a) < resource(b) ? -1 : resource(a) > resource(b) ? 1 : 0)
  const enter = (index: number): Promise<T> => index === ordered.length ? action()
    : withProfileFolderTurn(ordered[index], () => enter(index + 1))
  return enter(0)
}
