import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  deleteProject,
  findTreeNode,
  getCurrentProject,
  getCurrentProjectId,
  getProjects,
  getSelectableProjects,
  hasProjectBeenLoaded,
  loadDefaultProjectPath,
  updateProject,
  setDefaultProjectPath,
  getExpandedDirectoryPaths,
  getFileTree,
  getFlatFileList,
  getMentionIndexError,
  getMentionIndexStatus,
  isMentionIndexTruncated,
  setCurrentProject,
  setDirectoryChildren,
  setDirectoryError,
  setDirectoryExpanded,
  setDirectoryLoading,
  setFileTreeRoot,
  setMentionIndex,
  setMentionIndexError,
  setMentionIndexLoading,
  setProjects,
  type FileTreeNode,
  type Project
} from './projects.svelte'
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '$lib/projects/defaultProject'

function project(id: string): Project {
  return {
    id,
    user_id: 'user-1',
    name: id,
    root_path: `/workspace/${id}`,
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: '2026-06-09T00:00:00.000Z'
  }
}

function dir(path: string): FileTreeNode {
  return {
    name: path.split('/').pop() ?? path,
    path,
    type: 'directory',
    isExpanded: false,
    childrenLoaded: false
  }
}

function file(path: string): FileTreeNode {
  return {
    name: path.split('/').pop() ?? path,
    path,
    type: 'file',
    isExpanded: false
  }
}

describe('projects store lazy file tree', () => {
  beforeEach(() => {
    localStorage.clear()
    setProjects([project('project-a'), project('project-b')])
    setCurrentProject('project-a')
    setFileTreeRoot([dir('src'), file('readme.md')])
  })

  afterEach(() => {
    setProjects([])
    setCurrentProject(null)
    localStorage.clear()
  })

  it('caches fetched children and keeps them through collapse/expand', () => {
    setDirectoryLoading('src', true)
    expect(findTreeNode('src')).toMatchObject({
      childrenLoading: true,
      isExpanded: true,
      childrenError: null
    })

    setDirectoryChildren('src', [dir('src/lib'), file('src/app.ts')])
    expect(findTreeNode('src')).toMatchObject({
      childrenLoaded: true,
      childrenLoading: false,
      isExpanded: true
    })
    expect(findTreeNode('src/lib')).toMatchObject({ type: 'directory', childrenLoaded: false })

    // Collapse keeps the cached children (no refetch needed on re-expand).
    setDirectoryExpanded('src', false)
    expect(findTreeNode('src')).toMatchObject({ isExpanded: false, childrenLoaded: true })
    expect(findTreeNode('src')?.children).toHaveLength(2)

    setDirectoryExpanded('src', true)
    expect(findTreeNode('src')).toMatchObject({ isExpanded: true, childrenLoaded: true })
  })

  it('records per-directory errors and clears them on the next load attempt', () => {
    setDirectoryError('src', 'Batshit-Server is not responding (connection failed)')
    expect(findTreeNode('src')).toMatchObject({
      childrenError: 'Batshit-Server is not responding (connection failed)',
      childrenLoading: false,
      isExpanded: true
    })

    setDirectoryLoading('src', true)
    expect(findTreeNode('src')).toMatchObject({ childrenError: null, childrenLoading: true })
  })

  it('lists expanded directory paths for refresh restoration', () => {
    setDirectoryChildren('src', [dir('src/lib')])
    setDirectoryChildren('src/lib', [file('src/lib/a.ts')])

    expect(getExpandedDirectoryPaths()).toEqual(['src', 'src/lib'])

    setDirectoryExpanded('src/lib', false)
    expect(getExpandedDirectoryPaths()).toEqual(['src'])
  })

  it('hydrates the mention index without touching the tree', () => {
    setMentionIndexLoading()
    expect(getMentionIndexStatus()).toBe('loading')

    setMentionIndex(
      [{ name: 'deep.ts', path: 'src/lib/deep.ts', type: 'file', extension: 'ts' }],
      true
    )
    expect(getMentionIndexStatus()).toBe('ready')
    expect(isMentionIndexTruncated()).toBe(true)
    expect(getFlatFileList()).toHaveLength(1)
    // Tree stays the lazily loaded root level.
    expect(getFileTree().map((node) => node.path)).toEqual(['src', 'readme.md'])
  })

  it('keeps the last good mention index when hydration fails', () => {
    setMentionIndex([{ name: 'a.ts', path: 'a.ts', type: 'file', extension: 'ts' }])

    setMentionIndexLoading()
    setMentionIndexError('File tree request timed out after 45s')

    expect(getMentionIndexStatus()).toBe('error')
    expect(getMentionIndexError()).toBe('File tree request timed out after 45s')
    expect(getFlatFileList()).toHaveLength(1)
  })

  it('clears tree, cache, and mention index state when switching projects', () => {
    setDirectoryChildren('src', [dir('src/lib')])
    setMentionIndex([{ name: 'a.ts', path: 'a.ts', type: 'file', extension: 'ts' }])

    setCurrentProject('project-b')

    expect(getFileTree()).toEqual([])
    expect(getFlatFileList()).toEqual([])
    expect(getMentionIndexStatus()).toBe('idle')
    expect(getMentionIndexError()).toBeNull()
    expect(isMentionIndexTruncated()).toBe(false)
  })
})

