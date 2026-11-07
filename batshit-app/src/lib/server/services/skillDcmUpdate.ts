/** Exact server-owned replacements of the canonical DCM span; never serialized authority. */
export type SkillDcmUpdate = Readonly<{ readonly skillDcmUpdate: unique symbol }>
type Replacement = Readonly<{ before: string; after: string; context: string; start: number; removed: string; inserted: string }>
const replacements = new WeakMap<SkillDcmUpdate, Replacement>()
export function createSkillDcmUpdate(before: string, start: number, removed: string, inserted: string, context: string): SkillDcmUpdate {
  if (!Number.isSafeInteger(start) || start < 0 || before.slice(start, start + removed.length) !== removed) {
    throw new Error('The canonical DCM replacement span is unavailable. Nothing was sent.')
  }
  const token = Object.freeze({}) as SkillDcmUpdate
  replacements.set(token, Object.freeze({ before, after: before.slice(0, start) + inserted + before.slice(start + removed.length), context, start, removed, inserted }))
  return token
}
export function readSkillDcmUpdate(token: SkillDcmUpdate): Replacement {
  const value = replacements.get(token)
  if (!value) throw new Error('The canonical DCM update does not belong to this server run.')
  return value
}
export function applySkillDcmUpdate(messages: readonly any[], token: SkillDcmUpdate): any[] {
  const update = readSkillDcmUpdate(token)
  let matches = 0
  const changed = messages.map(message => {
    if (message?.role !== 'user') return message
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    if (!Array.isArray(parts)) return message
    const joined = parts.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('')
    const offset = joined.indexOf(update.before)
    if (offset < 0) return message
    if (joined.indexOf(update.before, offset + 1) >= 0) throw new Error('The compiled DCM span is ambiguous. Nothing was sent.')
    const start = offset + update.start
    const end = start + update.removed.length
    let at = 0
    let replaced = false
    const content = parts.map((part: any) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part
      const from = at
      at += part.text.length
      if (replaced || start < from || start > at || end > at) return part
      if (part.text.slice(start - from, end - from) !== update.removed) return part
      replaced = true
      return { ...part, text: part.text.slice(0, start - from) + update.inserted + part.text.slice(end - from) }
    })
    if (!replaced) throw new Error('The canonical DCM crosses an unsupported compiled boundary. Nothing was sent.')
    matches += 1
    return { ...message, content: typeof message.content === 'string' ? content[0].text : content }
  })
  if (matches !== 1) throw new Error('The original compiled DCM span changed. Nothing was sent.')
  return changed
}
