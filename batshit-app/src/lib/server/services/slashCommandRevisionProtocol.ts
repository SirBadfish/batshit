import { randomBytes } from 'node:crypto'
import { assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'

declare const preparationBrand: unique symbol
export type SlashCommandWritePreparation = Readonly<{ [preparationBrand]: true }>
type PreparationState = {
  userId: string; lifecycle: SettingsLifecycleSnapshot; revision: string | null | undefined
  poisoned: boolean; busy: boolean
}
const preparations = new WeakMap<SlashCommandWritePreparation, PreparationState>()

/** Actual logical writer entry, synchronously before its first await. No Redis facade. */
export function beginSlashCommandWrite(userId: string): SlashCommandWritePreparation {
  slashCommandRevisionKey(userId)
  const preparation = Object.freeze({}) as SlashCommandWritePreparation
  let lifecycle: SettingsLifecycleSnapshot
  try { lifecycle = captureSettingsLifecycle([]) }
  catch { throw new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'Settings are being replaced or an earlier write is still settling. Reload before another change.', 'not_written') }
  preparations.set(preparation, { userId, lifecycle, revision: undefined, poisoned: false, busy: false })
  return preparation
}

/** Server-private state shared only with the fixed command/source write owner. */
export function slashCommandPreparationState(preparation: SlashCommandWritePreparation, userId?: string) {
  const state = preparations.get(preparation)
  if (!state || (userId !== undefined && state.userId !== userId) || state.poisoned) {
    throw new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'This command preparation is no longer current. Reload before another change.', 'not_written')
  }
  try { assertSettingsLifecycle(state.lifecycle) }
  catch { throw new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'Settings changed during preparation. Reload before another change.', 'not_written') }
  return state
}

/** Final physical deletion receives only this preparation's confirmed catalogue chain. */
export function currentSlashCommandWriteRevision(preparation: SlashCommandWritePreparation): string | null {
  const state = slashCommandPreparationState(preparation)
  if (state.busy || state.revision === undefined) {
    throw new SlashCommandMutationError('SLASH_COMMAND_CONFLICT', 'The cleanup catalogue was not captured or is still settling. Reload before another change.', 'not_written')
  }
  return state.revision
}

export type SlashCommandWriteOutcome = 'not_written' | 'unknown' | 'saved_readback_unavailable'
export class SlashCommandMutationError extends Error {
  constructor(readonly code: 'SLASH_COMMAND_CONFLICT' | 'SLASH_COMMAND_INVALID' | 'SLASH_COMMAND_UNCONFIRMED' | 'SLASH_COMMAND_SAVED_READBACK_UNAVAILABLE',
    message: string, readonly outcome: SlashCommandWriteOutcome, readonly status = outcome === 'not_written' ? 409 : 503) {
    super(message); this.name = 'SlashCommandMutationError'
  }
}
export function isSlashCommandMutationError(value: unknown): value is SlashCommandMutationError {
  return value instanceof SlashCommandMutationError
}

/** Concurrency metadata only: never portable permission/backup data. */
export function slashCommandRevisionKey(userId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Invalid command owner.')
  return `slash_command_revision:${userId}`
}
export const newSlashCommandRevision = () => randomBytes(32).toString('hex')

/** No writes/imported Redis facade: safe for existing Redis script owners. */
export const SLASH_COMMAND_REVISION_LUA = `
local function command_revision(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return '' end
  if kind ~= 'string' then return nil end
  local value = redis.call('GET', key)
  if #value ~= 64 or string.find(value, '[^a-f0-9]') then return nil end
  return value
end
local function valid_command_nonce(value)
  return type(value) == 'string' and #value == 64 and not string.find(value, '[^a-f0-9]')
end
`
