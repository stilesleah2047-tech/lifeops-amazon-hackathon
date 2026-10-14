// Shared types for the SPA. Matches the BFF response shape which mirrors
// the MCP tool structured content.

export type Priority = 'low' | 'medium' | 'high';
export type TaskStatus = 'pending' | 'completed' | 'cancelled';

export interface Task {
  id: string;
  userId: string;
  title: string;
  notes: string | null;
  priority: Priority;
  status: TaskStatus;
  dueDate: string | null;
  estimatedMinutes: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CalendarEvent {
  id: string;
  userId: string;
  title: string;
  location: string | null;
  startAt: string;
  endAt: string;
}

export interface Reminder {
  id: string;
  userId: string;
  title: string;
  notes: string | null;
  remindAt: string;
  status: 'scheduled' | 'fired' | 'cancelled';
  relatedTaskId: string | null;
  relatedEventId: string | null;
}

export interface PlanBlock {
  startAt: string;
  endAt: string;
  kind: 'task' | 'event' | 'break';
  title: string;
  reason: string;
  taskId?: string;
  eventId?: string;
}

export interface DailyPlan {
  userId: string;
  date: string;
  blocks: PlanBlock[];
  summary: string;
  warnings: string[];
  generatedBy: 'bedrock' | 'deterministic';
}

export interface Insights {
  date: string;
  overdueTasks: Task[];
  freeMinutes: number;
  pendingMinutes: number;
  overloaded: boolean;
  freePeriods: Array<{ startAt: string; endAt: string; minutes: number }>;
  highlights: string[];
}

export interface DaySummary {
  date: string;
  completed: Task[];
  pending: Task[];
  upcoming: CalendarEvent[];
  reminders: Reminder[];
  summary: string;
}

export interface ActivityEntry {
  tool: string;
  ok: boolean;
  ms: number;
  message: string;
}

export interface TodayResponse {
  userId: string;
  tasks: { tasks: Task[]; count: number };
  schedule: { events: CalendarEvent[]; count: number };
  insights: Insights;
  summary: DaySummary;
  activity: ActivityEntry[];
}

export type AskResult =
  | { kind: 'plan'; plan: { plan: DailyPlan }; tasks: unknown; schedule: unknown; insights: Insights }
  | { kind: 'reminder'; reminder: { reminder: Reminder }; anchoredTo: CalendarEvent }
  | { kind: 'summary'; summary: DaySummary }
  | { kind: 'meeting'; recommendation: MeetingRecommendation }
  | {
      kind: 'agent';
      mode: 'bedrock';
      text: string;
      toolCalls: Array<{ name: string; ok: boolean; message: string }>;
      proposedActions: Array<{ tool: string; reason: string }>;
      iterations: number;
    }
  | { kind: 'error'; message: string };

/** Deterministic “finish before my meeting” recommendation (mirror of server). */
export interface MeetingRecommendation {
  hasMeeting: boolean;
  meeting: { id: string; title: string; startAt: string; endAt: string; location: string | null } | null;
  minutesUntilMeeting: number | null;
  availableMinutes: number;
  beforeMeeting: RecommendedTask[];
  afterMeeting: RecommendedTask[];
  infeasible: RecommendedTask[];
  committedMinutes: number;
  warnings: string[];
  summary: string;
  generatedBy: 'deterministic';
}

export interface RecommendedTask {
  taskId: string;
  title: string;
  priority: Priority;
  estimatedMinutes: number;
  dueDate: string | null;
  reason: string;
}

/** How the BFF produced the answer. Surfaced in the UI, truthfully. */
export type AskMode =
  | 'bedrock'
  | 'deterministic'
  | 'deterministic-meeting'
  | 'deterministic-fallback';

export interface AskResponse {
  prompt: string;
  result: AskResult;
  activity: ActivityEntry[];
  mode: AskMode;
  /** Present only when mode === 'deterministic-fallback'. */
  fallbackReason?: string;
}

// ---------- API client ----------

const base = ''; // Vite dev proxies /api → BFF; in prod the BFF serves everything.

// Optional shared write token. WRITE routes (/api/ask when it creates a
// reminder, /api/tasks/:id/complete) are gated server-side; when the operator
// has enabled writes they expose the token to this build via
// VITE_LIFEOPS_WRITE_TOKEN so the UI can authorize them. When unset, write
// actions are refused by the server (read-only demo) — which is the safe
// default. NOTE: a token shipped to the browser is visible to end users; it
// gates casual/cross-site abuse, it is NOT per-user authentication.
const WRITE_TOKEN =
  (import.meta.env.VITE_LIFEOPS_WRITE_TOKEN as string | undefined)?.trim() || '';
const writeAuthHeaders: Record<string, string> = WRITE_TOKEN
  ? { Authorization: `Bearer ${WRITE_TOKEN}` }
  : {};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  today(userId = 'demo-user') {
    return json<TodayResponse>(`/api/today?userId=${encodeURIComponent(userId)}`);
  },
  ask(prompt: string, userId = 'demo-user') {
    return json<AskResponse>('/api/ask', {
      method: 'POST',
      headers: writeAuthHeaders,
      body: JSON.stringify({ prompt, userId }),
    });
  },
  completeTask(taskId: string, userId = 'demo-user') {
    return json<{ result: { task: Task; alreadyCompleted: boolean }; activity: ActivityEntry[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/complete`,
      { method: 'POST', headers: writeAuthHeaders, body: JSON.stringify({ userId }) }
    );
  },
};
