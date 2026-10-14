/**
 * Deterministic planning engine.
 *
 * This is the reliability backbone of LifeOps. It NEVER fails, NEVER calls out
 * to a model, and produces a well-formed plan from tasks + events alone.
 *
 * Bedrock is layered on top of this (in bedrock.ts) — the AI reprioritises and
 * rewrites the summary in natural language, but if AI is unavailable the user
 * still gets a real, actionable plan. Time calculations, conflict detection,
 * and reminder timing are always done here in application code, never by the
 * model (per spec §35 — AI must not invent IDs or times).
 */
import type {
  CalendarEvent,
  DailyPlan,
  PlanBlock,
  Task,
} from '../types/domain.js';

export interface PlanInputs {
  userId: string;
  date: string;
  now: Date;
  /** Start of the planning window as HH:MM (local). Defaults to now if past this today. */
  windowStart?: string;
  /** End of the planning window as HH:MM (local). Defaults to 18:00. */
  windowEnd?: string;
  tasks: Task[];
  events: CalendarEvent[];
}

/** Parse an ISO datetime string into ms since epoch (falls back to 0 on garbage). */
const toMs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Compose an ISO datetime for `date` (YYYY-MM-DD) at HH:MM local. */
const isoOn = (date: string, hhmm: string): string => {
  const [h, m] = hhmm.split(':').map((s) => parseInt(s, 10));
  const d = new Date(`${date}T00:00:00`);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
};

const priorityWeight = (p: Task['priority']): number =>
  p === 'high' ? 100 : p === 'medium' ? 50 : 10;

/**
 * Score tasks by urgency: priority + overdue boost + short-fits-first.
 * Exported so other deterministic planners (e.g. the meeting-aware recommender)
 * order tasks identically — one source of truth for prioritisation.
 */
export const taskUrgencyScore = (t: Task, dateISO: string): number => {
  let s = priorityWeight(t.priority);
  if (t.dueDate) {
    if (t.dueDate < dateISO) s += 200; // overdue — front of the line
    else if (t.dueDate === dateISO) s += 60; // due today
  }
  // Slight nudge for tasks that fit in small gaps.
  if (t.estimatedMinutes <= 30) s += 5;
  return s;
};

/** @deprecated internal alias retained for readability within this module. */
const scoreTask = taskUrgencyScore;

/** Return sorted free intervals between events inside the window, in ms. */
export function computeFreeIntervals(
  windowStartMs: number,
  windowEndMs: number,
  events: CalendarEvent[]
): Array<{ start: number; end: number }> {
  const sorted = [...events]
    .map((e) => ({ s: toMs(e.startAt), e: toMs(e.endAt) }))
    .filter((e) => e.e > windowStartMs && e.s < windowEndMs)
    .sort((a, b) => a.s - b.s);

  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = windowStartMs;
  for (const ev of sorted) {
    if (ev.s > cursor) gaps.push({ start: cursor, end: Math.min(ev.s, windowEndMs) });
    cursor = Math.max(cursor, ev.e);
    if (cursor >= windowEndMs) break;
  }
  if (cursor < windowEndMs) gaps.push({ start: cursor, end: windowEndMs });
  return gaps.filter((g) => g.end - g.start >= 15 * 60_000); // ignore <15min gaps
}

/** Detect event↔event overlaps (calendar conflicts). */
export function detectConflicts(events: CalendarEvent[]): Array<[CalendarEvent, CalendarEvent]> {
  const sorted = [...events].sort((a, b) => toMs(a.startAt) - toMs(b.startAt));
  const conflicts: Array<[CalendarEvent, CalendarEvent]> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (toMs(b.startAt) < toMs(a.endAt)) conflicts.push([a, b]);
      else break;
    }
  }
  return conflicts;
}

/**
 * Build a day plan. The algorithm:
 *   1. Compute window [start,end] on the given date.
 *   2. Insert every event as a fixed block.
 *   3. Compute free gaps.
 *   4. Sort pending tasks by score (desc).
 *   5. Greedily fit tasks into gaps by estimatedMinutes.
 *   6. Attach human-readable reasons and warnings.
 */
