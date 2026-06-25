import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  findTreeNode,
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
