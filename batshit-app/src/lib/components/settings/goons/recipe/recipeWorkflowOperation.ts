import type { RecipeWorkflowProgress } from '$lib/goons/recipe'

export function recipeWorkflowProgressPhase(progress: RecipeWorkflowProgress | null): string | null {
  switch (progress) {
    case 'starting':
      return 'Starting the Goon update'
    case 'server-building':
      return 'Building and checking the Goon'
    case 'settling-server-build':
      return 'Checking the unfinished Goon update'
    case 'fetching-source':
      return 'Loading the source package'
    case 'validating-source':
      return 'Validating the source package'
    case 'evaluating-recipe':
      return 'Planning the changes'
    case 'rewriting-model':
      return 'Baking the Goon model'
    case 'auditing-model':
      return 'Checking the baked model'
    case 'packaging-live-goon':
      return 'Packaging the finished Goon'
    case 'uploading-candidate':
      return 'Uploading the finished Goon'
    case 'registering-candidate':
      return 'Registering the finished Goon'
    case 'verifying-output':
      return 'Verifying the output'
    case 'staging-candidate':
      return 'Preparing the final preview'
    case 'previewing-candidate':
      return 'Loading the final preview'
    case 'committing':
      return 'Saving the Goon'
    case 'complete':
      return 'Finishing the Goon update'
    default:
      return null
  }
}

export function recipeBuildCanCancel(
  progress: RecipeWorkflowProgress | null,
  hasAbortController: boolean,
  cancelPending: boolean
): boolean {
  return hasAbortController && !cancelPending && progress !== 'committing' &&
    progress !== 'complete' && progress !== 'settling-server-build'
}
