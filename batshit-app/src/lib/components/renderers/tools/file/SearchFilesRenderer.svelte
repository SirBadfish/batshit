<!-- SearchFilesRenderer.svelte - Beautiful rendering for search_files tool -->
<script lang="ts">
	import FullTool from '../templates/FullTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
	import { Search, File, ChartBar } from '@lucide/svelte'
	import { numericKeyObjectToArray } from '$lib/utils/toolPayloadUnwrap'
	
	let { tool }: { tool: ToolData } = $props()

	// Extract search info
	let searchPattern = $derived(tool.toolInput?.searchPattern || tool.toolInput?.pattern || tool.toolInput?.query || 'unknown')
	let searchPath = $derived(tool.toolInput?.dirPath || tool.toolInput?.projectPath || tool.toolInput?.path || tool.toolInput?.directory || '.')

	// Extract results and counts from the structured data
	let searchResults = $derived(extractResults(tool.toolResult))
	let resultCount = $derived(resolveResultCount(tool.toolResult, searchResults))
	let fileCount = $derived(resolveFileCount(tool.toolResult, searchResults))

	// Build metadata
	let metadata = $derived({
		'Search Pattern': searchPattern,
		'Search Path': searchPath,
		'Files Found': fileCount,
		'Total Matches': resultCount,
		...(tool.metadata?.executionTime && { 'Search Time': `${tool.metadata.executionTime}ms` })
	})
	
	function extractResults(result: any): any {
		if (!result) return { type: 'empty' }

		// Direct string result
		if (typeof result === 'string') {
			const parsed = parseGrepStyleOutput(result)
			return parsed || { type: 'text', content: result }
		}

		// Numeric-key objects from n8n/batshit-server transports -> array
		if (result && typeof result === 'object' && !Array.isArray(result)) {
			const normalized = numericKeyObjectToArray(result)
			if (Array.isArray(normalized)) return extractResults(normalized)
		}

		// Structured results
		if (result.results && Array.isArray(result.results)) {
			return formatSearchResults(result.results, result.totalMatches)
		}

		// Legacy-ish keys
		if (result.matches) return { type: 'text', content: formatMatches(result.matches, result.totalMatches) }
		if (result.files) return { type: 'text', content: formatMatches(result.files) }
		if (result.output) return { type: 'text', content: normalizeText(result.output) }
		if (result.content) return { type: 'text', content: normalizeText(result.content) }
		if (result.stdout) {
			const stdout = normalizeText(result.stdout)
			const parsed = parseGrepStyleOutput(stdout)
			return parsed || { type: 'text', content: stdout }
		}
		if (result.result) return { type: 'text', content: normalizeText(result.result) }

		if (Array.isArray(result)) {
			return { type: 'text', content: formatMatches(result) }
		}

		return { type: 'text', content: normalizeText(result) }
	}
	
	function formatSearchResults(results: any[], totalCount?: number): any {
		if (!results || results.length === 0) return { type: 'empty' }
		
		const formattedResults: any[] = []
		let displayedMatches = 0
		const maxMatchesPerFile = 5 // Limit matches shown per file for readability
		
		results.forEach((fileResult: any) => {
			const filePath = fileResult.filePath || fileResult.absolutePath || 'Unknown file'
			const matches = fileResult.matches || []
			
			if (matches.length > 0) {
				// Use relative path if available, otherwise absolute
				const displayPath = fileResult.filePath || fileResult.absolutePath
				const matchesToShow = matches.slice(0, maxMatchesPerFile)
				
				formattedResults.push({
					path: displayPath,
					matchCount: matches.length,
					matches: matchesToShow.map((match: any) => ({
						lineNumber: match.lineNumber || match.line || '?',
						text: match.line || match.text || match.content || ''
					})),
					hasMore: matches.length > maxMatchesPerFile,
					moreCount: matches.length - maxMatchesPerFile
				})
				
				displayedMatches += matchesToShow.length
			}
		})
		
		return {
			type: 'results',
			files: formattedResults,
			totalMatches: totalCount || displayedMatches,
			displayedMatches,
			fileCount: results.length
		}
	}
	
	function formatMatches(matches: any, totalCount?: number): string {
		if (typeof matches === 'string') return matches
		
		if (Array.isArray(matches)) {
			if (matches.length === 0) return 'No matches found'
			
			// Group matches by file for better readability
			const byFile: Record<string, any[]> = {}
			
			matches.forEach(match => {
				if (typeof match === 'string') {
					// Simple string match (file path)
					byFile[match] = byFile[match] || []
				} else if (match.file || match.path) {
					const file = match.file || match.path
					byFile[file] = byFile[file] || []
					if (match.line || match.lineNumber || match.text) {
						byFile[file].push({
							line: match.lineNumber || match.line,
							text: match.text || match.content || match.match || ''
						})
					}
				}
			})
			
			// Format grouped results
			let output = ''
			Object.entries(byFile).forEach(([file, lineMatches]) => {
				output += `[file] ${file}\n`
				if (lineMatches.length > 0) {
					lineMatches.forEach(m => {
						if (m.line) {
							output += `   Line ${m.line}: ${m.text.trim()}\n`
						}
					})
				}
			})
			
			if (totalCount && totalCount > matches.length) {
				output += `\n... and ${totalCount - matches.length} more matches`
			}
			
			return output.trim()
		}
		
		return normalizeText(matches)
	}
	
	function normalizeText(value: any): string {
		if (typeof value === 'string') return value
		if (value === null || value === undefined) return ''
		if (Array.isArray(value)) return value.map((entry) => normalizeText(entry)).filter(Boolean).join('\n')
		if (typeof value === 'object') return JSON.stringify(value, null, 2)
		return String(value)
	}

	function parseGrepStyleOutput(raw: string): any | null {
		const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
		if (lines.length === 0) return { type: 'empty' }

		const grouped = new Map<string, Array<{ lineNumber: number | string; text: string }>>()
		let parsedCount = 0

		for (const line of lines) {
			const match = line.match(/^(.+?):(\d+)(?::\d+)?:\s?(.*)$/)
			if (!match) continue
			const [, filePath, lineNumberRaw, textRaw] = match
			const lineNumber = Number.parseInt(lineNumberRaw, 10)
			const text = (textRaw || '').trim()
			if (!grouped.has(filePath)) grouped.set(filePath, [])
			grouped.get(filePath)!.push({
				lineNumber: Number.isFinite(lineNumber) ? lineNumber : lineNumberRaw,
				text
			})
			parsedCount += 1
		}

		if (parsedCount === 0) return null

		const files = Array.from(grouped.entries()).map(([path, matches]) => ({
			path,
			matchCount: matches.length,
			matches,
			hasMore: false,
			moreCount: 0
		}))

		return {
			type: 'results',
			files,
			totalMatches: parsedCount,
			displayedMatches: parsedCount,
			fileCount: files.length
		}
	}

	function resolveResultCount(rawResult: any, parsedResult: any): number {
		if (typeof rawResult?.totalMatches === 'number') return rawResult.totalMatches
		return countResults(parsedResult)
	}

	function resolveFileCount(rawResult: any, parsedResult: any): number {
		if (typeof rawResult?.totalMatchingFiles === 'number') return rawResult.totalMatchingFiles
		if (parsedResult?.type === 'results' && typeof parsedResult?.fileCount === 'number') {
			return parsedResult.fileCount
		}
		return 0
	}

	function countResults(results: any): number {
		if (!results) return 0
		if (typeof results === 'string') {
			return results.split(/\r?\n/).filter((line) => line.trim().length > 0).length
		}
		if (Array.isArray(results)) return results.length
		if (typeof results === 'object') {
			if (typeof results.totalMatches === 'number') return results.totalMatches
			if (results.type === 'results') {
				const fromFiles = Array.isArray(results.files)
					? results.files.reduce((sum: number, file: any) => sum + (Number(file?.matchCount) || 0), 0)
					: 0
				return Number(results.totalMatches) || fromFiles
			}
			if (results.type === 'text') return countResults(results.content)
			if (typeof results.stdout === 'string') return countResults(results.stdout)
			if (typeof results.output === 'string') return countResults(results.output)
			if (typeof results.content === 'string') return countResults(results.content)
		}
		return 0
	}
