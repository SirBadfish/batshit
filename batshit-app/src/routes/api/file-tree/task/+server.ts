import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireUser } from '$lib/server/services/routeSecurity'
import { assertMacCustodyPathAllowed } from '$lib/server/services/macCustodyPaths'
import path from 'node:path'
import {
  getInternalBatshitServerApiUrl,
  getInternalBatshitServerAuthHeaders
} from '$lib/server/services/batshitServerUrls'

// The read-only operations the in-app file tree needs. batshit-server's task
// API is service-token-gated; the browser reaches it only through this
// session-authed proxy, and only for these tools.
const FILE_TREE_TOOL_ALLOW_LIST = new Set(['list_files', 'read_file'])

// POST /api/file-tree/task — session-authed proxy for the browser file tree.
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  let body: { toolName?: unknown; input?: unknown; params?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const toolName = typeof body.toolName === 'string' ? body.toolName : ''
  if (!FILE_TREE_TOOL_ALLOW_LIST.has(toolName)) {
    return json(
      { error: `Tool "${toolName}" is not available through the file-tree proxy` },
      { status: 403 }
    )
  }

  try {
    const params = body.params as { projectPath?: unknown } | undefined
    const input = body.input as { filePath?: unknown; dirPath?: unknown } | undefined
    if (typeof params?.projectPath !== 'string') return json({ error: 'A project folder is required.' }, { status: 400 })
    assertMacCustodyPathAllowed(params.projectPath)
    const relative = toolName === 'read_file' ? input?.filePath : input?.dirPath
    if (typeof relative === 'string') assertMacCustodyPathAllowed(path.resolve(params.projectPath, relative))
  } catch {
    return json({ error: 'This folder is protected from file-tree access.' }, { status: 403 })
  }

  const response = await fetch(`${getInternalBatshitServerApiUrl()}/task/s`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getInternalBatshitServerAuthHeaders()
    },
    body: JSON.stringify({
      serviceName: 'built-in',
      toolName,
      input: body.input ?? {},
      params: body.params ?? {}
    })
  })

  const payload = await response.text()
  return new Response(payload, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' }
  })
}
