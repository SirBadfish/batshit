import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { env } from '$env/dynamic/private'
import { logger } from '$lib/utils/logger'
import { claudeContextCappedByEnvironment, matchingCliContextReport, type CliContextSelection } from '$lib/utils/cliContextWindow'
import type { NativeModeRequest } from '$lib/server/services/vercelBrain'
import { detectClaudeCliStatus, resolveClaudeCliExecutable } from '$lib/server/services/claudeCliStatus'
import { ClaudeEventAdapter } from '$lib/server/services/claudeEventAdapter'
import {
  applyClaudeContextGuard,
  resolveClaudeContextGuardThreshold,
  resolveClaudeContextWindow,
  type ClaudeContextGuardConfig
} from '$lib/server/services/claudeContextGuard'
import { buildCodexPromptFromMessages } from '$lib/server/services/codexBridge'
import { redis } from '$lib/server/redis'
import { ManagedProfileRunRefusedError, isManagedProfileRunRefusal } from './agentProfileFolderGate'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import {
  syncAgentClaudeProfiles,
  ensureManagedClaudeHome,
  assertManagedClaudeProfileId,
  buildClaudeProfileId,
  buildUsersClaudePlansDenyRules,
  CLAUDE_APPROVAL_TOOL_NAME
} from '$lib/server/services/claudeProfileManager'
import { buildManagedGatewayId } from '$lib/server/services/codexProfileManager'
import type { MCPGateway } from '$lib/types/database'
import type { SavedModel } from '$lib/types/savedModels'
import type { ClaudePermissionMode } from '$lib/types/claude'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import {
  MODE4_INTERNAL_HELPER_TOOL_NAMES,
  MODE4_INTERNAL_FETCH_ZIP_TOOL_NAMES,
  resolveManagedCliFetchZipAllowed,
  resolveEnabledMode4InternalHelperTools,
  isMode4InternalHelperTool,
  buildCliHelperMcpToolName
} from '$lib/server/services/mode4InternalTools'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import {
  resolveCliToolSelectionScope,
  resolveRunCredentialCliToolScope
} from '$lib/server/services/cliToolRegistry'
import {
  isStdioGateway,
  resolveManagedStdioEnvironmentValues
} from '$lib/server/services/mcpGatewayStdio'
import { mintCliRunCredential } from '$lib/server/services/cliHelperToken'
import { waitForSseExternalSubscriber } from '$lib/server/sseExternalSubscriber'
import { endClaudeApprovalRunForReply } from '$lib/server/services/claudeApprovalEvents'

/** BL-496: how long a run with approvals waits for the server's Redis subscriber to listen. */
const APPROVAL_SUBSCRIBER_WAIT_MS = 10_000
import { applyCliRunCredentialToChildEnv, stripHostOperatorAuthorityFromChildEnv } from '$lib/server/services/cliChildEnv'
import {
  cliHelperLaunchEnv,
  resolveCliHelperLaunchValues,
  type CliHelperLaunchValues
} from '$lib/server/services/cliHelperLaunch'
import { revokeRunCredential } from '$lib/server/services/agentRunCredentials'
import { getDockerGatewayAuthToken } from '$lib/server/services/dockerGatewayConfig'
import {
  buildClaudeChildEnv,
  buildClaudeChildProcessOptions,
  resolveClaudeRunAsIdentity,
  resolveClaudeRuntimeUid
} from '$lib/server/services/claudeRuntimeUser'
import { buildSubagentSlugCollisionError } from '$lib/utils/subagentSlug'
import { assertCliModelStillOffered, warnIfCliOlderThanPinned } from '$lib/server/services/cliModelAvailability'
import {
  buildCliSubagentMcpToolReference,
  buildCliWorkerSpawnToolReference,
  resolveCliSubagentToolKey
} from '$lib/utils/cliSubagentToolNames'

type ClaudeTransport = 'cli'

interface ClaudeRunOptions {
  model?: string | null
  workingDirectory: string
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  approvalMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'
  permissionPromptTool?: string
  disallowedTools?: string[]
  addDirectories?: string[]
  allowedTools?: string[]
  maxThinkingTokens?: number
  allowedMcpTools?: string[]
  planAllowedTools?: string[]
  allowedDirs?: string[]
  autoAllowTools?: string[]
  /**
   * SA-117 DL-117-06/07 — this run's credential (`<credentialId>.<secret>`), exported to the
   * child as `BATSHIT_AGENT_TOKEN`. It replaces the instance `BATSHIT_TOKEN`, which
   * `applyCliRunCredentialToChildEnv` now DELETES from the child environment.
   */
  agentRunToken?: string | null
  /**
   * SA-117 DL-117-07 — the Docker MCP gateway token this run resolved, if any.
   *
   * The Claude lane passes gateway auth to the CLI through `${BATSHIT_MCP_HEADER_*}`
   * placeholders rather than this variable, so this exists only so the child keeps
   * `MCP_GATEWAY_AUTH_TOKEN` on a run that HAS a gateway and loses it on one that does not
   * — the same rule the Codex lane applies. The Codex bridge already carried this field.
   */
  dockerAuthToken?: string | null
  managedStdioEnv?: Record<string, string>
  systemPromptMode?: 'default' | 'append' | 'replace' | 'replace_file'
  systemPrompt?: string
  systemPromptFile?: string
  chromeEnabled?: boolean
  configScope?: 'managed' | 'global'
  settingsPath?: string | null
  mcpConfigPath?: string | null
  pluginDirs?: string[]
  settingSources?: string[]
  signal?: AbortSignal
  sessionId?: string | null
  messageId?: string | null
  userId?: string | null
  agentId?: string | null
  contextGuard?: ClaudeContextGuardConfig | null
}

interface ClaudeRunner {
  transport: ClaudeTransport
  events: AsyncGenerator<any>
  cleanup?: () => void | Promise<void>
  /**
   * SA-114 P2 (DL-114-08) — write the user's mid-reply words onto the run's open stdin.
   *
   * Resolves `true` when the line was written, which is NOT delivery: Claude Code consumes
   * a queued line between tool calls and only then replays it back on stdout
   * (`--replay-user-messages`), and that echo is the delivery signal (AMD-114-01).
   */
  steer?: (payload: { steerIds: string[]; text: string }) => Promise<boolean>
  /**
   * BL-287: the Claude process. A caller that must outlast it (a Subagent delete, which
   * removes the folder it writes into) waits for its exit (`subagentRunSettle.ts`).
   */
  process?: ChildProcess
}

const PROVIDER_DISABLED_ERROR =
  'Claude Code CLI provider is disabled. Set BATSHIT_CLAUDE_PROVIDER_ENABLED=true and ensure the CLI is installed.'
const CLAUDE_AUTO_ALLOW_TOOLS = ['Read', 'WebSearch', 'WebFetch']
// How long a guard-stopped child gets to exit after SIGTERM before SIGKILL.
const GUARD_KILL_GRACE_MS = 10_000
const ROOT_CLAUDE_BYPASS_PERMISSION_MESSAGE =
  'Claude Code blocks Bypass Permissions when running as root. Configure BATSHIT_CLAUDE_RUN_AS_UID/GID so Batshit can run Claude Code as a non-root child process, or choose Edit Automatically.'

type GetProcessUid = () => number | null | undefined

export function getClaudePermissionModeRuntimeBlockReason(
  permissionMode: ClaudePermissionMode,
  getUid: GetProcessUid = resolveClaudeRuntimeUid
): string | null {
  if (permissionMode !== 'bypassPermissions') return null
  return getUid() === 0 ? ROOT_CLAUDE_BYPASS_PERMISSION_MESSAGE : null
}

