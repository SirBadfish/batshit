import { env } from '$env/dynamic/private'

/**
 * The internal Dev panel exists only where `BATSHIT_ENABLE_INTERNAL_DEV_PANEL`
 * is `1` and its secret is set (32+ characters). The one gate: the layout
 * load and every server route that honors a Dev panel setting ask this.
 */
export function isInternalDevPanelEnabled(): boolean {
  const enabled = env.BATSHIT_ENABLE_INTERNAL_DEV_PANEL === '1'
  const secret = env.BATSHIT_INTERNAL_DEV_PANEL_SECRET?.trim() ?? ''
  return enabled && secret.length >= 32
}
