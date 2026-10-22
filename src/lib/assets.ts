import { fetchAsset, readAsset, validateAssetUrl } from './asset-fetch';
// import dotenv from 'dotenv';
import path from 'path';
import { S3Client, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
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

/** Live Builder bindings reach imgix with the original extensionless pathname. */
async function ensureRawAssetAlias(assetUrl: URL, sourceKey: string): Promise<void> {
  const pathname = safeDecodePath(assetUrl.pathname).replace(/^\/+/, '');
  if (pathname.split('/').some(part => part === '.' || part === '..') || /[\\\x00-\x1f]/.test(pathname)) {
    throw new Error('Unsafe raw asset path');
  }
  const rawKey = `${exportStorageConfig().prefix}/${pathname}`;
  if (rawKey === sourceKey) return;
  const Bucket = process.env.AWS_BUCKET_NAME!;
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: rawKey }));
    return;
  } catch (error) {
    if (!isS3NotFound(error)) throw error;
  }
  await s3.send(new CopyObjectCommand({ Bucket, Key: rawKey, CopySource: `${Bucket}/${encodeURIComponent(sourceKey)}` }));
}


async function uploadAssetToS3(asset: AssetRow): Promise<UploadAssetResult> {
  const publicDomain = exportStorageConfig().publicBaseUrl;
  const urlObj = validateAssetUrl(asset.url);
  const fetchUrl = urlObj.href;

  let headerContentType: string | null = null;
  const tentative = computeS3KeyParts(asset, urlObj, null);
  if (!tentative.ext) {
    try {
      const headRes = await fetchAsset(fetchUrl, 'HEAD');
      if (headRes.ok) {
        headerContentType = headRes.headers.get('content-type');
      }
    } catch {
      // ignore
    }
  }

  let parts = computeS3KeyParts(asset, urlObj, headerContentType);

  const bucket = process.env.AWS_BUCKET_NAME!;

  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: parts.s3Key }));
    await ensureRawAssetAlias(urlObj, parts.s3Key);
    return {
      key: parts.s3Key,
      url: `${publicDomain}/${parts.s3RelativeKey}`,
      didUpload: false,
    };
  } catch (err: unknown) {
    if (!isS3NotFound(err)) throw err;
  }

  const response = await fetchAsset(fetchUrl);
  if (!response.ok) {
    throw new Error(
      `Error fetching file from ${asset.url}: ${response.status} ${response.statusText}`,
    );
  }

  const getHeader = response.headers.get('content-type');
  parts = computeS3KeyParts(asset, urlObj, getHeader);
  const contentType = normalizeContentType(asset.type, getHeader);

  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: parts.s3Key }));
    void response.body?.cancel();
    await ensureRawAssetAlias(urlObj, parts.s3Key);
    return {
      key: parts.s3Key,
      url: `${publicDomain}/${parts.s3RelativeKey}`,
      didUpload: false,
    };
  } catch (err: unknown) {
    if (!isS3NotFound(err)) throw err;
  }

  const fileBuffer = await readAsset(response);

  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: parts.s3Key }));
    await ensureRawAssetAlias(urlObj, parts.s3Key);
    return {
      key: parts.s3Key,
      url: `${publicDomain}/${parts.s3RelativeKey}`,
      didUpload: false,
    };
  } catch (err: unknown) {
    if (!isS3NotFound(err)) throw err;
  }

  console.log('uploading file:', `${publicDomain}/${parts.s3RelativeKey}`);

  await new Upload({ client: s3, params: {
      Bucket: bucket,
      Key: parts.s3Key,
      Body: fileBuffer,
      ContentType: contentType,
    } }).done();

  await ensureRawAssetAlias(urlObj, parts.s3Key);
  return {
    key: parts.s3Key,
    url: `${publicDomain}/${parts.s3RelativeKey}`,
    didUpload: true,
  };
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
  const uploaded: PushAssetsResult['uploaded'] = [];
  const skipped: PushAssetsResult['skipped'] = [];
  const failed: PushAssetsResult['failed'] = [];
  const reportProgress = async () => {
    if (!options.onProgress) return;
    try {
      await options.onProgress({ total: assets.length, completed: uploaded.length + skipped.length + failed.length,
        uploaded: uploaded.length, skipped: skipped.length, failed: failed.length });
    } catch { console.warn('Asset progress reporting failed'); }
  };
  await reportProgress();

  for (const asset of assets) {
    if (!asset.url) {
      skipped.push({ id: asset.id, reason: 'missing url' });
      await reportProgress();
      continue;
    }

    try {
      const { key, url, didUpload } = await uploadAssetToS3(asset);
      if (didUpload) {
        uploaded.push({ id: asset.id, key, url });
      } else {
        skipped.push({ id: asset.id, reason: 'already on s3' });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failed.push({ id: asset.id, error: message });
    }
    await reportProgress();
  }

  return { uploaded, skipped, failed };
};

// const main = async () => {
//   await pushAssets();
//   // console.log(JSON.stringify(result, null, 2));
// };

// if (require.main === module) {
//   main().catch(console.error);
// }
