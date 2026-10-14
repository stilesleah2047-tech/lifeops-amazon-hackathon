/**
 * Unit tests for the deterministic meeting-aware recommender.
 *
 * These are PURE unit tests — no DB, no network, no model. They lock in the
 * “what can I finish before my next meeting?” behaviour and its determinism.
 */
import { describe, expect, it } from 'vitest';
import { recommendBeforeMeeting } from '../src/services/meetingPlanner.js';
import type { CalendarEvent, Task } from '../src/types/domain.js';

const BASE = '2026-10-09T09:00:00Z';
const now = () => new Date(BASE);

function mkTask(o: Partial<Task> & Pick<Task, 'id' | 'title' | 'estimatedMinutes'>): Task {
  return {
    id: o.id,
    userId: 'u',
    title: o.title,
    notes: null,
    priority: o.priority ?? 'medium',
    status: o.status ?? 'pending',
    dueDate: o.dueDate ?? null,
    estimatedMinutes: o.estimatedMinutes,
    createdAt: BASE,
    updatedAt: BASE,
    completedAt: o.completedAt ?? null,
  };
}

function mkEvent(
  o: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'title' | 'startAt' | 'endAt'>,
): CalendarEvent {
  return {
    id: o.id,
    userId: 'u',
    title: o.title,
    location: o.location ?? null,
    startAt: o.startAt,
    endAt: o.endAt,
    createdAt: BASE,
  };
}

describe('meetingPlanner: next-meeting selection', () => {
  it('anchors to the soonest UPCOMING event, ignoring past ones', () => {
    const res = recommendBeforeMeeting({
      now: now(),
      tasks: [],
      events: [
        mkEvent({ id: 'past', title: 'Past', startAt: '2026-10-09T08:00:00Z', endAt: '2026-10-09T08:30:00Z' }),
        mkEvent({ id: 'next', title: 'Standup', startAt: '2026-10-09T10:00:00Z', endAt: '2026-10-09T10:30:00Z' }),
        mkEvent({ id: 'later', title: 'Later', startAt: '2026-10-09T14:00:00Z', endAt: '2026-10-09T15:00:00Z' }),
      ],
    });
    expect(res.hasMeeting).toBe(true);
    expect(res.meeting?.id).toBe('next');
    expect(res.minutesUntilMeeting).toBe(60);
    expect(res.availableMinutes).toBe(60);
  });

  it('can anchor to an explicit meetingEventId', () => {
    const events = [
      mkEvent({ id: 'soon', title: 'Soon', startAt: '2026-10-09T09:30:00Z', endAt: '2026-10-09T10:00:00Z' }),
      mkEvent({ id: 'later', title: 'Later', startAt: '2026-10-09T11:00:00Z', endAt: '2026-10-09T12:00:00Z' }),
    ];
    expect(recommendBeforeMeeting({ now: now(), tasks: [], events, meetingEventId: 'later' }).meeting?.id).toBe('later');
  });

  it('falls back to the soonest meeting (with a warning) for an unknown id', () => {
    const events = [
      mkEvent({ id: 'soon', title: 'Soon', startAt: '2026-10-09T09:30:00Z', endAt: '2026-10-09T10:00:00Z' }),
    ];
    const res = recommendBeforeMeeting({ now: now(), tasks: [], events, meetingEventId: 'nope' });
    expect(res.meeting?.id).toBe('soon');
    expect(res.warnings.some((w) => /not an upcoming meeting/i.test(w))).toBe(true);
  });
});

