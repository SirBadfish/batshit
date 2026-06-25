import { json, type RequestHandler } from '@sveltejs/kit'
import { createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { apiError } from '$lib/server/services/apiResponses'

function decodePathHeader(value: string | null): string | null {
  if (!value) return null
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return null
  }
}

function normalizeTargetPath(value: string | null): string | null {
  if (!value || value.includes('\0')) return null
  if (!path.isAbsolute(value)) return null
  const normalized = path.normalize(value)
  if (!normalized || normalized === path.parse(normalized).root) return null
  return normalized
}

async function assertWritableFileTarget(filePath: string): Promise<void> {
  const parent = path.dirname(filePath)
  const parentStats = await stat(parent)
  if (!parentStats.isDirectory()) {
    throw new Error('Save destination folder does not exist.')
  }

  try {
    const targetStats = await stat(filePath)
    if (targetStats.isDirectory()) {
      throw new Error('Save destination is a folder.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) return apiError('Unauthorized', 401)

  const targetPath = normalizeTargetPath(
    decodePathHeader(request.headers.get('x-batshit-download-path'))
  )
  if (!targetPath) {
    return json({ error: 'A valid native save path is required.' }, { status: 400 })
  }
  if (!request.body) {
    return json({ error: 'No file content was provided.' }, { status: 400 })
  }

  const tempPath = `${targetPath}.batshit-download-${Date.now()}.tmp`
  try {
    await assertWritableFileTarget(targetPath)
    await pipeline(Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tempPath))
    await rm(targetPath, { force: true })
    await rename(tempPath, targetPath)
    return json({ success: true })
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    const message = error instanceof Error ? error.message : 'Failed to save file.'
    console.error('[native-downloads] save failed', { targetPath, message })
    return json({ error: message }, { status: 500 })
  }
}
