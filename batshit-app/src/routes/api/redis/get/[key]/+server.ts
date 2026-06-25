import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { RedisService } from '$lib/server/redis';
import { requireAdmin } from '$lib/server/services/routeSecurity';

export const GET: RequestHandler = async ({ params, locals }) => {
    const admin = requireAdmin(locals);
    if (!admin.ok) return admin.response;

    try {
        const { key } = params;
        
        // Security: Only allow specific live system prompt keys
        const allowedKeys = [
            // Primary-agent prompts
            'batshit:batshit_mode3_system_prompt',
            'batshit:batshit_mode4_system_prompt',
            'batshit:n8n_mode2_system_prompt',
            // Base SA prompts
            'batshit:sub_system_prompt',
            'batshit:subagent_instructions',
            // Tool + zip guidance prompts
            'batshit:tool_guidance_zip_enabled_prompt',
            'batshit:tool_guidance_zip_disabled_prompt',
            'batshit:dynamic_mcp_prompt',
            // Legacy keys (kept for backward compatibility)
            'batshit:batshit_primary_system_prompt',
            'batshit:n8n_primary_system_prompt',
            'batshit:primary_system_prompt',
            'batshit:system_prompt'
        ];
        
        if (!allowedKeys.includes(key)) {
            return json({ error: 'Access denied to this key' }, { status: 403 });
        }
        
        const redis = new RedisService();
        const value = await redis.get(key);
        
        return json({ 
            key,
            value: value || '',
            exists: value !== null
        });
    } catch (error) {
        console.error('Redis GET error:', error);
        return json({ error: 'Failed to retrieve value' }, { status: 500 });
    }
};
