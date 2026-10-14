/**
 * BFF security middleware — Phase 3.1 public-API hardening.
 *
 * Scope and honest limits (read this before assuming "auth exists"):
 *   - LifeOps has NO user identity system. `userId` arrives as a request
 *     parameter and defaults to the demo user. Nothing here turns that into
 *     real per-user authentication or authorization — it CANNOT, without a
 *     login/session design that is intentionally out of scope for this phase.
 *   - What this module DOES provide:
 *       1. A configurable CORS allowlist (replacing wildcard CORS). CORS is a
 *          browser policy, NOT authentication.
 *       2. A server-side SHARED-SECRET bearer gate for WRITE routes. This
 *          authenticates the *caller* (whoever holds the operator token), not
 *          an end user. When no token is configured, writes are DISABLED so
 *          they can never be triggered anonymously — the safe public-beta
 *          default.
 *       3. A small in-memory rate limiter (per instance).
 *       4. Dependency-free body/param validation and a secret-safe error
 *          handler.
 *
 * Everything is pure/injectable so it can be unit-tested without booting a
 * server or opening the database.
 */
import { timingSafeEqual } from 'node:crypto';
import type { CorsOptions } from 'cors';
import type { Request, Response, NextFunction } from 'express';

// --------------------------------------------------------------------------
// CORS allowlist
// --------------------------------------------------------------------------

/** Parse a comma-separated ALLOWED_ORIGINS env value into a clean list. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decide whether a browser Origin is allowed.
 * - No Origin (same-origin navigations, curl, server-to-server) → allowed.
 *   The SPA is served by THIS service, so its own fetches are same-origin and
 *   send no cross-origin Origin. CORS is not a substitute for auth.
 * - '*' in the allowlist → allow all (explicit dev opt-in only).
 * - otherwise → exact-match the allowlist.
 */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  if (allowed.includes('*')) return true;
  return allowed.includes(origin);
}

/** Build cors() options from a resolved allowlist. */
export function buildCorsOptions(allowed: string[]): CorsOptions {
  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin ?? undefined, allowed)) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  };
}

// --------------------------------------------------------------------------
// Write-route authorization (shared operator secret — NOT per-user auth)
// --------------------------------------------------------------------------

export interface WriteAuthResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Authorize a WRITE request against the configured shared token.
 *   - token unset  → 403, writes disabled (cannot be triggered anonymously).
 *   - token set, header missing/invalid → 401.
 *   - token set, `Authorization: Bearer <token>` matches → ok.
 */
export function checkWriteAuth(authHeader: string | undefined, token: string): WriteAuthResult {
  if (!token) {
    return {
      ok: false,
      status: 403,
      error:
        'Write actions are disabled on this deployment. Set LIFEOPS_WRITE_TOKEN to enable them.',
    };
  }
  const expected = `Bearer ${token}`;
  if (authHeader && safeEqual(authHeader, expected)) return { ok: true };
  return {
    ok: false,
    status: 401,
    error: 'Unauthorized: missing or invalid bearer token for a write action.',
  };
}

/** Express middleware factory enforcing checkWriteAuth. */
export function requireWriteAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = checkWriteAuth(req.header('authorization'), token);
    if (result.ok) return next();
    res.status(result.status ?? 401).json({ error: result.error });
  };
}

// --------------------------------------------------------------------------
// In-memory fixed-window rate limiter (per process/instance)
// --------------------------------------------------------------------------

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Minimal dependency-free limiter. Per-instance only — adequate for the
 * single-instance public beta; swap for a shared store if you scale out.
 */
export function createRateLimiter(opts: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const clock = opts.now ?? Date.now;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const t = clock();
    const entry = hits.get(key);
    if (!entry || t >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: t + opts.windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - t) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Slow down and retry shortly.' });
      return;
    }
    next();
  };
}

// --------------------------------------------------------------------------
// Request validation (dependency-free)
// --------------------------------------------------------------------------

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function validateAskBody(body: unknown): ValidationResult<{ userId: string; prompt: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'prompt is required and must be a non-empty string.' };
  if (prompt.length > 500) return { ok: false, error: 'prompt must be 500 characters or fewer.' };
  const userId = typeof b.userId === 'string' && b.userId.trim() ? b.userId.trim() : '';
  if (userId.length > 128) return { ok: false, error: 'userId is too long.' };
  return { ok: true, value: { userId, prompt } };
}

export function validateTaskId(raw: unknown): ValidationResult<string> {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return { ok: false, error: 'taskId is required.' };
  if (id.length > 128 || !/^[\w:-]+$/.test(id)) return { ok: false, error: 'taskId is malformed.' };
  return { ok: true, value: id };
}

// --------------------------------------------------------------------------
// Secret-safe error handler
// --------------------------------------------------------------------------

/**
 * Produce a client-facing error body. In production we return a generic
 * message so internal details (and anything that might embed a secret in an
 * error string) never reach the client; the full error is logged server-side
 * by the caller. In development we surface the message to aid debugging.
 */
export function clientErrorBody(err: Error, isProd: boolean): { error: string } {
  if (isProd) return { error: 'Internal server error' };
  return { error: err.message || 'Internal server error' };
}
