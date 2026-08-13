import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { apiKeyService } from '$lib/services/apiKey.server';
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager';
import { syncAgentClaudeProfiles } from '$lib/server/services/claudeProfileManager';

function isContainerizedRuntime() {
  return env.BATSHIT_CONTAINERIZED === '1';
}

function isMacAppRuntime() {
  return env.BATSHIT_RUNTIME_OWNER === 'mac-app';
}

function runtimeToken() {
  return (env.BATSHIT_TOKEN || '').trim();
}

function hasRuntimeManagedBatshitToken() {
  return Boolean(runtimeToken());
}

function runtimeName() {
  if (isMacAppRuntime()) return 'Mac runtime';
  if (isContainerizedRuntime()) return 'Docker runtime environment';
  return 'source runtime environment';
}

function maskSecret(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return 'Configured';
  return `****...${trimmed.slice(-4)}`;
}

function resolveDefaultArtifactCompleteUrl(request: Request) {
  return `${new URL(request.url).origin}/api/artifacts/complete`;
}

function applyDefaultedHostKeys(keys: Record<string, any>, request: Request) {
  const artifactCompleteUrl = keys.batshit_artifact_complete_url;
  if (!artifactCompleteUrl || artifactCompleteUrl.status === 'needs-config') {
    keys.batshit_artifact_complete_url = {
      service: 'batshit_artifact_complete_url',
      masked: resolveDefaultArtifactCompleteUrl(request),
      updatedAt: '',
      status: 'ready',
      defaultedByRuntime: true,
      runtimeLabel: 'Using default'
    };
  }

  return keys;
}

function applyMacRuntimeManagedKeys(keys: Record<string, any>) {
  const token = runtimeToken();
  if (token) {
    keys.batshit_token = {
      service: 'batshit_token',
      masked: maskSecret(token),
      updatedAt: '',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Mac Runtime'
    };
  }

  return keys;
}

function applyHostRuntimeManagedKeys(keys: Record<string, any>, request: Request) {
  const token = runtimeToken();
  if (token) {
    keys.batshit_token = {
      service: 'batshit_token',
      masked: maskSecret(token),
      updatedAt: '',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Source Runtime'
    };
  }

  return applyDefaultedHostKeys(keys, request);
}

function applyRuntimeManagedKeys(keys: Record<string, any>, request: Request) {
  if (isMacAppRuntime()) {
    return applyMacRuntimeManagedKeys(applyDefaultedHostKeys(keys, request));
  }

  if (!isContainerizedRuntime()) {
    return applyHostRuntimeManagedKeys(keys, request);
  }

  const token = runtimeToken();
  if (token) {
    keys.batshit_token = {
      service: 'batshit_token',
      masked: maskSecret(token),
      updatedAt: '',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Docker Compose'
    };
  }

  const artifactCompleteUrl = (env.BATSHIT_ARTIFACT_COMPLETE_URL || '').trim();
  if (artifactCompleteUrl) {
    keys.batshit_artifact_complete_url = {
      service: 'batshit_artifact_complete_url',
      masked: artifactCompleteUrl,
      updatedAt: '',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Using Docker runtime default'
    };
  }

  const n8nApiUrl = (env.N8N_API_URL || '').trim();
  if (n8nApiUrl) {
    keys.n8n_api_url = {
      service: 'n8n_api_url',
      masked: n8nApiUrl,
      updatedAt: '',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Docker Compose'
    };
  }

  const n8nApiKey = (env.N8N_API_KEY || '').trim();
  if (n8nApiKey) {
    keys.n8n_api_key = {
      service: 'n8n_api_key',
      masked: maskSecret(n8nApiKey),
      updatedAt: '',
      status: 'ready',
      managedByRuntime: true,
      runtimeLabel: 'Managed by Docker Compose'
    };
  }

  return keys;
}

