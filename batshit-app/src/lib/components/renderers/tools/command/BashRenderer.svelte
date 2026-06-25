<!-- BashRenderer.svelte - Shared renderer family for bash/search/list tool activity -->
<script lang="ts">
	import FullTool from '../templates/FullTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
	import { FolderOpen, Search, Terminal, Check, X } from '@lucide/svelte'
	
	let { tool }: { tool: ToolData } = $props()
	let operationKind = $derived(
		tool.operationKind || tool.metadata?.operationKind || 'bash'
	)
	let title = $derived.by(() => {
		switch (operationKind) {
			case 'search_files':
				return 'Search Files'
			case 'list_files':
				return 'List Files'
			case 'bash':
			default:
				return 'Bash'
		}
	})
	let icon = $derived.by(() => {
		switch (operationKind) {
			case 'search_files':
				return Search
			case 'list_files':
				return FolderOpen
			case 'bash':
			default:
				return Terminal
		}
	})

	// Extract command info
	let command = $derived(
		tool.toolInput?.command ||
		tool.toolInput?.cmd ||
		tool.toolResult?.command ||
		tool.toolResult?.toolInput?.command ||
		tool.toolResult?.toolInput?.cmd ||
		'Unknown command'
	)
	// Also check for projectPath and workingDir in toolResult
	let workingDir = $derived(tool.toolInput?.cwd ||
	                tool.toolInput?.working_dir ||
	                tool.toolInput?.projectPath ||
	                tool.toolInput?.workingDir ||
	                tool.toolResult?.workingDir ||
	                tool.toolResult?.cwd ||
	                undefined)

	let searchResults = $derived(
		Array.isArray(tool.toolResult?.results) ? tool.toolResult.results : []
	)
	let listFiles = $derived(
		Array.isArray(tool.toolResult?.files) ? tool.toolResult.files : []
	)
	let totalMatches = $derived(
		typeof tool.toolResult?.totalMatches === 'number'
			? tool.toolResult.totalMatches
			: searchResults.reduce(
					(sum: number, entry: any) => sum + Number(entry?.matchCount || 0),
					0
			  )
	)
	let totalMatchingFiles = $derived(
		typeof tool.toolResult?.totalMatchingFiles === 'number'
			? tool.toolResult.totalMatchingFiles
			: searchResults.length
	)
	let totalItems = $derived(
		typeof tool.toolResult?.totalItems === 'number'
			? tool.toolResult.totalItems
			: listFiles.length
	)
	let totalDirectories = $derived(
		typeof tool.toolResult?.totalDirectories === 'number'
			? tool.toolResult.totalDirectories
			: listFiles.filter((entry: any) => entry?.type === 'directory').length
	)
	let totalFiles = $derived(
		typeof tool.toolResult?.totalFiles === 'number'
			? tool.toolResult.totalFiles
			: listFiles.filter((entry: any) => entry?.type === 'file').length
	)
	let totalUnknownItems = $derived(
		typeof tool.toolResult?.totalUnknownItems === 'number'
			? tool.toolResult.totalUnknownItems
			: listFiles.filter((entry: any) => entry?.type !== 'directory' && entry?.type !== 'file').length
	)
	let searchQuery = $derived(
		tool.toolResult?.query ||
		tool.toolInput?.query ||
		tool.toolInput?.pattern ||
		extractSearchQuery(command)
	)

	// Extract output
	let stdout = $derived(extractOutput(tool.toolResult, 'stdout'))
	let stderr = $derived(extractOutput(tool.toolResult, 'stderr'))
	let exitCode = $derived.by(() => {
		const value = tool.toolResult?.exitCode ?? tool.toolResult?.code
		return typeof value === 'number' ? value : undefined
	})
	let status = $derived.by(() => {
		if (typeof exitCode === 'number') {
			return exitCode === 0 ? 'success' : 'error'
		}
		return tool.success ? 'success' : 'error'
	}) as 'success' | 'error'
	let subtitle = $derived.by(() => {
		if (operationKind === 'search_files') {
			return `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${totalMatchingFiles} file${totalMatchingFiles === 1 ? '' : 's'}`
		}
		if (operationKind === 'list_files') {
			return `${totalItems} item${totalItems === 1 ? '' : 's'}`
		}
		if (command && command !== 'Unknown command') return command
		return 'Shell activity'
	})

	// Build metadata
	let metadata = $derived.by(() => ({
		...(workingDir ? { 'Working Directory': workingDir } : {}),
		...(typeof exitCode === 'number' ? { 'Exit Code': exitCode } : {}),
		...(operationKind === 'search_files'
			? {
					...(searchQuery ? { Query: searchQuery } : {}),
					'Matching Files': totalMatchingFiles,
					'Total Matches': totalMatches
			  }
			: {}),
		...(operationKind === 'list_files'
			? totalUnknownItems > 0
				? {
						...(totalFiles > 0 ? { 'Known Files': totalFiles } : {}),
						...(totalDirectories > 0 ? { 'Known Directories': totalDirectories } : {}),
						'Unknown Type': totalUnknownItems,
						Items: totalItems
				  }
				: {
						Files: totalFiles,
						Directories: totalDirectories,
						Items: totalItems
				  }
			: {}),
		...(tool.metadata?.executionTime && { 'Duration': `${tool.metadata.executionTime}ms` }),
		...(tool.rawSidecar?.zipId ? { 'Raw Payload Zip': tool.rawSidecar.zipId } : {})
	}))
	
	function extractOutput(result: any, type: 'stdout' | 'stderr'): string {
		if (!result) return ''
		
		// Direct access
		if (result[type]) return result[type]
		
		// Check nested response
		if (result.response && result.response[type]) return result.response[type]
		
		// For stdout, check common aliases
		if (type === 'stdout') {
			return result.output || result.result || ''
		}
		
		// For stderr, check error field
		if (type === 'stderr') {
			return result.error || ''
		}
		
		return ''
	}

	function extractSearchQuery(value: string): string | undefined {
		if (!value || value === 'Unknown command') return undefined
		const match = value.match(/\b(?:rg|grep)\b(?:\s+-[^\s]+|\s+--[^\s]+(?:[=\s][^\s]+)?)*\s+(['"])(.*?)\1/)
		if (match?.[2]) return match[2]
		return undefined
	}
	
	// Combine outputs for display
	let displayOutput = $derived.by(() => {
		let output = ''
		if (stdout) output += stdout
		if (stderr) {
			if (output) output += '\n'
			output += stderr
		}
		return output || 'Command completed with no output'
	})
</script>

<FullTool
	icon={icon}
	title={title}
	{subtitle}
	{status}
	{metadata}
	duration={tool.metadata?.executionTime}
	error={tool.error}
>
	{#if operationKind === 'search_files' && searchResults.length > 0}
		<div class="search-results">
			{#each searchResults as entry}
				<div class="search-result-card">
					<div class="search-result-header">
						<div class="search-result-path">{entry.path || 'Unknown file'}</div>
						<div class="search-result-count">
							{entry.matchCount || 0} match{entry.matchCount === 1 ? '' : 'es'}
						</div>
					</div>
					{#if Array.isArray(entry.matches) && entry.matches.length > 0}
						<div class="search-result-matches">
							{#each entry.matches as match}
								<div class="search-match-row">
									<div class="search-match-line">L{match.lineNumber}</div>
									<pre class="search-match-text">{match.text}</pre>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{:else if operationKind === 'list_files' && listFiles.length > 0}
		<div class="list-results">
			{#each listFiles as entry}
				<div class="list-row">
					<div class="list-row-name">{entry.name || entry.path || 'Unknown item'}</div>
					<div class="list-row-meta">
						<span class:list-directory={entry.type === 'directory'}>
							{entry.type === 'directory' ? 'Directory' : entry.type === 'file' ? 'File' : 'Item'}
						</span>
						<span class="list-row-path">{entry.path}</span>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="terminal-wrapper">
			{#if command && command !== 'Unknown command'}
				<div class="command-line">
					<span class="prompt">$</span>
					<span class="command-text">{command}</span>
				</div>
			{/if}
			
			<div class="terminal-output" class:has-error={status === 'error'}>
				<pre class="output-content">{displayOutput}</pre>
				
				{#if stderr && stdout}
					<div class="stderr-section">
						<div class="stderr-label">stderr:</div>
						<pre class="stderr-content">{stderr}</pre>
					</div>
				{/if}
			</div>
			
			{#if typeof exitCode === 'number'}
				<div class="exit-status" class:success={exitCode === 0} class:error={exitCode !== 0}>
					{#if exitCode === 0}
						<Check size={14} />
					{:else}
						<X size={14} />
					{/if}
					<span class="status-text">
						Process exited with code {exitCode}
					</span>
				</div>
			{/if}
		</div>
	{/if}
</FullTool>

<style>
	.search-results,
	.list-results {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.search-result-card,
	.list-row {
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		background: oklch(1 0 0 / 0.03);
	}

	.search-result-card {
		padding: 0.75rem;
	}

	.search-result-header,
	.list-row {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.search-result-path,
	.list-row-name {
		font-weight: 600;
		font-size: 0.875rem;
		word-break: break-word;
	}

	.search-result-count,
	.list-row-meta {
		color: var(--muted-foreground);
		font-size: 0.75rem;
	}

	.search-result-matches {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.search-match-row {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.5rem;
		padding: 0.5rem;
		border-radius: 0.375rem;
		background: var(--muted);
	}

	.search-match-line {
		color: var(--muted-foreground);
		font-size: 0.75rem;
		font-weight: 600;
	}

	.search-match-text {
		margin: 0;
		font-size: 0.75rem;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.list-row {
		padding: 0.75rem;
	}

	.list-row-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.list-directory {
		color: var(--foreground);
		font-weight: 600;
	}

	.list-row-path {
		word-break: break-word;
	}

	.terminal-wrapper {
		font-family: var(--font-mono, monospace);
		min-width: 0;
		max-width: 100%;
	}
	
	.command-line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem;
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: 0.375rem 0.375rem 0 0;
		font-size: 0.875rem;
		min-width: 0;
		max-width: 100%;
	}
	
	.prompt {
		color: var(--muted-foreground);
		font-weight: bold;
	}
	
	.command-text {
		min-width: 0;
		color: var(--foreground);
		word-break: break-all;
	}
	
	.terminal-output {
		background: #0a0a0a; /* Darker, almost black */
		border: 1px solid var(--border);
		border-top: none;
		padding: 1rem;
		overflow: auto;
		max-height: 400px;
		min-width: 0;
		max-width: 100%;
	}
	
	.terminal-output.has-error {
		background: #140808; /* Dark red tint for errors */
	}
	
	.output-content {
		margin: 0;
		font-size: 0.75rem;
		line-height: 1.5;
		color: #e4e4e4;
		white-space: pre-wrap; /* Enable line wrapping */
		word-wrap: break-word; /* Wrap long words */
		word-break: break-word; /* Break at word boundaries */
		overflow-wrap: break-word; /* Ensure wrapping happens */
	}
	
	.stderr-section {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid rgba(239, 68, 68, 0.3);
	}
	
	.stderr-label {
		color: rgb(239 68 68);
		font-size: 0.6875rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
		text-transform: uppercase;
	}
	
	.stderr-content {
		margin: 0;
		color: #ff9999;
		font-size: 0.75rem;
		line-height: 1.5;
		white-space: pre-wrap;
	}
	
	.exit-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-top: none;
		border-radius: 0 0 0.375rem 0.375rem;
		font-size: 0.75rem;
	}
	
	.exit-status.success {
		background: oklch(1 0 0 / 0.04);
		border-color: var(--border);
		color: var(--foreground);
	}
	
	.exit-status.error {
		background: oklch(1 0 0 / 0.04);
		border-color: var(--border);
		color: var(--muted-foreground);
	}
	
	
	.status-text {
		font-weight: 500;
	}
	
	/* Scrollbar styling for terminal output */
	.terminal-output::-webkit-scrollbar {
		width: 8px;
		height: 8px;
	}
	
	.terminal-output::-webkit-scrollbar-track {
		background: transparent;
	}
	
	.terminal-output::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 9999px;
	}
	
	.terminal-output::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}
</style>
