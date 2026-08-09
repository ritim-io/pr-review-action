/**
 * The Ritim wire format — **a hand-maintained copy** of
 * `src/shared/pull-request-schema` in the Ritim monorepo. An Action is vendored
 * into strangers' repositories, so it must not depend on a workspace package. A
 * change there is a change here; `schemaVersion` is what catches a missed one.
 *
 * Types only. The server validates; two opinions about a bad `number` is worse
 * than one.
 */

export const SCHEMA_VERSION = 1;

export type PullRequestState = 'draft' | 'open' | 'closed' | 'merged';

export type AuditStrategy = 'mobile' | 'desktop';

export type TriggerStatus = 'running' | 'done' | 'failed';

/** `POST /api/v1/pull-requests`. */
export interface ReportBody {
  schemaVersion: number;
  repository: string;
  number: number;
  title: string;
  state: PullRequestState;
  author: string;
  openedAt: string;
  commitSha: string;
  previewUrl: string;
  /** Omitted entirely when unset - see the `domain` input. */
  domain?: string;
  strategies?: AuditStrategy[];
}

/**
 * `PATCH /api/v1/pull-requests`. Identified by repository and number rather
 * than by `pullRequestId`: a closed event carries no id, and the only run that
 * ever learns one is the run that reported.
 */
export interface CloseBody {
  schemaVersion: number;
  repository: string;
  number: number;
  state: PullRequestState;
}

/** `200` from the close. */
export interface CloseResponse {
  pullRequestId: string;
  state: PullRequestState;
}

/** `202` from the report. The audit has not run yet. */
export interface ReportResponse {
  pullRequestId: string;
  triggerId: string;
  status: TriggerStatus;
  /** True when this commit was already reported and nothing new was started. */
  deduplicated: boolean;
}

/**
 * Lighthouse's own 0-100 verdict per lab metric. Optional in full, not just per
 * metric: runs recorded before the field existed do not carry it.
 */
export interface LabScores {
  lcp?: number;
  cls?: number;
  fcp?: number;
  ttfb?: number;
  tbt?: number;
  speedIndex?: number;
}

export interface AuditResult {
  requestedUrl: string;
  finalUrl: string;
  strategy: AuditStrategy;
  lighthouseVersion: string;
  /** 0-100. Undefined when Lighthouse could not score the run. */
  performanceScore?: number;
  lab: {
    lcp?: number;
    cls?: number;
    fcp?: number;
    /**
     * Lighthouse's `server-response-time`, ms. Named for Ritim's RUM field but
     * **not** the same measurement — the document response alone, an order of
     * magnitude below a real TTFB. Never band it against the 800ms threshold.
     */
    ttfb?: number;
    tbt?: number;
    speedIndex?: number;
  };
  labScores?: LabScores;
}

/** One strategy's outcome. One failing does not fail the audit. */
export type StrategyOutcome =
  | { strategy: AuditStrategy; ok: true; result: AuditResult }
  | { strategy: AuditStrategy; ok: false; error: string };

/** `GET /api/v1/pull-requests/triggers/{id}`. */
export interface TriggerResponse {
  triggerId: string;
  pullRequestId: string;
  commitSha: string;
  previewUrl: string;
  status: TriggerStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  result: { outcomes: StrategyOutcome[] } | null;
}

/** The error body every Ritim 4xx carries. */
export interface ApiErrorBody {
  message?: string;
  data?: { issues?: { field: string; message: string }[] };
}