function resolveClaudeApprovalMode(
  permissionMode: ClaudeRunOptions['permissionMode'],
  sharedToolApprovalMode: 'off' | 'all'
): NonNullable<ClaudeRunOptions['approvalMode']> {
  if (permissionMode === 'plan') return 'plan'
  if (permissionMode === 'bypassPermissions') return 'bypassPermissions'
  if (permissionMode === 'acceptEdits') {
    return sharedToolApprovalMode === 'all' ? 'acceptEdits' : 'dontAsk'
  }
  return sharedToolApprovalMode === 'all' ? 'default' : 'dontAsk'
}

// Flags whose values carry instruction-bearing payloads (full managed system prompts).
// Mirrors redactCodexCliArgsForLog, which hides developer_instructions/skills.config values.
const CLAUDE_REDACTED_ARG_FLAGS = new Set(['--system-prompt', '--append-system-prompt'])

export function redactClaudeCliArgsForLog(args: string[]) {
  const redacted: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    redacted.push(arg)

    if (!CLAUDE_REDACTED_ARG_FLAGS.has(arg)) continue
    const next = args[index + 1]
    if (typeof next !== 'string') continue

    redacted.push('<redacted>')
    index += 1
  }

  return redacted
}

/**
 * SA-117 DL-117-07 — the Claude lane's child environment, as one testable function.
 *
 * The Codex lane already had `buildCodexChildEnv`; this is its counterpart, extracted so the
 * "`BATSHIT_TOKEN` absent, `BATSHIT_AGENT_TOKEN` present" claim can be asserted on BOTH lanes
 * without spawning a CLI. The rule itself lives in `cliChildEnv.ts` and is shared, so the two
 * lanes cannot drift; this function only supplies the base environment the rule applies to.
 */
export function buildClaudeRunChildEnv(
  options: Pick<ClaudeRunOptions, 'agentRunToken' | 'dockerAuthToken'>,
  baseEnv: NodeJS.ProcessEnv = process.env,
  identity = resolveClaudeRunAsIdentity(baseEnv),
  helperLaunch: CliHelperLaunchValues = resolveCliHelperLaunchValues()
): NodeJS.ProcessEnv {
  const envVars = buildClaudeChildEnv(baseEnv, identity)
  applyCliRunCredentialToChildEnv(envVars, {
    agentRunToken: options.agentRunToken,
    dockerAuthToken: options.dockerAuthToken ?? null
  })
  // BL-152: the shared managed mcp.json names each helper's script folder and URL by
  // reference, and Claude Code expands them from this environment, so this run launches its
  // own process's helpers whichever Batshit wrote the file last.
  Object.assign(envVars, cliHelperLaunchEnv(helperLaunch))
  return envVars
}

/**
 * BL-270: what a managed Plan-mode run is told about its plan. Claude Code writes a plan file in
 * Plan mode, into the user's own `~/.claude/plans`; managed runs are denied that folder
 * (`buildUsersClaudePlansDenyRules`), so the plan belongs in the reply.
 */
export const CLAUDE_MANAGED_PLAN_MODE_NOTE =
  'Plan mode in Batshit: Batshit keeps your plan in the chat, so write the whole plan in your ' +
  'reply. Do not save a plan file; the plans folder is closed to this run.'

