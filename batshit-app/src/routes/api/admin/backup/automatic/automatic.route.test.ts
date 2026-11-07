import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('$lib/server/services/automaticBackupService', () => ({ getAutomaticBackupView: fake.get, updateAutomaticBackupConfig: fake.save }))
import { GET, PUT } from './+server'
const event = (user: any, body = '{}', authorization = '') => ({ locals: { user }, request: new Request('http://localhost/api/admin/backup/automatic', {
  method: 'PUT', body, headers: { 'Content-Type': 'application/json', Authorization: authorization }
}) }) as any
beforeEach(() => { vi.clearAllMocks(); fake.get.mockResolvedValue({ config: { enabled: false } }); fake.save.mockResolvedValue({ saved: true }) })
describe('human Admin automatic backup route', () => {
  it('rejects service/agent tokens without a signed-in Admin and never calls the owner', async () => {
    expect((await PUT(event(null, '{}', 'Bearer service-token'))).status).toBe(401)
    expect((await GET(event({ id: 'worker', is_admin: false }))).status).toBe(403)
    expect(fake.get).not.toHaveBeenCalled(); expect(fake.save).not.toHaveBeenCalled()
  })
  it('reads settings without starting work, and sends only an authenticated human save to the owner', async () => {
    expect((await GET(event({ id: 'admin', is_admin: true }))).status).toBe(200)
    expect(fake.save).not.toHaveBeenCalled()
    const body = { expectedRevision: 'r1', enabled: true, cadence: 'daily', folder: null, afterUpdates: false }
    expect((await PUT(event({ id: 'admin', is_admin: true }, JSON.stringify(body)))).status).toBe(200)
    expect(fake.save).toHaveBeenCalledWith('admin', body)
  })
  it('bounds actual streamed configuration bytes and refuses malformed bodies before the owner', async () => {
    expect((await PUT(event({ id: 'admin', is_admin: true }, 'x'.repeat(16_385)))).status).toBe(413)
    expect((await PUT(event({ id: 'admin', is_admin: true }, '{bad'))).status).toBe(400)
    expect(fake.save).not.toHaveBeenCalled()
  })
})
