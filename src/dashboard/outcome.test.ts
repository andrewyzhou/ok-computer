import { describe, expect, it } from 'vitest';
import { outcomeOf, type OutcomeInput } from './outcome.js';

const decision = (fields: Partial<NonNullable<OutcomeInput['decision']>> = {}) => ({
  decision: 'allow',
  reviewerVerdict: null,
  approvalId: null,
  approvalStatus: null,
  ...fields,
});
const call = (fields: Partial<OutcomeInput> = {}): OutcomeInput => ({
  toolCallId: 'c1',
  isError: false,
  stored: null,
  riskLevel: 'read',
  decision: decision(),
  ...fields,
});

describe('outcomeOf', () => {
  it.each<[string, OutcomeInput, string]>([
    ['an allowed call that worked', call(), 'ran'],
    ['an allowed call that returned an error', call({ isError: true }), 'failed'],
    ['an unknown tool or bad input', call({ isError: true, riskLevel: null, decision: null }), 'invalid'],
    ['a failed policy check', call({ isError: true, decision: null }), 'failed'],
    ['a row from before the policy existed', call({ riskLevel: null, decision: null }), 'ran'],
    ['a deny rule', call({ isError: true, decision: decision({ decision: 'deny' }) }), 'denied'],
    ['a reviewer hold', call({ isError: true, decision: decision({ decision: 'review', reviewerVerdict: 'hold' }) }), 'held'],
    ['a reviewer allow', call({ decision: decision({ decision: 'review', reviewerVerdict: 'allow' }) }), 'ran'],
    ['an approval that waits', call({ decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'pending' }) }), 'waiting'],
    ['a review that the owner decides', call({ decision: decision({ decision: 'review', approvalId: 1, approvalStatus: 'pending' }) }), 'waiting'],
    ['an approved request', call({ decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'approved' }) }), 'approved'],
    ['a declined request', call({ decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'denied' }) }), 'declined'],
    ['an expired request', call({ decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'expired' }) }), 'expired'],
    ['the run after an approval', call({ toolCallId: 'approval-1', decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'approved' }) }), 'ran'],
    ['a failed run after an approval', call({ toolCallId: 'approval-1', isError: true, decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'approved' }) }), 'failed'],
    ['an approval request that failed', call({ isError: true, decision: decision({ decision: 'approve' }) }), 'failed'],
    ['an abandoned call', call({ isError: true, stored: 'abandoned' }), 'abandoned'],
    ['a late call', call({ stored: 'late' }), 'late'],
    ['an interrupted call', call({ isError: true, stored: 'interrupted' }), 'interrupted'],
    ['an interrupted run after an approval', call({ toolCallId: 'approval-1', isError: true, stored: 'interrupted', decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'approved' }) }), 'interrupted'],
    ['an approved call that its integration did not send', call({ toolCallId: 'approval-1', isError: true, stored: 'unsent', decision: decision({ decision: 'approve', approvalId: 1, approvalStatus: 'pending' }) }), 'unsent'],
  ])('%s', (_name, input, expected) => {
    expect(outcomeOf(input)).toBe(expected);
  });

  it('never calls a held or waiting call ran', () => {
    for (const approvalStatus of ['pending', 'denied', 'expired', 'approved']) {
      expect(outcomeOf(call({ decision: decision({ decision: 'approve', approvalId: 1, approvalStatus }) }))).not.toBe('ran');
    }
    expect(outcomeOf(call({ decision: decision({ decision: 'review', reviewerVerdict: 'hold' }) }))).not.toBe('ran');
  });
});
