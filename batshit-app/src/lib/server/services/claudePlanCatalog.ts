import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_LABEL, CLAUDE_PLAN_MODEL_CHOICES, CLAUDE_PLAN_SERVICE } from '$lib/utils/claudePlanConnection'
import type { ClaudePlanReadiness } from './claudePlanAdmission'

/**
 * SA-139 (D1): the connection is listed only where Claude Code is installed, after every other
 * connection, so an Anthropic catalog row never auto-selects it. Its models are the managed Claude
 * Code list (`claude-cli-models.ts`) plus "CLI default"; no paid price or output limit applies.
 */
export function claudePlanConnectionOptions(readiness: ClaudePlanReadiness & { installed: boolean }): CatalogConnectionOption[] {
  if (!readiness.installed) return []
  const locked = readiness.state === 'ready' ? null : readiness
  return [{
    id: CLAUDE_PLAN_CONNECTION_ID, label: CLAUDE_PLAN_LABEL, transport: 'direct', service: CLAUDE_PLAN_SERVICE, providers: ['anthropic'],
    status: locked ? 'locked' : 'ready', ...(locked ? { lockedReason: locked.reason } : {}),
    ...(locked?.setupCommand ? { setupCommand: locked.setupCommand } : {}), ...(locked?.statusCommand ? { statusCommand: locked.statusCommand } : {}),
    ...(locked?.setupContext ? { setupContext: locked.setupContext } : {}), ...(locked?.setupWorkingDirectory ? { setupWorkingDirectory: locked.setupWorkingDirectory } : {}),
    description: 'Your own Claude Code, signed in with your Claude plan, as the model for Primary Agents, Subagents, Workers and Compact. Batshit runs every tool. No paid API-key fallback.',
    n8nStatus: 'locked', n8nDescription: 'The Claude plan connection runs only inside Batshit and is unavailable to n8n.'
  }]
}

export function claudePlanCatalogModels(readiness: { installed: boolean }): CatalogModel[] {
  if (!readiness.installed) return []
  return CLAUDE_PLAN_MODEL_CHOICES.map(choice => ({
    id: `${CLAUDE_PLAN_CONNECTION_ID}/${choice.value}`, canonicalId: `${CLAUDE_PLAN_CONNECTION_ID}/${choice.value}`, provider: 'anthropic',
    name: choice.value, displayName: `${choice.label} (${CLAUDE_PLAN_LABEL})`, source: CLAUDE_PLAN_SERVICE, transport: 'direct',
    purpose: 'chat', category: 'balanced', connectionId: CLAUDE_PLAN_CONNECTION_ID, availableConnections: [CLAUDE_PLAN_CONNECTION_ID],
    tags: ['batshit-only', 'claude', 'anthropic'], features: { streaming: true, tools: true, vision: true },
    idVariants: { [CLAUDE_PLAN_CONNECTION_ID]: { developerId: 'anthropic', modelId: choice.value, effectiveId: choice.value, source: 'direct',
      limits: { contextWindow: choice.contextWindow, maxOutputTokens: null } } }
  }))
}
