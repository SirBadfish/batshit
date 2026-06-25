<!-- EditFileRenderer.svelte - Beautiful rendering for edit_file tool -->
<script lang="ts">
	import FullTool from '../templates/FullTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
	import { getLanguageFromPath } from '$lib/utils/languageDetection'
	import { buildCompactEditPreview } from '$lib/utils/editDiff'
	import { AlertCircle, Edit3 } from '@lucide/svelte'
	
	let { tool }: { tool: ToolData } = $props()

	// Extract file info from input AND result (batshit-server returns it in result too)
	let filePath = $derived(tool.toolInput?.filePath ||
	              tool.toolInput?.file_path ||
	              tool.toolInput?.path ||
	              tool.toolResult?.filePath ||
	              tool.toolResult?.mappedToolInput?.filePath ||
	              tool.toolResult?.mappedToolInput?.path ||
	              tool.toolResult?.absolutePath ||
	              'Unknown file')
	let fileName = $derived(filePath.split('/').pop() || 'file')
	let fileExtension = $derived(fileName.includes('.') ? fileName.split('.').pop() : '')
	let subtitleTarget = $derived(
		typeof tool.metadata?.artifactName === 'string' ? tool.metadata.artifactName : fileName
	)
	let failureReason = $derived.by(() => {
		const result = tool.toolResult
		if (result && typeof result === 'object' && !Array.isArray(result)) {
			const failed = result.success === false || result.blocked === true
			if (failed) {
				if (typeof result.reason === 'string' && result.reason.trim()) return result.reason.trim()
				if (typeof result.failureMessage === 'string' && result.failureMessage.trim()) return result.failureMessage.trim()
				if (typeof result.error === 'string' && result.error.trim()) return result.error.trim()
				if (result.error && typeof result.error === 'object' && typeof result.error.message === 'string') {
					return result.error.message.trim()
				}
				if (typeof result.errorCode === 'string' && result.errorCode.trim()) return result.errorCode.trim()
			}
		}

		return typeof tool.error === 'string' && tool.error.trim() ? tool.error.trim() : ''
	})
	let rendererTitle = $derived(
		failureReason
			? 'Edit Not Applied'
			: typeof tool.metadata?.rendererTitle === 'string'
				? tool.metadata.rendererTitle
				: 'Edit File'
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

	// Extract the diff or changes and clean up spacing
	let diffContent = $derived.by(() => {
		const fromResult = extractDiff(tool.toolResult)
		if (fromResult) return cleanDiffSpacing(fromResult)

		// Fallback 1: diff embedded in toolResult.output text
		if (tool.toolResult?.output && typeof tool.toolResult.output === 'string') {
			const text = tool.toolResult.output
			if (text.includes('*** Begin Patch')) {
				const start = text.indexOf('*** Begin Patch')
				const end = text.indexOf('*** End Patch')
				if (start !== -1 && end !== -1 && end > start) {
					return text.slice(start, end + '*** End Patch'.length)
				}
			}
		}

		// Fallback 2: diff inside command string
		const cmd = tool.toolInput?.command
		if (typeof cmd === 'string' && cmd.includes('*** Begin Patch')) {
			const start = cmd.indexOf('*** Begin Patch')
			const end = cmd.indexOf('*** End Patch')
			if (start !== -1 && end !== -1 && end > start) {
				return cmd.slice(start, end + '*** End Patch'.length)
			}
		}
		return ''
	})
	
	// Clean up any excessive spacing in the diff
	function cleanDiffSpacing(diff: string): string {
		if (!diff) return ''
		return diff.split('\n').map(line => {
			// Clean up spacing after +/- signs
			if (line.startsWith('+')) {
				return line.replace(/^\+\s+/, '+ ')
			} else if (line.startsWith('-')) {
				return line.replace(/^-\s+/, '- ')
			} else if (line.match(/^\s+\d/)) {
				// Lines with just line numbers (unchanged lines)
				return line.replace(/^\s+/, '  ')
			}
			return line
		}).join('\n')
	}
	let changesCount = $derived(countChanges(diffContent, tool.toolResult?.changeCount))
	let subtitle = $derived(
		changesCount.total !== null ? `${subtitleTarget} • ${changesCount.total} changes` : subtitleTarget
	)

	// Build metadata
	let metadata = $derived({
		'File Path': filePath,
		...(failureReason
			? {
				'Result': 'Not applied',
				'Reason': failureReason
			}
			: {}),
		...(changesCount.total !== null
			? {
				'Lines Added': changesCount.additions,
				'Lines Removed': changesCount.deletions,
				'Total Changes': changesCount.total
			}
			: {}),
		...(language && { 'Language': language }),
		...(tool.metadata?.executionTime && { 'Edit Time': `${tool.metadata.executionTime}ms` })
	})
	
	// Helper to clean diff headers
	function cleanDiffHeaders(content: string): string {
		if (!content || typeof content !== 'string') return content || ''
		// Remove file header lines (--- filename and +++ filename) and @@ lines
		// Also clean up excessive spaces after + and - signs
		return content.split('\n')
			.filter(line => !line.startsWith('---') && !line.startsWith('+++') && !line.startsWith('@@'))
			.map(line => {
				// Replace multiple spaces after +/- with single space
				if (line.startsWith('+')) {
					return line.replace(/^\+\s+/, '+ ')
				} else if (line.startsWith('-')) {
					return line.replace(/^-\s+/, '- ')
				}
				return line
			})
			.join('\n')
	}
	
	function extractDiff(result: any): string {
		if (!result) return ''
		
		// Direct string result - clean up file headers
		if (typeof result === 'string') {
			// Remove file header lines (--- filename and +++ filename)
			return result.split('\n')
				.filter(line => !line.startsWith('---') && !line.startsWith('+++'))
				.join('\n')
		}
		
		// Common response patterns for diffs - clean them too
		if (result.diff) return cleanDiffHeaders(result.diff)
		if (result.changes) return cleanDiffHeaders(result.changes)
		if (result.patch) return cleanDiffHeaders(result.patch)
		if (result.content) return cleanDiffHeaders(result.content)
		
		// batshit-server edit_file returns edits array with oldContent/newContent
		if (result.edits && Array.isArray(result.edits)) {
			const patches = result.edits
				.map((edit: any) =>
					buildCompactEditPreview({
						filePath,
						oldText: typeof edit.oldContent === 'string' ? edit.oldContent : undefined,
						newText: typeof edit.newContent === 'string' ? edit.newContent : undefined
					})
				)
				.filter((value: string | undefined): value is string => Boolean(value))
			if (patches.length > 0) return patches.join('\n\n')
		}
		
		// If we have before/after, create a simple diff display
		if (result.before && result.after) {
			const preview = buildCompactEditPreview({
				filePath,
				before: typeof result.before === 'string' ? result.before : undefined,
				after: typeof result.after === 'string' ? result.after : undefined
			})
			if (preview) return preview
		}
		
		// Check toolInput for edits (sometimes data is there)
		if (tool.toolInput?.edits && Array.isArray(tool.toolInput.edits)) {
			const patches = tool.toolInput.edits
				.map((edit: any) =>
					buildCompactEditPreview({
						filePath,
						oldText: typeof edit.oldContent === 'string' ? edit.oldContent : undefined,
						newText: typeof edit.newContent === 'string' ? edit.newContent : undefined
					})
				)
				.filter((value: string | undefined): value is string => Boolean(value))
			if (patches.length > 0) return patches.join('\n\n')
		}
		
		// Last resort - stringify it
		return JSON.stringify(result, null, 2)
	}
	
	function countChanges(
		diff: string,
		explicitTotal?: unknown
	): { additions: number, deletions: number, total: number | null } {
		if (typeof explicitTotal === 'number' && Number.isFinite(explicitTotal) && explicitTotal >= 0) {
			return {
				additions: 0,
				deletions: 0,
				total: explicitTotal
			}
		}

		const lines = diff.split('\n')
		let additions = 0
		let deletions = 0
		
		for (const line of lines) {
			if (line.startsWith('+') && !line.startsWith('+++')) additions++
			if (line.startsWith('-') && !line.startsWith('---')) deletions++
		}
		
		const total = additions + deletions
		return {
			additions,
			deletions,
			total: total > 0 ? total : null
		}
	}
</script>

<FullTool
	icon={Edit3}
	title={rendererTitle}
	subtitle={subtitle}
	status={failureReason || !tool.success ? 'error' : 'success'}
	{metadata}
	duration={tool.metadata?.executionTime}
	error={failureReason || tool.error}
>
	<div class="diff-content-wrapper">
		{#if failureReason}
			<div class="error-container blocked-edit">
				<div class="error-icon"><AlertCircle class="h-5 w-5" /></div>
				<div class="error-message">
					Edit not applied: {failureReason}
				</div>
			</div>
		{/if}
		{#if diffContent}
			<!-- Custom diff display with proper alignment -->
			<div class="diff-display">
				{#each diffContent.split('\n').filter((line: string) => line) as line}
					<div class="diff-line-wrapper">
						{#if line.startsWith('+')}
							<div class="diff-line diff-add">{line}</div>
						{:else if line.startsWith('-')}
							<div class="diff-line diff-remove">{line}</div>
						{:else}
							<div class="diff-line diff-context">{line}</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else if tool.error && !failureReason}
			<div class="error-container">
				<div class="error-icon"><AlertCircle class="h-5 w-5" /></div>
				<div class="error-message">
					Failed to edit file: {tool.error}
				</div>
			</div>
		{:else if !failureReason}
			<div class="empty-container">
				<div class="empty-icon">✏️</div>
				<div class="empty-message">No changes made</div>
			</div>
		{/if}
	</div>
</FullTool>

<style>
	.diff-content-wrapper {
		max-height: 400px;
		overflow: hidden;
		border-radius: var(--radius);
		position: relative;
		background: #0a0a0a;
	}
	
	.diff-display {
		max-height: 400px;
		overflow-y: auto;
		overflow-x: hidden;  /* Hide horizontal scroll, allow wrapping */
		padding: 1rem 0;
		font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
		font-size: 0.85rem;
		line-height: 1.5;
	}
	
	/* Scrollbar styling */
	.diff-display::-webkit-scrollbar {
		width: 8px;
		height: 8px;
	}
	
	.diff-display::-webkit-scrollbar-track {
		background: transparent;
	}
	
	.diff-display::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 9999px;
	}
	
	.diff-display::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}
	
	.diff-line-wrapper {
		margin: 0;
		padding: 0;
	}
	
	.diff-line {
		display: block;
		padding: 0.125rem 0.5rem 0.125rem 4rem;  /* Reduced left padding since we removed spaces */
		margin: 0 -0.5rem;
		position: relative;
		white-space: pre-wrap;  /* Allow wrapping */
		word-wrap: break-word;
		overflow-wrap: break-word;
		text-indent: -3rem;  /* Adjusted indent to match */
	}
	
	.diff-add {
		background: rgba(34, 139, 34, 0.15);
		color: #58d68d;
	}
	
	.diff-remove {
		background: rgba(220, 20, 60, 0.15);
		color: #ff6b6b;
	}
	
	.diff-context {
		color: #8b949e;
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
