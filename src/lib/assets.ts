import { fetchAsset, readAsset, validateAssetUrl } from './asset-fetch';
// import dotenv from 'dotenv';
import path from 'path';
import { S3Client, HeadObjectCommand, CopyObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';


// dotenv.config();

if (!process.env.BUILDER_PRIVATE_KEY) {
  throw new Error('BUILDER_PRIVATE_KEY must be set');
}


if (!process.env.AWS_BUCKET_NAME) {
  throw new Error('AWS_BUCKET_NAME must be set');
}



export function exportStorageConfig(): { prefix: string; publicBaseUrl: string } {
  const prefix = process.env.S3_KEY_PREFIX || 'builder';
  if (!/^builder(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)) {
    throw new Error('S3_KEY_PREFIX must be builder or a safe path beneath builder');
  }
  const publicBaseUrl = process.env.PUBLIC_ASSET_BASE_URL || `https://d1ttqs35fxgawv.cloudfront.net/${prefix}`;
  const url = new URL(publicBaseUrl);
  if (url.origin !== 'https://d1ttqs35fxgawv.cloudfront.net' || url.username || url.password || url.search || url.hash || url.pathname !== `/${prefix}`) {
    throw new Error('PUBLIC_ASSET_BASE_URL must match the CloudFront domain and S3 prefix');
  }
  return { prefix, publicBaseUrl };
}

// Default credential chain supports short-lived IAM role credentials.
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

function isS3NotFound(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number; name?: string };
  return (
    e.code === 'NotFound' ||
    e.code === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ||
    e.statusCode === 404
  );
}

function safeDecodePath(p: string): string {
  if (!p) return p;
  try {
    const decoded = decodeURIComponent(p);
    if (decoded.includes('%')) {
      return decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return p;
  }
}

function sanitizeFilename(filename: string): string {
  if (!filename) return 'asset';
  return filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 255);
}

/** Mirrors push-to-env.ts — maps Builder / HTTP mime types to file suffixes */
function getFileExtension(mimeType: string): string {
  const mimeTypeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/xml': 'xml',
    'image/webp': 'webp',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/vnd.microsoft.icon': 'ico',
    'image/vnd.adobe.photoshop': 'psd',
    'image/x-icon': 'ico',
    'image/x-photoshop': 'psd',
    'image/x-tiff': 'tiff',
    'image/x-windows-bmp': 'bmp',
    'image/x-xbitmap': 'xbm',
    'image/x-xbm': 'xbm',
    'image/x-xpixmap': 'xpm',
    'image/xpm': 'xpm',
    'image/x-xpm': 'xpm',
    'image/x-xwd': 'xwd',
    'image/x-xwindowdump': 'xwd',
    'image/xwd': 'xwd',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
    'application/font-woff': 'woff',
    'application/font-woff2': 'woff2',
  };
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mimeTypeMap[normalized] ?? '';
}

function normalizeContentType(
  assetType: string | undefined | null,
  headerType: string | null,
): string {
  const fromAsset = assetType?.split(';')[0]?.trim();
  if (fromAsset) return fromAsset;
  const fromHeader = headerType?.split(';')[0]?.trim();
  if (fromHeader) return fromHeader;
  return 'application/octet-stream';
}

type S3KeyParts = {
  s3Key: string;
  s3RelativeKey: string;
  contentType: string;
  ext: string;
};

export function computeS3KeyParts(
  asset: AssetRow,
  urlObj: URL,
  headerContentType: string | null,
): S3KeyParts {
  const fullPath = urlObj.pathname;
  const decodedPath = safeDecodePath(fullPath);
  const noSlashFullPath = decodedPath.replace(/^\/+/, '');

  const contentType = normalizeContentType(asset.type, headerContentType);
  let ext = getFileExtension(contentType);

  if (!ext && headerContentType) {
    ext = getFileExtension(headerContentType);
  }

  if (!ext) {
    const last = path.posix.basename(noSlashFullPath);
    const dot = last.lastIndexOf('.');
    if (dot > 0) {
      ext = last.slice(dot + 1).toLowerCase();
    }
  }

  const dir = path.posix.dirname(noSlashFullPath);
  const fileBase = path.posix.basename(noSlashFullPath);
  const baseWithoutExt = fileBase.includes('.')
    ? fileBase.replace(/\.[^.]+$/, '')
    : fileBase;
  const safeBase = sanitizeFilename(baseWithoutExt || asset.id);
  const relative =
    dir === '.' || dir === '' ? safeBase : `${dir}/${safeBase}`;

  const suffix = ext ? `.${ext}` : '';
  const s3RelativeKey = `${relative}${suffix}`;
  const s3Key = `${exportStorageConfig().prefix}/${s3RelativeKey}`;

  return { s3Key, s3RelativeKey, contentType, ext };
}

