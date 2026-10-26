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
  const logs = [];
  const env = { PUBLISH_ENABLED: 'true', JOBS_TABLE: 'jobs', QUEUE_URL: 'queue', INGRESS_SECRET_ARN: 'ingress', PUBLISHING_SECRET_ARN: 'publishing', AWS_CLOUDFRONT_DISTRIBUTION_ID: 'distribution', VERCEL_TEAM_ID:'team_fixture', VERCEL_PROJECT_ID:'prj_fixture', VERCEL_GITHUB_REPO_ID:'12345', ...options.env };
  const common = {
    table:'jobs', requirePatchedNode() {},
    terminalStatuses:new Set(['deployment_requested','hook_unknown','validated','synced','ready','live','failed','attention_required']),
    getJob:async () => typeof options.prior === 'function' ? options.prior() : options.prior,
    readSecret:async arn => arn === 'ingress' ? 'fixture-secret' : JSON.stringify({BUILDER_PRIVATE_KEY:'bpk-fixture',VERCEL_DEPLOY_WEBHOOK:'https://api.vercel.com/v1/integrations/deploy/fixture',...options.publishingSecret}),
    db:{send:async cmd => { calls.push(['db',cmd.input]); if (options.dbError) throw options.dbError; if (options.dbSend) return options.dbSend(cmd.input); return {}; }}
  };
  const mocks = {
    './common':common,
    '@aws-sdk/lib-dynamodb':{PutCommand:command,UpdateCommand:command},
    '@aws-sdk/client-sqs':{SendMessageCommand:command,SQSClient:class { async send(cmd) { calls.push(['sqs',cmd.input]); if (options.queueError) throw Error('queue unavailable'); return {}; } }},
    '@aws-sdk/client-cloudfront':{CreateInvalidationCommand:command,CloudFrontClient:class {async send(cmd) {calls.push(['cf',cmd.input]);return {Invalidation:{Id:'invalidation'}};}},waitUntilInvalidationCompleted:async()=>{calls.push(['wait']);}},
    '../lib/assets':{pushAssets:async(config)=>{calls.push(['assets']); for (const value of options.assetProgress || []) { try { await config?.onProgress?.(value); } catch {} } return {failed:options.failedAssets || [],uploaded:[],skipped:[]};}},
    '../lib/push-to-env':{pushToEnvironment:async(pageId,config)=>{calls.push(['pages',pageId,config]); for (const value of options.pageProgress || []) { try { await config?.onProgress?.(value); } catch {} } return options.exported ?? {paths:['/builder/pages/home.json'],missingAssets:[],pagesRemoved:0,removedKeys:[]};}}
  };
  function load(name) {
    const filename=path.resolve(__dirname,'../dist/lambda',name+'.js');
    const realRequire=createRequire(filename), module={exports:{}};
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
      module,exports:module.exports,require:name=>mocks[name] || realRequire(name),
      process:{env,versions:{node:'22.23.4'}},URL,Buffer,AbortSignal,
      console:{log:(...args)=>logs.push(args.join(' ')),error:(...args)=>logs.push(args.join(' ')),warn(){}},fetch:async(url,config)=>{
        if(String(url).startsWith('https://api.vercel.com/v1/edge-cache/')){calls.push(['purge',String(url),config]);if(options.purgeError)throw options.purgeError;return new Response('{}',{status:options.purgeStatus || 200});}
        calls.push(['hook',url,config]);if(options.hookError)throw Error('timeout');return new Response(JSON.stringify(options.fetchBody ?? {job:{id:'vercel-job'}}),{status:options.fetchStatus || 200});}
    },{filename});
    return module.exports;
  }
  return {load,calls,env,logs};
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
  for (const status of ['deployment_requested','hook_unknown','validated','synced','ready','live','failed','attention_required']) {
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
  assert.deepEqual(h.calls.map(c=>c[0]),['db','db','assets','db']);assert.ok(statuses(h).includes('retry'));
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
  for (const status of ['deployment_requested','hook_unknown','validated','synced','ready','live','failed','attention_required']) {
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
test('direct validation rejects traversal identifiers before export or changing its storage prefix',async()=>{
  for (const validationId of ['../outside','../../pages','%2e%2e%2foutside','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/../../pages','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\\outside']) {
    const h=harness({env:{PUBLISH_ENABLED:'false'}});
    await assert.rejects(h.load('worker').handler({validate:true,validationId},context),/Invalid validation ID/);
    assert.equal(h.calls.length,0);assert.equal(h.env.S3_KEY_PREFIX,undefined);assert.equal(h.env.PUBLIC_ASSET_BASE_URL,undefined);
  }
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

const fields = update => Object.fromEntries(Object.entries(update.ExpressionAttributeNames || {}).filter(([key])=>key.startsWith('#k')).map(([key,name])=>[name,update.ExpressionAttributeValues[key.replace('#k',':v')]]));
const payloadRecord = payload => ({Records:[{messageId:'message',body:JSON.stringify({jobId:id,requestHash:fingerprint(),...payload})}]});

test('Slack targets are validated before ingress queueing and worker claims',async()=>{
  for (const slack of [null,{},[],{channel:'https://evil.example',ts:'1792687000.123456'}, {channel:'CABC',ts:'1.123456'}, {channel:'CABC',ts:'1792687000.123'}, {channel:123,ts:'1792687000.123456'}]) {
    const h=harness();
    assert.equal((await h.load('ingress').handler({...event(),body:JSON.stringify({slack})})).statusCode,400);
    assert.equal(h.calls.length,0);
    const result=await h.load('worker').handler(payloadRecord({slack}),context);
    assert.equal(result.batchItemFailures.length,1);assert.equal(h.calls.length,0);
  }
});

test('Slack target is persisted as channel and timestamp only, with original retry target authoritative',async()=>{
  const slack={channel:'CABC',ts:'1792687000.123456',unexpected:'do-not-store'};
  const h=harness(); const response=await h.load('ingress').handler({...event(),body:JSON.stringify({slack})});
  assert.equal(response.statusCode,202);
  const safe={channel:slack.channel,ts:slack.ts};
  assert.deepEqual(JSON.parse(h.calls[0][1].MessageBody).slack,safe);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1][1].Item.slack)),safe);
  assert.deepEqual(JSON.parse(response.body).slack,safe);
  const duplicate=harness({prior:{status:'running',requestHash:fingerprint(),slack:safe}});
  const retried=await duplicate.load('ingress').handler({...event(),body:JSON.stringify({slack:{channel:'COTHER',ts:'1792687001.123456'}})});
  assert.deepEqual(JSON.parse(retried.body).slack,safe);assert.equal(duplicate.calls.length,0);
});

