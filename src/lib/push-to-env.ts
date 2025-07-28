// import dotenv from 'dotenv';
// dotenv.config();
import path from 'path';
import { fetchEntries, fetchOneEntry } from '@builder.io/sdk-react';
import * as AWS from 'aws-sdk';
// import uniq from 'lodash/uniq'
// import fetch from 'node-fetch'
// import { fileTypeFromBuffer } from 'file-type'


if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set');
}

if (!process.env.NEXT_PUBLIC_BUILDER_API_KEY) {
  throw new Error('NEXT_PUBLIC_BUILDER_API_KEY must be set');
}

if (!process.env.AWS_BUCKET_NAME) {
  throw new Error('AWS_BUCKET_NAME must be set');
}

if (!process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID) {
  throw new Error('AWS_CLOUDFRONT_DISTRIBUTION_ID must be set');
}

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const cloudfront = new AWS.CloudFront();

const apiKey = process.env.NEXT_PUBLIC_BUILDER_API_KEY;

// const uploadDomain = `https://${process.env.AWS_BUCKET_NAME}.s3.amazonaws.com`
const publicDomain = 'https://d1ttqs35fxgawv.cloudfront.net/builder';
const builderDomain = 'https://cdn.builder.io';

/**
 * Safely decodes a URL path to prevent encoded characters like %2F from appearing in file paths
 */
function safeDecodePath(path: string): string {
  if (!path) return path;
  
  try {
    const decoded = decodeURIComponent(path);
    // Additional safety check to ensure no encoded characters remain
    if (decoded.includes('%')) {
      console.warn('Path still contains encoded characters after decoding:', path);
      // Try to decode again in case of double encoding
      return decodeURIComponent(decoded);
    }
    return decoded;
  } catch (error) {
    console.warn('Failed to decode path:', path, error);
    return path;
  }
}

/**
 * Sanitizes a filename to be safe for S3 storage
 */
function sanitizeFilename(filename: string): string {
  if (!filename) return 'index';
  
  // Remove or replace characters that could cause issues in S3
  return filename
    .replace(/[<>:"/\\|?*]/g, '_') // Replace problematic characters with underscores
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/__+/g, '_') // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .substring(0, 255); // Limit length for S3 compatibility
}

function extractUrl(str: string): string {
  const regex = /(http[s]?:\/\/[^\s\)]+)/g;
  const result = str.match(regex);
  return result ? result[0] : '';
}

function getFileExtension(mimeType: string): string {
  const mimeTypeMap: any = {
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
    // 'application/json': 'json',
  };
  const ext = mimeTypeMap[mimeType];
  return ext ? ext : '';
}

