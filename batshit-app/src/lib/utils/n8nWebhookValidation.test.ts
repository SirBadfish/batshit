import { describe, expect, it } from 'vitest';
import { validateN8nProductionWebhookUrl } from './n8nWebhookValidation';

describe('validateN8nProductionWebhookUrl', () => {
  it('blocks test webhook URLs', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook-test/batshit_n8n_workflow_subagent'
      )
    ).toContain('Production Webhook URL');
  });

  it('blocks retired Category 1 webhook URLs for workflow subagents', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit_n8n_primary'
      )
    ).toContain('retired Category 1 webhook');

    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit'
      )
    ).toContain('retired Category 1 webhook');
  });

  it('accepts workflow-subagent production webhook URLs', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit_n8n_workflow_subagent'
      )
    ).toBeNull();
  });

  it('requires an n8n webhook path', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/workflow/pxzgDWI9jjigwZFU'
      )
    ).toContain('/webhook/');
  });
});
