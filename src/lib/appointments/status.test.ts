import { describe, expect, it } from 'vitest';
import { canTransitionStatus, isTerminalStatus, nextStatusOptions } from './status';

describe('canTransitionStatus', () => {
  it('allows the normal forward lifecycle', () => {
    expect(canTransitionStatus('scheduled', 'confirmed', false)).toBe(true);
    expect(canTransitionStatus('confirmed', 'checked_in', false)).toBe(true);
    expect(canTransitionStatus('checked_in', 'in_progress', false)).toBe(true);
  });

  it('never allows completed as a target — that always goes through complete_appointment', () => {
    expect(canTransitionStatus('scheduled', 'completed', true)).toBe(false);
    expect(canTransitionStatus('in_progress', 'completed', true)).toBe(false);
  });

  it('allows cancelling from anywhere reachable, agent-tier', () => {
    expect(canTransitionStatus('scheduled', 'cancelled', false)).toBe(true);
    expect(canTransitionStatus('confirmed', 'cancelled', false)).toBe(true);
    expect(canTransitionStatus('checked_in', 'cancelled', false)).toBe(true);
  });

  it('requires admin to void a completed appointment', () => {
    expect(canTransitionStatus('completed', 'cancelled', false)).toBe(false);
    expect(canTransitionStatus('completed', 'cancelled', true)).toBe(true);
  });

  it('requires admin to reopen a cancelled appointment', () => {
    expect(canTransitionStatus('cancelled', 'scheduled', false)).toBe(false);
    expect(canTransitionStatus('cancelled', 'scheduled', true)).toBe(true);
  });

  it('rejects a no-op transition to the same status', () => {
    expect(canTransitionStatus('scheduled', 'scheduled', true)).toBe(false);
  });

  it('rejects an unreachable transition (in_progress cannot go back to scheduled)', () => {
    expect(canTransitionStatus('in_progress', 'scheduled', true)).toBe(false);
  });
});

describe('nextStatusOptions', () => {
  it('excludes admin-only transitions for a non-admin caller', () => {
    expect(nextStatusOptions('completed', false)).toEqual([]);
    expect(nextStatusOptions('completed', true)).toEqual(['cancelled']);
  });

  it('lists every non-admin-gated forward option for a scheduled appointment', () => {
    expect(nextStatusOptions('scheduled', false)).toEqual([
      'confirmed',
      'checked_in',
      'in_progress',
      'cancelled',
      'no_show',
    ]);
  });
});

describe('isTerminalStatus', () => {
  it('is true for completed and cancelled', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });
  it('is false for everything still in flight', () => {
    expect(isTerminalStatus('scheduled')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
  });
});
