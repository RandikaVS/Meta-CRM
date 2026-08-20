import { describe, expect, it } from 'vitest';
import {
  addMinutes,
  durationMinutes,
  formatConflictMessage,
  rangesOverlap,
  SchedulingError,
  validateTimeRange,
} from './scheduling';

describe('rangesOverlap', () => {
  it('is true when ranges genuinely overlap', () => {
    expect(
      rangesOverlap(
        { start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' },
        { start: '2026-01-01T10:30:00Z', end: '2026-01-01T11:30:00Z' },
      ),
    ).toBe(true);
  });

  it('is false for back-to-back ranges (half-open, matches the DB EXCLUDE constraint)', () => {
    expect(
      rangesOverlap(
        { start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' },
        { start: '2026-01-01T11:00:00Z', end: '2026-01-01T11:30:00Z' },
      ),
    ).toBe(false);
  });

  it('is false for ranges that do not touch at all', () => {
    expect(
      rangesOverlap(
        { start: '2026-01-01T09:00:00Z', end: '2026-01-01T09:30:00Z' },
        { start: '2026-01-01T11:00:00Z', end: '2026-01-01T11:30:00Z' },
      ),
    ).toBe(false);
  });

  it('is true when one range fully contains the other', () => {
    expect(
      rangesOverlap(
        { start: '2026-01-01T09:00:00Z', end: '2026-01-01T12:00:00Z' },
        { start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:30:00Z' },
      ),
    ).toBe(true);
  });
});

describe('addMinutes / durationMinutes', () => {
  it('round-trips: addMinutes then durationMinutes recovers the original delta', () => {
    const start = '2026-01-01T10:00:00Z';
    const end = addMinutes(start, 45);
    expect(durationMinutes(start, end)).toBe(45);
  });

  it('durationMinutes never goes negative for an inverted range', () => {
    expect(durationMinutes('2026-01-01T11:00:00Z', '2026-01-01T10:00:00Z')).toBe(0);
  });
});

describe('validateTimeRange', () => {
  it('accepts a valid forward range', () => {
    expect(() =>
      validateTimeRange('2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'),
    ).not.toThrow();
  });

  it('rejects end <= start', () => {
    expect(() =>
      validateTimeRange('2026-01-01T11:00:00Z', '2026-01-01T11:00:00Z'),
    ).toThrow(SchedulingError);
    expect(() =>
      validateTimeRange('2026-01-01T11:00:00Z', '2026-01-01T10:00:00Z'),
    ).toThrow(SchedulingError);
  });

  it('rejects unparseable dates', () => {
    expect(() => validateTimeRange('not-a-date', '2026-01-01T11:00:00Z')).toThrow(
      SchedulingError,
    );
  });
});

describe('formatConflictMessage', () => {
  it('names the staff member and the conflicting window', () => {
    const msg = formatConflictMessage('Sarah', {
      start: '2026-01-01T11:30:00Z',
      end: '2026-01-01T12:30:00Z',
    });
    expect(msg).toContain('Sarah');
    expect(msg).toContain('already booked from');
  });
});
