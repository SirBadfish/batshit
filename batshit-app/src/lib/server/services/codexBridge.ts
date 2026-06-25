import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { env } from "$env/dynamic/private";
import { logger } from "$lib/utils/logger";
import type { ThreadEvent } from "$lib/types/codexProtocol";
import type { NativeModeRequest } from "./vercelBrain";
import { detectCodexCliStatus, resolveCodexCliExecutable } from "./codexCliStatus";
import { CodexEventAdapter } from "./codexEventAdapter";
import { redis } from "$lib/server/redis";
import {
  buildCodexRuntimeSettings,
  resolveCodexWebSearchMode,
} from "$lib/server/services/codexSettings";
import type {
  CodexRuntimeSettings,
  CodexPermissionMode,
  CodexHistoryPersistence,
} from "$lib/types/codex";
import {
  ensureManagedCodexHome,
  DOCKER_AUTH_ENV_VAR,
  N8N_INSTANCE_MCP_TOKEN_ENV,
  BATSHIT_TOKEN_ENV_VAR,
  buildAgentProfileId,
} from "$lib/server/services/codexProfileManager";
import { getDockerGatewayAuthToken } from "$lib/server/services/dockerGatewayConfig";
import { apiKeyService } from "$lib/services/apiKey.server";
import { mcpGatewayService } from "$lib/server/services/mcpGatewayService";
import {
  isStdioGateway,
  resolveManagedStdioEnvironmentValues,
} from "$lib/server/services/mcpGatewayStdio";
import { resolveCliHelperBatshitToken } from "$lib/server/services/cliHelperToken";
import {
  startCodexAppServerRun,
  type CodexAppServerThreadParams,
} from "$lib/server/services/codexAppServerLane";

type CodexRunTransport = "app-server" | "exec";

type CodexTransportLane = "app-server" | "exec";

/**
 * Managed Batshit runs default to the app-server lane so mid-run token usage
 * can drive the proactive context guard. `BATSHIT_CODEX_TRANSPORT=exec` is the
 * documented escape hatch back to one-shot `codex exec --json`. Non-managed
 * scopes (user-profile runs) stay on exec.
 */
export function resolveCodexTransportLane(
  options: { configScope?: string | null },
  processEnv: NodeJS.ProcessEnv = process.env,
): CodexTransportLane {
  if (options.configScope !== "managed") return "exec";
  const override = (processEnv.BATSHIT_CODEX_TRANSPORT ?? "").trim().toLowerCase();
  if (override === "exec") return "exec";
  return "app-server";
}

/**
 * Reuses the exec arg builder as the single source of truth for `--config`
 * overrides, then keeps only the flags `codex app-server` understands
 * (`--config`, `--enable`, `--disable`). Everything else (exec subcommand,
 * --ephemeral, --cd, --sandbox, --image, ...) is expressed through
 * thread/start params instead.
 */
export function extractAppServerSpawnArgs(execArgs: string[]): string[] {
  const spawnArgs: string[] = ["app-server"];
  for (let i = 0; i < execArgs.length; i++) {
    const arg = execArgs[i];
    if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = execArgs[i + 1];
      if (typeof value === "string") {
        spawnArgs.push(arg, value);
        i++;
      }
    }
  }
  return spawnArgs;
}

/**
 * Mirrors the exec lane's permission flags (`--sandbox`,
 * `--dangerously-bypass-approvals-and-sandbox`) onto
 * thread/start params.
 */
