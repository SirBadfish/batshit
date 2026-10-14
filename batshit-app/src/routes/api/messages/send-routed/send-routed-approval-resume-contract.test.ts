import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')

/**
 * An API-lane approval resume streams into the message the card was ON — the same id every
 * tab has already marked finished, so the chat page drops every one of its stream events
 * (`ignoreLateEventForFinalizedMessage`). Nothing but the page's old ten-times-a-second
 * refetch of the open chat ever put the resumed reply on screen; that refetch is gone
 * (2026-09-18), so the server says it once, after the write.
 *
 * The pin is about ORDER and the GATE: after the resumed message is in Redis, and only for a
 * resume that has no user turn of its own — a CLI control resume writes a NEW assistant id
 * and streams to the tab normally.
 */
describe('send-routed approval resume contract', () => {
  it('opens an in-place resume after run registration and before provider or tool work', () => {
    const registerAbort = source.indexOf('registerStreamAbort(sessionId, messageId, streamAbortController)')
    const registerSteer = source.indexOf('registerSteerRun(sessionId, {', registerAbort)
    const startDefinition = source.indexOf('ensureStartEmitted = async () => {', registerSteer)
    const resumeGate = source.indexOf('approvalResumeStart &&', startDefinition)
    const earlyStart = source.indexOf('await ensureStartEmitted()', resumeGate)
    const providerStart = source.indexOf('streamResult = await nativeRuntime.streamNativeMode(', earlyStart)

    expect(registerAbort).toBeGreaterThan(-1)
    expect(registerSteer).toBeGreaterThan(registerAbort)
    expect(startDefinition).toBeGreaterThan(registerSteer)
    expect(resumeGate).toBeGreaterThan(startDefinition)
    expect(earlyStart).toBeGreaterThan(resumeGate)
    expect(providerStart).toBeGreaterThan(earlyStart)

    const gateBody = source.slice(resumeGate, earlyStart)
    expect(gateBody).toContain('!groupContext')
    expect(gateBody).toContain('streamMetadata?.groupChat !== true')

    // The same once-only guard serves the early resume and every later chunk/tool path. Provider
    // setup must never replace it and reopen/reset the same message a second time.
    expect(source.split('let startEmitted = false').length - 1).toBe(1)
    expect(source.split('ensureStartEmitted = async () => {').length - 1).toBe(1)
  })

  it('closes an early resume start when provider acquisition fails', () => {
    const helper = source.indexOf('const closeStartedAcquisitionFailure = async (error: unknown) => {')
    const primaryCatch = source.indexOf('} catch (primaryError) {', helper)

    expect(helper).toBeGreaterThan(-1)
    const helperBody = source.slice(helper, primaryCatch)
    expect(helperBody).toContain('if (!startEmitted) return')
    expect(helperBody).toContain('const interrupted = isStopError(error, [streamAbortSignal, request.signal])')
    expect(helperBody).toContain('if (interrupted) {')
    // BL-775: saved through `finalizeStoppedReply` (one retry, then a plain error to the tabs).
    expect(helperBody).toContain("await finalizeStoppedReply('Failed to finalize a stopped early approval resume')")
    expect(helperBody).toContain('await streamAdapter.emitComplete({')
    expect(helperBody).toContain('interrupted: true,')
    expect(helperBody.indexOf('await finalizeStoppedReply('))
      .toBeLessThan(helperBody.indexOf('await streamAdapter.emitComplete({'))
    expect(helperBody.indexOf('await streamAdapter.emitComplete({'))
      .toBeLessThan(helperBody.indexOf('await streamAdapter.emitError({'))
    expect(helperBody).toContain('await streamAdapter.emitError({')
    expect(helperBody).not.toContain('redis.saveMessage')
    // BL-775: a real failure is saved before the tabs are told, and the POST's catch skips it.
    expect(helperBody.indexOf('await persistFailedAssistantTurn({'))
      .toBeLessThan(helperBody.indexOf('await streamAdapter.emitError({'))
    expect(helperBody).toContain('failuresSavedBeforeThrow.add(error)')

    // BL-451: the model's setup failure ends the run. There is no fallback model and no second
    // try: one provider call, and its catch closes the start and throws.
    const primaryFailureEnd = source.indexOf('\n  }\n\n  try {', primaryCatch)
    expect(primaryFailureEnd).toBeGreaterThan(primaryCatch)
    const primaryFailureBody = source.slice(primaryCatch, primaryFailureEnd)
    expect(primaryFailureBody).toContain('const terminalError = preserveAcquisitionFailureVersion(primaryError)')
    expect(primaryFailureBody).toContain('await closeStartedAcquisitionFailure(terminalError)')
    expect(primaryFailureBody.indexOf('await closeStartedAcquisitionFailure(terminalError)'))
      .toBeLessThan(primaryFailureBody.indexOf('throw terminalError'))
    expect(primaryFailureBody).not.toContain('streamNativeMode(')
    expect(source.split('streamResult = await nativeRuntime.streamNativeMode(').length - 1).toBe(1)

    const postCatch = source.indexOf('} catch (streamError) {', primaryFailureEnd)
    const postCatchBody = source.slice(postCatch, source.indexOf('\n        }\n', postCatch))
    expect(postCatchBody).toContain('streamError instanceof ApprovalResumeAcquisitionError')
    expect(postCatchBody).toContain('if (!isAbortError && !failureAlreadySaved) {')
    expect(postCatchBody).toContain('{ approvalResumeVersion: streamError.approvalResumeVersion }')
  })

  it('tells the tab AFTER the resumed message is saved, and only for an in-place resume', () => {
    const save = source.indexOf('await redis.saveMessage(finalMessage)')
    expect(save).toBeGreaterThan(-1)
    const announce = source.indexOf('if (isApprovalResumeWithoutUserTurn) {', save)
    expect(announce).toBeGreaterThan(save)

    const body = source.slice(announce, announce + 400)
    expect(body).toContain('await publishUserEvent(userId, {')
    expect(body).toContain("type: 'session_messages_changed',")
    expect(body).toContain('sessionId,')
    expect(body).toContain("reason: 'approval_resume',")

    // Nothing between the save and the announcement may end the turn early.
    expect(source.slice(save, announce)).not.toContain('return')
  })

  it('reuses the message the card was on only for an in-place resume', () => {
    // The CLI control resume mints its own ids, so its turn streams to the tab as usual and
    // needs no announcement.
    expect(source).toContain('managedAssistantMessageId = resumeAssistantMessageId')
    expect(source).toContain('const isApprovalResumeWithoutUserTurn =\n    hasToolApprovalResponse && !hasUserTurnContent')
    // Two writers can end an in-place resume: the finalize and the no-output failure writer. The
    // failure writer also announces a turn that failed before its stream opened (bug sweep item 2,
    // 2026-09-18), so its reason is chosen, with the in-place resume keeping `approval_resume`.
    expect(source.split("reason: 'approval_resume',").length - 1).toBe(1)
    expect(source.split("reason: inPlaceResume ? 'approval_resume' : 'turn_failed',").length - 1).toBe(1)
  })
})

