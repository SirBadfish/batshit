<script lang="ts">
  import { resolveVoiceTtsDisplayEndpoint, resolveVoiceTtsDisplaySelection, voiceTtsModelStreams } from '$lib/utils/voiceTtsDisplay';
  import { mimoVoiceModelNotice } from '$lib/data/mimoVoiceProfiles';
  import { voiceModelApplicabilityNotice, voiceTranscriptionModelNotice } from '$lib/data/voiceModelApplicability';
  import { getQwenAudioTtsVoices, isQwenAudioTtsModel, parseQwenAudioEndpoint } from '$lib/data/qwenAudioTts';
  import { readVoiceProviderEnvelope } from '$lib/utils/voiceProviderEnvelope';
  import { voiceModelCatalogNotice, voiceProviderModelProfile } from '$lib/utils/builtinVoiceCatalogProjection';
import type { ToolGridEnableControl } from '$lib/components/tools/ToolGridEnableCell.svelte';
  import { TYPED_FILE_TOOLS_REVISION_HEADER, captureTypedFileToolsBaseline, typedFileToolsBodyValue,
    withExpectedTypedFileTools, withoutExpectedTypedFileTools, adoptTypedFileToolsAck,
    withTypedFileToolsChoice, withoutTypedFileToolsChoice, type TypedFileToolsBaseline } from "$lib/utils/typedFileToolsSave";
  import { performAvatarImport, uploadAvatarFile } from '$lib/appActions/imports/avatars'
  import type { ImportArgs, ImportOutcome } from '$lib/appActions/imports/contracts'
  import { refuse, type SettingsTarget } from '$lib/appActions/catalog'
  import { appActionsHaveDrafts, type ActionContext } from '$lib/appActions/owners'

  import { onDestroy, onMount, untrack } from "svelte";
  import { isExactSavedAccessAgentId, readArtifactAgentAccess } from "$lib/utils/agentAccessIds";
  import { createEntitySaverCount } from "$lib/utils/entitySaverCount";
  import { AGENT_MEMORY_GROUP, AGENT_SAVE_FIELD_GROUPS } from "$lib/utils/agentSettingsSavePatch";
  import { agentWritableConflictLabels, rebaseAgentWritableFields } from "$lib/utils/agentWritableFieldRebase";
  import { MODEL_SELECTION_REVISION_HEADER, MODEL_SELECTION_FIELDS, MODEL_SELECTION_IDENTITY_FIELDS, captureModelSelectionBaseline, isModelSelectionWrite, sameModelSelection, withModelSelection, type ModelSelectionBaseline, type ModelSelectionKind } from '$lib/appActions/settings/modelSelectionBaseline';
  import { CLAUDE_CLI_PRESET_REFUSAL, namesRetiredCodexCliModel } from '$lib/utils/cliRuntimeIdentity';
  import { INSTRUCTIONS_REVISION_HEADER, captureInstructionsBaseline, instructionsExpectedForWrites, namesInstructions, type InstructionsBaseline, type InstructionsRevisions } from '$lib/appActions/settings/instructionsBaseline';
  import { AUTO_COMPACT_COMMON_FIELDS, AUTO_COMPACT_REVISION_HEADER, captureAutoCompactBaseline, type AutoCompactBaseline } from '$lib/appActions/settings/autoCompactBaseline';
  import { CONFIGURED_TTS_REVISION_HEADER, captureConfiguredTtsBaseline, type ConfiguredTtsBaseline } from '$lib/appActions/settings/configuredTtsBaseline';
  import { buildPickedPresetSelection, buildClearedPresetSelection } from '$lib/utils/modelPresetPick';
  import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper';
  import { onUserChannelEvent, type UserChannelEvent } from "$lib/services/userChannel";
  import { SUBAGENT_SAVE_FIELD_GROUPS } from "$lib/utils/subagentSettingsSavePatch";
  import {
    buildDcmDisplaySettingsSignature,
    cloneDcmDisplaySettings,
    createDefaultDcmDisplaySettings
  } from "$lib/utils/dcmDisplaySettings";
  import { toast } from "$lib/components/ui/sonner/settings-toast";
  import * as agentStore from "$lib/stores/agents.svelte";
  import * as projectStore from "$lib/stores/projects.svelte";
  import { noteSavedDefaultProject } from "$lib/projects/agentProjectSelection.svelte";
  import { refreshAllDeadCopies } from "$lib/stores/zipDeadCopies.svelte";
  import ModelReasoningControl from '$lib/components/models/ModelReasoningControl.svelte';
  import { agentReasoningReadGeneration, captureAgentReasoningReads, preserveNewerReasoningLeaves } from '$lib/utils/agentReasoningReadGuard';
  import type { Agent as AgentStoreRecord } from "$lib/stores/agents.svelte";
  import { loadGoons } from "$lib/services/goons";
  import { getGoons } from "$lib/stores/goons.svelte";
  import { isGoonRuntimeReady } from "$lib/goons/recipe";
  import { subagentStore } from "$lib/stores/subagents.svelte";
  import { getUserSettings } from "$lib/stores/userSettings.svelte";
  import ReasoningRetentionFields from '$lib/components/settings/ReasoningRetentionFields.svelte';
  import type { AgentReasoningRetention } from '$lib/utils/reasoningRetention';
  import { confirmDialog, confirmDialogWithCheckbox } from "$lib/stores/confirmDialog";
  import { copyTextToClipboard } from "$lib/utils/clipboard";
  import { requestAvatarPictureTidy, shouldTidyAvatarPictures } from "$lib/utils/avatarPictureTidy";
  import { sandboxUnavailableMessage } from "$lib/utils/nativeExecutionBackend";
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
  import { Input } from "$lib/components/ui/input";
  import * as Label from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";
  import * as Switch from "$lib/components/ui/switch";
  import * as Select from "$lib/components/ui/select";
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
  findSettingsVoicePresetFallback,
  resolveModelVoiceSessionConfig
} from "$lib/utils/modelVoiceSession";
import * as savedModelsStore from "$lib/stores/savedModels.svelte";
import type { CatalogConnectionOption } from "$lib/types/modelCatalog";
import { getModelPresetAvailability, presetAvailabilityKeepsSelection } from "$lib/utils/modelPresetAvailability";
import { CLI_GROUP_KEY, captureCliDcmWrite, applyCliDcmPatch, readCliDcmPair, readCliNativeChoice } from "$lib/utils/cliToolGridEnable";
import type { AgentDcmDisplaySettingsSave } from "$lib/utils/agentBlockFieldSettings";
import { applyAgentProviderSettingsUpdate } from "$lib/utils/agentProviderSettings";
import { buildAgentSettingsSavePatch } from "$lib/utils/agentSettingsSavePatch";
import {
  AGENT_FIELD_BY_FIELD_BLOCKS,
  applyAgentBlockUpdate,
  sameJsonValue,
  type AgentBlockSaveByField,
  type AgentFieldByFieldBlock,
} from "$lib/utils/agentBlockFieldSettings";
import {
  MCP_SETTINGS_REVISION_HEADER, mcpSettingsLeaves, readMcpSettingsRevisions, withExpectedMcpSettings, withoutExpectedMcpSettings, type ExpectedMcpSettings,
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
  isApiPrimaryAgentType,
  isRetiredPrimaryAgentType,
  normalizePrimaryAgentType,
  retiredPrimaryAgentTypeMessage,
  shouldShowReasoningByDefaultForPrimaryAgent
} from "$lib/utils/primaryAgentType";
import { resolveAgentFabricUtilitiesEnabled, type ToolHostScope } from "$lib/utils/brokerAvailability";
import {
  isCliSubagentType,
  isRetiredSubagentType,
  isSubagentCompatibleWithPrimaryAgent,
  normalizeSubagentType,
  retiredSubagentTypeSentences,
  type SubagentType,
  type StoredSubagentType,
} from "$lib/utils/subagentType";
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
  import AgentAppActionsAccessCard from "$lib/components/settings/agent/AgentAppActionsAccessCard.svelte";
  import AgentDeleteDisclosure from "$lib/components/settings/agent/AgentDeleteDisclosure.svelte";
  import AgentSelectorSection from "$lib/components/settings/agent/AgentSelectorSection.svelte";
  import AgentAutoCompactSettingsCard from "$lib/components/settings/agent/AgentAutoCompactSettingsCard.svelte";
  import AgentMemorySettingsCard from "$lib/components/settings/agent/AgentMemorySettingsCard.svelte";
  import AgentDmsSettingsCard from "$lib/components/settings/agent/AgentDmsSettingsCard.svelte";
  import AgentJevJuiceSettingsCard from "$lib/components/settings/agent/AgentJevJuiceSettingsCard.svelte";
  import {
    readAgentJevJudgeToolSwitch,
    resolveAgentJevMemoryRecallEnabled,
    resolveAgentJevMemoryRerankEnabled,
    resolveAgentJevReplyCheckEnabled,
    resolveAgentJevSkillSessionMode,
    type JevSkillSessionMode,
    type StoredJevSkillSessionMode,
    resolveAgentJevStyleCoachEnabled,
  } from "$lib/utils/jevJuiceControl";
  import {
    DEFAULT_WAKE_TARGET,
    readAgentDmsSwitch,
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
    resolveWorkersEnabled,
  } from "$lib/utils/delegationCapabilities";
  import { typedFileToolsUnavailableReason, type TypedFileToolsHost } from "$lib/utils/typedFileToolsGrant";
  import { liveFileReadsChosenOn, resolveZipAiViewModeOf } from "$lib/utils/liveFileReads";
  import {
    agentRefreshedFileReadsAvailability,
    fetchToolsHostFacts,
    refreshedFileReadsRecordInputsChanged,
  } from "$lib/utils/refreshedFileReadsSettings";
  import {
    TYPED_FILE_TOOLS_AGENT_FIELD,
    TYPED_FILE_TOOLS_BLOCK_LIST_SENTENCE,
    readTypedFileToolsValue,
  } from "$lib/utils/typedFileToolsGrant";
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
  Lock,
  Mic,
  ChevronDown,
  Info,
  Plus,
  RotateCcw,
  Wrench,
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
import { LIVE_SETTINGS_EVENTS, dispatchArtifactUpdated } from "$lib/utils/liveSettingsEvents";
import {
  formatDelegationDuration,
  getSubagentTimeoutValidationError,
  normalizeSubagentTimeoutSeconds,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
  MIN_SUBAGENT_TIMEOUT_SECONDS,
} from "$lib/utils/subagentTimeout";
import {
  getSubagentMaxToolStepsValidationError,
  MAX_SUBAGENT_MAX_TOOL_STEPS,
  MIN_SUBAGENT_MAX_TOOL_STEPS,
} from "$lib/utils/subagentToolSteps";

  const BASIC_SAVE_DEBOUNCE_MS = 600;
  const ZIP_SAVE_DEBOUNCE_MS = 700;
  const SUBAGENT_SAVE_DEBOUNCE_MS = 600;
  const MCP_SAVE_DEBOUNCE_MS = 650;
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
    typedFileToolsHost?: TypedFileToolsHost;
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


  interface BasicForm extends AgentReasoningRetention {
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
    jev_juice_skill_tool_hints: JevSkillSessionMode;
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
    retained?: Record<string, unknown>;
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
    live_file_reads: string;
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

  const ZIP_LAYOUT_INHERIT = "__inherit__";
  const ZIP_NOTES_INHERIT = "__inherit__";
  const LIVE_READS_INHERIT = "__inherit__";
  const ZIP_AUTO_INHERIT = "__inherit__";
  const VOICE_PROVIDER_INHERIT = "__inherit__";
  const VOICE_ITALIC_NARRATION_INHERIT = "__inherit_italic_narration__";

  interface BasicPayloadBody extends AgentReasoningRetention {
    expectedTypedFileTools?: string;
    displayName: string;
    agentType: PrimaryAgentType;
    show_reasoning: boolean;
    preserve_reasoning?: boolean;
    tool_approval_mode?: "off" | "all" | null;
    memory_enabled?: boolean;
    /** SA-111 P4 (DL-111-11). */
    workers_enabled?: boolean;
    dms_enabled?: boolean;
    dm_senders?: DmSenderScope | { scope?: DmSenderScope; agentIds?: string[] } | null;
    dm_sender_agent_ids?: string[] | null;
    jev_juice_skill_tool_hints?: StoredJevSkillSessionMode;
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
          .filter(isExactSavedAccessAgentId),
      ),
    );
  }

  function getArtifactAccessScope(artifact: ArtifactRow): "all" | "selected" {
    if (!isArtifactAgentUseEligible(artifact)) return "selected";
    return readArtifactAgentAccess(artifact).scope;
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
    return readArtifactAgentAccess(artifact).ids.includes(entityId);
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

  let accessResourcesGeneration = 0;
  type AccessReadScope = "all" | "commands";
  let accessFullReadRequired = true;
  let accessRefreshQueued: AccessReadScope | null = null;
  function queueAccessRefresh(commandsOnly: boolean) {
    // Invalidating a full read must retain its Artifact work, including first load and Retry.
    const scope = commandsOnly && !accessFullReadRequired
      ? "commands" : "all";
    if (accessRefreshQueued !== "all") accessRefreshQueued = scope;
    accessResourcesGeneration += 1;
  }
  function handleSlashCommandsUpdated() {
    if (!accessResourcesLoaded && !accessResourcesLoading) return;
    queueAccessRefresh(true);
    flushAccessRefresh();
  }
  function flushAccessRefresh() {
    if (settingsPanelAlive && accessRefreshQueued && !accessResourcesLoading && accessSaveState !== "saving") {
      void loadAccessResources(true, accessRefreshQueued === "commands");
    }
  }
  async function loadAccessResources(force = false, commandsOnly = false) {
    if (!settingsPanelAlive || !data?.user?.id) return;
    if (accessResourcesLoaded && !force) return;
    if (accessResourcesLoading || accessSaveState === "saving") {
      if (force) queueAccessRefresh(commandsOnly);
      return;
    }
    const userId = data.user.id;
    const generation = ++accessResourcesGeneration;
    const readScope: AccessReadScope = commandsOnly && !accessFullReadRequired ? "commands" : "all";
    if (readScope === "all") accessFullReadRequired = true;
    accessRefreshQueued = null;

    accessResourcesLoading = true;
    accessResourcesError = null;
    try {
      const [commands, artifacts] = await Promise.all([
        slashCommandStore.getSlashCommands(userId, { required: true }),
        readScope === "commands" ? Promise.resolve(null) : artifactService.getArtifacts(userId, { required: true }),
      ]);
      if (!settingsPanelAlive || generation !== accessResourcesGeneration || data?.user?.id !== userId) return;

      accessSlashCommands = [...commands].sort((left, right) =>
        String(left.displayName || left.name || left.id).localeCompare(
          String(right.displayName || right.name || right.id),
        ),
      );
      if (artifacts) accessArtifacts = artifacts
        .filter((artifact) => isArtifactAgentUseEligible(artifact))
        .sort((left, right) =>
          String(left.name || left.id).localeCompare(String(right.name || right.id)),
        );
      accessResourcesLoaded = true;
      if (readScope === "all") accessFullReadRequired = false;
    } catch (error) {
      if (!settingsPanelAlive || generation !== accessResourcesGeneration || data?.user?.id !== userId) return;
      console.error("Failed to load access resources:", error);
      accessResourcesError =
        error instanceof Error ? error.message : "Failed to load access resources.";
    } finally {
      if (settingsPanelAlive) {
        accessResourcesLoading = false;
        flushAccessRefresh();
      }
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
    } finally {
      flushAccessRefresh();
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
    } finally {
      flushAccessRefresh();
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
   * Every other API primary is listed, not only the ones with DMs already on: the user
   * picks who may write, and turning that agent's own DMs on afterwards is a separate act.
   * A `DMs off` pill says which ones cannot write yet, so the list is honest rather than
   * quietly incomplete.
   */
  const dmSenderCandidates = $derived(
    agents
      .filter((agent) => {
        if (agent.id === selectedAgentId) return false;
        // SA-139 R4: a leftover of a removed Primary type never runs, so it never sends a DM.
        return isApiPrimaryAgentType(normalizePrimaryAgentType(agent));
      })
      .map((agent) => ({
        id: agent.id,
        name: agent.displayName || agent.id,
        dmsEnabled: resolveAgentDmsEnabled(agent),
      })),
  );
  /**
   * This agent's Fabric & Utilities switch as the form holds it now, read by the server's own
   * rule (every saved shape and alias the server accepts). Agent DMs and the Judge Juice
   * Judgment Tool need it (Josh, 2026-10-24), so their cards lock while it is off.
   */
  const primaryFabricUtilitiesEnabled = $derived.by(
    () =>
      isNativeToolUiAvailable("fabric") &&
      resolveAgentFabricUtilitiesEnabled({ provider_specific_settings: getProviderSpecificSettings("agent") }),
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
  type PrimaryCaptureSection = "basic" | "zip" | "mcp" | "assignment";
  const primaryDeferredCaptures = new Map<string, Set<PrimaryCaptureSection>>();
  const primaryCaptureWake = $state({ basic: 0, zip: 0, mcp: 0, assignment: 0 });
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
  type ModelSelectionSave = { baseline: ModelSelectionBaseline | null; generation: number; hold: 'read' | 'conflict' | 'unknown' | null; earlierUnknown: boolean };
  const modelSelectionSaves = new Map<string, ModelSelectionSave>();
  const modelSelectionReadbacks = new Set<string>();
  let primaryModelSelectionNotice = $state<string | null>(null);
  let subagentModelSelectionNotice = $state<string | null>(null);
  let primaryModelSelectionBlocked = $state(true);
  let subagentModelSelectionBlocked = $state(true);
  let primaryModelClearBlocked = $state(true);
  let subagentModelClearBlocked = $state(true);
  type InstructionsLeaf = 'customPrompt' | 'includeGlobalPrompt';
  type InstructionsSave = { bases: Record<InstructionsLeaf, InstructionsBaseline | null>; holds: Record<InstructionsLeaf, 'read' | 'conflict' | 'unknown' | null>; generation: number; earlierUnknown: boolean };
  const instructionsSaves = new Map<string, InstructionsSave>();
  const instructionsReadbacks = new Set<string>();
  let primaryInstructionsBaseline = $state.raw<InstructionsBaseline | null>(null);
  let subagentInstructionsBaseline = $state.raw<InstructionsBaseline | null>(null);
  let primaryInstructionsNotice = $state<string | null>(null);
  let subagentInstructionsNotice = $state<string | null>(null);
  let primaryInstructionsPromptBlocked = $state(true);
  let primaryInstructionsIncludeBlocked = $state(true);
  let subagentInstructionsPromptBlocked = $state(true);
  let subagentInstructionsIncludeBlocked = $state(true);
  type AutoCompactSave = { baseline: AutoCompactBaseline | null; generation: number; hold: 'read' | 'conflict' | 'unknown' | null; earlierUnknown: boolean };
  const autoCompactSaves = new Map<string, AutoCompactSave>();
  const autoCompactReadbacks = new Set<string>();
  const memoryReadbacks = new Set<string>();
  let autoCompactNotice = $state<string | null>(null);
  let autoCompactBlocked = $state(true);
  type TypedToolsSave = { baseline: TypedFileToolsBaseline | null; hold: 'read' | 'conflict' | 'unknown' | null; generation: number; earlierUnknown: boolean };
  let typedToolsSaves = $state<Record<string, TypedToolsSave>>({});
  class TypedToolsSaveRefusedError extends Error {}
  function typedToolsSave(kind: NativeToolsScope, id: string): TypedToolsSave {
    const key = `${kind}:${id}`;
    if (!typedToolsSaves[key]) typedToolsSaves[key] = { baseline: null, hold: null, generation: 0, earlierUnknown: false };
    return typedToolsSaves[key];
  }
  function typedToolsInfo(kind: NativeToolsScope) {
    const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
    const saved = id ? typedToolsSaves[`${kind}:${id}`] : null;
    const blocked = Boolean(id && (!saved?.baseline || saved.hold !== null));
    let notice = saved?.hold === 'unknown' ? 'This choice is unconfirmed. Your draft is kept.' :
      saved?.hold === 'conflict' ? 'The saved choice changed. Your draft was not saved.' : blocked ? 'Read the saved choice before changing it.' : null;
    if (saved?.earlierUnknown && saved.hold !== 'unknown') notice = `An earlier save remains unconfirmed.${notice ? ` ${notice}` : ''}`;
    return { blocked, notice, reloading: kind === 'agent' ? detailLoading : subagentDetailLoading };
  }
  function adoptTypedToolsRead(kind: NativeToolsScope, row: AgentRow | SubagentRow, baseline: TypedFileToolsBaseline | null, clean: boolean, takeSaved: boolean) {
    const saved = typedToolsSave(kind, row.id);
    const busy = kind === 'agent' ? basicSaves.busy(row.id) : subagentCoreSaves.busy(row.id);
    if (busy || !takeSaved && (saved.hold === 'unknown' || saved.hold === 'conflict')) return;
    if (baseline && (clean || takeSaved)) {
      if (kind === 'agent' && basicPersistedForm) {
        basicForm = withTypedFileToolsChoice(basicForm, baseline.value);
        basicPersistedForm = withTypedFileToolsChoice(basicPersistedForm, baseline.value);
        basicPersistedSignature = makeBasicSignature(basicPersistedForm);
      } else if (kind === 'subagent' && subagentPersistedForm) {
        subagentForm = withTypedFileToolsChoice(subagentForm, baseline.value);
        subagentPersistedForm = withTypedFileToolsChoice(subagentPersistedForm, baseline.value);
        subagentPersistedSignature = makeSubagentFormSignature(subagentPersistedForm);
      }
      saved.baseline = baseline; saved.hold = null;
    } else if (!clean && saved.baseline && baseline?.token !== saved.baseline.token) saved.hold = 'conflict';
    else if (clean && !baseline) { saved.baseline = null; saved.hold = 'read'; }
  }
  function captureTypedTools<T extends object, F extends { provider_specific_settings: Record<string, any> | null }>(kind: NativeToolsScope, id: string, body: T, nextForm: F, baseForm: F) {
    if (typedFileToolsBodyValue(body) === undefined) return { body, nextForm };
    const saved = typedToolsSave(kind, id);
    if (saved.baseline && saved.hold === null) return { body: withExpectedTypedFileTools(body, saved.baseline), nextForm };
    const before = typedFileToolsBodyValue(baseForm);
    return { body: withoutTypedFileToolsChoice(body), nextForm: before === undefined ? withoutTypedFileToolsChoice(nextForm) : withTypedFileToolsChoice(nextForm, before) };
  }
  function beginTypedToolsWrite(kind: NativeToolsScope, id: string, body: object) {
    if (typedFileToolsBodyValue(body) === undefined) return null;
    const saved = typedToolsSave(kind, id);
    const expected = (body as { expectedTypedFileTools?: string }).expectedTypedFileTools;
    if (!saved.baseline || saved.hold !== null || expected !== saved.baseline.token) throw new TypedToolsSaveRefusedError('This choice was not sent. Use Saved Choice and make a new choice.');
    saved.generation += 1;
    return saved.baseline;
  }
  function adoptTypedToolsReceipt(kind: NativeToolsScope, id: string, body: object, original: TypedFileToolsBaseline | null, ack: unknown) {
    const expected = (body as { expectedTypedFileTools?: string }).expectedTypedFileTools;
    const next = adoptTypedFileToolsAck(original, expected, typedFileToolsBodyValue(body), ack);
    if (!next) return false;
    const saved = typedToolsSave(kind, id);
    if (saved.baseline?.token === expected) {
      saved.baseline = next; saved.hold = null; saved.generation += 1;
      if (kind === 'agent' && selectedAgentId === id && basicPersistedForm) {
        basicPersistedForm = withTypedFileToolsChoice(basicPersistedForm, next.value);
        basicPersistedSignature = makeBasicSignature(basicPersistedForm);
      } else if (kind === 'subagent' && selectedEditableSubagentId === id && subagentPersistedForm) {
        subagentPersistedForm = withTypedFileToolsChoice(subagentPersistedForm, next.value);
        subagentPersistedSignature = makeSubagentFormSignature(subagentPersistedForm);
      }
    }
    return true;
  }
  function refuseTypedToolsWrite(kind: NativeToolsScope, id: string, knownNoWrite: boolean) {
    const saved = typedToolsSave(kind, id); saved.generation += 1;
    saved.hold = knownNoWrite ? 'conflict' : 'unknown'; saved.earlierUnknown ||= !knownNoWrite;
  }
  async function useSavedTypedTools(kind: NativeToolsScope) {
    const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
    if (!id || (kind === 'agent' ? basicSaves.busy(id) : subagentCoreSaves.busy(id))) return;
    if (kind === 'agent') await hydrateAgent(id, undefined, true, false, false, false, false, false, true);
    else await hydrateSubagent(id, undefined, false, false, true);
  }
  type TtsSave = { baseline: ConfiguredTtsBaseline | null; generation: number; hold: 'read' | 'conflict' | 'unknown' | null; earlierUnknown: boolean };
  const ttsSaves = new Map<string, TtsSave>();
  const ttsReadbacks = new Set<string>();
  let ttsBlocked = $state(true);
  let ttsNotice = $state<string | null>(null);
  const ttsFormFields = ['provider', 'model', 'voiceId', 'profileId'] as const;
  function ttsSave(id: string): TtsSave {
    let saved = ttsSaves.get(id);
    if (!saved) { saved = { baseline: null, generation: 0, hold: null, earlierUnknown: false }; ttsSaves.set(id, saved); }
    return saved;
  }
  function syncTtsNotice() {
    const saved = selectedAgentId ? ttsSave(selectedAgentId) : null;
    ttsBlocked = !saved?.baseline || saved.hold !== null;
    ttsNotice = saved?.hold === 'unknown' ? 'This reply voice save is unconfirmed. Your draft is kept. Use Saved Reply Voice reads the current selection.' :
      saved?.hold === 'conflict' ? 'Reply voice changed while you were editing. Your draft was not saved. Use Saved Reply Voice, then make a new choice.' :
      !saved?.baseline ? 'Read the saved reply voice before another voice change.' : null;
    if (saved?.earlierUnknown && saved.hold !== 'unknown') ttsNotice = `An earlier reply voice save remains unconfirmed.${ttsNotice ? ` ${ttsNotice}` : ''}`;
  }
  function guardVoiceChoice<T extends (...args: any[]) => any>(callback: T): T { return guardPrimaryChoice(((...args: Parameters<T>) => { if (!ttsBlocked) return callback(...args); }) as T); }
  function sameTtsForm(left: VoiceProfileForm, right: VoiceProfileForm) { return ttsFormFields.every(field => left[field] === right[field]); }
  function adoptTtsRead(row: AgentRow, baseline: ConfiguredTtsBaseline | null, clean: boolean, takeSaved: boolean) {
    const saved = ttsSave(row.id);
    if (!basicPersistedForm || basicSaves.busy(row.id)) return;
    if (!takeSaved && (saved.hold === 'unknown' || saved.hold === 'conflict')) { syncTtsNotice(); return; }
    if (baseline && (clean || takeSaved)) {
      const incoming = normaliseBasicForm(row).voice_profile;
      const merge = (voice: VoiceProfileForm) => ({ ...voice, ...Object.fromEntries(ttsFormFields.map(field => [field, incoming[field]])) });
      basicForm = { ...basicForm, voice_profile: merge(basicForm.voice_profile) };
      basicPersistedForm = { ...basicPersistedForm, voice_profile: merge(basicPersistedForm.voice_profile) };
      basicPersistedSignature = makeBasicSignature(basicPersistedForm);
      saved.baseline = baseline; saved.hold = null;
    } else if (!clean && saved.baseline && baseline?.token !== saved.baseline.token) saved.hold = 'conflict';
    else if (clean && !baseline) saved.baseline = null;
    syncTtsNotice();
  }
  function captureBasicTts(id: string, body: Partial<BasicPayloadBody>, nextForm: BasicForm, baseForm: BasicForm) {
    if (!Object.hasOwn(body, 'voice_profile')) return { body, nextForm, expectedTtsSelection: undefined as string | undefined };
    const saved = ttsSave(id);
    if (saved.baseline?.id === id && saved.hold === null) return { body, nextForm, expectedTtsSelection: saved.baseline.token };
    const nextBody = { ...body }; delete nextBody.voice_profile;
    return { body: nextBody, nextForm: { ...nextForm, voice_profile: baseForm.voice_profile }, expectedTtsSelection: undefined };
  }
  function tryTtsReadback() {
    const id = selectedAgentId;
    if (!settingsPanelAlive || !id || selectedEntity?.kind !== 'agent' || !ttsReadbacks.has(id) || detailLoading || basicSaves.busy(id)) return;
    ttsReadbacks.delete(id); void hydrateAgent(id, undefined, true);
  }
  async function useSavedTts() { const id = selectedAgentId; if (id && !basicSaves.busy(id)) await hydrateAgent(id, undefined, true, false, false, false, true); }

  function autoCompactSave(id: string): AutoCompactSave {
    let saved = autoCompactSaves.get(id);
    if (!saved) { saved = { baseline: null, generation: 0, hold: null, earlierUnknown: false }; autoCompactSaves.set(id, saved); }
    return saved;
  }
  function syncAutoCompactNotice() {
    const saved = selectedAgentId ? autoCompactSave(selectedAgentId) : null;
    autoCompactBlocked = !saved?.baseline || saved.hold !== null;
    let message: string | null = null;
    if (saved?.hold === 'unknown') message = 'This Auto Compact save is unconfirmed. Your draft is kept. Use Saved Auto Compact reads the current values and replaces this draft.';
    else if (saved?.hold === 'conflict') message = 'Auto Compact changed while you were editing. Your draft was not saved. Use Saved Auto Compact reads the current values; make a new choice to continue.';
    else if (!saved?.baseline) message = saved?.hold === 'read' ? 'Auto Compact was saved. Read its current values before another change.' : 'Read the saved Auto Compact settings before editing them.';
    if (saved?.earlierUnknown && saved.hold !== 'unknown') message = `An earlier Auto Compact save remains unconfirmed.${message ? ` ${message}` : ''}`;
    autoCompactNotice = message;
  }
  function sameAutoCompactCommon(left: AgentAutoCompactSettings, right: AgentAutoCompactSettings) {
    return AUTO_COMPACT_COMMON_FIELDS.every(field => left[field] === right[field]);
  }
  /** A whole human block must never send common leaves from before a clean agent refresh. */
  function adoptAutoCompactRead(row: AgentRow, baseline: AutoCompactBaseline | null, cleanCommon: boolean, cleanAdvanced: boolean, takeSaved = false) {
    const saved = autoCompactSave(row.id);
    if (!basicPersistedForm || basicSaves.busy(row.id)) return;
    if (!takeSaved && (saved.hold === 'unknown' || saved.hold === 'conflict')) { syncAutoCompactNotice(); return; }
    if (baseline && (cleanCommon || takeSaved)) {
      const incoming = normalizeAgentAutoCompactSettings(row.auto_compact_settings);
      const merge = (current: AgentAutoCompactSettings) => cleanAdvanced || takeSaved ? incoming : {
        ...current, ...Object.fromEntries(AUTO_COMPACT_COMMON_FIELDS.map(field => [field, incoming[field]]))
      } as AgentAutoCompactSettings;
      basicForm = { ...basicForm, auto_compact_settings: merge(basicForm.auto_compact_settings) };
      basicPersistedForm = { ...basicPersistedForm, auto_compact_settings: merge(basicPersistedForm.auto_compact_settings) };
      basicPersistedSignature = makeBasicSignature(basicPersistedForm);
      saved.baseline = baseline;
      saved.hold = null;
      if (takeSaved && basicSaveError?.includes('Auto Compact')) { basicSaveError = null; basicSaveState = 'idle'; }
    } else if (!cleanCommon && saved.baseline && baseline?.token !== saved.baseline.token) {
      saved.hold = 'conflict';
    } else if (cleanCommon && !baseline) {
      saved.baseline = null;
    }
    syncAutoCompactNotice();
  }
  function captureBasicAutoCompact(id: string, body: Partial<BasicPayloadBody>, nextForm: BasicForm, baseForm: BasicForm) {
    const voice = captureBasicTts(id, body, nextForm, baseForm); body = voice.body; nextForm = voice.nextForm;
    const expectedTtsSelection = voice.expectedTtsSelection;
    if (!Object.hasOwn(body, 'auto_compact_settings')) return { body, nextForm, expectedTtsSelection, expectedAutoCompact: undefined as string | undefined };
    const saved = autoCompactSave(id);
    if (saved.baseline?.id === id && saved.hold === null) return { body, nextForm, expectedTtsSelection, expectedAutoCompact: saved.baseline.token };
    const nextBody = { ...body };
    delete nextBody.auto_compact_settings;
    return { body: nextBody, nextForm: { ...nextForm, auto_compact_settings: baseForm.auto_compact_settings }, expectedTtsSelection, expectedAutoCompact: undefined };
  }
  function tryAutoCompactReadback() {
    const id = selectedAgentId;
    if (!settingsPanelAlive || !id || selectedEntity?.kind !== 'agent' || !autoCompactReadbacks.has(id) || detailLoading || basicSaves.busy(id)) return;
    autoCompactReadbacks.delete(id);
    void hydrateAgent(id, undefined, true);
  }
  function tryMemoryReadback() {
    const id = selectedAgentId;
    if (!settingsPanelAlive || !id || selectedEntity?.kind !== 'agent' || !memoryReadbacks.has(id) || detailLoading || basicSaves.busy(id)) return;
    memoryReadbacks.delete(id);
    void hydrateAgent(id, undefined, true);
  }
  async function useSavedAutoCompact() {
    const id = selectedAgentId;
    if (!id || basicSaves.busy(id)) return;
    await hydrateAgent(id, undefined, true, false, false, true);
  }

  function instructionsSave(kind: ModelSelectionKind, id: string): InstructionsSave {
    const key = `${kind}:${id}`;
    let saved = instructionsSaves.get(key);
    if (!saved) { saved = { bases: { customPrompt: null, includeGlobalPrompt: null }, holds: { customPrompt: null, includeGlobalPrompt: null }, generation: 0, earlierUnknown: false }; instructionsSaves.set(key, saved); }
    return saved;
  }
  function syncInstructionsNotices() {
    for (const kind of ['agent', 'subagent'] as const) {
      const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
      const saved = id ? instructionsSave(kind, id) : null;
      const blocked = (leaf: InstructionsLeaf) => !saved?.bases[leaf] || saved.holds[leaf] !== null;
      let message: string | null = null;
      if (saved && Object.values(saved.holds).includes('unknown')) message = 'This instructions save is unconfirmed. Your draft is kept. Use Saved Instructions reads the current values and replaces this instructions draft.';
      else if (saved && Object.values(saved.holds).includes('conflict')) message = 'Saved instructions changed while you were editing. Your draft was not saved. Use Saved Instructions reads the current values; make a new choice to continue.';
      else if (blocked('customPrompt') || blocked('includeGlobalPrompt')) message = 'Read the saved instructions before editing them.';
      if (saved?.earlierUnknown && !Object.values(saved.holds).includes('unknown')) message = `An earlier instructions save remains unconfirmed.${message ? ` ${message}` : ''}`;
      if (kind === 'agent') {
        primaryInstructionsBaseline = saved?.bases.customPrompt ?? null;
        primaryInstructionsPromptBlocked = blocked('customPrompt'); primaryInstructionsIncludeBlocked = blocked('includeGlobalPrompt'); primaryInstructionsNotice = message;
      } else {
        subagentInstructionsBaseline = saved?.bases.customPrompt ?? null;
        subagentInstructionsPromptBlocked = blocked('customPrompt'); subagentInstructionsIncludeBlocked = blocked('includeGlobalPrompt'); subagentInstructionsNotice = message;
      }
    }
  }
  function adoptInstructionsRead(kind: ModelSelectionKind, row: Record<string, any>, baseline: InstructionsBaseline | null, cleanPrompt: boolean, cleanInclude: boolean, takeSaved = false) {
    const saved = instructionsSave(kind, row.id);
    if (takeSaved && !baseline) { syncInstructionsNotices(); return; }
    const incoming = kind === 'agent' ? normaliseBasicForm(row as AgentRow) : normaliseSubagentForm(row as SubagentRow);
    for (const [leaf, clean] of [['customPrompt', cleanPrompt], ['includeGlobalPrompt', cleanInclude]] as const) {
      if (!clean || !takeSaved && (saved.holds[leaf] === 'conflict' || saved.holds[leaf] === 'unknown')) continue;
      if (leaf === 'customPrompt') {
        if (kind === 'agent') { promptValue = typeof row.system_prompt === 'string' ? row.system_prompt : ''; promptPersistedSignature = promptValue; }
        else if (subagentPersistedForm) {
          const value = typeof row.system_prompt === 'string' ? row.system_prompt : '';
          subagentForm = { ...subagentForm, system_prompt: value };
          subagentPersistedForm = { ...subagentPersistedForm, system_prompt: value };
        }
      } else if (kind === 'agent' && basicPersistedForm) {
        basicForm = { ...basicForm, include_global_prompt: incoming.include_global_prompt };
        basicPersistedForm = { ...basicPersistedForm, include_global_prompt: incoming.include_global_prompt };
        basicPersistedSignature = makeBasicSignature(basicPersistedForm);
      } else if (kind === 'subagent' && subagentPersistedForm) {
        subagentForm = { ...subagentForm, include_global_prompt: incoming.include_global_prompt };
        subagentPersistedForm = { ...subagentPersistedForm, include_global_prompt: incoming.include_global_prompt };
      }
      // Keep stable opaque identity when only the other leaf changed.
      if (!baseline || baseline.type !== saved.bases[leaf]?.type || baseline.tokens[leaf] !== saved.bases[leaf]?.tokens[leaf]) saved.bases[leaf] = baseline;
      if (baseline) saved.holds[leaf] = null;
    }
    if (kind === 'subagent' && subagentPersistedForm) subagentPersistedSignature = makeSubagentFormSignature(subagentPersistedForm);
    if (takeSaved) { if (kind === 'agent') agentPromptEditorOpen = false; else subagentPromptEditorOpen = false; }
    syncInstructionsNotices();
  }
  function captureInstructions<T extends Record<string, any>, F extends Record<string, any>>(kind: ModelSelectionKind, id: string, body: T, nextForm: F, baseForm: F, editorBase?: InstructionsBaseline | null) {
    const nextBody = { ...body };
    let resultForm = nextForm;
    const expectedInstructions: Partial<InstructionsRevisions> = {};
    const saved = instructionsSave(kind, id);
    for (const [field, leaf] of [['system_prompt', 'customPrompt'], ['include_global_prompt', 'includeGlobalPrompt']] as const) {
      if (!Object.hasOwn(nextBody, field)) continue;
      const baseline = leaf === 'customPrompt' && editorBase !== undefined ? editorBase : saved.bases[leaf];
      const expected = instructionsExpectedForWrites(baseline, { [field]: nextBody[field] });
      if (!baseline || baseline.kind !== kind || baseline.id !== id || saved.holds[leaf] !== null || !expected) {
        delete nextBody[field];
        resultForm = { ...resultForm, [field]: baseForm[field] };
      } else Object.assign(expectedInstructions, expected);
    }
    return { body: nextBody, nextForm: resultForm, expectedInstructions: Object.keys(expectedInstructions).length ? expectedInstructions : undefined };
  }
  function beginInstructionsWrite(kind: ModelSelectionKind, id: string, body: Record<string, unknown>, expected?: Partial<InstructionsRevisions>) {
    if (!namesInstructions(body)) return;
    const saved = instructionsSave(kind, id);
    for (const [field, leaf] of [['system_prompt', 'customPrompt'], ['include_global_prompt', 'includeGlobalPrompt']] as const) {
      if (Object.hasOwn(body, field) && (!expected?.[leaf] || saved.holds[leaf] !== null)) throw new InstructionsSaveRefusedError('This instructions change was not sent. Use Saved Instructions and make a new choice.');
    }
    saved.generation += 1;
  }
  /** HTTP status alone does not establish whether an issued route saved before readback failed. */
  function instructionsKnownNoSave(status: unknown, code: unknown): boolean {
    return status === 400 && ['instructions_base_required', 'model_selection_base_required', 'cli_reasoning_base_required', 'auto_compact_base_required', 'tts_selection_base_required'].includes(String(code)) ||
      status === 409 && ['instructions_settings_changed', 'model_selection_settings_changed', 'cli_reasoning_settings_changed', 'auto_compact_settings_changed', 'memory_settings_changed', 'cli_promotion_changed', 'tts_selection_changed', 'tts_speech_to_speech_locked', 'tts_model_selection_unavailable', 'model_preset_unavailable', 'cli_selection_changes_unadopted_native_controls', 'MANAGED_PROFILE_SOURCE_CHANGED'].includes(String(code));
  }
  function settleInstructionsWrite(kind: ModelSelectionKind, id: string, body: Record<string, unknown>, outcome: 'read' | 'conflict' | 'unknown') {
    if (!namesInstructions(body)) return;
    const saved = instructionsSave(kind, id);
    saved.generation += 1;
    for (const [field, leaf] of [['system_prompt', 'customPrompt'], ['include_global_prompt', 'includeGlobalPrompt']] as const) {
      if (Object.hasOwn(body, field)) { saved.holds[leaf] = outcome; if (outcome === 'read') saved.bases[leaf] = null; }
    }
    saved.earlierUnknown ||= outcome === 'unknown';
    if (outcome !== 'unknown') instructionsReadbacks.add(`${kind}:${id}`);
    syncInstructionsNotices();
  }
  function tryInstructionsReadbacks() {
    for (const kind of ['agent', 'subagent'] as const) {
      const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
      if (!settingsPanelAlive || !id || selectedEntity?.kind !== kind || !instructionsReadbacks.has(`${kind}:${id}`) ||
        (kind === 'agent' ? detailLoading || basicSaves.busy(id) || promptSaves.busy(id) : subagentDetailLoading || subagentCoreSaves.busy(id))) continue;
      instructionsReadbacks.delete(`${kind}:${id}`);
      if (kind === 'agent') void hydrateAgent(id, undefined, true); else void hydrateSubagent(id);
    }
  }
  async function useSavedInstructions(kind: ModelSelectionKind) {
    const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
    if (!id || (kind === 'agent' ? basicSaves.busy(id) || promptSaves.busy(id) : subagentCoreSaves.busy(id))) return;
    if (kind === 'agent') await hydrateAgent(id, undefined, true, false, true); else await hydrateSubagent(id, undefined, false, true);
  }

  function modelSelectionSave(kind: ModelSelectionKind, id: string): ModelSelectionSave {
    const key = `${kind}:${id}`;
    let saved = modelSelectionSaves.get(key);
    if (!saved) { saved = { baseline: null, generation: 0, hold: null, earlierUnknown: false }; modelSelectionSaves.set(key, saved); }
    return saved;
  }

  function syncModelSelectionNotices() {
    for (const kind of ['agent', 'subagent'] as const) {
      const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
      const saved = id ? modelSelectionSave(kind, id) : null;
      const validBase = Boolean(saved?.baseline);
      // SA-139 R5: a leftover CLI Subagent shows no model picker (it is delete-only), so only the
      // live API type needs the guard.
      const needsGuard = kind === 'agent'
        ? ['api', 'cli'].includes(basicForm.agentType) || ['api', 'cli'].includes(basicPersistedForm?.agentType ?? '')
        : subagentForm.subagentType === 'api' || subagentPersistedForm?.subagentType === 'api';
      if (!needsGuard) {
        if (kind === 'agent') { primaryModelSelectionNotice = null; primaryModelSelectionBlocked = false; primaryModelClearBlocked = true; }
        else { subagentModelSelectionNotice = null; subagentModelSelectionBlocked = false; subagentModelClearBlocked = true; }
        continue;
      }
      let message: string | null = null;
      if (saved?.hold === 'unknown') message = 'This model save is unconfirmed. Your choice is kept. Use Saved Model reads the current choice and replaces only this model draft.';
      else if (saved?.hold === 'conflict') message = 'The saved model changed while you were editing. Your choice was not saved. Use Saved Model reads the current choice and replaces only this model draft.';
      else if (!validBase) message = saved?.hold === 'read' ? 'The model was saved. Read its current selection before choosing another model.' : 'The original model and native selection source is unavailable. Read it before choosing another model.';
      const blocked = !validBase || saved?.hold !== null;
      if (saved?.earlierUnknown && saved.hold !== 'unknown') message = `An earlier model save remains unconfirmed.${message ? ` ${message}` : ''}`;
      if (kind === 'agent') { primaryModelSelectionNotice = message; primaryModelSelectionBlocked = blocked; primaryModelClearBlocked = blocked; }
      else { subagentModelSelectionNotice = message; subagentModelSelectionBlocked = blocked; subagentModelClearBlocked = blocked; }
    }
  }

  function adoptModelSelectionRead(kind: ModelSelectionKind, row: Record<string, any>, baseline: ModelSelectionBaseline | null, canAdopt: boolean) {
    const saved = modelSelectionSave(kind, row.id);
    if (canAdopt) {
      const incoming = kind === 'agent' ? normaliseBasicForm(row as AgentRow) : normaliseSubagentForm(row as SubagentRow);
      if (kind === 'agent' && basicPersistedForm) {
        basicForm = withModelSelection(kind, basicForm, incoming);
        basicPersistedForm = withModelSelection(kind, basicPersistedForm, incoming);
        basicPersistedSignature = makeBasicSignature(basicPersistedForm);
        syncSelectedModelFromAgent();
      } else if (kind === 'subagent' && subagentPersistedForm) {
        subagentForm = withModelSelection(kind, subagentForm, incoming);
        subagentPersistedForm = withModelSelection(kind, subagentPersistedForm, incoming);
        subagentPersistedSignature = makeSubagentFormSignature(subagentPersistedForm);
        syncSelectedModelFromSubagent();
      }
      saved.baseline = baseline;
      if (baseline) { saved.hold = null; modelSelectionReadbacks.delete(`${kind}:${row.id}`); }
    } else if (saved.baseline && baseline?.revision !== saved.baseline.revision && saved.hold !== 'unknown' &&
      (['api', 'cli'].includes(saved.baseline.type) || ['api', 'cli'].includes(kind === 'agent' ? basicForm.agentType : subagentForm.subagentType))) {
      saved.hold = 'conflict';
    }
    syncModelSelectionNotices();
  }

  function captureModelSelection<T extends Record<string, any>, F extends Record<string, any>>(kind: ModelSelectionKind, id: string, body: T, nextForm: F, baseForm: F) {
    if (!isModelSelectionWrite(kind, body)) return { body, nextForm, expectedModelSelection: undefined as string | undefined };
    const typeField = kind === 'agent' ? 'agentType' : 'subagentType';
    if (!['api', 'cli'].includes(baseForm[typeField]) && !['api', 'cli'].includes(nextForm[typeField])) return { body, nextForm, expectedModelSelection: undefined };
    const saved = modelSelectionSave(kind, id);
    if (saved.baseline && saved.hold === null) {
      return { body, nextForm, expectedModelSelection: saved.baseline.revision };
    }
    const nextBody = { ...body };
    if (nextForm[kind === 'agent' ? 'agentType' : 'subagentType'] !== baseForm[kind === 'agent' ? 'agentType' : 'subagentType']) return { body: {} as T, nextForm: baseForm, expectedModelSelection: undefined };
    for (const field of kind === 'agent' ? MODEL_SELECTION_FIELDS : MODEL_SELECTION_IDENTITY_FIELDS) delete nextBody[field];
    if (kind === 'agent' && 'provider_specific_settings' in nextBody) {
      const own = Object.fromEntries(Object.entries(nextBody.provider_specific_settings ?? {}).filter(([key]) => isAgentRuntimeSettingKey(key)));
      if (Object.keys(own).length) (nextBody as Record<string, unknown>).provider_specific_settings = own;
      else delete nextBody.provider_specific_settings;
    }
    return { body: nextBody, nextForm: withModelSelection(kind, nextForm, baseForm), expectedModelSelection: undefined };
  }

  function ownsModelSelectionBase(baseline: ModelSelectionBaseline | null, token: unknown) {
    return typeof token === 'string' && Boolean(baseline && baseline.revision === token);
  }

  async function useSavedModelSelection(kind: ModelSelectionKind) {
    const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
    if (!id || (kind === 'agent' ? basicSaves.busy(id) : subagentCoreSaves.busy(id))) return;
    if (kind === 'agent') await hydrateAgent(id, undefined, false, true);
    else await hydrateSubagent(id, undefined, true);
  }

  function tryModelSelectionReadbacks() {
    for (const kind of ['agent', 'subagent'] as const) {
      const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
      if (!settingsPanelAlive || !id || selectedEntity?.kind !== kind || !modelSelectionReadbacks.has(`${kind}:${id}`) ||
        (kind === 'agent' ? detailLoading || basicSaves.busy(id)
          : subagentDetailLoading || subagentCoreSaves.busy(id))) continue;
      modelSelectionReadbacks.delete(`${kind}:${id}`);
      if (kind === 'agent') void hydrateAgent(id, undefined, true);
      else void hydrateSubagent(id);
    }
  }

  $effect(() => {
    basicForm.agentType;
    subagentForm.subagentType;
    untrack(syncModelSelectionNotices);
  });
  const MEMORY_CONFLICT_RETRY_MESSAGE =
    "This agent's memory settings changed while you were editing them, so your change was not saved. Retry reads them again and keeps your edits.";
  const primarySettingsReadWaiting = $derived(detailLoading || agentReadDeferredUi || primaryReadWaitError !== null || primarySaveWaitExpiredUi || primaryOwnedSaveInFlightUi);
  const primaryDeferredDraftOnly = $derived.by(() => agentReadDeferredUi && !detailLoading && primaryReadWaitError === null &&
    !primarySaveWaitExpiredUi && !primaryOwnedWritePendingUi && !primaryOwnedSaveInFlightUi &&
    primaryModelSelectionNotice === null && ![basicSaveError, zipSaveError, mcpSaveError, assignmentSaveError].some(Boolean) &&
    hydratedAgentId === selectedAgentId && Object.values(agentSectionsAtRest()).some(atRest => !atRest));
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
  const assignmentSaves = createEntitySaverCount(readAgentAgainWhenAtRest, () => untrack(syncPrimarySaveWaits));

  let basicForm = $state<BasicForm>(createDefaultBasicForm());

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
   * BL-855: the two sections below as they were loaded or last saved. A save sends only what
   * differs from them (`agentSettingsSectionSaves.ts`), so a copy that the chat bar or a second
   * Settings window has since changed is never written back over that change. A failed save
   * leaves them as they were. Not reactive, like `basicPersistedForm`: each is set and cleared
   * beside its `...PersistedSignature`, and no effect reads what it writes.
   */
  let zipPersistedPayload: ZipPayloadBody | null = null;
  let mcpPersistedValues: McpSectionValues | null = null;
  let primaryMcpBases = $state<Record<string, ExpectedMcpSettings>>({});
  let primaryMcpHolds = $state<Record<string, 'read' | 'conflict' | 'unknown'>>({});
  const primaryMcpVersions = new Map<string, number>();
  function capturePrimaryMcpBody<T extends object>(body: T) {
    return untrack(() => {
      const id = selectedAgentId;
      if (!mcpSettingsLeaves(body).length) return body;
      if (!id || primaryMcpHolds[id]) throw new Error('Your Tool Settings draft is kept. Use Saved Tool Settings before another choice.');
      let captured;
      try { captured = withExpectedMcpSettings(body, primaryMcpBases[id]); }
      catch (error) { primaryMcpHolds = { ...primaryMcpHolds, [id]: 'read' }; throw error; }
      primaryMcpVersions.set(id, (primaryMcpVersions.get(id) ?? 0) + 1);
      return captured;
    });
  }
  function adoptPrimaryMcpAck(id: string, expected: ExpectedMcpSettings | undefined, ack: unknown) {
    if (!ack || typeof ack !== 'object' || !('revisions' in ack)) return false;
    const revisions = readMcpSettingsRevisions(JSON.stringify(ack.revisions));
    if (!expected || !revisions) return false;
    const base = primaryMcpBases[id];
    if (!base || Object.keys(expected).some(field => base[field as keyof ExpectedMcpSettings] !== expected[field as keyof ExpectedMcpSettings] || !revisions[field as keyof ExpectedMcpSettings])) return false;
    primaryMcpBases = { ...primaryMcpBases, [id]: { ...base, ...Object.fromEntries(Object.keys(expected).map(field => [field, revisions[field as keyof ExpectedMcpSettings]])) } };
    return true;
  }
  async function useSavedMcpSettings() {
    const id = selectedAgentId;
    if (id && !mcpSaves.busy(id) && !zipSaves.busy(id)) await hydrateAgent(id, undefined, false, false, false, false, false, true);
  }

  let zipValidationError = $state<string | null>(null);
  let zipSaveState = $state<SaveState>("idle");
  let zipSaveError = $state<string | null>(null);
  let zipLastSaved = $state<Date | null>(null);

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
  let savedModelsRead: Promise<void> | null = null;
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
  // BL-2049: the Tools card's host facts (Refreshed File Reads, Typed File Tools), read alone (no
  // sandbox probe) beside the full sandbox status, so neither waits on that probe's `sbx` timeouts.
  let toolsHostFacts = $state<TypedFileToolsHost | null>(null);
  let toolsHostFactsFailed = $state(false);
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
  const isChatPreset = (model: SavedModel) => (model.purpose ? model.purpose === "chat" : true);
  const chatModelPresets = $derived.by(() => savedModels.filter(isChatPreset));
  let modelConnectionOptions = $state<CatalogConnectionOption[] | null>(null);
  let modelConnectionOptionsLoading = $state(false);
  let modelConnectionOptionsError = $state<string | null>(null);
  let modelConnectionOptionsLoadedForAgentType = $state<StoredPrimaryAgentType | null>(null);
  const primaryModelConnectionsBlocked = $derived(
    isApiPrimaryAgentType(basicForm.agentType) &&
    (modelConnectionOptionsLoading || modelConnectionOptionsError !== null || modelConnectionOptions === null),
  );
  let voiceProfiles = $state<VoiceProfileRecord[]>([]);
  let voiceProfilesLoading = $state(false);
  let voiceProfilesError = $state<string | null>(null);

  let voiceProviders = $state<VoiceProviderSummary[]>([]);
  let voiceProvidersLoading = $state(false);
  let voiceCatalogRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const refreshVisibleVoiceCatalog = () => { if (settingsPanelAlive && document.visibilityState === 'visible') void loadVoiceProviders(); };
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

  function getTtsLaneLabel(provider: VoiceProviderSummary | null, model?: string | null) {
    if (!provider) return "Not configured";
    return voiceTtsModelStreams(provider, model) ? "Realtime TTS" : "Batch TTS";
  }

  function getTtsBadgeClass(provider: VoiceProviderSummary | null, model?: string | null) {
    if (!provider) return "batshit-settings-pill";
    return voiceTtsModelStreams(provider, model) ? "batshit-settings-pill is-success" : "batshit-settings-pill";
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
    const selected = resolveVoiceTtsDisplaySelection(basicForm.voice_profile, globalVoiceSettings, voiceProfiles, voiceProviders);
    const provider = selected.providerId;
    if (!provider) return [];

    const merged = new Map<string, AgentVoiceOption>();
    const model = selected.modelId;
    if (provider === 'alibaba' && isQwenAudioTtsModel(model ?? '')) {
      try {
        const { region } = parseQwenAudioEndpoint(resolveVoiceTtsDisplayEndpoint(selected, globalVoiceSettings, voiceProfiles));
        return getQwenAudioTtsVoices(model ?? '', region).map(id => ({ id, name: id, provider: 'alibaba' as VoiceProviderId }));
      } catch { return []; }
    }
    const step3 = provider === 'stepfun' && model === 'stepaudio-3-tts';
    const defaultVoiceId = selectedVoiceProvider?.defaultVoice?.trim();
    if (defaultVoiceId && !step3) {
      merged.set(defaultVoiceId, {
        id: defaultVoiceId,
        name: defaultVoiceId,
        provider: provider as VoiceProviderId,
        isDefault: true,
      });
    }
    voiceOptions.forEach((voice) => {
      if (step3 && voice.id !== 'zixinnansheng') return;
      merged.set(voice.id, voice);
    });
    if (step3 && !merged.has('zixinnansheng')) merged.set('zixinnansheng', { id: 'zixinnansheng', name: 'zixinnansheng', provider: 'stepfun' });

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

  const agentVoiceUsesModelSpecificVoices = $derived.by(() => {
    const selected = resolveVoiceTtsDisplaySelection(basicForm.voice_profile, globalVoiceSettings, voiceProfiles, voiceProviders);
    return selected.providerId === 'alibaba' && isQwenAudioTtsModel(selected.modelId ?? '') || selected.providerId === 'stepfun' && selected.modelId === 'stepaudio-3-tts';
  });

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
          agentType: getPrimaryToolHostScope(),
          connectionOptions: modelConnectionOptions,
        })
      : null,
  );

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
  const effectiveVoiceModelNotice = $derived.by(() => {
    const selected = resolveVoiceTtsDisplaySelection(basicForm.voice_profile, globalVoiceSettings, voiceProfiles, voiceProviders)
    const provider = resolveVoiceProviderById(selected.providerId)
    return mimoVoiceModelNotice(selected.providerId, selected.modelId, voiceProviderModelProfile(provider, 'tts-batch', selected.modelId)) ?? voiceModelApplicabilityNotice(selected.providerId, selected.modelId)
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
  const effectiveAgentTtsModel = $derived(resolveVoiceTtsDisplaySelection(basicForm.voice_profile, globalVoiceSettings, voiceProfiles, voiceProviders).modelId);
  const defaultAgentTtsModel = $derived(resolveVoiceTtsDisplaySelection({ ...basicForm.voice_profile, model: '' }, globalVoiceSettings, voiceProfiles, voiceProviders).modelId);
  const effectiveAgentTtsLaneLabel = $derived(getTtsLaneLabel(effectiveAgentTtsProvider, effectiveAgentTtsModel));
  const effectiveAgentTtsBadgeClass = $derived(getTtsBadgeClass(effectiveAgentTtsProvider, effectiveAgentTtsModel));
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
    getTtsLaneLabel(selectedAgentTtsProviderForBadge, effectiveAgentTtsModel),
  );
  const selectedAgentTtsBadgeClass = $derived(
    getTtsBadgeClass(selectedAgentTtsProviderForBadge, effectiveAgentTtsModel),
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
    savedModelsError = savedModelsStore.getReadError();
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
        agentType: getPrimaryToolHostScope(),
        connectionOptions: modelConnectionOptions,
      }),
    }));

    items.sort(
      (a, b) =>
        Number(a.availability.disabled) - Number(b.availability.disabled),
    );

    return items;
  });

  const subagentModelMenuItems = $derived.by(() => {
    const items = chatModelPresets.map((model) => ({
      model,
      availability: getModelPresetAvailability({
        model,
        agentType: getSubagentToolHostScope(),
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

  // SA-139 R4/R5: every live Primary and Subagent is an API agent (a leftover retired type is
  // refused, not run), so Batshit's own Bash and Web Search are the only lane these rows serve.
  function isNativeToolUiAvailable(
    family: NativeToolUiFamily,
    scope: NativeToolsScope = "agent",
  ): boolean {
    switch (family) {
      case "fabric":
        return scope === "agent";
      case "bash":
      case "web-search":
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
    switch (family) {
      case "fabric":
        if (scope === "subagent") {
          return "Broad Fabric Controls are not available for Subagents. Delegated runs do not receive the Judge Juice judgment tool or the MCP search/call utility refs.";
        }
        return null;
      default:
        return null;
    }
  }

  function getBashToolName(scope: NativeToolsScope = "agent"): string | null {
    return "native_bash_execute";
  }

  function getWebSearchToolName(scope: NativeToolsScope = "agent"): string | null {
    return "native_web_search";
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

  // This record's materialized grant is explicit. Missing source stays unavailable; Bash,
  // the parent and current host/backend facts remain separate execution bounds.
  function getTypedFileToolsValue(scope: NativeToolsScope = "agent"): boolean | null {
    return readTypedFileToolsValue(getNativeToolsSettings(scope)[TYPED_FILE_TOOLS_AGENT_FIELD]);
  }

  // The command location the server resolves for this record's Bash: an explicit one, else Local
  // for Dangerous mode, else the default sandbox (`resolveNativeBashDcmState`). The typed file tools
  // and Refreshed File Reads both read it.
  function getEffectiveBashBackend(scope: NativeToolsScope = "agent"): NativeExecutionBackend {
    const settings = getNativeToolsSettings(scope);
    const explicitBackend = normalizeNativeExecutionBackend(
      settings.executionBackend ??
        settings.nativeExecutionBackend ??
        settings.bashExecutionBackend ??
        settings.nativeBashExecutionBackend,
    );
    return (
      explicitBackend ??
      (getNativeBashAccessMode(scope) === "dangerous" ? "local" : getDefaultNativeExecutionBackend())
    );
  }

  function getTypedFileToolsUnavailableReason(scope: NativeToolsScope = "agent"): string | null {
    return typedFileToolsUnavailableReason(
      getEffectiveBashBackend(scope),
      toolsHostFacts ?? nativeSandboxStatus?.typedFileToolsHost ?? nativeAppleSandboxStatus?.typedFileToolsHost ?? null,
    );
  }

  // SA-137 Round 2 (R2-2): what the Tools tab says about whether Refreshed File Reads can run for
  // this agent now, from the same rule the route uses. The agent's Zip view is the form's own
  // choice, else the user's global one, so choosing Inline in the same card makes the switch
  // unavailable at once. The saved choice is never touched; it shows again when the reason goes.
  // A host that could not be read never locks the switch: it is a plain note (the server checks
  // again on every turn).
  const refreshedFileReadsAvailability = $derived.by(() => {
    const host =
      toolsHostFacts ??
      nativeSandboxStatus?.typedFileToolsHost ??
      nativeAppleSandboxStatus?.typedFileToolsHost ??
      null;
    const own = zipForm.live_file_reads;
    return agentRefreshedFileReadsAvailability({
      primaryType: basicForm.agentType,
      zipViewMode: resolveZipAiViewModeOf(
        { zip_ai_view_mode: zipForm.zip_ai_view_mode },
        globalZipSettings,
      ),
      backend: getEffectiveBashBackend("agent"),
      host,
      hostCheckFailed: !host && (toolsHostFactsFailed || nativeSandboxStatusError !== null),
      chosenOn: liveFileReadsChosenOn(
        { live_file_reads: own === "enabled" ? true : own === "disabled" ? false : null },
        globalZipSettings,
      ),
    });
  });

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
    // The Default Project Path lives in the project preferences (`project_prefs:<user>`), which
    // the project store holds for the page; user settings never carry it.
    const defaultWorkspacePath = projectStore.getDefaultProjectPath() ?? "";
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

  type CliPairChoice = { owner: string; value: boolean; pending: boolean; reading: boolean; hold: boolean; notice: string; earlierUnknown: boolean };
  let cliPairChoices = $state<Record<string, CliPairChoice>>({});
  function cliPairId(scope: NativeToolsScope) { return selectedEntity?.kind === scope ? scope === 'agent' ? selectedAgentId : selectedEditableSubagentId : null; }
  function cliPairRow(scope: NativeToolsScope, id: string) { return scope === 'agent' ? agents.find(row => row.id === id) : subagents.find(row => row.id === id); }
  function cliPairOwner(scope: NativeToolsScope, row: any) { return JSON.stringify([scope, row?.id, row?.user_id, row?.created_at, scope === 'agent' ? row?.agentType : row?.subagentType]); }
  function cliPairHeld(scope: NativeToolsScope) { const id = cliPairId(scope), pair = id ? cliPairChoices[`${scope}:${id}`] : undefined; return !!id && !!pair && pair.owner === untrack(() => cliPairOwner(scope, cliPairRow(scope, id))) && pair.hold === true; }
  function cliPairBlocked(scope: NativeToolsScope) { const id = cliPairId(scope), pair = id ? cliPairChoices[`${scope}:${id}`] : undefined; return !!id && !!pair && pair.owner === untrack(() => cliPairOwner(scope, cliPairRow(scope, id))) && (pair.hold || pair.pending || pair.reading); }
  function cliPairReady(scope: NativeToolsScope) {
    return scope === 'agent' ? !listLoading && !detailLoading && primaryReadWaitError === null && basicPersistedForm !== null && mcpPersistedSignature !== null
      : !subagentsLoading && !subagentDetailLoading && subagentReadWaitError === null && subagentPersistedForm !== null && subagentMcpPersistedSignature !== null;
  }
  type CliPairSource = { id: string; owner: string; generation: number; row: unknown };
  type CliAckSection = 'basic' | 'mcp';
  type CliAckOperation = { scope: NativeToolsScope; id: string; owner: string; generation: number; body: object; knownSaved: boolean; before: Record<CliAckSection, string> };
  type CliAckOrigin = { operation: CliAckOperation; row: unknown; before: string; after: string };
  const cliAckOrigins = new Map<string, CliAckOrigin>();
  const cliAckKey = (scope: NativeToolsScope, id: string, section: CliAckSection) => JSON.stringify([scope, id, section]);
  function retireCliAckOrigin(scope: NativeToolsScope, id: string | null, section?: CliAckSection) {
    if (!id) return;
    for (const field of section ? [section] : ['basic', 'mcp'] as const) cliAckOrigins.delete(cliAckKey(scope, id, field));
  }
  function cliUnownedProjection(scope: NativeToolsScope, section: CliAckSection) {
    if (section === 'basic') return scope === 'agent'
      ? JSON.stringify(withNativeToolSetting(basicForm, 'cliToolsEnabled', undefined))
      : JSON.stringify(withNativeToolSetting(subagentForm, 'cliToolsEnabled', undefined));
    const dcm = cloneDcmDisplaySettings(scope === 'agent' ? dcmDisplaySettings : subagentDcmDisplaySettings);
    delete dcm.groups[CLI_GROUP_KEY];
    if (dcm.groupDisplayPreferences) delete dcm.groupDisplayPreferences[CLI_GROUP_KEY];
    return makeMcpSignature(scope === 'agent' ? defaultMCPGateways : subagentDefaultMCPGateways,
      scope === 'agent' ? defaultMCPToolSelections : subagentDefaultMCPToolSelections, dcm);
  }
  function cliAckOwnsRebase(scope: NativeToolsScope, section: CliAckSection) {
    const id = cliPairId(scope);
    if (!id) return false;
    const key = cliAckKey(scope, id, section), origin = cliAckOrigins.get(key);
    if (!origin) return false;
    const operation = origin.operation;
    if (!operation.knownSaved || !cliPairCurrent(scope, id, operation.generation, operation.owner, origin.row) ||
      origin.before !== origin.after || cliUnownedProjection(scope, section) !== origin.after) {
      cliAckOrigins.delete(key);
      return false;
    }
    return true;
  }
  function rememberCliAckRebase(operation: CliAckOperation, before: Record<CliAckSection, string>, changesDcm: boolean) {
    for (const section of changesDcm ? ['basic', 'mcp'] as const : ['basic'] as const) {
      const after = cliUnownedProjection(operation.scope, section);
      const key = cliAckKey(operation.scope, operation.id, section);
      // A real unowned edit while the ACK travelled keeps its normal sender.
      if (operation.before[section] === before[section] && before[section] === after) cliAckOrigins.set(key, {
        operation, row: cliPairRow(operation.scope, operation.id), before: before[section], after
      });
      else cliAckOrigins.delete(key);
    }
  }
  function cliPairBusy(scope: NativeToolsScope, id: string) { return scope === 'agent' ? primaryOwnedWritesPending(id) : subagentOwnedWritesPending(id); }
  function cliPairCurrent(scope: NativeToolsScope, id: string, generation: number, owner: string, row: unknown) {
    return settingsPanelAlive && cliPairId(scope) === id && cliPairRow(scope, id) === row && cliPairOwner(scope, cliPairRow(scope, id)) === owner &&
      (scope === 'agent' ? agentHydrationRequestId : subagentReadGeneration) === generation;
  }
  function installCliPair(scope: NativeToolsScope, value: unknown, patch: AgentDcmDisplaySettingsSave | undefined, keepLegacy = false) {
    if (scope === 'agent') {
      basicForm = withNativeToolSetting(basicForm, 'cliToolsEnabled', value);
      if (basicPersistedForm) { basicPersistedForm = withNativeToolSetting(basicPersistedForm, 'cliToolsEnabled', value); basicPersistedSignature = makeBasicSignature(basicPersistedForm); }
      if (patch) {
        dcmDisplaySettings = applyCliDcmPatch(dcmDisplaySettings, readCliDcmPair({ dcmDisplaySettings: patch }));
        if (mcpPersistedValues) mcpPersistedValues = { ...mcpPersistedValues, dcm: keepLegacy ? null : applyCliDcmPatch(mcpPersistedValues.dcm ?? mcpPersistedValues.viewedDcm, patch), viewedDcm: applyCliDcmPatch(mcpPersistedValues.dcm ?? mcpPersistedValues.viewedDcm, patch) };
      }
      if (mcpPersistedValues) mcpPersistedSignature = makeMcpSignature(mcpPersistedValues.gateways, mcpPersistedValues.selections, mcpPersistedValues.dcm ?? mcpPersistedValues.viewedDcm ?? createDefaultDcmDisplaySettings());
    } else {
      subagentForm = withNativeToolSetting(subagentForm, 'cliToolsEnabled', value);
      if (subagentPersistedForm) { subagentPersistedForm = withNativeToolSetting(subagentPersistedForm, 'cliToolsEnabled', value); subagentPersistedSignature = makeSubagentFormSignature(subagentPersistedForm); }
      if (patch) {
        subagentDcmDisplaySettings = applyCliDcmPatch(subagentDcmDisplaySettings, readCliDcmPair({ dcmDisplaySettings: patch }));
        if (subagentMcpPersistedValues) subagentMcpPersistedValues = { ...subagentMcpPersistedValues, dcm: keepLegacy ? null : applyCliDcmPatch(subagentMcpPersistedValues.dcm ?? subagentMcpPersistedValues.viewedDcm, patch), viewedDcm: applyCliDcmPatch(subagentMcpPersistedValues.dcm ?? subagentMcpPersistedValues.viewedDcm, patch) };
      }
      if (subagentMcpPersistedValues) subagentMcpPersistedSignature = makeMcpSignature(subagentMcpPersistedValues.gateways, subagentMcpPersistedValues.selections, subagentMcpPersistedValues.dcm ?? subagentMcpPersistedValues.viewedDcm ?? createDefaultDcmDisplaySettings());
    }
  }
  function updateCliPairCache(scope: NativeToolsScope, id: string, value: unknown, patch?: AgentDcmDisplaySettingsSave, legacyRead = false) {
    const native = { nativeTools: { cliToolsEnabled: value ?? null } };
    if (scope === 'agent') { const row = cliPairRow(scope, id); updateAgentCollections(id, { provider_specific_settings: native, ...(patch ? legacyRead ? { dcm_display_settings: applyCliDcmPatch((row as any)?.dcm_display_settings, patch) } : { dcmDisplaySettings: patch } : {}) } as AgentCollectionsUpdate); }
    else {
      const row = subagents.find(row => row.id === id);
      if (!row) return;
      const next = { ...row, provider_specific_settings: applyAgentProviderSettingsUpdate(row.provider_specific_settings, native), ...(patch ? legacyRead ? { dcm_display_settings: applyCliDcmPatch((row as any).dcm_display_settings, patch) } : { dcmDisplaySettings: applyCliDcmPatch(row.dcmDisplaySettings ?? (row as any).dcm_display_settings, patch) } : {}) };
      subagentStore.acceptServerRecord(next);
      const accepted = subagentStore.subagents.find(row => row.id === id) ?? next;
      subagents = subagents.map(row => row.id === id ? accepted : row);
    }
  }
  async function chooseCliPair(scope: NativeToolsScope, value: boolean, companion: AgentDcmDisplaySettingsSave | undefined, source: CliPairSource) {
    const id = cliPairId(scope), row = id ? cliPairRow(scope, id) : null;
    if (!id || !row || source.id !== id || !cliPairCurrent(scope, source.id, source.generation, source.owner, source.row) || !cliPairReady(scope) || cliPairBusy(scope, id) || cliPairHeld(scope)) return;
    if (scope === 'agent') requirePrimaryCaptureReady(); else requireSubagentCaptureReady();
    retireCliAckOrigin(scope, id);
    const owner = cliPairOwner(scope, row), generation = scope === 'agent' ? agentHydrationRequestId : subagentReadGeneration;
    const baseline = scope === 'agent' ? mcpPersistedValues : subagentMcpPersistedValues;
    const patch = value ? captureCliDcmWrite({ ...row, ...(baseline?.dcm === null && baseline.viewedDcm ? { dcmDisplaySettings: null, dcm_display_settings: baseline.viewedDcm } : {}) }, companion) : undefined;
    const body = $state.snapshot({ provider_specific_settings: { nativeTools: { cliToolsEnabled: value } }, ...(patch ? { dcmDisplaySettings: patch } : {}) });
    const operation: CliAckOperation = { scope, id, owner, generation, body, knownSaved: false, before: { basic: cliUnownedProjection(scope, 'basic'), mcp: cliUnownedProjection(scope, 'mcp') } };
    const key = `${scope}:${id}`;
    cliPairChoices = { ...cliPairChoices, [key]: { owner, value, pending: true, reading: false, hold: false, notice: '', earlierUnknown: cliPairChoices[key]?.earlierUnknown ?? false } };
    const choice = cliPairChoices[key];
    await (scope === 'agent' ? mcpSaves : subagentMcpSaves).run(id, async () => {
      try {
        const response = await fetch(`/api/${scope === 'agent' ? 'agents' : 'subagents'}/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const answer = await response.json().catch(() => null);
        const known = response.ok && (scope === 'agent' ? answer?.success === true : answer?.subagent && cliPairOwner(scope, answer.subagent) === owner);
        if (!known) throw new Error('This CLI Tools choice is unconfirmed. Your draft is kept.');
        const returnedPair = scope === 'subagent' ? readCliDcmPair(answer.subagent) : body.dcmDisplaySettings;
        const returnedValue = scope === 'subagent' ? readCliNativeChoice(answer.subagent) : value;
        if (returnedValue != null && parseBooleanSetting(returnedValue) === null) throw new Error('The saved CLI Tools readback is unavailable. Your draft is kept.');
        const keepLegacy = scope === 'subagent' && answer.subagent.dcmDisplaySettings == null && answer.subagent.dcm_display_settings != null;
        untrack(() => {
          const current = cliPairCurrent(scope, id, generation, owner, row);
          if (current) {
            const before = { basic: cliUnownedProjection(scope, 'basic'), mcp: cliUnownedProjection(scope, 'mcp') };
            installCliPair(scope, returnedValue, returnedPair, keepLegacy);
            updateCliPairCache(scope, id, returnedValue, returnedPair, keepLegacy);
            operation.knownSaved = true;
            rememberCliAckRebase(operation, before, returnedPair !== undefined);
          }
          // A newer accepted source keeps its forms/cache; request a current detail read.
          if (!current && cliPairId(scope) === id) {
            if (scope === 'agent') setAgentReadDeferred(true); else setSubagentReadDeferred(true);
          }
          if (cliPairChoices[key] === choice) delete cliPairChoices[key];
        });
      } catch (error) {
        choice.hold = true; choice.earlierUnknown = true;
        choice.notice = error instanceof Error ? error.message : 'This CLI Tools choice is unconfirmed. Your draft is kept.';
      } finally { choice.pending = false; }
    });
  }
  async function readCliPair(scope: NativeToolsScope, source: CliPairSource) {
    const id = cliPairId(scope), key = `${scope}:${id}`, choice = cliPairChoices[key];
    if (!id || !choice || source.id !== id || !cliPairCurrent(scope, source.id, source.generation, source.owner, source.row) || choice.owner !== source.owner || !cliPairReady(scope) || choice.pending || choice.reading || cliPairBusy(scope, id)) return;
    retireCliAckOrigin(scope, id);
    const generation = scope === 'agent' ? agentHydrationRequestId : subagentReadGeneration;
    choice.reading = true;
    await (scope === 'agent' ? mcpSaves : subagentMcpSaves).run(id, async () => {
      try {
        const response = await fetch(`/api/${scope === 'agent' ? 'agents' : 'subagents'}/${encodeURIComponent(id)}`, { cache: 'no-store' });
        const payload = await response.json();
        const record = scope === 'agent' ? payload : payload?.subagent;
        if (!response.ok || cliPairOwner(scope, record) !== choice.owner) throw new Error('The saved CLI Tools choice could not be read. Your draft is kept.');
        const patch = readCliDcmPair(record), value = readCliNativeChoice(record);
        if (!cliPairCurrent(scope, id, generation, choice.owner, source.row) || cliPairChoices[key] !== choice) return;
        untrack(() => { installCliPair(scope, value, patch, record.dcmDisplaySettings == null && record.dcm_display_settings != null); updateCliPairCache(scope, id, value, patch, record.dcmDisplaySettings == null && record.dcm_display_settings != null); choice.hold = false; choice.notice = 'An earlier save remains unconfirmed. Current saved choices are shown.'; });
      } catch (error) { choice.hold = true; choice.notice = error instanceof Error ? error.message : 'The saved CLI Tools choice could not be read. Your draft is kept.'; }
      finally { choice.reading = false; }
    });
  }

  function getToolGridEnableControl(id: string, scope: NativeToolsScope = "agent"): ToolGridEnableControl | null {
    const fields: Record<string, string> = { bash: 'bashEnabled', web_search: 'webSearchEnabled', agent_browser_actions: 'agentBrowserEnabled', artifact_find: 'artifactRuntimeEnabled', fabric_find: 'batshitToolsEnabled', typed_file_tools: TYPED_FILE_TOOLS_AGENT_FIELD, mcp_tools: 'dynamicMcpEnabled', cli_tools: 'cliToolsEnabled' };
    const field = fields[id];
    if (!field) return null;
    const gate = id === 'bash' ? 'bash' : id === 'web_search' ? 'web-search' : id === 'fabric_find' ? 'fabric' : null;
    const available = !gate || isNativeToolUiAvailable(gate, scope);
    const typed = id === 'typed_file_tools';
    const typedInfo = typedToolsInfo(scope);
    const note = id === 'fabric_find' && scope === 'subagent' ? getNativeToolUiUnavailableMessage('fabric', scope) : typed ? [typedInfo.notice, getTypedFileToolsUnavailableReason(scope), !getNativeToolToggle('bashEnabled', true, scope) ? 'Typed File Tools also needs Bash enabled.' : null].filter(Boolean).join(' ') : gate && !available ? getNativeToolUiUnavailableMessage(gate, scope) : null;
    const choice = (value: boolean) => {
      if (!available || cliPairHeld(scope) || id === 'fabric_find' && scope === 'subagent') return;
      retireCliAckOrigin(scope, cliPairId(scope), 'basic');
      if (scope === 'agent') basicSaveScope = 'tools'; else subagentSaveScope = 'tools';
      updateNativeToolSetting(field, value, scope);
    };
    const cliId = cliPairId(scope), cliOwner = cliId ? cliPairOwner(scope, cliPairRow(scope, cliId)) : '';
    const pair = cliId && cliPairChoices[`${scope}:${cliId}`]?.owner === cliOwner ? cliPairChoices[`${scope}:${cliId}`] : undefined;
    const cliSource = { id: cliId ?? '', owner: cliOwner, row: cliId ? cliPairRow(scope, cliId) : undefined, generation: scope === 'agent' ? agentHydrationRequestId : subagentReadGeneration };
    return {
      ...(id === 'cli_tools' && pair && (pair.pending || pair.hold) ? { draftChecked: pair.value } : {}),
      checked: id === 'fabric_find' && scope === 'subagent' ? false : typed ? getTypedFileToolsValue(scope) === true : getNativeToolToggle(field, id === 'artifact_find' ? getNativeToolToggle('batshitToolsEnabled', true, scope) : true, scope),
      disabled: id === 'fabric_find' && scope === 'subagent' || !available || cliPairHeld(scope) || id === 'cli_tools' && (!cliPairReady(scope) || !!cliId && cliPairBusy(scope, cliId)) || typed && (typedInfo.blocked || !getNativeToolToggle('bashEnabled', true, scope) || !!getTypedFileToolsUnavailableReason(scope)),
      notice: id === 'cli_tools' && pair ? pair.notice : note,
      ...(id === 'cli_tools' && pair ? { onRead: () => void readCliPair(scope, cliSource), reading: pair.pending || pair.reading } : {}),
      onChange: id === 'cli_tools' ? (value, companion) => void chooseCliPair(scope, value, companion, cliSource) : scope === 'agent' ? guardPrimaryChoice(choice) : guardSubagentChoice(choice),
      ...(typed ? { onRead: () => void useSavedTypedTools(scope), reading: typedInfo.reloading } : {})
    };
  }

  function updateNativeToolSetting(
    key: string,
    value: unknown,
    scope: NativeToolsScope = "agent",
  ) {
    untrack(() => {
      if (key === TYPED_FILE_TOOLS_AGENT_FIELD) {
        const id = scope === 'agent' ? selectedAgentId : selectedEditableSubagentId;
        if (id) typedToolsSave(scope, id).generation += 1;
      }
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

  const toolApprovalEligible = $derived(
    isApiPrimaryAgentType(basicForm.agentType),
  );

  let isUploadingAgentAvatar = $state(false);
  let agentAvatarUploadRequestId = 0;
  let agentAvatarError = $state<string | null>(null);

  let subagents = $state<SubagentRow[]>([]);
  let selectedEditableSubagentId = $state<string | null>(null);
  let selectedSubagentModelId = $state<string | null>(null);

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
      // SA-139 R6 (D16): one Subagent kind. This menu mixes Primary Agents and Subagents, so a
      // Subagent row carries the role label, never a type label, as a Primary row does (R3).
      badgeLabel: "Subagent",
      disabledReason: null,
    })),
  );

  const combinedAgentSections = $derived<MegaAgentSection[]>([
    {
      heading: "Primary Agents",
      // SA-139 R3: one Primary concept. This menu mixes Primary Agents and Subagents, so a
      // Primary row carries the role label, never an API/CLI type label (decision 16).
      items: primaryAgentOptions.map((agent) => ({
        ...agent,
        id: `agent:${agent.id}`,
        badgeLabel: "Primary Agent",
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
    subagentType: "api",
    specialty: "general",
    include_global_prompt: false,
    system_prompt: "",
    primary_model_provider: "",
    primary_model_name: "",
    primary_model_preset_id: "",
    primary_model_connection: null,
    timeout_seconds: "",
    max_tool_steps: "",
    avatar: null,
    avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
    avatar_icon_fit: "fill",
    provider_specific_settings: null,
  });

  /**
   * SA-139 R5 (D14): the refusal for a stored Subagent of a removed type (a Claude Code CLI or
   * Codex CLI Subagent), or null for a live one. Such a leftover opens showing only its identity,
   * this line and its Delete; validation refuses every save of it, so opening or editing it
   * writes nothing (the leftover Primary's R4 rule).
   */
  const retiredSubagentDetails = $derived.by(() =>
    isRetiredSubagentType(subagentForm.subagentType)
      ? retiredSubagentTypeSentences(subagentForm.subagentType, subagentForm).details
      : null,
  );

  let subagentPersistedSignature = $state<string | null>(null);
  /**
   * BL-844: the Subagent form as it was loaded or last saved. A save sends only the fields that
   * differ from it (`buildSubagentSettingsSavePatch`), so a copy of the Subagent that another tab,
   * window, or agent tool has since changed is never written back over that change. Not reactive,
   * like `basicPersistedForm`: it is set and cleared beside `subagentPersistedSignature`.
   */
  let subagentPersistedForm: SubagentForm | null = null;
  /**
   * BL-914: the Subagent's Tool Grid values as they were loaded or last saved, the twin of the
   * Primary Agent's `mcpPersistedValues`. The Subagent PUT writes those blocks key by key, so the
   * section save sends only what differs from its copy (`diffMcpSection`), a dropped key as
   * `null`. A plain variable, not `$state`: set at select and at the list-effect hydrate, moved
   * after a successful save, cleared at both resets, left as it is by a failed save; an effect
   * that reads it does not depend on it. (SA-139 R5 removed the CLI Subagent's Claude block
   * section and its copies.)
   */
  let subagentMcpPersistedValues: McpSectionValues | null = null;
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
  let subagentDetailLoading = $state(false);
  let subagentReadDeferredUi = $state(false);
  let subagentOwnedSaveInFlightUi = $state(false);
  let subagentOwnedWritePendingUi = $state(false);
  type SubagentCaptureSection = "core" | "mcp";
  const subagentDeferredCaptures = new Map<string, Set<SubagentCaptureSection>>();
  const subagentCaptureWake = $state({ core: 0, mcp: 0 });
  let subagentSaveWaitExpiredUi = $state(false);
  let subagentReadWaitError = $state<string | null>(null);
  const subagentSettingsReadWaiting = $derived(subagentDetailLoading || subagentReadDeferredUi || subagentReadWaitError !== null || subagentSaveWaitExpiredUi || subagentOwnedSaveInFlightUi);
  const subagentDeferredDraftOnly = $derived.by(() => subagentReadDeferredUi && !subagentDetailLoading && subagentReadWaitError === null &&
    !subagentSaveWaitExpiredUi && !subagentOwnedWritePendingUi && !subagentOwnedSaveInFlightUi && subagentModelSelectionNotice === null &&
    ![subagentEditSaveError, subagentAvatarError].some(Boolean) &&
    Object.values(subagentSectionsAtRest()).some(atRest => !atRest));
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
    include_global_prompt: boolean;
    subagentType: SubagentType;
    // SA-139 R5: a new Subagent never takes the old `claude-code` specialty (a stored value only).
    specialty: Exclude<SubagentForm["specialty"], "claude-code">;
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
    include_global_prompt: true,
    subagentType: "api",
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
      include_global_prompt: true,
      subagentType: "api",
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
          // SA-139 R4 (D14): a new Primary Agent is always an API agent.
          agentType: "api",
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

        const created = await subagentStore.create({
          id: generatedSlug,
          displayName: name,
          subagentType: createEntityForm.subagentType,
          specialty: createEntityForm.specialty,
          include_global_prompt: false,
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
    // SA-139 R5: only a leftover CLI Subagent has a managed CLI settings folder; the server's
    // delete removes it with the record.
    const confirmed = await confirmDialog({
      title: `Delete ${label}?`,
      description: isCliSubagentType(subagentForm.subagentType)
        ? "It will be unassigned from every Primary Agent, and its settings, avatar pictures, and managed CLI settings folder will be removed. Chat history stays intact."
        : "It will be unassigned from every Primary Agent, and its settings and avatar pictures will be removed. Chat history stays intact.",
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
    window.addEventListener("focus", refreshVisibleVoiceCatalog);
    voiceCatalogRefreshTimer = setInterval(refreshVisibleVoiceCatalog, 60 * 60_000);
    window.addEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, handleSlashCommandsUpdated);
    window.addEventListener(
      LIVE_SETTINGS_EVENTS.localAiSettingsUpdated,
      handleLocalAiSettingsUpdated,
    );
    stopAgentSettingsEvents = onUserChannelEvent(handleAgentSettingsEvent);
    await Promise.all([
      loadAgents(),
      loadProjectsForDefaults(),
    ]);
    void loadGoons();
    void refreshModelPickerData();
    void loadWebSearchProviderAvailability();
    void loadAgentBrowserRuntimeStatus();
    void loadNativeSandboxStatus();
    void loadToolsHostFacts();
    void loadVoiceProfiles();
    void loadVoiceProviders();
    void loadInputDevices();
    if (data?.user?.id) {
      subagentStore.init(data.user.id);
      subagentsLoading = true;
      await subagentStore.load();
      subagentsLoading = false;
    }
    if (savedModelsRead) await savedModelsRead;
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
    window.removeEventListener("focus", refreshVisibleVoiceCatalog);
    if (voiceCatalogRefreshTimer) clearInterval(voiceCatalogRefreshTimer);
    cliAckOrigins.clear();
    accessResourcesGeneration += 1;
    window.removeEventListener(LIVE_SETTINGS_EVENTS.slashCommandsUpdated, handleSlashCommandsUpdated);
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
    // BL-1871: the loader reads its own loading/loaded flags (b34b0e201). Tracked here, a failed read
    // (the store now throws) flipped the loading flag back and re-ran this effect without end.
    untrack(() => void loadAccessResources());
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
            subagentType: "api",
            specialty: "general",
            include_global_prompt: false,
            system_prompt: "",
            primary_model_provider: "",
            primary_model_name: "",
            primary_model_preset_id: "",
            primary_model_connection: null,
            timeout_seconds: "",
            max_tool_steps: "",
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
          subagentType: "api",
          specialty: "general",
          include_global_prompt: false,
          system_prompt: "",
          primary_model_provider: "",
          primary_model_name: "",
          primary_model_preset_id: "",
          primary_model_connection: null,
          timeout_seconds: "",
          max_tool_steps: "",
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

      // BL-915: the core section (not the Tool Grid), only while at rest.
      untrack(() => {
        readSubagentSections(current, false, false);
        // Hydration preserves headerless instruction drafts; its picker sync must
        // not subscribe this cache effect to the form object it just replaced.
        syncSelectedModelFromSubagent();
      });
    });

  async function loadAgents() {
    const reasoningReads = captureAgentReasoningReads();
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
      for (const agent of loadedAgents) agent.model_reasoning_overrides = preserveNewerReasoningLeaves(
        agent.id, agent.model_reasoning_overrides, agentStore.getAgentById(agent.id)?.model_reasoning_overrides,
        reasoningReads.get(agent.id) ?? 0);

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
    return [basicSaves, promptSaves, zipSaves, mcpSaves, cliToolSaves, assignmentSaves];
  }

  function subagentSavers() {
    return [subagentCoreSaves, subagentMcpSaves, subagentCliToolSaves];
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

  function syncPrimarySaveWaits() { syncSaveWaits("agent"); resumeDeferredCaptures(); tryModelSelectionReadbacks(); tryInstructionsReadbacks(); tryAutoCompactReadback(); tryMemoryReadback(); tryTtsReadback(); }
  function syncSubagentSaveWaits() { syncSaveWaits("subagent"); resumeDeferredCaptures(); tryModelSelectionReadbacks(); tryInstructionsReadbacks(); }

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

  async function hydrateSubagent(id: string, admit?: () => boolean, takeSavedModel = false, takeSavedInstructions = false, takeSavedTypedTools = false) {
    const typedGeneration = typedToolsSave('subagent', id).generation;
    const cleanTyped = !subagentPersistedForm || typedFileToolsBodyValue(subagentForm) === typedFileToolsBodyValue(subagentPersistedForm);
    const modelGeneration = modelSelectionSave('subagent', id).generation;
    const instructionsGeneration = instructionsSave('subagent', id).generation;
    retireCliAckOrigin("subagent", id);
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
      const typedBaseline = captureTypedFileToolsBaseline('subagent', id, record, response.headers.get(TYPED_FILE_TOOLS_REVISION_HEADER));
      const modelBaseline = captureModelSelectionBaseline('subagent', record as unknown as Record<string, unknown>, response.headers.get(MODEL_SELECTION_REVISION_HEADER));
      const instructionsBaseline = captureInstructionsBaseline('subagent', record as unknown as Record<string, unknown>, response.headers.get(INSTRUCTIONS_REVISION_HEADER));
      if (typedGeneration !== typedToolsSave('subagent', id).generation) { setSubagentReadDeferred(true); return; }
      if (!settingsPanelAlive || requestId !== subagentReadRequestId || selectedEntity?.kind !== "subagent" || selectedEditableSubagentId !== id || admit && !admit() || modelGeneration !== modelSelectionSave('subagent', id).generation || instructionsGeneration !== instructionsSave('subagent', id).generation) return;
      untrack(() => {
        const canAdoptModel = !subagentCoreSaves.busy(id) && (takeSavedModel || Boolean(subagentPersistedForm && sameModelSelection('subagent', subagentForm, subagentPersistedForm)));
        const cleanPrompt = !subagentCoreSaves.busy(id) && (takeSavedInstructions || subagentForm.system_prompt === subagentPersistedForm?.system_prompt);
        const cleanInclude = !subagentCoreSaves.busy(id) && (takeSavedInstructions || subagentForm.include_global_prompt === subagentPersistedForm?.include_global_prompt);
        subagentStore.acceptServerRecord(record);
        subagents = subagents.map((existing) => existing.id === id ? record : existing);
        readSubagentSections(record, false, true);
        adoptModelSelectionRead('subagent', record, modelBaseline, canAdoptModel);
        adoptInstructionsRead('subagent', record, instructionsBaseline, cleanPrompt, cleanInclude, takeSavedInstructions);
        adoptTypedToolsRead('subagent', record, typedBaseline, cleanTyped, takeSavedTypedTools);
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
        tryModelSelectionReadbacks();
        tryInstructionsReadbacks();
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
    return [basicSaves, promptSaves, zipSaves, mcpSaves, cliToolSaves,
      assignmentSaves].some((saver) => saver.busy(id));
  }

  function subagentOwnedWritesPending(id: string) {
    return [subagentCoreSaves, subagentMcpSaves, subagentCliToolSaves].some((saver) => saver.busy(id));
  }

  function guardPrimaryChoice<T extends (...args: any[]) => any>(callback: T, cliShared = false): T {
    return ((...args: Parameters<T>) => {
      if (primaryOwnedSaveInFlightUi || cliShared && cliPairHeld("agent")) return;
      return callback(...args);
    }) as T;
  }

  function guardSubagentChoice<T extends (...args: any[]) => any>(callback: T, cliShared = false): T {
    return ((...args: Parameters<T>) => {
      if (subagentOwnedSaveInFlightUi || cliShared && cliPairHeld("subagent")) return;
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

  async function hydrateAgent(agentId: string, admit?: () => boolean, quietReadback = false, takeSavedModel = false, takeSavedInstructions = false, takeSavedAutoCompact = false, takeSavedTts = false, takeSavedMcp = false, takeSavedTypedTools = false) {
    const typedGeneration = typedToolsSave('agent', agentId).generation;
    const cleanTyped = !basicPersistedForm || typedFileToolsBodyValue(basicForm) === typedFileToolsBodyValue(basicPersistedForm);
    const mcpReadVersion = primaryMcpVersions.get(agentId) ?? 0;
    const ttsGeneration = ttsSave(agentId).generation;
    const compactGeneration = autoCompactSave(agentId).generation;
    const modelGeneration = modelSelectionSave('agent', agentId).generation;
    const instructionsGeneration = instructionsSave('agent', agentId).generation;
    const reasoningRead = agentReasoningReadGeneration(agentId);
    quietReadback = !detailLoading && quietReadback;
    retireCliAckOrigin("agent", agentId);
    const requestId = ++agentHydrationRequestId;
    syncPrimarySaveWaits();
    primaryReadWaitError = null;
    if (primaryReadTimer) clearTimeout(primaryReadTimer);
    primaryReadTimer = quietReadback ? null : setTimeout(() => {
      if (settingsPanelAlive && requestId === agentHydrationRequestId && selectedEntity?.kind === "agent" && selectedAgentId === agentId) {
        primaryReadWaitError = "These settings did not load within 30 seconds. Retry reads the record.";
      }
    }, SETTINGS_WAIT_MS);
    // BL-912: this read shows what the record holds now; a section it leaves alone asks again.
    setAgentReadDeferred(false);
    if (!quietReadback) { detailLoading = true; hydrationInProgress = true; }
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
      const modelBaseline = captureModelSelectionBaseline('agent', agent as unknown as Record<string, unknown>, response.headers.get(MODEL_SELECTION_REVISION_HEADER));
      const instructionsBaseline = captureInstructionsBaseline('agent', agent as unknown as Record<string, unknown>, response.headers.get(INSTRUCTIONS_REVISION_HEADER));
      const compactBaseline = captureAutoCompactBaseline(agent as unknown as Record<string, unknown>, response.headers.get(AUTO_COMPACT_REVISION_HEADER));
      const ttsBaseline = captureConfiguredTtsBaseline(agent as unknown as Record<string, unknown>, response.headers.get(CONFIGURED_TTS_REVISION_HEADER));
      const typedBaseline = captureTypedFileToolsBaseline('agent', agentId, agent, response.headers.get(TYPED_FILE_TOOLS_REVISION_HEADER));
      const incomingMcpBase = readMcpSettingsRevisions(response.headers.get(MCP_SETTINGS_REVISION_HEADER));

      const currentSubagents = await fetchAgentSubagents(agentId);
      if (!settingsPanelAlive || requestId !== agentHydrationRequestId || selectedAgentId !== agentId || selectedEntity?.kind !== "agent" || selectedEntity.id !== agentId || admit && !admit()) {
        return;
      }
      if (typedGeneration !== typedToolsSave('agent', agentId).generation) { setAgentReadDeferred(true); return; }
      if (mcpReadVersion !== (primaryMcpVersions.get(agentId) ?? 0)) { setAgentReadDeferred(true); return; }
      if (modelGeneration !== modelSelectionSave('agent', agentId).generation) { setAgentReadDeferred(true); return; }
      if (instructionsGeneration !== instructionsSave('agent', agentId).generation) { setAgentReadDeferred(true); return; }
      if (compactGeneration !== autoCompactSave(agentId).generation) { autoCompactReadbacks.add(agentId); setAgentReadDeferred(true); return; }
      if (ttsGeneration !== ttsSave(agentId).generation) { ttsReadbacks.add(agentId); setAgentReadDeferred(true); return; }

      // Explicit recovery replaces BOTH guarded sections from this one owned read.
      // A partial header must not pair new form values with an old baseline.
      const canTakeSavedMcp = takeSavedMcp && !mcpSaves.busy(agentId) && !zipSaves.busy(agentId) &&
        ['defaultMCPGateways', 'defaultMCPToolSelections', 'custom_tool_settings'].every(field =>
          Boolean(incomingMcpBase?.[field as keyof ExpectedMcpSettings]));
      untrack(() => {
        if (takeSavedMcp && !canTakeSavedMcp) {
          const message = 'Saved Tool Settings could not be read completely. Your draft is kept; retry Use Saved Tool Settings.';
          mcpSaveError = message;
          zipSaveError = message;
        }
        agents = agents.map((existing) =>
          existing.id === agent.id ? agent : existing,
        );
        agent.model_reasoning_overrides = preserveNewerReasoningLeaves(agent.id, agent.model_reasoning_overrides,
          agentStore.getAgentById(agent.id)?.model_reasoning_overrides, reasoningRead);
        agentStore.updateAgent(agent.id, mapToStoreAgent(agent));

        // BL-912, BL-942: a read of another agent (a first open, a pick, a delete fallback, the
        // prop naming another agent) fills every section. A read of the agent the forms already
        // hold replaces a section only while it is at rest: its form equals its baseline and no
        // save of it is queued or on its way. A section that is not at rest keeps what it shows
        // (an edit, typed text, a failed save and its error line), and the panel reads again
        // when it comes to rest.
        const fill = hydratedAgentId !== agentId;
        const cleanTts = fill || Boolean(basicPersistedForm && sameTtsForm(basicForm.voice_profile, basicPersistedForm.voice_profile));
        const cleanCompactCommon = fill || Boolean(basicPersistedForm && sameAutoCompactCommon(basicForm.auto_compact_settings, basicPersistedForm.auto_compact_settings));
        const cleanCompactAdvanced = fill || Boolean(basicPersistedForm && ['modelMode', 'modelPresetId', 'promptMode', 'prompt'].every(field =>
          basicForm.auto_compact_settings[field as keyof AgentAutoCompactSettings] === basicPersistedForm!.auto_compact_settings[field as keyof AgentAutoCompactSettings]));
        const cleanInstructionsPrompt = !promptSaves.busy(agentId);
        const cleanInstructionsInclude = !basicSaves.busy(agentId) && (fill || takeSavedInstructions || basicForm.include_global_prompt === basicPersistedForm?.include_global_prompt);
        const canAdoptModel = !basicSaves.busy(agentId) && (fill || takeSavedModel || Boolean(basicPersistedForm && sameModelSelection('agent', basicForm, basicPersistedForm)));
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
          memoryConflictNeedsRetry = rebaseBusyBasicSection(agent, conflict?.base ?? null) && conflict !== null;
        } else if (conflict) {
          // A save of the section is queued or on its way: it carries its own baseline and meets the
          // same check, so this read leaves the section to it and keeps the refused save's baseline.
          memoryConflictBase = conflict;
        }
        adoptAutoCompactRead(agent, compactBaseline, cleanCompactCommon, cleanCompactAdvanced, takeSavedAutoCompact);
        adoptTtsRead(agent, ttsBaseline, cleanTts, takeSavedTts);
        adoptTypedToolsRead('agent', agent, typedBaseline, cleanTyped, takeSavedTypedTools);
        adoptModelSelectionRead('agent', agent, modelBaseline, canAdoptModel);

        if (replaces("prompt")) {
          promptValue = agent.system_prompt ?? "";
          promptPersistedSignature = promptValue;
        }
        adoptInstructionsRead('agent', agent, instructionsBaseline, cleanInstructionsPrompt, cleanInstructionsInclude, takeSavedInstructions);

        if (takeSavedMcp ? canTakeSavedMcp : replaces("zip") && !primaryMcpHolds[agentId]) {
          if (incomingMcpBase?.custom_tool_settings) primaryMcpBases = { ...primaryMcpBases, [agentId]: { ...primaryMcpBases[agentId], custom_tool_settings: incomingMcpBase.custom_tool_settings } };
          zipForm = normaliseZipForm(agent);
          zipPersistedSignature = makeZipSignature(zipForm);
          syncCustomToolOverridesFromGlobal();
          // After the sync: it adds the global tools as empty rows and may reorder them, which the
          // save does not see, so opening compares equal and saves nothing.
          zipPersistedPayload = zipPayloadForSave(buildZipPayload(zipForm));
          zipSaveError = null;
        }

        if (takeSavedMcp ? canTakeSavedMcp : replaces("toolGrid") && !primaryMcpHolds[agentId]) {
          if (incomingMcpBase) primaryMcpBases = { ...primaryMcpBases, [agentId]: { ...primaryMcpBases[agentId], defaultMCPGateways: incomingMcpBase.defaultMCPGateways, defaultMCPToolSelections: incomingMcpBase.defaultMCPToolSelections } };
          if (takeSavedMcp) { const holds = { ...primaryMcpHolds }; delete holds[agentId]; primaryMcpHolds = holds; }
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
            viewedDcm: cloneDcmDisplaySettings(dcmDisplaySettings),
            gateways: [...mcpDefaults.gateways],
            selections: cloneToolSelections(mcpDefaults.selections),
            dcm:
              agent.dcmDisplaySettings == null && (agent as any).dcm_display_settings != null
                ? null
                : cloneDcmDisplaySettings(mcpDefaults.dcmDisplaySettings),
          };
          mcpRenderNonce = mcpRenderNonce + 1;
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
        // A failed quiet readback leaves the read-wait notice alone; the toast reports it.
        if (!(quietReadback && hydratedAgentId === agentId)) primaryReadWaitError = error instanceof Error ? error.message : "Failed to load agent details";
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
        if (!quietReadback) { hydrationInProgress = false; detailLoading = false; }
        tryModelSelectionReadbacks();
        tryInstructionsReadbacks();
        tryAutoCompactReadback();
        tryTtsReadback();
        tryMemoryReadback();
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

  async function loadToolsHostFacts() {
    try {
      toolsHostFacts = await fetchToolsHostFacts();
      toolsHostFactsFailed = false;
    } catch (error) {
      console.warn(
        "[AgentSettings] Could not read the host facts alone; the Tools card waits for the full sandbox status, and Refreshed File Reads stays usable:",
        error,
      );
      toolsHostFactsFailed = true;
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

  function loadSavedModelsForPanel(): Promise<void> {
    if (savedModelsRead) return savedModelsRead;
    const read = readSavedModelsForPanel();
    savedModelsRead = read;
    void read.finally(() => { if (savedModelsRead === read) savedModelsRead = null; });
    return read;
  }

  async function readSavedModelsForPanel() {
    const read = savedModelsStore.beginSavedModelsRead();
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
        : payload?.models;
      if (!settingsPanelAlive || !read.install(models)) return;
      savedModels = models;
    } catch (error) {
      if (!settingsPanelAlive || !read.current()) return;
      read.fail("Saved models could not be loaded. The last good list is retained.");
      console.error("Failed to load saved models:", error);
      savedModelsError =
        error instanceof Error ? error.message : "Failed to load saved models";
    } finally {
      read.finish();
      savedModelsLoading = false;
      syncSelectedModelFromAgent();
      syncSelectedModelFromSubagent();
    }
  }

  async function refreshModelPickerData() {
    const tasks: Promise<unknown>[] = [loadSavedModelsForPanel()];
    if (isApiPrimaryAgentType(basicForm.agentType)) {
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
    if (voiceProvidersLoading || !settingsPanelAlive) return;
    voiceProvidersLoading = true;
    voiceProvidersError = null;

    try {
      const response = await fetch("/api/voice/providers?catalog=refresh");
      if (!response.ok) {
        const message = await extractError(
          response,
          "Failed to load voice providers",
        );
        throw new Error(message);
      }

      const payload = await response.json();
      if (settingsPanelAlive) voiceProviders = readVoiceProviderEnvelope(payload);
    } catch (error) {
      console.error("Failed to load voice providers:", error);
      if (settingsPanelAlive) voiceProvidersError =
        error instanceof Error ? error.message : "Failed to load voice providers";
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
    if (!isApiPrimaryAgentType(agentTypeAtRequest)) return;
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
      const connections = payload?.data?.connections;
      if (!Array.isArray(connections) || connections.some((option) =>
        !option || typeof option !== 'object' || Array.isArray(option) ||
        typeof option.id !== 'string' || !option.id.trim() ||
        (option.status !== 'ready' && option.status !== 'locked')
      )) {
        throw new Error('Connection status could not be read. Refresh Saved Models to retry.');
      }
      modelConnectionOptions = connections;
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
    if (!isApiPrimaryAgentType(primaryTypeForConnectionOptions)) return;
    untrack(() => {
      void loadModelConnectionOptionsForPanel();
    });
  });

  function handleLocalAiSettingsUpdated() {
    if (!isApiPrimaryAgentType(basicForm.agentType)) return;
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
      match = findSettingsVoicePresetFallback(savedModels, basicForm);
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
        agentType: getPrimaryToolHostScope(),
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
    const picked = buildPickedPresetSelection(model);
    basicForm = {
      ...basicForm,
      ...picked,
      provider_specific_settings: withAgentModelKeys(picked.provider_specific_settings),
    };
  }

  type ModelClearFormView = { [Key in keyof BasicForm]: BasicForm[Key] } | { [Key in keyof SubagentSaveForm]: SubagentSaveForm[Key] };

  function clearAgentModelSelection() {
    selectedModelId = null;
    const source: ModelClearFormView = basicForm;
    const clear = buildClearedPresetSelection('agent', source);
    basicForm = {
      ...basicForm,
      ...clear,
      ...(clear.provider_specific_settings ? { provider_specific_settings: withAgentModelKeys(null) } : {}),
    };
  }
  function modelClearEligibility(kind: ModelSelectionKind) {
    try {
      const form: ModelClearFormView = kind === 'agent' ? basicForm : subagentForm;
      const draft = buildClearedPresetSelection(kind, form);
      const persisted = kind === 'agent' ? basicPersistedForm : subagentPersistedForm;
      if (persisted && sameModelSelection(kind, form, persisted)) {
        const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
        const saved = id ? modelSelectionSaves.get(`${kind}:${id}`) : undefined;
        if (!id || !saved?.baseline || saved.baseline.id !== id || saved.baseline.kind !== kind || saved.hold !== null) return { meaningful: false, unreadable: false };
        return { meaningful: Object.keys(buildClearedPresetSelection(kind, saved.baseline.group)).length > 0, unreadable: false };
      }
      return { meaningful: Object.keys(draft).length > 0, unreadable: false };
    } catch {
      return { meaningful: false, unreadable: true };
    }
  }
  function canClearModelSelection(kind: ModelSelectionKind) {
    const blocked = kind === 'agent' ? primaryModelClearBlocked : subagentModelClearBlocked;
    const id = kind === 'agent' ? selectedAgentId : selectedEditableSubagentId;
    const saved = id ? modelSelectionSaves.get(`${kind}:${id}`) : undefined;
    if (!id || !saved?.baseline || saved.baseline.id !== id || saved.baseline.kind !== kind || saved.hold !== null) return false;
    if (kind === 'agent' ? primaryOwnedSaveInFlightUi || blocked : subagentOwnedSaveInFlightUi || blocked) return false;
    return modelClearEligibility(kind).meaningful;
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
        agentType: getSubagentToolHostScope(),
        connectionOptions: null,
      }),
    );
  }

  function handleSubagentModelChange(
    value: string | string[] | null | undefined,
  ) {
    if (subagentOwnedSaveInFlightUi || subagentModelSelectionBlocked) return;
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
      agentType: getSubagentToolHostScope(),
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
  }

  function handleAgentModelChange(value: string | string[] | null | undefined) {
    if (primaryOwnedSaveInFlightUi || primaryModelSelectionBlocked || primaryModelConnectionsBlocked) return;
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
      agentType: getPrimaryToolHostScope(),
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
    const source: ModelClearFormView = subagentForm;
    subagentForm = {
      ...subagentForm,
      ...buildClearedPresetSelection('subagent', source),
    };
  }

  /**
   * BL-266: the saved model a Subagent's form points at. The preset it saved wins; without one,
   * the Subagent shows no selection (its model was saved before Batshit kept the connection, and
   * it will not run until the model is picked again, which saves the preset). SA-139 R5: the
   * provider-and-name match served only the removed CLI Subagent type.
   */
  function findSubagentFormModel(form: SubagentForm): SavedModel | null {
    if (form.primary_model_preset_id) {
      return savedModels.find((model) => model.id === form.primary_model_preset_id) ?? null;
    }
    return null;
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
      // SA-139 R5 (D14): a leftover of a removed Subagent type is never saved, so no file is uploaded for it.
      if (retiredSubagentDetails) return 'unsupported_target';
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
    cliAckOrigins.clear();
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
    jev_juice_skill_tool_hints: 'off',
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
      api_reasoning_retention: agent.api_reasoning_retention ?? null,
      whiteboard_budget_tokens: agent.whiteboard_budget_tokens ?? null,
      show_whiteboard: agent.show_whiteboard ?? null,
      tool_approval_mode:
        (agent as any).tool_approval_mode === "all" || (agent as any).toolApprovalMode === "all"
          ? "all"
          : "off",
      auto_compact_settings: normalizeAgentAutoCompactSettings(agent.auto_compact_settings),
      memory_settings: resolveAgentMemorySettingsDraft(agent),
      workers_enabled: resolveWorkersEnabled(agent),
    // The saved switches, not the rules: the rules are also off while Fabric & Utilities is
    // off, and hydrating from them would erase the saved choice on the next save.
    dms_enabled: readAgentDmsSwitch(agent),
    dm_sender_scope: resolveDmSenderPolicy(agent).scope,
    dm_sender_agent_ids: resolveDmSenderPolicy(agent).agentIds,
    jev_juice_skill_tool_hints: resolveAgentJevSkillSessionMode(agent),
    jev_juice_judge_tool: readAgentJevJudgeToolSwitch(agent),
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
      live_file_reads: LIVE_READS_INHERIT,
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
    autoCompactNotice = null;
    autoCompactBlocked = true;
    ttsNotice = null;
    ttsBlocked = true;
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
    const liveFileReadsValue =
      typeof agent.live_file_reads === "boolean"
        ? agent.live_file_reads
          ? "enabled"
          : "disabled"
        : LIVE_READS_INHERIT;
    return {
      zip_ai_view_mode: layoutValue,
      zip_tool_notes_enabled: notesValue,
      live_file_reads: liveFileReadsValue,
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
          retained: Object.fromEntries(Object.entries(tool).filter(([field]) => !['tool_name','buffer_size','zip_threshold','auto_zip','zip_disabled'].includes(field))),
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
      // The stored type, kept as read (SA-139 R5): a leftover CLI Subagent stays `cli`, so it is
      // shown delete-only and never saved as an API Subagent. The list never holds a removed n8n
      // Subagent type (`GET /api/subagents`, SA-139 R2).
      subagentType: normalizeSubagentType(subagent, subagent.subagentType),
      specialty: subagent.specialty ?? "general",
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
      max_tool_steps:
        typeof subagent.max_tool_steps === "number"
          ? String(subagent.max_tool_steps)
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
   * section that has not loaded is not at rest. The zip section is
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
        !cliPairBlocked("agent") && basicPersistedSignature !== null &&
        makeBasicSignature(basicForm) === basicPersistedSignature &&
        !basicSaves.busy(selectedAgentId ?? ""),
      prompt:
        promptPersistedSignature !== null &&
        promptValue === promptPersistedSignature &&
        !promptSaves.busy(selectedAgentId ?? ""),
      zip: zipChanges !== null && Object.keys(zipChanges).length === 0 && !zipSaves.busy(selectedAgentId ?? ""),
      toolGrid:
        !cliPairBlocked("agent") && mcpPersistedSignature !== null &&
        makeMcpSignature(defaultMCPGateways, defaultMCPToolSelections, dcmDisplaySettings) ===
          mcpPersistedSignature &&
        !mcpSaves.busy(selectedAgentId ?? "") &&
        !cliToolSaves.busy(selectedAgentId ?? ""),
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
    const modelRefresh = event.type === 'reconnected' ||
      (event.type === 'agent_settings_changed' || event.type === 'subagent_settings_changed') && event.family === 'model-selection';
    if (modelRefresh) {
      // The user-channel owner refreshes the shared list once through its pure stored
      // projection. This mounted owner only follows target detail at its existing rest boundary.
      if (selectedEntity?.kind === 'subagent' && selectedEditableSubagentId &&
        (event.type === 'reconnected' || event.type === 'subagent_settings_changed' && event.agentId === selectedEditableSubagentId)) {
        if (!subagentCoreSaves.busy(selectedEditableSubagentId)) void hydrateSubagent(selectedEditableSubagentId);
        else setSubagentReadDeferred(true);
      }
    }
    if (event.type === 'subagent_settings_changed' && event.family === 'instructions' && selectedEntity?.kind === 'subagent' && event.agentId === selectedEditableSubagentId && selectedEditableSubagentId) {
      if (!subagentCoreSaves.busy(selectedEditableSubagentId)) void hydrateSubagent(selectedEditableSubagentId);
      else { instructionsReadbacks.add(`subagent:${selectedEditableSubagentId}`); setSubagentReadDeferred(true); }
    }
    if (event.type === 'subagent_settings_changed' && event.family === 'provider-settings' && selectedEntity?.kind === 'subagent' && event.agentId === selectedEditableSubagentId && selectedEditableSubagentId) {
      if (!subagentCoreSaves.busy(selectedEditableSubagentId)) void hydrateSubagent(selectedEditableSubagentId);
      else setSubagentReadDeferred(true);
    }
    // The selected agent, loaded or still loading: `readAgentAgainWhenAtRest` replaces a first read
    // that is still on its way (its answer may predate the agent's save) and waits for rest otherwise.
    const shownAgentId = selectedEntity?.kind === "agent" ? selectedAgentId : null;
    const readShownAgent = (refreshModel = false, refreshInstructions = false, refreshCompact = false, refreshMemory = false, refreshTts = false) =>
      untrack(() => {
        if (shownAgentId === null) return;
        setAgentReadDeferred(true);
        if (refreshTts && hydratedAgentId === shownAgentId) {
          ttsReadbacks.add(shownAgentId); tryTtsReadback();
        } else if (refreshMemory && hydratedAgentId === shownAgentId) {
          memoryReadbacks.add(shownAgentId);
          tryMemoryReadback();
        } else if (refreshCompact && hydratedAgentId === shownAgentId) {
          autoCompactReadbacks.add(shownAgentId);
          tryAutoCompactReadback();
        } else if (refreshInstructions && hydratedAgentId === shownAgentId) {
          instructionsReadbacks.add(`agent:${shownAgentId}`);
          tryInstructionsReadbacks();
        } else if (refreshModel && hydratedAgentId === shownAgentId && !basicSaves.busy(shownAgentId)) {
          void hydrateAgent(shownAgentId);
        } else readAgentAgainWhenAtRest();
      });
    if (event.type === "reconnected") {
      if (shownAgentId !== null) readShownAgent(true, true, true, true, true);
      return;
    }
    if (event.type !== "agent_settings_changed" || typeof event.agentId !== "string") return;
    if (event.family === "mcp-settings" && event.agentId === shownAgentId && shownAgentId) {
      if (!mcpSaves.busy(shownAgentId) && !zipSaves.busy(shownAgentId)) void hydrateAgent(shownAgentId); else setAgentReadDeferred(true);
      return;
    }
    if (shownAgentId !== null && event.agentId === shownAgentId) {
      readShownAgent(event.family === 'model-selection', event.family === 'instructions', event.family === 'auto-compact', event.family === 'memory', event.family === 'voice-selection');
    } else if (agents.some((agent) => agent.id === event.agentId)) void refreshListedAgent(event.agentId);
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
  function basicRequestBody(body: Partial<BasicPayloadBody>, baseForm: BasicForm, expectedModelSelection?: string, expectedInstructions?: Partial<InstructionsRevisions>, expectedAutoCompact?: string, expectedTtsSelection?: string): Record<string, unknown> {
    const request = AGENT_MEMORY_GROUP.some((field) => field in body)
      ? { ...body, expectedMemory: buildAgentMemoryRecordFields(baseForm.memory_settings) }
      : body;
    return { ...request, ...(expectedModelSelection ? { expectedModelSelection } : {}), ...(expectedInstructions ? { expectedInstructions } : {}), ...(expectedAutoCompact ? { expectedAutoCompact } : {}), ...(expectedTtsSelection ? { expectedTtsSelection } : {}) };
  }

  class ModelSelectionSaveRefusedError extends Error {}
  class InstructionsSaveRefusedError extends Error {}
  class AutoCompactSaveRefusedError extends Error {}
  class TtsSaveRefusedError extends Error {}

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
    payload: { id: string; body: Partial<BasicPayloadBody>; hydrationGeneration: number; baseForm: BasicForm; expectedModelSelection?: string; expectedInstructions?: Partial<InstructionsRevisions>; expectedAutoCompact?: string; expectedTtsSelection?: string },
    savedForm: BasicForm,
    applyToLive?: (form: BasicForm) => BasicForm,
  ) {
    retireCliAckOrigin("agent", payload.id, "basic");
    const stored = agents.find((agent) => agent.id === payload.id);
    const previousAvatar = stored?.avatar ?? stored?.avatar_url ?? null;
    const modelSent = isModelSelectionWrite('agent', payload.body) && Boolean(payload.expectedModelSelection);
    let modelIssued = false;
    let modelKnownSaved = false;
    let instructionsIssued = false;
    let instructionsKnownSaved = false;
    const compactSent = Object.hasOwn(payload.body, 'auto_compact_settings');
    const compactBase = compactSent ? autoCompactSave(payload.id).baseline : null;
    const compactBefore = compactSent ? { ...payload.baseForm.auto_compact_settings } : null;
    const compactSaved = compactSent ? { ...savedForm.auto_compact_settings } : null;
    let compactIssued = false;
    let compactKnownSaved = false;
    let knownNoSave = false;
    const ttsSent = Object.hasOwn(payload.body, 'voice_profile');
    const ttsBase = ttsSent ? ttsSave(payload.id).baseline : null;
    const ttsBefore = ttsSent ? { ...payload.baseForm.voice_profile } : null;
    const ttsSaved = ttsSent ? { ...savedForm.voice_profile } : null;
    const ttsType = ttsSent ? payload.baseForm.agentType : null;
    let ttsIssued = false, ttsKnownSaved = false;
    const typedSent = typedFileToolsBodyValue(payload.body) !== undefined;
    let typedOriginal: TypedFileToolsBaseline | null = null, typedIssued = false, typedKnownSaved = false;
    try {
      if (typedSent) typedOriginal = beginTypedToolsWrite('agent', payload.id, payload.body);
      if (ttsSent) {
        const saved = ttsSave(payload.id);
        if (!payload.expectedTtsSelection || saved.baseline?.token !== payload.expectedTtsSelection || saved.hold !== null) throw new TtsSaveRefusedError('This reply voice change was not sent. Use Saved Reply Voice and make a new choice.');
        saved.generation += 1;
      }
      if (compactSent) {
        const saved = autoCompactSave(payload.id);
        if (!payload.expectedAutoCompact || saved.baseline?.token !== payload.expectedAutoCompact || saved.hold !== null) {
          throw new AutoCompactSaveRefusedError('This Auto Compact change was not sent. Use Saved Auto Compact and make a new choice.');
        }
        saved.generation += 1;
      }
      beginInstructionsWrite('agent', payload.id, payload.body, payload.expectedInstructions);
      if (modelSent) {
        const saved = modelSelectionSave('agent', payload.id);
        if (!ownsModelSelectionBase(saved.baseline, payload.expectedModelSelection) || saved.hold !== null) {
          throw new ModelSelectionSaveRefusedError('This model choice was not sent. Use Saved Model before choosing another model.');
        }
        saved.generation += 1;
        modelIssued = true;
      }
      instructionsIssued = namesInstructions(payload.body);
      compactIssued = compactSent;
      ttsIssued = ttsSent;
      typedIssued = typedSent;
      const response = await fetch(`/api/agents/${payload.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basicRequestBody(payload.body, payload.baseForm, payload.expectedModelSelection, payload.expectedInstructions, payload.expectedAutoCompact, payload.expectedTtsSelection)),
      });

      const typedAnswer = typedSent ? await response.clone().json().catch(() => null) : null;
      if (typedSent) typedKnownSaved = adoptTypedToolsReceipt('agent', payload.id, payload.body, typedOriginal, typedAnswer?.typedFileTools);
      if (typedSent && response.ok && !typedKnownSaved) throw new Error('The saved choice receipt is unconfirmed. Your draft is kept; do not repeat it automatically.');
      if (!response.ok) {
        knownNoSave = typedSent && [400, 409].includes(response.status) && ['typed_file_tools_base_required', 'typed_file_tools_changed'].includes(typedAnswer?.code);
        knownNoSave ||= instructionsKnownNoSave(response.status, (await response.clone().json().catch(() => null))?.code);
        if (compactSent && knownNoSave) {
          const answer = await response.clone().json().catch(() => null);
          if (answer?.code === 'auto_compact_base_required' || answer?.code === 'auto_compact_settings_changed') throw new AutoCompactSaveRefusedError('Auto Compact changed while you were editing. Your draft was not saved. Use Saved Auto Compact and make a new choice.');
        }
        if (namesInstructions(payload.body) && (response.status === 400 || response.status === 409)) {
          const answer = await response.clone().json().catch(() => null);
          if (answer?.code === 'instructions_base_required' || answer?.code === 'instructions_settings_changed') throw new InstructionsSaveRefusedError('Saved instructions changed while you were editing. Your draft was not saved. Use Saved Instructions and make a new choice.');
        }
        if (modelSent && (response.status === 400 || response.status === 409)) {
          const answer = await response.clone().json().catch(() => null);
          if (answer?.code === 'model_selection_base_required' || answer?.code === 'model_selection_settings_changed') {
            throw new ModelSelectionSaveRefusedError('The model changed while you were editing. Your choice was not saved. Use Saved Model before choosing another model.');
          }
        }
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

      modelKnownSaved = true;
      instructionsKnownSaved = true;
      compactKnownSaved = true;
      ttsKnownSaved = true;
      if (ttsSent) { const saved = ttsSave(payload.id); saved.generation += 1; saved.baseline = null; saved.hold = 'read'; ttsReadbacks.add(payload.id); syncTtsNotice(); }
      if (compactSent) {
        const saved = autoCompactSave(payload.id);
        saved.generation += 1;
        saved.baseline = null;
        saved.hold = 'read';
        autoCompactReadbacks.add(payload.id);
        syncAutoCompactNotice();
      }
      settleInstructionsWrite('agent', payload.id, payload.body, 'read');
      if (modelSent) {
        const saved = modelSelectionSave('agent', payload.id);
        saved.generation += 1;
        saved.baseline = null;
        saved.hold = 'read';
        modelSelectionReadbacks.add(`agent:${payload.id}`);
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
          // A later detail read can leave this known save's baseline behind. Move only
          // its still-owned Compact block to the captured saved snapshot, so its own
          // readback can obtain the new token beside an unrelated invalid draft.
          // Never use the live form: a later Compact edit and every other draft stay owned.
          if (compactSaved && compactBase && compactBase.token === payload.expectedAutoCompact &&
            selectedEntity?.kind === 'agent' && selectedEntity.id === payload.id &&
            basicPersistedForm?.agentType === compactBase.type && basicForm.agentType === compactBase.type &&
            sameJsonValue(basicPersistedForm.auto_compact_settings, compactBefore)) {
            basicPersistedForm = { ...basicPersistedForm, auto_compact_settings: compactSaved };
            basicPersistedSignature = makeBasicSignature(basicPersistedForm);
          }
          if (ttsSaved && ttsBefore && ttsBase?.id === payload.id && ttsBase.token === payload.expectedTtsSelection &&
            selectedEntity?.kind === 'agent' && selectedEntity.id === payload.id &&
            basicPersistedForm?.agentType === ttsType && basicForm.agentType === ttsType &&
            sameTtsForm(basicPersistedForm.voice_profile, ttsBefore)) {
            const tuple = { provider: ttsSaved.provider, model: ttsSaved.model, voiceId: ttsSaved.voiceId, profileId: ttsSaved.profileId };
            basicPersistedForm = { ...basicPersistedForm, voice_profile: { ...basicPersistedForm.voice_profile, ...tuple } };
            basicPersistedSignature = makeBasicSignature(basicPersistedForm);
          }
        }
        // BL-514: the body holds only what this save changed; a field it left out keeps its value.
        updateAgentCollections(payload.id, {
          ...withoutExpectedTypedFileTools(payload.body),
          ...("primary_model_name" in payload.body
            ? { model: payload.body.primary_model_name }
            : {}),
        } as Partial<AgentRow>);
        syncModelSelectionNotices();
        // Round 2: whether Refreshed File Reads can run reads the agent's type and its Bash
        // command location and permissions mode, so a save that changes one changes the badges' facts.
        if (refreshedFileReadsRecordInputsChanged(payload.baseForm, savedForm)) void refreshAllDeadCopies();
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
        if (typedSent && !typedKnownSaved) refuseTypedToolsWrite('agent', payload.id, knownNoSave || !typedIssued || error instanceof TypedToolsSaveRefusedError);
        if (ttsSent && !ttsKnownSaved) { const saved = ttsSave(payload.id); saved.generation += 1; saved.hold = knownNoSave || !ttsIssued || error instanceof TtsSaveRefusedError ? 'conflict' : 'unknown'; saved.earlierUnknown ||= saved.hold === 'unknown'; syncTtsNotice(); }
        if (compactSent && !compactKnownSaved) {
          const saved = autoCompactSave(payload.id);
          saved.generation += 1;
          saved.hold = knownNoSave || !compactIssued ? 'conflict' : 'unknown';
          saved.earlierUnknown ||= saved.hold === 'unknown';
          syncAutoCompactNotice();
        }
        if (!instructionsKnownSaved) settleInstructionsWrite('agent', payload.id, payload.body, error instanceof InstructionsSaveRefusedError || !instructionsIssued || knownNoSave ? 'conflict' : 'unknown');
        if (modelSent && !modelKnownSaved) {
          const saved = modelSelectionSave('agent', payload.id);
          saved.generation += 1;
          saved.hold = knownNoSave || error instanceof AutoCompactSaveRefusedError || error instanceof InstructionsSaveRefusedError || error instanceof ModelSelectionSaveRefusedError || error instanceof MemorySettingsChangedError || !modelIssued ? 'conflict' : 'unknown';
          saved.earlierUnknown ||= saved.hold === 'unknown';
          syncModelSelectionNotices();
        }
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
      expectedModelSelection?: string;
      expectedInstructions?: Partial<InstructionsRevisions>;
      expectedAutoCompact?: string;
      expectedTtsSelection?: string;
    }) => persistBasic(payload, payload.nextForm),
    BASIC_SAVE_DEBOUNCE_MS,
  );

  async function persistPrompt(
    payload: { id: string; system_prompt: string; hydrationGeneration: number; expectedInstructions: Partial<InstructionsRevisions> },
    nextPrompt: string = promptValue,
  ) {
    let issued = false;
    let knownSaved = false;
    let knownNoSave = false;
    try {
      beginInstructionsWrite('agent', payload.id, payload, payload.expectedInstructions);
      issued = true;
      const response = await fetch(`/api/agents/${payload.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: payload.system_prompt, expectedInstructions: payload.expectedInstructions }),
      });

      if (!response.ok) {
        knownNoSave = instructionsKnownNoSave(response.status, (await response.clone().json().catch(() => null))?.code);
        const message = await extractError(
          response,
          "Failed to save system prompt",
        );
        throw new Error(message);
      }
      knownSaved = true;
      settleInstructionsWrite('agent', payload.id, payload, 'read');

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
      if (!knownSaved) settleInstructionsWrite('agent', payload.id, payload, !issued || knownNoSave ? 'conflict' : 'unknown');
      console.error("Failed to save prompt:", error);
      throw error instanceof Error
        ? error
        : new Error("Failed to save system prompt");
    }
  }

  const saveZipSettings = zipSaves.debounce(
    async (payload: {
      id: string;
      body: Partial<ZipPayloadBody> & { expectedMcpSettings?: ExpectedMcpSettings };
      signature: string;
      /** The whole payload the body was worked out from: the baseline once the save lands. */
      full: ZipPayloadBody;
      hydrationGeneration: number;
    }) => {
      let issued = false;
      let ownsAck = false;
      let knownRefusal = false;
      try {
        // A queued capture cannot issue after an earlier guarded outcome became held.
        if (payload.body.expectedMcpSettings && primaryMcpHolds[payload.id]) {
          throw new Error('Your Tool Settings draft is kept. Use Saved Tool Settings before another choice.');
        }
        const body = JSON.stringify(payload.body);
        issued = true;
        const response = await fetch(`/api/agents/${payload.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });

        const mcpAnswer = await response.clone().json().catch(() => null);
        ownsAck = adoptPrimaryMcpAck(payload.id, payload.body.expectedMcpSettings, mcpAnswer?.mcpSettings);
        if (response.ok && payload.body.expectedMcpSettings && !ownsAck) {
          primaryMcpHolds = { ...primaryMcpHolds, [payload.id]: 'unknown' };
          throw new Error('The Tool Settings save acknowledgement is unconfirmed. Your draft is kept; use saved values before another choice.');
        }
        if (!response.ok) {
          if (payload.body.expectedMcpSettings && !ownsAck) {
            knownRefusal = [400, 409].includes(response.status) && ['mcp_settings_base_required', 'mcp_settings_changed'].includes(mcpAnswer?.code);
            primaryMcpHolds = { ...primaryMcpHolds, [payload.id]: knownRefusal ? 'conflict' : 'unknown' };
          }
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
            zipPayloadToAgentUpdates(withoutExpectedMcpSettings(payload.body)),
          );
          // SA-137 P4 (D11): the badges' live-read facts depend on this agent's choice, and
          // Round 2 on its Zip view (one of the availability rule's inputs).
          if ("live_file_reads" in payload.body || "zip_ai_view_mode" in payload.body) void refreshAllDeadCopies();
        });
      } catch (error) {
        console.error("Failed to save zip overrides:", error);
        untrack(() => {
          // A lost/unreadable answer is unknown even if this entity is no longer selected.
          // A genuine same-request ACK survives any later follow-up failure.
          if (issued && payload.body.expectedMcpSettings && !ownsAck && !knownRefusal) {
            primaryMcpHolds = { ...primaryMcpHolds, [payload.id]: 'unknown' };
          }
          if (selectedAgentId === payload.id) {
            zipSaveState = "idle";
            zipSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save zip overrides";
          }
        });
      } finally {
        primaryMcpVersions.set(payload.id, (primaryMcpVersions.get(payload.id) ?? 0) + 1);
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
      body: McpSectionSave & { expectedMcpSettings?: ExpectedMcpSettings };
      signature: string;
      /** The values the body was worked out from: the baseline once the save lands. */
      values: McpSectionValues;
      hydrationGeneration: number;
    }) => {
      retireCliAckOrigin("agent", payload.id, "mcp");
      let issued = false;
      let ownsAck = false;
      let knownRefusal = false;
      try {
        // A queued capture cannot issue after an earlier guarded outcome became held.
        if (payload.body.expectedMcpSettings && primaryMcpHolds[payload.id]) {
          throw new Error('Your Tool Settings draft is kept. Use Saved Tool Settings before another choice.');
        }
        const body = JSON.stringify(payload.body);
        issued = true;
        const response = await fetch(`/api/agents/${payload.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });

        const mcpAnswer = await response.clone().json().catch(() => null);
        ownsAck = adoptPrimaryMcpAck(payload.id, payload.body.expectedMcpSettings, mcpAnswer?.mcpSettings);
        if (response.ok && payload.body.expectedMcpSettings && !ownsAck) {
          primaryMcpHolds = { ...primaryMcpHolds, [payload.id]: 'unknown' };
          throw new Error('The Tool Settings save acknowledgement is unconfirmed. Your draft is kept; use saved values before another choice.');
        }
        if (!response.ok) {
          if (payload.body.expectedMcpSettings && !ownsAck) {
            knownRefusal = [400, 409].includes(response.status) && ['mcp_settings_base_required', 'mcp_settings_changed'].includes(mcpAnswer?.code);
            primaryMcpHolds = { ...primaryMcpHolds, [payload.id]: knownRefusal ? 'conflict' : 'unknown' };
          }
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
          updateAgentCollections(payload.id, withoutExpectedMcpSettings(payload.body));
        });
      } catch (error) {
        console.error("Failed to save default MCP settings:", error);
        untrack(() => {
          // A lost/unreadable answer is unknown even if this entity is no longer selected.
          // A genuine same-request ACK survives any later follow-up failure.
          if (issued && payload.body.expectedMcpSettings && !ownsAck && !knownRefusal) {
            primaryMcpHolds = { ...primaryMcpHolds, [payload.id]: 'unknown' };
          }
          if (selectedAgentId === payload.id) {
            mcpSaveState = "idle";
            mcpSaveError =
              error instanceof Error
                ? error.message
                : "Failed to save MCP defaults";
          }
        });
      } finally {
        primaryMcpVersions.set(payload.id, (primaryMcpVersions.get(payload.id) ?? 0) + 1);
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
        !cliPairBlocked("subagent") && subagentPersistedSignature !== null &&
        makeSubagentFormSignature(subagentForm) === subagentPersistedSignature &&
        !subagentCoreSaves.busy(selectedEditableSubagentId ?? ""),
      toolGrid:
        !cliPairBlocked("subagent") && subagentMcpPersistedSignature !== null &&
        makeMcpSignature(
          subagentDefaultMCPGateways,
          subagentDefaultMCPToolSelections,
          subagentDcmDisplaySettings,
        ) === subagentMcpPersistedSignature &&
        !subagentMcpSaves.busy(selectedEditableSubagentId ?? "") &&
        !subagentCliToolSaves.busy(selectedEditableSubagentId ?? ""),
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
   * The saves of the other sections (the Tool Settings Grid, CLI tools) name no form and leave
   * the baseline AND the persisted signature alone: they save none of the core fields, so a core
   * edit that is unsaved (waiting in its debounce, in flight, or failed) stays a difference from
   * the baseline, the store-refresh effect can tell it is unsaved, and the next core edit sends
   * it. The save error and the "Saved" status belong to the core edit while one is unsaved, so
   * neither section touches them then: not when it starts (both clear the error only when no
   * core edit is unsaved) and not when it lands (no "Saved", no cleared error). The error of a
   * failed core save stays on screen until a core save works.
   */
  async function persistSubagentDetails(
    payload: { id: string; body: LiveSubagentUpdate; readGeneration: number },
    savedForm?: SubagentForm,
    applyToLive?: (form: SubagentForm) => SubagentForm,
  ): Promise<SaveLanding> {
    if (savedForm || Object.hasOwn(payload.body, 'provider_specific_settings')) retireCliAckOrigin('subagent', payload.id, 'basic');
    if (['defaultMCPGateways', 'defaultMCPToolSelections', 'dcmDisplaySettings'].some(field => Object.hasOwn(payload.body, field))) retireCliAckOrigin('subagent', payload.id, 'mcp');
    const previousAvatar = subagents.find((subagent) => subagent.id === payload.id)?.avatar ?? null;
    const modelSent = isModelSelectionWrite('subagent', payload.body) && Boolean(payload.body.expectedModelSelection);
    let modelIssued = false;
    let modelKnownSaved = false;
    let instructionsIssued = false;
    let instructionsKnownSaved = false;
    const typedSent = typedFileToolsBodyValue(payload.body) !== undefined;
    let typedOriginal: TypedFileToolsBaseline | null = null, typedIssued = false, typedKnownSaved = false;
    try {
      if (typedSent) typedOriginal = beginTypedToolsWrite('subagent', payload.id, payload.body);
      beginInstructionsWrite('subagent', payload.id, payload.body, payload.body.expectedInstructions);
      if (modelSent) {
        const saved = modelSelectionSave('subagent', payload.id);
        if (!ownsModelSelectionBase(saved.baseline, payload.body.expectedModelSelection) || saved.hold !== null) throw new ModelSelectionSaveRefusedError('This model choice was not sent. Use Saved Model before choosing another model.');
        saved.generation += 1;
        modelIssued = true;
      }
      instructionsIssued = namesInstructions(payload.body);
      typedIssued = typedSent;
      const result = await subagentStore.update(payload.id, payload.body);
      if (typedSent) {
        typedKnownSaved = adoptTypedToolsReceipt('subagent', payload.id, payload.body, typedOriginal, result.typedFileTools);
        if (!typedKnownSaved) throw new Error('The saved choice receipt is unconfirmed. Your draft is kept; do not repeat it automatically.');
      }
      modelKnownSaved = true;
      instructionsKnownSaved = true;
      settleInstructionsWrite('subagent', payload.id, payload.body, 'read');
      if (modelSent) {
        const saved = modelSelectionSave('subagent', payload.id);
        saved.generation += 1;
        saved.baseline = null;
        saved.hold = 'read';
        modelSelectionReadbacks.add(`subagent:${payload.id}`);
      }
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
      syncModelSelectionNotices();
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
        if (typedSent && !typedKnownSaved) {
          typedKnownSaved = adoptTypedToolsReceipt('subagent', payload.id, payload.body, typedOriginal, (error as { typedFileTools?: unknown }).typedFileTools);
          if (!typedKnownSaved) refuseTypedToolsWrite('subagent', payload.id, !typedIssued || error instanceof TypedToolsSaveRefusedError ||
            instructionsKnownNoSave((error as { status?: number }).status, (error as { code?: string }).code) ||
            [400, 409].includes((error as { status?: number }).status ?? 0) && ['typed_file_tools_base_required', 'typed_file_tools_changed'].includes((error as { code?: string }).code ?? ''));
        }
        if (!instructionsKnownSaved) settleInstructionsWrite('subagent', payload.id, payload.body, !instructionsIssued ||
          instructionsKnownNoSave((error as { status?: number }).status, (error as { code?: string }).code) ? 'conflict' : 'unknown');
        if (modelSent && !modelKnownSaved) {
          const saved = modelSelectionSave('subagent', payload.id);
          saved.generation += 1;
          saved.hold = error instanceof ModelSelectionSaveRefusedError || !modelIssued ||
            instructionsKnownNoSave((error as { status?: number }).status, (error as { code?: string }).code) ? 'conflict' : 'unknown';
          saved.earlierUnknown ||= saved.hold === 'unknown';
          syncModelSelectionNotices();
        }
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
    const ackOwnsCliRebase = untrack(() => cliAckOwnsRebase("agent", "basic"));
    if (
      !basicPersistedSignature ||
      !basicPersistedForm ||
      signature === basicPersistedSignature ||
      signature === lastInvalidAgentSignature
    ) {
      return;
    }

    if (ackOwnsCliRebase) return;
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
    if (untrack(() => cliPairHeld("agent"))) return;
    const modelCaptured = untrack(() => captureModelSelection('agent', selectedAgentId!, body, nextForm, baseForm));
    const typedCaptured = { ...modelCaptured, ...untrack(() => captureTypedTools('agent', selectedAgentId!, modelCaptured.body, modelCaptured.nextForm, baseForm)) };
    const compactCaptured = { ...typedCaptured, ...untrack(() => captureBasicAutoCompact(selectedAgentId!, typedCaptured.body, typedCaptured.nextForm, baseForm)) };
    const captured = { ...compactCaptured, ...untrack(() => captureInstructions('agent', selectedAgentId!, compactCaptured.body, compactCaptured.nextForm, baseForm)) };
    if (patchContainsGroupedValues(captured.body, "agent") && deferPrimaryCapture("basic")) return;
    // A form that differs from the saved copy only in ways the save does not see (a reordered
    // block) has nothing to send.
    if (Object.keys(captured.body).length === 0) return;

    basicSaveState = "saving";
    basicSaveError = null;
    saveBasic({
      id: selectedAgentId,
      ...captured,
      // Read when the body is built: a re-read of the agent during the debounce or the round trip
      // is what `persistBasic` checks at the landing (BL-911).
      hydrationGeneration: agentHydrationRequestId,
      baseForm,
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
    let body: Partial<ZipPayloadBody> & { expectedMcpSettings?: ExpectedMcpSettings } = diffZipPayload(zipPersistedPayload, payload);
    // A read finishing is not a new choice. Keep the held draft's owning error,
    // including an incomplete recovery read, until saved values are adopted.
    const mcpId = selectedAgentId;
    if (mcpSettingsLeaves(body).length && untrack(() => primaryMcpHolds[mcpId])) return;
    try { body = capturePrimaryMcpBody(body); } catch (error) { zipSaveError = error instanceof Error ? error.message : "Read Saved Tool Settings before another choice."; return; }
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
    const ackOwnsCliRebase = untrack(() => cliAckOwnsRebase("agent", "mcp"));
    if (!mcpPersistedSignature || signature === mcpPersistedSignature) {
      return;
    }

    if (ackOwnsCliRebase) return;

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
    let body: McpSectionSave & { expectedMcpSettings?: ExpectedMcpSettings } = diffMcpSection(mcpPersistedValues, values);
    if (untrack(() => cliPairHeld("agent"))) return;
    // The held owner already has its save/read failure; hydration must not
    // replace it by trying to capture the same unsaved draft again.
    const mcpId = selectedAgentId;
    if (mcpSettingsLeaves(body).length && untrack(() => primaryMcpHolds[mcpId])) return;
    try { body = capturePrimaryMcpBody(body); } catch (error) { mcpSaveError = error instanceof Error ? error.message : "Read Saved Tool Settings before another choice."; return; }
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
    const signature = makeMcpSignature(
      subagentDefaultMCPGateways,
      subagentDefaultMCPToolSelections,
      subagentDcmDisplaySettings,
    );
    const ackOwnsCliRebase = untrack(() => cliAckOwnsRebase("subagent", "mcp"));
    if (
      !subagentMcpPersistedSignature ||
      signature === subagentMcpPersistedSignature
    ) {
      return;
    }

    if (ackOwnsCliRebase) return;

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
    if (untrack(() => cliPairHeld("subagent"))) return;
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
    const signature = makeSubagentFormSignature(subagentForm);
    const ackOwnsCliRebase = untrack(() => cliAckOwnsRebase("subagent", "basic"));
    if (
      !subagentPersistedSignature ||
      !subagentPersistedForm ||
      signature === subagentPersistedSignature ||
      signature === lastInvalidSubagentSignature
    ) {
      return;
    }

    if (ackOwnsCliRebase) return;
    const validation = validateSubagentForm(subagentForm);
    subagentValidationError = validation;

    if (validation) {
      lastInvalidSubagentSignature = signature;
      subagentEditSaveState = "idle";
      return;
    }

    lastInvalidSubagentSignature = null;
    const nextForm = $state.snapshot(subagentForm) as SubagentForm;
    if (untrack(() => cliPairHeld("subagent"))) return;
    const typedCaptured = untrack(() => captureTypedTools('subagent', selectedEditableSubagentId!, buildSubagentSavePatch(nextForm), nextForm, subagentPersistedForm!));
    const modelCaptured = untrack(() => captureModelSelection('subagent', selectedEditableSubagentId!, typedCaptured.body, typedCaptured.nextForm, subagentPersistedForm!));
    const captured = { ...modelCaptured, ...untrack(() => captureInstructions('subagent', selectedEditableSubagentId!, modelCaptured.body, modelCaptured.nextForm, subagentPersistedForm!)) };
    const body = { ...captured.body, ...(captured.expectedModelSelection ? { expectedModelSelection: captured.expectedModelSelection } : {}), ...(captured.expectedInstructions ? { expectedInstructions: captured.expectedInstructions } : {}) };
    if (patchContainsGroupedValues(body, "subagent") && deferSubagentCapture("core")) return;
    // A form that differs from the saved copy only in ways the save does not see has nothing to
    // send.
    if (Object.keys(body).length === 0) return;

    subagentEditSaveState = "saving";
    subagentEditSaveError = null;

    saveSubagentDetails({
      id: selectedEditableSubagentId,
      body,
      nextForm: captured.nextForm,
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
    const retired = retiredPrimaryDetails(form);
    if (retired) return retired;
    if (typeof form.primary_model_provider !== 'string' || typeof form.primary_model_name !== 'string') {
      return "The saved model identity is unreadable. Choose a Saved Model before saving these settings.";
    }
    const provider = form.primary_model_provider.trim().toLowerCase();
    const modelName = form.primary_model_name.trim().toLowerCase();
    const connectionHint =
      form.primary_model_connection?.id ??
      form.primary_model_connection?.service ??
      "";
    if (typeof connectionHint !== 'string') {
      return "The saved model connection is unreadable. Choose a Saved Model before saving these settings.";
    }
    const isCliPreset =
      provider.includes("claude-cli") ||
      modelName.includes("claude-cli") ||
      connectionHint.toLowerCase().includes("claude-cli");

    if (isCliPreset) {
      return CLAUDE_CLI_PRESET_REFUSAL;
    }
    return null;
  }

  /**
   * SA-139 R4 (D14): the plain refusal for a stored Primary of a removed type (`cli`, `n8n`), or
   * null for a live one. Such a leftover is shown and deleted, never saved: validation and
   * `buildBasicPayload` refuse it, so opening it saves nothing.
   */
  function retiredPrimaryDetails(form: Pick<BasicForm, "agentType" | "primary_model_provider" | "primary_model_connection">): string | null {
    if (!isRetiredPrimaryAgentType(form.agentType)) return null;
    return retiredPrimaryAgentTypeMessage(form.agentType, {
      codex: form.agentType === "cli" && namesRetiredCodexCliModel(form),
    }).details;
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
    // SA-139 R5 (D14): a leftover of a removed Subagent type is shown and deleted, never saved.
    if (isRetiredSubagentType(form.subagentType)) {
      return retiredSubagentTypeSentences(form.subagentType, form).details;
    }
    if (!form.displayName.trim()) {
      return "Display name is required.";
    }
    const timeoutValidation = getSubagentTimeoutValidationError(
      form.timeout_seconds,
    );
    if (timeoutValidation) {
      return timeoutValidation;
    }
    const maxToolStepsValidation = getSubagentMaxToolStepsValidationError(
      form.max_tool_steps,
    );
    if (maxToolStepsValidation) {
      return maxToolStepsValidation;
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
    cliAckOrigins.clear();
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
      const normalisedSubagentForm = { ...normaliseSubagentForm(match), ...(!fill ? {
        system_prompt: subagentForm.system_prompt,
        include_global_prompt: subagentForm.include_global_prompt,
      } : {}) };
      if (!fill && !sameModelSelection('subagent', subagentForm, normalisedSubagentForm)) {
        modelSelectionSave('subagent', match.id).baseline = null;
        modelSelectionReadbacks.add(`subagent:${match.id}`);
      }
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
        viewedDcm: cloneDcmDisplaySettings(subagentDcmDisplaySettings),
        gateways: [...mcpDefaults.gateways],
        selections: cloneToolSelections(mcpDefaults.selections),
        dcm:
          match.dcmDisplaySettings == null && (match as any).dcm_display_settings != null
            ? null
            : cloneDcmDisplaySettings(mcpDefaults.dcmDisplaySettings),
      };
      subagentMcpRenderNonce += 1;
    }
  }

  async function selectEditableSubagent(id: string) {
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
    const fill = selectedEditableSubagentId !== id;
    modelSelectionSave('subagent', id).baseline = null;
    instructionsSave('subagent', id).bases = { customPrompt: null, includeGlobalPrompt: null };
    const requestId = subagentReadRequestId;
    untrack(() => {
      selectedEditableSubagentId = id;
      selectedEntity = { kind: "subagent", id };
      createEntityMode = false;
      activeSubagentSettingsTab = "core";
    });
    try {
      untrack(() => {
        readSubagentSections(match, fill, true);
        subagentValidationError = null;
        subagentAvatarError = null;
        selectedSubagentModelId = null;
        lastInvalidSubagentSignature = null;
      });
      syncSelectedModelFromSubagent();
      syncModelSelectionNotices();
      syncInstructionsNotices();
      await hydrateSubagent(id);
    } catch (error) {
      if (settingsPanelAlive && requestId === subagentReadRequestId && selectedEntity?.kind === "subagent" && selectedEditableSubagentId === id) {
        subagentReadWaitError = error instanceof Error ? error.message : "Failed to read the selected Subagent";
      }
    } finally {
      if (requestId === subagentReadRequestId && selectedEditableSubagentId === id) {
        subagentDetailLoading = false;
        syncSubagentSaveWaits();
      }
    }
  }

  function resetZipOverrides() {
    if (primaryCaptureBlocked) return;
    if (!selectedAgentId) return;
    const nextForm: ZipForm = {
      ...zipForm,
      zip_ai_view_mode: ZIP_LAYOUT_INHERIT,
      zip_tool_notes_enabled: ZIP_NOTES_INHERIT,
      live_file_reads: LIVE_READS_INHERIT,
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
    retireCliAckOrigin("agent", selectedAgentId, "mcp");
    if (primaryOwnedSaveInFlightUi) return;
    defaultMCPGateways = [...gateways];
  }

  function handleMcpDcmDisplaySettingsChange(settings: AgentDcmDisplaySettings) {
    retireCliAckOrigin("agent", selectedAgentId, "mcp");
    if (primaryOwnedSaveInFlightUi) return;
    dcmDisplaySettings = cloneDcmDisplaySettings(settings);
  }

  function clearMcpDefaults(showToast = true) {
    if (primaryCaptureBlocked) return;
    retireCliAckOrigin("agent", selectedAgentId, "mcp");
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
    if (ttsBlocked) return;
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
    if (ttsBlocked) return;
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
      ...(form.agentType === 'api' ? {
        api_reasoning_retention: form.api_reasoning_retention ?? null,
        whiteboard_budget_tokens: form.whiteboard_budget_tokens ?? null,
        show_whiteboard: form.show_whiteboard ?? null
      } : { preserve_reasoning: form.preserve_reasoning }),
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
      primary_model_provider: typeof form.primary_model_provider === 'string' ? form.primary_model_provider.trim() : form.primary_model_provider,
      primary_model_name: typeof form.primary_model_name === 'string' ? form.primary_model_name.trim() : form.primary_model_name,
      primary_model_preset_id: typeof form.primary_model_preset_id === 'string' ? form.primary_model_preset_id.trim() : form.primary_model_preset_id,
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
    if (isRetiredPrimaryAgentType(form.agentType)) throw new Error(retiredPrimaryDetails(form)!);
    return {
      displayName: form.displayName.trim(),
      agentType: form.agentType,
      show_reasoning: form.show_reasoning,
      api_reasoning_retention: form.api_reasoning_retention ?? null,
      whiteboard_budget_tokens: form.whiteboard_budget_tokens ?? null,
      show_whiteboard: form.show_whiteboard ?? null,
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

  async function saveAgentPromptFromEditor(nextPrompt: string, openingBaseline?: unknown) {
    requirePrimaryCaptureReady();
    const agentId = requireHydratedAgentDetail(
      selectedAgentId,
      promptPersistedSignature,
      "the agent prompt",
    );
    const captured = captureInstructions('agent', agentId, { system_prompt: nextPrompt }, {}, {}, openingBaseline as InstructionsBaseline | null ?? null);
    if (!Object.hasOwn(captured.body, 'system_prompt') || !captured.expectedInstructions) throw new InstructionsSaveRefusedError('This prompt was not sent. Use Saved Instructions and open the editor again.');
    basicSaveScope = "instructions";
    const payload = { id: agentId, system_prompt: nextPrompt, expectedInstructions: captured.expectedInstructions, hydrationGeneration: agentHydrationRequestId };
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
    const modelCaptured = untrack(() => captureModelSelection('agent', agentId, body, savedForm, baseForm));
    const compactCaptured = { ...modelCaptured, ...untrack(() => captureBasicAutoCompact(agentId, modelCaptured.body, modelCaptured.nextForm, baseForm)) };
    const captured = { ...compactCaptured, ...untrack(() => captureInstructions('agent', agentId, compactCaptured.body, compactCaptured.nextForm, baseForm)) };
    if (Object.keys(captured.body).length === 0) return;

    basicSaveScope = scope;
    basicSaveState = "saving";
    basicSaveError = null;
    // BL-911: the editor's change is not in the live form yet: it is laid over the form as the
    // save lands, so text typed elsewhere during the round trip stays (unless the agent was read
    // again meanwhile: `persistBasic` then leaves the form to that read and asks for another).
    const payload = { id: agentId, body: captured.body, expectedModelSelection: captured.expectedModelSelection, expectedInstructions: captured.expectedInstructions, expectedAutoCompact: captured.expectedAutoCompact, expectedTtsSelection: captured.expectedTtsSelection, hydrationGeneration: agentHydrationRequestId, baseForm };
    await basicSaves.run(agentId, () => persistBasic(payload, captured.nextForm, mutator));
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
    openingBaseline?: unknown,
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
    const typedCaptured = untrack(() => captureTypedTools('subagent', selectedEditableSubagentId!, buildSubagentSavePatch(savedForm), savedForm, subagentPersistedForm!));
    const modelCaptured = untrack(() => captureModelSelection('subagent', selectedEditableSubagentId!, typedCaptured.body, typedCaptured.nextForm, subagentPersistedForm!));
    const captured = { ...modelCaptured, ...untrack(() => captureInstructions('subagent', selectedEditableSubagentId!, modelCaptured.body, modelCaptured.nextForm, subagentPersistedForm!, scope === 'instructions' ? openingBaseline as InstructionsBaseline | null ?? null : undefined)) };
    if (scope === 'instructions' && Object.hasOwn(modelCaptured.body, 'system_prompt') && !Object.hasOwn(captured.body, 'system_prompt')) throw new InstructionsSaveRefusedError('This prompt was not sent. Use Saved Instructions and open the editor again.');
    const body = { ...captured.body, ...(captured.expectedModelSelection ? { expectedModelSelection: captured.expectedModelSelection } : {}), ...(captured.expectedInstructions ? { expectedInstructions: captured.expectedInstructions } : {}) };
    if (Object.keys(body).length === 0) return;

    subagentSaveScope = scope;
    subagentEditSaveState = "saving";
    subagentEditSaveError = null;
    const payload = { id: selectedEditableSubagentId, body, readGeneration: subagentReadGeneration };
    await subagentCoreSaves.run(payload.id, () => persistSubagentDetails(payload, captured.nextForm, mutator));
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
        if (buffer === null && threshold === null && autoZip === null && zipDisabled === null && !Object.keys(tool.retained ?? {}).length) {
          return null;
        }
        const payload: CustomToolPayload = {
          ...tool.retained,
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
    const liveFileReads =
      form.live_file_reads === "enabled"
        ? true
        : form.live_file_reads === "disabled"
          ? false
          : null;

    return {
      zip_ai_view_mode: zipAiViewMode,
      zip_tool_notes_enabled: zipToolNotesEnabled,
      live_file_reads: liveFileReads,
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
    retireCliAckOrigin("subagent", selectedEditableSubagentId, "mcp");
    if (subagentOwnedSaveInFlightUi) return;
    subagentDefaultMCPGateways = [...gateways];
  }

  function handleSubagentMcpDcmDisplaySettingsChange(
    settings: AgentDcmDisplaySettings,
  ) {
    retireCliAckOrigin("subagent", selectedEditableSubagentId, "mcp");
    if (subagentOwnedSaveInFlightUi) return;
    subagentDcmDisplaySettings = cloneDcmDisplaySettings(settings);
  }

  function clearSubagentMcpDefaults() {
    if (subagentCaptureBlocked) return;
    retireCliAckOrigin("subagent", selectedEditableSubagentId, "mcp");
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
      } else if (key === "live_file_reads") {
        result.live_file_reads = (value as AgentRow["live_file_reads"]) ?? null;
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
      retained: current?.retained,
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
      !getGlobalCustomToolSetting(normalizedName) && !Object.keys(nextEntry.retained ?? {}).length;

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

  function handleLiveFileReadsChange(value: string) {
    if (primaryOwnedSaveInFlightUi) return;
    zipForm = { ...zipForm, live_file_reads: value };
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

  function getPrimaryApprovalPolicyLabel(mode: "off" | "all") {
    return (
      PRIMARY_TOOL_APPROVAL_OPTIONS.find((option) => option.value === mode)?.label ?? "Never"
    );
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
   * What a save names, as a copy takes it. The Claude settings and the Tool Grid display
   * settings are written key by key (BL-848, BL-855), so a save of them names only the keys (or
   * map entries) it changed, a removed one as `null`, and a copy takes them the way the server
   * does (`applyAgentBlockUpdate`), never as a whole replacement of the block.
   */
  type AgentCollectionsUpdate = Omit<Partial<AgentRow>, AgentFieldByFieldBlock> & {
    [Field in AgentFieldByFieldBlock]?: AgentBlockSaveByField[Field] | null;
  };

  function updateAgentCollections(id: string, updates: AgentCollectionsUpdate) {
    // BL-2372 review A2: a landed save naming this agent's default project outranks an older
    // sidebar pick for it, even while another agent is current.
    if ("default_project_id" in updates) noteSavedDefaultProject(id);
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

  // SA-139 R6 (D16): one Subagent kind, so a live Subagent's row carries no type badge. A leftover
  // of a removed type (a CLI Subagent, R5; the list never holds an n8n one, R2) is listed but can
  // never be assigned, and its badge says why its switch is off.
  function formatSubagentBadge(subagent: SubagentRow) {
    return isRetiredSubagentType(normalizeSubagentType(subagent, subagent.subagentType)) ? "Removed Type" : "";
  }

  // SA-139 R4: every live Primary is an API agent, so Claude Code CLI presets never fit a Primary.
  function getPrimaryToolHostScope(): ToolHostScope {
    return "api";
  }

  // SA-139 R5: every live Subagent is an API agent too (a leftover CLI Subagent shows no picker
  // or Tool Grid), so the Subagent pickers and grid pass `api`, never `cli`.
  function getSubagentToolHostScope(): ToolHostScope {
    return "api";
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
      }}
    />

    {#if selectedEntity?.kind === "agent" && selectedAgentId}
      <!-- Primary Agent Settings Start -->
      <div class="batshit-settings-surface space-y-6">
              {#if primaryModelSelectionNotice && !detailLoading}
                <div class="batshit-settings-note is-dashed flex items-center gap-2" data-testid="primary-model-selection-notice" role="status">
                  <AlertCircle class="h-4 w-4" />
                  <span>{primaryModelSelectionNotice}</span>
                  <Button variant="outline" size="sm" disabled={primaryOwnedWritePendingUi} onclick={() => useSavedModelSelection('agent')}>Use Saved Model</Button>
                </div>
              {/if}
              {#if primarySettingsReadWaiting || primaryOwnedSaveInFlightUi}
                <div class="batshit-settings-note is-dashed flex items-center gap-2" data-testid="primary-settings-read-wait" role="status">
                  {#if primaryReadWaitError || primarySaveWaitExpiredUi}
                    <AlertCircle class="h-4 w-4" />
                    <span>{primaryReadWaitError ?? "Your last change to this agent did not confirm within 30 seconds. Batshit does not know if it was saved. Retry reads the record."}</span>
                  {:else if primaryDeferredDraftOnly}
                    <Info class="h-4 w-4" />
                    <span>Your unsaved edits are being kept.</span>
                  {:else}
                    <Loader2 class="h-4 w-4 animate-spin" />
                    <span>Waiting for saved agent settings…</span>
                  {/if}
                  {#if !primaryDeferredDraftOnly}<Button variant="outline" size="sm" onclick={retryPrimarySettingsRead}>Retry</Button>{/if}
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

              {#if selectedAgentId && primaryMcpHolds[selectedAgentId]}
                <div class="batshit-settings-action-row">
                  <span class="batshit-settings-form-meta is-error">Your Tool Settings draft is kept. Read saved values before another choice.</span>
                  <Button variant="outline" size="sm" disabled={mcpSaves.busy(selectedAgentId) || zipSaves.busy(selectedAgentId)} onclick={useSavedMcpSettings}>Use Saved Tool Settings</Button>
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
                subjectKind="primary"
                toolHostScope={getPrimaryToolHostScope()}
                userId={data?.user?.id ?? null}
                accordionName="agent-tools-cards"
                toolGridTitle="Agent Tool Grid Settings"
                defaultMCPGateways={defaultMCPGateways}
                defaultMCPToolSelections={defaultMCPToolSelections}
                defaultCliToolIds={defaultCliToolIds}
                cliToolIdsExplicit={cliToolIdsExplicit}
                dcmDisplaySettings={dcmDisplaySettings}
                mcpSaveState={mcpSaveState}
                enableSaveState={basicSaveScope === "tools" ? basicSaveState : "idle"}
                enableSaveError={basicSaveScope === "tools" ? basicSaveError ?? basicValidationError : null}
                mcpSaveError={mcpSaveError}
                mcpLastSaved={mcpLastSaved}
                mcpRenderNonce={mcpRenderNonce}
                nativeDynamicMcpEnabled={
                  getNativeToolToggle("dynamicMcpEnabled", true)
                }
                nativeCliToolsEnabled={getNativeToolToggle("cliToolsEnabled", true)}
                nativeToolSettings={getNativeToolsSettings("agent")}
                getEnableControl={id => getToolGridEnableControl(id, "agent")}
                discoveryReadOnly={cliPairBlocked("agent")}
                onGatewaysChange={guardPrimaryChoice(handleMcpGatewaysChange, true)}
                onDcmDisplaySettingsChange={guardPrimaryChoice(handleMcpDcmDisplaySettingsChange, true)}
                onCliToolIdsChange={guardPrimaryChoice(handleCliToolSelectionsChange, true)}
                getToolZipOverride={getMcpToolZipOverride}
                onToolZipOverrideChange={guardPrimaryChoice(handleMcpToolZipOverrideChange)}
                showZipControls={true}
                zipAiViewMode={zipForm.zip_ai_view_mode}
                zipToolNotesEnabled={zipForm.zip_tool_notes_enabled}
                liveFileReads={zipForm.live_file_reads}
                liveFileReadsUnavailableReason={refreshedFileReadsAvailability.unavailableReason}
                liveFileReadsWarn={refreshedFileReadsAvailability.warn}
                liveFileReadsNote={refreshedFileReadsAvailability.note}
                nonMcpZipRows={NON_MCP_ZIP_ROW_ORDER}
                getNonMcpZipOverride={getNonMcpZipOverrideById}
                onNonMcpZipOverrideChange={guardPrimaryChoice(handleNonMcpZipOverrideChangeById)}
                onZipAiViewModeChange={guardPrimaryChoice(handleZipAiViewModeChange)}
                onZipToolNotesChange={guardPrimaryChoice(handleZipToolNotesChange)}
                onLiveFileReadsChange={guardPrimaryChoice(handleLiveFileReadsChange)}
                onResetToGlobalSettings={resetToolGridToGlobalSettings}
                zipSaveState={zipSaveState}
                zipSaveError={zipSaveError}
                zipValidationError={zipValidationError}
                zipLastSaved={zipLastSaved}
                fullWidthTable={true}
              >
              </AgentMcpDefaultsCard>
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
                            {#if isRetiredPrimaryAgentType(basicForm.agentType)}
                              <!-- SA-139 R4 (D14): a leftover of a removed Primary type is refused; Delete is its only action. -->
                              <div class="batshit-settings-identity-meta-item" data-testid="primary-retired-type-notice">
                                <span class="batshit-settings-caption">{retiredPrimaryDetails(basicForm)}</span>
                              </div>
                            {/if}
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
                                    disabled={primaryModelSelectionBlocked || primaryModelConnectionsBlocked}
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
                                <Button variant="ghost" size="icon" class="batshit-button-shrink-0" title="Clear Saved Model" aria-label="Clear Saved Model"
                                  disabled={!canClearModelSelection('agent')} onclick={() => { if (canClearModelSelection('agent')) clearAgentModelSelection(); }}>
                                  <X class="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </div>

                              {#if modelClearEligibility('agent').unreadable}
                                <p class="batshit-settings-form-meta is-warning">Saved Model clear is unavailable because the saved model selection is unreadable.</p>
                              {/if}
                              {#if selectedModelId}
                                {#if selectedPrimaryModelAvailability?.disabled}
                                  <p class="batshit-settings-form-meta is-warning">
                                    {selectedPrimaryModelAvailability.reason}
                                  </p>
                                {/if}
                              {/if}
                              {#if isApiPrimaryAgentType(basicForm.agentType) && modelConnectionOptionsLoading}
                                <p class="batshit-settings-form-meta">
                                  Loading connection status…
                                </p>
                              {:else if isApiPrimaryAgentType(basicForm.agentType) && modelConnectionOptionsError}
                                <p class="batshit-settings-form-meta is-error">{modelConnectionOptionsError}</p>
                              {/if}
                              {#if savedModelsError}
                                <p class="batshit-settings-form-meta is-error">{savedModelsError}</p>
                              {/if}
                            </div>
                          </div>
                        </div>

                        {#if basicForm.agentType === 'api' && selectedAgentId}
                          <ModelReasoningControl agentId={selectedAgentId} preset={selectedPrimaryModel} surface="settings"
                            disabled={primaryCaptureBlocked || primaryOwnedSaveInFlightUi}
                            canEdit={() => !primaryCaptureBlocked && !primaryOwnedSaveInFlightUi} />
                        {/if}

                        {#if isApiPrimaryAgentType(basicForm.agentType)}
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
                                  Shows available reasoning in a collapsed section. Batshit saves the reasoning the model exposes independently of this display preference. Reasoning Retention below controls whether completed replies' reasoning enters later model context. This does not change how much reasoning the model generates.
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </div>
                            <Switch.Root
                              checked={basicForm.show_reasoning}
                              onCheckedChange={guardPrimaryChoice((checked: boolean) => {
                                basicForm = { ...basicForm, show_reasoning: checked };
                              })}
                            />
                          </div>

                          <ReasoningRetentionFields value={basicForm}
                            ownerId={selectedAgentId ?? ''}
                            disabled={primaryCaptureBlocked || primaryOwnedSaveInFlightUi}
                            onChange={guardPrimaryChoice((patch: AgentReasoningRetention) => { basicForm = { ...basicForm, ...patch }; basicSaveScope = 'core'; })} />
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

                        {#if autoCompactNotice}
                          <div class="batshit-settings-note is-dashed flex items-center gap-2" data-testid="auto-compact-notice" role="status">
                            <span>{autoCompactNotice}</span>
                            <Button variant="outline" size="sm" disabled={primaryOwnedWritePendingUi} onclick={useSavedAutoCompact}>Use Saved Auto Compact</Button>
                          </div>
                        {/if}
                        <fieldset class="contents" disabled={autoCompactBlocked} inert={autoCompactBlocked}>
                        <AgentAutoCompactSettingsCard
                          settings={basicForm.auto_compact_settings}
                          {savedModels}
                          {savedModelsLoading}
                          {savedModelsError}
                          onRefreshModels={refreshModelPickerData}
                          onChange={guardPrimaryChoice((nextSettings) => {
                            if (autoCompactBlocked) return;
                            basicForm = {
                              ...basicForm,
                              auto_compact_settings: nextSettings,
                            };
                          })}
                        />
                        </fieldset>

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
                          fabricUtilitiesEnabled={primaryFabricUtilitiesEnabled}
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
                          skillSessionMode={basicForm.jev_juice_skill_tool_hints}
                          judgeToolEnabled={basicForm.jev_juice_judge_tool}
                          memoryRerankEnabled={basicForm.jev_juice_memory_rerank}
                          memoryRecallEnabled={basicForm.jev_juice_memory_recall}
                          replyCheckEnabled={basicForm.jev_juice_reply_check}
                          styleCoachEnabled={basicForm.jev_juice_style_coach}
                          memoryEnabled={basicForm.memory_settings?.enabled === true}
                          fabricUtilitiesEnabled={primaryFabricUtilitiesEnabled}
                          onSkillSessionModeChange={guardPrimaryChoice((mode) =>
                            (basicForm = { ...basicForm, jev_juice_skill_tool_hints: mode }))}
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
                            Only primary agents can ask for extra approval.
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
                          <SettingsInfoMenu ariaLabel="About Always Block List" contentClass="w-80">
                            <p>Rules in this list are blocked for all modes, including Batshit Crazy.</p>
                            <p class="mt-2">{TYPED_FILE_TOOLS_BLOCK_LIST_SENTENCE}</p>
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
                {/if}
            {/snippet}
              <div
                class="space-y-2"
                onfocusin={() => (basicSaveScope = "projects")}
              >
                <div class="flex items-center gap-1.5 px-4 pt-3">
                  <Label.Label>Default Project</Label.Label>
                  <SettingsInfoMenu ariaLabel="About Default Project">
                    The Projects sidebar shows this project for this agent. A project picked in the sidebar
                    is used instead until you save a new default here. Use Global Default Project uses the
                    Default Project from Settings > Projects.
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
          </SettingsAccordionCard>

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
                        disabled={primaryInstructionsPromptBlocked}
                        onclick={() => { if (!primaryInstructionsPromptBlocked) agentPromptEditorOpen = true; }}
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
                    <Switch.Root bind:checked={basicForm.include_global_prompt} disabled={primaryInstructionsIncludeBlocked} />
                  </div>
                  {#if primaryInstructionsNotice}
                    <div class="batshit-settings-note is-dashed" data-testid="primary-instructions-notice" role="status">
                      <p class="batshit-settings-caption">{primaryInstructionsNotice}</p>
                      <Button type="button" variant="outline" size="sm" disabled={primaryCaptureBlocked || promptSaves.busy(selectedAgentId ?? '')} onclick={() => void useSavedInstructions('agent')}>Use Saved Instructions</Button>
                    </div>
                  {/if}
                </div>
          </SettingsAccordionCard>


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

          {#if ttsNotice}
            <div class={`batshit-settings-note is-dashed flex items-center gap-2 ${hiddenUnless("voice")}`} data-testid="tts-selection-notice" role="status">
              <span>{ttsNotice}</span>
              <Button size="sm" variant="outline" disabled={primaryOwnedSaveInFlightUi} onclick={useSavedTts}>Use Saved Reply Voice</Button>
            </div>
          {/if}
          <fieldset class="contents" disabled={ttsBlocked} inert={ttsBlocked}>
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
                      onValueChange={guardVoiceChoice((value) => {
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
                    {#if voiceTranscriptionModelNotice(basicForm.voice_profile.sttProvider, basicForm.voice_profile.sttModel)}
                      <p class="batshit-settings-form-meta is-warning">{voiceTranscriptionModelNotice(basicForm.voice_profile.sttProvider, basicForm.voice_profile.sttModel)}</p>
                    {/if}
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
                      onValueChange={guardVoiceChoice((value) =>
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
                      onValueChange={guardVoiceChoice((value) => {
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
                      onValueChange={guardVoiceChoice((value) => {
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
                      onValueChange={guardVoiceChoice((value) => {
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
                      onValueChange={guardVoiceChoice((value) => {
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
                      onValueChange={guardVoiceChoice((value) =>
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
                        onValueChange={guardVoiceChoice((value) =>
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
                      {#if effectiveVoiceModelNotice}
                        <p class="batshit-settings-form-meta is-warning">{effectiveVoiceModelNotice}</p>
                      {/if}
                      {#if voiceModelCatalogNotice(selectedVoiceProvider, ['tts-batch', 'tts-direct-stream'], basicForm.voice_profile.model)}
                        <p class="batshit-settings-form-meta is-warning">{voiceModelCatalogNotice(selectedVoiceProvider, ['tts-batch', 'tts-direct-stream'], basicForm.voice_profile.model)}</p>
                      {/if}
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
                          onValueChange={guardVoiceChoice((value) =>
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
                                : `Use Default${defaultAgentTtsModel ? ` (${defaultAgentTtsModel})` : ""}`}
                            </span>
                            <Badge variant="outline" class={`${selectedAgentTtsBadgeClass} shrink-0`}>
                              {selectedAgentTtsLaneLabel}
                            </Badge>
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="">
                              <div class="flex items-center justify-between gap-2">
                                <span>Use Default{defaultAgentTtsModel ? ` (${defaultAgentTtsModel})` : ""}</span>
                                <Badge variant="outline" class={`${getTtsBadgeClass(selectedAgentTtsProviderForBadge, defaultAgentTtsModel)} shrink-0`}>
                                  {getTtsLaneLabel(selectedAgentTtsProviderForBadge, defaultAgentTtsModel)}
                                </Badge>
                              </div>
                            </Select.Item>
                            {#each voiceModelOptions as model (model)}
                              <Select.Item value={model}>
                                <div class="flex items-center justify-between gap-2">
                                  <span>{model}</span>
                                  <Badge variant="outline" class={getTtsBadgeClass(selectedVoiceProvider, model)}>
                                    {getTtsLaneLabel(selectedVoiceProvider, model)}
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
                            onValueChange={guardVoiceChoice((value) => {
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
                                  : agentVoiceUsesModelSpecificVoices ? "Use inherited voice" : `Use Default${selectedVoiceProvider?.defaultVoice ? ` (${selectedVoiceProvider.defaultVoice})` : ""}`}
                              </span>
                            </Select.Trigger>
                            <Select.Content>
                              <Select.Item value="">
                                {agentVoiceUsesModelSpecificVoices ? "Use inherited voice" : `Use Default${selectedVoiceProvider?.defaultVoice ? ` (${selectedVoiceProvider.defaultVoice})` : ""}`}
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
                      onValueChange={guardVoiceChoice((value) => {
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
          </fieldset>

          {#if selectedAgentId}
            {#key selectedAgentId}
              <AgentAppActionsAccessCard agentId={selectedAgentId} sectionClass={hiddenUnless("access")} active={activeAgentSettingsTab === "access"} />
            {/key}
          {/if}
          <AgentAccessAssignmentsSection
            sectionClass={hiddenUnless("access")}
            {subagentsLoading}
            {subagents}
            {selectedSubagentIds}
            {selectedAgentId}
            {assignmentSaveState}
            {assignmentSaveError}
            workersEnabled={basicForm.workers_enabled}
            workersMaxConcurrent={WORKERS_MAX_CONCURRENT}
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
            onAccessRetry={() => void loadAccessResources(true)}
            onAccessSaveScopeChange={(scope) => {
              accessSaveScope = scope
            }}
          />

          <AgentDeleteDisclosure
            bind:open={primaryDeleteOpen}
            sectionClass={hiddenUnless("core")}
            title="Delete Primary Agent"
            paragraphs={[
              isRetiredPrimaryAgentType(basicForm.agentType)
                ? "This saved record uses a Primary Agent type that Batshit removed. Deleting it is the only supported action; create a new Primary Agent for chat."
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
              {#if subagentModelSelectionNotice && !subagentDetailLoading}
                <div class="batshit-settings-note is-dashed flex items-center gap-2" data-testid="subagent-model-selection-notice" role="status">
                  <AlertCircle class="h-4 w-4" />
                  <span>{subagentModelSelectionNotice}</span>
                  <Button variant="outline" size="sm" disabled={subagentOwnedWritePendingUi} onclick={() => useSavedModelSelection('subagent')}>Use Saved Model</Button>
                </div>
              {/if}
              {#if subagentSettingsReadWaiting || subagentOwnedSaveInFlightUi}
                <div class="batshit-settings-note is-dashed flex items-center gap-2" data-testid="subagent-settings-read-wait" role="status">
                  {#if subagentReadWaitError || subagentSaveWaitExpiredUi}
                    <AlertCircle class="h-4 w-4" />
                    <span>{subagentReadWaitError ?? "Your last change to this subagent did not confirm within 30 seconds. Batshit does not know if it was saved. Retry reads the record."}</span>
                  {:else if subagentDeferredDraftOnly}
                    <Info class="h-4 w-4" />
                    <span>Your unsaved edits are being kept.</span>
                  {:else}
                    <Loader2 class="h-4 w-4 animate-spin" />
                    <span>Waiting for saved subagent settings…</span>
                  {/if}
                  {#if !subagentDeferredDraftOnly}<Button variant="outline" size="sm" onclick={retrySubagentSettingsRead}>Retry</Button>{/if}
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

              <!-- SA-139 R5 (D14): a leftover of a removed Subagent type shows only its identity,
                   its retired line and its Delete; every other section and tab is hidden. -->
              {#if !retiredSubagentDetails}
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
                  subjectKind="subagent"
                  toolHostScope={getSubagentToolHostScope()}
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
                  getEnableControl={id => getToolGridEnableControl(id, "subagent")}
                  discoveryReadOnly={cliPairBlocked("subagent")}
                  onGatewaysChange={guardSubagentChoice(handleSubagentMcpGatewaysChange, true)}
                  onDcmDisplaySettingsChange={guardSubagentChoice(handleSubagentMcpDcmDisplaySettingsChange, true)}
                  onCliToolIdsChange={guardSubagentChoice(handleSubagentCliToolSelectionsChange, true)}
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
                                disabled={Boolean(retiredSubagentDetails)}
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
                            {#if retiredSubagentDetails}
                              <!-- SA-139 R5 (D14): a leftover of a removed Subagent type is refused; Delete is its only action. -->
                              <div class="batshit-settings-identity-meta-item" data-testid="subagent-retired-type-notice">
                                <span class="batshit-settings-caption">{retiredSubagentDetails}</span>
                              </div>
                            {/if}
                          </div>
                        </div>

                        {#if !retiredSubagentDetails}
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
                                  This model is used directly by Batshit when this Subagent runs.
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
                                    value={(selectedSubagentModelId ?? "") as unknown as string}
                                    disabled={subagentModelSelectionBlocked}
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
                                <Button variant="ghost" size="icon" class="batshit-button-shrink-0" title="Clear Saved Model" aria-label="Clear Saved Model"
                                  disabled={!canClearModelSelection('subagent')} onclick={() => { if (canClearModelSelection('subagent')) clearSubagentModelSelection(); }}>
                                  <X class="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </div>

                              {#if modelClearEligibility('subagent').unreadable}
                                <p class="batshit-settings-form-meta is-warning">Saved Model clear is unavailable because the saved model selection is unreadable.</p>
                              {/if}
                              {#if selectedSubagentModelId}
                                {@const selected =
                                  savedModels.find((item) => item.id === selectedSubagentModelId) ?? null}
                                {@const availability = selected
                                  ? getModelPresetAvailability({
                                      model: selected,
                                      agentType: getSubagentToolHostScope(),
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
                                  Leave blank for no time limit: the call runs until it is done, and Stop always ends it. Batshit still stops a call that shows no progress for 10 minutes (a tool that is still running, like a long build, counts as progress). To set a limit, enter seconds from 10 to 86400 (24 hours). This covers the call itself, not time spent waiting for a turn: Batshit runs one call per Subagent at a time so its thread stays intact, so a call made while this Subagent is already busy waits for the earlier call to finish first. Batshit says so in the result when that happens. Use Workers for work that should genuinely run at the same time.
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </div>
                            {#if normalizeSubagentTimeoutSeconds(subagentForm.timeout_seconds) !== undefined}
                              <p class="batshit-settings-form-meta">
                                {formatDelegationDuration(Number(subagentForm.timeout_seconds))}
                              </p>
                            {/if}
                          </div>
                          <div class="batshit-settings-form-control">
                            <Input
                              id="subagent-timeout"
                              type="number"
                              min={MIN_SUBAGENT_TIMEOUT_SECONDS}
                              max={MAX_SUBAGENT_TIMEOUT_SECONDS}
                              step="1"
                              placeholder="No limit"
                              bind:value={subagentForm.timeout_seconds}
                            />
                          </div>
                        </div>

                        <div class="batshit-settings-form-row">
                          <div class="batshit-settings-form-copy">
                            <div class="batshit-settings-form-label-line">
                              <Label.Label class="batshit-settings-form-label" for="subagent-max-tool-steps">
                                Max Tool Steps
                              </Label.Label>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger
                                  class={SETTINGS_INFO_TRIGGER_CLASS}
                                  aria-label="About Subagent Max Tool Steps"
                                >
                                  <Info class="h-3.5 w-3.5" />
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Content
                                  align="start"
                                  side="bottom"
                                  class={SETTINGS_INFO_CONTENT_CLASS}
                                >
                                  Leave blank for no limit. Otherwise, the most tool calls this Subagent may make in one call (1 to 10000). At the limit Batshit stops it and returns its work so far, marked partial, and the Primary Agent can resume it to continue. Workers copied from this Subagent follow the same limit.
                                </DropdownMenu.Content>
                              </DropdownMenu.Root>
                            </div>
                          </div>
                          <div class="batshit-settings-form-control">
                            <Input
                              id="subagent-max-tool-steps"
                              type="number"
                              min={MIN_SUBAGENT_MAX_TOOL_STEPS}
                              max={MAX_SUBAGENT_MAX_TOOL_STEPS}
                              step="1"
                              placeholder="No limit"
                              bind:value={subagentForm.max_tool_steps}
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
                          <!-- SA-139 R5: a leftover is never saved, so its avatar is shown without
                               the upload, icon and remove controls (an upload writes a file first). -->
                          {#if !retiredSubagentDetails}
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
                          {/if}
                        </div>
                      </div>
                    </div>
                  </div>
              </SettingsAccordionCard>

              {#if !retiredSubagentDetails}
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
                        disabled={subagentInstructionsPromptBlocked}
                        onclick={() => { if (!subagentInstructionsPromptBlocked) subagentPromptEditorOpen = true; }}
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
                    <Switch.Root bind:checked={subagentForm.include_global_prompt} disabled={subagentInstructionsIncludeBlocked} />
                  </div>
                  {#if subagentInstructionsNotice}
                    <div class="batshit-settings-note is-dashed" data-testid="subagent-instructions-notice" role="status">
                      <p class="batshit-settings-caption">{subagentInstructionsNotice}</p>
                      <Button type="button" variant="outline" size="sm" disabled={subagentCaptureBlocked} onclick={() => void useSavedInstructions('subagent')}>Use Saved Instructions</Button>
                    </div>
                  {/if}
                </div>
          </SettingsAccordionCard>
              {/if}
              {#if !retiredSubagentDetails}
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
                        <SettingsInfoMenu ariaLabel="About Subagent Always Block List" contentClass="w-80">
                          <p>Rules in this list are blocked for all modes, including Batshit Crazy.</p>
                          <p class="mt-2">{TYPED_FILE_TOOLS_BLOCK_LIST_SENTENCE}</p>
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

          {#if !retiredSubagentDetails}
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
            onAccessRetry={() => void loadAccessResources(true)}
            onAccessSaveScopeChange={(scope) => {
              accessSaveScope = scope
            }}
          />
          {/if}

          <AgentDeleteDisclosure
            bind:open={subagentDeleteOpen}
            sectionClass={hiddenUnlessSubagent("core")}
            title="Delete Subagent"
            paragraphs={[
              retiredSubagentDetails
                ? "This saved record uses a Subagent type that Batshit removed. Deleting it is the only supported action; it also removes its managed CLI settings folder. Create a new Subagent to keep working."
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
  baseline={primaryInstructionsBaseline}
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
  baseline={subagentInstructionsBaseline}
  placeholder="Custom instructions for this Subagent"
  width="large"
  onSave={async (value, baseline) =>
    saveSubagentMultilineEditor("instructions", (current) => ({
      ...current,
      system_prompt: value,
    }), baseline)}
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
                  Lowercase letters, numbers, and underscores only. Used in Redis keys.
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
          {/if}
          <!-- SA-139 R6 (D16): one Subagent kind, so the create dialog has no type choice; a Subagent is created as `api`. -->
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
