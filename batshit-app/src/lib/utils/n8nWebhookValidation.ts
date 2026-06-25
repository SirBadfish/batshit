export type N8nWebhookTarget = 'primary-agent' | 'workflow-subagent';

const KNOWN_PRIMARY_WEBHOOK_PATHS = new Set([
  'batshit',
  'batshit_n8n_primary'
]);

const KNOWN_WORKFLOW_SUBAGENT_WEBHOOK_PATHS = new Set([
  'batshit_subagent',
  'batshit_n8n_workflow_subagent'
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
        'Enter a full n8n Production Webhook URL, for example http://localhost:5678/webhook/batshit_n8n_primary.'
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
        "Paste the Production Webhook URL. Batshit's test-mode button switches it to the test webhook automatically."
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
  rawUrl: string,
  target: N8nWebhookTarget
) {
  if (!rawUrl.trim()) return null;

  const parsed = getWebhookPathFromUrl(rawUrl);
  if ('error' in parsed) return parsed.error;

  const normalizedPath = normalizeWebhookPath(parsed.webhookPath);

  if (
    target === 'primary-agent' &&
    KNOWN_WORKFLOW_SUBAGENT_WEBHOOK_PATHS.has(normalizedPath)
  ) {
    return 'This is the n8n Workflow Subagent webhook. Primary Agents need the n8n Primary Agent production webhook.';
  }

  if (
    target === 'workflow-subagent' &&
    KNOWN_PRIMARY_WEBHOOK_PATHS.has(normalizedPath)
  ) {
    return 'This is the n8n Primary Agent webhook. Workflow Subagents need the n8n Workflow Subagent production webhook.';
  }

  return null;
}
