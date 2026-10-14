export type VoiceDockOwnerPorts = {
  visible(): boolean
  /** Use the page's current desktopModeActive, including its existing entering transition. */
  desktopActive(): boolean
  /** The existing human Dock toggle owns ordinary visibility/persistence and Desktop exit. */
  toggleDockOrExitDesktop(): void
}

/**
 * Voice's existing person-authorized projection differs from P1's ordinary-Dock-only executor:
 * opening in Desktop Mode is a no-op; closing asks the existing owner to leave Desktop Mode.
 * Never use this as a safe developer/agent exception to performDockAction's Desktop refusal.
 * owner_requested records dispatch only, not saved state, native closure or mounted completion.
 */
export function dispatchVoiceDockQuickAction(
  id: unknown,
  ports: VoiceDockOwnerPorts
): 'owner_requested' | 'no_op' | 'unsupported_action' {
  if (id === 'open_goon_dock') {
    if (ports.visible() || ports.desktopActive()) return 'no_op'
  } else if (id === 'close_goon_dock') {
    if (!ports.visible() && !ports.desktopActive()) return 'no_op'
  } else return 'unsupported_action'
  ports.toggleDockOrExitDesktop()
  return 'owner_requested'
}
