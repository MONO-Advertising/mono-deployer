# Security review — October 22, 2026

## Current operational state

The Railway publisher is stopped and automatic deployments are disabled. AWS
publishing and queue consumption are enabled in `us-east-2`. Deployer PR #2 and
website PR #18 are merged. The website's tested production container
`dpl_CwCumSTwy6AqQpyiCpLqpRr1b3KD` has been promoted. Public homepage, work, and
news routes return 200; unauthenticated publishing POSTs return 401; a signed
Builder webhook with an unsupported model returns 200 without doing work.
Bot PR #1 is merged and its tested production container
`dpl_5oYa5EqVKKHguW3Mx1KDwpoV1AGb` is promoted. Its live Slack endpoint rejects
unsigned requests with 401. A subsequent Git build may replace that deployment
with the same runtime source.
Both public website domains resolve to the promoted website deployment. The
recent 15-minute error-log checks returned no entries for either promoted build.
AWS final checks confirm active functions, enabled queue mapping, empty main and
dead-letter queues, and the old IAM key still inactive. No real production content
publish has been initiated during these checks.

The managed Lambda interpreter failed the minimum patched-version guard. A
checksum-verified official Node 22.23.4 Linux ARM64 interpreter layer is deployed
through `AWS_LAMBDA_EXEC_WRAPPER`; live health confirmed 22.23.4 and both provider
credentials ready. Isolated export validated 1,155 assets and 61 pages with zero
failed registered assets. A deleted page-only image remains at its original URL
and is reported as missing; this pre-existing content defect does not fabricate a
working mirrored URL. A warm retry completed in about 118 seconds; initial cold
asset copying alone took about 652 seconds. All 2,412 versions under that isolated
validation prefix were subsequently removed. Production objects were untouched.
A synthetic terminal-job duplicate exercised HTTP authentication, durable status,
and queue consumption without exporting content or triggering a Vercel hook.

Vercel runtime probes reported 22.23.2 on managed Node 22 and 24.21.0 on managed
Node 24. No provider backport or mitigation has been verified. Both staged
containers report Node 22.23.4. The user selected temporary patched containers on
October 22, accepting approximately three extra minutes per website build
(225 seconds measured versus about 40 seconds native). Return to managed Vercel
only after its actual runtime patch status is verified. Container image pins and
the Lambda interpreter layer require explicit maintenance for future patches.

Replacement ingress configuration is installed in both Vercel projects for all
environments. Obsolete AWS credentials, Builder private key, and Vercel deploy hook
have been removed from website environment configuration; provider secrets reside
in AWS Secrets Manager. The previous Builder key fails authentication. Deployer
and bot dependency audits report zero findings; website production dependencies
report zero, with two development/build-tool advisories remaining. Tests passed:
34 deployer, 78 website, and nine bot tests. These results do not establish that
an attacker did not previously use the exposed credentials.

## Publishing architecture and security boundaries

Previous confirmed path:

Slack -> Vercel `mono-deploy-bot` -> Railway `mono-deployer` -> Builder ->
S3 `mono-website-assets/builder/*` -> CloudFront -> Vercel `mono-dotcom` deploy hook.

Replacement path:

Slack bot / website publishing routes -> authenticated AWS HTTP API -> SQS FIFO ->
Lambda worker -> Builder reads -> S3 export -> CloudFront invalidation -> Vercel
hook for a full deployment. Sync-only jobs omit the Vercel deployment step.

- Ingress authenticates before accepting work, requires an idempotency identifier,
  and binds job identity to request parameters. A 202 response means queued,
  not published. An authenticated job-status endpoint exposes durable progress.
- One FIFO message group serializes publishing. DynamoDB conditional claims and
  request fingerprints protect against duplicate or conflicting requests. Queue
  insertion precedes recording a queued state so a send failure cannot create a
  falsely accepted job.
- The worker records hook dispatch before contacting Vercel. Ambiguous outcomes
  become `hook_unknown`, requiring reconciliation instead of blind retries.
  `deployment_requested` means Vercel accepted a job, not that production is ready.
- The worker uses temporary execution-role credentials; no replacement IAM access
  key was created. Ingress cannot read the publishing secrets or write S3.
- Worker permissions cover object reads/writes and multipart abort under `builder/*`,
  bucket listing for missing-object HEAD behavior, and invalidation create/read on
  the existing CloudFront distribution. No bucket-policy or deletion permission.
- Secrets Manager separates ingress authentication from Builder/Vercel credentials.
  Secrets are not embedded in SAM outputs or queue payloads. There is no VPC/NAT
  requirement for the public Builder/Vercel APIs and AWS service endpoints.
- Queue visibility is 5,400 seconds for a 900-second worker, batch size one, with
  five receives before the FIFO dead-letter queue. Queue TLS policies, encryption,
  DynamoDB point-in-time recovery, and 30-day function log retention are configured.
  Alarms exist; notification delivery requires an actual configured SNS destination.
  Lambda Errors alone does not count handled partial-batch application failures.

