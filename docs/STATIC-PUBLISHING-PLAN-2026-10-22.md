# MONO: faster pages and simpler publishing

Prepared October 22, 2026. Planning report; no production settings or application code changed.

**Status, October 22:** Phase 1 is live for every public page, widened from `/work` at the team's request (website PR 19, deployment `dpl_4nmqBfBNemgxhC2jD4htfbxzGKQ8`). Warm production pages measured 166 ms median. See [Cache and freshness boundaries](ARCHITECTURE.md#cache-and-freshness-boundaries) and the website's [public HTML cache](../../mono-dotcom/docs/public-html-cache-2026-10-22.md) notes. Phases 2–4 have not started.

## Recommendation

Keep Builder, Vercel, Slack publishing, Mux, and Imgix. First enable safe caching of public HTML. Then make production a frozen, prerendered release, with live Builder content confined to the editing/review environment. Evaluate Craft separately for editorial experience and seat economics; a CMS migration is not required to fix the speed problem.

The intended staff workflow stays:

**Edit in Builder → review stage.mono-1.com → deploy in Slack → updated public website.**

No on-prem server. No image/video provider migration in this project. No requirement for staff to use GitHub or the Vercel dashboard.

## What we know

The current operations guide is [ARCHITECTURE.md](ARCHITECTURE.md). Older workspace documentation describes superseded infrastructure.

The production website exports Builder JSON into S3, reads it through CloudFront, then dynamically renders pages on Vercel. The catch-all route uses `force-dynamic`; its snapshot fetch uses `no-store`. Saved content bindings can fetch Builder at request time. Both metadata and page rendering use this reader. The existing exporter deliberately restores live bindings instead of freezing their results.

The deployment is currently a Next.js standalone container on Vercel, not a standard managed Next deployment. Do not assume managed ISR behavior or globally coordinated invalidation from framework configuration alone.

Slack publishing works and reports progress. However, Builder webhooks and nightly full syncs can modify production content without Slack approval. Real Builder event delivery remains unverified in the operations guide. Current snapshots are overwritten in place, so a code rollback does not necessarily restore content.

Three HTTP GET timing samples from the same machine on October 22:

| Work page | Time to first byte | Compressed HTML | Observed headers |
|---|---:|---:|---|
| Colle McVoy | 160, 165, 160 ms | 84 KB | `Craft CMS,Blitz`; shared-cache lifetime of one year |
| MONO | 1,230, 596, 885 ms | 31 KB | `private, no-cache, no-store`; Vercel `MISS` |

These are small, local HTTP samples, not browser LCP measurements, a global benchmark, or proof of which cache served Colle McVoy. They show a substantial response-time gap before media loading even begins. Their headers identify Craft and Blitz; they do not prove the complete hosting architecture. Their larger site is not inherently harder to serve quickly: a cached page need not render or query the rest of the site on each visit.

## What caching will improve

| Layer | What it stores | Current situation / effect of the plan |
|---|---|---|
| Public HTML | Finished page markup | Main immediate opportunity. A cache hit avoids repeated page rendering and upstream content reads. |
| Content/data cache | Builder responses or snapshot JSON | Can accelerate a cache miss, but is not a substitute for caching finished HTML. CloudFront already caches snapshot objects. |
| Image CDN | Imgix renditions by URL and parameters | Already operating. Earlier charts show 81.6K requests and 17.7K CDN misses, approximately 78% hits by request. |
| Video delivery | Mux playback resources | Separate from website HTML caching. Playback still depends on player startup, buffering, connection, and loading policy. |
| Browser cache | Locally retained assets | May avoid network requests entirely, depending on response headers and freshness. |
| JS/CSS | Versioned application files | Hashed assets should retain long-lived immutable caching. This does not eliminate JS execution cost. |

An image is not fetched through the HTML cache just because its URL appears on a cached page. The browser discovers the image, checks its local cache, then may request Imgix. Imgix can return a cached rendition or fetch/transform an original on a miss. Mux has its own delivery path.

Faster HTML can make media appear sooner because the browser learns what to fetch earlier. It does not directly reduce image bytes or make a late JavaScript-triggered request start immediately. Once HTML is fast, measure image discovery, above-the-fold loading priorities, responsive sizes, player initialization, and JavaScript work separately.