type AssetRow = {
  id: string;
  name: string | null;
  url: string;
  type: string | null;
};

/** Admin SDK returns `{ data: { assets: [...] } }` (GraphQL-style payload). */
function assetsFromQueryResponse(response: unknown): AssetRow[] {
  const r = response as {
    data?: { assets?: AssetRow[] };
    assets?: AssetRow[];
  };
  return r.data?.assets ?? r.assets ?? [];
}

async function fetchAllAssets(): Promise<AssetRow[]> {
  const limit = 100;
  let offset = 0;
  const out: AssetRow[] = [];

  for (;;) {
    const input = {
      limit,
      offset,
    };

    const result = await fetch('https://cdn.builder.io/api/v2/admin', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BUILDER_PRIVATE_KEY}`,
        'Content-Type': 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        query: `query { assets(input: { limit: ${input.limit}, offset: ${input.offset} }) { id name url type } }`,
      }),
    });
    if (!result.ok) throw new Error('Builder asset query failed');
    const response = await result.json() as { errors?: unknown[]; data?: { assets?: AssetRow[] } };
    if (response.errors?.length || !Array.isArray(response.data?.assets)) {
      throw new Error('Invalid Builder asset response');
    }

    const batch = assetsFromQueryResponse(response);
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return out;
}

type UploadAssetResult = { key: string; url: string; didUpload: boolean };

const ASSET_CONCURRENCY = 8;
const DOWNLOAD_CONCURRENCY = 2;
const MAX_INVENTORY_KEYS = 50_000;

/** Bound memory and requests even if a provider returns malformed pagination. */
export async function existingKeys(Prefix = `${exportStorageConfig().prefix}/`): Promise<Set<string>> {
  const keys = new Set<string>();
  const tokens = new Set<string>();
  let ContinuationToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.AWS_BUCKET_NAME!, Prefix, MaxKeys: 1000, ContinuationToken,
    }));
    for (const object of result.Contents || []) {
      if (typeof object.Key !== 'string' || !object.Key.startsWith(Prefix)) throw new Error('Invalid S3 inventory key');
      keys.add(object.Key);
      if (keys.size > MAX_INVENTORY_KEYS) throw new Error('S3 inventory exceeds safe key limit');
    }
    if (!result.IsTruncated) return keys;
    const next = result.NextContinuationToken;
    if (!next || tokens.has(next)) throw new Error('Invalid S3 inventory pagination');
    tokens.add(next);
    ContinuationToken = next;
  }
  throw new Error('S3 inventory exceeds safe page limit');
}

/** The inventory is a positive cache, never proof that an object is absent. */
async function objectExists(Key: string, inventory: Set<string>): Promise<boolean> {
  if (inventory.has(Key)) return true;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: process.env.AWS_BUCKET_NAME!, Key }));
    inventory.add(Key);
    return true;
  } catch (error) {
    if (!isS3NotFound(error)) throw error;
    return false;
  }
}

function boundedDownloads() {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= DOWNLOAD_CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally {
      const next = waiting.shift();
      if (next) next(); // Transfer this slot directly to the next waiter.
      else active--;
    }
  };
}

/** Live Builder bindings reach imgix with the original extensionless pathname. */
async function ensureRawAssetAlias(assetUrl: URL, sourceKey: string, inventory: Set<string>): Promise<void> {
  const pathname = safeDecodePath(assetUrl.pathname).replace(/^\/+/, '');
  if (pathname.split('/').some(part => part === '.' || part === '..') || /[\\\x00-\x1f]/.test(pathname)) {
    throw new Error('Unsafe raw asset path');
  }
  const rawKey = `${exportStorageConfig().prefix}/${pathname}`;
  if (rawKey === sourceKey || await objectExists(rawKey, inventory)) return;
  const Bucket = process.env.AWS_BUCKET_NAME!;
  await s3.send(new CopyObjectCommand({ Bucket, Key: rawKey, CopySource: `${Bucket}/${encodeURIComponent(sourceKey)}` }));
  inventory.add(rawKey);
}

async function uploadAssetToS3(asset: AssetRow, inventory: Set<string>, download: ReturnType<typeof boundedDownloads>): Promise<UploadAssetResult> {
  const publicDomain = exportStorageConfig().publicBaseUrl;
  const urlObj = validateAssetUrl(asset.url);
  const fetchUrl = urlObj.href;
  let headerContentType: string | null = null;
  const tentative = computeS3KeyParts(asset, urlObj, null);
  if (!tentative.ext) {
    try {
      const headRes = await fetchAsset(fetchUrl, 'HEAD');
      if (headRes.ok) headerContentType = headRes.headers.get('content-type');
      await headRes.body?.cancel();
    } catch { /* The guarded GET below can still determine content type. */ }
  }
  let parts = computeS3KeyParts(asset, urlObj, headerContentType);
  const existing = async (): Promise<UploadAssetResult | undefined> => {
    if (!await objectExists(parts.s3Key, inventory)) return undefined;
    await ensureRawAssetAlias(urlObj, parts.s3Key, inventory);
    return { key: parts.s3Key, url: `${publicDomain}/${parts.s3RelativeKey}`, didUpload: false };
  };
  const found = await existing();
  if (found) return found;

  // readAsset buffers at most 256 MiB. Keep the entire GET/read/upload lifetime
  // inside two slots rather than allocating eight maximum-size buffers at once.
  return download(async () => {
    const queuedFound = await existing();
    if (queuedFound) return queuedFound;
    const response = await fetchAsset(fetchUrl);
    try {
      if (!response.ok) throw new Error(`Asset download failed (${response.status})`);
      const getHeader = response.headers.get('content-type');
      parts = computeS3KeyParts(asset, urlObj, getHeader);
      const typedFound = await existing();
      if (typedFound) return typedFound;
      const fileBuffer = await readAsset(response);
      const concurrentFound = await existing();
      if (concurrentFound) return concurrentFound;
      await new Upload({ client: s3, queueSize: 1, params: {
        Bucket: process.env.AWS_BUCKET_NAME!, Key: parts.s3Key,
        Body: fileBuffer, ContentType: normalizeContentType(asset.type, getHeader),
      } }).done();
      inventory.add(parts.s3Key);
      await ensureRawAssetAlias(urlObj, parts.s3Key, inventory);
      return { key: parts.s3Key, url: `${publicDomain}/${parts.s3RelativeKey}`, didUpload: true };
    } finally {
      // Cancel an unused GET body when another worker already uploaded its key.
      try { await response.body?.cancel(); } catch { /* Already consumed/locked. */ }
    }
  });
}

export type PushAssetsResult = {
  uploaded: { id: string; key: string; url: string }[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; error: string }[];
};

export type AssetProgress = {
  total: number; completed: number; uploaded: number; skipped: number; failed: number;
};
// Called after enumeration and each processed item; callers own throttling/timeouts.
// Awaited for ordering, but telemetry failures must never abort publishing.
export type PushAssetsOptions = { onProgress?: (progress: AssetProgress) => Promise<void> | void };

export const pushAssets = async (options: PushAssetsOptions = {}): Promise<PushAssetsResult> => {
  exportStorageConfig();
  const assets = await fetchAllAssets();
  const inventory = await existingKeys();
  const download = boundedDownloads();
  const uploaded: PushAssetsResult['uploaded'] = [];
  const skipped: PushAssetsResult['skipped'] = [];
  const failed: PushAssetsResult['failed'] = [];
  let progressTail = Promise.resolve();
  const reportProgress = () => {
    if (!options.onProgress) return Promise.resolve();
    // Capture at completion time and serialize callbacks to prevent an older
    // in-flight progress write from overwriting a newer count.
    const snapshot = { total: assets.length, completed: uploaded.length + skipped.length + failed.length,
      uploaded: uploaded.length, skipped: skipped.length, failed: failed.length };
    progressTail = progressTail.then(async () => {
      try { await options.onProgress!(snapshot); }
      catch { console.warn('Asset progress reporting failed'); }
    });
    return progressTail;
  };
  await reportProgress();

  let cursor = 0;
  const run = async () => {
    while (cursor < assets.length) {
      const asset = assets[cursor++];
      if (!asset.url) skipped.push({ id: asset.id, reason: 'missing url' });
      else {
        try {
          const { key, url, didUpload } = await uploadAssetToS3(asset, inventory, download);
          if (didUpload) uploaded.push({ id: asset.id, key, url });
          else skipped.push({ id: asset.id, reason: 'already on s3' });
        } catch (error) {
          failed.push({ id: asset.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      await reportProgress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(ASSET_CONCURRENCY, assets.length) }, run));

  return { uploaded, skipped, failed };
};

// const main = async () => {
//   await pushAssets();
//   // console.log(JSON.stringify(result, null, 2));
// };

// if (require.main === module) {
//   main().catch(console.error);
// }