describe('meetingPlanner: greedy fit before the meeting', () => {
  const events = [
    mkEvent({ id: 'm', title: 'Standup', startAt: '2026-10-09T10:00:00Z', endAt: '2026-10-09T10:30:00Z' }),
  ];
  const tasks = [
    mkTask({ id: 't-low', title: 'Low 20', estimatedMinutes: 20, priority: 'low' }),
    mkTask({ id: 't-high', title: 'High 30', estimatedMinutes: 30, priority: 'high' }),
    mkTask({ id: 't-med', title: 'Med 20', estimatedMinutes: 20, priority: 'medium' }),
    mkTask({ id: 't-med2', title: 'Med 15', estimatedMinutes: 15, priority: 'medium' }),
    mkTask({ id: 't-done', title: 'Done', estimatedMinutes: 10, status: 'completed' }),
  ];

  it('orders by shared urgency scorer and fits greedily inside the window', () => {
    const res = recommendBeforeMeeting({ now: now(), tasks, events });
    // high (30) + shorter medium (15) = 45 <= 60; the two 20-min tasks overflow.
    expect(res.beforeMeeting.map((t) => t.taskId)).toEqual(['t-high', 't-med2']);
    expect(res.committedMinutes).toBe(45);
    expect(res.afterMeeting.map((t) => t.taskId).sort()).toEqual(['t-low', 't-med']);
  });

  it('never recommends completed tasks', () => {
    const res = recommendBeforeMeeting({ now: now(), tasks, events });
    const all = [...res.beforeMeeting, ...res.afterMeeting, ...res.infeasible].map((t) => t.taskId);
    expect(all).not.toContain('t-done');
  });

  it('is deterministic (identical output on repeat)', () => {
    const a = recommendBeforeMeeting({ now: now(), tasks, events });
    const b = recommendBeforeMeeting({ now: now(), tasks, events });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never commits more minutes than are available', () => {
    const res = recommendBeforeMeeting({ now: now(), tasks, events });
    expect(res.committedMinutes).toBeLessThanOrEqual(res.availableMinutes);
  });
});

describe('meetingPlanner: edge cases', () => {
  it('flags a task that cannot fit even on its own as infeasible', () => {
    const events = [
      mkEvent({ id: 'm', title: 'Review', startAt: '2026-10-09T09:10:00Z', endAt: '2026-10-09T09:40:00Z' }),
    ];
    const tasks = [
      mkTask({ id: 'big', title: 'Big 30', estimatedMinutes: 30, priority: 'high' }),
      mkTask({ id: 'small', title: 'Small 5', estimatedMinutes: 5, priority: 'low' }),
    ];
    const res = recommendBeforeMeeting({ now: now(), tasks, events });
    expect(res.availableMinutes).toBe(10);
    expect(res.infeasible.map((t) => t.taskId)).toContain('big');
    expect(res.afterMeeting.map((t) => t.taskId)).toContain('big'); // infeasible also surfaced as “do later”
    expect(res.beforeMeeting.map((t) => t.taskId)).toContain('small');
  });

  it('respects a pre-meeting buffer that eats the whole window', () => {
    const events = [
      mkEvent({ id: 'm', title: 'Review', startAt: '2026-10-09T09:10:00Z', endAt: '2026-10-09T09:40:00Z' }),
    ];
    const tasks = [mkTask({ id: 'small', title: 'Small 5', estimatedMinutes: 5 })];
    const res = recommendBeforeMeeting({ now: now(), tasks, events, bufferMinutes: 15 });
    expect(res.availableMinutes).toBe(0);
    expect(res.beforeMeeting).toHaveLength(0);
    expect(res.warnings.some((w) => /buffer/i.test(w))).toBe(true);
  });

  it('handles no upcoming meeting by sending everything to “after”', () => {
    const events = [
      mkEvent({ id: 'past', title: 'Past', startAt: '2026-10-09T08:00:00Z', endAt: '2026-10-09T08:30:00Z' }),
    ];
    const tasks = [mkTask({ id: 'a', title: 'A', estimatedMinutes: 20 })];
    const res = recommendBeforeMeeting({ now: now(), tasks, events });
    expect(res.hasMeeting).toBe(false);
    expect(res.meeting).toBeNull();
    expect(res.afterMeeting.map((t) => t.taskId)).toEqual(['a']);
    expect(res.warnings.some((w) => /No upcoming meeting/i.test(w))).toBe(true);
  });

  it('parses timezone offsets as absolute instants', () => {
    // 12:00+02:00 == 10:00Z == 60 min after the 09:00Z “now”.
    const events = [
      mkEvent({ id: 'tz', title: 'TZ', startAt: '2026-10-09T12:00:00+02:00', endAt: '2026-10-09T13:00:00+02:00' }),
    ];
    expect(recommendBeforeMeeting({ now: now(), tasks: [], events }).minutesUntilMeeting).toBe(60);
  });
});