## Phase 1 — urgent public-page caching

**Priority: next implementation task.** This is smaller than the static-release migration. Plan for a short implementation and validation cycle, potentially a same-day prototype, rather than promising a five-minute production toggle. Container/CDN behavior is the main uncertainty.

### First experiment

On an isolated deployment, test a narrowly scoped shared HTML cache for `/work`, then `/`, `/news`, and representative detail pages. Start with a 60-second shared-cache lifetime, browser revalidation, and no long stale-serving window. A short lifetime limits additional staleness while the current publishing path is still mutable. This is a proposed policy, not an already verified configuration.

Use Vercel's supported response cache controls at a layer that can inspect the final response. Verify that Next.js does not overwrite the policy and that the container service is eligible for the intended CDN caching. Do not assume adding a header in `next.config` fixes the live response. If the experiment cannot safely produce cache hits, move immediately to the production/preview route separation below rather than layering another CDN in front.

Cache only successful, anonymous public HTML GET responses. Exclude authenticated requests, requests that can alter preview/targeting, responses with cookies, error pages, `/api`, `/deploy`, labs, and editing/review hosts. Initially bypass unknown query strings and cookie-bearing requests; explicitly classify harmless analytics cookies later if bypass volume is high. Maintain host separation. Avoid indiscriminate `cache everything` rules.

