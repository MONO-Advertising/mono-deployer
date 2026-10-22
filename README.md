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

## Infrastructure and credentials

`infra/template.yaml` deploys stack `mono-deployer-production` in `us-east-2`.
Initial deploys must use `WorkerEnabled=false PublishEnabled=false`. Populate
`mono-deployer/production/publishing` in Secrets Manager with `BUILDER_PRIVATE_KEY`
and `VERCEL_DEPLOY_WEBHOOK`; the generated raw ingress secret is separate.
Configure callers with `DEPLOY_API_ENDPOINT` and `DEPLOYMENT_KEY`. Builder's
webhook secret stays separate in the website's `BUILDER_WEBHOOK_SECRET`.
Never commit secrets or place fresh credentials in Railway.

Run direct IAM-authorized worker events `{"healthcheck":true}` and
`{"validate":true}` before enabling. Validation writes only to a new
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
keys preserve canonical and extensionless aliases. Exports write the current
prefix in place; they are not atomic releases. S3 versioning supports recovery.

The Express entry point remains for local development, not Lambda production.
Copy `.env.example` privately to `.env` if using it. Its lock is process-local.
See `SECURITY-REVIEW-2026-10-22.md` for incident findings and cutover status.
