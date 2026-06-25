/**
 * Group Chat Types - Story 5.10: Group Chat Foundation
 *
 * Types for multi-agent group chat feature (Modes 3 & 4)
 * Foundation phase focuses on 2-3 agent parallel processing
 */

/**
 * Individual agent in a group chat
 */
export interface GroupAgent {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  enabled?: boolean; // Can be disabled without removing from group
  color?: string; // For UI differentiation
  position?: number; // Display order in UI
}

/**
 * Group chat session configuration
 */
export interface GroupChatConfig {
  sessionId: string;
  agents: GroupAgent[];
  layout: 'parallel' | 'interleaved'; // UI layout mode (parallel for foundation)
  created: number;
  maxAgents?: number; // Foundation: 3, Future: 5+
  mode: 'vercel-native'; // Legacy field (Modes 3 & 4 supported in routing)
}

/**
 * Agent-specific stream result during parallel processing
 */
export interface AgentStreamResult {
  agentId: string;
  agentName: string;
  stream: ReadableStream<string> | null;
  error?: Error;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Message with agent attribution for storage (future helpers)
 */
export interface GroupChatMessage {
  role: 'user' | 'assistant';
  content: string;
  agentId?: string; // Which agent sent this (undefined for user messages)
  agentName?: string;
  timestamp: number;
  tokens?: number;
  messageId: string;
}

export type GroupChatLayout = 'parallel' | 'interleaved'

export type GroupChatSpeakPolicy =
  | 'none'
  | 'balanced'
  | 'quiet'
  | 'only_when_asked'
  | 'topic_only'

export interface GroupChatAgentSettings {
  speak_policy?: GroupChatSpeakPolicy
  speak_topics?: string[]
}

export interface GroupChatZipSettings extends Record<string, any> {
  shared_tools?: string[]
  auto_zip_error?: boolean
  auto_zip_image?: boolean
  auto_zip_subagent?: boolean
  auto_zip_read_file?: boolean
  auto_zip_write_file?: boolean
  auto_zip_edit_file?: boolean
  auto_zip_execute_command?: boolean
  auto_zip_list_files?: boolean
  auto_zip_all_other_tools?: boolean
  custom_tool_settings?: Array<{
    tool_name: string
    buffer_size?: number
    zip_threshold?: number
    auto_zip?: boolean
  }>
}

export interface GroupChatSessionConfig {
  enabled: boolean
  layout: GroupChatLayout
  agent_ids: string[]
  agent_settings?: Record<string, GroupChatAgentSettings>
  group_system_prompt?: string | null
  max_followups_total?: number
  max_agents?: number
  driver_mode?: boolean
  driver_agent_id?: string | null
  shared_tools?: string[]
  zip_settings?: GroupChatZipSettings | null
}

export const GROUP_CHAT_MIN_AGENT_COUNT = 2
export const GROUP_CHAT_MAX_AGENT_COUNT = 8
export const GROUP_CHAT_MAX_FOLLOWUPS_TOTAL = 200

export const GROUP_CHAT_SESSION_DEFAULTS: GroupChatSessionConfig = {
  enabled: false,
  layout: 'interleaved',
  agent_ids: [],
  agent_settings: {},
  group_system_prompt: null,
  max_followups_total: 2,
  max_agents: 4,
  driver_mode: false,
  driver_agent_id: null,
  shared_tools: [],
  zip_settings: null
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const coerceInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed)
    }
  }
  return null
}

export function normalizeGroupMaxFollowupsTotal(
  value: unknown,
  fallback: number = GROUP_CHAT_SESSION_DEFAULTS.max_followups_total ?? 5
) {
  const safeFallback = clamp(
    Math.max(0, Math.trunc(fallback)),
    0,
    GROUP_CHAT_MAX_FOLLOWUPS_TOTAL
  )
  const parsed = coerceInteger(value)
  if (parsed === null) return safeFallback
  return clamp(parsed, 0, GROUP_CHAT_MAX_FOLLOWUPS_TOTAL)
}

export function normalizeGroupMaxAgents(
  value: unknown,
  fallback: number = GROUP_CHAT_SESSION_DEFAULTS.max_agents ?? 4
) {
  const safeFallback = clamp(
    Math.max(GROUP_CHAT_MIN_AGENT_COUNT, Math.trunc(fallback)),
    GROUP_CHAT_MIN_AGENT_COUNT,
    GROUP_CHAT_MAX_AGENT_COUNT
  )
  const parsed = coerceInteger(value)
  if (parsed === null) return safeFallback
  return clamp(parsed, GROUP_CHAT_MIN_AGENT_COUNT, GROUP_CHAT_MAX_AGENT_COUNT)
}

/**
 * Foundation phase templates
 */
/**
 * Default group chat settings
 */
export const GROUP_CHAT_DEFAULTS = {
  maxAgentsFoundation: 3, // Foundation phase limit
  maxAgentsFuture: 5, // Future expansion
  agentTimeout: 15000, // 15 seconds per agent
  defaultLayout: 'parallel' as const,
  minAgents: GROUP_CHAT_MIN_AGENT_COUNT // Minimum for group chat
}
