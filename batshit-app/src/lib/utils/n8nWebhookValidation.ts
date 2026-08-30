const KNOWN_PRIMARY_WEBHOOK_PATHS = new Set([
  'batshit',
  'batshit_n8n_primary'
]);

function normalizeWebhookPath(path: string) {
  return path
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getWebhookPathFromUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return {
      error:
        'Enter a full n8n Production Webhook URL, for example http://localhost:5678/webhook/batshit_n8n_workflow_subagent.'
    };
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  const webhookIndex = segments.findIndex(
    (segment) => segment === 'webhook' || segment === 'webhook-test'
  );

  if (webhookIndex === -1) {
    return {
      error: 'Paste an n8n Production Webhook URL that contains /webhook/.'
    };
  }

  if (segments[webhookIndex] === 'webhook-test') {
    return {
      error:
        'Test webhook URLs are not supported. Activate the workflow and paste its Production Webhook URL.'
    };
  }

  const webhookPath = segments.slice(webhookIndex + 1).join('/');
  if (!webhookPath.trim()) {
    return {
      error: 'The n8n webhook URL is missing the workflow path after /webhook/.'
    };
  }

  return { webhookPath };
}

export function validateN8nProductionWebhookUrl(
  rawUrl: string
) {
  if (!rawUrl.trim()) return null;

  const parsed = getWebhookPathFromUrl(rawUrl);
  if ('error' in parsed) return parsed.error;

  const normalizedPath = normalizeWebhookPath(parsed.webhookPath);

  if (KNOWN_PRIMARY_WEBHOOK_PATHS.has(normalizedPath)) {
    return 'This is a retired Category 1 webhook. n8n Workflow Subagents need their own production webhook.';
  }

  return null;
}
