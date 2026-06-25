import type { IconRef } from './iconTypes'

const CODE_EXTENSIONS = new Set([
  'astro',
  'c',
  'cc',
  'cpp',
  'cs',
  'go',
  'h',
  'hpp',
  'java',
  'kt',
  'lua',
  'php',
  'py',
  'rb',
  'rs',
  'swift'
])

const STYLE_EXTENSIONS = new Set(['css', 'less', 'sass', 'scss'])
const CONFIG_EXTENSIONS = new Set(['env', 'ini'])
const DATA_EXTENSIONS = new Set(['csv', 'jsonl', 'parquet', 'tsv'])
const DOCUMENT_EXTENSIONS = new Set(['adoc', 'log', 'md', 'mdx', 'rst', 'txt'])
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'heic', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'])
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mov', 'mp4', 'mpeg', 'webm'])
const ARCHIVE_EXTENSIONS = new Set(['7z', 'br', 'gz', 'rar', 'tar', 'tgz', 'zip'])
const SPREADSHEET_EXTENSIONS = new Set(['ods', 'xls', 'xlsx'])
const DATABASE_EXTENSIONS = new Set(['db', 'sqlite', 'sqlite3', 'sql'])
const SCRIPT_EXTENSIONS = new Set(['bash', 'bat', 'cmd', 'fish', 'ps1', 'sh', 'zsh'])
const LOCK_EXTENSIONS = new Set(['cer', 'cert', 'crt', 'key', 'pem', 'pfx'])

const FOLDER_ICON_BY_NAME: Record<string, string> = {
  '.git': 'folder-git',
  '.github': 'folder-github',
  '.vscode': 'folder-vscode',
  app: 'folder-app',
  apps: 'folder-app',
  assets: 'folder-images',
  audio: 'folder-audio',
  client: 'folder-client',
  components: 'folder-components',
  config: 'folder-config',
  configs: 'folder-config',
  css: 'folder-css',
  data: 'folder-database',
  database: 'folder-database',
  db: 'folder-database',
  dist: 'folder-dist',
  docs: 'folder-docs',
  images: 'folder-images',
  img: 'folder-images',
  lib: 'folder-lib',
  node_modules: 'folder-node',
  package: 'folder-packages',
  packages: 'folder-packages',
  public: 'folder-public',
  routes: 'folder-routes',
  sass: 'folder-sass',
  scripts: 'folder-scripts',
  server: 'folder-server',
  src: 'folder-src',
  static: 'folder-public',
  test: 'folder-test',
  tests: 'folder-test',
  tools: 'folder-tools',
  utils: 'folder-utils',
  video: 'folder-video',
  videos: 'folder-video',
  views: 'folder-views'
}

const FILE_ICON_BY_NAME: Record<string, string> = {
  '.dockerignore': 'docker',
  '.env': 'settings',
  '.env.local': 'settings',
  '.env.production': 'settings',
  '.gitignore': 'git',
  '.npmrc': 'npm',
  'biome.json': 'biome',
  'bun.lock': 'bun',
  'deno.json': 'deno',
  'docker-compose.yaml': 'docker',
  'docker-compose.yml': 'docker',
  dockerfile: 'docker',
  'eslint.config.js': 'eslint',
  'go.mod': 'go-mod',
  'go.sum': 'go',
  'package-lock.json': 'npm',
  'package.json': 'nodejs',
  'pnpm-lock.yaml': 'pnpm',
  'prettier.config.js': 'prettier',
  'pyproject.toml': 'python',
  'svelte.config.js': 'svelte',
  'tsconfig.json': 'tsconfig',
  'vite.config.js': 'vite',
  'vite.config.ts': 'vite',
  'vitest.config.js': 'vitest',
  'vitest.config.ts': 'vitest',
  'yarn.lock': 'yarn'
}

function fileType(id: string): IconRef {
  return { kind: 'fileType', id }
}

function folderType(baseId: string, isExpanded = false): IconRef {
  return fileType(isExpanded ? `${baseId}-open` : baseId)
}

function extensionFor(name: string) {
  const segments = name.toLowerCase().split('.')
  return segments.length > 1 ? segments.at(-1) ?? '' : ''
}

