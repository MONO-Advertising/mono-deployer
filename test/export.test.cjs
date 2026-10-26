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
  const deletes = [];
  const invalidations = [];
  const s3Requests = [];
  const pageRequests = [];
  const entryRequests = [];
  const assetRequests = [];
  // Builder hides drafts unless the request includes unpublished entries.
  const visible = (list, options) => list.filter(entry => options?.includeUnpublished || entry.published !== 'draft');
  const env = {
    BUILDER_PRIVATE_KEY: 'fixture-private-key',
    NEXT_PUBLIC_BUILDER_API_KEY: 'fixture-public-key',
    AWS_BUCKET_NAME: 'fixture-bucket',
    AWS_CLOUDFRONT_DISTRIBUTION_ID: 'fixture-distribution',
    ...environment,
  };
  const mocks = {
    '@aws-sdk/client-s3': {
      S3Client: class { async send(command) {
        s3Requests.push(command);
        if (providers.s3Send) return providers.s3Send(command);
        if (command.list) return { Contents: (providers.objects || []).filter(Key => Key.startsWith(command.input.Prefix)).map(Key => ({ Key })), IsTruncated: false };
        if (command.copy) { copies.push(command.input); return {}; }
        if (command.remove) { deletes.push(command.input); return {}; }
        throw Object.assign(new Error('missing'), { name: 'NotFound' });
      } },
      ListObjectsV2Command: class { constructor(input) { this.input = input; this.list = true; } },
      DeleteObjectsCommand: class { constructor(input) { this.input = input; this.remove = true; } },
      HeadObjectCommand: class { constructor(input) { this.input = input; } },
      CopyObjectCommand: class { constructor(input) { this.input = input; this.copy = true; } },
    },
    '@aws-sdk/client-cloudfront': {
      CloudFrontClient: class { async send(command) { invalidations.push(command.input); return { Invalidation: { Id: 'fixture-invalidation' } }; } },
      waitUntilInvalidationCompleted: async () => ({}),
      CreateInvalidationCommand: class { constructor(input) { this.input = input; } },
    },
    '@aws-sdk/lib-storage': {
      Upload: class { constructor({ params }) { this.params = params; } async done() { if (providers.upload) await providers.upload(this.params); uploads.push(this.params); return {}; } },
    },
    '@builder.io/sdk-react': {
      fetchEntries: async (request) => {
        pageRequests.push(request);
        const offset = request.offset ?? request.options?.offset ?? 0;
        const listed = providers.pageList ? providers.pageList(pageRequests.length) : pages;
        return structuredClone(visible(listed, request.options).slice(offset, offset + request.limit));
      },
      fetchOneEntry: async (request) => {
        entryRequests.push(request);
        return structuredClone(visible(pages, request.options).find(page => page.id === request.query.id));
      },
    },
    './asset-fetch': {
      validateAssetUrl: (value) => {
        const url = new URL(value);
        if (url.origin !== 'https://cdn.builder.io') throw new Error('Invalid asset origin');
        return url;
      },
      fetchAsset: providers.fetchAsset || (async () => new Response('fixture-image', { headers: { 'content-type': 'image/png' } })),
      readAsset: providers.readAsset || (async response => Buffer.from(await response.arrayBuffer())),
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
  return { load: name => load(path.resolve(__dirname, '../dist/lib', name + '.js')), uploads, copies, deletes, invalidations, pageRequests, entryRequests, assetRequests, s3Requests };
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
  assert.ok(h.s3Requests.some(command => command.list && command.input.Prefix === prefix + '/pages/'), 'reconcile lists the isolated prefix');
  assert.ok(h.s3Requests.every(command => !command.list || command.input.Prefix.startsWith(prefix + '/')), 'validation never lists production keys');
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
  assert.deepEqual(snapshots.map(p => p.completed), [0, 1, 2, 3]);
  assert.deepEqual(snapshots[0], { total: 3, completed: 0, uploaded: 0, skipped: 0, failed: 0 });
  assert.deepEqual(snapshots.at(-1), { total: 3, completed: 3, uploaded: 1, skipped: 1, failed: 1 });
  for (const p of snapshots) {
    assert.equal(p.completed, p.uploaded + p.skipped + p.failed);
    assert.deepEqual(Object.keys(p).sort(), ['completed', 'failed', 'skipped', 'total', 'uploaded']);
  }
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


const assetFixture = i => ({ id: 'asset-' + i, name: null, type: 'image/png', url: 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fasset-' + i });
const canonicalKey = i => 'builder/api/v1/image/assets/space/asset-' + i + '.png';
const aliasKey = i => 'builder/api/v1/image/assets/space/asset-' + i;
const missingObject = () => Object.assign(new Error('missing'), { name: 'NotFound' });

test('paginated inventory skips existing canonical objects and raw aliases without per-asset HEAD or downloads', async () => {
  const h = harness([], [assetFixture(0), assetFixture(1)], {}, {
    s3Send: async command => {
      assert.equal(command.list, true, 'warm inventory must eliminate HEAD and Copy calls');
      assert.equal(command.input.Prefix, 'builder/');
      assert.equal(command.input.MaxKeys, 1000);
      return command.input.ContinuationToken
        ? { Contents: [{ Key: canonicalKey(1) }, { Key: aliasKey(1) }], IsTruncated: false }
        : { Contents: [{ Key: canonicalKey(0) }, { Key: aliasKey(0) }], IsTruncated: true, NextContinuationToken: 'page-two' };
    },
    fetchAsset: async () => { throw new Error('warm assets must not be fetched'); },
  });
  const result = await h.load('assets').pushAssets();
  assert.equal(result.skipped.length, 2); assert.equal(result.failed.length, 0);
  assert.equal(h.s3Requests.length, 2); assert.equal(h.s3Requests[1].input.ContinuationToken, 'page-two');
  assert.equal(h.uploads.length, 0);
});

test('missing raw alias is HEAD checked then repaired from inventoried canonical source', async () => {
  const copies = [];
  const h = harness([], [assetFixture(0)], {}, {
    s3Send: async command => {
      if (command.list) return { Contents: [{ Key: canonicalKey(0) }] };
      if (command.copy) { copies.push(command.input); return {}; }
      assert.equal(command.input.Key, aliasKey(0)); throw missingObject();
    },
    fetchAsset: async () => { throw new Error('existing source must not download'); },
  });
  const result = await h.load('assets').pushAssets();
  assert.equal(result.failed.length, 0); assert.equal(result.skipped.length, 1);
  assert.equal(copies.length, 1); assert.equal(copies[0].Key, aliasKey(0));
  assert.equal(decodeURIComponent(copies[0].CopySource), 'fixture-bucket/' + canonicalKey(0));
});

test('inventory failures and malformed pagination stop safely before asset provider operations', async () => {
  for (const list of [
    async () => { throw new Error('AccessDenied'); },
    async () => ({ IsTruncated: true }),
    async () => ({ IsTruncated: true, NextContinuationToken: 'repeat' }),
    async () => ({ Contents: [{ Key: 'outside-prefix/key' }] }),
    async () => ({ Contents: Array.from({ length: 50001 }, (_, i) => ({ Key: 'builder/key-' + i })) }),
  ]) {
    let fetched = false;
    const h = harness([], [assetFixture(0)], {}, {
      s3Send: async command => { assert.ok(command.list); return list(); },
      fetchAsset: async () => { fetched = true; throw new Error('unexpected download'); },
    });
    await assert.rejects(h.load('assets').pushAssets());
    assert.equal(fetched, false); assert.equal(h.uploads.length, 0);
    assert.ok(h.s3Requests.length <= 2);
  }
});

test('asset workers cap metadata at eight and complete downloads at two while serializing progress', async () => {
  let heads = 0, maxHeads = 0, downloads = 0, maxDownloads = 0, callbacks = 0, maxCallbacks = 0;
  const snapshots = [];
  const delay = () => new Promise(resolve => setTimeout(resolve, 2));
  const h = harness([], Array.from({ length: 18 }, (_, i) => assetFixture(i)), {}, {
    s3Send: async command => {
      if (command.list) return { Contents: [] };
      if (command.copy) return {};
      heads++; maxHeads = Math.max(maxHeads, heads); await delay(); heads--; throw missingObject();
    },
    fetchAsset: async () => { downloads++; maxDownloads = Math.max(maxDownloads, downloads); return new Response('image', { headers: { 'content-type': 'image/png' } }); },
    upload: async () => { await delay(); downloads--; },
  });
  const result = await h.load('assets').pushAssets({ onProgress: async progress => {
    callbacks++; maxCallbacks = Math.max(maxCallbacks, callbacks); await delay();
    snapshots.push(progress.completed); callbacks--;
  } });
  assert.equal(result.uploaded.length, 18); assert.equal(result.failed.length, 0);
  assert.ok(maxHeads > 1 && maxHeads <= 8); assert.equal(maxDownloads, 2); assert.equal(maxCallbacks, 1);
  assert.deepEqual(snapshots, Array.from({ length: 19 }, (_, i) => i));
});

test('missing inventory entry still HEAD checks before download, and access errors remain failures', async () => {
  for (const denied of [false, true]) {
    const h = harness([], [assetFixture(0)], {}, {
      s3Send: async command => {
        if (command.list) return { Contents: [] };
        if (denied) throw new Error('AccessDenied');
        return {}; // Object appeared after listing; do not download or overwrite it.
      },
      fetchAsset: async () => { throw new Error('must not download'); },
    });
    const result = await h.load('assets').pushAssets();
    assert.equal(result.failed.length, denied ? 1 : 0);
    assert.equal(result.skipped.length, denied ? 0 : 1);
    assert.equal(h.uploads.length, 0);
  }
});

// Removal (plan B8). Kept keys follow mono-dotcom scripts/audit-orphan-snapshots.ts
// expectedSnapshotKey(url, exportslug): '/' -> index.json, '/a/b' -> a/b.json, exportslug replaces the last segment.
const snapshot = key => 'builder/pages/' + key;
const removedBatches = h => h.deletes.map(input => Array.from(input.Delete.Objects, object => object.Key));

test('full export deletes every snapshot key it did not produce, after all uploads, and invalidates the removed paths', async () => {
  const root = { id: 'root', query: [{ property: 'urlPath', value: '/' }], data: { blocks: [] } };
  const slugged = page('work/renamed');
  slugged.data.exportslug = 'custom-slug';
  const draft = { ...page('work/draft'), published: 'draft' };
  const h = harness([root, page('work'), page('work/kept'), slugged, draft], [], {}, {
    objects: ['index.json', 'work.json', 'work/kept.json', 'work/custom-slug.json', 'work/renamed.json', 'work/draft.json', 'lidl.json', 'notes.txt'].map(snapshot),
    upload: async () => assert.equal(h.deletes.length, 0, 'removal happens only after every page is written'),
  });
  const result = await h.load('push-to-env').pushToEnvironment();
  const removed = ['lidl.json', 'work/draft.json', 'work/renamed.json'].map(snapshot);
  assert.deepEqual(removedBatches(h), [removed], 'one batch; non-JSON keys are not snapshots');
  assert.equal(h.deletes[0].Bucket, 'fixture-bucket');
  assert.equal(h.deletes[0].Delete.Objects.every(object => object.VersionId === undefined), true, 'plain delete writes markers');
  assert.equal(result.pagesRemoved, 3);
  assert.deepEqual(Array.from(result.removedKeys), removed);
  assert.equal(result.reconcileSkipped, undefined);
  assert.deepEqual(Array.from(result.paths).sort(), ['index.json', 'work.json', 'work/custom-slug.json', 'work/kept.json'].map(key => '/' + snapshot(key)));
  assert.equal(h.invalidations.length, 1);
  const { Paths } = h.invalidations[0].InvalidationBatch;
  assert.deepEqual(Array.from(Paths.Items).sort(), [...result.paths, ...removed.map(key => '/' + key)].sort());
  assert.equal(Paths.Quantity, Paths.Items.length);
});

test('reconcile refuses to delete anything when Builder returns zero published pages', async () => {
  const h = harness([{ ...page('only-draft'), published: 'draft' }], [], {}, { objects: ['home.json', 'work.json'].map(snapshot) });
  const result = await h.load('push-to-env').pushToEnvironment(undefined, { invalidate: false });
  assert.equal(h.deletes.length, 0);
  assert.equal(result.pagesRemoved, 0);
  assert.deepEqual(Array.from(result.removedKeys), []);
  assert.match(result.reconcileSkipped, /no published pages/i);
});

test('reconcile refuses to delete anything when the Builder listing stopped short or a page fetch failed', async () => {
  // The export's listing lost /about; a fresh listing shows it, so no key may be removed.
  const pages = [page('home'), page('about')];
  const h = harness(pages, [], {}, {
    objects: ['home.json', 'about.json', 'lidl.json'].map(snapshot),
    pageList: call => call === 1 ? pages.slice(0, 1) : pages,
  });
  const result = await h.load('push-to-env').pushToEnvironment(undefined, { invalidate: false });
  assert.equal(h.deletes.length, 0);
  assert.equal(result.pagesRemoved, 0);
  assert.deepEqual(Array.from(result.removedKeys), []);
  assert.match(result.reconcileSkipped, /listing/i);
  // A page that cannot be exported fails the job before anything is listed or removed.
  const failed = harness([page('home'), page('broken', 'https://cdn.builder.io/api/v1/image/assets%2Fspace%2Fbad.png')], [], {}, {
    objects: ['home.json', 'lidl.json'].map(snapshot),
    fetchAsset: async () => new Response(null, { status: 503 }),
  });
  await assert.rejects(failed.load('push-to-env').pushToEnvironment(undefined, { invalidate: false }), /Asset metadata request failed/);
  assert.equal(failed.deletes.length, 0);
  assert.ok(!failed.s3Requests.some(command => command.list));
});

test('single published page sync writes only that page and never reconciles', async () => {
  const h = harness([page('home'), page('about')], [], {}, { objects: ['home.json', 'about.json', 'lidl.json'].map(snapshot) });
  const result = await h.load('push-to-env').pushToEnvironment('home', { invalidate: false });
  assert.deepEqual(Array.from(result.paths), ['/' + snapshot('home.json')]);
  assert.equal(result.pagesRemoved, 0);
  assert.equal(h.deletes.length, 0);
  assert.equal(h.entryRequests.length, 1);
});

test('single-page sync of an unpublished page reads its draft and removes only its snapshot', async () => {
  const draft = { ...page('work/retired'), published: 'draft' };
  const h = harness([page('home'), draft], [], {}, { objects: ['home.json', 'work/retired.json', 'lidl.json'].map(snapshot) });
  const result = await h.load('push-to-env').pushToEnvironment('work/retired');
  assert.deepEqual(h.entryRequests.map(request => [request.query.id, request.options.includeUnpublished]), [['work/retired', false], ['work/retired', true]]);
  assert.deepEqual(removedBatches(h), [[snapshot('work/retired.json')]]);
  assert.equal(result.pagesRemoved, 1);
  assert.deepEqual(Array.from(result.removedKeys), [snapshot('work/retired.json')]);
  assert.deepEqual(Array.from(result.paths), []);
  assert.equal(h.uploads.length, 0);
  assert.deepEqual(Array.from(h.invalidations[0].InvalidationBatch.Paths.Items), ['/' + snapshot('work/retired.json')]);
});

test('unpublishing a page whose URL another published page serves keeps that snapshot', async () => {
  const live = { ...page('contact'), id: 'contact-v2' };
  const retired = { ...page('contact'), id: 'contact-v1', published: 'draft' };
  const h = harness([live, retired], [], {}, { objects: [snapshot('contact.json')] });
  const result = await h.load('push-to-env').pushToEnvironment('contact-v1', { invalidate: false });
  assert.equal(h.deletes.length, 0);
  assert.equal(result.pagesRemoved, 0);
  assert.deepEqual(Array.from(result.paths), ['/' + snapshot('contact.json')], 'the full reconcile rewrites the live page');
});

test('single-page sync of a page Builder no longer has falls back to the full reconcile', async () => {
  const h = harness([page('home')], [], {}, { objects: ['home.json', 'gone.json'].map(snapshot) });
  const result = await h.load('push-to-env').pushToEnvironment('deleted-page', { invalidate: false });
  assert.deepEqual(h.entryRequests.map(request => [request.query.id, request.options.includeUnpublished]), [['deleted-page', false], ['deleted-page', true]]);
  assert.deepEqual(Array.from(result.paths), ['/' + snapshot('home.json')]);
  assert.deepEqual(removedBatches(h), [[snapshot('gone.json')]]);
  assert.equal(result.pagesRemoved, 1);
  assert.deepEqual(Array.from(result.removedKeys), [snapshot('gone.json')]);
});
