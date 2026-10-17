import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ActivityEntry,
  type AskResponse,
  type TodayResponse,
  type DailyPlan,
  type PlanBlock,
  type Priority,
  type Task,
  type CalendarEvent,
  type Reminder,
  type Insights,
  type DaySummary,
} from './api';

/** Result of a reminder-create attempt, surfaced to the Reminders view. */
type ReminderCreateOutcome = { ok: boolean; message: string };

/* -------------------------------------------------------------------------- */
/* helpers + icons                                                             */
/* -------------------------------------------------------------------------- */

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '\u2014';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PATHS: Record<string, string> = {
  today: 'M3 9.5 12 3l9 6.5V21H3z',
  calendar: 'M3 9h18M8 2v4M16 2v4|RECT',
  tasks: 'M9 11l3 3 8-8|M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11',
  reminders: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9|M13.7 21a2 2 0 0 1-3.4 0',
  insights: 'M3 3v18h18|m7 14 3-3 3 3 5-6',
  settings: 'CIRCLE|M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0a1.6 1.6 0 0 0-2.4-1.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4a1.6 1.6 0 0 0 1.5-2.7l-.1-.1A2 2 0 1 1 8.7 5.4l.1.1A1.6 1.6 0 0 0 11 4.6V4.5a2 2 0 1 1 4 0a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.1 2.6z',
  bolt: 'M13 2 3 14h7l-1 8 10-12h-7z',
  clock: 'CIRCLE12|M12 7v5l3 2',
  play: 'm5 3 14 9-14 9z',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  search: 'CIRCLE11|m21 21-4.3-4.3',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  menu: 'M3 6h18M3 12h18M3 18h18',
  fire: 'M12 2s4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 1-3s3 3 3-5z',
  star: 'm12 2 3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z',
};

function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  const raw = PATHS[name] ?? '';
  const parts = raw.split('|');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      {parts.map((p, i) => {
        if (p === 'RECT') return <rect key={i} x="3" y="4" width="18" height="17" rx="2" />;
        if (p === 'CIRCLE') return <circle key={i} cx="12" cy="12" r="3" />;
        if (p === 'CIRCLE12') return <circle key={i} cx="12" cy="12" r="9" />;
        if (p === 'CIRCLE11') return <circle key={i} cx="11" cy="11" r="7" />;
        return <path key={i} d={p} />;
      })}
    </svg>
  );
}

function PriorityChip({ p }: { p: Priority }) {
  return <span className={`chip ${p}`}>{cap(p)}</span>;
}

type ViewName = 'today' | 'calendar' | 'tasks' | 'reminders' | 'insights' | 'settings';

const NAV: Array<{ id: ViewName; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'insights', label: 'Insights' },
  { id: 'settings', label: 'Settings' },
];

