import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { LOCAL_PINOKIO_MACHINE, isPinokioMachineList, pinokioTargetKey, readPinokioMachineSelector } from '$lib/pinokio/machines'
import { pinokioMachineService as service, pinokioMachinesKey, restoredPinokioMachineRegistry } from '../pinokioMachineService'

// Lane-aware: the existing CAS twin by default; actual RedisJSON/Lua with test:redis.
useRedisTestServer()
// The default lane primitives are already vi.fn wrappers. Capture their implementations,
// not the mutable wrapper itself, when interleaving a second real service write.
const originalCas = vi.isMockFunction(redis.json.setIfUnchanged) ? redis.json.setIfUnchanged.getMockImplementation()! : redis.json.setIfUnchanged
const originalRead = vi.isMockFunction(redis.json.getRaw) ? redis.json.getRaw.getMockImplementation()! : redis.json.getRaw
function restoreStorageMocks() {
  vi.restoreAllMocks()
  if (vi.isMockFunction(redis.json.setIfUnchanged)) redis.json.setIfUnchanged.mockReset().mockImplementation(originalCas)
  if (vi.isMockFunction(redis.json.getRaw)) redis.json.getRaw.mockReset().mockImplementation(originalRead)
}
beforeEach(restoreStorageMocks)
afterEach(restoreStorageMocks)
const USER = 'pinokio_machine_owner'
const KEY = pinokioMachinesKey(USER)
const connection = (label = 'PC', controlHost = '192.168.1.85') => ({ label, controlHost, controlPort: 42000 })

function interleaveOnce(action: () => Promise<unknown>) {
  let armed = true
  return vi.spyOn(redis.json, 'setIfUnchanged').mockImplementation(async (...args) => {
    if (armed) { armed = false; await action() }
    return originalCas(...args)
  })
}

