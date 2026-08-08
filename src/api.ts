import type { ApiErrorBody, ReportBody, ReportResponse, TriggerResponse } from './contract.js';

/**
 * The Ritim half of the Action: report, then poll.
 *
 * `fetch` rather than a client library — a dependency here is a dependency
 * vendored into every repository that installs this Action.
 */

const POLL_INTERVAL_MS = 3000;

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

export class RitimClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async report(body: ReportBody): Promise<ReportResponse> {
    return this.request<ReportResponse>('POST', '/api/v1/pull-requests', body);
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

    // Polled at least once even with a zero timeout — a deduplicated report is
    // already finished.
    for (;;) {
      const state = await this.trigger(triggerId);
      if (state.status !== 'running' || Date.now() >= deadline) return state;

      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.secret}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Parsed before the status is checked: the useful message lives in the
    // body, and an empty one must not mask the status.
    const payload = (await response.json().catch(() => undefined)) as
      | (T & ApiErrorBody)
      | undefined;

    if (!response.ok) {
      throw new RitimApiError(
        response.status,
        payload?.message ?? `Ritim returned ${response.status} ${response.statusText}`,
        payload?.data?.issues ?? [],
      );
    }

    if (payload === undefined) {
      throw new RitimApiError(response.status, 'Ritim returned a response that was not JSON');
    }

    return payload;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
