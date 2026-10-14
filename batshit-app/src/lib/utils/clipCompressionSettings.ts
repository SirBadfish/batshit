/**
 * BL-484 — one shared clip-compression normalizer.
 *
 * `ui_settings` (Settings > Clips) does not exist until a user has saved that panel once:
 * registration (`auth.server.ts`) and `updateUserSettings` (`redis.ts`) never create it. The
 * chat's Clips menu (`ClipsManagerDropdown.svelte`) already treated a missing `ui_settings`
 * as "use the defaults" — it defaults the fetched object to `{}` before reading fields out of
 * it. Desktop Controls (`desktop-controls/+page.svelte`) instead THREW
 * "Clip compression settings are unavailable." for that same missing-object case, so a fresh
 * install's first upload from Desktop Controls failed outright. Both call sites now share this
 * one normalizer, so the defaults can never drift apart again.
 *
 * The defaults themselves are not invented here — they are exactly what
 * `ClipsManagerDropdown.svelte`'s `uploadFilesInternal` already computed for a missing/partial
 * `ui_settings`: compression on, quality 40, max size 1024, force JPEG on.
 *
 * Two functions, two jobs: `normalizeClipCompressionSettings` takes an already-parsed
 * `ui_settings` value and never throws; `clipCompressionSettingsFromResponse` additionally
 * owns the `GET /api/user/settings` response's own missing-vs-failed rule (a FAILED request
 * throws, everything else normalizes) so a page does not have to re-decide that itself.
 */

export interface ClipCompressionSettings {
  compress_images: boolean
  compression_quality: number
  max_image_size: string
  force_jpeg: boolean
}

export const DEFAULT_CLIP_COMPRESSION_SETTINGS: ClipCompressionSettings = {
  compress_images: true,
  compression_quality: 40,
  max_image_size: '1024',
  force_jpeg: true
}

/**
 * Reads clip-compression fields out of a user's `ui_settings` (or `undefined`/`null`/anything
 * else shaped wrong, treated the same as an empty object), falling back to
 * `DEFAULT_CLIP_COMPRESSION_SETTINGS` field by field. Never throws: a MISSING or PARTIAL
 * `ui_settings` is an ordinary, expected shape (every user meets it until they save Settings >
 * Clips once), not a failure. A FAILED settings request is the caller's concern, before this
 * function is ever called.
 */
export function normalizeClipCompressionSettings(uiSettings: unknown): ClipCompressionSettings {
  const settings: Record<string, unknown> =
    uiSettings && typeof uiSettings === 'object' && !Array.isArray(uiSettings)
      ? (uiSettings as Record<string, unknown>)
      : {}

  // The exact rules `ClipsManagerDropdown.svelte`'s `uploadFilesInternal` already used for a
  // missing/partial `ui_settings`: `||` (any falsy value, not only `undefined`, falls back).
  return {
    compress_images: settings.compress_images !== false,
    compression_quality:
      (settings.compression_quality as number | undefined) ||
      DEFAULT_CLIP_COMPRESSION_SETTINGS.compression_quality,
    max_image_size:
      (settings.max_image_size as string | undefined) ||
      DEFAULT_CLIP_COMPRESSION_SETTINGS.max_image_size,
    force_jpeg: settings.force_jpeg !== false
  }
}

/**
 * The `GET /api/user/settings` response handling, shared so every caller (today: Desktop
 * Controls) reads the same rule this module's own tests already prove, instead of each page
 * re-deciding what counts as a failure. Only a FAILED request throws — a non-OK response
 * (the HTTP status rides in the message, so Josh sees WHICH failure), or a payload that is
 * not a real object (an unreadable body, `null` from a `.catch(() => null)`, or any other
 * wrong shape). A well-formed payload with a missing, partial, or wrongly-shaped
 * `settings.ui_settings` is the ordinary case and normalizes to the defaults; it never throws.
 */
export function clipCompressionSettingsFromResponse(
  ok: boolean,
  status: number,
  payload: unknown
): ClipCompressionSettings {
  if (!ok) {
    throw new Error(`Clip upload settings are unavailable (${status}).`)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Clip upload settings are unavailable.')
  }
  const settings = (payload as Record<string, unknown>).settings
  const settingsRecord =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : undefined
  return normalizeClipCompressionSettings(settingsRecord?.ui_settings)
}
