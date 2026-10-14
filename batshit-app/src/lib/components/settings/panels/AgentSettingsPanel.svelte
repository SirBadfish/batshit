<script lang="ts">
  import { performAvatarImport, uploadAvatarFile } from '$lib/appActions/imports/avatars'
  import type { ImportArgs, ImportOutcome } from '$lib/appActions/imports/contracts'
  import { refuse, type SettingsTarget } from '$lib/appActions/catalog'
  import { appActionsHaveDrafts, type ActionContext } from '$lib/appActions/owners'

  import { onDestroy, onMount, untrack } from "svelte";
  import { createEntitySaverCount } from "$lib/utils/entitySaverCount";
  import { AGENT_MEMORY_GROUP, AGENT_SAVE_FIELD_GROUPS } from "$lib/utils/agentSettingsSavePatch";
  import { agentWritableConflictLabels, rebaseAgentWritableFields } from "$lib/utils/agentWritableFieldRebase";
  import { onUserChannelEvent, type UserChannelEvent } from "$lib/services/userChannel";
  import { SUBAGENT_SAVE_FIELD_GROUPS } from "$lib/utils/subagentSettingsSavePatch";
  import {
    buildDcmDisplaySettingsSignature,
    cloneDcmDisplaySettings,
    createDefaultDcmDisplaySettings
  } from "$lib/utils/dcmDisplaySettings";
  import { toast } from "$lib/components/ui/sonner/settings-toast";
  import * as agentStore from "$lib/stores/agents.svelte";
  import * as n8nRuntimeStatusStore from "$lib/stores/n8nRuntimeStatus.svelte";
  import type { Agent as AgentStoreRecord } from "$lib/stores/agents.svelte";
  import { loadGoons } from "$lib/services/goons";
  import { getGoons } from "$lib/stores/goons.svelte";
  import { isGoonRuntimeReady } from "$lib/goons/recipe";
  import { subagentStore } from "$lib/stores/subagents.svelte";
  import { getUserSettings } from "$lib/stores/userSettings.svelte";
  import { confirmDialog, confirmDialogWithCheckbox } from "$lib/stores/confirmDialog";
  import { copyTextToClipboard } from "$lib/utils/clipboard";
  import { requestAvatarPictureTidy, shouldTidyAvatarPictures } from "$lib/utils/avatarPictureTidy";
  import { sandboxUnavailableMessage } from "$lib/utils/nativeExecutionBackend";
  import { isClaudeToolEnabled, withClaudeToolEnabled } from "$lib/utils/claudeToolSwitch";
  import {
    resolveAgentDeleteChatCountOutcome,
    type AgentChatCounts,
  } from "$lib/utils/agentDeleteChatCount";
  import type {
  AgentDcmDisplaySettings,
  AgentRow,
  MCPToolSelections,
  SubagentRow,
  SlashCommandRow,
  UserSettingsRow,
} from "$lib/types/database";
  import type {
  AgentVoiceProfile,
  VoiceProfileRecord,
  VoiceProviderSummary,
  VoiceProviderId,
  VoiceItalicNarrationBehavior,
  VoiceModeInputMode,
  VoiceModeSubmitMode,
  VoiceSessionRuntime,
  VoiceSummary,
} from "$lib/types/voice";
  import { BROWSER_STT_CAPABILITIES } from "$lib/data/voiceCapabilityRegistry";
  import {
  DEFAULT_TTS_ITALIC_NARRATION_BEHAVIOR,
  DEFAULT_VOICE_MODE_INPUT_MODE,
  DEFAULT_VOICE_MODE_SUBMIT_MODE,
  normalizeAgentVoiceProfile,
  normalizeVoiceSettings
} from "$lib/utils/voiceSchema";
import { loadMicrophoneDeviceOptions } from "$lib/utils/microphoneDevices";
  import type {
  CodexAgentSettings,
  CodexPermissionMode,
  CodexApproval,
  CodexSandbox,
  CodexHistoryPersistence,
  CodexServiceTier,
} from "$lib/types/codex";
import type {
  ClaudeAgentSettings,
  ClaudePermissionMode,
  ClaudeConfigScope,
  ClaudeSystemPromptMode
} from "$lib/types/claude";
import {
  CODEX_FAST_MODE_HELPER_TEXT,
  CODEX_SUBMODEL_CHOICES,
  CODEX_XHIGH_REASONING_HELPER_TEXT,
  supportsCodexFastMode,
  supportsCodexXhighReasoning,
} from "$lib/data/codex-models";
import { CLAUDE_CLI_MODEL_CHOICES } from "$lib/data/claude-cli-models";
  import CliRuntimeManagerCard from "$lib/components/settings/CliRuntimeManagerCard.svelte";
  import RetiredCliModelNotice from "$lib/components/settings/agent/RetiredCliModelNotice.svelte";
  import { Input } from "$lib/components/ui/input";
  import * as Label from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";
  import * as Switch from "$lib/components/ui/switch";
  import * as Select from "$lib/components/ui/select";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
import ModelProviderIcon from "$lib/components/models/ModelProviderIcon.svelte";
import VoiceProviderIcon from "$lib/components/settings/voice/VoiceProviderIcon.svelte";
import BatshitIcon from "$lib/components/icons/BatshitIcon.svelte";
import IconPicker from "$lib/components/icons/IconPicker.svelte";
import EntityAvatar from "$lib/components/avatar/EntityAvatar.svelte";
import { getSavedModelBadgeProvider, resolveSavedModelConnection } from "$lib/utils/modelConnections";
import {
  getVoiceModeLockLabel,
  resolveModelVoiceSessionConfig
} from "$lib/utils/modelVoiceSession";
import * as savedModelsStore from "$lib/stores/savedModels.svelte";
import type { CatalogConnectionOption } from "$lib/types/modelCatalog";
import { getModelPresetAvailability, presetAvailabilityKeepsSelection } from "$lib/utils/modelPresetAvailability";
import { applyAgentProviderSettingsUpdate, presetModelSettings } from "$lib/utils/agentProviderSettings";
import { buildAgentSettingsSavePatch } from "$lib/utils/agentSettingsSavePatch";
import {
  AGENT_FIELD_BY_FIELD_BLOCKS,
  applyAgentBlockUpdate,
  diffAgentBlockWithGroups,
  type AgentBlockSaveByField,
  type AgentFieldByFieldBlock,
} from "$lib/utils/agentBlockFieldSettings";
import {
  diffMcpSection,
  diffZipPayload,
  zipPayloadForSave,
  type CustomToolPayload,
  type McpPayloadBody,
  type McpSectionSave,
  type McpSectionValues,
  type ZipPayloadBody,
} from "$lib/utils/agentSettingsSectionSaves";
import {
  buildSubagentSettingsSavePatch,
  makeSubagentFormSignature,
  type LiveSubagentUpdate,
  type SubagentSaveForm,
} from "$lib/utils/subagentSettingsSavePatch";
import { DEFAULT_AGENT_ICON_REF } from "$lib/icons/iconCatalog";
import { normalizeIconRef } from "$lib/icons/iconLegacy";
import {
  iconRefKey,
  normalizeAvatarIconFit,
  type AvatarIconFit,
  type IconRef,
} from "$lib/icons/iconTypes";
import {
  type PrimaryAgentType,
  type StoredPrimaryAgentType,
  getPrimaryAgentDisplayLabel,
  isCliPrimaryAgentType,
  isManagedPrimaryAgentType,
  normalizePrimaryAgentType,
  shouldShowReasoningByDefaultForPrimaryAgent
} from "$lib/utils/primaryAgentType";
import type { ToolHostScope } from "$lib/utils/brokerAvailability";
import {
  getCompatibleSubagentTypesForPrimaryAgent,
  getSubagentTypeBadgeTone,
  getSubagentTypeDisplayLabel,
  getSubagentTypeShortLabel,
  isSubagentCompatibleWithPrimaryAgent,
  isWorkflowBackedSubagentType,
  normalizeSubagentType,
  type SubagentType,
  type StoredSubagentType,
} from "$lib/utils/subagentType";
import { validateN8nProductionWebhookUrl } from "$lib/utils/n8nWebhookValidation";
import { ProjectService } from "$lib/services/projects";
import { artifactService, type ArtifactRow } from "$lib/services/artifactService";
import { isArtifactAgentUseEligible } from "$lib/artifacts/agentUseEligibility";
import { slashCommandStore } from "$lib/services/slashCommandStore";
import { resolveVoiceSettingsForSpeech, voiceService, type VoiceConfig } from "$lib/services/voice";
  import type { MegaAgentSection } from "$lib/components/settings/AgentMegaDropdown.svelte";
  import SettingsInfoMenu from "$lib/components/settings/SettingsInfoMenu.svelte";
  import SettingsAccordionCard from "$lib/components/settings/SettingsAccordionCard.svelte";
  import SettingsTextEditor from "$lib/components/settings/SettingsTextEditor.svelte";
  import SettingsSaveStatus from "$lib/components/settings/SettingsSaveStatus.svelte";
  import { sanitizeId } from "$lib/utils/idSanitizer";
  import AgentAccessAssignmentsSection from "$lib/components/settings/agent/AgentAccessAssignmentsSection.svelte";
  import AgentDeleteDisclosure from "$lib/components/settings/agent/AgentDeleteDisclosure.svelte";
  import AgentSelectorSection from "$lib/components/settings/agent/AgentSelectorSection.svelte";
  import AgentAutoCompactSettingsCard from "$lib/components/settings/agent/AgentAutoCompactSettingsCard.svelte";
  import AgentMemorySettingsCard from "$lib/components/settings/agent/AgentMemorySettingsCard.svelte";
  import AgentDmsSettingsCard from "$lib/components/settings/agent/AgentDmsSettingsCard.svelte";
  import AgentJevJuiceSettingsCard from "$lib/components/settings/agent/AgentJevJuiceSettingsCard.svelte";
  import {
    resolveAgentJevJudgeToolEnabled,
    resolveAgentJevMemoryRecallEnabled,
    resolveAgentJevMemoryRerankEnabled,
    resolveAgentJevReplyCheckEnabled,
    resolveAgentJevSkillToolHintsEnabled,
    resolveAgentJevStyleCoachEnabled,
  } from "$lib/utils/jevJuiceControl";
  import {
    DEFAULT_WAKE_TARGET,
    resolveAgentDmsEnabled,
    resolveAgentWakeEnabled,
    resolveDmSenderPolicy,
    resolveWakeTarget,
    validateWakeTimeoutMinutes,
    type DmSenderScope,
    type WakeTarget,
  } from "$lib/utils/dmControl";
  import {
    buildAgentMemoryRecordFields,
    resolveAgentMemorySettingsDraft,
    type AgentMemorySettingsDraft,
  } from "$lib/utils/memoryControl";
  import {
    WORKERS_MAX_CONCURRENT,
    WORKERS_MAX_RUNS_PER_TURN,
    resolveWorkersEnabled,
  } from "$lib/utils/delegationCapabilities";
  import {
    CODEX_PERMISSION_PRESETS,
    CODEX_SANDBOX_LABELS,
    CODEX_SANDBOX_ORDER,
    sanitizeCodexSandbox,
  } from "$lib/utils/codexRunAccess";
  import AgentWebSearchDefaultsDisclosure from "$lib/components/settings/agent/AgentWebSearchDefaultsDisclosure.svelte";
  import SubagentAccessAssignmentsSection from "$lib/components/settings/agent/SubagentAccessAssignmentsSection.svelte";
  import {
    CREATE_AGENT_SENTINEL,
    requireHydratedAgentDetail,
  } from "$lib/components/settings/agent/agentDetailSaveGuard";
  import {
    normalizeAgentAutoCompactSettings,
    type AgentAutoCompactSettings
  } from "$lib/utils/contextCompaction";
import {
  Loader2,
  AudioLines,
  AlertCircle,
  Check,
  RefreshCcw,
  Users,
  UploadCloud,
  Copy,
  Trash2,
  MessageCircle,
  Package,
  Pencil,
  Play,
  Shield,
  ShieldPlus,
  Brain,
  TerminalSquare,
  Lock,
  Mic,
  ChevronDown,
  Info,
  Plus,
  RotateCcw,
  Wrench,
  Eye,
  X
} from '@lucide/svelte';
import type { SavedModel, ModelCapabilities, ModelConnectionInfo } from "$lib/types/savedModels";
import AgentMcpDefaultsCard from "$lib/components/settings/agent/AgentMcpDefaultsCard.svelte";
import {
  SHARED_NON_MCP_TOOL_GRID_CONFIG,
  SHARED_NON_MCP_TOOL_GRID_ROWS,
  isSharedNonMcpToolGridRowId,
  type SharedNonMcpToolGridRowConfig,
  type SharedNonMcpToolGridRowId,
} from "$lib/components/tools/toolGridConfig";
import { getToolGridDefaultAutoZip, getToolGridDefaultNumber } from "$lib/utils/toolGridZipDefaults";
import { listUnsupportedN8NParameters } from "$lib/utils/modelCompatibility";
import * as compatibilityMatrixStore from "$lib/stores/compatibilityMatrix.svelte";
import { LIVE_SETTINGS_EVENTS, dispatchArtifactUpdated } from "$lib/utils/liveSettingsEvents";
import { getSubagentTimeoutValidationError } from "$lib/utils/subagentTimeout";

  const BASIC_SAVE_DEBOUNCE_MS = 600;
  const ZIP_SAVE_DEBOUNCE_MS = 700;
  const SUBAGENT_SAVE_DEBOUNCE_MS = 600;
  const MCP_SAVE_DEBOUNCE_MS = 650;
  const MODE4_PRELAUNCH_REPLACEMENT_PROMPT = "You are a helpful assistant.";
  const CLAUDE_DEFAULT_MAX_THINKING_TOKENS = 1024;
  const CODEX_SAVE_DEBOUNCE_MS = 650;
  const CLAUDE_SAVE_DEBOUNCE_MS = 650;
  const DEFAULT_AGENT_VOICE_TEST_PHRASE = "Hey! This is a quick voice test from Batshit.";
  const NATIVE_BASH_TIMEOUT_OPTIONS = [10_000, 30_000, 60_000, 120_000];
  const NATIVE_AGENT_BROWSER_TIMEOUT_OPTIONS = [15_000, 30_000, 45_000, 60_000, 120_000];
  const DEFAULT_NATIVE_AGENT_BROWSER_TIMEOUT_MS = 45_000;
  const DEFAULT_NATIVE_AGENT_BROWSER_CDP_PORT = 9222;
  type NativeExecutionBackend = "docker_sandbox" | "apple_container" | "local";
  type NativeBashAccessMode = "plan" | "agent" | "dangerous";
  type NativeAgentBrowserRuntimeMode = "chromium" | "chrome-cdp";
  type NativeAgentBrowserProvider = "local" | "browserbase" | "browseruse" | "kernel";
  const NATIVE_EXECUTION_BACKEND_OPTIONS: NativeExecutionBackend[] = [
    "apple_container",
    "docker_sandbox",
    "local",
  ];
  const NATIVE_EXECUTION_BACKEND_LABELS: Record<NativeExecutionBackend, string> = {
    apple_container: "Apple Container (Mac default)",
    docker_sandbox: "Docker Sandbox",
    local: "Local machine (least safe)",
  };
  const NATIVE_BASH_ACCESS_MODE_OPTIONS: NativeBashAccessMode[] = [
    "plan",
    "agent",
    "dangerous",
  ];
  const NATIVE_BASH_ACCESS_MODE_LABELS: Record<NativeBashAccessMode, string> = {
    plan: "Plan",
    agent: "Agent",
    dangerous: "Batshit Crazy",
  };
  const NATIVE_AGENT_BROWSER_RUNTIME_MODE_OPTIONS: NativeAgentBrowserRuntimeMode[] = [
    "chromium",
    "chrome-cdp",
  ];
  const NATIVE_AGENT_BROWSER_RUNTIME_MODE_LABELS: Record<NativeAgentBrowserRuntimeMode, string> = {
    chromium: "Separate Chromium (recommended)",
    "chrome-cdp": "Current Chrome via CDP",
  };
  const NATIVE_AGENT_BROWSER_PROVIDER_OPTIONS: NativeAgentBrowserProvider[] = [
    "local",
    "browserbase",
    "browseruse",
    "kernel",
  ];
  const NATIVE_AGENT_BROWSER_PROVIDER_LABELS: Record<NativeAgentBrowserProvider, string> = {
    local: "Local browser runtime",
    browserbase: "Browserbase (cloud)",
    browseruse: "Browser Use (cloud)",
    kernel: "Kernel (cloud)",
  };
  type NativeWebSearchProvider = "duckduckgo-html" | "exa" | "perplexity";
  type ExaSearchType = "auto" | "fast" | "neural" | "deep";
  const DEFAULT_NATIVE_WEB_SEARCH_PROVIDER: NativeWebSearchProvider = "duckduckgo-html";
  const DEFAULT_NATIVE_WEB_SEARCH_EXA_TYPE: ExaSearchType = "auto";
  const DEFAULT_NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE = 1024;
  const NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS = [512, 1024, 2048, 4096];
  const NATIVE_WEB_SEARCH_PROVIDER_INHERIT = "__inherit__";
  const NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT = "__inherit_exa_type__";
  const NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT =
    "__inherit_perplexity_max_tokens_per_page__";
  const NATIVE_WEB_SEARCH_PROVIDER_LABELS: Record<
    NativeWebSearchProvider,
    string
  > = {
    "duckduckgo-html": "DuckDuckGo (built-in, no key)",
    exa: "Exa",
    perplexity: "Perplexity",
  };
  const NATIVE_WEB_SEARCH_EXA_TYPE_LABELS: Record<ExaSearchType, string> = {
    auto: "Auto (recommended)",
    fast: "Fast",
    neural: "Neural",
    deep: "Deep",
  };
  const NATIVE_WEB_SEARCH_PROVIDER_ALIASES: Record<string, NativeWebSearchProvider> = {
    duckduckgo: "duckduckgo-html",
    ddg: "duckduckgo-html",
    "duckduckgo-html": "duckduckgo-html",
    exa: "exa",
    perplexity: "perplexity",
  };

  type PanelData = {
    user?: { id: string } | null;
    userSettings?: UserSettingsRow | null;
  } | null;
  type AgentProjectOption = {
    id: string;
    name: string;
    root_path: string;
  };
  type AgentBrowserRuntimeStatus = {
    installed: boolean;
    supported?: boolean;
    dockerUnsupported?: boolean;
    supportLevel?: "native-cli" | "docker-sidecar" | "docker-deferred";
    installScope?: "native-cli" | "docker-sidecar";
    command: string | null;
    version: string | null;
    reason: string | null;
    installCommand: string;
    installHelp: string;
  };
  type NativeSandboxStatus = {
    success: boolean;
    available: boolean;
    supported?: boolean;
    dockerUnsupported?: boolean;
    containerized?: boolean;
    backend: NativeExecutionBackend;
    policy: string;
    version: string | null;
    cli?: string | null;
    /** Apple Container only: false when the CLI is missing (BL-83). */
    installed?: boolean;
    /** Apple Container only: false until the first sandboxed command starts it (BL-62). */
    systemRunning?: boolean;
    reason: string | null;
  };


  interface BasicForm {
    displayName: string;
    agentType: StoredPrimaryAgentType;
    show_reasoning: boolean;
    preserve_reasoning: boolean;
    tool_approval_mode: "off" | "all";
    auto_compact_settings: AgentAutoCompactSettings;
    memory_settings: AgentMemorySettingsDraft;
    // SA-111 P4 (DL-111-11): may this Primary Agent spawn Workers? Default on.
    workers_enabled: boolean;
    // SA-113 (DL-113-01, DL-113-15): the Agent DMs card. The DM half and the wake half
    // are independent switches — a webhook can wake an agent that never uses DMs.
    dms_enabled: boolean;
    dm_sender_scope: DmSenderScope;
    dm_sender_agent_ids: string[];
    wake_enabled: boolean;
    wake_timeout_minutes: number | null;
    wake_target: WakeTarget;
    // SA-120 P1 (DL-120-01): the per-agent Judge Juice skill/tool hint switch. Default off.
    jev_juice_skill_tool_hints: boolean;
    // SA-120 P2 (LS-050): the per-agent switch for the sys.judge.ask tool. Default off.
    jev_juice_judge_tool: boolean;
    // SA-120 P4a (LS-052): the per-agent switch for the memory search rerank. Default off.
    jev_juice_memory_rerank: boolean;
    // SA-120 P4b (LS-053): the per-agent switch for recall by meaning. Default off.
    jev_juice_memory_recall: boolean;
    // SA-120 P6 — the two after-reply lanes (LS-055, LS-056).
    jev_juice_reply_check: boolean;
    jev_juice_style_coach: boolean;
    webhook_url: string;
    agent_url: string;
    default_project_id: string | null;
    include_global_prompt: boolean;
    primary_model_provider: string;
    primary_model_name: string;
    primary_model_preset_id: string;
    primary_model_connection: ModelConnectionInfo | null;
    avatar_url: string | null;
    avatar_icon_ref: IconRef;
    avatar_icon_fit: AvatarIconFit;
    goon_id: string | null;
    provider_specific_settings: Record<string, any> | null;
    primary_model_temperature: number | null;
    primary_model_max_tokens: number | null;
    primary_model_top_p: number | null;
    primary_model_top_k: number | null;
    primary_model_frequency_penalty: number | null;
    primary_model_presence_penalty: number | null;
    primary_model_seed: number | null;
    primary_model_stop_sequences: string[] | null;
    primary_model_reasoning_effort: string | null;
    primary_model_capabilities: ModelCapabilities | null;
    voice_profile: VoiceProfileForm;
  }

  interface VoiceProfileForm {
    voiceSessionRuntime: "" | VoiceSessionRuntime;
    voiceModeInputMode: "" | VoiceModeInputMode;
    voiceModeSubmitMode: "" | VoiceModeSubmitMode;
    provider: string;
    model: string;
    voiceId: string;
    profileId: string;
    ttsItalicNarrationBehavior: "" | VoiceItalicNarrationBehavior;
    sttProvider: string;
    sttModel: string;
    realtimeSttProvider: string;
    realtimeSttModel: string;
  }

  type CustomToolSettingForm = {
    tool_name: string;
    buffer_size: string;
    zip_threshold: string;
    auto_zip: string;
  };

  type McpToolZipOverrideSnapshot = {
    buffer_size: string;
    zip_threshold: string;
    auto_zip: string;
    inherited_buffer_size?: number;
    inherited_zip_threshold?: number;
    inherited_auto_zip?: boolean;
    inherited_zip_disabled?: boolean;
  };

  type McpToolZipOverridePatch = Partial<
    Pick<CustomToolSettingForm, "buffer_size" | "zip_threshold" | "auto_zip">
  >;

  type NonMcpZipRowId = SharedNonMcpToolGridRowId;

  type NonMcpZipOverrideSnapshot = {
    buffer_size: string;
    zip_threshold: string;
    auto_zip: string;
    inherited_buffer_size?: number;
    inherited_zip_threshold?: number;
    inherited_auto_zip?: boolean;
    inherited_zip_disabled?: boolean;
    min_buffer: number;
  };

  type NonMcpZipOverridePatch = Partial<
    Pick<NonMcpZipOverrideSnapshot, "buffer_size" | "zip_threshold" | "auto_zip">
  >;

  // SA-129 DL-06 (BL-1484): no zip control permission here. The parked permission reads only the
  // hidden experiment key, which no Settings surface reads or writes.
  interface ZipForm {
    zip_ai_view_mode: string;
    zip_tool_notes_enabled: string;
    buffer_size: string;
    buffer_size_image: string;
    buffer_size_error: string;
    buffer_size_subagent: string;
    buffer_size_read_file: string;
    buffer_size_write_file: string;
    buffer_size_edit_file: string;
    buffer_size_execute_command: string;
    buffer_size_list_files: string;
    buffer_size_all_other_tools: string;
    zip_threshold_error: string;
    zip_threshold_image: string;
    zip_threshold_subagent: string;
    zip_threshold_read_file: string;
    zip_threshold_write_file: string;
    zip_threshold_edit_file: string;
    zip_threshold_execute_command: string;
    zip_threshold_list_files: string;
    zip_threshold_all_other_tools: string;
    auto_zip_error: string;
    auto_zip_image: string;
    auto_zip_subagent: string;
    auto_zip_read_file: string;
    auto_zip_write_file: string;
    auto_zip_edit_file: string;
    auto_zip_execute_command: string;
    auto_zip_list_files: string;
    auto_zip_all_other_tools: string;
    custom_tool_settings: CustomToolSettingForm[];
  }

  const ZIP_BUFFER_FIELDS = [
    "buffer_size",
    "buffer_size_image",
    "buffer_size_error",
    "buffer_size_subagent",
    "buffer_size_read_file",
    "buffer_size_write_file",
    "buffer_size_edit_file",
    "buffer_size_execute_command",
    "buffer_size_list_files",
    "buffer_size_all_other_tools",
  ] as const;

  const ZIP_THRESHOLD_FIELDS = [
    "zip_threshold_error",
    "zip_threshold_image",
    "zip_threshold_subagent",
    "zip_threshold_read_file",
    "zip_threshold_write_file",
    "zip_threshold_edit_file",
    "zip_threshold_execute_command",
    "zip_threshold_list_files",
    "zip_threshold_all_other_tools",
  ] as const;

  const ZIP_AUTO_FIELDS = [
    "auto_zip_error",
    "auto_zip_image",
    "auto_zip_subagent",
    "auto_zip_read_file",
    "auto_zip_write_file",
    "auto_zip_edit_file",
    "auto_zip_execute_command",
    "auto_zip_list_files",
    "auto_zip_all_other_tools",
  ] as const;

  const ZIP_DISABLED_FIELDS = [
    "zip_disabled_error",
    "zip_disabled_image",
    "zip_disabled_subagent",
    "zip_disabled_read_file",
    "zip_disabled_write_file",
    "zip_disabled_edit_file",
    "zip_disabled_execute_command",
    "zip_disabled_list_files",
    "zip_disabled_all_other_tools",
  ] as const;

  type ZipNumericField =
    | (typeof ZIP_BUFFER_FIELDS)[number]
    | (typeof ZIP_THRESHOLD_FIELDS)[number];

  const MIN_BUFFER = 1;
  const MIN_IMAGE_BUFFER = 0;

  const NON_MCP_ZIP_ROW_ORDER: Array<{ id: NonMcpZipRowId; label: string; iconRef: IconRef }> =
    SHARED_NON_MCP_TOOL_GRID_ROWS;

  const NON_MCP_ZIP_ROW_CONFIG: Record<
    NonMcpZipRowId,
    SharedNonMcpToolGridRowConfig
  > = SHARED_NON_MCP_TOOL_GRID_CONFIG as Record<
    NonMcpZipRowId,
    SharedNonMcpToolGridRowConfig
  >;

  function isZeroAllowedBuffer(field: (typeof ZIP_BUFFER_FIELDS)[number]) {
    return field === "buffer_size_image";
  }

  interface ConfigRow {
    id: string;
    key: string;
    value: string;
  }

  interface CodexFormOptions {
    permissionMode: CodexPermissionMode;
    includeProjectInstructions: boolean;
    model: string;
    reasoningEffort: "default" | "low" | "medium" | "high" | "xhigh";
    serviceTier: CodexServiceTier;
    streamingEffect: boolean;
    unifiedExec: boolean;
    search: boolean;
    sandbox: CodexSandbox;
    approval: CodexApproval;
    configScope: "managed" | "global";
    addDirs: string[];
    enableFeatures: string[];
    disableFeatures: string[];
    configOverrides: ConfigRow[];
    workingDirectoryMode: "project" | "custom";
    customWorkingDirectory: string;
    historyPersistence: CodexHistoryPersistence;
  }

  interface ClaudeFormOptions {
    permissionMode: ClaudePermissionMode;
    includeCoreSystemPrompt: boolean;
    includeProjectInstructions: boolean;
    model: string;
    alwaysThinkingEnabled: boolean;
    maxThinkingTokens: string;
    configScope: ClaudeConfigScope;
    systemPromptMode: ClaudeSystemPromptMode;
    systemPrompt: string;
    systemPromptFile: string;
    chrome: boolean;
    addDirs: string[];
    allowedTools: string[];
    disallowedTools: string[];
    configOverrides: ConfigRow[];
    workingDirectoryMode: "project" | "custom";
    customWorkingDirectory: string;
  }

  type ManagedConfigProvider = "codex" | "claude";

  const CODEX_PERMISSION_OPTIONS: Array<{
    value: CodexPermissionMode;
    label: string;
    helper: string;
    icon: typeof MessageCircle;
  }> = [
    { value: "chat", label: "Chat", helper: "Read-only, never prompts", icon: MessageCircle },
    { value: "agent", label: "Agent", helper: "Workspace write, ask when needed", icon: Shield },
    {
      value: "agent_full",
      label: "Agent (full access)",
      helper: "Full access, run without prompts",
      icon: ShieldPlus,
    },
  ];

  const CLAUDE_PERMISSION_OPTIONS: Array<{
    value: ClaudePermissionMode;
    label: string;
    helper: string;
    icon: typeof MessageCircle;
  }> = [
    { value: "plan", label: "Plan", helper: "Plan-only, no edits or commands", icon: MessageCircle },
    {
      value: "default",
      label: "Ask before edits",
      helper: "Edits and commands follow Approval Policy.",
      icon: MessageCircle,
    },
    {
      value: "acceptEdits",
      label: "Edit automatically",
      helper: "Approved work runs automatically; extra actions follow Approval Policy.",
      icon: Shield,
    },
    {
      value: "bypassPermissions",
      label: "Bypass permissions",
      helper: "Full trust, no approvals",
      icon: ShieldPlus,
    },
  ];

  const PRIMARY_TOOL_APPROVAL_OPTIONS: Array<{
    value: "off" | "all";
    label: string;
    helper: string;
  }> = [
    {
      value: "off",
      label: "Never",
      helper: "Stay inside the saved boundaries. Extra actions fail instead of asking.",
    },
    {
      value: "all",
      label: "On Request",
      helper: "When a primary agent hits a permission boundary, supported runtimes can ask for extra approval.",
    },
  ];

  const NATIVE_PERMISSION_OPTIONS: Array<{
    value: NativeBashAccessMode;
    label: string;
    helper: string;
    icon: typeof MessageCircle;
  }> = [
    {
      value: "plan",
      label: "Plan",
      helper: "Plan-only mode. Reads and Markdown note edits only.",
      icon: MessageCircle,
    },
    {
      value: "agent",
      label: "Agent",
      helper: "Project-safe command execution with sandbox-first defaults.",
      icon: Shield,
    },
    {
      value: "dangerous",
      label: "Batshit Crazy",
      helper: "Full local-machine access with no approval prompts. Hard safety blocks still apply.",
      icon: ShieldPlus,
    },
  ];

  const CODEX_SANDBOX_OPTIONS = CODEX_SANDBOX_ORDER.map((value) => ({
    value,
    label: CODEX_SANDBOX_LABELS[value],
  }));

  const CODEX_REASONING_OPTIONS: Array<{
    value: CodexFormOptions["reasoningEffort"];
    label: string;
    helper: string;
  }> = [
    { value: "default", label: "Auto", helper: "Use provider default" },
    { value: "low", label: "Low", helper: "Fastest, minimal planning" },
    { value: "medium", label: "Medium", helper: "Balanced effort" },
    { value: "high", label: "High", helper: "Most careful, slower" },
    { value: "xhigh", label: "Extra High", helper: CODEX_XHIGH_REASONING_HELPER_TEXT },
  ];
  const CODEX_SERVICE_TIER_OPTIONS: Array<{
    value: CodexServiceTier;
    label: string;
    helper: string;
  }> = [
    { value: "standard", label: "Standard", helper: "Use normal Codex speed." },
    { value: "fast", label: "Fast", helper: CODEX_FAST_MODE_HELPER_TEXT },
  ];

  const ZIP_LAYOUT_INHERIT = "__inherit__";
  const ZIP_NOTES_INHERIT = "__inherit__";
  const ZIP_AUTO_INHERIT = "__inherit__";
  const VOICE_PROVIDER_INHERIT = "__inherit__";
  const VOICE_ITALIC_NARRATION_INHERIT = "__inherit_italic_narration__";

  interface BasicPayloadBody {
    displayName: string;
    agentType: PrimaryAgentType;
    show_reasoning: boolean;
    preserve_reasoning: boolean;
    tool_approval_mode?: "off" | "all" | null;
    memory_enabled?: boolean;
    /** SA-111 P4 (DL-111-11). */
    workers_enabled?: boolean;
    dms_enabled?: boolean;
    dm_senders?: DmSenderScope | { scope?: DmSenderScope; agentIds?: string[] } | null;
    dm_sender_agent_ids?: string[] | null;
    jev_juice_skill_tool_hints?: boolean | null;
    jev_juice_judge_tool?: boolean | null;
    jev_juice_memory_rerank?: boolean | null;
    jev_juice_memory_recall?: boolean | null;
    jev_juice_reply_check?: boolean | null;
    jev_juice_style_coach?: boolean | null;
    wake_enabled?: boolean;
    wake_timeout_minutes?: number | null;
    wake_target?: WakeTarget;
    memory_linger_turns?: number;
    memory_recall_linger_turns?: number;
    memory_lane_budgets?: Record<string, number>;
    memory_window?: Record<string, any>;
    webhook_url: string | null;
    webhookUrl: string | null;
    agent_url: string | null;
    default_project_id?: string | null;
    include_global_prompt: boolean;
    primary_model_provider: string | null;
    primary_model_name: string | null;
    primary_model_preset_id?: string | null;
    primary_model_connection?: ModelConnectionInfo | null;
    avatar_url: string | null;
    avatar: string | null;
    avatar_icon_ref: IconRef | null;
    avatar_icon_fit: AvatarIconFit | null;
    goon_id?: string | null;
    provider_specific_settings?: Record<string, any> | null;
    primary_model_temperature?: number | null;
    primary_model_max_tokens?: number | null;
    primary_model_top_p?: number | null;
    primary_model_top_k?: number | null;
    primary_model_frequency_penalty?: number | null;
    primary_model_presence_penalty?: number | null;
    primary_model_seed?: number | null;
    primary_model_stop_sequences?: string[] | null;
    primary_model_reasoning_effort?: string | null;
    primary_model_capabilities?: ModelCapabilities | null;
    voice_profile?: AgentVoiceProfile | null;
    auto_compact_settings?: AgentAutoCompactSettings | null;
  }

  type SaveState = "idle" | "saving" | "saved";
  type BasicSaveScope =
    | "core"
    | "projects"
    | "instructions"
    | "tools"
    | "voice"
    | "permissions"
    | "approvals";
  type CliSaveScope = "core" | "projects" | "instructions" | "permissions" | "tools";
  type AccessSaveScope =
    | "agent-skills"
    | "agent-artifacts"
    | "subagent-skills"
    | "subagent-artifacts";
  type SubagentSaveScope = "core" | "instructions" | "tools" | "permissions";

  function normalizeAccessEntityIds(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return Array.from(
      new Set(
        input
          .map((entry) => sanitizeId(String(entry ?? "").trim()))
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  function getArtifactAccessScope(artifact: ArtifactRow): "all" | "selected" {
    if (!isArtifactAgentUseEligible(artifact)) return "selected";
    const direct =
      typeof (artifact as any).agent_access_scope === "string"
        ? String((artifact as any).agent_access_scope).trim().toLowerCase()
        : "";
    if (direct === "all" || direct === "selected") {
      return direct;
    }
    const allowlist = normalizeAccessEntityIds(artifact.agent_allowlist);
    if (allowlist.length > 0) return "selected";
    if (artifact.agent_use_enabled === true) return "selected";
    return "all";
  }

  function getArtifactPlacementLabel(artifact: ArtifactRow): string {
    if (artifact.zone === "header") return "Header";
    if (artifact.zone === "panel") return "Panel";
    if (artifact.zone === "trigger") return "Trigger";
    if (artifact.widget_position === "header-icon") return "Header";
    if (artifact.widget_position === "panel-tab") return "Panel";
    if (artifact.widget_position === "header-dropdown") return "Trigger";
    return "Unpublished";
  }

  function getCurrentAccessEntityId(): string | null {
    if (selectedEntity?.kind === "agent") {
      return selectedAgentId;
    }
    if (selectedEntity?.kind === "subagent") {
      return selectedEditableSubagentId;
    }
    return null;
  }

  function getSlashCommandEnabledForEntity(
    command: SlashCommandRow,
    entityId: string | null,
  ): boolean {
    if (!entityId) return false;
    if (command.enabled_for_all_agents === true) return true;
    // BL-544: a command with no list at all is on for every agent (the runtime rule,
    // `commandEnabledForAgent`); an empty list is on for nobody. Turning one agent off there
    // keeps the others on: the route writes them as an explicit list.
    if (!Object.prototype.hasOwnProperty.call(command, "enabled_agent_ids")) return true;
    return normalizeAccessEntityIds(command.enabled_agent_ids).includes(entityId);
  }

  function getArtifactEnabledForEntity(
    artifact: ArtifactRow,
    entityId: string | null,
  ): boolean {
    if (!entityId) return false;
    if (!isArtifactAgentUseEligible(artifact)) return false;
    if (artifact.agent_use_enabled === false) return false;
    if (getArtifactAccessScope(artifact) === "all") return true;
    return normalizeAccessEntityIds(artifact.agent_allowlist).includes(entityId);
  }

  function markAccessSaved(_message: string) {
    accessSaveState = "saved";
    accessSaveError = null;
    accessLastSaved = new Date();
    setTimeout(() => {
      if (accessSaveState === "saved") {
        accessSaveState = "idle";
      }
    }, 1800);
  }

  async function loadAccessResources(force = false) {
    if (!data?.user?.id) return;
    if (accessResourcesLoaded && !force) return;

    accessResourcesLoading = true;
    accessResourcesError = null;
    try {
      const [commands, artifacts] = await Promise.all([
        slashCommandStore.getSlashCommands(data.user.id),
        artifactService.getArtifacts(data.user.id),
      ]);

      accessSlashCommands = [...commands].sort((left, right) =>
        String(left.displayName || left.name || left.id).localeCompare(
          String(right.displayName || right.name || right.id),
        ),
      );
      accessArtifacts = artifacts
        .filter((artifact) => isArtifactAgentUseEligible(artifact))
        .sort((left, right) =>
          String(left.name || left.id).localeCompare(String(right.name || right.id)),
        );
      accessResourcesLoaded = true;
    } catch (error) {
      console.error("Failed to load access resources:", error);
      accessResourcesError =
        error instanceof Error ? error.message : "Failed to load access resources.";
    } finally {
      accessResourcesLoading = false;
    }
  }

  async function toggleSlashCommandAccess(
    command: SlashCommandRow,
    entityId: string,
    enabled: boolean,
    scope: AccessSaveScope,
  ) {
    if (command.enabled_for_all_agents === true) return;

    const previous = accessSlashCommands;
    const nextIds = new Set(normalizeAccessEntityIds(command.enabled_agent_ids));
    if (enabled) nextIds.add(entityId);
    else nextIds.delete(entityId);
    const nextEnabledAgentIds = Array.from(nextIds);

    accessSaveScope = scope;
    accessSaveState = "saving";
    accessSaveError = null;

    accessSlashCommands = accessSlashCommands.map((entry) =>
      entry.id === command.id
        ? {
            ...entry,
            enabled_agent_ids: nextEnabledAgentIds,
            can_be_attached_to_agents:
              entry.enabled_for_all_agents === true || nextEnabledAgentIds.length > 0,
          }
        : entry,
    );

    try {
      // BL-544: one agent, against the list as stored now. Sending this copy's whole list (and
      // `enabled_for_all_agents: false`) undid every change made elsewhere since Access loaded.
      const updated = await slashCommandStore.setSlashCommandAgentAccess(
        command.id,
        entityId,
        enabled,
      );

      accessSlashCommands = accessSlashCommands.map((entry) =>
        entry.id === updated.id ? updated : entry,
      );
      markAccessSaved("Skills & Prompts access saved");
    } catch (error) {
      accessSlashCommands = previous;
      accessSaveState = "idle";
      accessSaveError =
        error instanceof Error ? error.message : "Failed to save command access.";
    }
  }

  async function toggleArtifactAccess(
    artifact: ArtifactRow,
    entityId: string,
    enabled: boolean,
    scope: AccessSaveScope,
  ) {
    if (!isArtifactAgentUseEligible(artifact)) return;
    if (artifact.agent_use_enabled === false) return;
    if (getArtifactAccessScope(artifact) === "all") return;

    const previous = accessArtifacts;
    const nextIds = new Set(normalizeAccessEntityIds(artifact.agent_allowlist));
    if (enabled) nextIds.add(entityId);
    else nextIds.delete(entityId);
    const nextAllowlist = Array.from(nextIds);

    accessSaveScope = scope;
    accessSaveState = "saving";
    accessSaveError = null;

    accessArtifacts = accessArtifacts.map((entry) =>
      entry.id === artifact.id
        ? {
            ...entry,
            agent_allowlist: nextAllowlist,
          }
        : entry,
    );

    try {
      // BL-544: one agent, against the list as stored now; Agent Use and the all-agents scope
      // stay as they are (this copy's whole list and `agent_access_scope: "selected"` undid a
      // list or an all-agents switch saved elsewhere since Access loaded).
      const updated = await artifactService.setArtifactAgentAccess(
        artifact.id,
        entityId,
        enabled,
      );

      accessArtifacts = accessArtifacts.map((entry) =>
        entry.id === updated.id ? updated : entry,
      );
      dispatchArtifactUpdated(updated.id);
      markAccessSaved("Artifact access saved");
    } catch (error) {
      accessArtifacts = previous;
      accessSaveState = "idle";
      accessSaveError =
        error instanceof Error ? error.message : "Failed to save artifact access.";
    }
  }

  let {
    data = null,
    initialAgentId = null,
  }: {
    data?: PanelData;
    initialAgentId?: string | null;
  } = $props();

  let agents = $state<AgentRow[]>([]);
  let listLoading = $state(true);
  let listError = $state<string | null>(null);
  let projectOptions = $state<AgentProjectOption[]>([]);
  let projectOptionsLoading = $state(true);
  let projectOptionsError = $state<string | null>(null);
  const projectService = new ProjectService();
  const goons = $derived(getGoons());
  const assignableGoons = $derived.by(() => goons.filter(isGoonRuntimeReady));

  let selectedAgentId = $state<string | null>(null);

  /**
   * SA-113 P2 (DL-113-01): the other primary agents this one could accept DMs from.
   *
   * Every other API/CLI primary is listed, not only the ones with DMs already on: the user
   * picks who may write, and turning that agent's own DMs on afterwards is a separate act.
   * A `DMs off` pill says which ones cannot write yet, so the list is honest rather than
   * quietly incomplete.
   */
  const dmSenderCandidates = $derived(
    agents
      .filter((agent) => {
        if (agent.id === selectedAgentId) return false;
        const type = normalizePrimaryAgentType(agent);
        return type === "api" || type === "cli";
      })
      .map((agent) => ({
        id: agent.id,
        name: agent.displayName || agent.id,
        dmsEnabled: resolveAgentDmsEnabled(agent),
      })),
  );
  let detailLoading = $state(false);
  let hydrationInProgress = $state(false);
  let lastAppliedInitialAgentId = $state<string | null>(null);
  let agentHydrationRequestId = 0;
  /**
   * BL-912: the agent whose record the forms hold (null after a reset). A read of another agent
   * fills every section; a read of this one replaces only the sections at rest (`hydrateAgent`).
   */
  let hydratedAgentId: string | null = null;
  /**
   * BL-912: a landing that belongs to an older read, or a read that left a section alone, asks
   * for a read of the shown agent; it runs when the panel comes to rest
   * (`readAgentAgainWhenAtRest`). Each read clears it when it starts. Plain, like the counter.
   */
  let agentReadDeferred = false;
  let agentReadDeferredUi = $state(false);
  let primaryOwnedSaveInFlightUi = $state(false);
  let primaryOwnedWritePendingUi = $state(false);
  type PrimaryCaptureSection = "basic" | "codex" | "claude" | "zip" | "mcp" | "assignment";
  const primaryDeferredCaptures = new Map<string, Set<PrimaryCaptureSection>>();
  const primaryCaptureWake = $state({ basic: 0, codex: 0, claude: 0, zip: 0, mcp: 0, assignment: 0 });
  let primarySaveWaitExpiredUi = $state(false);
  let primaryReadWaitError = $state<string | null>(null);
  /**
   * SA-122 A-1y (BL-1294): a memory save the server refused (409 `memory_settings_changed`) because
   * the saved memory settings changed after its baseline was read (the agent saved its own, App
   * Actions). `memoryConflictBase` is that save's baseline: the next read of the agent rebases the
   * busy basic section from it (`hydrateAgent`). One automatic resend per user edit
   * (`memoryConflictResendUsed`, Ashe's refinement b): a second refusal shows the existing Retry,
   * which reads the record and keeps the edits. Plain, like the read counter.
   */
  let memoryConflictBase: { agentId: string; base: BasicForm } | null = null;
  let memoryConflictResendUsed = false;
  const MEMORY_CONFLICT_RETRY_MESSAGE =
    "This agent's memory settings changed while you were editing them, so your change was not saved. Retry reads them again and keeps your edits.";
  const primarySettingsReadWaiting = $derived(detailLoading || agentReadDeferredUi || primaryReadWaitError !== null || primarySaveWaitExpiredUi || primaryOwnedSaveInFlightUi);
  const primaryCaptureBlocked = $derived(detailLoading || primaryReadWaitError !== null || primaryOwnedWritePendingUi);
  /**
   * BL-912: whether each Primary saver has a save queued or on its way. The basic one counts the
   * autosave and the multiline editors; the Tool Grid section has its own save and the CLI tools
   * save. Each settled save asks for the deferred read.
   */
  const basicSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));
  const promptSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));
  const zipSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));
  const mcpSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));
  const cliToolSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));
  const codexSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));
  const claudeSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));
  const assignmentSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));

  let basicForm = $state<BasicForm>(createDefaultBasicForm());

  $effect(() => {
    if (!basicForm.show_reasoning && basicForm.preserve_reasoning) {
      basicForm.preserve_reasoning = false;
    }
  });

  let basicPersistedSignature = $state<string | null>(null);
  /**
   * BL-514: the form as it was loaded or last saved. A save sends only what differs from it
   * (`buildAgentSettingsSavePatch`), so this copy cannot take back a change the chat bar made
   * after Settings opened. Kept in step with `basicPersistedSignature`; not reactive. A landed
   * save moves it (and the signature) to the snapshot it sent, never the live form (BL-911).
   */
  let basicPersistedForm: BasicForm | null = null;
  let basicValidationError = $state<string | null>(null);
  let basicSaveState = $state<SaveState>("idle");
  let basicSaveError = $state<string | null>(null);
  let basicLastSaved = $state<Date | null>(null);
  let basicSaveScope = $state<BasicSaveScope>("core");
  let lastInvalidAgentSignature = $state<string | null>(null);


  let promptValue = $state("");
  let promptPersistedSignature = $state<string | null>(null);
  let agentPromptEditorOpen = $state(false);
  let agentBashBlockEditorOpen = $state(false);
  let agentBashAllowEditorOpen = $state(false);
  let agentBrowserFlagsEditorOpen = $state(false);

  let zipForm = $state<ZipForm>(createDefaultZipForm());
  let zipPersistedSignature = $state<string | null>(null);
  /**
   * BL-855: the four sections below as they were loaded or last saved. A save sends only what
   * differs from them (`agentSettingsSectionSaves.ts`, and `diffAgentBlockWithGroups` for the Codex
   * and Claude blocks), so a copy that the chat bar or a second Settings window has since changed is
   * never written back over that change. A failed save leaves them as they were. Not reactive,
   * like `basicPersistedForm`: each is set and cleared beside its `...PersistedSignature`, and no
   * effect reads what it writes. Codex and Claude: `null` while the agent has no such block yet
   * (its first save then writes the whole block).
   */
  let zipPersistedPayload: ZipPayloadBody | null = null;
  let codexPersistedBlock: CodexAgentSettings | null = null;
  let claudePersistedBlock: ClaudeAgentSettings | null = null;
  let mcpPersistedValues: McpSectionValues | null = null;
  let zipValidationError = $state<string | null>(null);
  let zipSaveState = $state<SaveState>("idle");
  let zipSaveError = $state<string | null>(null);
  let zipLastSaved = $state<Date | null>(null);

  let codexForm = $state(createDefaultCodexForm());
  let codexPersistedSignature = $state<string | null>(null);
  let codexSaveState = $state<SaveState>("idle");
  let codexSaveError = $state<string | null>(null);
  let codexLastSaved = $state<Date | null>(null);
  let codexSaveScope = $state<CliSaveScope>("core");
  let codexAdvancedOpen = $state(false);
  let codexConfigOverridesOpen = $state(false);
  let primaryWebSearchDefaultsOpen = $state(false);
  let primaryAgentBrowserDefaultsOpen = $state(false);
  let primarySkillsAccessOpen = $state(true);
  let primaryArtifactsAccessOpen = $state(false);
  let primaryDeleteOpen = $state(false);
  let subagentDeleteOpen = $state(false);
  let subagentWebSearchDefaultsOpen = $state(false);
  let subagentAgentBrowserDefaultsOpen = $state(false);
  let subagentSkillsAccessOpen = $state(true);
  let subagentArtifactsAccessOpen = $state(false);
  let codexDirDraft = $state("");
  let codexEnableDraft = $state("");
  let codexDisableDraft = $state("");
  let subagentCodexForm = $state(createDefaultCodexForm());
  let subagentCodexPersistedSignature = $state<string | null>(null);
  let subagentCodexSaveState = $state<SaveState>("idle");
  let subagentCodexSaveError = $state<string | null>(null);
  let subagentCodexLastSaved = $state<Date | null>(null);
  let subagentCodexSaveScope = $state<CliSaveScope>("core");
  let subagentCodexAdvancedOpen = $state(false);
  let subagentCodexConfigOverridesOpen = $state(false);
  let subagentCodexEnableDraft = $state("");
  let subagentCodexDisableDraft = $state("");

  let claudeForm = $state(createDefaultClaudeForm());
  let claudePersistedSignature = $state<string | null>(null);
  let claudeSaveState = $state<SaveState>("idle");
  let claudeSaveError = $state<string | null>(null);
  let claudeLastSaved = $state<Date | null>(null);
  let claudeSaveScope = $state<CliSaveScope>("core");
  let claudeConfigOverridesOpen = $state(false);
  let claudeDirDraft = $state("");
  let claudeAllowedToolDraft = $state("");
  let claudeDisallowedToolDraft = $state("");
  let subagentClaudeForm = $state(createDefaultClaudeForm());
  let subagentClaudePersistedSignature = $state<string | null>(null);
  let subagentClaudeSaveState = $state<SaveState>("idle");
  let subagentClaudeSaveError = $state<string | null>(null);
  let subagentClaudeLastSaved = $state<Date | null>(null);
  let subagentClaudeSaveScope = $state<CliSaveScope>("core");
  let subagentClaudeConfigOverridesOpen = $state(false);
  let subagentClaudeAllowedToolDraft = $state("");
  let subagentClaudeDisallowedToolDraft = $state("");
  let managedConfigDialogOpen = $state(false);
  let managedConfigLoading = $state(false);
  let managedConfigError = $state<string | null>(null);
  let managedConfigProvider = $state<ManagedConfigProvider | null>(null);
  let managedConfigFileName = $state("");
  let managedConfigPath = $state("");
  let managedConfigContents = $state("");
  function toCustomToolArray(
    value: unknown,
  ): Array<{
    tool_name: string;
    buffer_size?: number;
    zip_threshold?: number;
    auto_zip?: boolean;
    zip_disabled?: boolean;
  }> {
    if (Array.isArray(value)) {
      return value as Array<{
        tool_name: string;
        buffer_size: number;
        zip_threshold: number;
        auto_zip?: boolean;
        zip_disabled?: boolean;
      }>;
    }
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, any>).map(
        ([toolName, config]) => {
          const bufferValue = Number(config?.buffer_size);
          const thresholdValue = Number(config?.zip_threshold);
          return {
            tool_name: toolName,
            buffer_size: Number.isFinite(bufferValue) ? bufferValue : undefined,
            zip_threshold: Number.isFinite(thresholdValue) ? thresholdValue : undefined,
            auto_zip:
              typeof config?.auto_zip === "boolean" ? config.auto_zip : undefined,
            zip_disabled:
              typeof config?.zip_disabled === "boolean" ? config.zip_disabled : undefined,
          };
        },
      );
    }
    return [];
  }

  function normaliseGlobalZipSettings(
    settings: UserSettingsRow["global_zip_settings"] | null | undefined,
  ) {
    if (!settings) return null;

    return {
      ...settings,
      custom_tool_settings: toCustomToolArray(settings.custom_tool_settings),
    };
  }

  let globalZipSettings = $state<UserSettingsRow["global_zip_settings"] | null>(null);

  let defaultMCPGateways = $state<string[]>([]);
  let defaultMCPToolSelections = $state<MCPToolSelections>([]);
  let defaultCliToolIds = $state<string[]>([]);
  let cliToolIdsExplicit = $state(false);
  let dcmDisplaySettings = $state<AgentDcmDisplaySettings>(
    createDefaultDcmDisplaySettings(),
  );
  let mcpPersistedSignature = $state<string | null>(null);
  let mcpSaveState = $state<SaveState>("idle");
  let mcpSaveError = $state<string | null>(null);
  let mcpLastSaved = $state<Date | null>(null);
  let hasSeededGlobalZipSettings = false;
  let mcpRenderNonce = $state(0);
  let subagentDefaultMCPGateways = $state<string[]>([]);
  let subagentDefaultMCPToolSelections = $state<MCPToolSelections>([]);
  let subagentDefaultCliToolIds = $state<string[]>([]);
  let subagentCliToolIdsExplicit = $state(false);
  let subagentDcmDisplaySettings = $state<AgentDcmDisplaySettings>(
    createDefaultDcmDisplaySettings(),
  );
  let subagentMcpPersistedSignature = $state<string | null>(null);
  let subagentMcpRenderNonce = $state(0);

  let selectedSubagentIds = $state<string[]>([]);
  let assignmentPersistedSignature = $state<string | null>(null);
  let assignmentSaveState = $state<SaveState>("idle");
  let assignmentSaveError = $state<string | null>(null);
  let assignmentLastSaved = $state<Date | null>(null);
  let accessResourcesLoading = $state(false);
  let accessResourcesLoaded = $state(false);
  let accessResourcesError = $state<string | null>(null);
  let accessSaveState = $state<SaveState>("idle");
  let accessSaveError = $state<string | null>(null);
  let accessLastSaved = $state<Date | null>(null);
  let accessSaveScope = $state<AccessSaveScope>("agent-skills");
  let accessSlashCommands = $state<SlashCommandRow[]>([]);
  let accessArtifacts = $state<ArtifactRow[]>([]);
  let subagentsLoading = $state(false);

  let savedModels = $state<SavedModel[]>([]);
  let savedModelsLoading = $state(false);
  let savedModelsError = $state<string | null>(null);
  let webSearchProviderAvailabilityLoading = $state(false);
  let webSearchProviderAvailabilityError = $state<string | null>(null);
  let hasLoadedWebSearchProviderAvailability = $state(false);
  let availableWebSearchProviders = $state<Record<"exa" | "perplexity", boolean>>({
    exa: false,
    perplexity: false,
  });
  let agentBrowserRuntimeStatusLoading = $state(false);
  let agentBrowserRuntimeStatusError = $state<string | null>(null);
  let agentBrowserRuntimeStatus = $state<AgentBrowserRuntimeStatus | null>(null);
  let nativeSandboxStatusLoading = $state(false);
  let nativeSandboxStatusError = $state<string | null>(null);
  let nativeSandboxStatus = $state<NativeSandboxStatus | null>(null);
  let nativeAppleSandboxStatus = $state<NativeSandboxStatus | null>(null);
  const nativeWebSearchProviderOptions = $derived.by<
    Array<{ value: NativeWebSearchProvider; label: string }>
  >(() => {
    const options: Array<{ value: NativeWebSearchProvider; label: string }> = [
      {
        value: "duckduckgo-html",
        label: NATIVE_WEB_SEARCH_PROVIDER_LABELS["duckduckgo-html"],
      },
    ];

    if (availableWebSearchProviders.exa) {
      options.push({
        value: "exa",
        label: NATIVE_WEB_SEARCH_PROVIDER_LABELS.exa,
        });
      }
    if (availableWebSearchProviders.perplexity) {
      options.push({
        value: "perplexity",
        label: NATIVE_WEB_SEARCH_PROVIDER_LABELS.perplexity,
      });
    }

    return options;
  });
  const savedModelsFromStore = $derived(savedModelsStore.getSavedModels());
  const matrixEntries = $derived(compatibilityMatrixStore.getMatrixEntries());
  const isChatPreset = (model: SavedModel) => (model.purpose ? model.purpose === "chat" : true);
  const chatModelPresets = $derived.by(() => savedModels.filter(isChatPreset));
  let modelConnectionOptions = $state<CatalogConnectionOption[] | null>(null);
  let modelConnectionOptionsLoading = $state(false);
  let modelConnectionOptionsError = $state<string | null>(null);
  let modelConnectionOptionsLoadedForAgentType = $state<StoredPrimaryAgentType | null>(null);
  let unsupportedSubagentModelParams = $state<string[]>([]);
  let voiceProfiles = $state<VoiceProfileRecord[]>([]);
  let voiceProfilesLoading = $state(false);
  let voiceProfilesError = $state<string | null>(null);

  let voiceProviders = $state<VoiceProviderSummary[]>([]);
  let voiceProvidersLoading = $state(false);
  let voiceProvidersError = $state<string | null>(null);

  let voiceOptions = $state<VoiceSummary[]>([]);
  let voiceOptionsLoading = $state(false);
  let voiceOptionsError = $state<string | null>(null);
  let voiceOptionsKey = $state("");
  let inputDevices = $state<Array<{ id: string; label: string }>>([]);

  let voiceModelManual = $state(false);
  let voiceIdManual = $state(false);
  let agentVoiceTestPhrase = $state(DEFAULT_AGENT_VOICE_TEST_PHRASE);
  let agentVoicePreviewBusy = $state(false);
  let selectedModelId = $state<string | null>(null);

  const SETTINGS_DISCLOSURE_TRIGGER_CLASS =
    "batshit-settings-disclosure-trigger";
  const SETTINGS_PERMISSION_TOGGLE_ITEM_CLASS =
    "batshit-settings-permission-toggle-item";
  const SETTINGS_SUBSET_DISCLOSURE_CONTAINER_CLASS =
    "batshit-settings-disclosure-row";
  const SETTINGS_INFO_TRIGGER_CLASS =
    "batshit-settings-info-trigger inline-flex h-5 w-5 shrink-0 items-center justify-center";
  const SETTINGS_INFO_CONTENT_CLASS =
    "batshit-settings-info-content batshit-settings-card-elevated batshit-settings-card-info-callout z-[var(--z-popover)] w-72";

  type AgentVoiceOption = VoiceSummary & {
    profileId?: string;
    model?: string | null;
  };

  const BROWSER_VOICE_PROVIDER_SUMMARY: VoiceProviderSummary = {
    id: "browser",
    label: "Browser (Web Speech API)",
    type: "browser",
    supports: {
      tts: true,
      stt: true,
      listVoices: false,
      clone: false,
      streaming: false,
      styles: false,
      emotions: false,
    },
    sttCapabilities: BROWSER_STT_CAPABILITIES,
    sttModels: [],
    ttsModels: [],
  };

  function providerSupportsTranscribe(provider: VoiceProviderSummary): boolean {
    if (!provider.supports.stt) return false;
    if (provider.id === "browser") return true;
    const capabilities = provider.sttCapabilities;
    return capabilities ? capabilities.recorded : true;
  }

  function providerSupportsVoiceModeStt(provider: VoiceProviderSummary): boolean {
    if (!provider.supports.stt) return false;
    const capabilities = provider.sttCapabilities;
    if (!capabilities) return provider.id === "browser";
    return capabilities.recorded || (capabilities.realtime && capabilities.runtimeSupport === "supported");
  }

  function providerHasRealtimeVoiceMode(provider: VoiceProviderSummary): boolean {
    const capabilities = provider.sttCapabilities;
    if (!capabilities) return provider.id === "browser";
    return capabilities.realtime && capabilities.runtimeSupport === "supported";
  }

  function providerUsesRecordedVoiceMode(provider: VoiceProviderSummary | null): boolean {
    if (!provider) return false;
    const capabilities = provider.sttCapabilities;
    if (!capabilities) return false;
    return capabilities.recorded && !(capabilities.realtime && capabilities.runtimeSupport === "supported");
  }

  function getVoiceModeSubmitModeLabel(mode?: VoiceModeSubmitMode | null) {
    return mode === "manual" ? "Manual Turn" : "Auto Listen";
  }

  function getManualTurnUnavailableReason({
    runtime,
    inputMode,
    provider
  }: {
    runtime: VoiceSessionRuntime;
    inputMode: VoiceModeInputMode;
    provider: VoiceProviderSummary | null;
  }) {
    if (runtime === "livekit") {
      return "Manual Turn is for Direct Voice Mode recorded-turn STT. LiveKit manages the microphone room continuously.";
    }
    if (inputMode === "text") {
      return "Manual Turn is not used with Text Input because you send composer text yourself.";
    }
    if (provider && providerHasRealtimeVoiceMode(provider)) {
      return "Manual Turn is disabled because this agent's Voice Mode STT is a realtime mic provider.";
    }
    return "Manual Turn is only available for Direct Voice Mode with a recorded-turn STT provider.";
  }

  function getSttModelsForLane(
    provider: VoiceProviderSummary | null,
    lane: "transcribe" | "realtime",
  ): string[] {
    if (!provider) return [];
    if (lane === "realtime" && providerHasRealtimeVoiceMode(provider)) {
      return provider.realtimeSttModels?.length ? provider.realtimeSttModels : (provider.sttModels ?? []);
    }
    return provider.sttModels ?? [];
  }

  function getDefaultSttModelForLane(
    provider: VoiceProviderSummary | null,
    lane: "transcribe" | "realtime",
  ): string | null {
    if (!provider) return null;
    if (lane === "realtime" && providerHasRealtimeVoiceMode(provider)) {
      return provider.defaultRealtimeSttModel ?? provider.realtimeSttModels?.[0] ?? null;
    }
    return provider.defaultSttModel ?? (!provider.supports.tts ? provider.defaultModel ?? null : null);
  }

  function getVoiceRuntimeLabel(runtime?: VoiceSessionRuntime | null) {
    return runtime === "livekit" ? "LiveKit Bridge (room + sidecar)" : "Direct Voice Mode (STT + TTS)";
  }

  function getVoiceRuntimeBadgeClass(runtime?: VoiceSessionRuntime | null) {
    return runtime === "livekit"
      ? "batshit-settings-pill is-info"
      : "batshit-settings-pill is-success";
  }

  function getVoiceRuntimeSummary(runtime?: VoiceSessionRuntime | null) {
    if (runtime === "livekit") {
      return "The ChatBar Voice button opens a LiveKit room. Bridge mode still uses the Voice Mode STT and TTS choices below.";
    }
    return "The ChatBar Voice button uses Batshit STT for listening and TTS for spoken replies.";
  }

  function getVoiceModeInputLabel(mode?: VoiceModeInputMode | null) {
    return mode === "text" ? "Text Input" : "Mic STT";
  }

  function getVoiceModeInputBadgeClass(mode?: VoiceModeInputMode | null) {
    return mode === "text"
      ? "batshit-settings-pill is-info"
      : "batshit-settings-pill is-success";
  }

  function getVoiceModeInputSummary(mode?: VoiceModeInputMode | null) {
    if (mode === "text") {
      return "Voice Mode accepts typed or system-dictated composer text and still speaks replies.";
    }
    return "Voice Mode listens through the selected Voice Mode STT provider.";
  }

  function resolveVoiceProviderById(providerId?: string | null): VoiceProviderSummary | null {
    if (!providerId) return null;
    return (
      voiceProviders.find((provider) => provider.id === providerId) ??
      (providerId === "browser" ? BROWSER_VOICE_PROVIDER_SUMMARY : null)
    );
  }

  function resolveVoiceProviderLabel(providerId?: string | null) {
    return resolveVoiceProviderById(providerId)?.label ?? providerId ?? "Not configured";
  }

  function getTranscribeSttLaneLabel(provider: VoiceProviderSummary | null) {
    if (!provider) return "Not configured";
    if (provider.id === "browser") return "Dictation";
    return provider.sttCapabilities?.recorded ? "Recorded audio" : "Dictation";
  }

  function getVoiceModeSttLaneLabel(provider: VoiceProviderSummary | null) {
    if (!provider) return "Not configured";
    const capabilities = provider.sttCapabilities;
    if (!capabilities) return provider.id === "browser" ? "Realtime mic" : "Unknown";
    if (capabilities.realtime && capabilities.runtimeSupport === "supported") return "Realtime mic";
    if (capabilities.recorded) return "Recorded turn";
    if (capabilities.runtimeSupport === "candidate") return "Realtime candidate";
    return "Unavailable";
  }

  function getVoiceModeSttBadgeClass(provider: VoiceProviderSummary | null) {
    const capabilities = provider?.sttCapabilities;
    if (!provider) return "batshit-settings-pill";
    if (!capabilities && provider.id === "browser") return "batshit-settings-pill is-success";
    if (capabilities?.realtime && capabilities.runtimeSupport === "supported") {
      return "batshit-settings-pill is-success";
    }
    if (capabilities?.recorded) return "batshit-settings-pill is-warning";
    if (capabilities?.runtimeSupport === "candidate") return "batshit-settings-pill is-info";
    return "batshit-settings-pill is-danger";
  }

  function getTtsLaneLabel(provider: VoiceProviderSummary | null) {
    if (!provider) return "Not configured";
    return provider.supports.streaming ? "Realtime TTS" : "Batch TTS";
  }

  function getTtsBadgeClass(provider: VoiceProviderSummary | null) {
    if (!provider) return "batshit-settings-pill";
    return provider.supports.streaming ? "batshit-settings-pill is-success" : "batshit-settings-pill";
  }

  function getVoiceSourceLabel(hasAgentOverride: boolean) {
    return hasAgentOverride ? "Agent override" : "Inherited from Global";
  }

  function getItalicNarrationLabel(value: VoiceItalicNarrationBehavior) {
    return value === "silent" ? "Silent" : "Spoken";
  }

  function getAgentItalicNarrationSelectLabel(
    value: "" | VoiceItalicNarrationBehavior,
    globalValue: VoiceItalicNarrationBehavior,
  ) {
    if (value) return getItalicNarrationLabel(value);
    return `Use Global Default (${getItalicNarrationLabel(globalValue)})`;
  }

  function getInputDeviceLabel(inputDeviceId?: string | null) {
    if (inputDeviceId) {
      return (
        inputDevices.find((device) => device.id === inputDeviceId)?.label ??
        "Selected microphone"
      );
    }

    const defaultDevice = inputDevices.find((device) => device.id === "default");
    return defaultDevice?.label ? `System default (${defaultDevice.label})` : "System default";
  }

  function getGoonLipSyncLabel(settings: ReturnType<typeof normalizeVoiceSettings>) {
    if (settings.goonLipSync?.mode === "viseme") {
      return settings.goonLipSync.analyzerId === "audio2face-3d"
        ? "NVIDIA Audio2Face"
        : "Rhubarb WASM";
    }

    return "Shitty but Fast";
  }

  function getGoonLipSyncBadgeClass(settings: ReturnType<typeof normalizeVoiceSettings>) {
    return settings.goonLipSync?.mode === "viseme"
      ? "batshit-settings-pill is-info"
      : "batshit-settings-pill";
  }

  const voiceProviderOptions = $derived(
    voiceProviders.filter((provider) => provider.supports.tts),
  );
  const sttProviderOptions = $derived(
    voiceProviders.filter(providerSupportsTranscribe),
  );
  const realtimeSttProviderOptions = $derived(
    voiceProviders.filter(providerSupportsVoiceModeStt),
  );

  const selectedVoiceProvider = $derived(
    voiceProviderOptions.find(
      (provider) => provider.id === basicForm.voice_profile.provider,
    ) ?? null,
  );

  const voiceModelOptions = $derived(
    selectedVoiceProvider?.ttsModels ?? [],
  );

  const selectedVoiceDefaultModel = $derived(
    selectedVoiceProvider?.defaultTtsModel ?? selectedVoiceProvider?.defaultModel ?? null,
  );

  const selectedSttProvider = $derived(
    sttProviderOptions.find(
      (provider) => provider.id === basicForm.voice_profile.sttProvider,
    ) ?? null,
  );
  const selectedRealtimeSttProvider = $derived(
    realtimeSttProviderOptions.find(
      (provider) => provider.id === basicForm.voice_profile.realtimeSttProvider,
    ) ?? null,
  );

  const sttModelOptions = $derived(
    getSttModelsForLane(selectedSttProvider, "transcribe"),
  );
  const realtimeSttModelOptions = $derived(
    getSttModelsForLane(selectedRealtimeSttProvider, "realtime"),
  );

  const selectedSttDefaultModel = $derived(
    getDefaultSttModelForLane(selectedSttProvider, "transcribe"),
  );
  const selectedRealtimeSttDefaultModel = $derived(
    getDefaultSttModelForLane(selectedRealtimeSttProvider, "realtime"),
  );

  const canListAgentVoices = $derived(
    selectedVoiceProvider?.supports.listVoices ?? false,
  );

  const agentVoiceOptions = $derived.by<AgentVoiceOption[]>(() => {
    const provider = basicForm.voice_profile.provider;
    if (!provider) return [];

    const merged = new Map<string, AgentVoiceOption>();
    const defaultVoiceId = selectedVoiceProvider?.defaultVoice?.trim();
    if (defaultVoiceId) {
      merged.set(defaultVoiceId, {
        id: defaultVoiceId,
        name: defaultVoiceId,
        provider: provider as VoiceProviderId,
        isDefault: true,
      });
    }
    voiceOptions.forEach((voice) => {
      merged.set(voice.id, voice);
    });

    voiceProfiles
      .filter((profile) => profile.provider === provider)
      .forEach((profile) => {
        if (!merged.has(profile.voiceId)) {
          merged.set(profile.voiceId, {
            id: profile.voiceId,
            name: profile.name,
            provider: profile.provider,
            isClone: true,
            profileId: profile.id,
            model: profile.model ?? null,
          });
        }
      });

    return Array.from(merged.values());
  });

  const canSelectAgentVoices = $derived(
    canListAgentVoices || agentVoiceOptions.length > 0,
  );

  const voiceRefreshBusy = $derived(
    voiceOptionsLoading || voiceProfilesLoading,
  );

  const selectedPrimaryModel = $derived(
    selectedModelId ? savedModels.find((item) => item.id === selectedModelId) ?? null : null,
  );
  const selectedPrimaryModelAvailability = $derived.by(() =>
    selectedPrimaryModel
      ? getModelPresetAvailability({
          model: selectedPrimaryModel,
          agentType: basicForm.agentType,
          connectionOptions: modelConnectionOptions,
        })
      : null,
  );
  const selectedCliConnectionSetup = $derived.by(() => {
    const option = selectedPrimaryModelAvailability?.connectionOption ?? null;
    return isCliLoginSetupConnectionOption(option) ? option : null;
  });

  const selectedVoiceSessionConfig = $derived(
    resolveModelVoiceSessionConfig(selectedPrimaryModel),
  );

  const voiceModeLockedBySpeechToSpeech = $derived(
    Boolean(selectedVoiceSessionConfig?.locksVoiceModeSettings),
  );

  const voiceModeLockLabel = $derived(
    getVoiceModeLockLabel(selectedPrimaryModel),
  );

  const globalVoiceSettings = $derived.by(() => {
    const settings = getUserSettings() ?? data?.userSettings ?? null;
    return normalizeVoiceSettings(settings?.voice_settings);
  });
  const globalVoiceRuntime = $derived(globalVoiceSettings.voiceSessionRuntime ?? "direct");
  const globalVoiceModeInputMode = $derived(
    globalVoiceSettings.voiceMode?.inputMode ?? DEFAULT_VOICE_MODE_INPUT_MODE,
  );
  const globalVoiceModeSubmitMode = $derived(
    globalVoiceSettings.voiceMode?.submitMode ?? DEFAULT_VOICE_MODE_SUBMIT_MODE,
  );
  const globalTranscribeProviderId = $derived(globalVoiceSettings.stt?.providerId ?? "browser");
  const globalVoiceModeSttProviderId = $derived(
    globalVoiceSettings.realtimeStt?.providerId ?? "browser",
  );
  const globalTtsProviderId = $derived(globalVoiceSettings.tts?.providerId ?? "browser");
  const globalTtsItalicNarrationBehavior = $derived(
    globalVoiceSettings.tts?.narration?.italicBehavior ??
      DEFAULT_TTS_ITALIC_NARRATION_BEHAVIOR,
  );
  const agentVoiceRuntimeInherited = $derived(!basicForm.voice_profile.voiceSessionRuntime);
  const agentVoiceModeInputInherited = $derived(!basicForm.voice_profile.voiceModeInputMode);
  const agentVoiceModeSubmitInherited = $derived(!basicForm.voice_profile.voiceModeSubmitMode);
  const agentTranscribeProviderInherited = $derived(!basicForm.voice_profile.sttProvider);
  const agentVoiceModeSttProviderInherited = $derived(!basicForm.voice_profile.realtimeSttProvider);
  const agentTtsProviderInherited = $derived(!basicForm.voice_profile.provider);
  const agentTtsItalicNarrationInherited = $derived(
    !basicForm.voice_profile.ttsItalicNarrationBehavior,
  );
  const effectiveAgentVoiceRuntime = $derived(
    basicForm.voice_profile.voiceSessionRuntime || globalVoiceRuntime,
  );
  const effectiveAgentVoiceModeInputMode = $derived(
    basicForm.voice_profile.voiceModeInputMode || globalVoiceModeInputMode,
  );
  const agentVoiceModeUsesSttInput = $derived(effectiveAgentVoiceModeInputMode !== "text");
  const configuredAgentVoiceModeSubmitMode = $derived(
    basicForm.voice_profile.voiceModeSubmitMode || globalVoiceModeSubmitMode,
  );
  const effectiveAgentTranscribeProviderId = $derived(
    basicForm.voice_profile.sttProvider || globalTranscribeProviderId,
  );
  const effectiveAgentVoiceModeSttProviderId = $derived(
    basicForm.voice_profile.realtimeSttProvider || globalVoiceModeSttProviderId,
  );
  const effectiveAgentTtsProviderId = $derived(
    basicForm.voice_profile.provider || globalTtsProviderId,
  );
  const effectiveAgentTranscribeProvider = $derived(
    resolveVoiceProviderById(effectiveAgentTranscribeProviderId),
  );
  const effectiveAgentVoiceModeSttProvider = $derived(
    resolveVoiceProviderById(effectiveAgentVoiceModeSttProviderId),
  );
  const effectiveAgentTtsProvider = $derived(
    resolveVoiceProviderById(effectiveAgentTtsProviderId),
  );
  const effectiveAgentVoiceRuntimeLabel = $derived(
    getVoiceRuntimeLabel(effectiveAgentVoiceRuntime),
  );
  const effectiveAgentVoiceRuntimeBadgeClass = $derived(
    getVoiceRuntimeBadgeClass(effectiveAgentVoiceRuntime),
  );
  const effectiveAgentVoiceRuntimeSummary = $derived.by(() => {
    const source = getVoiceSourceLabel(!agentVoiceRuntimeInherited);
    return `${source}. ${getVoiceRuntimeSummary(effectiveAgentVoiceRuntime)}`;
  });
  const effectiveAgentVoiceModeInputLabel = $derived(
    getVoiceModeInputLabel(effectiveAgentVoiceModeInputMode),
  );
  const effectiveAgentVoiceModeInputBadgeClass = $derived(
    getVoiceModeInputBadgeClass(effectiveAgentVoiceModeInputMode),
  );
  const effectiveAgentVoiceModeInputSummary = $derived.by(() => {
    const source = getVoiceSourceLabel(!agentVoiceModeInputInherited);
    return `${source}. ${getVoiceModeInputSummary(effectiveAgentVoiceModeInputMode)}`;
  });
  const effectiveAgentTranscribeLaneLabel = $derived(
    getTranscribeSttLaneLabel(effectiveAgentTranscribeProvider),
  );
  const effectiveAgentVoiceModeSttLaneLabel = $derived(
    getVoiceModeSttLaneLabel(effectiveAgentVoiceModeSttProvider),
  );
  const effectiveAgentVoiceModeSttBadgeClass = $derived(
    getVoiceModeSttBadgeClass(effectiveAgentVoiceModeSttProvider),
  );
  const agentManualTurnAvailable = $derived(
    effectiveAgentVoiceRuntime === "direct" &&
      agentVoiceModeUsesSttInput &&
      providerUsesRecordedVoiceMode(effectiveAgentVoiceModeSttProvider),
  );
  const effectiveAgentVoiceModeSubmitMode = $derived(
    configuredAgentVoiceModeSubmitMode === "manual" && agentManualTurnAvailable
      ? "manual"
      : "auto",
  );
  const effectiveAgentVoiceModeSubmitModeLabel = $derived(
    getVoiceModeSubmitModeLabel(effectiveAgentVoiceModeSubmitMode),
  );
  const effectiveAgentVoiceModeSubmitBadgeClass = $derived(
    effectiveAgentVoiceModeSubmitMode === "manual"
      ? "batshit-settings-pill is-warning"
      : "batshit-settings-pill is-success",
  );
  const agentManualTurnUnavailableReason = $derived(
    getManualTurnUnavailableReason({
      runtime: effectiveAgentVoiceRuntime,
      inputMode: effectiveAgentVoiceModeInputMode,
      provider: effectiveAgentVoiceModeSttProvider,
    }),
  );
  const agentVoiceModeSubmitSummary = $derived.by(() => {
    const source = getVoiceSourceLabel(!agentVoiceModeSubmitInherited);
    if (configuredAgentVoiceModeSubmitMode === "manual" && !agentManualTurnAvailable) {
      return `${source}. Manual Turn is configured but currently disabled for this agent.`;
    }
    return `${source}.`;
  });
  const effectiveAgentTtsLaneLabel = $derived(getTtsLaneLabel(effectiveAgentTtsProvider));
  const effectiveAgentTtsBadgeClass = $derived(getTtsBadgeClass(effectiveAgentTtsProvider));
  const selectedAgentTranscribeProviderForBadge = $derived(
    basicForm.voice_profile.sttProvider ? selectedSttProvider : effectiveAgentTranscribeProvider,
  );
  const selectedAgentVoiceModeSttProviderForBadge = $derived(
    basicForm.voice_profile.realtimeSttProvider
      ? selectedRealtimeSttProvider
      : effectiveAgentVoiceModeSttProvider,
  );
  const selectedAgentTtsProviderForBadge = $derived(
    basicForm.voice_profile.provider ? selectedVoiceProvider : effectiveAgentTtsProvider,
  );
  const selectedAgentTranscribeLaneLabel = $derived(
    getTranscribeSttLaneLabel(selectedAgentTranscribeProviderForBadge),
  );
  const selectedAgentVoiceModeSttLaneLabel = $derived(
    getVoiceModeSttLaneLabel(selectedAgentVoiceModeSttProviderForBadge),
  );
  const selectedAgentVoiceModeSttBadgeClass = $derived(
    getVoiceModeSttBadgeClass(selectedAgentVoiceModeSttProviderForBadge),
  );
  const selectedAgentTtsLaneLabel = $derived(
    getTtsLaneLabel(selectedAgentTtsProviderForBadge),
  );
  const selectedAgentTtsBadgeClass = $derived(
    getTtsBadgeClass(selectedAgentTtsProviderForBadge),
  );
  const globalInputDeviceLabel = $derived.by(() =>
    getInputDeviceLabel(globalVoiceSettings.inputDeviceId),
  );
  const globalInputDeviceBadgeLabel = $derived(
    globalVoiceSettings.inputDeviceId ? "Selected mic" : "System default",
  );
  const globalGoonLipSyncLabel = $derived(getGoonLipSyncLabel(globalVoiceSettings));
  const globalGoonLipSyncBadgeClass = $derived(getGoonLipSyncBadgeClass(globalVoiceSettings));
  const globalGoonLipSyncBadgeLabel = $derived(
    globalVoiceSettings.goonLipSync?.mode === "viseme" ? "Viseme" : "Amplitude",
  );

  $effect(() => {
    savedModels = savedModelsFromStore;
    if (!savedModelsLoading) {
      syncSelectedModelFromAgent();
      syncSelectedModelFromSubagent();
    }
  });

  const agentModelMenuItems = $derived.by(() => {
    const items = chatModelPresets.map((model) => ({
      model,
      availability: getModelPresetAvailability({
        model,
        agentType: getPrimaryToolHostScope(basicForm.agentType),
        connectionOptions: modelConnectionOptions,
      }),
    }));

    items.sort(
      (a, b) =>
        Number(a.availability.disabled) - Number(b.availability.disabled),
    );

    return items;
  });

  const cliConnectionSetups = $derived.by(() => {
    if (!isCliPrimaryAgentType(basicForm.agentType)) return [];
    const lockedOptions =
      modelConnectionOptions?.filter(isCliLoginSetupConnectionOption) ?? [];
    if (selectedCliConnectionSetup) {
      return [selectedCliConnectionSetup];
    }

    const hintedConnectionId = resolveCliLoginSetupHintId();
    if (hintedConnectionId) {
      return lockedOptions.filter((option) => option.id === hintedConnectionId);
    }

    return [];
  });

  function isCliLoginSetupConnectionOption(
    option: CatalogConnectionOption | null | undefined,
  ): option is CatalogConnectionOption {
    return Boolean(
      option &&
        (option.id === "codex-cli" || option.id === "claude-cli") &&
        option.status === "locked" &&
        option.setupCommand,
    );
  }

  function resolveCliLoginSetupHintId(): "codex-cli" | "claude-cli" | null {
    const connectionHint = (
      basicForm.primary_model_connection?.id ??
      basicForm.primary_model_connection?.service ??
      ""
    ).toLowerCase();
    const hint = [
      basicForm.primary_model_provider,
      basicForm.primary_model_name,
      connectionHint,
      selectedAgentId,
      basicForm.displayName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (hint.includes("codex")) return "codex-cli";
    if (hint.includes("claude-cli") || hint.includes("claude")) return "claude-cli";

    return null;
  }

  const subagentModelMenuItems = $derived.by(() => {
    const items = chatModelPresets.map((model) => ({
      model,
      availability: getModelPresetAvailability({
        model,
        agentType: getSubagentToolHostScope(subagentForm.subagentType),
        connectionOptions: null,
      }),
    }));

    items.sort(
      (a, b) =>
        Number(a.availability.disabled) - Number(b.availability.disabled),
    );

    return items;
  });

  function updateProviderSpecificSetting(key: string, value: unknown) {
    untrack(() => {
      const current = basicForm.provider_specific_settings ?? {};
      if (value === null || value === undefined || value === "" || value === false) {
        const next = { ...current };
        delete next[key];
        basicForm = {
          ...basicForm,
          provider_specific_settings: Object.keys(next).length > 0 ? next : null,
        };
      } else {
        basicForm = {
          ...basicForm,
          provider_specific_settings: {
            ...current,
            [key]: value,
          },
        };
      }
    });
  }

  type NativeToolsScope = "agent" | "subagent";

  function getProviderSpecificSettings(scope: NativeToolsScope): Record<string, any> | null {
    if (scope === "subagent") {
      return subagentForm.provider_specific_settings ?? null;
    }
    return basicForm.provider_specific_settings ?? null;
  }

  function setProviderSpecificSettings(
    scope: NativeToolsScope,
    providerSettings: Record<string, any> | null,
  ) {
    if (scope === "subagent") {
      subagentForm = {
        ...subagentForm,
        provider_specific_settings: providerSettings,
      };
      return;
    }

    basicForm = {
      ...basicForm,
      provider_specific_settings: providerSettings,
    };
  }

  function getNativeToolsSettings(scope: NativeToolsScope = "agent"): Record<string, any> {
    const providerSettings = getProviderSpecificSettings(scope);
    if (!providerSettings || typeof providerSettings !== "object") return {};
    const nested = (providerSettings as Record<string, any>).nativeTools;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return {};
    return nested as Record<string, any>;
  }

  function parseBooleanSetting(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
      if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
    }
    return null;
  }

  function getNativeToolToggle(
    key: string,
    fallback: boolean,
    scope: NativeToolsScope = "agent",
  ): boolean {
    const parsed = parseBooleanSetting(getNativeToolsSettings(scope)[key]);
    return parsed === null ? fallback : parsed;
  }

  type NativeToolUiFamily =
    | "bash"
    | "mcp"
    | "cli"
    | "artifact"
    | "web-search"
    | "fabric";

  type NativeToolUiRuntime = "n8n" | "api" | "cli";

  function getNativeToolUiRuntime(scope: NativeToolsScope = "agent"): NativeToolUiRuntime {
    if (scope === "subagent") {
      if (subagentForm.subagentType === "api") return "api";
      if (subagentForm.subagentType === "cli") return "cli";
      return "n8n";
    }
    if (basicForm.agentType === "api") return "api";
    if (basicForm.agentType === "cli") return "cli";
    return "api";
  }

  function isNativeToolUiAvailable(
    family: NativeToolUiFamily,
    scope: NativeToolsScope = "agent",
  ): boolean {
    const runtime = getNativeToolUiRuntime(scope);
    switch (family) {
      case "bash":
      case "web-search":
        return runtime !== "cli";
      case "fabric":
        return scope === "agent" && runtime !== "n8n";
      case "mcp":
      case "cli":
      case "artifact":
      default:
        return true;
    }
  }

  function getNativeToolUiUnavailableMessage(
    family: NativeToolUiFamily,
    scope: NativeToolsScope = "agent",
  ): string | null {
    const runtime = getNativeToolUiRuntime(scope);
    switch (family) {
      case "bash":
        return runtime === "cli"
          ? "Use Claude/Codex built-in Bash Tool instead."
          : null;
      case "web-search":
        return runtime === "cli"
          ? "Use Claude/Codex built-in Web Search Tool instead."
          : null;
      case "fabric":
        if (scope === "subagent") {
          return "Fabric Controls are not available for Subagents.";
        }
        return null;
      default:
        return null;
    }
  }

  function getBashToolName(scope: NativeToolsScope = "agent"): string | null {
    const runtime = getNativeToolUiRuntime(scope);
    if (runtime === "api") return "native_bash_execute";
    if (runtime === "n8n") return "bash_execute";
    return null;
  }

  function getWebSearchToolName(scope: NativeToolsScope = "agent"): string | null {
    const runtime = getNativeToolUiRuntime(scope);
    if (runtime === "api") return "native_web_search";
    if (runtime === "n8n") return "web_search";
    return null;
  }

  function normalizeNativeExecutionBackend(
    value: unknown,
  ): NativeExecutionBackend | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (
      normalized === "docker_sandbox" ||
      normalized === "docker-sandbox" ||
      normalized === "sandbox" ||
      normalized === "docker"
    ) {
      return "docker_sandbox";
    }
    if (
      normalized === "apple_container" ||
      normalized === "apple-container" ||
      normalized === "apple container" ||
      normalized === "apple"
    ) {
      return "apple_container";
    }
    if (normalized === "local") return "local";
    return null;
  }

  function getDefaultNativeExecutionBackend(): NativeExecutionBackend {
    if (isDockerNativeRuntime()) return "docker_sandbox";
    if (nativeAppleSandboxStatus?.supported === false) return "docker_sandbox";
    return "apple_container";
  }

  function getNativeExecutionBackend(scope: NativeToolsScope = "agent"): NativeExecutionBackend {
    const settings = getNativeToolsSettings(scope);
    const normalized = normalizeNativeExecutionBackend(
      settings.executionBackend ??
        settings.nativeExecutionBackend ??
        settings.bashExecutionBackend ??
        settings.nativeBashExecutionBackend,
    );
    return normalized ?? getDefaultNativeExecutionBackend();
  }

  function getNativeExecutionBackendLabel(value: NativeExecutionBackend): string {
    if (value === "local" && nativeSandboxStatus?.containerized) {
      return "App container shell";
    }
    return NATIVE_EXECUTION_BACKEND_LABELS[value];
  }

  function getBashBackendForPermissionMode(mode: NativeBashAccessMode): NativeExecutionBackend {
    return mode === "dangerous" ? "local" : getDefaultNativeExecutionBackend();
  }

  function isDockerNativeRuntime(): boolean {
    return nativeSandboxStatus?.containerized === true || nativeSandboxStatus?.dockerUnsupported === true;
  }

  function getSandboxStatusForBackend(backend: NativeExecutionBackend): NativeSandboxStatus | null {
    if (backend === "apple_container") return nativeAppleSandboxStatus;
    if (backend === "docker_sandbox") return nativeSandboxStatus;
    return null;
  }

  // BL-83: the words follow the state (not installed, not answering, not a Mac); a stopped Apple
  // Container is `available` and gets the "not started yet" note instead.
  function getSandboxUnavailableMessage(
    backend: NativeExecutionBackend,
    status: NativeSandboxStatus | null,
  ): string {
    return sandboxUnavailableMessage(backend, status) ?? "";
  }

  function isAgentBrowserRuntimeInstalled(): boolean {
    return agentBrowserRuntimeStatus?.installed === true && agentBrowserRuntimeStatus?.supported !== false;
  }

  function isAgentBrowserDockerSidecarRuntime(): boolean {
    return agentBrowserRuntimeStatus?.supportLevel === "docker-sidecar";
  }

  function getNativeAgentBrowserEnabledForUi(): boolean {
    if (!isAgentBrowserRuntimeInstalled()) return false;
    return getNativeToolToggle("agentBrowserEnabled", true);
  }

  function normalizeNativeBashAccessMode(value: unknown): NativeBashAccessMode | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "plan" || normalized === "read_only" || normalized === "readonly") {
      return "plan";
    }
    if (normalized === "dangerous") return "dangerous";
    if (normalized === "agent" || normalized === "workspace") return "agent";
    return null;
  }

  function getNativeBashAccessMode(scope: NativeToolsScope = "agent"): NativeBashAccessMode {
    const settings = getNativeToolsSettings(scope);
    const explicitMode = normalizeNativeBashAccessMode(
      settings.bashAccessMode ?? settings.nativeBashAccessMode,
    );
    if (explicitMode) return explicitMode;
    return normalizeNativeBashAccessMode(settings.bashPolicyMode) ?? "agent";
  }

  function getNativeBashAccessModeLabel(mode: NativeBashAccessMode): string {
    return NATIVE_BASH_ACCESS_MODE_LABELS[mode];
  }

  function normalizeNativeBashPatternList(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
    }
    if (typeof value === "string") {
      return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
    return [];
  }

  function getNativeBashPatternListText(
    key: "bashCommandAllowList" | "bashNeverAllowList",
    scope: NativeToolsScope = "agent",
  ): string {
    const settings = getNativeToolsSettings(scope);
    const values = normalizeNativeBashPatternList(settings[key]);
    return values.join("\n");
  }

  function splitMultilineEntries(value: string): string[] {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function getMultilineEntryCountLabel(
    value: string,
    singular: string,
    plural: string,
    emptyLabel: string,
  ): string {
    const entries = splitMultilineEntries(value);
    if (entries.length === 0) return emptyLabel;
    return `${entries.length} ${entries.length === 1 ? singular : plural}`;
  }

  function getMultilinePreviewText(value: string, emptyLabel: string): string {
    const entries = splitMultilineEntries(value);
    if (entries.length === 0) return emptyLabel;
    const preview = entries.slice(0, 3).join(" • ");
    if (entries.length <= 3) return preview;
    return `${preview} • +${entries.length - 3} more`;
  }

  function updateNativeBashPatternList(
    key: "bashCommandAllowList" | "bashNeverAllowList",
    text: string,
    scope: NativeToolsScope = "agent",
  ) {
    const values = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    updateNativeToolSetting(
      key,
      values.length > 0 ? Array.from(new Set(values)) : null,
      scope,
    );
  }

  function getNativeBashTimeoutMs(scope: NativeToolsScope = "agent"): number {
    const raw = getNativeToolsSettings(scope).bashTimeoutMs;
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 30_000;
  }

  function normalizeNativeWebSearchProvider(
    value: unknown,
  ): NativeWebSearchProvider | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    return NATIVE_WEB_SEARCH_PROVIDER_ALIASES[normalized] ?? null;
  }

  function normalizeNativeExaSearchType(value: unknown): ExaSearchType | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    return normalized === "fast" ||
      normalized === "neural" ||
      normalized === "deep" ||
      normalized === "auto"
      ? normalized
      : null;
  }

  function normalizePerplexityMaxTokensPerPage(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(4096, Math.max(512, Math.floor(value)));
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return Math.min(4096, Math.max(512, parsed));
      }
    }
    return null;
  }

  function getGlobalWebSearchProviderDefault(): NativeWebSearchProvider {
    const settings = getUserSettings() ?? data?.userSettings ?? null;
    const adminSettings = (settings?.admin_settings as Record<string, any>) ?? {};
    return (
      normalizeNativeWebSearchProvider(adminSettings.web_search_default_provider) ??
      DEFAULT_NATIVE_WEB_SEARCH_PROVIDER
    );
  }

  function getGlobalWebSearchExaTypeDefault(): ExaSearchType {
    const settings = getUserSettings() ?? data?.userSettings ?? null;
    const adminSettings = (settings?.admin_settings as Record<string, any>) ?? {};
    return (
      normalizeNativeExaSearchType(
        adminSettings.web_search_exa_type ?? adminSettings.webSearchExaType,
      ) ?? DEFAULT_NATIVE_WEB_SEARCH_EXA_TYPE
    );
  }

  function getGlobalWebSearchPerplexityMaxTokensPerPageDefault(): number {
    const settings = getUserSettings() ?? data?.userSettings ?? null;
    const adminSettings = (settings?.admin_settings as Record<string, any>) ?? {};
    return (
      normalizePerplexityMaxTokensPerPage(
        adminSettings.web_search_perplexity_max_tokens_per_page ??
          adminSettings.webSearchPerplexityMaxTokensPerPage,
      ) ?? DEFAULT_NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE
    );
  }

  function getGlobalDefaultProjectLabel(): string {
    const settings = getUserSettings() ?? data?.userSettings ?? null;
    const defaultWorkspacePath =
      typeof settings?.default_workspace_path === "string"
        ? settings.default_workspace_path.trim()
        : "";
    const defaultProject =
      defaultWorkspacePath.length > 0
        ? projectOptions.find((project) => project.root_path === defaultWorkspacePath) ?? null
        : null;

    if (defaultProject?.name) {
      return `Use Global Default Project (${defaultProject.name})`;
    }

    return "Use Global Default Project";
  }

  function isWebSearchProviderAvailable(provider: NativeWebSearchProvider): boolean {
    if (provider === "duckduckgo-html") return true;
    if (provider === "exa") return availableWebSearchProviders.exa;
    return availableWebSearchProviders.perplexity;
  }

  function getNativeWebSearchProviderValue(
    scope: NativeToolsScope = "agent",
  ):
    | NativeWebSearchProvider
    | typeof NATIVE_WEB_SEARCH_PROVIDER_INHERIT {
    const settings = getNativeToolsSettings(scope);
    const normalized = normalizeNativeWebSearchProvider(
      settings.webSearchProvider ?? settings.nativeWebSearchProvider,
    );
    if (!normalized) return NATIVE_WEB_SEARCH_PROVIDER_INHERIT;
    // BL-835: the saved choice, also when its key is not ready (the label says so). It used to
    // show as "Use Global Default" and the form dropped it, so the next autosave erased it.
    return normalized;
  }

  /**
   * BL-835: a saved Exa or Perplexity choice is unavailable only when the key status has
   * loaded and names no ready key. While it loads, or when it could not be loaded (that failure
   * shows beside the picker), the panel does not know, so it does not call the choice unavailable.
   */
  function isWebSearchProviderKeyMissing(provider: NativeWebSearchProvider): boolean {
    if (provider === "duckduckgo-html") return false;
    if (!hasLoadedWebSearchProviderAvailability || webSearchProviderAvailabilityError) return false;
    return !isWebSearchProviderAvailable(provider);
  }

  function getNativeWebSearchProviderLabel(
    value: NativeWebSearchProvider | typeof NATIVE_WEB_SEARCH_PROVIDER_INHERIT,
  ): string {
    if (value === NATIVE_WEB_SEARCH_PROVIDER_INHERIT) {
      return `Use Global Default (${NATIVE_WEB_SEARCH_PROVIDER_LABELS[getGlobalWebSearchProviderDefault()]})`;
    }
    const label = NATIVE_WEB_SEARCH_PROVIDER_LABELS[value];
    return isWebSearchProviderKeyMissing(value) ? `${label} (Missing API key)` : label;
  }

  function getNativeWebSearchExaTypeValue(
    scope: NativeToolsScope = "agent",
  ):
    | ExaSearchType
    | typeof NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT {
    const settings = getNativeToolsSettings(scope);
    const normalized = normalizeNativeExaSearchType(
      settings.webSearchExaSearchType ??
        settings.webSearchExaType ??
        settings.nativeWebSearchExaSearchType,
    );
    if (!normalized) return NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT;
    return normalized;
  }

  function getNativeWebSearchExaTypeLabel(
    value: ExaSearchType | typeof NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT,
  ): string {
    if (value === NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT) {
      return `Use Global Default (${NATIVE_WEB_SEARCH_EXA_TYPE_LABELS[getGlobalWebSearchExaTypeDefault()]})`;
    }
    return NATIVE_WEB_SEARCH_EXA_TYPE_LABELS[value];
  }

  function getNativeWebSearchPerplexityMaxTokensPerPageValue(
    scope: NativeToolsScope = "agent",
  ):
    | number
    | typeof NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT {
    const settings = getNativeToolsSettings(scope);
    const normalized = normalizePerplexityMaxTokensPerPage(
      settings.webSearchPerplexityMaxTokensPerPage ??
        settings.nativeWebSearchPerplexityMaxTokensPerPage,
    );
    if (!normalized) return NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT;
    return normalized;
  }

  function getNativeWebSearchPerplexityMaxTokensPerPageLabel(
    value: number | typeof NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT,
  ): string {
    if (value === NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT) {
      return `Use Global Default (${getGlobalWebSearchPerplexityMaxTokensPerPageDefault()})`;
    }
    return `${value}`;
  }

  function normalizeNativeAgentBrowserRuntimeMode(
    value: unknown,
  ): NativeAgentBrowserRuntimeMode | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "chromium" || normalized === "separate-chromium" || normalized === "separate_chromium") {
      return "chromium";
    }
    if (normalized === "chrome-cdp" || normalized === "chrome_cdp" || normalized === "cdp" || normalized === "chrome") {
      return "chrome-cdp";
    }
    return null;
  }

  function normalizeNativeAgentBrowserProvider(
    value: unknown,
  ): NativeAgentBrowserProvider | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "local") return "local";
    if (normalized === "browserbase") return "browserbase";
    if (normalized === "browseruse" || normalized === "browser_use" || normalized === "browser-use") {
      return "browseruse";
    }
    if (normalized === "kernel") return "kernel";
    return null;
  }

  function getNativeAgentBrowserLiveViewEnabled(scope: NativeToolsScope = "agent"): boolean {
    const settings = getNativeToolsSettings(scope);
    const parsed = parseBooleanSetting(
      settings.agentBrowserLiveViewEnabled ?? settings.nativeAgentBrowserLiveViewEnabled,
    );
    return parsed ?? true;
  }

  function getNativeAgentBrowserRuntimeMode(
    scope: NativeToolsScope = "agent",
  ): NativeAgentBrowserRuntimeMode {
    const settings = getNativeToolsSettings(scope);
    const normalized = normalizeNativeAgentBrowserRuntimeMode(
      settings.agentBrowserRuntimeMode ??
        settings.nativeAgentBrowserRuntimeMode ??
        settings.agentBrowserMode,
    );
    return normalized ?? "chromium";
  }

  function getNativeAgentBrowserProvider(scope: NativeToolsScope = "agent"): NativeAgentBrowserProvider {
    const settings = getNativeToolsSettings(scope);
    const normalized = normalizeNativeAgentBrowserProvider(
      settings.agentBrowserProvider ?? settings.nativeAgentBrowserProvider,
    );
    return normalized ?? "local";
  }

  function getNativeAgentBrowserCdpPort(scope: NativeToolsScope = "agent"): number {
    const settings = getNativeToolsSettings(scope);
    const raw = settings.agentBrowserCdpPort ?? settings.nativeAgentBrowserCdpPort;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.min(65535, Math.max(1, Math.floor(raw)));
    }
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return Math.min(65535, Math.max(1, parsed));
    }
    return DEFAULT_NATIVE_AGENT_BROWSER_CDP_PORT;
  }

  function getNativeAgentBrowserTimeoutMs(scope: NativeToolsScope = "agent"): number {
    const settings = getNativeToolsSettings(scope);
    const raw = settings.agentBrowserTimeoutMs ?? settings.nativeAgentBrowserTimeoutMs;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.min(120_000, Math.max(1_000, Math.floor(raw)));
    }
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return Math.min(120_000, Math.max(1_000, parsed));
    }
    return DEFAULT_NATIVE_AGENT_BROWSER_TIMEOUT_MS;
  }

  function getNativeAgentBrowserExecutablePath(scope: NativeToolsScope = "agent"): string {
    const settings = getNativeToolsSettings(scope);
    const raw = settings.agentBrowserExecutablePath ?? settings.nativeAgentBrowserExecutablePath;
    if (typeof raw !== "string") return "";
    return raw.trim();
  }

  function getNativeAgentBrowserSession(scope: NativeToolsScope = "agent"): string {
    const settings = getNativeToolsSettings(scope);
    const raw = settings.agentBrowserSession ?? settings.nativeAgentBrowserSession;
    if (typeof raw !== "string") return "";
    return raw.trim();
  }

  function getNativeAgentBrowserProfilePath(scope: NativeToolsScope = "agent"): string {
    const settings = getNativeToolsSettings(scope);
    const raw =
      settings.agentBrowserProfilePath ??
      settings.agentBrowserProfile ??
      settings.nativeAgentBrowserProfilePath ??
      settings.nativeAgentBrowserProfile;
    if (typeof raw !== "string") return "";
    return raw.trim();
  }

  function getNativeAgentBrowserExtraFlagsText(scope: NativeToolsScope = "agent"): string {
    const settings = getNativeToolsSettings(scope);
    const raw = settings.agentBrowserExtraFlags ?? settings.nativeAgentBrowserExtraFlags;
    if (Array.isArray(raw)) {
      return raw
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
        .join("\n");
    }
    if (typeof raw === "string") return raw;
    return "";
  }

  type ProviderSettingsForm = {
    provider_specific_settings: Record<string, any> | null;
  };

  function withNativeToolSetting<FormType extends ProviderSettingsForm>(
    form: FormType,
    key: string,
    value: unknown,
  ): FormType {
    const currentProviderSettings =
      form.provider_specific_settings && typeof form.provider_specific_settings === "object"
        ? { ...form.provider_specific_settings }
        : {};
    const currentNativeTools =
      currentProviderSettings.nativeTools &&
      typeof currentProviderSettings.nativeTools === "object" &&
      !Array.isArray(currentProviderSettings.nativeTools)
        ? { ...currentProviderSettings.nativeTools }
        : {};

    if (value === null || value === undefined || value === "") {
      delete currentNativeTools[key];
    } else {
      currentNativeTools[key] = value;
    }

    if (Object.keys(currentNativeTools).length > 0) {
      currentProviderSettings.nativeTools = currentNativeTools;
    } else {
      delete currentProviderSettings.nativeTools;
    }

    return {
      ...form,
      provider_specific_settings:
        Object.keys(currentProviderSettings).length > 0
          ? currentProviderSettings
          : null,
    };
  }

  function withNativeBashPatternList<FormType extends ProviderSettingsForm>(
    form: FormType,
    key: "bashCommandAllowList" | "bashNeverAllowList",
    text: string,
  ): FormType {
    const values = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return withNativeToolSetting(
      form,
      key,
      values.length > 0 ? Array.from(new Set(values)) : null,
    );
  }

  function withNativeAgentBrowserExtraFlags<FormType extends ProviderSettingsForm>(
    form: FormType,
    text: string,
  ): FormType {
    const values = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return withNativeToolSetting(
      form,
      "agentBrowserExtraFlags",
      values.length > 0 ? Array.from(new Set(values)) : null,
    );
  }

  function updateNativeAgentBrowserExtraFlags(
    text: string,
    scope: NativeToolsScope = "agent",
  ) {
    const values = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    updateNativeToolSetting(
      "agentBrowserExtraFlags",
      values.length > 0 ? Array.from(new Set(values)) : null,
      scope,
    );
  }

  function updateNativeToolSetting(
    key: string,
    value: unknown,
    scope: NativeToolsScope = "agent",
  ) {
    untrack(() => {
      const currentProviderSettings = getProviderSpecificSettings(scope) ?? {};
      const currentNativeTools = {
        ...(currentProviderSettings.nativeTools &&
        typeof currentProviderSettings.nativeTools === "object" &&
        !Array.isArray(currentProviderSettings.nativeTools)
          ? currentProviderSettings.nativeTools
          : {}),
      };

      if (value === null || value === undefined || value === "") {
        delete currentNativeTools[key];
      } else {
        currentNativeTools[key] = value;
      }

      const nextProviderSettings: Record<string, any> = {
        ...currentProviderSettings,
      };

      if (Object.keys(currentNativeTools).length > 0) {
        nextProviderSettings.nativeTools = currentNativeTools;
      } else {
        delete nextProviderSettings.nativeTools;
      }

      setProviderSpecificSettings(
        scope,
        Object.keys(nextProviderSettings).length > 0 ? nextProviderSettings : null,
      );
    });
  }

  const isCodexProvider = $derived.by(() => {
    if (!isCliPrimaryAgentType(basicForm.agentType)) return false;
    const provider = (basicForm.primary_model_provider ?? "").toLowerCase();
    const modelName = (basicForm.primary_model_name ?? "").toLowerCase();
    const connectionHint =
      basicForm.primary_model_connection?.id ??
      basicForm.primary_model_connection?.service ??
      "";
    return (
      provider.includes("codex") ||
      modelName.includes("codex") ||
      connectionHint === "codex-cli"
    );
  });

  const isClaudeCliProvider = $derived.by(() => {
    if (!isCliPrimaryAgentType(basicForm.agentType)) return false;
    const provider = (basicForm.primary_model_provider ?? "").toLowerCase();
    const modelName = (basicForm.primary_model_name ?? "").toLowerCase();
    const connectionHint =
      basicForm.primary_model_connection?.id ??
      basicForm.primary_model_connection?.service ??
      "";
    return (
      provider.includes("claude-cli") ||
      modelName.includes("claude-cli") ||
      connectionHint === "claude-cli"
    );
  });

  const isCliProvider = $derived.by(() => {
    return isCliPrimaryAgentType(basicForm.agentType) || isCodexProvider || isClaudeCliProvider;
  });

  const toolApprovalEligible = $derived(
    isManagedPrimaryAgentType(basicForm.agentType),
  );
  const n8nRuntimeUnavailable = $derived(n8nRuntimeStatusStore.isUnavailable());

  let isUploadingAgentAvatar = $state(false);
  let agentAvatarUploadRequestId = 0;
  let agentAvatarError = $state<string | null>(null);

  let subagents = $state<SubagentRow[]>([]);
  let selectedEditableSubagentId = $state<string | null>(null);
  let selectedSubagentModelId = $state<string | null>(null);

  $effect(() => {
    if (!selectedSubagentModelId) {
      unsupportedSubagentModelParams = [];
      return;
    }
    const selectedModel = savedModels.find(
      (model) => model.id === selectedSubagentModelId,
    );
    unsupportedSubagentModelParams = selectedModel
      ? getSubagentToolHostScope(subagentForm.subagentType) !== "n8n"
        ? []
        : listUnsupportedN8NParameters(selectedModel, { matrixEntries })
      : [];
  });

  function getN8nSubagentUnavailableReason(subagent: SubagentRow | null | undefined) {
    if (!subagent || !n8nRuntimeUnavailable) return null;
    const type = normalizeSubagentType(subagent, subagent.subagentType);
    return type === "n8n-workflow" ? "n8n is not connected" : null;
  }

  const primaryAgentOptions = $derived(
    agents.map((agent) => {
      return {
        id: agent.id,
        displayName: agent.displayName ?? "Unnamed agent",
        agentType: normalizePrimaryAgentType(agent),
        avatarUrl: agent.avatar ?? agent.avatar_url ?? null,
        avatarIconRef: normalizeIconRef(agent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF),
        avatarIconFit: normalizeAvatarIconFit(agent.avatar_icon_fit),
        defaultModelProvider: agent.primary_model_provider ?? null,
        defaultModelName: agent.primary_model_name ?? agent.model ?? null,
        specialty: null,
        disabledReason: null,
      };
    }),
  );

  const subagentOptions = $derived(
    subagents.map((subagent) => ({
      id: `subagent:${subagent.id}`,
      displayName: subagent.displayName ?? "Unnamed subagent",
      agentType: normalizeSubagentType(subagent, subagent.subagentType) === "cli"
        ? ("cli" as const)
        : ("api" as const),
      avatarUrl: subagent.avatar ?? null,
      avatarIconRef: normalizeIconRef(subagent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF),
      avatarIconFit: normalizeAvatarIconFit(subagent.avatar_icon_fit),
      defaultModelProvider: subagent.primary_model_provider ?? null,
      defaultModelName: subagent.primary_model_name ?? null,
      specialty: subagent.specialty ?? null,
      badgeLabel: getSubagentTypeDisplayLabel(
        normalizeSubagentType(subagent, subagent.subagentType),
      ),
      badgeTone: getSubagentTypeBadgeTone(
        normalizeSubagentType(subagent, subagent.subagentType),
      ),
      disabledReason: getN8nSubagentUnavailableReason(subagent),
    })),
  );

  const combinedAgentSections = $derived<MegaAgentSection[]>([
    {
      heading: "Primary Agents",
      items: primaryAgentOptions.map((agent) => ({
        ...agent,
        id: `agent:${agent.id}`,
      })),
    },
    {
      heading: "Subagents",
      items: subagentOptions,
    },
  ]);

  const combinedSelectedEntityId = $derived.by<string | null>(() => {
    if (selectedEntity?.kind === "agent" && selectedAgentId) {
      return `agent:${selectedAgentId}`;
    }
    if (selectedEntity?.kind === "subagent" && selectedEditableSubagentId) {
      return `subagent:${selectedEditableSubagentId}`;
    }
    return null;
  });

  // BL-844: the form and its save live in `$lib/utils/subagentSettingsSavePatch.ts`, so the
  // rule that decides what a save sends is testable without the panel.
  type SubagentForm = SubagentSaveForm;

  let subagentForm = $state<SubagentForm>({
    displayName: "",
    subagentType: "n8n-workflow",
    specialty: "general",
    webhook_url: "",
    include_global_prompt: false,
    system_prompt: "",
    primary_model_provider: "",
    primary_model_name: "",
    primary_model_preset_id: "",
    primary_model_connection: null,
    timeout_seconds: "",
    avatar: null,
    avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
    avatar_icon_fit: "fill",
    provider_specific_settings: null,
  });

  const isCodexCliSubagentProvider = $derived.by(() => {
    if (subagentForm.subagentType !== "cli") return false;
    const provider = (subagentForm.primary_model_provider ?? "").toLowerCase();
    const modelName = (subagentForm.primary_model_name ?? "").toLowerCase();
    return provider.includes("codex") || modelName.includes("codex");
  });

  const isClaudeCliSubagentProvider = $derived.by(() => {
    if (subagentForm.subagentType !== "cli") return false;
    const provider = (subagentForm.primary_model_provider ?? "").toLowerCase();
    const modelName = (subagentForm.primary_model_name ?? "").toLowerCase();
    return provider.includes("claude-cli") || modelName.includes("claude-cli");
  });

  const isCliSubagentProvider = $derived.by(() => {
    return subagentForm.subagentType === "cli" &&
      (isCodexCliSubagentProvider || isClaudeCliSubagentProvider);
  });

  let subagentPersistedSignature = $state<string | null>(null);
  /**
   * BL-844: the Subagent form as it was loaded or last saved. A save sends only the fields that
   * differ from it (`buildSubagentSettingsSavePatch`), so a copy of the Subagent that another tab,
   * window, or agent tool has since changed is never written back over that change. Not reactive,
   * like `basicPersistedForm`: it is set and cleared beside `subagentPersistedSignature`.
   */
  let subagentPersistedForm: SubagentForm | null = null;
  /**
   * BL-914: the Subagent's Tool Grid values, Codex block and Claude block as they were loaded or last
   * saved, the twins of the Primary Agent's `mcpPersistedValues`, `codexPersistedBlock` and
   * `claudePersistedBlock`. The Subagent PUT writes those blocks key by key, so each section save
   * sends only what differs from its copy (`diffMcpSection`, `diffAgentBlockWithGroups`), a dropped
   * key as `null`. Plain variables, not `$state`: set at select and at the list-effect hydrate,
   * moved after a successful save, cleared at both resets, left as they are by a failed save; an
   * effect that reads one does not depend on it. A Codex or Claude block of `null` is a Subagent
   * that has none yet (its first edit sends the whole block).
   */
  let subagentMcpPersistedValues: McpSectionValues | null = null;
  let subagentCodexPersistedBlock: CodexAgentSettings | null = null;
  let subagentClaudePersistedBlock: ClaudeAgentSettings | null = null;
  /**
   * BL-955: raised by each read that replaces the Subagent's section forms (a pick, the list
   * effect's hydrate, the deferred read); each Subagent save carries the value from when its
   * payload was built (`subagentLanding`). The Primary Agent's twin is `agentHydrationRequestId`.
   */
  let subagentReadGeneration = 0;
  /** BL-955: the Subagent's twin of `agentReadDeferred` (`readSubagentAgainWhenAtRest`). */
  let subagentReadDeferred = false;
  /** BL-955: the Subagent's savers (the core one counts the autosave and the multiline editors). */
  const subagentCoreSaves = createEntitySaverCount(readSubagentAgainWhenAtRest, () => untrack(syncSubagentSaveWaits));
  const subagentMcpSaves = createEntitySaverCount(readSubagentAgainWhenAtRest, () => untrack(syncSubagentSaveWaits));
  const subagentCliToolSaves = createEntitySaverCount(readSubagentAgainWhenAtRest, () => untrack(syncSubagentSaveWaits));
  const subagentCodexSaves = createEntitySaverCount(readSubagentAgainWhenAtRest, () => untrack(syncSubagentSaveWaits));
  const subagentClaudeSaves = createEntitySaverCount(readSubagentAgainWhenAtRest, () => untrack(syncSubagentSaveWaits));
  let subagentDetailLoading = $state(false);
  let subagentReadDeferredUi = $state(false);
  let subagentOwnedSaveInFlightUi = $state(false);
  let subagentOwnedWritePendingUi = $state(false);
  type SubagentCaptureSection = "core" | "codex" | "claude" | "mcp";
  const subagentDeferredCaptures = new Map<string, Set<SubagentCaptureSection>>();
  const subagentCaptureWake = $state({ core: 0, codex: 0, claude: 0, mcp: 0 });
  let subagentSaveWaitExpiredUi = $state(false);
  let subagentReadWaitError = $state<string | null>(null);
  const subagentSettingsReadWaiting = $derived(subagentDetailLoading || subagentReadDeferredUi || subagentReadWaitError !== null || subagentSaveWaitExpiredUi || subagentOwnedSaveInFlightUi);
  const subagentCaptureBlocked = $derived(subagentDetailLoading || subagentReadWaitError !== null || subagentOwnedWritePendingUi);
  const SETTINGS_WAIT_MS = 30_000;
  type SaveWait = { timer: ReturnType<typeof setTimeout> | null; expired: boolean };
  const primarySaveWaits = new Map<string, SaveWait>();
  const subagentSaveWaits = new Map<string, SaveWait>();
  let primaryReadTimer: ReturnType<typeof setTimeout> | null = null;
  let subagentReadTimer: ReturnType<typeof setTimeout> | null = null;
  let subagentReadRequestId = 0;
  let settingsPanelAlive = true;
  let subagentEditSaveState = $state<SaveState>("idle");
  let subagentEditSaveError = $state<string | null>(null);
  let subagentEditLastSaved = $state<Date | null>(null);
  let subagentSaveScope = $state<SubagentSaveScope>("core");
  let subagentValidationError = $state<string | null>(null);
  let subagentAvatarUploading = $state(false);
  let subagentAvatarUploadRequestId = 0;
  let subagentAvatarError = $state<string | null>(null);
  let lastInvalidSubagentSignature = $state<string | null>(null);
  let subagentPromptEditorOpen = $state(false);
  let subagentBashBlockEditorOpen = $state(false);
  let subagentBashAllowEditorOpen = $state(false);
  let subagentBrowserFlagsEditorOpen = $state(false);

  let agentAvatarInput = $state<HTMLInputElement | null>(null);
  let subagentAvatarInput = $state<HTMLInputElement | null>(null);

  type EntityKind = "agent" | "subagent";

  interface SelectedEntity {
    kind: EntityKind;
    id: string;
  }

  interface CreateEntityForm {
    kind: EntityKind;
    displayName: string;
    slug: string;
    slugManuallyEdited: boolean;
    agentType: PrimaryAgentType;
    webhook_url: string;
    workflow_url: string;
    include_global_prompt: boolean;
    subagentType: SubagentType;
    specialty: SubagentForm["specialty"];
  }

  let selectedEntity = $state<SelectedEntity | null>(null);
  type AgentSettingsTab = "core" | "tools" | "instructions" | "voice" | "access";
  let activeAgentSettingsTab = $state<AgentSettingsTab>("core");
  let activeSubagentSettingsTab = $state<AgentSettingsTab>("core");

  function hiddenUnless(tab: AgentSettingsTab) {
    return activeAgentSettingsTab === tab ? "" : "hidden";
  }

  function hiddenUnlessSubagent(tab: AgentSettingsTab) {
    return activeSubagentSettingsTab === tab ? "" : "hidden";
  }
  let createEntityMode = $state(false);
  let createEntityForm = $state<CreateEntityForm>({
    kind: "agent",
    displayName: "",
    slug: "",
    slugManuallyEdited: false,
    agentType: "api",
    webhook_url: "",
    workflow_url: "",
    include_global_prompt: true,
    subagentType: "n8n-workflow",
    specialty: "general",
  });
  let createEntityBusy = $state(false);
  let createEntityError = $state<string | null>(null);
  let agentDeleteState = $state<"idle" | "deleting">("idle");
  let agentDeleteError = $state<string | null>(null);
  let subagentDeleteState = $state<"idle" | "deleting">("idle");
  let subagentDeleteError = $state<string | null>(null);

  // SA-008: SUBAGENT_SPECIALTIES removed - all SAs now use "general" (same base prompt)

  function resetCreateEntityForm(kind: EntityKind = "agent") {
    createEntityForm = {
      kind,
      displayName: "",
      slug: "",
      slugManuallyEdited: false,
      agentType: "api",
      webhook_url: "",
      workflow_url: "",
      include_global_prompt: true,
      subagentType: "n8n-workflow",
      specialty: "general",
    };
    createEntityError = null;
  }

  function handleStartCreateEntity(kind: EntityKind = "agent") {
    if (createEntityMode) return;
    resetCreateEntityForm(kind);
    createEntityMode = true;
    createEntityBusy = false;
  }

  async function handleCreateEntity() {
    const name = createEntityForm.displayName.trim();
    if (!name) {
      createEntityError = "Display name is required.";
      return;
    }

    createEntityBusy = true;
    createEntityError = null;

    try {
      if (createEntityForm.kind === "agent") {
        const rawSlug = createEntityForm.slug.trim();
        const generatedSlug = sanitizeId(rawSlug || name);
        if (!generatedSlug) {
          createEntityError = "Agent ID is required.";
          createEntityBusy = false;
          return;
        }

        if (agents.some((agent) => agent.id === generatedSlug)) {
          createEntityError = `Agent ID "${generatedSlug}" is already in use.`;
          createEntityBusy = false;
          return;
        }

        const payload = {
          id: generatedSlug,
          displayName: name,
          agentType: createEntityForm.agentType,
          show_reasoning: true,
          preserve_reasoning: false,
          include_global_prompt: createEntityForm.include_global_prompt,
          webhook_url: null,
          agent_url: null,
        };

        const response = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const message = await extractError(
            response,
            "Failed to create agent",
          );
          throw new Error(message);
        }

        const created = (await response.json()) as AgentRow;

        agents = [...agents, created];
        agentStore.addAgent(mapToStoreAgent(created));
        agentStore.setCurrentAgentId(created.id);

        createEntityMode = false;
        resetCreateEntityForm("agent");
        selectAgent(created.id);
        toast.success(`Primary agent "${created.displayName}" created`);
      } else {
        const rawSlug = createEntityForm.slug.trim();
        const generatedSlug = sanitizeId(rawSlug || name);
        if (!generatedSlug) {
          createEntityError = "Subagent ID is required.";
          createEntityBusy = false;
          return;
        }

        if (subagents.some((subagent) => subagent.id === generatedSlug)) {
          createEntityError = `Subagent ID "${generatedSlug}" is already in use.`;
          createEntityBusy = false;
          return;
        }

        if (
          isWorkflowBackedSubagentType(createEntityForm.subagentType) &&
          !createEntityForm.webhook_url.trim()
        ) {
          createEntityError = "Production webhook URL is required for n8n Workflow Subagents.";
          createEntityBusy = false;
          return;
        }
        if (isWorkflowBackedSubagentType(createEntityForm.subagentType)) {
          const webhookValidation = validateN8nProductionWebhookUrl(
            createEntityForm.webhook_url,
          );
          if (webhookValidation) {
            createEntityError = webhookValidation;
            createEntityBusy = false;
            return;
          }
        }

        const created = await subagentStore.create({
          id: generatedSlug,
          displayName: name,
          subagentType: createEntityForm.subagentType,
          specialty: createEntityForm.specialty,
          include_global_prompt: false,
          webhook_url:
            isWorkflowBackedSubagentType(createEntityForm.subagentType)
              ? createEntityForm.webhook_url.trim() || undefined
              : undefined,
        });

        createEntityMode = false;
        resetCreateEntityForm("agent");
        selectSubagent(created.id);
        toast.success(`Subagent "${created.displayName}" created`);
      }
    } catch (error) {
      const label = createEntityForm.kind === "agent" ? "agent" : "subagent";
      console.error(`Failed to create ${label}:`, error);
      createEntityError =
        error instanceof Error ? error.message : `Failed to create ${label}`;
    } finally {
      createEntityBusy = false;
    }
  }

  async function handleDeletePrimaryAgent() {
    if (!selectedAgentId || primaryCaptureBlocked) return;
    const targetId = selectedAgentId;
    const current = agents.find((agent) => agent.id === targetId);
    const label = current?.displayName?.trim() || "this Primary Agent";

    // 2026-09-19 (Josh): deleting an agent may take its own chats with it. The count comes
    // from the same selection the delete uses, so the number shown is the number that goes.
    // Group chats are never counted or deleted; the agent only leaves their rosters.
    //
    // BL-778: a failed count must never fall back to the plain no-checkbox dialog below --
    // that dialog still deletes the agent, but with `deleteChats` left false, so the agent's
    // chats were silently kept with nothing telling the user the checkbox was ever dropped.
    // `resolveAgentDeleteChatCountOutcome` is the one place that decides "did this actually
    // work"; a `failed` outcome refuses the delete outright here, visibly, instead of guessing.
    let chatCounts: AgentChatCounts | null = null;
    let chatCountFailed = false;
    try {
      const countResponse = await fetch(`/api/agents/${targetId}/chats`);
      const body = countResponse.ok ? await countResponse.json().catch(() => null) : null;
      const outcome = resolveAgentDeleteChatCountOutcome(countResponse, body);
      if (outcome.status === "ok") {
        chatCounts = outcome.counts;
      } else {
        chatCountFailed = true;
      }
    } catch (error) {
      console.warn("Failed to count the agent's chats:", error);
      chatCountFailed = true;
    }

    if (chatCountFailed) {
      toast.error(
        `Couldn't check ${label}'s chats, so nothing was deleted. Try again in a moment.`,
      );
      return;
    }

    const description = [
      "This permanently removes the agent's settings, avatar pictures, model defaults, tool assignments, memories, DMs sent to it, schedules, and wake-up webhooks.",
      "Group chats are kept; the agent is only removed from their rosters.",
    ];
    const confirmLabel = "Delete Primary Agent";
    let confirmed = false;
    let deleteChats = false;
    if (chatCounts && (chatCounts.deletable > 0 || chatCounts.keptLocked > 0)) {
      const chatWord = chatCounts.deletable === 1 ? "chat" : "chats";
      const infiniteNote =
        chatCounts.infinite > 0
          ? `, including ${chatCounts.infinite === 1 ? "its Infinite Session" : `${chatCounts.infinite} Infinite Sessions`}`
          : "";
      // BL-778 part 2: named the same way BL-388's folder-delete dialog names archived chats
      // (`describeFolderDeleteWithChats`, folderDeleteDialog.ts) -- the sidebar hides archived
      // chats, so the user may not remember they exist.
      const archivedNote =
        chatCounts.archived > 0 ? `, ${chatCounts.archived} of them archived` : "";
      const keptNote =
        chatCounts.keptLocked > 0
          ? `${chatCounts.keptLocked} locked ${chatCounts.keptLocked === 1 ? "chat is" : "chats are"} kept; unlock ${chatCounts.keptLocked === 1 ? "it" : "them"} first to delete ${chatCounts.keptLocked === 1 ? "it" : "them"} too.`
          : undefined;
      const result = await confirmDialogWithCheckbox({
        title: `Delete ${label}?`,
        description,
        checkbox: {
          label: `Also delete its ${chatCounts.deletable} ${chatWord}${infiniteNote}${archivedNote}`,
          note: keptNote,
          checked: chatCounts.deletable > 0,
        },
        confirmLabel,
        tone: "destructive",
      });
      confirmed = result.confirmed;
      deleteChats = result.checked && chatCounts.deletable > 0;
    } else {
      confirmed = await confirmDialog({
        title: `Delete ${label}?`,
        description: chatCounts
          ? [...description, "It has no chats of its own."]
          : description,
        confirmLabel,
        tone: "destructive",
      });
    }
    if (!confirmed || primaryCaptureBlocked || selectedEntity?.kind !== "agent" || selectedAgentId !== targetId) {
      return;
    }

    agentDeleteState = "deleting";
    agentDeleteError = null;

    try {
      const response = await fetch(
        `/api/agents/${targetId}${deleteChats ? "?chats=1" : ""}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to delete agent",
        );
        throw new Error(message);
      }
      const payload = (await response.json().catch(() => null)) as {
        chats?: { deleted: number; keptLocked: number } | null;
        notice?: string;
      } | null;
      const deletedChats = payload?.chats?.deleted ?? 0;

      toast.success(
        deletedChats > 0
          ? `Primary Agent "${label}" deleted with ${deletedChats} ${deletedChats === 1 ? "chat" : "chats"}`
          : `Primary Agent "${label}" deleted`,
        payload?.notice ? { description: payload.notice, duration: 12000 } : undefined,
      );
      untrack(() => {
        selectedEntity = null;
        selectedAgentId = null;
        createEntityMode = false;
      });

      await loadAgents();

      if (selectedAgentId) {
        const fallbackId = selectedAgentId;
        untrack(() => {
          selectedEntity = { kind: "agent", id: fallbackId };
        });
        await hydrateAgent(fallbackId);
      } else if (agents.length > 0) {
        const fallbackId = agents[0].id;
        untrack(() => {
          selectedAgentId = fallbackId;
          selectedEntity = { kind: "agent", id: fallbackId };
        });
        await hydrateAgent(fallbackId);
      } else if (subagents.length > 0) {
        selectSubagent(subagents[0].id);
      } else {
        untrack(() => {
          selectedEntity = null;
        });
      }
    } catch (error) {
      console.error("Failed to delete agent:", error);
      const message =
        error instanceof Error ? error.message : "Failed to delete agent";
      agentDeleteError = message;
      toast.error(message);
    } finally {
      agentDeleteState = "idle";
    }
  }

  async function handleDeleteSubagent() {
    if (!selectedEditableSubagentId || subagentCaptureBlocked) return;
    const targetId = selectedEditableSubagentId;
    const label = subagentForm.displayName?.trim() || "this Subagent";
    const confirmed = await confirmDialog({
      title: `Delete ${label}?`,
      description:
        "It will be unassigned from every Primary Agent, and its settings, avatar pictures, and managed CLI settings folder will be removed. Chat history stays intact.",
      confirmLabel: "Delete Subagent",
      tone: "destructive",
    });
    if (!confirmed || subagentCaptureBlocked || selectedEntity?.kind !== "subagent" || selectedEditableSubagentId !== targetId) {
      return;
    }

    subagentDeleteState = "deleting";
    subagentDeleteError = null;

    try {
      const notice = await subagentStore.delete(targetId);
      toast.success(`Subagent "${label}" deleted`, notice ? { description: notice, duration: 12000 } : undefined);

      untrack(() => {
        const nextIds = selectedSubagentIds.filter((id) => id !== targetId);
        selectedSubagentIds = nextIds;
        assignmentPersistedSignature = makeSubagentSignature(nextIds);
      });

      for (const agent of agents) {
        if (!agent.assigned_subagent_ids?.includes(targetId)) continue;
        updateAgentCollections(agent.id, {
          assigned_subagent_ids: agent.assigned_subagent_ids.filter(
            (id) => id !== targetId,
          ),
        });
      }

      if (
        selectedEntity?.kind === "subagent" &&
        selectedEditableSubagentId === targetId
      ) {
        const fallback = subagents.find((item) => item.id !== targetId);
        if (fallback) {
          selectSubagent(fallback.id);
        } else {
          untrack(() => {
            selectedEditableSubagentId = null;
            selectedEntity = selectedAgentId
              ? { kind: "agent", id: selectedAgentId }
              : agents[0]
                ? { kind: "agent", id: agents[0].id }
                : null;
          });
          if (!selectedAgentId && agents[0]?.id) {
            selectedAgentId = agents[0].id;
            void hydrateAgent(agents[0].id);
          }
        }
      }
    } catch (error) {
      console.error("Failed to delete subagent:", error);
      const message =
        error instanceof Error ? error.message : "Failed to delete subagent";
      subagentDeleteError = message;
      toast.error(message);
    } finally {
      subagentDeleteState = "idle";
    }
  }

  function handleCancelCreateEntity() {
    createEntityMode = false;
    createEntityBusy = false;
    createEntityError = null;
    resetCreateEntityForm("agent");
  }

  $effect(() => {
    if (!createEntityMode) return;
    if (createEntityForm.slugManuallyEdited) return;
    const sanitized = sanitizeId(createEntityForm.displayName);
    if (createEntityForm.slug !== sanitized) {
      createEntityForm = { ...createEntityForm, slug: sanitized };
    }
  });

  $effect(() => {
    if (createEntityMode && createEntityForm.kind === "agent") {
      if (createEntityForm.webhook_url || createEntityForm.workflow_url) {
        createEntityForm = {
          ...createEntityForm,
          webhook_url: "",
          workflow_url: "",
        };
      }
    }
  });

  $effect(() => {
    if (createEntityMode && createEntityForm.kind === "subagent") {
      if (
        !isWorkflowBackedSubagentType(createEntityForm.subagentType) &&
        createEntityForm.webhook_url
      ) {
        createEntityForm = {
          ...createEntityForm,
          webhook_url: "",
        };
      }
    }
  });

  $effect(() => {
    // API and CLI agents do not own n8n workflow URLs. Retired stored records remain
    // untouched so the user can delete them without an auto-save mutation.
  });

  $effect(() => {
    if (!isWorkflowBackedSubagentType(subagentForm.subagentType) && subagentForm.webhook_url) {
      subagentForm = { ...subagentForm, webhook_url: "" };
    }
  });

  $effect(() => {
    const storeSettings = getUserSettings();
    if (storeSettings?.global_zip_settings) {
      globalZipSettings = normaliseGlobalZipSettings(
        storeSettings.global_zip_settings,
      );
      hasSeededGlobalZipSettings = true;
      return;
    }

    if (
      !hasSeededGlobalZipSettings &&
      data?.userSettings?.global_zip_settings
    ) {
      globalZipSettings = normaliseGlobalZipSettings(
        data.userSettings.global_zip_settings,
      );
    }
  });

  onMount(async () => {
    window.addEventListener(
      LIVE_SETTINGS_EVENTS.localAiSettingsUpdated,
      handleLocalAiSettingsUpdated,
    );
    stopAgentSettingsEvents = onUserChannelEvent(handleAgentSettingsEvent);
    await Promise.all([
      loadAgents(),
      loadProjectsForDefaults(),
      n8nRuntimeStatusStore.refreshN8nRuntimeStatus(),
    ]);
    void loadGoons();
    void refreshModelPickerData();
    void loadWebSearchProviderAvailability();
    void loadAgentBrowserRuntimeStatus();
    void loadNativeSandboxStatus();
    void compatibilityMatrixStore.loadCompatibilityMatrix();
    void loadVoiceProfiles();
    void loadVoiceProviders();
    void loadInputDevices();
    if (data?.user?.id) {
      subagentStore.init(data.user.id);
      subagentsLoading = true;
      await subagentStore.load();
      subagentsLoading = false;
    }
    const selectableAgentId =
      selectedAgentId && agents.find((agent) => agent.id === selectedAgentId)
        ? selectedAgentId
        : agents[0]?.id ?? null;

    if (selectableAgentId) {
      untrack(() => {
        selectedAgentId = selectableAgentId;
        selectedEntity = { kind: "agent", id: selectableAgentId };
      });
      await hydrateAgent(selectableAgentId);
    } else if (subagents.length > 0) {
      selectSubagent(subagents[0].id);
    }
  });

  onDestroy(() => {
    settingsPanelAlive = false;
    stopAgentSettingsEvents();
    if (primaryReadTimer) clearTimeout(primaryReadTimer);
    if (subagentReadTimer) clearTimeout(subagentReadTimer);
    for (const wait of [...primarySaveWaits.values(), ...subagentSaveWaits.values()]) if (wait.timer) clearTimeout(wait.timer);
    primarySaveWaits.clear();
    subagentSaveWaits.clear();
    primaryDeferredCaptures.clear();
    subagentDeferredCaptures.clear();
    window.removeEventListener(
      LIVE_SETTINGS_EVENTS.localAiSettingsUpdated,
      handleLocalAiSettingsUpdated,
    );
  });

  $effect(() => {
    const shouldLoadAccess =
      (selectedEntity?.kind === "agent" && activeAgentSettingsTab === "access") ||
      (selectedEntity?.kind === "subagent" && activeSubagentSettingsTab === "access");

    if (!shouldLoadAccess) return;
    if (!data?.user?.id) return;
    void loadAccessResources();
  });

  $effect(() => {
    const provider = basicForm.voice_profile.provider;
    if (!provider) {
      voiceOptions = [];
      voiceOptionsError = null;
      voiceOptionsKey = "";
      return;
    }

    const providerSummary = voiceProviderOptions.find(
      (item) => item.id === provider,
    );
    if (!providerSummary?.supports.listVoices) {
      voiceOptions = [];
      voiceOptionsError = null;
      voiceOptionsKey = "";
      return;
    }

    const model = basicForm.voice_profile.model ?? "";
    void loadAgentVoices(provider, model);
  });

  $effect(() => {
    if (!initialAgentId) {
      if (lastAppliedInitialAgentId) {
        lastAppliedInitialAgentId = null;
      }
      return;
    }

    if (initialAgentId === CREATE_AGENT_SENTINEL) {
      if (lastAppliedInitialAgentId === CREATE_AGENT_SENTINEL) {
        return;
      }
      handleStartCreateEntity("agent");
      lastAppliedInitialAgentId = CREATE_AGENT_SENTINEL;
      return;
    }

    if (initialAgentId === lastAppliedInitialAgentId) {
      return;
    }

    if (listLoading || hydrationInProgress) {
      return;
    }

    const target = agents.find((agent) => agent.id === initialAgentId);
    if (!target) {
      return;
    }

    untrack(() => {
      selectedAgentId = target.id;
      selectedEntity = { kind: "agent", id: target.id };
      createEntityMode = false;
    });
    void hydrateAgent(target.id);
    lastAppliedInitialAgentId = target.id;
  });

  $effect(() => {
    const list = subagentStore.subagents;
    subagents = list;

    if (!list || list.length === 0) {
      if (selectedEditableSubagentId !== null) {
        untrack(() => {
          selectedEditableSubagentId = null;
          subagentForm = {
            displayName: "",
            subagentType: "n8n-workflow",
            specialty: "general",
            webhook_url: "",
            include_global_prompt: false,
            system_prompt: "",
            primary_model_provider: "",
            primary_model_name: "",
            primary_model_preset_id: "",
            primary_model_connection: null,
            timeout_seconds: "",
            avatar: null,
            avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
            avatar_icon_fit: "fill",
            provider_specific_settings: null,
          };
          subagentPersistedSignature = null;
          subagentPersistedForm = null;
          subagentDefaultMCPGateways = [];
          subagentDefaultMCPToolSelections = [];
          subagentDefaultCliToolIds = [];
          subagentCliToolIdsExplicit = false;
          subagentDcmDisplaySettings = createDefaultDcmDisplaySettings();
          subagentMcpPersistedSignature = null;
          subagentMcpPersistedValues = null;
          subagentCodexForm = createDefaultCodexForm();
          subagentCodexPersistedSignature = null;
          subagentCodexPersistedBlock = null;
          subagentCodexSaveState = "idle";
          subagentCodexSaveError = null;
          subagentCodexLastSaved = null;
          subagentClaudeForm = createDefaultClaudeForm();
          subagentClaudePersistedSignature = null;
          subagentClaudePersistedBlock = null;
          subagentClaudeSaveState = "idle";
          subagentClaudeSaveError = null;
          subagentClaudeLastSaved = null;
          selectedSubagentModelId = null;
      });
    }
      if (selectedEntity?.kind === "subagent") {
        const fallbackAgentId = selectedAgentId ?? agents[0]?.id ?? null;
        selectedEntity = fallbackAgentId
          ? { kind: "agent", id: fallbackAgentId }
          : null;
      }
      return;
    }

    const exists = selectedEditableSubagentId
      ? list.some((item) => item.id === selectedEditableSubagentId)
      : false;

    if (selectedEditableSubagentId && !exists) {
      untrack(() => {
        selectedEditableSubagentId = null;
        subagentForm = {
          displayName: "",
          subagentType: "n8n-workflow",
          specialty: "general",
          webhook_url: "",
          include_global_prompt: false,
          system_prompt: "",
          primary_model_provider: "",
          primary_model_name: "",
          primary_model_preset_id: "",
          primary_model_connection: null,
          timeout_seconds: "",
          avatar: null,
          avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
          avatar_icon_fit: "fill",
          provider_specific_settings: null,
        };
        subagentPersistedSignature = null;
        subagentPersistedForm = null;
        subagentDefaultMCPGateways = [];
        subagentDefaultMCPToolSelections = [];
        subagentDefaultCliToolIds = [];
        subagentCliToolIdsExplicit = false;
        subagentDcmDisplaySettings = createDefaultDcmDisplaySettings();
        subagentMcpPersistedSignature = null;
        subagentMcpPersistedValues = null;
        subagentCodexForm = createDefaultCodexForm();
        subagentCodexPersistedSignature = null;
        subagentCodexPersistedBlock = null;
        subagentCodexSaveState = "idle";
        subagentCodexSaveError = null;
        subagentCodexLastSaved = null;
        subagentClaudeForm = createDefaultClaudeForm();
        subagentClaudePersistedSignature = null;
        subagentClaudePersistedBlock = null;
        subagentClaudeSaveState = "idle";
        subagentClaudeSaveError = null;
        subagentClaudeLastSaved = null;
        selectedSubagentModelId = null;
      });
    }

    if (!selectedEditableSubagentId) {
      if (selectedEntity?.kind === "subagent") {
        selectSubagent(list[0].id);
      }
      return;
    }

    const current = list.find((item) => item.id === selectedEditableSubagentId);
    if (!current) {
      return;
    }

    const normalised = normaliseSubagentForm(current);
    const signature = makeSubagentFormSignature(normalised);

    if (subagentPersistedSignature === signature) {
      return;
    }

    // BL-844 review fix: the record replaces the form only when nothing in the form is unsaved.
    // A save that lands puts the server's record into the store; a form with edits made while
    // that save was in flight (or waiting for its autosave) is left as it is, and the autosave
    // sends those edits against the saved baseline. Once the form equals the baseline again
    // (the save settled, `subagentPersistedSignature` moved), this effect runs again and the
    // record, another window's change included, is picked up.
    if (
      subagentPersistedSignature !== null &&
      untrack(() => makeSubagentFormSignature(subagentForm)) !== subagentPersistedSignature
    ) {
      return;
    }

      // BL-915: the core, Codex and Claude sections (not the Tool Grid), each only while at rest.
      untrack(() => readSubagentSections(current, false, false));
      syncSelectedModelFromSubagent();
    });

  async function loadAgents() {
    listLoading = true;
    listError = null;

    try {
      const response = await fetch("/api/agents");
      if (!response.ok) {
        const message = await extractError(response, "Failed to load agents");
        throw new Error(message);
      }

      const payload = await response.json();
      const loadedAgents: AgentRow[] = Array.isArray(payload?.agents)
        ? payload.agents
        : [];

      untrack(() => {
        agents = loadedAgents;
        agentStore.setAgents(loadedAgents.map(mapToStoreAgent));
      });

      if (selectedAgentId) {
        const exists = loadedAgents.some(
          (agent) => agent.id === selectedAgentId,
        );
        if (!exists) {
          selectedAgentId = loadedAgents[0]?.id ?? null;
        }
      } else if (loadedAgents.length > 0) {
        selectedAgentId = loadedAgents[0]?.id ?? null;
      }
      if (!selectedAgentId) {
        resetAgentDetailState();
      }
    } catch (error) {
      console.error("Failed to load agents:", error);
      listError =
        error instanceof Error ? error.message : "Failed to load agents";
      agents = [];
      agentStore.setAgents([]);
      selectedAgentId = null;
      resetAgentDetailState();
    } finally {
      listLoading = false;
    }
  }

  async function loadProjectsForDefaults() {
    projectOptionsLoading = true;
    projectOptionsError = null;

    try {
      const loadedProjects = await projectService.loadProjects(data?.user?.id ?? "");
      const normalized = loadedProjects
        .filter(
          (project) =>
            typeof project?.id === "string" &&
            typeof project?.name === "string" &&
            typeof project?.root_path === "string",
        )
        .map((project) => ({
          id: project.id,
          name: project.name,
          root_path: project.root_path,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      projectOptions = normalized;
    } catch (error) {
      console.error("Failed to load projects for agent defaults:", error);
      projectOptions = [];
      projectOptionsError =
        error instanceof Error ? error.message : "Failed to load projects";
    } finally {
      projectOptionsLoading = false;
    }
  }

  function primarySavers() {
    return [basicSaves, promptSaves, zipSaves, mcpSaves, cliToolSaves, codexSaves, claudeSaves, assignmentSaves];
  }

  function subagentSavers() {
    return [subagentCoreSaves, subagentMcpSaves, subagentCliToolSaves, subagentCodexSaves, subagentClaudeSaves];
  }

  // BL-1028: ownership is a gate, never an ordinary autosave dependency. A real
  // dirty-draft/read trigger may wait once for an owned write, without retaining a payload.
  function deferPrimaryCapture(section: PrimaryCaptureSection) {
    return untrack(() => {
      if (!primaryCaptureBlocked) return false;
      const id = selectedAgentId;
      if (id && primaryOwnedWritesPending(id)) {
        const sections = primaryDeferredCaptures.get(id) ?? new Set<PrimaryCaptureSection>();
        sections.add(section);
        primaryDeferredCaptures.set(id, sections);
      }
      return true;
    });
  }

  function deferSubagentCapture(section: SubagentCaptureSection) {
    return untrack(() => {
      if (!subagentCaptureBlocked) return false;
      const id = selectedEditableSubagentId;
      if (id && subagentOwnedWritesPending(id)) {
        const sections = subagentDeferredCaptures.get(id) ?? new Set<SubagentCaptureSection>();
        sections.add(section);
        subagentDeferredCaptures.set(id, sections);
      }
      return true;
    });
  }

  function resumeDeferredCaptures() {
    for (const [id, sections] of primaryDeferredCaptures) {
      if (selectedEntity?.kind !== "agent" || selectedAgentId !== id) {
        primaryDeferredCaptures.delete(id);
      } else if (!primaryOwnedWritesPending(id)) {
        // Remove before waking. The effect rechecks the latest form, baseline and read.
        primaryDeferredCaptures.delete(id);
        for (const section of sections) primaryCaptureWake[section] += 1;
      }
    }
    for (const [id, sections] of subagentDeferredCaptures) {
      if (selectedEntity?.kind !== "subagent" || selectedEditableSubagentId !== id) {
        subagentDeferredCaptures.delete(id);
      } else if (!subagentOwnedWritesPending(id)) {
        subagentDeferredCaptures.delete(id);
        for (const section of sections) subagentCaptureWake[section] += 1;
      }
    }
  }

  function syncSaveWaits(kind: "agent" | "subagent") {
    if (!settingsPanelAlive) return;
    const savers = kind === "agent" ? primarySavers() : subagentSavers();
    const waits = kind === "agent" ? primarySaveWaits : subagentSaveWaits;
    const running = new Set(savers.flatMap((saver) => saver.inFlightOwners()));
    const pending = new Set(savers.flatMap((saver) => saver.pendingOwners()));
    for (const id of running) {
      if (waits.has(id)) continue;
      const wait: SaveWait = { timer: null, expired: false };
      wait.timer = setTimeout(() => {
        if (!settingsPanelAlive || waits.get(id) !== wait || !savers.some((saver) => saver.inFlight(id))) return;
        wait.timer = null;
        wait.expired = true;
        // Timeout publishes uncertainty; it never releases or cancels the actual save.
        if (kind === "agent" && selectedEntity?.kind === "agent" && selectedAgentId === id) setAgentReadDeferred(true);
        if (kind === "subagent" && selectedEntity?.kind === "subagent" && selectedEditableSubagentId === id) setSubagentReadDeferred(true);
        untrack(() => syncSaveWaits(kind));
      }, SETTINGS_WAIT_MS);
      waits.set(id, wait);
    }
    for (const [id, wait] of waits) {
      if (running.has(id)) continue;
      if (wait.timer) clearTimeout(wait.timer);
      wait.timer = null;
      if (!wait.expired) waits.delete(id);
    }
    if (kind === "agent") {
      primaryOwnedSaveInFlightUi = selectedAgentId !== null && running.has(selectedAgentId);
      primaryOwnedWritePendingUi = selectedAgentId !== null && pending.has(selectedAgentId);
      primarySaveWaitExpiredUi = selectedAgentId !== null && waits.get(selectedAgentId)?.expired === true;
    } else {
      subagentOwnedSaveInFlightUi = selectedEditableSubagentId !== null && running.has(selectedEditableSubagentId);
      subagentOwnedWritePendingUi = selectedEditableSubagentId !== null && pending.has(selectedEditableSubagentId);
      subagentSaveWaitExpiredUi = selectedEditableSubagentId !== null && waits.get(selectedEditableSubagentId)?.expired === true;
    }
  }

  function syncPrimarySaveWaits() { syncSaveWaits("agent"); resumeDeferredCaptures(); }
  function syncSubagentSaveWaits() { syncSaveWaits("subagent"); resumeDeferredCaptures(); }

  async function retryPrimarySettingsRead() {
    const id = selectedAgentId;
    if (!id || selectedEntity?.kind !== "agent") return;
    // A-1y: the user asked again, so a memory conflict may resend once more after this read.
    memoryConflictResendUsed = false;
    await hydrateAgent(id);
  }

  async function retrySubagentSettingsRead() {
    const id = selectedEditableSubagentId;
    if (!id || selectedEntity?.kind !== "subagent") return;
    await hydrateSubagent(id);
  }

  async function hydrateSubagent(id: string) {
    const requestId = ++subagentReadRequestId;
    // A real server read supersedes saves built before its snapshot; list refreshes still do not.
    subagentReadGeneration += 1;
    subagentDetailLoading = true;
    subagentReadWaitError = null;
    if (subagentReadTimer) clearTimeout(subagentReadTimer);
    subagentReadTimer = setTimeout(() => {
      if (settingsPanelAlive && requestId === subagentReadRequestId && selectedEntity?.kind === "subagent" && selectedEditableSubagentId === id) {
        subagentReadWaitError = "These settings did not load within 30 seconds. Retry reads the record.";
      }
    }, SETTINGS_WAIT_MS);
    try {
      const response = await fetch(`/api/subagents/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await extractError(response, "Failed to load subagent settings"));
      const payload = await response.json();
      const record = payload?.subagent as SubagentRow | undefined;
      if (!record || typeof record !== "object" || Array.isArray(record) || record.id !== id) throw new Error("Subagent settings response did not contain the requested record");
      if (!settingsPanelAlive || requestId !== subagentReadRequestId || selectedEntity?.kind !== "subagent" || selectedEditableSubagentId !== id) return;
      untrack(() => {
        subagentStore.acceptServerRecord(record);
        subagents = subagents.map((existing) => existing.id === id ? record : existing);
        readSubagentSections(record, false, true);
        syncSelectedModelFromSubagent();
        subagentReadWaitError = null;
        if (!subagentOwnedWritesPending(id)) {
          subagentSaveWaits.delete(id);
          syncSubagentSaveWaits();
        }
      });
    } catch (error) {
      if (settingsPanelAlive && requestId === subagentReadRequestId && selectedEntity?.kind === "subagent" && selectedEditableSubagentId === id) {
        subagentReadWaitError = error instanceof Error ? error.message : "Failed to load subagent settings";
      }
    } finally {
      if (requestId === subagentReadRequestId) {
        if (subagentReadTimer) clearTimeout(subagentReadTimer);
        subagentReadTimer = null;
        subagentDetailLoading = false;
      }
    }
  }

  function setAgentReadDeferred(value: boolean) {
    agentReadDeferred = value;
    agentReadDeferredUi = value;
  }

  function setSubagentReadDeferred(value: boolean) {
    subagentReadDeferred = value;
    subagentReadDeferredUi = value;
  }

  function primaryOwnedWritesPending(id: string) {
    return [basicSaves, promptSaves, zipSaves, mcpSaves, cliToolSaves, codexSaves,
      claudeSaves, assignmentSaves].some((saver) => saver.busy(id));
  }

  function subagentOwnedWritesPending(id: string) {
    return [subagentCoreSaves, subagentMcpSaves, subagentCliToolSaves,
      subagentCodexSaves, subagentClaudeSaves].some((saver) => saver.busy(id));
  }

  function guardPrimaryChoice<T extends (...args: any[]) => any>(callback: T): T {
    return ((...args: Parameters<T>) => {
      if (primaryOwnedSaveInFlightUi) return;
      return callback(...args);
    }) as T;
  }

  function guardSubagentChoice<T extends (...args: any[]) => any>(callback: T): T {
    return ((...args: Parameters<T>) => {
      if (subagentOwnedSaveInFlightUi) return;
      return callback(...args);
    }) as T;
  }

  function patchContainsGroupedValues(body: Record<string, unknown>, scope: "agent" | "subagent") {
    const groups = scope === "agent" ? AGENT_SAVE_FIELD_GROUPS : SUBAGENT_SAVE_FIELD_GROUPS;
    const groupedKeys = new Set(groups.filter(group => group.length > 1).flat());
    return Object.entries(body).some(([key, value]) =>
      key === "tool_approval_mode" || groupedKeys.has(key) ||
      (value !== null && typeof value === "object"));
  }

  function requirePrimaryCaptureReady() {
    if (primaryCaptureBlocked) throw new Error("Agent settings are waiting for a read. Retry when the read finishes.");
  }

  function requireSubagentCaptureReady() {
    if (subagentCaptureBlocked) throw new Error("Subagent settings are waiting for a read. Retry when the read finishes.");
  }

  async function hydrateAgent(agentId: string) {
    const requestId = ++agentHydrationRequestId;
    syncPrimarySaveWaits();
    primaryReadWaitError = null;
    if (primaryReadTimer) clearTimeout(primaryReadTimer);
    primaryReadTimer = setTimeout(() => {
      if (settingsPanelAlive && requestId === agentHydrationRequestId && selectedEntity?.kind === "agent" && selectedAgentId === agentId) {
        primaryReadWaitError = "These settings did not load within 30 seconds. Retry reads the record.";
      }
    }, SETTINGS_WAIT_MS);
    // BL-912: this read shows what the record holds now; a section it leaves alone asks again.
    setAgentReadDeferred(false);
    detailLoading = true;
    hydrationInProgress = true;
    subagentEditSaveError = null;

    try {
      const response = await fetch(`/api/agents/${agentId}`);
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load agent details",
        );
        throw new Error(message);
      }

      const agent = (await response.json()) as AgentRow;
      if (!agent || typeof agent !== "object" || Array.isArray(agent) || agent.id !== agentId) throw new Error("Agent settings response did not contain the requested record");

      const currentSubagents = await fetchAgentSubagents(agentId);
      if (!settingsPanelAlive || requestId !== agentHydrationRequestId || selectedAgentId !== agentId || selectedEntity?.kind !== "agent" || selectedEntity.id !== agentId) {
        return;
      }

      untrack(() => {
        agents = agents.map((existing) =>
          existing.id === agent.id ? agent : existing,
        );
        agentStore.updateAgent(agent.id, mapToStoreAgent(agent));

        // BL-912, BL-942: a read of another agent (a first open, a pick, a delete fallback, the
        // prop naming another agent) fills every section. A read of the agent the forms already
        // hold replaces a section only while it is at rest: its form equals its baseline and no
        // save of it is queued or on its way. A section that is not at rest keeps what it shows
        // (an edit, typed text, a failed save and its error line), and the panel reads again
        // when it comes to rest.
        const fill = hydratedAgentId !== agentId;
        const atRest = agentSectionsAtRest();
        const replaces = (section: keyof typeof atRest) => {
          if (fill || atRest[section]) return true;
          setAgentReadDeferred(true);
          return false;
        };
        hydratedAgentId = agentId;
        // A return can read this entity before its own earlier save has written.
        if (primaryOwnedWritesPending(agentId)) setAgentReadDeferred(true);

        // A-1y: whether a refused memory save's recovery could not be done, so Retry is shown.
        let memoryConflictNeedsRetry = false;
        const conflict = memoryConflictBase?.agentId === agentId ? memoryConflictBase : null;
        memoryConflictBase = null;
        if (replaces("basic")) {
          basicForm = normaliseBasicForm(agent);
          basicPersistedSignature = makeBasicSignature(basicForm);
          basicPersistedForm = $state.snapshot(basicForm) as BasicForm;
          lastInvalidAgentSignature = null;
          basicSaveError = null;
          syncSelectedModelFromAgent();
        } else if (basicPersistedForm && !basicSaves.busy(agentId)) {
          memoryConflictNeedsRetry = rebaseBusyBasicSection(agent, conflict?.base ?? null);
        } else if (conflict) {
          // A save of the section is queued or on its way: it carries its own baseline and meets the
          // same check, so this read leaves the section to it and keeps the refused save's baseline.
          memoryConflictBase = conflict;
        }

        if (replaces("prompt")) {
          promptValue = agent.system_prompt ?? "";
          promptPersistedSignature = promptValue;
        }

        if (replaces("zip")) {
          zipForm = normaliseZipForm(agent);
          zipPersistedSignature = makeZipSignature(zipForm);
          syncCustomToolOverridesFromGlobal();
          // After the sync: it adds the global tools as empty rows and may reorder them, which the
          // save does not see, so opening compares equal and saves nothing.
          zipPersistedPayload = zipPayloadForSave(buildZipPayload(zipForm));
          zipSaveError = null;
        }

        if (replaces("toolGrid")) {
          const mcpDefaults = normaliseMcpDefaults(agent);
          defaultMCPGateways = mcpDefaults.gateways;
          defaultMCPToolSelections = mcpDefaults.selections;
          defaultCliToolIds = normaliseCliToolDefaults(agent);
          cliToolIdsExplicit =
            Array.isArray(agent.defaultTools) ||
            Array.isArray((agent as any).default_tools);
          dcmDisplaySettings = mcpDefaults.dcmDisplaySettings;
          mcpPersistedSignature = makeMcpSignature(
            mcpDefaults.gateways,
            mcpDefaults.selections,
            mcpDefaults.dcmDisplaySettings,
          );
          // An agent that holds its display settings only under the older name has no
          // `dcmDisplaySettings` yet: its first save writes the whole block, so the older name's
          // entries are not dropped (the chat bar's Tools menu does the same).
          mcpPersistedValues = {
            gateways: [...mcpDefaults.gateways],
            selections: cloneToolSelections(mcpDefaults.selections),
            dcm:
              agent.dcmDisplaySettings == null && (agent as any).dcm_display_settings != null
                ? null
                : cloneDcmDisplaySettings(mcpDefaults.dcmDisplaySettings),
          };
          mcpRenderNonce = mcpRenderNonce + 1;
        }

        if (replaces("codex")) {
          codexForm = normaliseCodexForm(agent, "agent");
          codexPersistedSignature = makeCodexSignature(codexForm, "agent");
          codexPersistedBlock =
            agent.codex_settings == null ? null : serializeCodexForm(codexForm, "agent");
          codexSaveState = "idle";
          codexSaveError = null;
          codexLastSaved = null;
        }

        if (replaces("claude")) {
          claudeForm = normaliseClaudeForm(agent, "agent");
          claudePersistedSignature = makeClaudeSignature(claudeForm);
          claudePersistedBlock =
            agent.claude_settings == null ? null : serializeClaudeForm(claudeForm);
          claudeSaveState = "idle";
          claudeSaveError = null;
          claudeLastSaved = null;
        }

        if (replaces("assignment")) {
          selectedSubagentIds = [...currentSubagents];
          assignmentPersistedSignature = makeSubagentSignature(currentSubagents);
          assignmentSaveError = null;
        }
        lastInvalidSubagentSignature = null;
        primaryReadWaitError = memoryConflictNeedsRetry ? MEMORY_CONFLICT_RETRY_MESSAGE : null;
        if (!primaryOwnedWritesPending(agentId)) {
          primarySaveWaits.delete(agentId);
          syncPrimarySaveWaits();
        }
      });
    } catch (error) {
      console.error("Failed to hydrate agent:", error);
      if (!settingsPanelAlive || requestId !== agentHydrationRequestId || selectedAgentId !== agentId || selectedEntity?.kind !== "agent" || selectedEntity.id !== agentId) {
        return;
      }
      untrack(() => {
        // A failed same-entity Retry keeps every typed draft; a first load has no own draft.
        if (hydratedAgentId !== agentId) resetAgentDetailState();
        primaryReadWaitError = error instanceof Error ? error.message : "Failed to load agent details";
      });
      toast.error(
        error instanceof Error ? error.message : "Failed to load agent details",
      );
    } finally {
      if (requestId !== agentHydrationRequestId) {
        return;
      }
      if (primaryReadTimer) clearTimeout(primaryReadTimer);
      primaryReadTimer = null;
      untrack(() => {
        hydrationInProgress = false;
        detailLoading = false;
      });
    }
  }

  async function loadWebSearchProviderAvailability() {
    if (webSearchProviderAvailabilityLoading) return;
    webSearchProviderAvailabilityLoading = true;
    webSearchProviderAvailabilityError = null;

    try {
      const response = await fetch("/api/settings/api-keys");
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load web search provider key status",
        );
        throw new Error(message);
      }

      const payload = await response.json();
      const keys = payload?.keys ?? {};
      const availability = {
        exa: keys?.exa?.status === "ready",
        perplexity: keys?.perplexity?.status === "ready",
      };
      availableWebSearchProviders = availability;
    } catch (error) {
      console.error("Failed to load web search provider availability:", error);
      webSearchProviderAvailabilityError =
        error instanceof Error
          ? error.message
          : "Failed to load web search provider key status";
      availableWebSearchProviders = {
        exa: false,
        perplexity: false,
      };
    } finally {
      webSearchProviderAvailabilityLoading = false;
      hasLoadedWebSearchProviderAvailability = true;
    }
  }

  async function loadAgentBrowserRuntimeStatus() {
    if (agentBrowserRuntimeStatusLoading) return;
    agentBrowserRuntimeStatusLoading = true;
    agentBrowserRuntimeStatusError = null;

    try {
      const response = await fetch("/api/native-tools/agent-browser/runtime");
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load Agent Browser runtime status",
        );
        throw new Error(message);
      }

      agentBrowserRuntimeStatus = (await response.json()) as AgentBrowserRuntimeStatus;
    } catch (error) {
      console.error("Failed to load Agent Browser runtime status:", error);
      agentBrowserRuntimeStatusError =
        error instanceof Error
          ? error.message
          : "Failed to load Agent Browser runtime status";
      agentBrowserRuntimeStatus = null;
    } finally {
      agentBrowserRuntimeStatusLoading = false;
    }
  }

  async function loadNativeSandboxStatus() {
    if (nativeSandboxStatusLoading) return;
    nativeSandboxStatusLoading = true;
    nativeSandboxStatusError = null;

    try {
      const [dockerResult, appleResult] = await Promise.allSettled([
        fetch("/api/native-tools/sandbox/status"),
        fetch("/api/native-tools/sandbox/status?backend=apple_container"),
      ]);
      const errors: string[] = [];

      if (dockerResult.status === "fulfilled" && dockerResult.value.ok) {
        nativeSandboxStatus = (await dockerResult.value.json()) as NativeSandboxStatus;
      } else {
        const message =
          dockerResult.status === "fulfilled"
            ? await extractError(dockerResult.value, "Failed to load Docker Sandbox status")
            : dockerResult.reason instanceof Error
              ? dockerResult.reason.message
              : "Failed to load Docker Sandbox status";
        nativeSandboxStatus = null;
        errors.push(message);
      }

      if (appleResult.status === "fulfilled" && appleResult.value.ok) {
        nativeAppleSandboxStatus = (await appleResult.value.json()) as NativeSandboxStatus;
      } else {
        const message =
          appleResult.status === "fulfilled"
            ? await extractError(appleResult.value, "Failed to load Apple Container status")
            : appleResult.reason instanceof Error
              ? appleResult.reason.message
              : "Failed to load Apple Container status";
        nativeAppleSandboxStatus = null;
        errors.push(message);
      }

      if (errors.length > 0) {
        nativeSandboxStatusError = errors.join(" ");
      }
    } catch (error) {
      console.error("Failed to load sandbox status:", error);
      nativeSandboxStatusError =
        error instanceof Error
          ? error.message
          : "Failed to load sandbox status";
      nativeSandboxStatus = null;
      nativeAppleSandboxStatus = null;
    } finally {
      nativeSandboxStatusLoading = false;
    }
  }

  async function loadSavedModelsForPanel() {
    if (savedModelsLoading) return;
    savedModelsLoading = true;
    savedModelsError = null;

    try {
      const response = await fetch("/api/user/saved-models");
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load saved models",
        );
        throw new Error(message);
      }

      const payload = await response.json();
      const models: SavedModel[] = Array.isArray(payload)
        ? payload
        : (payload?.models ?? payload ?? []);
      savedModels = models ?? [];
      savedModelsStore.setSavedModels(savedModels);
    } catch (error) {
      console.error("Failed to load saved models:", error);
      savedModels = [];
      savedModelsError =
        error instanceof Error ? error.message : "Failed to load saved models";
    } finally {
      savedModelsLoading = false;
      syncSelectedModelFromAgent();
      syncSelectedModelFromSubagent();
    }
  }

  async function refreshModelPickerData() {
    const tasks: Promise<unknown>[] = [loadSavedModelsForPanel()];
    if (isManagedPrimaryAgentType(basicForm.agentType)) {
      tasks.push(loadModelConnectionOptionsForPanel({ force: true }));
    }
    await Promise.all(tasks);
  }

  async function loadVoiceProfiles() {
    if (voiceProfilesLoading) return;
    voiceProfilesLoading = true;
    voiceProfilesError = null;

    try {
      const response = await fetch("/api/voice/profiles");
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load voice profiles",
        );
        throw new Error(message);
      }

      const payload = await response.json();
      const profiles: VoiceProfileRecord[] = Array.isArray(payload?.profiles)
        ? payload.profiles
        : [];
      voiceProfiles = profiles;
    } catch (error) {
      console.error("Failed to load voice profiles:", error);
      voiceProfilesError =
        error instanceof Error ? error.message : "Failed to load voice profiles";
      voiceProfiles = [];
    } finally {
      voiceProfilesLoading = false;
    }
  }

  async function loadVoiceProviders() {
    if (voiceProvidersLoading) return;
    voiceProvidersLoading = true;
    voiceProvidersError = null;

    try {
      const response = await fetch("/api/voice/providers");
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load voice providers",
        );
        throw new Error(message);
      }

      const payload = await response.json();
      voiceProviders = Array.isArray(payload?.providers)
        ? payload.providers
        : [];
    } catch (error) {
      console.error("Failed to load voice providers:", error);
      voiceProvidersError =
        error instanceof Error ? error.message : "Failed to load voice providers";
      voiceProviders = [];
    } finally {
      voiceProvidersLoading = false;
    }
  }

  async function loadInputDevices() {
    if (!navigator?.mediaDevices?.enumerateDevices) return;

    try {
      inputDevices = await loadMicrophoneDeviceOptions({
        mediaDevices: navigator.mediaDevices,
      });
    } catch (error) {
      console.warn("Failed to enumerate microphones:", error);
      inputDevices = [];
    }
  }

  async function loadAgentVoices(provider: string, model: string) {
    if (!provider || provider === "browser") {
      voiceOptions = [];
      voiceOptionsError = null;
      voiceOptionsKey = "";
      return;
    }

    const key = `${provider}:${model}`;
    if (voiceOptionsKey === key || voiceOptionsLoading) return;

    voiceOptionsKey = key;
    voiceOptionsLoading = true;
    voiceOptionsError = null;

    try {
      const params = new URLSearchParams({ provider });
      if (model) {
        params.set("model", model);
      }

      const response = await fetch(`/api/voice/voices?${params.toString()}`);
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load voices",
        );
        throw new Error(message);
      }

      const payload = await response.json();
      const voices: VoiceSummary[] = Array.isArray(payload?.voices)
        ? payload.voices
        : [];
      voiceOptions = voices;
    } catch (error) {
      console.error("Failed to load voices:", error);
      voiceOptionsError =
        error instanceof Error ? error.message : "Failed to load voices";
      voiceOptions = [];
    } finally {
      voiceOptionsLoading = false;
    }
  }

  async function loadModelConnectionOptionsForPanel({ force = false }: { force?: boolean } = {}) {
    const agentTypeAtRequest = basicForm.agentType;
    if (!isManagedPrimaryAgentType(agentTypeAtRequest)) return;
    if (modelConnectionOptionsLoading) return;
    if (
      !force &&
      modelConnectionOptions &&
      modelConnectionOptionsLoadedForAgentType === agentTypeAtRequest
    ) {
      return;
    }
    modelConnectionOptionsLoading = true;
    modelConnectionOptionsError = null;

    try {
      const response = await fetch("/api/models?include=connections");
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load model connections",
        );
        throw new Error(message);
      }

      const payload = await response.json();
      modelConnectionOptions = payload?.data?.connections ?? null;
      modelConnectionOptionsLoadedForAgentType = agentTypeAtRequest;
    } catch (error) {
      console.error("Failed to load model connection options:", error);
      modelConnectionOptions = null;
      modelConnectionOptionsLoadedForAgentType = null;
      modelConnectionOptionsError =
        error instanceof Error
          ? error.message
          : "Failed to load model connection options";
    } finally {
      modelConnectionOptionsLoading = false;
    }
  }

  // The connection status is asked again only when the Primary Agent's TYPE changes: read through a
  // `$derived`, so a rewrite of the whole form that keeps the type is not a trigger, and the load
  // runs untracked, since it reads and writes the states its own fetch flips (a tracked call re-ran
  // on a failed answer, forever: BL-977). A failed load shows its error and does not retry by
  // itself; `handleLocalAiSettingsUpdated` and `refreshModelPickerData` reload with `force`.
  const primaryTypeForConnectionOptions = $derived(basicForm.agentType);
  $effect(() => {
    if (!isManagedPrimaryAgentType(primaryTypeForConnectionOptions)) return;
    untrack(() => {
      void loadModelConnectionOptionsForPanel();
    });
  });

  function handleLocalAiSettingsUpdated() {
    if (!isManagedPrimaryAgentType(basicForm.agentType)) return;
    void loadModelConnectionOptionsForPanel({ force: true });
  }

  function syncSelectedModelFromAgent() {
    if (!savedModels.length) {
      selectedModelId = null;
      return;
    }

    let match: SavedModel | null = null;

    const presetId = basicForm.primary_model_preset_id?.trim() ?? "";
    if (presetId) {
      match = savedModels.find((model) => model.id === presetId) ?? null;
    }

    if (!match) {
      match =
        savedModels.find((model) => {
          if (
            model.provider !== basicForm.primary_model_provider ||
            model.modelId !== basicForm.primary_model_name &&
            model.effectiveModelId !== basicForm.primary_model_name
          ) {
            return false;
          }

          const connection = resolveSavedModelConnection(model);
          const agentConnection = basicForm.primary_model_connection;
          if (!agentConnection) return true;
          if (connection.type !== agentConnection.type) return false;
          if (agentConnection.service && connection.service !== agentConnection.service) return false;
          return true;
        }) ?? null;
    }

    selectedModelId = match && agentPresetShowsAsSelected(match) ? match.id : null;
  }

  /**
   * Whether Agent Settings shows the agent's saved preset as its selection. A preset it cannot
   * select (not a chat model, the wrong agent type) shows no selection, but the form keeps the
   * saved model: opening Settings, or a preset list or connection change, never changes or saves
   * it (hydration never saves, BL-514); only the user's pick does. A preset that is only
   * unavailable for now stays selected with its reason shown (BL-517).
   */
  function agentPresetShowsAsSelected(model: SavedModel): boolean {
    return presetAvailabilityKeepsSelection(
      getModelPresetAvailability({
        model,
        agentType: basicForm.agentType,
        connectionOptions: modelConnectionOptions,
      }),
    );
  }

  /**
   * BL-514: the form's copy of `provider_specific_settings` after a model pick or clear, the way
   * the agent PUT stores it: the preset's model keys replace the old model keys, and the agent's
   * own keys (the Work mode, the Bash never-allow list, `codex_*`, ...) stay.
   */
  function withAgentModelKeys(modelKeys: Record<string, any> | null): Record<string, any> | null {
    const next = applyAgentProviderSettingsUpdate(basicForm.provider_specific_settings, modelKeys);
    return next && Object.keys(next).length > 0 ? next : null;
  }

  function applySavedModelToBasicForm(model: SavedModel) {
    const settings = model.settings ?? {};

    basicForm = {
      ...basicForm,
      primary_model_preset_id: model.id,
      primary_model_connection: resolveSavedModelConnection(model),
      primary_model_provider: model.provider,
      primary_model_name: model.effectiveModelId ?? model.modelId,
      provider_specific_settings: withAgentModelKeys(presetModelSettings(settings)),
      primary_model_temperature:
        typeof settings.temperature === "number" ? settings.temperature : null,
      primary_model_max_tokens:
        typeof settings.maxTokens === "number" ? settings.maxTokens : null,
      primary_model_top_p:
        typeof settings.topP === "number" ? settings.topP : null,
      primary_model_top_k:
        typeof settings.topK === "number" ? settings.topK : null,
      primary_model_frequency_penalty:
        typeof settings.frequencyPenalty === "number"
          ? settings.frequencyPenalty
          : null,
      primary_model_presence_penalty:
        typeof settings.presencePenalty === "number"
          ? settings.presencePenalty
          : null,
      primary_model_seed:
        typeof settings.seed === "number" ? settings.seed : null,
      primary_model_stop_sequences: Array.isArray(settings.stopSequences)
        ? settings.stopSequences.map((entry) => String(entry))
        : null,
      primary_model_reasoning_effort:
        typeof settings.reasoningEffort === "string"
          ? settings.reasoningEffort
          : null,
      primary_model_capabilities: model.capabilities ?? null,
    };
  }

  function resolveSavedCliSubagentRuntime(model: SavedModel): "codex" | "claude" | null {
    const connection = resolveSavedModelConnection(model);
    const connectionId = (connection.id ?? "").trim().toLowerCase();
    const connectionService = (connection.service ?? "").trim().toLowerCase();
    const provider = (model.provider ?? "").trim().toLowerCase();
    const modelId = (model.modelId ?? "").trim().toLowerCase();

    if (
      connectionId === "codex-cli" ||
      connectionService.includes("codex") ||
      provider.includes("codex") ||
      modelId.includes("codex")
    ) {
      return "codex";
    }

    if (
      connectionId === "claude-cli" ||
      connectionService.includes("claude-cli") ||
      provider.includes("claude-cli") ||
      modelId.includes("claude-cli")
    ) {
      return "claude";
    }

    return null;
  }

  function extractSavedCliRuntimeModel(
    model: SavedModel,
    runtime: "codex" | "claude",
  ): string | null {
    const settings = model.settings ?? null;
    if (!settings || typeof settings !== "object") return null;

    const key = runtime === "codex" ? "codex_model" : "claude_model";
    const value = settings[key];
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  function mergeSubagentCliRuntimeModelSetting(
    runtime: "codex" | "claude",
    modelId: string | null,
  ): Record<string, any> | null {
    const current =
      subagentForm.provider_specific_settings &&
      typeof subagentForm.provider_specific_settings === "object"
        ? { ...subagentForm.provider_specific_settings }
        : {};

    const key = runtime === "codex" ? "codex_model" : "claude_model";
    if (modelId && modelId.trim().length > 0) {
      current[key] = modelId.trim();
    }

    return Object.keys(current).length > 0 ? current : null;
  }

  function seedCliSubagentFormsFromSavedModel(model: SavedModel) {
    if (subagentForm.subagentType !== "cli") return;

    const runtime = resolveSavedCliSubagentRuntime(model);
    if (!runtime) return;

    const nativeModel = extractSavedCliRuntimeModel(model, runtime);
    if (!nativeModel) return;

    if (runtime === "codex") {
      updateCodexForm(
        (current) =>
          current.model === nativeModel
            ? current
            : { ...current, model: nativeModel },
        "subagent",
      );
      subagentForm = {
        ...subagentForm,
        provider_specific_settings: mergeSubagentCliRuntimeModelSetting(
          "codex",
          nativeModel,
        ),
      };
      return;
    }

    updateClaudeForm(
      (current) =>
        current.model === nativeModel
          ? current
          : { ...current, model: nativeModel },
      "subagent",
    );
    subagentForm = {
      ...subagentForm,
      provider_specific_settings: mergeSubagentCliRuntimeModelSetting(
        "claude",
        nativeModel,
      ),
    };
  }

  function clearAgentModelSelection() {
    selectedModelId = null;
    basicForm = {
      ...basicForm,
      primary_model_preset_id: "",
      primary_model_connection: null,
      primary_model_provider: "",
      primary_model_name: "",
      provider_specific_settings: withAgentModelKeys(null),
      primary_model_temperature: null,
      primary_model_max_tokens: null,
      primary_model_top_p: null,
      primary_model_top_k: null,
      primary_model_frequency_penalty: null,
      primary_model_presence_penalty: null,
      primary_model_seed: null,
      primary_model_stop_sequences: null,
      primary_model_reasoning_effort: null,
      primary_model_capabilities: null,
    };
  }

  function syncSelectedModelFromSubagent() {
    if (!selectedEditableSubagentId || !savedModels.length) {
      selectedSubagentModelId = null;
      return;
    }

    const match = findSubagentFormModel(subagentForm);
    selectedSubagentModelId = match && subagentPresetShowsAsSelected(match) ? match.id : null;
  }

  /**
   * BL-834, the Subagent twin of `agentPresetShowsAsSelected`: whether the picker shows the
   * Subagent's saved preset as its selection. A preset it cannot select (not a chat model, the
   * wrong Subagent type) shows no selection, but the form keeps the saved model: opening
   * Settings, or a preset list change, never changes or saves it (hydration never saves); only
   * the user's pick or clear does. A preset that is only unavailable for now stays selected with
   * its reason shown (BL-517).
   */
  function subagentPresetShowsAsSelected(model: SavedModel): boolean {
    return presetAvailabilityKeepsSelection(
      getModelPresetAvailability({
        model,
        agentType: getSubagentToolHostScope(subagentForm.subagentType),
        connectionOptions: null,
      }),
    );
  }

  function handleSubagentModelChange(
    value: string | string[] | null | undefined,
  ) {
    if (subagentOwnedSaveInFlightUi) return;
    const nextValue = Array.isArray(value) ? value[0] : value;
    if (!nextValue) {
      clearSubagentModelSelection();
      return;
    }

    const model = savedModels.find((item) => item.id === nextValue);
    if (!model) {
      selectedSubagentModelId = null;
      return;
    }

    const availability = getModelPresetAvailability({
      model,
      agentType: getSubagentToolHostScope(subagentForm.subagentType),
      connectionOptions: null,
    });
    if (availability.disabled) {
      toast.error(availability.reason ?? "This model preset is not selectable.");
      return;
    }

    selectedSubagentModelId = model.id;
    subagentForm = {
      ...subagentForm,
      primary_model_provider: model.provider,
      primary_model_name: model.effectiveModelId ?? model.modelId,
      primary_model_preset_id: model.id,
      primary_model_connection: resolveSavedModelConnection(model),
    };
    seedCliSubagentFormsFromSavedModel(model);
  }

  function handleAgentModelChange(value: string | string[] | null | undefined) {
    if (primaryOwnedSaveInFlightUi) return;
    const nextValue = Array.isArray(value) ? value[0] : value;
    if (!nextValue) {
      clearAgentModelSelection();
      return;
    }

    const model = savedModels.find((item) => item.id === nextValue);
    if (!model) {
      clearAgentModelSelection();
      return;
    }

    const availability = getModelPresetAvailability({
      model,
      agentType: basicForm.agentType,
      connectionOptions: modelConnectionOptions,
    });
    if (availability.disabled) {
      toast.error(availability.reason ?? "This model preset is not selectable.");
      return;
    }

    selectedModelId = model.id;
    applySavedModelToBasicForm(model);
  }

  function clearSubagentModelSelection() {
    selectedSubagentModelId = null;
    subagentForm = {
      ...subagentForm,
      primary_model_provider: "",
      primary_model_name: "",
      primary_model_preset_id: "",
      primary_model_connection: null,
    };
  }

  /**
   * BL-266: the saved model a Subagent's form points at. The preset it saved wins; without one,
   * an API Subagent shows no selection (its model was saved before Batshit kept the connection,
   * and it will not run until the model is picked again, which saves the preset), while the
   * other types still match by provider and model name, the way they always have.
   */
  function findSubagentFormModel(form: SubagentForm): SavedModel | null {
    if (form.primary_model_preset_id) {
      return savedModels.find((model) => model.id === form.primary_model_preset_id) ?? null;
    }
    if (form.subagentType === "api") return null;
    return (
      savedModels.find(
        (model) =>
          model.provider === form.primary_model_provider &&
          (model.modelId === form.primary_model_name ||
            model.effectiveModelId === form.primary_model_name),
      ) ?? null
    );
  }

  let avatarAppActionBusy = $state(false);

  export function suppliedAvatarAvailability(args: ImportArgs['avatar.import_file']): string {
    if (!settingsPanelAlive) return 'unsupported_document';
    if (avatarAppActionBusy) return 'owner_busy';
    if (args.entityType === 'agent') {
      if (selectedEntity?.kind !== 'agent' || selectedAgentId !== args.entityId) return 'unsupported_target';
      if (primarySettingsReadWaiting || !basicPersistedForm) return 'settings_unconfirmed';
      if (primaryOwnedSaveInFlightUi || isUploadingAgentAvatar) return 'owner_busy';
      if (!Object.values(agentSectionsAtRest()).every(Boolean)) return 'unsaved_changes';
    } else if (args.entityType === 'subagent') {
      if (selectedEntity?.kind !== 'subagent' || selectedEditableSubagentId !== args.entityId) return 'unsupported_target';
      if (subagentSettingsReadWaiting || !subagentPersistedForm) return 'settings_unconfirmed';
      if (subagentOwnedSaveInFlightUi || subagentAvatarUploading) return 'owner_busy';
      if (!Object.values(subagentSectionsAtRest()).every(Boolean)) return 'unsaved_changes';
    } else return 'unsupported_target';
    return 'available';
  }

  export async function importAppActionAvatar(
    args: ImportArgs['avatar.import_file'], files: File[], context: ActionContext
  ): Promise<ImportOutcome> {
    const available = suppliedAvatarAvailability(args);
    if (available !== 'available') refuse(available);
    const primary = args.entityType === 'agent';
    const generation = primary ? agentHydrationRequestId : subagentReadGeneration;
    const initialSignature = primary ? makeBasicSignature(basicForm) : makeSubagentFormSignature(subagentForm);
    const check = () => {
      if (!settingsPanelAlive || selectedEntity?.kind !== args.entityType || selectedEntity.id !== args.entityId ||
        (primary ? agentHydrationRequestId : subagentReadGeneration) !== generation) refuse('target_changed');
    };
    avatarAppActionBusy = true;
    if (primary) isUploadingAgentAvatar = true; else subagentAvatarUploading = true;
    try {
      return await performAvatarImport(files[0], args, {
        check,
        stage: url => {
          const signature = primary ? makeBasicSignature(basicForm) : makeSubagentFormSignature(subagentForm);
          if (signature !== initialSignature || (primary ? primaryOwnedSaveInFlightUi : subagentOwnedSaveInFlightUi)) refuse('unsaved_changes');
          if (primary) { basicForm = { ...basicForm, avatar_url: url }; basicSaveError = null; isUploadingAgentAvatar = false; }
          else { subagentForm = { ...subagentForm, avatar: url }; subagentEditSaveError = null; subagentAvatarUploading = false; }
        },
        savedAvatar: () => primary ? basicPersistedForm?.avatar_url ?? null : subagentPersistedForm?.avatar ?? null,
        saveError: () => primary ? basicSaveError : subagentEditSaveError
      }, context);
    } finally {
      avatarAppActionBusy = false;
      if (primary && selectedAgentId === args.entityId) isUploadingAgentAvatar = false;
      if (!primary && selectedEditableSubagentId === args.entityId) subagentAvatarUploading = false;
    }
  }

  async function handleAgentAvatarUpload(event: Event) {
    if (primaryOwnedSaveInFlightUi || avatarAppActionBusy) return;
    const targetId = selectedAgentId;
    const input = event.currentTarget as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      agentAvatarError = "Please choose an image file";
      if (input) input.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      agentAvatarError = "Avatar must be 5MB or smaller";
      if (input) input.value = "";
      return;
    }

    if (!targetId) {
      agentAvatarError = "Select an agent before uploading an avatar";
      if (input) input.value = "";
      return;
    }

    const uploadRequestId = ++agentAvatarUploadRequestId;
    isUploadingAgentAvatar = true;
    agentAvatarError = null;

    try {
      const url = await uploadAvatarFile(file, { entityType: "agent", entityId: targetId });

      if (!settingsPanelAlive || uploadRequestId !== agentAvatarUploadRequestId || selectedEntity?.kind !== "agent" || selectedAgentId !== targetId || primaryOwnedSaveInFlightUi) {
        // Keep the new file owned by its original entity. Its next successful avatar change or
        // owner delete performs the normal cutoff-aware tidy; never sweep a newer pending upload.
        if (settingsPanelAlive) toast.info("Avatar uploaded, but its settings changed while it was uploading. Choose the image again after the save finishes.");
        return;
      }

      basicForm = {
        ...basicForm,
        avatar_url: url,
      };
    } catch (error) {
      console.error("Agent avatar upload failed:", error);
      if (settingsPanelAlive && uploadRequestId === agentAvatarUploadRequestId && selectedEntity?.kind === "agent" && selectedAgentId === targetId) agentAvatarError =
        error instanceof Error ? error.message : "Failed to upload avatar";
    } finally {
      if (settingsPanelAlive && uploadRequestId === agentAvatarUploadRequestId && selectedAgentId === targetId) isUploadingAgentAvatar = false;
      if (input) input.value = "";
    }
  }

  function clearAgentAvatar() {
    basicForm = {
      ...basicForm,
      avatar_url: null,
    };
  }

  function chooseAgentAvatarIcon(iconRef: IconRef) {
    if (primaryOwnedSaveInFlightUi) return;
    basicForm = {
      ...basicForm,
      avatar_url: null,
      avatar_icon_ref: iconRef,
      avatar_icon_fit: "fill",
    };
  }

  async function handleSubagentAvatarUpload(event: Event) {
    if (subagentOwnedSaveInFlightUi || avatarAppActionBusy) return;
    const targetId = selectedEditableSubagentId;
    const input = event.currentTarget as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      subagentAvatarError = "Please choose an image file";
      if (input) input.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      subagentAvatarError = "Avatar must be 5MB or smaller";
      if (input) input.value = "";
      return;
    }

    if (!targetId) {
      subagentAvatarError = "Select a subagent before uploading an avatar";
      if (input) input.value = "";
      return;
    }

    const uploadRequestId = ++subagentAvatarUploadRequestId;
    subagentAvatarUploading = true;
    subagentAvatarError = null;

    try {
      const url = await uploadAvatarFile(file, { entityType: "subagent", entityId: targetId });

      if (!settingsPanelAlive || uploadRequestId !== subagentAvatarUploadRequestId || selectedEntity?.kind !== "subagent" || selectedEditableSubagentId !== targetId || subagentOwnedSaveInFlightUi) {
        // Keep the new file owned by its original entity. Its next successful avatar change or
        // owner delete performs the normal cutoff-aware tidy; never sweep a newer pending upload.
        if (settingsPanelAlive) toast.info("Avatar uploaded, but its settings changed while it was uploading. Choose the image again after the save finishes.");
        return;
      }

      subagentForm = {
        ...subagentForm,
        avatar: url,
      };
    } catch (error) {
      console.error("Subagent avatar upload failed:", error);
      if (settingsPanelAlive && uploadRequestId === subagentAvatarUploadRequestId && selectedEntity?.kind === "subagent" && selectedEditableSubagentId === targetId) subagentAvatarError =
        error instanceof Error ? error.message : "Failed to upload avatar";
    } finally {
      if (settingsPanelAlive && uploadRequestId === subagentAvatarUploadRequestId && selectedEditableSubagentId === targetId) subagentAvatarUploading = false;
      if (input) input.value = "";
    }
  }

  function clearSubagentAvatar() {
    subagentForm = {
      ...subagentForm,
      avatar: null,
    };
  }

  function chooseSubagentAvatarIcon(iconRef: IconRef) {
    if (subagentOwnedSaveInFlightUi) return;
    subagentForm = {
      ...subagentForm,
      avatar: null,
      avatar_icon_ref: iconRef,
      avatar_icon_fit: "fill",
    };
  }

  async function fetchAgentSubagents(agentId: string) {
    try {
      const response = await fetch(`/api/agents/${agentId}/subagents`);
      if (!response.ok) {
        return [];
      }

      const payload = await response.json();
      const subagents: SubagentRow[] = Array.isArray(payload?.subagents)
        ? payload.subagents
        : [];
      return subagents.map((subagent) => subagent.id);
    } catch (error) {
      console.error("Failed to load agent subagents:", error);
      return [];
    }
  }

  function selectAgent(agentId: string) {
    if (createEntityMode) return;
    if (selectedEntity?.kind !== "agent") { subagentAvatarUploadRequestId += 1; subagentAvatarUploading = false; }
    if (agentId === selectedAgentId) {
      untrack(() => {
        selectedEntity = { kind: "agent", id: agentId };
        activeAgentSettingsTab = "core";
        createEntityMode = false;
      });
      return;
    }
    untrack(() => {
      selectedAgentId = agentId;
      selectedEntity = { kind: "agent", id: agentId };
      activeAgentSettingsTab = "core";
      createEntityMode = false;
      resetAgentDetailState();
    });
    void hydrateAgent(agentId);
  }

  function createDefaultVoiceProfile(): VoiceProfileForm {
    return {
      voiceSessionRuntime: "",
      voiceModeInputMode: "",
      voiceModeSubmitMode: "",
      provider: "",
      model: "",
      voiceId: "",
      profileId: "",
      ttsItalicNarrationBehavior: "",
      sttProvider: "",
      sttModel: "",
      realtimeSttProvider: "",
      realtimeSttModel: "",
    };
  }

  function createDefaultBasicForm(): BasicForm {
    return {
      displayName: "",
      agentType: "api",
      show_reasoning: false,
      preserve_reasoning: false,
      tool_approval_mode: "off",
      auto_compact_settings: normalizeAgentAutoCompactSettings(null),
      memory_settings: resolveAgentMemorySettingsDraft(null),
      workers_enabled: true,
    dms_enabled: false,
    dm_sender_scope: "all",
    dm_sender_agent_ids: [],
    wake_enabled: true,
    wake_timeout_minutes: null,
    wake_target: DEFAULT_WAKE_TARGET,
    jev_juice_skill_tool_hints: false,
    jev_juice_judge_tool: false,
    jev_juice_memory_rerank: false,
    jev_juice_memory_recall: false,
    jev_juice_reply_check: false,
    jev_juice_style_coach: false,
      webhook_url: "",
      agent_url: "",
      default_project_id: null,
      include_global_prompt: true,
      primary_model_provider: "",
      primary_model_name: "",
      primary_model_preset_id: "",
      primary_model_connection: null,
      avatar_url: null,
      avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
      avatar_icon_fit: "fill",
      goon_id: null,
      provider_specific_settings: null,
      primary_model_temperature: null,
      primary_model_max_tokens: null,
      primary_model_top_p: null,
      primary_model_top_k: null,
      primary_model_frequency_penalty: null,
      primary_model_presence_penalty: null,
      primary_model_seed: null,
      primary_model_stop_sequences: null,
      primary_model_reasoning_effort: null,
      primary_model_capabilities: null,
      voice_profile: createDefaultVoiceProfile(),
    };
  }

  function normaliseBasicForm(agent: AgentRow): BasicForm {
    const normalisedType = normalizePrimaryAgentType(agent);

    const voiceProfile = normalizeAgentVoiceProfile(agent.voice_profile);
    const voiceTts = voiceProfile?.tts;
    const voiceStt = voiceProfile?.stt;
    const voiceRealtimeStt = voiceProfile?.realtimeStt;

    return {
      displayName: agent.displayName ?? "",
      agentType: normalisedType,
      show_reasoning:
        agent.show_reasoning ?? shouldShowReasoningByDefaultForPrimaryAgent(normalisedType),
      preserve_reasoning: agent.preserve_reasoning ?? false,
      tool_approval_mode:
        (agent as any).tool_approval_mode === "all" || (agent as any).toolApprovalMode === "all"
          ? "all"
          : "off",
      auto_compact_settings: normalizeAgentAutoCompactSettings(agent.auto_compact_settings),
      memory_settings: resolveAgentMemorySettingsDraft(agent),
      workers_enabled: resolveWorkersEnabled(agent),
    dms_enabled: resolveAgentDmsEnabled(agent),
    dm_sender_scope: resolveDmSenderPolicy(agent).scope,
    dm_sender_agent_ids: resolveDmSenderPolicy(agent).agentIds,
    jev_juice_skill_tool_hints: resolveAgentJevSkillToolHintsEnabled(agent),
    jev_juice_judge_tool: resolveAgentJevJudgeToolEnabled(agent),
    jev_juice_memory_rerank: resolveAgentJevMemoryRerankEnabled(agent),
    jev_juice_memory_recall: resolveAgentJevMemoryRecallEnabled(agent),
    jev_juice_reply_check: resolveAgentJevReplyCheckEnabled(agent),
    jev_juice_style_coach: resolveAgentJevStyleCoachEnabled(agent),
    wake_enabled: resolveAgentWakeEnabled(agent),
    wake_timeout_minutes: (() => {
      const validation = validateWakeTimeoutMinutes(
        (agent as any)?.wake_timeout_minutes,
      );
      return validation.ok ? validation.minutes : null;
    })(),
    wake_target: resolveWakeTarget(agent),
      webhook_url: agent.webhook_url ?? agent.webhookUrl ?? "",
      agent_url: agent.agent_url ?? "",
      default_project_id:
        typeof (agent as any).default_project_id === "string" &&
        (agent as any).default_project_id.trim().length > 0
          ? (agent as any).default_project_id
          : null,
      include_global_prompt: agent.include_global_prompt ?? true,
      primary_model_provider: agent.primary_model_provider ?? "",
      primary_model_name: agent.primary_model_name ?? agent.model ?? "",
      primary_model_preset_id: agent.primary_model_preset_id ?? "",
      primary_model_connection: agent.primary_model_connection ?? null,
      avatar_url: agent.avatar ?? agent.avatar_url ?? null,
      avatar_icon_ref: normalizeIconRef(agent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF),
      avatar_icon_fit: normalizeAvatarIconFit(agent.avatar_icon_fit),
      goon_id: agent.goon_id ?? null,
      provider_specific_settings: agent.provider_specific_settings ?? null,
      primary_model_temperature: agent.primary_model_temperature ?? null,
      primary_model_max_tokens: agent.primary_model_max_tokens ?? null,
      primary_model_top_p: agent.primary_model_top_p ?? null,
      primary_model_top_k: agent.primary_model_top_k ?? null,
      primary_model_frequency_penalty: agent.primary_model_frequency_penalty ?? null,
      primary_model_presence_penalty: agent.primary_model_presence_penalty ?? null,
      primary_model_seed: agent.primary_model_seed ?? null,
      primary_model_stop_sequences: agent.primary_model_stop_sequences ?? null,
      primary_model_reasoning_effort: agent.primary_model_reasoning_effort ?? null,
      primary_model_capabilities: agent.primary_model_capabilities ?? null,
      voice_profile: {
        voiceSessionRuntime: voiceProfile?.voiceSessionRuntime ?? "",
        voiceModeInputMode: voiceProfile?.voiceModeInputMode ?? "",
        voiceModeSubmitMode: voiceProfile?.voiceMode?.submitMode ?? "",
        provider: voiceTts?.providerId ?? "",
        model: voiceTts?.modelId ?? "",
        voiceId: voiceTts?.voiceId ?? "",
        profileId: voiceTts?.profileId ?? "",
        ttsItalicNarrationBehavior: voiceTts?.narration?.italicBehavior ?? "",
        sttProvider: voiceStt?.providerId ?? "",
        sttModel: voiceStt?.modelId ?? "",
        realtimeSttProvider: voiceRealtimeStt?.providerId ?? "",
        realtimeSttModel: voiceRealtimeStt?.modelId ?? "",
      },
    };
  }

  function createDefaultZipForm(includeGlobalTools = false): ZipForm {
    return {
      zip_ai_view_mode: ZIP_LAYOUT_INHERIT,
      zip_tool_notes_enabled: ZIP_NOTES_INHERIT,
      buffer_size: "",
      buffer_size_image: "",
      buffer_size_error: "",
      buffer_size_subagent: "",
      buffer_size_read_file: "",
      buffer_size_write_file: "",
      buffer_size_edit_file: "",
      buffer_size_execute_command: "",
      buffer_size_list_files: "",
      buffer_size_all_other_tools: "",
      zip_threshold_error: "",
      zip_threshold_image: "",
      zip_threshold_subagent: "",
      zip_threshold_read_file: "",
      zip_threshold_write_file: "",
      zip_threshold_edit_file: "",
      zip_threshold_execute_command: "",
      zip_threshold_list_files: "",
      zip_threshold_all_other_tools: "",
      auto_zip_error: ZIP_AUTO_INHERIT,
      auto_zip_image: ZIP_AUTO_INHERIT,
      auto_zip_subagent: ZIP_AUTO_INHERIT,
      auto_zip_read_file: ZIP_AUTO_INHERIT,
      auto_zip_write_file: ZIP_AUTO_INHERIT,
      auto_zip_edit_file: ZIP_AUTO_INHERIT,
      auto_zip_execute_command: ZIP_AUTO_INHERIT,
      auto_zip_list_files: ZIP_AUTO_INHERIT,
      auto_zip_all_other_tools: ZIP_AUTO_INHERIT,
      custom_tool_settings: includeGlobalTools
        ? (globalZipSettings?.custom_tool_settings ?? []).map((tool) => ({
            tool_name: tool.tool_name,
            buffer_size: "",
            zip_threshold: "",
            auto_zip: ZIP_AUTO_INHERIT,
          }))
        : [],
    };
  }

  function resetAgentDetailState() {
    agentAvatarUploadRequestId += 1;
    isUploadingAgentAvatar = false;
    hydratedAgentId = null;
    memoryConflictBase = null;
    memoryConflictResendUsed = false;
    basicForm = createDefaultBasicForm();
    basicPersistedSignature = null;
    basicPersistedForm = null;
    basicValidationError = null;
    basicSaveState = "idle";
    basicSaveError = null;
    basicLastSaved = null;
    lastInvalidAgentSignature = null;
    promptValue = "";
    promptPersistedSignature = null;
    agentPromptEditorOpen = false;
    agentBashBlockEditorOpen = false;
    agentBashAllowEditorOpen = false;
    agentBrowserFlagsEditorOpen = false;
    zipForm = createDefaultZipForm(true);
    zipPersistedSignature = null;
    zipPersistedPayload = null;
    zipValidationError = null;
    zipSaveState = "idle";
    zipSaveError = null;
    zipLastSaved = null;
    defaultMCPGateways = [];
    defaultMCPToolSelections = [];
    defaultCliToolIds = [];
    cliToolIdsExplicit = false;
    dcmDisplaySettings = createDefaultDcmDisplaySettings();
    mcpPersistedSignature = null;
    mcpPersistedValues = null;
    mcpSaveState = "idle";
    mcpSaveError = null;
    mcpLastSaved = null;
    mcpRenderNonce += 1;
    codexForm = createDefaultCodexForm();
    codexPersistedSignature = null;
    codexPersistedBlock = null;
    codexSaveState = "idle";
    codexSaveError = null;
    codexLastSaved = null;
    codexDirDraft = "";
    codexEnableDraft = "";
    codexDisableDraft = "";
    claudeForm = createDefaultClaudeForm();
    claudePersistedSignature = null;
    claudePersistedBlock = null;
    claudeSaveState = "idle";
    claudeSaveError = null;
    claudeLastSaved = null;
    claudeDirDraft = "";
    claudeAllowedToolDraft = "";
    claudeDisallowedToolDraft = "";
    selectedSubagentIds = [];
    assignmentPersistedSignature = null;
    assignmentSaveState = "idle";
    assignmentSaveError = null;
    assignmentLastSaved = null;
    selectedModelId = null;
    agentAvatarError = null;
    agentVoicePreviewBusy = false;
  }

  function normaliseZipForm(agent: AgentRow): ZipForm {
    const layoutValue =
      agent.zip_ai_view_mode === "appended"
        ? "appended"
        : agent.zip_ai_view_mode === "inline"
          ? "inline"
          : ZIP_LAYOUT_INHERIT;
    const notesValue =
      typeof agent.zip_tool_notes_enabled === "boolean"
        ? agent.zip_tool_notes_enabled
          ? "enabled"
          : "disabled"
        : ZIP_NOTES_INHERIT;
    return {
      zip_ai_view_mode: layoutValue,
      zip_tool_notes_enabled: notesValue,
      buffer_size: toStringValue(agent.buffer_size),
      buffer_size_image: toStringValue(agent.buffer_size_image),
      buffer_size_error: toStringValue(agent.buffer_size_error),
      buffer_size_subagent: toStringValue(agent.buffer_size_subagent),
      buffer_size_read_file: toStringValue(agent.buffer_size_read_file),
      buffer_size_write_file: toStringValue(agent.buffer_size_write_file),
      buffer_size_edit_file: toStringValue(agent.buffer_size_edit_file),
      buffer_size_execute_command: toStringValue(
        agent.buffer_size_execute_command,
      ),
      buffer_size_list_files: toStringValue(agent.buffer_size_list_files),
      buffer_size_all_other_tools: toStringValue(
        agent.buffer_size_all_other_tools,
      ),
      zip_threshold_error: toStringValue(agent.zip_threshold_error),
      zip_threshold_image: toStringValue(agent.zip_threshold_image),
      zip_threshold_subagent: toStringValue(agent.zip_threshold_subagent),
      zip_threshold_read_file: toStringValue(agent.zip_threshold_read_file),
      zip_threshold_write_file: toStringValue(agent.zip_threshold_write_file),
      zip_threshold_edit_file: toStringValue(agent.zip_threshold_edit_file),
      zip_threshold_execute_command: toStringValue(
        agent.zip_threshold_execute_command,
      ),
      zip_threshold_list_files: toStringValue(agent.zip_threshold_list_files),
      zip_threshold_all_other_tools: toStringValue(
        agent.zip_threshold_all_other_tools,
      ),
      auto_zip_error: toAutoZipValue((agent as any).auto_zip_error, (agent as any).zip_disabled_error),
      auto_zip_image: toAutoZipValue((agent as any).auto_zip_image, (agent as any).zip_disabled_image),
      auto_zip_subagent: toAutoZipValue((agent as any).auto_zip_subagent, (agent as any).zip_disabled_subagent),
      auto_zip_read_file: toAutoZipValue((agent as any).auto_zip_read_file, (agent as any).zip_disabled_read_file),
      auto_zip_write_file: toAutoZipValue((agent as any).auto_zip_write_file, (agent as any).zip_disabled_write_file),
      auto_zip_edit_file: toAutoZipValue((agent as any).auto_zip_edit_file, (agent as any).zip_disabled_edit_file),
      auto_zip_execute_command: toAutoZipValue((agent as any).auto_zip_execute_command, (agent as any).zip_disabled_execute_command),
      auto_zip_list_files: toAutoZipValue((agent as any).auto_zip_list_files, (agent as any).zip_disabled_list_files),
      auto_zip_all_other_tools: toAutoZipValue((agent as any).auto_zip_all_other_tools, (agent as any).zip_disabled_all_other_tools),
      custom_tool_settings: toCustomToolArray(agent.custom_tool_settings).map(
        (tool) => ({
          tool_name: tool.tool_name,
          buffer_size: toStringValue(tool.buffer_size),
          zip_threshold: toStringValue(tool.zip_threshold),
          auto_zip: toAutoZipValue((tool as any).auto_zip, (tool as any).zip_disabled),
        }),
      ),
    };
  }

  function normaliseSubagentForm(subagent: SubagentRow): SubagentForm {
    return {
      displayName: subagent.displayName ?? "",
      subagentType: normalizeSubagentType(subagent, subagent.subagentType),
      specialty: subagent.specialty ?? "general",
      webhook_url: subagent.webhook_url ?? subagent.webhookUrl ?? "",
      include_global_prompt: subagent.include_global_prompt ?? false,
      system_prompt: subagent.system_prompt ?? "",
      primary_model_provider: subagent.primary_model_provider ?? "",
      primary_model_name: subagent.primary_model_name ?? "",
      primary_model_preset_id: subagent.primary_model_preset_id ?? "",
      primary_model_connection: subagent.primary_model_connection ?? null,
      timeout_seconds:
        typeof subagent.timeout_seconds === "number"
          ? String(subagent.timeout_seconds)
          : "",
      avatar: subagent.avatar ?? null,
      avatar_icon_ref: normalizeIconRef(subagent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF),
      avatar_icon_fit: normalizeAvatarIconFit(subagent.avatar_icon_fit),
      provider_specific_settings: subagent.provider_specific_settings ?? null,
    };
  }

  /**
   * BL-912: which Primary sections are at rest: the form equals what it last loaded or saved, and
   * no save of the section is queued or on its way (its savers in `basicSaves` and the others). A
   * section that has not loaded (a null persisted signature) is not at rest; the zip section is
   * compared the way its own effect decides to save (`diffZipPayload`), because the global custom
   * tool sync can reorder its signature without anything to send. The prompt and the CLI tools
   * list have no form of their own to differ, so their savers decide. Plain reads, never in an
   * effect.
   */
  function agentSectionsAtRest() {
    const zipChanges = zipPersistedPayload
      ? diffZipPayload(zipPersistedPayload, buildZipPayload(zipForm))
      : null;
    return {
      basic:
        basicPersistedSignature !== null &&
        makeBasicSignature(basicForm) === basicPersistedSignature &&
        !basicSaves.busy(selectedAgentId ?? ""),
      prompt:
        promptPersistedSignature !== null &&
        promptValue === promptPersistedSignature &&
        !promptSaves.busy(selectedAgentId ?? ""),
      zip: zipChanges !== null && Object.keys(zipChanges).length === 0 && !zipSaves.busy(selectedAgentId ?? ""),
      toolGrid:
        mcpPersistedSignature !== null &&
        makeMcpSignature(defaultMCPGateways, defaultMCPToolSelections, dcmDisplaySettings) ===
          mcpPersistedSignature &&
        !mcpSaves.busy(selectedAgentId ?? "") &&
        !cliToolSaves.busy(selectedAgentId ?? ""),
      codex:
        codexPersistedSignature !== null &&
        makeCodexSignature(codexForm, "agent") === codexPersistedSignature &&
        !codexSaves.busy(selectedAgentId ?? ""),
      claude:
        claudePersistedSignature !== null &&
        makeClaudeSignature(claudeForm) === claudePersistedSignature &&
        !claudeSaves.busy(selectedAgentId ?? ""),
      assignment:
        assignmentPersistedSignature !== null &&
        makeSubagentSignature(selectedSubagentIds) === assignmentPersistedSignature &&
        !assignmentSaves.busy(selectedAgentId ?? ""),
    };
  }

  let stopAgentSettingsEvents: () => void = () => {};
  const listedAgentReads = new Map<string, number>();

  /**
   * SA-122 A-1y (BL-1294, LS-067/LS-068): a read of the shown agent while its basic section holds an
   * edit with no save queued or on its way. The section keeps the edit (BL-942); only the fields the
   * agent's own Settings save can change, the name and the memory settings (one saved group), take
   * the record's values leaf by leaf (`rebaseAgentWritableFields`): an untouched leaf in the form and
   * the baseline, an edited leaf in the baseline only, so the next save carries the edit on top of the
   * record's values. `conflictBase` is the baseline of a refused memory save (Ashe's refinement e);
   * without one, the form's baseline. Answers whether a refused save could not be recovered: the
   * record reads the same as its baseline, so the two disagree on what is saved, and nothing is sent
   * again (the loop guard: the caller shows Retry).
   */
  function rebaseBusyBasicSection(agent: AgentRow, conflictBase: BasicForm | null): boolean {
    const current = $state.snapshot(basicPersistedForm) as BasicForm;
    const result = rebaseAgentWritableFields(
      $state.snapshot(basicForm) as BasicForm,
      conflictBase ?? current,
      normaliseBasicForm(agent),
      current,
    );
    if (!result.baseChanged) return conflictBase !== null;
    basicForm = result.draft;
    basicPersistedForm = result.base;
    basicPersistedSignature = makeBasicSignature(result.base);
    lastInvalidAgentSignature = null;
    const labels = agentWritableConflictLabels(result.conflicts);
    if (labels.length > 0) {
      toast.warning(`Your agent changed ${labels.join(", ")} while you were editing. Batshit kept your value.`);
    }
    return false;
  }

  /**
   * SA-122 A-1y (LS-067/LS-068): the agent saved its own Settings (App Actions), heard on the user
   * channel. No tab made that save, so this panel reads the agent again. The shown agent: the
   * BL-912 read (now when the panel is at rest, else when it comes to rest; a busy basic section
   * takes the agent's name and memory settings leaf by leaf in `hydrateAgent`). Another listed agent:
   * its list entry. `reconnected`: an event may have been missed while the connection was down.
   */
  function handleAgentSettingsEvent(event: UserChannelEvent) {
    if (!settingsPanelAlive) return;
    // The selected agent, loaded or still loading: `readAgentAgainWhenAtRest` replaces a first read
    // that is still on its way (its answer may predate the agent's save) and waits for rest otherwise.
    const shownAgentId = selectedEntity?.kind === "agent" ? selectedAgentId : null;
    const readShownAgent = () =>
      untrack(() => {
        setAgentReadDeferred(true);
        readAgentAgainWhenAtRest();
      });
    if (event.type === "reconnected") {
      if (shownAgentId !== null) readShownAgent();
      return;
    }
    if (event.type !== "agent_settings_changed" || typeof event.agentId !== "string") return;
    if (shownAgentId !== null && event.agentId === shownAgentId) readShownAgent();
    else if (agents.some((agent) => agent.id === event.agentId)) void refreshListedAgent(event.agentId);
  }

  /** A-1y: a listed agent that is not shown, read again for its list entry (the picker's name). */
  async function refreshListedAgent(agentId: string) {
    const generation = (listedAgentReads.get(agentId) ?? 0) + 1;
    listedAgentReads.set(agentId, generation);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const agent = (await response.json()) as AgentRow;
      if (!settingsPanelAlive || listedAgentReads.get(agentId) !== generation || agent?.id !== agentId) return;
      untrack(() => {
        agents = agents.map((existing) => (existing.id === agentId ? agent : existing));
      });
    } catch (error) {
      console.warn(`[AgentSettingsPanel] Could not read agent ${agentId} again after it changed its own settings:`, error);
    }
  }

  /**
   * BL-912: the read that a landing, or a read that left a section alone, asked for. It runs when
   * every section is at rest (a settled save calls this), for the agent shown then, and obeys the
   * at-rest rule of `hydrateAgent` when it comes back. A read that fills every section and is still
   * on its way is simply replaced by it. The read also wipes a failed Subagent save's error line,
   * so it waits for that too.
   */
  function readAgentAgainWhenAtRest() {
    if (!settingsPanelAlive) return;
    const agentId = selectedAgentId;
    if (!agentReadDeferred || !agentId || selectedEntity?.kind !== "agent" || selectedEntity.id !== agentId) return;
    const filling = hydrationInProgress && hydratedAgentId !== agentId;
    if (!filling) {
      if (hydratedAgentId !== agentId || subagentEditSaveError !== null) return;
      if (!Object.values(agentSectionsAtRest()).every(Boolean)) return;
    }
    void hydrateAgent(agentId);
  }

  /**
   * BL-912: how a Primary save lands. "current": the panel shows the agent and no read replaced its
   * forms since the payload was built (`hydrationGeneration` is `agentHydrationRequestId` then); the
   * landing moves the baseline as it always did. "older": a read came between and may have put an
   * older record into the form and the baseline, and a baseline moved under that form would make
   * the section's effect send the older value back, so the landing moves nothing of the form, the
   * baseline or the signature, puts its save state back to idle and asks for a read at rest.
   * "other": another agent is shown; the landing touches nothing of it.
   *
   * A "current" landing while a read is still on its way (a prompt, multiline editor or CLI tools
   * save is built while a read travels, so it carries the newer counter) also asks for a read: that
   * read may have read the record before this save wrote it, and its answer would put the older
   * record over the saved section. The new read starts after this write; when every section is at
   * rest at the settle it supersedes the older one, otherwise the older answer can still cover the
   * saved section until the next read (an open condition, listed in settings-panel.md).
   */
  type SaveLanding = "current" | "older" | "other";
  function agentLanding(agentId: string, hydrationGeneration: number): SaveLanding {
    if (selectedAgentId !== agentId) return "other";
    if (hydrationGeneration === agentHydrationRequestId) {
      if (hydrationInProgress) setAgentReadDeferred(true);
      return "current";
    }
    setAgentReadDeferred(true);
    return "older";
  }

  /**
   * SA-122 A-1y (BL-1294): a save that names a memory setting says which saved values it started
   * from: the baseline its body was worked out from, written the way the save writes them. The
   * server refuses it (409 `memory_settings_changed`) when the saved ones changed meanwhile.
   */
  function basicRequestBody(body: Partial<BasicPayloadBody>, baseForm: BasicForm): Record<string, unknown> {
    return AGENT_MEMORY_GROUP.some((field) => field in body)
      ? { ...body, expectedMemory: buildAgentMemoryRecordFields(baseForm.memory_settings) }
      : body;
  }

  class MemorySettingsChangedError extends Error {}

  /**
   * A-1y (BL-1294, Ashe's refinement b): the server refused this memory save. The first time for
   * this edit, read the agent once the save has settled and rebase from the save's own baseline
   * (`hydrateAgent`): the section's effect then sends the edit once more. A second refusal shows
   * the existing Retry, which reads the record and keeps the edits; never a loop.
   */
  function recoverRefusedMemorySave(payload: { id: string; baseForm: BasicForm }) {
    if (!settingsPanelAlive || selectedEntity?.kind !== "agent" || selectedAgentId !== payload.id) {
      // The user left this agent (another one is shown, or Settings closed) before its queued save
      // went out. Nothing was saved, and no form is left to rebase: say so, never silently.
      const name = agents.find((agent) => agent.id === payload.id)?.displayName || "an agent";
      toast.error(
        `Your memory change to ${name} was not saved, because the agent changed its memory settings meanwhile. Open it in Settings and try again.`,
      );
      return;
    }
    memoryConflictBase = { agentId: payload.id, base: payload.baseForm };
    basicSaveState = "idle";
    if (memoryConflictResendUsed) {
      primaryReadWaitError = MEMORY_CONFLICT_RETRY_MESSAGE;
      return;
    }
    memoryConflictResendUsed = true;
    // After this save has settled: the read rebases only a section with no save queued or on its way.
    setTimeout(() => {
      if (settingsPanelAlive && selectedEntity?.kind === "agent" && selectedAgentId === payload.id) {
        void hydrateAgent(payload.id);
      }
    }, 0);
  }

  /**
   * `savedForm` is the form snapshot a basic save (the autosave, the multiline editors) built its
   * body from: when the save lands it becomes the new baseline (`basicPersistedForm`, BL-514) and
   * the persisted signature follows it (BL-911, the way BL-844 does it for the Subagent form). The
   * LIVE form is left alone: whatever was typed while the save was in flight is still in it, and
   * the next autosave sends just that (the baseline is the saved snapshot). `applyToLive` is for a
   * save whose change is not in the live form yet (the multiline editors change the form only when
   * their save works): it is laid over the live form as the save lands. A failed save changes
   * nothing: the baseline stays as it was, so the next edit sends this change again.
   *
   * `payload.hydrationGeneration` is `agentHydrationRequestId` when the body was built: a landing
   * after a newer read touches neither the form nor the baseline and asks for a read at rest
   * (`agentLanding`, BL-912). `payload.baseForm` is the baseline the body was worked out from
   * (A-1y): a memory save carries it as `expectedMemory`, and a refused one rebases from it.
   */
  async function persistBasic(
    payload: { id: string; body: Partial<BasicPayloadBody>; hydrationGeneration: number; baseForm: BasicForm },
    savedForm: BasicForm,
    applyToLive?: (form: BasicForm) => BasicForm,
  ) {
    const stored = agents.find((agent) => agent.id === payload.id);
    const previousAvatar = stored?.avatar ?? stored?.avatar_url ?? null;
    try {
      const response = await fetch(`/api/agents/${payload.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basicRequestBody(payload.body, payload.baseForm)),
      });

      if (!response.ok) {
        if (response.status === 409) {
          const answer = await response.clone().json().catch(() => null);
          if (answer?.code === "memory_settings_changed") {
            throw new MemorySettingsChangedError(
              "This agent's memory settings changed while you were editing them, so nothing was saved. Batshit reads them again and keeps your edits.",
            );
          }
        }
        const message = await extractError(
          response,
          "Failed to save agent settings",
        );
        throw new Error(message);
      }

      untrack(() => {
        const landing = agentLanding(payload.id, payload.hydrationGeneration);
        if (landing === "current") {
          memoryConflictResendUsed = false;
          if (applyToLive) basicForm = applyToLive(basicForm);
          basicPersistedSignature = makeBasicSignature(savedForm);
          basicPersistedForm = $state.snapshot(savedForm) as BasicForm;
          lastInvalidAgentSignature = null;
          basicSaveState = "saved";
          basicSaveError = null;
          basicLastSaved = new Date();
        } else if (landing === "older") {
          basicSaveState = "idle";
        }
        // BL-514: the body holds only what this save changed; a field it left out keeps its value.
        updateAgentCollections(payload.id, {
          ...payload.body,
          ...("primary_model_name" in payload.body
            ? { model: payload.body.primary_model_name }
            : {}),
        } as Partial<AgentRow>);
      });
      // BL-142: the save changed the picture, so the pictures the agent no longer shows go.
      if (
        "avatar_url" in payload.body &&
        shouldTidyAvatarPictures({
          previous: previousAvatar,
          saved: payload.body.avatar_url,
          current: selectedAgentId === payload.id ? basicForm.avatar_url : payload.body.avatar_url,
          uploading: selectedAgentId === payload.id && isUploadingAgentAvatar,
        })
      ) {
        void requestAvatarPictureTidy("agent", payload.id, previousAvatar);
      }
    } catch (error) {
      console.error("Failed to save agent settings:", error);
      untrack(() => {
        if (error instanceof MemorySettingsChangedError) {
          recoverRefusedMemorySave(payload);
        } else if (selectedAgentId === payload.id) {
          basicSaveState = "idle";
          basicSaveError =
            error instanceof Error ? error.message : "Failed to save agent";
        }
      });
      throw error;
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (basicSaveState === "saved") {
            basicSaveState = "idle";
          }
        });
      }, 2000);
    }
  }

  const saveBasic = basicSaves.debounce(
    (payload: {
      id: string;
      body: Partial<BasicPayloadBody>;
      nextForm: BasicForm;
      hydrationGeneration: number;
      baseForm: BasicForm;
    }) => persistBasic(payload, payload.nextForm),
    BASIC_SAVE_DEBOUNCE_MS,
  );

  async function persistPrompt(
    payload: { id: string; system_prompt: string; hydrationGeneration: number },
    nextPrompt: string = promptValue,
  ) {
    try {
      const response = await fetch(`/api/agents/${payload.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: payload.system_prompt }),
      });

      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to save system prompt",
        );
        throw new Error(message);
      }

      untrack(() => {
        // The prompt has no form of its own to differ from a baseline and no effect that saves it
        // (only the editor's Save does), so nothing can send an older prompt back and an older
        // landing moves it as it always did; only another agent's landing leaves it alone.
        if (agentLanding(payload.id, payload.hydrationGeneration) !== "other") {
          promptValue = nextPrompt;
          promptPersistedSignature = nextPrompt;
        }
        updateAgentCollections(payload.id, {
          system_prompt: payload.system_prompt,
        });
      });
    } catch (error) {
      console.error("Failed to save prompt:", error);
      throw error instanceof Error
        ? error
        : new Error("Failed to save system prompt");
    }
  }

  const saveZipSettings = zipSaves.debounce(
    async (payload: {
      id: string;
      body: Partial<ZipPayloadBody>;
      signature: string;
      /** The whole payload the body was worked out from: the baseline once the save lands. */
      full: ZipPayloadBody;
      hydrationGeneration: number;
    }) => {
      try {
        const response = await fetch(`/api/agents/${payload.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload.body),
        });

        if (!response.ok) {
          const message = await extractError(
            response,
            "Failed to save zip overrides",
          );
          throw new Error(message);
        }

        untrack(() => {
          const landing = agentLanding(payload.id, payload.hydrationGeneration);
          if (landing === "current") {
            zipPersistedSignature = payload.signature;
            zipPersistedPayload = zipPayloadForSave(payload.full);
            zipSaveState = "saved";
            zipSaveError = null;
            zipLastSaved = new Date();
          } else if (landing === "older") {
            zipSaveState = "idle";
          }
          updateAgentCollections(
            payload.id,
            zipPayloadToAgentUpdates(payload.body),
          );
        });
      } catch (error) {
        console.error("Failed to save zip overrides:", error);
        untrack(() => {
          if (selectedAgentId === payload.id) {
            zipSaveState = "idle";
            zipSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save zip overrides";
          }
        });
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (zipSaveState === "saved") {
              zipSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    ZIP_SAVE_DEBOUNCE_MS,
  );

  const saveMcpSettings = mcpSaves.debounce(
    async (payload: {
      id: string;
      body: McpSectionSave;
      signature: string;
      /** The values the body was worked out from: the baseline once the save lands. */
      values: McpSectionValues;
      hydrationGeneration: number;
    }) => {
      try {
        const response = await fetch(`/api/agents/${payload.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload.body),
        });

        if (!response.ok) {
          const message = await extractError(
            response,
            "Failed to save default MCP settings",
          );
          throw new Error(message);
        }

        untrack(() => {
          const landing = agentLanding(payload.id, payload.hydrationGeneration);
          if (landing === "current") {
            mcpPersistedSignature = payload.signature;
            mcpPersistedValues = payload.values;
            mcpSaveState = "saved";
            mcpSaveError = null;
            mcpLastSaved = new Date();
          } else if (landing === "older") {
            mcpSaveState = "idle";
          }
          // BL-855: the body names only what changed; each copy takes it the way the server does.
          updateAgentCollections(payload.id, payload.body);
        });
      } catch (error) {
        console.error("Failed to save default MCP settings:", error);
        untrack(() => {
          if (selectedAgentId === payload.id) {
            mcpSaveState = "idle";
            mcpSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save MCP defaults";
          }
        });
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (mcpSaveState === "saved") {
              mcpSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    MCP_SAVE_DEBOUNCE_MS,
  );

  const saveCliToolSettings = cliToolSaves.debounce(
    async (payload: {
      id: string;
      body: { defaultTools: string[] | null };
      hydrationGeneration: number;
    }) => {
      try {
        const response = await fetch(`/api/agents/${payload.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload.body),
        });

        if (!response.ok) {
          const message = await extractError(
            response,
            "Failed to save CLI tool selections",
          );
          throw new Error(message);
        }

        untrack(() => {
          const landing = agentLanding(payload.id, payload.hydrationGeneration);
          if (landing === "current") {
            mcpSaveState = "saved";
            mcpSaveError = null;
            mcpLastSaved = new Date();
          } else if (landing === "older") {
            mcpSaveState = "idle";
          }
          updateAgentCollections(payload.id, {
            defaultTools: payload.body.defaultTools ?? undefined,
          });
        });
      } catch (error) {
        console.error("Failed to save CLI tool selections:", error);
        untrack(() => {
          if (selectedAgentId === payload.id) {
            mcpSaveState = "idle";
            mcpSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save CLI tool selections";
          }
        });
        if (selectedAgentId === payload.id) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to save CLI tool selections",
          );
        }
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (mcpSaveState === "saved") {
              mcpSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    MCP_SAVE_DEBOUNCE_MS,
  );

  const saveSubagentMcpSettings = subagentMcpSaves.debounce(
    async (payload: {
      id: string;
      body: McpSectionSave;
      signature: string;
      /** The values the body was worked out from: the baseline once the save lands. */
      values: McpSectionValues;
      readGeneration: number;
    }) => {
      try {
        const landing = await persistSubagentDetails({
          id: payload.id,
          body: payload.body,
          readGeneration: payload.readGeneration,
        });
        untrack(() => {
          // Only the Subagent the panel still shows, and only when no read came between: a save
          // that lands after another Subagent was picked, or after a newer read, moves nothing.
          if (landing === "current") {
            subagentMcpPersistedSignature = payload.signature;
            subagentMcpPersistedValues = payload.values;
          }
        });
      } catch (error) {
        console.error("Failed to save subagent MCP settings:", error);
      }
    },
    MCP_SAVE_DEBOUNCE_MS,
  );

  const saveSubagentCliToolSettings = subagentCliToolSaves.debounce(
    async (payload: {
      id: string;
      body: { defaultTools: string[] | null };
      readGeneration: number;
    }) => {
      try {
        await persistSubagentDetails(payload);
      } catch (error) {
        console.error("Failed to save subagent CLI tool selections:", error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to save subagent CLI tool selections",
        );
      }
    },
    MCP_SAVE_DEBOUNCE_MS,
  );

  const saveCodexSettings = codexSaves.debounce(
    async (payload: {
      id: string;
      body: { codex_settings: NonNullable<AgentBlockSaveByField["codex_settings"]> };
      signature: string;
      /** The whole block the body was worked out from: the baseline once the save lands. */
      block: CodexAgentSettings;
      hydrationGeneration: number;
    }) => {
      try {
        const response = await fetch(`/api/agents/${payload.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload.body),
        });

        if (!response.ok) {
          const message = await extractError(
            response,
            "Failed to save Codex settings",
          );
          throw new Error(message);
        }

        untrack(() => {
          const landing = agentLanding(payload.id, payload.hydrationGeneration);
          if (landing === "current") {
            codexPersistedSignature = payload.signature;
            codexPersistedBlock = payload.block;
            codexSaveState = "saved";
            codexSaveError = null;
            codexLastSaved = new Date();
          } else if (landing === "older") {
            codexSaveState = "idle";
          }
          updateAgentCollections(payload.id, {
            codex_settings: payload.body.codex_settings,
          });
        });
      } catch (error) {
        console.error("Failed to save Codex settings:", error);
        untrack(() => {
          if (selectedAgentId === payload.id) {
            codexSaveState = "idle";
            codexSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save Codex settings";
          }
        });
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (codexSaveState === "saved") {
              codexSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    CODEX_SAVE_DEBOUNCE_MS,
  );

  const saveClaudeSettings = claudeSaves.debounce(
    async (payload: {
      id: string;
      body: { claude_settings: NonNullable<AgentBlockSaveByField["claude_settings"]> };
      signature: string;
      /** The whole block the body was worked out from: the baseline once the save lands. */
      block: ClaudeAgentSettings;
      hydrationGeneration: number;
    }) => {
      try {
        const response = await fetch(`/api/agents/${payload.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload.body),
        });

        if (!response.ok) {
          const message = await extractError(
            response,
            "Failed to save Claude settings",
          );
          throw new Error(message);
        }

        untrack(() => {
          const landing = agentLanding(payload.id, payload.hydrationGeneration);
          if (landing === "current") {
            claudePersistedSignature = payload.signature;
            claudePersistedBlock = payload.block;
            claudeSaveState = "saved";
            claudeSaveError = null;
            claudeLastSaved = new Date();
          } else if (landing === "older") {
            claudeSaveState = "idle";
          }
          updateAgentCollections(payload.id, {
            claude_settings: payload.body.claude_settings,
          });
        });
      } catch (error) {
        console.error("Failed to save Claude settings:", error);
        untrack(() => {
          if (selectedAgentId === payload.id) {
            claudeSaveState = "idle";
            claudeSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save Claude settings";
          }
        });
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (claudeSaveState === "saved") {
              claudeSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    CLAUDE_SAVE_DEBOUNCE_MS,
  );

  const saveSubagentCodexSettings = subagentCodexSaves.debounce(
    async (payload: {
      id: string;
      body: { codex_settings: NonNullable<AgentBlockSaveByField["codex_settings"]> };
      signature: string;
      /** The whole block the body was worked out from: the baseline once the save lands. */
      block: CodexAgentSettings;
      readGeneration: number;
    }) => {
      try {
        const landing = await persistSubagentDetails({
          id: payload.id,
          body: payload.body,
          readGeneration: payload.readGeneration,
        });
        untrack(() => {
          // The Primary Agent's rule (`agentLanding`).
          if (landing === "current") {
            subagentCodexPersistedSignature = payload.signature;
            subagentCodexPersistedBlock = payload.block;
            subagentCodexSaveState = "saved";
            subagentCodexSaveError = null;
            subagentCodexLastSaved = new Date();
          } else if (landing === "older") {
            subagentCodexSaveState = "idle";
          }
        });
      } catch (error) {
        console.error("Failed to save subagent Codex settings:", error);
        untrack(() => {
          if (selectedEditableSubagentId === payload.id) {
            subagentCodexSaveState = "idle";
            subagentCodexSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save subagent Codex settings";
          }
        });
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (subagentCodexSaveState === "saved") {
              subagentCodexSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    CODEX_SAVE_DEBOUNCE_MS,
  );

  const saveSubagentClaudeSettings = subagentClaudeSaves.debounce(
    async (payload: {
      id: string;
      body: { claude_settings: NonNullable<AgentBlockSaveByField["claude_settings"]> };
      signature: string;
      /** The whole block the body was worked out from: the baseline once the save lands. */
      block: ClaudeAgentSettings;
      readGeneration: number;
    }) => {
      try {
        const landing = await persistSubagentDetails({
          id: payload.id,
          body: payload.body,
          readGeneration: payload.readGeneration,
        });
        untrack(() => {
          // The Primary Agent's rule (`agentLanding`).
          if (landing === "current") {
            subagentClaudePersistedSignature = payload.signature;
            subagentClaudePersistedBlock = payload.block;
            subagentClaudeSaveState = "saved";
            subagentClaudeSaveError = null;
            subagentClaudeLastSaved = new Date();
          } else if (landing === "older") {
            subagentClaudeSaveState = "idle";
          }
        });
      } catch (error) {
        console.error("Failed to save subagent Claude settings:", error);
        untrack(() => {
          if (selectedEditableSubagentId === payload.id) {
            subagentClaudeSaveState = "idle";
            subagentClaudeSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save subagent Claude settings";
          }
        });
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (subagentClaudeSaveState === "saved") {
              subagentClaudeSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    CLAUDE_SAVE_DEBOUNCE_MS,
  );

  const saveSubagentAssignments = assignmentSaves.debounce(
    async (payload: {
      id: string;
      subagentIds: string[];
      signature: string;
      hydrationGeneration: number;
    }) => {
      try {
        await subagentStore.updateAgentSubagents(
          payload.id,
          payload.subagentIds,
        );
        untrack(() => {
          const landing = agentLanding(payload.id, payload.hydrationGeneration);
          if (landing === "current") {
            assignmentPersistedSignature = payload.signature;
            assignmentSaveState = "saved";
            assignmentSaveError = null;
            assignmentLastSaved = new Date();
          } else if (landing === "older") {
            assignmentSaveState = "idle";
          }
          updateAgentCollections(payload.id, {
            assigned_subagent_ids: payload.subagentIds,
          });
        });
      } catch (error) {
        console.error("Failed to save subagent assignments:", error);
        untrack(() => {
          if (selectedAgentId === payload.id) {
            assignmentSaveState = "idle";
            assignmentSaveError =
              error instanceof Error
                ? error.message
                : "Failed to update subagents";
          }
        });
      } finally {
        setTimeout(() => {
          untrack(() => {
            if (assignmentSaveState === "saved") {
              assignmentSaveState = "idle";
            }
          });
        }, 2000);
      }
    },
    SUBAGENT_SAVE_DEBOUNCE_MS,
  );

  /**
   * Whether the Subagent's core form holds an edit that is not saved: waiting in its autosave
   * debounce, in flight, or failed. The form differs from the persisted signature exactly then
   * (only a core save moves that signature). Read untracked, so an effect that asks does not
   * start depending on the form.
   */
  function subagentCoreEditUnsaved(): boolean {
    return untrack(
      () =>
        selectedEditableSubagentId !== null &&
        subagentPersistedSignature !== null &&
        makeSubagentFormSignature(subagentForm) !== subagentPersistedSignature,
    );
  }

  /**
   * BL-955: which Subagent sections are at rest, the Primary Agent's rule
   * (`agentSectionsAtRest`): the form equals its baseline and no save of it is queued or on its
   * way. The CLI tools list has no baseline, so its saver decides with the Tool Grid's.
   */
  function subagentSectionsAtRest() {
    return {
      core:
        subagentPersistedSignature !== null &&
        makeSubagentFormSignature(subagentForm) === subagentPersistedSignature &&
        !subagentCoreSaves.busy(selectedEditableSubagentId ?? ""),
      toolGrid:
        subagentMcpPersistedSignature !== null &&
        makeMcpSignature(
          subagentDefaultMCPGateways,
          subagentDefaultMCPToolSelections,
          subagentDcmDisplaySettings,
        ) === subagentMcpPersistedSignature &&
        !subagentMcpSaves.busy(selectedEditableSubagentId ?? "") &&
        !subagentCliToolSaves.busy(selectedEditableSubagentId ?? ""),
      codex:
        subagentCodexPersistedSignature !== null &&
        makeCodexSignature(subagentCodexForm, "subagent") === subagentCodexPersistedSignature &&
        !subagentCodexSaves.busy(selectedEditableSubagentId ?? ""),
      claude:
        subagentClaudePersistedSignature !== null &&
        makeClaudeSignature(subagentClaudeForm) === subagentClaudePersistedSignature &&
        !subagentClaudeSaves.busy(selectedEditableSubagentId ?? ""),
    };
  }

  /**
   * BL-955: the Subagent's deferred read, the Primary Agent's rule (`readAgentAgainWhenAtRest`):
   * when every section is at rest, the shown Subagent is read again through its real GET route.
   */
  function readSubagentAgainWhenAtRest() {
    if (!settingsPanelAlive || subagentDetailLoading) return;
    const id = selectedEditableSubagentId;
    if (!subagentReadDeferred || !id || selectedEntity?.kind !== "subagent" || selectedEntity.id !== id) return;
    if (!Object.values(subagentSectionsAtRest()).every(Boolean)) return;
    void hydrateSubagent(id);
  }

  /** BL-955: how a Subagent save lands, the Primary Agent's rule (`agentLanding`). */
  function subagentLanding(id: string, readGeneration: number): SaveLanding {
    if (selectedEditableSubagentId !== id) return "other";
    if (readGeneration === subagentReadGeneration) return "current";
    setSubagentReadDeferred(true);
    return "older";
  }

  /**
   * `savedForm` is the form a core save (the autosave, the multiline editors) built its body
   * from: when the save lands it becomes the new baseline (BL-844), and the persisted signature
   * follows it. The LIVE form is left alone: whatever was typed while the save was in flight is
   * still in it, and the next autosave sends just that (the baseline is the saved snapshot).
   * `applyToLive` is for a save whose change is not in the live form yet (the multiline editors
   * change the form only when their save works): it is laid over the live form as the save lands.
   *
   * The saves of the other sections (the Tool Settings Grid, CLI tools, Codex, Claude) name no
   * form and leave the baseline AND the persisted signature alone: they save none of the core
   * fields, so a core edit that is unsaved (waiting in its debounce, in flight, or failed) stays
   * a difference from the baseline, the store-refresh effect can tell it is unsaved, and the
   * next core edit sends it. The save error and the "Saved" status belong to the core edit while
   * one is unsaved, so none of the four sections touches them then: not when it starts (the Tool
   * Settings Grid and CLI tools clear the error only when no core edit is unsaved; Codex and
   * Claude clear only their own error) and not when it lands (no "Saved", no cleared error). The
   * error of a failed core save stays on screen until a core save works.
   */
  async function persistSubagentDetails(
    payload: { id: string; body: LiveSubagentUpdate; readGeneration: number },
    savedForm?: SubagentForm,
    applyToLive?: (form: SubagentForm) => SubagentForm,
  ): Promise<SaveLanding> {
    const previousAvatar = subagents.find((subagent) => subagent.id === payload.id)?.avatar ?? null;
    try {
      await subagentStore.update(payload.id, payload.body);
      const landing = untrack(() => {
        // Only the Subagent the panel still shows, and only when no read replaced its forms since
        // the payload was built (`subagentLanding`, BL-955): otherwise the landing moves nothing.
        const kind = subagentLanding(payload.id, payload.readGeneration);
        // A save of another section says nothing about a core edit that is still unsaved: it
        // neither reads "Saved" beside that text nor hides the error of a failed core save.
        const coreEditUnsaved = !savedForm && kind !== "other" && subagentCoreEditUnsaved();
        if (kind === "current") {
          if (savedForm) {
            if (applyToLive) subagentForm = applyToLive(subagentForm);
            subagentPersistedSignature = makeSubagentFormSignature(savedForm);
            subagentPersistedForm = $state.snapshot(savedForm) as SubagentForm;
            lastInvalidSubagentSignature = null;
          }
          if (!coreEditUnsaved) {
            subagentEditSaveState = "saved";
            subagentEditSaveError = null;
          }
          subagentEditLastSaved = new Date();
        } else if (kind === "older" && !coreEditUnsaved) {
          subagentEditSaveState = "idle";
        }
        return kind;
      });
      // BL-142: the save changed the picture, so the pictures the Subagent no longer shows go.
      if (
        Object.prototype.hasOwnProperty.call(payload.body, "avatar") &&
        shouldTidyAvatarPictures({
          previous: previousAvatar,
          saved: payload.body.avatar,
          current: selectedEditableSubagentId === payload.id ? subagentForm.avatar : payload.body.avatar,
          uploading: selectedEditableSubagentId === payload.id && subagentAvatarUploading,
        })
      ) {
        void requestAvatarPictureTidy("subagent", payload.id, previousAvatar);
      }
      return landing;
    } catch (error) {
      console.error("Failed to save subagent:", error);
      untrack(() => {
        if (selectedEntity?.kind !== "subagent" || selectedEditableSubagentId !== payload.id) return;
        subagentEditSaveState = "idle";
        subagentEditSaveError =
          error instanceof Error ? error.message : "Failed to save subagent";
      });
      throw error;
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (subagentEditSaveState === "saved") {
            subagentEditSaveState = "idle";
          }
        });
      }, 2000);
    }
  }

  const saveSubagentDetails = subagentCoreSaves.debounce(
    async (payload: {
      id: string;
      body: LiveSubagentUpdate;
      nextForm: SubagentForm;
      readGeneration: number;
    }) => {
      try {
        await persistSubagentDetails(
          { id: payload.id, body: payload.body, readGeneration: payload.readGeneration },
          payload.nextForm,
        );
      } catch {
        // `persistSubagentDetails` logged the failure and set `subagentEditSaveError`, which the
        // panel shows; the baseline stays as it was, so the next edit sends this change again.
      }
    },
    700,
  );

  $effect(() => {
    primaryCaptureWake.basic;
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    const signature = makeBasicSignature(basicForm);
    if (
      !basicPersistedSignature ||
      !basicPersistedForm ||
      signature === basicPersistedSignature ||
      signature === lastInvalidAgentSignature
    ) {
      return;
    }

    const validation = validateBasicForm(basicForm);
    basicValidationError = validation;

    if (validation) {
      lastInvalidAgentSignature = signature;
      basicSaveState = "idle";
      return;
    }

    lastInvalidAgentSignature = null;
    // A snapshot: it is the baseline when this save lands, so a nested list or object the user
    // changes while the save is in flight must not reach it (BL-911).
    const nextForm = $state.snapshot(cloneBasicForm(basicForm)) as BasicForm;
    // A-1y: the baseline the body is worked out from; a memory save says it started from it.
    const baseForm = $state.snapshot(basicPersistedForm) as BasicForm;
    const body = buildBasicSavePatch(nextForm);
    if (patchContainsGroupedValues(body, "agent") && deferPrimaryCapture("basic")) return;
    // A form that differs from the saved copy only in ways the save does not see (a reordered
    // block) has nothing to send.
    if (Object.keys(body).length === 0) return;

    basicSaveState = "saving";
    basicSaveError = null;
    saveBasic({
      id: selectedAgentId,
      body,
      nextForm,
      // Read when the body is built: a re-read of the agent during the debounce or the round trip
      // is what `persistBasic` checks at the landing (BL-911).
      hydrationGeneration: agentHydrationRequestId,
      baseForm,
    });
  });

  $effect(() => {
    primaryCaptureWake.codex;
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    if (!isCodexProvider) return;
    const signature = makeCodexSignature(codexForm, "agent");
    if (!codexPersistedSignature || signature === codexPersistedSignature) return;
    // BL-848: only the keys that differ from the block as it loaded or was last saved, a key the
    // form dropped as `null`; a form that differs only in ways the save does not see sends nothing.
    // BL-919: the permission trio (mode, sandbox, approval) is one choice: a change to any of its
    // keys sends all three, so an older copy never leaves a mix with another window's mode.
    const block = serializeCodexForm(codexForm, "agent");
    const change = diffAgentBlockWithGroups("codex_settings", codexPersistedBlock, block);
    if (change == null) return;
    if (deferPrimaryCapture("codex")) return;
    codexSaveState = "saving";
    codexSaveError = null;
    saveCodexSettings({
      id: selectedAgentId,
      body: { codex_settings: change },
      signature,
      block,
      hydrationGeneration: agentHydrationRequestId,
    });
  });

  $effect(() => {
    primaryCaptureWake.claude;
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    if (!isClaudeCliProvider) return;
    const signature = makeClaudeSignature(claudeForm);
    if (!claudePersistedSignature || signature === claudePersistedSignature) return;
    // BL-848, BL-919: as the Codex section above; the thinking switch and its budget are one pair.
    const block = serializeClaudeForm(claudeForm);
    const change = diffAgentBlockWithGroups("claude_settings", claudePersistedBlock, block);
    if (change == null) return;
    if (deferPrimaryCapture("claude")) return;
    claudeSaveState = "saving";
    claudeSaveError = null;
    saveClaudeSettings({
      id: selectedAgentId,
      body: { claude_settings: change },
      signature,
      block,
      hydrationGeneration: agentHydrationRequestId,
    });
  });

  $effect(() => {
    subagentCaptureWake.codex;
    if (
      !selectedEditableSubagentId ||
      subagentDetailLoading ||
      subagentsLoading ||
      hydrationInProgress
    ) {
      return;
    }
    if (!(subagentForm.subagentType === "cli" && isCodexCliSubagentProvider)) return;
    const signature = makeCodexSignature(subagentCodexForm, "subagent");
    // A null signature is a Subagent that is not hydrated yet: nothing is saved from it.
    if (subagentCodexPersistedSignature === null || signature === subagentCodexPersistedSignature) return;
    // BL-914: the Subagent PUT writes `codex_settings` key by key, so only the keys that differ
    // from the block as it loaded or was last saved go, a key the form dropped as `null`; a
    // Subagent with no block yet gets the whole block. BL-919: the permission trio is one choice
    // and goes whole when any of its keys changed. A Subagent has no Tool Approval tie (CLI
    // Subagents never pause for approval), so `serializeCodexForm(..., "subagent")` always gives
    // approval `never`, and the trio always carries it.
    const block = serializeCodexForm(subagentCodexForm, "subagent");
    const change = diffAgentBlockWithGroups("codex_settings", subagentCodexPersistedBlock, block);
    if (change == null) return;
    if (deferSubagentCapture("codex")) return;
    subagentCodexSaveState = "saving";
    subagentCodexSaveError = null;
    saveSubagentCodexSettings({
      id: selectedEditableSubagentId,
      body: { codex_settings: change },
      signature,
      block,
      readGeneration: subagentReadGeneration,
    });
  });

  $effect(() => {
    subagentCaptureWake.claude;
    if (
      !selectedEditableSubagentId ||
      subagentDetailLoading ||
      subagentsLoading ||
      hydrationInProgress
    ) {
      return;
    }
    if (!(subagentForm.subagentType === "cli" && isClaudeCliSubagentProvider)) return;
    const signature = makeClaudeSignature(subagentClaudeForm);
    if (subagentClaudePersistedSignature === null || signature === subagentClaudePersistedSignature) return;
    // BL-914, BL-919: as the Codex section above; the thinking switch and its budget are one pair.
    const block = serializeClaudeForm(subagentClaudeForm);
    const change = diffAgentBlockWithGroups("claude_settings", subagentClaudePersistedBlock, block);
    if (change == null) return;
    if (deferSubagentCapture("claude")) return;
    subagentClaudeSaveState = "saving";
    subagentClaudeSaveError = null;
    saveSubagentClaudeSettings({
      id: selectedEditableSubagentId,
      body: { claude_settings: change },
      signature,
      block,
      readGeneration: subagentReadGeneration,
    });
  });

  $effect(() => {
    primaryCaptureWake.zip;
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    const signature = makeZipSignature(zipForm);
    if (!zipPersistedSignature || signature === zipPersistedSignature) {
      return;
    }

    const validation = validateZipForm(zipForm);
    zipValidationError = validation;

    if (validation) {
      zipSaveState = "idle";
      return;
    }

    // BL-855: only the zip fields that differ from the payload as it loaded or was last saved
    // (`custom_tool_settings` whole, and only when a custom tool row differs).
    const payload = buildZipPayload(zipForm);
    if (!zipPersistedPayload) return;
    const body = diffZipPayload(zipPersistedPayload, payload);
    if (Object.keys(body).length === 0) return;
    if (deferPrimaryCapture("zip")) return;

    zipSaveState = "saving";
    zipSaveError = null;
    saveZipSettings({
      id: selectedAgentId,
      body,
      signature,
      full: payload,
      hydrationGeneration: agentHydrationRequestId,
    });
  });

  $effect(() => {
    primaryCaptureWake.mcp;
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    const signature = makeMcpSignature(
      defaultMCPGateways,
      defaultMCPToolSelections,
      dcmDisplaySettings,
    );
    if (!mcpPersistedSignature || signature === mcpPersistedSignature) {
      return;
    }

    // BL-855: the gateway list and the tool selections whole, only when they differ; the display
    // settings entry by entry (`diffAgentBlock`).
    if (!mcpPersistedValues) return;
    const payload = buildMcpPayload(
      defaultMCPGateways,
      defaultMCPToolSelections,
      dcmDisplaySettings,
    );
    const values: McpSectionValues = {
      gateways: payload.defaultMCPGateways,
      selections: payload.defaultMCPToolSelections,
      dcm: payload.dcmDisplaySettings,
    };
    const body = diffMcpSection(mcpPersistedValues, values);
    if (Object.keys(body).length === 0) return;
    if (deferPrimaryCapture("mcp")) return;

    mcpSaveState = "saving";
    mcpSaveError = null;
    saveMcpSettings({
      id: selectedAgentId,
      body,
      signature,
      values,
      hydrationGeneration: agentHydrationRequestId,
    });
  });

  $effect(() => {
    subagentCaptureWake.mcp;
    if (
      !selectedEditableSubagentId ||
      subagentDetailLoading ||
      subagentsLoading ||
      hydrationInProgress
    )
      return;
    if (subagentForm.subagentType === "n8n-subnode") return;

    const signature = makeMcpSignature(
      subagentDefaultMCPGateways,
      subagentDefaultMCPToolSelections,
      subagentDcmDisplaySettings,
    );
    if (
      !subagentMcpPersistedSignature ||
      signature === subagentMcpPersistedSignature
    ) {
      return;
    }

    // BL-914: the gateway list and the tool selections whole, only when they differ; the display
    // settings entry by entry (a removed entry as `null`), the Primary Agent's rule
    // (`diffMcpSection`). A change that leaves every value as it was sends nothing.
    if (!subagentMcpPersistedValues) return;
    const payload = buildMcpPayload(
      subagentDefaultMCPGateways,
      subagentDefaultMCPToolSelections,
      subagentDcmDisplaySettings,
    );
    const values: McpSectionValues = {
      gateways: payload.defaultMCPGateways,
      selections: payload.defaultMCPToolSelections,
      dcm: payload.dcmDisplaySettings,
    };
    const body = diffMcpSection(subagentMcpPersistedValues, values);
    if (Object.keys(body).length === 0) return;
    if (deferSubagentCapture("mcp")) return;

    subagentEditSaveState = "saving";
    if (!subagentCoreEditUnsaved()) subagentEditSaveError = null;
    saveSubagentMcpSettings({
      id: selectedEditableSubagentId,
      body,
      signature,
      values,
      readGeneration: subagentReadGeneration,
    });
  });

  $effect(() => {
    primaryCaptureWake.assignment;
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    const signature = makeSubagentSignature(selectedSubagentIds);
    if (
      !assignmentPersistedSignature ||
      signature === assignmentPersistedSignature
    ) {
      return;
    }

    if (deferPrimaryCapture("assignment")) return;
    assignmentSaveState = "saving";
    assignmentSaveError = null;
    saveSubagentAssignments({
      id: selectedAgentId,
      subagentIds: [...selectedSubagentIds],
      signature,
      hydrationGeneration: agentHydrationRequestId,
    });
  });

  $effect(() => {
    subagentCaptureWake.core;
    if (
      !selectedEditableSubagentId ||
      subagentDetailLoading ||
      subagentsLoading ||
      hydrationInProgress
    )
      return;
    if (subagentForm.subagentType === "n8n-subnode") return;

    const signature = makeSubagentFormSignature(subagentForm);
    if (
      !subagentPersistedSignature ||
      !subagentPersistedForm ||
      signature === subagentPersistedSignature ||
      signature === lastInvalidSubagentSignature
    ) {
      return;
    }

    const validation = validateSubagentForm(subagentForm);
    subagentValidationError = validation;

    if (validation) {
      lastInvalidSubagentSignature = signature;
      subagentEditSaveState = "idle";
      return;
    }

    lastInvalidSubagentSignature = null;
    const nextForm = $state.snapshot(subagentForm) as SubagentForm;
    const body = buildSubagentSavePatch(nextForm);
    if (patchContainsGroupedValues(body, "subagent") && deferSubagentCapture("core")) return;
    // A form that differs from the saved copy only in ways the save does not see (a workflow URL
    // an API Subagent does not keep) has nothing to send.
    if (Object.keys(body).length === 0) return;

    subagentEditSaveState = "saving";
    subagentEditSaveError = null;

    saveSubagentDetails({
      id: selectedEditableSubagentId,
      body,
      nextForm,
      readGeneration: subagentReadGeneration,
    });
  });

  $effect(() => {
    const presetId = basicForm.primary_model_preset_id?.trim() ?? "";
    const provider = basicForm.primary_model_provider;
    const modelId = basicForm.primary_model_name;
    savedModels;

    const match =
      (presetId ? savedModels.find((model) => model.id === presetId) : null) ??
      savedModels.find((model) => model.provider === provider && model.modelId === modelId) ??
      null;

    const nextId = match && agentPresetShowsAsSelected(match) ? match.id : null;

    if (selectedModelId !== nextId) {
      selectedModelId = nextId;
    }
  });

  $effect(() => {
    const form = subagentForm;
    savedModels;
    const match = findSubagentFormModel(form);
    const nextId = match && subagentPresetShowsAsSelected(match) ? match.id : null;
    if (selectedSubagentModelId !== nextId) {
      selectedSubagentModelId = nextId;
    }
  });

  function validateBasicForm(form: BasicForm) {
    if (!form.displayName.trim()) {
      return "Display name is required.";
    }
    if (
      form.default_project_id &&
      !projectOptions.some((project) => project.id === form.default_project_id)
    ) {
      return "Selected Default Project no longer exists. Pick another project or set None.";
    }
    if (form.agentType === "n8n") {
      return "This Primary Agent uses the retired n8n type and can only be deleted.";
    }
    const provider = form.primary_model_provider.trim().toLowerCase();
    const modelName = form.primary_model_name.trim().toLowerCase();
    const connectionHint =
      form.primary_model_connection?.id ??
      form.primary_model_connection?.service ??
      "";
    const hasModelSelection = Boolean(provider || modelName || connectionHint);
    const isCodexPreset =
      provider.includes("codex") ||
      modelName.includes("codex") ||
      connectionHint.toLowerCase().includes("codex");
    const isClaudeCliPreset =
      provider.includes("claude-cli") ||
      modelName.includes("claude-cli") ||
      connectionHint.toLowerCase().includes("claude-cli");
    const isCliPreset = isCodexPreset || isClaudeCliPreset;

    if (isCliPrimaryAgentType(form.agentType) && hasModelSelection && !isCliPreset) {
      return "CLI agents only support CLI presets.";
    }
    if (!isCliPrimaryAgentType(form.agentType) && isCliPreset) {
      return "CLI presets are only available for CLI agents.";
    }
    return null;
  }

  function validateZipForm(form: ZipForm) {
    for (const key of [...ZIP_BUFFER_FIELDS, ...ZIP_THRESHOLD_FIELDS]) {
      const value = form[key];
      if (!value) continue;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return `Invalid value for ${formatZipLabel(String(key))}. Use numeric values.`;
      }
      if ((ZIP_BUFFER_FIELDS as readonly string[]).includes(key)) {
        const field = key as (typeof ZIP_BUFFER_FIELDS)[number];
        if (isZeroAllowedBuffer(field) && parsed === 0) {
          continue;
        }
        if (parsed < MIN_BUFFER) {
          return `Invalid value for ${formatZipLabel(String(key))}. Use ${MIN_BUFFER} or higher.`;
        }
      } else if (parsed < 0) {
        return `Invalid value for ${formatZipLabel(String(key))}. Use non-negative numbers.`;
      }
    }

    for (const tool of form.custom_tool_settings) {
      if (!tool.buffer_size && !tool.zip_threshold) {
        continue;
      }
      if (tool.buffer_size) {
        const bufferParsed = Number(tool.buffer_size);
        if (!Number.isFinite(bufferParsed) || bufferParsed < MIN_BUFFER) {
          return `Invalid buffer for ${tool.tool_name}. Use ${MIN_BUFFER} or higher.`;
        }
      }
      if (tool.zip_threshold) {
        const thresholdParsed = Number(tool.zip_threshold);
        if (!Number.isFinite(thresholdParsed) || thresholdParsed < 0) {
          return `Invalid threshold for ${tool.tool_name}. Use non-negative numbers.`;
        }
      }
    }
    return null;
  }

  function sortCustomToolSettings(tools: CustomToolSettingForm[]) {
    const globalOrder = new Map(
      (globalZipSettings?.custom_tool_settings ?? []).map((tool, index) => [
        tool.tool_name,
        index,
      ]),
    );

    return [...tools].sort((left, right) => {
      const leftOrder = globalOrder.get(left.tool_name);
      const rightOrder = globalOrder.get(right.tool_name);

      if (leftOrder !== undefined && rightOrder !== undefined) {
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      } else if (leftOrder !== undefined) {
        return -1;
      } else if (rightOrder !== undefined) {
        return 1;
      }

      return left.tool_name.localeCompare(right.tool_name);
    });
  }

  function syncCustomToolOverridesFromGlobal() {
    const globalTools = globalZipSettings?.custom_tool_settings ?? [];

    const currentMap = new Map(
      zipForm.custom_tool_settings.map((tool) => [tool.tool_name, tool]),
    );
    const merged: CustomToolSettingForm[] = [];

    for (const tool of globalTools) {
      const existing = currentMap.get(tool.tool_name);
      if (existing) {
        merged.push({
          ...existing,
          auto_zip: existing.auto_zip || ZIP_AUTO_INHERIT,
        });
        currentMap.delete(tool.tool_name);
      } else {
        merged.push({
          tool_name: tool.tool_name,
          buffer_size: "",
          zip_threshold: "",
          auto_zip: ZIP_AUTO_INHERIT,
        });
      }
    }

    for (const tool of currentMap.values()) {
      merged.push({
        ...tool,
        auto_zip: tool.auto_zip || ZIP_AUTO_INHERIT,
      });
    }

    const ordered = sortCustomToolSettings(merged);

    const currentSignature = JSON.stringify(zipForm.custom_tool_settings);
    const nextSignature = JSON.stringify(ordered);
    if (currentSignature !== nextSignature) {
      untrack(() => {
        zipForm = { ...zipForm, custom_tool_settings: ordered };
      });
    }
  }

  $effect(() => {
    globalZipSettings?.custom_tool_settings;
    syncCustomToolOverridesFromGlobal();
  });

  function validateSubagentForm(form: SubagentForm) {
    if (!form.displayName.trim()) {
      return "Display name is required.";
    }
    if (
      isWorkflowBackedSubagentType(form.subagentType) &&
      !form.webhook_url.trim()
    ) {
      return "Production webhook URL is required for n8n Workflow Subagents.";
    }
    if (isWorkflowBackedSubagentType(form.subagentType)) {
      const webhookValidation = validateN8nProductionWebhookUrl(
        form.webhook_url,
      );
      if (webhookValidation) {
        return webhookValidation;
      }
    }
    const timeoutValidation = getSubagentTimeoutValidationError(
      form.timeout_seconds,
    );
    if (timeoutValidation) {
      return timeoutValidation;
    }
    return null;
  }

  function formatZipLabel(key: string) {
    return key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function handleSubagentToggle(id: string, checked: boolean) {
    if (primaryOwnedSaveInFlightUi) return;
    const set = new Set(selectedSubagentIds);
    if (checked) {
      set.add(id);
    } else {
      set.delete(id);
    }
    selectedSubagentIds = Array.from(set);
  }

  function getSubagentType(
    subagent: SubagentRow | null | undefined,
  ): StoredSubagentType {
    return normalizeSubagentType(subagent, subagent?.subagentType);
  }

  function isSubagentCompatible(subagent: SubagentRow) {
    return isSubagentCompatibleWithPrimaryAgent(basicForm.agentType, subagent);
  }

  function selectSubagent(id: string) {
    if (createEntityMode) return;
    agentAvatarUploadRequestId += 1;
    isUploadingAgentAvatar = false;
    createEntityMode = false;
    activeAgentSettingsTab = "core";
    activeSubagentSettingsTab = "core";
    untrack(() => {
      selectedEntity = { kind: "subagent", id };
    });
    selectEditableSubagent(id);
  }

  /**
   * BL-955, BL-915: puts `match`, the panel's copy of the shown Subagent, into its section forms.
   * `fill` (a first open, a pick of another Subagent) fills every section and raises
   * `subagentReadGeneration`; every real GET also raises it before taking a snapshot.
   * A save built before either read moves nothing when it lands
   * (`subagentLanding`) and the status the earlier Subagent's save left is put back to idle: that
   * save lands as "other" and can no longer end it. Otherwise (the list effect's hydrate, the
   * real GET) a section is replaced only while it is at rest (`subagentSectionsAtRest`): no
   * section that a save is on its way for is replaced, so no save of it can land under an older
   * record. A cached-list refresh keeps the counter, while a real GET supersedes older saves. A
   * section left alone asks for a read at rest. The list effect's hydrate leaves the Tool Grid out
   * (`withToolGrid`), as it always did. Called untracked.
   */
  function readSubagentSections(match: SubagentRow, fill: boolean, withToolGrid: boolean) {
    if (fill) {
      subagentReadGeneration += 1;
      subagentEditSaveState = "idle";
    }
    setSubagentReadDeferred(false);
    const atRest = subagentSectionsAtRest();
    if (subagentOwnedWritesPending(match.id)) setSubagentReadDeferred(true);
    const replaces = (section: keyof typeof atRest) => {
      if (fill || atRest[section]) return true;
      setSubagentReadDeferred(true);
      return false;
    };

    if (replaces("core")) {
      const normalisedSubagentForm = normaliseSubagentForm(match);
      subagentForm = normalisedSubagentForm;
      subagentPersistedSignature = makeSubagentFormSignature(normalisedSubagentForm);
      subagentPersistedForm = $state.snapshot(normalisedSubagentForm) as SubagentForm;
    }
    if (withToolGrid && replaces("toolGrid")) {
      const mcpDefaults = normaliseSubagentMcpDefaults(match);
      subagentDefaultMCPGateways = mcpDefaults.gateways;
      subagentDefaultMCPToolSelections = mcpDefaults.selections;
      subagentDefaultCliToolIds = normaliseCliToolDefaults(match as unknown as AgentRow);
      subagentCliToolIdsExplicit = Array.isArray(
        match.defaultTools ?? (match as any).default_tools,
      );
      subagentDcmDisplaySettings = mcpDefaults.dcmDisplaySettings;
      subagentMcpPersistedSignature = makeMcpSignature(
        mcpDefaults.gateways,
        mcpDefaults.selections,
        mcpDefaults.dcmDisplaySettings,
      );
      // A Subagent that holds its display settings only under the older name has no
      // `dcmDisplaySettings` yet: its first save writes the whole block, so the older name's
      // entries are not dropped (the Primary Agent's rule, and the runtime readers still take the
      // older name).
      subagentMcpPersistedValues = {
        gateways: [...mcpDefaults.gateways],
        selections: cloneToolSelections(mcpDefaults.selections),
        dcm:
          match.dcmDisplaySettings == null && (match as any).dcm_display_settings != null
            ? null
            : cloneDcmDisplaySettings(mcpDefaults.dcmDisplaySettings),
      };
      subagentMcpRenderNonce += 1;
    }
    if (replaces("codex")) {
      const normalisedCodexForm = normaliseCodexForm(match, "subagent");
      subagentCodexForm = normalisedCodexForm;
      subagentCodexPersistedSignature = makeCodexSignature(normalisedCodexForm, "subagent");
      subagentCodexPersistedBlock =
        match.codex_settings == null ? null : serializeCodexForm(normalisedCodexForm, "subagent");
      subagentCodexSaveState = "idle";
      subagentCodexSaveError = null;
      subagentCodexLastSaved = null;
    }
    if (replaces("claude")) {
      const normalisedClaudeForm = normaliseClaudeForm(match, "subagent");
      subagentClaudeForm = normalisedClaudeForm;
      subagentClaudePersistedSignature = makeClaudeSignature(normalisedClaudeForm);
      subagentClaudePersistedBlock =
        match.claude_settings == null ? null : serializeClaudeForm(normalisedClaudeForm);
      subagentClaudeSaveState = "idle";
      subagentClaudeSaveError = null;
      subagentClaudeLastSaved = null;
    }
  }

  function selectEditableSubagent(id: string) {
    if (createEntityMode) return;
    const match = subagents.find((item) => item.id === id);
    if (!match) return;

    if (selectedEditableSubagentId !== id) {
      subagentAvatarUploadRequestId += 1;
      subagentAvatarUploading = false;
      subagentReadRequestId += 1;
      if (subagentReadTimer) clearTimeout(subagentReadTimer);
      subagentReadTimer = null;
      subagentReadWaitError = null;
    }
    subagentDetailLoading = true;

    untrack(() => {
      const fill = selectedEditableSubagentId !== id;
      selectedEditableSubagentId = id;
      selectedEntity = { kind: "subagent", id };
      createEntityMode = false;
      activeSubagentSettingsTab = "core";
      readSubagentSections(match, fill, true);
      subagentValidationError = null;
      subagentAvatarError = null;
      selectedSubagentModelId = null;
      lastInvalidSubagentSignature = null;
    });

    syncSelectedModelFromSubagent();
    subagentDetailLoading = false;
    syncSubagentSaveWaits();
  }

  function resetZipOverrides() {
    if (primaryCaptureBlocked) return;
    if (!selectedAgentId) return;
    const nextForm: ZipForm = {
      ...zipForm,
      zip_ai_view_mode: ZIP_LAYOUT_INHERIT,
      zip_tool_notes_enabled: ZIP_NOTES_INHERIT,
      custom_tool_settings: (globalZipSettings?.custom_tool_settings ?? []).map((tool) => ({
        tool_name: tool.tool_name,
        buffer_size: "",
        zip_threshold: "",
        auto_zip: ZIP_AUTO_INHERIT,
      })),
    };

    for (const field of ZIP_BUFFER_FIELDS) {
      nextForm[field] = "";
    }
    for (const field of ZIP_THRESHOLD_FIELDS) {
      nextForm[field] = "";
    }
    for (const field of ZIP_AUTO_FIELDS) {
      nextForm[field] = ZIP_AUTO_INHERIT;
    }

    untrack(() => {
      zipForm = nextForm;
    });
  }

  async function refreshCurrentAgent() {
    if (!selectedAgentId) return;
    await hydrateAgent(selectedAgentId);
    toast.success("Agent settings refreshed");
  }

  function handleMcpGatewaysChange(gateways: string[]) {
    if (primaryOwnedSaveInFlightUi) return;
    defaultMCPGateways = [...gateways];
  }

  function handleMcpDcmDisplaySettingsChange(settings: AgentDcmDisplaySettings) {
    if (primaryOwnedSaveInFlightUi) return;
    dcmDisplaySettings = cloneDcmDisplaySettings(settings);
  }

  function clearMcpDefaults(showToast = true) {
    if (primaryCaptureBlocked) return;
    if (
      defaultMCPGateways.length === 0 &&
      defaultMCPToolSelections.length === 0 &&
      !cliToolIdsExplicit &&
      Object.keys(dcmDisplaySettings.groups ?? {}).length === 0 &&
      Object.keys(dcmDisplaySettings.tools ?? {}).length === 0
    ) {
      return;
    }
    defaultMCPGateways = [];
    defaultMCPToolSelections = [];
    defaultCliToolIds = [];
    cliToolIdsExplicit = false;
    dcmDisplaySettings = createDefaultDcmDisplaySettings();
    mcpRenderNonce = mcpRenderNonce + 1;
    if (selectedAgentId && selectedAgentId !== CREATE_AGENT_SENTINEL) {
      mcpSaveState = "saving";
      mcpSaveError = null;
      saveCliToolSettings({
        id: selectedAgentId,
        body: {
          defaultTools: null,
        },
        hydrationGeneration: agentHydrationRequestId,
      });
    }
    if (showToast) {
      toast.success("Reset Tool Grid to global settings");
    }
  }

  function resetToolGridToGlobalSettings() {
    if (primaryCaptureBlocked) return;
    if (!selectedAgentId || selectedAgentId === CREATE_AGENT_SENTINEL) return;
    resetZipOverrides();
    clearMcpDefaults(false);
    toast.success("Reset Tool Grid to global settings");
  }

  function handleVoiceProviderChange(value: string) {
    const provider =
      value === VOICE_PROVIDER_INHERIT ? "" : value;
    voiceIdManual = false;
    voiceModelManual = false;
    voiceOptions = [];
    voiceOptionsError = null;
    voiceOptionsKey = "";
    basicForm = {
      ...basicForm,
      voice_profile: {
        ...basicForm.voice_profile,
        provider,
        model: "",
        voiceId: "",
        profileId: "",
      },
    };
  }

  function resetVoiceProfile() {
    basicForm = {
      ...basicForm,
      voice_profile: createDefaultVoiceProfile(),
    };
  }

  async function handleAgentVoicePreview() {
    const text = agentVoiceTestPhrase.trim();
    if (!text) {
      toast.error("Enter a test phrase first.");
      return;
    }

    const agentVoiceProfile = buildVoiceProfilePayload(basicForm.voice_profile);
    const tts = agentVoiceProfile?.tts;
    const provider = tts?.providerId;
    const voiceConfig: VoiceConfig = {
      provider,
      model: tts?.modelId,
      voiceId: tts?.voiceId,
      profileId: tts?.profileId,
    };

    agentVoicePreviewBusy = true;
    try {
      await voiceService.speak(text, {
        manual: true,
        voice: voiceConfig,
        voiceSettings: resolveVoiceSettingsForSpeech(globalVoiceSettings, agentVoiceProfile)
      });
    } catch (error) {
      console.error("Agent voice preview failed:", error);
      toast.error(error instanceof Error ? error.message : "Voice preview failed");
    } finally {
      agentVoicePreviewBusy = false;
    }
  }

  function makeBasicSignature(form: BasicForm) {
    return JSON.stringify({
      displayName: form.displayName.trim(),
      agentType: form.agentType,
      show_reasoning: form.show_reasoning,
      preserve_reasoning: form.show_reasoning ? form.preserve_reasoning : false,
      tool_approval_mode: form.tool_approval_mode,
      auto_compact_settings: normalizeAgentAutoCompactSettings(form.auto_compact_settings),
      memory_settings: buildAgentMemoryRecordFields(form.memory_settings),
      workers_enabled: form.workers_enabled,
      dms_enabled: form.dms_enabled,
      jev_juice_skill_tool_hints: form.jev_juice_skill_tool_hints,
      jev_juice_judge_tool: form.jev_juice_judge_tool,
      jev_juice_memory_rerank: form.jev_juice_memory_rerank,
      jev_juice_memory_recall: form.jev_juice_memory_recall,
      jev_juice_reply_check: form.jev_juice_reply_check,
      jev_juice_style_coach: form.jev_juice_style_coach,
      dm_senders: form.dm_sender_scope,
      dm_sender_agent_ids: form.dm_sender_agent_ids,
      wake_enabled: form.wake_enabled,
      wake_timeout_minutes: form.wake_timeout_minutes,
      wake_target: form.wake_target,
      webhook_url: form.webhook_url.trim(),
      agent_url: form.agent_url.trim(),
      default_project_id: form.default_project_id ?? null,
      include_global_prompt: form.include_global_prompt,
      primary_model_provider: form.primary_model_provider.trim(),
      primary_model_name: form.primary_model_name.trim(),
      primary_model_preset_id: form.primary_model_preset_id.trim(),
      primary_model_connection: form.primary_model_connection ?? null,
      avatar_url: form.avatar_url ?? "",
      avatar_icon_ref: iconRefKey(form.avatar_icon_ref),
      avatar_icon_fit: form.avatar_icon_fit,
      goon_id: form.goon_id ?? null,
      provider_specific_settings: form.provider_specific_settings ?? null,
      primary_model_temperature: form.primary_model_temperature ?? null,
      primary_model_max_tokens: form.primary_model_max_tokens ?? null,
      primary_model_top_p: form.primary_model_top_p ?? null,
      primary_model_top_k: form.primary_model_top_k ?? null,
      primary_model_frequency_penalty: form.primary_model_frequency_penalty ?? null,
      primary_model_presence_penalty: form.primary_model_presence_penalty ?? null,
      primary_model_seed: form.primary_model_seed ?? null,
      primary_model_stop_sequences: form.primary_model_stop_sequences ?? null,
      primary_model_reasoning_effort: form.primary_model_reasoning_effort ?? null,
      primary_model_capabilities: form.primary_model_capabilities ?? null,
      voice_profile: buildVoiceProfilePayload(form.voice_profile),
    });
  }

  function cloneJsonValue<T>(value: T): T {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function cloneBasicForm(form: BasicForm): BasicForm {
    return {
      ...form,
      auto_compact_settings: normalizeAgentAutoCompactSettings(
        form.auto_compact_settings,
      ),
      memory_settings: cloneJsonValue(form.memory_settings),
      primary_model_connection: cloneJsonValue(form.primary_model_connection),
      provider_specific_settings: cloneJsonValue(form.provider_specific_settings),
      primary_model_stop_sequences: form.primary_model_stop_sequences
        ? [...form.primary_model_stop_sequences]
        : null,
      primary_model_capabilities: cloneJsonValue(form.primary_model_capabilities),
      voice_profile: { ...form.voice_profile },
    };
  }

  function buildVoiceProfilePayload(form: VoiceProfileForm): AgentVoiceProfile | null {
    const voiceSessionRuntime =
      form.voiceSessionRuntime === "direct" || form.voiceSessionRuntime === "livekit"
        ? form.voiceSessionRuntime
        : undefined;
    const voiceModeInputMode =
      form.voiceModeInputMode === "stt" || form.voiceModeInputMode === "text"
        ? form.voiceModeInputMode
        : undefined;
    const voiceModeSubmitMode =
      form.voiceModeSubmitMode === "auto" || form.voiceModeSubmitMode === "manual"
        ? form.voiceModeSubmitMode
        : undefined;
    const provider = normaliseStringOrNull(form.provider);
    const model = normaliseStringOrNull(form.model);
    const voiceId = normaliseStringOrNull(form.voiceId);
    const profileId = normaliseStringOrNull(form.profileId);
    const italicNarrationBehavior =
      form.ttsItalicNarrationBehavior === "speak" ||
      form.ttsItalicNarrationBehavior === "silent"
        ? form.ttsItalicNarrationBehavior
        : undefined;
    const sttProvider = normaliseStringOrNull(form.sttProvider);
    const sttModel = normaliseStringOrNull(form.sttModel);
    const realtimeSttProvider = normaliseStringOrNull(form.realtimeSttProvider);
    const realtimeSttModel = normaliseStringOrNull(form.realtimeSttModel);
    const hasNarration = Boolean(italicNarrationBehavior);
    if (
      !provider &&
      !model &&
      !voiceId &&
      !profileId &&
      !hasNarration &&
      !sttProvider &&
      !sttModel &&
      !realtimeSttProvider &&
      !realtimeSttModel &&
      !voiceSessionRuntime &&
      !voiceModeInputMode &&
      !voiceModeSubmitMode
    ) {
      return null;
    }

    return {
      schemaVersion: 2,
      voiceSessionRuntime,
      voiceModeInputMode,
      voiceMode: voiceModeSubmitMode
        ? {
            submitMode: voiceModeSubmitMode,
          }
        : undefined,
      tts:
        provider || model || voiceId || profileId || hasNarration
          ? {
              providerId: provider ? (provider as VoiceProviderId) : undefined,
              modelId: model ?? undefined,
              voiceId: voiceId ?? undefined,
              profileId: profileId ?? undefined,
              narration: hasNarration
                ? {
                    italicBehavior: italicNarrationBehavior,
                  }
                : undefined,
            }
          : undefined,
      stt:
        sttProvider || sttModel
          ? {
              providerId: sttProvider ? (sttProvider as VoiceProviderId) : undefined,
              modelId: sttModel ?? undefined,
            }
          : undefined,
      realtimeStt:
        realtimeSttProvider || realtimeSttModel
          ? {
              providerId: realtimeSttProvider ? (realtimeSttProvider as VoiceProviderId) : undefined,
              modelId: realtimeSttModel ?? undefined,
            }
          : undefined,
    };
  }

  /**
   * BL-514: the save for `form`: only what differs from the copy the form loaded or last saved
   * (`basicPersistedForm`), so a stale copy never takes back a newer chat-bar change, and a
   * native-tool setting the form removed goes as `null` (the server keeps an own key a save
   * leaves out).
   */
  function buildBasicSavePatch(form: BasicForm): Partial<BasicPayloadBody> {
    if (!basicPersistedForm) {
      throw new Error("Agent settings have not loaded yet, so nothing can be saved.");
    }
    return buildAgentSettingsSavePatch(
      buildBasicPayload(basicPersistedForm) as unknown as Record<string, unknown>,
      buildBasicPayload(form) as unknown as Record<string, unknown>,
    ) as Partial<BasicPayloadBody>;
  }

  function buildBasicPayload(form: BasicForm): BasicPayloadBody {
    if (form.agentType === "n8n") {
      throw new Error("This Primary Agent uses the retired n8n type and can only be deleted.");
    }
    return {
      displayName: form.displayName.trim(),
      agentType: form.agentType,
      show_reasoning: form.show_reasoning,
      preserve_reasoning: form.show_reasoning ? form.preserve_reasoning : false,
      tool_approval_mode: form.tool_approval_mode,
      auto_compact_settings: normalizeAgentAutoCompactSettings(form.auto_compact_settings),
      ...buildAgentMemoryRecordFields(form.memory_settings),
      workers_enabled: form.workers_enabled,
      dms_enabled: form.dms_enabled,
      jev_juice_skill_tool_hints: form.jev_juice_skill_tool_hints,
      jev_juice_judge_tool: form.jev_juice_judge_tool,
      jev_juice_memory_rerank: form.jev_juice_memory_rerank,
      jev_juice_memory_recall: form.jev_juice_memory_recall,
      jev_juice_reply_check: form.jev_juice_reply_check,
      jev_juice_style_coach: form.jev_juice_style_coach,
      dm_senders: form.dm_sender_scope,
      // Stored beside the scope rather than inside it, so an agent that switches back to
      // "Any agent" and then to "Only chosen agents" keeps the list it had.
      dm_sender_agent_ids: form.dm_sender_agent_ids,
      wake_enabled: form.wake_enabled,
      wake_timeout_minutes: form.wake_timeout_minutes,
      wake_target: form.wake_target,
      webhook_url: normaliseStringOrNull(form.webhook_url),
      webhookUrl: normaliseStringOrNull(form.webhook_url),
      agent_url: normaliseStringOrNull(form.agent_url),
      default_project_id: form.default_project_id ?? null,
      include_global_prompt: form.include_global_prompt,
      primary_model_provider: normaliseStringOrNull(form.primary_model_provider),
      primary_model_name: normaliseStringOrNull(form.primary_model_name),
      primary_model_preset_id: normaliseStringOrNull(form.primary_model_preset_id),
      primary_model_connection: form.primary_model_connection,
      avatar_url: form.avatar_url,
      avatar: form.avatar_url,
      avatar_icon_ref: form.avatar_icon_ref,
      avatar_icon_fit: form.avatar_icon_fit,
      goon_id: form.goon_id ?? null,
      provider_specific_settings: form.provider_specific_settings,
      primary_model_temperature: form.primary_model_temperature,
      primary_model_max_tokens: form.primary_model_max_tokens,
      primary_model_top_p: form.primary_model_top_p,
      primary_model_top_k: form.primary_model_top_k,
      primary_model_frequency_penalty: form.primary_model_frequency_penalty,
      primary_model_presence_penalty: form.primary_model_presence_penalty,
      primary_model_seed: form.primary_model_seed,
      primary_model_stop_sequences: form.primary_model_stop_sequences,
      primary_model_reasoning_effort: form.primary_model_reasoning_effort,
      primary_model_capabilities: form.primary_model_capabilities,
      voice_profile: buildVoiceProfilePayload(form.voice_profile),
    };
  }

  async function saveAgentPromptFromEditor(nextPrompt: string) {
    requirePrimaryCaptureReady();
    const agentId = requireHydratedAgentDetail(
      selectedAgentId,
      promptPersistedSignature,
      "the agent prompt",
    );
    basicSaveScope = "instructions";
    const payload = { id: agentId, system_prompt: nextPrompt, hydrationGeneration: agentHydrationRequestId };
    await promptSaves.run(agentId, () => persistPrompt(payload, nextPrompt));
  }

  async function saveBasicMultilineEditor(
    scope: BasicSaveScope,
    mutator: (current: BasicForm) => BasicForm,
  ) {
    requirePrimaryCaptureReady();
    const agentId = requireHydratedAgentDetail(
      selectedAgentId,
      basicPersistedSignature,
      "agent settings",
    );
    const nextForm = mutator(basicForm);
    const validation = validateBasicForm(nextForm);
    basicValidationError = validation;
    if (validation) {
      throw new Error(validation);
    }

    const savedForm = $state.snapshot(nextForm) as BasicForm;
    const baseForm = $state.snapshot(basicPersistedForm) as BasicForm;
    const body = buildBasicSavePatch(savedForm);
    if (Object.keys(body).length === 0) return;

    basicSaveScope = scope;
    basicSaveState = "saving";
    basicSaveError = null;
    // BL-911: the editor's change is not in the live form yet: it is laid over the form as the
    // save lands, so text typed elsewhere during the round trip stays (unless the agent was read
    // again meanwhile: `persistBasic` then leaves the form to that read and asks for another).
    const payload = { id: agentId, body, hydrationGeneration: agentHydrationRequestId, baseForm };
    await basicSaves.run(agentId, () => persistBasic(payload, savedForm, mutator));
  }

  /**
   * BL-844: the Subagent's save for `form`: only what differs from the copy the form loaded or
   * last saved (`subagentPersistedForm`), so a change made to the Subagent elsewhere since
   * Settings opened is never taken back. The Subagent form has no save before it loaded.
   */
  function buildSubagentSavePatch(form: SubagentForm): LiveSubagentUpdate {
    if (!subagentPersistedForm) {
      throw new Error("Subagent settings have not loaded yet, so nothing can be saved.");
    }
    return buildSubagentSettingsSavePatch(subagentPersistedForm, form);
  }

  async function saveSubagentMultilineEditor(
    scope: SubagentSaveScope,
    mutator: (current: SubagentForm) => SubagentForm,
  ) {
    requireSubagentCaptureReady();
    if (!selectedEditableSubagentId) return;
    const nextForm = mutator(subagentForm);
    const validation = validateSubagentForm(nextForm);
    subagentValidationError = validation;
    if (validation) {
      throw new Error(validation);
    }

    const savedForm = $state.snapshot(nextForm) as SubagentForm;
    const body = buildSubagentSavePatch(savedForm);
    if (Object.keys(body).length === 0) return;

    subagentSaveScope = scope;
    subagentEditSaveState = "saving";
    subagentEditSaveError = null;
    const payload = { id: selectedEditableSubagentId, body, readGeneration: subagentReadGeneration };
    await subagentCoreSaves.run(payload.id, () => persistSubagentDetails(payload, savedForm, mutator));
  }

  function makeZipSignature(form: ZipForm) {
    return JSON.stringify(buildZipPayload(form));
  }

  function makeSubagentSignature(ids: string[]) {
    return JSON.stringify([...ids].sort());
  }

  function buildZipPayload(form: ZipForm): ZipPayloadBody {
    const customToolPayload = form.custom_tool_settings
      .map((tool) => {
        const buffer = toNumberOrNull(tool.buffer_size);
        const threshold = toNumberOrNull(tool.zip_threshold);
        const autoZip = toAutoZipPayload(tool.auto_zip);
        const zipDisabled = toZipDisabledPayload(tool.auto_zip);
        if (buffer === null && threshold === null && autoZip === null && zipDisabled === null) {
          return null;
        }
        const payload: CustomToolPayload = {
          tool_name: tool.tool_name,
        };
        if (buffer !== null) payload.buffer_size = buffer;
        if (threshold !== null) payload.zip_threshold = threshold;
        if (autoZip !== null) {
          payload.auto_zip = autoZip;
        }
        if (zipDisabled !== null) {
          payload.zip_disabled = zipDisabled;
        }
        return payload;
      })
      .filter((tool): tool is CustomToolPayload => Boolean(tool));
    const zipAiViewMode =
      form.zip_ai_view_mode === "inline" || form.zip_ai_view_mode === "appended"
        ? form.zip_ai_view_mode
        : null;
    const zipToolNotesEnabled =
      form.zip_tool_notes_enabled === "enabled"
        ? true
        : form.zip_tool_notes_enabled === "disabled"
          ? false
          : null;

    return {
      zip_ai_view_mode: zipAiViewMode,
      zip_tool_notes_enabled: zipToolNotesEnabled,
      buffer_size: toNumberOrNull(form.buffer_size),
      buffer_size_image: toNumberOrNull(form.buffer_size_image),
      buffer_size_error: toNumberOrNull(form.buffer_size_error),
      buffer_size_subagent: toNumberOrNull(form.buffer_size_subagent),
      buffer_size_read_file: toNumberOrNull(form.buffer_size_read_file),
      buffer_size_write_file: toNumberOrNull(form.buffer_size_write_file),
      buffer_size_edit_file: toNumberOrNull(form.buffer_size_edit_file),
      buffer_size_execute_command: toNumberOrNull(
        form.buffer_size_execute_command,
      ),
      buffer_size_list_files: toNumberOrNull(form.buffer_size_list_files),
      buffer_size_all_other_tools: toNumberOrNull(
        form.buffer_size_all_other_tools,
      ),
      zip_threshold_error: toNumberOrNull(form.zip_threshold_error),
      zip_threshold_image: toNumberOrNull(form.zip_threshold_image),
      zip_threshold_subagent: toNumberOrNull(form.zip_threshold_subagent),
      zip_threshold_read_file: toNumberOrNull(form.zip_threshold_read_file),
      zip_threshold_write_file: toNumberOrNull(form.zip_threshold_write_file),
      zip_threshold_edit_file: toNumberOrNull(form.zip_threshold_edit_file),
      zip_threshold_execute_command: toNumberOrNull(
        form.zip_threshold_execute_command,
      ),
      zip_threshold_list_files: toNumberOrNull(form.zip_threshold_list_files),
      zip_threshold_all_other_tools: toNumberOrNull(
        form.zip_threshold_all_other_tools,
      ),
      auto_zip_error: toAutoZipPayload(form.auto_zip_error),
      auto_zip_image: toAutoZipPayload(form.auto_zip_image),
      auto_zip_subagent: toAutoZipPayload(form.auto_zip_subagent),
      auto_zip_read_file: toAutoZipPayload(form.auto_zip_read_file),
      auto_zip_write_file: toAutoZipPayload(form.auto_zip_write_file),
      auto_zip_edit_file: toAutoZipPayload(form.auto_zip_edit_file),
      auto_zip_execute_command: toAutoZipPayload(form.auto_zip_execute_command),
      auto_zip_list_files: toAutoZipPayload(form.auto_zip_list_files),
      auto_zip_all_other_tools: toAutoZipPayload(form.auto_zip_all_other_tools),
      zip_disabled_error: toZipDisabledPayload(form.auto_zip_error),
      zip_disabled_image: toZipDisabledPayload(form.auto_zip_image),
      zip_disabled_subagent: toZipDisabledPayload(form.auto_zip_subagent),
      zip_disabled_read_file: toZipDisabledPayload(form.auto_zip_read_file),
      zip_disabled_write_file: toZipDisabledPayload(form.auto_zip_write_file),
      zip_disabled_edit_file: toZipDisabledPayload(form.auto_zip_edit_file),
      zip_disabled_execute_command: toZipDisabledPayload(form.auto_zip_execute_command),
      zip_disabled_list_files: toZipDisabledPayload(form.auto_zip_list_files),
      zip_disabled_all_other_tools: toZipDisabledPayload(form.auto_zip_all_other_tools),
      custom_tool_settings:
        customToolPayload.length > 0 ? customToolPayload : [],
    };
  }

  function buildMcpPayload(
    gateways: string[],
    selections: MCPToolSelections,
    displaySettings: AgentDcmDisplaySettings,
  ): McpPayloadBody {
    return {
      defaultMCPGateways: [...gateways],
      defaultMCPToolSelections: cloneToolSelections(selections),
      dcmDisplaySettings: cloneDcmDisplaySettings(displaySettings),
    };
  }

  function normaliseCliToolDefaults(agent: AgentRow) {
    const toolIds = Array.isArray(agent.defaultTools)
      ? [...agent.defaultTools]
      : Array.isArray((agent as any).default_tools)
        ? [...(agent as any).default_tools]
        : [];
    return [...new Set(toolIds.filter((entry) => typeof entry === "string" && entry.trim().length > 0))];
  }

  function handleCliToolSelectionsChange(toolIds: string[]) {
    if (primaryCaptureBlocked) return;
    defaultCliToolIds = [...toolIds];
    cliToolIdsExplicit = true;
    if (!selectedAgentId || selectedAgentId === CREATE_AGENT_SENTINEL) return;
    mcpSaveState = "saving";
    mcpSaveError = null;
    saveCliToolSettings({
      id: selectedAgentId,
      body: {
        defaultTools: [...toolIds],
      },
      hydrationGeneration: agentHydrationRequestId,
    });
  }

  function handleSubagentCliToolSelectionsChange(toolIds: string[]) {
    if (subagentCaptureBlocked) return;
    subagentDefaultCliToolIds = [...toolIds];
    subagentCliToolIdsExplicit = true;
    if (!selectedEditableSubagentId) return;
    subagentEditSaveState = "saving";
    if (!subagentCoreEditUnsaved()) subagentEditSaveError = null;
    saveSubagentCliToolSettings({
      id: selectedEditableSubagentId,
      body: {
        defaultTools: [...toolIds],
      },
      readGeneration: subagentReadGeneration,
    });
  }

  function handleSubagentMcpGatewaysChange(gateways: string[]) {
    if (subagentOwnedSaveInFlightUi) return;
    subagentDefaultMCPGateways = [...gateways];
  }

  function handleSubagentMcpDcmDisplaySettingsChange(
    settings: AgentDcmDisplaySettings,
  ) {
    if (subagentOwnedSaveInFlightUi) return;
    subagentDcmDisplaySettings = cloneDcmDisplaySettings(settings);
  }

  function clearSubagentMcpDefaults() {
    if (subagentCaptureBlocked) return;
    if (
      subagentDefaultMCPGateways.length === 0 &&
      subagentDefaultMCPToolSelections.length === 0 &&
      !subagentCliToolIdsExplicit &&
      Object.keys(subagentDcmDisplaySettings.groups ?? {}).length === 0 &&
      Object.keys(subagentDcmDisplaySettings.tools ?? {}).length === 0
    ) {
      return;
    }
    subagentDefaultMCPGateways = [];
    subagentDefaultMCPToolSelections = [];
    subagentDefaultCliToolIds = [];
    subagentCliToolIdsExplicit = false;
    subagentDcmDisplaySettings = createDefaultDcmDisplaySettings();
    subagentMcpRenderNonce += 1;
    if (selectedEditableSubagentId) {
      saveSubagentCliToolSettings({
        id: selectedEditableSubagentId,
        body: {
          defaultTools: null,
        },
        readGeneration: subagentReadGeneration,
      });
    }
    toast.success("Cleared Subagent Tool Grid defaults");
  }

  function zipPayloadToAgentUpdates(body: Partial<ZipPayloadBody>): Partial<AgentRow> {
    const result: Partial<AgentRow> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "custom_tool_settings") {
        result.custom_tool_settings =
          (value as ZipPayloadBody["custom_tool_settings"]) ?? undefined;
      } else if (key === "zip_ai_view_mode") {
        result.zip_ai_view_mode =
          (value as AgentRow["zip_ai_view_mode"]) ?? null;
      } else if (key === "zip_tool_notes_enabled") {
        result.zip_tool_notes_enabled =
          (value as AgentRow["zip_tool_notes_enabled"]) ?? null;
      } else if (key.startsWith("auto_zip_") || key.startsWith("zip_disabled_")) {
        result[key as keyof AgentRow] = (value as boolean | null) ?? null;
      } else {
        result[key as keyof AgentRow] = (value as number | null) ?? undefined;
      }
    }
    return result;
  }

  function toNumberOrNull(value: string) {
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }

  function toAutoZipPayload(value: string) {
    if (value === "enabled") return true;
    if (value === "disabled") return false;
    return null;
  }

  function toZipDisabledPayload(value: string) {
    if (value === "off") return true;
    if (value === "enabled" || value === "disabled") return false;
    return null;
  }

  function toStringValue(value: number | null | undefined) {
    if (value === null || value === undefined) return "";
    return String(value);
  }

  function toAutoZipValue(value: boolean | null | undefined, zipDisabled?: boolean | null) {
    if (zipDisabled === true) return "off";
    if (value === true) return "enabled";
    if (value === false) return "disabled";
    return ZIP_AUTO_INHERIT;
  }

  function formatInheritedNumberOverride(
    value: string | null | undefined,
    inheritedValue: number | undefined,
  ) {
    if (!value) return "";
    const parsed = Number(value);
    if (
      typeof inheritedValue === "number" &&
      Number.isFinite(parsed) &&
      parsed === inheritedValue
    ) {
      return "";
    }
    return value;
  }

  function formatInheritedAutoZipOverride(
    value: string | null | undefined,
    inheritedAutoZip: boolean | undefined,
    inheritedZipDisabled: boolean | undefined,
  ) {
    const normalized = value || ZIP_AUTO_INHERIT;
    if (normalized === ZIP_AUTO_INHERIT) return ZIP_AUTO_INHERIT;
    if (inheritedZipDisabled === true) return normalized;
    if (normalized === "enabled" && inheritedAutoZip === true) return ZIP_AUTO_INHERIT;
    if (normalized === "disabled" && inheritedAutoZip === false) return ZIP_AUTO_INHERIT;
    return normalized;
  }

  function getGlobalZipValue(key: ZipNumericField) {
    if (!globalZipSettings) return undefined;
    const raw = (globalZipSettings as Record<string, number | undefined>)[key];
    return typeof raw === "number" ? raw : undefined;
  }

  function getEffectiveGlobalZipValue(key: ZipNumericField) {
    return getGlobalZipValue(key) ?? getToolGridDefaultNumber(key);
  }

  function getGlobalAutoZipValue(
    key: (typeof ZIP_AUTO_FIELDS)[number],
  ): boolean | undefined {
    if (!globalZipSettings) {
      return getToolGridDefaultAutoZip(key);
    }
    const raw = (globalZipSettings as Record<string, any>)[key];
    if (typeof raw === "boolean") return raw;
    return getToolGridDefaultAutoZip(key);
  }

  function getZipDisabledFieldForAutoField(
    key: (typeof ZIP_AUTO_FIELDS)[number],
  ): (typeof ZIP_DISABLED_FIELDS)[number] {
    return key.replace(/^auto_zip_/, "zip_disabled_") as (typeof ZIP_DISABLED_FIELDS)[number];
  }

  function getGlobalZipDisabledValue(
    key: (typeof ZIP_AUTO_FIELDS)[number],
  ): boolean | undefined {
    if (!globalZipSettings) return undefined;
    const disabledField = getZipDisabledFieldForAutoField(key);
    const raw = (globalZipSettings as Record<string, any>)[disabledField];
    return typeof raw === "boolean" ? raw : undefined;
  }

  function getGlobalCustomToolSetting(toolName: string) {
    return (globalZipSettings?.custom_tool_settings ?? []).find(
      (tool) => tool.tool_name === toolName,
    );
  }

  function getMcpToolZipOverride(
    toolName: string,
  ): McpToolZipOverrideSnapshot {
    const normalizedName = toolName.trim();
    const customTool = zipForm.custom_tool_settings.find(
      (tool) => tool.tool_name === normalizedName,
    );
    const globalTool = getGlobalCustomToolSetting(normalizedName);
    const inheritedBufferSize =
      globalTool?.buffer_size ??
      getEffectiveGlobalZipValue("buffer_size_all_other_tools");
    const inheritedZipThreshold =
      globalTool?.zip_threshold ??
      getEffectiveGlobalZipValue("zip_threshold_all_other_tools");
    const inheritedAutoZip =
      typeof globalTool?.auto_zip === "boolean"
        ? globalTool.auto_zip
        : getGlobalAutoZipValue("auto_zip_all_other_tools");
    const inheritedZipDisabled =
      typeof globalTool?.zip_disabled === "boolean"
        ? globalTool.zip_disabled
        : getGlobalZipDisabledValue("auto_zip_all_other_tools");

    return {
      buffer_size: formatInheritedNumberOverride(customTool?.buffer_size, inheritedBufferSize),
      zip_threshold: formatInheritedNumberOverride(
        customTool?.zip_threshold,
        inheritedZipThreshold,
      ),
      auto_zip: formatInheritedAutoZipOverride(
        customTool?.auto_zip,
        inheritedAutoZip,
        inheritedZipDisabled,
      ),
      inherited_buffer_size: inheritedBufferSize,
      inherited_zip_threshold: inheritedZipThreshold,
      inherited_auto_zip: inheritedAutoZip,
      inherited_zip_disabled: inheritedZipDisabled,
    };
  }

  function handleMcpToolZipOverrideChange(
    toolName: string,
    patch: McpToolZipOverridePatch,
  ) {
    if (primaryOwnedSaveInFlightUi) return;
    const normalizedName = toolName.trim();
    if (!normalizedName) return;

    const current = zipForm.custom_tool_settings.find(
      (tool) => tool.tool_name === normalizedName,
    );
    const nextEntry: CustomToolSettingForm = {
      tool_name: normalizedName,
      buffer_size: current?.buffer_size ?? "",
      zip_threshold: current?.zip_threshold ?? "",
      auto_zip: current?.auto_zip ?? ZIP_AUTO_INHERIT,
      ...patch,
    };

    if (!nextEntry.auto_zip) {
      nextEntry.auto_zip = ZIP_AUTO_INHERIT;
    }

    const shouldRemoveEntry =
      !nextEntry.buffer_size &&
      !nextEntry.zip_threshold &&
      nextEntry.auto_zip === ZIP_AUTO_INHERIT &&
      !getGlobalCustomToolSetting(normalizedName);

    const withoutCurrent = zipForm.custom_tool_settings.filter(
      (tool) => tool.tool_name !== normalizedName,
    );
    const nextCustomTools = shouldRemoveEntry
      ? withoutCurrent
      : sortCustomToolSettings([...withoutCurrent, nextEntry]);

    const currentSignature = JSON.stringify(zipForm.custom_tool_settings);
    const nextSignature = JSON.stringify(nextCustomTools);
    if (currentSignature === nextSignature) return;

    zipForm = {
      ...zipForm,
      custom_tool_settings: nextCustomTools,
    };
  }

  function getNonMcpZipOverride(
    rowId: NonMcpZipRowId,
  ): NonMcpZipOverrideSnapshot {
    const config = NON_MCP_ZIP_ROW_CONFIG[rowId];
    if (config.mode === "custom") {
      const customTool = zipForm.custom_tool_settings.find(
        (tool) => tool.tool_name === config.toolName,
      );
      const globalTool = getGlobalCustomToolSetting(config.toolName);
      const inheritedBufferSize =
        globalTool?.buffer_size ?? config.defaultBuffer;
      const inheritedZipThreshold =
        globalTool?.zip_threshold ?? config.defaultThreshold;
      const inheritedAutoZip =
        typeof globalTool?.auto_zip === "boolean"
          ? globalTool.auto_zip
          : config.defaultAutoZip;
      const inheritedZipDisabled =
        typeof globalTool?.zip_disabled === "boolean"
          ? globalTool.zip_disabled
          : false;

      return {
        buffer_size: formatInheritedNumberOverride(
          customTool?.buffer_size,
          inheritedBufferSize,
        ),
        zip_threshold: formatInheritedNumberOverride(
          customTool?.zip_threshold,
          inheritedZipThreshold,
        ),
        auto_zip: formatInheritedAutoZipOverride(
          customTool?.auto_zip,
          inheritedAutoZip,
          inheritedZipDisabled,
        ),
        inherited_buffer_size: inheritedBufferSize,
        inherited_zip_threshold: inheritedZipThreshold,
        inherited_auto_zip: inheritedAutoZip,
        inherited_zip_disabled: inheritedZipDisabled,
        min_buffer: config.minBuffer,
      };
    }
    const bufferField = config.bufferField as (typeof ZIP_BUFFER_FIELDS)[number];
    const thresholdField = config.thresholdField as (typeof ZIP_THRESHOLD_FIELDS)[number];
    const autoField = config.autoField as (typeof ZIP_AUTO_FIELDS)[number];
    const inheritedBufferSize = getEffectiveGlobalZipValue(bufferField);
    const inheritedZipThreshold = getEffectiveGlobalZipValue(thresholdField);
    const inheritedAutoZip = getGlobalAutoZipValue(autoField);
    const inheritedZipDisabled = getGlobalZipDisabledValue(autoField);

    return {
      buffer_size: formatInheritedNumberOverride(zipForm[bufferField], inheritedBufferSize),
      zip_threshold: formatInheritedNumberOverride(
        zipForm[thresholdField],
        inheritedZipThreshold,
      ),
      auto_zip: formatInheritedAutoZipOverride(
        zipForm[autoField],
        inheritedAutoZip,
        inheritedZipDisabled,
      ),
      inherited_buffer_size: inheritedBufferSize,
      inherited_zip_threshold: inheritedZipThreshold,
      inherited_auto_zip: inheritedAutoZip,
      inherited_zip_disabled: inheritedZipDisabled,
      min_buffer: config.minBuffer,
    };
  }

  function isNonMcpZipRowId(value: string): value is NonMcpZipRowId {
    return isSharedNonMcpToolGridRowId(value);
  }

  function getNonMcpZipOverrideById(rowId: string): NonMcpZipOverrideSnapshot {
    if (!isNonMcpZipRowId(rowId)) {
      return {
        buffer_size: "",
        zip_threshold: "",
        auto_zip: ZIP_AUTO_INHERIT,
        inherited_zip_disabled: false,
        min_buffer: MIN_BUFFER,
      };
    }
    return getNonMcpZipOverride(rowId);
  }

  function handleNonMcpZipOverrideChange(
    rowId: NonMcpZipRowId,
    patch: NonMcpZipOverridePatch,
  ) {
    if (primaryOwnedSaveInFlightUi) return;
    const config = NON_MCP_ZIP_ROW_CONFIG[rowId];
    if (config.mode === "custom") {
      handleMcpToolZipOverrideChange(config.toolName, patch);
      return;
    }
    const bufferField = config.bufferField as (typeof ZIP_BUFFER_FIELDS)[number];
    const thresholdField = config.thresholdField as (typeof ZIP_THRESHOLD_FIELDS)[number];
    const autoField = config.autoField as (typeof ZIP_AUTO_FIELDS)[number];
    const nextForm: ZipForm = { ...zipForm };

    if (patch.buffer_size !== undefined) {
      nextForm[bufferField] = patch.buffer_size;
    }
    if (patch.zip_threshold !== undefined) {
      nextForm[thresholdField] = patch.zip_threshold;
    }
    if (patch.auto_zip !== undefined) {
      nextForm[autoField] = patch.auto_zip || ZIP_AUTO_INHERIT;
    }

    zipForm = nextForm;
  }

  function handleNonMcpZipOverrideChangeById(
    rowId: string,
    patch: NonMcpZipOverridePatch,
  ) {
    if (!isNonMcpZipRowId(rowId)) return;
    handleNonMcpZipOverrideChange(rowId, patch);
  }

  function handleZipAiViewModeChange(value: string) {
    if (primaryOwnedSaveInFlightUi) return;
    zipForm = { ...zipForm, zip_ai_view_mode: value };
  }

  function handleZipToolNotesChange(value: string) {
    if (primaryOwnedSaveInFlightUi) return;
    zipForm = { ...zipForm, zip_tool_notes_enabled: value };
  }

  function normaliseMcpDefaults(agent: AgentRow) {
    const gateways = Array.isArray(agent.defaultMCPGateways)
      ? [...agent.defaultMCPGateways]
      : [];
    const selections = cloneToolSelections(agent.defaultMCPToolSelections);
    const dcmDisplaySettings = cloneDcmDisplaySettings(
      agent.dcmDisplaySettings ?? (agent as any).dcm_display_settings,
    );
    return { gateways, selections, dcmDisplaySettings };
  }

  function normaliseSubagentMcpDefaults(subagent: SubagentRow) {
    const gateways = Array.isArray(subagent.defaultMCPGateways)
      ? [...subagent.defaultMCPGateways]
      : Array.isArray((subagent as any).default_mcp_gateways)
        ? [...(subagent as any).default_mcp_gateways]
        : [];
    const selections = cloneToolSelections(
      subagent.defaultMCPToolSelections ??
        (subagent as any).default_mcp_tool_selections ??
        [],
    );
    const dcmDisplaySettings = cloneDcmDisplaySettings(
      subagent.dcmDisplaySettings ?? (subagent as any).dcm_display_settings,
    );
    return { gateways, selections, dcmDisplaySettings };
  }

  function makeMcpSignature(
    gateways: string[],
    selections: MCPToolSelections,
    displaySettings: AgentDcmDisplaySettings,
  ) {
      return JSON.stringify({
        gateways: [...gateways].sort(),
        selections: sortMcpSelections(selections),
        dcmDisplaySettings: buildDcmDisplaySettingsSignature(displaySettings),
      });
    }

  function cloneToolSelections(
    source?: MCPToolSelections | null,
  ): MCPToolSelections {
    if (!source || !Array.isArray(source)) return [];
    return [...source];
  }

  function createConfigRow(initial?: Partial<ConfigRow>): ConfigRow {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `codex_cfg_${Math.random().toString(36).slice(2, 10)}`;
    return {
      id,
      key: initial?.key ?? "",
      value: initial?.value ?? "",
    };
  }

  function createDefaultCodexForm(): CodexFormOptions {
    return {
      permissionMode: "chat",
      includeProjectInstructions: true,
      model: CODEX_SUBMODEL_CHOICES[0]?.value ?? "gpt-6-astra",
      reasoningEffort: "default",
      serviceTier: "standard",
      streamingEffect: true,
      unifiedExec: true,
      search: true,
      sandbox: CODEX_PERMISSION_PRESETS.chat.sandbox,
      approval: "never",
      configScope: "managed",
      addDirs: [],
      enableFeatures: [],
      disableFeatures: [],
      configOverrides: [],
      workingDirectoryMode: "project",
      customWorkingDirectory: "",
      historyPersistence: "none",
    };
  }

  function createDefaultClaudeForm(): ClaudeFormOptions {
    return {
      permissionMode: "acceptEdits",
      includeCoreSystemPrompt: false,
      includeProjectInstructions: true,
      model: "",
      alwaysThinkingEnabled: false,
      maxThinkingTokens: "",
      configScope: "managed",
      systemPromptMode: "replace",
      systemPrompt: MODE4_PRELAUNCH_REPLACEMENT_PROMPT,
      systemPromptFile: "",
      chrome: false,
      addDirs: [],
      allowedTools: [],
      disallowedTools: [],
      configOverrides: [],
      workingDirectoryMode: "project",
      customWorkingDirectory: "",
    };
  }

  function parseClaudeList(value: unknown) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
    }
    if (typeof value === "string") {
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    return [];
  }

  function resolveCodexApprovalPolicy(
    permissionMode: CodexPermissionMode,
    sharedToolApprovalMode: "off" | "all",
    scope: CliSettingsScope = "agent",
  ): CodexApproval {
    if (scope === "subagent") return "never";
    if (permissionMode !== "agent") return "never";
    return sharedToolApprovalMode === "all" ? "on-request" : "never";
  }

  function getPrimaryApprovalPolicyLabel(mode: "off" | "all") {
    return (
      PRIMARY_TOOL_APPROVAL_OPTIONS.find((option) => option.value === mode)?.label ?? "Never"
    );
  }

  function normaliseCodexForm(
    agent: AgentRow | SubagentRow | null,
    scope: CliSettingsScope = "agent",
  ): CodexFormOptions {
    const options = createDefaultCodexForm();
    if (!agent) return options;
    const source = agent.codex_settings ?? null;
    const providerSettings =
      !source && agent.provider_specific_settings
        ? agent.provider_specific_settings
        : null;
    if (!source && !providerSettings) return options;

    const permission = source?.permissionMode ?? providerSettings?.codex_permission_mode;
    if (
      permission === "chat" ||
      permission === "agent" ||
      permission === "agent_full"
    ) {
      options.permissionMode = permission;
    }

    options.includeProjectInstructions =
      typeof source?.includeProjectInstructions === "boolean"
        ? source.includeProjectInstructions
        : providerSettings?.codex_include_project_instructions === true ||
            providerSettings?.codex_include_core_system_prompt === true;
    options.model =
      source?.model ??
      (typeof providerSettings?.codex_model === "string"
        ? providerSettings.codex_model.trim()
        : options.model);
    if (source?.reasoningEffort) {
      options.reasoningEffort = source.reasoningEffort as CodexFormOptions["reasoningEffort"];
    }
    options.serviceTier = source?.serviceTier === "fast" ? "fast" : "standard";
    options.streamingEffect = true;
    options.unifiedExec = true;
    options.search = source ? source.search !== false : providerSettings?.codex_search !== false;
    // BL-941 S: mirror the runtime's saved level; missing is this mode's own preset.
    // A structured block is authoritative; only an absent block reads the legacy bag.
    const savedSandbox = source ? source.sandbox : providerSettings?.codex_sandbox;
    options.sandbox = savedSandbox == null
      ? CODEX_PERMISSION_PRESETS[options.permissionMode].sandbox
      : sanitizeCodexSandbox(savedSandbox) ?? "read-only";
    if (source?.approval) {
      options.approval = source.approval;
    }
    options.configScope = "managed";
    options.addDirs = Array.isArray(source?.addDirs) ? [...source.addDirs] : [];
    options.enableFeatures = Array.isArray(source?.enableFeatures)
      ? [...source.enableFeatures]
      : [];
    options.disableFeatures = Array.isArray(source?.disableFeatures)
      ? [...source.disableFeatures]
      : [];
    if (Array.isArray(source?.configOverrides)) {
      options.configOverrides = source.configOverrides.map((entry) =>
        createConfigRow({ key: entry.key, value: entry.value ?? "" }),
      );
    }
    options.workingDirectoryMode = "project";
    options.customWorkingDirectory = "";
    options.historyPersistence = source?.historyPersistence ?? "none";
    options.approval = resolveCodexApprovalPolicy(
      options.permissionMode,
      scope === "agent" ? basicForm.tool_approval_mode : "off",
      scope,
    );
    return options;
  }

  function normaliseClaudeForm(
    agent: AgentRow | SubagentRow | null,
    _scope: CliSettingsScope = "agent",
  ): ClaudeFormOptions {
    const options = createDefaultClaudeForm();
    if (!agent) return options;

    const source = agent.claude_settings ?? null;
    const providerSettings =
      !source && agent.provider_specific_settings
        ? agent.provider_specific_settings
        : null;

    const permission = source?.permissionMode ?? providerSettings?.claude_permission_mode;
    if (permission === "default" || permission === "acceptEdits" || permission === "plan" || permission === "bypassPermissions") {
      options.permissionMode = permission;
    } else if (permission === "chat") {
      options.permissionMode = "default";
    } else if (permission === "agent") {
      options.permissionMode = "acceptEdits";
    } else if (permission === "agent_full") {
      options.permissionMode = "bypassPermissions";
    }

    const modelValue =
      typeof source?.model === "string"
        ? source.model
        : typeof providerSettings?.claude_model === "string"
          ? providerSettings.claude_model
          : "";
    options.model = modelValue?.trim() ?? "";

    const alwaysThinking =
      typeof source?.alwaysThinkingEnabled === "boolean"
        ? source.alwaysThinkingEnabled
        : typeof providerSettings?.claude_always_thinking_enabled === "boolean"
          ? providerSettings.claude_always_thinking_enabled
          : typeof providerSettings?.claude_always_thinking === "boolean"
            ? providerSettings.claude_always_thinking
            : false;
    options.alwaysThinkingEnabled = alwaysThinking;

    const rawMaxThinking =
      source?.maxThinkingTokens ?? providerSettings?.claude_max_thinking_tokens ?? "";
    const normalizedMaxThinking =
      typeof rawMaxThinking === "number"
        ? String(rawMaxThinking)
        : typeof rawMaxThinking === "string"
          ? rawMaxThinking.trim()
          : "";
    options.maxThinkingTokens = alwaysThinking
      ? normalizedMaxThinking.length > 0
        ? normalizedMaxThinking
        : String(CLAUDE_DEFAULT_MAX_THINKING_TOKENS)
      : "";

    options.configScope = "managed";
    options.includeCoreSystemPrompt =
      source?.includeCoreSystemPrompt === true ||
      providerSettings?.claude_include_core_system_prompt === true;
    options.includeProjectInstructions =
      typeof source?.includeProjectInstructions === "boolean"
        ? source.includeProjectInstructions
        : typeof providerSettings?.claude_include_project_instructions === "boolean"
          ? providerSettings.claude_include_project_instructions
          : true;
    options.systemPromptMode = options.includeCoreSystemPrompt ? "default" : "replace";
    options.systemPrompt = options.includeCoreSystemPrompt
      ? ""
      : MODE4_PRELAUNCH_REPLACEMENT_PROMPT;
    options.systemPromptFile = "";

    options.chrome = Boolean(
      source?.chrome ?? providerSettings?.claude_chrome_enabled ?? false,
    );
    options.addDirs = Array.isArray(source?.addDirs)
      ? [...source.addDirs]
      : parseClaudeList(providerSettings?.claude_additional_dirs);
    options.allowedTools = Array.isArray(source?.allowedTools)
      ? [...source.allowedTools]
      : parseClaudeList(providerSettings?.claude_allowed_tools);
    options.disallowedTools = Array.isArray(source?.disallowedTools)
      ? [...source.disallowedTools]
      : parseClaudeList(providerSettings?.claude_disallowed_tools);
    if (Array.isArray(source?.configOverrides)) {
      options.configOverrides = source.configOverrides.map((entry) =>
        createConfigRow({ key: entry.key, value: entry.value ?? "" }),
      );
    } else if (Array.isArray(providerSettings?.claude_config_overrides)) {
      options.configOverrides = providerSettings.claude_config_overrides
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) =>
          createConfigRow({
            key: typeof entry.key === "string" ? entry.key : "",
            value:
              typeof entry.value === "string"
                ? entry.value
                : entry.value !== undefined
                  ? String(entry.value)
                  : "",
          }),
        )
        .filter((entry) => entry.key.trim().length > 0);
    }

    options.workingDirectoryMode = "project";
    options.customWorkingDirectory = "";

    return options;
  }

  function makeCodexSignature(
    form: CodexFormOptions,
    scope: CliSettingsScope = "agent",
  ) {
    return JSON.stringify({
      ...form,
      approval: resolveCodexApprovalPolicy(
        form.permissionMode,
        scope === "agent" ? basicForm.tool_approval_mode : "off",
        scope,
      ),
      includeProjectInstructions: form.includeProjectInstructions,
      addDirs: [...form.addDirs].sort(),
      enableFeatures: [...form.enableFeatures].sort(),
      disableFeatures: [...form.disableFeatures].sort(),
      configOverrides: form.configOverrides
        .map((row) => ({ key: row.key.trim(), value: row.value }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    });
  }

  function makeClaudeSignature(form: ClaudeFormOptions) {
    return JSON.stringify({
      ...form,
      includeCoreSystemPrompt: form.includeCoreSystemPrompt,
      includeProjectInstructions: form.includeProjectInstructions,
      model: form.model.trim(),
      alwaysThinkingEnabled: form.alwaysThinkingEnabled,
      maxThinkingTokens: form.maxThinkingTokens.trim(),
      systemPrompt: form.systemPrompt.trim(),
      systemPromptFile: form.systemPromptFile.trim(),
      customWorkingDirectory: form.customWorkingDirectory.trim(),
      addDirs: [...form.addDirs].sort(),
      allowedTools: [...form.allowedTools].sort(),
      disallowedTools: [...form.disallowedTools].sort(),
      configOverrides: form.configOverrides
        .map((row) => ({ key: row.key.trim(), value: row.value }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    });
  }

  type CliSettingsScope = "agent" | "subagent";

  function updateCodexForm(
    updater: (current: CodexFormOptions) => CodexFormOptions,
    scope: CliSettingsScope = "agent",
  ) {
    if (scope === "agent" ? primaryOwnedSaveInFlightUi : subagentOwnedSaveInFlightUi) return;
    if (scope === "subagent") {
      subagentCodexForm = updater(subagentCodexForm);
      return;
    }
    codexForm = updater(codexForm);
  }

  /**
   * SA-017, BL-910: the form for a Codex model the USER just picked. `xhigh` reasoning effort and
   * the `fast` service tier are only allowed for the models the static support sets name, so a pick
   * of a model outside them lowers the value in the pick itself (it shows, and it saves once).
   * Nothing else lowers them: opening an agent never changes the form, so a saved value the sets
   * do not know (a model outside Batshit's list) stays as saved; the server passes it through and
   * Codex itself validates it.
   */
  function codexFormForPickedModel(
    current: CodexFormOptions,
    model: string,
  ): CodexFormOptions {
    return {
      ...current,
      model,
      reasoningEffort:
        current.reasoningEffort === "xhigh" && !supportsCodexXhighReasoning(model)
          ? "high"
          : current.reasoningEffort,
      serviceTier:
        current.serviceTier === "fast" && !supportsCodexFastMode(model)
          ? "standard"
          : current.serviceTier,
    };
  }

  function updateClaudeForm(
    updater: (current: ClaudeFormOptions) => ClaudeFormOptions,
    scope: CliSettingsScope = "agent",
  ) {
    if (scope === "agent" ? primaryOwnedSaveInFlightUi : subagentOwnedSaveInFlightUi) return;
    if (scope === "subagent") {
      subagentClaudeForm = updater(subagentClaudeForm);
      return;
    }
    claudeForm = updater(claudeForm);
  }


  function serializeCodexForm(
    form: CodexFormOptions,
    scope: CliSettingsScope = "agent",
  ): CodexAgentSettings {
    return {
      permissionMode: form.permissionMode,
      includeProjectInstructions: form.includeProjectInstructions === true,
      model: form.model,
      reasoningEffort:
        form.reasoningEffort && form.reasoningEffort !== "default"
          ? form.reasoningEffort
          : undefined,
      serviceTier: form.serviceTier === "fast" ? "fast" : undefined,
      streamingEffect: true,
      unifiedExec: true,
      search: form.search,
      sandbox: form.sandbox,
      approval: resolveCodexApprovalPolicy(
        form.permissionMode,
        scope === "agent" ? basicForm.tool_approval_mode : "off",
        scope,
      ),
      configScope: "managed",
      addDirs: [...form.addDirs],
      enableFeatures: [...form.enableFeatures],
      disableFeatures: [...form.disableFeatures],
      configOverrides: form.configOverrides.map((row) => ({
        key: row.key.trim(),
        value: row.value,
      })),
      workingDirectoryMode: "project",
      customWorkingDirectory: undefined,
      historyPersistence: form.historyPersistence,
    };
  }

  function serializeClaudeForm(form: ClaudeFormOptions): ClaudeAgentSettings {
    const trimmedModel = form.model.trim();
    const trimmedMaxThinking = form.maxThinkingTokens.trim();
    const parsedMaxThinking = Number.parseInt(trimmedMaxThinking, 10);
    const thinkingEnabled = form.alwaysThinkingEnabled === true;
    const maxThinkingTokens = thinkingEnabled
      ? Number.isFinite(parsedMaxThinking) && parsedMaxThinking > 0
        ? parsedMaxThinking
        : CLAUDE_DEFAULT_MAX_THINKING_TOKENS
      : undefined;

    return {
      permissionMode: form.permissionMode,
      includeCoreSystemPrompt: form.includeCoreSystemPrompt === true,
      includeProjectInstructions: form.includeProjectInstructions === true,
      model: trimmedModel.length ? trimmedModel : undefined,
      alwaysThinkingEnabled: thinkingEnabled,
      maxThinkingTokens,
      configScope: "managed",
      systemPromptMode: form.includeCoreSystemPrompt ? "default" : "replace",
      systemPrompt: form.includeCoreSystemPrompt
        ? undefined
        : MODE4_PRELAUNCH_REPLACEMENT_PROMPT,
      systemPromptFile: undefined,
      chrome: form.chrome === true ? true : false,
      addDirs: [...form.addDirs],
      allowedTools: [...form.allowedTools],
      disallowedTools: [...form.disallowedTools],
      configOverrides: form.configOverrides.map((row) => ({
        key: row.key.trim(),
        value: row.value,
      })),
      workingDirectoryMode: "project",
      customWorkingDirectory: undefined,
    };
  }

  function setCodexPermissionMode(mode: CodexPermissionMode, scope: CliSettingsScope = "agent") {
    const preset = CODEX_PERMISSION_PRESETS[mode];
    updateCodexForm((current) => ({
      ...current,
      permissionMode: mode,
      sandbox: preset.sandbox,
    }), scope);
  }

  function setClaudePermissionMode(mode: ClaudePermissionMode, scope: CliSettingsScope = "agent") {
    updateClaudeForm((current) => ({
      ...current,
      permissionMode: mode,
    }), scope);
  }

  function addCodexListValue(
    key: "addDirs" | "enableFeatures" | "disableFeatures",
    value: string,
    scope: CliSettingsScope = "agent",
  ) {
    const trimmed = value.trim();
    if (!trimmed) return;
    updateCodexForm((current) => {
      if (current[key].includes(trimmed)) {
        return current;
      }
      return {
        ...current,
        [key]: [...current[key], trimmed],
      };
    }, scope);
  }

  function removeCodexListValue(
    key: "addDirs" | "enableFeatures" | "disableFeatures",
    index: number,
    scope: CliSettingsScope = "agent",
  ) {
    updateCodexForm((current) => ({
      ...current,
      [key]: current[key].filter((_, idx) => idx !== index),
    }), scope);
  }

  function addClaudeListValue(
    key: "addDirs" | "allowedTools" | "disallowedTools",
    value: string,
    scope: CliSettingsScope = "agent",
  ) {
    const trimmed = value.trim();
    if (!trimmed) return;
    updateClaudeForm((current) => {
      if (current[key].includes(trimmed)) {
        return current;
      }
      return {
        ...current,
        [key]: [...current[key], trimmed],
      };
    }, scope);
  }

  function removeClaudeListValue(
    key: "addDirs" | "allowedTools" | "disallowedTools",
    index: number,
    scope: CliSettingsScope = "agent",
  ) {
    updateClaudeForm((current) => ({
      ...current,
      [key]: current[key].filter((_, idx) => idx !== index),
    }), scope);
  }

  // BL-499: this switch (Agent Settings' "Allow Claude Web Search") is driven by
  // `disallowedTools` alone, from the shared, unit-tested `claudeToolSwitch` module — never
  // `allowedTools`, and never reimplemented inline here. Claude Code reads `allowedTools` as
  // "skip the permission prompt for these", not "only these tools work", so a tool absent from
  // it still runs normally; consulting it here used to show the switch OFF for a tool that was
  // still fully working the moment any OTHER Allowed Tools entry existed, and could silently
  // erase an existing denial when turning it OFF in that state.
  function getClaudeToolEnabled(toolName: string, scope: CliSettingsScope = "agent") {
    const form = scope === "subagent" ? subagentClaudeForm : claudeForm;
    return isClaudeToolEnabled(form.disallowedTools, toolName);
  }

  function setClaudeToolEnabled(
    toolName: string,
    enabled: boolean,
    scope: CliSettingsScope = "agent",
  ) {
    updateClaudeForm((current) => {
      const nextDisallowed = withClaudeToolEnabled(current.disallowedTools, toolName, enabled);
      if (nextDisallowed === current.disallowedTools) return current;
      return {
        ...current,
        disallowedTools: nextDisallowed,
      };
    }, scope);
  }

  function addCodexConfig(scope: CliSettingsScope = "agent") {
    updateCodexForm((current) => ({
      ...current,
      configOverrides: [...current.configOverrides, createConfigRow()],
    }), scope);
  }

  function updateCodexConfig(
    id: string,
    field: "key" | "value",
    value: string,
    scope: CliSettingsScope = "agent",
  ) {
    updateCodexForm((current) => ({
      ...current,
      configOverrides: current.configOverrides.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    }), scope);
  }

  function removeCodexConfig(id: string, scope: CliSettingsScope = "agent") {
    updateCodexForm((current) => ({
      ...current,
      configOverrides: current.configOverrides.filter((row) => row.id !== id),
    }), scope);
  }

  function addClaudeConfig(scope: CliSettingsScope = "agent") {
    updateClaudeForm((current) => ({
      ...current,
      configOverrides: [...current.configOverrides, createConfigRow()],
    }), scope);
  }

  function updateClaudeConfig(
    id: string,
    field: "key" | "value",
    value: string,
    scope: CliSettingsScope = "agent",
  ) {
    updateClaudeForm((current) => ({
      ...current,
      configOverrides: current.configOverrides.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    }), scope);
  }

  function removeClaudeConfig(id: string, scope: CliSettingsScope = "agent") {
    updateClaudeForm((current) => ({
      ...current,
      configOverrides: current.configOverrides.filter((row) => row.id !== id),
    }), scope);
  }

  function sortMcpSelections(selections: MCPToolSelections): MCPToolSelections {
    // SA-009: MCPToolSelections is now a flat string[], just sort it
    if (!Array.isArray(selections)) return [];
    return [...selections].sort();
  }

  function normaliseStringOrNull(value: string) {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  /**
   * What a save names, as a copy takes it. The Codex and Claude settings and the Tool Grid display
   * settings are written key by key (BL-848, BL-855), so a save of them names only the keys (or
   * map entries) it changed, a removed one as `null`, and a copy takes them the way the server
   * does (`applyAgentBlockUpdate`), never as a whole replacement of the block.
   */
  type AgentCollectionsUpdate = Omit<Partial<AgentRow>, AgentFieldByFieldBlock> & {
    [Field in AgentFieldByFieldBlock]?: AgentBlockSaveByField[Field] | null;
  };

  function updateAgentCollections(id: string, updates: AgentCollectionsUpdate) {
    // BL-514: a saved block is laid over each copy the way the agent PUT stores it (model keys
    // replaced, the agent's own keys kept unless named), each over its own copy: the store's
    // may hold a newer chat-bar change than this panel's list.
    const hasProviderSettings = "provider_specific_settings" in updates;
    const plainUpdates: Record<string, unknown> = { ...updates };
    for (const field of AGENT_FIELD_BY_FIELD_BLOCKS) delete plainUpdates[field];
    const layBlocks = (copy: object | null | undefined): Record<string, unknown> => {
      const laid: Record<string, unknown> = {};
      for (const field of AGENT_FIELD_BY_FIELD_BLOCKS) {
        if (field in updates) {
          laid[field] = applyAgentBlockUpdate(
            field,
            (copy as Record<string, unknown> | null | undefined)?.[field],
            updates[field],
          );
        }
      }
      return laid;
    };
    agents = agents.map((agent) =>
      agent.id === id
        ? ({
            ...agent,
            ...plainUpdates,
            ...(hasProviderSettings
              ? {
                  provider_specific_settings: applyAgentProviderSettingsUpdate(
                    agent.provider_specific_settings,
                    updates.provider_specific_settings,
                  ),
                }
              : {}),
            ...layBlocks(agent),
          } as AgentRow)
        : agent,
    );
    const storeUpdates: Record<string, unknown> = { ...plainUpdates };
    if (hasProviderSettings) {
      storeUpdates.provider_specific_settings = applyAgentProviderSettingsUpdate(
        agentStore.getAgentById(id)?.provider_specific_settings,
        updates.provider_specific_settings,
      );
    }
    Object.assign(storeUpdates, layBlocks(agentStore.getAgentById(id)));
    if (
      "assigned_subagent_ids" in updates &&
      Array.isArray(updates.assigned_subagent_ids)
    ) {
      storeUpdates.assignedSubagents = updates.assigned_subagent_ids;
    }
    agentStore.updateAgent(id, storeUpdates as Partial<AgentStoreRecord>);
  }

  function mapToStoreAgent(agent: AgentRow): AgentStoreRecord {
    return {
      ...agent,
      avatar_url: agent.avatar ?? agent.avatar_url,
      assignedSubagents:
        agent.assigned_subagent_ids ?? agent.assignedSubagents ?? [],
    } as AgentStoreRecord;
  }

  function getInitials(name: string) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "A";
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    const first = parts[0][0] ?? "";
    const last = parts[parts.length - 1][0] ?? "";
    return `${first}${last}`.toUpperCase();
  }

  function formatSubagentBadge(subagent: SubagentRow) {
    return getSubagentTypeShortLabel(
      normalizeSubagentType(subagent, subagent.subagentType),
    );
  }

  const TYPE_BADGE_BASE =
    "batshit-agent-type-badge";

  function formatPrimaryAgentTypeLabel(
    type: StoredPrimaryAgentType,
  ) {
    return `${getPrimaryAgentDisplayLabel(type)} Primary Agent`;
  }

  function formatSubagentTypeLabel(type: StoredSubagentType) {
    return getSubagentTypeDisplayLabel(type);
  }

  function primaryTypeBadgeClass(type: StoredPrimaryAgentType) {
    return `${TYPE_BADGE_BASE} is-agent-type-${type}`;
  }

  function subagentTypeBadgeClass(type: StoredSubagentType) {
    return `${TYPE_BADGE_BASE} is-agent-type-${getSubagentTypeBadgeTone(type)}`;
  }

  function formatCompatibleSubagentTypes(primaryAgentType: StoredPrimaryAgentType) {
    return getCompatibleSubagentTypesForPrimaryAgent(primaryAgentType)
      .map((type) => getSubagentTypeDisplayLabel(type))
      .join(" or ");
  }

  function getPrimaryToolHostScope(type: StoredPrimaryAgentType): ToolHostScope {
    return type === "cli" ? "cli" : "api";
  }

  function getSubagentToolHostScope(type: StoredSubagentType): ToolHostScope {
    if (type === "cli") return "cli";
    return type === "api" ? "api" : "n8n";
  }

  async function copyId(value: string | null | undefined, label: string) {
    if (!value) return;
    try {
      await copyTextToClipboard(value);
      toast.success(`${label} copied`);
    } catch (error) {
      console.error(`Failed to copy ${label.toLowerCase()}:`, error);
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    }
  }

  function formatCliLoginHelp(setupContext: string | undefined, setupWorkingDirectory?: string) {
    if (setupContext === "docker") {
      return setupWorkingDirectory?.trim()
        ? "Open Terminal, go to the Batshit Docker folder shown below, then run this login command once."
        : "Open Terminal, go to your Batshit Docker install folder, then run this login command once.";
    }

    return "Open Terminal and run this once.";
  }

  function formatCliLoginNote(option: CatalogConnectionOption | null | undefined) {
    if (option?.id !== "claude-cli") return null;

    return 'Claude Code on Windows may hide pasted auth-code input. At "Paste code here if prompted", paste the browser code, then press Enter even if no text appears.';
  }

  async function fetchManagedConfig(provider: ManagedConfigProvider) {
    const isSubagent = selectedEntity?.kind === "subagent";
    const targetId = isSubagent ? selectedEditableSubagentId : selectedAgentId;
    if (!targetId) {
      throw new Error(`Select a ${isSubagent ? "subagent" : "primary agent"} first.`);
    }

    const basePath = isSubagent
      ? `/api/subagents/${targetId}/managed-config`
      : `/api/agents/${targetId}/managed-config`;
    const response = await fetch(`${basePath}?provider=${provider}`);
    if (!response.ok) {
      throw new Error(await extractError(response, "Failed to load managed config"));
    }

    return (await response.json()) as {
      provider: ManagedConfigProvider;
      fileName: string;
      path: string;
      contents: string;
    };
  }

  async function openManagedConfigViewer(provider: ManagedConfigProvider) {
    managedConfigDialogOpen = true;
    managedConfigLoading = true;
    managedConfigError = null;
    managedConfigProvider = provider;
    managedConfigFileName = provider === "codex" ? "config.toml" : "settings.json";
    managedConfigPath = "";
    managedConfigContents = "";

    try {
      const payload = await fetchManagedConfig(provider);
      managedConfigProvider = payload.provider;
      managedConfigFileName = payload.fileName;
      managedConfigPath = payload.path;
      managedConfigContents = payload.contents;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load managed config";
      managedConfigError = message;
      toast.error(message);
    } finally {
      managedConfigLoading = false;
    }
  }

  async function copyManagedConfigPath(provider: ManagedConfigProvider) {
    try {
      const payload = await fetchManagedConfig(provider);
      await copyId(payload.path, `${payload.fileName} path`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy managed config path";
      toast.error(message);
    }
  }

  function getManagedConfigDialogTitle() {
    if (managedConfigProvider === "codex") return "Managed Codex config.toml";
    if (managedConfigProvider === "claude") return "Managed Claude settings.json";
    return "Managed Config";
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const data = await response.json();
      if (data?.error) return data.error;
      if (typeof data === "string") return data;
      return fallback;
    } catch {
      return fallback;
    }
  }

  // P1's direct target seam never invokes create, Save, or a queued human continuation.
  export function readAppActionState() {
    const subagent = selectedEntity?.kind === "subagent";
    return {
      entityId: selectedEntity?.kind === "agent" ? selectedAgentId : null,
      busy: listLoading || detailLoading || hydrationInProgress || subagentDetailLoading || primaryOwnedWritePendingUi || subagentOwnedWritePendingUi,
      dirty: createEntityMode || (subagent
        ? subagentPersistedSignature !== null && !Object.values(subagentSectionsAtRest()).every(Boolean)
        : hydratedAgentId === selectedAgentId && selectedAgentId !== null && !Object.values(agentSectionsAtRest()).every(Boolean)),
      error: listError ?? (subagent ? subagentReadWaitError : primaryReadWaitError)
    };
  }
  export function selectAppActionTarget(target: SettingsTarget, context: ActionContext) {
    context.check();
    if (appActionsHaveDrafts()) refuse("unsaved_changes");
    if (!target.agentId || !agents.some(agent => agent.id === target.agentId)) refuse("missing_entity");
    if (readAppActionState().busy) refuse("busy");
    selectAgent(target.agentId);
  }

</script>

{#if listLoading}
  <div
    class="batshit-settings-empty-state"
  >
    <div class="batshit-settings-caption flex items-center gap-3">
      <Loader2 class="h-4 w-4 animate-spin" />
      Loading Agents…
    </div>
  </div>
{:else if listError}
  <div
    class="batshit-settings-inline-alert is-danger flex flex-col items-center justify-center gap-4 text-center"
  >
    <div class="flex items-center gap-2">
      <AlertCircle class="h-4 w-4" />
      {listError}
    </div>
    <Button variant="outline" size="sm" onclick={loadAgents}>
      <RefreshCcw  />
      Retry
    </Button>
  </div>
{:else if agents.length === 0}
  <div class="space-y-8">
    <Card.Root>
      <Card.Header>
        <Card.Title class="flex items-center gap-2">
          <Users class="h-4 w-4" />
          <span>No Agents found</span>
          <SettingsInfoMenu ariaLabel="About No Agents Found">
            Create your first Primary Agent here. Once saved it will appear in the
            selector automatically.
          </SettingsInfoMenu>
        </Card.Title>
      </Card.Header>
      <Card.Content>
        <Button
          variant="outline"
          size="sm"
          disabled={createEntityMode}
          onclick={() => handleStartCreateEntity("agent")}
        >
          <Plus aria-hidden="true" />

          Create Primary Agent
        </Button>
      </Card.Content>
    </Card.Root>
  </div>
{:else}
  <div class="space-y-8">
    <AgentSelectorSection
      sections={combinedAgentSections}
      selectedId={combinedSelectedEntityId}
      disabled={createEntityMode}
      onSelectAgent={selectAgent}
      onSelectSubagent={selectSubagent}
      onCreateAgent={() => handleStartCreateEntity("agent")}
      onOpen={() => {
        void n8nRuntimeStatusStore.refreshN8nRuntimeStatus({ force: true });
      }}
    />

    {#if selectedEntity?.kind === "agent" && selectedAgentId}
      <!-- Primary Agent Settings Start -->
      <div class="batshit-settings-surface space-y-6">
              {#if primarySettingsReadWaiting || primaryOwnedSaveInFlightUi}
                <div class="batshit-settings-note is-dashed flex items-center gap-2" data-testid="primary-settings-read-wait" role="status">
                  {#if primaryReadWaitError || primarySaveWaitExpiredUi}
                    <AlertCircle class="h-4 w-4" />
                    <span>{primaryReadWaitError ?? "Your last change to this agent did not confirm within 30 seconds. Batshit does not know if it was saved. Retry reads the record."}</span>
                  {:else}
                    <Loader2 class="h-4 w-4 animate-spin" />
                    <span>Waiting for saved agent settings…</span>
                  {/if}
                  <Button variant="outline" size="sm" onclick={retryPrimarySettingsRead}>Retry</Button>
                </div>
              {/if}
              <fieldset disabled={primaryOwnedSaveInFlightUi} inert={primaryOwnedSaveInFlightUi} class="min-w-0 space-y-6 border-0 p-0 m-0">
              {#if detailLoading}
                <div
                  class="batshit-settings-note is-dashed flex items-center gap-2"
                >
                  <Loader2 class="h-4 w-4 animate-spin" />
                  Loading agent details…
                </div>
              {/if}

              <Tabs.Root bind:value={activeAgentSettingsTab} class="w-full">
                <Tabs.List class="flex w-full flex-wrap gap-2">
                  <Tabs.Trigger
                    value="core"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <BatshitIcon id="core-basic" class="h-3.5 w-3.5" />
                    <span>Core</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="tools"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <Wrench class="h-3.5 w-3.5" />
                    <span>Tools</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="instructions"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <BatshitIcon id="instructions" class="h-3.5 w-3.5" />
                    <span>Instructions</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="voice"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <Mic class="h-3.5 w-3.5" />
                    <span>Voice</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="access"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <BatshitIcon id="access" class="h-3.5 w-3.5" />
                    <span>Access</span>
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs.Root>

              {#if activeAgentSettingsTab === "tools"}
              <AgentMcpDefaultsCard
                agentId={selectedAgentId === CREATE_AGENT_SENTINEL ? null : selectedAgentId}
                toolHostScope={getPrimaryToolHostScope(basicForm.agentType)}
                userId={data?.user?.id ?? null}
                accordionName="agent-tools-cards"
                toolGridTitle="Agent Tool Grid Settings"
                defaultMCPGateways={defaultMCPGateways}
                defaultMCPToolSelections={defaultMCPToolSelections}
                defaultCliToolIds={defaultCliToolIds}
                cliToolIdsExplicit={cliToolIdsExplicit}
                dcmDisplaySettings={dcmDisplaySettings}
                mcpSaveState={mcpSaveState}
                mcpSaveError={mcpSaveError}
                mcpLastSaved={mcpLastSaved}
                mcpRenderNonce={mcpRenderNonce}
                nativeDynamicMcpEnabled={
                  getNativeToolToggle("dynamicMcpEnabled", true)
                }
                nativeCliToolsEnabled={getNativeToolToggle("cliToolsEnabled", true)}
                nativeToolSettings={getNativeToolsSettings("agent")}
                isCodexMode={isCliProvider}
                onGatewaysChange={guardPrimaryChoice(handleMcpGatewaysChange)}
                onDcmDisplaySettingsChange={guardPrimaryChoice(handleMcpDcmDisplaySettingsChange)}
                onCliToolIdsChange={guardPrimaryChoice(handleCliToolSelectionsChange)}
                getToolZipOverride={getMcpToolZipOverride}
                onToolZipOverrideChange={guardPrimaryChoice(handleMcpToolZipOverrideChange)}
                showZipControls={true}
                zipAiViewMode={zipForm.zip_ai_view_mode}
                zipToolNotesEnabled={zipForm.zip_tool_notes_enabled}
                nonMcpZipRows={NON_MCP_ZIP_ROW_ORDER}
                getNonMcpZipOverride={getNonMcpZipOverrideById}
                onNonMcpZipOverrideChange={guardPrimaryChoice(handleNonMcpZipOverrideChangeById)}
                onZipAiViewModeChange={guardPrimaryChoice(handleZipAiViewModeChange)}
                onZipToolNotesChange={guardPrimaryChoice(handleZipToolNotesChange)}
                onResetToGlobalSettings={resetToolGridToGlobalSettings}
                zipSaveState={zipSaveState}
                zipSaveError={zipSaveError}
                zipValidationError={zipValidationError}
                zipLastSaved={zipLastSaved}
                fullWidthTable={true}
              />
              {/if}

              <SettingsAccordionCard
                name="agent-core-cards"
                title="Basic Settings"
                batshitIcon="core-basic"
                open
                class={hiddenUnless("core")}
                contentClass="space-y-8"
                onfocusin={() => (basicSaveScope = "core")}
                onpointerdown={() => (basicSaveScope = "core")}
              >
                {#snippet actions()}
                  {#if basicSaveScope === "core"}
                    <SettingsSaveStatus
                      state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                      error={basicSaveError ?? basicValidationError}
                      savingLabel="Saving agent settings..."
                      savedLabel="Saved"
                    />
                  {/if}
                {/snippet}

                  <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
                    <div class="space-y-5">
                      <div class="batshit-settings-form-stack">
                        <div class="batshit-settings-identity-block">
                          <div class="batshit-settings-identity-name-row">
                            <div class="batshit-settings-form-copy">
                              <div class="batshit-settings-form-label-line">
                                <Label.Label class="batshit-settings-form-label" for="agent-display">
                                  Agent Display Name
                                </Label.Label>
                              </div>
                            </div>
                            <div class="batshit-settings-form-control">
                              <Input
                                id="agent-display"
                                placeholder="Agent name"
                                bind:value={basicForm.displayName}
                              />
                            </div>
                          </div>
                          <div class="batshit-settings-identity-meta-row">
                            <div class="batshit-settings-identity-meta-item">
                              <span class="whitespace-nowrap">Agent ID:</span>
                              <span class="batshit-settings-code-caption">{selectedAgentId ?? "—"}</span>
                              <Button
                                variant="ghost"
                                size="icon"

                                onclick={() => copyId(selectedAgentId, "Agent ID")}
                                disabled={!selectedAgentId}
                                title="Copy Agent ID"
                              >
                                <Copy  />
                              </Button>
                            </div>
                            <div class="batshit-settings-identity-meta-item">
                              <span class="whitespace-nowrap">Agent Type:</span>
                              <span class={primaryTypeBadgeClass(basicForm.agentType)}>
                                {formatPrimaryAgentTypeLabel(basicForm.agentType)}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div class="batshit-settings-form-row">
                          <div class="batshit-settings-form-copy">
                            <div class="batshit-settings-form-label-line">
                              <Label.Label class="batshit-settings-form-label">Default Model</Label.Label>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger
                                  class={SETTINGS_INFO_TRIGGER_CLASS}
                                  aria-label="About Default Model"
                                >
                                  <Info class="h-3.5 w-3.5" />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content
                                  align="start"
                                  side="bottom"
                                  class={SETTINGS_INFO_CONTENT_CLASS}
                                >
                                  This model is used automatically for this Primary Agent, but it can be updated in the chat bar too.
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </div>
                          </div>
                          <div class="batshit-settings-form-control">
                            <div class="batshit-settings-form-control-group">
                              <div class="batshit-settings-field-cluster">
                                <div class="batshit-settings-field-lane">
                                  <Select.Root
                                    type="single"
                                    value={(selectedModelId ?? "") as unknown as string}
                                    onValueChange={guardPrimaryChoice((value) =>
                                      handleAgentModelChange(
                                        Array.isArray(value) ? value[0] : value,
                                      ))}
                                  >
                                    <Select.Trigger class="w-full justify-between">
                                      {#if selectedModelId}
                                        {@const selected = savedModels.find(
                                          (item) => item.id === selectedModelId,
                                        )}
                                        <div class="flex min-w-0 items-center gap-2">
                                          <ModelProviderIcon
                                            modelId={selected?.modelId ?? basicForm.primary_model_name}
                                            modelName={selected?.modelName ?? basicForm.primary_model_name}
                                            provider={selected?.provider ?? basicForm.primary_model_provider ?? ""}
                                            size="md"
                                            badgeProvider={selected ? getSavedModelBadgeProvider(selected) : undefined}
                                          />
                                          <span class="truncate">{selected?.modelName ?? basicForm.primary_model_name ?? selectedModelId}</span>
                                          {#if resolveModelVoiceSessionConfig(selected)}
                                            <Badge variant="outline" class="batshit-settings-child-label">Speech-to-speech</Badge>
                                          {/if}
                                        </div>
                                      {:else}
                                        <span class="batshit-settings-caption">
                                          Choose a Saved Model
                                        </span>
                                      {/if}
                                    </Select.Trigger>
                                    <Select.Content>
                                      {#if savedModelsLoading}
                                        <Select.Label>Loading Models…</Select.Label>
                                      {:else if agentModelMenuItems.length === 0}
                                        <Select.Label>No Saved Models Yet</Select.Label>
                                      {:else}
                                        {#each agentModelMenuItems as item (item.model.id)}
                                          {@const model = item.model}
                                          {@const availability = item.availability}
                                          <Select.Item
                                            value={model.id}
                                            disabled={availability.disabled}
                                          >
                                            <div class="flex items-center gap-2 w-full">
                                              <ModelProviderIcon
                                                modelId={model.modelId}
                                                modelName={model.modelName}
                                                provider={model.provider}
                                                size="md"
                                                badgeProvider={getSavedModelBadgeProvider(model)}
                                              />
                                            <div class="flex flex-col min-w-0">
                                                <div class="flex min-w-0 items-center gap-1.5">
                                                  <span class="truncate">{model.modelName}</span>
                                                  {#if resolveModelVoiceSessionConfig(model)}
                                                    <Badge variant="outline" class="batshit-settings-child-label">Speech-to-speech</Badge>
                                                  {/if}
                                                </div>
                                                <span class="batshit-settings-caption batshit-model-id truncate">{model.modelId}</span>
                                              </div>
                                              {#if availability.disabled}
                                                <span class="ml-auto flex max-w-[140px] items-center gap-1 truncate text-[11px] text-muted-foreground">
                                                  <Lock class="h-3 w-3 shrink-0" />
                                                  <span class="truncate">{availability.reason}</span>
                                                </span>
                                              {:else if isCliLoginSetupConnectionOption(availability.connectionOption)}
                                                <span class="ml-auto flex max-w-[140px] items-center gap-1 truncate text-[11px] text-amber-600 dark:text-amber-400">
                                                  <AlertCircle class="h-3 w-3 shrink-0" />
                                                  <span class="truncate">Login needed</span>
                                                </span>
                                              {/if}
                                            </div>
                                          </Select.Item>
                                        {/each}
                                      {/if}
                                    </Select.Content>
                                  </Select.Root>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  class="batshit-button-shrink-0"
                                  onclick={refreshModelPickerData}
                                  disabled={savedModelsLoading || modelConnectionOptionsLoading}
                                  title="Refresh Saved Models"
                                >
                                  <RefreshCcw
                                    class={`${savedModelsLoading || modelConnectionOptionsLoading ? "animate-spin" : ""}`}
                                  />
                                </Button>
                              </div>

                              {#if selectedModelId}
                                {#if selectedPrimaryModelAvailability?.disabled}
                                  <p class="batshit-settings-form-meta is-warning">
                                    {selectedPrimaryModelAvailability.reason}
                                  </p>
                                {/if}
                              {/if}
                              {#each cliConnectionSetups as cliConnectionSetup (cliConnectionSetup.id)}
                                {@const cliLoginCommandLabel = `${cliConnectionSetup.label} login command`}
                                {@const cliLoginNote = formatCliLoginNote(cliConnectionSetup)}
                                <div class="batshit-settings-inline-alert is-dashed space-y-2">
                                  <div>
                                    <p class="batshit-settings-parent-label">{cliConnectionSetup.label} login needed</p>
                                    <p class="batshit-settings-form-meta">
                                      {formatCliLoginHelp(
                                        cliConnectionSetup.setupContext,
                                        cliConnectionSetup.setupWorkingDirectory,
                                      )}
                                    </p>
                                    {#if cliConnectionSetup.setupContext === "docker" && cliConnectionSetup.setupWorkingDirectory}
                                      <p class="batshit-settings-form-meta">
                                        Run from:
                                        <code class="break-all rounded px-1 py-0.5">
                                          {cliConnectionSetup.setupWorkingDirectory}
                                        </code>
                                      </p>
                                    {/if}
                                    {#if cliLoginNote}
                                      <p class="batshit-settings-form-meta is-warning">
                                        {cliLoginNote}
                                      </p>
                                    {/if}
                                  </div>
                                  <div class="flex items-center gap-2">
                                    <code class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded px-2 py-1 text-[11px]">
                                      {cliConnectionSetup.setupCommand}
                                    </code>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      class="h-8 w-8 shrink-0"
                                      title={`Copy ${cliLoginCommandLabel}`}
                                      aria-label={`Copy ${cliLoginCommandLabel}`}
                                      onclick={() =>
                                        copyId(
                                          cliConnectionSetup.setupCommand,
                                          cliLoginCommandLabel,
                                        )}
                                    >
                                      <Copy class="h-4 w-4" />
                                    </Button>
                                  </div>
                                </div>
                              {/each}
                              {#if isCliPrimaryAgentType(basicForm.agentType)}
                                {#if isCodexProvider || !isClaudeCliProvider}
                                  <CliRuntimeManagerCard
                                    runtime="codex"
                                    onChanged={refreshModelPickerData}
                                  />
                                {/if}
                                {#if isClaudeCliProvider || !isCodexProvider}
                                  <CliRuntimeManagerCard
                                    runtime="claude"
                                    onChanged={refreshModelPickerData}
                                  />
                                {/if}
                              {/if}
                              {#if isManagedPrimaryAgentType(basicForm.agentType) && modelConnectionOptionsLoading}
                                <p class="batshit-settings-form-meta">
                                  Loading connection status…
                                </p>
                              {:else if isManagedPrimaryAgentType(basicForm.agentType) && modelConnectionOptionsError}
                                <p class="batshit-settings-form-meta is-error">{modelConnectionOptionsError}</p>
                              {/if}
                              {#if savedModelsError}
                                <p class="batshit-settings-form-meta is-error">{savedModelsError}</p>
                              {/if}
                            </div>
                          </div>
                        </div>

                        {#if isManagedPrimaryAgentType(basicForm.agentType)}
                          <div class="batshit-settings-toggle-row is-spine-toggle">
                            <div class="flex min-w-0 items-center gap-1.5">
                              <span class="batshit-settings-parent-label">Display Reasoning</span>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger
                                  class={SETTINGS_INFO_TRIGGER_CLASS}
                                  aria-label="About Display Reasoning"
                                >
                                  <Info class="h-3.5 w-3.5" />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content
                                  align="start"
                                  side="bottom"
                                  class={SETTINGS_INFO_CONTENT_CLASS}
                                >
                                  When enabled, Batshit streams reasoning summaries into chat in a collapsed section whenever the model provides them, then saves them with the message so they remain visible after refresh. When disabled, supported runtimes may still capture reasoning internally only to recover an unfinished response after you interrupt it.
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </div>
                            <Switch.Root
                              bind:checked={basicForm.show_reasoning}
                              disabled={!isManagedPrimaryAgentType(basicForm.agentType)}
                            />
                          </div>

                          {#if basicForm.show_reasoning}
                            <div class="batshit-settings-toggle-row is-child is-spine-toggle">
                              <div class="flex min-w-0 items-center gap-1.5">
                                <span class="batshit-settings-child-label">Preserve Reasoning In Chat History</span>
                                <DropdownMenu.Root>
                                  <DropdownMenu.Trigger
                                    class={SETTINGS_INFO_TRIGGER_CLASS}
                                    aria-label="About Preserving Reasoning In Chat History"
                                  >
                                    <Info class="h-3.5 w-3.5" />
                                  </DropdownMenu.Trigger>
                                  <DropdownMenu.Content
                                    align="start"
                                    side="bottom"
                                    class={SETTINGS_INFO_CONTENT_CLASS}
                                  >
                                    Reasoning shown in chat is always saved and still appears after refresh. Turn this on to also include this agent's prior reasoning in later model requests and in the Execution Viewer's Compiled Messages. Leaving it off keeps completed-turn reasoning visible to you but hidden from the agent's later context, which saves tokens. If you interrupt a response, Batshit temporarily gives that unfinished reasoning back to the same agent until it completes one successful response, regardless of this setting.
                                  </DropdownMenu.Content>
                                </DropdownMenu.Root>
                              </div>
                              <Switch.Root bind:checked={basicForm.preserve_reasoning} />
                            </div>
                          {/if}
                        {/if}

                        <div class={`batshit-settings-form-row ${assignableGoons.length === 0 ? "is-tall" : ""}`}>
                          <div class="batshit-settings-form-copy">
                            <div class="batshit-settings-form-label-line">
                              <Label.Label class="batshit-settings-form-label">Assigned 3D Goon</Label.Label>
                            </div>
                            {#if assignableGoons.length === 0}
                              <p class="batshit-settings-form-help">
                                No ready Goons yet. Create or finish preparing one in Settings → 3D Goons.
                              </p>
                            {/if}
                          </div>
                          <div class="batshit-settings-form-control">
                            <Select.Root
                              type="single"
                              value={basicForm.goon_id || "none"}
                              onValueChange={guardPrimaryChoice((value: string) =>
                                (basicForm = {
                                  ...basicForm,
                                  goon_id: value === "none" ? null : value,
                                }))}
                            >
                              <Select.Trigger class="w-full">
                                {basicForm.goon_id
                                  ? goons.find((entry) => entry.id === basicForm.goon_id)
                                      ?.name || "Select Goon"
                                  : "None"}
                              </Select.Trigger>
                              <Select.Content>
                                <Select.Item value="none">None</Select.Item>
                                {#each assignableGoons as goon}
                                  <Select.Item value={goon.id}>{goon.name}</Select.Item>
                                {/each}
                              </Select.Content>
                            </Select.Root>
                          </div>
                        </div>

                        <AgentAutoCompactSettingsCard
                          settings={basicForm.auto_compact_settings}
                          {savedModels}
                          {savedModelsLoading}
                          {savedModelsError}
                          onRefreshModels={refreshModelPickerData}
                          onChange={guardPrimaryChoice((nextSettings) =>
                            (basicForm = {
                              ...basicForm,
                              auto_compact_settings: nextSettings,
                            }))}
                        />

                        <AgentMemorySettingsCard
                          draft={basicForm.memory_settings}
                          {savedModels}
                          onChange={guardPrimaryChoice((nextDraft) =>
                            (basicForm = {
                              ...basicForm,
                              memory_settings: nextDraft,
                            }))}
                        />

                        <AgentDmsSettingsCard
                          dmsEnabled={basicForm.dms_enabled}
                          dmSenderScope={basicForm.dm_sender_scope}
                          dmSenderAgentIds={basicForm.dm_sender_agent_ids}
                          senderCandidates={dmSenderCandidates}
                          onDmsEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, dms_enabled: enabled }))}
                          onDmSenderScopeChange={guardPrimaryChoice((scope) =>
                            (basicForm = { ...basicForm, dm_sender_scope: scope }))}
                          onDmSenderAgentIdsChange={guardPrimaryChoice((agentIds) =>
                            (basicForm = {
                              ...basicForm,
                              dm_sender_agent_ids: agentIds,
                            }))}
                          wakeEnabled={basicForm.wake_enabled}
                          wakeTimeoutMinutes={basicForm.wake_timeout_minutes}
                          wakeTarget={basicForm.wake_target}
                          onWakeEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, wake_enabled: enabled }))}
                          onWakeTimeoutMinutesChange={guardPrimaryChoice((minutes) =>
                            (basicForm = {
                              ...basicForm,
                              wake_timeout_minutes: minutes,
                            }))}
                          onWakeTargetChange={guardPrimaryChoice((target) =>
                            (basicForm = { ...basicForm, wake_target: target }))}
                        />

                        <AgentJevJuiceSettingsCard
                          skillToolHintsEnabled={basicForm.jev_juice_skill_tool_hints}
                          judgeToolEnabled={basicForm.jev_juice_judge_tool}
                          memoryRerankEnabled={basicForm.jev_juice_memory_rerank}
                          memoryRecallEnabled={basicForm.jev_juice_memory_recall}
                          replyCheckEnabled={basicForm.jev_juice_reply_check}
                          styleCoachEnabled={basicForm.jev_juice_style_coach}
                          memoryEnabled={basicForm.memory_settings?.enabled === true}
                          onSkillToolHintsEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, jev_juice_skill_tool_hints: enabled }))}
                          onJudgeToolEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, jev_juice_judge_tool: enabled }))}
                          onMemoryRerankEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, jev_juice_memory_rerank: enabled }))}
                          onMemoryRecallEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, jev_juice_memory_recall: enabled }))}
                          onReplyCheckEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, jev_juice_reply_check: enabled }))}
                          onStyleCoachEnabledChange={guardPrimaryChoice((enabled) =>
                            (basicForm = { ...basicForm, jev_juice_style_coach: enabled }))}
                        />

                      </div>
                    </div>

                    <div class="space-y-4">
                      <div class="batshit-settings-card batshit-settings-card-subtle-frame is-spacious space-y-3">
                        <div class="flex flex-col items-start gap-4">
                          <EntityAvatar
                            avatarUrl={basicForm.avatar_url}
                            iconRef={basicForm.avatar_icon_ref}
                            iconFit={basicForm.avatar_icon_fit}
                            label={basicForm.displayName || "Agent"}
                            fallback={basicForm.displayName || "Agent"}
                            class="batshit-settings-avatar-preview"
                            iconClass="text-muted-foreground"
                          />
                          <div class="w-full space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onclick={() => agentAvatarInput?.click()}
                                disabled={isUploadingAgentAvatar}
                              >
                                {#if isUploadingAgentAvatar}
                                  <Loader2 class="animate-spin" />
                                  Uploading…
                                {:else}
                                  <UploadCloud  />
                                  Upload Avatar
                                {/if}
                              </Button>
                              <IconPicker
                                bind:value={basicForm.avatar_icon_ref}
                                triggerLabel="Use Icon"
                                onSelect={chooseAgentAvatarIcon}
                              />
                              {#if basicForm.avatar_url}
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  class="is-danger"
                                  onclick={clearAgentAvatar}
                                  disabled={isUploadingAgentAvatar}
                                  title="Remove Avatar"
                                  aria-label="Remove Avatar"
                                >
                                  <Trash2  />
                                </Button>
                              {/if}
                            </div>
                            {#if agentAvatarError}
                              <p class="batshit-settings-form-help is-danger">{agentAvatarError}</p>
                            {/if}
                          </div>
                          <input
                            class="hidden"
                            type="file"
                            accept="image/*"
                            bind:this={agentAvatarInput}
                            onchange={handleAgentAvatarUpload}
                          />
                        </div>
                      </div>

                    </div>
                  </div>

              </SettingsAccordionCard>
          {#if isClaudeCliProvider}
            <SettingsAccordionCard
              name="agent-core-cards"
              title="Claude Code CLI Defaults"
              batshitIcon="cli-tools"
              class={hiddenUnless("core")}
              onfocusin={() => (claudeSaveScope = "core")}
              onpointerdown={() => (claudeSaveScope = "core")}
            >
              {#snippet actions()}
                {#if claudeSaveScope === "core"}
                  <SettingsSaveStatus
                    state={claudeSaveError ? "error" : claudeSaveState}
                    error={claudeSaveError}
                    savingLabel="Saving Claude defaults..."
                    savedLabel="Saved"
                  />
                {/if}
              {/snippet}
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Default Claude Model</Label.Root>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger
                            class={SETTINGS_INFO_TRIGGER_CLASS}
                            aria-label="About Default Claude Model"
                          >
                            <Info class="h-3.5 w-3.5" />
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content
                            align="start"
                            side="bottom"
                            class={SETTINGS_INFO_CONTENT_CLASS}
                          >
                            Passed to <code>claude --model</code>. Choose CLI default to let Claude decide.
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={claudeForm.model.length ? claudeForm.model : "default"}
                        onValueChange={guardPrimaryChoice((value) => {
                          const nextValue = (Array.isArray(value) ? value[0] : value) as string;
                          updateClaudeForm((current) => ({
                            ...current,
                            model: nextValue === "default" ? "" : nextValue,
                          }));
                        })}
                      >
                        <Select.Trigger class="w-full">
                          {@const label = claudeForm.model.length
                            ? CLAUDE_CLI_MODEL_CHOICES.find((option) => option.value === claudeForm.model)?.label ?? claudeForm.model
                            : "CLI default"}
                          <div class="flex items-center gap-2">
                            <ModelProviderIcon
                              modelId={claudeForm.model.length ? claudeForm.model : "claude"}
                              modelName={label}
                              provider="claude"
                              badgeProvider="anthropic"
                              size="sm"
                              showOverlay={true}
                            />
                            <span class="truncate">{label}</span>
                          </div>
                        </Select.Trigger>
                        <Select.Content>
                          <Select.Item value="default">
                            <div class="flex items-center gap-2">
                              <ModelProviderIcon
                                modelId="claude"
                                modelName="CLI default"
                                provider="claude"
                                badgeProvider="anthropic"
                                size="sm"
                                showOverlay={true}
                              />
                              <span>CLI default</span>
                            </div>
                          </Select.Item>
                          {#each CLAUDE_CLI_MODEL_CHOICES as option}
                            <Select.Item value={option.value}>
                              <div class="flex items-center gap-2">
                                <ModelProviderIcon
                                  modelId={option.value}
                                  modelName={option.label}
                                  provider="claude"
                                  badgeProvider="anthropic"
                                  size="sm"
                                  showOverlay={true}
                                />
                                <span class="truncate">{option.label}</span>
                              </div>
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                      <RetiredCliModelNotice runtime="claude" model={claudeForm.model} />
                    </div>
                  </div>

                  <div class="batshit-settings-toggle-row">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <span class="batshit-settings-parent-label">Always Enable Extended Thinking</span>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger
                          class={SETTINGS_INFO_TRIGGER_CLASS}
                          aria-label="About Always Enable Extended Thinking"
                        >
                          <Info class="h-3.5 w-3.5" />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content
                          align="start"
                          side="bottom"
                          class={SETTINGS_INFO_CONTENT_CLASS}
                        >
                          Turns on Claude Code&apos;s extended thinking for this agent.
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                    </div>
                    <Switch.Root
                      checked={claudeForm.alwaysThinkingEnabled}
                      onCheckedChange={guardPrimaryChoice((checked) =>
                        updateClaudeForm((current) => ({
                          ...current,
                          alwaysThinkingEnabled: checked === true,
                          maxThinkingTokens:
                            checked === true
                              ? current.maxThinkingTokens.trim().length > 0
                                ? current.maxThinkingTokens
                                : String(CLAUDE_DEFAULT_MAX_THINKING_TOKENS)
                              : "",
                        })))} />
                  </div>

                  {#if claudeForm.alwaysThinkingEnabled}
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label">
                            Thinking Token Budget
                          </Label.Root>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger
                              class={SETTINGS_INFO_TRIGGER_CLASS}
                              aria-label="About Thinking Token Budget"
                            >
                              <Info class="h-3.5 w-3.5" />
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content
                              align="start"
                              side="bottom"
                              class={SETTINGS_INFO_CONTENT_CLASS}
                            >
                              Uses <code>{CLAUDE_DEFAULT_MAX_THINKING_TOKENS}</code> when left blank.
                            </DropdownMenu.Content>
                          </DropdownMenu.Root>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          type="number"
                          min="1"
                          placeholder={String(CLAUDE_DEFAULT_MAX_THINKING_TOKENS)}
                          value={claudeForm.maxThinkingTokens}
                          oninput={(event) => {
                            const nextValue = (event.target as HTMLInputElement).value;
                            updateClaudeForm((current) => ({
                              ...current,
                              maxThinkingTokens: nextValue,
                            }));
                          }}
                        />
                      </div>
                    </div>
                  {/if}
                </div>
            </SettingsAccordionCard>
          {/if}

          {#if basicForm.agentType === "api"}
            <SettingsAccordionCard
              name="agent-access-cards"
              title="Batshit Permissions & Boundaries"
              batshitIcon="access"
              class={hiddenUnless("access")}
              contentClass="space-y-4"
              onfocusin={() => (basicSaveScope = "permissions")}
              onpointerdown={() => (basicSaveScope = "permissions")}
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Batshit Permissions and Boundaries">
                  Controls where Batshit-native execution runs and how much freedom the agent has once command execution is enabled.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                {#if basicSaveScope === "permissions"}
                  <SettingsSaveStatus
                    state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                    error={basicSaveError ?? basicValidationError}
                    savingLabel="Saving agent settings..."
                    savedLabel="Saved"
                  />
                {/if}
              {/snippet}
                {#if getNativeToolToggle("bashEnabled", true)}
                  <div class="space-y-2">
                    <div class="flex items-center gap-1.5">
                      <Label.Root class="batshit-settings-section-title"
                        >Permissions Mode</Label.Root
                      >
                      <SettingsInfoMenu ariaLabel="About Batshit permissions mode">
                        {#each NATIVE_PERMISSION_OPTIONS as option}
                          <span class="mt-1 block">
                            <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                          </span>
                        {/each}
                      </SettingsInfoMenu>
                    </div>
                    <ToggleGroup.Root
                      type="single"
                      value={getNativeBashAccessMode() as unknown as string}
                      variant="outline"
                      size="lg"
                      class="batshit-settings-permission-toggle-group"
                      aria-label="Batshit permissions mode"
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        if (!NATIVE_BASH_ACCESS_MODE_OPTIONS.includes(next as NativeBashAccessMode)) return;
                        const mode = next as NativeBashAccessMode;
                        updateNativeToolSetting("bashAccessMode", mode);
                        updateNativeToolSetting(
                          "executionBackend",
                          getBashBackendForPermissionMode(mode),
                        );
                        updateNativeToolSetting("bashPolicyMode", null);
                        if (mode !== "agent") {
                          updateNativeToolSetting("bashAgentApprovalCardsEnabled", false);
                        }
                      })}
                    >
                      {#each NATIVE_PERMISSION_OPTIONS as option}
                        <ToggleGroup.Item
                          value={option.value}
                          class={SETTINGS_PERMISSION_TOGGLE_ITEM_CLASS}
                        >
                          {@const OptionIcon = option.icon}
                          <OptionIcon class="h-4 w-4 shrink-0" />
                          <span class="batshit-settings-form-label truncate">{option.label}</span>
                        </ToggleGroup.Item>
                      {/each}
                    </ToggleGroup.Root>
                  </div>

                  {@const selectedSandboxBackend = getNativeExecutionBackend()}
                  {@const selectedSandboxStatus = getSandboxStatusForBackend(selectedSandboxBackend)}
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label">
                            Sandbox Level
                          </Label.Root>
                        <SettingsInfoMenu ariaLabel="About Sandbox">
                          Batshit keeps one sandbox for the active run in this workspace, then cleans it
                          up when the run ends. Disk use depends on what gets installed or built during
                          the run.
                          {#if selectedSandboxStatus?.available}
                            <span class="batshit-settings-inline-strong mt-2 block">Current sandbox status</span>
                            {#if selectedSandboxStatus.policy}
                              <span class="mt-1 block">Network policy: <code>{selectedSandboxStatus.policy}</code></span>
                            {/if}
                            {#if selectedSandboxStatus.version}
                              <span class="mt-1 block"><code>{selectedSandboxStatus.version}</code></span>
                            {/if}
                          {/if}
                        </SettingsInfoMenu>
                        {#if selectedSandboxBackend === "local"}
                          <SettingsInfoMenu
                            ariaLabel={isDockerNativeRuntime() ? "About App Container Shell mode" : "About Local Machine mode"}
                            tone="amber"
                          >
                            {#if isDockerNativeRuntime()}
                              App Container Shell runs commands inside the Batshit app container against
                              the mounted workspace. It is not the host computer shell. Allow/deny rules
                              and hard safety blocks still apply, but filesystem and network effects happen
                              inside the container and any mounted folders.
                            {:else}
                              Local Machine mode runs commands directly on your machine instead of inside
                              the Docker sandbox. Allow/deny rules and hard safety blocks still apply,
                              but filesystem and network effects happen on the host.
                            {/if}
                          </SettingsInfoMenu>
                        {/if}
                        {#if selectedSandboxStatus?.available}
                          <span class="batshit-settings-pill is-info">
                            <Package class="h-3.5 w-3.5" />
                            Sandbox Ready
                          </span>
                        {/if}
                        </div>
                      </div>
                      <div class="batshit-settings-form-control-group">
                        <Select.Root
                          type="single"
                          value={selectedSandboxBackend as unknown as string}
                          onValueChange={guardPrimaryChoice((value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            const normalized = normalizeNativeExecutionBackend(next) ?? getDefaultNativeExecutionBackend();
                            updateNativeToolSetting("executionBackend", normalized);
                          })}
                        >
                          <Select.Trigger class="justify-between">
                            <span class="truncate">
                              {getNativeExecutionBackendLabel(selectedSandboxBackend)}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each NATIVE_EXECUTION_BACKEND_OPTIONS as option}
                              <Select.Item value={option}>
                                {getNativeExecutionBackendLabel(option)}
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                        {#if nativeSandboxStatusLoading}
                          <p class="batshit-settings-form-help">Checking sandbox status...</p>
                        {:else if selectedSandboxBackend !== "local" && !selectedSandboxStatus?.available}
                          <p class="batshit-settings-form-help is-danger">
                            {getSandboxUnavailableMessage(selectedSandboxBackend, selectedSandboxStatus)}
                          </p>
                          {#if selectedSandboxStatus?.reason}
                            <p class="batshit-settings-form-help is-danger">{selectedSandboxStatus.reason}</p>
                          {/if}
                        {:else if selectedSandboxBackend === "apple_container" && selectedSandboxStatus?.systemRunning === false}
                          <p class="batshit-settings-form-help">
                            Apple Container is not started yet. Batshit starts it with the first sandboxed command.
                          </p>
                        {:else if selectedSandboxBackend === "local" && isDockerNativeRuntime()}
                          <p class="batshit-settings-form-help">
                            Bash commands will run inside the Batshit app container with access to the mounted workspace.
                          </p>
                        {/if}
                        {#if nativeSandboxStatusError}
                          <p class="batshit-settings-form-help is-danger">{nativeSandboxStatusError}</p>
                        {/if}
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">
                          Approval Policy
                        </Label.Root>
                        <SettingsInfoMenu ariaLabel="About Approval Policy">
                          {#each PRIMARY_TOOL_APPROVAL_OPTIONS as option}
                            <span class="mt-1 block">
                              <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                            </span>
                          {/each}
                          <span class="mt-2 block">
                            Only primary agents can ask for extra approval. n8n automation stays non-interactive.
                          </span>
                          <span class="mt-2 block">
                            Approval Policy only matters in <span class="batshit-settings-inline-strong">Agent</span> mode.
                            Plan blocks edits, and Batshit Crazy never asks.
                          </span>
                        </SettingsInfoMenu>
                      </div>
                      </div>
                      <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={basicForm.tool_approval_mode}
                        onValueChange={guardPrimaryChoice((value) => {
                          const next = (Array.isArray(value) ? value[0] : value) as "off" | "all";
                          basicSaveScope = "permissions";
                          basicForm = {
                            ...basicForm,
                            tool_approval_mode: !toolApprovalEligible ? "off" : next,
                          };
                        })}
                        disabled={!toolApprovalEligible}
                      >
                        <Select.Trigger>
                          <span>{getPrimaryApprovalPolicyLabel(basicForm.tool_approval_mode)}</span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each PRIMARY_TOOL_APPROVAL_OPTIONS as option}
                            <Select.Item value={option.value}>
                              <div class="flex flex-col min-w-0">
                                <span class="truncate">{option.label}</span>
                                <span class="batshit-settings-child-label">
                                  {option.helper}
                                </span>
                              </div>
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                      </div>
                    </div>
                  </div>
                {/if}

                {#if getNativeToolToggle("bashEnabled", true)}
                  <details class="batshit-settings-card-subtle-frame is-compact">
                    <summary class="batshit-settings-caption cursor-pointer">
                      Advanced Safety Rules
                    </summary>
                    <div class="mt-3 space-y-4">
                      <div class="batshit-settings-card-subtle-frame is-compact space-y-2">
                        <div class="flex items-center gap-1.5">
                          <Label.Root class="batshit-settings-form-label">
                            Command Timeout
                          </Label.Root>
                          <SettingsInfoMenu ariaLabel="About Command Timeout">
                            Limits how long a native command can run before Batshit stops it.
                          </SettingsInfoMenu>
                        </div>
                        <Select.Root
                          type="single"
                          value={String(getNativeBashTimeoutMs()) as unknown as string}
                          onValueChange={guardPrimaryChoice((value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            const parsed = Number.parseInt(String(next ?? ""), 10);
                            updateNativeToolSetting(
                              "bashTimeoutMs",
                              Number.isFinite(parsed) ? parsed : 30_000,
                            );
                          })}
                        >
                          <Select.Trigger class="justify-between">
                            <span class="truncate">{Math.round(getNativeBashTimeoutMs() / 1000)} seconds</span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each NATIVE_BASH_TIMEOUT_OPTIONS as timeoutMsValue}
                              <Select.Item value={String(timeoutMsValue)}>
                                {Math.round(timeoutMsValue / 1000)} seconds
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      </div>

                      <div class="batshit-settings-card-subtle-frame is-compact space-y-2">
                        <div class="flex items-center gap-1.5">
                          <Label.Label class="batshit-settings-form-label">Always Block List</Label.Label>
                          <SettingsInfoMenu ariaLabel="About Always Block List">
                            Rules in this list are blocked for all modes, including Batshit Crazy.
                          </SettingsInfoMenu>
                        </div>
                        <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
                          <div class="min-w-0 flex-1 space-y-1">
                            <p class="batshit-settings-form-label">
                              {getMultilineEntryCountLabel(
                                getNativeBashPatternListText("bashNeverAllowList"),
                                "rule",
                                "rules",
                                "No rules saved",
                              )}
                            </p>
                            <p class="batshit-settings-code-caption line-clamp-3">
                              {getMultilinePreviewText(
                                getNativeBashPatternListText("bashNeverAllowList"),
                                "Open the editor to manage blocked command patterns.",
                              )}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onclick={() => (agentBashBlockEditorOpen = true)}
                          >
                            <Pencil aria-hidden="true" />

                            Edit
                          </Button>
                        </div>
                      </div>

                      {#if getNativeBashAccessMode() === "agent"}
                        <div class="batshit-settings-card-subtle-frame is-compact space-y-2">
                          <div class="flex items-center gap-1.5">
                            <Label.Label class="batshit-settings-form-label">Always Allow List</Label.Label>
                            <SettingsInfoMenu ariaLabel="About Always Allow List">
                              Matching rules run immediately. Non-matching commands are blocked when Approval Policy is set to Never.
                              When Approval Policy is On Failure, non-matching commands ask first.
                            </SettingsInfoMenu>
                          </div>
                          <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
                            <div class="min-w-0 flex-1 space-y-1">
                              <p class="batshit-settings-form-label">
                                {getMultilineEntryCountLabel(
                                  getNativeBashPatternListText("bashCommandAllowList"),
                                  "rule",
                                  "rules",
                                  "No rules saved",
                                )}
                              </p>
                              <p class="batshit-settings-code-caption line-clamp-3">
                                {getMultilinePreviewText(
                                  getNativeBashPatternListText("bashCommandAllowList"),
                                  "Open the editor to manage always-allow command patterns.",
                                )}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onclick={() => (agentBashAllowEditorOpen = true)}
                            >
                              <Pencil aria-hidden="true" />

                              Edit
                            </Button>
                          </div>
                        </div>
                      {/if}
                    </div>
                  </details>

                  <div class="batshit-settings-caption flex items-center gap-1.5">
                    <span class="batshit-settings-inline-strong">Hard Safety Blocks</span>
                    <SettingsInfoMenu ariaLabel="About Hard Safety Blocks">
                      <span class="batshit-settings-inline-strong">Hard safety blocks remain enforced and cannot be overridden.</span>
                      <span class="mt-2 block">
                        Batshit still blocks the biggest host-risk categories even in Batshit Crazy mode.
                      </span>
                      <span class="mt-2 block">
                        Examples include privilege escalation commands, host shutdown/reboot, destructive
                        root deletion, raw disk writes or formatting, fork-bomb patterns, and piping remote
                        scripts straight into a shell.
                      </span>
                      <span class="mt-2 block">
                        Machine-wide Python version changes and bare global <code>pip install</code> /
                        <code>pip uninstall</code> are also blocked unless they clearly target an isolated
                        environment like <code>.venv</code>.
                      </span>
                    </SettingsInfoMenu>
                  </div>
                {:else}
                  <div class="batshit-settings-muted-panel">
                    Turn on <span class="batshit-settings-inline-strong">Command execution</span> in the Tools tab to configure execution permissions and safety rules.
                  </div>
                {/if}
            </SettingsAccordionCard>
          {/if}

          {#if isCodexProvider}
            <SettingsAccordionCard
              name="agent-core-cards"
              title="Codex CLI Defaults"
              batshitIcon="cli-tools"
              class={hiddenUnless("core")}
              onfocusin={() => (codexSaveScope = "core")}
              onpointerdown={() => (codexSaveScope = "core")}
            >
              {#snippet actions()}
                {#if codexSaveScope === "core"}
                  <SettingsSaveStatus
                    state={codexSaveError ? "error" : codexSaveState}
                    error={codexSaveError}
                    savingLabel="Saving Codex defaults..."
                    savedLabel="Saved"
                  />
                {/if}
              {/snippet}

                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Default Codex Model</Label.Root>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger
                            class={SETTINGS_INFO_TRIGGER_CLASS}
                            aria-label="About Default Codex Model"
                          >
                            <Info class="h-3.5 w-3.5" />
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content
                            align="start"
                            side="bottom"
                            class={SETTINGS_INFO_CONTENT_CLASS}
                          >
                            Passed directly to <code>codex --model</code> for this agent.
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={codexForm.model}
                        onValueChange={guardPrimaryChoice((value) =>
                          updateCodexForm((current) =>
                            codexFormForPickedModel(
                              current,
                              Array.isArray(value)
                                ? (value[0] as string)
                                : (value as string),
                            ),
                          ))}
                      >
                        <Select.Trigger class="w-full">
                          {@const label = CODEX_SUBMODEL_CHOICES.find((option) => option.value === codexForm.model)?.label ?? codexForm.model}
                          <div class="flex items-center gap-2 min-w-0">
                            <ModelProviderIcon
                              modelId={codexForm.model}
                              modelName={label}
                              provider="openai"
                              size="sm"
                              badgeProvider="codex"
                            />
                            <span class="truncate">{label}</span>
                          </div>
                        </Select.Trigger>
                        <Select.Content>
                          {#each CODEX_SUBMODEL_CHOICES as option}
                            <Select.Item value={option.value}>
                              <div class="flex items-center gap-2 min-w-0">
                                <ModelProviderIcon
                                  modelId={option.value}
                                  modelName={option.label}
                                  provider="openai"
                                  size="sm"
                                  badgeProvider="codex"
                                />
                                <span class="truncate">{option.label}</span>
                              </div>
                            </Select.Item>
                        {/each}
                        </Select.Content>
                      </Select.Root>
                      <RetiredCliModelNotice runtime="codex" model={codexForm.model} />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Reasoning Effort</Label.Root>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger
                            class={SETTINGS_INFO_TRIGGER_CLASS}
                            aria-label="About Reasoning Effort"
                          >
                            <Info class="h-3.5 w-3.5" />
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content
                            align="start"
                            side="bottom"
                            class={SETTINGS_INFO_CONTENT_CLASS}
                          >
                            Mirrors Codex <code>model_reasoning_effort</code>.
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={codexForm.reasoningEffort}
                        onValueChange={guardPrimaryChoice((value) =>
                          updateCodexForm((current) => ({
                            ...current,
                            reasoningEffort: (Array.isArray(value)
                              ? value[0]
                              : value) as CodexFormOptions["reasoningEffort"],
                          })))}
                      >
                        <Select.Trigger class="w-full">
                          {@const label = CODEX_REASONING_OPTIONS.find((option) => option.value === codexForm.reasoningEffort)?.label ?? "Auto"}
                          <div class="flex items-center gap-2 min-w-0">
                            <Brain class="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span class="truncate">{label}</span>
                          </div>
                        </Select.Trigger>
                        <Select.Content>
                          {#each CODEX_REASONING_OPTIONS as option}
                            {#if option.value !== "xhigh" || supportsCodexXhighReasoning(codexForm.model)}
                              <Select.Item value={option.value}>
                                <div class="flex items-start gap-2 min-w-0">
                                  <Brain class="h-4 w-4 shrink-0 text-muted-foreground" />
                                  <div class="flex flex-col min-w-0">
                                    <span class="truncate">{option.label}</span>
                                    <span class="batshit-settings-child-label truncate">
                                      {option.helper}
                                    </span>
                                  </div>
                                </div>
                              </Select.Item>
                            {/if}
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Service Tier</Label.Root>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger
                            class={SETTINGS_INFO_TRIGGER_CLASS}
                            aria-label="About Service Tier"
                          >
                            <Info class="h-3.5 w-3.5" />
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content
                            align="start"
                            side="bottom"
                            class={SETTINGS_INFO_CONTENT_CLASS}
                          >
                            Writes Codex <code>service_tier</code>. Fast is currently supported on GPT-5.5 and GPT-5.4.
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={codexForm.serviceTier}
                        onValueChange={guardPrimaryChoice((value) =>
                          updateCodexForm((current) => ({
                            ...current,
                            serviceTier: (Array.isArray(value)
                              ? value[0]
                              : value) as CodexServiceTier,
                          })))}
                      >
                        <Select.Trigger class="w-full">
                          <span>
                            {CODEX_SERVICE_TIER_OPTIONS.find((option) =>
                              option.value === codexForm.serviceTier
                            )?.label ?? codexForm.serviceTier}
                          </span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each CODEX_SERVICE_TIER_OPTIONS as option}
                            {#if option.value !== "fast" || supportsCodexFastMode(codexForm.model)}
                              <Select.Item value={option.value}>
                                <div class="flex flex-col min-w-0">
                                  <span class="truncate">{option.label}</span>
                                  <span class="batshit-settings-child-label truncate">
                                    {option.helper}
                                  </span>
                                </div>
                              </Select.Item>
                            {/if}
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                  </div>
                </div>
            </SettingsAccordionCard>
          {/if}

          {#if !isCliProvider}
          <SettingsAccordionCard
            name="agent-access-cards"
            title="Projects"
            batshitIcon="projects"
            class={hiddenUnless("access")}
            contentClass="space-y-5"
            onfocusin={() => (basicSaveScope = "projects")}
            onpointerdown={() => (basicSaveScope = "projects")}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Agent Projects">
                Choose the default project context for this agent and any extra working directories
                the runtime may access.
              </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
                {#if basicSaveScope === "projects"}
                  <SettingsSaveStatus
                    state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                    error={basicSaveError ?? basicValidationError}
                    savingLabel="Saving project settings..."
                    savedLabel="Saved"
                  />
                {:else if isCodexProvider && codexSaveScope === "projects"}
                  <SettingsSaveStatus
                    state={codexSaveError ? "error" : codexSaveState}
                    error={codexSaveError}
                    savingLabel="Saving project settings..."
                    savedLabel="Saved"
                  />
                {:else if isClaudeCliProvider && claudeSaveScope === "projects"}
                  <SettingsSaveStatus
                    state={claudeSaveError ? "error" : claudeSaveState}
                    error={claudeSaveError}
                    savingLabel="Saving project settings..."
                    savedLabel="Saved"
                  />
                {/if}
            {/snippet}
              <div
                class="space-y-2"
                onfocusin={() => (basicSaveScope = "projects")}
              >
                <div class="flex items-center gap-1.5 px-4 pt-3">
                  <Label.Label>Default Project</Label.Label>
                  <SettingsInfoMenu ariaLabel="About Default Project">
                    Used when no project is selected in the sidebar. Precedence is:
                    active project, then this agent default, then the user Default Project Path.
                  </SettingsInfoMenu>
                </div>
                <Select.Root
                  type="single"
                  value={basicForm.default_project_id || "none"}
                  onValueChange={guardPrimaryChoice((value: string) =>
                    (basicForm = {
                      ...basicForm,
                      default_project_id: value === "none" ? null : value,
                    }))}
                >
                  <Select.Trigger class="w-full sm:w-[420px]">
                    {#if basicForm.default_project_id}
                      {projectOptions.find((project) => project.id === basicForm.default_project_id)?.name ||
                        "Select project"}
                    {:else}
                      {getGlobalDefaultProjectLabel()}
                    {/if}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="none">{getGlobalDefaultProjectLabel()}</Select.Item>
                    {#each projectOptions as project}
                      <Select.Item value={project.id}>{project.name}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
                {#if projectOptionsLoading}
                  <p class="batshit-settings-form-label">Loading available projects…</p>
                {:else if projectOptions.length === 0}
                  <p class="batshit-settings-form-label">
                    No projects found yet. Create one in Settings → Projects.
                  </p>
                {/if}
                {#if projectOptionsError}
                  <p class="batshit-settings-form-help is-danger">{projectOptionsError}</p>
                {/if}
              </div>

              {#if isCodexProvider}
                <div
                  class="space-y-2 batshit-settings-muted-panel"
                  onfocusin={() => (codexSaveScope = "projects")}
                >
                  <div class="flex items-center gap-1.5">
                    <Label.Root class="batshit-settings-form-label">
                      Codex Additional Writable Directories
                    </Label.Root>
                    <SettingsInfoMenu ariaLabel="About Codex Additional Writable Directories">
                      Extra directories extend where Codex can read and write inside this Batshit-managed session.
                    </SettingsInfoMenu>
                  </div>
                  <div class="flex gap-2">
                    <Input
                      placeholder="/path/to/allow"
                      bind:value={codexDirDraft}
                      onkeydown={(event: KeyboardEvent) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addCodexListValue("addDirs", codexDirDraft);
                          codexDirDraft = "";
                        }
                      }}
                    />
                    <Button
                      variant="secondary"
                      onclick={() => {
                        addCodexListValue("addDirs", codexDirDraft);
                        codexDirDraft = "";
                      }}
                    >
                      <Plus aria-hidden="true" />

                      Add
                    </Button>
                  </div>
                  {#if codexForm.addDirs.length > 0}
                    <div class="flex flex-wrap gap-2">
                      {#each codexForm.addDirs as dir, idx}
                        <span class="batshit-settings-pill">
                          {dir}
                          <button
                            class="text-muted-foreground hover:text-foreground"
                            type="button"
                            onclick={() => removeCodexListValue("addDirs", idx)}
                          >
                            ×
                          </button>
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

              {#if isClaudeCliProvider}
                <div
                  class="space-y-2 batshit-settings-muted-panel"
                  onfocusin={() => (claudeSaveScope = "projects")}
                >
                  <div class="flex items-center gap-1.5">
                    <Label.Root class="batshit-settings-form-label">
                      Claude Additional Directories
                    </Label.Root>
                    <SettingsInfoMenu ariaLabel="About Claude Additional Directories">
                      Extra directories extend Claude's project access but do not turn those folders into full config roots.
                    </SettingsInfoMenu>
                  </div>
                  <div class="flex gap-2">
                    <Input
                      placeholder="/path/to/allow"
                      bind:value={claudeDirDraft}
                      onkeydown={(event: KeyboardEvent) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addClaudeListValue("addDirs", claudeDirDraft);
                          claudeDirDraft = "";
                        }
                      }}
                    />
                    <Button
                      variant="secondary"
                      onclick={() => {
                        addClaudeListValue("addDirs", claudeDirDraft);
                        claudeDirDraft = "";
                      }}
                    >
                      <Plus aria-hidden="true" />

                      Add
                    </Button>
                  </div>
                  {#if claudeForm.addDirs.length > 0}
                    <div class="flex flex-wrap gap-2">
                      {#each claudeForm.addDirs as dir, idx}
                        <span class="batshit-settings-pill">
                          {dir}
                          <button
                            class="text-muted-foreground hover:text-foreground"
                            type="button"
                            onclick={() => removeClaudeListValue("addDirs", idx)}
                          >
                            ×
                          </button>
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
          </SettingsAccordionCard>
          {/if}

          {#if isClaudeCliProvider}
            <SettingsAccordionCard
              name="agent-instructions-cards"
              title="Claude Instructions"
              batshitIcon="instructions"
              class={hiddenUnless("instructions")}
              contentClass="space-y-4"
              onfocusin={() => (claudeSaveScope = "instructions")}
              onpointerdown={() => (claudeSaveScope = "instructions")}
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Claude Instructions">
                  Controls how Claude's own instruction sources mix with Batshit-managed prompting.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                {#if claudeSaveScope === "instructions"}
                  <SettingsSaveStatus
                    state={claudeSaveError ? "error" : claudeSaveState}
                    error={claudeSaveError}
                    savingLabel="Saving Claude instructions..."
                    savedLabel="Saved"
                  />
                {/if}
              {/snippet}
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Use Project CLAUDE.md When Found</p>
                      <SettingsInfoMenu ariaLabel="About Project CLAUDE.md">
                        On lets Claude read project <code>CLAUDE.md</code> files inside this
                        Batshit-managed chat. Off ignores those project instruction files for this agent.
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={claudeForm.includeProjectInstructions}
                    onCheckedChange={guardPrimaryChoice((checked) =>
                      updateClaudeForm((current) => ({
                        ...current,
                        includeProjectInstructions: checked === true,
                      })))}
                  />
                </div>

                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Include Claude's Built-In System Prompt</p>
                      <SettingsInfoMenu ariaLabel="About Claude Built-in System Prompt">
                        Off keeps Batshit's plain helper replacement. On removes that override so
                        Claude Code uses its own built-in prompt too.
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={claudeForm.includeCoreSystemPrompt}
                    onCheckedChange={guardPrimaryChoice((checked) =>
                      updateClaudeForm((current) => ({
                        ...current,
                        includeCoreSystemPrompt: checked === true,
                        systemPromptMode: checked === true ? "default" : "replace",
                        systemPrompt:
                          checked === true ? "" : MODE4_PRELAUNCH_REPLACEMENT_PROMPT,
                        systemPromptFile: "",
                      })))}
                  />
                </div>
              </div>
            </SettingsAccordionCard>
          {/if}

          {#if isCodexProvider}
            <SettingsAccordionCard
              name="agent-instructions-cards"
              title="Codex Instructions"
              batshitIcon="instructions"
              class={hiddenUnless("instructions")}
              contentClass="space-y-4"
              onfocusin={() => (codexSaveScope = "instructions")}
              onpointerdown={() => (codexSaveScope = "instructions")}
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Codex Instructions">
                  Controls whether Codex also reads project instruction files in this managed session.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                {#if codexSaveScope === "instructions"}
                  <SettingsSaveStatus
                    state={codexSaveError ? "error" : codexSaveState}
                    error={codexSaveError}
                    savingLabel="Saving Codex instructions..."
                    savedLabel="Saved"
                  />
                {/if}
              {/snippet}
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Use Project AGENTS.md When Found</p>
                      <SettingsInfoMenu ariaLabel="About Project AGENTS.md">
                        On lets Codex also read the project's <code>AGENTS.md</code> inside this
                        Batshit-managed chat. Off uses Batshit's managed replacement instructions file instead.
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={codexForm.includeProjectInstructions}
                    onCheckedChange={guardPrimaryChoice((checked) =>
                      updateCodexForm((current) => ({
                        ...current,
                        includeProjectInstructions: checked === true,
                      })))}
                  />
                </div>
              </div>
            </SettingsAccordionCard>
          {/if}

          {#if isClaudeCliProvider}
            <SettingsAccordionCard
              name="agent-access-cards"
              title="Claude Permissions & Boundaries"
              batshitIcon="access"
              class={hiddenUnless("access")}
              contentClass="space-y-4"
              onfocusin={() => (claudeSaveScope = "permissions")}
              onpointerdown={() => (claudeSaveScope = "permissions")}
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Claude Permissions">
                  Controls how freely Claude can act when tools are enabled.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                  {#if basicSaveScope === "approvals" &&
                    (basicSaveState !== "idle" || basicSaveError || basicValidationError)}
                    <SettingsSaveStatus
                      state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                      error={basicSaveError ?? basicValidationError}
                      savingLabel="Saving approval policy..."
                      savedLabel="Saved"
                    />
                  {:else if claudeSaveScope === "permissions"}
                    <SettingsSaveStatus
                      state={claudeSaveError ? "error" : claudeSaveState}
                      error={claudeSaveError}
                      savingLabel="Saving Claude access settings..."
                      savedLabel="Saved"
                    />
                  {/if}
              {/snippet}
                <div class="space-y-2">
                  <div class="flex items-center gap-1.5">
                    <Label.Root class="batshit-settings-section-title"
                      >Permissions Mode</Label.Root
                    >
                    <SettingsInfoMenu ariaLabel="About Claude permissions mode">
                      {#each CLAUDE_PERMISSION_OPTIONS as option}
                        <span class="mt-1 block">
                          <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                        </span>
                      {/each}
                    </SettingsInfoMenu>
                  </div>
                  <ToggleGroup.Root
                    type="single"
                    value={claudeForm.permissionMode}
                    variant="outline"
                    size="lg"
                    class="batshit-settings-permission-toggle-group"
                    aria-label="Claude permissions mode"
                    onValueChange={guardPrimaryChoice((value) => {
                      const next = Array.isArray(value) ? value[0] : value;
                      if (!next) return;
                      setClaudePermissionMode(next as ClaudePermissionMode);
                    })}
                  >
                    {#each CLAUDE_PERMISSION_OPTIONS as option}
                      <ToggleGroup.Item
                        value={option.value}
                        class={SETTINGS_PERMISSION_TOGGLE_ITEM_CLASS}
                      >
                        {@const OptionIcon = option.icon}
                        <OptionIcon class="h-4 w-4 shrink-0" />
                        <span class="batshit-settings-form-label truncate">{option.label}</span>
                      </ToggleGroup.Item>
                    {/each}
                  </ToggleGroup.Root>
                  {#if isDockerNativeRuntime()}
                    <p class="batshit-settings-form-meta is-warning">
                      Docker runs Claude Code as non-root batshit-cli so Bypass Permissions can
                      work. If you see a root-runtime warning, rebuild the Docker app image and
                      rerun the Claude login command shown above.
                    </p>
                  {/if}
                </div>

                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label"
                          >Approval Policy</Label.Root
                        >
                        <SettingsInfoMenu ariaLabel="About Claude approval policy">
                          {#each PRIMARY_TOOL_APPROVAL_OPTIONS as option}
                            <span class="mt-1 block">
                              <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                            </span>
                          {/each}
                          <span class="mt-2 block">
                            This controls requests from Claude's own tools in <span class="batshit-settings-inline-strong">Edit Automatically</span> or an effective Default mode. Batshit helpers do not ask through this policy: the Bash helper follows its saved Work mode and allow/never-allow rules. Fabric controls may have separate approvals. Claude Plan and Bypass Permissions do not ask.
                          </span>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={basicForm.tool_approval_mode}
                        onValueChange={guardPrimaryChoice((value) => {
                          const next = (Array.isArray(value) ? value[0] : value) as "off" | "all";
                          basicSaveScope = "approvals";
                          basicForm = {
                            ...basicForm,
                            tool_approval_mode: next,
                          };
                        })}
                      >
                        <Select.Trigger>
                          <span>{getPrimaryApprovalPolicyLabel(basicForm.tool_approval_mode)}</span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each PRIMARY_TOOL_APPROVAL_OPTIONS as option}
                            <Select.Item value={option.value}>
                              <div class="flex flex-col min-w-0">
                                <span class="truncate">{option.label}</span>
                                <span class="batshit-settings-child-label">
                                  {option.helper}
                                </span>
                              </div>
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                  </div>
                </div>

                <Collapsible.Root bind:open={claudeConfigOverridesOpen}>
                  <div class="batshit-settings-disclosure-row">
                    <Collapsible.Trigger class={SETTINGS_DISCLOSURE_TRIGGER_CLASS}>
                      <span class="batshit-settings-form-label flex items-center gap-1.5">
                        <span>Custom settings.json entries</span>
                        <SettingsInfoMenu ariaLabel="About Custom settings.json entries">
                          Add advanced Claude settings using JSON paths like <code>cleanupPeriodDays</code>,
                          <code>env.FOO</code>, or <code>hooks.PreToolUse</code>. Batshit-managed keys stay protected,
                          and manual JSON outside those managed paths is preserved on sync.
                        </SettingsInfoMenu>
                      </span>
                      <ChevronDown
                        class={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${claudeConfigOverridesOpen ? "rotate-180" : ""}`}
                      />
                    </Collapsible.Trigger>
                    <Collapsible.Content class="batshit-settings-disclosure-content">
                      {#if claudeForm.configOverrides.length > 0}
                        <div class="space-y-2">
                          {#each claudeForm.configOverrides as row (row.id)}
                            <div class="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                              <Input
                                placeholder="JSON path"
                                value={row.key}
                                oninput={(event) =>
                                  updateClaudeConfig(row.id, "key", (event.target as HTMLInputElement).value)}
                              />
                              <Input
                                placeholder={"JSON value (30, true, [\"foo\"], {\"bar\":1})"}
                                value={row.value}
                                oninput={(event) =>
                                  updateClaudeConfig(row.id, "value", (event.target as HTMLInputElement).value)}
                              />
                              <Button type="button" variant="ghost" onclick={() => removeClaudeConfig(row.id)}>
                                <Trash2 aria-hidden="true" />

                                Remove
                              </Button>
                            </div>
                          {/each}
                        </div>
                      {/if}
                      <Button class="mt-2" variant="outline" size="sm" onclick={() => addClaudeConfig()}>
                        <Plus aria-hidden="true" />

                        Add config row
                      </Button>
                    </Collapsible.Content>
                  </div>
                </Collapsible.Root>

                <div class="batshit-settings-action-row">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-form-label">Managed settings.json</p>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger
                          class={SETTINGS_INFO_TRIGGER_CLASS}
                          aria-label="About Managed settings.json"
                        >
                          <Info class="h-3.5 w-3.5" />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content
                          align="start"
                          side="bottom"
                          class={SETTINGS_INFO_CONTENT_CLASS}
                        >
                          View the exact Batshit-managed Claude settings file for this agent.
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => openManagedConfigViewer("claude")}
                      >
                        <Eye aria-hidden="true" />

                        View settings.json
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onclick={() => copyManagedConfigPath("claude")}
                      >
                        <Copy aria-hidden="true" />

                        Copy path
                      </Button>
                    </div>
                  </div>
                </div>
            </SettingsAccordionCard>
          {/if}

          {#if isCodexProvider}
            <SettingsAccordionCard
              name="agent-access-cards"
              title="Codex Permissions & Boundaries"
              batshitIcon="access"
              class={hiddenUnless("access")}
              contentClass="space-y-5"
              onfocusin={() => (codexSaveScope = "permissions")}
              onpointerdown={() => (codexSaveScope = "permissions")}
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Codex Permissions">
                  A chat send uses the tighter of the mode and this Sandbox Level.
                  Choosing a mode sets its own level.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                  {#if basicSaveScope === "approvals" &&
                    (basicSaveState !== "idle" || basicSaveError || basicValidationError)}
                    <SettingsSaveStatus
                      state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                      error={basicSaveError ?? basicValidationError}
                      savingLabel="Saving approval policy..."
                      savedLabel="Saved"
                    />
                  {:else if codexSaveScope === "permissions"}
                    <SettingsSaveStatus
                      state={codexSaveError ? "error" : codexSaveState}
                      error={codexSaveError}
                      savingLabel="Saving Codex access settings..."
                      savedLabel="Saved"
                    />
                  {/if}
              {/snippet}
                <div class="space-y-2">
                  <div class="flex items-center gap-1.5">
                    <Label.Root class="batshit-settings-section-title"
                      >Permissions Mode</Label.Root
                    >
                    <SettingsInfoMenu ariaLabel="About Codex permissions mode">
                      {#each CODEX_PERMISSION_OPTIONS as option}
                        <span class="mt-1 block">
                          <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                        </span>
                      {/each}
                    </SettingsInfoMenu>
                  </div>
                    <ToggleGroup.Root
                      type="single"
                      value={codexForm.permissionMode}
                      variant="outline"
                      size="lg"
                      class="batshit-settings-permission-toggle-group"
                      aria-label="Codex permissions mode"
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        if (!next) return;
                        setCodexPermissionMode(next as CodexPermissionMode);
                      })}
                    >
                      {#each CODEX_PERMISSION_OPTIONS as option}
                        <ToggleGroup.Item
                          value={option.value}
                          class={SETTINGS_PERMISSION_TOGGLE_ITEM_CLASS}
                        >
                          {@const OptionIcon = option.icon}
                          <OptionIcon class="h-4 w-4 shrink-0" />
                          <span class="batshit-settings-form-label truncate">{option.label}</span>
                        </ToggleGroup.Item>
                      {/each}
                    </ToggleGroup.Root>
                  </div>

                <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label"
                            >Sandbox Level</Label.Root
                          >
                        </div>
                      </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={codexForm.sandbox}
                        disabled={codexForm.permissionMode === "agent_full"}
                        onValueChange={guardPrimaryChoice((value) =>
                          updateCodexForm((current) => ({
                            ...current,
                            sandbox: (Array.isArray(value)
                              ? value[0]
                              : value) as CodexSandbox,
                          })))}
                      >
                        <Select.Trigger>
                          <span>
                            {CODEX_SANDBOX_OPTIONS.find((option) =>
                              option.value === codexForm.sandbox
                            )?.label ?? codexForm.sandbox}
                          </span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each CODEX_SANDBOX_OPTIONS as option}
                            <Select.Item value={option.value}>{option.label}</Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                  </div>
                  {#if codexForm.permissionMode === "agent_full"}
                    <div class="batshit-settings-note" data-testid="agent-codex-full-sandbox-note">
                      {#if codexForm.sandbox !== CODEX_PERMISSION_PRESETS.agent_full.sandbox}
                        This agent keeps its saved {CODEX_SANDBOX_LABELS[codexForm.sandbox]} Sandbox Level.
                      {/if}
                      To limit the sandbox, pick Agent.
                    </div>
                  {/if}
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label"
                          >Approval Policy</Label.Root
                        >
                        <SettingsInfoMenu ariaLabel="About Codex approval policy">
                          {#each PRIMARY_TOOL_APPROVAL_OPTIONS as option}
                            <span class="mt-1 block">
                              <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                            </span>
                          {/each}
                          <span class="mt-2 block">
                            Codex only uses this in <span class="batshit-settings-inline-strong">Agent</span> mode.
                            Chat and Agent (full access) never prompt.
                          </span>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={basicForm.tool_approval_mode}
                        onValueChange={guardPrimaryChoice((value) => {
                          const next = (Array.isArray(value) ? value[0] : value) as "off" | "all";
                          basicSaveScope = "approvals";
                          basicForm = {
                            ...basicForm,
                            tool_approval_mode: next,
                          };
                        })}
                      >
                        <Select.Trigger>
                          <span>
                            {getPrimaryApprovalPolicyLabel(basicForm.tool_approval_mode)}
                          </span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each PRIMARY_TOOL_APPROVAL_OPTIONS as option}
                            <Select.Item value={option.value}>
                              <div class="flex flex-col min-w-0">
                                <span class="truncate">{option.label}</span>
                                <span class="batshit-settings-child-label">
                                  {option.helper}
                                </span>
                              </div>
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                  </div>
                </div>

                <Collapsible.Root bind:open={codexConfigOverridesOpen}>
                  <div class="batshit-settings-disclosure-row">
                    <Collapsible.Trigger class={SETTINGS_DISCLOSURE_TRIGGER_CLASS}>
                      <span class="batshit-settings-form-label flex items-center gap-1.5">
                        <span>Custom config.toml entries</span>
                        <SettingsInfoMenu ariaLabel="About Custom config.toml entries">
                          Add advanced Codex config rows for settings Batshit does not manage directly,
                          like <code>model_context_window</code>. Batshit-managed keys stay protected.
                        </SettingsInfoMenu>
                      </span>
                      <ChevronDown
                        class={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${codexConfigOverridesOpen ? "rotate-180" : ""}`}
                      />
                    </Collapsible.Trigger>
                    <Collapsible.Content class="batshit-settings-disclosure-content">
                      {#if codexForm.configOverrides.length > 0}
                        <div class="space-y-2">
                          {#each codexForm.configOverrides as row (row.id)}
                            <div class="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                              <Input
                                placeholder="key"
                                value={row.key}
                                oninput={(event) =>
                                  updateCodexConfig(row.id, "key", (event.target as HTMLInputElement).value)}
                              />
                              <Input
                                placeholder="value"
                                value={row.value}
                                oninput={(event) =>
                                  updateCodexConfig(row.id, "value", (event.target as HTMLInputElement).value)}
                              />
                              <Button type="button" variant="ghost" onclick={() => removeCodexConfig(row.id)}>
                                <Trash2 aria-hidden="true" />

                                Remove
                              </Button>
                            </div>
                          {/each}
                        </div>
                      {/if}
                      <Button class="mt-2" variant="outline" size="sm" onclick={() => addCodexConfig()}>
                        <Plus aria-hidden="true" />

                        Add config row
                      </Button>
                    </Collapsible.Content>
                  </div>
                </Collapsible.Root>

                <div class="batshit-settings-action-row">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-form-label">Managed config.toml</p>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger
                          class={SETTINGS_INFO_TRIGGER_CLASS}
                          aria-label="About Managed config.toml"
                        >
                          <Info class="h-3.5 w-3.5" />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content
                          align="start"
                          side="bottom"
                          class={SETTINGS_INFO_CONTENT_CLASS}
                        >
                          View the exact Batshit-managed Codex config file for this agent.
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onclick={() => openManagedConfigViewer("codex")}
                      >
                        <Eye aria-hidden="true" />

                        View config.toml
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onclick={() => copyManagedConfigPath("codex")}
                      >
                        <Copy aria-hidden="true" />

                        Copy path
                      </Button>
                    </div>
                  </div>
                </div>
            </SettingsAccordionCard>
          {/if}

          {#if isCliProvider}
            <SettingsAccordionCard
              name="agent-access-cards"
              title="Projects"
              batshitIcon="projects"
              class={hiddenUnless("access")}
              contentClass="space-y-5"
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Agent Projects">
                  Choose the default project context for this agent and any extra working directories
                  the runtime may access.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                  {#if basicSaveScope === "projects"}
                    <SettingsSaveStatus
                      state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                      error={basicSaveError ?? basicValidationError}
                      savingLabel="Saving project settings..."
                      savedLabel="Saved"
                    />
                  {:else if isCodexProvider && codexSaveScope === "projects"}
                    <SettingsSaveStatus
                      state={codexSaveError ? "error" : codexSaveState}
                      error={codexSaveError}
                      savingLabel="Saving project settings..."
                      savedLabel="Saved"
                    />
                  {:else if isClaudeCliProvider && claudeSaveScope === "projects"}
                    <SettingsSaveStatus
                      state={claudeSaveError ? "error" : claudeSaveState}
                      error={claudeSaveError}
                      savingLabel="Saving project settings..."
                      savedLabel="Saved"
                    />
                  {/if}
              {/snippet}
                <div
                  class="space-y-2"
                  onfocusin={() => (basicSaveScope = "projects")}
                >
                  <div class="flex items-center gap-1.5">
                    <Label.Label>Default Project</Label.Label>
                    <SettingsInfoMenu ariaLabel="About Default Project">
                      Used when no project is selected in the sidebar. Precedence is:
                      active project, then this agent default, then the user Default Project Path.
                    </SettingsInfoMenu>
                  </div>
                  <Select.Root
                    type="single"
                    value={basicForm.default_project_id || "none"}
                    onValueChange={guardPrimaryChoice((value: string) =>
                      (basicForm = {
                        ...basicForm,
                        default_project_id: value === "none" ? null : value,
                      }))}
                  >
                    <Select.Trigger class="w-full sm:w-[420px]">
                      {#if basicForm.default_project_id}
                        {projectOptions.find((project) => project.id === basicForm.default_project_id)?.name ||
                          "Select project"}
                      {:else}
                        {getGlobalDefaultProjectLabel()}
                      {/if}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="none">{getGlobalDefaultProjectLabel()}</Select.Item>
                      {#each projectOptions as project}
                        <Select.Item value={project.id}>{project.name}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                  {#if projectOptionsLoading}
                    <p class="batshit-settings-form-label">Loading available projects…</p>
                  {:else if projectOptions.length === 0}
                    <p class="batshit-settings-form-label">
                      No projects found yet. Create one in Settings → Projects.
                    </p>
                  {/if}
                  {#if projectOptionsError}
                    <p class="batshit-settings-form-help is-danger">{projectOptionsError}</p>
                  {/if}
                </div>

                {#if isCodexProvider}
                  <div
                    class="space-y-2 batshit-settings-muted-panel"
                    onfocusin={() => (codexSaveScope = "projects")}
                  >
                    <div class="flex items-center gap-1.5">
                      <Label.Root class="batshit-settings-form-label">
                        Codex Additional Writable Directories
                      </Label.Root>
                      <SettingsInfoMenu ariaLabel="About Codex Additional Writable Directories">
                        Extra directories extend where Codex can read and write inside this Batshit-managed session.
                      </SettingsInfoMenu>
                    </div>
                    <div class="flex gap-2">
                      <Input
                        placeholder="/path/to/allow"
                        bind:value={codexDirDraft}
                        onkeydown={(event: KeyboardEvent) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addCodexListValue("addDirs", codexDirDraft);
                            codexDirDraft = "";
                          }
                        }}
                      />
                      <Button
                        variant="secondary"
                        onclick={() => {
                          addCodexListValue("addDirs", codexDirDraft);
                          codexDirDraft = "";
                        }}
                      >
                        <Plus aria-hidden="true" />

                        Add
                      </Button>
                    </div>
                    {#if codexForm.addDirs.length > 0}
                      <div class="flex flex-wrap gap-2">
                        {#each codexForm.addDirs as dir, idx}
                          <span class="batshit-settings-pill">
                            {dir}
                            <button
                              class="text-muted-foreground hover:text-foreground"
                              type="button"
                              onclick={() => removeCodexListValue("addDirs", idx)}
                            >
                              ×
                            </button>
                          </span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}

                {#if isClaudeCliProvider}
                  <div
                    class="space-y-2 batshit-settings-muted-panel"
                    onfocusin={() => (claudeSaveScope = "projects")}
                  >
                    <div class="flex items-center gap-1.5">
                      <Label.Root class="batshit-settings-form-label">
                        Claude Additional Directories
                      </Label.Root>
                      <SettingsInfoMenu ariaLabel="About Claude Additional Directories">
                        Extra directories extend Claude's project access but do not turn those folders into full config roots.
                      </SettingsInfoMenu>
                    </div>
                    <div class="flex gap-2">
                      <Input
                        placeholder="/path/to/allow"
                        bind:value={claudeDirDraft}
                        onkeydown={(event: KeyboardEvent) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addClaudeListValue("addDirs", claudeDirDraft);
                            claudeDirDraft = "";
                          }
                        }}
                      />
                      <Button
                        variant="secondary"
                        onclick={() => {
                          addClaudeListValue("addDirs", claudeDirDraft);
                          claudeDirDraft = "";
                        }}
                      >
                        <Plus aria-hidden="true" />

                        Add
                      </Button>
                    </div>
                    {#if claudeForm.addDirs.length > 0}
                      <div class="flex flex-wrap gap-2">
                        {#each claudeForm.addDirs as dir, idx}
                          <span class="batshit-settings-pill">
                            {dir}
                            <button
                              class="text-muted-foreground hover:text-foreground"
                              type="button"
                              onclick={() => removeClaudeListValue("addDirs", idx)}
                            >
                              ×
                            </button>
                          </span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
            </SettingsAccordionCard>
          {/if}

          {#if isClaudeCliProvider}
            <SettingsAccordionCard
              name="agent-tools-cards"
              title="Claude Tools"
              icon={Wrench}
              class={hiddenUnless("tools")}
              contentClass="space-y-5"
              onfocusin={() => (claudeSaveScope = "tools")}
              onpointerdown={() => (claudeSaveScope = "tools")}
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Claude Tools">
                  Controls Claude-specific built-in tools for this agent.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                {#if claudeSaveScope === "tools"}
                  <SettingsSaveStatus
                    state={claudeSaveError ? "error" : claudeSaveState}
                    error={claudeSaveError}
                    savingLabel="Saving Claude tools..."
                    savedLabel="Saved"
                  />
                {/if}
              {/snippet}
                <div class="batshit-settings-form-stack">
                <div class="batshit-settings-toggle-row">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Enable Chrome Integration</p>
                      <SettingsInfoMenu ariaLabel="About Claude Chrome Integration">
                        Toggles Claude Code's Chrome automation.
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={claudeForm.chrome}
                    onCheckedChange={guardPrimaryChoice((checked) =>
                      updateClaudeForm((current) => ({
                        ...current,
                        chrome: checked === true,
                      })))}
                  />
                </div>

                <div class="batshit-settings-toggle-row">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Allow Claude Web Search</p>
                      <SettingsInfoMenu ariaLabel="About Claude Web Search">
                        Convenience toggle for Claude's <code>WebSearch</code> built-in tool.
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={getClaudeToolEnabled("WebSearch")}
                    onCheckedChange={guardPrimaryChoice((checked) => setClaudeToolEnabled("WebSearch", checked === true))}
                  />
                </div>
                </div>

                <details class="batshit-settings-card-subtle-frame is-compact">
                  <summary class="batshit-settings-form-label cursor-pointer">
                    Advanced Tool Rules
                  </summary>
                  <div class="mt-3 grid gap-4 md:grid-cols-2">
                    <div class="space-y-2">
                      <Label.Root class="batshit-settings-form-label"
                        >Allowed Tools</Label.Root
                      >
                      <div class="flex gap-2">
                        <Input
                          placeholder="Read, Edit, Bash..."
                          bind:value={claudeAllowedToolDraft}
                          onkeydown={(event: KeyboardEvent) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addClaudeListValue("allowedTools", claudeAllowedToolDraft);
                              claudeAllowedToolDraft = "";
                            }
                          }}
                        />
                        <Button
                          variant="secondary"
                          onclick={() => {
                            addClaudeListValue("allowedTools", claudeAllowedToolDraft);
                            claudeAllowedToolDraft = "";
                          }}
                        >
                          <Plus aria-hidden="true" />

                          Add
                        </Button>
                      </div>
                      {#if claudeForm.allowedTools.length > 0}
                        <div class="flex flex-wrap gap-2">
                          {#each claudeForm.allowedTools as tool, idx}
                            <span class="batshit-settings-pill is-success">
                              {tool}
                              <button
                                type="button"
                                onclick={() => removeClaudeListValue("allowedTools", idx)}
                              >×</button>
                            </span>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <div class="space-y-2">
                      <Label.Root class="batshit-settings-form-label"
                        >Disallowed Tools</Label.Root
                      >
                      <div class="flex gap-2">
                        <Input
                          placeholder="WebSearch, WebFetch..."
                          bind:value={claudeDisallowedToolDraft}
                          onkeydown={(event: KeyboardEvent) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addClaudeListValue("disallowedTools", claudeDisallowedToolDraft);
                              claudeDisallowedToolDraft = "";
                            }
                          }}
                        />
                        <Button
                          variant="secondary"
                          onclick={() => {
                            addClaudeListValue("disallowedTools", claudeDisallowedToolDraft);
                            claudeDisallowedToolDraft = "";
                          }}
                        >
                          <Plus aria-hidden="true" />

                          Add
                        </Button>
                      </div>
                      {#if claudeForm.disallowedTools.length > 0}
                        <div class="flex flex-wrap gap-2">
                          {#each claudeForm.disallowedTools as tool, idx}
                            <span class="batshit-settings-pill is-danger">
                              {tool}
                              <button
                                type="button"
                                onclick={() => removeClaudeListValue("disallowedTools", idx)}
                              >×</button>
                            </span>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                </details>
            </SettingsAccordionCard>
          {/if}

          {#if isCodexProvider}
            <SettingsAccordionCard
              name="agent-tools-cards"
              title="Codex Tools"
              icon={Wrench}
              class={hiddenUnless("tools")}
              contentClass="space-y-5"
              onfocusin={() => (codexSaveScope = "tools")}
              onpointerdown={() => (codexSaveScope = "tools")}
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Codex Tools">
                  Controls Codex-specific built-in capabilities and advanced feature flags.
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                {#if codexSaveScope === "tools"}
                  <SettingsSaveStatus
                    state={codexSaveError ? "error" : codexSaveState}
                    error={codexSaveError}
                    savingLabel="Saving Codex tools..."
                    savedLabel="Saved"
                  />
                {/if}
              {/snippet}
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-toggle-row">
                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">Allow Codex Web Search</p>
                        <SettingsInfoMenu ariaLabel="About Codex Web Search">
                          Enables Codex live web search for CLI runs via the managed <code>web_search</code> setting.
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <Switch.Root
                      checked={codexForm.search}
                      onCheckedChange={guardPrimaryChoice((checked) =>
                        updateCodexForm((current) => ({
                          ...current,
                          search: checked === true,
                        })))}
                    />
                  </div>

                  <Collapsible.Root bind:open={codexAdvancedOpen}>
                    <div class="batshit-settings-disclosure-row is-form-line">
                      <Collapsible.Trigger class={SETTINGS_DISCLOSURE_TRIGGER_CLASS}>
                        <span class="batshit-settings-form-label">Advanced Feature Flags</span>
                        <ChevronDown
                          class={`h-4 w-4 text-muted-foreground transition-transform ${codexAdvancedOpen ? "rotate-180" : ""}`}
                        />
                      </Collapsible.Trigger>
                      <Collapsible.Content class="batshit-settings-disclosure-content space-y-4">
                      <div class="grid gap-4 md:grid-cols-2">
                        <div class="space-y-2">
                          <Label.Root class="batshit-settings-form-label"
                            >Enable Feature Flags</Label.Root
                          >
                          <div class="flex gap-2">
                            <Input
                              placeholder="browser_use"
                              bind:value={codexEnableDraft}
                              onkeydown={(event: KeyboardEvent) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addCodexListValue("enableFeatures", codexEnableDraft);
                                  codexEnableDraft = "";
                                }
                              }}
                            />
                            <Button
                              variant="secondary"
                              onclick={() => {
                                addCodexListValue("enableFeatures", codexEnableDraft);
                                codexEnableDraft = "";
                              }}
                            >
                              <Plus aria-hidden="true" />

                              Add
                            </Button>
                          </div>
                          <div class="flex flex-wrap gap-2">
                            {#if codexForm.enableFeatures.length > 0}
                              {#each codexForm.enableFeatures as feature, idx}
                                <span class="batshit-settings-pill is-success">
                                  {feature}
                                  <button
                                    type="button"
                                    onclick={() => removeCodexListValue("enableFeatures", idx)}
                                  >×</button>
                                </span>
                              {/each}
                            {/if}
                          </div>
                        </div>
                        <div class="space-y-2">
                          <Label.Root class="batshit-settings-form-label"
                            >Disable Feature Flags</Label.Root
                          >
                          <div class="flex gap-2">
                            <Input
                              placeholder="browser_use"
                              bind:value={codexDisableDraft}
                              onkeydown={(event: KeyboardEvent) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addCodexListValue("disableFeatures", codexDisableDraft);
                                  codexDisableDraft = "";
                                }
                              }}
                            />
                            <Button
                              variant="secondary"
                              onclick={() => {
                                addCodexListValue("disableFeatures", codexDisableDraft);
                                codexDisableDraft = "";
                              }}
                            >
                              <Plus aria-hidden="true" />

                              Add
                            </Button>
                          </div>
                          <div class="flex flex-wrap gap-2">
                            {#if codexForm.disableFeatures.length > 0}
                              {#each codexForm.disableFeatures as feature, idx}
                                <span class="batshit-settings-pill is-danger">
                                  {feature}
                                  <button
                                    type="button"
                                    onclick={() => removeCodexListValue("disableFeatures", idx)}
                                  >×</button>
                                </span>
                              {/each}
                            {/if}
                          </div>
                        </div>
                      </div>
                      </Collapsible.Content>
                    </div>
                  </Collapsible.Root>
                </div>
            </SettingsAccordionCard>
          {/if}

          <SettingsAccordionCard
            name="agent-instructions-cards"
            title="Instructions"
            batshitIcon="instructions"
            class={hiddenUnless("instructions")}
            contentClass="space-y-4"
            onfocusin={() => (basicSaveScope = "instructions")}
            onpointerdown={() => (basicSaveScope = "instructions")}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Custom System Prompt">
                Agent-specific Custom System Prompt. This does not override any
                other prompts. It is just added for this specific agent.
              </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
                {#if basicSaveScope === "instructions"}
                  <SettingsSaveStatus
                    state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                    error={basicSaveError ?? basicValidationError}
                    savingLabel="Saving instructions..."
                    savedLabel="Saved"
                  />
                {/if}
            {/snippet}
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Custom System Prompt</Label.Label>
                      </div>
                    </div>
                      <div class="batshit-settings-form-control is-compact-action">
                        <Button
                          type="button"
                          variant="outline"
                        size="sm"
                        onclick={() => (agentPromptEditorOpen = true)}
                      >
                        <Pencil aria-hidden="true" />

                        Edit
                      </Button>
                    </div>
                  </div>

                  <div class="batshit-settings-toggle-row">
                    <div>
                      <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">Include Global Custom Prompt</p>
                        <SettingsInfoMenu ariaLabel="About Include Global Custom Prompt">
                          When enabled, this agent receives your Global Custom
                          System Prompt from the Prompts tab.
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <Switch.Root bind:checked={basicForm.include_global_prompt} />
                  </div>
                </div>
          </SettingsAccordionCard>
          {#if isManagedPrimaryAgentType(basicForm.agentType)}
            <SettingsAccordionCard
              name="agent-tools-cards"
              title="Batshit Tools"
              icon={Wrench}
              class={hiddenUnless("tools")}
              contentClass="space-y-4"
              onfocusin={() => (basicSaveScope = "tools")}
              onpointerdown={() => (basicSaveScope = "tools")}
            >
                {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Batshit Tools">
                    Configure Batshit built-in tools and dynamic tool families for this agent.
                    {#if basicForm.agentType === "api"}
                    API agents use native Batshit tools directly.
                  {:else}
                    CLI agents use managed Batshit MCP helper tools.
                  {/if}
                </SettingsInfoMenu>
              {/snippet}
              {#snippet actions()}
                  {#if basicSaveScope === "tools"}
                    <SettingsSaveStatus
                      state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                      error={basicSaveError ?? basicValidationError}
                      savingLabel="Saving tool settings..."
                      savedLabel="Saved"
                    />
                  {/if}
              {/snippet}
                {@const primaryBashAvailable = isNativeToolUiAvailable("bash")}
                {@const primaryWebSearchAvailable = isNativeToolUiAvailable("web-search")}
                {@const primaryFabricAvailable = isNativeToolUiAvailable("fabric")}

                <div class="batshit-settings-form-stack">
                <div class="batshit-settings-toggle-row">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Bash Tool</p>
                      <SettingsInfoMenu ariaLabel="About Bash Tool">
                        {#if primaryBashAvailable}
                          Enables <code>{getBashToolName()}</code> for terminal command execution.
                          Uses the active Project (sidebar) or your Default Project Directory.
                          If neither is set, execution is blocked. Execution environment,
                          permissions mode, timeout, and safety boundaries live in the
                          <span class="batshit-settings-inline-strong">Access</span> tab.
                        {:else}
                          {getNativeToolUiUnavailableMessage("bash")}
                        {/if}
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={primaryBashAvailable && getNativeToolToggle("bashEnabled", true)}
                    onCheckedChange={guardPrimaryChoice((checked) =>
                      updateNativeToolSetting("bashEnabled", checked === true))}
                    disabled={!primaryBashAvailable}
                  />
                </div>

                <div class="batshit-settings-toggle-row">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">MCP Tools</p>
                        <SettingsInfoMenu ariaLabel="About MCP Tools">
                          Lets Dynamic Tool Search surface enabled MCP Source tools for this agent.
                          Individual MCP sources, groups, and tools are controlled in the Tool Grid.
                        </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={getNativeToolToggle("dynamicMcpEnabled", true)}
                    onCheckedChange={guardPrimaryChoice((checked) =>
                      updateNativeToolSetting("dynamicMcpEnabled", checked === true))}
                  />
                </div>

                <div class="batshit-settings-toggle-row">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">CLI Tools</p>
                        <SettingsInfoMenu ariaLabel="About CLI Tools">
                          Lets Dynamic Tool Search surface saved CLI tools for this agent.
                          Individual CLI tools are controlled in the Tool Grid.
                        </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={getNativeToolToggle("cliToolsEnabled", true)}
                    onCheckedChange={guardPrimaryChoice((checked) =>
                      updateNativeToolSetting("cliToolsEnabled", checked === true))}
                  />
                </div>

                <div class="batshit-settings-toggle-row">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">Artifact Tools</p>
                        <SettingsInfoMenu ariaLabel="About Artifact Tools">
                          Lets Dynamic Tool Search surface published artifacts this agent can use
                          as tools.
                        </SettingsInfoMenu>
                    </div>
                  </div>
                    <Switch.Root
                      checked={getNativeToolToggle("artifactRuntimeEnabled", true)}
                      onCheckedChange={guardPrimaryChoice((checked) =>
                        updateNativeToolSetting("artifactRuntimeEnabled", checked === true))}
                    />
                  </div>

                  <div class="batshit-settings-toggle-row">
                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">Fabric Controls</p>
                          <SettingsInfoMenu ariaLabel="About Fabric Controls">
                            {#if primaryFabricAvailable}
                              Lets Dynamic Tool Search surface Fabric control-plane actions for
                              Batshit management.
                            {:else}
                            {getNativeToolUiUnavailableMessage("fabric")}
                          {/if}
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <Switch.Root
                      checked={primaryFabricAvailable && getNativeToolToggle("batshitToolsEnabled", true)}
                      onCheckedChange={guardPrimaryChoice((checked) =>
                        updateNativeToolSetting("batshitToolsEnabled", checked === true))}
                      disabled={!primaryFabricAvailable}
                    />
                  </div>

                  <AgentWebSearchDefaultsDisclosure
                    bind:open={primaryWebSearchDefaultsOpen}
                    entityLabel="agent"
                    titleInfoAriaLabel="About Web Search"
                    defaultsInfoAriaLabel="About Web Search Defaults"
                    providerInfoAriaLabel="About Default Web Search Provider"
                    exaInfoAriaLabel="About Exa Search Type"
                    perplexityInfoAriaLabel="About Perplexity Max Tokens Per Page"
                    available={primaryWebSearchAvailable}
                    enabled={getNativeToolToggle("webSearchEnabled", true)}
                    toolName={getWebSearchToolName()}
                    unavailableMessage={getNativeToolUiUnavailableMessage("web-search")}
                    providerValue={getNativeWebSearchProviderValue()}
                    providerLabel={getNativeWebSearchProviderLabel(getNativeWebSearchProviderValue())}
                    providerInheritValue={NATIVE_WEB_SEARCH_PROVIDER_INHERIT}
                    providerInheritLabel={getNativeWebSearchProviderLabel(NATIVE_WEB_SEARCH_PROVIDER_INHERIT)}
                    providerOptions={nativeWebSearchProviderOptions}
                    providerLoading={webSearchProviderAvailabilityLoading}
                    providerError={webSearchProviderAvailabilityError}
                    exaTypeValue={getNativeWebSearchExaTypeValue()}
                    exaTypeLabel={getNativeWebSearchExaTypeLabel(getNativeWebSearchExaTypeValue())}
                    exaTypeInheritValue={NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT}
                    exaTypeInheritLabel={getNativeWebSearchExaTypeLabel(NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT)}
                    exaTypeOptions={[
                      { value: "auto", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.auto },
                      { value: "fast", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.fast },
                      { value: "neural", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.neural },
                      { value: "deep", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.deep }
                    ]}
                    perplexityValue={String(getNativeWebSearchPerplexityMaxTokensPerPageValue())}
                    perplexityLabel={getNativeWebSearchPerplexityMaxTokensPerPageLabel(
                      getNativeWebSearchPerplexityMaxTokensPerPageValue()
                    )}
                    perplexityInheritValue={NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT}
                    perplexityInheritLabel={getNativeWebSearchPerplexityMaxTokensPerPageLabel(
                      NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT
                    )}
                    perplexityOptions={NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS}
                    onEnabledChange={guardPrimaryChoice((enabled) => updateNativeToolSetting("webSearchEnabled", enabled))}
                    onProviderValueChange={guardPrimaryChoice((next) => {
                      if (next === NATIVE_WEB_SEARCH_PROVIDER_INHERIT) {
                        updateNativeToolSetting("webSearchProvider", null);
                        return;
                      }
                      const provider = normalizeNativeWebSearchProvider(next);
                      updateNativeToolSetting("webSearchProvider", provider);
                    })}
                    onExaTypeValueChange={guardPrimaryChoice((next) => {
                      if (next === NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT) {
                        updateNativeToolSetting("webSearchExaType", null);
                        return;
                      }
                      const normalized = normalizeNativeExaSearchType(next);
                      updateNativeToolSetting("webSearchExaType", normalized);
                    })}
                    onPerplexityMaxTokensValueChange={guardPrimaryChoice((next) => {
                      if (next === NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT) {
                        updateNativeToolSetting("webSearchPerplexityMaxTokensPerPage", null);
                        return;
                      }
                      const normalized = normalizePerplexityMaxTokensPerPage(next);
                      updateNativeToolSetting("webSearchPerplexityMaxTokensPerPage", normalized);
                    })}
                  />
                  <Collapsible.Root bind:open={primaryAgentBrowserDefaultsOpen}>
                    <div class="batshit-settings-toggle-disclosure-row">
                      <div class="batshit-settings-toggle-disclosure-header">
                        <div class="batshit-settings-toggle-disclosure-copy">
                          <div class="flex items-center gap-1.5">
                            <p class="batshit-settings-parent-label">Agent Browser</p>
                            <SettingsInfoMenu ariaLabel="About Agent Browser">
                              Native browser automation powered by Vercel Agent Browser (Playwright under the hood). No MCP setup required.
                              {#if basicForm.agentType === "cli"}
                                For CLI agents, Dynamic Tool Search can surface Agent Browser
                                actions when detailed schemas are needed.
                              {:else}
                            These defaults auto-apply when the agent runs <code>native_bash_execute</code> with <code>agent-browser ...</code> commands.
                          {/if}
                          {#if agentBrowserRuntimeStatus?.version}
                              Runtime version: <code>{agentBrowserRuntimeStatus.version}</code>
                            {/if}
                            </SettingsInfoMenu>
                          </div>
                        {#if agentBrowserRuntimeStatusLoading}
                          <p class="batshit-settings-form-help">Checking runtime installation...</p>
                        {:else if agentBrowserRuntimeStatus?.supportLevel === "docker-sidecar" && !isAgentBrowserRuntimeInstalled()}
                        <p class="batshit-settings-form-help">
                          Docker Agent Browser sidecar is stopped. Start it in <code>Settings -> Admin -> Agent Browser Runtime</code> first.
                        </p>
                        {:else if agentBrowserRuntimeStatus?.dockerUnsupported}
                        <p class="batshit-settings-form-help">
                          Agent Browser is unavailable in this runtime.
                        </p>
                        {:else if !isAgentBrowserRuntimeInstalled()}
                        <p class="batshit-settings-form-help">
                          Runtime not installed. Install it in <code>Settings -> Admin -> Agent Browser Runtime</code> first.
                        </p>
                      {/if}
                        {#if agentBrowserRuntimeStatusError}
                          <p class="batshit-settings-form-help is-danger">{agentBrowserRuntimeStatusError}</p>
                        {/if}
                        </div>
                        <div class="batshit-settings-toggle-disclosure-control">
                          <Switch.Root
                            checked={getNativeAgentBrowserEnabledForUi()}
                            onCheckedChange={guardPrimaryChoice((checked) => {
                              updateNativeToolSetting("agentBrowserEnabled", checked === true);
                              if (checked !== true) {
                                primaryAgentBrowserDefaultsOpen = false;
                              }
                            })}
                            disabled={agentBrowserRuntimeStatusLoading || !isAgentBrowserRuntimeInstalled()}
                          />
                          {#if getNativeAgentBrowserEnabledForUi()}
                            <Collapsible.Trigger class="batshit-settings-toggle-disclosure-trigger">
                              <span class="batshit-settings-toggle-disclosure-label">Agent Browser Defaults</span>
                              <SettingsInfoMenu ariaLabel="About Agent Browser Defaults">
                                {#if isAgentBrowserDockerSidecarRuntime()}
                                  Docker sidecar mode exposes timeout, cloud provider, and extra CLI flag defaults.
                                {:else}
                                  Runtime mode, timeout, session memory, and optional provider overrides.
                                {/if}
                              </SettingsInfoMenu>
                              <ChevronDown
                                class={`batshit-settings-toggle-disclosure-chevron ${primaryAgentBrowserDefaultsOpen ? "is-open" : ""}`}
                              />
                            </Collapsible.Trigger>
                          {/if}
                        </div>
                      </div>

                    {#if getNativeAgentBrowserEnabledForUi()}
                          <Collapsible.Content class="batshit-settings-disclosure-content batshit-settings-subitem-lines">
                            <div class="batshit-settings-form-stack">
                            {#if isAgentBrowserDockerSidecarRuntime()}
                              <div class="batshit-settings-muted-panel space-y-1">
                                <p class="batshit-settings-form-label">Docker Sidecar Runtime</p>
                                <p class="batshit-settings-code-caption">
                                  Runs headless in the Agent Browser sidecar's bundled Chromium. Host Chrome/CDP, live visibility,
                                  executable path, session name, and host profile path are not used in Docker.
                                </p>
                              </div>
                            {/if}

                            {#if !isAgentBrowserDockerSidecarRuntime()}
                            <div class="batshit-settings-toggle-row">
                              <div class="flex items-center gap-1.5">
                                <p class="batshit-settings-parent-label">Live Browser Visibility</p>
                                <SettingsInfoMenu ariaLabel="About Live Browser Visibility">
                                  When enabled by default, browser actions run in headed mode so you can watch them live.
                                  Disable for hidden/headless execution.
                                </SettingsInfoMenu>
                              </div>
                              <Switch.Root
                                checked={getNativeAgentBrowserLiveViewEnabled()}
                                onCheckedChange={guardPrimaryChoice((checked) =>
                                  updateNativeToolSetting("agentBrowserLiveViewEnabled", checked === true))}
                              />
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Browser Runtime Mode</Label.Label>
                                  <SettingsInfoMenu ariaLabel="About Browser Runtime Mode">
                                    Use Chrome CDP when you want Batshit to drive your existing Chrome session
                                    with the usual debug port <code>9222</code>.
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <Select.Root
                                  type="single"
                                  value={getNativeAgentBrowserRuntimeMode() as unknown as string}
                                  onValueChange={guardPrimaryChoice((value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserRuntimeMode(next) ?? "chromium";
                                    updateNativeToolSetting("agentBrowserRuntimeMode", normalized);
                                  })}
                                >
                                  <Select.Trigger class="justify-between">
                                    <span class="truncate">
                                      {NATIVE_AGENT_BROWSER_RUNTIME_MODE_LABELS[getNativeAgentBrowserRuntimeMode()]}
                                    </span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each NATIVE_AGENT_BROWSER_RUNTIME_MODE_OPTIONS as option}
                                      <Select.Item value={option}>
                                        {NATIVE_AGENT_BROWSER_RUNTIME_MODE_LABELS[option]}
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              </div>
                            </div>

                            {#if getNativeAgentBrowserRuntimeMode() === "chrome-cdp"}
                              <div class="batshit-settings-form-row">
                                <div class="batshit-settings-form-copy">
                                  <div class="batshit-settings-form-label-line">
                                    <Label.Label class="batshit-settings-form-label">Chrome CDP port</Label.Label>
                                    <SettingsInfoMenu ariaLabel="About Chrome CDP Port">
                                      Start Chrome with remote debugging enabled, for example:
                                      <code>--remote-debugging-port=9222</code>
                                    </SettingsInfoMenu>
                                  </div>
                                </div>
                                <div class="batshit-settings-form-control">
                                  <Input
                                    type="number"
                                    min="1"
                                    max="65535"
                                    step="1"
                                    value={String(getNativeAgentBrowserCdpPort())}
                                    oninput={(event) => {
                                      const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
                                      updateNativeToolSetting(
                                        "agentBrowserCdpPort",
                                        Number.isFinite(parsed) ? Math.min(65535, Math.max(1, parsed)) : DEFAULT_NATIVE_AGENT_BROWSER_CDP_PORT,
                                      );
                                    }}
                                  />
                                </div>
                              </div>
                            {/if}
                            {/if}

                              <div class="batshit-settings-form-row">
                                <div class="batshit-settings-form-copy">
                                  <div class="batshit-settings-form-label-line">
                                    <Label.Label class="batshit-settings-form-label">Agent Browser Timeout</Label.Label>
                                  </div>
                                </div>
                                <div class="batshit-settings-form-control">
                                <Select.Root
                                  type="single"
                                  value={String(getNativeAgentBrowserTimeoutMs()) as unknown as string}
                                  onValueChange={guardPrimaryChoice((value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const parsed = Number.parseInt(String(next ?? ""), 10);
                                    updateNativeToolSetting(
                                      "agentBrowserTimeoutMs",
                                      Number.isFinite(parsed) ? parsed : DEFAULT_NATIVE_AGENT_BROWSER_TIMEOUT_MS,
                                    );
                                  })}
                                >
                                  <Select.Trigger class="justify-between">
                                    <span class="truncate">{Math.round(getNativeAgentBrowserTimeoutMs() / 1000)} seconds</span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each NATIVE_AGENT_BROWSER_TIMEOUT_OPTIONS as timeoutMsValue}
                                      <Select.Item value={String(timeoutMsValue)}>
                                        {Math.round(timeoutMsValue / 1000)} seconds
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              </div>
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Cloud Provider (Optional)</Label.Label>
                                  <SettingsInfoMenu ariaLabel="About Agent Browser Cloud Provider">
                                    Power-user option. <code>local</code> is the default. Cloud providers need credentials saved in API Keys.
                                    {#if isAgentBrowserDockerSidecarRuntime()}
                                      In Docker, Batshit passes those credentials to the Agent Browser sidecar.
                                    {/if}
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <Select.Root
                                  type="single"
                                  value={getNativeAgentBrowserProvider() as unknown as string}
                                  onValueChange={guardPrimaryChoice((value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserProvider(next) ?? "local";
                                    updateNativeToolSetting("agentBrowserProvider", normalized);
                                  })}
                                >
                                  <Select.Trigger class="justify-between">
                                    <span class="truncate">
                                      {NATIVE_AGENT_BROWSER_PROVIDER_LABELS[getNativeAgentBrowserProvider()]}
                                    </span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each NATIVE_AGENT_BROWSER_PROVIDER_OPTIONS as option}
                                      <Select.Item value={option}>
                                        {NATIVE_AGENT_BROWSER_PROVIDER_LABELS[option]}
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              </div>
                            </div>

                            {#if !isAgentBrowserDockerSidecarRuntime()}
                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Browser Executable Path (Optional)</Label.Label>
                                  <SettingsInfoMenu ariaLabel="About Browser Executable Path">
                                    Override the browser binary path when local defaults are not ideal.
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control is-wide">
                                <Input
                                  placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                                  value={getNativeAgentBrowserExecutablePath()}
                                  oninput={(event) =>
                                    updateNativeToolSetting(
                                      "agentBrowserExecutablePath",
                                      (event.target as HTMLInputElement).value.trim() || null,
                                    )}
                                />
                              </div>
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Default Session Name (Optional)</Label.Label>
                                  <SettingsInfoMenu ariaLabel="About Default Session Name">
                                    Auto-adds <code>--session &lt;name&gt;</code> to Agent Browser bash commands
                                    unless the command already provides one.
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <Input
                                  placeholder="default"
                                  value={getNativeAgentBrowserSession()}
                                  oninput={(event) =>
                                    updateNativeToolSetting(
                                      "agentBrowserSession",
                                      (event.target as HTMLInputElement).value.trim() || null,
                                    )}
                                />
                              </div>
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Default Profile Path (Optional)</Label.Label>
                                  <SettingsInfoMenu ariaLabel="About Default Profile Path">
                                    Auto-adds <code>--profile &lt;path&gt;</code> for persistent cookies or login state
                                    unless already set in the command.
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control is-wide">
                                <Input
                                  placeholder="~/.batshit/ab-profile"
                                  value={getNativeAgentBrowserProfilePath()}
                                  oninput={(event) =>
                                    updateNativeToolSetting(
                                      "agentBrowserProfilePath",
                                      (event.target as HTMLInputElement).value.trim() || null,
                                    )}
                                />
                              </div>
                            </div>
                            {/if}

                            <div class="batshit-settings-form-row is-tall">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Extra CLI Flags (Advanced)</Label.Label>
                                  <SettingsInfoMenu ariaLabel="About Extra CLI Flags">
                                    For power users. Flags are automatically appended to <code>agent-browser</code> bash commands before execution.
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
                                  <div class="min-w-0 flex-1 space-y-1">
                                    <p class="batshit-settings-form-label">
                                      {getMultilineEntryCountLabel(
                                        getNativeAgentBrowserExtraFlagsText(),
                                        "flag",
                                        "flags",
                                        "No extra flags saved",
                                      )}
                                    </p>
                                    <p class="batshit-settings-code-caption line-clamp-3">
                                      {getMultilinePreviewText(
                                        getNativeAgentBrowserExtraFlagsText(),
                                        "Open the editor to add extra Agent Browser CLI flags.",
                                      )}
                                    </p>
                                  </div>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onclick={() => (agentBrowserFlagsEditorOpen = true)}
                                  >
                                    <Pencil aria-hidden="true" />

                                    Edit
                                  </Button>
                                </div>
                              </div>
                            </div>
                            </div>
                          </Collapsible.Content>
                    {/if}
                    </div>
                  </Collapsible.Root>
                  </div>
            </SettingsAccordionCard>
          {/if}

          <div class={`batshit-settings-muted-panel is-loose batshit-voice-lane-map space-y-3 ${hiddenUnless("voice")}`}>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <p class="batshit-settings-form-label">Agent Voice Lane Map</p>
                <p class="batshit-settings-caption">
                  {voiceModeLockedBySpeechToSpeech
                    ? voiceModeLockLabel
                    : effectiveAgentVoiceRuntimeSummary}
                </p>
              </div>
              <Badge
                variant="outline"
                class={`${
                  voiceModeLockedBySpeechToSpeech
                    ? "batshit-settings-pill is-success"
                    : effectiveAgentVoiceRuntimeBadgeClass
                } shrink-0`}
              >
                {voiceModeLockedBySpeechToSpeech
                  ? "Speech-to-speech model"
                  : effectiveAgentVoiceRuntimeLabel}
              </Badge>
            </div>

            <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Microphone</p>
                  <Badge variant="outline" class="batshit-settings-pill shrink-0">
                    {globalInputDeviceBadgeLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">{globalInputDeviceLabel}</p>
                <p class="batshit-settings-caption">Global capture input for this agent.</p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Voice Mode Input</p>
                  <Badge variant="outline" class={`${effectiveAgentVoiceModeInputBadgeClass} shrink-0`}>
                    {effectiveAgentVoiceModeInputLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {effectiveAgentVoiceModeInputMode === "text" ? "Composer text" : "Voice Mode STT"}
                </p>
                <p class="batshit-settings-caption">
                  {voiceModeLockedBySpeechToSpeech
                    ? "Locked while speech-to-speech is active."
                    : `${getVoiceSourceLabel(!agentVoiceModeInputInherited)}.`}
                </p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Turn Mode</p>
                  <Badge
                    variant="outline"
                    class={`${
                      voiceModeLockedBySpeechToSpeech
                        ? "batshit-settings-pill is-success"
                        : effectiveAgentVoiceModeSubmitBadgeClass
                    } shrink-0`}
                  >
                    {voiceModeLockedBySpeechToSpeech ? "Locked" : effectiveAgentVoiceModeSubmitModeLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {voiceModeLockedBySpeechToSpeech
                    ? "Speech-to-speech"
                    : configuredAgentVoiceModeSubmitMode === "manual" && !agentManualTurnAvailable
                      ? "Manual Turn disabled"
                      : effectiveAgentVoiceModeSubmitModeLabel}
                </p>
                <p class="batshit-settings-caption">
                  {voiceModeLockedBySpeechToSpeech
                    ? "Locked while speech-to-speech is active."
                    : agentVoiceModeSubmitSummary}
                </p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Transcribe</p>
                  <Badge variant="outline" class="batshit-settings-pill shrink-0">
                    {effectiveAgentTranscribeLaneLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {resolveVoiceProviderLabel(effectiveAgentTranscribeProviderId)}
                </p>
                <p class="batshit-settings-caption">
                  {getVoiceSourceLabel(!agentTranscribeProviderInherited)}.
                </p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Voice Mode STT</p>
                  <Badge variant="outline" class={`${effectiveAgentVoiceModeSttBadgeClass} shrink-0`}>
                    {effectiveAgentVoiceModeSttLaneLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {resolveVoiceProviderLabel(effectiveAgentVoiceModeSttProviderId)}
                </p>
                <p class="batshit-settings-caption">
                  {voiceModeLockedBySpeechToSpeech
                    ? "Locked while speech-to-speech is active."
                    : `${getVoiceSourceLabel(!agentVoiceModeSttProviderInherited)}.`}
                </p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">Reply Voice</p>
                  <Badge variant="outline" class={`${effectiveAgentTtsBadgeClass} shrink-0`}>
                    {effectiveAgentTtsLaneLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">
                  {resolveVoiceProviderLabel(effectiveAgentTtsProviderId)}
                </p>
                <p class="batshit-settings-caption">
                  {voiceModeLockedBySpeechToSpeech
                    ? "Locked while speech-to-speech is active."
                    : `${getVoiceSourceLabel(!agentTtsProviderInherited)}.`}
                </p>
              </div>

              <div class="space-y-1 border-l border-border/60 pl-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="batshit-settings-child-label">3D Goon Lip Sync</p>
                  <Badge variant="outline" class={`${globalGoonLipSyncBadgeClass} shrink-0`}>
                    {globalGoonLipSyncBadgeLabel}
                  </Badge>
                </div>
                <p class="truncate text-sm text-foreground">{globalGoonLipSyncLabel}</p>
                <p class="batshit-settings-caption">Global mouth animation setting.</p>
              </div>
            </div>
          </div>

          <SettingsAccordionCard
            name="agent-voice-cards"
            title="Transcribe Mode (STT)"
            icon={Mic}
            class={hiddenUnless("voice")}
            contentClass="space-y-4"
            onfocusin={() => (basicSaveScope = "voice")}
            onpointerdown={() => (basicSaveScope = "voice")}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Agent Transcribe Mode">
                Controls mic dictation and uploaded-audio transcription while this agent is selected. Leave fields blank to inherit the global Transcribe Mode default.
              </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
              {#if basicSaveScope === "voice"}
                <SettingsSaveStatus
                  state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                  error={basicSaveError ?? basicValidationError}
                  savingLabel="Saving voice settings..."
                  savedLabel="Saved"
                />
              {/if}
            {/snippet}

            <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
              <p class="batshit-settings-form-label">Transcribe STT</p>
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Provider</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.sttProvider || VOICE_PROVIDER_INHERIT) as unknown as string}
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            sttProvider: next === VOICE_PROVIDER_INHERIT ? "" : next,
                            sttModel: "",
                          },
                        };
                      })}
                    >
                      <Select.Trigger class="justify-between">
                        <span class="flex min-w-0 items-center gap-2">
                          <VoiceProviderIcon providerId={basicForm.voice_profile.sttProvider} />
                          <span class="truncate">
                            {basicForm.voice_profile.sttProvider
                              ? sttProviderOptions.find((option) =>
                                  option.id === basicForm.voice_profile.sttProvider)?.label ?? "Custom STT provider"
                              : "Use Global Default"}
                          </span>
                        </span>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value={VOICE_PROVIDER_INHERIT}>
                          Use Global Default
                        </Select.Item>
                        {#each sttProviderOptions as option (option.id)}
                          <Select.Item value={option.id}>
                            <div class="flex items-center justify-between gap-2">
                              <span class="flex min-w-0 items-center gap-2">
                                <VoiceProviderIcon providerId={option.id} label={option.label} />
                                <span class="truncate">{option.label}</span>
                              </span>
                              <div class="flex shrink-0 items-center gap-1.5">
                                {#if option.ready === false}
                                  <Badge variant="outline" class="batshit-settings-pill is-warning">
                                    {option.statusHint ?? "Not ready"}
                                  </Badge>
                                {/if}
                              </div>
                            </div>
                          </Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Model</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.sttModel || "") as unknown as string}
                      onValueChange={guardPrimaryChoice((value) =>
                        (basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            sttModel: Array.isArray(value) ? value[0] : value,
                          },
                        }))}
                      disabled={!basicForm.voice_profile.sttProvider}
                    >
                      <Select.Trigger class="justify-between">
                        <span class="truncate">
                          {basicForm.voice_profile.sttModel
                            ? basicForm.voice_profile.sttModel
                            : `Use Default${selectedSttDefaultModel ? ` (${selectedSttDefaultModel})` : ""}`}
                        </span>
                        <Badge variant="outline" class="batshit-settings-pill shrink-0">
                          {selectedAgentTranscribeLaneLabel}
                        </Badge>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="">
                          <div class="flex items-center justify-between gap-2">
                            <span>Use Default{selectedSttDefaultModel ? ` (${selectedSttDefaultModel})` : ""}</span>
                            <Badge variant="outline" class="batshit-settings-pill">
                              {selectedAgentTranscribeLaneLabel}
                            </Badge>
                          </div>
                        </Select.Item>
                        {#each sttModelOptions as model (model)}
                          <Select.Item value={model}>
                            <div class="flex items-center justify-between gap-2">
                              <span>{model}</span>
                              <Badge variant="outline" class="batshit-settings-pill">
                                {getTranscribeSttLaneLabel(selectedSttProvider)}
                              </Badge>
                            </div>
                          </Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>

              </div>
            </div>
          </SettingsAccordionCard>

          <SettingsAccordionCard
            name="agent-voice-cards"
            title="Voice Mode (Input/STT + TTS)"
            icon={AudioLines}
            class={hiddenUnless("voice")}
            contentClass="space-y-4"
            open
            onfocusin={() => (basicSaveScope = "voice")}
            onpointerdown={() => (basicSaveScope = "voice")}
          >
            {#snippet info()}
              <SettingsInfoMenu ariaLabel="About Agent Voice Mode">
                Controls how this agent accepts input, listens, and speaks during phone-style Voice Mode. Leave fields blank to inherit global voice defaults.
              </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
              {#if basicSaveScope === "voice"}
                <SettingsSaveStatus
                  state={basicSaveError || basicValidationError ? "error" : basicSaveState}
                  error={basicSaveError ?? basicValidationError}
                  savingLabel="Saving voice settings..."
                  savedLabel="Saved"
                />
              {/if}
            {/snippet}

            {#if voiceModeLockedBySpeechToSpeech}
              <div class="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3">
                <p class="batshit-settings-form-label is-success">
                  Handled by selected speech-to-speech model
                </p>
                <p class="batshit-settings-form-meta is-success">
                  {voiceModeLockLabel}
                </p>
              </div>
            {/if}

            <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
              <div class="flex items-center gap-1.5">
                <p class="batshit-settings-form-label">Voice Runtime</p>
                <SettingsInfoMenu ariaLabel="About Agent Voice Runtime">
                  Leave this on the global default unless this agent should open Voice Mode through a different runtime.
                </SettingsInfoMenu>
              </div>
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Runtime</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.voiceSessionRuntime || VOICE_PROVIDER_INHERIT) as unknown as string}
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            voiceSessionRuntime: next === "direct" || next === "livekit" ? next : "",
                          },
                        };
                      })}
                      disabled={voiceModeLockedBySpeechToSpeech}
                    >
                      <Select.Trigger class="justify-between">
                        <span class="truncate">
                          {basicForm.voice_profile.voiceSessionRuntime === "livekit"
                            ? getVoiceRuntimeLabel("livekit")
                            : basicForm.voice_profile.voiceSessionRuntime === "direct"
                              ? getVoiceRuntimeLabel("direct")
                              : "Use Global Default"}
                        </span>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value={VOICE_PROVIDER_INHERIT}>Use Global Default</Select.Item>
                        <Select.Item value="direct">{getVoiceRuntimeLabel("direct")}</Select.Item>
                        <Select.Item value="livekit">{getVoiceRuntimeLabel("livekit")}</Select.Item>
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>
              </div>
            </div>

            <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5">
                  <p class="batshit-settings-form-label">Voice Mode Input</p>
                  <SettingsInfoMenu ariaLabel="About Agent Voice Mode Input">
                    Choose whether this agent inherits global Voice Mode input, listens through Voice Mode STT, or accepts composer text while still speaking replies.
                  </SettingsInfoMenu>
                </div>
                <Badge variant="outline" class={`${effectiveAgentVoiceModeInputBadgeClass} shrink-0`}>
                  {effectiveAgentVoiceModeInputLabel}
                </Badge>
              </div>
              <p class="batshit-settings-caption">{effectiveAgentVoiceModeInputSummary}</p>
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Input</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.voiceModeInputMode || VOICE_PROVIDER_INHERIT) as unknown as string}
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            voiceModeInputMode: next === "stt" || next === "text" ? next : "",
                          },
                        };
                      })}
                      disabled={voiceModeLockedBySpeechToSpeech}
                    >
                      <Select.Trigger class="justify-between">
                        <span class="truncate">
                          {basicForm.voice_profile.voiceModeInputMode
                            ? getVoiceModeInputLabel(basicForm.voice_profile.voiceModeInputMode)
                            : "Use Global Default"}
                        </span>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value={VOICE_PROVIDER_INHERIT}>
                          <div class="flex items-center justify-between gap-2">
                            <span>Use Global Default</span>
                            <Badge variant="outline" class={getVoiceModeInputBadgeClass(globalVoiceModeInputMode)}>
                              {getVoiceModeInputLabel(globalVoiceModeInputMode)}
                            </Badge>
                          </div>
                        </Select.Item>
                        <Select.Item value="stt">Mic STT</Select.Item>
                        <Select.Item value="text">Text Input</Select.Item>
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>
              </div>
            </div>

            <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5">
                  <p class="batshit-settings-form-label">Turn Mode</p>
                  <SettingsInfoMenu ariaLabel="About Agent Voice Mode Turn Mode">
                    Auto Listen starts the next recorded turn when Batshit is ready for you.
                    Manual Turn lets you start each recorded Direct Voice Mode turn yourself,
                    then stop it to send. Realtime mic, LiveKit, and Text Input use Auto Listen
                    or continuous behavior instead.
                  </SettingsInfoMenu>
                </div>
                <Badge
                  variant="outline"
                  class={`${
                    voiceModeLockedBySpeechToSpeech
                      ? "batshit-settings-pill is-success"
                      : effectiveAgentVoiceModeSubmitBadgeClass
                  } shrink-0`}
                >
                  {voiceModeLockedBySpeechToSpeech ? "Locked" : effectiveAgentVoiceModeSubmitModeLabel}
                </Badge>
              </div>
              <p class="batshit-settings-caption">{agentVoiceModeSubmitSummary}</p>
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Mode</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.voiceModeSubmitMode || VOICE_PROVIDER_INHERIT) as unknown as string}
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        if (next === "manual" && !agentManualTurnAvailable) return;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            voiceModeSubmitMode: next === "auto" || next === "manual" ? next : "",
                          },
                        };
                      })}
                      disabled={voiceModeLockedBySpeechToSpeech}
                    >
                      <Select.Trigger class="justify-between">
                        <span class="truncate">
                          {basicForm.voice_profile.voiceModeSubmitMode
                            ? getVoiceModeSubmitModeLabel(basicForm.voice_profile.voiceModeSubmitMode)
                            : "Use Global Default"}
                        </span>
                        <Badge
                          variant="outline"
                          class={`${
                            voiceModeLockedBySpeechToSpeech
                              ? "batshit-settings-pill is-success"
                              : effectiveAgentVoiceModeSubmitBadgeClass
                          } shrink-0`}
                        >
                          {voiceModeLockedBySpeechToSpeech ? "Locked" : effectiveAgentVoiceModeSubmitModeLabel}
                        </Badge>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value={VOICE_PROVIDER_INHERIT}>
                          <div class="flex items-center justify-between gap-2">
                            <span>Use Global Default</span>
                            <Badge variant="outline" class="batshit-settings-pill">
                              {getVoiceModeSubmitModeLabel(globalVoiceModeSubmitMode)}
                            </Badge>
                          </div>
                        </Select.Item>
                        <Select.Item value="auto">Auto Listen</Select.Item>
                        <Select.Item value="manual" disabled={!agentManualTurnAvailable}>
                          <div class="flex items-center justify-between gap-2">
                            <span>Manual Turn</span>
                            {#if !agentManualTurnAvailable}
                              <Badge variant="outline" class="batshit-settings-pill is-warning">
                                Unavailable
                              </Badge>
                            {/if}
                          </div>
                        </Select.Item>
                      </Select.Content>
                    </Select.Root>
                    {#if !voiceModeLockedBySpeechToSpeech && !agentManualTurnAvailable}
                      <p class="batshit-settings-inline-alert is-info">
                        {agentManualTurnUnavailableReason}
                      </p>
                    {/if}
                  </div>
                </div>
              </div>
            </div>

            <div class={`batshit-settings-card-subtle-frame is-spacious space-y-3 ${agentVoiceModeUsesSttInput ? "" : "opacity-75"}`}>
              <div class="flex items-center gap-1.5">
                <p class="batshit-settings-form-label">Voice Mode STT</p>
                <SettingsInfoMenu ariaLabel="About Agent Voice Mode STT">
                  Used only for phone-style two-way voice chat. Leave blank to inherit the global Voice Mode STT defaults.
                </SettingsInfoMenu>
                {#if !agentVoiceModeUsesSttInput}
                  <Badge variant="outline" class="batshit-settings-pill is-info">
                    Not used in Text Input
                  </Badge>
                {/if}
              </div>
              {#if !agentVoiceModeUsesSttInput}
                <p class="batshit-settings-inline-alert is-info">
                  Saved for Mic STT, but ignored while this agent's effective Voice Mode Input is Text Input.
                </p>
              {/if}
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Provider</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.realtimeSttProvider || VOICE_PROVIDER_INHERIT) as unknown as string}
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            realtimeSttProvider: next === VOICE_PROVIDER_INHERIT ? "" : next,
                            realtimeSttModel: "",
                          },
                        };
                      })}
                      disabled={voiceModeLockedBySpeechToSpeech || !agentVoiceModeUsesSttInput}
                    >
                      <Select.Trigger class="justify-between">
                        <span class="flex min-w-0 items-center gap-2">
                          <VoiceProviderIcon providerId={basicForm.voice_profile.realtimeSttProvider} />
                          <span class="truncate">
                            {basicForm.voice_profile.realtimeSttProvider
                              ? realtimeSttProviderOptions.find((option) =>
                                  option.id === basicForm.voice_profile.realtimeSttProvider)?.label ?? "Custom realtime STT provider"
                              : "Use Global Default"}
                          </span>
                        </span>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value={VOICE_PROVIDER_INHERIT}>
                          Use Global Default
                        </Select.Item>
                        {#each realtimeSttProviderOptions as option (option.id)}
                          <Select.Item value={option.id}>
                            <div class="flex items-center justify-between gap-2">
                              <span class="flex min-w-0 items-center gap-2">
                                <VoiceProviderIcon providerId={option.id} label={option.label} />
                                <span class="truncate">{option.label}</span>
                              </span>
                              <div class="flex shrink-0 items-center gap-1.5">
                                {#if option.ready === false}
                                  <Badge variant="outline" class="batshit-settings-pill is-warning">
                                    {option.statusHint ?? "Not ready"}
                                  </Badge>
                                {/if}
                              </div>
                            </div>
                          </Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Model</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.realtimeSttModel || "") as unknown as string}
                      onValueChange={guardPrimaryChoice((value) =>
                        (basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            realtimeSttModel: Array.isArray(value) ? value[0] : value,
                          },
                        }))}
                      disabled={
                        !basicForm.voice_profile.realtimeSttProvider ||
                        voiceModeLockedBySpeechToSpeech ||
                        !agentVoiceModeUsesSttInput
                      }
                    >
                      <Select.Trigger class="justify-between">
                        <span class="truncate">
                          {basicForm.voice_profile.realtimeSttModel
                            ? basicForm.voice_profile.realtimeSttModel
                            : `Use Default${selectedRealtimeSttDefaultModel ? ` (${selectedRealtimeSttDefaultModel})` : ""}`}
                        </span>
                        <Badge variant="outline" class={`${selectedAgentVoiceModeSttBadgeClass} shrink-0`}>
                          {selectedAgentVoiceModeSttLaneLabel}
                        </Badge>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="">
                          <div class="flex items-center justify-between gap-2">
                            <span>Use Default{selectedRealtimeSttDefaultModel ? ` (${selectedRealtimeSttDefaultModel})` : ""}</span>
                            <Badge variant="outline" class={`${selectedAgentVoiceModeSttBadgeClass} shrink-0`}>
                              {selectedAgentVoiceModeSttLaneLabel}
                            </Badge>
                          </div>
                        </Select.Item>
                        {#each realtimeSttModelOptions as model (model)}
                          <Select.Item value={model}>
                            <div class="flex items-center justify-between gap-2">
                              <span>{model}</span>
                              <Badge variant="outline" class={getVoiceModeSttBadgeClass(selectedRealtimeSttProvider)}>
                                {getVoiceModeSttLaneLabel(selectedRealtimeSttProvider)}
                              </Badge>
                            </div>
                          </Select.Item>
                        {/each}
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>

              </div>
            </div>

            <div class="batshit-settings-card-subtle-frame is-spacious space-y-3">
              <div class="flex items-center gap-1.5">
                <p class="batshit-settings-form-label">Text-to-Speech (TTS)</p>
                <SettingsInfoMenu ariaLabel="About Agent Text-to-Speech">
                  Controls this agent&apos;s speaking voice during Voice Mode and generated voice previews.
                </SettingsInfoMenu>
              </div>
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Provider</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <div class="batshit-settings-form-control-group">
                      <Select.Root
                        type="single"
                        value={(basicForm.voice_profile.provider || VOICE_PROVIDER_INHERIT) as unknown as string}
                        onValueChange={guardPrimaryChoice((value) =>
                          handleVoiceProviderChange(Array.isArray(value) ? value[0] : value))}
                        disabled={voiceModeLockedBySpeechToSpeech}
                      >
                        <Select.Trigger class="justify-between">
                          <span class="flex min-w-0 items-center gap-2">
                            <VoiceProviderIcon providerId={basicForm.voice_profile.provider} />
                            <span class="truncate">
                              {basicForm.voice_profile.provider
                                ? voiceProviderOptions.find((option) =>
                                    option.id === basicForm.voice_profile.provider)?.label ?? "Custom provider"
                                : "Use Global Default"}
                            </span>
                          </span>
                        </Select.Trigger>
                        <Select.Content>
                          <Select.Item value={VOICE_PROVIDER_INHERIT}>
                            Use Global Default
                          </Select.Item>
                          {#each voiceProviderOptions as option (option.id)}
                            <Select.Item value={option.id}>
                              <div class="flex items-center justify-between gap-2">
                                <span class="flex min-w-0 items-center gap-2">
                                  <VoiceProviderIcon providerId={option.id} label={option.label} />
                                  <span class="truncate">{option.label}</span>
                                </span>
                                <div class="flex shrink-0 items-center gap-1.5">
                                  {#if option.ready === false}
                                    <Badge variant="outline" class="batshit-settings-pill is-warning">
                                      {option.statusHint ?? "Not ready"}
                                    </Badge>
                                  {/if}
                                </div>
                              </div>
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                      {#if voiceProvidersError}
                        <p class="batshit-settings-form-meta is-warning">{voiceProvidersError}</p>
                      {/if}
                    </div>
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Model</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <div class="batshit-settings-field-cluster">
                      {#if !voiceModelManual}
                        <Select.Root
                          type="single"
                          value={(basicForm.voice_profile.model || "") as unknown as string}
                          onValueChange={guardPrimaryChoice((value) =>
                            (basicForm = {
                              ...basicForm,
                              voice_profile: {
                                ...basicForm.voice_profile,
                                model: Array.isArray(value) ? value[0] : value,
                              },
                            }))}
                          disabled={voiceModeLockedBySpeechToSpeech}
                        >
                          <Select.Trigger class="min-w-0 flex-1 justify-between">
                            <span class="truncate">
                              {basicForm.voice_profile.model
                                ? basicForm.voice_profile.model
                                : `Use Default${selectedVoiceDefaultModel ? ` (${selectedVoiceDefaultModel})` : ""}`}
                            </span>
                            <Badge variant="outline" class={`${selectedAgentTtsBadgeClass} shrink-0`}>
                              {selectedAgentTtsLaneLabel}
                            </Badge>
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="">
                              <div class="flex items-center justify-between gap-2">
                                <span>Use Default{selectedVoiceDefaultModel ? ` (${selectedVoiceDefaultModel})` : ""}</span>
                                <Badge variant="outline" class={`${selectedAgentTtsBadgeClass} shrink-0`}>
                                  {selectedAgentTtsLaneLabel}
                                </Badge>
                              </div>
                            </Select.Item>
                            {#each voiceModelOptions as model (model)}
                              <Select.Item value={model}>
                                <div class="flex items-center justify-between gap-2">
                                  <span>{model}</span>
                                  <Badge variant="outline" class={getTtsBadgeClass(selectedVoiceProvider)}>
                                    {getTtsLaneLabel(selectedVoiceProvider)}
                                  </Badge>
                                </div>
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      {:else}
                        <div class="batshit-settings-field-lane flex items-center gap-2">
                          <Input
                            id="voice-model"
                            class="min-w-0 flex-1"
                            placeholder="gpt-4o-mini-tts, eleven_multilingual_v2, etc."
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck={false}
                            data-lpignore="true"
                            data-1p-ignore="true"
                            disabled={voiceModeLockedBySpeechToSpeech}
                            bind:value={basicForm.voice_profile.model}
                          />
                          <Badge variant="outline" class={`${selectedAgentTtsBadgeClass} shrink-0`}>
                            {selectedAgentTtsLaneLabel}
                          </Badge>
                        </div>
                      {/if}
                      <Button
                        variant="ghost"
                        size="icon"
                        class="batshit-button-shrink-0"
                        onclick={() => (voiceModelManual = !voiceModelManual)}
                        disabled={voiceModeLockedBySpeechToSpeech}
                        title={voiceModelManual ? "Use model list" : "Enter model manually"}
                        aria-label={voiceModelManual ? "Use model list" : "Enter model manually"}
                      >
                        <Pencil />
                      </Button>
                    </div>
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Voice</Label.Label>
                      <SettingsInfoMenu ariaLabel="About Agent Voice">
                        This list includes cloned voices when the current provider supports them.
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <div class="batshit-settings-form-control-group">
                      <div class="batshit-settings-field-cluster">
                        {#if canSelectAgentVoices && !voiceIdManual}
                          <Select.Root
                            type="single"
                            value={(basicForm.voice_profile.voiceId || "") as unknown as string}
                            onValueChange={guardPrimaryChoice((value) => {
                              const voiceId = Array.isArray(value) ? value[0] : value;
                              const selected = agentVoiceOptions.find(
                                (option) => option.id === voiceId,
                              );
                              basicForm = {
                                ...basicForm,
                                voice_profile: {
                                  ...basicForm.voice_profile,
                                  voiceId,
                                  profileId: selected?.profileId ?? "",
                                  model:
                                    selected?.profileId && selected.model
                                      ? selected.model
                                      : basicForm.voice_profile.model,
                                },
                              };
                            })}
                            disabled={voiceModeLockedBySpeechToSpeech}
                          >
                            <Select.Trigger class="min-w-0 flex-1 justify-between">
                              <span class="truncate">
                                {basicForm.voice_profile.voiceId
                                  ? agentVoiceOptions.find(
                                      (option) => option.id === basicForm.voice_profile.voiceId,
                                    )?.name ?? "Selected voice"
                                  : `Use Default${selectedVoiceProvider?.defaultVoice ? ` (${selectedVoiceProvider.defaultVoice})` : ""}`}
                              </span>
                            </Select.Trigger>
                            <Select.Content>
                              <Select.Item value="">
                                Use Default{selectedVoiceProvider?.defaultVoice ? ` (${selectedVoiceProvider.defaultVoice})` : ""}
                              </Select.Item>
                              {#each agentVoiceOptions as voice (voice.id)}
                                <Select.Item value={voice.id}>
                                  <div class="flex items-center gap-2">
                                    <span>{voice.name}</span>
                                    {#if voice.isClone}
                                      <Badge variant="outline" class="batshit-settings-child-label">Clone</Badge>
                                    {/if}
                                  </div>
                                </Select.Item>
                              {/each}
                            </Select.Content>
                          </Select.Root>
                        {:else}
                          <Input
                            id="voice-id"
                            class="min-w-0 flex-1"
                            placeholder={selectedVoiceProvider?.defaultVoice ?? "Voice ID"}
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck={false}
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-form-type="other"
                            disabled={voiceModeLockedBySpeechToSpeech}
                            bind:value={basicForm.voice_profile.voiceId}
                          />
                        {/if}
                        {#if canSelectAgentVoices}
                          <Button
                            variant="ghost"
                            size="icon"
                            class="batshit-button-shrink-0"
                            onclick={() => {
                              void loadVoiceProfiles();
                              if (basicForm.voice_profile.provider) {
                                void loadAgentVoices(
                                  basicForm.voice_profile.provider,
                                  basicForm.voice_profile.model ?? "",
                                );
                              }
                            }}
                            disabled={voiceRefreshBusy || voiceModeLockedBySpeechToSpeech}
                            title="Refresh voice list"
                            aria-label="Refresh voice list"
                          >
                            <RefreshCcw class={`${voiceRefreshBusy ? "animate-spin" : ""}`} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            class="batshit-button-shrink-0"
                            onclick={() => {
                              voiceIdManual = !voiceIdManual;
                              if (voiceIdManual) {
                                basicForm = {
                                  ...basicForm,
                                  voice_profile: {
                                    ...basicForm.voice_profile,
                                    profileId: "",
                                  },
                                };
                              }
                            }}
                            disabled={voiceModeLockedBySpeechToSpeech}
                            title={voiceIdManual ? "Use voice list" : "Enter voice manually"}
                            aria-label={voiceIdManual ? "Use voice list" : "Enter voice manually"}
                          >
                            <Pencil />
                          </Button>
                        {/if}
                      </div>
                      {#if voiceOptionsError}
                        <p class="batshit-settings-form-meta is-warning">{voiceOptionsError}</p>
                      {/if}
                      {#if voiceProfilesError}
                        <p class="batshit-settings-form-meta is-warning">{voiceProfilesError}</p>
                      {/if}
                    </div>
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label">Italic narration</Label.Label>
                      <SettingsInfoMenu ariaLabel="About Agent Italic Narration">
                        Choose whether this agent inherits the global italic narration behavior or overrides it for spoken replies.
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <Select.Root
                      type="single"
                      value={(basicForm.voice_profile.ttsItalicNarrationBehavior ||
                        VOICE_ITALIC_NARRATION_INHERIT) as unknown as string}
                      onValueChange={guardPrimaryChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            ttsItalicNarrationBehavior:
                              next === "speak" || next === "silent" ? next : "",
                          },
                        };
                      })}
                      disabled={voiceModeLockedBySpeechToSpeech}
                    >
                      <Select.Trigger class="justify-between">
                        <span class="truncate">
                          {getAgentItalicNarrationSelectLabel(
                            basicForm.voice_profile.ttsItalicNarrationBehavior,
                            globalTtsItalicNarrationBehavior,
                          )}
                        </span>
                        <Badge
                          variant="outline"
                          class={`${
                            agentTtsItalicNarrationInherited
                              ? "batshit-settings-pill"
                              : "batshit-settings-pill is-info"
                          } shrink-0`}
                        >
                          {agentTtsItalicNarrationInherited ? "Global" : "Agent"}
                        </Badge>
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value={VOICE_ITALIC_NARRATION_INHERIT}>
                          Use Global Default ({getItalicNarrationLabel(globalTtsItalicNarrationBehavior)})
                        </Select.Item>
                        <Select.Item value="speak">Spoken</Select.Item>
                        <Select.Item value="silent">Silent</Select.Item>
                      </Select.Content>
                    </Select.Root>
                  </div>
                </div>

                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <div class="batshit-settings-form-label-line">
                      <Label.Label class="batshit-settings-form-label" for="agent-voice-test">Test Phrase</Label.Label>
                    </div>
                  </div>
                  <div class="batshit-settings-form-control">
                    <div class="batshit-settings-field-cluster">
                      <Input
                        id="agent-voice-test"
                        class="min-w-0 flex-1"
                        autocomplete="off"
                        autocorrect="off"
                        autocapitalize="off"
                        spellcheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        data-form-type="other"
                        disabled={voiceModeLockedBySpeechToSpeech}
                        bind:value={agentVoiceTestPhrase}
                      />
                      <Button
                        size="icon"
                        variant="outline"
                        class="batshit-button-shrink-0"
                        onclick={handleAgentVoicePreview}
                        disabled={agentVoicePreviewBusy || voiceModeLockedBySpeechToSpeech}
                        title="Play test phrase"
                        aria-label="Play test phrase"
                      >
                        {#if agentVoicePreviewBusy}
                          <Loader2 class="animate-spin" />
                        {:else}
                          <Play />
                        {/if}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

            </div>

            <div class="flex justify-end">
              <Button size="sm" variant="ghost" onclick={resetVoiceProfile}>
                <RotateCcw aria-hidden="true" />
                Reset Voice Overrides
              </Button>
            </div>
          </SettingsAccordionCard>

          <AgentAccessAssignmentsSection
            sectionClass={hiddenUnless("access")}
            {subagentsLoading}
            {subagents}
            {selectedSubagentIds}
            {selectedAgentId}
            primaryAgentLabel={getPrimaryAgentDisplayLabel(basicForm.agentType)}
            compatibleSubagentTypesLabel={formatCompatibleSubagentTypes(basicForm.agentType)}
            {assignmentSaveState}
            {assignmentSaveError}
            workersEnabled={basicForm.workers_enabled}
            workersMaxConcurrent={WORKERS_MAX_CONCURRENT}
            workersMaxRunsPerTurn={WORKERS_MAX_RUNS_PER_TURN}
            onWorkersEnabledChange={guardPrimaryChoice((enabled) => {
              basicForm = { ...basicForm, workers_enabled: enabled };
            })}
            {accessSaveState}
            {accessSaveError}
            {accessSaveScope}
            {accessResourcesLoading}
            {accessResourcesLoaded}
            {accessResourcesError}
            {accessSlashCommands}
            {accessArtifacts}
            {isSubagentCompatible}
            {formatSubagentBadge}
            {getSlashCommandEnabledForEntity}
            {getArtifactEnabledForEntity}
            {getArtifactAccessScope}
            {getArtifactPlacementLabel}
            onSubagentToggle={handleSubagentToggle}
            onSlashCommandToggle={toggleSlashCommandAccess}
            onArtifactToggle={toggleArtifactAccess}
            onAccessSaveScopeChange={(scope) => {
              accessSaveScope = scope
            }}
          />

          <AgentDeleteDisclosure
            bind:open={primaryDeleteOpen}
            sectionClass={hiddenUnless("core")}
            title="Delete Primary Agent"
            paragraphs={[
              basicForm.agentType === "n8n"
                ? "This saved record uses the retired n8n Primary Agent type. Deleting it is the only supported action; create an API or CLI agent for chat."
                : "Permanently removes this Primary Agent’s settings, zip overrides, MCP defaults, and avatar pictures. The confirm dialog asks whether to delete its own chats too; group chats stay.",
              "Subagent assignments and MCP selections are cleared during deletion."
            ]}
            error={agentDeleteError}
            busy={agentDeleteState === "deleting"}
            disabled={!selectedAgentId || agentDeleteState === "deleting"}
            onDelete={handleDeletePrimaryAgent}
          />
              </fieldset>
      </div>
      <!-- Primary Agent Settings End -->
    {:else if selectedEntity?.kind === "subagent" && selectedEditableSubagentId}
      <!-- Subagent Settings Start -->
      <div class="batshit-settings-surface space-y-6">
              {#if subagentSettingsReadWaiting || subagentOwnedSaveInFlightUi}
                <div class="batshit-settings-note is-dashed flex items-center gap-2" data-testid="subagent-settings-read-wait" role="status">
                  {#if subagentReadWaitError || subagentSaveWaitExpiredUi}
                    <AlertCircle class="h-4 w-4" />
                    <span>{subagentReadWaitError ?? "Your last change to this subagent did not confirm within 30 seconds. Batshit does not know if it was saved. Retry reads the record."}</span>
                  {:else}
                    <Loader2 class="h-4 w-4 animate-spin" />
                    <span>Waiting for saved subagent settings…</span>
                  {/if}
                  <Button variant="outline" size="sm" onclick={retrySubagentSettingsRead}>Retry</Button>
                </div>
              {/if}
              <fieldset disabled={subagentOwnedSaveInFlightUi} inert={subagentOwnedSaveInFlightUi} class="min-w-0 space-y-6 border-0 p-0 m-0">
              {#if subagentDetailLoading}
                <div
                  class="batshit-settings-note is-dashed flex items-center gap-2"
                >
                  <Loader2 class="h-4 w-4 animate-spin" />
                  Loading subagent…
                </div>
              {/if}

              <Tabs.Root bind:value={activeSubagentSettingsTab} class="w-full">
                <Tabs.List class="flex w-full flex-wrap gap-2">
                  <Tabs.Trigger
                    value="core"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <BatshitIcon id="core-basic" class="h-3.5 w-3.5" />
                    <span>Core</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="tools"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <Wrench class="h-3.5 w-3.5" />
                    <span>Tools</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="instructions"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <BatshitIcon id="instructions" class="h-3.5 w-3.5" />
                    <span>Instructions</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="access"
                    class="min-w-[104px] flex-1 gap-2 sm:flex-none"
                  >
                    <BatshitIcon id="access" class="h-3.5 w-3.5" />
                    <span>Access</span>
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs.Root>

              {#if activeSubagentSettingsTab === "tools"}
                <AgentMcpDefaultsCard
                  agentId={selectedEditableSubagentId}
                  toolHostScope={getSubagentToolHostScope(subagentForm.subagentType)}
                  userId={data?.user?.id ?? null}
                  accordionName="subagent-tools-cards"
                  toolGridTitle="Tool Settings Grid"
                  defaultMCPGateways={subagentDefaultMCPGateways}
                  defaultMCPToolSelections={subagentDefaultMCPToolSelections}
                  defaultCliToolIds={subagentDefaultCliToolIds}
                  cliToolIdsExplicit={subagentCliToolIdsExplicit}
                  dcmDisplaySettings={subagentDcmDisplaySettings}
                  mcpSaveState={subagentEditSaveState}
                  mcpSaveError={subagentEditSaveError}
                  mcpLastSaved={subagentEditLastSaved}
                  mcpRenderNonce={subagentMcpRenderNonce}
                  nativeDynamicMcpEnabled={
                    getNativeToolToggle("dynamicMcpEnabled", true, "subagent")
                  }
                  nativeCliToolsEnabled={getNativeToolToggle("cliToolsEnabled", true, "subagent")}
                  nativeToolSettings={getNativeToolsSettings("subagent")}
                  isCodexMode={isCodexCliSubagentProvider}
                  onGatewaysChange={guardSubagentChoice(handleSubagentMcpGatewaysChange)}
                  onDcmDisplaySettingsChange={guardSubagentChoice(handleSubagentMcpDcmDisplaySettingsChange)}
                  onCliToolIdsChange={guardSubagentChoice(handleSubagentCliToolSelectionsChange)}
                  getToolZipOverride={getMcpToolZipOverride}
                  onToolZipOverrideChange={guardSubagentChoice(handleMcpToolZipOverrideChange)}
                  showZipControls={false}
                  showZipModeControls={false}
                  showPostTableControls={false}
                  getNonMcpZipOverride={getNonMcpZipOverrideById}
                  onNonMcpZipOverrideChange={guardSubagentChoice(handleNonMcpZipOverrideChangeById)}
                  onZipAiViewModeChange={guardSubagentChoice(handleZipAiViewModeChange)}
                  fullWidthTable={true}
                />
              {/if}

              <SettingsAccordionCard
                name="subagent-core-cards"
                title="Basic Settings"
                batshitIcon="core-basic"
                class={hiddenUnlessSubagent("core")}
                contentClass="space-y-6"
                open
                onfocusin={() => (subagentSaveScope = "core")}
                onpointerdown={() => (subagentSaveScope = "core")}
              >
                {#snippet actions()}
                    {#if subagentSaveScope === "core"}
                      <SettingsSaveStatus
                        state={subagentEditSaveError || subagentValidationError ? "error" : subagentEditSaveState}
                        error={subagentEditSaveError ?? subagentValidationError}
                        savingLabel="Saving subagent..."
                        savedLabel="Saved"
                      />
                    {/if}
                {/snippet}
                  <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
                    <div class="space-y-5">
                      <div class="batshit-settings-form-stack">
                        <div class="batshit-settings-identity-block">
                          <div class="batshit-settings-identity-name-row">
                            <div class="batshit-settings-form-copy">
                              <div class="batshit-settings-form-label-line">
                                <Label.Label class="batshit-settings-form-label" for="subagent-display">
                                  Subagent Display Name
                                </Label.Label>
                              </div>
                            </div>
                            <div class="batshit-settings-form-control">
                              <Input
                                id="subagent-display"
                                placeholder="Subagent name"
                                bind:value={subagentForm.displayName}
                              />
                            </div>
                          </div>
                          <div class="batshit-settings-identity-meta-row">
                            <div class="batshit-settings-identity-meta-item">
                              <span class="whitespace-nowrap">Subagent ID:</span>
                              <span class="batshit-settings-code-caption">{selectedEditableSubagentId ?? "—"}</span>
                              <Button
                                variant="ghost"
                                size="icon"

                                onclick={() => copyId(selectedEditableSubagentId, "Subagent ID")}
                                disabled={!selectedEditableSubagentId}
                                title="Copy Subagent ID"
                              >
                                <Copy  />
                              </Button>
                            </div>
                            <div class="batshit-settings-identity-meta-item">
                              <span class="whitespace-nowrap">Subagent Type:</span>
                              <span class={subagentTypeBadgeClass(subagentForm.subagentType)}>
                                {formatSubagentTypeLabel(subagentForm.subagentType)}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div class="batshit-settings-form-row">
                          <div class="batshit-settings-form-copy">
                            <div class="batshit-settings-form-label-line">
                              <Label.Label class="batshit-settings-form-label">Default Model</Label.Label>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger
                                  class={SETTINGS_INFO_TRIGGER_CLASS}
                                  aria-label="About Subagent Default Model"
                                >
                                  <Info class="h-3.5 w-3.5" />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content
                                  align="start"
                                  side="bottom"
                                  class={SETTINGS_INFO_CONTENT_CLASS}
                                >
                                  {#if subagentForm.subagentType === "api"}
                                    This model is used directly by Batshit when this API Subagent runs.
                                  {:else if subagentForm.subagentType === "cli"}
                                    This model decides whether this CLI Subagent runs through Codex or Claude.
                                  {:else}
                                    This model is used automatically for this Subagent when the workflow resolves model settings through the usual n8n expressions.
                                  {/if}
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                              {#if unsupportedSubagentModelParams.length}
                                <DropdownMenu.Root>
                                  <DropdownMenu.Trigger
                                    class="batshit-settings-info-trigger is-amber inline-flex shrink-0 items-center justify-center"
                                    aria-label="About Ignored Subagent Model Settings"
                                  >
                                    <Info class="h-3.5 w-3.5" />
                                  </DropdownMenu.Trigger>
                                  <DropdownMenu.Content
                                    align="start"
                                    side="bottom"
                                    class="batshit-settings-info-content batshit-settings-card-elevated is-amber z-[var(--z-popover)] w-72"
                                  >
                                    {unsupportedSubagentModelParams.join(", ")} will be ignored inside this n8n workflow.
                                  </DropdownMenu.Content>
                                </DropdownMenu.Root>
                              {/if}
                            </div>
                          </div>
                          <div class="batshit-settings-form-control">
                            <div class="batshit-settings-form-control-group">
                              <div class="batshit-settings-field-cluster">
                                <div class="batshit-settings-field-lane">
                                  <Select.Root
                                    type="single"
                                    value={(selectedSubagentModelId ?? "") as unknown as string}
                                    onValueChange={guardSubagentChoice((value) =>
                                      handleSubagentModelChange(
                                        Array.isArray(value) ? value[0] : value,
                                      ))}
                                  >
                                    <Select.Trigger class="w-full justify-between">
                                      {#if selectedSubagentModelId}
                                        {@const model = savedModels.find(
                                          (item) => item.id === selectedSubagentModelId,
                                        )}
                                        <div class="flex min-w-0 items-center gap-2">
                                          <ModelProviderIcon
                                            modelId={model?.modelId ?? subagentForm.primary_model_name}
                                            modelName={model?.modelName ?? subagentForm.primary_model_name}
                                            provider={model?.provider ?? subagentForm.primary_model_provider ?? ""}
                                            size="md"
                                            badgeProvider={model ? getSavedModelBadgeProvider(model) : undefined}
                                          />
                                          <span class="truncate">{model?.modelName ?? subagentForm.primary_model_name ?? selectedSubagentModelId}</span>
                                        </div>
                                      {:else}
                                        <span class="batshit-settings-caption">
                                          Choose a Saved Model
                                        </span>
                                      {/if}
                                    </Select.Trigger>
                                    <Select.Content>
                                      {#if savedModelsLoading}
                                        <Select.Label>Loading Models…</Select.Label>
                                      {:else if subagentModelMenuItems.length === 0}
                                        <Select.Label>No Saved Models Yet</Select.Label>
                                      {:else}
                                        {#each subagentModelMenuItems as item (item.model.id)}
                                          {@const model = item.model}
                                          {@const availability = item.availability}
                                          <Select.Item
                                            value={model.id}
                                            disabled={availability.disabled}
                                          >
                                            <div class="flex items-center gap-2 w-full">
                                              <ModelProviderIcon
                                                modelId={model.modelId}
                                                modelName={model.modelName}
                                                provider={model.provider}
                                                size="md"
                                                badgeProvider={getSavedModelBadgeProvider(model)}
                                              />
                                              <div class="flex flex-col min-w-0">
                                                <span class="truncate">{model.modelName}</span>
                                                <span class="batshit-settings-caption batshit-model-id truncate">{model.modelId}</span>
                                              </div>
                                              {#if availability.disabled}
                                                <span class="ml-auto flex max-w-[140px] items-center gap-1 truncate text-[11px] text-muted-foreground">
                                                  <Lock class="h-3 w-3 shrink-0" />
                                                  <span class="truncate">{availability.reason}</span>
                                                </span>
                                              {/if}
                                            </div>
                                          </Select.Item>
                                        {/each}
                                      {/if}
                                    </Select.Content>
                                  </Select.Root>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  class="batshit-button-shrink-0"
                                  onclick={refreshModelPickerData}
                                  disabled={savedModelsLoading || modelConnectionOptionsLoading}
                                  title="Refresh Saved Models"
                                >
                                  <RefreshCcw
                                    class={`${savedModelsLoading || modelConnectionOptionsLoading ? "animate-spin" : ""}`}
                                  />
                                </Button>
                              </div>

                              {#if selectedSubagentModelId}
                                {@const selected =
                                  savedModels.find((item) => item.id === selectedSubagentModelId) ?? null}
                                {@const availability = selected
                                  ? getModelPresetAvailability({
                                      model: selected,
                                      agentType: getSubagentToolHostScope(subagentForm.subagentType),
                                      connectionOptions: null,
                                    })
                                  : null}
                                {#if availability?.disabled}
                                  <p class="batshit-settings-form-meta is-warning">
                                    {availability.reason}
                                  </p>
                                {/if}
                              {:else if subagentForm.subagentType === "api" && subagentForm.primary_model_name && !subagentForm.primary_model_preset_id}
                                <p class="batshit-settings-form-meta is-warning">
                                  Pick this Subagent's model again ({subagentForm.primary_model_name}) so Batshit knows which connection to use. It will not run until you do.
                                </p>
                              {/if}
                            </div>
                          </div>
                        </div>

                        <div class="batshit-settings-form-row">
                          <div class="batshit-settings-form-copy">
                            <div class="batshit-settings-form-label-line">
                              <Label.Label class="batshit-settings-form-label" for="subagent-timeout">
                                Call Timeout
                              </Label.Label>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger
                                  class={SETTINGS_INFO_TRIGGER_CLASS}
                                  aria-label="About Subagent Call Timeout"
                                >
                                  <Info class="h-3.5 w-3.5" />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content
                                  align="start"
                                  side="bottom"
                                  class={SETTINGS_INFO_CONTENT_CLASS}
                                >
                                  Leave blank to use the type default: 180 seconds for API and n8n Workflow Subagents, or 300 seconds for CLI Subagents. Custom values can be 10 to 600 seconds. This covers the call itself, not time spent waiting for a turn: Batshit runs one call per Subagent at a time so its thread stays intact, so a call made while this Subagent is already busy waits first and can take up to about twice this long overall. Batshit says so in the result when that happens. Use Workers for work that should genuinely run at the same time.
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </div>
                          </div>
                          <div class="batshit-settings-form-control">
                            <Input
                              id="subagent-timeout"
                              type="number"
                              min="10"
                              max="600"
                              step="1"
                              placeholder={subagentForm.subagentType === "cli" ? "300" : "180"}
                              bind:value={subagentForm.timeout_seconds}
                            />
                          </div>
                        </div>

                        {#if isWorkflowBackedSubagentType(subagentForm.subagentType)}
                          <div class="batshit-settings-form-row">
                            <div class="batshit-settings-form-copy">
                              <div class="batshit-settings-form-label-line">
                                <Label.Label class="batshit-settings-form-label" for="subagent-webhook">
                                  Production Webhook URL
                                </Label.Label>
                                <DropdownMenu.Root>
                                  <DropdownMenu.Trigger
                                    class={SETTINGS_INFO_TRIGGER_CLASS}
                                    aria-label="About Subagent Production Webhook URL"
                                  >
                                    <Info class="h-3.5 w-3.5" />
                                  </DropdownMenu.Trigger>
                                  <DropdownMenu.Content
                                    align="start"
                                    side="bottom"
                                    class={SETTINGS_INFO_CONTENT_CLASS}
                                  >
                                    Use the Production Webhook URL, not the Test Webhook URL.
                                  </DropdownMenu.Content>
                                </DropdownMenu.Root>
                              </div>
                            </div>
                            <div class="batshit-settings-form-control is-wide">
                              <Input
                                id="subagent-webhook"
                                placeholder="https://localhost:5678/webhook/..."
                                bind:value={subagentForm.webhook_url}
                              />
                            </div>
                          </div>
                        {/if}
                      </div>
                    </div>

                    <div class="space-y-4">
                      <div class="batshit-settings-card batshit-settings-card-subtle-frame is-spacious space-y-3">
                        <div class="flex flex-col items-start gap-4">
                          <EntityAvatar
                            avatarUrl={subagentForm.avatar}
                            iconRef={subagentForm.avatar_icon_ref}
                            iconFit={subagentForm.avatar_icon_fit}
                            label={subagentForm.displayName || "Subagent"}
                            fallback={subagentForm.displayName || "Subagent"}
                            class="batshit-settings-avatar-preview"
                            iconClass="text-muted-foreground"
                          />
                          <div class="w-full space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onclick={() => subagentAvatarInput?.click()}
                                disabled={subagentAvatarUploading}
                              >
                                {#if subagentAvatarUploading}
                                  <Loader2 class="animate-spin" />
                                  Uploading…
                                {:else}
                                  <UploadCloud  />
                                  Upload Avatar
                                {/if}
                              </Button>
                              <IconPicker
                                bind:value={subagentForm.avatar_icon_ref}
                                triggerLabel="Use Icon"
                                onSelect={chooseSubagentAvatarIcon}
                              />
                              {#if subagentForm.avatar}
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  class="is-danger"
                                  onclick={clearSubagentAvatar}
                                  disabled={subagentAvatarUploading}
                                  title="Remove Avatar"
                                  aria-label="Remove Avatar"
                                >
                                  <Trash2  />
                                </Button>
                              {/if}
                            </div>
                            {#if subagentAvatarError}
                              <p class="batshit-settings-form-help is-danger">{subagentAvatarError}</p>
                            {/if}
                          </div>
                          <input
                            class="hidden"
                            type="file"
                            accept="image/*"
                            bind:this={subagentAvatarInput}
                            onchange={handleSubagentAvatarUpload}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
              </SettingsAccordionCard>

              {#if subagentForm.subagentType === "cli" && isClaudeCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-core-cards"
                  title="Claude Code CLI Defaults"
                  batshitIcon="cli-tools"
                  class={hiddenUnlessSubagent("core")}
                  onfocusin={() => (subagentClaudeSaveScope = "core")}
                  onpointerdown={() => (subagentClaudeSaveScope = "core")}
                >
                  {#snippet actions()}
                      {#if subagentClaudeSaveScope === "core"}
                        <SettingsSaveStatus
                          state={subagentClaudeSaveError ? "error" : subagentClaudeSaveState}
                          error={subagentClaudeSaveError}
                          savingLabel="Saving Claude defaults..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                    <div class="batshit-settings-form-stack">
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <Label.Root class="batshit-settings-form-label">Default Claude Model</Label.Root>
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger
                                class={SETTINGS_INFO_TRIGGER_CLASS}
                                aria-label="About Subagent Default Claude Model"
                              >
                                <Info class="h-3.5 w-3.5" />
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Content
                                align="start"
                                side="bottom"
                                class={SETTINGS_INFO_CONTENT_CLASS}
                              >
                                Passed to <code>claude --model</code>. Choose CLI default to let Claude decide.
                              </DropdownMenu.Content>
                            </DropdownMenu.Root>
                          </div>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Select.Root
                            type="single"
                            value={subagentClaudeForm.model.length ? subagentClaudeForm.model : "default"}
                            onValueChange={guardSubagentChoice((value) => {
                              const nextValue = (Array.isArray(value) ? value[0] : value) as string;
                              updateClaudeForm((current) => ({
                                ...current,
                                model: nextValue === "default" ? "" : nextValue,
                              }), "subagent");
                            })}
                          >
                            <Select.Trigger class="w-full">
                              {@const label = subagentClaudeForm.model.length
                                ? CLAUDE_CLI_MODEL_CHOICES.find((option) => option.value === subagentClaudeForm.model)?.label ?? subagentClaudeForm.model
                                : "CLI default"}
                              <div class="flex items-center gap-2">
                                <ModelProviderIcon
                                  modelId={subagentClaudeForm.model.length ? subagentClaudeForm.model : "claude"}
                                  modelName={label}
                                  provider="claude"
                                  badgeProvider="anthropic"
                                  size="sm"
                                  showOverlay={true}
                                />
                                <span class="truncate">{label}</span>
                              </div>
                            </Select.Trigger>
                            <Select.Content>
                              <Select.Item value="default">
                                <div class="flex items-center gap-2">
                                  <ModelProviderIcon
                                    modelId="claude"
                                    modelName="CLI default"
                                    provider="claude"
                                    badgeProvider="anthropic"
                                    size="sm"
                                    showOverlay={true}
                                  />
                                  <span>CLI default</span>
                                </div>
                              </Select.Item>
                              {#each CLAUDE_CLI_MODEL_CHOICES as option}
                                <Select.Item value={option.value}>
                                  <div class="flex items-center gap-2">
                                    <ModelProviderIcon
                                      modelId={option.value}
                                      modelName={option.label}
                                      provider="claude"
                                      badgeProvider="anthropic"
                                      size="sm"
                                      showOverlay={true}
                                    />
                                    <span class="truncate">{option.label}</span>
                                  </div>
                                </Select.Item>
                              {/each}
                            </Select.Content>
                          </Select.Root>
                          <RetiredCliModelNotice runtime="claude" model={subagentClaudeForm.model} />
                        </div>
                      </div>

                      <div class="batshit-settings-toggle-row">
                        <div class="flex min-w-0 items-center gap-1.5">
                          <span class="batshit-settings-parent-label">Always Enable Extended Thinking</span>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger
                              class={SETTINGS_INFO_TRIGGER_CLASS}
                              aria-label="About Subagent Always Enable Extended Thinking"
                            >
                              <Info class="h-3.5 w-3.5" />
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content
                              align="start"
                              side="bottom"
                              class={SETTINGS_INFO_CONTENT_CLASS}
                            >
                              Turns on Claude Code&apos;s extended thinking for this subagent.
                            </DropdownMenu.Content>
                          </DropdownMenu.Root>
                        </div>
                        <Switch.Root
                          checked={subagentClaudeForm.alwaysThinkingEnabled}
                          onCheckedChange={guardSubagentChoice((checked) =>
                            updateClaudeForm((current) => ({
                              ...current,
                              alwaysThinkingEnabled: checked === true,
                              maxThinkingTokens:
                                checked === true
                                  ? current.maxThinkingTokens.trim().length > 0
                                    ? current.maxThinkingTokens
                                    : String(CLAUDE_DEFAULT_MAX_THINKING_TOKENS)
                                  : "",
                            }), "subagent"))} />
                      </div>

                      {#if subagentClaudeForm.alwaysThinkingEnabled}
                        <div class="batshit-settings-form-row">
                          <div class="batshit-settings-form-copy">
                            <div class="batshit-settings-form-label-line">
                              <Label.Root class="batshit-settings-form-label">
                                Thinking Token Budget
                              </Label.Root>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger
                                  class={SETTINGS_INFO_TRIGGER_CLASS}
                                  aria-label="About Subagent Thinking Token Budget"
                                >
                                  <Info class="h-3.5 w-3.5" />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content
                                  align="start"
                                  side="bottom"
                                  class={SETTINGS_INFO_CONTENT_CLASS}
                                >
                                  Uses <code>{CLAUDE_DEFAULT_MAX_THINKING_TOKENS}</code> when left blank.
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </div>
                          </div>
                          <div class="batshit-settings-form-control">
                            <Input
                              type="number"
                              min="1"
                              placeholder={String(CLAUDE_DEFAULT_MAX_THINKING_TOKENS)}
                              value={subagentClaudeForm.maxThinkingTokens}
                              oninput={(event) => {
                                const nextValue = (event.target as HTMLInputElement).value;
                                updateClaudeForm((current) => ({
                                  ...current,
                                  maxThinkingTokens: nextValue,
                                }), "subagent");
                              }}
                            />
                          </div>
                        </div>
                      {/if}
                    </div>
                </SettingsAccordionCard>
              {/if}

              {#if subagentForm.subagentType === "cli" && isCodexCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-core-cards"
                  title="Codex CLI Defaults"
                  batshitIcon="cli-tools"
                  class={hiddenUnlessSubagent("core")}
                  onfocusin={() => (subagentCodexSaveScope = "core")}
                  onpointerdown={() => (subagentCodexSaveScope = "core")}
                >
                  {#snippet actions()}
                      {#if subagentCodexSaveScope === "core"}
                        <SettingsSaveStatus
                          state={subagentCodexSaveError ? "error" : subagentCodexSaveState}
                          error={subagentCodexSaveError}
                          savingLabel="Saving Codex defaults..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                    <div class="batshit-settings-form-stack">
                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <Label.Root class="batshit-settings-form-label">Default Codex Model</Label.Root>
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger
                                class={SETTINGS_INFO_TRIGGER_CLASS}
                                aria-label="About Subagent Default Codex Model"
                              >
                                <Info class="h-3.5 w-3.5" />
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Content
                                align="start"
                                side="bottom"
                                class={SETTINGS_INFO_CONTENT_CLASS}
                              >
                                Passed directly to <code>codex --model</code> for this subagent.
                              </DropdownMenu.Content>
                            </DropdownMenu.Root>
                          </div>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Select.Root
                            type="single"
                            value={subagentCodexForm.model}
                            onValueChange={guardSubagentChoice((value) =>
                              updateCodexForm((current) => ({
                                ...current,
                                model: Array.isArray(value)
                                  ? (value[0] as string)
                                  : (value as string),
                              }), "subagent"))}
                          >
                            <Select.Trigger class="w-full">
                              {@const label = CODEX_SUBMODEL_CHOICES.find((option) => option.value === subagentCodexForm.model)?.label ?? subagentCodexForm.model}
                              <div class="flex items-center gap-2 min-w-0">
                                <ModelProviderIcon
                                  modelId={subagentCodexForm.model}
                                  modelName={label}
                                  provider="openai"
                                  size="sm"
                                  badgeProvider="codex"
                                />
                                <span class="truncate">{label}</span>
                              </div>
                            </Select.Trigger>
                            <Select.Content>
                              {#each CODEX_SUBMODEL_CHOICES as option}
                                <Select.Item value={option.value}>
                                  <div class="flex items-center gap-2 min-w-0">
                                    <ModelProviderIcon
                                      modelId={option.value}
                                      modelName={option.label}
                                      provider="openai"
                                      size="sm"
                                      badgeProvider="codex"
                                    />
                                    <span class="truncate">{option.label}</span>
                                  </div>
                                </Select.Item>
                              {/each}
                            </Select.Content>
                          </Select.Root>
                          <RetiredCliModelNotice runtime="codex" model={subagentCodexForm.model} />
                        </div>
                      </div>

                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <Label.Root class="batshit-settings-form-label">Reasoning Effort</Label.Root>
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger
                                class={SETTINGS_INFO_TRIGGER_CLASS}
                                aria-label="About Subagent Reasoning Effort"
                              >
                                <Info class="h-3.5 w-3.5" />
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Content
                                align="start"
                                side="bottom"
                                class={SETTINGS_INFO_CONTENT_CLASS}
                              >
                                Mirrors Codex <code>model_reasoning_effort</code>.
                              </DropdownMenu.Content>
                            </DropdownMenu.Root>
                          </div>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Select.Root
                            type="single"
                            value={subagentCodexForm.reasoningEffort}
                            onValueChange={guardSubagentChoice((value) =>
                              updateCodexForm((current) => ({
                                ...current,
                                reasoningEffort: (Array.isArray(value)
                                  ? value[0]
                                  : value) as CodexFormOptions["reasoningEffort"],
                              }), "subagent"))}
                          >
                            <Select.Trigger class="w-full">
                              {@const label = CODEX_REASONING_OPTIONS.find((option) => option.value === subagentCodexForm.reasoningEffort)?.label ?? "Auto"}
                              <div class="flex items-center gap-2 min-w-0">
                                <Brain class="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span class="truncate">{label}</span>
                              </div>
                            </Select.Trigger>
                            <Select.Content>
                              {#each CODEX_REASONING_OPTIONS as option}
                                {#if option.value !== "xhigh" || supportsCodexXhighReasoning(subagentCodexForm.model)}
                                  <Select.Item value={option.value}>
                                    <div class="flex items-start gap-2 min-w-0">
                                      <Brain class="h-4 w-4 shrink-0 text-muted-foreground" />
                                      <div class="flex flex-col min-w-0">
                                        <span class="truncate">{option.label}</span>
                                        <span class="batshit-settings-child-label truncate">
                                          {option.helper}
                                        </span>
                                      </div>
                                    </div>
                                  </Select.Item>
                                {/if}
                              {/each}
                            </Select.Content>
                          </Select.Root>
                        </div>
                      </div>

                      <div class="batshit-settings-form-row">
                        <div class="batshit-settings-form-copy">
                          <div class="batshit-settings-form-label-line">
                            <Label.Root class="batshit-settings-form-label">Service Tier</Label.Root>
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger
                                class={SETTINGS_INFO_TRIGGER_CLASS}
                                aria-label="About Subagent Service Tier"
                              >
                                <Info class="h-3.5 w-3.5" />
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Content
                                align="start"
                                side="bottom"
                                class={SETTINGS_INFO_CONTENT_CLASS}
                              >
                                Writes Codex <code>service_tier</code>. Fast is currently supported on GPT-5.5 and GPT-5.4.
                              </DropdownMenu.Content>
                            </DropdownMenu.Root>
                          </div>
                        </div>
                        <div class="batshit-settings-form-control">
                          <Select.Root
                            type="single"
                            value={subagentCodexForm.serviceTier}
                            onValueChange={guardSubagentChoice((value) =>
                              updateCodexForm((current) => ({
                                ...current,
                                serviceTier: (Array.isArray(value)
                                  ? value[0]
                                  : value) as CodexServiceTier,
                              }), "subagent"))}
                          >
                            <Select.Trigger class="w-full">
                              <span>
                                {CODEX_SERVICE_TIER_OPTIONS.find((option) =>
                                  option.value === subagentCodexForm.serviceTier
                                )?.label ?? subagentCodexForm.serviceTier}
                              </span>
                            </Select.Trigger>
                            <Select.Content>
                              {#each CODEX_SERVICE_TIER_OPTIONS as option}
                                {#if option.value !== "fast" || supportsCodexFastMode(subagentCodexForm.model)}
                                  <Select.Item value={option.value}>
                                    <div class="flex flex-col min-w-0">
                                      <span class="truncate">{option.label}</span>
                                      <span class="batshit-settings-child-label truncate">
                                        {option.helper}
                                      </span>
                                    </div>
                                  </Select.Item>
                                {/if}
                              {/each}
                            </Select.Content>
                          </Select.Root>
                        </div>
                      </div>
                    </div>
                </SettingsAccordionCard>
              {/if}

              {#if subagentForm.subagentType === "cli" && isClaudeCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-instructions-cards"
                  title="Claude Instructions"
                  batshitIcon="instructions"
                  class={hiddenUnlessSubagent("instructions")}
                  contentClass="space-y-4"
                  onfocusin={() => (subagentClaudeSaveScope = "instructions")}
                  onpointerdown={() => (subagentClaudeSaveScope = "instructions")}
                >
                  {#snippet info()}
                        <SettingsInfoMenu ariaLabel="About Subagent Claude Instructions">
                          Controls how Claude's own instruction sources mix with Batshit-managed prompting.
                        </SettingsInfoMenu>
                  {/snippet}
                  {#snippet actions()}
                      {#if subagentClaudeSaveScope === "instructions"}
                        <SettingsSaveStatus
                          state={subagentClaudeSaveError ? "error" : subagentClaudeSaveState}
                          error={subagentClaudeSaveError}
                          savingLabel="Saving Claude instructions..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                      <div class="batshit-settings-form-stack">
                        <div class="batshit-settings-toggle-row">
                          <div>
                            <div class="flex items-center gap-1.5">
                              <p class="batshit-settings-parent-label">Use Project CLAUDE.md When Found</p>
                              <SettingsInfoMenu ariaLabel="About Subagent Project CLAUDE.md">
                                On lets Claude read project <code>CLAUDE.md</code> files inside this
                                Batshit-managed chat. Off ignores those project instruction files for this subagent.
                              </SettingsInfoMenu>
                            </div>
                          </div>
                          <Switch.Root
                            checked={subagentClaudeForm.includeProjectInstructions}
                            onCheckedChange={guardSubagentChoice((checked) =>
                              updateClaudeForm((current) => ({
                                ...current,
                                includeProjectInstructions: checked === true,
                              }), "subagent"))}
                          />
                        </div>

                        <div class="batshit-settings-toggle-row">
                          <div>
                            <div class="flex items-center gap-1.5">
                              <p class="batshit-settings-parent-label">Include Claude's Built-In System Prompt</p>
                              <SettingsInfoMenu ariaLabel="About Subagent Claude Built-in System Prompt">
                                Off keeps Batshit's plain helper replacement. On removes that override so
                                Claude Code uses its own built-in prompt too.
                              </SettingsInfoMenu>
                            </div>
                          </div>
                          <Switch.Root
                            checked={subagentClaudeForm.includeCoreSystemPrompt}
                            onCheckedChange={guardSubagentChoice((checked) =>
                              updateClaudeForm((current) => ({
                                ...current,
                                includeCoreSystemPrompt: checked === true,
                                systemPromptMode: checked === true ? "default" : "replace",
                                systemPrompt:
                                  checked === true ? "" : MODE4_PRELAUNCH_REPLACEMENT_PROMPT,
                                systemPromptFile: "",
                              }), "subagent"))}
                          />
                        </div>
                      </div>
                </SettingsAccordionCard>
              {/if}

              {#if subagentForm.subagentType === "cli" && isCodexCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-instructions-cards"
                  title="Codex Instructions"
                  batshitIcon="instructions"
                  class={hiddenUnlessSubagent("instructions")}
                  contentClass="space-y-4"
                  onfocusin={() => (subagentCodexSaveScope = "instructions")}
                  onpointerdown={() => (subagentCodexSaveScope = "instructions")}
                >
                  {#snippet info()}
                        <SettingsInfoMenu ariaLabel="About Subagent Codex Instructions">
                          Controls whether Codex also reads project instruction files in this managed session.
                        </SettingsInfoMenu>
                  {/snippet}
                  {#snippet actions()}
                      {#if subagentCodexSaveScope === "instructions"}
                        <SettingsSaveStatus
                          state={subagentCodexSaveError ? "error" : subagentCodexSaveState}
                          error={subagentCodexSaveError}
                          savingLabel="Saving Codex instructions..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                      <div class="batshit-settings-form-stack">
                        <div class="batshit-settings-toggle-row">
                          <div>
                            <div class="flex items-center gap-1.5">
                              <p class="batshit-settings-parent-label">Use Project AGENTS.md When Found</p>
                              <SettingsInfoMenu ariaLabel="About Subagent Project AGENTS.md">
                                On lets Codex also read the project's <code>AGENTS.md</code> inside this
                                Batshit-managed chat. Off uses Batshit's managed replacement instructions file instead.
                              </SettingsInfoMenu>
                            </div>
                          </div>
                          <Switch.Root
                            checked={subagentCodexForm.includeProjectInstructions}
                            onCheckedChange={guardSubagentChoice((checked) =>
                              updateCodexForm((current) => ({
                                ...current,
                                includeProjectInstructions: checked === true,
                              }), "subagent"))}
                          />
                        </div>
                      </div>
                </SettingsAccordionCard>
              {/if}

            <SettingsAccordionCard
              name="subagent-instructions-cards"
              title="Instructions"
              batshitIcon="instructions"
              class={hiddenUnlessSubagent("instructions")}
              contentClass="space-y-4"
            onfocusin={() => (subagentSaveScope = "instructions")}
            onpointerdown={() => (subagentSaveScope = "instructions")}
          >
            {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Subagent Custom System Prompt">
                    Agent-specific Custom System Prompt. This does not override any
                    other prompts. It is just added for this specific subagent.
                  </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
                {#if subagentSaveScope === "instructions"}
                  <SettingsSaveStatus
                    state={subagentEditSaveError || subagentValidationError ? "error" : subagentEditSaveState}
                    error={subagentEditSaveError ?? subagentValidationError}
                    savingLabel="Saving subagent..."
                    savedLabel="Saved"
                  />
                {/if}
            {/snippet}
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Label class="batshit-settings-form-label">Custom System Prompt</Label.Label>
                      </div>
                    </div>
                      <div class="batshit-settings-form-control is-compact-action">
                        <Button
                          type="button"
                          variant="outline"
                        size="sm"
                        onclick={() => (subagentPromptEditorOpen = true)}
                      >
                        <Pencil aria-hidden="true" />

                        Edit
                      </Button>
                    </div>
                  </div>

                  <div class="batshit-settings-toggle-row">
                    <div>
                      <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">Include Global Custom Prompt</p>
                        <SettingsInfoMenu ariaLabel="About Subagent Global Custom Prompt">
                          When enabled, this subagent receives your Global Custom System
                          Prompt from the Prompts tab.
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <Switch.Root bind:checked={subagentForm.include_global_prompt} />
                  </div>
                </div>
          </SettingsAccordionCard>
              {#if subagentForm.subagentType === "cli" && isClaudeCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-tools-cards"
                  title="Claude Tools"
                  icon={Wrench}
                  class={hiddenUnlessSubagent("tools")}
                  contentClass="space-y-5"
                  onfocusin={() => (subagentClaudeSaveScope = "tools")}
                  onpointerdown={() => (subagentClaudeSaveScope = "tools")}
                >
                  {#snippet info()}
                        <SettingsInfoMenu ariaLabel="About Subagent Claude Tools">
                          Controls Claude-specific built-in tools for this subagent.
                        </SettingsInfoMenu>
                  {/snippet}
                  {#snippet actions()}
                      {#if subagentClaudeSaveScope === "tools"}
                        <SettingsSaveStatus
                          state={subagentClaudeSaveError ? "error" : subagentClaudeSaveState}
                          error={subagentClaudeSaveError}
                          savingLabel="Saving Claude tools..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                    <div class="flex items-center justify-between gap-4 batshit-settings-muted-panel">
                      <div>
                        <div class="flex items-center gap-1.5">
                          <p class="batshit-settings-form-label">Enable Chrome Integration</p>
                          <SettingsInfoMenu ariaLabel="About Subagent Claude Chrome Integration">
                            Toggles Claude Code's Chrome automation.
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <Switch.Root
                        checked={subagentClaudeForm.chrome}
                        onCheckedChange={guardSubagentChoice((checked) =>
                          updateClaudeForm((current) => ({
                            ...current,
                            chrome: checked === true,
                          }), "subagent"))}
                      />
                    </div>

                    <div class="flex items-center justify-between gap-4 batshit-settings-muted-panel">
                      <div>
                        <div class="flex items-center gap-1.5">
                          <p class="batshit-settings-form-label">Allow Claude Web Search</p>
                          <SettingsInfoMenu ariaLabel="About Subagent Claude Web Search">
                            Convenience toggle for Claude's <code>WebSearch</code> built-in tool.
                          </SettingsInfoMenu>
                        </div>
                      </div>
                      <Switch.Root
                        checked={getClaudeToolEnabled("WebSearch", "subagent")}
                        onCheckedChange={guardSubagentChoice((checked) =>
                          setClaudeToolEnabled("WebSearch", checked === true, "subagent"))}
                      />
                    </div>

                    <details class="batshit-settings-muted-panel">
                      <summary class="batshit-settings-form-label cursor-pointer">
                        Advanced Tool Rules
                      </summary>
                      <div class="mt-3 grid gap-4 md:grid-cols-2">
                        <div class="space-y-2">
                          <Label.Root class="batshit-settings-form-label"
                            >Allowed Tools</Label.Root
                          >
                          <div class="flex gap-2">
                            <Input
                              placeholder="Read, Edit, Bash..."
                              bind:value={subagentClaudeAllowedToolDraft}
                              onkeydown={(event: KeyboardEvent) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addClaudeListValue("allowedTools", subagentClaudeAllowedToolDraft, "subagent");
                                  subagentClaudeAllowedToolDraft = "";
                                }
                              }}
                            />
                            <Button
                              variant="secondary"
                              onclick={() => {
                                addClaudeListValue("allowedTools", subagentClaudeAllowedToolDraft, "subagent");
                                subagentClaudeAllowedToolDraft = "";
                              }}
                            >
                              <Plus aria-hidden="true" />

                              Add
                            </Button>
                          </div>
                          {#if subagentClaudeForm.allowedTools.length > 0}
                            <div class="flex flex-wrap gap-2">
                              {#each subagentClaudeForm.allowedTools as tool, idx}
                                <span class="batshit-settings-pill is-success">
                                  {tool}
                                  <button
                                    type="button"
                                    onclick={() => removeClaudeListValue("allowedTools", idx, "subagent")}
                                  >×</button>
                                </span>
                              {/each}
                            </div>
                          {/if}
                        </div>
                        <div class="space-y-2">
                          <Label.Root class="batshit-settings-form-label"
                            >Disallowed Tools</Label.Root
                          >
                          <div class="flex gap-2">
                            <Input
                              placeholder="WebSearch, WebFetch..."
                              bind:value={subagentClaudeDisallowedToolDraft}
                              onkeydown={(event: KeyboardEvent) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addClaudeListValue("disallowedTools", subagentClaudeDisallowedToolDraft, "subagent");
                                  subagentClaudeDisallowedToolDraft = "";
                                }
                              }}
                            />
                            <Button
                              variant="secondary"
                              onclick={() => {
                                addClaudeListValue("disallowedTools", subagentClaudeDisallowedToolDraft, "subagent");
                                subagentClaudeDisallowedToolDraft = "";
                              }}
                            >
                              <Plus aria-hidden="true" />

                              Add
                            </Button>
                          </div>
                          {#if subagentClaudeForm.disallowedTools.length > 0}
                            <div class="flex flex-wrap gap-2">
                              {#each subagentClaudeForm.disallowedTools as tool, idx}
                                <span class="batshit-settings-pill is-danger">
                                  {tool}
                                  <button
                                    type="button"
                                    onclick={() => removeClaudeListValue("disallowedTools", idx, "subagent")}
                                  >×</button>
                                </span>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      </div>
                    </details>
                </SettingsAccordionCard>
              {/if}

              {#if subagentForm.subagentType === "cli" && isCodexCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-tools-cards"
                  title="Codex Tools"
                  icon={Wrench}
                  class={hiddenUnlessSubagent("tools")}
                  contentClass="space-y-5"
                  onfocusin={() => (subagentCodexSaveScope = "tools")}
                  onpointerdown={() => (subagentCodexSaveScope = "tools")}
                >
                  {#snippet info()}
                        <SettingsInfoMenu ariaLabel="About Subagent Codex Tools">
                          Controls Codex-specific built-in capabilities and advanced feature flags.
                        </SettingsInfoMenu>
                  {/snippet}
                  {#snippet actions()}
                      {#if subagentCodexSaveScope === "tools"}
                        <SettingsSaveStatus
                          state={subagentCodexSaveError ? "error" : subagentCodexSaveState}
                          error={subagentCodexSaveError}
                          savingLabel="Saving Codex tools..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                    <div class="batshit-settings-form-stack">
                      <div class="batshit-settings-toggle-row">
                        <div class="min-w-0">
                          <div class="flex items-center gap-1.5">
                            <p class="batshit-settings-parent-label">Allow Codex Web Search</p>
                            <SettingsInfoMenu ariaLabel="About Subagent Codex Web Search">
                              Enables Codex live web search for CLI subagent runs via the managed <code>web_search</code> setting.
                            </SettingsInfoMenu>
                          </div>
                        </div>
                        <Switch.Root
                          checked={subagentCodexForm.search}
                          onCheckedChange={guardSubagentChoice((checked) =>
                            updateCodexForm((current) => ({
                              ...current,
                              search: checked === true,
                            }), "subagent"))}
                        />
                      </div>

                      <Collapsible.Root bind:open={subagentCodexAdvancedOpen}>
                        <div class="batshit-settings-disclosure-row is-form-line">
                          <Collapsible.Trigger class={SETTINGS_DISCLOSURE_TRIGGER_CLASS}>
                            <span class="batshit-settings-form-label">Advanced Feature Flags</span>
                            <ChevronDown
                              class={`h-4 w-4 text-muted-foreground transition-transform ${subagentCodexAdvancedOpen ? "rotate-180" : ""}`}
                            />
                          </Collapsible.Trigger>
                          <Collapsible.Content class="batshit-settings-disclosure-content space-y-4">
                          <div class="grid gap-4 md:grid-cols-2">
                            <div class="space-y-2">
                              <Label.Root class="batshit-settings-form-label"
                                >Enable Feature Flags</Label.Root
                              >
                              <div class="flex gap-2">
                                <Input
                                  placeholder="browser_use"
                                  bind:value={subagentCodexEnableDraft}
                                  onkeydown={(event: KeyboardEvent) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      addCodexListValue("enableFeatures", subagentCodexEnableDraft, "subagent");
                                      subagentCodexEnableDraft = "";
                                    }
                                  }}
                                />
                                <Button
                                  variant="secondary"
                                  onclick={() => {
                                    addCodexListValue("enableFeatures", subagentCodexEnableDraft, "subagent");
                                    subagentCodexEnableDraft = "";
                                  }}
                                >
                                  <Plus aria-hidden="true" />

                                  Add
                                </Button>
                              </div>
                              <div class="flex flex-wrap gap-2">
                                {#if subagentCodexForm.enableFeatures.length > 0}
                                  {#each subagentCodexForm.enableFeatures as feature, idx}
                                    <span class="batshit-settings-pill is-success">
                                      {feature}
                                      <button
                                        type="button"
                                        onclick={() => removeCodexListValue("enableFeatures", idx, "subagent")}
                                      >×</button>
                                    </span>
                                  {/each}
                                {/if}
                              </div>
                            </div>
                            <div class="space-y-2">
                              <Label.Root class="batshit-settings-form-label"
                                >Disable Feature Flags</Label.Root
                              >
                              <div class="flex gap-2">
                                <Input
                                  placeholder="browser_use"
                                  bind:value={subagentCodexDisableDraft}
                                  onkeydown={(event: KeyboardEvent) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      addCodexListValue("disableFeatures", subagentCodexDisableDraft, "subagent");
                                      subagentCodexDisableDraft = "";
                                    }
                                  }}
                                />
                                <Button
                                  variant="secondary"
                                  onclick={() => {
                                    addCodexListValue("disableFeatures", subagentCodexDisableDraft, "subagent");
                                    subagentCodexDisableDraft = "";
                                  }}
                                >
                                  <Plus aria-hidden="true" />

                                  Add
                                </Button>
                              </div>
                              <div class="flex flex-wrap gap-2">
                                {#if subagentCodexForm.disableFeatures.length > 0}
                                  {#each subagentCodexForm.disableFeatures as feature, idx}
                                    <span class="batshit-settings-pill is-danger">
                                      {feature}
                                      <button
                                        type="button"
                                        onclick={() => removeCodexListValue("disableFeatures", idx, "subagent")}
                                      >×</button>
                                    </span>
                                  {/each}
                                {/if}
                              </div>
                            </div>
                          </div>
                          </Collapsible.Content>
                        </div>
                      </Collapsible.Root>
                    </div>
                </SettingsAccordionCard>
              {/if}

            <SettingsAccordionCard
              name="subagent-tools-cards"
              title="Batshit Tools"
              icon={Wrench}
              class={hiddenUnlessSubagent("tools")}
              contentClass="space-y-4"
            onfocusin={() => (subagentSaveScope = "tools")}
            onpointerdown={() => (subagentSaveScope = "tools")}
          >
            {#snippet info()}
                    <SettingsInfoMenu ariaLabel="About Subagent Native Tools">
                        {#if subagentForm.subagentType === "cli"}
                          Configure Batshit built-in tools and dynamic tool families for this CLI Subagent. Codex or Claude built-ins live in the dedicated CLI cards above.
                        Permission boundaries are managed by the CLI runtime itself, and broad Fabric controls stay unavailable for subagent runs.
                      {:else}
                      Configure native tool behavior for this subagent when it runs.
                      Workflow-backed subagents use these helpers through
                      <code>Batshit Tools</code>, and managed subagents use the same helpers directly through their runtime lane.
                        Permission boundaries live in <code>Access</code>.
                      {/if}
                    </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
                {#if subagentSaveScope === "tools"}
                  <SettingsSaveStatus
                    state={subagentEditSaveError || subagentValidationError ? "error" : subagentEditSaveState}
                    error={subagentEditSaveError ?? subagentValidationError}
                    savingLabel="Saving subagent tools..."
                    savedLabel="Saved"
                  />
                {/if}
            {/snippet}
              {@const subagentBashAvailable = isNativeToolUiAvailable("bash", "subagent")}
                {@const subagentWebSearchAvailable = isNativeToolUiAvailable("web-search", "subagent")}
                {@const subagentFabricAvailable = isNativeToolUiAvailable("fabric", "subagent")}

                <div class="batshit-settings-form-stack">
                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Bash Tool</p>
                    <SettingsInfoMenu ariaLabel="About Subagent Bash Tool">
                      {#if subagentBashAvailable}
                        Enables <code>{getBashToolName("subagent")}</code> for terminal command execution.
                        Execution environment, permissions mode, command timeout, and safety rules live in
                        <code>Access</code>.
                      {:else}
                        {getNativeToolUiUnavailableMessage("bash", "subagent")}
                      {/if}
                    </SettingsInfoMenu>
                  </div>
                </div>
                <Switch.Root
                  checked={subagentBashAvailable && getNativeToolToggle("bashEnabled", true, "subagent")}
                  onCheckedChange={guardSubagentChoice((checked) =>
                    updateNativeToolSetting("bashEnabled", checked === true, "subagent"))}
                  disabled={!subagentBashAvailable}
                />
              </div>

                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">MCP Tools</p>
                      <SettingsInfoMenu ariaLabel="About Subagent MCP Tools">
                        Lets Dynamic Tool Search surface enabled MCP Source tools for this subagent.
                        Individual MCP sources, groups, and tools are controlled in the Tool Grid.
                      </SettingsInfoMenu>
                  </div>
                </div>
                <Switch.Root
                  checked={getNativeToolToggle("dynamicMcpEnabled", true, "subagent")}
                  onCheckedChange={guardSubagentChoice((checked) =>
                    updateNativeToolSetting("dynamicMcpEnabled", checked === true, "subagent"))}
                />
              </div>

                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">CLI Tools</p>
                      <SettingsInfoMenu ariaLabel="About Subagent CLI Tools">
                        Lets Dynamic Tool Search surface saved CLI tools for this subagent.
                        Individual CLI tools are controlled in the Tool Grid.
                      </SettingsInfoMenu>
                  </div>
                </div>
                <Switch.Root
                  checked={getNativeToolToggle("cliToolsEnabled", true, "subagent")}
                  onCheckedChange={guardSubagentChoice((checked) =>
                    updateNativeToolSetting("cliToolsEnabled", checked === true, "subagent"))}
                />
              </div>

                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                        <p class="batshit-settings-parent-label">Artifact Tools</p>
                      <SettingsInfoMenu ariaLabel="About Subagent Artifact Tools">
                        Lets Dynamic Tool Search surface published artifacts this subagent can use
                        as tools.
                      </SettingsInfoMenu>
                  </div>
                </div>
                  <Switch.Root
                    checked={getNativeToolToggle("artifactRuntimeEnabled", true, "subagent")}
                    onCheckedChange={guardSubagentChoice((checked) =>
                      updateNativeToolSetting("artifactRuntimeEnabled", checked === true, "subagent"))}
                  />
                </div>

                <div class="batshit-settings-toggle-row">
                  <div>
                    <div class="flex items-center gap-1.5">
                      <p class="batshit-settings-parent-label">Fabric Controls</p>
                        <SettingsInfoMenu ariaLabel="About Subagent Fabric Controls">
                          {#if subagentFabricAvailable}
                            Lets Dynamic Tool Search surface Fabric control-plane actions for
                            Batshit management.
                          {:else}
                          {getNativeToolUiUnavailableMessage("fabric", "subagent")}
                        {/if}
                      </SettingsInfoMenu>
                    </div>
                  </div>
                  <Switch.Root
                    checked={subagentFabricAvailable && getNativeToolToggle("batshitToolsEnabled", true, "subagent")}
                    onCheckedChange={guardSubagentChoice((checked) =>
                      updateNativeToolSetting("batshitToolsEnabled", checked === true, "subagent"))}
                    disabled={!subagentFabricAvailable}
                  />
                </div>

                  <AgentWebSearchDefaultsDisclosure
                    bind:open={subagentWebSearchDefaultsOpen}
                    entityLabel="subagent"
                    titleInfoAriaLabel="About Subagent Web Search"
                    defaultsInfoAriaLabel="About Subagent Web Search Defaults"
                    providerInfoAriaLabel="About Subagent Default Web Search Provider"
                    exaInfoAriaLabel="About Subagent Exa Search Type"
                    perplexityInfoAriaLabel="About Subagent Perplexity Max Tokens Per Page"
                    available={subagentWebSearchAvailable}
                    enabled={getNativeToolToggle("webSearchEnabled", true, "subagent")}
                    toolName={getWebSearchToolName("subagent")}
                    unavailableMessage={getNativeToolUiUnavailableMessage("web-search", "subagent")}
                    providerValue={getNativeWebSearchProviderValue("subagent")}
                    providerLabel={getNativeWebSearchProviderLabel(
                      getNativeWebSearchProviderValue("subagent")
                    )}
                    providerInheritValue={NATIVE_WEB_SEARCH_PROVIDER_INHERIT}
                    providerInheritLabel={getNativeWebSearchProviderLabel(NATIVE_WEB_SEARCH_PROVIDER_INHERIT)}
                    providerOptions={nativeWebSearchProviderOptions}
                    providerLoading={webSearchProviderAvailabilityLoading}
                    providerError={webSearchProviderAvailabilityError}
                    exaTypeValue={getNativeWebSearchExaTypeValue("subagent")}
                    exaTypeLabel={getNativeWebSearchExaTypeLabel(getNativeWebSearchExaTypeValue("subagent"))}
                    exaTypeInheritValue={NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT}
                    exaTypeInheritLabel={getNativeWebSearchExaTypeLabel(NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT)}
                    exaTypeOptions={[
                      { value: "auto", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.auto },
                      { value: "fast", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.fast },
                      { value: "neural", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.neural },
                      { value: "deep", label: NATIVE_WEB_SEARCH_EXA_TYPE_LABELS.deep }
                    ]}
                    perplexityValue={String(getNativeWebSearchPerplexityMaxTokensPerPageValue("subagent"))}
                    perplexityLabel={getNativeWebSearchPerplexityMaxTokensPerPageLabel(
                      getNativeWebSearchPerplexityMaxTokensPerPageValue("subagent")
                    )}
                    perplexityInheritValue={NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT}
                    perplexityInheritLabel={getNativeWebSearchPerplexityMaxTokensPerPageLabel(
                      NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT
                    )}
                    perplexityOptions={NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_OPTIONS}
                    onEnabledChange={guardSubagentChoice((enabled) =>
                      updateNativeToolSetting("webSearchEnabled", enabled, "subagent"))}
                    onProviderValueChange={guardSubagentChoice((next) => {
                      if (next === NATIVE_WEB_SEARCH_PROVIDER_INHERIT) {
                        updateNativeToolSetting("webSearchProvider", null, "subagent");
                        return;
                      }
                      const provider = normalizeNativeWebSearchProvider(next);
                      updateNativeToolSetting("webSearchProvider", provider, "subagent");
                    })}
                    onExaTypeValueChange={guardSubagentChoice((next) => {
                      if (next === NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT) {
                        updateNativeToolSetting("webSearchExaType", null, "subagent");
                        return;
                      }
                      const normalized = normalizeNativeExaSearchType(next);
                      updateNativeToolSetting("webSearchExaType", normalized, "subagent");
                    })}
                    onPerplexityMaxTokensValueChange={guardSubagentChoice((next) => {
                      if (next === NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT) {
                        updateNativeToolSetting(
                          "webSearchPerplexityMaxTokensPerPage",
                          null,
                          "subagent"
                        );
                        return;
                      }
                      const normalized = normalizePerplexityMaxTokensPerPage(next);
                      updateNativeToolSetting(
                        "webSearchPerplexityMaxTokensPerPage",
                        normalized,
                        "subagent"
                      );
                    })}
                  />

                <Collapsible.Root bind:open={subagentAgentBrowserDefaultsOpen}>
                  <div class="batshit-settings-toggle-disclosure-row">
                    <div class="batshit-settings-toggle-disclosure-header">
                      <div class="batshit-settings-toggle-disclosure-copy">
                        <div class="flex items-center gap-1.5">
                          <p class="batshit-settings-parent-label">Agent Browser</p>
                          <SettingsInfoMenu ariaLabel="About Subagent Agent Browser">
                            Native browser automation powered by Vercel Agent Browser (Playwright under the hood).
                            Workflow-backed subagents reach it through
                            <code>Batshit Tools</code>, and managed subagents call the same browser helpers directly.
                            {#if agentBrowserRuntimeStatus?.version}
                              Runtime version: <code>{agentBrowserRuntimeStatus.version}</code>
                            {/if}
                          </SettingsInfoMenu>
                        </div>
                        {#if agentBrowserRuntimeStatusLoading}
                          <p class="batshit-settings-form-help">Checking runtime installation...</p>
                        {:else if agentBrowserRuntimeStatus?.supportLevel === "docker-sidecar" && !isAgentBrowserRuntimeInstalled()}
                          <p class="batshit-settings-form-help">
                            Docker Agent Browser sidecar is stopped. Start it in <code>Settings -> Admin -> Agent Browser Runtime</code> first.
                          </p>
                        {:else if agentBrowserRuntimeStatus?.dockerUnsupported}
                          <p class="batshit-settings-form-help">
                            Agent Browser is unavailable in this runtime.
                          </p>
                        {:else if !isAgentBrowserRuntimeInstalled()}
                          <p class="batshit-settings-form-help">
                            Runtime not installed. Install it in <code>Settings -> Admin -> Agent Browser Runtime</code> first.
                          </p>
                        {/if}
                        {#if agentBrowserRuntimeStatusError}
                          <p class="batshit-settings-form-help is-danger">{agentBrowserRuntimeStatusError}</p>
                        {/if}
                      </div>
                      <div class="batshit-settings-toggle-disclosure-control">
                        <Switch.Root
                          checked={isAgentBrowserRuntimeInstalled() && getNativeToolToggle("agentBrowserEnabled", true, "subagent")}
                          onCheckedChange={guardSubagentChoice((checked) => {
                            updateNativeToolSetting("agentBrowserEnabled", checked === true, "subagent");
                            if (checked !== true) {
                              subagentAgentBrowserDefaultsOpen = false;
                            }
                          })}
                          disabled={agentBrowserRuntimeStatusLoading || !isAgentBrowserRuntimeInstalled()}
                        />
                        {#if isAgentBrowserRuntimeInstalled() && getNativeToolToggle("agentBrowserEnabled", true, "subagent")}
                          <Collapsible.Trigger class="batshit-settings-toggle-disclosure-trigger">
                            <span class="batshit-settings-toggle-disclosure-label">Agent Browser Defaults</span>
                            <SettingsInfoMenu ariaLabel="About Subagent Agent Browser Defaults">
                              {#if isAgentBrowserDockerSidecarRuntime()}
                                Docker sidecar mode exposes timeout, cloud provider, and extra CLI flag defaults.
                              {:else}
                                Runtime mode, timeout, session memory, live visibility, and optional provider overrides.
                              {/if}
                            </SettingsInfoMenu>
                            <ChevronDown
                              class={`batshit-settings-toggle-disclosure-chevron ${subagentAgentBrowserDefaultsOpen ? "is-open" : ""}`}
                            />
                          </Collapsible.Trigger>
                        {/if}
                      </div>
                    </div>
                      {#if isAgentBrowserRuntimeInstalled() && getNativeToolToggle("agentBrowserEnabled", true, "subagent")}
                        <Collapsible.Content class="batshit-settings-disclosure-content batshit-settings-subitem-lines">
                          <div class="batshit-settings-form-stack">
                            {#if isAgentBrowserDockerSidecarRuntime()}
                              <div class="batshit-settings-muted-panel space-y-1">
                                <p class="batshit-settings-form-label">Docker Sidecar Runtime</p>
                                <p class="batshit-settings-code-caption">
                                  Runs headless in the Agent Browser sidecar's bundled Chromium. Host Chrome/CDP, live visibility,
                                  executable path, session name, and host profile path are not used in Docker.
                                </p>
                              </div>
                            {/if}

                            {#if !isAgentBrowserDockerSidecarRuntime()}
                            <div class="batshit-settings-toggle-row">
                              <div class="flex items-center gap-1.5">
                                <p class="batshit-settings-parent-label">Live Browser Visibility</p>
                                <SettingsInfoMenu ariaLabel="About Subagent Live Browser Visibility">
                                  When enabled by default, browser actions run in headed mode so you can watch them live.
                                  Disable for hidden/headless execution.
                                </SettingsInfoMenu>
                              </div>
                              <Switch.Root
                                checked={getNativeAgentBrowserLiveViewEnabled("subagent")}
                                onCheckedChange={guardSubagentChoice((checked) =>
                                  updateNativeToolSetting("agentBrowserLiveViewEnabled", checked === true, "subagent"))}
                              />
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Browser Runtime Mode</Label.Label>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <Select.Root
                                  type="single"
                                  value={getNativeAgentBrowserRuntimeMode("subagent") as unknown as string}
                                  onValueChange={guardSubagentChoice((value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserRuntimeMode(next) ?? "chromium";
                                    updateNativeToolSetting("agentBrowserRuntimeMode", normalized, "subagent");
                                  })}
                                >
                                  <Select.Trigger class="justify-between">
                                    <span class="truncate">
                                      {NATIVE_AGENT_BROWSER_RUNTIME_MODE_LABELS[getNativeAgentBrowserRuntimeMode("subagent")]}
                                    </span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each NATIVE_AGENT_BROWSER_RUNTIME_MODE_OPTIONS as option}
                                      <Select.Item value={option}>
                                        {NATIVE_AGENT_BROWSER_RUNTIME_MODE_LABELS[option]}
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              </div>
                            </div>

                            {#if getNativeAgentBrowserRuntimeMode("subagent") === "chrome-cdp"}
                              <div class="batshit-settings-form-row">
                                <div class="batshit-settings-form-copy">
                                  <div class="batshit-settings-form-label-line">
                                    <Label.Label class="batshit-settings-form-label">Chrome CDP port</Label.Label>
                                  </div>
                                </div>
                                <div class="batshit-settings-form-control">
                                  <Input
                                    type="number"
                                    min="1"
                                    max="65535"
                                    step="1"
                                    value={String(getNativeAgentBrowserCdpPort("subagent"))}
                                    oninput={(event) => {
                                      const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
                                      updateNativeToolSetting(
                                        "agentBrowserCdpPort",
                                        Number.isFinite(parsed) ? Math.min(65535, Math.max(1, parsed)) : DEFAULT_NATIVE_AGENT_BROWSER_CDP_PORT,
                                        "subagent",
                                      );
                                    }}
                                  />
                                </div>
                              </div>
                            {/if}
                            {/if}

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Agent Browser Timeout</Label.Label>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <Select.Root
                                  type="single"
                                  value={String(getNativeAgentBrowserTimeoutMs("subagent")) as unknown as string}
                                  onValueChange={guardSubagentChoice((value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const parsed = Number.parseInt(String(next ?? ""), 10);
                                    updateNativeToolSetting(
                                      "agentBrowserTimeoutMs",
                                      Number.isFinite(parsed) ? parsed : DEFAULT_NATIVE_AGENT_BROWSER_TIMEOUT_MS,
                                      "subagent",
                                    );
                                  })}
                                >
                                  <Select.Trigger class="justify-between">
                                    <span class="truncate">{Math.round(getNativeAgentBrowserTimeoutMs("subagent") / 1000)} seconds</span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each NATIVE_AGENT_BROWSER_TIMEOUT_OPTIONS as timeoutMsValue}
                                      <Select.Item value={String(timeoutMsValue)}>
                                        {Math.round(timeoutMsValue / 1000)} seconds
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              </div>
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Cloud Provider (Optional)</Label.Label>
                                  <SettingsInfoMenu ariaLabel="About Subagent Agent Browser Cloud Provider">
                                    Power-user option. <code>local</code> is the default. Cloud providers need credentials saved in API Keys.
                                    {#if isAgentBrowserDockerSidecarRuntime()}
                                      In Docker, Batshit passes those credentials to the Agent Browser sidecar.
                                    {/if}
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <Select.Root
                                  type="single"
                                  value={getNativeAgentBrowserProvider("subagent") as unknown as string}
                                  onValueChange={guardSubagentChoice((value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserProvider(next) ?? "local";
                                    updateNativeToolSetting("agentBrowserProvider", normalized, "subagent");
                                  })}
                                >
                                  <Select.Trigger class="justify-between">
                                    <span class="truncate">
                                      {NATIVE_AGENT_BROWSER_PROVIDER_LABELS[getNativeAgentBrowserProvider("subagent")]}
                                    </span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each NATIVE_AGENT_BROWSER_PROVIDER_OPTIONS as option}
                                      <Select.Item value={option}>
                                        {NATIVE_AGENT_BROWSER_PROVIDER_LABELS[option]}
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              </div>
                            </div>

                            {#if !isAgentBrowserDockerSidecarRuntime()}
                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Browser Executable Path (Optional)</Label.Label>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control is-wide">
                                <Input
                                  placeholder="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                                  value={getNativeAgentBrowserExecutablePath("subagent")}
                                  oninput={(event) =>
                                    updateNativeToolSetting(
                                      "agentBrowserExecutablePath",
                                      (event.target as HTMLInputElement).value.trim() || null,
                                      "subagent",
                                    )}
                                />
                              </div>
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Default Session Name (Optional)</Label.Label>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <Input
                                  placeholder="default"
                                  value={getNativeAgentBrowserSession("subagent")}
                                  oninput={(event) =>
                                    updateNativeToolSetting(
                                      "agentBrowserSession",
                                      (event.target as HTMLInputElement).value.trim() || null,
                                      "subagent",
                                    )}
                                />
                              </div>
                            </div>

                            <div class="batshit-settings-form-row">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Default Profile Path (Optional)</Label.Label>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control is-wide">
                                <Input
                                  placeholder="~/.batshit/ab-profile"
                                  value={getNativeAgentBrowserProfilePath("subagent")}
                                  oninput={(event) =>
                                    updateNativeToolSetting(
                                      "agentBrowserProfilePath",
                                      (event.target as HTMLInputElement).value.trim() || null,
                                      "subagent",
                                    )}
                                />
                              </div>
                            </div>
                            {/if}

                            <div class="batshit-settings-form-row is-tall">
                              <div class="batshit-settings-form-copy">
                                <div class="batshit-settings-form-label-line">
                                  <Label.Label class="batshit-settings-form-label">Extra CLI Flags (Advanced)</Label.Label>
                                </div>
                              </div>
                              <div class="batshit-settings-form-control">
                                <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
                                  <div class="min-w-0 flex-1 space-y-1">
                                    <p class="batshit-settings-form-label">
                                      {getMultilineEntryCountLabel(
                                        getNativeAgentBrowserExtraFlagsText("subagent"),
                                        "flag",
                                        "flags",
                                        "No extra flags saved",
                                      )}
                                    </p>
                                    <p class="batshit-settings-code-caption line-clamp-3">
                                      {getMultilinePreviewText(
                                        getNativeAgentBrowserExtraFlagsText("subagent"),
                                        "Open the editor to add extra Agent Browser CLI flags.",
                                      )}
                                    </p>
                                  </div>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onclick={() => (subagentBrowserFlagsEditorOpen = true)}
                                  >
                                    <Pencil aria-hidden="true" />

                                    Edit
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </Collapsible.Content>
                      {/if}
                  </div>
                </Collapsible.Root>
                </div>

            </SettingsAccordionCard>
              {#if subagentForm.subagentType === "cli" && isClaudeCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-access-cards"
                  title="Claude Permissions & Boundaries"
                  batshitIcon="access"
                  class={hiddenUnlessSubagent("access")}
                  contentClass="space-y-4"
                  onfocusin={() => (subagentClaudeSaveScope = "permissions")}
                  onpointerdown={() => (subagentClaudeSaveScope = "permissions")}
                >
                  {#snippet info()}
                        <SettingsInfoMenu ariaLabel="About Subagent Claude Permissions">
                          Controls how freely Claude can act when tools are enabled.
                        </SettingsInfoMenu>
                  {/snippet}
                  {#snippet actions()}
                      {#if subagentClaudeSaveScope === "permissions"}
                        <SettingsSaveStatus
                          state={subagentClaudeSaveError ? "error" : subagentClaudeSaveState}
                          error={subagentClaudeSaveError}
                          savingLabel="Saving Claude access settings..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                    <div class="space-y-2">
                      <div class="flex items-center gap-1.5">
                        <Label.Root class="batshit-settings-form-label"
                          >Permissions Mode</Label.Root
                        >
                        <SettingsInfoMenu ariaLabel="About Subagent Claude permissions mode">
                          {#each CLAUDE_PERMISSION_OPTIONS as option}
                            <span class="mt-1 block">
                              <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                            </span>
                          {/each}
                        </SettingsInfoMenu>
                      </div>
                        <ToggleGroup.Root
                          type="single"
                          value={subagentClaudeForm.permissionMode}
                          variant="outline"
                          size="lg"
                          class="batshit-settings-permission-toggle-group"
                          aria-label="Subagent Claude permissions mode"
                          onValueChange={guardSubagentChoice((value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (!next) return;
                            setClaudePermissionMode(next as ClaudePermissionMode, "subagent");
                          })}
                        >
                          {#each CLAUDE_PERMISSION_OPTIONS as option}
                            <ToggleGroup.Item
                              value={option.value}
                              class={SETTINGS_PERMISSION_TOGGLE_ITEM_CLASS}
                            >
                              {@const OptionIcon = option.icon}
                              <OptionIcon class="h-4 w-4 shrink-0" />
                              <span class="batshit-settings-form-label truncate">{option.label}</span>
                            </ToggleGroup.Item>
                          {/each}
                        </ToggleGroup.Root>
                        {#if isDockerNativeRuntime()}
                          <p class="batshit-settings-form-meta is-warning">
                            Docker runs Claude Code as non-root batshit-cli so Bypass Permissions can
                            work. If you see a root-runtime warning, rebuild the Docker app image and
                            rerun the Claude login command shown above.
                          </p>
                        {/if}
                      </div>

                    <div class="batshit-settings-muted-panel batshit-settings-caption">
                      CLI subagents never pause for approval. Anything outside the saved boundaries fails instead.
                    </div>

                    <Collapsible.Root bind:open={subagentClaudeConfigOverridesOpen}>
                      <div class="batshit-settings-muted-panel">
                        <Collapsible.Trigger class={SETTINGS_DISCLOSURE_TRIGGER_CLASS}>
                          <span class="batshit-settings-form-label flex items-center gap-1.5">
                            <span>Custom settings.json entries</span>
                            <SettingsInfoMenu ariaLabel="About Subagent Custom settings.json entries">
                              Add advanced Claude settings using JSON paths like <code>cleanupPeriodDays</code>,
                              <code>env.FOO</code>, or <code>hooks.PreToolUse</code>. Batshit-managed keys stay protected,
                              and manual JSON outside those managed paths is preserved on sync.
                            </SettingsInfoMenu>
                          </span>
                          <ChevronDown
                            class={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${subagentClaudeConfigOverridesOpen ? "rotate-180" : ""}`}
                          />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="space-y-3 pt-3">
                          {#if subagentClaudeForm.configOverrides.length > 0}
                            <div class="space-y-2">
                              {#each subagentClaudeForm.configOverrides as row (row.id)}
                                <div class="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                                  <Input
                                    placeholder="JSON path"
                                    value={row.key}
                                    oninput={(event) =>
                                      updateClaudeConfig(row.id, "key", (event.target as HTMLInputElement).value, "subagent")}
                                  />
                                  <Input
                                    placeholder={"JSON value (30, true, [\"foo\"], {\"bar\":1})"}
                                    value={row.value}
                                    oninput={(event) =>
                                      updateClaudeConfig(row.id, "value", (event.target as HTMLInputElement).value, "subagent")}
                                  />
                                  <Button type="button" variant="ghost" onclick={() => removeClaudeConfig(row.id, "subagent")}>
                                    <Trash2 aria-hidden="true" />

                                    Remove
                                  </Button>
                                </div>
                              {/each}
                            </div>
                          {/if}
                          <Button class="mt-2" variant="outline" size="sm" onclick={() => addClaudeConfig("subagent")}>
                            <Plus aria-hidden="true" />

                            Add config row
                          </Button>
                        </Collapsible.Content>
                      </div>
                    </Collapsible.Root>

                    <div class="batshit-settings-muted-panel">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div class="flex items-center gap-1.5">
                          <p class="batshit-settings-form-label">Managed settings.json</p>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger
                              class={SETTINGS_INFO_TRIGGER_CLASS}
                              aria-label="About Subagent Managed settings.json"
                            >
                              <Info class="h-3.5 w-3.5" />
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content
                              align="start"
                              side="bottom"
                              class={SETTINGS_INFO_CONTENT_CLASS}
                            >
                              View the exact Batshit-managed Claude settings file for this subagent.
                            </DropdownMenu.Content>
                          </DropdownMenu.Root>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onclick={() => openManagedConfigViewer("claude")}
                          >
                            <Eye aria-hidden="true" />

                            View settings.json
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onclick={() => copyManagedConfigPath("claude")}
                          >
                            <Copy aria-hidden="true" />

                            Copy path
                          </Button>
                        </div>
                      </div>
                    </div>
                </SettingsAccordionCard>
              {/if}

              {#if subagentForm.subagentType === "cli" && isCodexCliSubagentProvider}
                <SettingsAccordionCard
                  name="subagent-access-cards"
                  title="Codex Permissions & Boundaries"
                  batshitIcon="access"
                  class={hiddenUnlessSubagent("access")}
                  contentClass="space-y-5"
                  onfocusin={() => (subagentCodexSaveScope = "permissions")}
                  onpointerdown={() => (subagentCodexSaveScope = "permissions")}
                >
                  {#snippet info()}
                        <SettingsInfoMenu ariaLabel="About Subagent Codex Permissions">
                          Sandbox Level is saved with this Subagent. Choosing a mode sets its own level.
                        </SettingsInfoMenu>
                  {/snippet}
                  {#snippet actions()}
                      {#if subagentCodexSaveScope === "permissions"}
                        <SettingsSaveStatus
                          state={subagentCodexSaveError ? "error" : subagentCodexSaveState}
                          error={subagentCodexSaveError}
                          savingLabel="Saving Codex access settings..."
                          savedLabel="Saved"
                        />
                      {/if}
                  {/snippet}
                    <div class="space-y-2">
                      <div class="flex items-center gap-1.5">
                        <Label.Root class="batshit-settings-form-label"
                          >Permissions Mode</Label.Root
                        >
                        <SettingsInfoMenu ariaLabel="About Subagent Codex permissions mode">
                          {#each CODEX_PERMISSION_OPTIONS as option}
                            <span class="mt-1 block">
                              <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                            </span>
                          {/each}
                        </SettingsInfoMenu>
                      </div>
                        <ToggleGroup.Root
                          type="single"
                          value={subagentCodexForm.permissionMode}
                          variant="outline"
                          size="lg"
                          class="batshit-settings-permission-toggle-group"
                          aria-label="Subagent Codex permissions mode"
                          onValueChange={guardSubagentChoice((value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (!next) return;
                            setCodexPermissionMode(next as CodexPermissionMode, "subagent");
                          })}
                        >
                          {#each CODEX_PERMISSION_OPTIONS as option}
                            <ToggleGroup.Item
                              value={option.value}
                              class={SETTINGS_PERMISSION_TOGGLE_ITEM_CLASS}
                            >
                              {@const OptionIcon = option.icon}
                              <OptionIcon class="h-4 w-4 shrink-0" />
                              <span class="batshit-settings-form-label truncate">{option.label}</span>
                            </ToggleGroup.Item>
                          {/each}
                        </ToggleGroup.Root>
                      </div>

                      <div class="batshit-settings-form-stack">
                        <div class="batshit-settings-form-row">
                          <div class="batshit-settings-form-copy">
                            <div class="batshit-settings-form-label-line">
                              <Label.Root class="batshit-settings-form-label"
                                >Sandbox Level</Label.Root
                              >
                            </div>
                          </div>
                          <div class="batshit-settings-form-control">
                            <Select.Root
                              type="single"
                              value={subagentCodexForm.sandbox}
                              disabled={subagentCodexForm.permissionMode === "agent_full"}
                              onValueChange={guardSubagentChoice((value) =>
                                updateCodexForm((current) => ({
                                  ...current,
                                  sandbox: (Array.isArray(value)
                                    ? value[0]
                                    : value) as CodexSandbox,
                                }), "subagent"))}
                            >
                              <Select.Trigger>
                                <span>
                                  {CODEX_SANDBOX_OPTIONS.find((option) =>
                                    option.value === subagentCodexForm.sandbox
                                  )?.label ?? subagentCodexForm.sandbox}
                                </span>
                              </Select.Trigger>
                              <Select.Content>
                                {#each CODEX_SANDBOX_OPTIONS as option}
                                  <Select.Item value={option.value}>{option.label}</Select.Item>
                                {/each}
                              </Select.Content>
                            </Select.Root>
                          </div>
                        </div>
                  {#if subagentCodexForm.permissionMode === "agent_full"}
                    <div class="batshit-settings-note" data-testid="subagent-codex-full-sandbox-note">
                      {#if subagentCodexForm.sandbox !== CODEX_PERMISSION_PRESETS.agent_full.sandbox}
                        This Subagent keeps its saved {CODEX_SANDBOX_LABELS[subagentCodexForm.sandbox]} Sandbox Level.
                      {/if}
                      To limit the sandbox, pick Agent.
                    </div>
                  {/if}
                      </div>

                    <div class="batshit-settings-muted-panel batshit-settings-caption">
                      CLI subagents never pause for approval. Anything outside the saved boundaries fails instead.
                    </div>

                    <Collapsible.Root bind:open={subagentCodexConfigOverridesOpen}>
                      <div class="batshit-settings-muted-panel">
                        <Collapsible.Trigger class={SETTINGS_DISCLOSURE_TRIGGER_CLASS}>
                          <span class="batshit-settings-form-label flex items-center gap-1.5">
                            <span>Custom config.toml entries</span>
                            <SettingsInfoMenu ariaLabel="About Subagent Custom config.toml entries">
                              Add advanced Codex config rows for settings Batshit does not manage directly,
                              like <code>model_context_window</code>. Batshit-managed keys stay protected.
                            </SettingsInfoMenu>
                          </span>
                          <ChevronDown
                            class={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${subagentCodexConfigOverridesOpen ? "rotate-180" : ""}`}
                          />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="space-y-3 pt-3">
                          {#if subagentCodexForm.configOverrides.length > 0}
                            <div class="space-y-2">
                              {#each subagentCodexForm.configOverrides as row (row.id)}
                                <div class="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                                  <Input
                                    placeholder="key"
                                    value={row.key}
                                    oninput={(event) =>
                                      updateCodexConfig(row.id, "key", (event.target as HTMLInputElement).value, "subagent")}
                                  />
                                  <Input
                                    placeholder="value"
                                    value={row.value}
                                    oninput={(event) =>
                                      updateCodexConfig(row.id, "value", (event.target as HTMLInputElement).value, "subagent")}
                                  />
                                  <Button type="button" variant="ghost" onclick={() => removeCodexConfig(row.id, "subagent")}>
                                    <Trash2 aria-hidden="true" />

                                    Remove
                                  </Button>
                                </div>
                              {/each}
                            </div>
                          {/if}
                          <Button class="mt-2" variant="outline" size="sm" onclick={() => addCodexConfig("subagent")}>
                            <Plus aria-hidden="true" />

                            Add config row
                          </Button>
                        </Collapsible.Content>
                      </div>
                    </Collapsible.Root>

                    <div class="batshit-settings-muted-panel">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div class="flex items-center gap-1.5">
                          <p class="batshit-settings-form-label">Managed config.toml</p>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger
                              class={SETTINGS_INFO_TRIGGER_CLASS}
                              aria-label="About Subagent Managed config.toml"
                            >
                              <Info class="h-3.5 w-3.5" />
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content
                              align="start"
                              side="bottom"
                              class={SETTINGS_INFO_CONTENT_CLASS}
                            >
                              View the exact Batshit-managed Codex config file for this subagent.
                            </DropdownMenu.Content>
                          </DropdownMenu.Root>
                        </div>
                        <div class="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onclick={() => openManagedConfigViewer("codex")}
                          >
                            <Eye aria-hidden="true" />

                            View config.toml
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onclick={() => copyManagedConfigPath("codex")}
                          >
                            <Copy aria-hidden="true" />

                            Copy path
                          </Button>
                        </div>
                      </div>
                    </div>
                </SettingsAccordionCard>
              {/if}

              {#if subagentForm.subagentType !== "cli"}
            <SettingsAccordionCard
              name="subagent-access-cards"
              title="Batshit Permissions & Boundaries"
              batshitIcon="access"
              class={hiddenUnlessSubagent("access")}
              contentClass="space-y-4"
              onfocusin={() => (subagentSaveScope = "permissions")}
            onpointerdown={() => (subagentSaveScope = "permissions")}
          >
            {#snippet info()}
                  <SettingsInfoMenu ariaLabel="About Subagent Permissions And Boundaries">
                    Controls where Batshit-native command execution runs for this subagent and how much
                    freedom it has once Command execution is enabled.
                  </SettingsInfoMenu>
            {/snippet}
            {#snippet actions()}
                {#if subagentSaveScope === "permissions"}
                  <SettingsSaveStatus
                    state={subagentEditSaveError || subagentValidationError ? "error" : subagentEditSaveState}
                    error={subagentEditSaveError ?? subagentValidationError}
                    savingLabel="Saving subagent settings..."
                    savedLabel="Saved"
                  />
                {/if}
            {/snippet}
              {#if getNativeToolToggle("bashEnabled", true, "subagent")}
                <div class="space-y-2">
                  <div class="flex items-center gap-1.5">
                    <Label.Root class="batshit-settings-form-label"
                      >Permissions Mode</Label.Root
                    >
                    <SettingsInfoMenu ariaLabel="About Subagent permissions mode">
                      {#each NATIVE_PERMISSION_OPTIONS as option}
                        <span class="mt-1 block">
                          <span class="batshit-settings-inline-strong">{option.label}</span>: {option.helper}
                        </span>
                      {/each}
                      <span class="mt-2 block">
                        Subagent runs are non-interactive, so approval prompts stay unavailable.
                      </span>
                    </SettingsInfoMenu>
                  </div>
                    <ToggleGroup.Root
                      type="single"
                      value={getNativeBashAccessMode("subagent") as unknown as string}
                      variant="outline"
                      size="lg"
                      class="batshit-settings-permission-toggle-group"
                      aria-label="Subagent Batshit permissions mode"
                      onValueChange={guardSubagentChoice((value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        if (!NATIVE_BASH_ACCESS_MODE_OPTIONS.includes(next as NativeBashAccessMode)) return;
                        const mode = next as NativeBashAccessMode;
                        updateNativeToolSetting("bashAccessMode", mode, "subagent");
                        updateNativeToolSetting(
                          "executionBackend",
                          getBashBackendForPermissionMode(mode),
                          "subagent",
                        );
                        updateNativeToolSetting("bashPolicyMode", null, "subagent");
                      })}
                    >
                      {#each NATIVE_PERMISSION_OPTIONS as option}
                        <ToggleGroup.Item
                          value={option.value}
                          class={SETTINGS_PERMISSION_TOGGLE_ITEM_CLASS}
                        >
                          {@const OptionIcon = option.icon}
                          <OptionIcon class="h-4 w-4 shrink-0" />
                          <span class="batshit-settings-form-label truncate">{option.label}</span>
                        </ToggleGroup.Item>
                      {/each}
                    </ToggleGroup.Root>
                  </div>

                  {@const subagentSelectedSandboxBackend = getNativeExecutionBackend("subagent")}
                  {@const subagentSelectedSandboxStatus = getSandboxStatusForBackend(subagentSelectedSandboxBackend)}
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row is-tall">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label.Root class="batshit-settings-form-label">
                            Sandbox
                          </Label.Root>
                          <SettingsInfoMenu ariaLabel="About Subagent Sandbox">
                            Batshit keeps one sandbox for the active run in this workspace, then cleans it
                            up when the run ends. Disk use depends on what gets installed or built during
                            the run.
                          </SettingsInfoMenu>
                          {#if subagentSelectedSandboxBackend === "local"}
                            <SettingsInfoMenu
                              ariaLabel={isDockerNativeRuntime() ? "About App Container Shell mode" : "About Local Machine mode"}
                              tone="amber"
                            >
                              {#if isDockerNativeRuntime()}
                                App Container Shell runs commands inside the Batshit app container against
                                the mounted workspace. It is not the host computer shell. Allow/deny rules
                                and hard safety blocks still apply, but filesystem and network effects happen
                                inside the container and any mounted folders.
                              {:else}
                                Local Machine mode runs commands directly on your machine instead of inside
                                the Docker sandbox. Allow/deny rules and hard safety blocks still apply,
                                but filesystem and network effects happen on the host.
                              {/if}
                            </SettingsInfoMenu>
                          {/if}
                          {#if subagentSelectedSandboxStatus?.available}
                            <span class="batshit-settings-pill is-info">
                              <Package class="h-3.5 w-3.5" />
                              Sandbox Ready
                            </span>
                          {/if}
                        </div>
                      </div>
                      <div class="batshit-settings-form-control-group">
                        <Select.Root
                          type="single"
                          value={subagentSelectedSandboxBackend as unknown as string}
                          onValueChange={guardSubagentChoice((value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            const normalized = normalizeNativeExecutionBackend(next) ?? getDefaultNativeExecutionBackend();
                            updateNativeToolSetting("executionBackend", normalized, "subagent");
                          })}
                        >
                          <Select.Trigger class="justify-between">
                            <span class="truncate">
                              {getNativeExecutionBackendLabel(subagentSelectedSandboxBackend)}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each NATIVE_EXECUTION_BACKEND_OPTIONS as option}
                              <Select.Item value={option}>
                                {getNativeExecutionBackendLabel(option)}
                              </Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                        {#if nativeSandboxStatusLoading}
                          <p class="batshit-settings-form-help">Checking sandbox status...</p>
                        {:else if subagentSelectedSandboxBackend !== "local" && !subagentSelectedSandboxStatus?.available}
                          <p class="batshit-settings-form-help is-danger">
                            {getSandboxUnavailableMessage(subagentSelectedSandboxBackend, subagentSelectedSandboxStatus)}
                          </p>
                          {#if subagentSelectedSandboxStatus?.reason}
                            <p class="batshit-settings-form-help is-danger">{subagentSelectedSandboxStatus.reason}</p>
                          {/if}
                        {:else if subagentSelectedSandboxBackend === "apple_container" && subagentSelectedSandboxStatus?.systemRunning === false}
                          <p class="batshit-settings-form-help">
                            Apple Container is not started yet. Batshit starts it with the first sandboxed command.
                          </p>
                        {:else if subagentSelectedSandboxBackend === "local" && isDockerNativeRuntime()}
                          <p class="batshit-settings-form-help">
                            Bash commands will run inside the Batshit app container with access to the mounted workspace.
                          </p>
                        {/if}
                        {#if nativeSandboxStatusError}
                          <p class="batshit-settings-form-help is-danger">{nativeSandboxStatusError}</p>
                        {/if}
                        {#if subagentSelectedSandboxBackend === "local"}
                          <p class="batshit-settings-form-help is-warning">
                            Warning: Local mode runs commands directly on your machine.
                          </p>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/if}

              {#if getNativeToolToggle("bashEnabled", true, "subagent")}
                <details class="batshit-settings-muted-panel">
                  <summary class="batshit-settings-caption cursor-pointer">
                    Advanced Safety Rules
                  </summary>
                  <div class="mt-3 space-y-4">
                    <div class="space-y-2 batshit-settings-muted-panel">
                      <div class="flex items-center gap-1.5">
                        <Label.Root class="batshit-settings-form-label">
                          Command Timeout
                        </Label.Root>
                        <SettingsInfoMenu ariaLabel="About Subagent Command Timeout">
                          Limits how long a native subagent command can run before Batshit stops it.
                        </SettingsInfoMenu>
                      </div>
                      <Select.Root
                        type="single"
                        value={String(getNativeBashTimeoutMs("subagent")) as unknown as string}
                        onValueChange={guardSubagentChoice((value) => {
                          const next = Array.isArray(value) ? value[0] : value;
                          const parsed = Number.parseInt(String(next ?? ""), 10);
                          updateNativeToolSetting(
                            "bashTimeoutMs",
                            Number.isFinite(parsed) ? parsed : 30_000,
                            "subagent",
                          );
                        })}
                      >
                        <Select.Trigger class="justify-between">
                          <span class="truncate">
                            {Math.round(getNativeBashTimeoutMs("subagent") / 1000)} seconds
                          </span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each NATIVE_BASH_TIMEOUT_OPTIONS as timeoutMsValue}
                            <Select.Item value={String(timeoutMsValue)}>
                              {Math.round(timeoutMsValue / 1000)} seconds
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>

                    <div class="space-y-2 batshit-settings-muted-panel">
                      <div class="flex items-center gap-1.5">
                        <Label.Label class="batshit-settings-form-label">Always Block List</Label.Label>
                        <SettingsInfoMenu ariaLabel="About Subagent Always Block List">
                          Rules in this list are blocked for all modes, including Batshit Crazy.
                        </SettingsInfoMenu>
                      </div>
                      <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
                        <div class="min-w-0 flex-1 space-y-1">
                          <p class="batshit-settings-form-label">
                            {getMultilineEntryCountLabel(
                              getNativeBashPatternListText("bashNeverAllowList", "subagent"),
                              "rule",
                              "rules",
                              "No rules saved",
                            )}
                          </p>
                          <p class="batshit-settings-code-caption line-clamp-3">
                            {getMultilinePreviewText(
                              getNativeBashPatternListText("bashNeverAllowList", "subagent"),
                              "Open the editor to manage blocked command patterns.",
                            )}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onclick={() => (subagentBashBlockEditorOpen = true)}
                        >
                          <Pencil aria-hidden="true" />

                          Edit
                        </Button>
                      </div>
                    </div>

                    {#if getNativeBashAccessMode("subagent") === "agent"}
                      <div class="space-y-2 batshit-settings-muted-panel">
                        <div class="flex items-center gap-1.5">
                          <Label.Label class="batshit-settings-form-label">Always Allow List</Label.Label>
                          <SettingsInfoMenu ariaLabel="About Subagent Always Allow List">
                            Matching rules always run immediately. Non-matching commands are blocked in Agent mode.
                          </SettingsInfoMenu>
                        </div>
                        <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
                          <div class="min-w-0 flex-1 space-y-1">
                            <p class="batshit-settings-form-label">
                              {getMultilineEntryCountLabel(
                                getNativeBashPatternListText("bashCommandAllowList", "subagent"),
                                "rule",
                                "rules",
                                "No rules saved",
                              )}
                            </p>
                            <p class="batshit-settings-code-caption line-clamp-3">
                              {getMultilinePreviewText(
                                getNativeBashPatternListText("bashCommandAllowList", "subagent"),
                                "Open the editor to manage always-allow command patterns.",
                              )}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onclick={() => (subagentBashAllowEditorOpen = true)}
                          >
                            <Pencil aria-hidden="true" />

                            Edit
                          </Button>
                        </div>
                      </div>
                    {/if}
                  </div>
                </details>
                <div class="batshit-settings-caption flex items-center gap-1.5">
                  <span class="batshit-settings-inline-strong">Hard Safety Blocks</span>
                  <SettingsInfoMenu ariaLabel="About Subagent Hard Safety Blocks">
                    Hard safety blocks remain enforced and cannot be overridden.
                  </SettingsInfoMenu>
                </div>
              {:else}
                <div class="batshit-settings-inline-alert is-dashed">
                  Turn on <span class="batshit-settings-inline-strong">Command execution</span> in the Tools tab to configure execution permissions and safety rules.
                </div>
              {/if}
            </SettingsAccordionCard>
              {/if}

          <SubagentAccessAssignmentsSection
            sectionClass={hiddenUnlessSubagent("access")}
            selectedSubagentId={selectedEditableSubagentId}
            {accessSaveState}
            {accessSaveError}
            {accessSaveScope}
            {accessResourcesLoading}
            {accessResourcesLoaded}
            {accessResourcesError}
            {accessSlashCommands}
            {accessArtifacts}
            {getSlashCommandEnabledForEntity}
            {getArtifactEnabledForEntity}
            {getArtifactAccessScope}
            {getArtifactPlacementLabel}
            onSlashCommandToggle={toggleSlashCommandAccess}
            onArtifactToggle={toggleArtifactAccess}
            onAccessSaveScopeChange={(scope) => {
              accessSaveScope = scope
            }}
          />

          <AgentDeleteDisclosure
            bind:open={subagentDeleteOpen}
            sectionClass={hiddenUnlessSubagent("core")}
            title="Delete Subagent"
            paragraphs={[
              subagentForm.subagentType === "n8n-subnode"
                ? "This saved record uses the retired n8n Subnode Subagent type. Deleting it is the only supported action; n8n Workflow Subagents remain supported."
                : "Removes this Subagent, its avatar reference, and any assignments from every Primary Agent. Conversations remain in Redis.",
              "Primary Agents will immediately stop referencing it."
            ]}
            error={subagentDeleteError}
            busy={subagentDeleteState === "deleting"}
            disabled={!selectedEditableSubagentId || subagentDeleteState === "deleting"}
            onDelete={handleDeleteSubagent}
          />
              </fieldset>
      </div>
      <!-- Subagent Settings End -->
    {:else}
      <Card.Root>
        <Card.Content class="batshit-settings-card-empty">
          Select a Primary Agent or Subagent to view settings.
        </Card.Content>
      </Card.Root>
    {/if}
  </div>
{/if}

<SettingsTextEditor
  bind:open={agentPromptEditorOpen}
  title="Agent Custom System Prompt"
  description="Agent-specific Custom System Prompt. This adds to the agent's compiled prompt stack."
  value={promptValue}
  placeholder="Custom system prompt for this agent"
  width="large"
  onSave={saveAgentPromptFromEditor}
/>

<SettingsTextEditor
  bind:open={agentBashBlockEditorOpen}
  title="Always Block List"
  description="Blocked command patterns for this agent. One rule per line."
  value={getNativeBashPatternListText("bashNeverAllowList")}
  placeholder={"One rule per line\nExamples:\nre:^\\s*rm\\s+-rf\\s+\nterraform destroy"}
  width="large"
  onSave={async (value) =>
    saveBasicMultilineEditor("permissions", (current) =>
      withNativeBashPatternList(current, "bashNeverAllowList", value),
    )}
/>

<SettingsTextEditor
  bind:open={agentBashAllowEditorOpen}
  title="Always Allow List"
  description="Commands that can run immediately for this agent. One rule per line."
  value={getNativeBashPatternListText("bashCommandAllowList")}
  placeholder={"One rule per line\nExamples:\nrg *\nre:^\\s*npm\\s+run\\s+(test|check)\\b"}
  width="large"
  onSave={async (value) =>
    saveBasicMultilineEditor("permissions", (current) =>
      withNativeBashPatternList(current, "bashCommandAllowList", value),
    )}
/>

<SettingsTextEditor
  bind:open={agentBrowserFlagsEditorOpen}
  title="Agent Browser Extra CLI Flags"
  description="Extra CLI flags appended to Agent Browser commands for this agent. One flag per line."
  value={getNativeAgentBrowserExtraFlagsText()}
  placeholder={"One flag per line\nExamples:\n--slow-mo 150\n--some-provider-flag value"}
  width="large"
  onSave={async (value) =>
    saveBasicMultilineEditor("tools", (current) =>
      withNativeAgentBrowserExtraFlags(current, value),
    )}
/>

<SettingsTextEditor
  bind:open={subagentPromptEditorOpen}
  title="Subagent Custom System Prompt"
  description="Subagent-specific Custom System Prompt. This adds to the subagent's compiled prompt stack."
  value={subagentForm.system_prompt}
  placeholder="Custom instructions for this Subagent"
  width="large"
  onSave={async (value) =>
    saveSubagentMultilineEditor("instructions", (current) => ({
      ...current,
      system_prompt: value,
    }))}
/>

<SettingsTextEditor
  bind:open={subagentBashBlockEditorOpen}
  title="Subagent Always Block List"
  description="Blocked command patterns for this subagent. One rule per line."
  value={getNativeBashPatternListText("bashNeverAllowList", "subagent")}
  placeholder={"One rule per line\nExamples:\nre:^\\s*rm\\s+-rf\\s+\nterraform destroy"}
  width="large"
  onSave={async (value) =>
    saveSubagentMultilineEditor("permissions", (current) =>
      withNativeBashPatternList(current, "bashNeverAllowList", value),
    )}
/>

<SettingsTextEditor
  bind:open={subagentBashAllowEditorOpen}
  title="Subagent Always Allow List"
  description="Commands that can run immediately for this subagent. One rule per line."
  value={getNativeBashPatternListText("bashCommandAllowList", "subagent")}
  placeholder={"One rule per line\nExamples:\nrg *\nre:^\\s*npm\\s+run\\s+(test|check)\\b"}
  width="large"
  onSave={async (value) =>
    saveSubagentMultilineEditor("permissions", (current) =>
      withNativeBashPatternList(current, "bashCommandAllowList", value),
    )}
/>

<SettingsTextEditor
  bind:open={subagentBrowserFlagsEditorOpen}
  title="Subagent Agent Browser Extra CLI Flags"
  description="Extra CLI flags appended to Agent Browser commands for this subagent. One flag per line."
  value={getNativeAgentBrowserExtraFlagsText("subagent")}
  placeholder={"One flag per line\nExamples:\n--slow-mo 150\n--some-provider-flag value"}
  width="large"
  onSave={async (value) =>
    saveSubagentMultilineEditor("tools", (current) =>
      withNativeAgentBrowserExtraFlags(current, value),
    )}
/>

<Dialog.Root
  open={createEntityMode}
  onOpenChange={(open) => {
    if (open) {
      createEntityMode = true;
    }
  }}
>
  <Dialog.Content
    class="batshit-settings-dialog batshit-settings-create-dialog max-h-[88vh] sm:max-w-[760px]"
    showCloseButton={false}
    onInteractOutside={(event: Event) => event.preventDefault()}
    onEscapeKeydown={(event: KeyboardEvent) => event.preventDefault()}
  >
    <form
      class="flex max-h-[calc(88vh-3rem)] flex-col gap-5"
      onsubmit={(event) => {
        event.preventDefault();
        void handleCreateEntity();
      }}
    >
      <Dialog.Header>
        <Dialog.Title>Create Primary Agent or Subagent</Dialog.Title>
        <Dialog.Description>
          New items stay in this create flow until you choose either Create or Cancel.
        </Dialog.Description>
      </Dialog.Header>

      <div class="min-h-0 flex-1 overflow-y-auto pr-1">
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <Label.Label class="batshit-settings-form-label">Entity Type</Label.Label>
            </div>
            <div class="batshit-settings-form-inline-actions">
              <Button
                type="button"
                variant={createEntityForm.kind === "agent" ? "default" : "outline"}
                size="sm"
                onclick={() =>
                  (createEntityForm = {
                    ...createEntityForm,
                    kind: "agent",
                    slugManuallyEdited: false,
                    slug: sanitizeId(createEntityForm.displayName),
                  })}
              >
                <Brain aria-hidden="true" />
                Primary Agent
              </Button>
              <Button
                type="button"
                variant={createEntityForm.kind === "subagent" ? "default" : "outline"}
                size="sm"
                onclick={() =>
                  (createEntityForm = {
                    ...createEntityForm,
                    kind: "subagent",
                    slugManuallyEdited: false,
                    slug: sanitizeId(createEntityForm.displayName),
                  })}
              >
                <Users aria-hidden="true" />
                Subagent
              </Button>
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <Label.Label class="batshit-settings-form-label" for="create-name">Display Name</Label.Label>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id="create-name"
                placeholder="Agent name"
                bind:value={createEntityForm.displayName}
              />
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label.Label class="batshit-settings-form-label" for="create-slug">ID (Slug)</Label.Label>
                <SettingsInfoMenu ariaLabel="About Create Agent Slug">
                  Lowercase letters, numbers, and underscores only. Used in Redis keys,
                  webhook payloads, and in n8n expressions.
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id="create-slug"
                value={createEntityForm.slug}
                placeholder="customizable now or never"
                oninput={(event) => {
                  const value = (event.target as HTMLInputElement).value;
                  createEntityForm = {
                    ...createEntityForm,
                    slug: sanitizeId(value),
                    slugManuallyEdited: true,
                  };
                }}
              />
            </div>
          </div>

          {#if createEntityForm.kind === "agent"}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <Label.Label class="batshit-settings-form-label">Primary Agent Type</Label.Label>
              </div>
              <div class="batshit-settings-form-inline-actions">
                <Button
                  type="button"
                  variant={createEntityForm.agentType === "api" ? "default" : "outline"}
                  size="sm"
                  onclick={() =>
                    (createEntityForm = {
                      ...createEntityForm,
                      agentType: "api",
                    })}
                >
                  <Brain aria-hidden="true" />
                  API agent
                </Button>
                <Button
                  type="button"
                  variant={createEntityForm.agentType === "cli" ? "default" : "outline"}
                  size="sm"
                  onclick={() =>
                    (createEntityForm = {
                      ...createEntityForm,
                      agentType: "cli",
                    })}
                >
                  <TerminalSquare aria-hidden="true" />
                  CLI agent
                </Button>
              </div>
            </div>

            <div class="batshit-settings-toggle-row">
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <p class="batshit-settings-parent-label">Include Global Custom Prompt</p>
                  <SettingsInfoMenu ariaLabel="About Create Global Custom Prompt">
                    Include the Global Custom Prompt from the Prompts tab.
                  </SettingsInfoMenu>
                </div>
              </div>
              <Switch.Root bind:checked={createEntityForm.include_global_prompt} />
            </div>
          {:else}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <Label.Label class="batshit-settings-form-label">Subagent Type</Label.Label>
              </div>
              <div class="batshit-settings-form-inline-actions">
                <Button
                  type="button"
                  variant={createEntityForm.subagentType === "n8n-workflow" ? "default" : "outline"}
                  size="sm"
                  onclick={() =>
                    (createEntityForm = {
                      ...createEntityForm,
                      subagentType: "n8n-workflow",
                    })}
                >
                  <Package aria-hidden="true" />
                  n8n Workflow
                </Button>
                <Button
                  type="button"
                  variant={createEntityForm.subagentType === "api" ? "default" : "outline"}
                  size="sm"
                  onclick={() =>
                    (createEntityForm = {
                      ...createEntityForm,
                      subagentType: "api",
                    })}
                >
                  <Brain aria-hidden="true" />
                  API
                </Button>
                <Button
                  type="button"
                  variant={createEntityForm.subagentType === "cli" ? "default" : "outline"}
                  size="sm"
                  onclick={() =>
                    (createEntityForm = {
                      ...createEntityForm,
                      subagentType: "cli",
                    })}
                >
                  <TerminalSquare aria-hidden="true" />
                  CLI
                </Button>
              </div>
            </div>

            {#if isWorkflowBackedSubagentType(createEntityForm.subagentType)}
              <div class="batshit-settings-form-row">
                <div class="batshit-settings-form-copy">
                  <div class="batshit-settings-form-label-line">
                    <Label.Label class="batshit-settings-form-label" for="create-subagent-webhook">Production Webhook URL</Label.Label>
                    <SettingsInfoMenu ariaLabel="About Create Subagent Webhook URL">
                      Use the Production Webhook URL, not the Test Webhook URL.
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-form-control is-wide">
                  <Input
                    id="create-subagent-webhook"
                    placeholder="http://localhost:5678/webhook/batshit_n8n_workflow_subagent"
                    bind:value={createEntityForm.webhook_url}
                  />
                </div>
              </div>
            {/if}
          {/if}
        </div>

        {#if createEntityError}
          <div
            class="batshit-settings-inline-alert is-danger flex items-center gap-2"
          >
            <AlertCircle class="h-4 w-4" />
            {createEntityError}
          </div>
        {/if}
      </div>

      <Dialog.Footer class="justify-start gap-3">
        <Button type="submit" disabled={createEntityBusy}>
          {#if createEntityBusy}
            <Loader2 class="animate-spin" />
          {/if}
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          onclick={handleCancelCreateEntity}
          disabled={createEntityBusy}
        >
          <X aria-hidden="true" />
          Cancel
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={managedConfigDialogOpen}>
  <Dialog.Content class="sm:max-w-[960px] max-h-[85vh] flex flex-col">
    <Dialog.Header>
      <Dialog.Title>{getManagedConfigDialogTitle()}</Dialog.Title>
      <Dialog.Description>
        Read-only view of the exact managed config file Batshit is writing for this agent.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div class="flex flex-col gap-3 batshit-settings-muted-panel sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0 space-y-1">
          <p class="batshit-settings-form-label">Path</p>
          <p class="batshit-settings-code-caption truncate">
            {managedConfigPath || "Loading managed config path…"}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!managedConfigPath}
          onclick={() => copyId(managedConfigPath, `${managedConfigFileName} path`)}
        >
          <Copy aria-hidden="true" />

          Copy path
        </Button>
      </div>

      {#if managedConfigLoading}
        <div class="batshit-settings-note is-dashed flex items-center gap-2">
          <Loader2 class="h-4 w-4 animate-spin" />
          Loading managed config…
        </div>
      {:else if managedConfigError}
        <div class="batshit-settings-inline-alert is-danger">
          {managedConfigError}
        </div>
      {:else}
        <div class="min-h-0 flex-1 batshit-settings-table-frame">
          <pre class="batshit-settings-code-block">{managedConfigContents}</pre>
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