export function buildDeterministicPlan(input: PlanInputs): DailyPlan {
  const windowStartLocal = input.windowStart ?? '09:00';
  const windowEndLocal = input.windowEnd ?? '18:00';

  const winStartISO = isoOn(input.date, windowStartLocal);
  const winEndISO = isoOn(input.date, windowEndLocal);
  let winStartMs = toMs(winStartISO);
  const winEndMs = toMs(winEndISO);

  // If planning today and the window has already begun, start from "now".
  const todayISO = input.now.toISOString().slice(0, 10);
  if (input.date === todayISO && input.now.getTime() > winStartMs) {
    winStartMs = input.now.getTime();
  }

  // Events are always shown if they end after "now" (or the day just started).
  // We do NOT hide past events just because the window shifted forward — the
  // user should still see what already happened / is currently happening.
  const nowMs = input.now.getTime();
  const eventBlocks: PlanBlock[] = input.events
    .filter((e) => {
      const start = toMs(e.startAt);
      const end = toMs(e.endAt);
      // Include events that overlap the day at all AND end at or after nowMs OR
      // fall inside the raw planning window.
      const overlapsWindow = end > toMs(winStartISO) && start < winEndMs;
      const stillRelevant = end >= nowMs - 30 * 60_000;
      return overlapsWindow || stillRelevant;
    })
    .map((e) => ({
      startAt: e.startAt,
      endAt: e.endAt,
      kind: 'event',
      title: e.title,
      eventId: e.id,
      reason: e.location ? `Scheduled at ${e.location}` : 'Scheduled calendar event',
    }));

  // Compute gaps against the (possibly shifted) window. If the window has been
  // exhausted, gaps will be empty — the caller sees a warning below.
  const gaps =
    winStartMs < winEndMs ? computeFreeIntervals(winStartMs, winEndMs, input.events) : [];

  const pending = input.tasks
    .filter((t) => t.status === 'pending')
    .sort((a, b) => scoreTask(b, input.date) - scoreTask(a, input.date));

  const taskBlocks: PlanBlock[] = [];
  const unplaced: Task[] = [];
  const gapsRemaining = gaps.map((g) => ({ ...g }));

  for (const task of pending) {
    const need = Math.max(15, task.estimatedMinutes) * 60_000;
    const gap = gapsRemaining.find((g) => g.end - g.start >= need);
    if (!gap) {
      unplaced.push(task);
      continue;
    }
    const start = gap.start;
    const end = start + need;
    taskBlocks.push({
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      kind: 'task',
      title: task.title,
      taskId: task.id,
      reason: reasonForTask(task, input.date),
    });
    gap.start = end + 5 * 60_000; // insert a 5-minute buffer
  }

  const blocks = [...eventBlocks, ...taskBlocks].sort(
    (a, b) => toMs(a.startAt) - toMs(b.startAt)
  );

  const warnings: string[] = [];
  const conflicts = detectConflicts(input.events);
  for (const [a, b] of conflicts) {
    warnings.push(`Calendar conflict: "${a.title}" overlaps "${b.title}".`);
  }
  if (unplaced.length > 0) {
    warnings.push(
      `${unplaced.length} task${unplaced.length === 1 ? '' : 's'} could not be placed in the available window.`
    );
  }
  if (winStartMs >= winEndMs && pending.length > 0) {
    warnings.push(
      'The planning window for this date has already passed — pending tasks will roll to the next day.'
    );
  }

  const summary = buildDeterministicSummary(blocks, unplaced, conflicts.length);

  return {
    userId: input.userId,
    date: input.date,
    blocks,
    summary,
    warnings,
    generatedBy: 'deterministic',
  };
}

function reasonForTask(task: Task, dateISO: string): string {
  if (task.dueDate && task.dueDate < dateISO) return 'Overdue — pulled forward first.';
  if (task.dueDate === dateISO) return 'Due today.';
  if (task.priority === 'high') return 'High priority — scheduled early.';
  if (task.priority === 'medium') return 'Fits available focus block.';
  return 'Low-priority filler.';
}

function buildDeterministicSummary(
  blocks: PlanBlock[],
  unplaced: Task[],
  conflicts: number
): string {
  const taskCount = blocks.filter((b) => b.kind === 'task').length;
  const eventCount = blocks.filter((b) => b.kind === 'event').length;
  const parts: string[] = [];
  if (taskCount === 0 && eventCount === 0) {
    parts.push('Your window is clear — a good time to rest or plan ahead.');
  } else {
    parts.push(
      `Planned ${taskCount} task${taskCount === 1 ? '' : 's'} around ${eventCount} scheduled event${eventCount === 1 ? '' : 's'}.`
    );
  }
  if (conflicts > 0) parts.push(`Watch out for ${conflicts} calendar conflict${conflicts === 1 ? '' : 's'}.`);
  if (unplaced.length > 0) {
    parts.push(
      `${unplaced.length} task${unplaced.length === 1 ? '' : 's'} did not fit and rolls over.`
    );
  }
  return parts.join(' ');
}
