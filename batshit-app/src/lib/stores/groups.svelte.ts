import type { GroupChatGroupRow } from '$lib/types/database'

export type Group = GroupChatGroupRow

let groups = $state<Group[]>([])

export function getGroups() {
  return groups
}

export function setGroups(newGroups: Group[]) {
  groups = newGroups
}

export function addGroup(group: Group) {
  groups = [group, ...groups]
}

export function updateGroup(id: string, updates: Partial<Group>) {
  groups = groups.map((group) =>
    group.id === id ? { ...group, ...updates } : group
  )
}

export function deleteGroup(id: string) {
  groups = groups.filter((group) => group.id !== id)
}

export function getGroupById(id: string | null | undefined) {
  if (!id) return null
  return groups.find((group) => group.id === id) || null
}