Next App Router also requests React Server Component payloads. In a conservative HTML-only pilot, bypass those requests and prefetch variants. Do not strip `_rsc`, collapse HTML and RSC into one cache entry, or cache router-state-dependent responses as generic HTML. Verify ordinary navigation as well as reloads. [Next CDN guidance](https://nextjs.org/docs/app/guides/cdn-caching)

### Freshness and publishing

During this temporary phase, content export and CloudFront invalidation happen first. A new HTML cache adds its own freshness delay; invalidating CloudFront JSON does not purge HTML on Vercel. Either integrate a verified Vercel purge and warm-up for affected paths, or explicitly report that the origin is updated and public caches may take the configured freshness interval to catch up. Upstream cache freshness also contributes. Do not label a queued job as live.

Do not assume `revalidatePath` on one container purges the outer CDN or every other instance. Prefer a bounded TTL for the initial experiment over introducing Redis or another persistent service. [Next self-hosting guidance](https://nextjs.org/docs/app/guides/self-hosting)

### Acceptance and rollback

- Repeated eligible GETs show a verified CDN cache hit and lower TTFB on the real deployment path, not merely a locally changed header.
- Preview edits remain fresh and never appear in anonymous cached production responses.
- Reloads, client navigation, filters, pagination, metadata, and mobile layouts still work.
- Authentication and APIs are never shared-cached; unknown routes return correct status codes.
- A content update becomes visible within the documented freshness policy. Global navigation/header updates refresh all affected pages.
- Disable the new policy and purge its entries if incorrect content or response variants appear; retain the previous deployment for rollback.

Measure at least ten cold/warm samples per representative route, with stable browser/device conditions. A provisional warm-HTML target is under 300 ms from the same test location; this is an acceptance goal, not a global guarantee. Record mobile LCP, CLS, JS transfer, and first image/video request timing too.

Relevant platform reference: [Vercel cache-control headers](https://vercel.com/docs/caching/cache-control-headers).

## Phase 2 — separate live review from public delivery

Use the same codebase and components with explicit deployment modes:

- **Stage/editor:** protected review access where appropriate, no indexing, direct Builder content, fresh previews. Builder's Publish action means available for stage review. Unsaved/unpublished drafts use explicit Builder preview flows.
- **Production:** published release content only. No arbitrary Builder editing parameters or visitor-dependent CMS reads in public page generation.

Verify stage's deployed configuration, Builder iframe/preview URLs, access protection, and source selection; its live configuration has not been audited in this conversation. Do not rely solely on `__builder_editing__` to distinguish all preview cases.

Keep optimized Builder images on stage initially so newly uploaded assets work immediately. Copy referenced originals for production Imgix during release preparation. If exact stage/production image parity is needed later, synchronize new images independently of production content approval. Mux references remain unchanged.

Once this separation is verified, stop Builder webhooks and the nightly sync from mutating the current public release. They may support stage refresh or asset maintenance, but only an authorized release action changes production content. Keep existing safeguards until the replacement path passes verification.

## Phase 3 — frozen content and prerendered production

At Slack deployment, run one release workflow:

1. Allocate a release ID and record the approved code commit.
2. Capture all routable published pages, shared content, listing data, metadata, and pagination dependencies. Resolve saved HTTP bindings, including Work Tiles, into the release. Reject unexpected live bindings rather than silently retaining them.
3. Record content IDs/revisions/hashes and capture time. Builder exports span multiple calls; detect changes during capture or require a brief editorial freeze. A single API traversal is not automatically a transactionally consistent snapshot.
4. Copy missing referenced media using existing asset logic. Preserve stable Imgix URLs; use versioned names when an original changes. Do not overwrite an image needed by an older release.
5. Generate all known public pages, metadata, sitemap, redirects, and a real 404 from the captured content. Use Next static generation where possible; preserve client-side interactivity. Keep required administrative/API functions dynamic and separate.
6. Build a staged production deployment containing that exact snapshot or pointing exclusively to its immutable release prefix. Never regenerate from live Builder during promotion.
7. Check representative pages, links, images, video posters/playback, navigation, and release identity. Promote the successful deployment; a failed build leaves production unchanged.
8. Report the release URL and completion in Slack. Keep previous deployments and snapshots for rollback.

Prefer build-time prerendering of the roughly 61 previously exported pages over request-time regeneration. Determine the actual current route count during capture. New/deleted pages should enter/leave production only with a release. Any pagination/search requests in production must read release-scoped data too.

The long-term public request path becomes **visitor → Vercel cached/static page**, with separate **browser → Imgix** and **browser → Mux** paths. Builder is needed for editing and release creation, not for normal public content delivery.

If retaining containers, prove that generated pages and static assets are delivered correctly through the CDN. A return to standard managed Vercel Next hosting is desirable only after the actual serving runtime meets the existing patch requirement. Do not relax that requirement for convenience.

Stage is intentionally live. A Slack release captures its current eligible content, which might differ from what someone reviewed earlier. Initially use a short no-edit approval window; add a fixed candidate-review URL later if exact reviewed-artifact approval is required. Preserve this distinction in staff instructions.

## Phase 4 — simplify operations after the new flow works

Retain the existing queue/worker during transition. Then evaluate moving snapshot preparation into the platform build job, leaving the bot as a small authenticated trigger and status interface. Do not delete retries, serialization, or job tracking before their replacements are demonstrated.

Potential retirements: production JSON CloudFront reads/invalidation, content-only production sync, nightly content overwrite, legacy deploy entry points, and some custom cross-provider monitoring. S3 remains useful for Imgix originals and optionally release archives. The exact AWS services removable depend on where the release job ultimately executes.

A deployment rollback must restore code and snapshot together. Media originals needed by retained releases must remain available. Mutable Mux assets/default posters can still change independently; prefer explicit stable references where visual rollback fidelity matters.

## Builder versus hosted Craft

| Consideration | Builder + static Next releases | Hosted headless Craft + static Next | Hosted Craft + Twig + Blitz/native page cache |
|---|---|---|---|
| Editorial experience | Existing visual workflow and staff investment | Structured content and modeled blocks; preview integration required | Structured fields/blocks with Craft live preview |
| Frontend reuse | Highest; existing React components retained | React components partly reusable; Builder block renderer/content need replacement | Significant template/frontend rebuild |
| Speed potential | Cached/prerendered HTML | Cached/prerendered HTML | Cached rendered HTML |
| Who caches public pages? | Next/Vercel release architecture | Next/Vercel release architecture | Blitz or hosting-native cache |
| CMS operations | SaaS-managed | Hosted PHP/database application plus frontend | Hosted PHP/database application and templates |
| Seats | Current $24 per additional seat/month invoiced | Craft licensing can accommodate more editors without per-seat fees | Same Craft license economics |
| Migration burden | Focused delivery refactor | Content schemas, migration, previews, bindings, QA | Those changes plus template/frontend migration |
| Fit now | Recommended | Future alternative if Builder value is poor | Strong long-term simplicity option if accepting a rebuild |

**Headless Craft plus Blitz is not the same architecture as Craft-rendered pages plus Blitz.** Craft's GraphQL API can feed a static generator, but Blitz does not automatically cache HTML rendered by a separate Next application. Switching only the CMS while retaining MONO's uncached frontend would leave the central performance issue unresolved. [Craft GraphQL](https://craftcms.com/docs/5.x/development/graphql.html)

Blitz generates and refreshes cached Craft pages and can integrate with reverse-proxy delivery. Its default automatic refresh behavior would still need alignment with MONO's Slack approval requirement. [Blitz documentation](https://putyourlightson.com/plugins/blitz)

Craft Cloud already provides dependency-aware full-page caching and preview/session bypasses. Assess that built-in system before adding Blitz; do not assume the plugin is necessary or universally compatible with every hosting setup. [Craft Cloud static caching](https://craftcms.com/docs/cloud/static-caching)

## Cost comparison and decision gate

Known MONO invoices: Builder $72/month for three seats ($864/year); prior five-seat bill $120/month. Imgix $25/month. Vercel's reported $20/month supports other projects too. Mux's plan is covered through the user's Vercel arrangement; usage charges remain account-dependent. These shared costs should not all be attributed to the public site. Current Builder screenshots show low usage (3 GB current / 10 GB previous cycle against 100 GB), while all three seats are occupied.

Current published Craft licensing: Team $279/project, up to five users; Pro $399/project, unlimited users. Both include one year of updates, then $99/year for updates. Hosting is additional for these licenses. Existing MONO license eligibility was not checked. [Craft pricing](https://craftcms.com/pricing)

Blitz lists $99 initially and $69/year after the first year. Thus a new independently hosted Team + Blitz installation is $378 in initial licenses, then $168/year in renewals, plus hosting and maintenance. Pro + Blitz is $498 initially with the same listed renewal total. Headless Craft generally does not need Blitz just to accelerate the separate Next frontend. [Blitz pricing](https://plugins.craftcms.com/blitz)

Craft Cloud displays Team at $120/month and Pro at $240/month with annual billing, including the corresponding CMS license. That is $1,440 or $2,880/year before extras. Confirm billing cadence/checkout pricing. It is a managed convenience option, not an obvious subscription saving versus MONO's current Builder bill; headless use also retains frontend hosting. [Craft Cloud plans](https://craftcms.com/cloud)

A third-party managed Craft host may produce different economics, but obtain a real quote covering backups, updates, staging, and support rather than assuming cheap infrastructure means cheap maintenance. A CMS switch must also repay migration and training effort. Reassigning an unused Builder seat to a MONO editor is the immediate low-effort access improvement; do not change accounts as part of cache work.

Reconsider Craft after the Builder site is cached and a real browser benchmark is available. The question then becomes whether its editing model, ownership, and multi-user economics justify migration—not whether Builder can serve fast pages.

## Delivery sequence and completion criteria

1. **Urgent cache experiment and rollout:** isolated `/work` proof, preview/auth/RSC checks, production verification. Same-day prototype is plausible; allow 1–2 engineering days if route/container constraints require changes. Estimate only, not a delivery commitment.
2. **Production/stage separation and frozen-release prototype:** homepage, work listing, one case study, one news page; validate snapshot completeness and media behavior.
3. **Full-route generation and publishing cutover:** Slack is the sole production content gate; verify failures, new/deleted pages, pagination, and rollback.
4. **Retire redundant services and update operations:** only after end-to-end release and recovery tests pass. Size phases 2–4 after the prototype; plan in days to low weeks rather than a one-line config change.

The project is complete when anonymous public content has no request-time Builder dependency, warm public pages are demonstrably cached, editorial previews stay fresh, production changes require Slack release, failures preserve the old site, and rollback restores its content. Mux and Imgix remain in place throughout. Faster first-byte delivery is necessary, but final performance acceptance also requires browser measurements of visible content and media.
