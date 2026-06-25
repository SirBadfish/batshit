<!-- ReadFileRenderer.svelte - Beautiful rendering for read_file tool -->
<script lang="ts">
	import FullTool from '../templates/FullTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
	import { getProjectTreeIconRef } from '$lib/icons/fileTypeIcons'
	import { getLanguageFromPath } from '$lib/utils/languageDetection'
	import PrismCodeBlock from '$lib/components/renderers/shared/PrismCodeBlock.svelte'
	import { AlertCircle, FileText } from '@lucide/svelte'
	
	let { tool }: { tool: ToolData } = $props()
	let isSkillRead = $derived(
		tool.rendererFamily === 'skill_read' || tool.operationKind === 'skill_read'
	)
	let skillAction = $derived(
		tool.toolResult?.action || tool.toolInput?.action || 'read'
	)

	// Extract file info from input AND result (batshit-server returns it in result too)
	// CRITICAL: Ensure filePath is always a string (fix for Batshit agents)
	let filePath = $derived.by(() => {
		const path =
			tool.toolInput?.filePath ||
			tool.toolInput?.file_path ||
			tool.toolInput?.path ||
			tool.toolInput?.params?.filePath ||
			tool.toolInput?.params?.file_path ||
			tool.toolResult?.filePath ||
			tool.toolResult?.absolutePath ||
			tool.toolResult?.mappedToolInput?.filePath ||
			tool.toolResult?.mappedToolInput?.path ||
			tool.toolResult?.input?.params?.filePath ||
			tool.toolResult?.input?.params?.file_path ||
			tool.toolResult?.input?.filePath ||
			tool.toolResult?.input?.path ||
			(isSkillRead && skillAction === 'invoke' ? 'SKILL.md' : null) ||
			'Unknown file'

		// Type guard: ensure we have a string
		return typeof path === 'string' ? path : 'Unknown file'
	})
	let fileName = $derived(filePath.split('/').pop() || 'file')
	let fileExtension = $derived(fileName.includes('.') ? fileName.split('.').pop() : '')
	let rendererTitle = $derived(
		typeof tool.metadata?.rendererTitle === 'string'
			? tool.metadata.rendererTitle
			: isSkillRead
				? (skillAction === 'invoke' ? 'Skill' : 'Skill Read')
				: 'Read File'
	)
	let subtitleTarget = $derived(
		typeof tool.metadata?.artifactName === 'string' ? tool.metadata.artifactName : fileName
	)
	// Check for language in multiple places - md should be markdown
	let language = $derived.by(() => {
		const detected = tool.toolResult?.language ||
		                 tool.metadata?.language ||
		                 getLanguageFromPath(filePath) ||
		                 fileExtension
		// Convert 'md' to 'markdown' for display
		return detected === 'md' ? 'markdown' : detected
	})

	// Extract content from result
	let fileContent = $derived(extractContent(tool.toolResult))
	let skillName = $derived(
		tool.toolResult?.skillName ||
			tool.toolResult?.skill?.name ||
			tool.toolResult?.skillId ||
			tool.toolResult?.skill?.id ||
			tool.toolInput?.skillName ||
			tool.toolInput?.skillId ||
			''
	)
	// Use provided lineCount if available, otherwise calculate
	let lineCount = $derived(
		tool.toolResult?.lineCount ||
			tool.metadata?.lineCount ||
			(fileContent ? fileContent.split('\n').length : 0)
	)
	let fileSize = $derived(tool.toolResult?.size || (fileContent ? new Blob([fileContent]).size : 0))

	// Build metadata
	let metadata = $derived({
		...(isSkillRead && skillName ? { 'Skill': skillName } : {}),
		...(isSkillRead ? { 'Action': skillAction === 'invoke' ? 'Invoke' : 'Read' } : {}),
		'File Path': filePath,
		'Lines': lineCount.toLocaleString(),
		'Size': formatFileSize(fileSize),
		'Language': language || fileExtension || 'Plain Text',
		...(tool.metadata?.executionTime && { 'Read Time': `${tool.metadata.executionTime}ms` })
	})
	let fileIconRef = $derived(
		getProjectTreeIconRef({
			name: fileName,
			type: 'file'
		})
	)
	
	function extractContent(result: any): string {
		if (!result) return ''
		
		// Arrays from some tool transports (for example n8n batshit-server) come back as
		// [{ type: 'text', text: '...' }, ...]. Join their text fields for display.
		if (Array.isArray(result)) {
			const texts = result
				.map((item) => {
					if (typeof item === 'string') return item
					if (item && typeof item === 'object' && 'text' in item) return (item as any).text
					return null
				})
				.filter(Boolean)
				.join('\n')
			if (texts) return texts
			// Fallback: stringify unknown array shape
			return JSON.stringify(result, null, 2)
		}
		
		// Direct string result (attempt to parse JSON wrapper payloads first)
		if (typeof result === 'string') {
			const trimmed = result.trim()
			if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
				try {
					const parsed = JSON.parse(trimmed)
					const extracted = extractContent(parsed)
					if (extracted) return extracted
				} catch {
					// Not JSON - fall through to raw string display.
				}
			}
			return result
		}
		
		// Common response patterns
		if (typeof result.skillMarkdown === 'string') return result.skillMarkdown
		if (typeof result.stdout === 'string') return result.stdout
		if (typeof result.fileContent === 'string') return result.fileContent
		if (typeof result.output === 'string') return result.output
		if (typeof result.text === 'string') return result.text
		if (typeof result.result === 'string') return result.result
		if (result.result && typeof result.result === 'object') {
			const nested = extractContent(result.result)
			if (nested) return nested
		}
		if (typeof result.content === 'string') {
			const trimmed = result.content.trim()
			if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
				try {
					const parsed = JSON.parse(trimmed)
					const extracted = extractContent(parsed)
					if (extracted) return extracted
				} catch {
					// Keep original content fallback below.
				}
			}
			return result.content
		}
		if (result.fileContent) return result.fileContent
		if (result.data) return result.data
		if (result.blocked && typeof result.reason === 'string') return `Blocked: ${result.reason}`
		
		// If it's wrapped in an object with a single key
		const keys = Object.keys(result)
		if (keys.length === 1) {
			const value = result[keys[0]]
			if (typeof value === 'string') return value
		}
		
		// Last resort - stringify it
		return JSON.stringify(result, null, 2)
	}
	
	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	}
	
	// Determine if we should syntax highlight
	let shouldHighlight = $derived(language && fileContent && lineCount < 5000)
