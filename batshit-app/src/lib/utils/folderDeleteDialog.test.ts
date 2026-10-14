import { describe, expect, it } from 'vitest'

import { describeFolderDeleteLocked, describeFolderDeleteWithChats } from './folderDeleteDialog'

describe('describeFolderDeleteWithChats (BL-388)', () => {
  it('says the folder has no chats only when the server list is empty', () => {
    const { title, description } = describeFolderDeleteWithChats('Empty', [])
    expect(title).toBe('Delete "Empty" and 0 chats?')
    expect(description).toEqual(['This folder has no chats. The folder will be permanently deleted.'])
  })

  it('counts active and archived chats together and names only the archived ones', () => {
    const { title, description } = describeFolderDeleteWithChats('Mixed', [
      { name: 'Live one', archived: false },
      { name: 'Gone quiet', archived: true }
    ])
    expect(title).toBe('Delete "Mixed" and 2 chats?')
    // No chat is locked (the dialog is not offered when one is), so no locked-chat line.
    expect(description.join('\n')).not.toContain('ocked')
    expect(description[1]).toBe('1 of them is archived: "Gone quiet".')
    expect(description.join('\n')).not.toContain('Live one')
  })

  it('names the first five archived chats and counts the rest', () => {
    const chats = Array.from({ length: 8 }, (_, i) => ({ name: `Chat ${i + 1}`, archived: true }))
    const { title, description } = describeFolderDeleteWithChats('Many', chats)
    expect(title).toBe('Delete "Many" and 8 chats?')
    expect(description[1]).toBe(
      '8 of them are archived: "Chat 1", "Chat 2", "Chat 3", "Chat 4", "Chat 5", and 3 more.'
    )
  })

  it('says "1 chat" for one chat', () => {
    expect(describeFolderDeleteWithChats('One', [{ name: 'Solo', archived: false }]).title).toBe(
      'Delete "One" and 1 chat?'
    )
  })
})

describe('describeFolderDeleteLocked (BL-388 follow-up)', () => {
  it('returns null when no chat is locked', () => {
    expect(describeFolderDeleteLocked('Free', [{ name: 'A', locked: false }])).toBeNull()
  })

  it('names one locked chat', () => {
    expect(
      describeFolderDeleteLocked('Work', [
        { name: 'Keep me', locked: true },
        { name: 'Other', locked: false }
      ])
    ).toEqual({
      title: '"Work" has a locked chat',
      description: ['Unlock "Keep me" to delete this folder.']
    })
  })

  it('names two with "and", and past five says how many more', () => {
    expect(
      describeFolderDeleteLocked('Two', [
        { name: 'X', locked: true },
        { name: 'Y', locked: true }
      ])?.description
    ).toEqual(['Unlock "X" and "Y" to delete this folder.'])
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `L${i + 1}`, locked: true }))
    const result = describeFolderDeleteLocked('Many', many)
    expect(result?.title).toBe('"Many" has 7 locked chats')
    expect(result?.description).toEqual([
      'Unlock "L1", "L2", "L3", "L4", "L5", and 2 more to delete this folder.'
    ])
  })
})