/**
 * The resume CONTINUES the message the card was on (`approvalResumeMessage.ts`): its stream
 * starts empty and `saveMessage` replaces content, so saving it alone dropped the words the
 * agent wrote before the card (measured live 2026-09-18, old and new code alike). The rule
 * lives in the module and is tested there; these pins hold send-routed to it.
 */
describe('send-routed keeps what the message held before the card', () => {
  it('continues the stored message BEFORE the finalize saves it, for an in-place resume only', () => {
    const save = source.indexOf('await redis.saveMessage(finalMessage)')
    const gate = source.lastIndexOf(
      "if (isApprovalResumeWithoutUserTurn && typeof finalMessage.content === 'string') {",
      save
    )
    expect(gate).toBeGreaterThan(-1)
    const body = source.slice(gate, save)
    expect(body).toContain('const priorRecord = approvalResumePrior')
    const frozen = source.indexOf('const approvalResumePrior = isApprovalResumeWithoutUserTurn')
    expect(frozen).toBeGreaterThan(-1)
    expect(frozen).toBeLessThan(source.indexOf('const streamAdapter = new StreamEventAdapter({'))
    expect(body).toContain('const continued = composeInPlaceResumeMessage(priorRecord, {')
    expect(body).toContain('finalMessage.content = continued.content')
    expect(body).toContain('finalMessage.metadata = continued.metadata')
    expect(body).toContain('finalMessage.intermediateSteps = continued.intermediateSteps')
    // The finalMessage it continues is the one about to be saved: nothing is built between.
    expect(source.slice(source.lastIndexOf('const finalMessage: ChatMessage = {', gate), gate)).not.toContain('await ')
  })

  it('keeps the words when a resume fails with nothing produced, and tells the tab', () => {
    const writer = source.indexOf('async function persistFailedAssistantTurn(options: {')
    const end = source.indexOf('\nfunction ', writer + 10)
    const body = source.slice(writer, end)
    expect(body).toContain('inPlaceResume?: boolean')
    expect(body).toContain('const content = resolveFailedTurnContent({')
    expect(body).toContain('const prior = inPlaceResume ? await readStoredAssistantRecord(sessionId, messageId) : null')
    expect(body).toContain('      errorText: cleanMessage,\n      prior,\n')
    // BL-542: the reply-end record rides the failure record, joined with the part before the card.
    // Review D2: joined onto the record frozen before the resume, never onto the fresh read.
    expect(body).toContain(
      '...carriedReplyEndMetadata(\n          options.replyEndMetadata,\n          inPlaceResume ? (options.replyEndPrior ?? null) : null,\n        ),'
    )
    expect(body).toContain('      content,\n')
    const saved = body.indexOf('await redis.saveMessage({')
    const told = body.indexOf("type: 'session_messages_changed',")
    expect(saved).toBeGreaterThan(-1)
    expect(told).toBeGreaterThan(saved)
    expect(body.slice(saved, told)).toContain('if (inPlaceResume || options.noStreamEvent === true) {')
  })

  it('keeps the resume version on both partial and empty failure records', () => {
    const metadata = source.indexOf('const failureRuntimeMetadata = {')
    const partialFailure = source.indexOf('// A failed stream must never erase work', metadata)
    expect(metadata).toBeGreaterThan(-1)
    expect(partialFailure).toBeGreaterThan(metadata)
    expect(source.slice(metadata, partialFailure)).toContain(
      '...(approvalResumeStart ? { approvalResumeVersion: approvalResumeStart.version } : {}),'
    )

    // The partial finalize joins its own half later. The empty writer receives the
    // frozen-prefix accounting join now, including the same resume version.
    const accountingMetadata = source.indexOf(
      '\n    const joinedFailureAccounting = isApprovalResumeWithoutUserTurn && approvalResumePrior\n' +
      '      ? mergeResumedMetadata(approvalResumePrior.metadata, failureRuntimeMetadata)\n' +
      '      : failureRuntimeMetadata\n',
      metadata
    )
    expect(accountingMetadata).toBeGreaterThan(metadata)
    expect(partialFailure).toBeGreaterThan(accountingMetadata)
    expect(source.slice(accountingMetadata, partialFailure)).toContain(
      "\n    const failureAccountingMetadata: Record<string, any> = { ...failureRuntimeMetadata }\n" +
      "    for (const key of ['usage', 'observedUsage'] as const) {\n" +
      '      if (Object.prototype.hasOwnProperty.call(joinedFailureAccounting, key)) {\n' +
      '        failureAccountingMetadata[key] = joinedFailureAccounting[key]\n'
    )
    const partialMetadata = source.indexOf('...failureRuntimeMetadata,', partialFailure)
    const emptyFailure = source.indexOf('metadata: { ...failureAccountingMetadata,', partialMetadata)
    expect(partialMetadata).toBeGreaterThan(partialFailure)
    expect(emptyFailure).toBeGreaterThan(partialMetadata)
  })

  it('marks every failure writer that can end an in-place resume', () => {
    const calls = source.split('await persistFailedAssistantTurn({').slice(1).map((call) => call.slice(0, 900))
    expect(calls).toHaveLength(6)
    const marked = calls.filter((call) => call.includes('inPlaceResume:'))
    // The stream handler's two writers (a failed early resume start, BL-775, and a failed
    // stream), and both POST-handler writers of a managed run. The fifth and sixth are a group
    // speaker's (a speaker deleted before its turn, BL-965; a failed speaker), which never
    // resume an approval in place.
    expect(marked).toHaveLength(4)
    expect(marked[0]).toContain('inPlaceResume: isApprovalResumeWithoutUserTurn,')
    marked.shift()
    expect(marked[0]).toContain('inPlaceResume: isApprovalResumeWithoutUserTurn,')
    // BL-523: the two POST writers name the run in progress, which is the resume only while the
    // FIRST run runs; a continuation or a promoted turn is a new message.
    // The `!ok` writer names the run whose result it holds; the catch names the run in progress
    // (none between runs).
    expect(marked[1]).toContain('inPlaceResume: lastRun.inPlaceResume,')
    expect(marked[1]).toContain('messageId: streamResult.messageId || lastRun.messageId,')
    expect(marked[2]).toContain('\n              messageId: runInProgress?.messageId,')
    expect(marked[2]).toContain('inPlaceResume: runInProgress?.inPlaceResume === true,')
    expect(source).toContain(
      'runInProgress = { messageId: managedAssistantMessageId,\n          inPlaceResume: managedRunIsInPlaceApprovalResume, steerIds: trustedFirstRunSteerIds }'
    )
    // BL-965: the record is read again after the run is named, so a failed read lands on it.
    expect(source).toContain('\n            runInProgress = { messageId: continuationMessageId, inPlaceResume: false }\n            // BL-965: this turn starts after the last one ended: the record as it is now.\n            agent = await readAgentRecordForFollowUpTurn(resolvedUserId, agentId)\n            streamResult = await handleBatshitAgentStream({')
    // A promoted turn, or (BL-455) the message held for the card the click answered.
    const promotedOwner = source.indexOf('runInProgress = { messageId: nextTurn.assistantMessageId, inPlaceResume: false, steerIds: nextTurn.steerIds }')
    const promotedRead = source.indexOf('agent = await readAgentRecordForFollowUpTurn(resolvedUserId, agentId)', promotedOwner)
    expect(promotedOwner).toBeGreaterThan(-1)
    expect(promotedRead).toBeGreaterThan(promotedOwner)
    expect(source.slice(promotedOwner, promotedRead)).toContain('await buildFollowUpMetadata(')
    expect(source.indexOf('streamResult = await handleBatshitAgentStream({', promotedRead)).toBeGreaterThan(promotedRead)
    // Every run is let go of as soon as it returns: three calls, three `runFinished(streamResult)`.
    expect(source.split('\n          runFinished(streamResult)\n').length - 1 + source.split('\n            runFinished(streamResult)\n').length - 1).toBe(3)
    // BL-455: a CLI Deny that answers the message held for its card runs a NEW turn.
    expect(source).toContain(
      'const managedRunIsInPlaceApprovalResume =\n          heldAnswerAfterDeny === null &&\n          isInPlaceApprovalResume({\n            approvalResponseCount: approvalResponseForStream.length,\n            content,\n            controlResumeContent: controlApprovalResumeContent,\n          })'
    )
  })
})