</script>

<FullTool
	icon={FileText}
	iconRef={fileIconRef}
	title={rendererTitle}
	subtitle={isSkillRead && skillName ? `${skillName} • ${lineCount} lines` : `${subtitleTarget} • ${lineCount} lines`}
	status={tool.success ? 'success' : 'error'}
	{metadata}
	duration={tool.metadata?.executionTime}
	error={tool.error}
>
	<!-- Use PrismCodeBlock directly without double headers! -->
	<div class="file-content-wrapper">
		{#if fileContent}
			<PrismCodeBlock
				content={fileContent}
				language={language || 'text'}
				showCopyButton={true}
				showLineNumbers={true}
			/>
		{:else if tool.error}
			<div class="error-container">
				<div class="error-icon"><AlertCircle class="h-5 w-5" /></div>
				<div class="error-message">
					Failed to read file: {tool.error}
				</div>
			</div>
		{:else}
			<div class="empty-container">
				<div class="empty-icon"><FileText class="h-5 w-5" /></div>
				<div class="empty-message">File is empty</div>
			</div>
		{/if}
	</div>
</FullTool>

<style>
	.file-content-wrapper {
		/* No margin needed - parent handles spacing */
		max-height: 400px;
		overflow: hidden;
		border-radius: var(--radius);
		position: relative;
	}
	
	/* Inner scrollable container */
	.file-content-wrapper > :global(*) {
		max-height: 400px;
		overflow-y: auto;
		overflow-x: auto;
	}
	
	.error-container,
	.empty-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		text-align: center;
		color: var(--muted-foreground);
	}
	
	.error-icon,
	.empty-icon {
		font-size: 2rem;
		margin-bottom: 0.5rem;
	}
	
	.error-message {
		color: rgb(239 68 68);
		font-family: var(--font-mono, monospace);
		font-size: 0.875rem;
	}
	
	.empty-message {
		font-size: 0.875rem;
	}
	
</style>