export class ClaudeBridge {
  async streamNativeMode(request: NativeModeRequest) {
    if (env.BATSHIT_CLAUDE_PROVIDER_ENABLED === 'false') {
      throw new Error(PROVIDER_DISABLED_ERROR)
    }

    if (!request.messages?.length) {
      throw new Error('No messages provided to Claude CLI runtime')
    }

    if (request.delegatedRun && !request.processOwner) {
      throw new ManagedProfileRunRefusedError('A delegated Claude run requires its stored process owner before profile setup.')
    }
    if (request.processOwner && request.processOwner.userId !== request.userId) {
      throw new ManagedProfileRunRefusedError('The Claude process owner does not match this user.')
    }
    const profileOwner = request.processOwner ?? {
      userId: request.userId || '', kind: 'agent' as const, id: request.agentId || ''
    }

    const claudeSettings = request.claudeSettings
      ? buildClaudeRuntimeSettings(request.claudeSettings)
      : buildClaudeRuntimeSettings(request.providerSettings ?? null)
    const configScope = claudeSettings.configScope ?? 'managed'
    const profileId =
      claudeSettings.profileId ??
      (request.agentId ? buildClaudeProfileId(request.agentId) : null)
    // BL-7 review: a managed run's profile id becomes its home folder and can come from a
    // stored `claude_profile_id`, so it is refused here, before any file is written for this
    // run. A stored `../..` pointed `--settings`, `--mcp-config` and `--plugin-dir` into the
    // user's own `~/.claude`.
    if (configScope === 'managed' && profileId) {
      assertManagedClaudeProfileId(profileId)
    }
    // BL-158: a saved model Batshit's Claude list no longer offers stops the run here, before
    // anything of it is set up, with a message naming whose setting it is. A model id Batshit
    // never listed passes.
    await assertCliModelStillOffered(
      'claude',
      this.resolveCliModel(request.model, claudeSettings.model),
      request
    )

    const requestStart = Date.now()
    const prompt = buildCodexPromptFromMessages({
      messages: request.messages,
      images: request.images
    })

    const input = await this.buildStreamJsonInput(prompt, request.images)

    const agentRecord = await this.loadAgentRecord(request.agentId)
    const permissions = this.resolveAgentPermissions(agentRecord)
    const resolvedModel = this.resolveCliModel(request.model, claudeSettings.model)
    const workingDirectory = await this.resolveWorkingDirectory({
      userId: request.userId,
      projectPath: request.projectPath ?? null,
      claudeSettings
    })
    const sharedToolApprovalMode = request.toolApprovalMode === 'all' ? 'all' : 'off'

    // Managed mcp.json references gateway auth headers as ${BATSHIT_MCP_HEADER_*} placeholders;
    // the real values are injected into the CLI child environment at spawn time below.
    let gatewayHeaderEnv: Record<string, string> = {}
    if (configScope === 'managed' && request.userId && profileId) {
      try {
        gatewayHeaderEnv = await syncAgentClaudeProfiles(request.userId, profileId)
      } catch (error) {
        // A run must not continue with an older config when its required sync failed.
        if (isManagedProfileRunRefusal(error)) throw error
        throw new ManagedProfileRunRefusedError('The managed Claude profile could not be synced for this run.', { cause: error })
      }
    }

    const desiredPermission = claudeSettings.permissionMode ?? 'acceptEdits'
    const maxPermission =
      permissions.allowNetwork === true
        ? 'bypassPermissions'
        : permissions.allowFileEdits === true
          ? 'acceptEdits'
          : permissions.allowNetwork === false || permissions.allowFileEdits === false
            ? 'default'
            : null
    const permissionRank: Record<string, number> = {
      plan: 0,
      default: 1,
      acceptEdits: 2,
      bypassPermissions: 3
    }
    let permissionMode: ClaudeRunOptions['permissionMode'] = desiredPermission
    if (maxPermission && permissionRank[permissionMode] > permissionRank[maxPermission]) {
      permissionMode = maxPermission
    }
    const permissionBlockReason = getClaudePermissionModeRuntimeBlockReason(permissionMode)
    if (permissionBlockReason) {
      throw new Error(permissionBlockReason)
    }
    const approvalMode = resolveClaudeApprovalMode(permissionMode, sharedToolApprovalMode)
    const wantsPermissionPrompt =
      configScope === 'managed' &&
      (approvalMode === 'default' || approvalMode === 'acceptEdits')

    const disallowedTools = new Set<string>(claudeSettings.disallowedTools ?? [])
    if (configScope === 'managed') {
      // Keep the native permission callback unavailable to model selection while
      // still allowing Claude Code to invoke it host-side when a prompt is needed.
      disallowedTools.add(CLAUDE_APPROVAL_TOOL_NAME)
    }
    if (permissions.allowFileEdits === false) {
      disallowedTools.add('Write')
      disallowedTools.add('Edit')
      disallowedTools.add('NotebookEdit')
    }
    if (permissions.allowNetwork === false) {
      disallowedTools.add('WebFetch')
      disallowedTools.add('WebSearch')
    }
    let settingsPath: string | null = null
    let mcpConfigPath: string | null = null
    let pluginDirs: string[] | undefined
    if (configScope === 'managed' && profileId) {
      // BL-7 review: the flags come only from a home that exists and passed the managed-home
      // check (a folder symlinked out of the agents folder is refused here, loudly).
      const paths = await ensureManagedClaudeHome(profileId, profileOwner)
      settingsPath = paths.settingsPath
      mcpConfigPath = paths.mcpPath
      pluginDirs = [paths.pluginsDir]
    }

    if (configScope === 'managed') {
      // BL-270: a managed run never writes its Plan-mode plan into the user's own plans folder.
      for (const rule of buildUsersClaudePlansDenyRules()) {
        disallowedTools.add(rule)
      }
      const mcpDisallowed = await this.resolveManagedMcpToolDenyList({
        userId: request.userId,
        gatewayToolMap: request.gatewayToolMap ?? null
      })
      for (const toolName of mcpDisallowed) {
        disallowedTools.add(toolName)
      }
    }

    const addDirectories = new Set<string>()
    if (request.projectPath) addDirectories.add(request.projectPath)
    for (const dir of claudeSettings.addDirs ?? []) {
      if (dir) addDirectories.add(dir)
    }

    const subagentMcpTools =
      configScope === 'managed'
        ? this.resolveSubagentPlanAllowTools({
            agentId: request.agentId ?? null,
            agentSlug: request.agentSlug ?? null,
            assignedSubagents: request.assignedSubagents
          })
        : []

    let allowedMcpTools: string[] = []
    if (configScope === 'managed') {
      allowedMcpTools = await this.resolveManagedMcpToolAllowList({
        userId: request.userId,
        gatewayToolMap: request.gatewayToolMap ?? null
      })
      const internalMode4Tools = await this.resolveMode4InternalControlAllowTools({
        userId: request.userId ?? null,
        agentId: request.agentId ?? null,
        providerSettings: request.providerSettings ?? null,
        selectedCliToolIds: request.selectedCliToolIds ?? null
      })
      if (internalMode4Tools.allowTools.length > 0) {
        allowedMcpTools = Array.from(new Set([...allowedMcpTools, ...internalMode4Tools.allowTools]))
      }
      if (subagentMcpTools.length > 0) {
        allowedMcpTools = Array.from(new Set([...allowedMcpTools, ...subagentMcpTools]))
      }
      // BL-267: the profile registers `spawn_workers` on the same bridge for a Workers-on
      // primary (`resolveWorkersEnabled`, the value send-routed passes as `workersEnabled`;
      // a delegated run never has it), so it is pre-allowed under the name the profile
      // registers. Outside the list, Claude refused a Worker call with approvals off.
      // Never in Plan mode: a Worker can change files, and `--allowedTools` would pre-allow it
      // there too; Plan mode's own allow list stays the Subagent tools.
      const workerTool =
        request.workersEnabled === true && permissionMode !== 'plan' && request.agentId
          ? buildCliWorkerSpawnToolReference({ id: request.agentId, slug: request.agentSlug ?? null })
          : null
      if (workerTool) {
        allowedMcpTools = Array.from(new Set([...allowedMcpTools, workerTool.fullToolName]))
      }
      for (const toolName of internalMode4Tools.disallowTools) {
        disallowedTools.add(toolName)
      }
    }
    const planAllowedTools = subagentMcpTools

    const allowedDirs = new Set<string>()
    if (workingDirectory) {
      allowedDirs.add(workingDirectory)
    }
    for (const dir of addDirectories) {
      if (!dir) continue
      const resolved = path.isAbsolute(dir) ? dir : path.resolve(workingDirectory, dir)
      allowedDirs.add(resolved)
    }

    const managedStdioEnv =
      configScope === 'managed' && request.userId
        ? await this.resolveManagedStdioEnv(request.userId, request.gatewayToolMap ?? null)
        : {}
    const runProjectPath =
      typeof request.projectPath === 'string' && request.projectPath.trim().length > 0
        ? request.projectPath.trim()
        : null
    if (configScope === 'managed' && runProjectPath) {
      managedStdioEnv.BATSHIT_PROJECT_PATH = runProjectPath
    }
    for (const [key, value] of Object.entries(gatewayHeaderEnv)) {
      managedStdioEnv[key] = value
    }

    const contextGuard = await this.resolveContextGuardConfig({
      agent: agentRecord,
      model: resolvedModel,
      selection: request.cliContextSelection
    })
    contextGuard.onReport = request.onCliContext

    // BL-496 (A2): the permission helper publishes its card on the chat's Redis channel, and
    // only the server's subscriber hears it. That subscriber used to start with the first
    // browser connection, so a woken or unwatched run could ask for approval with nobody,
    // not even the server, listening. It must listen before the run can ask. Above the mint:
    // nothing awaited may sit between the mint and the spawn's `try` (F-P2-6).
    if (wantsPermissionPrompt && !(await waitForSseExternalSubscriber(APPROVAL_SUBSCRIBER_WAIT_MS))) {
      throw new Error(
        'Batshit could not start listening for approval cards, so this Claude run, which asks ' +
          'you before some tools, was not started. Check that Redis is running, then send again.'
      )
    }

    /**
     * SA-117 DL-117-06 — mint this run's credential, where the instance token used to be
     * resolved. See `codexBridge.ts` for the full reasoning; the two lanes are deliberately
     * symmetric, down to the warning and the once-only revoke.
     */
    const runCredential =
      request.userId && request.agentId && request.sessionId
        ? await mintCliRunCredential({
            userId: request.userId,
            agentId: request.agentId,
            sessionId: request.sessionId,
            messageId: request.messageId ?? null,
            runtime: 'claude',
            delegated: request.delegatedRun === true,
            processOwner: request.processOwner ?? null,
            commandParentAgentId: request.commandParentAgentId ?? null,
            delegatedBashEnabled: request.delegatedRun === true &&
              resolveNativeToolSettings(request.providerSettings ?? null).bashEnabled,
            // BL-75: a delegated run's credential names the Subagent or Worker whose skill
            // access governs its `native_skill` loads.
            scopeAgentId: request.scopeAgentId ?? null,
            // BL-81: and the control ids its DCM index offered it, the only ones the control
            // routes will answer it with. The mint refuses a delegated run without them.
            allowedControlIds: request.delegatedAllowedControlIds ?? null,
            mcpGatewayScope: request.selectedGateways ?? [],
            // BL-686: see `codexBridge.ts`; the same list the helper profile was built from.
            cliToolScope: await resolveRunCredentialCliToolScope(request),
            fetchZipAllowed: resolveManagedCliFetchZipAllowed(request.providerSettings, {
              configScope,
              delegatedRun: request.delegatedRun
            }) &&
              allowedMcpTools.includes(buildCliHelperMcpToolName(MODE4_INTERNAL_FETCH_ZIP_TOOL_NAMES[0])) &&
              !disallowedTools.has(buildCliHelperMcpToolName(MODE4_INTERNAL_FETCH_ZIP_TOOL_NAMES[0]))
          })
        : null
    if (!runCredential) {
      console.warn(
        '[ClaudeBridge] No run credential was minted for this run, so its managed helpers ' +
          'cannot authenticate. Missing: ' +
          [
            request.userId ? null : 'userId',
            request.agentId ? null : 'agentId',
            request.sessionId ? null : 'sessionId'
          ]
            .filter(Boolean)
            .join(', ')
      )
    }
    const revokeRunCredentialOnce = (() => {
      let revoked = false
      return async () => {
        if (revoked || !runCredential) return
        revoked = true
        try {
          await revokeRunCredential(runCredential.credentialId, {
            agentId: runCredential.agentId
          })
        } catch (error) {
          console.warn('[ClaudeBridge] Failed to revoke the run credential', error)
        }
      }
    })()

    // SA-117 P2 review (F-P2-6): the mint is the LAST thing before the run options are
    // built, so nothing that can throw sits between it and the `try` around the spawn —
    // `resolveManagedStdioEnv` and `resolveContextGuardConfig` used to sit below it, and a
    // throw there left an orphaned record until the 24 h backstop. Do not insert an awaited
    // call between here and `runViaCli`.
    const runOptions: ClaudeRunOptions = {
      model: resolvedModel,
      workingDirectory,
      permissionMode,
      disallowedTools: Array.from(disallowedTools),
      allowedTools: claudeSettings.allowedTools ?? [],
      maxThinkingTokens: claudeSettings.maxThinkingTokens,
      allowedMcpTools,
      planAllowedTools,
      allowedDirs: Array.from(allowedDirs),
      autoAllowTools: CLAUDE_AUTO_ALLOW_TOOLS,
      agentRunToken: runCredential?.token ?? null,
      dockerAuthToken: getDockerGatewayAuthToken() ?? null,
      managedStdioEnv,
      addDirectories: Array.from(addDirectories),
      systemPromptMode: claudeSettings.systemPromptMode,
      systemPrompt: claudeSettings.systemPrompt,
      systemPromptFile: claudeSettings.systemPromptFile,
      chromeEnabled: typeof claudeSettings.chrome === 'boolean' ? claudeSettings.chrome : undefined,
      configScope,
      settingsPath,
      mcpConfigPath,
      pluginDirs,
      settingSources: configScope === 'managed' ? (claudeSettings.settingSources ?? ['project']) : undefined,
      signal: request.abortSignal,
      approvalMode,
      permissionPromptTool: wantsPermissionPrompt ? CLAUDE_APPROVAL_TOOL_NAME : undefined,
      sessionId: request.sessionId ?? null,
      messageId: request.messageId ?? null,
      userId: request.userId ?? null,
      agentId: request.agentId ?? null,
      contextGuard
    }

    // SA-117 DL-117-06: a spawn that never produces a stream never reaches the cleanup
    // below, so the credential is revoked here instead.
    let runner: Awaited<ReturnType<typeof this.runViaCli>>
    try {
      runner = await this.runViaCli(input, runOptions)
    } catch (error) {
      await revokeRunCredentialOnce()
      throw error
    }

    const adapter = new ClaudeEventAdapter({
      request,
      transport: runner.transport,
      onFinish: request.onFinish
        ? async ({ text, steps, totalUsage, reasoning }) => {
            await request.onFinish?.({
              text,
              steps,
              totalUsage,
              usage: totalUsage,
              reasoning
            })
          }
        : undefined
    })

    const stream = adapter.stream(runner.events)
    let firstChunkLogged = false
    const wrappedStream = this.wrapStream(stream, {
      onAbort: request.onAbort,
      abortSignal: request.abortSignal,
      adapter,
      cleanup: async () => {
        // SA-117 DL-117-06: run end is credential end, on every exit — a finished stream, a
        // Stop (the iterator's `return`), a timeout, or a thrown error.
        try {
          await revokeRunCredentialOnce()
          if (runner.cleanup) await runner.cleanup()
        } finally {
          // BL-496: a card still waiting ends with its run (its helper is gone), and every
          // "needs you" mark this run's cards set is taken back, even when cleanup threw.
          if (wantsPermissionPrompt && request.sessionId && request.messageId) {
            await endClaudeApprovalRunForReply(request.sessionId, request.messageId)
          }
        }
      },
      onFirstChunk: () => {
        if (firstChunkLogged) return
        firstChunkLogged = true
        logger.debug('[ClaudeBridge] First Claude chunk ready', {
          elapsedMs: Date.now() - requestStart,
          transport: runner.transport
        })
      }
    })

    return {
      // Canonical AI SDK 7 name plus the legacy alias, mirroring the SDK's own
      // deprecated fullStream alias so no reader silently diverges.
      stream: wrappedStream,
      fullStream: wrappedStream,
      // SA-114 P2 (DL-114-08): the running turn's steer channel. send-routed reads it the
      // moment this call resolves — the child is already spawned by then — and registers it
      // as the session's steer transport for as long as the turn lives.
      __steer: runner.steer ?? null,
      __steerLane: runner.steer ? ('claude' as const) : null,
      __transport: runner.transport,
      // BL-287: the Claude process, so the Subagent runner can wait for its exit.
      __cliProcess: runner.process ?? null,
      __detectToolSource: adapter.getToolMetadataResolver(),
      __rawEvents: adapter.getRawEvents(),
      // BL-1362: accounting only (send-routed's `delegated` summary); filled as the run streams.
      __helperDelegatedSteps: adapter.getHelperDelegatedSteps(),
      __runtimeInfo: {
        runtimeId: 'claude',
        providerId: 'anthropic-claude-cli',
        connectionId: 'claude-cli',
        modelName: resolvedModel ?? null,
        transport: 'claude-cli',
        workingDirectory
      }
    }
  }

