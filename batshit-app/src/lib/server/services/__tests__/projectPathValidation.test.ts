import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	resolveProjectRootPathForRuntime,
	validateProjectRootPath
} from '../projectPathValidation'

const fixtureRoots: string[] = []

async function tempDir(prefix: string): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), prefix))
	fixtureRoots.push(root)
	return root
}

describe('projectPathValidation', () => {
	afterEach(async () => {
		await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
	})

	it('accepts an existing native directory', async () => {
		const root = await tempDir('batshit-project-native-')

		await expect(validateProjectRootPath(root, {})).resolves.toBe(root)
	})

	it('maps a configured Docker host workspace path into /workspace', async () => {
		const hostRoot = '/Users/example/batshit'
		const containerRoot = await tempDir('batshit-project-container-')
		await mkdir(path.join(containerRoot, 'nested'))

		const env = {
			BATSHIT_CONTAINERIZED: '1',
			BATSHIT_WORKSPACE_MOUNT: hostRoot,
			BATSHIT_WORKSPACE_CONTAINER_PATH: containerRoot
		}

		expect(resolveProjectRootPathForRuntime(`${hostRoot}/nested`, env)).toBe(
			path.join(containerRoot, 'nested')
		)
		await expect(validateProjectRootPath(`${hostRoot}/nested`, env)).resolves.toBe(
			path.join(containerRoot, 'nested')
		)
	})

	it('rejects host paths that are not visible inside Docker', async () => {
		const env = {
			BATSHIT_CONTAINERIZED: '1',
			BATSHIT_CODEX_WORKDIR: '/workspace'
		}

		await expect(validateProjectRootPath('/Users/example/missing-project', env)).rejects.toThrow(
			'Batshit is running in Docker'
		)
	})

	it('rejects files instead of directories', async () => {
		const root = await tempDir('batshit-project-file-')
		const filePath = path.join(root, 'not-a-dir.txt')
		await writeFile(filePath, 'not a directory')

		await expect(validateProjectRootPath(filePath, {})).rejects.toThrow('is not a directory')
	})
})
