<!-- WriteFileRenderer.svelte - Beautiful rendering for overwrite/write file tool -->
<script lang="ts">
	import FullTool from '../templates/FullTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
	import { getLanguageFromPath } from '$lib/utils/languageDetection'
	import { countTextLines, extractWriteContentFromSources } from '$lib/utils/writePreview'
	import PrismCodeBlock from '$lib/components/renderers/shared/PrismCodeBlock.svelte'
	import { FileEdit } from '@lucide/svelte'
	
	let { tool }: { tool: ToolData } = $props()

	// Extract file info from input AND result (batshit-server returns it in result too)
	let filePath = $derived(
		tool.toolInput?.filePath ||
			tool.toolInput?.file_path ||
			tool.toolInput?.path ||
			tool.toolResult?.filePath ||
			tool.toolResult?.absolutePath ||
			tool.toolResult?.mappedToolInput?.filePath ||
			tool.toolResult?.mappedToolInput?.path ||
			'Unknown file'
	)
	let fileName = $derived(filePath.split('/').pop() || 'file')
	let fileExtension = $derived(fileName.includes('.') ? fileName.split('.').pop() : '')
	let rendererTitle = $derived(
		typeof tool.metadata?.rendererTitle === 'string' ? tool.metadata.rendererTitle : 'Write File'
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

	// Extract content - for write_file it's usually in the input, but mapped native bash writes
	// may only include command text (heredoc/redirect), so we parse common command shapes too.
	let fileContent = $derived(
		extractWriteContentFromSources({
			directContentCandidates: [
				tool.toolInput?.content,
				tool.toolInput?.data,
				tool.toolInput?.newContent,
				tool.toolResult?.content,
				tool.toolResult?.fileContent,
				tool.toolResult?.data,
				tool.toolResult?.newContent,
				tool.toolResult?.mappedToolInput?.content
			],
			commandCandidates: [
				tool.toolInput?.innerCommand,
				tool.toolInput?.command,
				tool.toolResult?.command,
				tool.toolResult?.mappedToolInput?.innerCommand,
				tool.toolResult?.mappedToolInput?.command
			]
		})
	)

	// Calculate stats
	let lineCount = $derived(
		typeof tool.toolResult?.lineCount === 'number' ? tool.toolResult.lineCount : countTextLines(fileContent)
	)
	let fileSize = $derived(
		typeof tool.toolResult?.size === 'number'
			? tool.toolResult.size
			: fileContent
				? new Blob([fileContent]).size
				: 0
	)

	// Build metadata
	let metadata = $derived({
		'File Path': filePath,
		'Lines Written': lineCount.toLocaleString(),
		'Size': formatFileSize(fileSize),
		'Language': language || 'Plain Text',
		...(tool.metadata?.executionTime && { 'Write Time': `${tool.metadata.executionTime}ms` })
	})
	
	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	}

</script>

<FullTool
	icon={FileEdit}
	title={rendererTitle}
	subtitle="{subtitleTarget} • {lineCount} lines written"
	status={tool.success ? 'success' : 'error'}
	{metadata}
	duration={tool.metadata?.executionTime}
	error={tool.error}
>
<!-- Use PrismCodeBlock directly like ReadFileRenderer -->
	<div class="file-content-wrapper">
		{#if fileContent && tool.success}
			<PrismCodeBlock 
				content={fileContent}
				language={language || 'text'}
				showCopyButton={true}
				showLineNumbers={true}
			/>
		{:else if tool.error}
			<div class="error-container">
				<div class="error-message">
					Failed to write file: {tool.error}
				</div>
			</div>
		{:else}
			<div class="empty-container">
				<div class="empty-message">File written successfully (content preview unavailable)</div>
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
	
	.error-message {
		color: rgb(239 68 68);
		font-family: var(--font-mono, monospace);
		font-size: 0.875rem;
	}
	
	.empty-message {
		font-size: 0.875rem;
	}
</style>
