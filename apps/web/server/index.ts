/**
 * LifeOps web BFF (backend-for-frontend).
 *
 * The web dashboard is a plain SPA. Browsers cannot straightforwardly hold
 * long-lived Streamable HTTP MCP sessions, so this small Express server:
 *
 *   1. Maintains an MCP client connection to the LifeOps MCP server.
 *   2. Exposes narrow REST endpoints to the SPA.
 *   3. Records every tool call it makes to the MCP server and returns it in
 *      each response body — the "Activity" pane in the UI shows this feed so
 *      the user can see WHICH tools got orchestrated for their request.
 *
 * This BFF is not the Alexa+ path. Alexa+ hits the MCP server directly at
 * /mcp. The BFF exists purely to power the web demo. The docs make this clear.
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runAgent, AgentExhaustedError, type AgentToolDef } from './agent.js';
import { readBedrockConfig, createConverse } from './bedrockClient.js';
// Deterministic meeting-aware recommender lives with the other deterministic
// engines in the MCP server package (so it is unit-tested by that vitest
// suite). It is a PURE function with no I/O, imported here across the monorepo.
import {
  recommendBeforeMeeting,
  type MeetingRecommendation,
} from '../../../services/mcp-server/src/services/meetingPlanner.js';
import type { CalendarEvent, Task } from '../../../services/mcp-server/src/types/domain.js';
import {
  parseAllowedOrigins,
  buildCorsOptions,
  requireWriteAuth,
  checkWriteAuth,
  createRateLimiter,
  validateAskBody,
  validateTaskId,
  clientErrorBody,
} from './security.js';

// Render (and most PaaS) inject PORT; the public listener MUST bind it.
// Fall back to BFF_PORT, then 5174, for local development — backward compatible.
const PORT = Number(process.env.PORT ?? process.env.BFF_PORT ?? 5174);
const HOST = process.env.HOST ?? '0.0.0.0';
const MCP_BASE_URL = process.env.MCP_BASE_URL ?? 'http://localhost:8000';
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';
const MCP_URL = `${MCP_BASE_URL}${MCP_PATH}`;
const API_KEY = process.env.LIFEOPS_API_KEY ?? '';
const DEMO_USER = process.env.DEMO_USER_ID ?? 'demo-user';
const IS_PROD = process.env.NODE_ENV === 'production';

// CORS allowlist. Comma-separated origins via ALLOWED_ORIGINS. In dev we fall
// back to the local Vite/preview origins so the workflow keeps working; in
// production the custom domain MUST be supplied explicitly (no wildcard).
const DEFAULT_DEV_ORIGINS = 'http://localhost:5173,http://localhost:3000';
const ALLOWED_ORIGINS = parseAllowedOrigins(
  process.env.ALLOWED_ORIGINS ?? (IS_PROD ? '' : DEFAULT_DEV_ORIGINS),
);

// Shared operator secret that gates WRITE routes. Unset => writes DISABLED
// (cannot be triggered anonymously). This is NOT per-user authentication:
// it authenticates whoever holds the token, not an end user.
const WRITE_TOKEN = process.env.LIFEOPS_WRITE_TOKEN ?? '';

// Per-instance rate limit for the public API surface.
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 120);

// Bedrock is OPTIONAL. When BEDROCK_MODEL_ID is unset the BFF runs in pure
// deterministic mode. Credentials never leave this process.
const BEDROCK = readBedrockConfig();

// ---------- MCP client (lazy, cached, self-healing) ----------

interface MCPHandle {
  client: Client;
  transport: StreamableHTTPClientTransport;
}
let clientPromise: Promise<MCPHandle> | null = null;

async function getMcpClient(): Promise<MCPHandle> {
  if (clientPromise) {
    try {
      return await clientPromise;
    } catch {
      clientPromise = null; // rebuild on next call
    }
  }
  clientPromise = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: API_KEY ? { headers: { 'X-LifeOps-Api-Key': API_KEY } } : undefined,
    });
    const client = new Client(
      { name: 'lifeops-web-bff', version: '0.1.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    // eslint-disable-next-line no-console
    console.log(`[bff] connected to MCP at ${MCP_URL}`);
    return { client, transport };
  })();
  return clientPromise;
}

// ---------- Activity feed helper ----------

interface ActivityEntry {
  tool: string;
  ok: boolean;
  ms: number;
  message: string;
}

async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  activity: ActivityEntry[]
): Promise<T> {
  const started = Date.now();
  try {
    const { client } = await getMcpClient();
    const res = await client.callTool({ name, arguments: args });
    const ms = Date.now() - started;
    if (res.isError) {
      const errMsg = (res.structuredContent as { error?: string })?.error ?? 'tool error';
      activity.push({ tool: name, ok: false, ms, message: errMsg });
      throw new Error(errMsg);
    }
    activity.push({ tool: name, ok: true, ms, message: humanize(name) });
    return res.structuredContent as T;
  } catch (err) {
    // Reset connection so the next request will reconnect.
    clientPromise = null;
    if (activity[activity.length - 1]?.tool !== name) {
      activity.push({
        tool: name,
        ok: false,
        ms: Date.now() - started,
        message: (err as Error).message,
      });
    }
    throw err;
  }
}

function humanize(toolName: string): string {
  switch (toolName) {
    case 'get_tasks':
      return "Retrieved today's tasks";
    case 'get_schedule':
      return 'Checked calendar';
    case 'get_productivity_insights':
      return 'Analyzed available time and conflicts';
    case 'generate_daily_plan':
      return 'Generated a plan';
    case 'summarize_day':
      return 'Summarized the day';
    case 'create_reminder':
      return 'Created reminder';
    case 'complete_task':
      return 'Marked task complete';
    default:
      return `Called ${toolName}`;
  }
}

// ---------- Orchestrator: natural-language → tool sequence ----------

/** Fetch the REAL registered MCP tool definitions for the model to choose from. */
async function fetchRealToolDefs(): Promise<AgentToolDef[]> {
  const { client } = await getMcpClient();
  const listed = await client.listTools();
  return listed.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  }));
}