</script>

<FullTool
	icon={Search}
	title="Search Files"
	subtitle="{resultCount} match{resultCount !== 1 ? 'es' : ''} in {fileCount} file{fileCount !== 1 ? 's' : ''}"
	status={tool.success ? 'success' : 'error'}
	{metadata}
	duration={tool.metadata?.executionTime}
	error={tool.error}
>
	<div class="search-results">
		{#if searchResults.type === 'results'}
			<div class="results-container">
				{#each searchResults.files as file}
					<div class="file-result">
						<div class="file-header">
							<File size={16} class="file-icon" />
							<span class="file-path">{file.path}</span>
							<span class="match-count">{file.matchCount} match{file.matchCount !== 1 ? 'es' : ''}</span>
						</div>
						<div class="matches-list">
							{#each file.matches as match}
								<div class="match-item">
									<span class="line-number">Line {match.lineNumber}:</span>
									<span class="match-text">{match.text.trim()}</span>
								</div>
							{/each}
							{#if file.hasMore}
								<div class="more-matches">
									... and {file.moreCount} more match{file.moreCount !== 1 ? 'es' : ''} in this file
								</div>
							{/if}
						</div>
					</div>
				{/each}
				
				{#if searchResults.displayedMatches < searchResults.totalMatches}
					<div class="summary">
						<ChartBar size={16} class="summary-icon" />
						<span>Showing {searchResults.displayedMatches} of {searchResults.totalMatches} total matches across {searchResults.fileCount} files</span>
					</div>
				{/if}
			</div>
		{:else if searchResults.type === 'text'}
			<pre>{searchResults.content}</pre>
		{:else if searchResults.type === 'empty'}
			<div class="empty-container">
				<Search size={24} class="empty-icon" />
				<div class="empty-message">No matches found</div>
			</div>
		{:else if tool.error}
			<div class="error-container">
				<div class="error-message">
					Search failed: {tool.error}
				</div>
			</div>
		{/if}
	</div>
</FullTool>

<style>
	.search-results {
		background: var(--muted);
		border-radius: var(--radius);
		padding: 1rem;
		max-height: 400px;
		overflow-y: auto;
	}
	
	/* Scrollbar styling matching ReadFileRenderer */
	.search-results::-webkit-scrollbar {
		width: 8px;
		height: 8px;
	}
	
	.search-results::-webkit-scrollbar-track {
		background: transparent;
	}
	
	.search-results::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 9999px;
	}
	
	.search-results::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}
	
	.results-container {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	
	.file-result {
		background: rgba(0, 0, 0, 0.3);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem;
	}
	
	.file-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--border);
	}
	
	:global(.file-icon) {
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
	
	.file-path {
		font-family: var(--font-mono, monospace);
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--foreground);
		flex: 1;
		word-break: break-all;
	}
	
	.match-count {
		font-size: 0.75rem;
		color: var(--muted-foreground);
		background: var(--muted);
		padding: 0.125rem 0.5rem;
		border-radius: var(--radius);
	}
	
	.matches-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding-left: 1.5rem;
	}
	
	.match-item {
		font-family: var(--font-mono, monospace);
		font-size: 0.813rem;
		line-height: 1.5;
		display: flex;
		gap: 0.5rem;
		word-break: break-all;
	}
	
	.line-number {
		color: var(--muted-foreground);
		flex-shrink: 0;
		min-width: 4rem;
	}
	
	.match-text {
		color: var(--foreground);
		flex: 1;
	}
	
	.more-matches {
		font-size: 0.813rem;
		color: var(--muted-foreground);
		font-style: italic;
		margin-top: 0.25rem;
	}
	
	.summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem;
		background: rgba(0, 0, 0, 0.3);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: 0.875rem;
		color: var(--muted-foreground);
	}
	
	:global(.summary-icon) {
		color: var(--muted-foreground);
		flex-shrink: 0;
	}
	
	.search-results pre {
		margin: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.875rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-all;
		color: var(--foreground);
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
	
	:global(.empty-icon) {
		color: var(--muted-foreground);
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
