import { describe, expect, it } from 'vitest'

import { redactWebhookStyleInput } from '$lib/server/services/executionViewerRedaction'

describe('executionViewerRedaction', () => {
  it('redacts callback tokens from n8n webhook snapshots', () => {
    const redacted = redactWebhookStyleInput([
      {
        headers: {
          'content-type': 'application/json',
          'x-batshit-callback-token': 'secret-callback-token',
          'x-batshit-native-tool-token': 'secret-native-tool-token',
        },
        body: {
          chatInput: 'hello',
          batshit_sse_callback_token: 'secret-body-token',
          batshit_native_tool_token: 'secret-native-body-token',
          nested: {
            callbackToken: 'nested-secret',
            safe: 'visible',
          },
        },
      },
    ]) as any[]

    expect(redacted[0].headers).toEqual({
      'content-type': 'application/json',
      'x-batshit-callback-token': '[REDACTED]',
      'x-batshit-native-tool-token': '[REDACTED]',
    })
    expect(redacted[0].body).toEqual({
      chatInput: 'hello',
      batshit_sse_callback_token: '[REDACTED]',
      batshit_native_tool_token: '[REDACTED]',
      nested: {
        callbackToken: '[REDACTED]',
        safe: 'visible',
      },
    })
  })
})