/**
 * Detect the dedicated “what should I finish before my meeting?” intent.
 * Deliberately specific so it does not swallow generic planning requests.
 */
function detectMeetingIntent(prompt: string): boolean {
  const p = prompt.toLowerCase();
  const beforeMeeting = /(before|ahead of|prior to|in time for|by).{0,30}(meeting|call|standup|stand-up|sync|appointment|interview|1[:\- ]?1)/;
  const finishWhat = /(what|which|anything|something).{0,40}(finish|get done|complete|wrap up|knock out|do)/;
  const timeUntil = /(time|how long).{0,20}(before|until|til|till).{0,20}(meeting|call|standup|sync)/;
  return (
    beforeMeeting.test(p) ||
    timeUntil.test(p) ||
    (/(meeting|call|standup|sync)/.test(p) && finishWhat.test(p))
  );
}

/** Pull a leading buffer like “leave 10 minutes before” out of the prompt. */
function parseBufferMinutes(text: string): number | undefined {
  const m = text.match(/(?:buffer|leave|spare)\s*(\d{1,3})\s*(?:min(?:ute)?s?|m)\b/i);
  return m && m[1] ? parseInt(m[1], 10) : undefined;
}

/**
 * Dedicated, DETERMINISTIC meeting-aware recommendation. Reads the user's real
 * tasks + schedule through the MCP tools, then computes the fit entirely in
 * application code (recommendBeforeMeeting). No model does the time math.
 */
async function computeMeetingRecommendation(
  userId: string,
  prompt: string,
  activity: ActivityEntry[],
): Promise<MeetingRecommendation> {
  const [tasksRes, scheduleRes] = await Promise.all([
    callTool<{ tasks: Task[] }>('get_tasks', { userId, status: 'pending' }, activity),
    callTool<{ events: CalendarEvent[] }>('get_schedule', { userId }, activity),
  ]);
  return recommendBeforeMeeting({
    now: new Date(),
    tasks: tasksRes.tasks ?? [],
    events: scheduleRes.events ?? [],
    bufferMinutes: parseBufferMinutes(prompt),
  });
}

/**
 * Run the Bedrock agent loop against the REAL MCP tools. Returns the agent
 * result, or throws (caller falls back to deterministic orchestration).
 */
