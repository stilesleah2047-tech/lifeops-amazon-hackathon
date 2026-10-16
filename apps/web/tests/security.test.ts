/**
 * Focused tests for the Phase 3.1 BFF security hardening (server/security.ts).
 *
 * These exercise the pure decision functions and the Express middleware with
 * lightweight mock req/res objects — no server boot and no database, so they
 * run anywhere the rest of the web suite runs.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  parseAllowedOrigins,
  isOriginAllowed,
  buildCorsOptions,
  checkWriteAuth,
  requireWriteAuth,
  createRateLimiter,
  validateAskBody,
  validateTaskId,
  clientErrorBody,
} from '../server/security.js';

// ---- mock helpers ----

function mockRes() {
  const res: Partial<Response> & {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = { headers: {} };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response['status'];
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res as Response;
  }) as unknown as Response['json'];
  res.setHeader = vi.fn((k: string, v: string) => {
    res.headers[k] = v;
    return res as Response;
  }) as unknown as Response['setHeader'];
  return res as Response & { statusCode?: number; body?: any; headers: Record<string, string> };
}

function mockReq(opts: { ip?: string; authorization?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers.authorization = opts.authorization;
  return {
    ip: opts.ip ?? '1.2.3.4',
    socket: { remoteAddress: opts.ip ?? '1.2.3.4' } as any,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

// ---- CORS allowlist ----

describe('CORS allowlist', () => {
  it('parses a comma-separated list and trims blanks', () => {
    expect(parseAllowedOrigins(' https://a.com , https://b.com ,, ')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('allows no-Origin (same-origin / server-to-server) requests', () => {
    expect(isOriginAllowed(undefined, ['https://a.com'])).toBe(true);
  });

  it('allows exact matches and rejects everything else', () => {
    expect(isOriginAllowed('https://a.com', ['https://a.com'])).toBe(true);
    expect(isOriginAllowed('https://evil.com', ['https://a.com'])).toBe(false);
  });

  it('honors an explicit wildcard opt-in', () => {
    expect(isOriginAllowed('https://anything.com', ['*'])).toBe(true);
  });

  it('cors origin callback accepts allowed and errors on disallowed', () => {
    const opts = buildCorsOptions(['https://a.com']);
    const originFn = opts.origin as (
      o: string | undefined,
      cb: (err: Error | null, ok?: boolean) => void,
    ) => void;

    const ok = vi.fn();
    originFn('https://a.com', ok);
    expect(ok).toHaveBeenCalledWith(null, true);

    const bad = vi.fn();
    originFn('https://evil.com', bad);
    expect((bad.mock.calls[0]![0] as Error).message).toMatch(/not allowed/i);
  });
});

// ---- write authorization (shared operator secret) ----

describe('write authorization', () => {
  it('DISABLES writes when no token is configured (403, never anonymous)', () => {
    const r = checkWriteAuth('Bearer whatever', '');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it('rejects a missing bearer header when a token IS configured (401)', () => {
    const r = checkWriteAuth(undefined, 'secret-token');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('rejects a wrong token (401)', () => {
    const r = checkWriteAuth('Bearer nope', 'secret-token');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('accepts the correct bearer token', () => {
    const r = checkWriteAuth('Bearer secret-token', 'secret-token');
    expect(r.ok).toBe(true);
  });

  it('middleware blocks unauthorized writes and does NOT call next', () => {
    const mw = requireWriteAuth('secret-token');
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(mockReq({ authorization: 'Bearer wrong' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('middleware returns 403 when writes are disabled (no token)', () => {
    const mw = requireWriteAuth('');
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(mockReq({ authorization: 'Bearer anything' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('middleware calls next for an authorized write', () => {
    const mw = requireWriteAuth('secret-token');
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    mw(mockReq({ authorization: 'Bearer secret-token' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });
});

// ---- rate limiter ----

describe('rate limiter', () => {
  it('allows up to max, then returns 429 with Retry-After, and resets after the window', () => {
    let t = 1000;
    const mw = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    const next = vi.fn() as unknown as NextFunction;

    const res1 = mockRes();
    mw(mockReq(), res1, next);
    const res2 = mockRes();
    mw(mockReq(), res2, next);
    expect(next).toHaveBeenCalledTimes(2);

    const res3 = mockRes();
    mw(mockReq(), res3, next);
    expect(next).toHaveBeenCalledTimes(2); // blocked
    expect(res3.statusCode).toBe(429);
    expect(res3.headers['Retry-After']).toBeDefined();

    // Advance past the window → allowed again.
    t += 1001;
    const res4 = mockRes();
    mw(mockReq(), res4, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('tracks limits per client ip independently', () => {
    let t = 0;
    const mw = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    const next = vi.fn() as unknown as NextFunction;
    mw(mockReq({ ip: 'a' }), mockRes(), next);
    mw(mockReq({ ip: 'b' }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2); // different ips, each under max
  });

  it('evicts expired entries so the map cannot grow unbounded (regression)', () => {
    let t = 0;
    const mw = createRateLimiter({ windowMs: 1000, max: 100, now: () => t });
    const next = vi.fn() as unknown as NextFunction;

    // 50 one-off clients within the first window.
    for (let i = 0; i < 50; i++) {
      mw(mockReq({ ip: `ip-${i}` }), mockRes(), next);
    }
    expect(mw.pending()).toBe(50);

    // Advance past the window so all 50 entries are now stale, then make ONE
    // request from a new client. The lazy sweep must drop the 50 expired
    // entries, leaving only the single fresh one — not 51.
    t += 1001;
    mw(mockReq({ ip: 'fresh' }), mockRes(), next);
    expect(mw.pending()).toBe(1);
  });
});

// ---- validation ----

describe('request validation', () => {
  it('rejects an empty prompt', () => {
    expect(validateAskBody({ prompt: '   ' }).ok).toBe(false);
    expect(validateAskBody({}).ok).toBe(false);
  });

  it('rejects an over-long prompt', () => {
    expect(validateAskBody({ prompt: 'x'.repeat(501) }).ok).toBe(false);
  });

  it('accepts a valid prompt and trims it', () => {
    const r = validateAskBody({ prompt: '  plan my day  ', userId: 'demo-user' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ userId: 'demo-user', prompt: 'plan my day' });
  });

  it('validates taskId shape', () => {
    expect(validateTaskId('task_123').ok).toBe(true);
    expect(validateTaskId('').ok).toBe(false);
    expect(validateTaskId('bad id!!').ok).toBe(false);
  });
});

// ---- error handling ----

describe('secret-safe error handler', () => {
  it('returns a generic message in production', () => {
    expect(clientErrorBody(new Error('db password=hunter2 leaked'), true)).toEqual({
      error: 'Internal server error',
    });
  });

  it('surfaces the message in development', () => {
    expect(clientErrorBody(new Error('boom'), false)).toEqual({ error: 'boom' });
  });
});
