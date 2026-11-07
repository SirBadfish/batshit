import { canonicalSkillAccessId } from './slashCommandCapabilities'
import { captureSkillReadChoice, assertSkillReadChoice, type SkillReadChoice, type SkillSessionActor } from './skillSessions'
import { isToolModelCutView } from '$lib/utils/toolModelTextSizeGuard'
import { withZipStateLock } from './zipStateLock'
import type { ZipReference } from '$lib/server/zipService'

/** Only the actual Primary native callback receives this in-process capability. */
export interface SkillReadDelivery {
  owns(output: unknown): boolean
  hasReads(): boolean
  execute(input: Record<string, any>, run: () => Promise<Record<string, any>>): Promise<Record<string, any>>
  delivered(input: { toolName: string; toolCallId: string; input: unknown; output: unknown;
    before: unknown; after: unknown }): Promise<void>
}
type Pending = { choice: SkillReadChoice; skillId: string; result: Record<string, any>; admitted?: Promise<void> }

/** No serialized flag or matching tool name can mint a native read receipt. */
export function createSkillReadDelivery(input: {
  actor: SkillSessionActor
  messageId: string
  signal?: AbortSignal
  previewContext?: (skillId: string, result: Record<string, any>) => Promise<unknown>
  persist: (step: Record<string, any>, beforePersist: () => Promise<void>) => Promise<ZipReference[]>
}): SkillReadDelivery {
  const pending = new WeakMap<object, Pending>()
  let admitted = false
  const check = () => input.signal?.throwIfAborted()
  const find = (output: unknown): Pending | undefined => {
    if (!output || typeof output !== 'object') return undefined
    const own = pending.get(output)
    if (own) return own
    // This exact child object was minted by our native callback. Re-parsed or forged JSON
    // has no WeakMap identity. The API utility broker's original envelope keeps the object.
    return pending.get((output as any).result)
  }
  return {
    owns: output => Boolean(find(output)),
    hasReads: () => admitted,
    async execute(args, run) {
      const action = args.action ?? 'invoke'
      if (!['invoke', 'read', 'script_read'].includes(action)) return run()
      check()
      const skillId = canonicalSkillAccessId(args.skillId)
      const choice = await captureSkillReadChoice(input.actor, skillId, input.messageId)
      const result = await run()
      check()
      if (result?.success === true && !result.error && !result.blocked &&
          ['invoke', 'read', 'script_read'].includes(result.action)) {
        pending.set(result, { choice, skillId, result })
      }
      return result
    },
    async delivered(delivery) {
      const read = find(delivery.output)
      if (!read) return
      check()
      // The final model guard is authoritative. A cut or changed view cannot certify the
      // original skill window; no original bytes are admitted behind a smaller model view.
      if (!(delivery.after as any) || (delivery.after as any).type !== 'text' ||
          typeof (delivery.after as any).value !== 'string' || isToolModelCutView((delivery.after as any).value) ||
          JSON.stringify(delivery.before) !== JSON.stringify(delivery.after)) {
        throw new Error('The skill read could not be delivered completely. Read a smaller window.')
      }
      if (!read.admitted) {
        read.admitted = withZipStateLock(input.actor.sessionId, async () => {
          check()
          const beforePersist = async () => {
            check()
            await assertSkillReadChoice(read.choice, input.actor, read.skillId, input.messageId)
          }
          await beforePersist()
          await input.previewContext?.(read.skillId, read.result)
          const refs = await input.persist({ toolName: delivery.toolName,
            toolCallId: delivery.toolCallId, toolInput: delivery.input, toolArgs: delivery.input,
            toolResult: delivery.output, toolSource: 'native-tool', toolProvider: 'batshit-server', mcpServerName: 'batshit-native',
            timestamp: new Date().toISOString() }, beforePersist)
          const failed = refs.find(ref => ref.skillSessionError)
          if (failed || !refs.some(ref => ref.zipId)) {
            throw new Error(failed?.skillSessionError || 'The skill read was not confirmed stored. Nothing was delivered.')
          }
          check()
          admitted = true
        })
      }
      await read.admitted
    }
  }
}