The managed runtime remains on automatic updates, but the bundled interpreter
layer overrides its Node executable. Future Node security patches require updating
and rebuilding that layer until it can be removed after the managed runtime passes
our patch guard. AWS still manages the underlying environment/bootstrap. Verify
compatibility with a deployed smoke invocation after each layer change.

## Credential containment and rotation

| Credential or configuration | Verified state / remaining action |
| --- | --- |
| AWS access-key pair | Exposed user's sole key is Inactive. No replacement pair created. Dedicated Lambda roles replace it. Delete the old key/user after evidence retention and dependency checks. |
| `mono-website-builder` bucket-policy access | Removed from the live bucket policy. The applied semantic diff removes only this user's principal and preserves all other grants. |
| Builder private key | Replacement validated and installed in AWS Secrets Manager. The previous key fails a read-only authenticated asset query; the new key succeeds. |
| Deployment ingress key | New value in AWS and both Vercel projects' environment configurations for all environments. Website and bot promoted with replacement configuration. Railway remains stopped. |
| Builder webhook authentication secret | User rotated it; website environment configuration updated. Signed no-op webhook verified on the live website; unknown requests return 401. |
| Vercel deployment hook | Old hook revoked; replacement installed in AWS publishing secrets. |
| Public Builder API key | Public content-Space identifier; retained. Review content permissions rather than treating it as an administrative secret. |
| Bucket name / distribution ID / port | Configuration identifiers, not credentials; no credential rotation required. |

No fresh credentials have been submitted to Railway. Slack tokens were not in the
supplied Railway variable inventory; do not infer their compromise without evidence.
Inventory shared consumers before removing any additional credentials.

## Code and validation coverage

The deployer has moved from AWS SDK v2 to v3 and the default credential chain,
removed the vulnerable Builder admin SDK dependency tree, refreshed dependencies,
and pinned a patched Node version. The initial dependency audit fell from one
critical, 20 high, 14 moderate, and five low findings to zero reported findings.
That audit describes the scanned dependency state, not proof of application safety;
rerun after final dependency changes.

Asset downloads require approved HTTPS Builder CDN URLs, reject redirects and
embedded credentials, impose a 60-second deadline and a 256 MiB limit, and propagate
failures so page export and deployment do not continue after incomplete asset work.
Page enumeration now paginates beyond the former 100-page cap. Asset rewriting uses
the upload key mapping, and raw extensionless aliases required by existing imgix
bindings are preserved. Saved bindings are restored and hydrated state removed
before export. Isolated validation prefixes permit checking output without a
production cache invalidation or Vercel deployment.

Regression coverage includes authentication and pause gates, queue insertion
failures, deduplication and fingerprint races, worker claims, FIFO failure ordering,
asset failures, ambiguous hook dispatch, sync-only jobs, isolated validation,
pagination, upload/reference consistency, and unsafe asset URLs/download sizes.
SAM lint and the interpreter-layer build checks pass. These local checks do not
replace verifying the deployed runtime, end-to-end export duration, actual IAM
permissions, live caller deployment, and Vercel production readiness.

The bot and website active publishing paths have been migrated in source. Website production container build and public-route smoke checks pass; two
development/build-tool advisories remain (braces and postcss-selector-parser). No PHP source or runtime configuration
was found in the repositories inspected; unrelated PHP hosting remains out of scope.

## AWS exposure and investigation findings

Account: 150101466270. Retired principal: `mono-website-builder`.

- The original bucket resource policy granted this user `s3:*` over the bucket and
  all objects, far beyond publishing requirements. That grant has now been removed.
  `infra/assets-bucket-policy.proposed.json` records the resulting policy despite
  its historical filename. Other legacy full-control principals remain unchanged
  and need their own review; CloudFront and imgix access were preserved.
- The IAM user still exists. The reviewed state had no inline policies or group
  memberships. Its sole attached `AllowMONOWebsiteInvalidation` v1 policy permits
  `cloudfront:CreateInvalidation` on the existing distribution. Bucket-policy
  removal does not itself delete this identity or its attached policy.
- Bucket Block Public Access has all four settings enabled; versioning is enabled;
  default encryption is AES256; server access logs target `monoweblogs`.
- CloudFront `builder/*` uses an S3 REST origin with Origin Access Control. Its
  bucket read grant is constrained to distribution E1S6IGPBXC7JNY. That distribution
  also has a legacy HTTP S3 website default origin; inventory consumers before
  changing it. CloudFront logging is disabled; bucket access logging is separate.
- No trails were returned by describe-trails in us-east-2. This is not an account-wide
  statement about every region, CloudTrail Lake, or data-event coverage.
- Key-specific management-event review for October 15 16:02:05 UTC through
  October 22 16:02:05 UTC found four entries per queried region. In us-east-1:
  two CreateInvalidation and one GetCallerIdentity without recorded errors, plus
  one ListFunctions with AccessDenied. In us-east-2: two GetCallerIdentity without
  recorded errors, one ListFunctions with AccessDenied, and one DescribeRegions
  with Client.UnauthorizedOperation. Discovery calls occurred October 15 and need
  operator attribution. These regional counts are not deduplicated global totals.
