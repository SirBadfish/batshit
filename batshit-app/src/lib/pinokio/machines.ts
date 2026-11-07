/** Saved Pinokio addresses are user-selected trusted-LAN configuration, not physical-peer authentication. */
export const LOCAL_PINOKIO_MACHINE_ID = 'local'

export interface PinokioMachineSelector {
  machineId: string
  revision: number
}

export interface PinokioRemoteMachine {
  id: string
  label: string
  controlHost: string
  controlPort: number
  controlProtocol: 'http' | 'https'
  /** Optimistic edit version; changing a label advances this but leaves target identity alone. */
  version: number
  /** Target identity: advances only when the endpoint or confirmed binding changes. */
  revision: number
  bindingState: 'confirmed' | 'needs_confirmation'
}

export interface PinokioMachineRegistry {
  schemaVersion: 1
  machines: PinokioRemoteMachine[]
}

export const LOCAL_PINOKIO_MACHINE = Object.freeze({
  id: LOCAL_PINOKIO_MACHINE_ID,
  label: 'This computer',
  revision: 0,
  version: 0,
  bindingState: 'confirmed' as const
})

export type PinokioMachine = typeof LOCAL_PINOKIO_MACHINE | PinokioRemoteMachine

export function isPinokioRemoteMachineId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

export function isPinokioRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isPinokioControlPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isPinokioRemoteMachine(value: unknown): value is PinokioRemoteMachine {
  if (!record(value)) return false
  const keys = ['id', 'label', 'controlHost', 'controlPort', 'controlProtocol', 'version', 'revision', 'bindingState']
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) &&
    isPinokioRemoteMachineId(value.id) && typeof value.label === 'string' && value.label === value.label.trim() &&
    value.label.length > 0 && value.label.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value.label) &&
    isPinokioControlHost(value.controlHost) && isPinokioControlPort(value.controlPort) &&
    (value.controlProtocol === 'http' || value.controlProtocol === 'https') &&
    isPinokioRevision(value.version) && isPinokioRevision(value.revision) && value.revision <= value.version &&
    (value.bindingState === 'confirmed' || value.bindingState === 'needs_confirmation')
}

/** Validate the complete successful GET response before a settings form enables writes. */
export function isPinokioMachineList(value: unknown): value is PinokioMachine[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const local = value[0]
  if (!record(local) || Object.keys(local).length !== Object.keys(LOCAL_PINOKIO_MACHINE).length ||
    Object.entries(LOCAL_PINOKIO_MACHINE).some(([key, expected]) => local[key] !== expected)) return false
  const ids = new Set<string>()
  return value.slice(1).every((machine) => {
    if (!isPinokioRemoteMachine(machine) || ids.has(machine.id)) return false
    ids.add(machine.id)
    return true
  })
}

/** RFC1918 literal IPv4 only. No DNS, URL parsing, loopback, implicit port or public endpoint. */
export function isPinokioControlHost(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return false
  const parts = value.split('.').map(Number)
  if (parts.some((part) => part > 255)) return false
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
}

/** Saved Artifacts keep stable identity only; revisions belong to request/approval state. */
export function readPinokioMachineSelector(metadata: Record<string, unknown>): { machineId: string } | null {
  // The preparatory revision-pair form was never admitted as saved remote user data.
  if (Object.hasOwn(metadata, 'pinokio_machine_revision')) return null
  if (!Object.hasOwn(metadata, 'pinokio_machine_id')) return { machineId: LOCAL_PINOKIO_MACHINE_ID }
  const id = metadata.pinokio_machine_id
  return id === LOCAL_PINOKIO_MACHINE_ID || isPinokioRemoteMachineId(id) ? { machineId: id } : null
}

/** Collision-free cache/plan identity; the label and record edit version are not authority. */
export function pinokioTargetKey(userId: string, target: PinokioMachineSelector & { appId: string }): string {
  return JSON.stringify([userId, target.machineId, target.revision, target.appId])
}