  private async loadAgentRecord(agentId?: string): Promise<Record<string, any> | null> {
    if (!agentId) return null

    try {
      return await redis.execute(async (client) => {
        return (await client.json.get(`agent:${agentId}`)) as Record<string, any> | null
      })
    } catch (error) {
      console.error('[ClaudeBridge] Failed to load agent record', error)
      return null
    }
  }

  private resolveAgentPermissions(agent: Record<string, any> | null) {
    const allowFileEditsRaw =
      agent?.ai_permissions?.allow_file_edits ?? agent?.ai_permissions?.allowFileEdits
    const allowNetworkRaw =
      agent?.ai_permissions?.allow_network_commands ?? agent?.ai_permissions?.allowNetworkCommands

    return {
      allowFileEdits: allowFileEditsRaw === undefined ? null : Boolean(allowFileEditsRaw),
      allowNetwork: allowNetworkRaw === undefined ? null : Boolean(allowNetworkRaw)
    }
  }

  private async resolveContextGuardConfig(params: {
    agent: Record<string, any> | null
    model: string | null
    selection?: CliContextSelection
  }): Promise<ClaudeContextGuardConfig> {
    const threshold = resolveClaudeContextGuardThreshold()
    const selection = params.selection?.model === params.model ? params.selection : null
    const disableClaude1M = claudeContextCappedByEnvironment(params.model)

    let presetContextWindow: number | null = null
    const presetId =
      typeof params.agent?.primary_model_preset_id === 'string' &&
      params.agent.primary_model_preset_id.trim().length > 0
        ? params.agent.primary_model_preset_id.trim()
        : null
    if (selection) {
      presetContextWindow = selection.presetContextWindow
    } else if (presetId) {
      try {
        const preset = (await redis.get(`model:${presetId}`)) as SavedModel | null
        const selection = resolveRuntimeModelSelection({
          preset: preset && typeof preset === 'object' ? preset : null
        })
        presetContextWindow = selection.contextWindow
      } catch (error) {
        console.warn('[ClaudeBridge] Failed to load model preset for context guard', error)
      }
    }

    const matched = selection ? matchingCliContextReport(selection.priorReport, selection.settingsKey) : null
    const reported = matched?.runtime === 'claude' && matched.model === (params.model ?? 'default') &&
      Boolean(matched.disableClaude1M) === disableClaude1M ? matched : null
    return {
      contextWindow: resolveClaudeContextWindow({
        presetContextWindow,
        model: params.model,
        disableClaude1M,
        reported
      }),
      threshold,
      model: params.model,
      presetContextWindow,
      disableClaude1M,
      reported
    }
  }

