import { afterEach, beforeEach } from 'vitest'
import { redis } from '$lib/server/redis'

/** Opt-in semantic twin for one fixed two-key publication; never a generic Lua engine. */
export function useAppActionsSkillPublicationTwin(): void {
  if (process.env.VITEST_USE_REAL_REDIS === 'true') return
  let restore: (() => void) | undefined
  beforeEach(() => {
    const original = redis.execute
    ;(redis as any).execute = (operation: (client: any) => unknown) => original.call(redis, async (client: any) => operation(new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === 'eval') return async (script: string, options: { keys: string[]; arguments: string[] }) => {
          if (script.startsWith('\n-- BATSHIT_APP_ACTIONS_SKILL_PUBLICATION_V1\n')) {
            const { keys, arguments: args } = options
            const value = JSON.parse(args[2])
            if (keys.length !== 2 || args.length !== 3 || value?.id !== 'app_actions' || typeof value.user_id !== 'string' ||
                keys[0] !== `skill:${value.user_id}:app_actions` || keys[1] !== `slash_command:${value.user_id}:app-actions`) return 'INVALID'
            for (let index = 0; index < 2; index++) {
              const kind = await client.type(keys[index])
              if (kind !== 'none' && kind !== 'ReJSON-RL') return 'CHANGED'
              if (((await client.json.getRaw(keys[index], '$')) ?? '') !== args[index]) return 'CHANGED'
            }
            return await client.json.set(keys[0], '$', value) === 'OK' ? 'APPLIED' : 'UNCONFIRMED'
          }
          if (typeof client.eval !== 'function') throw new Error('The App Actions twin does not implement another owner\'s script.')
          return client.eval(script, options)
        }
        const value = Reflect.get(client, property, client)
        return typeof value === 'function' ? value.bind(client) : value
      }
    })))
    restore = () => { (redis as any).execute = original }
  })
  afterEach(() => { restore?.(); restore = undefined })
}
