# Ritim performance report

A GitHub Action that audits a pull request's preview deployment and comments the
Core Web Vitals result.

> **The preview URL must be publicly reachable.** Google fetches it to run the
> audit, so Vercel Deployment Protection, Netlify password protection or any
> auth wall makes every run fail. Fixing that is step one.

## Usage

```yaml
name: Ritim

on:
  pull_request:
    # `closed` matters: merging is usually the last event a pull request gets,
    # so without it a merged one stays recorded as open forever.
    types: [opened, reopened, synchronize, ready_for_review, converted_to_draft, closed]

# Needed for the comment. GITHUB_TOKEN is read-only by default on anything
# created since 2023, and an action cannot escalate its own permissions. Leave
# it out and the run still measures and records — it warns and skips the
# comment.
permissions:
  pull-requests: write

jobs:
  performance:
    runs-on: ubuntu-latest
    steps:
      # However you deploy. This action does not deploy anything, and reporting
      # before the preview is serving audits an error page.
      - id: deploy
        run: echo "url=https://preview-123.example.com" >> "$GITHUB_OUTPUT"

      - uses: ritim-io/ritim-action@v1
        with:
          project-secret: ${{ secrets.RITIM_PROJECT_SECRET }}
          preview-url: ${{ steps.deploy.outputs.url }}
```

Everything else — the number, title, author, state and commit — comes from the
event payload GitHub already handed the workflow.

## Getting a project secret

Ritim dashboard → your project → Settings → **API secret**. Store it as a
repository secret named `RITIM_PROJECT_SECRET`.

## Inputs

| Input            | Required    | Default                | Notes                                          |
| ---------------- | ----------- | ---------------------- | ---------------------------------------------- |
| `project-secret` | yes         | —                      | `psk_…`, from `secrets`                        |
| `preview-url`    | yes         | —                      | Absolute `http(s)` URL, publicly reachable     |
| `domain`         | conditional | —                      | Production host. See below                     |
| `api-url`        | no          | `https://api.ritim.io` | Override for staging                           |
| `github-token`   | no          | `${{ github.token }}`  | Never needs setting                            |
| `strategies`     | no          | `mobile`               | `mobile`, `desktop`, or both comma-separated   |
| `comment`        | no          | `true`                 | `false` records without commenting             |
| `wait`           | no          | `true`                 | `false` returns as soon as the audit is queued |
| `timeout`        | no          | `180`                  | Seconds to wait before giving up on this run   |
| `fail-on-error`  | no          | `false`                | Whether a failed audit fails the step          |

### `domain`

Which of the project's sites the pull request is work on — the **production**
host (`acme.com`), not the preview one. `pr-11-acme.vercel.app` names a
deployment, not a product.

- A project with **one site** does not need it; Ritim infers it.
- A project with **more than one** does. Omitting it fails with a message naming
  the sites to choose from.

A full URL is accepted, so `${{ vars.SITE_URL }}` works whether it holds
`acme.com` or `https://acme.com/`.

### `strategies`

`mobile` alone takes 30–50 seconds. Adding `desktop` roughly doubles it, because
the two run sequentially against Google's rate limit. Mobile is the profile Core
Web Vitals thresholds are defined against, which is why it is the default.

## Outputs

| Output       | Notes                                    |
| ------------ | ---------------------------------------- |
| `trigger-id` | The audit's id                           |
| `status`     | `running`, `done` or `failed`            |
| `result`     | The result document, as JSON             |
| `comment-id` | The comment created or updated, when any |

## Behaviour worth knowing

**The comment is edited, not repeated.** It is found by a hidden marker
(`<!-- ritim-performance-report -->`), so a branch with twenty pushes has one
comment, not twenty.

**Re-running a workflow costs nothing.** Ritim records one audit per commit. A
re-run of the same commit returns the existing result and skips the comment
update, because nothing changed.

