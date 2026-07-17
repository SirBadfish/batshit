import { json } from '@sveltejs/kit'
import { GoonRecipeLifecycleError } from './goonRecipeLifecycleService.server'
import { RecipeRepositoryError } from './goonRecipeRepository.server'

export function recipeRouteError(error: unknown) {
  if (error instanceof GoonRecipeLifecycleError || error instanceof RecipeRepositoryError) {
    return json({ error: error.message, code: error.code }, { status: error.status })
  }
  console.error('[Recipe lifecycle] Unexpected route failure:', error)
  return json(
    { error: 'Recipe lifecycle failed because stored or submitted evidence was invalid.' },
    { status: 500 }
  )
}

export function authenticatedRecipeOwner(userId: string | undefined, goonId: string | undefined) {
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 })
  if (!goonId) return json({ error: 'Goon id is required' }, { status: 400 })
  return { userId, goonId }
}