export function buildCodexAppServerThreadParams(
  options: Pick<
    CodexRunOptions,
    | "historyPersistence"
    | "workingDirectory"
    | "model"
    | "permissionMode"
    | "sandboxMode"
    | "approvalPolicy"
    | "configScope"
  >,
): CodexAppServerThreadParams {
  let approvalPolicy: string | undefined = options.approvalPolicy || undefined;
  let sandbox: string | undefined = options.sandboxMode || undefined;
  if (options.permissionMode === "agent") {
    approvalPolicy = approvalPolicy ?? "on-failure";
    sandbox = sandbox ?? "workspace-write";
  } else if (options.permissionMode === "agent_full") {
    approvalPolicy = "never";
    sandbox = "danger-full-access";
  }

  return {
    // Managed runs keep native history off; ephemeral threads are in-memory
    // only (no session/rollout files), preserving the exec --ephemeral hygiene.
    ephemeral: options.historyPersistence === "none",
    ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
    ...(options.model && options.configScope === "managed"
      ? { model: options.model }
      : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
}

export function getDefaultCodexWorkingDirectory(home = os.homedir()) {
  return path.join(home, ".batshit", "workspaces", "default");
}

interface CodexRunOptions {
  model?: string | null;
  permissionMode?: CodexPermissionMode;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  workingDirectory: string;
  allowFileEdits: boolean;
  allowNetwork: boolean;
  approvalPolicy: CodexRuntimeSettings["approval"];
  webSearchEnabled: boolean;
  addDirectories: string[];
  enableFeatures: string[];
  disableFeatures: string[];
  configOverrides: CodexRuntimeSettings["configOverrides"];
  defaultGateways?: string[] | null;
  profileName?: string;
  configScope: "managed" | "global";
  managedConfigHome?: string | null;
  dockerAuthToken?: string | null;
  n8nInstanceMcpToken?: string | null;
  batshitToken?: string | null;
  managedStdioEnv?: Record<string, string>;
  historyPersistence: CodexHistoryPersistence;
  serviceTier: CodexRuntimeSettings["serviceTier"];
  permissionOverridden?: boolean;
  reasoningEffort?: CodexRuntimeSettings["reasoningEffort"];
  reasoningSummary?: CodexRuntimeSettings["reasoningSummary"];
  modelSupportsReasoningSummaries?: CodexRuntimeSettings["modelSupportsReasoningSummaries"];
  signal?: AbortSignal;
  unifiedExec: boolean;
  imagePaths?: string[];
  sessionId?: string | null;
  promptCacheKey?: string | null;
  developerInstructions?: string | null;
  nativeSkillDisablePaths?: string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

interface CodexRunner {
  transport: CodexRunTransport;
  events: AsyncGenerator<ThreadEvent>;
  cleanup?: () => void | Promise<void>;
}

function mapCodexRuntimeTransport(transport: CodexRunTransport) {
  return transport === "app-server" ? "codex-app-server" : "codex-exec";
}

export interface CodexHiddenTextRequest {
  prompt: string;
  userId: string;
  agentId?: string | null;
  model?: string | null;
  providerSettings?: Record<string, any> | null;
  codexSettings?: CodexRuntimeSettings | null;
  timeoutMs?: number;
}

export interface CodexHiddenTextResult {
  text: string;
  modelLabel: string;
  modelId: string;
  transport: "cli";
  usage?: Record<string, any>;
}

const PROVIDER_DISABLED_ERROR =
  "Codex provider is disabled. Set BATSHIT_CODEX_PROVIDER_ENABLED=true and ensure the CLI is installed.";
const DATA_IMAGE_URL_REGEX = /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/gi

function redactDataImageUrlsForPrompt(value: string): string {
  if (!value || !value.toLowerCase().includes("data:image/")) return value
  return value.replace(
    DATA_IMAGE_URL_REGEX,
    (_full, mediaType: string, base64Data: string) => {
      const approxBytes = Math.max(0, Math.floor((base64Data.length * 3) / 4))
      return `[redacted ${mediaType} data URL (${approxBytes} bytes)]`
    }
  )
}

export function stringifyCodexMessageContent(content: any) {
  if (typeof content === "string") {
    return redactDataImageUrlsForPrompt(content);
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return redactDataImageUrlsForPrompt(part);
        if (part?.type === "text") return redactDataImageUrlsForPrompt(part.text ?? "");
        if (part?.type === "image_url") {
          return `Image: ${summarizeCodexImageReference(part.image_url?.url)}`;
        }
        return redactDataImageUrlsForPrompt(JSON.stringify(part));
      })
      .join("\n");
  }

  if (typeof content === "object" && content !== null) {
    return redactDataImageUrlsForPrompt(JSON.stringify(content));
  }

  return "";
}

function summarizeCodexImageReference(value: unknown): string {
  if (typeof value !== "string") return "[missing image reference]";
  const trimmed = value.trim();
  if (!trimmed) return "[empty image reference]";

  if (trimmed.toLowerCase().startsWith("data:image/")) {
    const mediaType = /^data:(image\/[^;]+);base64,/i.exec(trimmed)?.[1] ?? "image/*";
    return `[${mediaType} data URL redacted]`;
  }

  return trimmed;
}

export function buildCodexPromptFromMessages(params: {
  messages: Array<{ role?: string; content: any; name?: string }>
  images?: Array<{ url: string; alt?: string }>
}) {
  const segments = params.messages.map((message, index) => {
    const role = (message.role || "user").toUpperCase();
    const nameSuffix = message.name ? ` (${message.name})` : "";
    const header = `${role}${nameSuffix}`;
    const content = stringifyCodexMessageContent(message.content);
    return `Message ${index + 1} - ${header}\n${content}`;
  });

  if (params.images?.length) {
    const imageSummary = params.images
      .map((image, idx) => `Image ${idx + 1}: ${summarizeCodexImageReference(image.url)}`)
      .join("\n");
    segments.push(`Attached Images:\n${imageSummary}`);
  }

  return segments.join("\n\n");
}

export function buildCodexPromptPackageFromMessages(params: {
  messages: Array<{ role?: string; content: any; name?: string }>
  images?: Array<{ url: string; alt?: string }>
}) {
  const systemSegments: string[] = []
  const promptMessages: Array<{ role?: string; content: any; name?: string }> = []

  for (const message of params.messages) {
    if ((message.role || "").toLowerCase() === "system") {
      const content = stringifyCodexMessageContent(message.content).trim()
      if (content) systemSegments.push(content)
      continue
    }
    promptMessages.push(message)
  }

  const staticPromptPrefix = systemSegments.length
    ? `==== BATSHIT PRIMARY SYSTEM PROMPT ====\n\n${systemSegments.join("\n\n")}`
    : null
  const variablePrompt = buildCodexPromptFromMessages({
    messages: promptMessages,
    images: params.images,
  })

  return {
    developerInstructions: staticPromptPrefix,
    staticPromptPrefix,
    prompt: variablePrompt,
  }
}

export function buildManagedCodexPromptCacheKey(params: {
  sessionId?: string | null
  profileName?: string | null
  workingDirectory?: string | null
  model?: string | null
  developerInstructions?: string | null
  staticPromptPrefix?: string | null
}) {
  const profile = (params.profileName?.trim() || "batshit_agent").replace(/[^a-zA-Z0-9_-]/g, "_")
  const promptPrefix =
    params.staticPromptPrefix?.trim() ||
    params.developerInstructions?.trim() ||
    ""
  const staticPrefixHash = createHash("sha256")
    .update(JSON.stringify({
      model: params.model?.trim() || "",
      workingDirectory: params.workingDirectory?.trim() || "",
      staticPromptPrefix: promptPrefix,
    }))
    .digest("hex")
    .slice(0, 16)

  return `batshit:${profile}:prefix:${staticPrefixHash}`
}

export function buildCodexCliArgs(
  options: CodexRunOptions,
  params: {
    useProfileDefaults: boolean
    shouldSkipGitCheck: boolean
  }
) {
  const { useProfileDefaults, shouldSkipGitCheck } = params
  const args = ["exec", "--json"]
  const forceAgentPermissionArgs = options.permissionMode === "agent"
  const useExplicitRuntimeArgs =
    useProfileDefaults || options.ignoreUserConfig === true || forceAgentPermissionArgs
  const shouldPassExplicitModel = useExplicitRuntimeArgs || options.configScope === "managed"
  const shouldDisableDefaultCodexTools =
    options.configScope === "managed" || options.ignoreUserConfig === true
  const resolvedSandboxMode = forceAgentPermissionArgs
    ? options.sandboxMode ?? "workspace-write"
    : options.sandboxMode
  const resolvedApprovalPolicy = forceAgentPermissionArgs
    ? options.approvalPolicy ?? "on-failure"
    : options.approvalPolicy

  if (options.ignoreUserConfig) {
    args.push("--ignore-user-config")
  }
  if (options.ignoreRules) {
    args.push("--ignore-rules")
  }

  if (useProfileDefaults && options.profileName) {
    args.push("--profile", options.profileName)
  }
  if (shouldPassExplicitModel && options.model) {
    args.push("--model", options.model)
    args.push("--config", `model=${options.model}`)
  }
  if (shouldDisableDefaultCodexTools) {
    args.push("--config", "default_tools_enabled=false")
  }

  if (useExplicitRuntimeArgs || options.permissionOverridden) {
    if (resolvedSandboxMode) {
      if (useExplicitRuntimeArgs) {
        args.push("--sandbox", resolvedSandboxMode)
        args.push("--config", `sandbox_mode=${resolvedSandboxMode}`)
      } else {
        args.push("--sandbox", resolvedSandboxMode)
      }
    }
    if (useExplicitRuntimeArgs && resolvedApprovalPolicy) {
      args.push("--config", `approval_policy=${resolvedApprovalPolicy}`)
    }
    if (useExplicitRuntimeArgs) {
      args.push("--config", `web_search="${resolveCodexWebSearchMode(options.webSearchEnabled)}"`)
      if (options.reasoningEffort) {
        args.push(
          "--config",
          `model_reasoning_effort=${options.reasoningEffort}`,
        )
      }
      if (options.serviceTier === "fast") {
        args.push("--config", "service_tier=fast")
      }
    }
  }

  if (options.reasoningSummary) {
    args.push(
      "--config",
      `model_reasoning_summary=${options.reasoningSummary}`,
    )
  }
  if (typeof options.modelSupportsReasoningSummaries === "boolean") {
    args.push(
      "--config",
      `model_supports_reasoning_summaries=${options.modelSupportsReasoningSummaries}`,
    )
  }
  if (options.promptCacheKey) {
    args.push(
      "--config",
      `prompt_cache_key=${normalizeConfigOverrideValue(options.promptCacheKey)}`,
    )
  }
  if (options.developerInstructions) {
    args.push(
      "--config",
      `developer_instructions=${normalizeConfigOverrideValue(options.developerInstructions)}`,
    )
  }
  const nativeSkillDisableOverride = buildCodexNativeSkillDisableOverride(
    options.nativeSkillDisablePaths ?? [],
  )
  if (nativeSkillDisableOverride) {
    args.push("--config", nativeSkillDisableOverride)
  }

  if (options.permissionMode === "agent_full") {
    args.push("--dangerously-bypass-approvals-and-sandbox")
  }

  if (options.historyPersistence === "none") {
    args.push("--ephemeral")
  }

  if (shouldSkipGitCheck) {
    args.push("--skip-git-repo-check")
  }

  if (useProfileDefaults) {
    for (const dir of options.addDirectories) {
      args.push("--add-dir", dir)
    }

    for (const feature of options.enableFeatures) {
      args.push("--enable", feature)
    }

    for (const feature of options.disableFeatures) {
      args.push("--disable", feature)
    }

    for (const override of options.configOverrides) {
      const normalized = normalizeConfigOverrideValue(override.value)
      args.push("--config", `${override.key}=${normalized}`)
    }
  }

  if (options.workingDirectory) {
    args.push("--cd", options.workingDirectory)
  }

  if (options.imagePaths && options.imagePaths.length) {
    for (const img of options.imagePaths) {
      args.push("--image", img)
    }
  }

  return args
}

export function redactCodexCliArgsForLog(args: string[]) {
  const redacted: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    redacted.push(arg)

    if (arg !== "--config" && arg !== "-c") continue
    const next = args[index + 1]
    if (typeof next !== "string") continue

    const key = next.split("=", 1)[0]?.trim()
    if (key === "developer_instructions" || key === "skills.config") {
      redacted.push(`${key}=<redacted>`)
      index += 1
    }
  }

  return redacted
}

