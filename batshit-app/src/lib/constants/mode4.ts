export type Mode4Style = 'cr' | 'cli'

export const MODE4_PRELAUNCH_STYLE: Mode4Style = 'cr'

export function resolveMode4MemoryOwner(style: Mode4Style): 'batshit' | 'provider' {
  return style === 'cli' ? 'provider' : 'batshit'
}
