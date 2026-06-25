import { describe, expect, it } from 'vitest';
import { validateN8nProductionWebhookUrl } from './n8nWebhookValidation';

describe('validateN8nProductionWebhookUrl', () => {
  it('accepts primary-agent production webhook URLs', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit_n8n_primary',
        'primary-agent'
      )
    ).toBeNull();

    expect(
      validateN8nProductionWebhookUrl(
        'https://n8n.example.test/webhook/custom_primary_path',
        'primary-agent'
      )
    ).toBeNull();
  });

  it('blocks test webhook URLs because the chat test-mode toggle derives them', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook-test/batshit_n8n_primary',
        'primary-agent'
      )
    ).toContain('Production Webhook URL');
  });

  it('blocks known workflow-subagent webhook URLs for primary agents', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit-subagent',
        'primary-agent'
      )
    ).toContain('Workflow Subagent webhook');

    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit_n8n_workflow_subagent',
        'primary-agent'
      )
    ).toContain('Workflow Subagent webhook');
  });

  it('blocks known primary webhook URLs for workflow subagents', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit_n8n_primary',
        'workflow-subagent'
      )
    ).toContain('Primary Agent webhook');

    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit',
        'workflow-subagent'
      )
    ).toContain('Primary Agent webhook');
  });

  it('accepts workflow-subagent production webhook URLs', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/webhook/batshit_n8n_workflow_subagent',
        'workflow-subagent'
      )
    ).toBeNull();
  });

  it('requires an n8n webhook path', () => {
    expect(
      validateN8nProductionWebhookUrl(
        'http://localhost:5678/workflow/pxzgDWI9jjigwZFU',
        'primary-agent'
      )
    ).toContain('/webhook/');
  });
});