// BL-2373: the Default Project Path is a real Project in the browser, built from the setting.
describe('projects store Default Project', () => {
  beforeEach(() => {
    setProjects([project('project-a'), project('project-b')])
    setCurrentProject(null)
  })

  afterEach(() => {
    setDefaultProjectPath(null)
    setProjects([])
    setCurrentProject(null)
  })

  it('lists the Default Project first when a Default Project Path is saved, never among saved records', () => {
    expect(getSelectableProjects().map((entry) => entry.id)).toEqual(['project-a', 'project-b'])

    setDefaultProjectPath('  /Users/tester/Workspace  ')
    const [first, ...rest] = getSelectableProjects()
    expect(first).toMatchObject({
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      root_path: '/Users/tester/Workspace',
      is_default_project: true
    })
    expect(first.custom_exclusions).toEqual(expect.arrayContaining(['**/.env', '**/node_modules/**']))
    expect(rest.map((entry) => entry.id)).toEqual(['project-a', 'project-b'])
    expect(getProjects().map((entry) => entry.id)).toEqual(['project-a', 'project-b'])
  })

  it('a blank or relative path means no Default Project', () => {
    setDefaultProjectPath('   ')
    expect(getSelectableProjects()).toHaveLength(2)
    setDefaultProjectPath('relative/path')
    expect(getSelectableProjects()).toHaveLength(2)
  })

  it('a changed path clears the shown tree of the old folder', () => {
    setDefaultProjectPath('/Users/tester/Workspace')
    setCurrentProject(DEFAULT_PROJECT_ID)
    setFileTreeRoot([dir('old')])
    setMentionIndex([{ name: 'old.ts', path: 'old/old.ts', type: 'file', extension: 'ts' }])

    setDefaultProjectPath('/Users/tester/Workspace')
    expect(getFileTree()).toHaveLength(1)

    setDefaultProjectPath('/Users/tester/Other')
    expect(getCurrentProject()?.root_path).toBe('/Users/tester/Other')
    expect(getFileTree()).toEqual([])
    expect(getFlatFileList()).toEqual([])
  })

  // Review nit: ChatInput's mount read can land after a newer save from Settings.
  it('a read that lands after a newer write of the path is not installed', async () => {
    let answer!: (value: { default_workspace_path: string }) => void
    const read = loadDefaultProjectPath(() => new Promise((resolve) => { answer = resolve }))
    setDefaultProjectPath('/Users/tester/Saved-Later')
    answer({ default_workspace_path: '/Users/tester/Read-Earlier' })
    expect(await read).toBe(false)
    expect(getSelectableProjects()[0]?.root_path).toBe('/Users/tester/Saved-Later')

    expect(await loadDefaultProjectPath(async () => ({ default_workspace_path: '/Users/tester/Fresh' }))).toBe(true)
    expect(getSelectableProjects()[0]?.root_path).toBe('/Users/tester/Fresh')
  })

  it('deleting the current project selects nothing, not the next saved project', () => {
    setCurrentProject('project-a')
    deleteProject('project-a')
    expect(getCurrentProjectId()).toBeNull()
  })
})

// BL-2391: a saved project keeps its id when its Root Path changes; its old folder's tree must go.
describe('projects store: a shown project whose folder changed', () => {
  beforeEach(() => {
    setProjects([project('project-a'), project('project-b')])
    setCurrentProject('project-a')
    setFileTreeRoot([dir('old')])
    setMentionIndex([{ name: 'old.ts', path: 'old/old.ts', type: 'file', extension: 'ts' }])
  })

  afterEach(() => {
    setProjects([])
    setCurrentProject(null)
  })

  it('a saved Root Path from a save answer clears the old tree and mention index', () => {
    updateProject('project-a', { root_path: '/workspace/project-a-moved' })
    expect(getCurrentProject()?.root_path).toBe('/workspace/project-a-moved')
    expect(getFileTree()).toEqual([])
    expect(getFlatFileList()).toEqual([])
    expect(hasProjectBeenLoaded('project-a')).toBe(false)
  })

  it('a list read that brings the new Root Path clears it too', () => {
    setProjects([{ ...project('project-a'), root_path: '/workspace/project-a-moved' }, project('project-b')])
    expect(getFileTree()).toEqual([])
    expect(getFlatFileList()).toEqual([])
  })

  it('a change that keeps the folder, or of another project, keeps the tree', () => {
    updateProject('project-a', { name: 'Renamed', custom_exclusions: ['**/tmp/**'] })
    updateProject('project-b', { root_path: '/workspace/b-moved' })
    expect(getFileTree()).toHaveLength(1)
    expect(getFlatFileList()).toHaveLength(1)
  })
})

// BL-2384 round 6 (reviewer A): a list read replaces the store's copies whatever their stamps.
// A backup restore rewrites records without a newer `updated_at`; another open tab must take the
// restored copy (its root path is what chat sends) at its next list read, not keep its old one.
describe('projects store: list reads replace held copies', () => {
  afterEach(() => {
    setProjects([])
  })

  it('a restored list with an older stamp than the held copy replaces it', () => {
    setProjects([{ ...project('project-a'), root_path: '/workspace/before-restore', updated_at: '2026-10-27T12:00:05.000Z' }])
    setProjects([{ ...project('project-a'), root_path: '/workspace/restored', updated_at: '2026-10-20T09:00:00.000Z' }])
    expect(getProjects().map((entry) => entry.root_path)).toEqual(['/workspace/restored'])
  })
})
