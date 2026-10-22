import path from 'path';
import { fetchEntries, fetchOneEntry } from '@builder.io/sdk-react';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { CloudFrontClient, CreateInvalidationCommand, waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront';
import { fetchAsset, validateAssetUrl } from './asset-fetch';
import { computeS3KeyParts, exportStorageConfig } from './assets';

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
async function replaceUrls(obj: any, cache: Map<string, string>): Promise<void> {
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
          if (!response.ok) throw new Error('Asset metadata request failed');
          const parts = computeS3KeyParts({ id: 'asset', name: null, type: null, url: url.href }, url, response.headers.get('content-type'));
          cache.set(match, `${exportStorageConfig().publicBaseUrl}/${parts.s3RelativeKey}`);
        }
        obj[key] = obj[key].replace(match, cache.get(match)!);
      }
    } else if (obj[key] && typeof obj[key] === 'object') {
      await replaceUrls(obj[key], cache);
    }
  }
}

export type ExportOptions = { invalidate?: boolean; callerReference?: string };
export const pushToEnvironment = async (pageId?: string, options: ExportOptions = {}): Promise<{ paths: string[] }> => {
  const storage = exportStorageConfig();
  const apiKey = process.env.NEXT_PUBLIC_BUILDER_API_KEY;
  if (!apiKey || !process.env.AWS_BUCKET_NAME || !process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID) {
    throw new Error('Builder public key, bucket and CloudFront distribution must be configured');
  }
  const common = {
    model: 'page', apiKey,
    options: { includeUnpublished: false, includeRefs: true, cachebust: true },
    canTrack: false,
  };
  const pages: any[] = [];
  if (pageId) {
    const page = await fetchOneEntry({ ...common, query: { id: pageId } });
    if (!page) throw new Error('Published page not found');
    pages.push(page);
  } else {
    for (let offset = 0; ; offset += 100) {
      const batch = await fetchEntries({ ...common, limit: 100, offset, options: { ...common.options, 'sort.id': 1 } });
      pages.push(...batch);
      if (batch.length < 100) break;
    }
  }
  const paths: string[] = [];
  const assetUrlCache = new Map<string, string>();
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
    await replaceUrls(page, assetUrlCache);
    const query = page.query?.find((q: any) => q.property === 'urlPath');
    if (!query) continue;
    const rawPath = Array.isArray(query.value) ? query.value[0] : query.value;
    if (typeof rawPath !== 'string') throw new Error('Invalid published page URL path');
    const decoded = safeDecodePath(rawPath);
    const parts = (decoded === '/' ? '/index' : decoded).split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) throw new Error('Unsafe published page URL path');
    const filename = sanitizeFilename(page.data?.exportslug || parts.at(-1) || 'index') + '.json';
    const s3Key = path.posix.join(storage.prefix, 'pages', ...parts.slice(0, -1), filename);
    await new Upload({ client: s3, params: {
      Bucket: process.env.AWS_BUCKET_NAME, Key: s3Key, Body: JSON.stringify(page, null, 2), ContentType: 'application/json',
    } }).done();
    paths.push('/' + s3Key);
  }
  const uniquePaths = [...new Set(paths)];
  if (options.invalidate !== false && uniquePaths.length) {
    const result = await cloudfront.send(new CreateInvalidationCommand({
      DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID,
      InvalidationBatch: { CallerReference: options.callerReference || new Date().toISOString(), Paths: { Quantity: uniquePaths.length, Items: uniquePaths } },
    }));
    if (!result.Invalidation?.Id) throw new Error('CloudFront did not return an invalidation ID');
    await waitUntilInvalidationCompleted({ client: cloudfront, maxWaitTime: 600 }, {
      DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID, Id: result.Invalidation.Id,
    });
  }
  return { paths: uniquePaths };
};
