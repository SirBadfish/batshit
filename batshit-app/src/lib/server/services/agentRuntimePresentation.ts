import { rewriteN8nWebhookUrlForBrowserRuntime } from '$lib/server/services/runtimeUrlRewrites'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'

export function presentAgentForRuntime<T extends Record<string, any>>(
  agent: T,
  runtimeEnv?: Partial<Record<string, string | undefined>>
): T {
  if (normalizePrimaryAgentType(agent) !== 'n8n') {
    return agent
  }

  const rawWebhookUrl =
    typeof agent.webhook_url === 'string'
      ? agent.webhook_url
      : typeof agent.webhookUrl === 'string'
        ? agent.webhookUrl
        : null
  const runtimeWebhookUrl = rewriteN8nWebhookUrlForBrowserRuntime(rawWebhookUrl, runtimeEnv)

  if (!runtimeWebhookUrl || runtimeWebhookUrl === rawWebhookUrl) {
    return agent
  }

  return {
    ...agent,
    webhook_url: runtimeWebhookUrl,
    webhookUrl: runtimeWebhookUrl,
  }
}