async function uploadAsset(url: string) {
  // const flattendUrls = urls.flat()
  // const deDupedUrls = uniq(flattendUrls)

  // for (const url of deDupedUrls) {
  // console.log(url)
  const urlObj = new URL(url);
  // console.log('urlObj.searchParams:', urlObj.searchParams)
  // console.log('urlObj.search:', urlObj.search)
  const fullPath = urlObj.pathname;
  // Ensure the pathname is properly decoded to prevent %2F and other encoded characters
  const decodedPath = safeDecodePath(fullPath);
  const noSlashFullPath = decodedPath.replace(/^\/+/, '');

  const response = await fetch(`${urlObj.origin}${fullPath}`);
  if (!response.ok) {
    console.error(`Error fetching file from ${url}`);
    throw new Error(`Error fetching file from ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');
  const ext = getFileExtension(contentType || '');

  const arrayBuffer = await response.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);

  const s3_key = `${noSlashFullPath}${ext ? `.${ext}` : ''}`;

  const params: any = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: `builder/${s3_key}`,
    Body: fileBuffer,
    ContentType: contentType,
  };

  const responseUrl = new URL(`${publicDomain}/${s3_key}`);
  // responseUrl.search = urlObj.searchParams.toString();
  // console.log('responseUrl:', responseUrl.href)

  try {
    await s3.upload(params).promise();
    // console.log(`Successfully uploaded file ${s3_key}`)
    const returnData = {
      key: `builder/${s3_key}`,
      url: responseUrl.href,
      // ext,
    };
    console.log(returnData);
    return returnData;
  } catch (err) {
    console.error('Error uploading file', err);
    throw err;
  }
}

async function replaceUrls(
  obj: any,
  oldDomain: string,
  newDomain: string,
  depth: number = 0,
): Promise<string[]> {
  // Prevent infinite recursion
  if (depth > 10) {
    console.warn('Maximum recursion depth reached in replaceUrls');
    return [];
  }

  const regex = /(http[s]?:\/\/[^\s\)]+)/g;
  let urls: string[] = [];

  for (const key in obj) {
    if (
      typeof obj[key] === 'string' &&
      key !== 'workTile' &&
      key !== 'workTile2' &&
      key !== 'newsTile' &&
      // && key !== 'screenshot'
      obj[key].includes(oldDomain)
    ) {
      const matches = obj[key].match(regex);
      if (matches) {
        for (const match of matches) {
          if (!match.includes('pixel?') && !match.includes('_vercel')) {
            // console.log('\n')

            const decodedUrl = decodeURIComponent(match);
            // console.log('decodedUrl:', decodedUrl)

            const extractedUrl = extractUrl(decodedUrl);
            // console.log('extractedUrl:', extractedUrl)

            if (!extractedUrl) {
              console.warn('Could not extract URL from:', match);
              continue;
            }

            const extractedUrlObj = new URL(extractedUrl);

            // console.log('extractedUrlObj:', extractedUrlObj)
            // console.log('extractedUrlObj.searchParams:', extractedUrlObj.searchParams)
            // console.log('extractedUrlObj.search:', extractedUrlObj.search)
            // console.log('extractedUrlObj.pathname:', extractedUrlObj.pathname)
            // console.log('extractedUrlObj.pathname.replace(/^\/+/, ""):', extractedUrlObj.pathname.replace(/^\/+/, ""))

            // extractedUrl = extractedUrl.replace("?placeholderIfAbsent=true","")
            // console.log('extractedUrl replaced:', extractedUrl)

            let contentType: string | null = null;
            try {
              const fetchResponse = await fetch(extractedUrl);
              contentType = fetchResponse.headers.get('content-type')?.split(';')[0] || null;
            } catch (error) {
              console.error('Error fetching content type for:', extractedUrl, error);
              continue;
            }

            // console.log('contentType:', contentType)
            const fileExtension = getFileExtension(contentType || '');
            // console.log('fileExtension:', fileExtension)

            if (fileExtension === '') {
              // console.log(`Skipping ${extractedUrl}. It is not an image or video`)
              continue;
            }
            // Ensure the pathname is properly decoded to prevent %2F and other encoded characters
            const decodedPathname = safeDecodePath(extractedUrlObj.pathname);
            const s3_key = `${decodedPathname.replace(/^\/+/, '')}.${fileExtension}`;
            // console.log(`KEY: builder/${s3_key}`)

            // if (!process.env.AWS_BUCKET_NAME) {
            //   throw new Error('AWS_BUCKET_NAME is not defined')
            // }

            const headParams = {
              Bucket: process.env.AWS_BUCKET_NAME!,
              Key: `builder/${s3_key}`,
            };
            // console.log('headParams:', headParams)

            let uploadedFile: any;

            try {
              await s3.headObject(headParams).promise();
              // console.log(headers)
              // console.log('File already exists in S3')
              uploadedFile = {
                key: `builder/${s3_key}`,
                url: `${publicDomain}/${s3_key}`,
                // ext: fileExtension,
              };
              // console.log(uploadedFile)
            } catch (err: any) {
              // console.log(err)
              if (err.code === 'NotFound') {
                // console.log('File does not exist in S3')
                uploadedFile = await uploadAsset(extractedUrl);
                // console.log(upload)
              } else {
                console.error('Error checking if file exists in S3', err);
                throw err;
              }
            }

            const newUrl = uploadedFile.url;
            // const newUrl = `${publicDomain}/${s3_key}`
            obj[key] = obj[key].replace(match, newUrl);

            urls.push(extractedUrl);
          }
        }
      }
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      // replaceUrls(obj[key], oldDomain, newDomain)
      urls = urls.concat(await replaceUrls(obj[key], oldDomain, newDomain, depth + 1));
    }
  }

  return urls;
}

export const pushToEnvironment = async (pageId?: string) => {
  const pages = pageId
    ? [
        await fetchOneEntry({
          model: 'page',
          apiKey,
          query: {
            id: pageId,
          },
          options: {
            includeUnpublished: false,
            includeRefs: true,
          },
          cacheSeconds: 10,
          staleCacheSeconds: 10,
          canTrack: false,
        }),
      ]
    : await fetchEntries({
        model: 'page',
        apiKey,
        options: {
          includeUnpublished: false,
          includeRefs: true,
        },
        limit: 100,
        cacheSeconds: 10,
        staleCacheSeconds: 10,
        canTrack: false,
      });

  // console.log(pages);

  const invalidationPaths: string[] = []

  for (const page of pages) {
    if (!page) {
      console.warn('Skipping null/undefined page');
      continue;
    }

    const symbols: any[] = [];
    const findSymbols = (blocks: any) => {
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.component?.name === 'Symbol') {
            symbols.push({ symbol: block, parent: blocks });
          }
          if (block.children) {
            findSymbols(block.children);
          }
        }
      }
    };

    findSymbols(page?.data?.blocks);

    for (const symbol of symbols) {
      const symbolId = symbol.symbol.component.options.symbol.entry;
      const symbolData = await fetchOneEntry({
        model: symbol.symbol.component.options.symbol.model,
        apiKey,
        options: {
          includeUnpublished: false,
          includeRefs: true,
        },
        query: {
          id: symbolId,
        },
        fields: 'data.blocks',
        cacheSeconds: 10,
        staleCacheSeconds: 10,
        canTrack: false,
      });

      const index = symbol.parent.indexOf(symbol.symbol);
      symbol.parent.splice(index, 1);

      if (symbolData?.data?.blocks) {
        symbol.parent.splice(index, 0, ...symbolData.data.blocks);
      }
    }

    await replaceUrls(page, builderDomain, publicDomain);

    // console.log('page:', JSON.stringify(page, null, 2))

    const query = (page as any).query?.find(
      (q: any) => q.property === 'urlPath',
    );
    
    if (!query) {
      console.warn('No urlPath query found for page:', page.id || 'unknown');
      continue;
    }

    const queryValue = Array.isArray(query.value)
      ? query.value[0]
      : query.value;
    // Ensure the URL is properly decoded to prevent %2F and other encoded characters
    const decodedUrl = safeDecodePath(queryValue);
    const url = decodedUrl === '/' ? '/index' : decodedUrl;

    const urlParts = url.split('/').filter((part: any) => part !== '');

    // Ensure all URL parts are properly decoded to prevent encoded characters in filenames
    const decodedUrlParts = urlParts.map(part => safeDecodePath(part));
    const baseFileName = page?.data?.exportslug ? page.data.exportslug : (decodedUrlParts.length > 0 ? decodedUrlParts[decodedUrlParts.length - 1] : 'index');
    const fileName = `${sanitizeFilename(baseFileName)}.json`;
    const filePath =
      decodedUrlParts.length > 1 ? `/${decodedUrlParts.slice(0, -1).join('/')}/` : '/';

    const s3_key = path.join('builder', 'pages', filePath, fileName);

    try {
      const params: any = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: s3_key,
        Body: JSON.stringify(page, null, 2),
        ContentType: 'application/json',
      };
      await s3.upload(params).promise();
      console.log(`Successfully uploaded file ${s3_key}`);
    } catch (err) {
      console.error('Error uploading file', err);
      throw err;
    }

    invalidationPaths.push(`/${s3_key}`);
  }

  if (invalidationPaths.length === 0) {
    console.warn('No files to invalidate');
    return;
  }

  const invalidationParams = {
    DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID!, // Ensure this environment variable is set
    InvalidationBatch: {
      CallerReference: new Date().toISOString(), // Unique value to ensure the invalidation is processed
      Paths: {
        Quantity: invalidationPaths.length,
        Items: invalidationPaths, // Invalidate the specific file path
      },
    },
  };
  // console.log(JSON.stringify(invalidationParams, null, 2))

  try {
    await cloudfront.createInvalidation(invalidationParams).promise();
  } catch (error) {
    console.error('Error creating invalidation:', error);
    throw error;
  }
};
