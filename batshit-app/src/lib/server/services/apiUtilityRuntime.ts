import type { ToolExecutionOptions } from 'ai'
import { z } from 'zod'
import { API_UTILITY_CONTROL_IDS, type ApiUtilityKind } from '$lib/utils/apiUtilityControls'
import { serializeRegisteredTools } from './toolDefinitionFingerprint'
import { buildSchemaHintSummary, getSchemaHintText, type SchemaHintFields } from './dynamicMcpSchema'

type IdentityInput = {
  userId: string
  agentId?: string | null
  sessionId?: string | null
  messageId?: string | null
  scopeAgentId?: string | null
  abortSignal?: AbortSignal
}
type Identity = Readonly<Omit<IdentityInput, 'abortSignal'>>
type SubagentTarget = Readonly<{ slug: string; isSubagent: true; subagentId: string; subagentName: string; subagentType: string; subagentAvatar?: string }>
type Candidate = { kind: ApiUtilityKind; identity: Identity; abortSignal?: AbortSignal; target?: SubagentTarget }
type CapturedSubagent = { metadata: SubagentTarget; definition: Record<string, any>; approval?: RegisteredUtility['approval'] }
type RegisteredUtility = {
  controlId: string
  title: string
  description: string
  schemaHint: string
  schemaHintFields: SchemaHintFields
  inputSchema: z.ZodTypeAny
  inputSchemaJson: Record<string, any>
  definition: Record<string, any>
  approval?: (input: unknown) => unknown | Promise<unknown>
  targets?: readonly CapturedSubagent[]
}

/** These handles carry no serializable authority. Only this module can read them. */
export type ApiUtilityScope = Readonly<{ readonly apiUtilityScope: unique symbol }>
export type ApiUtilityInvocation = Readonly<{ readonly apiUtilityInvocation: unique symbol }>
const candidateKey = Symbol('native-api-utility-candidate')
const utilityBrokerKey = Symbol('utility-only-api-broker')
const utilityBrokers = new WeakMap<object, { identity: Identity; abortSignal?: AbortSignal }>()
const originalOptionsKey = Symbol('api-utility-original-sdk-options')
const innerExecutionKey = Symbol('api-utility-inner-execution')
const modelFormatKey = Symbol('api-utility-model-format')
const guardedFormatters = new WeakSet<(input: any) => any>()
const guardedOutputs = new WeakSet<object>()
const candidates = new WeakMap<object, Candidate>()
const scopes = new WeakMap<ApiUtilityScope, {
  identity: Identity
  abortSignal?: AbortSignal
  entries: readonly RegisteredUtility[]
}>()
const invocations = new WeakMap<ApiUtilityInvocation, {
  scope: ApiUtilityScope
  controlId: string
  options: ToolExecutionOptions<unknown>
  target?: SubagentTarget
}>()

const id = (value: string | null | undefined) => value?.trim() || null
const identityOf = (input: IdentityInput): Identity => Object.freeze({ userId: input.userId,
  agentId: id(input.agentId), sessionId: id(input.sessionId), messageId: id(input.messageId), scopeAgentId: id(input.scopeAgentId) })
const equalIdentity = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b)
const fullUtilityHint = (fields: SchemaHintFields) => getSchemaHintText(buildSchemaHintSummary(fields, {
  requiredLimit: Number.MAX_SAFE_INTEGER, optionalLimit: Number.MAX_SAFE_INTEGER, maxChars: 0
}))!

/** Keep original SDK step options through the existing Plan decoration, without serializing them. */
export function preserveApiUtilitySdkOptions<T extends Record<string | symbol, any>>(options: T | undefined): T {
  const source = options ?? {} as T
  return { ...source, [originalOptionsKey]: source[originalOptionsKey] ?? source }
}
export const isApiUtilityInnerExecution = (options: unknown): boolean =>
  !!options && typeof options === 'object' && (options as any)[innerExecutionKey] === true
export const isApiSkillUtilityFormatting = (options: unknown): boolean =>
  !!options && typeof options === 'object' && (options as any)[modelFormatKey] === API_UTILITY_CONTROL_IDS.skill
export function markApiUtilityGuardedFormatter(formatter: (input: any) => any): void { guardedFormatters.add(formatter) }
export const isGuardedApiUtilityOutput = (output: unknown): boolean =>
  !!output && typeof output === 'object' && guardedOutputs.has(output)