test('status API exposes progress and exact deployment identity but no internal state or nested extras',async()=>{
  const prior={status:'building',phase:'building',mode:'deploy',assetTotal:10,assetCompleted:10,pageTotal:2,pageCompleted:2,
    deploymentId:'dpl_fixture',deploymentUrl:'https://fixture.vercel.app',slack:{channel:'CABC',ts:'1792687000.123456',token:'private'},
    attempt:'private',requestHash:'private',paths:['private'],leaseUntil:123,monitorKey:'active',notificationHash:'private'};
  const h=harness({prior});
  const result=await h.load('ingress').handler({...event({},'GET'),pathParameters:{jobId:id},rawPath:'/api/jobs/'+id});
  assert.equal(result.statusCode,200);
  const body=JSON.parse(result.body);
  assert.equal(body.assetCompleted,10);assert.equal(body.pageCompleted,2);assert.equal(body.deploymentId,'dpl_fixture');
  for(const key of ['attempt','requestHash','paths','leaseUntil','monitorKey','notificationHash']) assert.equal(body[key],undefined);
  assert.deepEqual(body.slack,{channel:'CABC',ts:'1792687000.123456'});
  assert.equal(result.headers['cache-control'],'no-store');assert.equal(h.calls.length,0);
});

test('worker progress writes are throttled but final counters and phase boundaries persist',async()=>{
  const h=harness({assetProgress:[
    {total:2,completed:0,uploaded:0,skipped:0,failed:0},
    {total:2,completed:1,uploaded:1,skipped:0,failed:0},
    {total:2,completed:2,uploaded:1,skipped:1,failed:0},
  ],pageProgress:[{total:1,completed:0},{total:1,completed:1}]});
  await h.load('worker').handler(records,context);
  const values=updates(h).map(fields);
  const assets=values.filter(v=>v.assetTotal!==undefined);
  assert.equal(assets.length,2);assert.equal(assets[0].assetCompleted,0);assert.equal(assets[1].assetCompleted,2);
  assert.equal(assets[1].assetUploaded,1);assert.equal(assets[1].assetSkipped,1);assert.equal(assets[1].assetFailed,0);
  assert.deepEqual(values.filter(v=>v.pageTotal!==undefined).map(v=>v.pageCompleted),[0,1]);
  assert.ok(values.some(v=>v.phase==='invalidating'));
  for(const update of updates(h).slice(1)) assert.equal(update.ConditionExpression,'attempt = :attempt');
});