/**
 * BL-322: an approval resume is the paused call, CONTINUED (`approvalResumeReplay.ts`). It
 * compiles the paused turn's own message as the current message again, so the compiler builds
 * that turn's `<dynamic_info>`, and it replays every step the paused run took from the paused
 * message's stored record. The rules are tested in the module; these pins hold send-routed to
 * them and to the resume's other promise: it is not a new user turn, so it spends nothing a
 * new turn spends (no Judge Juice call, no memory commit, no clip countdown).
 */
describe('send-routed resumes the paused call, not a different one (BL-322)', () => {
  const handlerStart = source.indexOf('async function handleBatshitAgentStream({')
  const compileCall = source.indexOf('const formattedInput = await databaseService.buildFormattedChatInput(', handlerStart)

  it('finds the paused turn in the history and refuses a resume without one, before compiling', () => {
    const find = source.indexOf(
      'const pausedApprovalTurn = isApprovalResumeWithoutUserTurn\n    ? findPausedApprovalTurn(previousMessages, messageId)\n    : null',
      handlerStart,
    )
    expect(find).toBeGreaterThan(handlerStart)
    expect(find).toBeLessThan(compileCall)
    const refusal = source.indexOf("'APPROVAL_RESUME_TURN_MISSING'", find)
    expect(refusal).toBeGreaterThan(find)
    expect(refusal).toBeLessThan(compileCall)
    // The frozen record is read once, here, before the compile and before any resumed event.
    const frozen = source.indexOf('const approvalResumePrior = isApprovalResumeWithoutUserTurn', handlerStart)
    expect(frozen).toBeGreaterThan(-1)
    expect(frozen).toBeLessThan(find)
    expect(source.split('readStoredAssistantRecord(sessionId, messageId)').length - 1).toBe(2)
  })

  it("compiles the paused turn's history and message, with its sender, time, project, and files", () => {
    expect(source).toContain(
      'const historyForCompilation = pausedApprovalTurn\n    ? pausedApprovalTurn.history\n    : previousMessages',
    )
    expect(source).toContain(
      'const compileCurrentMessage = pausedApprovalTurn\n    ? pausedApprovalTurn.currentText\n    : messageForCompilation',
    )
    const call = source.slice(compileCall, source.indexOf('\n  )\n', compileCall))
    expect(call).toContain('    historyForCompilation,\n')
    expect(call).toContain('    compileCurrentMessage,\n')
    expect(call).toContain('pausedApprovalTurn\n        ? pausedApprovalTurn.projectPath')
    expect(call).toContain('pausedApprovalTurn\n        ? pausedApprovalTurn.fileReferences')
    expect(call).toContain('currentMessageAt: pausedApprovalTurn?.at ?? undefined,')
    expect(call).toContain('currentMessageFrom: pausedApprovalTurn\n        ? pausedApprovalTurn.from')
  })

  it('replays every earlier step from the frozen record, then the answer', () => {
    expect(source).not.toContain('function buildProviderContinuation(')
    expect(source).not.toContain('function extractProviderMessages(')
    expect(source).not.toContain('async function loadProviderMessagesForApprovalsFromRedis(')
    const replay = source.indexOf('const approvalResumeReplay = isApprovalResumeWithoutUserTurn\n    ? buildApprovalResumeReplay({\n        record: approvalResumePrior,')
    expect(replay).toBeGreaterThan(compileCall)
    const answer = source.indexOf('compiledMessages.push(...approvalResumeReplay, approvalResponseMessage)', replay)
    expect(answer).toBeGreaterThan(replay)
  })

  it('stores the whole replayable transcript, so a second card in the same reply replays the first run too', () => {
    const store = source.indexOf('replayableTranscript = buildReplayableTranscript({')
    expect(store).toBeGreaterThan(-1)
    const body = source.slice(store, store + 400)
    expect(body).toContain('replay: approvalResumeReplay,')
    expect(body).toContain('approvalResponse: approvalResponseMessage,')
    expect(body).toContain('steers: deliveredSteers,')
    const persisted = source.indexOf('sanitizeProviderMessagesForPersistence(replayableTranscript)', store)
    expect(persisted).toBeGreaterThan(store)
    expect(persisted - store).toBeLessThan(1600)
    expect(source).not.toContain('sanitizeProviderMessagesForPersistence(responseMessages)')
  })

  it('spends nothing a new turn spends: no Judge Juice call, no memory commit, no clip countdown', () => {
    // Every Judge Juice builder still reads the NEW user turn, which a resume does not have.
    expect(
      source.split("message: typeof messageForCompilation === 'string' ? messageForCompilation : '',").length - 1,
    ).toBe(5)
    expect(source).toContain('if (messageForCompilation && !groupContext) {')
    expect(source).toContain('if (consumeSessionClips && !isApprovalResumeWithoutUserTurn) {')
  })
})

