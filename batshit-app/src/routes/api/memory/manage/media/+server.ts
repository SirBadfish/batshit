import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import {
  deleteManagedMemoryMedia,
  loadManagedMemoryMedia,
  MemoryManageError,
  replaceManagedMemoryMedia
} from '$lib/server/services/memory/memoryManage'
import { MEMORY_MEDIA_MAX_SOURCE_BYTES } from '$lib/server/services/memory/memoryMedia'

function handleError(error: unknown, action: string): Response {
  if (error instanceof MemoryManageError) return json({ error: error.message }, { status: error.status })
  console.error(`[Memory Media] ${action} failed:`, error)
  return json({ error: error instanceof Error ? error.message : `Memory media ${action} failed` }, { status: 500 })
}

function ids(url: URL) {
  return {
    agentId: url.searchParams.get('agentId') ?? '',
    memoryId: url.searchParams.get('memoryId') ?? '',
    mediaId: url.searchParams.get('mediaId') ?? ''
  }
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const input = ids(url)
  try {
    const loaded = await loadManagedMemoryMedia(
      { userId: user.value.id, agentId: input.agentId },
      input.memoryId,
      input.mediaId
    )
    return new Response(Buffer.from(loaded.bytes), {
      headers: {
        'Content-Type': loaded.media.mime_type,
        'Content-Length': String(loaded.bytes.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  } catch (error) {
    return handleError(error, 'load')
  }
}

export const POST: RequestHandler = async ({ locals, request, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const input = ids(url)
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return json({ error: 'An image file is required.' }, { status: 400 })
    if (file.size > MEMORY_MEDIA_MAX_SOURCE_BYTES) {
      return json({ error: 'Memory image uploads cannot exceed 10 MiB.' }, { status: 413 })
    }
    const record = await replaceManagedMemoryMedia(
      { userId: user.value.id, agentId: input.agentId },
      input.memoryId,
      input.mediaId,
      { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type, filename: file.name }
    )
    return json({ record })
  } catch (error) {
    return handleError(error, 'replace')
  }
}

export const DELETE: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  const input = ids(url)
  try {
    const record = await deleteManagedMemoryMedia(
      { userId: user.value.id, agentId: input.agentId },
      input.memoryId,
      input.mediaId
    )
    return json({ record })
  } catch (error) {
    return handleError(error, 'delete')
  }
}
