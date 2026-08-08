import type { AuditResult, LabScores, StrategyOutcome, TriggerResponse } from './contract.js';

/**
 * The pull request comment: rendering it, and putting it in exactly one place.
 */

/** Invisible in rendered markdown, and how the Action finds its own comment to
 * edit rather than posting one per commit. */
export const COMMENT_MARKER = '<!-- ritim-performance-report -->';

type Band = 'good' | 'warn' | 'poor' | 'none';

const BAND_ICON: Record<Band, string> = {
  good: '🟢',
  warn: '🟠',
  poor: '🔴',
  none: '',
};

/** The only two metrics with published Core Web Vitals thresholds. */
const LCP_GOOD_MS = 2500;
const LCP_POOR_MS = 4000;
const CLS_GOOD = 0.1;
const CLS_POOR = 0.25;

/** Lighthouse's own cutoffs, the same ones its report colours by. */
function scoreBand(score: number | undefined): Band {
  if (score === undefined) return 'none';
  if (score >= 90) return 'good';
  if (score >= 50) return 'warn';
  return 'poor';
}

function milliseconds(value: number): string {
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

interface Row {
  label: string;
  value: string;
  band: Band;
}

/**
 * One strategy's table.
 *
 * Two rows are the ones a naive renderer gets wrong, and the comment is where
 * that mistake becomes public:
 *
 * - **`ttfb` is not TTFB.** It is Lighthouse's `server-response-time`, an order
 *   of magnitude below a real one, so it takes Lighthouse's verdict rather than
 *   the 800ms threshold it would always pass.
 * - **TBT, FCP and Speed Index have no published thresholds.** They are scored
 *   against a curve that differs between mobile and desktop; without a score
 *   they render "Not scored" rather than a zero that reads as catastrophic.
 */
function rowsFor(result: AuditResult): Row[] {
  const { lab } = result;
  const scores: LabScores = result.labScores ?? {};
  const rows: Row[] = [];

  rows.push({
    label: 'Performance',
    value: result.performanceScore === undefined ? 'Not scored' : String(result.performanceScore),
    band: scoreBand(result.performanceScore),
  });

  if (lab.lcp !== undefined) {
    rows.push({
      label: 'LCP',
      value: milliseconds(lab.lcp),
      band: lab.lcp <= LCP_GOOD_MS ? 'good' : lab.lcp <= LCP_POOR_MS ? 'warn' : 'poor',
    });
  }

  if (lab.cls !== undefined) {
    rows.push({
      label: 'CLS',
      // `0.04`, not `0.040` — trailing zeros read as more precision than there is.
      value: String(Math.round(lab.cls * 1000) / 1000),
      band: lab.cls <= CLS_GOOD ? 'good' : lab.cls <= CLS_POOR ? 'warn' : 'poor',
    });
  }

  const byScore: [string, number | undefined, number | undefined][] = [
    ['TBT', lab.tbt, scores.tbt],
    ['FCP', lab.fcp, scores.fcp],
    ['Speed Index', lab.speedIndex, scores.speedIndex],
    ['Server response time', lab.ttfb, scores.ttfb],
  ];

  for (const [label, value, score] of byScore) {
    if (value === undefined) continue;
    rows.push({ label, value: milliseconds(value), band: scoreBand(score) });
  }

  return rows;
}

function renderStrategy(result: AuditResult, commitSha: string): string {
  const name = result.strategy === 'mobile' ? 'Mobile' : 'Desktop';
  const rows = rowsFor(result)
    .map((row) => `| ${row.label} | ${row.value} | ${BAND_ICON[row.band]} |`)
    .join('\n');

  return [
    `**${name}** · [preview](${result.finalUrl || result.requestedUrl}) · \`${commitSha.slice(0, 7)}\``,
    '',
    '| Metric | Value | |',
    '| --- | --- | --- |',
    rows,
  ].join('\n');
}

/**
 * Small on purpose. It is read beside the diff by someone deciding whether to
 * approve, not on a dashboard by someone investigating.
 */
export function renderComment(trigger: TriggerResponse): string {
  const outcomes: StrategyOutcome[] = trigger.result?.outcomes ?? [];
  const succeeded = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);

  const sections = [COMMENT_MARKER, '### ⚡ Ritim performance report', ''];

  if (succeeded.length === 0) {
    sections.push(
      `The audit did not produce a result. ${trigger.error ?? ''}`.trim(),
      '',
      `Target: ${trigger.previewUrl}`,
    );
  } else {
    for (const outcome of succeeded) {
      sections.push(renderStrategy(outcome.result, trigger.commitSha), '');
    }
  }

  // Recorded rather than dropped: a desktop number is still worth reading when
  // the mobile audit timed out.
  for (const outcome of failed) {
    const name = outcome.strategy === 'mobile' ? 'Mobile' : 'Desktop';
    sections.push(`> **${name} audit failed** — ${outcome.error}`, '');
  }

  const version = succeeded[0]?.ok ? succeeded[0].result.lighthouseVersion : undefined;

  sections.push(
    `<sub>${version ? `Lighthouse ${version} · ` : ''}` +
      'measured on Google&#39;s hardware, not by real visitors</sub>',
  );

  return sections.join('\n');
}

/** The subset of Octokit this module needs, so the caller owns authentication. */
interface CommentApi {
  paginate: (
    route: unknown,
    parameters: Record<string, unknown>,
  ) => Promise<{ id: number; body?: string }[]>;
  rest: {
    issues: {
      listComments: unknown;
      createComment: (parameters: Record<string, unknown>) => Promise<{ data: { id: number } }>;
      updateComment: (parameters: Record<string, unknown>) => Promise<{ data: { id: number } }>;
    };
  };
}

/**
 * Creates the comment, or edits the one already there. Paginated because
 * Ritim's comment is the oldest on a busy pull request — exactly where the
 * first page is not.
 */
export async function upsertComment(
  api: CommentApi,
  target: { owner: string; repo: string; issueNumber: number },
  body: string,
): Promise<number> {
  const comments = await api.paginate(api.rest.issues.listComments, {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    per_page: 100,
  });

  const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));

  if (existing) {
    const updated = await api.rest.issues.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: existing.id,
      body,
    });
    return updated.data.id;
  }

  const created = await api.rest.issues.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    body,
  });

  return created.data.id;
}
