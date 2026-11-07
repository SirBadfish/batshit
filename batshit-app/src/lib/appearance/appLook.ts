// The app's look (Josh, 2026-10-29): Cave, the Bat Cave look of batshit.ai, is the default;
// Minimal is the same palette and carving with no textures or motion; OG is the look the app
// had before, kept for now so it can be compared. Saved in the user settings as
// `appearance_settings.look`, painted on <html data-look> by the server before the first frame
// (hooks.server.ts) and kept current in the browser by the root layout. The looks themselves
// are `src/lib/styles/themes/looks.css`; OG is the base stylesheet with no look rules on top.

export const APP_LOOKS = ['cave', 'minimal', 'og'] as const
export type AppLook = (typeof APP_LOOKS)[number]
export const DEFAULT_APP_LOOK: AppLook = 'cave'

export interface AppearanceSettings {
  look: AppLook
}

export const isAppLook = (value: unknown): value is AppLook =>
  typeof value === 'string' && (APP_LOOKS as readonly string[]).includes(value)

/** The look a settings record asks for; a record without one (or none at all) gets the default. */
export function resolveAppLook(settings: unknown): AppLook {
  const look = (settings as { appearance_settings?: { look?: unknown } } | null | undefined)?.appearance_settings?.look
  return isAppLook(look) ? look : DEFAULT_APP_LOOK
}

/** The only shape the settings route stores. Anything else is refused, never saved and quietly read as the default. */
export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('appearance_settings must be an object with a look.'), { status: 400 })
  }
  const extra = Object.keys(value).filter((key) => key !== 'look')
  if (extra.length) {
    throw Object.assign(new Error(`appearance_settings has unknown fields: ${extra.join(', ')}.`), { status: 400 })
  }
  const look = (value as { look?: unknown }).look
  if (!isAppLook(look)) {
    throw Object.assign(new Error(`appearance_settings.look must be one of ${APP_LOOKS.join(', ')}.`), { status: 400 })
  }
  return { look }
}

/** Paint a look on the document. The stylesheet keys every look rule on this attribute. */
export function applyAppLook(look: AppLook, root: HTMLElement = document.documentElement) {
  if (root.dataset.look !== look) root.dataset.look = look
}
