const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { validateAssetUrl, readAsset } = require('../dist/lib/asset-fetch');

test('asset URLs reject metadata endpoints, deceptive hosts, credentials and HTTP', () => {
  for (const url of ['http://cdn.builder.io/a', 'http://169.254.169.254/', 'https://cdn.builder.io.evil.test/a', 'https://evil.test/?cdn.builder.io', 'https://user:pass@cdn.builder.io/a']) {
    assert.throws(() => validateAssetUrl(url));
  }
  assert.equal(validateAssetUrl('https://cdn.builder.io/api/v1/image/assets%2Fid').hostname, 'cdn.builder.io');
});

test('asset size limit covers chunked responses as well as declared length', async () => {
  await assert.rejects(readAsset(new Response('12345'), 4));
  await assert.rejects(readAsset(new Response('1', { headers: { 'content-length': '9' } }), 4));
  assert.equal((await readAsset(new Response('123'), 4)).toString(), '123');
});

test('deploy endpoint fails closed, authenticates before work, and serializes runs', async (t) => {
  assert.throws(() => createApp('', async () => {}));
  let release;
  let calls = 0;
  const app = createApp('test-secret', () => { calls++; return new Promise(r => { release = r; }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/deploy`;
  const post = (key) => fetch(url, { method: 'POST', headers: key ? { 'x-deployment-key': key } : {} });
  assert.equal((await post()).status, 401);
  assert.equal((await post('wrong')).status, 401);
  assert.equal(calls, 0);
  assert.equal((await post('test-secret')).status, 202);
  assert.equal((await post('test-secret')).status, 409);
  assert.equal(calls, 1);
  release();
  await new Promise(r => setImmediate(r));
  assert.equal((await post('test-secret')).status, 202);
  release();
});
