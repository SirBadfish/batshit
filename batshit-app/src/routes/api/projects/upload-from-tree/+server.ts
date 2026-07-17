import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { Buffer } from 'node:buffer'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerTaskUrl,
  getInternalBatshitServerUrl,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'

function guessMimeType(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const imageTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    ico: 'image/x-icon'
  }
  if (imageTypes[ext]) return imageTypes[ext]

  const textTypes: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    xml: 'application/xml',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css'
  }
  if (textTypes[ext]) return textTypes[ext]

  const applicationTypes: Record<string, string> = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip'
  }
  if (applicationTypes[ext]) return applicationTypes[ext]

  return 'application/octet-stream'
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const userId = locals.user?.id
    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectPath, relativePath, sessionId } = await request.json()
    if (!projectPath || !relativePath) {
      return json({ error: 'projectPath and relativePath required' }, { status: 400 })
    }

    const readResponse = await fetch(getInternalBatshitServerTaskUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getInternalBatshitServerAuthHeaders() },
      body: JSON.stringify({
        serviceName: 'built-in',
        toolName: 'read_file',
        input: {
          filePath: relativePath,
          encoding: 'base64'
        },
        params: { projectPath }
      })
    })

    if (!readResponse.ok) {
      return json({ error: 'Failed to read file from batshit-server' }, { status: 502 })
    }

    const readResult = await readResponse.json()
    if (!readResult?.success || typeof readResult?.content !== 'string') {
      return json({ error: readResult?.error || 'Failed to read file' }, { status: 500 })
    }

    const filename = relativePath.split('/').pop() || 'file'
    const mimeType = guessMimeType(filename)
    const buffer = Buffer.from(readResult.content, 'base64')

    const userSettings = await redis.getUserSettings(userId)
    const uiSettings = userSettings?.ui_settings || {}

    const compressionSettings = {
      compress_images: uiSettings.compress_images !== false,
      compression_quality: uiSettings.compression_quality || 40,
      max_image_size: uiSettings.max_image_size || '1024',
      force_jpeg: uiSettings.force_jpeg !== false
    }

    const formData = new FormData()
    const blob = new Blob([buffer], { type: mimeType })
    formData.append('files', blob, filename)
    formData.append('userId', userId)
    if (sessionId) {
      formData.append('sessionId', sessionId)
    }
    formData.append('compressionSettings', JSON.stringify(compressionSettings))
    formData.append(
      'uploadSettings',
      JSON.stringify({
        strategy: 'local',
        storage_mode: 'local',
        webhookUrl: '',
        webhookAuth: '',
        tunnel_url: '',
        use_https: false,
        tunnel_provider: 'none',
        cloudflared_auto_start: false,
        cloudflared_target_url: ''
      })
    )

    const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}/api/upload`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: formData
    })

    if (!uploadResponse.ok) {
      return json({ error: 'Upload failed' }, { status: 502 })
    }

    const uploadResult = await uploadResponse.json()
    const uploadedFile = uploadResult?.files?.[0]
    if (!uploadedFile?.clipData) {
      return json({ error: 'Upload did not return clip data' }, { status: 500 })
    }

    const storageMode = 'local'
    const returnedTokens = uploadedFile.clipData.tokens
    const clip = {
      id: uploadedFile.clipData.id,
      filename: uploadedFile.originalName || filename,
      externalUrl: uploadedFile.externalUrl,
      displayUrl: uploadedFile.displayUrl,
      localUrl: uploadedFile.localUrl || uploadedFile.url,
      tunnelPath: uploadedFile.tunnelPath || uploadedFile.clipData.tunnelPath,
      externalTokens:
        uploadedFile.externalTokens ??
        uploadedFile.clipData.externalTokens,
      localTokens:
        uploadedFile.localTokens ??
        uploadedFile.clipData.localTokens ??
        returnedTokens,
      storageMode,
      uploadedAt: new Date().toISOString(),
      isClipped: true
    }

    return json({ clip: resolveUploadUrlsForBrowserInPayload(clip) })
  } catch (error) {
    console.error('Failed to upload project file', error)
    return json({ error: 'Failed to upload project file' }, { status: 500 })
  }
}
