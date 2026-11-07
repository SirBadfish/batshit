import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  children: [] as Array<{ root: string; resolve: (value: any) => void }>,
  walks: [] as Array<{ root: string; resolve: (value: any) => void }>
}))

vi.mock('$lib/services/fileTree', () => ({
  FILE_TREE_MAX_ENTRIES: 50_000,
  FileTreeService: {
    loadDirectoryChildren: vi.fn(
      (root: string) => new Promise((resolve) => service.children.push({ root, resolve }))
    ),
    loadFileTree: vi.fn((root: string) => new Promise((resolve) => service.walks.push({ root, resolve })))
  }
}))
vi.mock('svelte-sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }))

import * as projectStore from '$lib/stores/projects.svelte'
import { DEFAULT_PROJECT_ID } from './defaultProject'
import { BROAD_DEFAULT_PROJECT_INDEX_NOTE, hydrateMentionIndex, isBroadFolder, loadProjectTree } from './fileTreeActions'

function entries(prefix: string) {
  return [{ name: `${prefix}.md`, path: `${prefix}.md`, type: 'file' as const }]
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  service.children.length = 0
  service.walks.length = 0
  projectStore.setProjects([])
  projectStore.setDefaultProjectPath('/fixture/folder-a')
  projectStore.setCurrentProject(DEFAULT_PROJECT_ID)
})

afterEach(() => {
  projectStore.setCurrentProject(null)
  projectStore.setDefaultProjectPath(null)
})

/**
 * BL-2373 review A1: the Default Project keeps its id when the Default Project Path changes, so
 * an old folder's answer must be recognized by its folder, not only by the project id.
 */
describe('a Default Project load for an old folder that lands after the folder changed', () => {
  it('a root load of folder A that lands after folder B is saved never shows A', async () => {
    const load = loadProjectTree(projectStore.getDefaultProject()!)
    expect(service.children[0]?.root).toBe('/fixture/folder-a')

    projectStore.setDefaultProjectPath('/fixture/folder-b')
    service.children[0].resolve({ children: entries('from-a'), truncated: false })
    await load
    await settle()

    expect(projectStore.getFileTree()).toEqual([])
    expect(projectStore.hasProjectBeenLoaded(DEFAULT_PROJECT_ID)).toBe(false)
    expect(service.walks).toHaveLength(0)
  })

  it('a mention walk of folder A that lands after folder B is saved never indexes A', async () => {
    const walk = hydrateMentionIndex(projectStore.getDefaultProject()!)
    expect(service.walks[0]?.root).toBe('/fixture/folder-a')

    projectStore.setDefaultProjectPath('/fixture/folder-b')
    service.walks[0].resolve({ flat: entries('from-a'), truncated: false })
    await walk

    expect(projectStore.getFlatFileList()).toEqual([])
    expect(projectStore.getMentionIndexStatus()).not.toBe('ready')
  })

  it('a load of the current folder still lands', async () => {
    const load = loadProjectTree(projectStore.getDefaultProject()!)
    service.children[0].resolve({ children: entries('from-a'), truncated: false })
    await load
    expect(projectStore.getFileTree().map((node) => node.path)).toEqual(['from-a.md'])
  })
})

/**
 * Review A4: the Default Project's background @ mention walk never starts by itself over a whole
 * disk or a home folder; its top level still lists.
 */
describe('the Default Project never walks a whole disk or home folder by itself', () => {
  it('names the broad folders', () => {
    const broad = [
      '/', '/Users', '/Users/tester', '/Users/tester/', '/home/tester', '/Volumes/Data', '/root', '/var/root',
      // Round 3: case, `..`, repeated and trailing slashes, the macOS data volume, /private, /mnt, /media.
      '/USERS/Tester', '/users//tester///', '/Users/tester/batshit/..', '/Users/tester/./', '/Users/tester/batshit/../..',
      '/System/Volumes/Data', '/System/Volumes/Data/Users/tester', '/system/volumes/data/',
      '/private', '/private/tmp', '/private/var/root', '/mnt', '/mnt/c', '/media', '/media/usb'
    ]
    for (const path of broad) expect({ path, broad: isBroadFolder(path) }).toEqual({ path, broad: true })
    const narrow = [
      '/Users/tester/Workspace', '/Users/tester/batshit', '/USERS/tester/batshit', '/home/tester/code', '/workspace',
      '/Volumes/Data/projects', '/opt/app', '/System/Volumes/Data/Users/tester/batshit', '/private/tmp/project',
      '/mnt/c/code', '/media/usb/photos', '/Users/tester/../tester/batshit'
    ]
    for (const path of narrow) expect({ path, broad: isBroadFolder(path) }).toEqual({ path, broad: false })
  })

  it('lists the top level of a home-folder Default Project but starts no walk', async () => {
    projectStore.setDefaultProjectPath('/Users/tester')
    const load = loadProjectTree(projectStore.getDefaultProject()!)
    service.children[0].resolve({ children: entries('top'), truncated: false })
    await load
    await settle()

    expect(projectStore.getFileTree().map((node) => node.path)).toEqual(['top.md'])
    expect(service.walks).toHaveLength(0)
    expect(projectStore.getMentionIndexStatus()).toBe('error')
    expect(projectStore.getMentionIndexError()).toBe(BROAD_DEFAULT_PROJECT_INDEX_NOTE)
  })

  it('a saved project keeps its walk, whatever its folder', async () => {
    projectStore.setProjects([
      { id: 'project_home', user_id: 'josh', name: 'Home', root_path: '/Users/tester', created_at: '', updated_at: '' }
    ])
    projectStore.setCurrentProject('project_home')
    const load = loadProjectTree(projectStore.getCurrentProject()!)
    service.children[0].resolve({ children: entries('top'), truncated: false })
    await load
    expect(service.walks).toHaveLength(1)
  })
})
