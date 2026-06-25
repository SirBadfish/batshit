<!-- CoolToolRenderer.svelte - Bridge between intermediateSteps and Cool Tools system -->
<script lang="ts">
	import type { ComponentType, SvelteComponent } from 'svelte'
	import { getToolRenderer, type ToolData } from './toolRendererRegistry'
	import DefaultToolRenderer from './DefaultToolRenderer.svelte'
	import { detectToolSource } from '$lib/utils/toolSourceDetector'
	import { buildRendererKey } from './rendererKey'
	import { normalizeCompactTool } from '$lib/utils/toolActivityContract'
	import { stripGatewayPrefix, stripToSuffix } from '$lib/utils/toolNameFormatter'
	import {
		isDynamicMcpFindToolName as isDynamicMcpFindName,
		isDynamicMcpUseToolName as isDynamicMcpUseName,
		normalizeToolNameForLooseMatch
	} from '$lib/utils/toolNameNormalization'
	import {
		extractDynamicMcpPayload as getDynamicPayload,
		extractDynamicMcpParams as extractDynamicParams,
		normalizeToolPayload,
		parseJsonIfLikely
	} from '$lib/utils/toolPayloadUnwrap'

const normalizePayload = (val: any) => normalizeToolPayload(val)

const resultIndicatesFailure = (val: any): boolean => {
  const parsed = normalizePayload(val)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  return (parsed as any).success === false || (parsed as any).blocked === true
}

const extractResultErrorMessage = (val: any): string | null => {
  const parsed = normalizePayload(val)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (!resultIndicatesFailure(parsed)) return null

  const error = (parsed as any).error
  if (typeof (parsed as any).reason === 'string' && (parsed as any).reason.trim()) {
    return (parsed as any).reason.trim()
  }
  if (typeof (parsed as any).failureMessage === 'string' && (parsed as any).failureMessage.trim()) {
    return (parsed as any).failureMessage.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof (parsed as any).errorCode === 'string' && (parsed as any).errorCode.trim()) {
    return (parsed as any).errorCode.trim()
  }
  return 'Tool execution failed.'
}

const pickDynamicInput = (candidate: any): any | null => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  if (Object.keys(candidate).length === 0) return null
  return candidate
}

// Extract a likely tool name from various argument shapes (direct, params, Codex `arguments` wrapper)
const extractToolNameFromArgs = (args: any): string | undefined => {
  if (!args || typeof args !== 'object') return undefined

  const candidates = [
    args.toolName,
    args.tool,
    args.params?.toolName,
    args.params?.tool,
    args.arguments?.toolName,
    args.arguments?.tool,
    args.arguments?.params?.toolName,
    args.arguments?.params?.tool
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length) {
      return candidate
    }
  }

  return undefined
}

const normalizeToolError = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (typeof value === 'object') {
    const maybeMessage = (value as any).message
    if (typeof maybeMessage === 'string' && maybeMessage.length > 0) return maybeMessage
    const maybeError = (value as any).error
    if (typeof maybeError === 'string' && maybeError.length > 0) return maybeError
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}
	
	// Props from intermediateSteps structure
	// Handle both n8n format and direct format
	let {
		intermediateStep,
		metadata = {},
		isPending = false,
		toolId = ''
	}: {
		intermediateStep?: {
			action?: {
				tool: string
				toolInput: any
			}
			observation?: any
			// Alternative format from batshit-server
			toolName?: string
			toolArgs?: any
			toolInput?: any
			input?: any
			toolResult?: any
			error?: string
		}
		metadata?: Record<string, any>
		isPending?: boolean
		toolId?: string
	} = $props()
	
  // Extract and clean the tool data - handle both formats
  // When pending, show "Executing..." instead of actual tool name
  let toolName: string = $derived(isPending ? 'Executing Tool...' : (intermediateStep?.action?.tool || intermediateStep?.toolName || 'unknown'))
  const toolInput = $derived.by(() =>
    normalizePayload(
      intermediateStep?.action?.toolInput ||
      intermediateStep?.toolArgs ||
      intermediateStep?.toolInput ||
      intermediateStep?.input ||
      {}
    )
  )

	// Derive a display name that strips gateway prefixes and honors dynamic MCP targets
