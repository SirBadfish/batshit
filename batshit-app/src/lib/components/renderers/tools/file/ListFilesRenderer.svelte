<!-- ListFilesRenderer.svelte - Beautiful rendering for list_files tool -->
<script lang="ts">
	import CompactTool from '../templates/CompactTool.svelte'
	import type { ToolData } from '../toolRendererRegistry'
	import { Folder, File, FolderOpen } from '@lucide/svelte'
	
	let { tool }: { tool: ToolData } = $props()

	// Extract directory info from input or result
	let dirPath = $derived.by(() => {
		const directPath =
			tool.toolInput?.dirPath ||
			tool.toolInput?.directory ||
			tool.toolInput?.path ||
			tool.toolResult?.dirPath ||
			tool.toolResult?.mappedToolInput?.dirPath ||
			tool.toolResult?.mappedToolInput?.path
		if (typeof directPath === 'string' && directPath.trim().length > 0) return directPath

		const command =
			tool.toolInput?.command ||
			tool.toolResult?.command ||
			tool.toolResult?.mappedToolInput?.command
		const fromCommand = extractDirectoryFromCommand(command)
		return fromCommand || '.'
	})
	let dirName = $derived(dirPath === '.' ? 'Current directory' : dirPath.split('/').pop() || dirPath)

	// Extract file list and counts
	let fileData = $derived(extractFiles(tool.toolResult))
	let totalFiles = $derived(tool.toolResult?.totalFiles || fileData.filter(f => resolveEntryType(f) !== 'directory').length)
	let totalDirs = $derived(tool.toolResult?.totalDirectories || fileData.filter(f => resolveEntryType(f) === 'directory').length)
	let totalItems = $derived(fileData.length)

	let summary = $derived(buildSummary(totalFiles, totalDirs, totalItems))

	// Build details for expanded view
	let fileList = $derived(formatFileList(fileData))
	
	
	function buildSummary(files: number, dirs: number, items: number): string {
		const parts = []
		if (files > 0) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`)
		if (dirs > 0) parts.push(`${dirs} ${dirs === 1 ? 'folder' : 'folders'}`)
		if (parts.length === 0 && items > 0) parts.push(`${items} ${items === 1 ? 'item' : 'items'}`)
		return parts.join(', ') || 'Empty directory'
	}

	function resolveEntryType(entry: any): string {
		if (typeof entry === 'string') return entry.endsWith('/') ? 'directory' : 'item'
		if (!entry || typeof entry !== 'object') return 'item'
		if (entry.type === 'directory' || entry.kind === 'directory' || entry.isDirectory === true) {
			return 'directory'
		}
		if (entry.type === 'file' || entry.kind === 'file' || entry.isFile === true) {
			return 'file'
		}
		return 'item'
	}

	function parseMaybeJson(value: unknown): unknown {
		if (typeof value !== 'string') return value
		const trimmed = value.trim()
		if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
		try {
			return JSON.parse(trimmed)
		} catch {
			return value
		}
	}

	function extractDirectoryFromCommand(command: unknown): string | null {
		if (typeof command !== 'string') return null
		const segments = command
			.split(/&&|\|\||;/)
			.map((segment) => segment.trim())
			.filter(Boolean)
		const primary = segments.length > 0 ? segments[segments.length - 1] : command.trim()
		if (!primary) return null

		const tokenizer = /"([^"]*)"|'([^']*)'|([^\s]+)/g
		const tokens: string[] = []
		let match: RegExpExecArray | null = null
		while ((match = tokenizer.exec(primary))) {
			tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
		}
		if (tokens.length === 0) return null

		const commandName = tokens[0]?.toLowerCase()
		if (!commandName) return null

		const firstArg = (startIndex = 1) => {
			for (let i = startIndex; i < tokens.length; i += 1) {
				const token = tokens[i]
				if (!token || token === '--' || token.startsWith('-')) continue
				return token
			}
			return null
		}

		if (commandName === 'ls' || commandName === 'find' || commandName === 'tree') {
			return firstArg(1)
		}

		return null
	}
	
	function extractFiles(result: any): any[] {
		if (!result) return []

		const parsedResult = parseMaybeJson(result)
		if (parsedResult !== result) {
			return extractFiles(parsedResult)
		}
		
		// batshit-server returns files as an array of objects
		if (result.files && Array.isArray(result.files)) {
			return result.files
		}

		// Wrapped output payloads
		if (result.result) {
			const nested = extractFiles(result.result)
			if (nested.length > 0) return nested
		}
		if (result.output) {
			const nested = extractFiles(result.output)
			if (nested.length > 0) return nested
		}
		
		// Raw shell output variants (mapped native bash list/find/tree)
		if (typeof result === 'string') return parseShellListOutput(result)
		if (typeof result?.stdout === 'string') return parseShellListOutput(result.stdout)
		if (typeof result?.output === 'string') return parseShellListOutput(result.output)
		if (typeof result?.content === 'string') return parseShellListOutput(result.content)

		// Direct array result
		if (Array.isArray(result)) return result
		
		// Other common patterns
		if (result.items && Array.isArray(result.items)) return result.items
		if (result.entries && Array.isArray(result.entries)) return result.entries
		if (result.list && Array.isArray(result.list)) return result.list
		
		return []
	}

	function parseShellListOutput(rawOutput: string): any[] {
		if (!rawOutput) return []

		const lines = rawOutput
			.split(/\r?\n/)
			.map((line: string) => line.trim())
			.filter(Boolean)

		if (lines.length === 0) return []

		const parsed = lines
			.map((line: string) => {
				if (/^total\s+\d+/i.test(line)) return null

				// Typical `ls -la` line: drwxr-xr-x  5 user group 160 Feb 08 12:00 dirname
				const longLs = line.match(
					/^([bcdlps-][rwxstST-]{9}[+@]?)\s+\d+\s+\S+\s+\S+\s+\d+\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/
				)
				if (longLs?.[2]) {
					const name = longLs[2].replace(/\s+->\s+.+$/, '').trim()
					if (!name || name === '.' || name === '..') return null
					return {
						name,
						type: longLs[1].startsWith('d') ? 'directory' : 'file'
					}
				}

				// Plain output lines (`ls`, `find`, `tree` fallback)
				const name = line.replace(/^[├└│─\s]+/, '').trim()
				if (!name || name === '.' || name === '..') return null
				return {
					name,
					type: name.endsWith('/') ? 'directory' : 'file'
				}
			})
			.filter(Boolean) as any[]

		return parsed
	}
	
	// Build a tree structure from flat file list
	function buildFileTree(files: any[]): any {
		const tree: any = {}
		
		files.forEach(file => {
			const path = typeof file === 'string' ? file : (file.path || file.name || '')
			// Remove 'docs/' prefix if it exists to avoid duplication
			const cleanPath = path.startsWith('docs/') ? path.substring(5) : path
			const parts = cleanPath.split('/').filter((p: string) => p) // Filter out empty parts
			
			let current = tree
			
			parts.forEach((part: string, index: number) => {
				if (index === parts.length - 1) {
					// This is the final part - store the file object
					current[part] = file
				} else {
					// This is a directory in the path
					if (!current[part]) {
						current[part] = {}
					} else if (typeof current[part] === 'object' && current[part].type) {
						// This was previously stored as a directory object from batshit-server
						// Convert it to a tree node and preserve the directory metadata
						const dirMetadata = current[part]
						current[part] = { '_metadata': dirMetadata }
					}
					current = current[part]
				}
			})
		})
		
			return tree
		}
	
	// Format file list as tree
	function formatFileList(files: any[]): any[] {
		if (files.length === 0) return []
		
		// Check if we have recursive data
		// Look at the toolInput to see if recursive was requested
		const recursiveRequested = tool.toolInput?.recursive === true || 
		                          tool.toolInput?.depth > 1 ||
		                          tool.toolResult?.recursive === true
		
		// Also check if any file has nested structure (type === 'directory')
		const hasNestedStructure = files.some(f => {
			if (typeof f === 'object' && f !== null) {
				// If it's a directory, we likely have recursive data
				return f.type === 'directory'
			}
			return false
		})
		
		// Or check for slashes in paths (but not just the base directory)
		const hasSubPaths = files.some(f => {
			const path = typeof f === 'string' ? f : (f.path || f.name || '')
			// Remove the base directory if present
			const cleanPath = path.replace(/^docs\//, '')
			// Check if there are any slashes in the clean path
			return cleanPath.includes('/')
		})
		
		const isRecursive = recursiveRequested || hasNestedStructure || hasSubPaths
		
			if (isRecursive) {
				// Build tree structure for recursive listing
				const tree = buildFileTree(files)
				return formatTreeNode(tree, '')
		} else {
			// Simple flat list - sort directories first
			const sorted = [...files].sort((a, b) => {
				const aName = typeof a === 'string' ? a : (a.name || '')
				const bName = typeof b === 'string' ? b : (b.name || '')
				const aIsDir = typeof a === 'object' && a !== null ? 
					a.type === 'directory' : 
					(typeof a === 'string' && a.endsWith('/'))
				const bIsDir = typeof b === 'object' && b !== null ? 
					b.type === 'directory' : 
					(typeof b === 'string' && b.endsWith('/'))
				
				if (aIsDir && !bIsDir) return -1
				if (!aIsDir && bIsDir) return 1
				return aName.localeCompare(bName)
			})
			
			return sorted.map(file => {
				const name = typeof file === 'string' ? file : (file.name || '')
				const isDir = resolveEntryType(file) === 'directory'
				const size = typeof file === 'object' && file !== null && file.size ? 
					formatFileSize(file.size) : null
				
				return {
					name,
					isDir,
					size,
					indent: 0
				}
			})
		}
	}
	
	// Format tree node recursively
	function formatTreeNode(node: any, prefix: string, indent = 0): any[] {
		const items: any[] = []
		const entries = Object.entries(node).sort(([aKey, aVal], [bKey, bVal]) => {
			// Check if entries are directories
			const aIsDir = isDirectory(aVal)
			const bIsDir = isDirectory(bVal)
			
			// Sort directories first, then alphabetically
			if (aIsDir && !bIsDir) return -1
			if (!aIsDir && bIsDir) return 1
			return aKey.localeCompare(bKey)
		})
		
		entries.forEach(([key, value], index) => {
			const isLast = index === entries.length - 1
			const isDir = isDirectory(value)
			const hasChildren = hasChildNodes(value)
			
			items.push({
				name: key,
				isDir,
				// Only show size for actual files, not directories
				size: getFileSize(value),
				indent,
				isLast,
				prefix
			})
			
			// Recurse into nested structures
			if (hasChildren) {
				// Only add to prefix for indentation levels beyond the first
				const newPrefix = indent === 0 ? '' : prefix + (isLast ? '    ' : '│   ')
				const childNode = getChildNode(value)
				items.push(...formatTreeNode(childNode, newPrefix, indent + 1))
			}
		})
		
		return items
	}
	
	// Helper: Check if a node represents a directory
	function isDirectory(value: any): boolean {
		if (!value || typeof value !== 'object') return false
		
		// Explicit directory from batshit-server
		if (value.type === 'directory') return true
		
		// Nested object structure (tree node with children)
		// But exclude file objects with properties
		if (!value.type && Object.keys(value).length > 0) {
			// Check if any child is an object (indicating nested structure)
			return Object.values(value).some(v => 
				typeof v === 'object' && v !== null
			)
		}
		
		return false
	}
	
	// Helper: Check if node has children to recurse into
	function hasChildNodes(value: any): boolean {
		if (!value || typeof value !== 'object') return false
		
		// File objects from batshit-server don't have children
		if (value.type === 'file' || value.type === 'directory') return false
		
		// Tree nodes created by buildFileTree do have children
		return Object.keys(value).length > 0 && !value.type
	}
	
	// Helper: Get the child node to recurse into
	function getChildNode(value: any): any {
		// For tree nodes, the value itself is the child structure
		return value
	}
	
	// Helper: Get formatted file size if applicable
	function getFileSize(value: any): string | null {
		if (typeof value === 'object' && value !== null && 
		    value.type === 'file' && value.size) {
			return formatFileSize(value.size)
		}
		return null
	}
	
	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	}
	
	function getFileIcon(ext?: string): string {
		return ext ? ext.slice(0, 4).toUpperCase() : 'FILE'
	}
</script>

<CompactTool
	icon={Folder}
	title="List Files"
	summary={`${summary} in ${dirName}`}
	status={tool.success ? 'success' : 'error'}
	expandable={totalItems > 0}
	error={tool.error}
>
	<div class="file-list">
		{#if fileList.length === 0}
			<div class="empty-message">No files found</div>
		{:else}
			{#each fileList as item (`${item.indent}-${item.name}-${item.size || ''}`)}
				<div class="file-item" style="padding-left: {item.indent * 1.5}rem">
					{#if item.indent > 0}
						<span class="tree-line">{item.isLast ? '└── ' : '├── '}</span>
					{/if}
					<span class="file-icon">
						{#if item.isDir}
							<FolderOpen size={14} />
						{:else}
							<File size={14} />
						{/if}
					</span>
					<span class="file-name">{item.name}</span>
					{#if item.size}
						<span class="file-size">({item.size})</span>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</CompactTool>

<style>
	.file-list {
		padding: 0.35rem 0.4rem;
		max-height: 400px;
		overflow-y: auto;
		font-family: var(--font-mono, monospace);
		font-size: 0.76rem;
		border-top: 1px solid var(--bs-app-inner-line);
		background: color-mix(in oklab, var(--bs-app-field) 34%, transparent);
	}
	
	.empty-message {
		padding: 1rem;
		text-align: center;
		color: var(--muted-foreground);
		font-style: italic;
	}
	
	.file-item {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.115rem 0.25rem;
		border-radius: 0.25rem;
		line-height: 1.38;
		color: var(--foreground);
		white-space: nowrap;
	}
	
	.file-item:hover {
		background: oklch(1 0 0 / 0.02);
	}
	
	.tree-line {
		color: var(--muted-foreground);
		font-family: var(--font-mono, monospace);
		white-space: pre;
	}
	
	.file-icon {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		color: var(--muted-foreground);
	}

	.file-item .file-icon :global(svg) {
		width: 0.84rem;
		height: 0.84rem;
	}
	
	.file-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	
	.file-size {
		color: var(--muted-foreground);
		font-size: 0.75rem;
		margin-left: 0.5rem;
		flex-shrink: 0;
	}
	
	
	/* Scrollbar styling */
	.file-list::-webkit-scrollbar {
		width: 8px;
	}
	
	.file-list::-webkit-scrollbar-track {
		background: transparent;
	}
	
	.file-list::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 9999px;
	}
	
	.file-list::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.4);
	}
</style>
