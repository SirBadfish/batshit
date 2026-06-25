import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { RedisService } from '$lib/server/redis'
import { normalizeProjectExclusions } from '$lib/projects/exclusions'
import { cloneIconRef, isIconRef, type IconRef } from '$lib/icons/iconTypes'
import { validateProjectRootPath } from '$lib/server/services/projectPathValidation'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'

function normalizeProjectIconRef(value: unknown): IconRef | null {
	if (value === null || value === undefined) return null
	if (!isIconRef(value)) {
		throw Object.assign(new Error('icon_ref must be a valid icon picker reference'), { status: 400 })
	}
	return cloneIconRef(value)
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Not authenticated' }, { status: 401 })
	}
	
	try {
		const redis = new RedisService()
		const projects = (await redis.getProjects(locals.user.id)).map((project) => ({
			...project,
			custom_exclusions: normalizeProjectExclusions(project.custom_exclusions ?? [])
		}))
		
		return json({ projects })
	} catch (error) {
		console.error('Error loading projects:', error)
		return json({ 
			error: error instanceof Error ? error.message : 'Failed to load projects' 
		}, { status: 500 })
	}
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Not authenticated' }, { status: 401 })
	}
	
	try {
		const projectData = await request.json()
		const redis = new RedisService()
		const rootPath = await validateProjectRootPath(projectData.root_path)
		
		const newProject = {
			...projectData,
			root_path: rootPath,
			custom_exclusions: normalizeProjectExclusions(projectData.custom_exclusions ?? []),
			icon_ref: normalizeProjectIconRef(projectData.icon_ref),
			id: `project_${Date.now()}`,
			user_id: locals.user.id,
			created_at: new Date().toISOString()
		}
		
		await redis.saveProject(newProject)
		
		return json({ project: newProject })
	} catch (error) {
		console.error('Error creating project:', error)
		return json({ 
			error: error instanceof Error ? error.message : 'Failed to create project' 
		}, { status: (error as any)?.status ?? 500 })
	}
}

export const PUT: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Not authenticated' }, { status: 401 })
	}
	
	try {
		const { projectId, updates } = await request.json()
		const redis = new RedisService()
		const rootPath = Object.prototype.hasOwnProperty.call(updates, 'root_path')
			? await validateProjectRootPath(updates.root_path)
			: undefined
		
		const normalizedUpdates = {
			...updates,
			...(rootPath !== undefined ? { root_path: rootPath } : {}),
			...(Object.prototype.hasOwnProperty.call(updates, 'custom_exclusions')
				? { custom_exclusions: normalizeProjectExclusions(updates.custom_exclusions ?? []) }
				: {}),
			...(Object.prototype.hasOwnProperty.call(updates, 'icon_ref')
				? { icon_ref: normalizeProjectIconRef(updates.icon_ref) }
				: {})
		}
		const updated = await redis.updateProject(projectId, locals.user.id, normalizedUpdates)
		try {
			await syncAgentCodexProfiles(locals.user.id)
		} catch (error) {
			console.warn('[Projects API] Failed to sync Codex profiles after project update:', error)
		}
		
		return json({
			project: {
				...updated,
				custom_exclusions: normalizeProjectExclusions(updated.custom_exclusions ?? [])
			}
		})
	} catch (error) {
		console.error('Error updating project:', error)
		return json({ 
			error: error instanceof Error ? error.message : 'Failed to update project' 
		}, { status: (error as any)?.status ?? 500 })
	}
}

export const DELETE: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Not authenticated' }, { status: 401 })
	}
	
	try {
		const { projectId } = await request.json()
		const redis = new RedisService()
		
		await redis.deleteProject(projectId, locals.user.id)
		try {
			await syncAgentCodexProfiles(locals.user.id)
		} catch (error) {
			console.warn('[Projects API] Failed to sync Codex profiles after project delete:', error)
		}
		
		return json({ success: true })
	} catch (error) {
		console.error('Error deleting project:', error)
		return json({ 
			error: error instanceof Error ? error.message : 'Failed to delete project' 
		}, { status: 500 })
	}
}