/**
 * Mark only a definition actually created by the existing native registration owner.
 * A private symbol survives the existing Plan object spread. External tool JSON cannot
 * mint its WeakMap token, so a colliding tool name is never enough to migrate a callback.
 */
export function markApiUtilityCandidate<T extends Record<string, any>>(definition: T, kind: ApiUtilityKind, input: IdentityInput, target?: SubagentTarget): T {
  const token = Object.freeze({})
  candidates.set(token, { kind, identity: identityOf(input), abortSignal: input.abortSignal,
    ...(target ? { target: Object.freeze({ ...target }) } : {}) })
  return { ...definition, [candidateKey]: token }
}

export function markUtilityOnlyApiBroker<T extends Record<string, any>>(definition: T, input: IdentityInput): T {
  const token = Object.freeze({})
  utilityBrokers.set(token, { identity: identityOf(input), abortSignal: input.abortSignal })
  return { ...definition, [utilityBrokerKey]: token }
}

/** Never remove an independently supplied/decorated broker merely because the native base was empty. */
export function pruneUnusedUtilityBrokers(tools: Record<string, any>, input: IdentityInput): string[] {
  const removed: string[] = []
  for (const name of ['native_batshit_tool_search', 'native_batshit_tool_use']) {
    const token = tools[name]?.[utilityBrokerKey]
    const original = token && utilityBrokers.get(token)
    if (!original) continue
    if (!equalIdentity(original.identity, identityOf(input)) || original.abortSignal !== input.abortSignal) {
      throw new Error('The API utility broker owner changed. Nothing was sent.')
    }
    delete tools[name]
    removed.push(name)
  }
  return removed
}

