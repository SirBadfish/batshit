import { resolveArtifactSourceKind } from './artifactSourceBadge'

export const DEFAULT_ARTIFACT_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-downloads'

export const EXTERNAL_EMBED_IFRAME_SANDBOX = [
  DEFAULT_ARTIFACT_IFRAME_SANDBOX,
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-top-navigation-by-user-activation'
].join(' ')

export function getArtifactIframeSandbox(artifact: unknown): string {
  const sourceKind = resolveArtifactSourceKind(artifact)
  if (sourceKind === 'huggingface' || sourceKind === 'gradio') {
    return EXTERNAL_EMBED_IFRAME_SANDBOX
  }
  return DEFAULT_ARTIFACT_IFRAME_SANDBOX
}
