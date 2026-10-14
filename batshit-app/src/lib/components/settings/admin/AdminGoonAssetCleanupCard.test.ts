import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import AdminGoonAssetCleanupCard from './AdminGoonAssetCleanupCard.svelte'
import type { GoonAssetAuditSummary } from './adminSettingsTypes'

function audit(eligible = false): GoonAssetAuditSummary {
  const file = { uploadType: eligible ? 'goons' : 'goon_scenes', filename: 'lost.jpg', size: 1234,
    cleanupEligible: eligible, reason: eligible ? 'No current saved reference was found.' : 'A failed or partial settings write may have removed this Scene reference. Batshit cannot determine when or why. This file is preserved.' }
  return {
    uploadRecordCount: 1, referencedRecordCount: 0, orphanRecordCount: 1,
    uploadBytes: 1234, orphanBytes: 1234, byType: [],
    cleanupCandidateCount: eligible ? 1 : 0, cleanupCandidateBytes: eligible ? 1234 : 0,
    preservedOrphanRecordCount: eligible ? 0 : 1,
    orphans: [file], cleanupCandidates: eligible ? [file] : []
  }
}

describe('Admin cleanup evidence (BL-1025)', () => {
  it('shows each preserved file and its uncertainty, and never starts cleanup on inspection', async () => {
    const onInspect = vi.fn()
    const onCleanup = vi.fn()
    render(AdminGoonAssetCleanupCard, { auditBusy: false, cleanupBusy: false, audit: audit(), error: null, onInspect, onCleanup })
    expect(screen.getByText('lost.jpg')).toBeTruthy()
    expect(screen.getByText(/failed or partial settings write/)).toBeTruthy()
    expect(screen.getByText('1 preserved')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Clean Orphans' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(onInspect).toHaveBeenCalledOnce()
    expect(onCleanup).not.toHaveBeenCalled()
  })

  it('requires an inspection before offering cleanup', () => {
    render(AdminGoonAssetCleanupCard, { auditBusy: false, cleanupBusy: false, audit: null, error: null, onInspect: vi.fn(), onCleanup: vi.fn() })
    expect((screen.getByRole('button', { name: 'Clean Orphans' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers the explicit cleanup action only for eligible orphans and explains its basis', async () => {
    const onCleanup = vi.fn()
    render(AdminGoonAssetCleanupCard, { auditBusy: false, cleanupBusy: false, audit: audit(true), error: null, onInspect: vi.fn(), onCleanup })
    expect(screen.getByText('No current saved reference was found.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Clean Orphans' }) as HTMLButtonElement).disabled).toBe(false)
    expect(onCleanup).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Clean Orphans' }))
    expect(onCleanup).toHaveBeenCalledOnce()
  })
})
