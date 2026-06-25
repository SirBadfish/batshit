/**
 * Baseline security headers for every app response (G-0235). Applied by the
 * outermost handle hook; per-route values win (the artifact route sets its own
 * frame/CSP headers), so each header is only added when absent. Full app CSP
 * is a tracked follow-up — Svelte inline styles make it non-trivial.
 */
export function applyBaselineSecurityHeaders(headers: Headers): void {
  if (!headers.has('X-Content-Type-Options')) {
    headers.set('X-Content-Type-Options', 'nosniff')
  }
  if (!headers.has('Referrer-Policy')) {
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  }
  if (!headers.has('X-Frame-Options')) {
    headers.set('X-Frame-Options', 'SAMEORIGIN')
  }
  if (!headers.has('Permissions-Policy')) {
    // Batshit uses the microphone (STT/voice) on its own origin; nothing uses
    // camera, geolocation, or payment APIs.
    headers.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=()')
  }
}
