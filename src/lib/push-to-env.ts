import path from 'path';
import { fetchEntries, fetchOneEntry } from '@builder.io/sdk-react';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { CloudFrontClient, CreateInvalidationCommand, waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront';
import { fetchAsset, validateAssetUrl } from './asset-fetch';
import { computeS3KeyParts, existingKeys, exportStorageConfig } from './assets';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
const cloudfront = new CloudFrontClient({ region: 'us-east-1' });


function safeDecodePath(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes('%') ? decodeURIComponent(decoded) : decoded;
  } catch { return value; }
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_')
    .replace(/__+/g, '_').replace(/^_+|_+$/g, '').substring(0, 255) || 'index';
}

// Asset upload and page references must use exactly the same key algorithm.
async function replaceUrls(obj: any, cache: Map<string, string>, missingAssets: Set<string>): Promise<void> {
  for (const key of Object.keys(obj)) {
    if (['workTile', 'workTile2', 'newsTile'].includes(key)) continue;
    if (typeof obj[key] === 'string') {
      const matches: string[] = obj[key].match(/https?:\/\/[^\s)"'<>]+/g) || [];
      for (const match of matches) {
        const url = new URL(match);
        if (url.origin !== 'https://cdn.builder.io' || !/^\/api\/v1\/(image|video|raw)\//.test(url.pathname)) continue;
        validateAssetUrl(match);
        if (!cache.has(match)) {
          url.searchParams.delete('width');
          url.searchParams.delete('alt');
          const response = await fetchAsset(url.href, 'HEAD');
          if (response.status === 404) {
            // A deleted upstream image already referenced by a page must not become
            // a fabricated S3 URL. Preserve its original reference and report it.
            missingAssets.add(url.pathname);
            console.warn(JSON.stringify({ event: 'missing_source_asset', path: url.pathname }));
            cache.set(match, match);
            continue;
          }
          if (!response.ok) throw new Error(`Asset metadata request failed (${response.status}) for ${url.pathname}`);
          const parts = computeS3KeyParts({ id: 'asset', name: null, type: null, url: url.href }, url, response.headers.get('content-type'));
          cache.set(match, `${exportStorageConfig().publicBaseUrl}/${parts.s3RelativeKey}`);
        }
        obj[key] = obj[key].replace(match, cache.get(match)!);
      }
    } else if (obj[key] && typeof obj[key] === 'object') {
      await replaceUrls(obj[key], cache, missingAssets);
    }
  }
}

/** A routable page's snapshot key: the rule mono-dotcom scripts/audit-orphan-snapshots.ts mirrors, exportslug included. */
function snapshotKey(page: any, prefix: string): string | undefined {
  const query = page.query?.find((q: any) => q.property === 'urlPath');
  if (!query) return undefined;
  const rawPath = Array.isArray(query.value) ? query.value[0] : query.value;
  if (typeof rawPath !== 'string') throw new Error('Invalid published page URL path');
  const decoded = safeDecodePath(rawPath);
  const parts = (decoded === '/' ? '/index' : decoded).split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) throw new Error('Unsafe published page URL path');
  const filename = sanitizeFilename(page.data?.exportslug || parts.at(-1) || 'index') + '.json';
  return path.posix.join(prefix, 'pages', ...parts.slice(0, -1), filename);
}

const builderRequest = (apiKey: string) => ({
  model: 'page', apiKey,
  options: { includeUnpublished: false, includeRefs: true, cachebust: true },
  canTrack: false,
});
type BuilderRequest = ReturnType<typeof builderRequest>;
// Enough of each page to compute its snapshot key, without page bodies.
const KEY_FIELDS = 'id,query,data.exportslug';

async function listPublishedPages(common: BuilderRequest, fields?: string): Promise<any[]> {
  const pages: any[] = [];
  for (let offset = 0; ; offset += 100) {
    const batch = await fetchEntries({ ...common, limit: 100, offset, fields, options: { ...common.options, 'sort.id': 1 } });
    if (!Array.isArray(batch)) throw new Error('Invalid Builder page listing');
    pages.push(...batch);
    if (batch.length < 100) return pages;
  }
}

/** Plain deletes: the bucket is versioned, so each removal is a delete marker that can be undone. */
async function deleteSnapshots(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: process.env.AWS_BUCKET_NAME, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true },
    }));
    if (result.Errors?.length) {
      // Keys stay in the log; the error message only carries the first S3 code.
      const codes = result.Errors.map(error => String(error.Code));
      console.error(JSON.stringify({ event: 'snapshot_removal_failed', codes, keys: result.Errors.map(error => error.Key) }));
      throw new Error(`Snapshot removal failed (${codes[0]})`);
    }
  }
}