// GET: List all API keys (masked)
export const GET: RequestHandler = async ({ locals, request }) => {
  try {
    const userId = locals.user?.id;

    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const skipServices = ['batshit_token'];
    const storedKeys = await apiKeyService.getAllMasked(userId, { skipServices });
    const unreadableKeyCount = Object.values(storedKeys).filter(
      (record) => record.status === 'error'
    ).length;
    if (unreadableKeyCount > 0) {
      return json(
        {
          success: false,
          error:
            `Batshit found ${unreadableKeyCount} saved API key record${unreadableKeyCount === 1 ? '' : 's'} ` +
            'but could not decrypt them. Do not re-enter or delete the keys. Restore the original ' +
            'ENCRYPTION_KEY for this Batshit data, then restart Batshit.'
        },
        { status: 409 }
      );
    }
    const keys = applyRuntimeManagedKeys(storedKeys, request);

    return json({
      success: true,
      keys
    });
  } catch (error) {
    console.error('Failed to fetch API keys:', error);
    return json({
      success: false,
      error: 'Failed to fetch API keys'
    }, { status: 500 });
  }
};

// POST: Add or update an API key
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const userId = locals.user?.id;

    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { service, apiKey } = await request.json();

    if (!service || !apiKey) {
      return json({
        success: false,
        error: 'Service and API key are required'
      }, { status: 400 });
    }

    if (service === 'batshit_token') {
      await apiKeyService.delete(service, userId).catch(() => undefined);
      if (!hasRuntimeManagedBatshitToken()) {
        return json({
          success: false,
          error: `BATSHIT_TOKEN is not configured in the ${runtimeName()}.`
        }, { status: 400 });
      }

      const macRuntime = isMacAppRuntime();
      const dockerRuntime = isContainerizedRuntime();
      const token = runtimeToken();
      return json({
        success: true,
        service,
        masked: maskSecret(token),
        managedByRuntime: true,
        message: macRuntime
          ? 'BATSHIT_TOKEN is managed by the Mac runtime; restart the Mac app runtime after intentional rotation.'
          : dockerRuntime
            ? 'BATSHIT_TOKEN is managed by Docker Compose; update .env.docker and restart containers to change it.'
            : 'BATSHIT_TOKEN is managed by the source runtime environment; update root .env and restart services to change it.'
      });
    }

    // Store the API key
    await apiKeyService.store(service, apiKey, userId);
    if (service === 'n8n_instance_mcp_token') {
      await syncAgentCodexProfiles(userId);
      await syncAgentClaudeProfiles(userId);
    }

    // Return masked version
    const masked = await apiKeyService.getMasked(service, userId);

    return json({
      success: true,
      service,
      masked
    });
  } catch (error: any) {
    console.error('Failed to store API key:', error);
    return json({
      success: false,
      error: error.message || 'Failed to store API key'
    }, { status: 500 });
  }
};

// DELETE: Remove an API key
export const DELETE: RequestHandler = async ({ request, locals }) => {
  try {
    const userId = locals.user?.id;

    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { service } = await request.json();

    if (!service) {
      return json({
        success: false,
        error: 'Service is required'
      }, { status: 400 });
    }

    await apiKeyService.delete(service, userId);
    if (service === 'batshit_token') {
      const macRuntime = isMacAppRuntime();
      const dockerRuntime = isContainerizedRuntime();
      return json({
        success: true,
        service,
        managedByRuntime: true,
        message: macRuntime
          ? 'BATSHIT_TOKEN is managed by the Mac runtime and was not removed from the runtime environment.'
          : dockerRuntime
            ? 'BATSHIT_TOKEN is managed by Docker Compose and was not removed from the runtime environment.'
            : 'BATSHIT_TOKEN is managed by the source runtime environment and was not removed from root .env.'
      });
    }
    if (service === 'n8n_instance_mcp_token') {
      await syncAgentCodexProfiles(userId);
      await syncAgentClaudeProfiles(userId);
    }

    return json({
      success: true,
      service
    });
  } catch (error) {
    console.error('Failed to delete API key:', error);
    return json({
      success: false,
      error: 'Failed to delete API key'
    }, { status: 500 });
  }
};
