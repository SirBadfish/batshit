const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

const PUBLIC_REGISTRY_PATHS = new Set([
  '/registry/catalog.json',
  '/registry/compatibility-matrix.json'
])

const PROTECTED_CRON_PATHS = new Set([
  '/api/admin/cron/model-catalog',
  '/api/admin/cron/compatibility-matrix'
])

function isTruthy(value: string | undefined): boolean {
  return TRUE_VALUES.has((value ?? '').trim().toLowerCase())
}

function normalizePath(pathname: string): string {
  const cleaned = pathname.replace(/\/+$/, '')
  return cleaned || '/'
}

export function isHostedAppExemptPath(pathname: string): boolean {
  const normalized = normalizePath(pathname)
  return PUBLIC_REGISTRY_PATHS.has(normalized) || PROTECTED_CRON_PATHS.has(normalized)
}

// The hosted Vercel deployment serves ONLY the public registry JSON and protected cron
// endpoints. It has no batshit-server, no uploads volume, and a read-only filesystem, so
// single-user-instance startup work (backup-restore recovery, skill filesystem sync,
// prompt/clip seeding) must not run there.
export function isHostedVercelRegistryDeployment(
  env: Record<string, string | undefined>
): boolean {
  return isTruthy(env.VERCEL) && !isTruthy(env.BATSHIT_ENABLE_HOSTED_APP)
}

export function shouldBlockHostedVercelAppRequest(input: {
  env: Record<string, string | undefined>
  url: URL
}): boolean {
  if (!isTruthy(input.env.VERCEL)) return false
  if (isTruthy(input.env.BATSHIT_ENABLE_HOSTED_APP)) return false
  return !isHostedAppExemptPath(input.url.pathname)
}

export function hostedVercelAppDisabledResponse(): Response {
  return new Response(
    [
      'Batshit is a self-hosted local app.',
      'This hosted app surface is intentionally disabled.',
      'Use https://docs.batshit.ai/ to install and run your own instance.'
    ].join('\n'),
    {
      status: 410,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow'
      }
    }
  )
}
