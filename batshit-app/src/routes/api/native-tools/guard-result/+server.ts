import { json, type RequestHandler } from '@sveltejs/kit'

// The only caller was the retired managed CLI helper. Keep its refusal for stale requests.
export const POST: RequestHandler = async () =>
  json({ success: false, error: 'A live model run with a chat and reply is required.' }, { status: 403 })
