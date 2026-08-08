import * as core from '@actions/core';

/**
 * Logging for a run nobody can attach a debugger to.
 *
 * Two rules the rest of the Action leans on:
 *
 * - **Every step announces its start, its end, and how long it took.** A log
 *   that only speaks when something breaks cannot tell a hang from a crash.
 * - **No error is printed by `message` alone.** Node's `fetch` fails with the
 *   word "fetch failed" and puts every useful detail — the syscall, the errno,
 *   the hostname it could not resolve — on `cause`. Printing the message is how
 *   a DNS failure and an expired certificate become the same log line.
 */

/** Wall clock for the whole run, so each line says how far in it happened. */
const startedAt = Date.now();

function elapsed(): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

export function info(message: string): void {
  core.info(`[${elapsed()}] ${message}`);
}

export function debug(message: string): void {
  core.debug(`[${elapsed()}] ${message}`);
}

export function warn(message: string): void {
  core.warning(message);
}

/** Key/value block, one per line, for the things a bug report always needs. */
export function details(title: string, fields: Record<string, unknown>): void {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  const width = Math.max(0, ...entries.map(([key]) => key.length));

  core.startGroup(title);
  for (const [key, value] of entries) core.info(`${key.padEnd(width)}  ${format(value)}`);
  core.endGroup();
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Runs `fn` inside a collapsible group, timing it either way.
 *
 * The failure line is emitted *before* the group closes so the duration and the
 * error sit together, and then rethrown — this decides how a step is logged,
 * not whether it is fatal.
 */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  core.startGroup(`▸ ${name}`);
  const began = Date.now();

  try {
    const value = await fn();
    core.info(`✓ ${name} — ${((Date.now() - began) / 1000).toFixed(1)}s`);
    return value;
  } catch (error) {
    core.info(`✗ ${name} — ${((Date.now() - began) / 1000).toFixed(1)}s`);
    core.info(describeError(error));
    throw error;
  } finally {
    core.endGroup();
  }
}

/**
 * An error as every line of it, `cause` chain included.
 *
 * This is the function that answers "why did it say `fetch failed`". Undici
 * throws `TypeError: fetch failed` and hangs the real diagnosis off `cause` as
 * a `SystemError` carrying `code`, `syscall` and `hostname`. One level down is
 * usually enough, but TLS failures nest deeper, so the whole chain is walked.
 */
export function describeError(error: unknown): string {
  const lines: string[] = [];

  for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}${depth === 0 ? '' : 'caused by: '}${headline(current)}`);

    const extra = systemFields(current);
    if (extra.length > 0) lines.push(`${indent}  (${extra.join(', ')})`);

    if (!(current instanceof Error)) break;
    current = (current as { cause?: unknown }).cause;
  }

  // Three frames, not the whole stack: the bundle is one 1MB file, so deeper
  // frames are noise. Omitted entirely when empty — undici's `fetch failed`
  // carries no frames at all, and a bare "stack:" reads like something lost.
  const frames = (error instanceof Error ? (error.stack ?? '') : '')
    .split('\n')
    .slice(1, 4)
    .map((frame) => frame.trim())
    .filter(Boolean);

  if (frames.length > 0) lines.push(`  stack: ${frames.join(' | ')}`);

  return lines.join('\n');
}

function headline(error: unknown): string {
  if (!(error instanceof Error)) return `${typeof error}: ${String(error)}`;
  return `${error.name}: ${error.message}`;
}

/**
 * The fields Node puts on a `SystemError` and nowhere in its message. `code`
 * alone is the whole diagnosis most of the time: ENOTFOUND is a wrong host,
 * ECONNREFUSED a reachable host with nothing listening, CERT_HAS_EXPIRED a
 * proxy in the middle, UND_ERR_CONNECT_TIMEOUT a firewall dropping the SYN.
 */
function systemFields(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return [];

  const record = error as Record<string, unknown>;
  const keys = ['code', 'errno', 'syscall', 'hostname', 'address', 'port', 'status'];

  return keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${key}=${String(record[key])}`);
}

/**
 * A one-line hint for the network failures that have a known cause, appended to
 * the error the user actually sees. Nothing here is a guess about *their*
 * setup — each code has exactly one meaning at this layer.
 */
export function networkHint(error: unknown): string | undefined {
  switch (findCode(error)) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The API host could not be resolved. Check `api-url` for a typo, and that a self-hosted Ritim is reachable from GitHub-hosted runners.';
    case 'ECONNREFUSED':
      return 'The API host resolved but refused the connection. It is likely a wrong port, or a server that is down.';
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return 'The connection timed out — a firewall or IP allowlist that does not include GitHub runners will do this.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return "The TLS certificate could not be verified. A corporate proxy or a self-signed certificate on a self-hosted Ritim is the usual cause.";
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return 'The connection was reset mid-request, which usually means a proxy or load balancer closed it.';
    default:
      return undefined;
  }
}

function findCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    const code = (current as { code?: unknown } | null)?.code;
    if (typeof code === 'string') return code;
    if (!(current instanceof Error)) return undefined;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/** Trims a body for the log: enough to diagnose, not enough to flood. */
export function preview(text: string, limit = 500): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}… (${text.length} bytes)`;
}