test('Vercel API submission records only confirmed exact project deployment identity after invalidation',async()=>{
  const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},fetchBody:{id:'dpl_exact',projectId:'prj_fixture',url:'fixture.vercel.app'}});
  const result=await h.load('worker').handler(records,context);assert.equal(result.batchItemFailures.length,0);
  const hook=h.calls.find(c=>c[0]==='hook');assert.match(hook[1],/^https:\/\/api.vercel.com\/v13\/deployments\?teamId=team_fixture$/);
  const request=JSON.parse(hook[2].body);assert.equal(request.project,'prj_fixture');assert.equal(request.gitSource.ref,'main');assert.equal(request.meta.publishingJobId,id);
  assert.equal(hook[2].redirect,'error');assert.equal(hook[2].headers.authorization,'Bearer fixture-token');
  assert.ok(h.calls.findIndex(c=>c[0]==='wait')<h.calls.indexOf(hook));
  const resultState=updates(h).map(fields).find(v=>v.deploymentId);
  assert.equal(resultState.status,'deployment_requested');assert.equal(resultState.deploymentId,'dpl_exact');assert.equal(resultState.deploymentUrl,'https://fixture.vercel.app');
  assert.equal(resultState.vercelJobId,undefined);
});

test('unconfirmed Vercel API responses become ambiguous terminal jobs, never automatic deploy retries',async()=>{
  for(const fetchBody of [{id:'dpl_exact',projectId:'prj_other',url:'fixture.vercel.app'},{id:'dpl_exact',projectId:'prj_fixture',url:'evil.example'}, {id:'bad',projectId:'prj_fixture',url:'fixture.vercel.app'},{}]) {
    const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},fetchBody});
    const result=await h.load('worker').handler(records,context);assert.equal(result.batchItemFailures.length,0);
    assert.equal(h.calls.filter(c=>c[0]==='hook').length,1);assert.ok(statuses(h).includes('hook_unknown'));assert.ok(!statuses(h).includes('retry'));
    assert.ok(!updates(h).map(fields).some(v=>v.deploymentId));
  }
});

test('checkpoint retry reuses exported paths and invalidation instead of repeating export',async()=>{
  const h=harness({prior:{status:'retry',requestHash:fingerprint(),paths:['/builder/pages/checkpoint.json'],invalidationId:'prior-invalidation'}});
  await h.load('worker').handler(records,context);
  assert.ok(!h.calls.some(c=>['assets','pages','cf'].includes(c[0])));assert.equal(h.calls.filter(c=>c[0]==='wait').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='hook').length,1);assert.ok(statuses(h).includes('deployment_requested'));
});

test('same-key race returns the winning persisted Slack target rather than the later request target',async()=>{
  let reads=0;
  const winner={status:'queued',requestHash:fingerprint(),slack:{channel:'CWINNER',ts:'1792687000.123456'}};
  const h=harness({prior:()=>++reads===1?undefined:winner,dbError:Object.assign(Error('raced'),{name:'ConditionalCheckFailedException'})});
  const response=await h.load('ingress').handler({...event(),body:JSON.stringify({slack:{channel:'CLATER',ts:'1792687001.123456'}})});
  assert.equal(response.statusCode,202);assert.deepEqual(JSON.parse(response.body).slack,winner.slack);
  assert.equal(h.calls.filter(c=>c[0]==='sqs').length,1);
});

