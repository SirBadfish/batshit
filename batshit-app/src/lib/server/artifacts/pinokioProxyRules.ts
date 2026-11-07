/**
 * SA-072 P2 (DL-10): which app paths the Pinokio proxy forwards, by the artifact's kind.
 */

import type { PinokioArtifactKind } from '$lib/artifacts/pinokioArtifact'
import { isAllowedComfyPath } from './comfyuiProxyRules'

const GRADIO_ROOTS = ['config', 'info', 'upload', 'queue/join', 'queue/data']
const GRADIO_PREFIXES = ['gradio_api/', 'call/', 'file=', 'run/']

/** Which app paths a kind of Pinokio app artifact may reach; `null` means allowed. */
export function pinokioProxyPathProblem(kind: PinokioArtifactKind, requestPath: string): string | null {
  if (!requestPath) return 'A path on the app is required, for example /api/artifacts/pinokio/system_stats?artifactId=…'
  let decoded: string
  try { decoded = decodeURIComponent(requestPath) } catch { return 'The app path contains invalid escaping.' }
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('://') || /[\u0000-\u001f\u007f]/.test(decoded) || decoded.split('/').some((segment) => segment === '..' || segment === '.')) {
    return 'The app path may not contain "." or ".." segments.'
  }
  const lower = requestPath.toLowerCase()
  if (kind === 'comfyui') {
    return isAllowedComfyPath(requestPath)
      ? null
      : 'Unsupported ComfyUI path. Allowed roots: prompt, history, view, models, userdata, object_info, system_stats, queue, interrupt, upload/image.'
  }
  if (kind === 'gradio') {
    const allowed = GRADIO_ROOTS.includes(lower) || GRADIO_PREFIXES.some((prefix) => lower.startsWith(prefix))
    return allowed ? null : 'Unsupported Gradio path. Allowed: gradio_api/…, and the Gradio 4 roots config, info, upload, call/…, file=…, queue/…, run/….'
  }
  return null
}
