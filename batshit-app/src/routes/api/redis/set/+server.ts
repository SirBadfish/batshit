import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { RedisService } from '$lib/server/redis';
import { requireAdmin } from '$lib/server/services/routeSecurity';

export const POST: RequestHandler = async ({ request, locals }) => {
    const admin = requireAdmin(locals);
    if (!admin.ok) return admin.response;

    try {
        const { key, value } = await request.json();
        
        if (!key || value === undefined) {
            return json({ error: 'Missing key or value' }, { status: 400 });
        }
        
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
            'batshit:system_prompt',
            // Last updated timestamps
            'batshit:batshit_mode3_system_prompt:last_updated',
            'batshit:batshit_mode4_system_prompt:last_updated',
            'batshit:n8n_mode2_system_prompt:last_updated',
            'batshit:sub_system_prompt:last_updated',
            'batshit:subagent_instructions:last_updated',
            'batshit:tool_guidance_zip_enabled_prompt:last_updated',
            'batshit:tool_guidance_zip_disabled_prompt:last_updated',
            'batshit:dynamic_mcp_prompt:last_updated',
            'batshit:batshit_primary_system_prompt:last_updated',
            'batshit:n8n_primary_system_prompt:last_updated',
            'batshit:primary_system_prompt:last_updated',
            'batshit:system_prompt:last_updated'
        ];
        
        if (!allowedKeys.includes(key)) {
            return json({ error: 'Access denied to this key' }, { status: 403 });
        }
        
        const redis = new RedisService();
        await redis.set(key, value);
        
        return json({ 
            success: true,
            key,
            message: 'Value saved successfully'
        });
    } catch (error) {
        console.error('Redis SET error:', error);
        return json({ error: 'Failed to save value' }, { status: 500 });
    }
};
