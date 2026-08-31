<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { debounce } from "$lib/utils/debounce";
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
  import { confirmDialog } from "$lib/stores/confirmDialog";
  import { copyTextToClipboard } from "$lib/utils/clipboard";
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
import { getModelPresetAvailability } from "$lib/utils/modelPresetAvailability";
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
  import {
    buildAgentMemoryRecordFields,
    resolveAgentMemorySettingsDraft,
    type AgentMemorySettingsDraft,
  } from "$lib/utils/memoryControl";
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

  type CustomToolPayload = {
    tool_name: string;
    buffer_size?: number;
    zip_threshold?: number;
    auto_zip?: boolean;
    zip_disabled?: boolean;
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

  interface ZipForm {
    zip_agent_control_enabled: string;
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

  const CODEX_PERMISSION_PRESETS: Record<
    CodexPermissionMode,
    { sandbox: CodexSandbox }
  > = {
    chat: { sandbox: "read-only" },
    agent: { sandbox: "workspace-write" },
    agent_full: { sandbox: "danger-full-access" },
  };

  const CODEX_PERMISSION_OPTIONS: Array<{
    value: CodexPermissionMode;
    label: string;
    helper: string;
    icon: typeof MessageCircle;
  }> = [
    { value: "chat", label: "Chat", helper: "Read-only, never prompts", icon: MessageCircle },
    { value: "agent", label: "Agent", helper: "Workspace write, ask on failure", icon: Shield },
    {
      value: "agent_full",
      label: "Agent (full)",
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
      value: "acceptEdits",
      label: "Edit Automatically",
      helper: "Approved work runs automatically; extra actions follow Approval Policy.",
      icon: Shield,
    },
    {
      value: "bypassPermissions",
      label: "Bypass Permissions",
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
      label: "On Failure",
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

  const CODEX_SANDBOX_OPTIONS = [
    { value: "read-only", label: "Read-only" },
    { value: "workspace-write", label: "Workspace write" },
    { value: "danger-full-access", label: "Danger full access" },
  ];

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

  const ZIP_PERMISSION_INHERIT = "__inherit__";
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
    fallback_model_enabled?: boolean;
    fallback_model_provider?: string | null;
    fallback_model_name?: string | null;
    fallback_model_preset_id?: string | null;
    fallback_model_connection?: ModelConnectionInfo | null;
    fallback_model_temperature?: number | null;
    fallback_model_max_tokens?: number | null;
    fallback_model_top_p?: number | null;
    fallback_model_top_k?: number | null;
    fallback_model_frequency_penalty?: number | null;
    fallback_model_presence_penalty?: number | null;
    fallback_model_seed?: number | null;
    fallback_model_stop_sequences?: string[] | null;
    fallback_model_reasoning_effort?: string | null;
    fallback_model_capabilities?: ModelCapabilities | null;
    fallback_provider_specific_settings?: Record<string, any> | null;
    voice_profile?: AgentVoiceProfile | null;
    auto_compact_settings?: AgentAutoCompactSettings | null;
  }

  interface ZipPayloadBody {
    zip_agent_control_enabled?: boolean | null;
    zip_ai_view_mode?: "inline" | "appended" | null;
    zip_tool_notes_enabled?: boolean | null;
    buffer_size: number | null;
    buffer_size_image: number | null;
    buffer_size_error: number | null;
    buffer_size_subagent: number | null;
    buffer_size_read_file: number | null;
    buffer_size_write_file: number | null;
    buffer_size_edit_file: number | null;
    buffer_size_execute_command: number | null;
    buffer_size_list_files: number | null;
    buffer_size_all_other_tools: number | null;
    zip_threshold_error: number | null;
    zip_threshold_image: number | null;
    zip_threshold_subagent: number | null;
    zip_threshold_read_file: number | null;
    zip_threshold_write_file: number | null;
    zip_threshold_edit_file: number | null;
    zip_threshold_execute_command: number | null;
    zip_threshold_list_files: number | null;
    zip_threshold_all_other_tools: number | null;
    auto_zip_error?: boolean | null;
    auto_zip_image?: boolean | null;
    auto_zip_subagent?: boolean | null;
    auto_zip_read_file?: boolean | null;
    auto_zip_write_file?: boolean | null;
    auto_zip_edit_file?: boolean | null;
    auto_zip_execute_command?: boolean | null;
    auto_zip_list_files?: boolean | null;
    auto_zip_all_other_tools?: boolean | null;
    zip_disabled_error?: boolean | null;
    zip_disabled_image?: boolean | null;
    zip_disabled_subagent?: boolean | null;
    zip_disabled_read_file?: boolean | null;
    zip_disabled_write_file?: boolean | null;
    zip_disabled_edit_file?: boolean | null;
    zip_disabled_execute_command?: boolean | null;
    zip_disabled_list_files?: boolean | null;
    zip_disabled_all_other_tools?: boolean | null;
    custom_tool_settings?: Array<{
      tool_name: string;
      buffer_size?: number;
      zip_threshold?: number;
      auto_zip?: boolean;
      zip_disabled?: boolean;
    }> | null;
  }

  interface McpPayloadBody {
    defaultMCPGateways: string[];
    defaultMCPToolSelections: MCPToolSelections;
    dcmDisplaySettings: AgentDcmDisplaySettings;
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
      const updated = await slashCommandStore.updateSlashCommand(command.id, {
        enabled_agent_ids: nextEnabledAgentIds,
        enabled_for_all_agents: false,
      });

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
            agent_access_scope: "selected",
            agent_allowlist: nextAllowlist,
          }
        : entry,
    );

    try {
      const updated = await artifactService.updateArtifact(artifact.id, {
        agent_access_scope: "selected",
        agent_allowlist: nextAllowlist,
      });

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
  let detailLoading = $state(false);
  let hydrationInProgress = $state(false);
  let lastAppliedInitialAgentId = $state<string | null>(null);
  let agentHydrationRequestId = 0;

  let basicForm = $state<BasicForm>(createDefaultBasicForm());

  $effect(() => {
    if (!basicForm.show_reasoning && basicForm.preserve_reasoning) {
      basicForm.preserve_reasoning = false;
    }
  });

  let basicPersistedSignature = $state<string | null>(null);
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

  // SA-017: `xhigh` reasoning effort is only allowed for compatible Codex models.
  $effect(() => {
    if (codexForm.reasoningEffort !== "xhigh") return;
    if (supportsCodexXhighReasoning(codexForm.model)) return;
    codexForm = { ...codexForm, reasoningEffort: "high" };
  });
  $effect(() => {
    if (codexForm.serviceTier !== "fast") return;
    if (supportsCodexFastMode(codexForm.model)) return;
    codexForm = { ...codexForm, serviceTier: "standard" };
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

  function getSandboxUnavailableMessage(backend: NativeExecutionBackend): string {
    if (backend === "apple_container") {
      return "Apple Container is not available. Apple-backed Bash runs will fail safely until Apple Container is installed and running.";
    }
    return "Docker Sandbox is not available. Docker-backed Bash runs will fail safely until Docker Sandbox is ready.";
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
    if (!isWebSearchProviderAvailable(normalized)) {
      return NATIVE_WEB_SEARCH_PROVIDER_INHERIT;
    }
    return normalized;
  }

  function getNativeWebSearchProviderLabel(
    value: NativeWebSearchProvider | typeof NATIVE_WEB_SEARCH_PROVIDER_INHERIT,
  ): string {
    if (value === NATIVE_WEB_SEARCH_PROVIDER_INHERIT) {
      return `Use Global Default (${NATIVE_WEB_SEARCH_PROVIDER_LABELS[getGlobalWebSearchProviderDefault()]})`;
    }
    return NATIVE_WEB_SEARCH_PROVIDER_LABELS[value];
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

  function clearInvalidWebSearchProviderOverrideIfNeeded() {
    const currentProvider = normalizeNativeWebSearchProvider(
      getNativeToolsSettings().webSearchProvider ??
        getNativeToolsSettings().nativeWebSearchProvider,
    );
    if (!currentProvider) return;
    if (isWebSearchProviderAvailable(currentProvider)) return;
    updateNativeToolSetting("webSearchProvider", null);
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

  interface SubagentForm {
    displayName: string;
    subagentType: StoredSubagentType;
    specialty: "general" | "n8n-specialist" | "claude-code" | "artifact";
    webhook_url: string;
    include_global_prompt: boolean;
    system_prompt: string;
    primary_model_provider: string;
    primary_model_name: string;
    avatar: string | null;
    avatar_icon_ref: IconRef;
    avatar_icon_fit: AvatarIconFit;
    provider_specific_settings: Record<string, any> | null;
  }

  type LiveSubagentUpdate = Partial<Omit<SubagentRow, "subagentType">> & {
    subagentType?: SubagentType;
  };

  let subagentForm = $state<SubagentForm>({
    displayName: "",
    subagentType: "n8n-workflow",
    specialty: "general",
    webhook_url: "",
    include_global_prompt: false,
    system_prompt: "",
    primary_model_provider: "",
    primary_model_name: "",
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
  let subagentDetailLoading = $state(false);
  let subagentEditSaveState = $state<SaveState>("idle");
  let subagentEditSaveError = $state<string | null>(null);
  let subagentEditLastSaved = $state<Date | null>(null);
  let subagentSaveScope = $state<SubagentSaveScope>("core");
  let subagentValidationError = $state<string | null>(null);
  let subagentAvatarUploading = $state(false);
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
    if (!selectedAgentId) return;
    const current = agents.find((agent) => agent.id === selectedAgentId);
    const label = current?.displayName?.trim() || "this Primary Agent";
    const confirmed = await confirmDialog({
      title: `Delete ${label}?`,
      description:
        "This permanently removes the agent's settings, model defaults, zip overrides, and tool assignments. Chat history is preserved.",
      confirmLabel: "Delete Primary Agent",
      tone: "destructive",
    });
    if (!confirmed) {
      return;
    }

    agentDeleteState = "deleting";
    agentDeleteError = null;

    try {
      const response = await fetch(`/api/agents/${selectedAgentId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to delete agent",
        );
        throw new Error(message);
      }

      toast.success(`Primary Agent "${label}" deleted`);
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
    if (!selectedEditableSubagentId) return;
    const targetId = selectedEditableSubagentId;
    const label = subagentForm.displayName?.trim() || "this Subagent";
    const confirmed = await confirmDialog({
      title: `Delete ${label}?`,
      description:
        "It will be unassigned from every Primary Agent and its settings will be removed. Chat history stays intact.",
      confirmLabel: "Delete Subagent",
      tone: "destructive",
    });
    if (!confirmed) {
      return;
    }

    subagentDeleteState = "deleting";
    subagentDeleteError = null;

    try {
      await subagentStore.delete(targetId);
      toast.success(`Subagent "${label}" deleted`);

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
            avatar: null,
            avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
            avatar_icon_fit: "fill",
            provider_specific_settings: null,
          };
          subagentPersistedSignature = null;
          subagentDefaultMCPGateways = [];
          subagentDefaultMCPToolSelections = [];
          subagentDefaultCliToolIds = [];
          subagentCliToolIdsExplicit = false;
          subagentDcmDisplaySettings = createDefaultDcmDisplaySettings();
          subagentMcpPersistedSignature = null;
          subagentCodexForm = createDefaultCodexForm();
          subagentCodexPersistedSignature = null;
          subagentCodexSaveState = "idle";
          subagentCodexSaveError = null;
          subagentCodexLastSaved = null;
          subagentClaudeForm = createDefaultClaudeForm();
          subagentClaudePersistedSignature = null;
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
          avatar: null,
          avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
          avatar_icon_fit: "fill",
          provider_specific_settings: null,
        };
        subagentPersistedSignature = null;
        subagentDefaultMCPGateways = [];
        subagentDefaultMCPToolSelections = [];
        subagentDefaultCliToolIds = [];
        subagentCliToolIdsExplicit = false;
        subagentDcmDisplaySettings = createDefaultDcmDisplaySettings();
        subagentMcpPersistedSignature = null;
        subagentCodexForm = createDefaultCodexForm();
        subagentCodexPersistedSignature = null;
        subagentCodexSaveState = "idle";
        subagentCodexSaveError = null;
        subagentCodexLastSaved = null;
        subagentClaudeForm = createDefaultClaudeForm();
        subagentClaudePersistedSignature = null;
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

      untrack(() => {
        subagentForm = normaliseSubagentForm(current);
        subagentPersistedSignature = signature;
        subagentCodexForm = normaliseCodexForm(current, "subagent");
        subagentCodexPersistedSignature = makeCodexSignature(subagentCodexForm, "subagent");
        subagentCodexSaveState = "idle";
        subagentCodexSaveError = null;
        subagentCodexLastSaved = null;
        subagentClaudeForm = normaliseClaudeForm(current, "subagent");
        subagentClaudePersistedSignature = makeClaudeSignature(subagentClaudeForm);
        subagentClaudeSaveState = "idle";
        subagentClaudeSaveError = null;
        subagentClaudeLastSaved = null;
      });
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

  async function hydrateAgent(agentId: string) {
    const requestId = ++agentHydrationRequestId;
    detailLoading = true;
    hydrationInProgress = true;
    basicSaveError = null;
    zipSaveError = null;
    assignmentSaveError = null;
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

      const currentSubagents = await fetchAgentSubagents(agentId);
      if (requestId !== agentHydrationRequestId || selectedAgentId !== agentId) {
        return;
      }

      untrack(() => {
        agents = agents.map((existing) =>
          existing.id === agent.id ? agent : existing,
        );
        agentStore.updateAgent(agent.id, mapToStoreAgent(agent));

        basicForm = normaliseBasicForm(agent);
        basicPersistedSignature = makeBasicSignature(basicForm);
        lastInvalidAgentSignature = null;
        syncSelectedModelFromAgent();

        promptValue = agent.system_prompt ?? "";
        promptPersistedSignature = promptValue;

        zipForm = normaliseZipForm(agent);
        zipPersistedSignature = makeZipSignature(zipForm);
        syncCustomToolOverridesFromGlobal();

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
        mcpRenderNonce = mcpRenderNonce + 1;

        codexForm = normaliseCodexForm(agent, "agent");
        codexPersistedSignature = makeCodexSignature(codexForm, "agent");
        codexSaveState = "idle";
        codexSaveError = null;
        codexLastSaved = null;

        claudeForm = normaliseClaudeForm(agent, "agent");
        claudePersistedSignature = makeClaudeSignature(claudeForm);
        claudeSaveState = "idle";
        claudeSaveError = null;
        claudeLastSaved = null;

        selectedSubagentIds = [...currentSubagents];
        assignmentPersistedSignature = makeSubagentSignature(currentSubagents);
        lastInvalidSubagentSignature = null;
      });

      if (hasLoadedWebSearchProviderAvailability) {
        clearInvalidWebSearchProviderOverrideIfNeeded();
      }
    } catch (error) {
      console.error("Failed to hydrate agent:", error);
      if (requestId !== agentHydrationRequestId || selectedAgentId !== agentId) {
        return;
      }
      untrack(() => {
        resetAgentDetailState();
      });
      toast.error(
        error instanceof Error ? error.message : "Failed to load agent details",
      );
    } finally {
      if (requestId !== agentHydrationRequestId) {
        return;
      }
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
      clearInvalidWebSearchProviderOverrideIfNeeded();
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

  $effect(() => {
    if (!isManagedPrimaryAgentType(basicForm.agentType)) return;
    void loadModelConnectionOptionsForPanel();
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

    if (match) {
      const availability = getModelPresetAvailability({
        model: match,
        agentType: basicForm.agentType,
        connectionOptions: modelConnectionOptions,
      });
      if (
        availability.disabled &&
        availability.disabledBecause !== "locked"
      ) {
        clearAgentModelSelection();
        return;
      }
    }

    selectedModelId = match ? match.id : null;
  }

  function applySavedModelToBasicForm(model: SavedModel) {
    const settings = model.settings ?? {};
    const hasSettings = settings && Object.keys(settings).length > 0;

    basicForm = {
      ...basicForm,
      primary_model_preset_id: model.id,
      primary_model_connection: resolveSavedModelConnection(model),
      primary_model_provider: model.provider,
      primary_model_name: model.effectiveModelId ?? model.modelId,
      provider_specific_settings: hasSettings ? settings : null,
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
    };
  }

  function syncSelectedModelFromSubagent() {
    if (!selectedEditableSubagentId || !savedModels.length) {
      selectedSubagentModelId = null;
      return;
    }

    const match = savedModels.find(
      (model) =>
        model.provider === subagentForm.primary_model_provider &&
        (model.modelId === subagentForm.primary_model_name ||
          model.effectiveModelId === subagentForm.primary_model_name),
    );

    if (match) {
      const availability = getModelPresetAvailability({
        model: match,
        agentType: getSubagentToolHostScope(subagentForm.subagentType),
        connectionOptions: null,
      });
      if (availability.disabled) {
        clearSubagentModelSelection();
        return;
      }
    }

    selectedSubagentModelId = match ? match.id : null;
  }

  function handleSubagentModelChange(
    value: string | string[] | null | undefined,
  ) {
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
    };
    seedCliSubagentFormsFromSavedModel(model);
  }

  function handleAgentModelChange(value: string | string[] | null | undefined) {
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
    };
  }

  async function handleAgentAvatarUpload(event: Event) {
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

    if (!selectedAgentId) {
      agentAvatarError = "Select an agent before uploading an avatar";
      if (input) input.value = "";
      return;
    }

    isUploadingAgentAvatar = true;
    agentAvatarError = null;

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("entityType", "agent");
      formData.append("entityId", selectedAgentId);
      if (basicForm.avatar_url) {
        formData.append("oldAvatarUrl", basicForm.avatar_url);
      }

      const uploadResponse = await fetch("/api/uploads/avatar", {
        method: "POST",
        body: formData,
      });

      if (!uploadResponse.ok) {
        const message = await extractError(
          uploadResponse,
          "Failed to upload avatar",
        );
        throw new Error(message);
      }

      const result = await uploadResponse.json();
      const url = result?.url ?? "";
      if (!url) {
        throw new Error("Upload succeeded but no avatar URL was returned");
      }

      basicForm = {
        ...basicForm,
        avatar_url: url,
      };
    } catch (error) {
      console.error("Agent avatar upload failed:", error);
      agentAvatarError =
        error instanceof Error ? error.message : "Failed to upload avatar";
    } finally {
      isUploadingAgentAvatar = false;
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
    basicForm = {
      ...basicForm,
      avatar_url: null,
      avatar_icon_ref: iconRef,
      avatar_icon_fit: "fill",
    };
  }

  async function handleSubagentAvatarUpload(event: Event) {
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

    if (!selectedEditableSubagentId) {
      subagentAvatarError = "Select a subagent before uploading an avatar";
      if (input) input.value = "";
      return;
    }

    subagentAvatarUploading = true;
    subagentAvatarError = null;

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("entityType", "subagent");
      formData.append("entityId", selectedEditableSubagentId);
      if (subagentForm.avatar) {
        formData.append("oldAvatarUrl", subagentForm.avatar);
      }

      const uploadResponse = await fetch("/api/uploads/avatar", {
        method: "POST",
        body: formData,
      });

      if (!uploadResponse.ok) {
        const message = await extractError(
          uploadResponse,
          "Failed to upload avatar",
        );
        throw new Error(message);
      }

      const result = await uploadResponse.json();
      const url = result?.url ?? "";
      if (!url) {
        throw new Error("Upload succeeded but no avatar URL was returned");
      }

      subagentForm = {
        ...subagentForm,
        avatar: url,
      };
    } catch (error) {
      console.error("Subagent avatar upload failed:", error);
      subagentAvatarError =
        error instanceof Error ? error.message : "Failed to upload avatar";
    } finally {
      subagentAvatarUploading = false;
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
      zip_agent_control_enabled: ZIP_PERMISSION_INHERIT,
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
    basicForm = createDefaultBasicForm();
    basicPersistedSignature = null;
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
    mcpSaveState = "idle";
    mcpSaveError = null;
    mcpLastSaved = null;
    mcpRenderNonce += 1;
    codexForm = createDefaultCodexForm();
    codexPersistedSignature = null;
    codexSaveState = "idle";
    codexSaveError = null;
    codexLastSaved = null;
    codexDirDraft = "";
    codexEnableDraft = "";
    codexDisableDraft = "";
    claudeForm = createDefaultClaudeForm();
    claudePersistedSignature = null;
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
    const legacyPermission =
      agent.zip_control_mode === "agent"
        ? "enabled"
        : agent.zip_control_mode === "user"
          ? "disabled"
          : ZIP_PERMISSION_INHERIT;
    const permissionValue =
      typeof agent.zip_agent_control_enabled === "boolean"
        ? agent.zip_agent_control_enabled
          ? "enabled"
          : "disabled"
        : legacyPermission;
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
      zip_agent_control_enabled: permissionValue,
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
      avatar: subagent.avatar ?? null,
      avatar_icon_ref: normalizeIconRef(subagent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF),
      avatar_icon_fit: normalizeAvatarIconFit(subagent.avatar_icon_fit),
      provider_specific_settings: subagent.provider_specific_settings ?? null,
    };
  }

  async function persistBasic(
    payload: { id: string; body: BasicPayloadBody },
    nextForm: BasicForm = basicForm,
  ) {
    try {
      const response = await fetch(`/api/agents/${payload.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload.body),
      });

      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to save agent settings",
        );
        throw new Error(message);
      }

      untrack(() => {
        if (selectedAgentId === payload.id) {
          basicForm = nextForm;
          basicPersistedSignature = makeBasicSignature(nextForm);
          lastInvalidAgentSignature = null;
          basicSaveState = "saved";
          basicSaveError = null;
          basicLastSaved = new Date();
        }
        updateAgentCollections(payload.id, {
          ...payload.body,
          displayName: payload.body.displayName,
          webhookUrl: payload.body.webhookUrl,
          model: payload.body.primary_model_name,
        } as Partial<AgentRow>);
      });
    } catch (error) {
      console.error("Failed to save agent settings:", error);
      untrack(() => {
        if (selectedAgentId === payload.id) {
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

  const saveBasic = debounce(
    (payload: { id: string; body: BasicPayloadBody; nextForm: BasicForm }) => {
      void persistBasic(payload, payload.nextForm);
    },
    BASIC_SAVE_DEBOUNCE_MS,
  );

  async function persistPrompt(
    payload: { id: string; system_prompt: string },
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
        if (selectedAgentId === payload.id) {
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

  const saveZipSettings = debounce(
    async (payload: { id: string; body: ZipPayloadBody; signature: string }) => {
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
          if (selectedAgentId === payload.id) {
            zipPersistedSignature = payload.signature;
            zipSaveState = "saved";
            zipSaveError = null;
            zipLastSaved = new Date();
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

  const saveMcpSettings = debounce(
    async (payload: { id: string; body: McpPayloadBody; signature: string }) => {
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
          if (selectedAgentId === payload.id) {
            mcpPersistedSignature = payload.signature;
            mcpSaveState = "saved";
            mcpSaveError = null;
            mcpLastSaved = new Date();
          }
          updateAgentCollections(payload.id, {
            defaultMCPGateways: payload.body.defaultMCPGateways,
            defaultMCPToolSelections: payload.body.defaultMCPToolSelections,
            dcmDisplaySettings: payload.body.dcmDisplaySettings,
          });
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

  const saveCliToolSettings = debounce(
    async (payload: { id: string; body: { defaultTools: string[] | null } }) => {
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
          if (selectedAgentId === payload.id) {
            mcpSaveState = "saved";
            mcpSaveError = null;
            mcpLastSaved = new Date();
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

  const saveSubagentMcpSettings = debounce(
    async (payload: { id: string; body: McpPayloadBody }) => {
      try {
        await persistSubagentDetails(payload);
        untrack(() => {
          subagentMcpPersistedSignature = makeMcpSignature(
            payload.body.defaultMCPGateways,
            payload.body.defaultMCPToolSelections,
            payload.body.dcmDisplaySettings,
          );
        });
      } catch (error) {
        console.error("Failed to save subagent MCP settings:", error);
      }
    },
    MCP_SAVE_DEBOUNCE_MS,
  );

  const saveSubagentCliToolSettings = debounce(
    async (payload: { id: string; body: { defaultTools: string[] | null } }) => {
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

  const saveCodexSettings = debounce(
    async (payload: {
      id: string;
      body: { codex_settings: CodexAgentSettings };
      signature: string;
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
          if (selectedAgentId === payload.id) {
            codexPersistedSignature = payload.signature;
            codexSaveState = "saved";
            codexSaveError = null;
            codexLastSaved = new Date();
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

  const saveClaudeSettings = debounce(
    async (payload: {
      id: string;
      body: { claude_settings: ClaudeAgentSettings };
      signature: string;
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
          if (selectedAgentId === payload.id) {
            claudePersistedSignature = payload.signature;
            claudeSaveState = "saved";
            claudeSaveError = null;
            claudeLastSaved = new Date();
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

  const saveSubagentCodexSettings = debounce(
    async (payload: { id: string; body: { codex_settings: CodexAgentSettings } }) => {
      try {
        await persistSubagentDetails(payload);
        untrack(() => {
          subagentCodexPersistedSignature = makeCodexSignature(subagentCodexForm, "subagent");
          subagentCodexSaveState = "saved";
          subagentCodexSaveError = null;
          subagentCodexLastSaved = new Date();
        });
      } catch (error) {
        console.error("Failed to save subagent Codex settings:", error);
        untrack(() => {
          subagentCodexSaveState = "idle";
          subagentCodexSaveError =
            error instanceof Error
              ? error.message
              : "Failed to save subagent Codex settings";
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

  const saveSubagentClaudeSettings = debounce(
    async (payload: { id: string; body: { claude_settings: ClaudeAgentSettings } }) => {
      try {
        await persistSubagentDetails(payload);
        untrack(() => {
          subagentClaudePersistedSignature = makeClaudeSignature(subagentClaudeForm);
          subagentClaudeSaveState = "saved";
          subagentClaudeSaveError = null;
          subagentClaudeLastSaved = new Date();
        });
      } catch (error) {
        console.error("Failed to save subagent Claude settings:", error);
        untrack(() => {
          subagentClaudeSaveState = "idle";
          subagentClaudeSaveError =
            error instanceof Error
              ? error.message
              : "Failed to save subagent Claude settings";
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

  const saveSubagentAssignments = debounce(
    async (payload: { id: string; subagentIds: string[]; signature: string }) => {
      try {
        await subagentStore.updateAgentSubagents(
          payload.id,
          payload.subagentIds,
        );
        untrack(() => {
          if (selectedAgentId === payload.id) {
            assignmentPersistedSignature = payload.signature;
            assignmentSaveState = "saved";
            assignmentSaveError = null;
            assignmentLastSaved = new Date();
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

  async function persistSubagentDetails(
    payload: { id: string; body: LiveSubagentUpdate },
    nextForm: SubagentForm = subagentForm,
  ) {
    try {
      await subagentStore.update(payload.id, payload.body);
      untrack(() => {
        subagentForm = nextForm;
        subagentPersistedSignature = makeSubagentFormSignature(nextForm);
        lastInvalidSubagentSignature = null;
        subagentEditSaveState = "saved";
        subagentEditSaveError = null;
        subagentEditLastSaved = new Date();
      });
    } catch (error) {
      console.error("Failed to save subagent:", error);
      untrack(() => {
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

  const saveSubagentDetails = debounce(
    (payload: { id: string; body: LiveSubagentUpdate }) => {
      void persistSubagentDetails(payload);
    },
    700,
  );

  $effect(() => {
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    const signature = makeBasicSignature(basicForm);
    if (
      !basicPersistedSignature ||
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
    basicSaveState = "saving";
    basicSaveError = null;

    const nextForm = cloneBasicForm(basicForm);
    saveBasic({
      id: selectedAgentId,
      body: buildBasicPayload(nextForm),
      nextForm,
    });
  });

  $effect(() => {
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    if (!isCodexProvider) return;
    const signature = makeCodexSignature(codexForm, "agent");
    if (!codexPersistedSignature || signature === codexPersistedSignature) return;
    codexSaveState = "saving";
    codexSaveError = null;
    saveCodexSettings({
      id: selectedAgentId,
      body: { codex_settings: serializeCodexForm(codexForm, "agent") },
      signature,
    });
  });

  $effect(() => {
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    if (!isClaudeCliProvider) return;
    const signature = makeClaudeSignature(claudeForm);
    if (!claudePersistedSignature || signature === claudePersistedSignature) return;
    claudeSaveState = "saving";
    claudeSaveError = null;
    saveClaudeSettings({
      id: selectedAgentId,
      body: { claude_settings: serializeClaudeForm(claudeForm) },
      signature,
    });
  });

  $effect(() => {
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
    if (signature === subagentCodexPersistedSignature) return;
    subagentCodexSaveState = "saving";
    subagentCodexSaveError = null;
    saveSubagentCodexSettings({
      id: selectedEditableSubagentId,
      body: { codex_settings: serializeCodexForm(subagentCodexForm, "subagent") },
    });
  });

  $effect(() => {
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
    if (signature === subagentClaudePersistedSignature) return;
    subagentClaudeSaveState = "saving";
    subagentClaudeSaveError = null;
    saveSubagentClaudeSettings({
      id: selectedEditableSubagentId,
      body: { claude_settings: serializeClaudeForm(subagentClaudeForm) },
    });
  });

  $effect(() => {
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

    zipSaveState = "saving";
    zipSaveError = null;

    const payload = buildZipPayload(zipForm);
    saveZipSettings({ id: selectedAgentId, body: payload, signature });
  });

  $effect(() => {
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

    mcpSaveState = "saving";
    mcpSaveError = null;
    const payload = buildMcpPayload(
      defaultMCPGateways,
      defaultMCPToolSelections,
      dcmDisplaySettings,
    );
    saveMcpSettings({ id: selectedAgentId, body: payload, signature });
  });

  $effect(() => {
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

    subagentEditSaveState = "saving";
    subagentEditSaveError = null;
    const payload = buildMcpPayload(
      subagentDefaultMCPGateways,
      subagentDefaultMCPToolSelections,
      subagentDcmDisplaySettings,
    );
    saveSubagentMcpSettings({ id: selectedEditableSubagentId, body: payload });
  });

  $effect(() => {
    if (!selectedAgentId || listLoading || detailLoading || hydrationInProgress)
      return;
    const signature = makeSubagentSignature(selectedSubagentIds);
    if (
      !assignmentPersistedSignature ||
      signature === assignmentPersistedSignature
    ) {
      return;
    }

    assignmentSaveState = "saving";
    assignmentSaveError = null;
    saveSubagentAssignments({
      id: selectedAgentId,
      subagentIds: [...selectedSubagentIds],
      signature,
    });
  });

  $effect(() => {
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
    subagentEditSaveState = "saving";
    subagentEditSaveError = null;

    saveSubagentDetails({
      id: selectedEditableSubagentId,
      body: buildSubagentPayload(subagentForm),
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

    const nextId = match ? match.id : null;

    if (selectedModelId !== nextId) {
      selectedModelId = nextId;
    }
  });

  $effect(() => {
    const provider = subagentForm.primary_model_provider;
    const modelId = subagentForm.primary_model_name;
    savedModels;
    const match = savedModels.find(
      (model) => model.provider === provider && model.modelId === modelId,
    );
    const nextId = match ? match.id : null;
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
    return null;
  }

  function formatZipLabel(key: string) {
    return key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function handleSubagentToggle(id: string, checked: boolean) {
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
    createEntityMode = false;
    activeAgentSettingsTab = "core";
    activeSubagentSettingsTab = "core";
    untrack(() => {
      selectedEntity = { kind: "subagent", id };
    });
    selectEditableSubagent(id);
  }

  function selectEditableSubagent(id: string) {
    if (createEntityMode) return;
    const match = subagents.find((item) => item.id === id);
    if (!match) return;

    subagentDetailLoading = true;

    const normalisedSubagentForm = normaliseSubagentForm(match);
    const normalisedCodexForm = normaliseCodexForm(match, "subagent");
    const normalisedClaudeForm = normaliseClaudeForm(match, "subagent");

    untrack(() => {
      const mcpDefaults = normaliseSubagentMcpDefaults(match);
      selectedEditableSubagentId = id;
      selectedEntity = { kind: "subagent", id };
      createEntityMode = false;
      activeSubagentSettingsTab = "core";
      subagentForm = normalisedSubagentForm;
      subagentPersistedSignature = makeSubagentFormSignature(normalisedSubagentForm);
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
      subagentMcpRenderNonce += 1;
      subagentCodexForm = normalisedCodexForm;
      subagentCodexPersistedSignature = makeCodexSignature(normalisedCodexForm, "subagent");
      subagentCodexSaveState = "idle";
      subagentCodexSaveError = null;
      subagentCodexLastSaved = null;
      subagentClaudeForm = normalisedClaudeForm;
      subagentClaudePersistedSignature = makeClaudeSignature(normalisedClaudeForm);
      subagentClaudeSaveState = "idle";
      subagentClaudeSaveError = null;
      subagentClaudeLastSaved = null;
      subagentValidationError = null;
      subagentAvatarError = null;
      selectedSubagentModelId = null;
      lastInvalidSubagentSignature = null;
    });

    syncSelectedModelFromSubagent();
    subagentDetailLoading = false;
  }

  function resetZipOverrides() {
    if (!selectedAgentId) return;
    const nextForm: ZipForm = {
      ...zipForm,
      zip_agent_control_enabled: ZIP_PERMISSION_INHERIT,
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
    defaultMCPGateways = [...gateways];
  }

  function handleMcpDcmDisplaySettingsChange(settings: AgentDcmDisplaySettings) {
    dcmDisplaySettings = cloneDcmDisplaySettings(settings);
  }

  function clearMcpDefaults(showToast = true) {
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
      });
    }
    if (showToast) {
      toast.success("Reset Tool Grid to global settings");
    }
  }

  function resetToolGridToGlobalSettings() {
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
      // Clear any legacy fallback-model config without keeping the dead settings lane.
      fallback_model_enabled: false,
      fallback_model_provider: null,
      fallback_model_name: null,
      fallback_model_preset_id: null,
      fallback_model_connection: null,
      fallback_model_temperature: null,
      fallback_model_max_tokens: null,
      fallback_model_top_p: null,
      fallback_model_top_k: null,
      fallback_model_frequency_penalty: null,
      fallback_model_presence_penalty: null,
      fallback_model_seed: null,
      fallback_model_stop_sequences: null,
      fallback_model_reasoning_effort: null,
      fallback_model_capabilities: null,
      fallback_provider_specific_settings: null,
      voice_profile: buildVoiceProfilePayload(form.voice_profile),
    };
  }

  async function saveAgentPromptFromEditor(nextPrompt: string) {
    const agentId = requireHydratedAgentDetail(
      selectedAgentId,
      promptPersistedSignature,
      "the agent prompt",
    );
    basicSaveScope = "instructions";
    await persistPrompt({ id: agentId, system_prompt: nextPrompt }, nextPrompt);
  }

  async function saveBasicMultilineEditor(
    scope: BasicSaveScope,
    mutator: (current: BasicForm) => BasicForm,
  ) {
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

    basicSaveScope = scope;
    basicSaveState = "saving";
    basicSaveError = null;
    await persistBasic(
      { id: agentId, body: buildBasicPayload(nextForm) },
      nextForm,
    );
  }

  async function saveSubagentMultilineEditor(
    scope: SubagentSaveScope,
    mutator: (current: SubagentForm) => SubagentForm,
  ) {
    if (!selectedEditableSubagentId) return;
    const nextForm = mutator(subagentForm);
    const validation = validateSubagentForm(nextForm);
    subagentValidationError = validation;
    if (validation) {
      throw new Error(validation);
    }

    subagentSaveScope = scope;
    subagentEditSaveState = "saving";
    subagentEditSaveError = null;
    await persistSubagentDetails(
      { id: selectedEditableSubagentId, body: buildSubagentPayload(nextForm) },
      nextForm,
    );
  }

  function makeZipSignature(form: ZipForm) {
    return JSON.stringify(buildZipPayload(form));
  }

  function makeSubagentSignature(ids: string[]) {
    return JSON.stringify([...ids].sort());
  }

  function makeSubagentFormSignature(form: SubagentForm) {
    return JSON.stringify({
      displayName: form.displayName.trim(),
      subagentType: form.subagentType,
      specialty: form.specialty,
      webhook_url: form.webhook_url.trim(),
      include_global_prompt: form.include_global_prompt,
      system_prompt: form.system_prompt.trim(),
      primary_model_provider: form.primary_model_provider,
      primary_model_name: form.primary_model_name,
      avatar: form.avatar ?? "",
      avatar_icon_ref: iconRefKey(form.avatar_icon_ref),
      avatar_icon_fit: form.avatar_icon_fit,
      provider_specific_settings: form.provider_specific_settings ?? null,
    });
  }

  function buildSubagentPayload(form: SubagentForm): LiveSubagentUpdate {
    if (form.subagentType === "n8n-subnode") {
      throw new Error(
        "n8n Subnode Subagents were removed from Batshit. Delete this record from Agent Settings.",
      );
    }
    return {
      displayName: form.displayName.trim(),
      subagentType: form.subagentType,
      specialty: form.specialty,
      webhook_url:
        isWorkflowBackedSubagentType(form.subagentType)
          ? form.webhook_url.trim() || undefined
          : undefined,
      webhookUrl:
        isWorkflowBackedSubagentType(form.subagentType)
          ? form.webhook_url.trim() || undefined
          : undefined,
      include_global_prompt: form.include_global_prompt,
      system_prompt: form.system_prompt.trim() || undefined,
      primary_model_provider: form.primary_model_provider || undefined,
      primary_model_name: form.primary_model_name || undefined,
      avatar: form.avatar ?? null,
      avatar_icon_ref: form.avatar_icon_ref,
      avatar_icon_fit: form.avatar_icon_fit,
      provider_specific_settings: form.provider_specific_settings ?? undefined,
    };
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
    const zipPermission =
      form.zip_agent_control_enabled === "enabled"
        ? true
        : form.zip_agent_control_enabled === "disabled"
          ? false
          : null;
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
      zip_agent_control_enabled: zipPermission,
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
    });
  }

  function handleSubagentCliToolSelectionsChange(toolIds: string[]) {
    subagentDefaultCliToolIds = [...toolIds];
    subagentCliToolIdsExplicit = true;
    if (!selectedEditableSubagentId) return;
    subagentEditSaveState = "saving";
    subagentEditSaveError = null;
    saveSubagentCliToolSettings({
      id: selectedEditableSubagentId,
      body: {
        defaultTools: [...toolIds],
      },
    });
  }

  function handleSubagentMcpGatewaysChange(gateways: string[]) {
    subagentDefaultMCPGateways = [...gateways];
  }

  function handleSubagentMcpDcmDisplaySettingsChange(
    settings: AgentDcmDisplaySettings,
  ) {
    subagentDcmDisplaySettings = cloneDcmDisplaySettings(settings);
  }

  function clearSubagentMcpDefaults() {
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
      });
    }
    toast.success("Cleared Subagent Tool Grid defaults");
  }

  function zipPayloadToAgentUpdates(body: ZipPayloadBody): Partial<AgentRow> {
    const result: Partial<AgentRow> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "custom_tool_settings") {
        result.custom_tool_settings =
          (value as ZipPayloadBody["custom_tool_settings"]) ?? undefined;
      } else if (key === "zip_agent_control_enabled") {
        result.zip_agent_control_enabled =
          (value as AgentRow["zip_agent_control_enabled"]) ?? null;
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

  function handleZipAgentControlChange(value: string) {
    zipForm = { ...zipForm, zip_agent_control_enabled: value };
  }

  function handleZipAiViewModeChange(value: string) {
    zipForm = { ...zipForm, zip_ai_view_mode: value };
  }

  function handleZipToolNotesChange(value: string) {
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
      model: CODEX_SUBMODEL_CHOICES[0]?.value ?? "gpt-5",
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
    return sharedToolApprovalMode === "all" ? "on-failure" : "never";
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
    if (source?.sandbox) {
      options.sandbox = source.sandbox;
    }
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
    if (permission === "acceptEdits" || permission === "plan" || permission === "bypassPermissions") {
      options.permissionMode = permission;
    } else if (permission === "default" || permission === "chat" || permission === "agent") {
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
    if (scope === "subagent") {
      subagentCodexForm = updater(subagentCodexForm);
      return;
    }
    codexForm = updater(codexForm);
  }

  function updateClaudeForm(
    updater: (current: ClaudeFormOptions) => ClaudeFormOptions,
    scope: CliSettingsScope = "agent",
  ) {
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

  function hasClaudeToolEntry(list: string[], toolName: string) {
    const normalizedTool = toolName.trim().toLowerCase();
    return list.some((entry) => entry.trim().toLowerCase() === normalizedTool);
  }

  function getClaudeToolEnabled(toolName: string, scope: CliSettingsScope = "agent") {
    const form = scope === "subagent" ? subagentClaudeForm : claudeForm;
    if (form.allowedTools.length > 0) {
      return hasClaudeToolEntry(form.allowedTools, toolName);
    }
    return !hasClaudeToolEntry(form.disallowedTools, toolName);
  }

  function setClaudeToolEnabled(
    toolName: string,
    enabled: boolean,
    scope: CliSettingsScope = "agent",
  ) {
    const normalizedTool = toolName.trim();
    if (!normalizedTool) return;

    updateClaudeForm((current) => {
      const hasAllowedList = current.allowedTools.length > 0;
      const nextDisallowed = current.disallowedTools.filter(
        (entry) => entry.trim().toLowerCase() !== normalizedTool.toLowerCase(),
      );

      if (hasAllowedList) {
        const nextAllowed = enabled
          ? hasClaudeToolEntry(current.allowedTools, normalizedTool)
            ? current.allowedTools
            : [...current.allowedTools, normalizedTool]
          : current.allowedTools.filter(
              (entry) => entry.trim().toLowerCase() !== normalizedTool.toLowerCase(),
            );

        return {
          ...current,
          allowedTools: nextAllowed,
          disallowedTools: nextDisallowed,
        };
      }

      if (enabled) {
        return {
          ...current,
          disallowedTools: nextDisallowed,
        };
      }

      if (hasClaudeToolEntry(current.disallowedTools, normalizedTool)) {
        return current;
      }

      return {
        ...current,
        disallowedTools: [...current.disallowedTools, normalizedTool],
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

  function updateAgentCollections(id: string, updates: Partial<AgentRow>) {
    agents = agents.map((agent) =>
      agent.id === id ? { ...agent, ...updates } : agent,
    );
    const storeUpdates: Partial<AgentStoreRecord> = {
      ...(updates as Partial<AgentStoreRecord>),
    };
    if (
      "assigned_subagent_ids" in updates &&
      Array.isArray(updates.assigned_subagent_ids)
    ) {
      storeUpdates.assignedSubagents = updates.assigned_subagent_ids;
    }
    agentStore.updateAgent(id, storeUpdates);
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
                onGatewaysChange={handleMcpGatewaysChange}
                onDcmDisplaySettingsChange={handleMcpDcmDisplaySettingsChange}
                onCliToolIdsChange={handleCliToolSelectionsChange}
                getToolZipOverride={getMcpToolZipOverride}
                onToolZipOverrideChange={handleMcpToolZipOverrideChange}
                showZipControls={true}
                zipAgentControlEnabled={zipForm.zip_agent_control_enabled}
                zipAiViewMode={zipForm.zip_ai_view_mode}
                zipToolNotesEnabled={zipForm.zip_tool_notes_enabled}
                nonMcpZipRows={NON_MCP_ZIP_ROW_ORDER}
                getNonMcpZipOverride={getNonMcpZipOverrideById}
                onNonMcpZipOverrideChange={handleNonMcpZipOverrideChangeById}
                onZipAgentControlChange={handleZipAgentControlChange}
                onZipAiViewModeChange={handleZipAiViewModeChange}
                onZipToolNotesChange={handleZipToolNotesChange}
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
                                    onValueChange={(value) =>
                                      handleAgentModelChange(
                                        Array.isArray(value) ? value[0] : value,
                                      )}
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
                                  When enabled, Batshit streams reasoning summaries into chat in a collapsed section whenever the model provides them.
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
                                    When enabled, the reasoning summary is saved with the message in Redis and still appears after refresh. It is not added to later model requests. When disabled, it only appears during the live response.
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
                              onValueChange={(value: string) =>
                                (basicForm = {
                                  ...basicForm,
                                  goon_id: value === "none" ? null : value,
                                })}
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
                          onChange={(nextSettings) =>
                            (basicForm = {
                              ...basicForm,
                              auto_compact_settings: nextSettings,
                            })}
                        />

                        <AgentMemorySettingsCard
                          draft={basicForm.memory_settings}
                          {savedModels}
                          onChange={(nextDraft) =>
                            (basicForm = {
                              ...basicForm,
                              memory_settings: nextDraft,
                            })}
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
                        onValueChange={(value) => {
                          const nextValue = (Array.isArray(value) ? value[0] : value) as string;
                          updateClaudeForm((current) => ({
                            ...current,
                            model: nextValue === "default" ? "" : nextValue,
                          }));
                        }}
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
                      onCheckedChange={(checked) =>
                        updateClaudeForm((current) => ({
                          ...current,
                          alwaysThinkingEnabled: checked === true,
                          maxThinkingTokens:
                            checked === true
                              ? current.maxThinkingTokens.trim().length > 0
                                ? current.maxThinkingTokens
                                : String(CLAUDE_DEFAULT_MAX_THINKING_TOKENS)
                              : "",
                        }))} />
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
                      onValueChange={(value) => {
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
                      }}
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
                          onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            const normalized = normalizeNativeExecutionBackend(next) ?? getDefaultNativeExecutionBackend();
                            updateNativeToolSetting("executionBackend", normalized);
                          }}
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
                            {getSandboxUnavailableMessage(selectedSandboxBackend)}
                          </p>
                          {#if selectedSandboxStatus?.reason}
                            <p class="batshit-settings-form-help is-danger">{selectedSandboxStatus.reason}</p>
                          {/if}
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
                        onValueChange={(value) => {
                          const next = (Array.isArray(value) ? value[0] : value) as "off" | "all";
                          basicSaveScope = "permissions";
                          basicForm = {
                            ...basicForm,
                            tool_approval_mode: !toolApprovalEligible ? "off" : next,
                          };
                        }}
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
                          onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            const parsed = Number.parseInt(String(next ?? ""), 10);
                            updateNativeToolSetting(
                              "bashTimeoutMs",
                              Number.isFinite(parsed) ? parsed : 30_000,
                            );
                          }}
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
                        onValueChange={(value) =>
                          updateCodexForm((current) => ({
                            ...current,
                            model: Array.isArray(value)
                              ? (value[0] as string)
                              : (value as string),
                          }))}
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
                        onValueChange={(value) =>
                          updateCodexForm((current) => ({
                            ...current,
                            reasoningEffort: (Array.isArray(value)
                              ? value[0]
                              : value) as CodexFormOptions["reasoningEffort"],
                          }))}
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
                        onValueChange={(value) =>
                          updateCodexForm((current) => ({
                            ...current,
                            serviceTier: (Array.isArray(value)
                              ? value[0]
                              : value) as CodexServiceTier,
                          }))}
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
                  onValueChange={(value: string) =>
                    (basicForm = {
                      ...basicForm,
                      default_project_id: value === "none" ? null : value,
                    })}
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
                    onCheckedChange={(checked) =>
                      updateClaudeForm((current) => ({
                        ...current,
                        includeProjectInstructions: checked === true,
                      }))}
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
                    onCheckedChange={(checked) =>
                      updateClaudeForm((current) => ({
                        ...current,
                        includeCoreSystemPrompt: checked === true,
                        systemPromptMode: checked === true ? "default" : "replace",
                        systemPrompt:
                          checked === true ? "" : MODE4_PRELAUNCH_REPLACEMENT_PROMPT,
                        systemPromptFile: "",
                      }))}
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
                    onCheckedChange={(checked) =>
                      updateCodexForm((current) => ({
                        ...current,
                        includeProjectInstructions: checked === true,
                      }))}
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
                    onValueChange={(value) => {
                      const next = Array.isArray(value) ? value[0] : value;
                      if (!next) return;
                      setClaudePermissionMode(next as ClaudePermissionMode);
                    }}
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
                            Claude only uses this in <span class="batshit-settings-inline-strong">Edit Automatically</span>.
                            Plan never prompts, and Bypass Permissions never asks.
                          </span>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={basicForm.tool_approval_mode}
                        onValueChange={(value) => {
                          const next = (Array.isArray(value) ? value[0] : value) as "off" | "all";
                          basicSaveScope = "approvals";
                          basicForm = {
                            ...basicForm,
                            tool_approval_mode: next,
                          };
                        }}
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
                  Controls how freely Codex can act when tools are enabled.
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
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        if (!next) return;
                        setCodexPermissionMode(next as CodexPermissionMode);
                      }}
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
                        onValueChange={(value) =>
                          updateCodexForm((current) => ({
                            ...current,
                            sandbox: (Array.isArray(value)
                              ? value[0]
                              : value) as CodexSandbox,
                          }))}
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
                            Chat and Agent (full) never prompt.
                          </span>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={basicForm.tool_approval_mode}
                        onValueChange={(value) => {
                          const next = (Array.isArray(value) ? value[0] : value) as "off" | "all";
                          basicSaveScope = "approvals";
                          basicForm = {
                            ...basicForm,
                            tool_approval_mode: next,
                          };
                        }}
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
                    onValueChange={(value: string) =>
                      (basicForm = {
                        ...basicForm,
                        default_project_id: value === "none" ? null : value,
                      })}
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
                    onCheckedChange={(checked) =>
                      updateClaudeForm((current) => ({
                        ...current,
                        chrome: checked === true,
                      }))}
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
                    onCheckedChange={(checked) => setClaudeToolEnabled("WebSearch", checked === true)}
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
                      onCheckedChange={(checked) =>
                        updateCodexForm((current) => ({
                          ...current,
                          search: checked === true,
                        }))}
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
                    onCheckedChange={(checked) =>
                      updateNativeToolSetting("bashEnabled", checked === true)}
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
                    onCheckedChange={(checked) =>
                      updateNativeToolSetting("dynamicMcpEnabled", checked === true)}
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
                    onCheckedChange={(checked) =>
                      updateNativeToolSetting("cliToolsEnabled", checked === true)}
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
                      onCheckedChange={(checked) =>
                        updateNativeToolSetting("artifactRuntimeEnabled", checked === true)}
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
                      onCheckedChange={(checked) =>
                        updateNativeToolSetting("batshitToolsEnabled", checked === true)}
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
                    onEnabledChange={(enabled) => updateNativeToolSetting("webSearchEnabled", enabled)}
                    onProviderValueChange={(next) => {
                      if (next === NATIVE_WEB_SEARCH_PROVIDER_INHERIT) {
                        updateNativeToolSetting("webSearchProvider", null);
                        return;
                      }
                      const provider = normalizeNativeWebSearchProvider(next);
                      updateNativeToolSetting("webSearchProvider", provider);
                    }}
                    onExaTypeValueChange={(next) => {
                      if (next === NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT) {
                        updateNativeToolSetting("webSearchExaType", null);
                        return;
                      }
                      const normalized = normalizeNativeExaSearchType(next);
                      updateNativeToolSetting("webSearchExaType", normalized);
                    }}
                    onPerplexityMaxTokensValueChange={(next) => {
                      if (next === NATIVE_WEB_SEARCH_PERPLEXITY_MAX_TOKENS_PER_PAGE_INHERIT) {
                        updateNativeToolSetting("webSearchPerplexityMaxTokensPerPage", null);
                        return;
                      }
                      const normalized = normalizePerplexityMaxTokensPerPage(next);
                      updateNativeToolSetting("webSearchPerplexityMaxTokensPerPage", normalized);
                    }}
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
                            onCheckedChange={(checked) => {
                              updateNativeToolSetting("agentBrowserEnabled", checked === true);
                              if (checked !== true) {
                                primaryAgentBrowserDefaultsOpen = false;
                              }
                            }}
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
                                onCheckedChange={(checked) =>
                                  updateNativeToolSetting("agentBrowserLiveViewEnabled", checked === true)}
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
                                  onValueChange={(value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserRuntimeMode(next) ?? "chromium";
                                    updateNativeToolSetting("agentBrowserRuntimeMode", normalized);
                                  }}
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
                                  onValueChange={(value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const parsed = Number.parseInt(String(next ?? ""), 10);
                                    updateNativeToolSetting(
                                      "agentBrowserTimeoutMs",
                                      Number.isFinite(parsed) ? parsed : DEFAULT_NATIVE_AGENT_BROWSER_TIMEOUT_MS,
                                    );
                                  }}
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
                                  onValueChange={(value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserProvider(next) ?? "local";
                                    updateNativeToolSetting("agentBrowserProvider", normalized);
                                  }}
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
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            sttProvider: next === VOICE_PROVIDER_INHERIT ? "" : next,
                            sttModel: "",
                          },
                        };
                      }}
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
                      onValueChange={(value) =>
                        (basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            sttModel: Array.isArray(value) ? value[0] : value,
                          },
                        })}
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
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            voiceSessionRuntime: next === "direct" || next === "livekit" ? next : "",
                          },
                        };
                      }}
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
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            voiceModeInputMode: next === "stt" || next === "text" ? next : "",
                          },
                        };
                      }}
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
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        if (next === "manual" && !agentManualTurnAvailable) return;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            voiceModeSubmitMode: next === "auto" || next === "manual" ? next : "",
                          },
                        };
                      }}
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
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            realtimeSttProvider: next === VOICE_PROVIDER_INHERIT ? "" : next,
                            realtimeSttModel: "",
                          },
                        };
                      }}
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
                      onValueChange={(value) =>
                        (basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            realtimeSttModel: Array.isArray(value) ? value[0] : value,
                          },
                        })}
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
                        onValueChange={(value) =>
                          handleVoiceProviderChange(Array.isArray(value) ? value[0] : value)}
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
                          onValueChange={(value) =>
                            (basicForm = {
                              ...basicForm,
                              voice_profile: {
                                ...basicForm.voice_profile,
                                model: Array.isArray(value) ? value[0] : value,
                              },
                            })}
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
                            onValueChange={(value) => {
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
                            }}
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
                      onValueChange={(value) => {
                        const next = Array.isArray(value) ? value[0] : value;
                        basicForm = {
                          ...basicForm,
                          voice_profile: {
                            ...basicForm.voice_profile,
                            ttsItalicNarrationBehavior:
                              next === "speak" || next === "silent" ? next : "",
                          },
                        };
                      }}
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
                : "Permanently removes this Primary Agent’s settings, zip overrides, MCP defaults, and avatar reference. Chat sessions remain stored.",
              "Subagent assignments and MCP selections are cleared during deletion."
            ]}
            error={agentDeleteError}
            busy={agentDeleteState === "deleting"}
            disabled={!selectedAgentId || agentDeleteState === "deleting"}
            onDelete={handleDeletePrimaryAgent}
          />
      </div>
      <!-- Primary Agent Settings End -->
    {:else if selectedEntity?.kind === "subagent" && selectedEditableSubagentId}
      <!-- Subagent Settings Start -->
      <div class="batshit-settings-surface space-y-6">
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
                  onGatewaysChange={handleSubagentMcpGatewaysChange}
                  onDcmDisplaySettingsChange={handleSubagentMcpDcmDisplaySettingsChange}
                  onCliToolIdsChange={handleSubagentCliToolSelectionsChange}
                  getToolZipOverride={getMcpToolZipOverride}
                  onToolZipOverrideChange={handleMcpToolZipOverrideChange}
                  showZipControls={false}
                  showZipModeControls={false}
                  showPostTableControls={false}
                  getNonMcpZipOverride={getNonMcpZipOverrideById}
                  onNonMcpZipOverrideChange={handleNonMcpZipOverrideChangeById}
                  onZipAgentControlChange={handleZipAgentControlChange}
                  onZipAiViewModeChange={handleZipAiViewModeChange}
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
                                    onValueChange={(value) =>
                                      handleSubagentModelChange(
                                        Array.isArray(value) ? value[0] : value,
                                      )}
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
                              {/if}
                            </div>
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
                            onValueChange={(value) => {
                              const nextValue = (Array.isArray(value) ? value[0] : value) as string;
                              updateClaudeForm((current) => ({
                                ...current,
                                model: nextValue === "default" ? "" : nextValue,
                              }), "subagent");
                            }}
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
                          onCheckedChange={(checked) =>
                            updateClaudeForm((current) => ({
                              ...current,
                              alwaysThinkingEnabled: checked === true,
                              maxThinkingTokens:
                                checked === true
                                  ? current.maxThinkingTokens.trim().length > 0
                                    ? current.maxThinkingTokens
                                    : String(CLAUDE_DEFAULT_MAX_THINKING_TOKENS)
                                  : "",
                            }), "subagent")} />
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
                            onValueChange={(value) =>
                              updateCodexForm((current) => ({
                                ...current,
                                model: Array.isArray(value)
                                  ? (value[0] as string)
                                  : (value as string),
                              }), "subagent")}
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
                            onValueChange={(value) =>
                              updateCodexForm((current) => ({
                                ...current,
                                reasoningEffort: (Array.isArray(value)
                                  ? value[0]
                                  : value) as CodexFormOptions["reasoningEffort"],
                              }), "subagent")}
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
                            onValueChange={(value) =>
                              updateCodexForm((current) => ({
                                ...current,
                                serviceTier: (Array.isArray(value)
                                  ? value[0]
                                  : value) as CodexServiceTier,
                              }), "subagent")}
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
                            onCheckedChange={(checked) =>
                              updateClaudeForm((current) => ({
                                ...current,
                                includeProjectInstructions: checked === true,
                              }), "subagent")}
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
                            onCheckedChange={(checked) =>
                              updateClaudeForm((current) => ({
                                ...current,
                                includeCoreSystemPrompt: checked === true,
                                systemPromptMode: checked === true ? "default" : "replace",
                                systemPrompt:
                                  checked === true ? "" : MODE4_PRELAUNCH_REPLACEMENT_PROMPT,
                                systemPromptFile: "",
                              }), "subagent")}
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
                            onCheckedChange={(checked) =>
                              updateCodexForm((current) => ({
                                ...current,
                                includeProjectInstructions: checked === true,
                              }), "subagent")}
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
                        onCheckedChange={(checked) =>
                          updateClaudeForm((current) => ({
                            ...current,
                            chrome: checked === true,
                          }), "subagent")}
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
                        onCheckedChange={(checked) =>
                          setClaudeToolEnabled("WebSearch", checked === true, "subagent")}
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
                          onCheckedChange={(checked) =>
                            updateCodexForm((current) => ({
                              ...current,
                              search: checked === true,
                            }), "subagent")}
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
                  onCheckedChange={(checked) =>
                    updateNativeToolSetting("bashEnabled", checked === true, "subagent")}
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
                  onCheckedChange={(checked) =>
                    updateNativeToolSetting("dynamicMcpEnabled", checked === true, "subagent")}
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
                  onCheckedChange={(checked) =>
                    updateNativeToolSetting("cliToolsEnabled", checked === true, "subagent")}
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
                    onCheckedChange={(checked) =>
                      updateNativeToolSetting("artifactRuntimeEnabled", checked === true, "subagent")}
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
                    onCheckedChange={(checked) =>
                      updateNativeToolSetting("batshitToolsEnabled", checked === true, "subagent")}
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
                    onEnabledChange={(enabled) =>
                      updateNativeToolSetting("webSearchEnabled", enabled, "subagent")}
                    onProviderValueChange={(next) => {
                      if (next === NATIVE_WEB_SEARCH_PROVIDER_INHERIT) {
                        updateNativeToolSetting("webSearchProvider", null, "subagent");
                        return;
                      }
                      const provider = normalizeNativeWebSearchProvider(next);
                      updateNativeToolSetting("webSearchProvider", provider, "subagent");
                    }}
                    onExaTypeValueChange={(next) => {
                      if (next === NATIVE_WEB_SEARCH_EXA_TYPE_INHERIT) {
                        updateNativeToolSetting("webSearchExaType", null, "subagent");
                        return;
                      }
                      const normalized = normalizeNativeExaSearchType(next);
                      updateNativeToolSetting("webSearchExaType", normalized, "subagent");
                    }}
                    onPerplexityMaxTokensValueChange={(next) => {
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
                    }}
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
                          onCheckedChange={(checked) => {
                            updateNativeToolSetting("agentBrowserEnabled", checked === true, "subagent");
                            if (checked !== true) {
                              subagentAgentBrowserDefaultsOpen = false;
                            }
                          }}
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
                                onCheckedChange={(checked) =>
                                  updateNativeToolSetting("agentBrowserLiveViewEnabled", checked === true, "subagent")}
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
                                  onValueChange={(value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserRuntimeMode(next) ?? "chromium";
                                    updateNativeToolSetting("agentBrowserRuntimeMode", normalized, "subagent");
                                  }}
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
                                  onValueChange={(value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const parsed = Number.parseInt(String(next ?? ""), 10);
                                    updateNativeToolSetting(
                                      "agentBrowserTimeoutMs",
                                      Number.isFinite(parsed) ? parsed : DEFAULT_NATIVE_AGENT_BROWSER_TIMEOUT_MS,
                                      "subagent",
                                    );
                                  }}
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
                                  onValueChange={(value) => {
                                    const next = Array.isArray(value) ? value[0] : value;
                                    const normalized = normalizeNativeAgentBrowserProvider(next) ?? "local";
                                    updateNativeToolSetting("agentBrowserProvider", normalized, "subagent");
                                  }}
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
                          onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (!next) return;
                            setClaudePermissionMode(next as ClaudePermissionMode, "subagent");
                          }}
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
                          Controls how freely Codex can act when tools are enabled.
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
                          onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            if (!next) return;
                            setCodexPermissionMode(next as CodexPermissionMode, "subagent");
                          }}
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
                              onValueChange={(value) =>
                                updateCodexForm((current) => ({
                                  ...current,
                                  sandbox: (Array.isArray(value)
                                    ? value[0]
                                    : value) as CodexSandbox,
                                }), "subagent")}
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
                      onValueChange={(value) => {
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
                      }}
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
                          onValueChange={(value) => {
                            const next = Array.isArray(value) ? value[0] : value;
                            const normalized = normalizeNativeExecutionBackend(next) ?? getDefaultNativeExecutionBackend();
                            updateNativeToolSetting("executionBackend", normalized, "subagent");
                          }}
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
                            {getSandboxUnavailableMessage(subagentSelectedSandboxBackend)}
                          </p>
                          {#if subagentSelectedSandboxStatus?.reason}
                            <p class="batshit-settings-form-help is-danger">{subagentSelectedSandboxStatus.reason}</p>
                          {/if}
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
                        onValueChange={(value) => {
                          const next = Array.isArray(value) ? value[0] : value;
                          const parsed = Number.parseInt(String(next ?? ""), 10);
                          updateNativeToolSetting(
                            "bashTimeoutMs",
                            Number.isFinite(parsed) ? parsed : 30_000,
                            "subagent",
                          );
                        }}
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
