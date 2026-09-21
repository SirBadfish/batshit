/**
 * SA-120 P1 — the context the canonical compiler hands a Jev Juice hint provider.
 *
 * The compiler stays deterministic: it computes the agent's enabled skills and the
 * discoverable typed refs exactly as it always has, then calls the provider the route
 * injected (a closure that owns the network call, its 400 ms deadline, and its evidence)
 * and appends whatever lines come back at the very end of the DCM — the cache-free tail.
 * No provider, no lines, byte-identical output.
 *
 * SA-120 P5 adds a third route-owned seam, `JevJuiceSmartZipProvider`, for the one Jev Juice
 * effect that must land INSIDE the compiled history rather than at the tail: Batshit opening
 * a zipped tool result for this very message. The compiler compiles history once, tells the
 * provider exactly which zips it left compressed, and expands the ones the provider returns
 * through an in-memory overlay plus ONE more history pass. It still writes nothing: the route
 * stores the `inferred` unzip state at the accepted-send boundary.
 */

import type { ZipCompression } from '$lib/services/messageCompiler'
import type { AgentSlashCapability } from '../slashCommandCapabilities'
import type { DynamicMcpDiscoverableRef } from '../dynamicMcpIndex'

export interface JevJuiceHintContext {
  currentUserMessage: string
  /** The agent's enabled slash capabilities (skills and prompts), as `skills_commands` lists them. */
  skills: AgentSlashCapability[]
  /** Every typed ref the agent can reach through the broker on this runtime. */
  discoverable: DynamicMcpDiscoverableRef[]
  /** The MCP gateway ids the agent's scope resolved to; `null` when Dynamic MCP is off. */
  resolvedGatewayIds: string[] | null
}

/** Returns DCM lines to append (already including their heading), or `[]`. Must never throw. */
export type JevJuiceHintProvider = (context: JevJuiceHintContext) => Promise<string[]>

export interface JevJuiceSmartZipContext {
  currentUserMessage: string
  /** Every zip the first history pass left compressed, in chat order (oldest first). */
  zippedItems: ZipCompression[]
}

/** One zipped tool result to expand for this compile. */
export interface JevJuiceSmartZipOpen {
  zipId: string
  description: string
  tokens: number
  probability: number
  durationMessages: number
}

/**
 * Returns the zips to open for THIS compile, or `[]`. Must never throw and must write
 * nothing. The compiler re-checks every id against what it really left compressed, so a wrong
 * answer can never expand anything the compile did not itself report.
 */
export type JevJuiceSmartZipProvider = (context: JevJuiceSmartZipContext) => Promise<JevJuiceSmartZipOpen[]>
