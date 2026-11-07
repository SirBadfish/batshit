import { randomUUID } from 'node:crypto'
import { redis } from '$lib/server/redis'
import {
  LOCAL_PINOKIO_MACHINE,
  LOCAL_PINOKIO_MACHINE_ID,
  isPinokioControlHost,
  isPinokioControlPort,
  isPinokioRemoteMachineId,
  isPinokioRemoteMachine,
  isPinokioRevision,
  type PinokioMachineRegistry,
  type PinokioMachineSelector,
  type PinokioRemoteMachine
} from '$lib/pinokio/machines'

export class PinokioMachineError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = 'PinokioMachineError'
  }
}

function invalid(message: string): never {
  throw new PinokioMachineError('pinokio_machine_invalid', message)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid('The Pinokio connection contains unsupported fields.')
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid('Give the Pinokio computer a name of 1 to 100 characters.')
  }
  return value.trim()
}

function port(value: unknown): number {
  if (!isPinokioControlPort(value)) invalid('The Pinokio control port must be a whole number from 1 to 65535.')
  return value
}

function host(value: unknown): string {
  if (!isPinokioControlHost(value)) invalid('Choose the Pinokio computer’s private IPv4 LAN address, without a URL, hostname or port.')
  return value
}

function protocol(value: unknown): 'http' | 'https' {
  if (value !== 'http' && value !== 'https') invalid('The Pinokio connection protocol must be http or https.')
  return value
}

function advance(value: number): number {
  if (!Number.isSafeInteger(value + 1)) invalid('This Pinokio connection’s version cannot be advanced. Remove it and connect again.')
  return value + 1
}

/** Strict read: a failed/malformed registry must never be replaced as an empty registry. */
export function parsePinokioMachineRegistry(value: unknown): PinokioMachineRegistry {
  try {
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.machines)) invalid('Invalid registry.')
    onlyKeys(value, ['schemaVersion', 'machines'])
    const ids = new Set<string>()
    for (const machine of value.machines) {
      if (!isPinokioRemoteMachine(machine) || ids.has(machine.id)) invalid('Invalid or duplicate connection.')
      ids.add(machine.id)
    }
    return value as unknown as PinokioMachineRegistry
  } catch {
    throw new PinokioMachineError('pinokio_machine_registry_invalid', 'Batshit could not read the saved Pinokio connections. Retry before changing them.', 500)
  }
}

/** Restore is configuration only: preserve IDs/endpoints, require an explicit reconnect. */
export function restoredPinokioMachineRegistry(value: unknown): PinokioMachineRegistry {
  const registry = parsePinokioMachineRegistry(value)
  return { schemaVersion: 1, machines: registry.machines.map((machine) => ({ ...machine, bindingState: 'needs_confirmation' })) }
}

export function pinokioMachinesKey(userId: string): string {
  if (!userId) invalid('A signed-in user is required.')
  return `pinokio_machines:${userId}`
}

async function readRegistry(userId: string) {
  const raw = await redis.json.getRaw(pinokioMachinesKey(userId), '$')
  if (raw === null) return { raw: '', registry: { schemaVersion: 1, machines: [] } as PinokioMachineRegistry }
  let value: unknown
  try {
    const reply: unknown = JSON.parse(raw)
    if (!Array.isArray(reply) || reply.length !== 1) throw new Error('Unexpected RedisJSON root.')
    value = reply[0]
  } catch {
    throw new PinokioMachineError('pinokio_machine_registry_invalid', 'Batshit could not read the saved Pinokio connections. Retry before changing them.', 500)
  }
  return { raw, registry: parsePinokioMachineRegistry(value) }
}

function editableId(id: string) {
  if (id === LOCAL_PINOKIO_MACHINE_ID) throw new PinokioMachineError('pinokio_machine_local_immutable', 'This computer is the built-in local connection and cannot be changed.')
  if (!isPinokioRemoteMachineId(id)) invalid('Choose a saved Pinokio computer.')
}

function currentMachine(registry: PinokioMachineRegistry, id: string, expectedVersion: unknown) {
  editableId(id)
  if (!isPinokioRevision(expectedVersion)) invalid('The connection’s current version is required.')
  const machine = registry.machines.find((entry) => entry.id === id)
  if (!machine) throw new PinokioMachineError('pinokio_machine_missing', 'This Pinokio connection was removed. Choose a saved computer.', 404)
  if (machine.version !== expectedVersion) throw new PinokioMachineError('pinokio_machine_changed', 'This Pinokio connection changed. Reload it before saving again.', 409)
  return machine
}

async function mutate<T>(userId: string, change: (registry: PinokioMachineRegistry) => { registry: PinokioMachineRegistry; result: T; unchanged?: boolean }): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { raw, registry } = await readRegistry(userId)
    const next = change(registry)
    if (next.unchanged || await redis.json.setIfUnchanged(pinokioMachinesKey(userId), '$', raw, next.registry)) return next.result
  }
  throw new PinokioMachineError('pinokio_machine_changed', 'The saved Pinokio connections changed. Reload them before saving again.', 409)
}

