import type { GoonAnimationLibrary } from '$lib/types/goons'

const emptyLibrary: GoonAnimationLibrary = { vrma: [] }

let library = $state<GoonAnimationLibrary>({ ...emptyLibrary })
let loading = $state(false)
let error = $state<string | null>(null)
let confirmed = $state(false)
let owner = $state<string | null>(null)
let generation = 0
let sourceRevision = $state(0)

export function getGoonAnimationLibrary() {
  return library
}

export function setGoonAnimationLibrary(next: GoonAnimationLibrary | null | undefined) {
  generation += 1
  sourceRevision += 1
  loading = false
  const vrma = Array.isArray(next?.vrma) ? next!.vrma : []
  library = {
    ...emptyLibrary,
    ...(next ?? {}),
    vrma
  }
  confirmed = Boolean(next && Array.isArray(next.vrma))
  if (confirmed) error = null
}

export function getGoonAnimationLibraryReadState() {
  return { owner, confirmed, loading, error }
}

export function getGoonAnimationLibrarySourceRevision() { return sourceRevision }

export function setGoonAnimationLibraryOwner(userId: string | null) {
  if (owner === userId) return
  owner = userId
  generation += 1
  sourceRevision += 1
  library = { ...emptyLibrary, vrma: [] }
  loading = false
  error = null
  confirmed = false
}

export function beginGoonAnimationLibraryOperation(userId: string) {
  setGoonAnimationLibraryOwner(userId)
  const ticket = { owner: userId, generation: ++generation, previousConfirmed: confirmed, previousError: error }
  loading = true
  error = null
  return ticket
}

export function restoreGoonAnimationLibraryOperation(ticket: {
  owner: string; generation: number; previousConfirmed: boolean; previousError: string | null
}) {
  if (!isCurrentGoonAnimationLibraryOperation(ticket)) return false
  loading = false
  confirmed = ticket.previousConfirmed
  error = ticket.previousError
  return true
}

export function isCurrentGoonAnimationLibraryOperation(ticket: { owner: string; generation: number }) {
  return owner === ticket.owner && generation === ticket.generation
}

export function acceptGoonAnimationLibraryOperation(
  ticket: { owner: string; generation: number }, next: GoonAnimationLibrary
) {
  if (!isCurrentGoonAnimationLibraryOperation(ticket)) return false
  library = { ...emptyLibrary, ...next, vrma: next.vrma }
  sourceRevision += 1
  loading = false
  error = null
  confirmed = true
  return true
}

export function failGoonAnimationLibraryOperation(ticket: { owner: string; generation: number }, message: string) {
  if (!isCurrentGoonAnimationLibraryOperation(ticket)) return false
  loading = false
  error = message
  confirmed = false
  return true
}

export function setGoonAnimationLibraryLoading(value: boolean) {
  loading = value
}

export function setGoonAnimationLibraryError(value: string | null) {
  error = value
  if (value) confirmed = false
}
