<script lang="ts">
        import Users from '@lucide/svelte/icons/users';
        import Sparkles from '@lucide/svelte/icons/sparkles';
        import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte';
        import CoolToolRenderer from '../CoolToolRenderer.svelte';
        import FullTool from '../templates/FullTool.svelte';
        import { getAgents, getCurrentAgent } from '$lib/stores/agents.svelte';
        import { subagentStore } from '$lib/stores/subagents.svelte';
        import { DEFAULT_AGENT_ICON_REF, DEFAULT_SUBAGENT_ICON_REF } from '$lib/icons/iconCatalog';
        import { normalizeIconRef } from '$lib/icons/iconLegacy';
        import { normalizeAvatarIconFit, type AvatarIconFit, type IconRef } from '$lib/icons/iconTypes';
        import { numericKeyObjectToArray } from '$lib/utils/toolPayloadUnwrap';

        const DEFAULT_AVATAR = '/assets/batshit_default_AI_Avatar_1.png';

        // Accept the standard tool prop from CoolToolRenderer
        let { tool } = $props();

        let collapsed = $state(true); // FullTool uses collapsed, not isExpanded
        let subagentName = $state('Subagent');
        let subagentAvatar = $state<string | null>(DEFAULT_AVATAR);
        let subagentAvatarIconRef = $state<IconRef | null>(null);
        let subagentAvatarIconFit = $state<AvatarIconFit>('fill');
        let primaryAgentName = $state('Primary Agent');
        let primaryAgentAvatar = $state<string | null>(DEFAULT_AVATAR);
        let primaryAgentAvatarIconRef = $state<IconRef | null>(null);
        let primaryAgentAvatarIconFit = $state<AvatarIconFit>('fill');

        const toPlain = (val: any) => {
                try {
                        // structuredClone keeps objects plain and strips proxies/functions
                        return typeof structuredClone === 'function' ? structuredClone(val) : JSON.parse(JSON.stringify(val));
                } catch (e) {
                        return val;
                }
        };

        let toolResult: any = $derived.by(() => {
                // CoolToolRenderer now passes clean JSON; accept both raw object and stringified
                const val = tool?.toolResult ?? {};
                if (typeof val === 'string') {
                        try {
                                return JSON.parse(val);
                        } catch (e) {
                                return { output: val };
                        }
                }
                return toPlain(val) || {};
        });
        let availableSubagents = $derived(subagentStore.subagents);
        let availableAgents = $derived(getAgents());
        let currentAgent = $derived(getCurrentAgent());

        function normalize(value?: string | null): string {
                if (typeof value !== 'string') return '';
                return value
                        .trim()
                        .toLowerCase()
                        .replace(/[_-]+/g, ' ')
                        .replace(/\s+/g, ' ');
        }

        function firstString(...values: unknown[]): string | null {
                for (const value of values) {
                        if (typeof value !== 'string') continue;
                        const trimmed = value.trim();
                        if (trimmed.length > 0) return trimmed;
                }
                return null;
        }

        function resolveIconRef(fallback: IconRef, ...values: unknown[]): IconRef | null {
                for (const value of values) {
                        if (value === null || value === undefined) continue;
                        if (typeof value === 'string' && value.trim().length === 0) continue;
                        return normalizeIconRef(value, fallback);
                }
                return null;
        }

        function resolveAvatarUrl(iconRef: IconRef | null, ...values: unknown[]): string | null {
                return firstString(...values) || (iconRef ? null : DEFAULT_AVATAR);
        }

        const slugify = (value?: string | null): string => {
                if (typeof value !== 'string') return '';
                return value
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_+|_+$/g, '');
        };

        function extractMessage(value: unknown, depth = 0): string {
                if (value === null || value === undefined) return '';
                if (typeof value === 'string') return value;
                if (typeof value === 'number' || typeof value === 'boolean') return String(value);
                if (depth > 4) {
                        return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
                }

                if (Array.isArray(value)) {
                        const parts = value
                                .map((entry) => extractMessage(entry, depth + 1))
                                .map((part) => part.trim())
                                .filter((part, index, arr) => part.length > 0 && arr.indexOf(part) === index);

                        if (parts.length === 0) {
                                return JSON.stringify(value, null, 2);
                        }

                        return parts.join('\n\n');
                }

                if (typeof value === 'object') {
                        if ('content' in value) {
                                return extractMessage((value as any).content, depth + 1);
                        }
                        if ('text' in value && typeof (value as any).text === 'string') {
                                return (value as any).text;
                        }
                        if ('value' in value) {
                                return extractMessage((value as any).value, depth + 1);
                        }
                        if ('message' in value) {
                                return extractMessage((value as any).message, depth + 1);
                        }
                        if ('preview' in value) {
                                return extractMessage((value as any).preview, depth + 1);
                        }
                        if ('prompt' in value && typeof (value as any).prompt === 'string') {
                                return (value as any).prompt;
                        }
                        if ('chatInput' in value) {
                                return extractMessage((value as any).chatInput, depth + 1);
                        }
                        if ('output' in value) {
                                return extractMessage((value as any).output, depth + 1);
                        }
                        if ('result' in value) {
                                return extractMessage((value as any).result, depth + 1);
                        }

                        return JSON.stringify(value, null, 2);
                }

                return String(value);
        }

        let input = $derived.by(() => {
                const inputData =
                        tool?.toolInput?.chatInput ??
                        tool?.toolInput?.Prompt__User_Message_ ??
                        tool?.toolInput?.prompt ??
                        toolResult?.input ??
                        tool?.toolInput;

                return extractMessage(inputData);
        });

        let output = $derived.by(() => {
                // 1) Start from the most direct candidates
                let result =
                        toolResult?.output ??
                        tool?.toolResult?.output ??
                        tool?.toolResult?.result ??
                        tool?.result ??
                        tool?.toolResult ??
                        toolResult;

                // 2) If it's a JSON string, parse once
                if (typeof result === 'string') {
                        try {
                                result = JSON.parse(result);
                        } catch (e) {
                                // leave as string
                        }
                }

                const numericExtract = numericKeyObjectToArray(result);
                if (Array.isArray(numericExtract)) {
                        result = numericExtract;
                }

                // 4) If still an object with a direct output/value/result/content, use it
                if (!Array.isArray(result) && result && typeof result === 'object') {
                        const direct =
                                (result as any).output ??
                                (result as any).result ??
                                (result as any).value ??
                                (result as any).content ??
                                (result as any).preview;
                        if (direct !== undefined) {
                                result = direct;
                        }
                }

                // 5) If array, prefer first non-null element's output/result/value
                if (Array.isArray(result)) {
                        const first = result.find((r) => r !== undefined && r !== null) ?? result[0];
                        result =
                                first?.output ??
                                first?.result ??
                                first?.value ??
                                first?.content ??
                                first?.preview ??
                                first;
                }

                // 6) Explicit fallback for the common cool_tool zip shape (numeric key + output)
                if ((!result || (typeof result === 'string' && result.trim() === '')) && toolResult) {
                        if (typeof (toolResult as any).output === 'string' && (toolResult as any).output.trim().length > 0) {
                                result = (toolResult as any).output;
                        } else if ((toolResult as any)['0']?.output) {
                                result = (toolResult as any)['0']?.output;
                        }
                }

                const message = extractMessage(result);

                return message;
        });

        let intermediateSteps = $derived.by(() => {
                const result = toolResult;

                if (Array.isArray(result) && result[0]) {
                        const firstResult = result[0];

                        if (firstResult?.intermediateSteps) {
                                return firstResult.intermediateSteps;
                        }

                        if (Array.isArray(firstResult?.output)) {
                                const firstOutput = firstResult.output[0];
                                if (firstOutput?.intermediateSteps) {
                                        return firstOutput.intermediateSteps;
                                }
                        }
                }

                if (result?.intermediateSteps) {
                        return result.intermediateSteps;
                }

                if (Array.isArray(result?.output) && result.output[0]?.intermediateSteps) {
                        return result.output[0].intermediateSteps;
                }

                if (Array.isArray(tool?.toolResult) && tool.toolResult[0]?.intermediateSteps) {
                        return tool.toolResult[0].intermediateSteps;
                }

                return null;
        });

        let candidateSubagentId = $derived.by(() => {
                const fromTool = typeof tool?.subagentId === 'string' ? tool.subagentId : undefined;
                const fromMeta = typeof tool?.metadata?.subagentId === 'string' ? tool.metadata.subagentId : undefined;
                const fromResult = typeof toolResult?.subagentId === 'string' ? toolResult.subagentId : undefined;
                const fromInput = typeof tool?.toolInput?.subagentId === 'string' ? tool?.toolInput?.subagentId : undefined;
                const fromSteps =
                        Array.isArray(intermediateSteps) && intermediateSteps.length > 0
                                ? intermediateSteps[0]?.toolArgs?.subagentId
                                : undefined;
                const fromName = tool?.toolName && tool?.isSubagent ? tool.toolName : undefined;
                const candidate = fromTool ?? fromMeta ?? fromResult ?? fromInput ?? fromSteps ?? fromName;
                return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
        });

        let candidateSubagentName = $derived.by(() => {
                const fromResult = typeof toolResult?.subagentName === 'string' ? toolResult.subagentName : undefined;
                const fromTool = typeof tool?.subagentName === 'string' ? tool?.subagentName : undefined;
                const fromMeta = typeof tool?.metadata?.subagentName === 'string' ? tool.metadata.subagentName : undefined;
                const fromArgs = typeof tool?.toolInput?.subagentName === 'string' ? tool?.toolInput?.subagentName : undefined;
                const fromSteps =
                        Array.isArray(intermediateSteps) && intermediateSteps.length > 0
                                ? intermediateSteps[0]?.subagentName || intermediateSteps[0]?.toolName
                                : undefined;
                const fromToolName = tool?.toolName && tool?.isSubagent ? tool.toolName : undefined;

                const candidate = fromResult ?? fromTool ?? fromMeta ?? fromArgs ?? fromSteps ?? fromToolName;

                if (typeof candidate === 'string' && candidate.trim().length > 0 && candidate !== 'call_subagent') {
                        return candidate;
                }

                return 'Subagent';
        });

        let candidateAgentName = $derived.by(() => {
                const fromResult = typeof toolResult?.agentName === 'string' ? toolResult.agentName : undefined;
                const fromTool = typeof tool?.agentName === 'string' ? tool?.agentName : undefined;
                const fromMeta = typeof tool?.metadata?.agentName === 'string' ? tool.metadata.agentName : undefined;
                const fromArgs = typeof tool?.toolInput?.agentName === 'string' ? tool?.toolInput?.agentName : undefined;
                const fromCurrent = currentAgent?.displayName || currentAgent?.name;

                const candidate = fromResult ?? fromTool ?? fromMeta ?? fromArgs ?? fromCurrent;

                if (typeof candidate === 'string' && candidate.trim().length > 0) {
                        return candidate;
                }

                return 'Primary Agent';
        });

        function findMatchingAgent(name: string) {
                const normalizedName = normalize(name);
                if (!normalizedName) return null;

                return (
                        availableAgents.find(
                                (agent) =>
                                        normalize(agent.displayName) === normalizedName || normalize(agent.name) === normalizedName
                        ) || null
                );
        }

        function findMatchingSubagent(name: string, id?: string) {
                const normalizedName = normalize(name);
                const normalizedId = slugify(id);

                return (
                        availableSubagents.find((subagent) => {
                                const subSlug = slugify(subagent.id) || slugify(subagent.displayName);
                                if (normalizedId && subSlug === normalizedId) {
                                        return true;
                                }

                                return normalize(subagent.displayName) === normalizedName;
                        }) || null
                );
        }

        $effect(() => {
                const resolvedSubagentName = candidateSubagentName;
                const resolvedSubagent = findMatchingSubagent(resolvedSubagentName, candidateSubagentId);
                const resolvedSubagentAny = resolvedSubagent as any;
                const metadata = tool?.metadata || {};

                subagentName = resolvedSubagent?.displayName || resolvedSubagentName || 'Subagent';
                const nextSubagentAvatarIconRef = resolveIconRef(
                        DEFAULT_SUBAGENT_ICON_REF,
                        resolvedSubagentAny?.avatar_icon_ref,
                        resolvedSubagentAny?.avatarIconRef,
                        metadata.subagentAvatarIconRef,
                        metadata.subagent_avatar_icon_ref,
                        metadata.avatarIconRef
                );
                const nextSubagentAvatarIconFit = normalizeAvatarIconFit(
                        resolvedSubagentAny?.avatar_icon_fit ??
                                resolvedSubagentAny?.avatarIconFit ??
                                metadata.subagentAvatarIconFit ??
                                metadata.subagent_avatar_icon_fit ??
                                metadata.avatarIconFit
                );
                const nextSubagentAvatar = resolveAvatarUrl(
                        nextSubagentAvatarIconRef,
                        resolvedSubagentAny?.avatar ||
                                resolvedSubagentAny?.avatar_url ||
                                resolvedSubagentAny?.avatarUrl,
                        tool?.subagentAvatar,
                        metadata.subagentAvatar,
                        metadata.subagentAvatarUrl,
                        metadata.avatarUrl
                );
                subagentAvatarIconRef = nextSubagentAvatarIconRef;
                subagentAvatarIconFit = nextSubagentAvatarIconFit;
                subagentAvatar = nextSubagentAvatar;

                const resolvedAgentName = candidateAgentName;
                const resolvedAgent = findMatchingAgent(resolvedAgentName);
                const fallbackCurrentAgent = !resolvedAgent && resolvedAgentName === 'Primary Agent' ? currentAgent : null;
                const resolvedAgentAny = resolvedAgent as any;
                const fallbackCurrentAgentAny = fallbackCurrentAgent as any;

                primaryAgentName =
                        resolvedAgent?.displayName ||
                        resolvedAgent?.name ||
                        (resolvedAgentName !== 'Primary Agent' ? resolvedAgentName : undefined) ||
                        fallbackCurrentAgent?.displayName ||
                        fallbackCurrentAgent?.name ||
                        'Primary Agent';
                const nextPrimaryAgentAvatarIconRef = resolveIconRef(
                        DEFAULT_AGENT_ICON_REF,
                        resolvedAgentAny?.avatar_icon_ref,
                        resolvedAgentAny?.avatarIconRef,
                        metadata.agentAvatarIconRef,
                        metadata.primaryAgentAvatarIconRef,
                        metadata.agent_avatar_icon_ref,
                        metadata.primary_agent_avatar_icon_ref,
                        fallbackCurrentAgentAny?.avatar_icon_ref,
                        fallbackCurrentAgentAny?.avatarIconRef
                );
                const nextPrimaryAgentAvatarIconFit = normalizeAvatarIconFit(
                        resolvedAgentAny?.avatar_icon_fit ??
                                resolvedAgentAny?.avatarIconFit ??
                                metadata.agentAvatarIconFit ??
                                metadata.primaryAgentAvatarIconFit ??
                                metadata.agent_avatar_icon_fit ??
                                metadata.primary_agent_avatar_icon_fit ??
                                fallbackCurrentAgentAny?.avatar_icon_fit ??
                                fallbackCurrentAgentAny?.avatarIconFit
                );
                const nextPrimaryAgentAvatar = resolveAvatarUrl(
                        nextPrimaryAgentAvatarIconRef,
                        resolvedAgentAny?.avatar_url,
                        resolvedAgentAny?.avatar,
                        metadata.agentAvatar,
                        metadata.agentAvatarUrl,
                        metadata.primaryAgentAvatar,
                        metadata.primaryAgentAvatarUrl,
                        fallbackCurrentAgentAny?.avatar_url,
                        fallbackCurrentAgentAny?.avatar
                );
                primaryAgentAvatarIconRef = nextPrimaryAgentAvatarIconRef;
                primaryAgentAvatarIconFit = nextPrimaryAgentAvatarIconFit;
                primaryAgentAvatar = nextPrimaryAgentAvatar;
        });
