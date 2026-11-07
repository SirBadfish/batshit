import type { GoonRecord } from '$lib/types/goons'

let goons = $state<GoonRecord[]>([])
let loading = $state(false)
let error = $state<string | null>(null)
let confirmed = $state(false)
let owner = $state<string | null>(null)
let generation = 0
let motionSourceRevision = $state(0)

function motionSourceKey(goon: GoonRecord | undefined) {
  return goon ? JSON.stringify([goon.id, goon.user_id, goon.files?.animations ?? null]) : ''
}

export function getGoons() {
  return goons
}

export function setGoons(list: GoonRecord[]) {
  generation += 1
  motionSourceRevision += 1
  goons = Array.isArray(list) ? list : []
  confirmed = Array.isArray(list)
  if (confirmed) error = null
}

export function getGoonsReadState() {
  return { owner, confirmed, loading, error }
}

export function getGoonsMotionSourceRevision() { return motionSourceRevision }

export function setGoonsOwner(userId: string | null) {
  if (owner === userId) return
  owner = userId
  generation += 1
  motionSourceRevision += 1
  goons = []
  loading = false
  error = null
  confirmed = false
}

export function beginGoonsRead(userId: string) {
  setGoonsOwner(userId)
  const ticket = { owner: userId, generation: ++generation }
  loading = true
  error = null
  return ticket
}

export function isCurrentGoonsRead(ticket: { owner: string; generation: number }) {
  return owner === ticket.owner && generation === ticket.generation
}

/** A mutation acknowledgement may update only the same owner/version of this cache. */
export function captureGoonsMutationTicket(userId: string) {
  setGoonsOwner(userId)
  return { owner: userId, generation }
}

export function isCurrentGoonsMutation(ticket: { owner: string; generation: number }) {
  return owner === ticket.owner && generation === ticket.generation
}

export function acceptGoonsRead(ticket: { owner: string; generation: number }, list: GoonRecord[]) {
  if (!isCurrentGoonsRead(ticket)) return false
  goons = list
  motionSourceRevision += 1
  confirmed = true
  loading = false
  error = null
  return true
}

export function failGoonsRead(ticket: { owner: string; generation: number }, message: string) {
  if (!isCurrentGoonsRead(ticket)) return false
  loading = false
  error = message
  confirmed = false
  return true
}

export function addGoon(goon: GoonRecord) {
  if (owner && goon.user_id !== owner) return
  generation += 1
  motionSourceRevision += 1
  loading = false
  goons = [goon, ...goons.filter((s) => s.id !== goon.id)]
}

export function updateGoon(id: string, updates: Partial<GoonRecord>, expectedOwner?: string) {
  if ((expectedOwner && owner !== expectedOwner) || (owner && updates.user_id && updates.user_id !== owner)) return
  generation += 1
  loading = false
  const previous = goons.find((goon) => goon.id === id)
  if (previous && (Object.hasOwn(updates, 'files') || Object.hasOwn(updates, 'user_id') || Object.hasOwn(updates, 'id')) &&
    motionSourceKey(previous) !== motionSourceKey({ ...previous, ...updates })) motionSourceRevision += 1
  goons = goons.map((s) => (s.id === id ? { ...s, ...updates } : s))
}

export function replaceGoon(id: string, goon: GoonRecord) {
  if (owner && goon.user_id !== owner) return
  generation += 1
  loading = false
  if (motionSourceKey(goons.find((entry) => entry.id === id)) !== motionSourceKey(goon)) motionSourceRevision += 1
  goons = goons.map((entry) => (entry.id === id ? goon : entry))
}

export function removeGoon(id: string) {
  generation += 1
  if (goons.some((goon) => goon.id === id)) motionSourceRevision += 1
  loading = false
  goons = goons.filter((s) => s.id !== id)
}

export function setGoonsLoading(value: boolean) {
  loading = value
}

export function setGoonsError(value: string | null) {
  error = value
  if (value) confirmed = false
}
