/**
 * Where a picture in a chat reply comes from (BL-474, step 1): the one classifier for every
 * picture address the chat draws. Josh's rule (2026-09-27): a picture from outside Batshit loads
 * only after the user clicks, because the request itself sends the address (and anything the
 * address carries) to that website.
 *
 * - `owned`: Batshit's own content, drawn at once as before: a picture from a Clip the server
 *   returned for this message, an upload on the configured Batshit server (or a canonical
 *   relative `/uploads/` path, resolved against that server as `resolveUploadUrlForBrowser`
 *   does), or a raster `data:image/*` address.
 *   Ownership is proved by where the address came from or by the configured server's origin,
 *   never by a model-written attribute or by `/uploads/` in some other website's address.
 * - `outside`: any other `http:` or `https:` address. It is drawn as a box until the user clicks
 *   Load (`imageLoadConsent.svelte.ts`). `carriesData` says the address carries extra data
 *   (see `addressCarriesData`).
 * - `unsupported`: anything else (another scheme, an SVG or non-image `data:` address, any `blob:`
 *   address (no chat picture is one Batshit made; a written one proves nothing), text that is
 *   not an address). Never drawn.
 *
 * Step 2 (where an outside address came from) adds states to `outside`; callers switch on `kind`.
 * Pure, with no browser, Svelte, or server imports, so the server can use it too.
 */

export type OwnedImageOwner = 'clip' | 'upload' | 'data'

export type ImageSource =
  | { kind: 'owned'; url: string; owner: OwnedImageOwner }
  | { kind: 'outside'; url: string; host: string; carriesData: boolean }
  | { kind: 'unsupported'; url: string }

export type ImageSourceContext = {
  /** The page's own address, for relative addresses. */
  baseUrl: string
  /** The configured Batshit server's address or addresses (where uploads live). */
  serverUrls: readonly string[]
  /** The address came from a Clip record the server returned for this message. */
  fromTrustedClip?: boolean
}

const RASTER_DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp)[;,]/i
const UPLOAD_PATH = '/uploads/'
/** A run of address characters long enough to hold encoded data (base64, base64url, hex, or percent escapes). */
const ENCODED_RUN = /^(?:[A-Za-z0-9+=_-]|%[0-9A-Fa-f]{2})+$/
const ENCODED_RUN_MIN_LENGTH = 24
const LONG_HOST_LABEL = /^[A-Za-z0-9-]{24,}$/

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/**
 * Whether an outside address carries extra data that loading it would send to the website: a
 * query string or a fragment, a user name or password, a path part that looks like encoded data
 * (24 or more characters of base64, base64url, hex, or percent escapes, with no `.`), or a host
 * name part of 24 or more letters and digits. A warning only; it never changes whether the
 * picture may load.
 */
export function addressCarriesData(url: URL): boolean {
  if (url.search.length > 1 || url.hash.length > 1) return true
  if (url.username || url.password) return true
  for (const part of url.pathname.split('/')) {
    if (part.length >= ENCODED_RUN_MIN_LENGTH && ENCODED_RUN.test(part)) return true
  }
  for (const label of url.hostname.split('.')) {
    if (LONG_HOST_LABEL.test(label)) return true
  }
  return false
}

export function classifyImageSource(raw: string | null | undefined, context: ImageSourceContext): ImageSource {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { kind: 'unsupported', url: '' }

  if (/^data:/i.test(value)) {
    return RASTER_DATA_IMAGE.test(value)
      ? { kind: 'owned', url: value, owner: 'data' }
      : { kind: 'unsupported', url: value }
  }

  if (context.fromTrustedClip) {
    // The server's own Clip record named this address; scheme safety stays the renderer's.
    return { kind: 'owned', url: value, owner: 'clip' }
  }

  const serverOrigins = context.serverUrls.map(originOf).filter((origin): origin is string => Boolean(origin))

  // A canonical relative upload path belongs to the configured server, as the server's
  // `resolveUploadUrlForBrowser` resolves it. `//host/uploads/...` is another website.
  if (value.startsWith(UPLOAD_PATH) && serverOrigins.length > 0) {
    try {
      // Dot segments can walk out of `/uploads/`; the resolved path must still be under it.
      const resolved = new URL(value, `${serverOrigins[0]}/`)
      return resolved.pathname.startsWith(UPLOAD_PATH)
        ? { kind: 'owned', url: resolved.href, owner: 'upload' }
        : { kind: 'outside', url: resolved.href, host: resolved.hostname, carriesData: addressCarriesData(resolved) }
    } catch {
      return { kind: 'unsupported', url: value }
    }
  }

  let parsed: URL
  try {
    parsed = new URL(value, context.baseUrl)
  } catch {
    return { kind: 'unsupported', url: value }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'unsupported', url: value }
  }

  if (serverOrigins.includes(parsed.origin) && parsed.pathname.startsWith(UPLOAD_PATH)) {
    return { kind: 'owned', url: parsed.href, owner: 'upload' }
  }

  return { kind: 'outside', url: parsed.href, host: parsed.hostname, carriesData: addressCarriesData(parsed) }
}
