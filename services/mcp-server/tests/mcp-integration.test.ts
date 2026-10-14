/**
 * MCP protocol integration test.
 *
 * Boots the real MCP server as a subprocess, connects via the official MCP
 * TypeScript client over Streamable HTTP, and verifies the two acceptance
 * scenarios from the spec:
 *
 *   §32.1 — "Plan my afternoon."
 *   §32.2 — "Remind me to submit my proposal before my 4 PM meeting."
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 8766;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = './data/lifeops.integration.db';
// Spawn the REAL Node binary (process.execPath) and let it load `tsx` via
// --import. process.execPath is a true executable (never a .cmd shim), so no
// shell is needed. This avoids BOTH the DEP0190 shell:true warning AND the
// Node 20.12+/24 `spawn EINVAL` that occurs when launching npx.cmd without a
// shell. Cross-platform: identical on Windows, macOS, and Linux.
const NODE = process.execPath;

let child: ChildProcess;
let client: Client;
let transport: StreamableHTTPClientTransport;

async function waitReady(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never became ready');
}

async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  return res.structuredContent as T;
}

beforeAll(async () => {
  // Wipe any prior integration DB so tests are hermetic.
  for (const ext of ['', '-wal', '-shm']) {
    const p = DB + ext;
    if (existsSync(p)) unlinkSync(p);
  }

  child = spawn(
    NODE,
    ['--import', 'tsx', 'src/index.ts'],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATABASE_URL: `file:${DB}`,
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stderr?.on('data', (b) => process.stderr.write(`[srv] ${b}`));

  await waitReady();

  // Seed inside the same DB the server sees.
  await new Promise<void>((resolve, reject) => {
    const seed = spawn(
      NODE,
      ['--import', 'tsx', 'src/scripts/seed.ts'],
      { env: { ...process.env, DATABASE_URL: `file:${DB}` }, stdio: 'inherit' }
    );
    seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exit ${code}`))));
  });

  transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  client = new Client({ name: 'lifeops-integration', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
}, 45_000);

afterAll(async () => {
  await transport?.close();
  child?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
});

describe('MCP protocol basics', () => {
  it('exposes all 7 tools via tools/list', async () => {
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'complete_task',
      'create_reminder',
      'generate_daily_plan',
      'get_productivity_insights',
      'get_schedule',
      'get_tasks',
      'summarize_day',
    ]);
  });

  it('reports server name and version', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('lifeops-mcp');
    expect(info?.version).toBeTypeOf('string');
  });
});

describe('Acceptance §32.1: "Plan my afternoon"', () => {
  it('retrieves tasks, retrieves schedule, and produces a structured plan', async () => {
    const tasks = await callTool<{ tasks: unknown[] }>('get_tasks', { userId: 'demo-user' });
    expect(tasks.tasks.length).toBeGreaterThan(0);

    const schedule = await callTool<{ events: unknown[] }>('get_schedule', {
      userId: 'demo-user',
    });
    expect(schedule.events.length).toBeGreaterThan(0);

    const plan = await callTool<{ plan: { blocks: unknown[]; summary: string } }>(
      'generate_daily_plan',
      { userId: 'demo-user', userRequest: 'Plan my afternoon.' }
    );
    expect(plan.plan.blocks.length).toBeGreaterThan(0);
    expect(plan.plan.summary.length).toBeGreaterThan(0);
  });
});

describe('Acceptance §32.2: "Remind me to submit proposal before my 4pm meeting"', () => {
  it('locates a meeting, calculates a reminder time, creates the reminder', async () => {
    const schedule = await callTool<{ events: Array<{ id: string; title: string; startAt: string }> }>(
      'get_schedule',
      { userId: 'demo-user' }
    );
    // The seed puts a "Team meeting" in the future. Find any upcoming meeting.
    const upcoming = schedule.events.find((e) => Date.parse(e.startAt) > Date.now());
    expect(upcoming).toBeDefined();

    // Deterministic: reminder 30 minutes before the meeting.
    const remindAt = new Date(Date.parse(upcoming!.startAt) - 30 * 60_000).toISOString();

    const created = await callTool<{
      reminder: { id: string; remindAt: string; title: string; status: string };
    }>('create_reminder', {
      userId: 'demo-user',
      title: 'Submit proposal',
      reminderTime: remindAt,
      relatedEventId: upcoming!.id,
    });

    expect(created.reminder.status).toBe('scheduled');
    expect(created.reminder.remindAt).toBe(remindAt);
    expect(created.reminder.title).toBe('Submit proposal');
  });
});

describe('Tool safety', () => {
  it('rejects complete_task on a nonexistent task with isError', async () => {
    const res = await client.callTool({
      name: 'complete_task',
      arguments: { userId: 'demo-user', taskId: 'task-nope' },
    });
    expect(res.isError).toBe(true);
  });

  it('rejects create_reminder more than 24h in the past', async () => {
    const res = await client.callTool({
      name: 'create_reminder',
      arguments: {
        userId: 'demo-user',
        title: 'nope',
        reminderTime: new Date(Date.now() - 48 * 3600_000).toISOString(),
      },
    });
    expect(res.isError).toBe(true);
  });
});