function resolveDisplayToolName(baseName: string, result: any, gatewayName?: string, inputArgs?: any) {
  const matchesDynamicUse = isDynamicMcpUseName(baseName)
  const matchesDynamicFind = isDynamicMcpFindName(baseName)

  const normalizeDynamic = (canonical: string) =>
    stripToSuffix(baseName, canonical) || canonical

  // Dynamic find should always stay labeled as dynamic_find.
  // It often receives tool-name-like query text that should never be treated as an executed tool.
  if (matchesDynamicFind) {
    return normalizeDynamic('batshit_server_dynamic_mcp_find')
  }

  const baseNormalizedUse = matchesDynamicUse ? normalizeDynamic('batshit_server_dynamic_mcp_use') : baseName
  const baseNormalizedFind = matchesDynamicFind ? normalizeDynamic('batshit_server_dynamic_mcp_find') : baseNormalizedUse

  // Dynamic MCP: prefer the executed tool name from the result payload (handle stringified result too)
  const maybeParse = (val: any) => {
    if (typeof val !== 'string') return val
    try { return JSON.parse(val) } catch { return val }
  }

  const parsedResult = maybeParse(result)

  // Try to extract executed tool name from loose text/arrays (Codex often returns text blocks)
  const extractFromText = (val: string | undefined): string | null => {
    if (!val) return null
    const match = val.match(/toolName\s*[:=]\s*"?([A-Za-z0-9._-]+)"?/i)
    return match?.[1] || null
  }

  const extractFromArray = (arr: any[]): string | null => {
    for (const item of arr) {
      if (typeof item === 'string') {
        const found = extractFromText(item)
        if (found) return found
      }
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        const found = extractFromText(item.text)
        if (found) return found
      }
    }
    return null
  }

  // If result object explicitly says which tool ran, show that no matter what
  let executedName =
    parsedResult?.toolName ||
    parsedResult?.tool_name ||
    parsedResult?.name ||
    (matchesDynamicUse ? extractToolNameFromArgs(inputArgs) : undefined)

  if (!executedName && Array.isArray(result)) {
    executedName = extractFromArray(result) || executedName
  }
  if (!executedName && typeof result === 'string') {
    executedName = extractFromText(result) || executedName
  }
  if (typeof executedName === 'string' && executedName.trim().length) {
    return executedName
  }

  // Last-chance override for dynamic use: if name still looks like dynamic_mcp_use, fall back to any known toolName in args
  if (matchesDynamicUse) {
    const argName = extractToolNameFromArgs(inputArgs)
    if (typeof argName === 'string' && argName.trim().length) {
      return argName
    }
  }

  // Remove gateway namespace prefixes for display only
  const stripped = stripGatewayPrefix(baseNormalizedFind, gatewayName) || baseNormalizedFind
  return stripped
}
	
  // Process the observation/result - handle both formats
  // When pending, there's no result yet
  const processedResult = $derived.by(() =>
    isPending
      ? { result: null, error: null }
      : processObservation(
          intermediateStep?.toolResult !== undefined
            ? intermediateStep.toolResult
            : intermediateStep?.observation
        )
  )
  let success = $derived.by(() => {
    if (isPending) return true
    if ((intermediateStep as any)?.success === false) return false
    if (intermediateStep?.error) return false
    if (resultIndicatesFailure(intermediateStep?.toolResult)) return false
    if (resultIndicatesFailure(processedResult.result)) return false
    return !processedResult.error
  })
  let error = $derived.by(() => {
    if (isPending) return null
    return normalizeToolError(
      intermediateStep?.error ??
        processedResult.error ??
        extractResultErrorMessage(intermediateStep?.toolResult) ??
        extractResultErrorMessage(processedResult.result)
    )
  })
  let toolResult = $derived(isPending ? null : processedResult.result)
	
  // Build the tool data structure for renderers
	let toolData = $derived.by(() => {
    const gatewayNameForDisplay = (intermediateStep as any)?.gatewayName || (intermediateStep as any)?.metadata?.gatewayName
    const explicitOperationKind =
      (intermediateStep as any)?.operationKind ||
      (intermediateStep as any)?.metadata?.operationKind
    const explicitRendererFamily =
      (intermediateStep as any)?.rendererFamily ||
      (intermediateStep as any)?.metadata?.rendererFamily
    const explicitDisplayName =
      (intermediateStep as any)?.displayToolName ||
      (intermediateStep as any)?.metadata?.rendererTitle
    const rawSidecarFromStep =
      (intermediateStep as any)?.rawSidecar ||
      ((intermediateStep as any)?.metadata?.rawSidecarZipId
        ? {
            status: 'stored',
            zipId: (intermediateStep as any).metadata.rawSidecarZipId
          }
        : undefined)
    const displayName = resolveDisplayToolName(toolName, processedResult?.result, gatewayNameForDisplay, toolInput)
    const parsedResultObj = typeof processedResult?.result === 'object' ? processedResult.result : null
    const executedToolName: string | undefined = (parsedResultObj as any)?.toolName || (parsedResultObj as any)?.tool_name || (parsedResultObj as any)?.name || (parsedResultObj as any)?.tool

		// Unwrap dynamic MCP payload shape: { toolName, executionTimeMs, result, input }
		const dynamicPayload = getDynamicPayload(processedResult?.result)
		const unwrappedResult = dynamicPayload ? (dynamicPayload as any).result ?? (dynamicPayload as any).output : processedResult?.result
		const overrideInput = dynamicPayload
      ? extractDynamicParams((dynamicPayload as any).input ?? (dynamicPayload as any).params)
      : null
		const executionTimeMs = (dynamicPayload as any)?.executionTimeMs ?? (dynamicPayload as any)?.executionTime

    const isDynamicUse = isDynamicMcpUseName(toolName) || isDynamicMcpUseName(displayName) || !!dynamicPayload
    const dynamicParamsFromInput = extractDynamicParams(toolInput)
    const resolvedToolInput = isDynamicUse
      ? (pickDynamicInput(overrideInput) ?? pickDynamicInput(dynamicParamsFromInput) ?? toolInput)
      : toolInput
    const inferredNormalization =
      explicitOperationKind && explicitRendererFamily
        ? null
        : normalizeCompactTool({
            toolName,
            originalToolName: (intermediateStep as any)?.originalToolName,
            toolArgs:
              resolvedToolInput && typeof resolvedToolInput === 'object' && !Array.isArray(resolvedToolInput)
                ? resolvedToolInput
                : {},
            toolResult: unwrappedResult,
            metadata: (intermediateStep as any)?.metadata,
            isSubagent: (intermediateStep as any)?.isSubagent === true,
            toolProvider: (intermediateStep as any)?.toolProvider
          })
    const operationKindFromStep = explicitOperationKind || inferredNormalization?.operationKind
    const rendererFamilyFromStep = explicitRendererFamily || inferredNormalization?.rendererFamily
    const effectiveToolInputPayload =
      inferredNormalization &&
      (!explicitOperationKind || !explicitRendererFamily) &&
      (inferredNormalization.rendererFamily !== 'generic_tool' ||
        inferredNormalization.operationKind !== 'unknown_tool')
        ? inferredNormalization.toolArgs
        : resolvedToolInput
    const effectiveToolResultPayload =
      inferredNormalization &&
      (!explicitOperationKind || !explicitRendererFamily) &&
      (inferredNormalization.rendererFamily !== 'generic_tool' ||
        inferredNormalization.operationKind !== 'unknown_tool')
        ? inferredNormalization.toolResult
        : normalizePayload(unwrappedResult)

		// Final executed name fallback: also inspect toolResult/toolInput directly
		const executedFromPayload =
			(unwrappedResult as any)?.toolName ||
			(unwrappedResult as any)?.tool ||
			extractToolNameFromArgs(toolInput) ||
			extractToolNameFromArgs(overrideInput)
		const finalExecutedName = executedFromPayload || executedToolName || (displayName && displayName !== toolName ? displayName : undefined)

		// If dynamic MCP executed an batshit-server tool, override provider/name for renderer routing
		const isDynamicBatshitServer = (isDynamicMcpUseName(toolName) || isDynamicMcpUseName(displayName || '')) && ((displayName || finalExecutedName)?.startsWith?.('batshit_server_'))
		const effectiveToolName = finalExecutedName || (isDynamicBatshitServer ? displayName : toolName)
		const effectiveDisplayName = inferredNormalization?.displayToolName || explicitDisplayName || finalExecutedName || displayName || toolName

		// Start with basic tool data
    let subagentNameFromStep =
      (intermediateStep as any)?.subagentName ||
      (intermediateStep as any)?.metadata?.subagentName ||
      (processedResult?.result as any)?.subagentName ||
      (overrideInput as any)?.subagentName ||
      (toolInput as any)?.subagentName

    const agentNameFromStep =
      (intermediateStep as any)?.agentName ||
      (intermediateStep as any)?.metadata?.agentName ||
      (processedResult?.result as any)?.agentName ||
      (toolInput as any)?.agentName

    const subagentIdFromStep =
      (intermediateStep as any)?.subagentId ||
      (intermediateStep as any)?.metadata?.subagentId ||
      (overrideInput as any)?.subagentId ||
      (toolInput as any)?.subagentId

    const subagentAvatarFromStep =
      (intermediateStep as any)?.subagentAvatar ||
      (intermediateStep as any)?.metadata?.subagentAvatar ||
      (processedResult?.result as any)?.subagentAvatar

    const subagentAvatarIconRefFromStep =
      (intermediateStep as any)?.subagentAvatarIconRef ||
      (intermediateStep as any)?.metadata?.subagentAvatarIconRef ||
      (processedResult?.result as any)?.subagentAvatarIconRef

    const subagentAvatarIconFitFromStep =
      (intermediateStep as any)?.subagentAvatarIconFit ||
      (intermediateStep as any)?.metadata?.subagentAvatarIconFit ||
      (processedResult?.result as any)?.subagentAvatarIconFit

    const agentAvatarIconRefFromStep =
      (intermediateStep as any)?.agentAvatarIconRef ||
      (intermediateStep as any)?.metadata?.agentAvatarIconRef ||
      (processedResult?.result as any)?.agentAvatarIconRef

    const agentAvatarIconFitFromStep =
      (intermediateStep as any)?.agentAvatarIconFit ||
      (intermediateStep as any)?.metadata?.agentAvatarIconFit ||
      (processedResult?.result as any)?.agentAvatarIconFit

    // If we detected a subagent but no name was provided, fall back to the executed tool name
    if (!subagentNameFromStep && ((intermediateStep as any)?.isSubagent || subagentIdFromStep)) {
      subagentNameFromStep = effectiveToolName
    }

    const inferredIsSubagent = Boolean(
      (intermediateStep as any)?.isSubagent === true ||
      !!subagentIdFromStep ||
      !!subagentNameFromStep ||
      (toolInput && typeof toolInput === 'object' && 'Prompt__User_Message_' in toolInput)
    )

      const baseData: ToolData = {
			toolName: effectiveToolName,
			displayToolName: effectiveDisplayName,
			toolInput: parseJsonIfLikely(effectiveToolInputPayload),
			toolResult: effectiveToolResultPayload,
      success,
      error: error ?? undefined,
      operationKind: operationKindFromStep,
      rendererFamily: rendererFamilyFromStep,
      rawSidecar: rawSidecarFromStep,
      subagentName: subagentNameFromStep,
      agentName: agentNameFromStep,
      subagentId: subagentIdFromStep,
      subagentAvatar: subagentAvatarFromStep,
      metadata: {
        ...(intermediateStep as any)?.metadata,
        ...metadata,
        ...(inferredNormalization?.metadata ?? {}),
        ...('metadata' in processedResult ? processedResult.metadata || {} : {}),
        ...(executionTimeMs ? { executionTime: executionTimeMs } : {}),
        ...(subagentNameFromStep ? { subagentName: subagentNameFromStep } : {}),
        ...(agentNameFromStep ? { agentName: agentNameFromStep } : {}),
        ...(subagentIdFromStep ? { subagentId: subagentIdFromStep } : {}),
        ...(subagentAvatarFromStep ? { subagentAvatar: subagentAvatarFromStep } : {}),
        ...(subagentAvatarIconRefFromStep ? { subagentAvatarIconRef: subagentAvatarIconRefFromStep } : {}),
        ...(subagentAvatarIconFitFromStep ? { subagentAvatarIconFit: subagentAvatarIconFitFromStep } : {}),
        ...(agentAvatarIconRefFromStep ? { agentAvatarIconRef: agentAvatarIconRefFromStep } : {}),
        ...(agentAvatarIconFitFromStep ? { agentAvatarIconFit: agentAvatarIconFitFromStep } : {}),
        ...(inferredIsSubagent ? { isSubagent: true } : {})
      },
      isSubagent: inferredIsSubagent
    }

    // Run tool source detection if we have an intermediateStep
    if (intermediateStep && !isPending) {
      // Convert to IntermediateStep format for detection
      const likelySubagent =
        (intermediateStep as any)?.isSubagent === true ||
        (typeof effectiveToolName === 'string' && normalizeToolNameForLooseMatch(effectiveToolName).includes('subagent')) ||
        (toolInput && typeof toolInput === 'object' && ('Prompt__User_Message_' in toolInput || 'subagentId' in toolInput || 'subagentName' in toolInput)) ||
        (!!subagentNameFromStep)

      const stepForDetection = {
        type: (intermediateStep.error ? 'tool_error' : 'tool') as 'tool' | 'tool_error' | 'error',
        toolName: effectiveToolName,
        toolArgs: toolInput,
        toolResult,
        error: error || undefined,
        isSubagent: (intermediateStep as any)?.isSubagent ?? likelySubagent ?? inferredIsSubagent,
        // Preserve any existing metadata fields
        ...(intermediateStep as any)
      }
			const detectionResult = detectToolSource(stepForDetection)

			// Merge detection results into toolData
			// Debugging fix (Oct 13): detectionResult includes isSubagent from detectToolSource
		const merged: ToolData = {
			...baseData,
			...detectionResult,
				// Preserve subagent name only when detectToolSource confirms it IS a subagent
				...((intermediateStep as any)?.subagentName && detectionResult.isSubagent ? { subagentName: (intermediateStep as any).subagentName } : {}),
				// When detectToolSource says NOT a subagent, explicitly clear subagent fields
				// to prevent false positives from secondary inference (e.g., native_fabric_use)
				...(!detectionResult.isSubagent ? { subagentName: undefined, subagentId: undefined } : {})
			}

			// Codex sometimes tags batshit-server tool calls as toolProvider: 'codex' — force batshit-server renderer when the name matches
			if (
				typeof merged.toolName === 'string' &&
				merged.toolProvider === 'codex' &&
				merged.toolName.toLowerCase().startsWith('batshit_server_')
			) {
				merged.toolProvider = 'batshit-server'
			}

			// Dynamic MCP routed to batshit-server: force provider for renderer resolution
			if (isDynamicBatshitServer) {
				merged.toolProvider = 'batshit-server'
				merged.mcpServerName = 'batshit-server'
			}

			return merged
		}

		return baseData as ToolData
	})
	
	// Component state
	let RendererComponent = $state<any>(null)
	let loading = $state(true)
	let currentRendererKey = $state<string | null>(null)
	let rendererKey = $state<string>('')
	// Build a stable key so we don't reload renderers on identical data
	$effect(() => {
		rendererKey = buildRendererKey({ intermediateStep, toolId, toolName: toolData?.toolName || toolName, isPending })
	})
	
	function processObservation(observation: any) {
		// Some callback paths wrap the real payload in a coolToolResult envelope.
		if (Array.isArray(observation) && observation.length > 0) {
			const firstItem = observation[0]
			
			// Check for the wrapped coolToolResult structure.
				if (firstItem?.type === 'coolToolResult' && firstItem?.toolResult) {
					const innerData = firstItem.toolResult
				
				// Return the actual tool result data
				return {
					error: normalizeToolError(innerData.error),
					result: innerData,
					metadata: innerData.metadata || {}
				}
			}
			
			// Fallback for old text-based structure
			if (firstItem?.type === 'text' && firstItem?.text) {
				try {
					const innerData = JSON.parse(firstItem.text)
					
					return {
						error: normalizeToolError(innerData.error),
						result: innerData,
						metadata: innerData.metadata || {}
					}
					} catch (e) {
						// If parse fails, the text is the actual content (like for read_file)
						return {
							error: null,
							result: { content: firstItem.text },
						metadata: {}
					}
				}
			}
		}
		
		// Handle string observation (legacy format)
		if (typeof observation === 'string') {
			try {
				// Try direct parse as fallback
				const directParse = JSON.parse(observation)
				return {
					error: normalizeToolError(directParse.error),
					result: directParse,
					metadata: directParse.metadata || {}
				}
			} catch (e) {
				// Not JSON, treat as string
			}
			
			// Handle error strings
			if (observation.startsWith('Error:')) {
				return {
					error: observation,
					result: null,
					metadata: {}
				}
			}
		}
		
		// Handle object with error property
		if (observation && typeof observation === 'object' && observation.error) {
			return {
				error: normalizeToolError(observation.error),
				result: observation.result || null,
				metadata: observation.metadata || {}
			}
		}
		
		// Extract metadata if present
		let metadata = {}
		let result = observation
		
		if (observation && typeof observation === 'object') {
			const observationData = Array.isArray(observation) ? [...observation] : { ...observation }
			// Common patterns from batshit-server tools
			if ('metadata' in observationData) {
				metadata = observationData.metadata
				delete observationData.metadata
			}
			
			// Extract execution time if present
			if ('executionTime' in observationData) {
				metadata = { ...metadata, executionTime: observationData.executionTime }
				delete observationData.executionTime
			}
			
			// Extract token count if present
			if ('tokenCount' in observationData) {
				metadata = { ...metadata, tokenCount: observationData.tokenCount }
				delete observationData.tokenCount
			}
			
			// If there's a result property, use that as the main result
			if ('result' in observationData && Object.keys(observationData).length === 1) {
				result = observationData.result
			} else if ('output' in observationData && Object.keys(observationData).length === 1) {
				result = observationData.output
			} else if ('content' in observationData && Object.keys(observationData).length === 1) {
				result = observationData.content
			} else {
				result = observationData
			}
		}
		
		return {
			error: null,
			result,
			metadata
		}
	}
	
	// Load the appropriate renderer
	$effect(() => {
		// For pending tools, just use the default renderer immediately
		if (isPending) {
			RendererComponent = DefaultToolRenderer
			loading = false
			currentRendererKey = rendererKey
			return
		}

		// Skip reload if nothing meaningful changed
		if (rendererKey === currentRendererKey && RendererComponent) {
			return
		}

		const loadRenderer = async () => {
			try {
				loading = true
				const rendererName = toolData?.displayToolName || toolName
				RendererComponent = await getToolRenderer(rendererName, toolData)
			} catch (err) {
				console.warn(`Using default renderer for ${toolName}`)
				RendererComponent = DefaultToolRenderer
			} finally {
				loading = false
				currentRendererKey = rendererKey
			}
		}
		loadRenderer()
	})
</script>

{#if loading}
	<div class="tool-loading">
		<span class="loading-text">Loading {toolName}...</span>
	</div>
{:else if RendererComponent}
	{@const Component = RendererComponent}
	<Component tool={toolData} />
{:else}
	<DefaultToolRenderer tool={toolData} />
{/if}

<style>
	.tool-loading {
		padding: 0.5rem;
		color: var(--muted-foreground);
		font-size: 0.75rem;
		font-family: var(--font-mono, monospace);
		opacity: 0.7;
	}
</style>
