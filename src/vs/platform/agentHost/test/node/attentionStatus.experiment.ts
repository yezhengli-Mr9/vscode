/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdir, writeFile } from 'fs/promises';
import { timeout } from '../../../../base/common/async.js';
import { NullLogService } from '../../../log/common/log.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import { ActionType, NotificationType } from '../../common/state/sessionActions.js';
import { buildDefaultChatUri, ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, SessionStatus, ToolCallConfirmationReason } from '../../common/state/sessionState.js';
import { chatToolCallReady, chatToolCallStart, chatTurnStarted } from '../common/chatActionBuilders.js';

const phase = process.env.ATTENTION_PHASE;
assert.ok(phase === 'before' || phase === 'after');
const manager = new AgentHostStateManager(new NullLogService());
const sessions = [
	{ resource: 'copilot:/approval', title: 'Tool approval experiment' },
	{ resource: 'copilot:/question', title: 'Answered question experiment' },
	{ resource: 'copilot:/genuine', title: 'Unanswered question (control)' },
	{ resource: 'copilot:/busy', title: 'Continuous background activity' },
];
const displayed = new Map<string, SessionStatus>();
const statusEvents: { resource: string; elapsed: number; status: SessionStatus }[] = [];
let startedAt: number | undefined;
const listener = manager.onDidEmitNotification(notification => {
	if (notification.type === NotificationType.SessionAdded) {
		displayed.set(notification.summary.resource, notification.summary.status);
	} else if (notification.type === NotificationType.SessionSummaryChanged && notification.changes.status !== undefined) {
		displayed.set(notification.session, notification.changes.status);
		if (startedAt !== undefined) {
			statusEvents.push({ resource: notification.session, elapsed: Date.now() - startedAt, status: notification.changes.status });
		}
	}
});
try {
	for (const session of sessions) {
		const now = new Date().toISOString();
		manager.createSession({ ...session, provider: 'copilot', status: SessionStatus.Idle, createdAt: now, modifiedAt: now });
		manager.dispatchServerAction(buildDefaultChatUri(session.resource), chatTurnStarted('turn-1', 'Run the controlled experiment'));
	}
	const approvalChat = buildDefaultChatUri(sessions[0].resource);
	manager.dispatchServerAction(approvalChat, chatToolCallStart('turn-1', 'tool-1', 'write', 'Write'));
	manager.dispatchServerAction(approvalChat, chatToolCallReady('turn-1', 'tool-1', 'Write file', { confirmationTitle: 'Write file?' }));
	for (const session of sessions.slice(1, 3)) {
		manager.dispatchServerAction(buildDefaultChatUri(session.resource), {
			type: ActionType.ChatInputRequested,
			request: { id: 'question-1', questions: [{ kind: ChatInputQuestionKind.Text, id: 'value', message: 'Which value?' }] },
		});
	}
	await timeout(160);
	const snapshot = (state: string) => ({
		state,
		elapsed: startedAt === undefined ? 0 : Date.now() - startedAt,
		sessions: sessions.map(session => ({
			...session, displayedStatus: displayed.get(session.resource),
			actualStatus: manager.getSessionSummary(session.resource)?.status,
		})),
	});
	const snapshots = [snapshot('pending')];
	assert.deepStrictEqual(snapshots[0].sessions.map(session => session.displayedStatus), [
		SessionStatus.InputNeeded, SessionStatus.InputNeeded, SessionStatus.InputNeeded, SessionStatus.InProgress,
	]);
	startedAt = Date.now();
	manager.dispatchServerAction(approvalChat, {
		type: ActionType.ChatToolCallConfirmed, turnId: 'turn-1', toolCallId: 'tool-1',
		approved: true, confirmed: ToolCallConfirmationReason.UserAction,
	});
	manager.dispatchServerAction(buildDefaultChatUri(sessions[1].resource), {
		type: ActionType.ChatInputCompleted, requestId: 'question-1', response: ChatInputResponseKind.Accept,
		answers: { value: { state: ChatInputAnswerState.Submitted, value: { kind: ChatInputAnswerValueKind.Text, value: 'Use the test value' } } },
	});
	for (let update = 0; update < 20; update++) {
		await timeout(40);
		manager.dispatchServerAction(sessions[3].resource, { type: ActionType.SessionTitleChanged, title: `Activity ${update}` });
	}
	snapshots.push(snapshot('answered-while-busy'));
	assert.deepStrictEqual(snapshots[1].sessions.map(session => session.actualStatus), [
		SessionStatus.InProgress, SessionStatus.InProgress, SessionStatus.InputNeeded, SessionStatus.InProgress,
	]);
	assert.deepStrictEqual(snapshots[1].sessions.map(session => session.displayedStatus), phase === 'before'
		? [SessionStatus.InputNeeded, SessionStatus.InputNeeded, SessionStatus.InputNeeded, SessionStatus.InProgress]
		: [SessionStatus.InProgress, SessionStatus.InProgress, SessionStatus.InputNeeded, SessionStatus.InProgress]);
	if (phase === 'after') {
		assert.ok(statusEvents.filter(event => event.status === SessionStatus.InProgress).every(event => event.elapsed <= 220));
	}
	await mkdir('screenshots', { recursive: true });
	await writeFile(`screenshots/${phase}-trace.json`, JSON.stringify({ phase, statusEvents, snapshots }, null, 2));
	console.log(JSON.stringify({ phase, statusEvents, snapshots }, null, 2));
} finally {
	listener.dispose();
	manager.dispose();
}
