/**
 * Deterministic MEETING-AWARE task recommender.
 *
 * Answers the question “what should I realistically finish before my next
 * meeting?” using nothing but the user's tasks, their calendar events, and the
 * current instant. Like planner.ts it is PURE and DETERMINISTIC:
 *   - no model calls, no I/O, no randomness, no hidden clock reads;
 *   - every time calculation is done here in application code (per spec §35 —
 *     the model must never invent times, IDs, or “fit” decisions);
 *   - identical inputs always produce identical output.
 *
 * Task ordering reuses `taskUrgencyScore` from planner.ts so the meeting view
 * and the daily plan agree on what “most important” means (one source of truth).
 *
 * Timezone handling: all comparisons are done on absolute epoch milliseconds
 * (via Date.parse, which honours the offset / `Z` embedded in each ISO
 * string), so results are correct regardless of the server's local timezone.
 * The caller passes `now` explicitly, which also makes the function trivial to
 * unit-test with a frozen clock.
 */
import type { CalendarEvent, Task } from '../types/domain.js';
import { taskUrgencyScore } from './planner.js';

export interface MeetingRecommendationInput {
  /** The reference instant (“now”). Passed in for deterministic testing. */
  now: Date;
  /** All of the user's tasks. Only `pending` tasks are considered. */
  tasks: Task[];
  /** The user's calendar events (treated as “meetings”). */
  events: CalendarEvent[];
  /**
   * Minutes of buffer to leave untouched immediately before the meeting
   * (e.g. to grab coffee / join the call). Defaults to 0.
   */
  bufferMinutes?: number;
  /**
   * Anchor the recommendation to a specific event id instead of the next
   * upcoming one. If the id is unknown the next upcoming meeting is used.
   */
  meetingEventId?: string;
}

export interface RecommendedTask {
  taskId: string;
  title: string;
  priority: Task['priority'];
  estimatedMinutes: number;
  dueDate: string | null;
  /** Human-readable, deterministic explanation shown in the UI. */
  reason: string;
}

export interface MeetingRecommendation {
  /** True when there is an upcoming meeting to anchor to. */
  hasMeeting: boolean;
  /** The meeting we planned around (null when none upcoming). */
  meeting:
    | { id: string; title: string; startAt: string; endAt: string; location: string | null }
    | null;
  /** Whole minutes from `now` until the meeting starts (null when none). */
  minutesUntilMeeting: number | null;
  /** Usable minutes before the meeting after subtracting the buffer (>= 0). */
  availableMinutes: number;
  /** Tasks that fit, in the order they should be tackled. */
  beforeMeeting: RecommendedTask[];
  /** Pending tasks that do not fit the available window (do them later). */
  afterMeeting: RecommendedTask[];
  /** Tasks that cannot fit even on their own (too long for the window). */
  infeasible: RecommendedTask[];
  /** Total estimated minutes of the `beforeMeeting` set. */
  committedMinutes: number;
  /** Non-fatal advisories (no meeting, window too tight, etc.). */
  warnings: string[];
  /** One-line deterministic summary of the recommendation. */
  summary: string;
  /** Always 'deterministic' — proves no model produced this. */
  generatedBy: 'deterministic';
}

const toMs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};

const toRecommended = (t: Task, reason: string): RecommendedTask => ({
  taskId: t.id,
  title: t.title,
  priority: t.priority,
  estimatedMinutes: t.estimatedMinutes,
  dueDate: t.dueDate,
  reason,
});

/** Local YYYY-MM-DD for the given instant (used for the due-date scorer). */
const localDateISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * Compute a deterministic “finish before my meeting” recommendation.
 */