/** Capture AFTER all existing eligibility and Plan/provider decoration, never from a factory's unfiltered dictionary. */
export function captureApiUtilities(input: {
  identity: IdentityInput
  tools?: Record<string, any>
  approvals: Record<string, any>
}): { scope: ApiUtilityScope; tools?: Record<string, any> } {
  const identity = identityOf(input.identity)
  const tools = input.tools ? { ...input.tools } : undefined
  const entries: RegisteredUtility[] = []
  const subagents: CapturedSubagent[] = []
  for (const [name, definition] of Object.entries(tools ?? {})) {
    const token = definition?.[candidateKey]
    const candidate = token ? candidates.get(token) : undefined
    if (!candidate) continue
    if (!equalIdentity(candidate.identity, identity) || candidate.abortSignal !== input.identity.abortSignal) {
      throw new Error('The API utility registration owner changed. Nothing was sent.')
    }
    if (typeof definition.execute !== 'function' || typeof definition.inputSchema?.safeParse !== 'function') {
      throw new Error('The eligible API utility schema or executor is unavailable. Nothing was sent.')
    }
    if (candidate.kind === 'subagent') {
      if (!candidate.target?.slug || !candidate.target.subagentId || subagents.some(target => target.metadata.slug === candidate.target!.slug)) {
        throw new Error('The eligible Subagent slug is missing or ambiguous. Nothing was sent.')
      }
      subagents.push(Object.freeze({ metadata: candidate.target, definition: Object.freeze({ ...definition }), approval: input.approvals[name] }))
      delete tools![name]
      continue
    }
    const skill = candidate.kind === 'skill'
    const schema = skill ? definition.inputSchema.pick({ skillId: true, action: true, path: true, maxChars: true, offset: true })
      .extend({ action: z.enum(['invoke', 'list', 'read']).optional() }) : definition.inputSchema
    const captured = skill ? { ...definition, inputSchema: schema } : definition
    const serialized = serializeRegisteredTools({ [name]: captured })[0]
    const workers = candidate.kind === 'workers'
    const schemaHintFields: SchemaHintFields = skill ? {
      required: ['`skillId`'], optional: ['`action` (`invoke` by default | `list` | `read`)', '`path` (required for read)',
        '`maxChars` (64 to 30000; 12000 by default for documents)', '`offset` (integer 0 or more; 0 by default)']
    } : workers ? {
      required: ['`workers` (1 to 6 entries, each with required `task` and optional `role`, `base`; omit base for general worker or use an assigned Subagent slug)'], optional: []
    } : {
      required: ['`query`'], optional: ['`maxResults` (1 to 10; 5 by default)', '`region`',
        '`safeSearch` (`strict` | `moderate` by default | `off`)', '`timeoutMs` (1000 to 20000; 8000 by default)']
    }
    entries.push(Object.freeze({ controlId: API_UTILITY_CONTROL_IDS[candidate.kind], title: skill ? 'Skill' : workers ? 'Spawn Workers' : 'Web Search',
      description: skill ? 'Invoke, list or read an enabled skill and its reference documentation.' : definition.description ?? '',
      schemaHint: fullUtilityHint(schemaHintFields), schemaHintFields,
      inputSchema: schema, inputSchemaJson: serialized.inputSchema,
      definition: Object.freeze({ ...captured }), approval: input.approvals[name] }))
    if (skill) {
      // Scripts keep the very same native callback, formatter and SDK approval
      // policy. Only document actions move; scripts/aliases cannot enter the
      // utility schema, and the remaining native schema requires a script action.
      tools![name] = { ...definition, description: 'List, read or run bundled skill scripts. Script runs retain native bash safety policy.',
        inputSchema: definition.inputSchema.extend({ action: z.enum(['script_list', 'script_read', 'script_run']) }) }
    } else delete tools![name]
  }
  if (subagents.length) {
    subagents.sort((a, b) => a.metadata.slug.localeCompare(b.metadata.slug))
    // Derive each slug branch from its ORIGINAL final schema. The selected
    // callback parses that schema again, stripping slug and hidden aliases.
    const schema = z.discriminatedUnion('slug', subagents.map(target =>
      target.definition.inputSchema.extend({ slug: z.literal(target.metadata.slug) })) as any)
    const definition = Object.freeze({ inputSchema: schema })
    const serialized = serializeRegisteredTools({ subagents: definition })[0]
    const schemaHintFields: SchemaHintFields = {
      required: [`\`slug\` (${subagents.map(target => target.metadata.slug).join(' | ')}; from subagents roster)`, '`chatInput`'],
      optional: ['`thread` (`fresh` by default | `resume`)']
    }
    entries.push(Object.freeze({ controlId: API_UTILITY_CONTROL_IDS.subagent, title: 'Call Subagent',
      description: 'Call one assigned Subagent by its exact slug, with fresh or resumed thread context.',
      schemaHint: fullUtilityHint(schemaHintFields), schemaHintFields,
      inputSchema: schema, inputSchemaJson: serialized.inputSchema, definition, targets: Object.freeze(subagents) }))
  }
  const scope = Object.freeze({}) as ApiUtilityScope
  scopes.set(scope, { identity, abortSignal: input.identity.abortSignal, entries: Object.freeze(entries) })
  return { scope, tools: entries.length ? tools : input.tools }
}

export function assertApiUtilityScope(scope: ApiUtilityScope, input: IdentityInput): void {
  const saved = scopes.get(scope)
  if (!saved || !equalIdentity(saved.identity, identityOf(input))) throw new Error('The API utility scope owner changed.')
  saved.abortSignal?.throwIfAborted()
}

export function readApiUtilities(scope: ApiUtilityScope | undefined, input: { userId?: string | null; agentId?: string | null }) {
  if (!scope) return []
  const saved = scopes.get(scope)
  if (!saved || saved.identity.userId !== input.userId || saved.identity.agentId !== id(input.agentId)) {
    throw new Error('The API utility discovery owner changed.')
  }
  saved.abortSignal?.throwIfAborted()
  return saved.entries
}

/** Registry definitions are projected from the same sealed eligible set used by execution. */
export function buildApiUtilityControls(scope: ApiUtilityScope | undefined,
  input: { userId?: string | null; agentId?: string | null; runtimeMode?: string | null }) {
  if (!scope || input.runtimeMode !== 'mode3') return []
  return readApiUtilities(scope, input).map(entry => ({
    controlId: entry.controlId, sourceType: 'core' as const, executorType: 'internal_handler' as const,
    title: entry.title, description: entry.description, schemaHint: entry.schemaHint,
    inputSchema: entry.inputSchema, inputSchemaJson: entry.inputSchemaJson, outputSchema: null,
    riskLevel: 'safe' as const, status: 'published' as const, tags: ['API utility', entry.title],
    // Identity is the opaque API registration/invocation, not a claimed context.agentId.
    // The captured helper retains its own acting-scope checks and SDK admission.
    actsAsAgent: false,
    handler: (context: IdentityInput & { actorType?: string; apiUtilityInvocation?: ApiUtilityInvocation }, args: Record<string, any>) =>
      executeApiUtility(scope, context.apiUtilityInvocation, context, entry.controlId, args)
  }))
}

