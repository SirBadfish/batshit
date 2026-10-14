// BL-485: no test in this suite previously mounted a component that imports `$app/navigation`,
// so this alias target never existed. `.svelte-kit/runtime/app` (what `vitest.config.ts`'s
// fallback `'$app'` alias points at) is not something `vite dev`/`build` writes to disk for
// `$app/navigation` either — SvelteKit resolves it as a virtual module — so that fallback can
// never satisfy this import. Mirrors the sibling `$app/environment` / `$app/state` /
// `$app/stores` mocks: a plain stub, aliased explicitly in `vitest.config.ts`. Only `goto` and
// `invalidate` are imported from `$app/navigation` anywhere in `src` today; add more here (and
// keep them spy-able with `vi.fn()`) if a future component needs another export.
import { vi } from 'vitest'

export const goto = vi.fn(async () => {})
export const invalidate = vi.fn(async () => {})
export const invalidateAll = vi.fn(async () => {})
export const preloadData = vi.fn(async () => {})
export const preloadCode = vi.fn(async () => {})
export const pushState = vi.fn(() => {})
export const replaceState = vi.fn(() => {})
export const beforeNavigate = vi.fn(() => {})
export const afterNavigate = vi.fn(() => {})
export const onNavigate = vi.fn(() => {})
export const disableScrollHandling = vi.fn(() => {})
