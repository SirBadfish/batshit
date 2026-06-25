import { describe, expect, it } from 'vitest'

import { getFileTypeIconPath } from './iconCatalog'
import { getProjectTreeIconRef } from './fileTypeIcons'

describe('getProjectTreeIconRef', () => {
  it('keeps project folders automatic and type-aware', () => {
    expect(getProjectTreeIconRef({ name: '.git', type: 'directory' })).toEqual({
      kind: 'fileType',
      id: 'folder-git'
    })
    expect(getProjectTreeIconRef({ name: 'src', type: 'directory' })).toEqual({
      kind: 'fileType',
      id: 'folder-src'
    })
    expect(getProjectTreeIconRef({ name: 'docs', type: 'directory', isExpanded: true })).toEqual({
      kind: 'fileType',
      id: 'folder-docs-open'
    })
    expect(getProjectTreeIconRef({ name: '.github', type: 'directory', isExpanded: true })).toEqual({
      kind: 'fileType',
      id: 'folder-github-open'
    })
  })

  it('maps common file extensions without emoji fallback', () => {
    expect(getProjectTreeIconRef({ name: 'App.svelte', type: 'file' })).toEqual({
      kind: 'fileType',
      id: 'svelte'
    })
    expect(getProjectTreeIconRef({ name: '.env.local', type: 'file' })).toEqual({
      kind: 'fileType',
      id: 'settings'
    })
    expect(getProjectTreeIconRef({ name: 'secret.pem', type: 'file' })).toEqual({
      kind: 'fileType',
      id: 'lock'
    })
    expect(getProjectTreeIconRef({ name: 'demo.mp4', type: 'file' })).toEqual({
      kind: 'fileType',
      id: 'video'
    })
    expect(getProjectTreeIconRef({ name: 'Widget.tsx', type: 'file' })).toEqual({
      kind: 'fileType',
      id: 'react_ts'
    })
    expect(getProjectTreeIconRef({ name: 'package.json', type: 'file' })).toEqual({
      kind: 'fileType',
      id: 'nodejs'
    })
  })

  it('renders generated Material Icon Theme assets for resolved file types', () => {
    expect(getFileTypeIconPath('svelte')).toBe('/file-icons/material/svelte.svg')
    expect(getFileTypeIconPath('folder-code')).toBe('/file-icons/material/folder-src.svg')
  })
})
