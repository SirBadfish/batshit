/** Fixed first-release Memory choices. Runtime normalization remains in memoryControl. */
export const MEMORY_WINDOW_MODE_PATHS = [
  '$.memory_window.floor_mode', '$.memory_window.ceiling_headroom_mode',
  '$.memoryWindow.floor_mode', '$.memoryWindow.ceiling_headroom_mode'
] as const
export type MemoryWindowParents = readonly [string, string]
export function memoryWindowModes(parents: MemoryWindowParents, modes: readonly unknown[]) {
  const canonical = parents[0] !== '' && parents[0] !== 'null'
  const parent = canonical ? parents[0] : parents[1]
  if (parent !== '' && parent !== 'null' && parent !== 'object') throw new Error('invalid_memory_window_container')
  const active = canonical ? 0 : 2
  const values = [modes[active], modes[active + 1]]
  if (values.some(value => value !== undefined && value !== null && value !== 'auto' && value !== 'custom')) throw new Error('invalid_memory_window_mode')
  const [floorMode, ceilingHeadroomMode] = values.map(value => value === 'custom' ? 'custom' as const : 'auto' as const)
  return { floorMode, ceilingHeadroomMode, windowMode: floorMode === ceilingHeadroomMode ? floorMode : 'mixed' as const,
    root: canonical ? '$.memory_window' as const : parent === 'object' ? '$.memoryWindow' as const : '$.memory_window' as const }
}