export class CodexBridge {
  async streamNativeMode(request: NativeModeRequest) {
    if (env.BATSHIT_CODEX_PROVIDER_ENABLED === "false") {
      throw new Error(PROVIDER_DISABLED_ERROR);
    }

    if (!request.messages?.length) {
      throw new Error("No messages provided to Codex runtime");
    }

    const codexSessionFallback =
      request.sessionId && request.userId && request.agentId
        ? {
            userId: request.userId,
            agentId: request.agentId,
            sessionId: request.sessionId,
          }
        : null;

    // Ensure Codex subagent bridge can resolve the parent sessionId reliably.
    // BATSHIT_SESSION_ID is the primary path. Redis fallback is now set-shaped:
    // it is only safe when exactly one same-user/same-agent session is active.
    if (codexSessionFallback) {
      try {
        await redis.execute(async (client) => {
          const setKey = `codex_sessions:${codexSessionFallback.userId}:${codexSessionFallback.agentId}`;
          const legacyKey = `codex_session:${codexSessionFallback.userId}:${codexSessionFallback.agentId}`;
          await client.sAdd(setKey, codexSessionFallback.sessionId);
          await client.expire(setKey, 60 * 60); // 1 hour TTL (refreshed every run)
          await client.del(legacyKey);
        });
      } catch (error) {
        console.warn("[CodexBridge] Failed to persist codex session mapping", error);
      }
    }

    const requestStart = Date.now();
    const promptPackage = buildCodexPromptPackageFromMessages({
      messages: request.messages,
      images: request.images,
    });
    const prompt = promptPackage.prompt;
    const { paths: imagePaths, cleanup: imageCleanup } =
      await this.prepareImages(request.images);
    const permissions = await this.loadAgentPermissions(request.agentId);
    const baseSandbox = this.resolveSandboxMode(permissions);
    const codexSettings: CodexRuntimeSettings =
      request.codexSettings ??
      buildCodexRuntimeSettings(request.providerSettings ?? null);
    const sandboxMode = baseSandbox
      ? this.clampSandbox(codexSettings.sandbox, baseSandbox)
      : codexSettings.sandbox;
    const allowFileEdits = sandboxMode !== "read-only";
    const allowNetwork = sandboxMode === "danger-full-access";
    const workingDirectory = await this.resolveWorkingDirectory({
      userId: request.userId,
      projectPath: request.projectPath ?? null,
      codexSettings,
    });
    const normalizedModelId = this.normalizeModelId(request.model);
    const resolvedModel =
      codexSettings.model && codexSettings.model.trim().length
        ? codexSettings.model.trim()
        : normalizedModelId;
    const profileId =
      codexSettings.profileId ??
      (request.agentId ? `batshit_agent_${request.agentId}` : null);

    const configScope = codexSettings.configScope ?? "managed";
    const managedStdioEnv =
      configScope === "managed" && request.userId
        ? await this.resolveManagedStdioEnv(
            request.userId,
            request.gatewayToolMap ?? null,
          )
        : {};
    const runProjectPath =
      typeof request.projectPath === "string" && request.projectPath.trim().length > 0
        ? request.projectPath.trim()
        : null;
    if (configScope === "managed" && runProjectPath) {
      managedStdioEnv.BATSHIT_PROJECT_PATH = runProjectPath;
    }
    const addDirectories = Array.isArray(codexSettings.addDirs)
      ? codexSettings.addDirs
      : [];
    const enableFeatures = Array.isArray(codexSettings.enableFeatures)
      ? codexSettings.enableFeatures
      : [];
    const disableFeatures = Array.isArray(codexSettings.disableFeatures)
      ? codexSettings.disableFeatures
      : [];
    const configOverrides = Array.isArray(codexSettings.configOverrides)
      ? codexSettings.configOverrides
      : [];
    let managedConfigHome: string | null = null;
    if (configScope === "managed" && request.userId) {
      try {
        managedConfigHome = await ensureManagedCodexHome({
          userId: request.userId,
          profileId,
          historyPersistence: codexSettings.historyPersistence,
        });
      } catch (error) {
        console.error(
          "[CodexBridge] Failed to prepare managed Codex config",
          error,
        );
      }
    }
    const nativeSkillDisablePaths =
      configScope === "managed"
        ? await discoverCodexNativeSkillDisablePaths({
            managedConfigHome,
            workingDirectory,
          })
        : [];

    const runOptions: CodexRunOptions = {
      model: resolvedModel,
      permissionMode: codexSettings.permissionMode,
      sandboxMode,
      workingDirectory,
      allowFileEdits,
      allowNetwork,
      approvalPolicy:
        codexSettings.permissionMode === "agent" && request.toolApprovalMode === "all"
          ? "on-failure"
          : "never",
      webSearchEnabled: codexSettings.search,
      addDirectories,
      enableFeatures,
      disableFeatures,
      configOverrides,
      defaultGateways: request.defaultGateways ?? null,
      profileName: profileId ?? undefined,
      configScope,
      managedConfigHome,
      dockerAuthToken: getDockerGatewayAuthToken() ?? null,
      n8nInstanceMcpToken: request.userId
        ? await apiKeyService.retrieve("n8n_instance_mcp_token", request.userId).catch(() => null)
        : null,
      batshitToken: await resolveCliHelperBatshitToken(request.userId ?? null),
      managedStdioEnv,
      historyPersistence: codexSettings.historyPersistence ?? "none",
      serviceTier: codexSettings.serviceTier,
      unifiedExec: codexSettings.unifiedExec,
      permissionOverridden: codexSettings.permissionOverridden,
      reasoningEffort: codexSettings.reasoningEffort,
      reasoningSummary: codexSettings.reasoningSummary,
      modelSupportsReasoningSummaries: codexSettings.modelSupportsReasoningSummaries,
      signal: request.abortSignal,
      sessionId: request.sessionId ?? null,
      promptCacheKey:
        configScope === "managed"
          ? buildManagedCodexPromptCacheKey({
              sessionId: request.sessionId,
              profileName: profileId,
              workingDirectory,
              model: resolvedModel,
              staticPromptPrefix: promptPackage.staticPromptPrefix,
            })
          : null,
      developerInstructions: promptPackage.developerInstructions,
      nativeSkillDisablePaths,
      imagePaths,
    };

    logger.debug("[CodexBridge] resolved permissions", {
      agentPermissions: permissions,
      requestedPermission: codexSettings.permissionMode,
      requestedSandbox: codexSettings.sandbox,
      sandboxMode,
      approvalPolicy: runOptions.approvalPolicy,
    });

    const runner = await this.createRunner(prompt, runOptions);

    const adapter = new CodexEventAdapter({
      request,
      transport: "cli",
      onFinish: request.onFinish
        ? async ({ text, steps, totalUsage, reasoning }) => {
            await request.onFinish!({
              text,
              steps,
              totalUsage,
              usage: totalUsage,
              reasoning,
            });
          }
        : undefined,
    });

    const stream = adapter.stream(runner.events);
    let firstChunkLogged = false;
    const wrappedStream = this.wrapStream(stream, {
      onAbort: request.onAbort,
      abortSignal: request.abortSignal,
      adapter,
      cleanup: async () => {
        if (runner.cleanup) await runner.cleanup();
        await imageCleanup();
        if (codexSessionFallback) {
          try {
            await redis.execute(async (client) => {
              const setKey = `codex_sessions:${codexSessionFallback.userId}:${codexSessionFallback.agentId}`;
              await client.sRem(setKey, codexSessionFallback.sessionId);
            });
          } catch (error) {
            console.warn("[CodexBridge] Failed to clear codex session mapping", error);
          }
        }
      },
      onFirstChunk: () => {
        if (firstChunkLogged) return;
        firstChunkLogged = true;
        logger.debug("[CodexBridge] First Codex chunk ready", {
          elapsedMs: Date.now() - requestStart,
          transport: runner.transport,
          permission: codexSettings.permissionMode,
          profile: codexSettings.profileId ?? null,
        });
      },
    });

    return {
      fullStream: wrappedStream,
      __transport: runner.transport,
      __detectToolSource: adapter.getToolMetadataResolver(),
      __rawEvents: adapter.getRawEvents?.(),
      __runtimeInfo: {
        runtimeId: "codex",
        providerId: "openai-codex",
        connectionId: "codex-cli",
        modelName: resolvedModel ?? null,
        transport: mapCodexRuntimeTransport(runner.transport),
        sandboxMode: runOptions.sandboxMode,
        allowFileEdits: permissions.allowFileEdits,
        allowNetwork: permissions.allowNetwork,
        workingDirectory: runOptions.workingDirectory,
      },
    };
  }