type Removal = { pagesRemoved: number; removedKeys: string[]; reconcileSkipped?: string };

/** Remove every snapshot no listed page writes, unless the listing may be incomplete or the export wrote nothing. */
async function reconcile(common: BuilderRequest, listed: any[], written: Set<string>, prefix: string): Promise<Removal> {
  const skip = (reason: string): Removal => {
    console.warn(JSON.stringify({ event: 'reconcile_skipped', reason }));
    return { pagesRemoved: 0, removedKeys: [], reconcileSkipped: reason };
  };
  // A failed or empty enumeration, or an export that wrote nothing, must never empty production.
  if (!listed.length) return skip('Builder returned no published pages');
  if (!written.size) return skip('Export wrote no page snapshots');
  const keep = new Set(listed.map(page => snapshotKey(page, prefix)));
  if ([...written].some(key => !keep.has(key))) return skip('Builder page listing does not match the exported pages');
  const stale = [...await existingKeys(`${prefix}/pages/`)].filter(key => key.endsWith('.json') && !keep.has(key)).sort();
  if (!stale.length) return { pagesRemoved: 0, removedKeys: [] };
  // Offset paging skips a page when an earlier one is unpublished mid-listing, so a
  // fresh listing must not contain any page this export did not see.
  const seen = new Set(listed.map(page => page.id));
  if ((await listPublishedPages(common, 'id')).some(page => !seen.has(page.id))) return skip('Builder page listing was incomplete or changed during export');
  await deleteSnapshots(stale);
  return { pagesRemoved: stale.length, removedKeys: stale };
}

async function invalidate(paths: string[], options: ExportOptions): Promise<void> {
  if (options.invalidate === false || !paths.length) return;
  const result = await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID,
    InvalidationBatch: { CallerReference: options.callerReference || new Date().toISOString(), Paths: { Quantity: paths.length, Items: paths } },
  }));
  if (!result.Invalidation?.Id) throw new Error('CloudFront did not return an invalidation ID');
  await waitUntilInvalidationCompleted({ client: cloudfront, maxWaitTime: 600 }, {
    DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID, Id: result.Invalidation.Id,
  });
}

