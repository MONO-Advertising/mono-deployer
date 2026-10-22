/** Assets must stay on Builder's CDN; never follow redirects into internal services. */
export function validateAssetUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== 'https://cdn.builder.io' || url.username || url.password) {
    throw new Error('Asset URL is not on the allowed Builder CDN');
  }
  return url;
}

export async function fetchAsset(value: string, method: 'GET' | 'HEAD' = 'GET') {
  return fetch(validateAssetUrl(value), {
    method, redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
}

export async function readAsset(response: Response, maxBytes = 256 * 1024 * 1024): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Asset exceeds size limit');
  }
  if (!response.body) throw new Error('Asset has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Asset exceeds size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