async function resolveRemote(userId: string, machineId: string, expectedRevision?: number) {
  if (!isPinokioRemoteMachineId(machineId)) invalid('Choose a saved Pinokio computer.')
  const { registry } = await readRegistry(userId)
  const machine = registry.machines.find((entry) => entry.id === machineId)
  if (!machine) throw new PinokioMachineError('pinokio_machine_missing', 'This Pinokio connection is missing. Choose a saved computer.', 404)
  if (machine.bindingState !== 'confirmed') throw new PinokioMachineError('pinokio_machine_confirmation_required', 'Reconnect this restored Pinokio computer before using its apps.', 409)
  if (expectedRevision !== undefined && machine.revision !== expectedRevision) throw new PinokioMachineError('pinokio_machine_changed', 'This Pinokio computer’s address changed. Choose it again before using the app.', 409)
  return { ...machine, kind: 'remote' as const }
}

export const pinokioMachineService = {
  async list(userId: string) {
    const { registry } = await readRegistry(userId)
    return [LOCAL_PINOKIO_MACHINE, ...registry.machines]
  },

  async create(userId: string, input: unknown): Promise<PinokioRemoteMachine> {
    if (!record(input)) invalid('Send a Pinokio computer name, address and control port.')
    onlyKeys(input, ['label', 'controlHost', 'controlPort', 'controlProtocol'])
    const machine: PinokioRemoteMachine = {
      id: randomUUID(), label: label(input.label), controlHost: host(input.controlHost), controlPort: port(input.controlPort),
      controlProtocol: input.controlProtocol === undefined ? 'http' : protocol(input.controlProtocol),
      version: 1, revision: 1, bindingState: 'confirmed'
    }
    return mutate(userId, (registry) => ({ registry: { ...registry, machines: [...registry.machines, machine] }, result: machine }))
  },

  async update(userId: string, id: string, input: unknown): Promise<PinokioRemoteMachine> {
    if (!record(input)) invalid('Send the changed Pinokio connection fields and expectedVersion.')
    onlyKeys(input, ['label', 'controlHost', 'controlPort', 'controlProtocol', 'expectedVersion', 'reconnect'])
    if ('reconnect' in input && input.reconnect !== true) invalid('Reconnect must be true when supplied.')
    const changes = {
      ...('label' in input ? { label: label(input.label) } : {}),
      ...('controlHost' in input ? { controlHost: host(input.controlHost) } : {}),
      ...('controlPort' in input ? { controlPort: port(input.controlPort) } : {}),
      ...('controlProtocol' in input ? { controlProtocol: protocol(input.controlProtocol) } : {})
    }
    return mutate(userId, (registry) => {
      const previous = currentMachine(registry, id, input.expectedVersion)
      const endpointChanged = ('controlHost' in changes && changes.controlHost !== previous.controlHost) || ('controlPort' in changes && changes.controlPort !== previous.controlPort) || ('controlProtocol' in changes && changes.controlProtocol !== previous.controlProtocol)
      const bindingChanged = endpointChanged || (input.reconnect === true && previous.bindingState !== 'confirmed')
      const changed = bindingChanged || ('label' in changes && changes.label !== previous.label)
      if (!changed) return { registry, result: previous, unchanged: true }
      const machine: PinokioRemoteMachine = {
        ...previous, ...changes, version: advance(previous.version),
        revision: bindingChanged ? advance(previous.revision) : previous.revision,
        bindingState: bindingChanged ? 'confirmed' : previous.bindingState
      }
      return { registry: { ...registry, machines: registry.machines.map((entry) => entry.id === id ? machine : entry) }, result: machine }
    })
  },

  async remove(userId: string, id: string, expectedVersion: unknown): Promise<void> {
    await mutate(userId, (registry) => {
      currentMachine(registry, id, expectedVersion)
      return { registry: { ...registry, machines: registry.machines.filter((entry) => entry.id !== id) }, result: undefined }
    })
  },

  /** Initial read-only targeting obtains the current revision from one owned registry read. */
  async resolveCurrent(userId: string, machineId?: string) {
    pinokioMachinesKey(userId)
    if (machineId === undefined || machineId === LOCAL_PINOKIO_MACHINE_ID) return { ...LOCAL_PINOKIO_MACHINE, kind: 'local' as const }
    return resolveRemote(userId, machineId)
  },

  /** No pterm or local Pinokio readiness read: remote targets resolve from their own owner. */
  async resolve(userId: string, selector?: PinokioMachineSelector) {
    pinokioMachinesKey(userId)
    if (selector === undefined || (selector && selector.machineId === LOCAL_PINOKIO_MACHINE_ID && selector.revision === 0)) {
      return { ...LOCAL_PINOKIO_MACHINE, kind: 'local' as const }
    }
    if (!selector || !isPinokioRemoteMachineId(selector.machineId) || !isPinokioRevision(selector.revision)) invalid('Choose a saved Pinokio computer and its target revision.')
    return resolveRemote(userId, selector.machineId, selector.revision)
  }
}