  async generateHiddenText(request: CodexHiddenTextRequest): Promise<CodexHiddenTextResult> {
    if (env.BATSHIT_CODEX_PROVIDER_ENABLED === "false") {
      throw new Error(PROVIDER_DISABLED_ERROR);
    }

    const prompt = request.prompt?.trim();
    if (!prompt) {
      throw new Error("No prompt provided to Codex compact worker");
    }

    const baseSettings =
      request.codexSettings ??
      buildCodexRuntimeSettings(request.providerSettings ?? null);
    const resolvedModel =
      baseSettings.model && baseSettings.model.trim().length
        ? baseSettings.model.trim()
        : this.normalizeModelId(request.model);
    if (!resolvedModel) {
      throw new Error("Codex compact worker is missing a Codex model selection.");
    }

    const profileId = request.agentId ? buildAgentProfileId(request.agentId) : null;
    let managedConfigHome: string | null = null;
    if (profileId && request.userId) {
      try {
        managedConfigHome = await ensureManagedCodexHome({
          userId: request.userId,
          profileId,
          historyPersistence: "none",
        });
      } catch (error) {
        console.warn("[CodexBridge] Failed to prepare compact worker Codex home", {
          profileId,
          error,
        });
      }
    }

    const status = await detectCodexCliStatus({
      codexHome: managedConfigHome,
    });
    if (!status.available) {
      throw new Error(
        status.error ||
          "Codex CLI is not installed or not authenticated. Use the one-click install in Agent Settings (or `npm i -g @openai/codex`), then run `codex login`.",
      );
    }

    const abortController = new AbortController();
    const timeoutMs = Math.max(30_000, Math.min(request.timeoutMs ?? 180_000, 600_000));
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const runOptions: CodexRunOptions = {
      model: resolvedModel,
      permissionMode: "chat",
      sandboxMode: "read-only",
      workingDirectory: os.tmpdir(),
      allowFileEdits: false,
      allowNetwork: false,
      approvalPolicy: "never",
      webSearchEnabled: false,
      addDirectories: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      defaultGateways: null,
      configScope: "global",
      managedConfigHome,
      dockerAuthToken: null,
      n8nInstanceMcpToken: null,
      batshitToken: null,
      managedStdioEnv: {},
      historyPersistence: "none",
      serviceTier: baseSettings.serviceTier,
      unifiedExec: baseSettings.unifiedExec,
      permissionOverridden: true,
      reasoningEffort: baseSettings.reasoningEffort,
      signal: abortController.signal,
      sessionId: null,
      imagePaths: [],
      nativeSkillDisablePaths: [],
      ignoreUserConfig: true,
      ignoreRules: true,
    };

    let runner: CodexRunner | null = null;
    let streamedText = "";
    let finishText = "";
    let usage: Record<string, any> | undefined;

    const adapterRequest: NativeModeRequest = {
      sessionId: `compact_${randomUUID()}`,
      messageId: `compact_${randomUUID()}`,
      userId: request.userId,
      agentId: request.agentId ?? undefined,
      messages: [{ role: "user", content: prompt }],
      model: resolvedModel,
      toolsEnabled: false,
      maxToolRounds: 0,
    };

    try {
      runner = await this.runViaCli(prompt, runOptions);
      const adapter = new CodexEventAdapter({
        request: adapterRequest,
        transport: "cli",
        onFinish: ({ text, totalUsage }) => {
          finishText = text;
          usage = totalUsage;
        },
      });

      for await (const chunk of adapter.stream(runner.events)) {
        if (chunk.type === "text-delta") {
          streamedText += chunk.text;
        } else if (chunk.type === "finish") {
          usage = chunk.totalUsage ?? chunk.usage ?? usage;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(`Codex compact worker timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (runner?.cleanup) {
        await runner.cleanup();
      }
    }

    const text = (finishText || streamedText).trim();
    if (!text) {
      throw new Error("Codex compact worker returned an empty summary.");
    }

    return {
      text,
      modelLabel: `Codex CLI ${resolvedModel}`,
      modelId: resolvedModel,
      transport: "cli",
      usage,
    };
  }

  private async loadAgentPermissions(agentId?: string) {
    if (!agentId) {
      return {
        allowFileEdits: null,
        allowNetwork: null,
      };
    }

    try {
      const agent = await redis.execute(async (client) => {
        return (await client.json.get(`agent:${agentId}`)) as Record<
          string,
          any
        > | null;
      });

      const allowFileEditsRaw =
        agent?.ai_permissions?.allow_file_edits ??
        agent?.ai_permissions?.allowFileEdits;
      const allowNetworkRaw =
        agent?.ai_permissions?.allow_network_commands ??
        agent?.ai_permissions?.allowNetworkCommands;

      return {
        allowFileEdits:
          allowFileEditsRaw === undefined ? null : Boolean(allowFileEditsRaw),
        allowNetwork:
          allowNetworkRaw === undefined ? null : Boolean(allowNetworkRaw),
      };
    } catch (error) {
      console.error("[CodexBridge] Failed to load agent permissions", error);
      return {
        allowFileEdits: null,
        allowNetwork: null,
      };
    }
  }

  private resolveSandboxMode(permissions: {
    allowFileEdits: boolean | null;
    allowNetwork: boolean | null;
  }) {
    if (permissions.allowNetwork === true) return "danger-full-access";
    if (permissions.allowFileEdits === true) return "workspace-write";
    if (permissions.allowNetwork === false || permissions.allowFileEdits === false) {
      return "read-only";
    }
    return null;
  }

  private async resolveWorkingDirectory(params: {
    userId?: string;
    projectPath?: string | null;
    codexSettings?: CodexRuntimeSettings | null;
  }) {
    const candidates: Array<string | null | undefined> = [];
    const override =
      params.codexSettings?.workingDirectoryMode === "custom"
        ? params.codexSettings?.customWorkingDirectory?.trim()
        : "";
    if (override) {
      candidates.push(override);
    }

    if (params.projectPath && params.projectPath.trim().length > 0) {
      candidates.push(params.projectPath.trim());
    }

    if (params.userId) {
      try {
        const preferences = await redis.getProjectPreferences(params.userId);
        if (preferences?.default_workspace_path?.trim()) {
          candidates.push(preferences.default_workspace_path.trim());
        }
      } catch (error) {
        console.error(
          "[CodexBridge] Failed to load project preferences",
          error,
        );
      }
    }

    if (env.BATSHIT_CODEX_WORKDIR) {
      candidates.push(env.BATSHIT_CODEX_WORKDIR);
    }

    const defaultWorkspace = await this.ensureDefaultWorkingDirectory();
    if (defaultWorkspace) {
      candidates.push(defaultWorkspace);
    }

    for (const candidate of candidates) {
      const resolved = await this.ensureValidWorkingDirectory(candidate);
      if (resolved) return resolved;
    }

    throw new Error(
      "No valid Codex working directory is available. Choose a Project folder or set a default workspace in Projects.",
    );
  }

  private async ensureDefaultWorkingDirectory() {
    const fallback = getDefaultCodexWorkingDirectory();
    try {
      await fs.mkdir(fallback, { recursive: true });
      return fallback;
    } catch (error) {
      console.error("[CodexBridge] Failed to create default Codex working directory", {
        fallback,
        error,
      });
      return null;
    }
  }

  private async ensureValidWorkingDirectory(
    candidate?: string | null,
  ): Promise<string | null> {
    if (!candidate) return null;
    const trimmed = candidate.trim();
    if (!trimmed) return null;

    const resolved = path.resolve(trimmed);
    if (this.isPackagedRuntimePath(resolved)) {
      console.warn("[CodexBridge] Refusing to use packaged app runtime as Codex working directory", {
        candidate: resolved,
      });
      return null;
    }
    try {
      const stats = await fs.stat(resolved);
      if (stats.isDirectory()) return resolved;
      const parent = path.dirname(resolved);
      if (this.isPackagedRuntimePath(parent)) {
        console.warn("[CodexBridge] Refusing to use packaged app runtime parent as Codex working directory", {
          candidate: resolved,
          parent,
        });
        return null;
      }
      const parentStats = await fs.stat(parent);
      if (parentStats.isDirectory()) {
        console.warn("[CodexBridge] Working directory is not a folder", {
          candidate: resolved,
          fallback: parent,
        });
        return parent;
      }
    } catch {
      console.warn("[CodexBridge] Working directory does not exist", {
        candidate: resolved,
      });
    }

    return null;
  }

  private isPackagedRuntimePath(candidate: string) {
    const normalized = path.resolve(candidate);
    return normalized.includes(".app/Contents/Resources/runtime");
  }

  private normalizeModelId(model?: string | null) {
    if (!model) return undefined;
    const normalized = model.trim().toLowerCase();
    if (normalized === "codex/codex-cli" || normalized === "codex-cli") {
      return undefined;
    }
    return model;
  }

  private async prepareImages(images?: Array<{ url: string; alt?: string }>) {
    if (!images || images.length === 0) {
      return { paths: [], cleanup: async () => {} };
    }

    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batshit-codex-img-"));
    const paths: string[] = [];

    for (const img of images) {
      if (!img?.url) continue;
      try {
        const res = await fetch(img.url);
        const array = await res.arrayBuffer();
        const filename = path.join(tmpDir, `${randomUUID()}.img`);
        // Codex image inputs are staged under a private random temp directory and removed after the run.
        // codeql[js/http-to-file-access]
        await fs.writeFile(filename, Buffer.from(array));
        paths.push(filename);
      } catch {
        console.warn("[CodexBridge] Failed to download image for Codex");
      }
    }

    const cleanup = async () => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    };

    return { paths, cleanup };
  }

  private async createRunner(
    prompt: string,
    options: CodexRunOptions,
  ): Promise<CodexRunner> {
    // Managed runs must always have a CODEX_HOME so per-agent config stays deterministic.
    if (options.configScope === "managed" && !options.managedConfigHome) {
      const fallbackProfile = options.profileName || "batshit_agent_default";
      const fallbackHome = path.join(
        os.homedir(),
        ".batshit",
        "agents",
        fallbackProfile,
        ".codex",
      );
      try {
        await fs.mkdir(fallbackHome, { recursive: true });
        options.managedConfigHome = fallbackHome;
      } catch (error) {
        console.warn(
          "[CodexBridge] Failed to create fallback managed Codex home",
          {
            fallbackHome,
            error,
          },
        );
      }
    }

    if (resolveCodexTransportLane(options, process.env) === "app-server") {
      const appServerRunner = await this.runViaAppServer(prompt, options);
      return this.wrapRunnerCleanup(appServerRunner);
    }

    const cliRunner = await this.runViaCli(prompt, options);
    return this.wrapRunnerCleanup(cliRunner);
  }

  private buildCodexChildEnv(options: CodexRunOptions): NodeJS.ProcessEnv {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_API_KEY: undefined,
    };
    if (options.managedConfigHome) {
      childEnv.CODEX_HOME = options.managedConfigHome;
    }
    if (options.dockerAuthToken) {
      childEnv[DOCKER_AUTH_ENV_VAR] = options.dockerAuthToken;
      if (!childEnv.MCP_GATEWAY_AUTH_TOKEN) {
        childEnv.MCP_GATEWAY_AUTH_TOKEN = options.dockerAuthToken;
      }
    }
    if (options.n8nInstanceMcpToken) {
      childEnv[N8N_INSTANCE_MCP_TOKEN_ENV] = options.n8nInstanceMcpToken;
    }
    if (options.batshitToken) {
      childEnv[BATSHIT_TOKEN_ENV_VAR] = options.batshitToken;
    }
    if (options.sessionId) {
      childEnv.BATSHIT_SESSION_ID = options.sessionId;
    }
    for (const [key, value] of Object.entries(options.managedStdioEnv ?? {})) {
      childEnv[key] = value;
    }
    return childEnv;
  }

  private async runViaAppServer(
    prompt: string,
    options: CodexRunOptions,
  ): Promise<CodexRunner> {
    const status = await detectCodexCliStatus({
      codexHome: options.managedConfigHome,
    });
    if (!status.available) {
      throw new Error(
        status.error ||
          "Codex CLI is not installed or not authenticated. Use the one-click install in Agent Settings (or `npm i -g @openai/codex`), then run `codex login`.",
      );
    }

    const useProfileDefaults =
      options.configScope === "global" && Boolean(options.profileName);
    const shouldSkipGitCheck = options.workingDirectory
      ? await this.shouldSkipGitRepoCheck(options.workingDirectory)
      : false;
    const execArgs = buildCodexCliArgs(options, {
      useProfileDefaults,
      shouldSkipGitCheck,
    });
    const spawnArgs = extractAppServerSpawnArgs(execArgs);
    const childEnv = this.buildCodexChildEnv(options);
    const codexExecutable =
      status.executable || resolveCodexCliExecutable(childEnv);
    const threadParams = buildCodexAppServerThreadParams(options);

    logger.debug(
      "[CodexBridge AppServer] Launching codex app-server",
      JSON.stringify({
        executable: codexExecutable,
        version: status.version ?? null,
        args: redactCodexCliArgsForLog(spawnArgs),
        ephemeral: threadParams.ephemeral,
        model: threadParams.model ?? null,
      }),
    );

    const run = startCodexAppServerRun({
      executable: codexExecutable,
      env: childEnv,
      cwd: options.workingDirectory,
      threadParams,
      prompt,
      imagePaths: options.imagePaths ?? [],
      signal: options.signal,
    });

    return {
      transport: "app-server",
      events: run.events,
      cleanup: run.cleanup,
    };
  }

  private wrapRunnerCleanup(runner: CodexRunner): CodexRunner {
    if (!runner.cleanup) return runner;

    return {
      ...runner,
      cleanup: async () => {
        try {
          await runner.cleanup?.();
        } catch (error) {
          console.warn("[CodexBridge] Runner cleanup error", error);
        }
      },
    };
  }

  private async runViaCli(
    prompt: string,
    options: CodexRunOptions,
  ): Promise<CodexRunner> {
    const status = await detectCodexCliStatus({
      codexHome: options.managedConfigHome,
    });
    if (!status.available) {
      throw new Error(
        status.error ||
          "Codex CLI is not installed or not authenticated. Use the one-click install in Agent Settings (or `npm i -g @openai/codex`), then run `codex login`.",
      );
    }

    const useProfileDefaults =
      options.configScope === "global" && Boolean(options.profileName);

    const shouldSkipGitCheck =
      options.workingDirectory
        ? await this.shouldSkipGitRepoCheck(options.workingDirectory)
        : false;
    const args = buildCodexCliArgs(options, {
      useProfileDefaults,
      shouldSkipGitCheck,
    });

    const childEnv = this.buildCodexChildEnv(options);

    const codexExecutable = status.executable || resolveCodexCliExecutable(childEnv);
    logger.debug("[CodexBridge CLI] Executing codex", JSON.stringify({
      executable: codexExecutable,
      version: status.version ?? null,
      args: redactCodexCliArgsForLog(args),
    }));

    const child = spawn(codexExecutable, args, {
      cwd: options.workingDirectory,
      env: childEnv,
      signal: options.signal,
    });
    if (child.stdin) {
      child.stdin.write(`${prompt}\n`);
      child.stdin.end();
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    let stderrBuffer = "";
    const events = this.createCliEventIterator(
      rl,
      child,
      () => stderrBuffer,
      options.signal,
    );

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      if (text.trim().length) {
        console.warn("[CodexBridge CLI]", text.trim());
      }
    });

    child.once("error", (error) => {
      const isAbortError =
        (error as { name?: string; code?: string })?.name === "AbortError" ||
        (error as { code?: string })?.code === "ABORT_ERR";
      if (isAbortError && options.signal?.aborted) {
        return;
      }
      console.error("[CodexBridge CLI] Spawn error", error);
    });

    const cleanup = async () => {
      rl.close();
      child.removeAllListeners();
      if (!child.killed) {
        child.kill();
      }
    };

    return {
      transport: "exec",
      events,
      cleanup,
    };
  }

  private async resolveManagedStdioEnv(
    userId: string,
    gatewayToolMap?: Record<string, string[]> | null,
  ): Promise<Record<string, string>> {
    if (!gatewayToolMap) return {};

    const gatewayIds = Object.keys(gatewayToolMap);
    if (gatewayIds.length === 0) return {};

    const gateways = await mcpGatewayService.list(userId);
    const values: Record<string, string> = {};

    for (const gateway of gateways) {
      if (!gatewayIds.includes(gateway.id) || !isStdioGateway(gateway)) continue;
      Object.assign(
        values,
        await resolveManagedStdioEnvironmentValues({ gateway, userId }),
      );
    }

    return values;
  }

  private async shouldSkipGitRepoCheck(workingDirectory: string): Promise<boolean> {
    const resolved = path.resolve(workingDirectory);
    let current = resolved;
    while (true) {
      const gitPath = path.join(current, ".git");
      try {
        await fs.stat(gitPath);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code && code !== "ENOENT") {
          console.warn("[CodexBridge] Failed to inspect git status", {
            workingDirectory: resolved,
            error,
          });
          return true;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return true;
  }

  private async *createCliEventIterator(
    rl: readline.Interface,
    child: import("node:child_process").ChildProcess,
    getStderr: () => string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ThreadEvent> {
    try {
      for await (const line of rl) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as ThreadEvent;
          yield parsed;
        } catch (error) {
          console.error("[CodexBridge CLI] Failed to parse event line", error);
        }
      }
      await new Promise<void>((resolve, reject) => {
        child.once("close", (code, signal) => {
          const aborted =
            abortSignal?.aborted === true ||
            signal === "SIGTERM" ||
            signal === "SIGKILL" ||
            code === 143 ||
            code === 137;

          if (code === 0 || aborted) {
            resolve();
            return;
          }

          reject(
            new Error(
              `Codex CLI exited with code ${code ?? -1}: ${getStderr()?.trim() || "No stderr output"}`,
            ),
          );
        });
      });
    } finally {
      rl.close();
    }
  }

  private wrapStream(
    stream: AsyncGenerator<any>,
    context: {
      onAbort?: NativeModeRequest["onAbort"];
      abortSignal?: AbortSignal;
      adapter: CodexEventAdapter;
      cleanup?: (() => void | Promise<void>) | undefined;
      onFirstChunk?: () => void;
    },
  ) {
    const { onAbort, abortSignal, adapter, cleanup, onFirstChunk } = context;

    if (abortSignal && onAbort) {
      abortSignal.addEventListener(
        "abort",
        () => {
          try {
            onAbort({
              steps: adapter.getIntermediateSteps(),
            });
          } catch (error) {
            console.error(
              "[CodexBridge] Failed to run onAbort callback",
              error,
            );
          }
        },
        { once: true },
      );
    }

    const iterator = stream[Symbol.asyncIterator]();
    let cleanedUp = false;

    const runCleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (cleanup) {
        await cleanup();
      }
    };

    return {
      [Symbol.asyncIterator]() {
        let firstChunkEmitted = false;
        return {
          next: async () => {
            let result: IteratorResult<any>;
            try {
              result = await iterator.next();
            } catch (error) {
              await runCleanup();
              throw error;
            }
            if (!firstChunkEmitted && !result.done && onFirstChunk) {
              firstChunkEmitted = true;
              try {
                onFirstChunk();
              } catch (error) {
                console.error(
                  "[CodexBridge] First-chunk callback failed",
                  error,
                );
              }
            }
            if (result.done) {
              await runCleanup();
            }
            return result;
          },
          return: async () => {
            await runCleanup();
            return iterator.return
              ? iterator.return(undefined)
              : Promise.resolve({ done: true, value: undefined });
          },
          throw: async (err?: any) => {
            await runCleanup();
            return iterator.throw ? iterator.throw(err) : Promise.reject(err);
          },
        };
      },
    };
  }

  private clampSandbox(
    desired: CodexRuntimeSettings["sandbox"],
    maximum: CodexRuntimeSettings["sandbox"],
  ): CodexRuntimeSettings["sandbox"] {
    if (!desired) return maximum;
    const rank = (value: CodexRuntimeSettings["sandbox"]) => {
      switch (value) {
        case "workspace-write":
          return 1;
        case "danger-full-access":
          return 2;
        default:
          return 0;
      }
    };

    const desiredRank = rank(desired);
    const maxRank = rank(maximum);
    return desiredRank <= maxRank ? desired : maximum;
  }
}

function normalizeConfigOverrideValue(raw: string | null | undefined): string {
  if (raw === undefined || raw === null) return '""';
  const value = String(raw);
  const trimmed = value.trim();
  if (!trimmed.length) return '""';

  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") return lower;

  // numeric literal (keep ints + floats as-is)
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed === num.toString()) return trimmed;

  // arrays / objects already in TOML/JSON-ish form
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    return trimmed;
  }

  // honor existing quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed;
  }

  // fallback: quote the value so paths like /Users/foo/bar.toml parse correctly
  return JSON.stringify(trimmed);
}

export function buildCodexNativeSkillDisableOverride(paths: string[]) {
  const uniquePaths = Array.from(
    new Set(
      paths
        .map((candidate) => candidate?.trim())
        .filter((candidate): candidate is string => Boolean(candidate)),
    ),
  ).sort()

  if (!uniquePaths.length) return null

  const entries = uniquePaths.map(
    (skillPath) => `{path=${JSON.stringify(skillPath)},enabled=false}`,
  )
  return `skills.config=[${entries.join(",")}]`
}

async function discoverCodexNativeSkillDisablePaths(params: {
  managedConfigHome?: string | null
  workingDirectory?: string | null
}) {
  const roots = resolveCodexNativeSkillRoots(params)
  const skillPaths = new Set<string>()

  for (const root of roots) {
    await collectSkillFiles(root, skillPaths)
  }

  return Array.from(skillPaths).sort()
}

function resolveCodexNativeSkillRoots(params: {
  managedConfigHome?: string | null
  workingDirectory?: string | null
}) {
  const roots = new Set<string>()
  const home = os.homedir()

  if (params.managedConfigHome) {
    roots.add(path.join(params.managedConfigHome, "skills"))
  }

  roots.add(path.join(home, ".agents", "skills"))

  if (params.workingDirectory) {
    const homeResolved = path.resolve(home)
    let current = path.resolve(params.workingDirectory)

    while (true) {
      roots.add(path.join(current, ".agents", "skills"))
      roots.add(path.join(current, ".codex", "skills"))

      if (current === homeResolved) break

      const parent = path.dirname(current)
      if (parent === current) break
      if (!current.startsWith(`${homeResolved}${path.sep}`)) break

      current = parent
    }
  }

  return Array.from(roots).sort()
}

async function collectSkillFiles(
  root: string,
  output: Set<string>,
  depth = 0,
) {
  if (depth > 8) return

  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[CodexBridge] Failed to inspect Codex native skill root", {
        root,
        error,
      })
    }
    return
  }

  for (const entry of entries) {
    const candidate = path.join(root, entry.name)
    if (entry.isFile() && entry.name === "SKILL.md") {
      output.add(path.resolve(candidate))
      continue
    }
    if (entry.isDirectory()) {
      await collectSkillFiles(candidate, output, depth + 1)
    }
  }
}
