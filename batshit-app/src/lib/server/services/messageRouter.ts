import type { ChatMessage, AgentRow } from '$lib/types/database';
import type { PrimaryAgentType } from '$lib/utils/primaryAgentType';
import { isN8nPrimaryAgentType, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType';
import { extractN8nWebhookError } from '$lib/utils/n8nWebhookResponse';
import { logger } from '$lib/utils/logger';

interface ChatRequest {
  sessionId: string;
  agentId: string;
  messages: ChatMessage[];
  agent: AgentRow; // Agent object for agentType routing
  webhookUrl?: string;
  batshitInput?: any;
}

interface RouteResponse {
  success: boolean;
  data?: any;
  error?: string;
  agentType: PrimaryAgentType;
}

export class MessageRouter {
  /**
   * Route a message to the n8n-backed Batshit primary-agent path.
   */
  async route(request: ChatRequest): Promise<RouteResponse> {
    try {
      const agentType = normalizePrimaryAgentType(request.agent);

      logger.debug(`[Router] Routing based on agentType: ${agentType}`);

      if (!isN8nPrimaryAgentType(agentType)) {
        throw new Error('API and CLI agents must use the managed streaming route.');
      }

      return await this.routeToN8nPrimary(request, request.messages);
    } catch (error) {
      console.error(`[Router] Error routing message:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        agentType: normalizePrimaryAgentType(request.agent)
      };
    }
  }

  /**
   * Route to the native n8n primary-agent webhook path.
   */
  private async routeToN8nPrimary(
    request: ChatRequest,
    compiledMessages: ChatMessage[]
  ): Promise<RouteResponse> {
    if (!request.webhookUrl) {
      throw new Error('Webhook URL required for n8n agents');
    }

    const response = await fetch(request.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...request.batshitInput,
        messages: compiledMessages,
        agentType: 'n8n'
      })
    });

    if (!response.ok) {
      throw new Error(`n8n webhook failed: ${response.statusText}`);
    }

    const responseText = await response.text();
    let data: unknown = null;
    if (responseText.trim().length > 0) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.toLowerCase().includes('application/json')) {
        try {
          data = JSON.parse(responseText);
        } catch (parseError) {
          throw new Error(
            `n8n webhook returned invalid JSON: ${
              parseError instanceof Error ? parseError.message : String(parseError)
            }`
          );
        }
      } else {
        data = responseText;
      }
    }

    const webhookError = extractN8nWebhookError(data);
    if (webhookError) {
      throw new Error(webhookError);
    }

    return {
      success: true,
      data,
      agentType: 'n8n'
    };
  }
}

// Export singleton instance
export const messageRouter = new MessageRouter();