interface Settings {
  focusStart: string;
  focusEnd: string;
  reminderLead: number;
  autoPlan: boolean;
  notifications: boolean;
  compact: boolean;
}
const DEFAULT_SETTINGS: Settings = {
  focusStart: '09:00',
  focusEnd: '17:00',
  reminderLead: 15,
  autoPlan: true,
  notifications: true,
  compact: false,
};
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('lifeops.settings');
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function App() {
  const [today, setToday] = useState<TodayResponse | null>(null);
  const [view, setView] = useState<ViewName>('today');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [lastAsk, setLastAsk] = useState<AskResponse | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [search, setSearch] = useState('');
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    localStorage.setItem('lifeops.settings', JSON.stringify(settings));
  }, [settings]);

  const refresh = useCallback(async () => {
    try {
      const data = await api.today();
      setToday(data);
      setActivity((prev) => [...data.activity, ...prev].slice(0, 40));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAsk = useCallback(
    async (text: string): Promise<AskResponse | null> => {
      const q = text.trim();
      if (!q || running) return null;
      setRunning(true);
      setError(null);
      try {
        const res = await api.ask(q);
        setLastAsk(res);
        setActivity((prev) => [...res.activity, ...prev].slice(0, 40));
        await refresh();
        return res;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
        return null;
      } finally {
        setRunning(false);
      }
    },
    [running, refresh]
  );

  const toggleTask = useCallback(
    async (task: Task) => {
      if (task.status === 'completed') return;
      try {
        const res = await api.completeTask(task.id);
        setActivity((prev) => [...res.activity, ...prev].slice(0, 40));
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to complete');
      }
    },
    [refresh]
  );

  // Create a reminder via the dedicated validated write endpoint. Like task
  // completion, this is a server-gated WRITE: with no operator token it is
  // refused (403) and the view surfaces that honestly; with writes enabled it
  // actually schedules the reminder and refreshes the snapshot.
  const createReminder = useCallback(
    async (input: { eventId?: string; leadMinutes?: number }): Promise<ReminderCreateOutcome> => {
      if (running) return { ok: false, message: 'Busy — please wait a moment and try again.' };
      setRunning(true);
      setError(null);
      try {
        const res = await api.createReminder(input);
        setActivity((prev) => [...res.activity, ...prev].slice(0, 40));
        await refresh();
        return { ok: true, message: res.result.message };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Failed to create reminder' };
      } finally {
        setRunning(false);
      }
    },
    [running, refresh]
  );

  const go = useCallback((v: ViewName) => {
    setView(v);
    setSidebarOpen(false);
    try {
      mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      /* noop */
    }
  }, []);

  const tasks = today?.tasks.tasks ?? [];
  const events = today?.schedule.events ?? [];
  const reminders = today?.summary.reminders ?? [];
  const insights = today?.insights ?? null;
  const summary = today?.summary ?? null;
  const planResult =
    lastAsk && lastAsk.result.kind === 'plan' ? lastAsk.result.plan.plan : null;

  const stats = useMemo(() => {
    const done = tasks.filter((t) => t.status === 'completed').length;
    const pending = tasks.filter((t) => t.status === 'pending').length;
    return { done, pending, events: events.length, reminders: reminders.length };
  }, [tasks, events, reminders]);

  return (
    <div className={`shell${settings.compact ? ' compact' : ''}`}>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">
            <span>L</span>
            <i className="diamond" />
          </div>
          <div className="brand-text">
            <strong>LifeOps</strong>
            <small>Ambient AI</small>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item${view === n.id ? ' active' : ''}`}
              onClick={() => go(n.id)}
            >
              <Icon name={n.id} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="mcp-pill">
            <i className="dot" />
            MCP connected
          </div>
          <p className="side-note">Natural language → tool orchestration</p>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <button className="burger" onClick={() => setSidebarOpen(true)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <div className="searchbar">
            <Icon name="search" size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks, events, reminders…"
            />
          </div>
          <div className="top-actions">
            <button className="icon-btn" onClick={() => go('reminders')} aria-label="Reminders">
              <Icon name="bell" size={18} />
              {stats.reminders > 0 && <i className="badge" />}
            </button>
            <div className="avatar">DU</div>
          </div>
        </header>

        <main className="main" ref={mainRef}>
          {error && <div className="alert">{error}</div>}
          {!today ? (
            <div className="empty">Loading your day…</div>
          ) : view === 'today' ? (
            <TodayView
              summary={summary}
              insights={insights}
              stats={stats}
              prompt={prompt}
              setPrompt={setPrompt}
              running={running}
              runAsk={runAsk}
              plan={planResult}
              lastAsk={lastAsk}
              activity={activity}
              tasks={tasks}
              events={events}
              toggleTask={toggleTask}
              go={go}
            />
          ) : view === 'calendar' ? (
            <CalendarView events={events} plan={planResult} go={go} />
          ) : view === 'tasks' ? (
            <TasksView tasks={tasks} toggleTask={toggleTask} search={search} />
          ) : view === 'reminders' ? (
            <RemindersView
              reminders={reminders}
              events={events}
              running={running}
              createReminder={createReminder}
              defaultLead={settings.reminderLead}
            />
          ) : view === 'insights' ? (
            <InsightsView insights={insights} stats={stats} activity={activity} />
          ) : (
            <SettingsView settings={settings} setSettings={setSettings} onReset={refresh} />
          )}
        </main>
      </div>
    </div>
  );
}

interface Stats {
  done: number;
  pending: number;
  events: number;
  reminders: number;
}

function StatCards({ stats, insights }: { stats: Stats; insights: Insights | null }) {
  const cards = [
    { label: 'Tasks done', value: stats.done, sub: `${stats.pending} pending`, icon: 'tasks' },
    { label: 'Events today', value: stats.events, sub: 'on calendar', icon: 'calendar' },
    { label: 'Reminders', value: stats.reminders, sub: 'scheduled', icon: 'reminders' },
    {
      label: 'Free time',
      value: insights ? formatMinutes(insights.freeMinutes) : '\u2014',
      sub: insights?.overloaded ? 'overloaded' : 'available',
      icon: 'clock',
    },
  ];
  return (
    <div className="stat-grid">
      {cards.map((c) => (
        <div className="stat-card" key={c.label}>
          <div className="stat-ico">
            <Icon name={c.icon} size={18} />
          </div>
          <div className="stat-body">
            <span className="stat-value">{c.value}</span>
            <span className="stat-label">{c.label}</span>
            <span className="stat-sub">{c.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskRow({ task, onToggle }: { task: Task; onToggle: (t: Task) => void }) {
  const done = task.status === 'completed';
  return (
    <div className={`task-row${done ? ' done' : ''}`}>
      <button className={`check${done ? ' on' : ''}`} onClick={() => onToggle(task)} aria-label="Toggle">
        {done && <Icon name="tasks" size={13} />}
      </button>
      <div className="task-main">
        <span className="task-title">{task.title}</span>
        <span className="task-meta">{formatMinutes(task.estimatedMinutes)}</span>
      </div>
      <PriorityChip p={task.priority} />
    </div>
  );
}

function EventRow({ ev }: { ev: CalendarEvent }) {
  return (
    <div className="event-row">
      <div className="event-time">
        <strong>{formatClock(ev.startAt)}</strong>
        <small>{formatClock(ev.endAt)}</small>
      </div>
      <div className="event-main">
        <span className="event-title">{ev.title}</span>
        {ev.location && <span className="event-loc">{ev.location}</span>}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  'Plan my day',
  'Summarize what I have today',
  'Remind me 15 minutes before my next meeting',
];

interface TodayViewProps {
  summary: DaySummary | null;
  insights: Insights | null;
  stats: Stats;
  prompt: string;
  setPrompt: (s: string) => void;
  running: boolean;
  runAsk: (s: string) => void;
  plan: DailyPlan | null;
  lastAsk: AskResponse | null;
  activity: ActivityEntry[];
  tasks: Task[];
  events: CalendarEvent[];
  toggleTask: (t: Task) => void;
  go: (v: ViewName) => void;
}

function TodayView(p: TodayViewProps) {
  const pending = p.tasks.filter((t) => t.status !== 'completed').slice(0, 5);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Good day — here’s your {todayStr()}</h1>
          <p>{p.summary?.summary ?? 'Your ambient assistant is ready.'}</p>
        </div>
      </div>

      <section className="ask-card">
        <div className="ask-head">
          <Icon name="bolt" size={16} />
          <span>Ask LifeOps</span>
        </div>
        <div className="ask-input">
          <input
            value={p.prompt}
            onChange={(e) => p.setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.runAsk(p.prompt);
            }}
            placeholder="Tell me what to do — e.g. plan my day"
          />
          <button className="btn primary" disabled={p.running} onClick={() => p.runAsk(p.prompt)}>
            <Icon name="play" size={14} /> {p.running ? 'Working\u2026' : 'Run'}
          </button>
        </div>
        <div className="suggests">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggest" onClick={() => p.runAsk(s)}>
              {s}
            </button>
          ))}
        </div>
      </section>

      <StatCards stats={p.stats} insights={p.insights} />

      {p.lastAsk && <AskResult res={p.lastAsk} />}

      <div className="col-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Priority tasks</h2>
            <button className="link" onClick={() => p.go('tasks')}>
              View all <Icon name="arrow" size={13} />
            </button>
          </div>
          <div className="panel-body">
            {pending.length === 0 ? (
              <div className="muted">All caught up ✨</div>
            ) : (
              pending.map((t) => <TaskRow key={t.id} task={t} onToggle={p.toggleTask} />)
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Up next</h2>
            <button className="link" onClick={() => p.go('calendar')}>
              Calendar <Icon name="arrow" size={13} />
            </button>
          </div>
          <div className="panel-body">
            {p.events.length === 0 ? (
              <div className="muted">No events scheduled</div>
            ) : (
              p.events.slice(0, 4).map((e) => <EventRow key={e.id} ev={e} />)
            )}
          </div>
        </section>
      </div>

      {p.activity.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>MCP tool activity</h2>
          </div>
          <div className="panel-body activity">
            {p.activity.slice(0, 6).map((a, i) => (
              <div className={`act-row${a.ok ? '' : ' bad'}`} key={i}>
                <code>{a.tool}</code>
                <span className="act-msg">{a.message}</span>
                <span className="act-ms">{a.ms}ms</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function modeLabel(mode: AskResponse['mode']): string {
  switch (mode) {
    case 'bedrock':
      return 'AI: Amazon Bedrock';
    case 'deterministic-meeting':
      return 'Deterministic · meeting-aware';
    case 'deterministic-fallback':
      return 'Deterministic (Bedrock fallback)';
    default:
      return 'Deterministic';
  }
}

/** Small, honest badge showing which engine produced the answer. */
function ModeBadge({ mode }: { mode: AskResponse['mode'] }) {
  return <span className="tag">{modeLabel(mode)}</span>;
}

function AskResult({ res }: { res: AskResponse }) {
  const r = res.result;
  if (r.kind === 'plan') {
    return (
      <section className="panel accent">
        <div className="panel-head">
          <h2>
            <Icon name="bolt" size={15} /> Plan ready
          </h2>
          <span className="tag">{r.plan.plan.generatedBy}</span>
          <ModeBadge mode={res.mode} />
        </div>
        <div className="panel-body">
          <p className="plan-summary">{r.plan.plan.summary}</p>
          <div className="timeline">
            {r.plan.plan.blocks.map((b: PlanBlock, i: number) => (
              <div className={`tl-row ${b.kind}`} key={i}>
                <span className="tl-time">
                  {formatClock(b.startAt)}–{formatClock(b.endAt)}
                </span>
                <span className="tl-title">{b.title}</span>
                <span className="tl-reason">{b.reason}</span>
              </div>
            ))}
          </div>
          {r.plan.plan.warnings.length > 0 && (
            <ul className="warnings">
              {r.plan.plan.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      </section>
    );
  }
  if (r.kind === 'reminder') {
    return (
      <section className="panel accent">
        <div className="panel-head">
          <h2>
            <Icon name="reminders" size={15} /> Reminder set
          </h2>
        </div>
        <div className="panel-body">
          <p>
            <strong>{r.reminder.reminder.title}</strong> at {formatClock(r.reminder.reminder.remindAt)}
            {r.anchoredTo && <> — before “{r.anchoredTo.title}”</>}
          </p>
        </div>
      </section>
    );
  }
  if (r.kind === 'summary') {
    return (
      <section className="panel accent">
        <div className="panel-head">
          <h2>Summary</h2>
          <ModeBadge mode={res.mode} />
        </div>
        <div className="panel-body">
          <p>{r.summary.summary}</p>
        </div>
      </section>
    );
  }
  if (r.kind === 'meeting') {
    const rec = r.recommendation;
    return (
      <section className="panel accent">
        <div className="panel-head">
          <h2>
            <Icon name="reminders" size={15} /> Before your meeting
          </h2>
          <ModeBadge mode={res.mode} />
        </div>
        <div className="panel-body">
          <p className="plan-summary">{rec.summary}</p>
          {rec.hasMeeting && rec.meeting && (
            <p>
              Next: <strong>{rec.meeting.title}</strong> at {formatClock(rec.meeting.startAt)}{' '}
              — {rec.availableMinutes} min free.
            </p>
          )}
          {rec.beforeMeeting.length > 0 && (
            <div className="timeline">
              {rec.beforeMeeting.map((t) => (
                <div className="tl-row task" key={t.taskId}>
                  <span className="tl-time">{t.estimatedMinutes}m</span>
                  <span className="tl-title">{t.title}</span>
                  <span className="tl-reason">{t.reason}</span>
                </div>
              ))}
            </div>
          )}
          {rec.afterMeeting.length > 0 && (
            <>
              <p className="muted">After the meeting:</p>
              <ul className="warnings">
                {rec.afterMeeting.map((t) => (
                  <li key={t.taskId}>
                    {t.title} — {t.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {rec.warnings.length > 0 && (
            <ul className="warnings">
              {rec.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      </section>
    );
  }
  if (r.kind === 'agent') {
    return (
      <section className="panel accent">
        <div className="panel-head">
          <h2>
            <Icon name="bolt" size={15} /> Assistant
          </h2>
          <ModeBadge mode={res.mode} />
        </div>
        <div className="panel-body">
          <p className="plan-summary">{r.text}</p>
          {r.toolCalls.length > 0 && (
            <ul className="warnings">
              {r.toolCalls.map((c, i) => (
                <li key={i}>
                  {c.ok ? '✓' : '✗'} {c.name} — {c.message}
                </li>
              ))}
            </ul>
          )}
          {r.proposedActions.length > 0 && (
            <>
              <p className="muted">Awaiting your confirmation:</p>
              <ul className="warnings">
                {r.proposedActions.map((a, i) => (
                  <li key={i}>
                    {a.tool} — {a.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Note</h2>
        <ModeBadge mode={res.mode} />
      </div>
      <div className="panel-body alert">
        {r.message}
        {res.mode === 'deterministic-fallback' && res.fallbackReason && (
          <p className="muted">Bedrock was unavailable ({res.fallbackReason}); used the deterministic engine.</p>
        )}
      </div>
    </section>
  );
}

function CalendarView({
  events,
  plan,
  go,
}: {
  events: CalendarEvent[];
  plan: DailyPlan | null;
  go: (v: ViewName) => void;
}) {
  const hours = Array.from({ length: 12 }, (_, i) => i + 8); // 8:00 - 19:00
  function topFor(iso: string): number {
    const d = new Date(iso);
    const mins = d.getHours() * 60 + d.getMinutes() - 8 * 60;
    return (mins / 60) * 56;
  }
  function heightFor(a: string, b: string): number {
    const mins = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
    return Math.max(28, (mins / 60) * 56);
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p>Your schedule for {todayStr()}</p>
        </div>
      </div>
      <div className="col-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Day timeline</h2>
          </div>
          <div className="panel-body">
            <div className="cal-grid">
              {hours.map((h) => (
                <div className="cal-hour" key={h}>
                  <span>{h}:00</span>
                </div>
              ))}
              {events.map((e) => (
                <div
                  key={e.id}
                  className="cal-event"
                  style={{ top: topFor(e.startAt), height: heightFor(e.startAt, e.endAt) }}
                >
                  <strong>{e.title}</strong>
                  <small>
                    {formatClock(e.startAt)}–{formatClock(e.endAt)}
                  </small>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Events</h2>
          </div>
          <div className="panel-body">
            {events.length === 0 ? (
              <div className="muted">Nothing scheduled</div>
            ) : (
              events.map((e) => <EventRow key={e.id} ev={e} />)
            )}
            {plan && (
              <button className="btn ghost full" onClick={() => go('today')}>
                <Icon name="bolt" size={13} /> View generated plan
              </button>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

const FILTERS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'completed', label: 'Completed' },
  { id: 'high', label: 'High priority' },
];

function TasksView({
  tasks,
  toggleTask,
  search,
}: {
  tasks: Task[];
  toggleTask: (t: Task) => void;
  search: string;
}) {
  const [filter, setFilter] = useState('all');
  const q = search.trim().toLowerCase();
  const list = tasks.filter((t) => {
    if (q && !t.title.toLowerCase().includes(q)) return false;
    if (filter === 'pending') return t.status !== 'completed';
    if (filter === 'completed') return t.status === 'completed';
    if (filter === 'high') return t.priority === 'high';
    return true;
  });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p>{tasks.filter((t) => t.status !== 'completed').length} pending · {tasks.length} total</p>
        </div>
      </div>
      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`filter${filter === f.id ? ' active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="panel-body">
          {list.length === 0 ? (
            <div className="muted">No tasks match this filter</div>
          ) : (
            list.map((t) => <TaskRow key={t.id} task={t} onToggle={toggleTask} />)
          )}
        </div>
      </section>
    </>
  );
}

function RemindersView({
  reminders,
  events,
  running,
  createReminder,
  defaultLead,
}: {
  reminders: Reminder[];
  events: CalendarEvent[];
  running: boolean;
  createReminder: (input: { eventId?: string; leadMinutes?: number }) => Promise<ReminderCreateOutcome>;
  defaultLead: number;
}) {
  const [eventId, setEventId] = useState('');
  const [lead, setLead] = useState(defaultLead);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  async function create() {
    // Honor the user's actual event + lead-time selection. The server anchors
    // the reminder to the chosen event (or the next upcoming one) and computes
    // the fire time as (event start - lead minutes).
    const res = await createReminder({ eventId: eventId || undefined, leadMinutes: lead });
    if (res.ok) {
      setNotice({ ok: true, text: res.message });
    } else {
      setNotice({ ok: false, text: res.message });
    }
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reminders</h1>
          <p>{reminders.length} scheduled</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>Create a reminder</h2>
        </div>
        <div className="panel-body form-row">
          <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Next meeting</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} · {formatClock(e.startAt)}
              </option>
            ))}
          </select>
          <select value={lead} onChange={(e) => setLead(Number(e.target.value))}>
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} min before
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={running} onClick={create}>
            <Icon name="plus" size={14} /> Set reminder
          </button>
        </div>
        {notice && (
          <div className="panel-body">
            <div className="alert">{notice.ok ? `\u2713 ${notice.text}` : notice.text}</div>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Scheduled</h2>
        </div>
        <div className="panel-body">
          {reminders.length === 0 ? (
            <div className="muted">No reminders yet</div>
          ) : (
            reminders.map((r) => (
              <div className="rem-row" key={r.id}>
                <div className="rem-ico">
                  <Icon name="bell" size={15} />
                </div>
                <div className="rem-main">
                  <span className="rem-title">{r.title}</span>
                  <span className="rem-meta">{formatClock(r.remindAt)}</span>
                </div>
                <span className={`chip ${r.status === 'scheduled' ? 'medium' : 'low'}`}>{r.status}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

function InsightsView({
  insights,
  stats,
  activity,
}: {
  insights: Insights | null;
  stats: Stats;
  activity: ActivityEntry[];
}) {
  const total = stats.done + stats.pending;
  const pct = total === 0 ? 0 : Math.round((stats.done / total) * 100);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Insights</h1>
          <p>How your day is shaping up</p>
        </div>
      </div>
      <div className="col-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Completion</h2>
          </div>
          <div className="panel-body">
            <div className="ring" style={{ ['--pct' as any]: pct }}>
              <span>{pct}%</span>
            </div>
            <p className="muted center">
              {stats.done} of {total} tasks completed
            </p>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Capacity</h2>
          </div>
          <div className="panel-body">
            <div className="meter">
              <div className="meter-row">
                <span>Free time</span>
                <strong>{insights ? formatMinutes(insights.freeMinutes) : '\u2014'}</strong>
              </div>
              <div className="meter-row">
                <span>Pending work</span>
                <strong>{insights ? formatMinutes(insights.pendingMinutes) : '\u2014'}</strong>
              </div>
              <div className="meter-row">
                <span>Status</span>
                <span className={`chip ${insights?.overloaded ? 'high' : 'low'}`}>
                  {insights?.overloaded ? 'Overloaded' : 'Balanced'}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
      {insights && insights.highlights.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>
              <Icon name="star" size={15} /> Highlights
            </h2>
          </div>
          <div className="panel-body">
            <ul className="bullets">
              {insights.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {insights && insights.overdueTasks.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Overdue</h2>
          </div>
          <div className="panel-body">
            {insights.overdueTasks.map((t) => (
              <div className="task-row" key={t.id}>
                <div className="task-main">
                  <span className="task-title">{t.title}</span>
                </div>
                <PriorityChip p={t.priority} />
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)} aria-label="Toggle">
      <i />
    </button>
  );
}

function SettingsView({
  settings,
  setSettings,
  onReset,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  onReset: () => void;
}) {
  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setSettings({ ...settings, [k]: v });
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Tune how your ambient assistant behaves</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>Focus window</h2>
        </div>
        <div className="panel-body form-row">
          <label className="field">
            <span>Start</span>
            <input type="time" value={settings.focusStart} onChange={(e) => set('focusStart', e.target.value)} />
          </label>
          <label className="field">
            <span>End</span>
            <input type="time" value={settings.focusEnd} onChange={(e) => set('focusEnd', e.target.value)} />
          </label>
          <label className="field">
            <span>Default reminder lead</span>
            <select value={settings.reminderLead} onChange={(e) => set('reminderLead', Number(e.target.value))}>
              {[5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Preferences</h2>
        </div>
        <div className="panel-body">
          <div className="pref-row">
            <div>
              <strong>Auto-plan my day</strong>
              <small>Generate a plan automatically each morning</small>
            </div>
            <Toggle on={settings.autoPlan} onChange={(v) => set('autoPlan', v)} />
          </div>
          <div className="pref-row">
            <div>
              <strong>Notifications</strong>
              <small>Fire reminders ahead of events</small>
            </div>
            <Toggle on={settings.notifications} onChange={(v) => set('notifications', v)} />
          </div>
          <div className="pref-row">
            <div>
              <strong>Compact mode</strong>
              <small>Tighter spacing across the app</small>
            </div>
            <Toggle on={settings.compact} onChange={(v) => set('compact', v)} />
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Data</h2>
        </div>
        <div className="panel-body form-row">
          <button className="btn ghost" onClick={onReset}>
            Refresh demo data
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              localStorage.removeItem('lifeops.settings');
              setSettings(DEFAULT_SETTINGS);
            }}
          >
            Reset settings
          </button>
        </div>
      </section>
    </>
  );
}
