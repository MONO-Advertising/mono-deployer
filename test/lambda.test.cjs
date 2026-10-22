const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const id = 'a'.repeat(64);
const fingerprint = (mode='deploy',pageId=undefined) => crypto.createHash('sha256').update(JSON.stringify({mode,pageId})).digest('hex');
const command = class { constructor(input) { this.input = input; } };
function harness(options = {}) {
  const calls = [];
  const env = { PUBLISH_ENABLED: 'true', JOBS_TABLE: 'jobs', QUEUE_URL: 'queue', INGRESS_SECRET_ARN: 'ingress', PUBLISHING_SECRET_ARN: 'publishing', AWS_CLOUDFRONT_DISTRIBUTION_ID: 'distribution', ...options.env };
  const common = {
    table:'jobs', requirePatchedNode() {},
    terminalStatuses:new Set(['deployment_requested','hook_unknown','validated','synced']),
    getJob:async () => typeof options.prior === 'function' ? options.prior() : options.prior,
    readSecret:async arn => arn === 'ingress' ? 'fixture-secret' : JSON.stringify({BUILDER_PRIVATE_KEY:'bpk-fixture',VERCEL_DEPLOY_WEBHOOK:'https://api.vercel.com/v1/integrations/deploy/fixture'}),
    db:{send:async cmd => { calls.push(['db',cmd.input]); if (options.dbError) throw options.dbError; return {}; }}
  };
  const mocks = {
    './common':common,
    '@aws-sdk/lib-dynamodb':{PutCommand:command,UpdateCommand:command},
    '@aws-sdk/client-sqs':{SendMessageCommand:command,SQSClient:class { async send(cmd) { calls.push(['sqs',cmd.input]); if (options.queueError) throw Error('queue unavailable'); return {}; } }},
    '@aws-sdk/client-cloudfront':{CreateInvalidationCommand:command,CloudFrontClient:class {async send(cmd) {calls.push(['cf',cmd.input]);return {Invalidation:{Id:'invalidation'}};}},waitUntilInvalidationCompleted:async()=>{calls.push(['wait']);}},
    '../lib/assets':{pushAssets:async()=>{calls.push(['assets']);return {failed:options.failedAssets || [],uploaded:[],skipped:[]};}},
    '../lib/push-to-env':{pushToEnvironment:async(pageId,config)=>{calls.push(['pages',pageId,config]);return {paths:['/builder/pages/home.json']};}}
  };
  function load(name) {
    const filename=path.resolve(__dirname,'../dist/lambda',name+'.js');
    const realRequire=createRequire(filename), module={exports:{}};
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
      module,exports:module.exports,require:name=>mocks[name] || realRequire(name),
      process:{env,versions:{node:'22.23.4'}},URL,Buffer,AbortSignal,
      console:{log(){},error(){}},fetch:async()=>{calls.push(['hook']);if(options.hookError)throw Error('timeout');return new Response(JSON.stringify({job:{id:'vercel-job'}}));}
    },{filename});
    return module.exports;
  }
  return {load,calls,env};
}
const event = (headers = {}, method='POST') => ({headers:{'x-deployment-key':'fixture-secret','idempotency-key':'submission-123456',...headers},requestContext:{http:{method}},rawPath:'/api/deploy'});
const records = {Records:[{messageId:'message',body:JSON.stringify({jobId:id,requestHash:fingerprint()})}]};
const context={getRemainingTimeInMillis:()=>600000};
const updates=h=>h.calls.filter(c=>c[0]==='db').map(c=>c[1]);
const statuses=h=>updates(h).flatMap(c=>Object.entries(c.ExpressionAttributeNames||{}).filter(([,v])=>v==='status').map(([k])=>c.ExpressionAttributeValues[k.replace('#k',':v')]));
test('ingress refuses missing/wrong auth and pause without queue or database writes',async()=>{
  for (const [headers,env,status] of [[{'x-deployment-key':undefined},{},401],[{'x-deployment-key':'wrong'},{},401],[{},{PUBLISH_ENABLED:'false'},503]]) {
    const h=harness({env}); const result=await h.load('ingress').handler(event(headers));
    assert.equal(result.statusCode,status);assert.equal(h.calls.length,0);
  }
});
test('ingress requires stable idempotency key and enqueues before saving queued state',async()=>{
  const h=harness();const handler=h.load('ingress').handler;
  assert.equal((await handler(event({'idempotency-key':'short'}))).statusCode,400);
  const result=await handler(event());assert.equal(result.statusCode,202);
  const job=JSON.parse(result.body); assert.equal(job.jobId,crypto.createHash('sha256').update('submission-123456').digest('hex'));
  assert.deepEqual(h.calls.map(c=>c[0]),['sqs','db']);
  assert.equal(h.calls[0][1].MessageDeduplicationId,job.jobId);
  assert.equal(h.calls[1][1].ConditionExpression,'attribute_not_exists(jobId)');
});
test('queue failure never creates phantom queued database record',async()=>{
  const h=harness({queueError:true});assert.equal((await h.load('ingress').handler(event())).statusCode,503);
  assert.deepEqual(h.calls.map(c=>c[0]),['sqs']);
});
test('existing job retry never queues a duplicate',async()=>{
  const h=harness({prior:{status:'queued'}});assert.equal((await h.load('ingress').handler(event())).statusCode,202);assert.equal(h.calls.length,0);
});
test('worker terminal duplicate is acknowledged without provider writes or hook',async()=>{
  for (const status of ['deployment_requested','hook_unknown','validated','synced']) {
    const h=harness({prior:{status}});const result=await h.load('worker').handler(records,context);
    assert.equal(result.batchItemFailures.length,0);assert.equal(h.calls.length,0);
  }
});
test('worker interrupted hook dispatch becomes unknown and never resends hook',async()=>{
  const h=harness({prior:{status:'hook_dispatching'}});const result=await h.load('worker').handler(records,context);
  assert.equal(result.batchItemFailures.length,0);assert.deepEqual(h.calls.map(c=>c[0]),['db']);
  assert.equal(updates(h)[0].ExpressionAttributeValues[':unknown'],'hook_unknown');
});
test('failed asset export retries job without page export, invalidation or deploy hook',async()=>{
  const h=harness({failedAssets:['bad-asset']});const result=await h.load('worker').handler(records,context);
  assert.equal(result.batchItemFailures[0].itemIdentifier,'message');
  assert.deepEqual(h.calls.map(c=>c[0]),['db','assets','db']);assert.ok(statuses(h).includes('retry'));
});
test('hook timeout becomes terminal unknown rather than retrying deployment',async()=>{
  const h=harness({hookError:true});const result=await h.load('worker').handler(records,context);
  assert.equal(result.batchItemFailures.length,0);assert.equal(h.calls.filter(c=>c[0]==='hook').length,1);
  const dispatchIndex=h.calls.findIndex(c=>c[0]==='db'&&Object.values(c[1].ExpressionAttributeValues||{}).includes('hook_dispatching'));
  assert.ok(dispatchIndex>=0&&dispatchIndex<h.calls.findIndex(c=>c[0]==='hook'));
  assert.ok(statuses(h).includes('hook_unknown'));
});
test('worker rejects paused publishing and malformed job identities',async()=>{
  const paused=harness({env:{PUBLISH_ENABLED:'false'}});await assert.rejects(paused.load('worker').handler(records,context),/paused/);assert.equal(paused.calls.length,0);
  const h=harness();const result=await h.load('worker').handler({Records:[{messageId:'bad',body:'{"jobId":"invalid"}'}]},context);
  assert.equal(result.batchItemFailures[0].itemIdentifier,'bad');assert.equal(h.calls.length,0);
});
test('terminal ingress retries report conflict instead of falsely reporting queued',async()=>{
  for (const status of ['deployment_requested','hook_unknown','validated','synced']) {
    const h=harness({prior:{status}});const response=await h.load('ingress').handler(event());
    assert.equal(response.statusCode,409);assert.equal(JSON.parse(response.body).status,status);assert.equal(h.calls.length,0);
  }
});
test('FIFO worker does not process later records after a failed record',async()=>{
  const h=harness();const result=await h.load('worker').handler({Records:[{messageId:'first',body:'not-json'},...records.Records]},context);
  assert.deepEqual(Array.from(result.batchItemFailures,x=>x.itemIdentifier),['first','message']);
  assert.equal(h.calls.length,0);
});
test('ingress binds sync mode and page ID into queue payload and request fingerprint',async()=>{
  const h=harness();const response=await h.load('ingress').handler({...event(),body:JSON.stringify({mode:'sync',pageId:'page-123'})});
  assert.equal(response.statusCode,202);
  const message=JSON.parse(h.calls[0][1].MessageBody);
  assert.equal(message.mode,'sync');assert.equal(message.pageId,'page-123');
  const expected=crypto.createHash('sha256').update(JSON.stringify({mode:'sync',pageId:'page-123'})).digest('hex');
  assert.equal(message.requestHash,expected);assert.equal(h.calls[1][1].Item.requestHash,expected);
});
test('ingress rejects mismatched idempotency fingerprint without requeueing',async()=>{
  const h=harness({prior:{status:'queued',requestHash:'different'}});
  const response=await h.load('ingress').handler(event());assert.equal(response.statusCode,409);assert.equal(h.calls.length,0);
});
test('ingress rejects malformed body, invalid mode/page and encoded payload',async()=>{
  for (const body of ['null','[]','bad',JSON.stringify({mode:'delete'}),JSON.stringify({mode:null}),JSON.stringify({mode:false}),JSON.stringify({mode:0}),JSON.stringify({mode:''}),JSON.stringify({pageId:'../home'}),JSON.stringify({pageId:123}),' '.repeat(4097)]) {
    const h=harness();assert.equal((await h.load('ingress').handler({...event(),body})).statusCode,400,body.slice(0,50));assert.equal(h.calls.length,0);
  }
  const h=harness();assert.equal((await h.load('ingress').handler({...event(),body:'e30=',isBase64Encoded:true})).statusCode,400);
});
test('sync updates selected page and invalidates cache without deploying Vercel',async()=>{
  const h=harness();const response=await h.load('worker').handler({Records:[{messageId:'sync',body:JSON.stringify({jobId:id,mode:'sync',pageId:'page-123',requestHash:fingerprint('sync','page-123')})}]},context);
  assert.equal(response.batchItemFailures.length,0);assert.equal(h.calls.find(c=>c[0]==='pages')[1],'page-123');
  assert.equal(h.calls.filter(c=>c[0]==='hook').length,0);assert.ok(h.calls.some(c=>c[0]==='wait'));assert.ok(statuses(h).includes('synced'));
});
test('worker rejects invalid sync page IDs before provider access',async()=>{
  for (const extra of [{mode:'delete'},{mode:'sync',pageId:'../bad'},{mode:'sync',pageId:3}]) {
    const h=harness();const result=await h.load('worker').handler({Records:[{messageId:'invalid',body:JSON.stringify({jobId:id,...extra})}]},context);
    assert.equal(result.batchItemFailures.length,1);assert.equal(h.calls.length,0);
  }
});
test('direct validation uses isolated prefix, clears environment, and never invalidates or deploys',async()=>{
  const h=harness({env:{PUBLISH_ENABLED:'false'}});const result=await h.load('worker').handler({validate:true},context);
  assert.match(result.prefix,/^builder\/validation\//);assert.equal(result.pageCount,1);assert.equal(result.failedAssets,0);
  assert.deepEqual(h.calls.map(c=>c[0]),['assets','pages']);assert.equal(h.env.S3_KEY_PREFIX,undefined);assert.equal(h.env.PUBLIC_ASSET_BASE_URL,undefined);
});
test('direct validation reports asset failures and skips page export',async()=>{
  const h=harness({failedAssets:['broken']});const result=await h.load('worker').handler({validate:true},context);
  assert.equal(result.failedAssets,1);assert.equal(result.assetCount,1);assert.deepEqual(h.calls.map(c=>c[0]),['assets']);assert.equal(h.env.S3_KEY_PREFIX,undefined);
});
test('ingress conditional-write race rejects different persisted request fingerprint',async()=>{
  let reads=0;
  const h=harness({prior:()=>++reads===1?undefined:{requestHash:'different'},dbError:Object.assign(Error('raced'),{name:'ConditionalCheckFailedException'})});
  assert.equal((await h.load('ingress').handler(event())).statusCode,409);
});
test('worker rejects missing, incorrect and persisted conflicting fingerprints before writes',async()=>{
  for (const [requestHash,prior] of [[undefined,undefined],['bad',undefined],[fingerprint(),{requestHash:'different',status:'queued'}]]) {
    const h=harness({prior});const result=await h.load('worker').handler({Records:[{messageId:'conflict',body:JSON.stringify({jobId:id,requestHash})}]},context);
    assert.equal(result.batchItemFailures.length,1);assert.equal(h.calls.length,0);
  }
});
test('worker claim atomically binds fingerprint to prevent read-write race',async()=>{
  const h=harness();await h.load('worker').handler(records,context);
  const claim=updates(h)[0];assert.match(claim.ConditionExpression,/requestHash = :requestHash/);
  assert.equal(claim.ExpressionAttributeValues[':requestHash'],fingerprint());
});
