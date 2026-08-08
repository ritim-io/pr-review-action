import * as core from '@actions/core';
import * as github from '@actions/github';

import { RitimApiError, RitimClient } from './api.js';
import { renderComment, upsertComment } from './comment.js';
import { SCHEMA_VERSION, type AuditStrategy, type PullRequestState } from './contract.js';

/**
 * Report a pull request's preview build to Ritim, wait for the audit, comment
 * the result.
 *
 * Soft by design. `project-secret` and `preview-url` are the only hard
 * failures - without them there is nothing to do. Everything else warns and
 * skips, or falls back to a default, because a performance report that can
 * redden a merge is a report people delete rather than fix. `fail-on-error`
 * opts into the stricter behaviour.
 */

/** Clears mobile and desktop together, which run sequentially. */
const DEFAULT_TIMEOUT_SECONDS = 180;

/** A merged pull request is also `closed`, so order matters. */
function toState(pr: { state?: string; draft?: boolean; merged?: boolean }): PullRequestState {
  if (pr.merged) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  return 'open';
}

let failOnErrorCache: boolean | undefined;

function failOnError(): boolean {
  failOnErrorCache ??= booleanInput('fail-on-error', false);
  return failOnErrorCache;
}

/** The only path from a problem to a red step, and it is opt-in. */
function soft(message: string): void {
  if (failOnError()) core.setFailed(message);
  else core.warning(message);
}

/**
 * `core.getBooleanInput` throws on anything but `true`/`false`, including the
 * empty string an unset `${{ vars.X }}` interpolates to.
 */
function booleanInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();

  if (raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  core.warning(`\`${name}\` must be true or false, got "${raw}" — using ${fallback}.`);
  return fallback;
}

