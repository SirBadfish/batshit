import { afterEach, describe, expect, it } from 'vitest'
import {
  droppedSendSentence,
  keptSendReplayMetadata,
  NOT_SENT_SENTENCE,
  readKeptSend,
  resolveKeptSendReceipts,
  toDroppedSendReason
} from '../keptSendReceipt'
import * as steerInbox from '$lib/stores/steerInbox.svelte'
import { MESSAGE_FACT_KEYS, pickSendFacts, SEND_FACT_KEYS } from '$lib/utils/sendFacts'
import { replayableSendMetadata } from '$lib/utils/steerControl'

/**
 * BL-903 (a): a kept send's "Not sent" receipt lived only in the tab that sent it; a reload or
 * another tab showed the words at the end of the chat with nothing to say they were never sent.
 * The keeper now saves the reason on the message, and every tab draws the receipt from it.
 */
const user = (id: string, metadata: Record<string, unknown> = {}) => ({ id, role: 'user', metadata })
const reply = (id: string) => ({ id, role: 'assistant', metadata: {} })

describe('a kept send\'s receipt from its record (BL-903 a)', () => {
  afterEach(() => steerInbox.clearSteerInboxForTest())

  it('every kept message at the end of the chat that no reply follows has one', () => {
    const receipts = resolveKeptSendReceipts({
      messages: [
        user('u1'),
        reply('a1'),
        user('kept-1', { keptSend: { reason: 'stopped' } }),
        user('plain'),
        user('kept-2', { keptSend: { reason: 'approval_wait' } })
      ],
      busy: false
    })
    expect(receipts).toEqual([
      { messageId: 'kept-1', state: 'stopped', label: 'Not sent — you stopped the reply' },
      {
        messageId: 'kept-2',
        state: 'not_sent',
        label: 'Not sent — it stopped waiting for the approval card. Send it when you are ready.'
      }
    ])
  })

  it('a reply after the kept message ends its receipt, and a busy chat shows none', () => {
    expect(
      resolveKeptSendReceipts({ messages: [user('kept', { keptSend: { reason: 'stopped' } }), reply('a2')], busy: false })
    ).toEqual([])
    expect(
      resolveKeptSendReceipts({ messages: [reply('a1'), user('kept', { keptSend: { reason: 'stopped' } })], busy: true })
    ).toEqual([])
  })

  it('says each reason the way the sending tab\'s bubble says it (one table)', () => {
    for (const [reason, dropReason] of [
      ['stopped', 'stopped'],
      ['approval_wait', 'approval_wait'],
      ['approval_expired', 'approval_expired'],
      ['shutdown', 'not_sent'],
      ['overflow', 'not_sent'],
      ['agent_deleted', 'not_sent'],
      ['a_reason_this_page_does_not_know', 'not_sent']
    ] as const) {
      expect(toDroppedSendReason(reason)).toBe(dropReason)
      const [receipt] = resolveKeptSendReceipts({ messages: [user('k', { keptSend: { reason } })], busy: false })
      steerInbox.noteLocalSteer({ steerId: `s-${reason}`, sessionId: 'chat', messageId: 'reply', text: 'x', deliver: 'end' })
      steerInbox.markSteerDropped(`s-${reason}`, dropReason)
      const bubble = steerInbox.getSteer(`s-${reason}`)
      expect(receipt.label).toBe(droppedSendSentence(dropReason))
      expect(bubble && steerInbox.steerBubbleStatusLabel(bubble)).toBe(receipt.label)
    }
  })

  /**
   * BL-903 (c): a send Batshit itself kept (it was stopping, or a backup restore began: reason
   * `shutdown`; the line's cap; an agent deleted while it waited) said "the reply ended before it
   * could land", the page's backstop for a steer the server never placed. No reply ended for it:
   * it is the plain "Not sent", in the bubble and in the record's receipt alike.
   */
  it('a send Batshit kept says the plain "Not sent", never that the reply ended (BL-903 c)', () => {
    for (const reason of ['shutdown', 'overflow', 'agent_deleted']) {
      expect(droppedSendSentence(toDroppedSendReason(reason))).toBe(NOT_SENT_SENTENCE)
      const [receipt] = resolveKeptSendReceipts({ messages: [user('k', { keptSend: { reason } })], busy: false })
      expect(receipt).toEqual({ messageId: 'k', state: 'not_sent', label: 'Not sent' })
    }
    // The backstop's own words stay the backstop's: the page passes them itself, no server reason maps to them.
    expect(droppedSendSentence('unanswered')).toBe('Not sent — the reply ended before it could land. Send it again.')
    expect(NOT_SENT_SENTENCE).not.toBe(droppedSendSentence('unanswered'))
  })

  it('reads only a well-formed mark', () => {
    expect(readKeptSend({ keptSend: { reason: 'stopped' } })).toEqual({ reason: 'stopped' })
    expect(readKeptSend({ keptSend: { reason: '' } })).toBeNull()
    expect(readKeptSend({ keptSend: 'stopped' })).toBeNull()
    expect(readKeptSend(null)).toBeNull()
  })

  it('Send now sends the facts the message was saved with, and nothing the composer owns', () => {
    expect(
      keptSendReplayMetadata({
        clipIds: ['clip_1'],
        fileReferences: [{ path: 'a.md' }],
        projectPath: '/p',
        tts: true,
        keptSend: { reason: 'stopped' },
        interruption: { messageId: 'old' },
        quickAction: { id: 'q' },
        client_sent: true
      })
    ).toEqual({ clipIds: ['clip_1'], fileReferences: [{ path: 'a.md' }], projectPath: '/p', tts: true })
  })

  /**
   * The reviewer's case: a kept send typed with a Claude permission mode, a project with rules and a
   * narrowed tool choice. The sending tab's bubble replays the send it made; the record's receipt
   * (after a reload, in another tab) replayed only Clips, files, project and voice, so its Send now
   * ran with the page's current modes. Both now carry the same send facts and message facts.
   */
  it('Send now from the record replays the same facts as the sending tab\'s bubble', () => {
    // The send as the chat bar hands it to the page (ChatInput), with the Goons state the page adds.
    const composerSend: Record<string, unknown> = {
      stt: true,
      tts: true,
      voiceMode: 'voice',
      realtime: false,
      composerSessionId: 'chat',
      fileReferences: [{ path: 'a.md' }],
      clipIds: ['clip_1'],
      claudePermissionMode: 'bypassPermissions',
      projectPath: '/work/p',
      projectRules: { notes: 'rules' },
      selectedTools: ['tool_a'],
      skillInvocation: { skillId: 'skill_1' },
      goonsEnabled: false,
      onAccepted: () => {},
      onReplayAccepted: () => {},
      busySendModeOverride: 'steer'
    }
    // What the page posts (`requestMetadata`), and what it saves on its own message.
    const requestMetadata = { ...composerSend, agent: { id: 'agent' }, sessionId: 'chat', interruption: undefined }
    const savedMessage = {
      client_sent: true,
      stt: true,
      tts: true,
      voiceMode: true,
      fileReferences: [{ path: 'a.md' }],
      clipIds: ['clip_1'],
      projectPath: '/work/p',
      skillInvocation: { skillId: 'skill_1' },
      zipIds: []
    }
    // The keeper's mark: the send facts of the kept send's own request (send-routed).
    const record = { ...savedMessage, keptSend: { reason: 'stopped', sendFacts: pickSendFacts(requestMetadata) } }

    const bubble = replayableSendMetadata(composerSend)
    const fromRecord = keptSendReplayMetadata(record)
    for (const key of [...SEND_FACT_KEYS, ...MESSAGE_FACT_KEYS]) {
      expect(fromRecord[key], key).toEqual(bubble[key])
    }
    expect(fromRecord).toMatchObject({ claudePermissionMode: 'bypassPermissions', projectRules: { notes: 'rules' }, selectedTools: ['tool_a'] })

    // A mark saved without send facts: the message's own project and voice stand in.
    expect(keptSendReplayMetadata({ ...savedMessage, keptSend: { reason: 'stopped' } })).toEqual({
      projectPath: '/work/p',
      tts: true,
      voiceMode: 'voice',
      stt: true,
      clipIds: ['clip_1'],
      fileReferences: [{ path: 'a.md' }],
      skillInvocation: { skillId: 'skill_1' }
    })
  })

  it('a receipt the user retired in this tab is remembered; leaving the chat or a tab that cannot send it is not a retirement', () => {
    const dropped = (id: string) => {
      steerInbox.noteLocalSteer({ steerId: id, sessionId: 'chat', messageId: 'reply', text: 'x', deliver: 'end' })
      steerInbox.markSteerDropped(id, 'stopped')
    }
    dropped('kept-left')
    steerInbox.clearDroppedSteersForSession('chat')
    expect(steerInbox.wasReceiptRetired('kept-left')).toBe(false)

    // A spectator tab clears a bubble it cannot send (`settleKeptReceipt`): the record's receipt,
    // with its own Send now, shows there instead.
    dropped('kept-spectator')
    steerInbox.clearDroppedSteer('kept-spectator')
    expect(steerInbox.wasReceiptRetired('kept-spectator')).toBe(false)

    dropped('kept-dismissed')
    steerInbox.clearDroppedSteer('kept-dismissed', { byUser: true })
    expect(steerInbox.wasReceiptRetired('kept-dismissed')).toBe(true)
  })
})