**Fork pull requests are skipped.** A `pull_request` run from a fork gets a
read-only token and no secrets, so the action can neither authenticate nor
comment. It logs a notice and exits successfully — this is a GitHub restriction
and no action can work around it. `pull_request_target` lifts it, but it runs
workflow code from the base branch and is easy to make unsafe; do not reach for
it without reading GitHub's guidance first.

**Only a missing `project-secret` or `preview-url` fails your build.** Without
those two there is nothing to audit and nowhere to send it, so a green step
would be a lie. Everything else — a failed audit, a slow preview, a typo'd
toggle, a rejected secret — is a warning in the log and a green step. This
action is advisory; a performance report that can redden a merge is a report
people delete rather than fix. `fail-on-error: true` turns a failed audit and a
rejected report into failures too.

**A missing `pull-requests: write` never fails the step** — not even with
`fail-on-error: true`. The audit still runs and is still recorded in Ritim; the
run warns that commenting is off and continues. GitHub gives a workflow no way
to ask what its own token may do, so the first comment attempt is what
discovers it.

**Bad input falls back rather than stopping.** `timeout: banana` uses 180,
`comment: ${{ vars.UNSET }}` uses `true`, and `strategies: mobile,desktopp`
audits mobile — each with a warning naming what was ignored.

## Reading the numbers

**"Server response time" is not TTFB.** It is Lighthouse's
`server-response-time` — the document response alone, with no DNS, TCP or TLS.
Single-digit milliseconds is normal and does not mean your server is
extraordinary.

**Only LCP and CLS are banded against Core Web Vitals thresholds.** TBT, FCP and
Speed Index have no published ones, so they take Lighthouse's own score, which
uses a different curve for mobile than for desktop.

These are synthetic measurements taken on Google's hardware. They are not the
real-user data the rest of Ritim reports, and the two will not agree.

## Troubleshooting

The step logs every phase as a collapsible group — the environment it ran in,
the resolved inputs, each HTTP request with its status and duration, each poll,
and the comment. Open the failing group first.

**`Warning: fetch failed`** never appears on its own any more. A request that
could not reach Ritim now fails with the host, the underlying error code, and a
`✗ Failure detail` group holding the whole `cause` chain. The codes worth
recognising:

| Code | Meaning |
| --- | --- |
| `ENOTFOUND` | `api-url` does not resolve — usually a typo. |
| `ECONNREFUSED` | Host resolves, nothing listening on that port. |
| `UND_ERR_CONNECT_TIMEOUT` | A firewall or IP allowlist is dropping GitHub runners. |
| `CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT` | TLS could not be verified — a proxy, or a self-hosted Ritim. |

Connection failures are retried three times with backoff before the step gives
up; an HTTP error status is not retried, because the server has already
answered.

For request and response bodies, re-run with debug logging on: set the
repository secret `ACTIONS_STEP_DEBUG` to `true`, or use **Re-run with debug
logging** in the Actions UI.

## Staging

```yaml
- uses: ritim-io/ritim-action@v1
  with:
    api-url: https://api-staging.ritim.io
    project-secret: ${{ secrets.RITIM_STAGING_SECRET }}
    preview-url: ${{ steps.deploy.outputs.url }}
```

Staging is a separate database with separate projects, so it needs its own
secret.

## Development

```bash
npm install
npm run typecheck
npm run build
```

`dist/index.js` is the artifact GitHub runs — **it must be committed.** GitHub
does not install dependencies for an action, so a stale bundle silently ships
old behaviour. Make CI rebuild and fail if `dist/` differs from the source.

`src/contract.ts` is a hand-maintained **copy** of Ritim's wire format
(`src/shared/pull-request-schema` in the Ritim monorepo). This action has no
dependency on that package on purpose, so a change there is a change here;
`schemaVersion` is what catches it if that is missed.

Tag `v1` as a moving major tag — retag on every backwards-compatible release,
which is what `@v1` in a customer's workflow is expected to mean.
