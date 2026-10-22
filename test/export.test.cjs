const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real exporter logic with all provider I/O replaced by local fixtures.
function harness(pages, assets = [], environment = {}, providers = {}) {
  const uploads = [];
  const copies = [];
  const pageRequests = [];
  const assetRequests = [];
  const env = {
    BUILDER_PRIVATE_KEY: 'fixture-private-key',
    NEXT_PUBLIC_BUILDER_API_KEY: 'fixture-public-key',
    AWS_BUCKET_NAME: 'fixture-bucket',
    AWS_CLOUDFRONT_DISTRIBUTION_ID: 'fixture-distribution',
    ...environment,
  };
  const mocks = {
    '@aws-sdk/client-s3': {
      S3Client: class { async send(command) { if (command.copy) { copies.push(command.input); return {}; } throw Object.assign(new Error('missing'), { name: 'NotFound' }); } },
      HeadObjectCommand: class { constructor(input) { this.input = input; } },
      CopyObjectCommand: class { constructor(input) { this.input = input; this.copy = true; } },
    },
    '@aws-sdk/client-cloudfront': {
      CloudFrontClient: class { async send() { return { Invalidation: { Id: 'fixture-invalidation' } }; } },
      waitUntilInvalidationCompleted: async () => ({}),
      CreateInvalidationCommand: class { constructor(input) { this.input = input; } },
    },
    '@aws-sdk/lib-storage': {
      Upload: class { constructor({ params }) { this.params = params; } async done() { uploads.push(this.params); return {}; } },
    },
    '@builder.io/sdk-react': {
      fetchEntries: async (request) => {
        pageRequests.push(request);
        const offset = request.offset ?? request.options?.offset ?? 0;
        return structuredClone(pages.slice(offset, offset + request.limit));
      },
      fetchOneEntry: async ({ query }) => structuredClone(pages.find(page => page.id === query.id)),
    },
    './asset-fetch': {
      validateAssetUrl: (value) => {
        const url = new URL(value);
        if (url.origin !== 'https://cdn.builder.io') throw new Error('Invalid asset origin');
        return url;
      },
      fetchAsset: providers.fetchAsset || (async () => new Response('fixture-image', { headers: { 'content-type': 'image/png' } })),
      readAsset: async response => Buffer.from(await response.arrayBuffer()),
    },
  };
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    cache.set(filename, module.exports);
    const realRequire = createRequire(filename);
    const context = {
      exports: module.exports, module,
      require: name => {
        if (mocks[name]) return mocks[name];
        if (name.startsWith('.')) return load(realRequire.resolve(name));
        return realRequire(name);
      },
      process: { env }, URL, Buffer, AbortSignal, Response,
      console: { log() {}, warn() {}, error() {} },
      fetch: async (_url, request) => {
        if (new URL(_url).pathname === '/api/v3/content/page') {
          const fixture = pages.find(page => page.id === new URL(_url).searchParams.get('query.id'));
          return new Response(JSON.stringify({ results: fixture ? [fixture] : [] }));
        }
        const query = JSON.parse(request.body).query;
        const offset = Number(query.match(/offset:\s*(\d+)/)?.[1] ?? 0);
        assetRequests.push(query);
        return new Response(JSON.stringify({ data: { assets: assets.slice(offset, offset + 100) } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return module.exports;
  }
  return { load: name => load(path.resolve(__dirname, '../dist/lib', name + '.js')), uploads, copies, pageRequests, assetRequests };
}

function page(id, image) {
  return { id, query: [{ property: 'urlPath', value: '/' + id }], data: { blocks: [], ...(image ? { image } : {}) } };
}

test('full export includes published pages beyond the first 100', async () => {
  const fixtures = Array.from({ length: 101 }, (_, i) => page('page-' + i));
  const h = harness(fixtures);
  await h.load('push-to-env').pushToEnvironment();
  const pageUploads = h.uploads.filter(upload => upload.ContentType === 'application/json');
  assert.equal(pageUploads.length, 101);
  assert.ok(pageUploads.some(upload => upload.Key === 'builder/pages/page-100.json'));
  assert.equal(h.pageRequests.length, 2);
});

test('rewritten page URLs identify the exact key used by asset upload', async () => {
  for (const suffix of ['photo.png', 'photo%20name.png', 'asset-id']) {
    const url = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2F' + suffix;
    const h = harness([page('home', url)], [{ id: suffix, name: suffix, url, type: 'image/png' }]);
    const result = await h.load('assets').pushAssets();
    assert.equal(result.failed.length, 0);
    await h.load('push-to-env').pushToEnvironment();
    const imageUpload = h.uploads.find(upload => upload.ContentType === 'image/png');
    const pageUpload = h.uploads.find(upload => upload.ContentType === 'application/json');
    const exported = JSON.parse(pageUpload.Body);
    assert.equal(decodeURIComponent(new URL(exported.data.image).pathname), '/' + imageUpload.Key, suffix);
  }
});


test('export restores saved bindings and removes hydrated state before writing', async () => {
  const fixture = page('home');
  fixture.data.httpRequests = { work: 'https://cdn.builder.io/api/v3/content/work?apiKey=public' };
  fixture.data.state = { work: { results: ['stale'] }, retained: 'keep' };
  const h = harness([fixture]);
  const result = await h.load('push-to-env').pushToEnvironment(undefined, { invalidate: false });
  assert.equal(result.paths.length, 1);
  const data = JSON.parse(h.uploads[0].Body).data;
  assert.equal(data.httpRequests.work, fixture.data.httpRequests.work);
  assert.equal(data.state.work, undefined);
  assert.equal(data.state.retained, 'keep');
});


test('isolated validation prefix applies to asset keys, page keys, URLs and invalidations', async () => {
  const url = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fphoto.png';
  const prefix = 'builder/validation/test-run';
  const h = harness([page('home', url)], [{ id: 'photo', name: 'photo', url, type: 'image/png' }], {
    S3_KEY_PREFIX: prefix, PUBLIC_ASSET_BASE_URL: 'https://d1ttqs35fxgawv.cloudfront.net/' + prefix,
  });
  assert.equal((await h.load('assets').pushAssets()).failed.length, 0);
  const result = await h.load('push-to-env').pushToEnvironment(undefined, { invalidate: false });
  assert.ok(h.uploads.every(upload => upload.Key.startsWith(prefix + '/')));
  assert.equal(result.paths[0], '/' + prefix + '/pages/home.json');
  const content = JSON.parse(h.uploads.find(upload => upload.ContentType === 'application/json').Body);
  assert.equal(new URL(content.data.image).pathname, '/' + h.uploads.find(upload => upload.ContentType === 'image/png').Key);
});

test('validation prefix and public base URL reject unsafe or mismatched destinations', () => {
  for (const environment of [
    { S3_KEY_PREFIX: 'outside' }, { S3_KEY_PREFIX: 'builder/../outside' },
    { S3_KEY_PREFIX: 'builder/%2foutside' },
    { PUBLIC_ASSET_BASE_URL: 'https://evil.example/builder' },
    { PUBLIC_ASSET_BASE_URL: 'https://d1ttqs35fxgawv.cloudfront.net/wrong' },
  ]) {
    const h = harness([], [], environment);
    assert.throws(() => h.load('assets').exportStorageConfig());
  }
});


test('asset mirroring preserves raw extensionless aliases for live imgix bindings', async () => {
  const url = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fasset-id';
  const h = harness([], [{ id: 'asset-id', name: null, url, type: 'image/png' }], { S3_KEY_PREFIX: 'builder/validation/aliases' });
  const result = await h.load('assets').pushAssets();
  assert.equal(result.failed.length, 0);
  assert.equal(h.copies.length, 1);
  assert.equal(h.copies[0].Key, 'builder/validation/aliases/api/v1/image/assets/space/asset-id');
  assert.equal(decodeURIComponent(h.copies[0].CopySource), 'fixture-bucket/' + h.uploads[0].Key);
});

test('missing page-only asset preserves original Builder URL and reports its path without fabricating S3 references', async () => {
  const url = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fdeleted.png?width=640&alt=media&token=fixture';
  const requests = [];
  const h = harness([page('home', url), page('second', url)], [], {}, {
    fetchAsset: async (value, method) => {
      requests.push({ value, method });
      return new Response(null, { status: 404 });
    },
  });
  const result = await h.load('push-to-env').pushToEnvironment(undefined, { invalidate: false });
  assert.equal(result.paths.length, 2);
  assert.deepEqual(Array.from(result.missingAssets), [new URL(url).pathname]);
  assert.equal(requests.length, 1, 'duplicate missing reference is checked only once');
  assert.equal(requests[0].method, 'HEAD');
  for (const upload of h.uploads) {
    assert.equal(upload.ContentType, 'application/json');
    assert.equal(JSON.parse(upload.Body).data.image, url);
    assert.ok(!upload.Body.includes('cloudfront.net'), 'missing source must not become a fabricated mirror link');
  }
});

test('non-404 page asset metadata errors fail export before page upload', async () => {
  const url = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fphoto.png';
  for (const status of [403, 429, 500, 503]) {
    const h = harness([page('home', url)], [], {}, {
      fetchAsset: async () => new Response(null, { status }),
    });
    await assert.rejects(h.load('push-to-env').pushToEnvironment(), new RegExp(`Asset metadata request failed \\(${status}\\)`));
    assert.equal(h.uploads.length, 0);
  }
});

test('registered asset download 404 remains a hard failure instead of a skipped missing page reference', async () => {
  const url = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fregistered.png';
  const h = harness([], [{ id: 'registered', name: 'registered', url, type: 'image/png' }], {}, {
    fetchAsset: async () => new Response(null, { status: 404 }),
  });
  const result = await h.load('assets').pushAssets();
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'registered');
  assert.equal(result.skipped.length, 0);
  assert.equal(result.uploaded.length, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.copies.length, 0);
});

test('asset progress counts uploaded, missing-url skips and failures without exposing asset data', async () => {
  const base = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2F';
  const h = harness([], [
    { id: 'ok', name: 'private-name', url: base + 'ok.png', type: 'image/png' },
    { id: 'no-url' },
    { id: 'broken', url: base + 'broken.png', type: 'image/png' },
  ], {}, { fetchAsset: async url => url.includes('broken')
    ? new Response(null, { status: 404 }) : new Response('image', { headers: { 'content-type': 'image/png' } }) });
  const snapshots = [];
  const result = await h.load('assets').pushAssets({ onProgress: async progress => snapshots.push(JSON.parse(JSON.stringify(progress))) });
  assert.deepEqual(snapshots, [
    { total: 3, completed: 0, uploaded: 0, skipped: 0, failed: 0 },
    { total: 3, completed: 1, uploaded: 1, skipped: 0, failed: 0 },
    { total: 3, completed: 2, uploaded: 1, skipped: 1, failed: 0 },
    { total: 3, completed: 3, uploaded: 1, skipped: 1, failed: 1 },
  ]);
  assert.equal(result.failed.length, 1);
});

test('page progress is awaited and counts processed non-routable pages without claiming an upload', async () => {
  const unroutable = page('no-route');
  delete unroutable.query;
  const h = harness([page('one'), unroutable]);
  const snapshots = [];
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pending = h.load('push-to-env').pushToEnvironment(undefined, {
    invalidate: false,
    onProgress: async progress => {
      snapshots.push(JSON.parse(JSON.stringify(progress)));
      if (progress.completed === 0) { entered(); await gate; }
    },
  });
  await started;
  assert.equal(h.uploads.length, 0, 'export waits for the initial progress callback');
  release();
  const result = await pending;
  assert.equal(result.paths.length, 1);
  assert.deepEqual(snapshots, [{ total: 2, completed: 0 }, { total: 2, completed: 1 }, { total: 2, completed: 2 }]);
});

test('progress reporting rejection cannot turn a successful export into failure', async () => {
  const url = 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fok.png';
  const h = harness([page('one')], [{ id: 'ok', url, type: 'image/png' }]);
  const reject = async () => { throw new Error('telemetry unavailable'); };
  const assets = await h.load('assets').pushAssets({ onProgress: reject });
  assert.equal(assets.uploaded.length, 1);
  assert.equal(assets.failed.length, 0);
  const pages = await h.load('push-to-env').pushToEnvironment(undefined, { invalidate: false, onProgress: reject });
  assert.equal(pages.paths.length, 1);
});

test('empty exports emit a zero-total snapshot and a failed page never reports completed', async () => {
  const h = harness([]);
  const assets = [];
  const pages = [];
  await h.load('assets').pushAssets({ onProgress: value => assets.push(JSON.parse(JSON.stringify(value))) });
  await h.load('push-to-env').pushToEnvironment(undefined, { invalidate: false, onProgress: value => pages.push(JSON.parse(JSON.stringify(value))) });
  assert.deepEqual(assets, [{ total: 0, completed: 0, uploaded: 0, skipped: 0, failed: 0 }]);
  assert.deepEqual(pages, [{ total: 0, completed: 0 }]);
  const failed = harness([page('broken', 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fbad.png')], [], {}, {
    fetchAsset: async () => new Response(null, { status: 503 }),
  });
  const progress = [];
  await assert.rejects(failed.load('push-to-env').pushToEnvironment(undefined, {
    invalidate: false, onProgress: value => progress.push(JSON.parse(JSON.stringify(value))),
  }), /Asset metadata request failed/);
  assert.deepEqual(progress, [{ total: 1, completed: 0 }]);
});
