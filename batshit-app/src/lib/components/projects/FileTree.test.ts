import { fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileTree from './FileTree.svelte'
import * as projectStore from '$lib/stores/projects.svelte'

function file(path: string): projectStore.FileTreeNode {
  return { name: path.split('/').pop()!, path, type: 'file' }
}

function directory(path: string, children: projectStore.FileTreeNode[]): projectStore.FileTreeNode {
  return {
    name: path.split('/').pop()!,
    path,
    type: 'directory',
    isExpanded: true,
    childrenLoaded: true,
    children
  }
}

function trigger(name: string): HTMLElement {
  return screen.getByText(name, { selector: '.project-file-tree-name' })
    .closest<HTMLElement>('[data-slot="context-menu-trigger"]')!
}

beforeEach(() => {
  projectStore.setProjects([{
    id: 'tree-project',
    user_id: 'tree-user',
    name: 'Tree project',
    root_path: '/fixture/tree-project',
    created_at: '',
    updated_at: ''
  }])
  projectStore.setCurrentProject('tree-project')
  projectStore.setFileTreeRoot([
    directory('src', [
      directory('src/nested', [file('src/nested/first.md')]),
      directory('src/other', [file('src/other/second.txt')])
    ])
  ])
})

afterEach(() => {
  projectStore.setCurrentProject(null)
  projectStore.setProjects([])
  projectStore.setActiveFile(null)
  vi.restoreAllMocks()
})

describe('FileTree recursive node instances', () => {
  it('keeps nested expansion, selection and portalled actions bound to their own nodes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const view = render(FileTree, { nodes: projectStore.getFileTree() })

    const otherFile = trigger('second.txt')
    await fireEvent.click(trigger('nested'))
    await view.rerender({ nodes: projectStore.getFileTree() })
    expect(screen.queryByTitle('first.md')).toBeNull()
    expect(trigger('second.txt')).toBe(otherFile)
    expect(projectStore.findTreeNode('src')?.isExpanded).toBe(true)
    expect(projectStore.findTreeNode('src/other')?.isExpanded).toBe(true)

    await fireEvent.click(trigger('nested'))
    await view.rerender({ nodes: projectStore.getFileTree() })
    expect(trigger('first.md')).toBeInTheDocument()
    expect(trigger('second.txt')).toBe(otherFile)
    expect(fetchSpy).not.toHaveBeenCalled()

    await fireEvent.click(trigger('first.md'))
    expect(projectStore.getActiveFilePath()).toBe('src/nested/first.md')
    expect(trigger('first.md')).toHaveClass('is-active')
    expect(otherFile).not.toHaveClass('is-active')
    await fireEvent.click(otherFile)
    expect(projectStore.getActiveFilePath()).toBe('src/other/second.txt')
    expect(otherFile).toHaveClass('is-active')
    expect(trigger('first.md')).not.toHaveClass('is-active')

    await fireEvent.contextMenu(trigger('first.md'))
    const upload = await screen.findByRole('menuitem', { name: 'Upload to Clip Vault' })
    expect(trigger('first.md')).toHaveAttribute('data-state', 'open')
    expect(otherFile).toHaveAttribute('data-state', 'closed')
    await fireEvent.click(upload)
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'batshit:upload-project-file',
      detail: { path: 'src/nested/first.md' }
    }))

    await fireEvent.contextMenu(otherFile)
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'Quick view' }))
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'batshit:project-quick-view',
      detail: { path: 'src/other/second.txt' }
    }))
  })
})
