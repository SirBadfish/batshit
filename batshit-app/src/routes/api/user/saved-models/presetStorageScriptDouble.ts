import { beforeEach, vi } from 'vitest'

/** Adapts this directory's existing object-only Redis doubles, retaining their
 * facade spies/race hooks. Exact wire text and atomicity are qualified on real Redis. */
beforeEach(async () => {
  const { redis } = await import('$lib/server/redis')
  const { MUTATE_MODEL_PRESET_SCRIPT, READ_MODEL_PRESET_SCRIPT, READ_MODEL_PRESET_CHOICES_SCRIPT } = await import('$lib/server/services/modelPresetSelectionOwner')
  const original = typeof redis.execute === 'function' ? vi.isMockFunction(redis.execute) ? vi.mocked(redis.execute).getMockImplementation() : redis.execute.bind(redis) : null
  const execute = async (operation: (client: any) => Promise<any>) => {
    const apply = async (client: any = {}) => operation({ ...client, eval: async (script: string, command: { keys: string[]; arguments: string[] }) => {
      if (script === READ_MODEL_PRESET_CHOICES_SCRIPT) {
        const ids = (await redis.sMembers(command.keys[0])).sort(); return [ids.length, ids.length, ids.slice(Number(command.arguments[1]), Number(command.arguments[1]) + Number(command.arguments[2]))]
      }
      if (script !== READ_MODEL_PRESET_SCRIPT && script !== MUTATE_MODEL_PRESET_SCRIPT) {
        if (!client.eval) throw new Error('This route double does not admit that Lua script.')
        return client.eval(script, command)
      }
      const [key, index] = command.keys
      const [id, expected, mode, encoded] = command.arguments
      const present = typeof redis.sismember === 'function' ? Boolean(await redis.sismember(index, id)) : (await redis.sMembers(index)).includes(id)
      const record = await redis.get(key)
      const raw = record == null ? '' : JSON.stringify([record])
      if (record && record.id !== id) return script === READ_MODEL_PRESET_SCRIPT ? ['INVALID_RECORD'] : 'INVALID_RECORD'
      if (script === READ_MODEL_PRESET_SCRIPT) return expected && Buffer.byteLength(raw, 'utf8') > Number(expected) ? ['TOO_LARGE'] : ['OK', present ? '1' : '0', raw]
      if (command.arguments[5]) throw new Error('Conditional copy Lua is qualified by its real Redis owner, not this human-route double.')
      if (mode === 'create' && (raw || present)) return 'EXISTS'
      if (mode !== 'create' && (!present || !raw)) return 'MISSING'
      if (raw !== expected) return 'CONFLICT'
      if (mode === 'delete') { await redis.sRem(index, id); await redis.del(key); return 'DELETED' }
      const stored = JSON.parse(encoded)
      const saved = mode === 'create' ? await redis.json.setIfAbsent(key, '$', stored) : await redis.json.setIfExists(key, '$', stored)
      if (!saved) return mode === 'create' ? 'EXISTS' : 'MISSING'
      if (mode === 'create') await redis.sAdd(index, id)
      return 'SAVED'
    } })
    return original ? original(apply) : apply()
  }
  if (original) vi.spyOn(redis, 'execute').mockImplementation(execute as any)
  else Object.assign(redis, { execute: vi.fn(execute) })
})
