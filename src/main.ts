import * as core from '@actions/core';
import * as github from '@actions/github';

import { RitimApiError, RitimClient, RitimNetworkError } from './api.js';
import { renderComment, upsertComment } from './comment.js';
import { SCHEMA_VERSION, type AuditStrategy, type PullRequestState } from './contract.js';
import * as log from './log.js';

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

/**
 * What the runner was, before anything can go wrong.
 *
 * Printed unconditionally and first, because every bug report about this Action
 * begins with a question this block answers: which version ran, on what Node,
 * against which event.
 */
function logEnvironment(): void {
  log.details('Environment', {
    action: `${process.env.GITHUB_ACTION_REPOSITORY ?? 'ritim-io/pr-review-action'}@${process.env.GITHUB_ACTION_REF ?? 'unknown'}`,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    runner: process.env.RUNNER_NAME ?? 'unknown',
    repository: process.env.GITHUB_REPOSITORY,
    event: `${github.context.eventName}${github.context.payload.action ? `.${github.context.payload.action}` : ''}`,
    workflow: github.context.workflow,
    runId: github.context.runId,
    // A proxy in the path changes what `fetch` does; an empty value here is
    // itself the answer when the request fails to connect.
    proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '(none)',
    noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? '(none)',
  });
}

async function run(): Promise<void> {
  logEnvironment();

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

  const apiUrl = core.getInput('api-url').trim() || 'https://api.ritim.io';
  const secret = core.getInput('project-secret').trim();
  const previewUrl = core.getInput('preview-url').trim();
  const domain = core.getInput('domain').trim();
  const shouldWait = booleanInput('wait', true);
  const timeoutSeconds = timeoutInput();

  canComment = booleanInput('comment', true);

  // Belt and braces. The secret should already be a repository secret, but a
  // user testing with a literal value should not have it echoed by our logs.
  if (secret) core.setSecret(secret);

  log.details('Inputs', {
    'api-url': apiUrl,
    'preview-url': previewUrl || '(missing)',
    'project-secret': describeSecret(secret),
    domain: domain || '(unset — the project must have a single site)',
    strategies: core.getInput('strategies').trim() || 'mobile (default)',
    wait: shouldWait,
    timeout: `${timeoutSeconds}s`,
    comment: canComment,
    'github-token': core.getInput('github-token') ? 'present' : '(missing)',
    'fail-on-error': failOnError(),
  });

  log.details('Pull request', {
    number: pr.number,
    state: toState(pr as Parameters<typeof toState>[0]),
    author: String(pr.user?.login ?? ''),
    headSha: String(pr.head?.sha ?? '').slice(0, 12),
    baseRepo: pr.base?.repo?.full_name,
  });

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

  // Caught here rather than as a malformed request later: `new URL()` inside
  // the client would fail with "Invalid URL" and no clue which input was wrong.
  if (!isHttpUrl(apiUrl)) {
    core.setFailed(`\`api-url\` must be an absolute http(s) URL, got "${apiUrl}".`);
    return;
  }

  if (!isHttpUrl(previewUrl)) {
    core.setFailed(
      `\`preview-url\` must be an absolute http(s) URL, got "${previewUrl}". ` +
        'A deploy step that produced no URL usually leaves this empty or set to a bare host.',
    );
    return;
  }

  const strategies = parseStrategies(core.getInput('strategies'));
  const client = new RitimClient(apiUrl, secret);

  const report = await log.step(`Report the preview to ${apiUrl}`, () =>
    client.report({
      schemaVersion: SCHEMA_VERSION,
      repository: `${github.context.repo.owner}/${github.context.repo.repo}`,
      number: pr.number,
      title: String(pr.title ?? ''),
      state: toState(pr as Parameters<typeof toState>[0]),
      author: String(pr.user?.login ?? ''),
      openedAt: String(pr.created_at ?? new Date().toISOString()),
      commitSha: String(pr.head?.sha ?? ''),
      previewUrl,
      // Omitted rather than sent empty, so an unset `${{ vars.X }}` does not
      // look deliberate.
      ...(domain ? { domain } : {}),
      ...(strategies ? { strategies } : {}),
    }),
  );

  core.setOutput('trigger-id', report.triggerId);
  log.details('Reported', {
    triggerId: report.triggerId,
    pullRequestId: report.pullRequestId,
    status: report.status,
    deduplicated: report.deduplicated
      ? 'yes — this commit was already measured, so no new audit was started'
      : 'no',
  });

  if (!shouldWait) {
    core.setOutput('status', report.status);
    log.info('`wait` is false, so this run stops here. The audit continues on Ritim.');
    return;
  }

  const trigger = await log.step('Wait for the audit', () =>
    client.waitForTrigger(report.triggerId, timeoutSeconds * 1000),
  );

  core.setOutput('status', trigger.status);
  core.setOutput('result', JSON.stringify(trigger.result));
  logOutcomes(trigger);

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
  } else {
    log.info(
      canComment
        ? 'Comment skipped: this commit was already measured, so the existing comment stands.'
        : 'Comment skipped: `comment` is false.',
    );
  }

  if (trigger.status === 'failed') {
    soft(`The audit failed: ${trigger.error ?? 'no result was produced'}`);
  }
}

