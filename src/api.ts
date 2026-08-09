import type {
  ApiErrorBody,
  CloseBody,
  CloseResponse,
  ReportBody,
  ReportResponse,
  TriggerResponse,
} from './contract.js';
import * as log from './log.js';

/**
 * The Ritim half of the Action: report, then poll.
 *
 * `fetch` rather than a client library — a dependency here is a dependency
 * vendored into every repository that installs this Action.
 *
 * Every request logs its method, URL, status and duration, and every transport
 * failure is rewrapped as a `RitimNetworkError` carrying the original as
 * `cause`. Node's bare `TypeError: fetch failed` names neither the host it
 * failed to reach nor the reason, and that message reaching a user is the
 * failure mode this module exists to prevent.
 */

const POLL_INTERVAL_MS = 3000;

/** Per-request ceiling. The overall wait is bounded separately by `timeout`. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Transport failures only — a 4xx is an answer, and retrying it changes nothing. */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

/** Carries the body's message; `Bad Request` is not the useful part. */
export class RitimApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'RitimApiError';
  }
}

/**
 * A request that never got an answer: DNS, TCP, TLS, or a timeout. Separate
 * from `RitimApiError` because the remedy is different — nothing about the
 * project secret or the payload can fix a host that does not resolve.
 */
export class RitimNetworkError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    cause: unknown,
  ) {
    super(`Could not reach Ritim (${method} ${url})`, { cause });
    this.name = 'RitimNetworkError';
  }
}

export class RitimClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async report(body: ReportBody): Promise<ReportResponse> {
    return this.request<ReportResponse>('POST', '/api/v1/pull-requests', body);
  }

  /** One indexed update. No audit, no poll — see the closed path in `main`. */
  async close(body: CloseBody): Promise<CloseResponse> {
    return this.request<CloseResponse>('PATCH', '/api/v1/pull-requests', body);
  }

  async trigger(triggerId: string): Promise<TriggerResponse> {
    return this.request<TriggerResponse>(
      'GET',
      `/api/v1/pull-requests/triggers/${encodeURIComponent(triggerId)}`,
    );
  }

  /**
   * Polls until the audit stops running, or the deadline passes. Returns the
   * last state either way rather than throwing: a slow run is not a failed
   * build, and the caller decides what a still-`running` result means.
   */
  async waitForTrigger(triggerId: string, timeoutMs: number): Promise<TriggerResponse> {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;

    log.info(`Waiting up to ${Math.round(timeoutMs / 1000)}s for audit ${triggerId} to finish.`);

    // Polled at least once even with a zero timeout — a deduplicated report is
    // already finished.
    for (;;) {
      const state = await this.trigger(triggerId);
      polls += 1;

      if (state.status !== 'running' || Date.now() >= deadline) {
        log.info(
          `Audit ${triggerId} is ${state.status} after ${polls} ${polls === 1 ? 'poll' : 'polls'}.`,
        );
        return state;
      }

      const remaining = Math.max(0, deadline - Date.now());
      log.info(`Still running (poll ${polls}, ${Math.round(remaining / 1000)}s left).`);
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt<T>(method, url, body, attempt);
      } catch (error) {
        // Only the transport is retried, and only while attempts remain: a
        // server that answered has said what it thinks, however unwelcome.
        if (!(error instanceof RitimNetworkError) || attempt >= MAX_ATTEMPTS) throw error;

        const delay = RETRY_BACKOFF_MS * attempt;
        log.warn(
          `${method} ${url.pathname} failed to connect (attempt ${attempt}/${MAX_ATTEMPTS}), ` +
            `retrying in ${delay / 1000}s.\n${log.describeError(error)}`,
        );
        await sleep(delay);
      }
    }
  }

  private async attempt<T>(method: string, url: URL, body: unknown, attempt: number): Promise<T> {
    const began = Date.now();
    log.info(`→ ${method} ${url.href}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    if (body !== undefined) log.debug(`  request body: ${log.preview(JSON.stringify(body), 1000)}`);

    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.secret}`,
          accept: 'application/json',
          'user-agent': 'ritim-pr-review-action',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // The whole point of this module: `fetch` rejects with a message that
      // names nothing. Everything that identifies the failure is on `cause`.
      throw new RitimNetworkError(method, url.href, error);
    }

    const took = Date.now() - began;
    const text = await response.text().catch(() => '');

    log.info(`← ${response.status} ${response.statusText} in ${took}ms (${text.length} bytes)`);
    log.debug(`  response body: ${log.preview(text, 1000)}`);

    // Parsed after the status is read, so a non-JSON error page is reported as
    // itself rather than as "not JSON".
    let payload: (T & ApiErrorBody) | undefined;

    try {
      payload = text === '' ? undefined : (JSON.parse(text) as T & ApiErrorBody);
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      throw new RitimApiError(
        response.status,
        payload?.message ?? `Ritim returned ${response.status} ${response.statusText}`,
        payload?.data?.issues ?? [],
      );
    }

    if (payload === undefined) {
      throw new RitimApiError(
        response.status,
        `Ritim returned a response that was not JSON: ${log.preview(text, 200) || '(empty body)'}`,
      );
    }

    return payload;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