test('active worker lease conflict fails the delivery before exports or external deployment',async()=>{
  const h=harness({prior:{status:'running',requestHash:fingerprint()},dbError:Object.assign(Error('leased'),{name:'ConditionalCheckFailedException'})});
  const response=await h.load('worker').handler(records,context);
  assert.equal(response.batchItemFailures.length,1);
  assert.deepEqual(h.calls.map(c=>c[0]),['db']);
  const claim=updates(h)[0];assert.match(claim.ConditionExpression,/leaseUntil < :now/);
});

test('Vercel API timeout retains durable dispatch intent and stops automatic redelivery',async()=>{
  const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},hookError:true});
  const result=await h.load('worker').handler(records,context);assert.equal(result.batchItemFailures.length,0);
  const hookIndex=h.calls.findIndex(c=>c[0]==='hook');
  const intentIndex=h.calls.findIndex(c=>c[0]==='db'&&fields(c[1]).status==='hook_dispatching');
  assert.ok(intentIndex>=0&&intentIndex<hookIndex);
  assert.equal(h.calls.filter(c=>c[0]==='hook').length,1);assert.ok(statuses(h).includes('hook_unknown'));
  assert.ok(!statuses(h).includes('retry'));
});

// Removal and Vercel cache refresh (plan B8, B7).
const syncRecord = (pageId='page-123') => ({Records:[{messageId:'sync',body:JSON.stringify({jobId:id,mode:'sync',pageId,requestHash:fingerprint('sync',pageId)})}]});
const purges = h => h.calls.filter(c=>c[0]==='purge');
const purgeUrl = action => `https://api.vercel.com/v1/edge-cache/${action}?projectIdOrName=prj_fixture&teamId=team_fixture`;
const removal = {paths:[],missingAssets:[],pagesRemoved:1,removedKeys:['builder/pages/retired.json']};

test('sync records removed pages, invalidates their paths, then purges Vercel with the delete form before reporting synced',async()=>{
  const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},exported:removal});
  const result=await h.load('worker').handler(syncRecord(),context);
  assert.equal(result.batchItemFailures.length,0);
  const checkpoint=updates(h).map(fields).find(v=>v.paths);
  assert.deepEqual(Array.from(checkpoint.paths),[]);assert.equal(checkpoint.pagesRemoved,1);assert.deepEqual(Array.from(checkpoint.removedKeys),['builder/pages/retired.json']);
  const cf=h.calls.find(c=>c[0]==='cf');
  assert.deepEqual(Array.from(cf[1].InvalidationBatch.Paths.Items),['/builder/pages/retired.json']);assert.equal(cf[1].InvalidationBatch.Paths.Quantity,1);
  assert.equal(purges(h).length,1);
  const [,url,request]=purges(h)[0];
  assert.equal(url,purgeUrl('dangerously-delete-by-tags'));
  assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.ok(request.signal);
  assert.equal(request.headers.authorization,'Bearer fixture-token');assert.equal(request.headers['content-type'],'application/json');
  assert.deepEqual(JSON.parse(request.body),{tags:'public-html'});
  const purgeIndex=h.calls.indexOf(purges(h)[0]);
  assert.ok(h.calls.findIndex(c=>c[0]==='wait')<purgeIndex);
  const purging=h.calls.findIndex(c=>c[0]==='db'&&fields(c[1]).phase==='purging');
  assert.ok(purging>=0&&purging<purgeIndex,'the job shows the purging step while it runs');
  const synced=h.calls.findIndex(c=>c[0]==='db'&&fields(c[1]).status==='synced');
  assert.ok(purgeIndex<synced);assert.deepEqual({...fields(h.calls[synced][1]).vercelPurge},{ok:true,form:'delete'});
  assert.equal(h.calls.filter(c=>c[0]==='hook').length,0);
});

test('sync purges with the invalidate form when nothing was removed, and not at all without a Vercel token',async()=>{
  const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'}});
  assert.equal((await h.load('worker').handler(syncRecord(),context)).batchItemFailures.length,0);
  assert.deepEqual(purges(h).map(c=>c[1]),[purgeUrl('invalidate-by-tags')]);
  assert.equal(updates(h).map(fields).find(v=>v.paths).pagesRemoved,0);
  assert.deepEqual({...updates(h).map(fields).find(v=>v.status==='synced').vercelPurge},{ok:true,form:'invalidate'});
  const tokenless=harness({exported:removal});
  assert.equal((await tokenless.load('worker').handler(syncRecord(),context)).batchItemFailures.length,0);
  assert.equal(purges(tokenless).length,0);assert.ok(statuses(tokenless).includes('synced'));
});

