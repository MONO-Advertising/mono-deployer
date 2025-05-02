import path from 'path';
import { fetchEntries, fetchOneEntry } from '@builder.io/sdk-react';
import * as AWS from 'aws-sdk';
// import uniq from 'lodash/uniq'
// import fetch from 'node-fetch'
// import { fileTypeFromBuffer } from 'file-type'

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set');
}

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const cloudfront = new AWS.CloudFront();

const apiKey = process.env.NEXT_PUBLIC_BUILDER_API_KEY!;

// const uploadDomain = `https://${process.env.AWS_BUCKET_NAME}.s3.amazonaws.com`
const publicDomain = 'https://d1ttqs35fxgawv.cloudfront.net/builder';
const builderDomain = 'https://cdn.builder.io';

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
  const noSlashFullPath = fullPath.replace(/^\/+/, '');

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Error fetching file from ${url}`);
    // throw new Error(`Error fetching file from ${url}`)
  }

  if (response.ok) {
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
    responseUrl.search = urlObj.searchParams.toString();
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
}

async function replaceUrls(
  obj: any,
  oldDomain: string,
  newDomain: string,
): Promise<string[]> {
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

            const extractedUrlObj = new URL(extractedUrl);

            // console.log('extractedUrlObj:', extractedUrlObj)
            // console.log('extractedUrlObj.searchParams:', extractedUrlObj.searchParams)
            // console.log('extractedUrlObj.search:', extractedUrlObj.search)
            // console.log('extractedUrlObj.pathname:', extractedUrlObj.pathname)
            // console.log('extractedUrlObj.pathname.replace(/^\/+/, ""):', extractedUrlObj.pathname.replace(/^\/+/, ""))

            // extractedUrl = extractedUrl.replace("?placeholderIfAbsent=true","")
            // console.log('extractedUrl replaced:', extractedUrl)

            const contentType = (await fetch(extractedUrl)).headers
              .get('content-type')
              ?.split(';')[0];
            // console.log('contentType:', contentType)
            const fileExtension = getFileExtension(contentType || '');
            // console.log('fileExtension:', fileExtension)

            if (fileExtension === '') {
              // console.log(`Skipping ${extractedUrl}. It is not an image or video`)
              continue;
            }
            const s3_key = `${extractedUrlObj.pathname.replace(/^\/+/, '')}.${fileExtension}`;
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
                url: `${publicDomain}/${s3_key}${extractedUrlObj.search}`,
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
      urls = urls.concat(await replaceUrls(obj[key], oldDomain, newDomain));
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

    const query = (page as any).query.find(
      (q: any) => q.property === 'urlPath',
    );
    const queryValue = Array.isArray(query.value)
      ? query.value[0]
      : query.value;
    const url = queryValue === '/' ? '/index' : queryValue;

    const urlParts = url.split('/').filter((part: any) => part !== '');

    const fileName = `${page?.data?.exportslug ? page.data.exportslug : urlParts[urlParts.length - 1]}.json`;
    const filePath =
      urlParts.length > 1 ? `/${urlParts.slice(0, -1).join('/')}/` : '/';

    const s3_key = path.join('builder', 'pages', filePath, fileName);

    const params: any = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3_key,
      Body: JSON.stringify(page, null, 2),
      ContentType: 'application/json',
    };
    s3.upload(params, (err: any) => {
      if (err) {
        console.error('Error uploading file', err);
      } else {
        console.log(`Successfully uploaded file ${s3_key}`);
      }
    });

    invalidationPaths.push(`/${s3_key}`);
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

  cloudfront.createInvalidation(
    invalidationParams,
    (err: any /*data: any*/) => {
      if (err) {
        console.error('Error creating CloudFront invalidation', err);
      } else {
        // console.log('Successfully created CloudFront invalidation', data);
      }
    },
  );
};
