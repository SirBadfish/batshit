import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { nativeToolService } from '$lib/server/services/nativeTools'

interface NativeBashExecuteRequest {
  userId?: string
  command?: string
  projectPath?: string
  cwd?: string
  timeoutMs?: number
  accessMode?: 'plan' | 'agent' | 'dangerous' | 'workspace' | 'read_only'
  policyMode?: 'workspace' | 'read_only'
  commandAllowList?: string[]
  neverAllowList?: string[]
  approved?: boolean
  requireApproval?: boolean
  maxOutputChars?: number
  backend?: 'local' | 'docker_sandbox' | 'apple_container'
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as NativeBashExecuteRequest | null
    if (!body || typeof body !== 'object') {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const command = typeof body.command === 'string' ? body.command.trim() : ''
    if (!command) {
      return json({ success: false, error: 'command is required.' }, { status: 400 })
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })

    if (!auth) {
      return apiFailure('Unauthorized', 401)
    }

    // Bridge defaults are stricter than Mode 3 direct native execution.
    const result = await nativeToolService.nativeBashExecute({
      userId: auth.userId,
      command,
      projectPath: body.projectPath,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
      accessMode: body.accessMode ?? body.policyMode ?? 'read_only',
      policyMode: body.policyMode ?? 'read_only',
      commandAllowList: body.commandAllowList,
      neverAllowList: body.neverAllowList,
      requireApproval: body.requireApproval ?? true,
      approved: body.approved === true,
      maxOutputChars: body.maxOutputChars,
      backend: body.backend
    })

    const statusCode = result.success === false ? 400 : 200
    return json(
      {
        auth: auth.auth,
        ...result
      },
      { status: statusCode }
    )
  } catch (error) {
    console.error('[Native Tools] bash/execute failed:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Native bash execution failed.'
      },
      { status: 500 }
    )
  }
}