test('a failed Vercel purge ends the sync job as attention_required with its status, without blocking the queue',async()=>{
  for (const [failure,status] of [[{purgeStatus:403},403],[{purgeError:Object.assign(Error('aborted'),{name:'TimeoutError'})},'TimeoutError']]) {
    const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},...failure});
    const result=await h.load('worker').handler(syncRecord(),context);
    assert.equal(result.batchItemFailures.length,0,'the message is acknowledged; content is already live');
    assert.equal(purges(h).length,1);
    assert.deepEqual(statuses(h).slice(-1),['attention_required']);assert.ok(!statuses(h).includes('synced'));assert.ok(!statuses(h).includes('retry'));
    const final=updates(h).map(fields).find(v=>v.status==='attention_required');
    assert.equal(final.phase,'purging');assert.deepEqual({...final.vercelPurge},{ok:false,status});
    assert.ok(h.logs.some(line=>line===JSON.stringify({jobId:id,event:'vercel_purge_failed',status})));
    assert.ok(h.logs.every(line=>!line.includes('fixture-token')));
  }
});

test('VERCEL_CACHE_PURGE off, false, 0 or disabled skips the purge; any other value purges',async()=>{
  for (const value of ['off','false','0','disabled',' OFF ']) {
    const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},env:{VERCEL_CACHE_PURGE:value}});
    assert.equal((await h.load('worker').handler(syncRecord(),context)).batchItemFailures.length,0);
    assert.equal(purges(h).length,0,value);assert.ok(statuses(h).includes('synced'));
    assert.ok(h.logs.some(line=>line===JSON.stringify({jobId:id,event:'vercel_purge_skipped'})));
  }
  for (const value of ['on','true','yes']) {
    const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},env:{VERCEL_CACHE_PURGE:value}});
    await h.load('worker').handler(syncRecord(),context);assert.equal(purges(h).length,1,value);
  }
});

test('deploy jobs invalidate removed paths but leave Vercel purging to the new deployment',async()=>{
  const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},fetchBody:{id:'dpl_exact',projectId:'prj_fixture',url:'fixture.vercel.app'},exported:{...removal,paths:['/builder/pages/home.json']}});
  assert.equal((await h.load('worker').handler(records,context)).batchItemFailures.length,0);
  assert.deepEqual(Array.from(h.calls.find(c=>c[0]==='cf')[1].InvalidationBatch.Paths.Items),['/builder/pages/home.json','/builder/pages/retired.json']);
  assert.equal(purges(h).length,0);assert.ok(statuses(h).includes('deployment_requested'));
});

test('checkpoint retry invalidates recorded removals and keeps the delete-form purge without exporting again',async()=>{
  const h=harness({publishingSecret:{VERCEL_API_TOKEN:'fixture-token'},prior:{status:'retry',requestHash:fingerprint('sync','page-123'),paths:[],pagesRemoved:1,removedKeys:['builder/pages/retired.json']}});
  assert.equal((await h.load('worker').handler(syncRecord(),context)).batchItemFailures.length,0);
  assert.ok(!h.calls.some(c=>['assets','pages'].includes(c[0])));
  assert.deepEqual(Array.from(h.calls.find(c=>c[0]==='cf')[1].InvalidationBatch.Paths.Items),['/builder/pages/retired.json']);
  assert.deepEqual(purges(h).map(c=>c[1]),[purgeUrl('dangerously-delete-by-tags')]);assert.ok(statuses(h).includes('synced'));
});

test('a full export that wrote no page fails the job even when it removed snapshots',async()=>{
  const h=harness({exported:removal});
  const result=await h.load('worker').handler(records,context);
  assert.equal(result.batchItemFailures.length,1);assert.ok(statuses(h).includes('retry'));
  assert.ok(!h.calls.some(c=>c[0]==='cf'));assert.ok(!updates(h).map(fields).some(v=>v.paths));
});