</script>

<FullTool
	icon={Users}
	title="Subagent Call"
	subtitle={subagentName !== 'Subagent' ? `Conversation with ${subagentName}` : 'Conversation'}
	status={tool?.success ? 'success' : 'info'}
	bind:collapsed
>
	<div class="conversation-content">
			<!-- Primary Agent Input -->
			<div class="message primary-agent">
				<div class="message-header">
					<EntityAvatar
						class="agent-avatar"
						avatarUrl={primaryAgentAvatar}
						iconRef={primaryAgentAvatarIconRef}
						iconFit={primaryAgentAvatarIconFit}
						label={primaryAgentName}
						fallback="AI"
					/>
					<span class="agent-name">{primaryAgentName}</span>
					<span class="message-label">→ Request</span>
				</div>
				<div class="message-content">
					{input}
				</div>
			</div>
			
			<!-- Subagent Response -->
			<div class="message subagent">
				<div class="message-header">
					<EntityAvatar
						class="agent-avatar"
						avatarUrl={subagentAvatar}
						iconRef={subagentAvatarIconRef}
						iconFit={subagentAvatarIconFit}
						label={subagentName}
						fallback="SA"
					/>
					<span class="agent-name">{subagentName}</span>
					<span class="message-label">← Response</span>
				</div>
				<div class="message-content">
					{output}
				</div>
			</div>

			<!-- Tool Results if any -->
			{#if intermediateSteps && intermediateSteps.length > 0}
				<div class="tools-section">
					<div class="tools-header">
						<span class="subagent-tool-icon flex-shrink-0"><Sparkles class="tool-icon flex-shrink-0" /></span>
						<span class="tools-label">Tools Used by {subagentName}</span>
					</div>
					<div class="tools-content">
						{#each intermediateSteps as step}
							<div class="embedded-tool">
								<CoolToolRenderer intermediateStep={step} />
							</div>
						{/each}
					</div>
				</div>
			{/if}

	</div>
</FullTool>

<style>
	.conversation-content {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	
	:global(.agent-avatar) {
		width: 20px !important;
		height: 20px !important;
		flex-shrink: 0;
	}
	
	.message {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0.5rem;
	}
	
	.message-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		padding: 0.25rem 0;
	}
	
	.agent-name {
		font-weight: 500;
		color: var(--foreground);
		text-transform: none;
		font-size: 0.8125rem;
	}
	
	.message-label {
		opacity: 0.7;
		text-transform: none;
		font-weight: 400;
	}
	
	.message-content {
		padding: 0.75rem;
		background: var(--muted);
		border-radius: 0.375rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
		position: relative;
	}
	
	.primary-agent .message-content {
		background: oklch(from var(--muted) l c h / 0.3);
	}
	
	.subagent .message-content {
		background: oklch(from var(--muted) l c h / 0.3);
	}
	
	.tools-section {
		padding: 0.5rem;
		background: oklch(from var(--muted) l c h / 0.2);
		border-radius: 0.375rem;
		margin: 0 0.5rem;
	}
	
	.tools-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-foreground);
		padding: 0 0.25rem;
	}
	
	.tools-label {
		font-size: 0.75rem;
		font-weight: 400;
		text-transform: none;
		font-family: monospace;
	}

	.conversation-content .subagent-tool-icon {
		display: flex;
		align-items: center;
		color: var(--muted-foreground);
	}
	
	.tools-content {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	
	.embedded-tool {
		overflow: hidden;
	}
	
	/* Scrollbar styling to match ReadFileRenderer */
	.message-content::-webkit-scrollbar {
		width: 8px;
		height: 8px;
	}
	
	.message-content::-webkit-scrollbar-track {
		background: transparent;
	}
	
	.message-content::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 9999px;
	}
	
	.message-content::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}

	/* No dark mode overrides - matches other Cool Tools */
</style>
