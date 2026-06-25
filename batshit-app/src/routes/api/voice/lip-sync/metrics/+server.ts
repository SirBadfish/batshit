import { json, type RequestHandler } from '@sveltejs/kit'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const LIP_SYNC_METRICS_FILENAME = 'lip-sync-current.jsonl'

function resolveMetricsLogPath() {
  const configuredFile = process.env.BATSHIT_LIP_SYNC_LOG_FILE
  if (configuredFile) {
    return path.isAbsolute(configuredFile)
      ? configuredFile
      : path.resolve(process.cwd(), '..', configuredFile)
  }

  const configuredLogDir = process.env.BATSHIT_LOG_DIR
  const logsDir = configuredLogDir
    ? path.resolve(configuredLogDir)
    : path.join(process.cwd(), '..', '_local', 'logs')

  return path.join(logsDir, LIP_SYNC_METRICS_FILENAME)
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = await request.json().catch(() => null)
    const metrics = payload?.metrics

    if (!metrics || typeof metrics !== 'object') {
      return json({ error: 'Metrics payload is required.' }, { status: 400 })
    }

    const metricsLogPath = resolveMetricsLogPath()
    await mkdir(path.dirname(metricsLogPath), { recursive: true })

    const line = JSON.stringify({
      ...metrics,
      userId: locals.user.id,
      loggedAt: new Date().toISOString()
    })

    await appendFile(metricsLogPath, `${line}\n`, 'utf8')

    return json({
      success: true,
      path: path.relative(path.resolve(process.cwd(), '..'), metricsLogPath)
    })
  } catch (error) {
    console.error('[voice/lip-sync/metrics] Failed to append metrics log:', error)
    return json({ error: 'Failed to write lip sync metrics log.' }, { status: 500 })
  }
}
