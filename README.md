# MONO publishing service

The production target is an authenticated HTTP API → SQS FIFO → Lambda worker.
Slack, the website publish button, Builder webhooks, and the nightly cron enqueue
jobs. The worker mirrors Builder assets/pages into S3, waits for CloudFront
invalidation, then requests a Vercel build for `deploy` jobs. `sync` jobs stop after
invalidation. Existing website serving remains on Vercel/S3/CloudFront.

Use Node **22.23.4** or a newer patched 22.x and pnpm 10.27.0.
Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build:lambda`,
and `python3 scripts/build-node-runtime.py`. The last command builds the
checksum-verified Linux ARM64 Node layer used until the managed interpreter is
patched. Update its pinned version/checksum for subsequent security releases.
The Lambda runtime rejects older Node releases. AWS access uses execution roles;
do not restore the disabled Railway IAM key.

## When to publish, sync, or rebuild

Normal copy, image, and layout edits using existing components should be published in Builder. The authenticated Builder webhook is designed to enqueue **sync only**: a page event selects its page ID, known tile models refresh their mapped index page, and header/footer/site changes refresh all pages; unknown models do no work. After S3 export and CloudFront invalidation, ordinary CMS changes do not require a Vercel rebuild: the website reads page content with `no-store` and renders its catch-all route dynamically. We verified real Slack publishing end to end, but have **not verified a real Builder publish event's delivery or the webhook configuration in Builder's portal**.

| Action | When to use it |
| --- | --- |
| **Publish in Builder** | Normal content edits; the configured webhook should sync them automatically. |
| **Sync content only** in Slack | Recover from a failed/missing webhook, refresh after correcting a missing image, or deliberately refresh content in bulk. |
| **Publish + rebuild** in Slack | An intentional full refresh and rebuild, including changes affecting build-time output. Code/runtime/config changes require a code deployment; merging code to `main` normally triggers that automatically. |

See [the publishing client](../mono-dotcom/src/lib/publishing-client.ts) and
[content reads](../mono-dotcom/src/lib/get-content.ts) for routing and cache behavior.

## Infrastructure and credentials

`infra/template.yaml` deploys stack `mono-deployer-production` in `us-east-2`.
Initial deploys must use `WorkerEnabled=false PublishEnabled=false`. Populate
`mono-deployer/production/publishing` in Secrets Manager with `BUILDER_PRIVATE_KEY`
and `VERCEL_DEPLOY_WEBHOOK`; the generated raw ingress secret is separate.
Configure callers with `DEPLOY_API_ENDPOINT` and `DEPLOYMENT_KEY`. Builder's
webhook secret stays separate in the website's `BUILDER_WEBHOOK_SECRET`.
Never commit secrets or place fresh credentials in Railway.

Run direct IAM-authorized worker events `{"healthcheck":true}` and
`{"validate":true}` before enabling. A retry may pass `validationId` with the
UUID of its existing isolated test prefix; arbitrary prefixes are rejected. Validation writes only to a new
`builder/validation/<uuid>/` prefix and does not invalidate production or invoke
Vercel. Enable the queue and application gate only after validation and caller
cutover. Keep the Vercel deploy-hook branch current with the migrated source.

## API and job handling

`POST /api/deploy` requires `x-deployment-key` and a stable `Idempotency-Key`
(16–128 URL-safe characters). Optional JSON: `{"mode":"deploy"}` or
`{"mode":"sync","pageId":"..."}`. Accepted requests return HTTP 202 and `jobId`.
Authenticated `GET /api/jobs/<jobId>` reports state. Acceptance is not completion.
Retry the same logical request with the same key and payload. Conflicting payloads
and terminal duplicates return 409 with status. Do not automatically retry a
`hook_unknown` job: verify Vercel first because the hook may have succeeded.

One FIFO message group serializes publishing. DynamoDB leases and fingerprints
prevent conflicting execution; retries checkpoint exported paths and invalidations.
Failed jobs eventually reach the dead-letter queue. CloudWatch alarms exist;
set `AlarmTopicArn` to connect an existing notification destination. Partial batch
failures are caught by the DLQ alarm, not the Lambda Errors metric alone.

Only HTTPS `cdn.builder.io` assets are fetched, without redirects. Downloads have
a 60-second deadline and a 256 MiB limit. Published pages are paginated and asset
keys preserve canonical and extensionless aliases. A deleted upstream image
referenced only by page content stays at its original URL and is reported in
`missingAssets`/job `missingAssetCount`; registered asset download failures still
stop publishing. Exports write the current
prefix in place; they are not atomic releases. S3 versioning supports recovery.

The Express entry point remains for local development, not Lambda production.
Copy `.env.example` privately to `.env` if using it. Its lock is process-local.
See `SECURITY-REVIEW-2026-10-22.md` for incident findings and cutover status.

## System documentation

See [the architecture and operations guide](../mono-dotcom/docs/architecture.md) for the
website, Slack bot, Builder, image/video delivery, AWS publishing, trust boundaries,
and recovery procedures. The security review records incident-specific evidence
and verification limits.


## Slack progress and exact deployment tracking — rollout checkpoint

The upgrade maintains one Slack status card with **Publish + rebuild**
and **Sync content only** actions, asset/page counts, cache/build phases, elapsed
time, and a **Check status** button. The button reads status; it never starts a
second publish. Numeric exporter callbacks are awaited, caller-throttled, and
non-fatal if telemetry fails.

A separate `monitor.handler` Lambda queries active jobs through `MonitorIndex` on
a one-minute EventBridge schedule. `StatusEnabled` defaults to false. It sends
changed snapshots to `/internal/publishing-status` on the bot, signed with a
separate timestamped HMAC secret (`StatusSecret` / `BOT_STATUS_SIGNING_SECRET`).
The bot verifies the raw body signature and five-minute timestamp window and
updates the existing message. No Slack OAuth token is needed in the publisher.

When a Vercel API token is available, the worker creates the website deployment
with `meta.publishingJobId`, records its exact deployment ID, and leaves tracking
to the monitor. “Published” requires the matching project/job/production deployment
to be READY and both the project production target and canonical `www.mono-1.com`
alias to point to that exact deployment. These references are checked before and
after a successful bounded HTML check of the public homepage. A ready preview or healthy old site is
not sufficient. Legacy hook jobs lacking an exact deployment ID cannot be
reported live automatically. Tracking failures stay unknown/pending; unresolved
jobs older than 24 hours need attention.

AWS progress/monitor infrastructure is deployed (`UPDATE_COMPLETE`) and its
minute schedule is enabled with `StatusEnabled=true`. Bot PR 3 merged at
`ae478695`; production deployment `dpl_2qJaSAqazabUV9hJHud378Gngtqg` has its production alias verified
on Node 22.23.4. Unsigned callback requests returned 401; a correctly signed
unknown-job callback returned 404 after authentication, without sending Slack
messages.

Dedicated API rebuild verification was accepted as deployment
`dpl_7a2HiCQx2Ck3HWBirD1wdGY3fk7G` and completed READY with production target.
Its correlated job is
`7af5c8688eb098b23ea58457abe189d37dc372b3bef1d7026a1fedf0f82654bf`.
The scheduled monitor independently recorded `status=live`, `phase=live`, and
`monitorCheckedAt=1792699571`, then removed `monitorKey`, confirming the exact
deployment, production-alias, and HTML-health verification path. This test performed
no CMS export. A subsequent real Slack publish completed production export, deployment,
and notification: job `c8976c8774acc8e487b59151b218f3ca37e63b0735fea64625300f6ebae7a1ce`
reached `live` for `dpl_AaYHfsfo6R9rvYVNHCunhCy95roX`, with `monitorKey` removed.
It reused 1,155 assets and processed 61 pages in 482 seconds end to end, before
the optimization below. One known deleted Builder image on `/work/lidl` remains
an editorial repair; its source URL was preserved and the Slack thread received
a warning explanation. See the architecture guide for the exact entry and field.

Asset sync now uses a paginated prefix-only S3 inventory (50,000-key/100-page
limits), eight workers, and two download/upload slots. Known existing canonical
objects and raw aliases skip HEAD requests; absent keys still receive HEAD checks,
and missing aliases are repaired. Inventory failures stop the export. Progress
callbacks remain ordered under concurrency. A local read-only benchmark over the
same 1,155 assets improved from 124.603 seconds / 2,307 HEAD requests to 35.568
seconds / three LIST requests (about 71% less time, 3.5× faster), with writes
blocked and no failures. This is not a Lambda or total publish-time benchmark.

The optimization and stable primary-host callback fix are deployed: AWS reports
`UPDATE_COMPLETE`, worker health confirms Node 22.23.4 and ready secrets, and
publishing is enabled. Signed unknown-job callback verification returned 404;
an idle monitor invocation completed without errors. Publisher tests: 64 passing;
bot tests: 30 passing.

The installed `mono-publishing-status` token is verified as scoped only to the
`mono-dotcom` website project (`prj_bsxsisiRxAzCsu5HcBMXMZ2Avwfv`). It is stored
as `VERCEL_API_TOKEN` in `mono-deployer/production/vercel-automation`
(`TrackingSecret`). Worker and monitor read that separate secret; the monitor
cannot read Builder credentials in `PublishingSecret`. The wrong bot-scoped token
was revoked. The callback signing secret remains separate.

The token expires October 22, 2027 at 20:54 America/Chicago (October 23 UTC).
Renewal reminders exist for September 22 and October 15, 2027; they do not perform
the rotation. Replace the scoped token before expiration and verify access to the
intended website project. See [the architecture guide](../mono-dotcom/docs/architecture.md) for
the full state, verification limits, and trust model.