async function runBedrockAgent(
  userId: string,
  prompt: string,
  activity: ActivityEntry[],
  allowWrites: boolean,
) {
  const tools = await fetchRealToolDefs();
  const converse = createConverse(BEDROCK);
  // The model is told who the user is so it passes the correct userId.
  const framedPrompt = `The current user's id is "${userId}". Request: ${prompt}`;
  return runAgent(
    framedPrompt,
    {
      tools,
      converse,
      callTool: (name, args) => callTool(name, args, activity),
    },
    { maxIterations: BEDROCK.maxIterations, allowWrites },
  );
}

/**
 * Deterministic intent classifier — no LLM. Chooses which tools to call based
 * on regex hints. Used directly when Bedrock is disabled, and as the ALWAYS-
 * available fallback when the agent fails.
 */
async function orchestrate(
  userId: string,
  prompt: string,
  activity: ActivityEntry[],
  writesEnabled: boolean,
) {
  const p = prompt.toLowerCase().trim();

  // Dedicated meeting-aware branch (deterministic): “what can I finish before
  // my next meeting?” Computed in application code, never by a model.
  if (detectMeetingIntent(prompt)) {
    const recommendation = await computeMeetingRecommendation(userId, prompt, activity);
    return { kind: 'meeting', recommendation } as const;
  }

  // "Summarize my day" / "recap"
  if (/(summar|recap|wrap[\s-]?up|how.*day)/i.test(p)) {
    const summary = await callTool('summarize_day', { userId }, activity);
    return { kind: 'summary', summary } as const;
  }

  // "Remind me ..." — schedule a reminder anchored to the next event.
  // This is the ONLY deterministic branch that MUTATES data (create_reminder),
  // so it is gated by the write authorization just like the explicit write
  // route. Without an authorized write token it is refused — never silently
  // executed anonymously.
  if (/^remind|reminder/i.test(p)) {
    if (!writesEnabled) {
      return {
        kind: 'error',
        message:
          'Creating a reminder is a write action and requires an authorized write token.',
      } as const;
    }
    const schedule = await callTool<{ events: Array<{ id: string; title: string; startAt: string }> }>(
      'get_schedule',
      { userId },
      activity
    );
    const upcoming = schedule.events.find((e) => Date.parse(e.startAt) > Date.now());
    if (!upcoming) {
      return {
        kind: 'error',
        message: 'No upcoming events found to anchor the reminder against.',
      } as const;
    }
    const minutesBefore = parseMinutesBefore(prompt) ?? 30;
    const remindAt = new Date(Date.parse(upcoming.startAt) - minutesBefore * 60_000).toISOString();
    const title = extractReminderTitle(prompt) ?? `Prepare for ${upcoming.title}`;
    const created = await callTool(
      'create_reminder',
      {
        userId,
        title,
        reminderTime: remindAt,
        relatedEventId: upcoming.id,
      },
      activity
    );
    return { kind: 'reminder', reminder: created, anchoredTo: upcoming } as const;
  }

  // Default: "Plan my afternoon" / "what should I get done" / anything else.
  // Reads tasks + schedule + insights, then generates a plan.
  const [tasks, schedule, insights] = await Promise.all([
    callTool('get_tasks', { userId }, activity),
    callTool('get_schedule', { userId }, activity),
    callTool('get_productivity_insights', { userId }, activity),
  ]);
  const plan = await callTool(
    'generate_daily_plan',
    { userId, userRequest: prompt },
    activity
  );
  return { kind: 'plan', plan, tasks, schedule, insights } as const;
}

function parseMinutesBefore(text: string): number | null {
  const m = text.match(/(\d{1,3})\s*(?:min(?:ute)?s?|m)\s*before/i);
  return m && m[1] ? parseInt(m[1], 10) : null;
}

function extractReminderTitle(text: string): string | null {
  const m = text.match(/remind me (?:to |about )?(.*?)(?: (?:before|at) |$)/i);
  let title = m?.[1]?.trim();
  if (!title) return null;
  // Strip trailing "N minute(s)" / "N min" / "N m" that belongs to the timing
  // clause, not the reminder title.
  title = title.replace(/\s+\d{1,3}\s*(?:min(?:ute)?s?|m)$/i, '').trim();
  return title.length > 0 ? title : null;
}

