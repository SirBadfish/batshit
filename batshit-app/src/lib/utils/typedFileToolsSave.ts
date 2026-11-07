/** Browser request-only metadata. Never merge these fields into stored subject records. */
export const TYPED_FILE_TOOLS_REVISION_HEADER = 'x-batshit-typed-file-tools-revision'
export type TypedFileToolsBaseline = Readonly<{ kind: 'agent' | 'subagent'; id: string; token: string; value: boolean }>
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const token = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
export function typedFileToolsBodyValue(body: unknown): boolean | undefined {
  if (!object(body) || !object(body.provider_specific_settings) || !object(body.provider_specific_settings.nativeTools)) return undefined
  return typeof body.provider_specific_settings.nativeTools.typedFileToolsEnabled === 'boolean'
    ? body.provider_specific_settings.nativeTools.typedFileToolsEnabled : undefined
}
export function captureTypedFileToolsBaseline(kind: 'agent' | 'subagent', id: string, record: unknown, revision: string | null): TypedFileToolsBaseline | null {
  if (!object(record) || record.id !== id || !token(revision)) return null
  const value = typedFileToolsBodyValue(record)
  return value === undefined ? null : Object.freeze({ kind, id, token: revision, value })
}
export function withExpectedTypedFileTools<T extends object>(body: T, baseline: TypedFileToolsBaseline | null): T & { expectedTypedFileTools?: string } {
  if (typedFileToolsBodyValue(body) === undefined) return body
  if (!baseline) throw new Error('Read the saved Typed File Tools choice before changing it. Your draft is kept; nothing was sent.')
  return { ...body, expectedTypedFileTools: baseline.token }
}
export function withoutExpectedTypedFileTools<T extends object>(body: T): Omit<T, 'expectedTypedFileTools'> {
  const { expectedTypedFileTools: _expected, ...values } = body as T & { expectedTypedFileTools?: unknown }
  return values
}
/** Advance only the original issued choice's own known physical receipt. */
export function adoptTypedFileToolsAck(baseline: TypedFileToolsBaseline | null, expected: unknown, wanted: unknown, ack: unknown): TypedFileToolsBaseline | null {
  if (!baseline || baseline.token !== expected || typeof wanted !== 'boolean' || !object(ack) || !token(ack.revision) || ack.value !== wanted) return null
  return Object.freeze({ ...baseline, token: ack.revision, value: wanted })
}
/** Replace one draft/baseline grant only; unrelated provider/model/tool siblings survive. */
export function withTypedFileToolsChoice<T extends { provider_specific_settings: Record<string, any> | null }>(form: T, value: boolean): T {
  const provider = form.provider_specific_settings ?? {}
  const native = object(provider.nativeTools) ? provider.nativeTools : {}
  return { ...form, provider_specific_settings: { ...provider, nativeTools: { ...native, typedFileToolsEnabled: value } } }
}

/** Hold this one group while allowing unrelated sparse fields to retain their own intent. */
export function withoutTypedFileToolsChoice<T extends object>(body: T): T {
  const source = body as T & { provider_specific_settings?: Record<string, any> | null }
  if (!object(source.provider_specific_settings) || !object(source.provider_specific_settings.nativeTools)) return body
  const native = { ...source.provider_specific_settings.nativeTools }
  delete native.typedFileToolsEnabled
  const provider = { ...source.provider_specific_settings }
  if (Object.keys(native).length) provider.nativeTools = native
  else delete provider.nativeTools
  const next = { ...source }
  if (Object.keys(provider).length) next.provider_specific_settings = provider
  else delete next.provider_specific_settings
  return next
}
