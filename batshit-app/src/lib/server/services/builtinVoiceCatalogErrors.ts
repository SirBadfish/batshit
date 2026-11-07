export class VoiceCatalogCompatibilityError extends Error {
  readonly status = 412
  readonly code = 'voice_model_compatibility_unavailable'
  readonly setupHint = 'Refresh the model list in Voice Settings. Your saved choice is kept; choose an available model deliberately.'
}