// ---------- Express app ----------

const app = express();
app.set('trust proxy', 1); // behind Render's proxy; makes req.ip meaningful
// Configurable CORS allowlist (NOT authentication) — replaces open cors().
// IMPORTANT: scope CORS to the API surface ONLY. The SPA's own static assets
// are served by THIS service, but the browser fetches them in CORS mode
// because Vite emits <script type="module" crossorigin> / <link crossorigin>.
// Applying the allowlist globally made the browser's same-origin asset fetch
// fail the check (empty prod allowlist) and the origin callback threw →
// 500 on /assets/* → blank page. The API stays guarded; same-origin static
// assets must not be gated.
app.use('/api', cors(buildCorsOptions(ALLOWED_ORIGINS)));
app.use(express.json({ limit: '256kb' }));
// Rate limit the whole public API surface (per instance).
const apiRateLimiter = createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX });
app.use('/api', apiRateLimiter);

function asyncHandler<T>(
  fn: (req: Request, res: Response) => Promise<T>
) {
  return (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mcp: MCP_URL,
    // Honest capability report. `bedrockEnabled` only means a model id is
    // CONFIGURED — it does NOT assert a successful AWS call has happened.
    ai: {
      bedrockEnabled: BEDROCK.enabled,
      model: BEDROCK.enabled ? BEDROCK.modelId : null,
      region: BEDROCK.enabled ? BEDROCK.region : null,
      defaultMode: BEDROCK.enabled ? 'bedrock' : 'deterministic',
      allowWrites: BEDROCK.allowWrites,
      maxIterations: BEDROCK.maxIterations,
    },
  });
});

// Today snapshot — tasks + schedule + reminders + insights, all in one call.
app.get(
  '/api/today',
  asyncHandler(async (req, res) => {
    const userId = (req.query.userId as string) || DEMO_USER;
    const activity: ActivityEntry[] = [];
    const [tasks, schedule, insights, summary] = await Promise.all([
      callTool('get_tasks', { userId }, activity),
      callTool('get_schedule', { userId }, activity),
      callTool('get_productivity_insights', { userId }, activity),
      callTool('summarize_day', { userId }, activity),
    ]);
    res.json({ userId, tasks, schedule, insights, summary, activity, mode: 'deterministic' });
  })
);

// Ask endpoint — natural-language command, returns the orchestration result + activity.
app.post(
  '/api/ask',
  asyncHandler(async (req, res) => {
    const parsed = validateAskBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const userId = parsed.value!.userId || DEMO_USER;
    const prompt = parsed.value!.prompt;
    const activity: ActivityEntry[] = [];

    // Is this caller authorized to perform write actions? Reads never require
    // it; writes (create_reminder, complete_task) do. Default (no token) =>
    // writes disabled, so they can never be triggered anonymously.
    const writesAuthorized = checkWriteAuth(req.header('authorization'), WRITE_TOKEN).ok;

    // Dedicated meeting-aware questions are ALWAYS answered deterministically
    // (the time math must be exact), regardless of whether Bedrock is on.
    // This branch is read-only.
    if (detectMeetingIntent(prompt)) {
      const result = await orchestrate(userId, prompt, activity, false);
      res.json({ prompt, result, activity, mode: 'deterministic-meeting' });
      return;
    }

    // When Bedrock is configured, let the model drive tool selection. If the
    // agent fails for ANY reason we fall back to the deterministic router and
    // report that honestly — we never claim Bedrock worked when it didn't.
    // Agent writes stay OFF unless BOTH AGENT_ALLOW_WRITES is true AND the
    // caller is write-authorized.
    if (BEDROCK.enabled) {
      try {
        const agent = await runBedrockAgent(
          userId,
          prompt,
          activity,
          BEDROCK.allowWrites && writesAuthorized,
        );
        res.json({ prompt, result: { kind: 'agent', ...agent }, activity, mode: 'bedrock' });
        return;
      } catch (err) {
        const reason =
          err instanceof AgentExhaustedError
            ? `agent did not converge: ${err.message}`
            : `bedrock error: ${(err as Error).message}`;
        console.warn('[bff] bedrock agent failed — deterministic fallback:', reason);
        const result = await orchestrate(userId, prompt, activity, writesAuthorized);
        res.json({
          prompt,
          result,
          activity,
          mode: 'deterministic-fallback',
          fallbackReason: reason,
        });
        return;
      }
    }

    // Bedrock not configured — pure deterministic orchestration.
    const result = await orchestrate(userId, prompt, activity, writesAuthorized);
    res.json({ prompt, result, activity, mode: 'deterministic' });
  })
);

