export function isAuthRateLimitedPath(path: string, method = 'GET'): boolean {
  const normalizedMethod = method.toUpperCase()
  if ((path === '/login' || path === '/setup') && normalizedMethod === 'POST') {
    return true
  }

  return path.startsWith('/api/auth')
}

export function shouldApplyBroadApiRateLimit({
  path,
  method,
  rateLimitingDisabled,
  isAuthenticatedUser
}: {
  path: string
  method?: string
  rateLimitingDisabled: boolean
  isAuthenticatedUser: boolean
}): boolean {
  if (rateLimitingDisabled) return false
  if (isAuthenticatedUser) return false
  if (isAuthRateLimitedPath(path, method)) return false
  return path.startsWith('/api/')
}
