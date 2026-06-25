import type { ThemeMode } from '$lib/types/theme'

const LAUNCH_THEME: ThemeMode = 'dark'

type Subscriber = (value: ThemeMode) => void
type DeferredThemePreference = ThemeMode | 'light' | 'system'

const subscribers = new Set<Subscriber>()
let currentTheme: ThemeMode = LAUNCH_THEME

function notify() {
  subscribers.forEach((run) => run(currentTheme))
}

function applyLaunchTheme() {
  currentTheme = LAUNCH_THEME

  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('dark')
    document.documentElement.dataset.theme = LAUNCH_THEME
    document.documentElement.style.colorScheme = LAUNCH_THEME
  }

  if (typeof window !== 'undefined') {
    window.localStorage?.setItem('theme', LAUNCH_THEME)
  }
}

export const themeStore = {
  subscribe(run: Subscriber) {
    applyLaunchTheme()
    run(currentTheme)
    subscribers.add(run)

    return () => {
      subscribers.delete(run)
    }
  }
}

export function setThemePreference(theme: DeferredThemePreference = LAUNCH_THEME) {
  if (theme !== LAUNCH_THEME) {
    console.warn('[theme] Batshit launch builds only support the dark theme.')
  }

  applyLaunchTheme()
  notify()
}