function timeoutInput(): number {
  const raw = core.getInput('timeout').trim();
  if (raw === '') return DEFAULT_TIMEOUT_SECONDS;

  const seconds = Number.parseInt(raw, 10);

  if (!Number.isFinite(seconds) || seconds < 0) {
    core.warning(
      `\`timeout\` must be a number of seconds, got "${raw}" — using ${DEFAULT_TIMEOUT_SECONDS}.`,
    );
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return seconds;
}

/** Unknown values are dropped: measuring mobile beats measuring nothing. */
function parseStrategies(raw: string): AuditStrategy[] | undefined {
  const isKnown = (value: string): value is AuditStrategy =>
    value === 'mobile' || value === 'desktop';

  const values = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const unknown = values.filter((value) => !isKnown(value));

  if (unknown.length > 0) {
    core.warning(
      `\`strategies\` may only contain "mobile" and "desktop" — ignoring ${unknown
        .map((value) => `"${value}"`)
        .join(', ')}.`,
    );
  }

  const known = values.filter(isKnown);
  return known.length === 0 ? undefined : [...new Set(known)];
}

/**
 * Compared by repository rather than by `head.repo.fork`, which is also true
 * for a same-repo branch in a repository that was itself forked. Only same-repo
 * decides whether secrets exist. A deleted head repository counts as a fork.
 */
function isFromFork(pr: {
  head?: { repo?: { full_name?: string } | null };
  base?: { repo?: { full_name?: string } };
}): boolean {
  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;

  return head === undefined || head !== base;
}

/**
 * Whether this run may comment.
 *
 * GitHub gives a workflow no way to ask what its own token is allowed to do, so
 * the write attempt is the probe. Its answer lands here rather than in an
 * exception: commenting switches off and the run carries on.
 */
let canComment = true;

async function run(): Promise<void> {
  const pr = github.context.payload.pull_request;

  if (!pr) {
    soft(
      'Skipped: this action needs a pull request event. Trigger it with `on: pull_request` ' +
        '(and include `closed` in `types` if you want merges recorded).',
    );
    return;
  }

  // A fork gets a read-only token and no secrets. GitHub's boundary, not a
  // configuration problem, so it exits clean.
  if (isFromFork(pr as Parameters<typeof isFromFork>[0])) {
    core.notice(
      'Skipped: pull requests from forks have no access to secrets, so the preview ' +
        'cannot be reported. This is a GitHub restriction, not a configuration problem.',
    );
    return;
  }

  const apiUrl = core.getInput('api-url') || 'https://api.ritim.io';
  const secret = core.getInput('project-secret').trim();
  const previewUrl = core.getInput('preview-url').trim();
  const domain = core.getInput('domain').trim();
  const shouldWait = booleanInput('wait', true);
  const timeoutSeconds = timeoutInput();

  canComment = booleanInput('comment', true);

  // The two hard failures. Nothing this action does is possible without them,
  // and a green step would say the report ran when it never could.
  if (!secret) {
    core.setFailed(
      '`project-secret` is required. Take it from the Ritim dashboard ' +
        '(Settings → API secret) and store it as a repository secret.',
    );
    return;
  }

  if (!previewUrl) {
    core.setFailed('`preview-url` is required. Pass the deployment URL to audit.');
    return;
  }

  const strategies = parseStrategies(core.getInput('strategies'));
  const client = new RitimClient(apiUrl, secret);

  const report = await client.report({
    schemaVersion: SCHEMA_VERSION,
    repository: `${github.context.repo.owner}/${github.context.repo.repo}`,
    number: pr.number,
    title: String(pr.title ?? ''),
    state: toState(pr as Parameters<typeof toState>[0]),
    author: String(pr.user?.login ?? ''),
    openedAt: String(pr.created_at ?? new Date().toISOString()),
    commitSha: String(pr.head?.sha ?? ''),
    previewUrl,
    // Omitted rather than sent empty, so an unset `${{ vars.X }}` does not look
    // deliberate.
    ...(domain ? { domain } : {}),
    ...(strategies ? { strategies } : {}),
  });

  core.setOutput('trigger-id', report.triggerId);
  core.info(`Reported ${report.triggerId}${report.deduplicated ? ' (already measured)' : ''}`);

  if (!shouldWait) {
    core.setOutput('status', report.status);
    return;
  }

  const trigger = await client.waitForTrigger(report.triggerId, timeoutSeconds * 1000);

  core.setOutput('status', trigger.status);
  core.setOutput('result', JSON.stringify(trigger.result));

  if (trigger.status === 'running') {
    core.warning(
      `The audit was still running after ${timeoutSeconds}s. It will finish on Ritim's side; ` +
        'raise `timeout` if you want the comment on this run.',
    );
    return;
  }

  // Deduplicated means this commit was already measured, so the comment already
  // says what this run would say.
  if (canComment && !report.deduplicated) {
    await comment(trigger);
  }

  if (trigger.status === 'failed') {
    soft(`The audit failed: ${trigger.error ?? 'no result was produced'}`);
  }
}

/** Posts the comment, or switches commenting off for this run. Never throws. */
async function comment(trigger: Parameters<typeof renderComment>[0]): Promise<void> {
  const token = core.getInput('github-token');

  if (!token) {
    canComment = false;
    core.warning('No `github-token`, so no comment was posted.');
    return;
  }

  try {
    const octokit = github.getOctokit(token);
    const id = await upsertComment(
      octokit as unknown as Parameters<typeof upsertComment>[0],
      {
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issueNumber: github.context.payload.pull_request?.number as number,
      },
      renderComment(trigger),
    );

    core.setOutput('comment-id', id);
  } catch (error) {
    /*
     * The first-install failure, every time, and GitHub's own message does not
     * name the missing permission. Deliberately not routed through `soft()`:
     * the measurement was recorded, and nobody who set `fail-on-error` for
     * *audits* asked for a red build over a comment.
     */
    canComment = false;

    if (isPermissionDenied(error)) {
      core.warning(
        'Commenting is off for this run: the workflow needs `permissions: pull-requests: write`. ' +
          'GITHUB_TOKEN is read-only by default. The result was still recorded in Ritim.',
      );
      return;
    }

    core.warning(`Could not comment: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 404 counts: GitHub hides a resource a token may not write. */
function isPermissionDenied(error: unknown): boolean {
  const status =
    typeof error === 'object' && error !== null ? (error as { status?: number }).status : undefined;

  return status === 403 || status === 404;
}

run().catch((error: unknown) => {
  soft(error instanceof RitimApiError ? ritimMessage(error) : errorMessage(error));
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ritimMessage(error: RitimApiError): string {
  switch (error.status) {
    case 401:
      return (
        'Ritim rejected the project secret. Check `RITIM_PROJECT_SECRET`, and note that ' +
        'rotating a secret in the dashboard takes effect immediately.'
      );
    case 403:
      return `Ritim requires a project secret (\`psk_…\`) on this route: ${error.message}`;
    case 400:
      // The server answers with every problem at once, so print them all.
      return error.issues.length > 0
        ? `Ritim rejected the report:\n${error.issues.map((issue) => `  - ${issue.field}: ${issue.message}`).join('\n')}`
        : `Ritim rejected the report: ${error.message}`;
    default:
      return `Ritim returned ${error.status}: ${error.message}`;
  }
}
