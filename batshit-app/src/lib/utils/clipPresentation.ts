export interface ClipPresentationSource {
  filename?: string | null
  mimeType?: string | null
  fileType?: string | null
  thumbnailUrl?: string | null
  displayUrl?: string | null
  externalUrl?: string | null
  localUrl?: string | null
  externalTokens?: number | null
  localTokens?: number | null
  storageMode?: 'local' | string | null
  systemClip?: boolean | null
}

export interface ClipTileDescriptor {
  label: string
  sublabel: string
  background: string
  foreground: string
  border: string
}

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
])

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz'])
export const STRUCTURED_IMAGE_TOKEN_ESTIMATE = 765
const TEXT_LIKE_EXTENSIONS = new Set([
  'adoc',
  'bash',
  'c',
  'cc',
  'cfg',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'env',
  'fish',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'less',
  'log',
  'lua',
  'markdown',
  'md',
  'mdx',
  'mjs',
  'py',
  'rb',
  'rs',
  'sass',
  'scss',
  'sh',
  'sql',
  'svelte',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
])

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function getClipExtension(filename?: string | null): string {
  const trimmed = trimString(filename)
  if (!trimmed.includes('.')) return ''
  return trimmed.split('.').pop()?.toLowerCase() ?? ''
}

export function resolveClipPreviewUrl(clip: ClipPresentationSource): string | null {
  return (
    trimString(clip.thumbnailUrl) ||
    trimString(clip.displayUrl) ||
    trimString(clip.externalUrl) ||
    trimString(clip.localUrl) ||
    null
  )
}

export function isClipImage(clip: ClipPresentationSource): boolean {
  const mime = trimString(clip.mimeType).toLowerCase()
  if (mime.startsWith('image/')) return true

  const extension = getClipExtension(clip.filename)
  return IMAGE_EXTENSIONS.has(extension)
}

export function isClipTextLike(clip: ClipPresentationSource): boolean {
  const mime = trimString(clip.mimeType).toLowerCase()
  if (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('javascript') ||
    mime.includes('markdown') ||
    mime.includes('xml') ||
    mime.includes('yaml') ||
    mime.includes('x-shellscript')
  ) {
    return true
  }

  return TEXT_LIKE_EXTENSIONS.has(getClipExtension(clip.filename))
}

export function resolveClipContextTokens(clip: ClipPresentationSource): number | undefined {
  const localTokens = typeof clip.localTokens === 'number' ? clip.localTokens : undefined
  const externalTokens = typeof clip.externalTokens === 'number' ? clip.externalTokens : undefined

  if (isClipImage(clip)) {
    return externalTokens ?? STRUCTURED_IMAGE_TOKEN_ESTIMATE
  }

  if (isClipTextLike(clip)) {
    return localTokens ?? externalTokens
  }

  return localTokens ?? externalTokens
}

export function getClipFileIconName(clip: ClipPresentationSource): string {
  const filename = trimString(clip.filename) || 'file'
  const mime = trimString(clip.mimeType).toLowerCase()

  if (!getClipExtension(filename) && (mime.includes('markdown') || clip.systemClip)) {
    return `${filename}.md`
  }

  return filename
}

export function getClipExtensionLabel(clip: ClipPresentationSource): string {
  const extension = getClipExtension(getClipFileIconName(clip))
  if (!extension) return ''
  return `.${extension.slice(0, 4).toLowerCase()}`
}