/**
 * BL-321: the resume writes into the paused reply's Execution Viewer snapshot, and every write
 * of `intermediateSteps` used to REPLACE the list, so the steps the paused run took were gone
 * and the viewer rebuilt them from the provider trace as "Partial" rows after the later ones.
 */
describe('send-routed keeps the paused run’s steps in the Execution Viewer (BL-321)', () => {
  const handlerStart = source.indexOf('async function handleBatshitAgentStream({')
  const handlerEnd = source.indexOf('\nasync function ', handlerStart + 10)
  const handler = source.slice(handlerStart, handlerEnd)

  it('reads the paused steps before the resume records its own snapshot', () => {
    const read = handler.indexOf(
      'const approvalResumePriorSnapshot = isApprovalResumeWithoutUserTurn\n    ? await executionViewerService.getSnapshot(sessionId, messageId)\n    : null',
    )
    expect(handler).toContain(
      'const approvalResumePriorSteps = Array.isArray(approvalResumePriorSnapshot?.intermediateSteps)\n    ? approvalResumePriorSnapshot.intermediateSteps\n    : []',
    )
    const record = handler.indexOf('await executionViewerService.recordSnapshot({')
    expect(read).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(read)
    // The snapshot names the user's own words, not the empty click.
    expect(handler.slice(record, record + 400)).toContain(
      'userMessage: pausedApprovalTurn ? pausedApprovalTurn.currentText : content,',
    )
  })

  it('adds this run’s steps after them on every write', () => {
    const writes = handler.split(/await executionViewerService\.updateSnapshot\(sessionId, messageId, (?:withPriorRunAccounting\()?\{/).slice(1)
    const stepWrites = writes.filter((write) => write.slice(0, 900).includes('intermediateSteps:'))
    expect(stepWrites.length).toBe(4)
    for (const write of stepWrites) {
      const body = write.slice(0, 900)
      expect(body).toMatch(/intermediateSteps:\s*withPriorRunSteps\(/)
    }
  })
})

/**
 * BL-525: the resume's numbers used to REPLACE the paused half's: the snapshot's `responseSummary`,
 * `llmSummary`, `delegated`, and `executionMetadata.typesafeCalls`, so the Token Panel's running
 * cost dropped the first half and its Subagent spend. The merge rules are tested in
 * `approvalResumeMessage.test.ts`; these pin the wiring those tests cannot see.
 */
describe('send-routed counts both halves of a resumed reply (BL-525)', () => {
  const handlerStart = source.indexOf('async function handleBatshitAgentStream({')
  const handlerEnd = source.indexOf('\nasync function ', handlerStart + 10)
  const handler = source.slice(handlerStart, handlerEnd)

  it('continues every write of the run\u2019s numbers from the paused half\u2019s snapshot', () => {
    expect(handler).toContain(
      '\n  const withPriorRunAccounting = (patch: Partial<ExecutionSnapshot>): Partial<ExecutionSnapshot> =>\n    continueResumedSnapshotPatch(approvalResumePriorSnapshot, patch)\n',
    )
    // Each call's argument text, by balanced parentheses from its opening one.
    const calls: string[] = []
    for (let at = handler.indexOf('executionViewerService.updateSnapshot('); at !== -1; at = handler.indexOf('executionViewerService.updateSnapshot(', at + 1)) {
      const open = at + 'executionViewerService.updateSnapshot'.length
      let depth = 0
      let end = open
      for (; end < handler.length; end += 1) {
        if (handler[end] === '(') depth += 1
        if (handler[end] === ')' && --depth === 0) break
      }
      calls.push(handler.slice(open + 1, end))
    }
    const numberWrites = calls.filter((args) => /\b(responseSummary|llmSummary|delegated)\b/.test(args))
    // The CLI finish, the API finish, the raw-chunk backfill, the failure capture, and the
    // Stop/failure `delegated`.
    expect(numberWrites.length).toBe(5)
    for (const args of numberWrites) {
      expect(args.replace(/\s+/g, ' ').trim().startsWith('sessionId, messageId, withPriorRunAccounting(')).toBe(true)
    }
  })

  it('puts the paused half\u2019s Judge Juice rows before the resume records its snapshot', () => {
    const rows = handler.indexOf('\n    const typesafeCalls = withPriorTypesafeCalls(\n      approvalResumePriorSnapshot.executionMetadata?.typesafeCalls,\n      executionMetadata.typesafeCalls,\n    )\n    if (typesafeCalls.length > 0) executionMetadata.typesafeCalls = typesafeCalls\n')
    const record = handler.indexOf('await executionViewerService.recordSnapshot({')
    expect(rows).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(rows)
  })

  it('records `delegated` for a run the finish callback never reached (a Stop, a failure)', () => {
    expect(handler).toContain(
      // BL-1362: plus the Batshit runs Claude Code's own helper model started (accounting only).
      '\n    const failedRunDelegated = onFinishResolved\n      ? null\n      : buildDelegatedExecutionSummary([...streamedToolSteps, ...helperDelegatedSteps])\n',
    )
    expect(handler.split('\n          ...(failedRunDelegated ? { delegated: failedRunDelegated } : {}),\n').length - 1).toBe(2)
  })
})
