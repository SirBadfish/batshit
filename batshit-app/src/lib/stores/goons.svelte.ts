import type { GoonRecord } from '$lib/types/goons'

let goons = $state<GoonRecord[]>([])
let loading = $state(false)
let error = $state<string | null>(null)

export function getGoons() {
  return goons
}

export function setGoons(list: GoonRecord[]) {
  goons = Array.isArray(list) ? list : []
}

export function addGoon(goon: GoonRecord) {
  goons = [goon, ...goons.filter((s) => s.id !== goon.id)]
}

export function updateGoon(id: string, updates: Partial<GoonRecord>) {
  goons = goons.map((s) => (s.id === id ? { ...s, ...updates } : s))
}

export function replaceGoon(id: string, goon: GoonRecord) {
  goons = goons.map((entry) => (entry.id === id ? goon : entry))
}

export function removeGoon(id: string) {
  goons = goons.filter((s) => s.id !== id)
}

export function setGoonsLoading(value: boolean) {
  loading = value
}

export function setGoonsError(value: string | null) {
  error = value
}