  private sanitizeToolName(name: string) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  private normalizeToolName(name: string) {
    return this.sanitizeToolName(name.trim())
  }

  /**
   * The full names of this primary's Subagent tools, for `--allowedTools` and the Plan-mode
   * allow list. BL-153: they come from the same `cliSubagentToolNames.ts` rule the Claude
   * profile registers the bridge under and the DCM roster prints (bounded server segment
   * and tool key), never from `buildManagedGatewayId`. A name the profile does not register
   * allows nothing, so a Subagent was denied in Plan mode and asked for approval elsewhere.
   */
  private resolveSubagentPlanAllowTools(params: {
    agentId?: string | null
    agentSlug?: string | null
    assignedSubagents?: any[] | null
  }) {
    const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : ''
    if (!agentId) return []

    const candidates = Array.isArray(params.assignedSubagents) ? params.assignedSubagents : []
    if (candidates.length === 0) return []

    const agent = { id: agentId, slug: params.agentSlug ?? null }
    const usedKeys = new Map<string, string>()
    const toolNames: string[] = []

    for (const entry of candidates) {
      const subagent =
        typeof entry === 'string' && entry.trim().length > 0
          ? { id: entry }
          : entry && typeof entry === 'object'
            ? entry
            : null
      if (!subagent) continue

      const key = resolveCliSubagentToolKey(subagent)
      const label =
        typeof subagent.id === 'string' && subagent.id.trim()
          ? subagent.id.trim()
          : typeof subagent.displayName === 'string' && subagent.displayName.trim()
            ? subagent.displayName.trim()
            : key
      const existing = usedKeys.get(key)
      if (existing) {
        throw buildSubagentSlugCollisionError(key, existing, label)
      }
      usedKeys.set(key, label)

      const reference = buildCliSubagentMcpToolReference(agent, subagent)
      if (reference) toolNames.push(reference.fullToolName)
    }

    return toolNames.sort()
  }

  private async resolveMode4InternalControlAllowTools(params: {
    userId?: string | null
    agentId?: string | null
    providerSettings?: Record<string, any> | null
    selectedCliToolIds?: string[] | null
  }) {
    const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : ''
    if (!agentId) {
      return {
        allowTools: [] as string[],
        disallowTools: [] as string[]
      }
    }

    const nativeToolSettings = resolveNativeToolSettings(params.providerSettings ?? null)
    const cliToolScope = await resolveCliToolSelectionScope({
      userId: params.userId ?? '',
      agentId,
      // The run's server-resolved list (BL-686); absent reads the agent's saved list.
      cliToolScope: params.selectedCliToolIds ?? undefined
    })
    const hasCliTools = cliToolScope.toolIds.length > 0
    const enabledHelperTools = resolveEnabledMode4InternalHelperTools(nativeToolSettings, {
      hasCliTools
    })
    const enabledSet = new Set(enabledHelperTools)
    // BL-5: the same fixed server name both profile managers register the helper bridge under.
    // A deny list naming any other server would deny nothing, and Claude would gain the
    // retained helpers (`cliHelperServerParity.test.ts`).
    const toManagedToolName = (toolName: string) => buildCliHelperMcpToolName(toolName)

    return {
      allowTools: enabledHelperTools.map(toManagedToolName),
      disallowTools: MODE4_INTERNAL_HELPER_TOOL_NAMES
        .filter((toolName) => !enabledSet.has(toolName))
        .map(toManagedToolName)
    }
  }

  private async resolveManagedMcpToolDenyList(params: {
    userId?: string
    gatewayToolMap?: Record<string, string[]> | null
  }) {
    // Dynamic MCP-only mode: gateway tools are not exposed directly in managed mode,
    // so no broad MCP tool deny matrix is required.
    return []
  }

  private async resolveManagedMcpToolAllowList(params: {
    userId?: string
    gatewayToolMap?: Record<string, string[]> | null
  }) {
    if (!params.userId || !params.gatewayToolMap) return []

    let gateways: MCPGateway[]
    try {
      gateways = await mcpGatewayService.list(params.userId)
    } catch (error) {
      console.warn('[ClaudeBridge] Failed to load MCP gateways for tool scoping', error)
      return []
    }

    const gatewayIds = new Set(Object.keys(params.gatewayToolMap))
    if (gatewayIds.size === 0) return []

    const allowed = new Set<string>()

    for (const gateway of gateways) {
      if (!gatewayIds.has(gateway.id)) continue

      const managedId = buildManagedGatewayId(gateway.id, gateway.slug)
      const enabledTools = (params.gatewayToolMap[gateway.id] ?? [])
        .map((name) => this.normalizeToolName(name))
        .filter((name) => !isMode4InternalHelperTool(name))
        .filter((name) => name.length > 0)

      for (const toolName of enabledTools) {
        allowed.add(`mcp__${managedId}__${toolName}`)
      }
    }

    return Array.from(allowed)
  }

  private async resolveWorkingDirectory(params: {
    userId?: string
    projectPath?: string | null
    claudeSettings?: ReturnType<typeof buildClaudeRuntimeSettings> | null
  }) {
    const candidates: Array<string | null | undefined> = []
    const override =
      params.claudeSettings?.workingDirectoryMode === 'custom'
        ? params.claudeSettings?.customWorkingDirectory?.trim()
        : ''
    if (override) {
      candidates.push(override)
    }

    if (params.projectPath && params.projectPath.trim().length > 0) {
      candidates.push(params.projectPath.trim())
    }

    if (params.userId) {
      try {
        const preferences = await redis.getProjectPreferences(params.userId)
        if (preferences?.default_workspace_path?.trim()) {
          candidates.push(preferences.default_workspace_path.trim())
        }
      } catch (error) {
        console.error('[ClaudeBridge] Failed to load project preferences', error)
      }
    }

    candidates.push(os.homedir())

    for (const candidate of candidates) {
      const resolved = await this.ensureValidWorkingDirectory(candidate)
      if (resolved) return resolved
    }

    return os.homedir()
  }

  private async ensureValidWorkingDirectory(candidate?: string | null): Promise<string | null> {
    if (!candidate) return null
    const trimmed = candidate.trim()
    if (!trimmed) return null

    const resolved = path.resolve(trimmed)
    if (this.isPackagedRuntimePath(resolved)) {
      console.warn('[ClaudeBridge] Refusing to use packaged app runtime as Claude working directory', {
        candidate: resolved
      })
      return null
    }
    try {
      const stats = await fs.stat(resolved)
      if (stats.isDirectory()) return resolved
      const parent = path.dirname(resolved)
      if (this.isPackagedRuntimePath(parent)) {
        console.warn('[ClaudeBridge] Refusing to use packaged app runtime parent as Claude working directory', {
          candidate: resolved,
          parent
        })
        return null
      }
      const parentStats = await fs.stat(parent)
      if (parentStats.isDirectory()) {
        console.warn('[ClaudeBridge] Working directory is not a folder', {
          candidate: resolved,
          fallback: parent
        })
        return parent
      }
    } catch {
      console.warn('[ClaudeBridge] Working directory does not exist', { candidate: resolved })
    }

    return null
  }

