import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * SA-106 P1: guards for the Category 2 official n8n templates that SURVIVE the
 * `n8n` primary-agent retirement.
 *
 * These assertions used to live in `messageApi.test.ts`, which died with the
 * Category 1 browser send lane. They are Category 2 (`n8n Workflow Subagent`,
 * whose parent is an API or CLI agent) and DL-106-01 requires that lane to stay
 * provably intact, so they moved here rather than being deleted with the suite.
 *
 * Note for P6: these read the templates off disk, so template edits and this
 * file must land in the same commit.
 */

const TEMPLATE_DIR =
  '../docs/user-docs/user-templates/batshit-official-n8n-workflow-templates'

function loadTemplate(name: string) {
  return JSON.parse(readFileSync(`${TEMPLATE_DIR}/${name}`, 'utf8'))
}

function getWebhookPath(workflow: any): string | undefined {
  return workflow.nodes.find((node: any) => node?.type === 'n8n-nodes-base.webhook')
    ?.parameters?.path
}

function collectToolUrls(workflow: any): string[] {
  return workflow.nodes
    .map((node: any) => node?.parameters?.url)
    .filter((url: unknown): url is string => typeof url === 'string')
}

describe('official n8n Workflow Subagent templates (Category 2)', () => {
  it('the Docker variant keeps its own webhook path and workflow id', () => {
    const workflowSubagent = loadTemplate('batshit-docker-n8n-workflow-subagent.json')
    const nativeSubagent = loadTemplate('batshit-n8n-workflow-subagent.json')

    expect(getWebhookPath(workflowSubagent)).toBe('batshit_docker_n8n_workflow_subagent')
    expect(workflowSubagent.id).not.toBe(nativeSubagent.id)
  })

  it('the Docker variant routes every Batshit tool call through the Compose service host', () => {
    const urls = collectToolUrls(loadTemplate('batshit-docker-n8n-workflow-subagent.json'))

    expect(urls.length).toBeGreaterThanOrEqual(1)
    expect(urls.every((url) => url.includes('http://app:3000'))).toBe(true)
    // The browser-facing loopback port is wrong from inside Compose; a regression here
    // silently breaks every Docker workflow-subagent tool call.
    expect(urls.every((url) => !url.includes('127.0.0.1:5620'))).toBe(true)
  })

  it('both variants read the subagent system prompt from the shared subagentPrompts wire field', () => {
    // SA-106: `subagentPrompts` is a SHARED n8n expression contract, not a Category 1
    // name. `subagentRunner.runWorkflowBackedSubagent` is its surviving producer, and a
    // name-based sweep during the retirement would break these templates.
    for (const name of [
      'batshit-n8n-workflow-subagent.json',
      'batshit-docker-n8n-workflow-subagent.json',
    ]) {
      const systemMessages = loadTemplate(name)
        .nodes.map((node: any) => node?.parameters?.options?.systemMessage)
        .filter((value: unknown): value is string => typeof value === 'string')

      expect(
        systemMessages.some((value: string) =>
          value.includes('subagentPrompts[$json.body.subagent_slug]'),
        ),
      ).toBe(true)
    }
  })

  it('both variants authenticate native tool calls with the per-message token', () => {
    for (const name of [
      'batshit-n8n-workflow-subagent.json',
      'batshit-docker-n8n-workflow-subagent.json',
    ]) {
      const raw = readFileSync(`${TEMPLATE_DIR}/${name}`, 'utf8')

      // The scoped per-message token minted by subagentRunner via
      // createN8nSseCallbackToken — the real reason n8nCallbackTokens.ts survives
      // the primary-agent retirement.
      expect(raw).toContain('x-batshit-native-tool-token')
      expect(raw).toContain('batshit_native_tool_token')
      // Category 2 dispatch identity: subagent actor, n8n tool host.
      expect(raw).toContain("actor_type: 'subagent'")
      expect(raw).toContain("primary_agent_type: 'n8n'")
    }
  })

  it('keys Redis Chat Memory on the Batshit-issued thread id with a 7-day TTL', () => {
    // SA-111 P2 (DL-111-06): n8n owns the conversation, so the thread id in the session key
    // is the ONLY lever Batshit has over it. Drop the id and `thread: "fresh"` silently
    // stops resetting, which is the failure mode this assertion exists to catch.
    for (const name of [
      'batshit-n8n-workflow-subagent.json',
      'batshit-docker-n8n-workflow-subagent.json',
    ]) {
      const memory = loadTemplate(name).nodes.find(
        (node: any) => node?.type === '@n8n/n8n-nodes-langchain.memoryRedisChat',
      )

      expect(memory?.parameters?.sessionKey).toBe(
        '=subagent_sessions:{{ $json.body.session_id }}:subagent:{{ $json.body.subagent_slug }}:{{ $json.body.subagent_thread_id }}',
      )
      // Orphaned threads must age out on their own; Batshit's own id key uses the same clock.
      expect(memory?.parameters?.sessionTTL).toBe(604800)
    }
  })
})
