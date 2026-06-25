import { stat } from 'node:fs/promises'
import path from 'node:path'
import { env } from '$env/dynamic/private'

type RuntimeEnv = Record<string, string | undefined>

export class ProjectPathValidationError extends Error {
	status = 400
}

function isContainerized(runtimeEnv: RuntimeEnv): boolean {
	return runtimeEnv.BATSHIT_CONTAINERIZED === '1' || runtimeEnv.BATSHIT_RUNTIME_ENV === 'docker'
}

function isWindowsAbsolutePath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(value)
}

function normalizeForComparison(value: string): string {
	const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
	return normalized || '/'
}

function isPathWithin(candidate: string, base: string): boolean {
	const normalizedCandidate = normalizeForComparison(candidate)
	const normalizedBase = normalizeForComparison(base)
	return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}/`)
}

function joinContainerPath(containerRoot: string, relativePath: string): string {
	if (!relativePath || relativePath === '.') return normalizeForComparison(containerRoot)
	return path.posix.join(normalizeForComparison(containerRoot), relativePath.replace(/\\/g, '/'))
}

function getDockerWorkspacePath(runtimeEnv: RuntimeEnv): string {
	return runtimeEnv.BATSHIT_WORKSPACE_CONTAINER_PATH?.trim()
		|| runtimeEnv.BATSHIT_CODEX_WORKDIR?.trim()
		|| '/workspace'
}

function getHostWorkspaceMount(runtimeEnv: RuntimeEnv): string | null {
	const mount = runtimeEnv.BATSHIT_WORKSPACE_MOUNT?.trim()
	if (!mount) return null
	return mount.startsWith('/') || isWindowsAbsolutePath(mount) ? mount : null
}

export function resolveProjectRootPathForRuntime(rawPath: string, runtimeEnv: RuntimeEnv = env): string {
	const requestedPath = rawPath.trim()
	if (!isContainerized(runtimeEnv)) return requestedPath

	const hostWorkspaceMount = getHostWorkspaceMount(runtimeEnv)
	if (!hostWorkspaceMount || !isPathWithin(requestedPath, hostWorkspaceMount)) {
		return requestedPath
	}

	const normalizedMount = normalizeForComparison(hostWorkspaceMount)
	const normalizedRequested = normalizeForComparison(requestedPath)
	const relativePath = normalizedRequested === normalizedMount
		? ''
		: normalizedRequested.slice(normalizedMount.length).replace(/^\/+/, '')

	return joinContainerPath(getDockerWorkspacePath(runtimeEnv), relativePath)
}

function createValidationError(message: string): ProjectPathValidationError {
	return new ProjectPathValidationError(message)
}

function buildMissingPathMessage(requestedPath: string, resolvedPath: string, runtimeEnv: RuntimeEnv): string {
	if (!isContainerized(runtimeEnv)) {
		return `Project root path "${requestedPath}" does not exist or Batshit cannot access it.`
	}

	if (requestedPath !== resolvedPath) {
		return `Docker mapped "${requestedPath}" to "${resolvedPath}", but Batshit cannot access "${resolvedPath}" inside the container. Check BATSHIT_WORKSPACE_MOUNT in .env.docker, then recreate the Docker containers.`
	}

	const workspacePath = getDockerWorkspacePath(runtimeEnv)
	return `Batshit is running in Docker and cannot access "${requestedPath}". Use "${workspacePath}" for the mounted workspace, or set BATSHIT_WORKSPACE_MOUNT in .env.docker to the host folder and recreate the Docker containers.`
}

export async function validateProjectRootPath(rawPath: unknown, runtimeEnv: RuntimeEnv = env): Promise<string> {
	if (typeof rawPath !== 'string' || !rawPath.trim()) {
		throw createValidationError('Project root path is required.')
	}

	const requestedPath = rawPath.trim()
	if (!requestedPath.startsWith('/') && !isWindowsAbsolutePath(requestedPath)) {
		throw createValidationError('Project root path must be an absolute path.')
	}

	const resolvedPath = resolveProjectRootPathForRuntime(requestedPath, runtimeEnv)
	if (isWindowsAbsolutePath(resolvedPath)) {
		throw createValidationError(buildMissingPathMessage(requestedPath, resolvedPath, runtimeEnv))
	}

	let stats
	try {
		stats = await stat(resolvedPath)
	} catch {
		throw createValidationError(buildMissingPathMessage(requestedPath, resolvedPath, runtimeEnv))
	}

	if (!stats.isDirectory()) {
		throw createValidationError(`Project root path "${resolvedPath}" is not a directory.`)
	}

	return resolvedPath
}
