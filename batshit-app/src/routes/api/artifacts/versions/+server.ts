import { error, json, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { ArtifactsService } from '$lib/server/artifacts/artifactsService'

const artifactsService = new ArtifactsService()

/**
 * GET: Retrieve version history or a specific version for an artifact
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) return apiError('Unauthorized', 401)

  const artifactId = url.searchParams.get('artifactId')
  const versionNumber = url.searchParams.get('version')
  if (!artifactId) throw error(400, 'Artifact ID is required')

  try {
    const artifact = await artifactsService.getOwned(artifactId, locals.user.id)
    const versions = artifact.versions || []

    if (versionNumber) {
      const target = versions.find(v => v.version === Number(versionNumber))
      if (!target) throw error(404, 'Version not found')
      return json({ version: target })
    }

    return json({
      artifactId,
      currentVersion: artifact.version || 1,
      versions: [...versions].sort((a, b) => b.version - a.version)
    })
  } catch (err: any) {
    if (err?.status) throw err
    console.error('Error getting versions:', err)
    throw error(500, 'Failed to retrieve versions')
  }
}

/**
 * POST: Create a new version (content change)
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return apiError('Unauthorized', 401)

  try {
    const { artifactId, content, changeNotes } = await request.json()
    if (!artifactId || !content) throw error(400, 'Artifact ID and content are required')

    const updated = await artifactsService.addVersion(artifactId, locals.user.id, content, changeNotes)
    const newVersion = (updated.versions || []).find(v => v.version === updated.version)

    return json({
      success: true,
      version: newVersion,
      message: `Version ${updated.version} created`
    })
  } catch (err: any) {
    if (err?.status) throw err
    console.error('Error creating version:', err)
    throw error(500, 'Failed to create version')
  }
}

/**
 * PUT: Rollback to a previous version (creates a new head version with old content)
 */
export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return apiError('Unauthorized', 401)

  try {
    const { artifactId, targetVersion } = await request.json()
    if (!artifactId || !targetVersion) throw error(400, 'Artifact ID and target version are required')

    const updated = await artifactsService.rollbackToVersion(artifactId, locals.user.id, Number(targetVersion))
    const newVersion = (updated.versions || []).find(v => v.version === updated.version)

    return json({
      success: true,
      action: 'restored',
      newVersion: updated.version,
      version: newVersion,
      message: `Restored to version ${targetVersion} as new version ${updated.version}`
    })
  } catch (err: any) {
    if (err?.status) throw err
    console.error('Error rolling back version:', err)
    throw error(500, 'Failed to rollback version')
  }
}

/**
 * DELETE: Delete a specific version (cannot delete current or only version)
 */
export const DELETE: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) return apiError('Unauthorized', 401)

  const artifactId = url.searchParams.get('artifactId')
  const versionNumber = url.searchParams.get('version')
  if (!artifactId || !versionNumber) throw error(400, 'Artifact ID and version are required')

  try {
    await artifactsService.deleteVersion(artifactId, locals.user.id, Number(versionNumber))
    return json({ success: true, message: `Version ${versionNumber} deleted` })
  } catch (err: any) {
    if (err?.status) throw err
    console.error('Error deleting version:', err)
    throw error(500, 'Failed to delete version')
  }
}
