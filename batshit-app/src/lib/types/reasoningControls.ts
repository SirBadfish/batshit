import type { ModelConnectionInfo } from './modelIdentity'

/** Public capability evidence. Executable request mappings never come from this payload. */
export type ReasoningControlDefinition =
  | { id: 'effort'; kind: 'effort'; values: string[]; defaultValue?: string }
  | { id: 'thinking'; kind: 'toggle'; defaultValue?: boolean }
  | { id: 'mode'; kind: 'mode'; values: string[]; defaultValue?: string }
  | { id: 'budget'; kind: 'budget'; min: number; max?: number; specialValues?: number[]; defaultValue?: number }

export interface ModelReasoningDescriptor {
  version: 1
  connection: string
  effectiveModelId: string
  endpoint: string
  controls: ReasoningControlDefinition[]
  evidence: Array<{ url: string; checkedAt: string }>
  lastVerified: string
}

export interface ReasoningEvidenceRecord {
  lastGood?: ModelReasoningDescriptor
  lastAttempt: { at: string; outcome: 'verified' | 'unavailable' | 'conflict'; reason?: string }
}

export interface ReasoningControlIdentity {
  presetId: string | null
  connection: ModelConnectionInfo
  effectiveModelId: string
}

export type ReasoningControlId = ReasoningControlDefinition['id']
export type ReasoningControlValue = string | boolean | number
export type ReasoningControlSelection =
  | { mode: 'provider-default' }
  | { mode: 'value'; value: ReasoningControlValue }

/** Absence means inherit. Each keyed control is an independently written agent-record leaf. */
export type AgentReasoningOverrides = Record<string, ReasoningControlSelection>
export type AgentReasoningOverridesPatch = Record<string, ReasoningControlSelection | null>

/** An explicit, validated choice frozen for this request; it does not alter delegated defaults. */
export interface ExplicitReasoningSnapshot {
  identity: ReasoningControlIdentity
  control: ReasoningControlId
  selection: ReasoningControlSelection
}

/** Installation-local, filtered read evidence. Never a public catalog fact or Send input. */
export interface LocalReasoningContract {
  version: 1
  status: 'verified' | 'unverified'
  connectionId: 'direct:ollama'
  effectiveModelId: string
  adapterVersion: string
  runtimeVersion?: string
  checkedAt: string
  thinking?: { values: [false, true]; default: boolean }
  reason?: string
}
/** Server-only request envelope; the opaque identity key is never returned to the browser. */
export interface LocalReasoningSnapshot {
  contract: LocalReasoningContract
  connectionKey: string
}