  private isPackagedRuntimePath(candidate: string) {
    const normalized = path.resolve(candidate)
    return normalized.includes('.app/Contents/Resources/runtime')
  }

  private buildCliAllowedTools(
    options: Pick<ClaudeRunOptions, 'permissionMode' | 'allowedTools' | 'allowedMcpTools' | 'planAllowedTools'>
  ) {
    // Plan only pre-allows the server-resolved assigned Subagents. Ordinary user
    // and managed MCP allows would otherwise bypass Plan's permission boundary.
    const tools = options.permissionMode === 'plan'
      ? options.planAllowedTools ?? []
      : [
          ...(options.allowedTools ?? []),
          ...(options.allowedMcpTools ?? []),
          ...(options.planAllowedTools ?? [])
        ]
    return Array.from(
      new Set(
        tools
          .map((tool) => tool.trim())
          .filter((tool) => tool.length > 0)
      )
    )
  }

  private async buildStreamJsonInput(
    prompt: string,
    images?: Array<{ url: string; alt?: string }>
  ) {
    const content: Array<Record<string, any>> = [{ type: 'text', text: prompt }]
    const imageBlocks = await this.buildImageBlocks(images)
    content.push(...imageBlocks)

    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content
      }
    })
  }

  private async buildImageBlocks(images?: Array<{ url: string; alt?: string }>) {
    if (!images?.length) return []

    const blocks: Array<Record<string, any>> = []

    for (const image of images) {
      if (!image?.url) continue
      const source = await this.buildImageSource(image.url)
      if (!source) continue

      if (image.alt && image.alt.trim().length > 0) {
        blocks.push({ type: 'text', text: `Image: ${image.alt.trim()}` })
      }

      blocks.push({ type: 'image', source })
    }

    return blocks
  }

  private async buildImageSource(url: string) {
    const trimmed = url.trim()
    if (!trimmed) return null

    if (trimmed.startsWith('https://')) {
      return { type: 'url', url: trimmed }
    }

    const dataUrlMatch = trimmed.match(/^data:(image\/[^;]+);base64,(.+)$/)
    if (dataUrlMatch?.[1] && dataUrlMatch?.[2]) {
      return {
        type: 'base64',
        media_type: dataUrlMatch[1],
        data: dataUrlMatch[2]
      }
    }

    // Claude Code requires HTTPS URLs for `source.type=url`. If we have a non-HTTPS URL (or anything else),
    // fall back to base64 so images still work in local dev setups.
    try {
      const res = await fetch(trimmed)
      if (!res.ok) {
        console.warn('[ClaudeBridge] Failed to fetch image for Claude stream-json input', {
          url: trimmed,
          status: res.status
        })
        return null
      }

      const mediaTypeRaw = res.headers.get('content-type') || 'image/jpeg'
      const mediaType = mediaTypeRaw.split(';')[0]?.trim() || 'image/jpeg'
      const array = await res.arrayBuffer()
      const data = Buffer.from(array).toString('base64')

      return {
        type: 'base64',
        media_type: mediaType,
        data
      }
    } catch (error) {
      console.warn('[ClaudeBridge] Failed to download image for Claude stream-json input', trimmed, error)
      return null
    }
  }

  private async runViaCli(prompt: string, options: ClaudeRunOptions): Promise<ClaudeRunner> {
    const status = await detectClaudeCliStatus()
    if (!status.available) {
      throw new Error(
        status.error ||
          'Claude Code CLI is not installed or not authenticated. Install it and run `claude auth login`.'
      )
    }
    // BL-268: a Claude Code older than the one Batshit installs may refuse newer models.
    warnIfCliOlderThanPinned('claude', status)

    const args = [
      '--print',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
      // SA-114 P2 (DL-114-08): re-emit stdin user messages on stdout so Batshit can tell
      // when the CLI actually HANDED a steered line to the model. P0 measured the echo
      // firing 2-6 ms after the tool result that precedes delivery — at consumption, not at
      // acceptance — which is the only honest moment to call a steer delivered.
      '--replay-user-messages'
    ]

    // BL-389: Batshit owns the chat, so a managed turn (a primary's, a Subagent's, or a
    // Worker's) never lets Claude Code save its own session copy. Without this flag every turn
    // wrote a `.jsonl` of the whole compiled prompt (system prompt plus the conversation) into
    // the user's own `~/.claude/projects/<cwd>/`, where deleting the chat or the agent never
    // reached it. Batshit never resumes a Claude session. `--print` only, which every run is.
    if (options.configScope === 'managed') {
      args.push('--no-session-persistence')
    }

    if (options.model && !options.model.includes('claude-cli')) {
      args.push('--model', options.model)
    }

    const permissionBlockReason = options.permissionMode
      ? getClaudePermissionModeRuntimeBlockReason(options.permissionMode)
      : null
    if (permissionBlockReason) {
      throw new Error(permissionBlockReason)
    }

    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode)
    }

    if (options.permissionPromptTool) {
      args.push('--permission-prompt-tool', options.permissionPromptTool)
    }

    if (options.disallowedTools && options.disallowedTools.length > 0) {
      const list = options.disallowedTools
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
      if (list.length > 0) {
        args.push('--disallowedTools', list.join(','))
      }
    }

    const list = this.buildCliAllowedTools(options)
    if (list.length > 0) {
      args.push('--allowedTools', list.join(','))
    }

    // BL-270: a managed Plan-mode run may not write its plan file (the user's plans folder is
    // denied), so it is told to keep the whole plan in its reply, which Batshit keeps. Without
    // the note the model asked the user to allow the write instead (measured on 2.1.280).
    const planNote =
      options.configScope === 'managed' && options.permissionMode === 'plan'
        ? CLAUDE_MANAGED_PLAN_MODE_NOTE
        : null
    const appendedPrompt = [
      options.systemPromptMode === 'append' ? options.systemPrompt : null,
      planNote
    ]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n\n')
    if (options.systemPromptMode === 'replace' && options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt)
    } else if (options.systemPromptMode === 'replace_file' && options.systemPromptFile) {
      args.push('--system-prompt-file', options.systemPromptFile)
    }
    // Claude Code combines an append flag with either replacement flag (CLI reference).
    if (appendedPrompt) {
      args.push('--append-system-prompt', appendedPrompt)
    }

    if (options.chromeEnabled === true) {
      args.push('--chrome')
    } else if (options.chromeEnabled === false) {
      args.push('--no-chrome')
    }

    // BL-498: an empty array is the "no sources" case (project instructions off), not "omit
    // the flag". Omitting `--setting-sources` does not mean "load nothing" to Claude Code —
    // it means "load the default sources" (user, project, AND local), so a managed run with
    // project instructions off used to fall through to the user's own `~/.claude/settings.json`
    // (hooks, plugins, allow rules, user CLAUDE.md). The verified fix, read from the installed
    // Claude Code CLI's own bundled source (`Fmo`, its `--setting-sources` parser): an explicit
    // empty string is a valid value and means "no sources" — the exact value Claude Code's own
    // `--restricted` startup path passes internally. So the flag is always passed with an
    // explicit value whenever the caller set one, never left out to fall back to CLI defaults.
    if (options.settingSources !== undefined) {
      args.push('--setting-sources', options.settingSources.join(','))
    }

    if (options.settingsPath) {
      args.push('--settings', options.settingsPath)
    }

    if (options.mcpConfigPath) {
      args.push('--mcp-config', options.mcpConfigPath)
      args.push('--strict-mcp-config')
    }

    if (options.pluginDirs && options.pluginDirs.length > 0) {
      for (const dir of options.pluginDirs) {
        args.push('--plugin-dir', dir)
      }
    }

    if (options.addDirectories) {
      for (const dir of options.addDirectories) {
        args.push('--add-dir', dir)
      }
    }

    const runAsIdentity = resolveClaudeRunAsIdentity()
    const envVars = buildClaudeRunChildEnv(options, process.env, runAsIdentity)
    const childProcessOptions = buildClaudeChildProcessOptions(runAsIdentity)
    if (typeof options.maxThinkingTokens === 'number' && options.maxThinkingTokens > 0) {
      envVars.MAX_THINKING_TOKENS = String(options.maxThinkingTokens)
    }
    if (options.userId) {
      envVars.BATSHIT_USER_ID = options.userId
    }
    if (options.agentId) {
      envVars.BATSHIT_AGENT_ID = options.agentId
    }
    if (options.approvalMode) {
      envVars.BATSHIT_CLAUDE_PERMISSION_MODE = options.approvalMode
    }
    if (options.autoAllowTools) {
      envVars.BATSHIT_CLAUDE_AUTO_ALLOW_TOOLS = JSON.stringify(options.autoAllowTools)
    }
    if (options.allowedTools) {
      envVars.BATSHIT_CLAUDE_ALLOWED_TOOLS = JSON.stringify(options.allowedTools)
    }
    if (options.disallowedTools) {
      envVars.BATSHIT_CLAUDE_DENIED_TOOLS = JSON.stringify(options.disallowedTools)
    }
    if (options.allowedMcpTools) {
      envVars.BATSHIT_CLAUDE_ALLOWED_MCP_TOOLS = JSON.stringify(options.allowedMcpTools)
    }
    if (options.planAllowedTools) {
      envVars.BATSHIT_CLAUDE_PLAN_ALLOW_TOOLS = JSON.stringify(options.planAllowedTools)
    }
    if (options.allowedDirs) {
      envVars.BATSHIT_CLAUDE_ALLOWED_DIRS = JSON.stringify(options.allowedDirs)
    }
    if (options.workingDirectory) {
      envVars.BATSHIT_CLAUDE_WORKDIR = options.workingDirectory
    }
    for (const [key, value] of Object.entries(options.managedStdioEnv ?? {})) {
      envVars[key] = value
    }
    // These identify this run's approval context and must never come from the
    // parent process or a managed gateway's environment.
    delete envVars.BATSHIT_SESSION_ID
    delete envVars.BATSHIT_MESSAGE_ID
    if (options.sessionId) {
      envVars.BATSHIT_SESSION_ID = options.sessionId
    }
    if (options.messageId) {
      envVars.BATSHIT_MESSAGE_ID = options.messageId
    }
    stripHostOperatorAuthorityFromChildEnv(envVars)

    const claudeExecutable = status.executable || resolveClaudeCliExecutable(envVars)
    logger.debug('[ClaudeBridge CLI] Executing claude', JSON.stringify({
      executable: claudeExecutable,
      version: status.version ?? null,
      source: status.source ?? null,
      runAsUid: runAsIdentity.uid ?? null,
      runAsUser: runAsIdentity.user ?? null,
      args: redactClaudeCliArgsForLog(args)
    }))

    const child = spawn(claudeExecutable, args, {
      cwd: options.workingDirectory,
      env: envVars,
      ...childProcessOptions,
      signal: options.signal
    })

    // SA-114 P2 (DL-114-08): stdin stays OPEN for the whole run. Closing it after the
    // prompt is what made Batshit unable to steer at all — the frame the CLI wants was
    // already right, the pipe was just shut. The run's fence moves to the first `result`
    // (AMD-114-01), which `createCliEventIterator` owns: P0 measured that with stdin open
    // the CLI sits waiting after `result` (20.0 s to 45.0 s in scenario A) instead of
    // exiting, so ending stdin there is now mandatory rather than tidy.
    if (child.stdin) {
      child.stdin.write(`${prompt}\n`)
    }

    const steersAwaitingEcho: Array<{ steerIds: string[]; text: string }> = []

    const steer = async (payload: {
      steerIds: string[]
      text: string
    }): Promise<boolean> => {
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false
      if (child.exitCode !== null || child.killed) return false
      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: payload.text }] }
      })
      try {
        stdin.write(`${line}\n`)
      } catch (error) {
        console.warn('[ClaudeBridge CLI] Could not write a steer to stdin', error)
        return false
      }
      // Matched by EXACT text when the echo arrives, because `--replay-user-messages`
      // replays EVERY user line including the turn's original prompt.
      steersAwaitingEcho.push({ steerIds: [...payload.steerIds], text: payload.text })
      return true
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    })
    // Attached HERE, at spawn, not when the event iterator first runs (2026-09-18). A Stop can
    // kill the child before anyone reads its events; by then the readline is closed, and
    // iterating a closed readline waits forever, and `close` has already fired. Measured: Stop
    // 0.3 s into a run, and the reply's request never ended
    // (`_local/stopfix-proof/before-claude-stop-300.json`). Both buffer what they see.
    const lines = rl[Symbol.asyncIterator]()
    const childClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }))
      }
    )

    let stderrBuffer = ''
    const baseEvents = this.createCliEventIterator(
      rl,
      lines,
      childClosed,
      child,
      () => stderrBuffer,
      options.signal,
      steersAwaitingEcho
    )

    const guard = options.contextGuard ?? null
    if (guard) {
      logger.debug('[ClaudeBridge CLI] Context guard active', {
        contextWindow: guard.contextWindow,
        threshold: guard.threshold
      })
    }
    const events = guard
      ? applyClaudeContextGuard(baseEvents, {
          ...guard,
          onTrip: (stopMessage) => {
            console.warn('[ClaudeBridge CLI] Context guard stopping Claude run', { stopMessage })
            rl.close()
            if (child.exitCode === null && !child.killed) {
              child.kill('SIGTERM')
            }
            const killTimer = setTimeout(() => {
              try {
                if (child.exitCode === null) child.kill('SIGKILL')
              } catch {
                // Child exited between the check and the kill — nothing to stop.
              }
            }, GUARD_KILL_GRACE_MS)
            killTimer.unref?.()
          }
        })
      : baseEvents

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderrBuffer += text
      if (text.trim().length) {
        console.warn('[ClaudeBridge CLI]', text.trim())
      }
    })

    child.once('error', (error) => {
      const isAbortError =
        (error as { name?: string; code?: string })?.name === 'AbortError' ||
        (error as { code?: string })?.code === 'ABORT_ERR'
      if (isAbortError && options.signal?.aborted) {
        return
      }
      console.error('[ClaudeBridge CLI] Spawn error', error)
    })

    const cleanup = async () => {
      rl.close()
      child.removeAllListeners()
      if (!child.killed) {
        child.kill()
      }
    }

    return {
      transport: 'cli',
      events,
      cleanup,
      steer,
      process: child
    }
  }

  private resolveCliModel(requestModel?: string | null, settingsModel?: string | null) {
    const settings = typeof settingsModel === 'string' ? settingsModel.trim() : ''
    if (settings) return settings

    const request = typeof requestModel === 'string' ? requestModel.trim() : ''
    if (!request) return null
    if (request.toLowerCase().includes('claude-cli')) return null
    return request
  }

  private async resolveManagedStdioEnv(
    userId: string,
    gatewayToolMap?: Record<string, string[]> | null
  ): Promise<Record<string, string>> {
    if (!gatewayToolMap) return {}

    const gatewayIds = Object.keys(gatewayToolMap)
    if (gatewayIds.length === 0) return {}

    const gateways = await mcpGatewayService.list(userId)
    const values: Record<string, string> = {}

    for (const gateway of gateways) {
      if (!gatewayIds.includes(gateway.id) || !isStdioGateway(gateway)) continue
      Object.assign(values, await resolveManagedStdioEnvironmentValues({ gateway, userId }))
    }

    return values
  }

  /**
   * SA-114 P2 (AMD-114-01) — the run's fence, and the steer echo.
   *
   * Two things changed here, and they are the same fact seen from two sides. With stdin
   * kept open (DL-114-08) the CLI no longer exits after `result`: P0 watched it sit for the
   * full 25-second grace in scenario A. Worse, a line the CLI had already READ from stdin
   * but not consumed starts a SECOND turn in the same process after the first `result` —
   * and scenario C proved that ending stdin at `result` does not prevent it, because the
   * pipe was closed after the read. So the first `result` is the end of the run: stop
   * consuming stdout, end stdin, and kill the child outright when a written steer has not
   * been echoed, which is exactly the state that would produce that second turn. Every
   * unechoed steer is then promoted server-side (DL-114-07), so nothing typed is lost.
   *
   * The echo itself is the delivery signal: `--replay-user-messages` re-emits a stdin user
   * line when the CLI HANDS it to the model, 2-6 ms after the preceding tool result. It is
   * matched by exact text and turned into one synthetic event, which the adapter maps to a
   * `steer` chunk and send-routed writes into the transcript at that position.
   */
  private async *createCliEventIterator(
    rl: readline.Interface,
    /** `rl`'s line iterator, made at spawn: iterating a readline created later hangs if closed. */
    lines: AsyncIterableIterator<string>,
    /**
     * F-P2-2 (SA-114 review): captured from the START of the run, never registered after
     * the loop. The loop now ends at the first `result`, and stdin is ended before that
     * event is yielded — so the CLI can exit, and `close` can fire, while the consumer still
     * holds the `result` and this generator is suspended at the yield. A listener added only
     * after the loop would miss that close and the wait below would never resolve. The start
     * of the run is the SPAWN, not this generator's first step (2026-09-18): a child killed
     * by an early Stop closes before anyone iterates. Resolve-only on purpose: a consumer that
     * stops pulling at `finish` never awaits this, and a rejected promise nobody awaits is an
     * unhandled rejection.
     */
    childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    child: import('node:child_process').ChildProcess,
    getStderr: () => string,
    abortSignal?: AbortSignal,
    steersAwaitingEcho: Array<{ steerIds: string[]; text: string }> = []
  ): AsyncGenerator<any> {
    let killedAtResult = false
    const endStdin = () => {
      try {
        if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.end()
        }
      } catch {
        // The child exited between the check and the call — nothing left to close.
      }
    }
    const matchSteerEcho = (event: any): string[] | null => {
      if (steersAwaitingEcho.length === 0) return null
      if (event?.type !== 'user') return null
      // BL-1366: a defensive closure. The echo of a stdin line is the main thread's (2.1.296
      // writes it with `parent_tool_use_id: null`), while Claude Code's own helper model's
      // messages carry the Agent call's id (BL-501). Without this, a helper's text-only user
      // message whose words equalled a pending steer would be taken as its echo. No vendor path
      // that sends such a message is known; this only keeps the two apart, like the adapter.
      if (event?.parent_tool_use_id) return null
      const content = event?.message?.content
      if (!Array.isArray(content)) return null
      // A tool result is also a `user` event. Only a replayed steer is text-only.
      if (content.some((block: any) => block?.type === 'tool_result')) return null
      const text = content
        .map((block: any) => (block && typeof block.text === 'string' ? block.text : ''))
        .join('')
      if (!text) return null
      const index = steersAwaitingEcho.findIndex((entry) => entry.text === text)
      if (index === -1) return null
      const [matched] = steersAwaitingEcho.splice(index, 1)
      return matched.steerIds
    }

    try {
      for await (const line of lines) {
        if (!line) continue
        let parsed: any
        try {
          parsed = JSON.parse(line)
        } catch (error) {
          console.error('[ClaudeBridge CLI] Failed to parse event line', error)
          continue
        }

        const echoed = matchSteerEcho(parsed)
        if (echoed) {
          yield { type: 'batshit_steer_delivered', steer_ids: echoed }
        }

        // The fence runs BEFORE the yield, not after it. A consumer that stops pulling on
        // `result` — which send-routed's loop does, `finish` sets `shouldBreakStream` — would
        // never resume this generator, so anything written after the yield is code that may
        // simply not run.
        const isResult = parsed?.type === 'result'
        if (isResult) {
          endStdin()
          if (steersAwaitingEcho.length > 0) {
            // A steer the CLI read from stdin but never handed to the model. Left running,
            // that is the second turn scenario C measured — a whole extra answer appended to
            // a reply the user already has. The message is not lost: it is still in
            // Batshit's steer inbox, and the end of the turn promotes it (DL-114-07).
            killedAtResult = true
            console.warn(
              '[ClaudeBridge CLI] Ending the run at `result` with an unconsumed steer; the message is promoted to the next turn',
              { unechoedSteers: steersAwaitingEcho.length }
            )
            try {
              if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
            } catch {
              // Already gone.
            }
          }
        }

        yield parsed
        if (isResult) break
      }
      // A killed child's exit code is not a failure to report: the run already produced its
      // `result` and Batshit ended it on purpose.
      if (killedAtResult) return
      const { code, signal } = await childClosed
      const aborted =
        abortSignal?.aborted === true ||
        signal === 'SIGTERM' ||
        signal === 'SIGKILL' ||
        code === 143 ||
        code === 137

      if (code === 0 || aborted) return

      throw new Error(
        `Claude CLI exited with code ${code ?? -1}: ${getStderr()?.trim() || 'No stderr output'}`
      )
    } finally {
      endStdin()
      rl.close()
    }
  }

  private wrapStream(
    stream: AsyncGenerator<any>,
    context: {
      onAbort?: NativeModeRequest['onAbort']
      abortSignal?: AbortSignal
      adapter: ClaudeEventAdapter
      cleanup?: (() => void | Promise<void>) | undefined
      onFirstChunk?: () => void
    }
  ) {
    const { onAbort, abortSignal, adapter, cleanup, onFirstChunk } = context

    if (abortSignal && onAbort) {
      abortSignal.addEventListener(
        'abort',
        () => {
          try {
            onAbort({
              steps: adapter.getIntermediateSteps()
            })
          } catch (error) {
            console.error('[ClaudeBridge] Failed to run onAbort callback', error)
          }
        },
        { once: true }
      )
    }

    const iterator = stream[Symbol.asyncIterator]()
    let cleanedUp = false

    const runCleanup = async () => {
      if (cleanedUp) return
      cleanedUp = true
      if (cleanup) {
        await cleanup()
      }
    }

    return {
      [Symbol.asyncIterator]() {
        let firstChunkEmitted = false
        return {
          next: async () => {
            let result: IteratorResult<any>
            try {
              result = await iterator.next()
            } catch (error) {
              await runCleanup()
              throw error
            }
            if (!firstChunkEmitted && !result.done && onFirstChunk) {
              firstChunkEmitted = true
              try {
                onFirstChunk()
              } catch (error) {
                console.error('[ClaudeBridge] First-chunk callback failed', error)
              }
            }
            if (result.done) {
              await runCleanup()
            }
            return result
          },
          return: async () => {
            await runCleanup()
            return iterator.return
              ? iterator.return(undefined)
              : Promise.resolve({ done: true, value: undefined })
          },
          throw: (err?: any) => (iterator.throw ? iterator.throw(err) : Promise.reject(err))
        }
      }
    }
  }
}