export type PageProgress = { total: number; completed: number };
// Called after enumeration and each processed item; callers own throttling/timeouts.
// Awaited for ordering, but telemetry failures must never abort publishing.
export type ExportOptions = {
  invalidate?: boolean; callerReference?: string;
  onProgress?: (progress: PageProgress) => Promise<void> | void;
};
// paths: snapshots written; removedKeys: snapshots deleted (both are invalidated).
export type ExportResult = { paths: string[]; missingAssets: string[] } & Removal;
export const pushToEnvironment = async (pageId?: string, options: ExportOptions = {}): Promise<ExportResult> => {
  const storage = exportStorageConfig();
  const apiKey = process.env.NEXT_PUBLIC_BUILDER_API_KEY;
  if (!apiKey || !process.env.AWS_BUCKET_NAME || !process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID) {
    throw new Error('Builder public key, bucket and CloudFront distribution must be configured');
  }
  const common = builderRequest(apiKey);
  const pages: any[] = [];
  if (pageId) {
    const page = await fetchOneEntry({ ...common, query: { id: pageId } });
    if (!page) {
      // The public key still reads unpublished drafts; a deleted page is gone entirely.
      const draft = await fetchOneEntry({ ...common, options: { ...common.options, includeUnpublished: true }, query: { id: pageId } });
      const key = draft ? snapshotKey(draft, storage.prefix) : undefined;
      // Reconcile everything when the key is unknown, the listing cannot prove nobody owns
      // it (empty, or entries without targeting), or a published page (another one at the
      // same URL, or this one re-published since) still writes it.
      const owners = key ? await listPublishedPages(common, KEY_FIELDS) : [];
      if (!key || !owners.length || owners.some(entry => !Array.isArray(entry.query) || snapshotKey(entry, storage.prefix) === key)) {
        return pushToEnvironment(undefined, options);
      }
      await deleteSnapshots([key]);
      await invalidate(['/' + key], options);
      return { paths: [], missingAssets: [], pagesRemoved: 1, removedKeys: [key] };
    }
    pages.push(page);
  } else {
    pages.push(...await listPublishedPages(common));
  }
  let completed = 0;
  const reportProgress = async () => {
    if (!options.onProgress) return;
    try { await options.onProgress({ total: pages.length, completed }); }
    catch { console.warn('Page progress reporting failed'); }
  };
  await reportProgress();
  const paths: string[] = [];
  const assetUrlCache = new Map<string, string>();
  const missingAssets = new Set<string>();
  for (const page of pages) {
    // Match the website exporter: hydrated state must not freeze saved data bindings.
    const bindingUrl = new URL('https://cdn.builder.io/api/v3/content/page');
    for (const [key, value] of Object.entries({
      apiKey, 'query.id': page.id, fields: 'data.httpRequests', includeUnpublished: 'false',
      includeRefs: 'false', noTraverse: 'true', cachebust: 'true',
    })) bindingUrl.searchParams.set(key, value);
    const bindingResponse = await fetch(bindingUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!bindingResponse.ok) throw new Error('Could not refresh saved page bindings');
    const bindingContent = await bindingResponse.json() as any;
    if (bindingContent.results?.length !== 1) throw new Error('Expected one published page for export');
    for (const [key, source] of Object.entries(bindingContent.results[0].data?.httpRequests || {})) {
      page.data.httpRequests ??= {};
      page.data.httpRequests[key] = source;
      if (page.data.state) delete page.data.state[key];
    }

    const symbols: { symbol: any; parent: any[] }[] = [];
    const findSymbols = (blocks: any) => {
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block.component?.name === 'Symbol') symbols.push({ symbol: block, parent: blocks });
        if (block.children) findSymbols(block.children);
      }
    };
    findSymbols(page.data?.blocks);
    for (const { symbol, parent } of symbols) {
      const ref = symbol.component.options.symbol;
      const content = await fetchOneEntry({ ...common, model: ref.model, query: { id: ref.entry }, fields: 'data.blocks' });
      if (!content?.data?.blocks) throw new Error('Referenced symbol is missing published blocks');
      parent.splice(parent.indexOf(symbol), 1, ...content.data.blocks);
    }
    await replaceUrls(page, assetUrlCache, missingAssets);
    const s3Key = snapshotKey(page, storage.prefix);
    if (!s3Key) {
      completed++;
      await reportProgress();
      continue;
    }
    await new Upload({ client: s3, params: {
      Bucket: process.env.AWS_BUCKET_NAME, Key: s3Key, Body: JSON.stringify(page, null, 2), ContentType: 'application/json',
    } }).done();
    paths.push('/' + s3Key);
    completed++;
    await reportProgress();
  }
  const uniquePaths = [...new Set(paths)];
  // A single-page sync reconciles against a keys-only listing, so a renamed page's old key goes in the same job.
  const listed = pageId ? await listPublishedPages(common, KEY_FIELDS) : pages;
  const removal = await reconcile(common, listed, new Set(uniquePaths.map(written => written.slice(1))), storage.prefix);
  await invalidate([...uniquePaths, ...removal.removedKeys.map(key => '/' + key)], options);
  return { paths: uniquePaths, missingAssets: [...missingAssets], ...removal };
};