/** The actual SDK invocation options/ID stay private and distinct for every broker step. */
export function captureApiUtilityInvocation(scope: ApiUtilityScope | undefined, controlId: string, options: ToolExecutionOptions<unknown>): ApiUtilityInvocation | undefined {
  if (!scope) return undefined
  if (!scopes.get(scope)?.entries.some(entry => entry.controlId === controlId)) return undefined
  const invocation = Object.freeze({}) as ApiUtilityInvocation
  invocations.set(invocation, { scope, controlId, options })
  return invocation
}

/** Only a selected, validated captured callback can name a child in saved presentation. */
export function readApiUtilityInvocationTarget(scope: ApiUtilityScope | undefined, invocation: ApiUtilityInvocation | undefined): SubagentTarget | undefined {
  const saved = invocation && invocations.get(invocation)
  return scope && saved?.scope === scope ? saved.target : undefined
}

export async function executeApiUtility(scope: ApiUtilityScope, invocation: ApiUtilityInvocation | undefined,
  input: IdentityInput & { actorType?: string }, controlId: string, args: Record<string, any>) {
  assertApiUtilityScope(scope, input)
  const call = invocation && invocations.get(invocation)
  const entry = scopes.get(scope)!.entries.find(entry => entry.controlId === controlId)
  if (input.actorType !== 'in-process' || !call || call.scope !== scope || call.controlId !== controlId || !entry) {
    throw new Error('This utility needs its exact in-process API tool invocation.')
  }
  call.options.abortSignal?.throwIfAborted()
  // The captured tool's own final schema still owns validation/unknown-key
  // stripping. Utility envelopes can never expose aliases the SDK had removed.
  const parsed = entry.definition.inputSchema.safeParse(args)
  if (!parsed.success) throw new Error('The original API utility input is invalid.')
  // These migrated operations have no approval at the accepted native boundary.
  // A changed policy must refuse visibly rather than be silently bypassed.
  const target = entry.targets?.find(target => target.metadata.slug === parsed.data.slug)
  const definition = target?.definition ?? entry.definition
  const nativeInput = definition.inputSchema.safeParse(parsed.data)
  if (!nativeInput.success || entry.targets && !target) throw new Error('The original API utility target or input is invalid.')
  const approval = target?.approval ?? entry.approval
  if (approval && await approval(nativeInput.data) !== undefined) {
    throw new Error('This utility requires an SDK approval boundary that is unavailable here.')
  }
  assertApiUtilityScope(scope, input)
  call.options.abortSignal?.throwIfAborted()
  if (target) call.target = target.metadata
  const original = (call.options as any)[originalOptionsKey] ?? call.options
  return definition.execute(nativeInput.data, { ...original, [innerExecutionKey]: true })
}

export async function formatApiUtilityOutput(scope: ApiUtilityScope | undefined, output: any, options: Record<string, any>) {
  if (!scope || typeof output?.controlId !== 'string') return null
  if (output.family !== 'batshit' || output.target !== output.controlId || output.ref !== `batshit:${output.controlId}`) return null
  const entry = scopes.get(scope)?.entries.find(entry => entry.controlId === output.controlId)
  if (!entry || !Object.hasOwn(output, 'result')) return null
  const raw = output.result
  const parsed = entry.definition.inputSchema.safeParse(options.input?.input)
  if (!parsed.success) throw new Error('The API utility formatter lost its original validated input.')
  const target = entry.targets?.find(target => target.metadata.slug === parsed.data.slug)
  const definition = target?.definition ?? entry.definition
  const nativeInput = definition.inputSchema.safeParse(parsed.data)
  if (!nativeInput.success || entry.targets && !target) throw new Error('The API utility formatter lost its original target input.')
  const formatter = definition.toModelOutput
  const modelOutput = formatter ? await formatter({ ...options, input: nativeInput.data, output: raw, [modelFormatKey]: entry.controlId }) : { type: 'json' as const, value: raw }
  if (guardedFormatters.has(formatter) && modelOutput && typeof modelOutput === 'object') guardedOutputs.add(modelOutput)
  return modelOutput
}
