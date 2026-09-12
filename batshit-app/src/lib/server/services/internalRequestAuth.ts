import { env } from '$env/dynamic/private'
import { timingSafeEqual } from 'crypto'

function safeTokenEquals(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false

  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false

  return timingSafeEqual(actualBuffer, expectedBuffer)
}

/**
 * The instance service token, and ONLY it.
 *
 * SA-117 DL-117-06 removed the `|| MCP_GATEWAY_AUTH_TOKEN` fallback that used to sit here.
 * One secret per boundary: the Docker gateway token unlocks the user's Docker MCP gateway
 * and nothing else, and the app boot-fails without a stable, non-placeholder `BATSHIT_TOKEN`
 * of at least 32 characters (`hooks.server.ts`), so the fallback could never have been the
 * value that matched. It was a second NAME for the instance secret, sitting where a reader
 * would mistake it for a real alternative — and `nativeToolAuth.ts`'s service lane never had
 * it, so the two gates disagreed about what "the internal token" meant.
 *
 * batshit-server keeps its own `BATSHIT_TOKEN || MCP_GATEWAY_AUTH_TOKEN` fallback: that is
 * its boundary, noted rather than changed by this story.
 */
export function getConfiguredInternalToken(): string | undefined {
  return env.BATSHIT_TOKEN || undefined
}

export function isTrustedInternalRequest(request: Request): boolean {
  const configuredToken = getConfiguredInternalToken()
  const suppliedToken =
    request.headers.get('x-batshit-service-token') ||
    request.headers.get('x-batshit-token')

  return safeTokenEquals(suppliedToken, configuredToken)
}

export function internalServiceHeaders(): Record<string, string> {
  const token = getConfiguredInternalToken()
  return token
    ? {
        'x-batshit-service-token': token,
        'x-internal-api-request': '1'
      }
    : {}
}