export function getProjectTreeIconRef(node: {
  name: string
  type: 'file' | 'directory'
  isExpanded?: boolean
}): IconRef {
  const normalizedName = node.name.trim().toLowerCase()

  if (node.type === 'directory') {
    if (normalizedName.includes('secret') || normalizedName.includes('credential')) {
      return folderType('folder-secure', node.isExpanded)
    }
    if (normalizedName.includes('private')) {
      return folderType('folder-private', node.isExpanded)
    }
    if (normalizedName.includes('admin')) {
      return folderType('folder-admin', node.isExpanded)
    }
    const folderId = FOLDER_ICON_BY_NAME[normalizedName] ?? 'folder'
    return folderType(folderId, node.isExpanded)
  }

  const extension = extensionFor(normalizedName)

  if (FILE_ICON_BY_NAME[normalizedName]) return fileType(FILE_ICON_BY_NAME[normalizedName])
  if (normalizedName.endsWith('.d.ts')) return fileType('typescript-def')
  if (normalizedName.endsWith('.schema.json')) return fileType('json_schema')
  if (normalizedName.startsWith('readme.')) return fileType('readme')
  if (normalizedName.startsWith('license')) return fileType('license')
  if (normalizedName.startsWith('changelog')) return fileType('changelog')
  if (normalizedName.includes('secret')) return fileType('lock')
  if (LOCK_EXTENSIONS.has(extension)) {
    return extension === 'cer' || extension === 'cert' || extension === 'crt' ? fileType('certificate') : fileType('key')
  }
  if (extension === 'ts') return fileType('typescript')
  if (extension === 'tsx') return fileType('react_ts')
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') return fileType('javascript')
  if (extension === 'jsx') return fileType('react')
  if (extension === 'svelte') return fileType('svelte')
  if (extension === 'vue') return fileType('vue')
  if (extension === 'html' || extension === 'htm') return fileType('html')
  if (STYLE_EXTENSIONS.has(extension)) {
    if (extension === 'scss' || extension === 'sass') return fileType('sass')
    return fileType(extension)
  }
  if (extension === 'json') return fileType('json')
  if (extension === 'yaml' || extension === 'yml') return fileType('yaml')
  if (extension === 'toml') return fileType('toml')
  if (extension === 'xml') return fileType('xml')
  if (extension === 'mdx') return fileType('mdx')
  if (extension === 'md' || extension === 'markdown') return fileType('markdown')
  if (extension === 'ipynb') return fileType('jupyter')
  if (extension === 'blend') return fileType('blender')
  if (extension === 'fig') return fileType('figma')
  if (extension === 'drawio') return fileType('drawio')
  if (extension === 'excalidraw') return fileType('excalidraw')
  if (extension === 'mmd' || extension === 'mermaid') return fileType('mermaid')
  if (extension === 'onnx') return fileType('onnx')
  if (extension === 'pt' || extension === 'pth') return fileType('pytorch')
  if (SCRIPT_EXTENSIONS.has(extension)) return extension === 'ps1' ? fileType('powershell') : fileType('console')
  if (extension === 'graphql' || extension === 'gql') return fileType('graphql')
  if (extension === 'prisma') return fileType('prisma')
  if (extension === 'tf' || extension === 'tfvars') return fileType('terraform')
  if (CODE_EXTENSIONS.has(extension)) {
    if (extension === 'cc' || extension === 'cxx') return fileType('cpp')
    if (extension === 'h' || extension === 'hpp') return fileType('cpp')
    if (extension === 'cs') return fileType('csharp')
    if (extension === 'kt') return fileType('kotlin')
    if (extension === 'py') return fileType('python')
    if (extension === 'rb') return fileType('ruby')
    if (extension === 'rs') return fileType('rust')
    return fileType(extension)
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) return extension === 'log' ? fileType('log') : fileType('document')
  if (extension === 'pdf') return fileType('pdf')
  if (extension === 'doc' || extension === 'docx') return fileType('word')
  if (extension === 'ppt' || extension === 'pptx') return fileType('powerpoint')
  if (IMAGE_EXTENSIONS.has(extension)) return extension === 'svg' ? fileType('svg') : fileType('image')
  if (AUDIO_EXTENSIONS.has(extension)) return fileType('audio')
  if (VIDEO_EXTENSIONS.has(extension)) return fileType('video')
  if (ARCHIVE_EXTENSIONS.has(extension)) return fileType('zip')
  if (SPREADSHEET_EXTENSIONS.has(extension)) return fileType('table')
  if (DATA_EXTENSIONS.has(extension)) return fileType('table')
  if (DATABASE_EXTENSIONS.has(extension)) return fileType('database')

  return fileType('file')
}
