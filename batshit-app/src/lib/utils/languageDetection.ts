// Language detection utilities for file paths and content

// Map of file extensions to language names
const extensionToLanguage: Record<string, string> = {
	// Web
	'js': 'javascript',
	'jsx': 'javascript',
	'ts': 'typescript',
	'tsx': 'typescript',
	'html': 'html',
	'htm': 'html',
	'css': 'css',
	'scss': 'scss',
	'sass': 'sass',
	'less': 'less',
	'vue': 'vue',
	'svelte': 'svelte',
	
	// Programming languages
	'py': 'python',
	'java': 'java',
	'c': 'c',
	'cpp': 'cpp',
	'cc': 'cpp',
	'cxx': 'cpp',
	'h': 'c',
	'hpp': 'cpp',
	'cs': 'csharp',
	'php': 'php',
	'rb': 'ruby',
	'go': 'go',
	'rs': 'rust',
	'kt': 'kotlin',
	'swift': 'swift',
	'scala': 'scala',
	'r': 'r',
	'lua': 'lua',
	'dart': 'dart',
	'elm': 'elm',
	'clj': 'clojure',
	'ex': 'elixir',
	'exs': 'elixir',
	
	// Shell and scripts
	'sh': 'bash',
	'bash': 'bash',
	'zsh': 'bash',
	'fish': 'fish',
	'ps1': 'powershell',
	'bat': 'batch',
	'cmd': 'batch',
	
	// Data and config
	'json': 'json',
	'json5': 'json5',
	'yaml': 'yaml',
	'yml': 'yaml',
	'toml': 'toml',
	'xml': 'xml',
	'ini': 'ini',
	'cfg': 'ini',
	'conf': 'conf',
	'properties': 'properties',
	
	// Documentation
	'md': 'markdown',
	'markdown': 'markdown',
	'mdx': 'mdx',
	'rst': 'restructuredtext',
	'tex': 'latex',
	'adoc': 'asciidoc',
	
	// Database
	'sql': 'sql',
	'mysql': 'sql',
	'pgsql': 'sql',
	'sqlite': 'sql',
	
	// Other
	'dockerfile': 'dockerfile',
	'makefile': 'makefile',
	'mk': 'makefile',
	'gradle': 'gradle',
	'proto': 'protobuf',
	'graphql': 'graphql',
	'gql': 'graphql',
	'tf': 'terraform',
	'hcl': 'hcl',
	'vim': 'vim',
	'diff': 'diff',
	'patch': 'diff',
	'gitignore': 'gitignore',
	'env': 'dotenv',
}

// Map of filenames to language names
const filenameToLanguage: Record<string, string> = {
	'Dockerfile': 'dockerfile',
	'dockerfile': 'dockerfile',
	'Makefile': 'makefile',
	'makefile': 'makefile',
	'Rakefile': 'ruby',
	'Gemfile': 'ruby',
	'Guardfile': 'ruby',
	'package.json': 'json',
	'package-lock.json': 'json',
	'tsconfig.json': 'json',
	'jsconfig.json': 'json',
	'composer.json': 'json',
	'Cargo.toml': 'toml',
	'Cargo.lock': 'toml',
	'pyproject.toml': 'toml',
	'go.mod': 'go',
	'go.sum': 'go',
	'requirements.txt': 'text',
	'CMakeLists.txt': 'cmake',
	'.gitignore': 'gitignore',
	'.dockerignore': 'gitignore',
	'.npmignore': 'gitignore',
	'.env': 'dotenv',
	'.env.local': 'dotenv',
	'.env.development': 'dotenv',
	'.env.production': 'dotenv',
	'.editorconfig': 'editorconfig',
	'.prettierrc': 'json',
	'.eslintrc': 'json',
	'.babelrc': 'json',
	'nginx.conf': 'nginx',
	'apache.conf': 'apache',
	'.vimrc': 'vim',
	'.bashrc': 'bash',
	'.zshrc': 'bash',
}

/**
 * Get language from file path
 */
export function getLanguageFromPath(filePath: string): string | null {
	if (!filePath) return null
	
	// Get the filename
	const parts = filePath.split('/')
	const filename = parts[parts.length - 1]
	
	// Check for exact filename match
	if (filenameToLanguage[filename]) {
		return filenameToLanguage[filename]
	}
	
	// Check for extension match
	if (filename.includes('.')) {
		const extension = filename.split('.').pop()?.toLowerCase()
		if (extension && extensionToLanguage[extension]) {
			return extensionToLanguage[extension]
		}
	}
	
	// Special cases
	if (filename.startsWith('.') && filename.endsWith('rc')) {
		return 'conf'
	}
	
	if (filePath.includes('/bin/') || filePath.includes('/scripts/')) {
		return 'bash'
	}
	
	return null
}

/**
 * Get file icon based on language/extension
 */
export function getFileIcon(filePath: string): string {
	const language = getLanguageFromPath(filePath)
	
	const iconMap: Record<string, string> = {
		'javascript': 'JS',
		'typescript': 'TS',
		'python': 'PY',
		'html': 'HTML',
		'css': 'CSS',
		'json': 'JSON',
		'markdown': 'MD',
		'yaml': 'YAML',
		'dockerfile': 'DOCKER',
		'bash': 'SH',
		'sql': 'SQL',
		'go': 'GO',
		'rust': 'RS',
		'ruby': 'RB',
		'java': 'JAVA',
		'php': 'PHP',
		'vue': 'VUE',
		'svelte': 'SVELTE',
		'git': 'GIT',
	}
	
	if (language && iconMap[language]) {
		return iconMap[language]
	}
	
	// Default based on general type
	if (filePath.endsWith('/')) return 'DIR'
	if (filePath.includes('.test.') || filePath.includes('.spec.')) return 'TEST'
	if (filePath.includes('config') || filePath.includes('settings')) return 'CFG'
	
	return 'FILE'
}