export function recommendBeforeMeeting(
  input: MeetingRecommendationInput,
): MeetingRecommendation {
  const { now, tasks, events } = input;
  const bufferMinutes = Math.max(0, Math.floor(input.bufferMinutes ?? 0));
  const nowMs = now.getTime();
  const warnings: string[] = [];

  // 1) Candidate meetings = events that have not started yet, soonest first.
  const upcoming = events
    .filter((e) => {
      const ms = toMs(e.startAt);
      return Number.isFinite(ms) && ms > nowMs;
    })
    .sort((a, b) => toMs(a.startAt) - toMs(b.startAt));

  let meeting: CalendarEvent | undefined;
  if (input.meetingEventId) {
    meeting = upcoming.find((e) => e.id === input.meetingEventId);
    if (!meeting) {
      warnings.push(
        `Event ${input.meetingEventId} is not an upcoming meeting; using the next one instead.`,
      );
    }
  }
  if (!meeting) meeting = upcoming[0];

  // 2) Pending tasks only, ordered by shared urgency scorer (desc), then by
  //    shorter-first and finally id for a fully stable sort.
  const dateISO = localDateISO(now);
  const pending = tasks
    .filter((t) => t.status === 'pending')
    .map((t) => ({
      t,
      score: taskUrgencyScore(t, dateISO),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.t.estimatedMinutes - b.t.estimatedMinutes ||
        (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0),
    )
    .map((x) => x.t);

  // 3) No upcoming meeting — nothing to race against.
  if (!meeting) {
    warnings.push('No upcoming meeting found; nothing to finish “before” one.');
    return {
      hasMeeting: false,
      meeting: null,
      minutesUntilMeeting: null,
      availableMinutes: 0,
      beforeMeeting: [],
      afterMeeting: pending.map((t) =>
        toRecommended(t, 'No meeting to beat — schedule this whenever you can.'),
      ),
      infeasible: [],
      committedMinutes: 0,
      warnings,
      summary:
        pending.length === 0
          ? 'No upcoming meeting and no pending tasks — you are all clear.'
          : `No upcoming meeting; ${pending.length} pending task${
              pending.length === 1 ? '' : 's'
            } to tackle at your own pace.`,
      generatedBy: 'deterministic',
    };
  }

  const minutesUntilMeeting = Math.max(
    0,
    Math.floor((toMs(meeting.startAt) - nowMs) / 60000),
  );
  const availableMinutes = Math.max(0, minutesUntilMeeting - bufferMinutes);

  if (availableMinutes === 0) {
    warnings.push(
      bufferMinutes > 0
        ? `Only ${minutesUntilMeeting} min until “${meeting.title}” — inside your ${bufferMinutes}-min buffer, so no room to start anything.`
        : `“${meeting.title}” is starting now — no time to start a task first.`,
    );
  }

  // 4) Greedy fit against the available window.
  const beforeMeeting: RecommendedTask[] = [];
  const afterMeeting: RecommendedTask[] = [];
  const infeasible: RecommendedTask[] = [];
  let committedMinutes = 0;

  for (const t of pending) {
    const est = Math.max(1, t.estimatedMinutes);
    if (est > availableMinutes) {
      // Can't fit even on its own in the window before the meeting.
      const rec = toRecommended(
        t,
        `Needs ~${est} min but only ${availableMinutes} min before “${meeting.title}” — do it after.`,
      );
      infeasible.push(rec);
      afterMeeting.push(rec);
      continue;
    }
    if (committedMinutes + est <= availableMinutes) {
      committedMinutes += est;
      beforeMeeting.push(
        toRecommended(
          t,
          `~${est} min — fits before “${meeting.title}” (${committedMinutes}/${availableMinutes} min used).`,
        ),
      );
    } else {
      afterMeeting.push(
        toRecommended(
          t,
          `Would overflow the ${availableMinutes}-min window before “${meeting.title}” — do it after.`,
        ),
      );
    }
  }

  if (beforeMeeting.length === 0 && pending.length > 0 && availableMinutes > 0) {
    warnings.push(
      `No pending task fits in the ${availableMinutes} min before “${meeting.title}”.`,
    );
  }

  const summary =
    beforeMeeting.length > 0
      ? `You have ${availableMinutes} min before “${meeting.title}” — you can finish ${
          beforeMeeting.length
        } task${beforeMeeting.length === 1 ? '' : 's'} (${committedMinutes} min).`
      : pending.length === 0
        ? `Nothing pending before “${meeting.title}” — you are ready.`
        : `No pending task fits the ${availableMinutes} min before “${meeting.title}” — tackle them afterwards.`;

  return {
    hasMeeting: true,
    meeting: {
      id: meeting.id,
      title: meeting.title,
      startAt: meeting.startAt,
      endAt: meeting.endAt,
      location: meeting.location,
    },
    minutesUntilMeeting,
    availableMinutes,
    beforeMeeting,
    afterMeeting,
    infeasible,
    committedMinutes,
    warnings,
    summary,
    generatedBy: 'deterministic',
  };
}
