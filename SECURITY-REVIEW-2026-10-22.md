# Security review — October 22, 2026

## Current operational state

The Railway publisher has been stopped and automatic deployments disabled. The
replacement AWS publishing infrastructure has been created in us-east-2, with
publishing and queue consumption paused. Production cutover is not complete;
no claim is made that the branches are merged or a complete production publish
has succeeded. Existing S3/CloudFront content remains the serving path.

The initial managed Lambda Node runtime failed the minimum patched-version guard.
A checksum-verified official Node 22.23.4 Linux arm64 interpreter layer is deployed
through `AWS_LAMBDA_EXEC_WRAPPER`. A live worker health check confirmed Node
22.23.4 and both publishing credentials ready. An isolated full export is being
validated before opening the publishing gates.
The guard remains enabled.

The new ingress endpoint and authentication key have been installed in both
Vercel projects' environment configurations for all environments. Those changes
apply to future deployments; they do not prove the existing live deployment has
loaded the replacement values. Bot and website publishing source paths have been
migrated locally to the queued AWS interface. Website production dependency audit reports zero findings; two build-tool
advisories remain documented in its migration PR. Obsolete AWS keys, Builder
private key, and Vercel hook have been removed from all website environments;
only the Lambda worker needs the provider secrets. A read-only check of the
previous Builder private key returned authentication errors, confirming it no
longer authenticates. Thirty deployer tests pass on patched Node.

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
| Deployment ingress key | New value in AWS and both Vercel projects' environment configurations for all environments. Complete/recheck deployments so live callers use it. Railway remains stopped. |
| Builder webhook authentication secret | User rotated it; website environment configuration updated. Validate the new webhook path after website deployment. |
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

The bot and website active publishing paths have been migrated in source. Final
website audit/build results remain pending. No PHP source or runtime configuration
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

1. Finish deploying the interpreter layer and verify both functions execute the
   patched runtime with all pause gates still closed.
2. Confirm exposed Builder-key revocation; verify AWS publishing secrets and
   ingress authentication without logging values.
3. Run a representative export against an isolated prefix; verify asset references,
   page count, bindings, output contents, and duration within Lambda's 15-minute
   ceiling. Split/checkpoint jobs if the full workload approaches that ceiling.
4. Complete website dependency/build review and deploy the updated bot and website.
   Verify their live routes and new authentication, not just saved environments.
5. Enable publishing/queue consumption deliberately, observe a full job through
   CloudFront and Vercel production readiness, and test job-status/error handling.
6. Confirm old Railway integrations cannot resume publishing; finish retiring the
   platform and old IAM identity after evidence retention and consumer inventory.

Page writes remain visible individually rather than as an atomic complete export.
Versioned export prefixes with a promotion step are a future hardening option.
Preserve the existing public serving infrastructure during cutover. Rollback must
not reactivate exposed AWS credentials or restart the compromised Railway setup.
