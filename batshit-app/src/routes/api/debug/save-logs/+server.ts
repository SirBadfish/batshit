import { json, type RequestHandler } from '@sveltejs/kit';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { requireAdmin } from '$lib/server/services/routeSecurity';
import { logger } from '$lib/utils/logger';

const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;

function normalizeTimestamp(value: unknown): string {
  const fallback = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  if (typeof value !== 'string') return fallback;

  const trimmed = value.trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(trimmed) ? trimmed : fallback;
}

// Save debug logs to the local logs directory
export const POST: RequestHandler = async ({ request, locals }) => {
  const admin = requireAdmin(locals);
  if (!admin.ok) return admin.response;

  try {
    const { content, timestamp } = await request.json();
    
    if (typeof content !== 'string' || !content) {
      return json({ 
        success: false, 
        error: 'No log content provided' 
      }, { status: 400 });
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_DEBUG_LOG_BYTES) {
      return json({
        success: false,
        error: 'Log content is too large'
      }, { status: 413 });
    }
    
    // Create logs directory if it doesn't exist
    const logsDir = process.env.BATSHIT_LOG_DIR
      ? path.resolve(process.env.BATSHIT_LOG_DIR)
      : path.resolve(process.cwd(), '..', '_local', 'logs');
    await mkdir(logsDir, { recursive: true });
    
    // Create filename with timestamp
    const filename = `batshit-console-${normalizeTimestamp(timestamp)}.log`;
    const filepath = path.resolve(logsDir, filename);

    if (!filepath.startsWith(`${logsDir}${path.sep}`)) {
      return json({
        success: false,
        error: 'Invalid log filename'
      }, { status: 400 });
    }
    
    // Write the log file
    await writeFile(filepath, content, 'utf8');
    
    logger.debug(`Debug logs saved to: ${filename}`);
    
    return json({ 
      success: true, 
      filename,
      path: path.relative(path.resolve(process.cwd(), '..'), filepath)
    });
    
  } catch (error) {
    console.error('Failed to save debug logs:', error);
    return json({ 
      success: false, 
      error: 'Failed to save debug logs' 
    }, { status: 500 });
  }
};