describe('saved Pinokio computers', () => {
  it('keeps an immutable synthetic local default and writes no registry on a read', async () => {
    expect(await service.list(USER)).toEqual([LOCAL_PINOKIO_MACHINE])
    expect(await service.resolve(USER)).toMatchObject({ id: 'local', kind: 'local', revision: 0 })
    expect(await redis.json.getRaw(KEY, '$')).toBeNull()
    await expect(service.update(USER, 'local', { expectedVersion: 0, label: 'Other' })).rejects.toMatchObject({ code: 'pinokio_machine_local_immutable' })
    await expect(service.remove(USER, 'local', 0)).rejects.toMatchObject({ code: 'pinokio_machine_local_immutable' })
  })

  it('resolves the selected remote independently of any local Pinokio installation or daemon', async () => {
    const machine = await service.create(USER, connection())
    expect(machine).toMatchObject({ ...connection(), version: 1, revision: 1, bindingState: 'confirmed' })
    expect(await service.resolve(USER, { machineId: machine.id, revision: 1 })).toMatchObject({ id: machine.id, kind: 'remote', controlHost: '192.168.1.85' })
    await expect(service.resolve('another-user', { machineId: machine.id, revision: 1 })).rejects.toMatchObject({ code: 'pinokio_machine_missing' })
  })

  it('resolves current read targets with one owned read and never defaults explicit invalid or missing computers', async () => {
    const machine = await service.create(USER, connection())
    const read = vi.spyOn(redis.json, 'getRaw')
    read.mockClear()
    expect(await service.resolveCurrent(USER, machine.id)).toMatchObject({ id: machine.id, kind: 'remote', revision: 1 })
    expect(read).toHaveBeenCalledTimes(1)
    read.mockClear()
    expect(await service.resolveCurrent(USER)).toMatchObject({ id: 'local', kind: 'local', revision: 0 })
    expect(await service.resolveCurrent(USER, 'local')).toMatchObject({ id: 'local', kind: 'local' })
    expect(read).not.toHaveBeenCalled()
    for (const id of [null, '', 'missing']) await expect(service.resolveCurrent(USER, id as any)).rejects.toMatchObject({ status: 400 })
    await expect(service.resolveCurrent('other-user', machine.id)).rejects.toMatchObject({ status: 404 })
    await redis.json.set(KEY, '$', restoredPinokioMachineRegistry({ schemaVersion: 1, machines: [machine] }))
    await expect(service.resolveCurrent(USER, machine.id)).rejects.toMatchObject({ code: 'pinokio_machine_confirmation_required' })
  })

  it('names the same app on different machines as different targets without using labels as authority', async () => {
    const a = await service.create(USER, connection('Same name'))
    const b = await service.create(USER, connection('Same name', '192.168.1.86'))
    const key = (machineId: string) => pinokioTargetKey(USER, { machineId, revision: 1, appId: 'comfy.git' })
    expect(key(a.id)).not.toBe(key(b.id))
    expect(key(a.id)).not.toBe(pinokioTargetKey('other', { machineId: a.id, revision: 1, appId: 'comfy.git' }))
  })

  it('rejects public, loopback, hostnames, paths, URL credentials and malformed control inputs before writing', async () => {
    for (const controlHost of ['127.0.0.1', 'localhost', 'pc.local', '8.8.8.8', '169.254.1.1', '192.168.001.1', 'http://192.168.1.85', 'user@192.168.1.85', '192.168.1.85:42000', '::1', '192.168.1.999']) {
      await expect(service.create(USER, { ...connection(), controlHost })).rejects.toMatchObject({ status: 400 })
    }
    for (const controlPort of [0, 65536, 42.5, '42000', null]) {
      await expect(service.create(USER, { ...connection(), controlPort })).rejects.toMatchObject({ status: 400 })
    }
    await expect(service.create(USER, { ...connection(), userId: 'other' })).rejects.toMatchObject({ status: 400 })
    expect(await redis.json.getRaw(KEY, '$')).toBeNull()
  })

  it('changes edit version for a label, preserves target revision, and refuses stale same-machine saves', async () => {
    const machine = await service.create(USER, connection())
    const renamed = await service.update(USER, machine.id, { expectedVersion: 1, label: 'Gaming PC' })
    expect(renamed).toMatchObject({ version: 2, revision: 1, label: 'Gaming PC' })
    expect(await service.resolve(USER, { machineId: machine.id, revision: 1 })).toMatchObject({ label: 'Gaming PC' })
    await expect(service.update(USER, machine.id, { expectedVersion: 1, label: 'Stale' })).rejects.toMatchObject({ status: 409 })
    const rebound = await service.update(USER, machine.id, { expectedVersion: 2, controlHost: '192.168.1.86' })
    expect(rebound).toMatchObject({ version: 3, revision: 2, label: 'Gaming PC' })
    await expect(service.resolve(USER, { machineId: machine.id, revision: 1 })).rejects.toMatchObject({ code: 'pinokio_machine_changed' })
    expect(await service.update(USER, machine.id, { expectedVersion: 3, label: 'Gaming PC' })).toEqual(rebound)
    const tls = await service.update(USER, machine.id, { expectedVersion: 3, controlProtocol: 'https' })
    expect(tls).toMatchObject({ version: 4, revision: 3, controlProtocol: 'https', controlHost: '192.168.1.86', controlPort: 42000 })
    await expect(service.create(USER, { ...connection(), controlProtocol: 'ftp' })).rejects.toMatchObject({ status: 400 })
  })

  it('retains another machine’s interleaved save and refuses an interleaved edit to the same machine', async () => {
    const a = await service.create(USER, connection('A'))
    const b = await service.create(USER, connection('B', '192.168.1.86'))
    interleaveOnce(() => service.update(USER, b.id, { expectedVersion: 1, label: 'New B' }))
    await service.update(USER, a.id, { expectedVersion: 1, label: 'New A' })
    expect(await service.list(USER)).toEqual([LOCAL_PINOKIO_MACHINE, expect.objectContaining({ label: 'New A' }), expect.objectContaining({ label: 'New B' })])
    restoreStorageMocks()
    interleaveOnce(() => service.update(USER, a.id, { expectedVersion: 2, controlPort: 42001 }))
    await expect(service.update(USER, a.id, { expectedVersion: 2, label: 'Stale A' })).rejects.toMatchObject({ status: 409 })
    expect((await service.list(USER))[1]).toMatchObject({ label: 'New A', controlPort: 42001, revision: 2 })
  })

  it('bounds CAS conflicts and never pretends a failed read or corrupt registry is empty', async () => {
    vi.spyOn(redis.json, 'setIfUnchanged').mockResolvedValue(false)
    await expect(service.create(USER, connection())).rejects.toMatchObject({ status: 409 })
    expect(redis.json.setIfUnchanged).toHaveBeenCalledTimes(3)
    restoreStorageMocks()
    await redis.json.set(KEY, '$', { schemaVersion: 1, machines: [{ id: 'local' }] })
    const before = await redis.json.getRaw(KEY, '$')
    await expect(service.list(USER)).rejects.toMatchObject({ code: 'pinokio_machine_registry_invalid' })
    await expect(service.create(USER, connection())).rejects.toMatchObject({ code: 'pinokio_machine_registry_invalid' })
    expect(await redis.json.getRaw(KEY, '$')).toBe(before)
    vi.spyOn(redis.json, 'getRaw').mockRejectedValue(new Error('storage unavailable'))
    await expect(service.create(USER, connection())).rejects.toThrow('storage unavailable')
  })

  it('removes only the selected connection and leaves a previously saved artifact unresolved', async () => {
    const a = await service.create(USER, connection('A'))
    const b = await service.create(USER, connection('B'))
    const artifact = { metadata: { pinokio_machine_id: a.id, pinokio_app_id: 'comfy.git' } }
    await redis.json.set('artifact:pinokio_fixture', '$', artifact)
    await expect(service.remove(USER, a.id, 2)).rejects.toMatchObject({ status: 409 })
    await service.remove(USER, a.id, 1)
    expect(await service.list(USER)).toEqual([LOCAL_PINOKIO_MACHINE, b])
    expect(await redis.json.get('artifact:pinokio_fixture')).toEqual(artifact)
    await expect(service.resolve(USER, { machineId: a.id, revision: 1 })).rejects.toMatchObject({ code: 'pinokio_machine_missing' })
  })

  it('keeps restored configuration inactive through label edits until explicit reconnect', async () => {
    const machine = await service.create(USER, connection())
    const restored = restoredPinokioMachineRegistry({ schemaVersion: 1, machines: [machine] })
    expect(restored.machines[0]).toMatchObject({ ...machine, bindingState: 'needs_confirmation' })
    await redis.json.set(KEY, '$', restored)
    await service.update(USER, machine.id, { expectedVersion: 1, label: 'Restored PC' })
    await expect(service.resolve(USER, { machineId: machine.id, revision: 1 })).rejects.toMatchObject({ code: 'pinokio_machine_confirmation_required' })
    const confirmed = await service.update(USER, machine.id, { expectedVersion: 2, reconnect: true })
    expect(confirmed).toMatchObject({ version: 3, revision: 2, bindingState: 'confirmed' })
    await expect(service.resolve(USER, { machineId: machine.id, revision: 1 })).rejects.toMatchObject({ code: 'pinokio_machine_changed' })
    expect(await service.resolve(USER, { machineId: machine.id, revision: 2 })).toMatchObject({ kind: 'remote' })
  })

  it('validates complete successful list responses and never defaults explicit invalid selectors to local', async () => {
    const machine = await service.create(USER, connection())
    expect(isPinokioMachineList(await service.list(USER))).toBe(true)
    for (const value of [[], [machine], [LOCAL_PINOKIO_MACHINE, machine, machine], [LOCAL_PINOKIO_MACHINE, { ...machine, controlHost: '8.8.8.8' }]]) expect(isPinokioMachineList(value)).toBe(false)
    expect(readPinokioMachineSelector({})).toEqual({ machineId: 'local' })
    expect(readPinokioMachineSelector({ pinokio_machine_id: machine.id })).toEqual({ machineId: machine.id })
    expect(readPinokioMachineSelector({ pinokio_machine_id: machine.id, pinokio_machine_revision: 1 })).toBeNull()
    for (const metadata of [{ pinokio_machine_id: null }, { pinokio_machine_id: '' }, { pinokio_machine_revision: 1 }, { pinokio_machine_id: 'local', pinokio_machine_revision: 1 }]) expect(readPinokioMachineSelector(metadata)).toBeNull()
    for (const selector of [null, { machineId: '', revision: 1 }, { machineId: 'local', revision: 1 }]) await expect(service.resolve(USER, selector as any)).rejects.toMatchObject({ status: 400 })
  })
})