- Earlier last-used metadata reported S3 use in us-east-2 at October 22 06:02 UTC.
  Metadata alone cannot distinguish legitimate from unauthorized activity. Ordinary
  management-event history does not cover S3 object access. Access logs and object
  version changes still need investigation; this review gives no clean bill of health.

## Bounded S3 access-log follow-up

Verified logging destination:
`s3://monoweblogs/s3-access-logs/mono-website-assets/` in us-east-2.
Read 165 small log objects containing 178 records, totaling 110,142 bytes, in
memory only. No raw logs, request URLs, or credentials were printed or retained.
All records parsed successfully. The sample used six delivery-hour prefixes:
October 21 at 21:00 and 22:00 UTC, and October 22 at 06:00, 07:00, 15:00, and
16:00 UTC, with at most 30 or 40 objects read per prefix.

The sample contained 132 GET-object requests, 45 HEAD-object requests, and one
HEAD-bucket request. Across all operations, status counts were 98 HTTP 200,
38 HTTP 304, 31 HTTP 403, ten HTTP 404, and one HTTP 400. No PUT or DELETE
appeared in this sample.

Forty-five records explicitly identified `mono-website-builder`: 40 object HEAD
requests returning 200 and five returning 404. Forty-four of those records were
in the October 22 sample whose actual request times span 06:00:52–06:18:01 UTC;
one was in the October 21 sample spanning 21:04:27–21:58:46 UTC. Those are the
containing sample windows, not exact bounds for every attributed request.
The pattern is consistent with the application's existence checks but does not
establish whether requests were legitimate. Attribution to the IAM user is
practical; proving caller intent requires correlation with IPs, user agents, and
known publishing activity.

Four of the six hourly listings were truncated at the imposed limit. Selection
was bounded and nonrandom, not a complete incident-window scan. Delivery prefixes
lag actual request times; the other sample windows covered October 21
20:17:01–20:59:25 UTC and October 22 05:01:36–05:56:12,
13:10:06–14:58:48, and 15:03:33–15:49:27 UTC. S3 server access logging is also
best effort and can be delayed, incomplete, or duplicated. These findings cannot
exclude abuse or substitute for a broader requester-filtered investigation.

Sources:
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/LogFormat.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/ServerLogs.html

## Advisory references

Node's October 21 security release addresses high-severity issues, including
Brotli remote code execution CVE-2026-111497. Patched branches are 22.23.4, 24.22.1,
and 26.12.1. Outbound fetch and the previous JSON request parser warrant patching
without asserting this service was exploited.

- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- https://nodejs.org/dist/v22.23.4/SHASUMS256.txt

PHP CVE-2026-109618 and CVE-2026-109619 are critical remote-code-execution issues;
patched branches are 8.2.35, 8.3.36, 8.4.27, and 8.5.12. They do not apply to the
inspected Node-only repositories. Source: https://www.php.net/

Railway's incident disclosed potential customer environment-variable exposure.
Provider-side revocation can be completed independently of Railway recovery.
Current publishing containment is the stopped service and disabled automatic
deployments, not reliance on the platform's incident state.
Source: https://status.railway.com/incident/QH8L8B3E

Architecture references:
- https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html
- https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html
- https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
- https://docs.aws.amazon.com/lambda/latest/dg/runtimes-modify.html
- https://vercel.com/docs/deploy-hooks

## Remaining cutover gates and limitations

1. Retain the verified Node 22.23.4 Lambda layer and runtime gate; verify ingress
   execution and authentication with all publishing gates still closed.
2. Preserve verified old Builder-key rejection and publishing-secret readiness;
   finish inventorying any other consumers without exposing credential values.
3. Diagnose the isolated page-export asset-metadata failure and rerun the full
   export. Verify asset references, page count, bindings, output contents, and
   duration within Lambda's 15-minute ceiling. Split/checkpoint jobs if needed.
4. Complete container-fallback testing for the bot and website, prove the actual
   execution runtime is patched, and verify routes and authentication before
   any production promotion. A successful build or saved environment is insufficient.
5. Enable publishing/queue consumption deliberately, observe a full job through
   CloudFront and Vercel production readiness, and test job-status/error handling.
6. Confirm old Railway integrations cannot resume publishing; finish retiring the
   platform and old IAM identity after evidence retention and consumer inventory.

Page writes remain visible individually rather than as an atomic complete export.
Versioned export prefixes with a promotion step are a future hardening option.
Preserve the existing public serving infrastructure during cutover. Rollback must
not reactivate exposed AWS credentials or restart the compromised Railway setup.

## Verified isolated export result

The deployed worker completed a validation export of 1,155 Builder assets and
61 pages on Node 22.23.4 in 117.984 seconds with existing mirrored assets. It
reported zero asset download failures and one pre-existing deleted Builder image
reference (`c4c55951f3a34fa6a41df04750f923f6`). The original URL is retained and
reported rather than replaced with a nonexistent S3 URL. Registered asset download
failures and non-404 metadata failures still stop publishing. The initial cold
asset-copy run plus page failure took approximately 652 seconds; retries reuse
mirrored assets. Production invalidation and deploy-hook timing still need live
operational confirmation.