/** Absolute http(s), the only thing either side can do anything with. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Shape and length only — enough to tell a wrong secret from an empty one. */
function describeSecret(secret: string): string {
  if (!secret) return '(missing)';
  if (!secret.startsWith('psk_'))
    return `set, ${secret.length} chars, but does not start with "psk_" — is this the right secret?`;
  return `set, ${secret.length} chars, psk_…`;
}

/** Per-strategy results, so a half-failed audit is readable without the JSON. */
function logOutcomes(trigger: { status: string; error: string | null; result: unknown }): void {
  const outcomes = (trigger.result as { outcomes?: unknown[] } | null)?.outcomes ?? [];

  log.details('Audit', {
    status: trigger.status,
    error: trigger.error ?? undefined,
    strategies: outcomes.length === 0 ? '(none reported)' : undefined,
  });

  for (const outcome of outcomes as {
    strategy: string;
    ok: boolean;
    error?: string;
    result?: { performanceScore?: number; finalUrl?: string };
  }[]) {
    log.info(
      outcome.ok
        ? `${outcome.strategy}: score ${outcome.result?.performanceScore ?? 'n/a'} for ${outcome.result?.finalUrl ?? ''}`
        : `${outcome.strategy}: failed — ${outcome.error ?? 'no reason given'}`,
    );
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
    log.info(`Posting the comment on ${github.context.repo.owner}/${github.context.repo.repo}#${github.context.payload.pull_request?.number}.`);

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
    log.info(`Comment ${id} is up to date.`);
  } catch (error) {
    log.debug(`Commenting failed:\n${log.describeError(error)}`);

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

run()
  .then(() => {
    log.info('Done.');
  })
  .catch((error: unknown) => {
    // The full chain goes to the log unconditionally; the annotation gets the
    // one sentence a user can act on. Before this existed, a DNS failure and an
    // expired certificate both surfaced as "Warning: fetch failed".
    core.startGroup('✗ Failure detail');
    core.info(log.describeError(error));
    core.endGroup();

    soft(errorMessage(error));
  });

function errorMessage(error: unknown): string {
  if (error instanceof RitimApiError) return ritimMessage(error);

  if (error instanceof RitimNetworkError) {
    const hint = log.networkHint(error);
    const cause = error.cause instanceof Error ? error.cause.message : undefined;

    return [
      `${error.message}: ${cause ?? 'the connection failed'}.`,
      hint,
      'The expanded "Failure detail" group above has the underlying error code.',
    ]
      .filter(Boolean)
      .join(' ');
  }

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