export function getClipTileDescriptor(
  clip: ClipPresentationSource
): ClipTileDescriptor {
  const mime = trimString(clip.mimeType).toLowerCase()
  const extension = getClipExtension(clip.filename)
  const upperExtension = extension.toUpperCase()

  if (mime.includes('pdf') || extension === 'pdf') {
    return {
      label: 'PDF',
      sublabel: 'Document',
      background: 'linear-gradient(135deg, #b91c1c 0%, #ef4444 100%)',
      foreground: '#fff7f7',
      border: 'rgba(239, 68, 68, 0.5)',
    }
  }

  if (['doc', 'docx', 'rtf'].includes(extension)) {
    return {
      label: 'DOC',
      sublabel: 'Word',
      background: 'linear-gradient(135deg, #1d4ed8 0%, #60a5fa 100%)',
      foreground: '#eff6ff',
      border: 'rgba(96, 165, 250, 0.55)',
    }
  }

  if (['xls', 'xlsx', 'csv'].includes(extension)) {
    return {
      label: extension === 'csv' ? 'CSV' : 'XLS',
      sublabel: extension === 'csv' ? 'Data' : 'Excel',
      background: 'linear-gradient(135deg, #166534 0%, #34d399 100%)',
      foreground: '#ecfdf5',
      border: 'rgba(52, 211, 153, 0.5)',
    }
  }

  if (['ppt', 'pptx', 'key'].includes(extension)) {
    return {
      label: 'PPT',
      sublabel: 'Slides',
      background: 'linear-gradient(135deg, #c2410c 0%, #fb923c 100%)',
      foreground: '#fff7ed',
      border: 'rgba(251, 146, 60, 0.5)',
    }
  }

  if (mime.includes('markdown') || ['md', 'markdown'].includes(extension)) {
    return {
      label: 'MD',
      sublabel: 'Markdown',
      background: 'linear-gradient(135deg, #475569 0%, #94a3b8 100%)',
      foreground: '#f8fafc',
      border: 'rgba(148, 163, 184, 0.5)',
    }
  }

  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return {
      label: 'JS',
      sublabel: 'Script',
      background: 'linear-gradient(135deg, #a16207 0%, #facc15 100%)',
      foreground: '#1f2937',
      border: 'rgba(250, 204, 21, 0.55)',
    }
  }

  if (['ts', 'tsx'].includes(extension)) {
    return {
      label: 'TS',
      sublabel: 'Typed',
      background: 'linear-gradient(135deg, #1d4ed8 0%, #38bdf8 100%)',
      foreground: '#eff6ff',
      border: 'rgba(56, 189, 248, 0.5)',
    }
  }

  if (['css', 'scss', 'sass', 'less'].includes(extension)) {
    return {
      label: 'CSS',
      sublabel: 'Styles',
      background: 'linear-gradient(135deg, #0f766e 0%, #2dd4bf 100%)',
      foreground: '#f0fdfa',
      border: 'rgba(45, 212, 191, 0.5)',
    }
  }

  if (['json'].includes(extension) || mime === 'application/json') {
    return {
      label: 'JSON',
      sublabel: 'Data',
      background: 'linear-gradient(135deg, #92400e 0%, #f59e0b 100%)',
      foreground: '#fffbeb',
      border: 'rgba(245, 158, 11, 0.5)',
    }
  }

  if (['html', 'htm'].includes(extension)) {
    return {
      label: 'HTML',
      sublabel: 'Web',
      background: 'linear-gradient(135deg, #c2410c 0%, #fb7185 100%)',
      foreground: '#fff7ed',
      border: 'rgba(251, 113, 133, 0.45)',
    }
  }

  if (['txt', 'text'].includes(extension) || mime.startsWith('text/')) {
    return {
      label: 'TXT',
      sublabel: 'Text',
      background: 'linear-gradient(135deg, #334155 0%, #64748b 100%)',
      foreground: '#f8fafc',
      border: 'rgba(100, 116, 139, 0.5)',
    }
  }

  if (ARCHIVE_EXTENSIONS.has(extension) || mime.includes('zip') || mime.includes('archive')) {
    return {
      label: 'ZIP',
      sublabel: 'Archive',
      background: 'linear-gradient(135deg, #5b21b6 0%, #a855f7 100%)',
      foreground: '#faf5ff',
      border: 'rgba(168, 85, 247, 0.45)',
    }
  }

  if (VIDEO_EXTENSIONS.has(extension) || mime.startsWith('video/')) {
    return {
      label: 'VID',
      sublabel: upperExtension || 'Video',
      background: 'linear-gradient(135deg, #0f172a 0%, #6366f1 100%)',
      foreground: '#eef2ff',
      border: 'rgba(99, 102, 241, 0.45)',
    }
  }

  if (AUDIO_EXTENSIONS.has(extension) || mime.startsWith('audio/')) {
    return {
      label: 'AUD',
      sublabel: upperExtension || 'Audio',
      background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)',
      foreground: '#f0fdfa',
      border: 'rgba(20, 184, 166, 0.45)',
    }
  }

  if (isClipImage(clip)) {
    return {
      label: 'IMG',
      sublabel: upperExtension || 'Image',
      background: 'linear-gradient(135deg, oklch(0.36 0.11 278) 0%, oklch(0.58 0.16 304) 100%)',
      foreground: 'oklch(0.94 0.018 296)',
      border: 'oklch(0.66 0.16 300 / 0.52)',
    }
  }

  return {
    label: upperExtension || 'FILE',
    sublabel: clip.fileType === 'text' ? 'Text' : 'File',
    background: 'linear-gradient(135deg, #1f2937 0%, #6b7280 100%)',
    foreground: '#f9fafb',
    border: 'rgba(107, 114, 128, 0.45)',
  }
}