// Direct task completion for the UI's "Mark done" button. This MUTATES user
// data, so it is gated by the write-authorization middleware: with no token
// configured it returns 403 (never anonymous), and with a token it requires a
// valid `Authorization: Bearer <token>`.
app.post(
  '/api/tasks/:taskId/complete',
  requireWriteAuth(WRITE_TOKEN),
  asyncHandler(async (req, res) => {
    const idCheck = validateTaskId(req.params.taskId);
    if (!idCheck.ok) {
      res.status(400).json({ error: idCheck.error });
      return;
    }
    const userId = (typeof req.body?.userId === 'string' && req.body.userId.trim()) || DEMO_USER;
    const activity: ActivityEntry[] = [];
    const result = await callTool(
      'complete_task',
      { userId, taskId: idCheck.value },
      activity
    );
    res.json({ result, activity });
  })
);

// Direct reminder creation for the UI's "Set reminder" button. This MUTATES
// user data, so — exactly like task completion — it is gated by the write-
// authorization middleware: no token configured => 403 (never anonymous);
// token configured => requires a valid `Authorization: Bearer <token>`.
//
// Unlike the natural-language /api/ask reminder branch, this endpoint honors
// the user's explicit event + lead-time selection from the form. The reminder
// fire time is computed server-side as (chosen event start - leadMinutes); the
// title/anchor are validated here, never trusted blindly from the client.
app.post(
  '/api/reminders',
  requireWriteAuth(WRITE_TOKEN),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId =
      (typeof body.userId === 'string' && body.userId.trim()) || DEMO_USER;
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    const leadRaw = Number(body.leadMinutes);
    const leadMinutes =
      Number.isFinite(leadRaw) && leadRaw > 0 && leadRaw <= 24 * 60
        ? Math.floor(leadRaw)
        : 30;
    const rawTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';

    const activity: ActivityEntry[] = [];
    const schedule = await callTool<{ events: CalendarEvent[] }>(
      'get_schedule',
      { userId },
      activity,
    );
    const events = schedule.events ?? [];
    const now = Date.now();
    // Prefer the explicitly selected event; else the next upcoming one.
    const chosen =
      (eventId ? events.find((e) => e.id === eventId) : undefined) ??
      events.find((e) => Date.parse(e.startAt) > now);
    if (!chosen) {
      res.status(400).json({ error: 'No upcoming calendar event available to anchor the reminder.' });
      return;
    }
    const title = rawTitle || `Prepare for ${chosen.title}`;
    const reminderTime = new Date(Date.parse(chosen.startAt) - leadMinutes * 60_000).toISOString();
    const result = await callTool(
      'create_reminder',
      { userId, title, reminderTime, relatedEventId: chosen.id },
      activity,
    );
    res.json({ result, activity });
  })
);

// ---------- Serve the built SPA in production ----------
// In dev, Vite serves the SPA and proxies /api → this BFF. In a deployed
// (single public service) setup there is no Vite, so the BFF serves the
// production build from apps/web/dist and falls back to index.html for the
// client-side router. API routes are registered above, so they take priority;
// anything under /api that reaches here is a genuine 404 and must NOT be
// rewritten to index.html.
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(distDir, 'index.html'));
  });
  // eslint-disable-next-line no-console
  console.log(`[bff] serving SPA from ${distDir}`);
}

// Global error handler — never leaks stack traces (spec §22). In production
// the client gets a generic message; the full error is logged server-side.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('[bff] error:', err.message);
  res.status(500).json(clientErrorBody(err, IS_PROD));
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[bff] listening on ${HOST}:${PORT}  →  MCP ${MCP_URL}`);
});
