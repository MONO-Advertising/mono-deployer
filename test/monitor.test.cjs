const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const id = 'a'.repeat(64);
const signingSecret = 'fixture-signing-secret-'.repeat(3);
const initial = () => ({ jobId:id,status:'deployment_requested',phase:'requested',createdAt:Math.floor(Date.now()/1000)-60,updatedAt:Math.floor(Date.now()/1000)-10,monitorKey:'active',deploymentId:'dpl_fixture',deploymentUrl:'https://fixture.vercel.app',mode:'deploy',slack:{channel:'C123',ts:'1792686074.000001'},assetTotal:10,assetCompleted:10,pageTotal:3,pageCompleted:3,privateInternal:'must not leave database' });
function harness(options = {}) {
  let job={...initial(),...options.job};
  const calls=[];
  let aliasReads=0;
  let projectReads=0;
  let callbackFails=options.callbackFails || false;
  class QueryCommand {constructor(input){this.input=input;this.kind='query';}}
  class UpdateCommand {constructor(input){this.input=input;this.kind='update';}}
  const env={JOBS_TABLE:'jobs',VERCEL_PROJECT_ID:'prj_fixture',VERCEL_TEAM_ID:'team_fixture',TRACKING_SECRET_ARN:'tracking',STATUS_SECRET_ARN:'status',BOT_STATUS_URL:'https://mono-deploy-bot.vercel.app/internal/publishing-status',...options.env};
  const db={send:async command=>{
    calls.push([command.kind,command.input]);
    if(command.kind==='query') return {Items:job.monitorKey==='active'?[structuredClone(job)]:[]};
    const input=command.input;
    assert.match(input.ConditionExpression,/#status = :oldStatus/);
    assert.match(input.ConditionExpression,/#updated = :oldUpdated/);
    if(options.stale || input.ExpressionAttributeValues[':oldStatus']!==job.status || input.ExpressionAttributeValues[':oldUpdated']!==job.updatedAt) throw Object.assign(Error('stale'),{name:'ConditionalCheckFailedException'});
    for(const [placeholder,name] of Object.entries(input.ExpressionAttributeNames)){
      if(placeholder.startsWith('#v'))job[name]=input.ExpressionAttributeValues[placeholder.replace('#',':')];
      if(placeholder.startsWith('#r'))delete job[name];
    }
    return {};
  }};
  const mocks={'./common':{db,table:'jobs',requirePatchedNode(){},readSecret:async arn=>arn==='status'?signingSecret:JSON.stringify({VERCEL_API_TOKEN:'fixture-private-api-token'})},'@aws-sdk/lib-dynamodb':{QueryCommand,UpdateCommand}};
  const filename=path.resolve(__dirname,'../dist/lambda/monitor.js');
  const module={exports:{}};const realRequire=createRequire(filename);
  const fetch=async(url,init)=>{
    const address=String(url);calls.push(['fetch',address,init]);
    if(address.includes('/v13/deployments/')){
      if(options.apiError)return new Response('{}',{status:503});
      return new Response(JSON.stringify({id:'dpl_fixture',projectId:'prj_fixture',target:'production',meta:{publishingJobId:id},readyState:'READY',...options.deployment}));
    }
    if(address.includes('/v9/projects/')){projectReads++;return new Response(JSON.stringify({id:'prj_fixture',targets:{production:{id:(projectReads>1&&options.changedProductionId)||options.productionId || 'dpl_fixture'}}}));}
    if(address.includes('/v4/aliases/')){aliasReads++;return new Response(JSON.stringify({alias:'www.mono-1.com',projectId:'prj_fixture',deploymentId:(aliasReads>1&&options.changedAliasId)||options.aliasId||'dpl_fixture',...options.alias}));}
    if(address==='https://www.mono-1.com/')return new Response(options.healthBody ?? '<!doctype html><html>healthy</html>',{status:options.healthStatus || 200,headers:{'content-type':options.healthType || 'text/html; charset=utf-8'}});
    if(address===env.BOT_STATUS_URL)return new Response('{}',{status:callbackFails?503:200});
    throw Error('Unexpected endpoint');
  };
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports:module.exports,module,require:n=>mocks[n]||realRequire(n),process:{env},URL,Buffer,AbortSignal,Response,Date,fetch,console:{error(){}},setTimeout,clearTimeout},{filename});
  return {run:()=>module.exports.handler({}, {getRemainingTimeInMillis:()=>60000}),calls,get job(){return job},set callbackFails(value){callbackFails=value}};
}
const callbacks=h=>h.calls.filter(c=>c[0]==='fetch'&&c[1].includes('/internal/publishing-status'));

test('monitor marks live only for exact deployment, project, publisher metadata, production target and HTML health',async()=>{
  const h=harness();await h.run();
  assert.equal(h.job.status,'live');assert.equal(h.job.phase,'live');assert.equal(h.job.monitorKey,undefined);
  assert.ok(h.calls.some(c=>c[0]==='fetch'&&c[1]==='https://api.vercel.com/v13/deployments/dpl_fixture?teamId=team_fixture'));
  assert.ok(h.calls.some(c=>c[0]==='fetch'&&c[1]==='https://api.vercel.com/v9/projects/prj_fixture?teamId=team_fixture'));
  assert.equal(callbacks(h).length,1);
});

test('monitor rejects unrelated deployment or wrong project without inventing completion',async()=>{
  for(const deployment of [{id:'dpl_other'},{projectId:'prj_other'},{meta:{publishingJobId:'b'.repeat(64)}},{target:'preview'}]){
    const h=harness({deployment});await h.run();
    assert.equal(h.job.status,'deployment_requested');assert.equal(h.job.phase,'requested');assert.equal(h.job.monitorKey,'active');
    assert.ok(!h.calls.some(c=>c[0]==='fetch'&&c[1]==='https://www.mono-1.com/'));
  }
});

test('READY without matching production target waits for promotion; non-HTML or unhealthy production cannot become live',async()=>{
  for(const options of [{productionId:'dpl_other'},{healthStatus:503},{healthType:'application/json'},{healthBody:'plain response'}]){
    const h=harness(options);await h.run();assert.equal(h.job.status,'ready');assert.equal(h.job.monitorKey,'active');
    assert.equal(h.job.phase,options.productionId?'awaiting_promotion':'health_check_pending');
  }
});

test('callback authenticates exact raw payload and exposes only allowed card fields',async()=>{
  const h=harness();await h.run();
  const [,url,request]=callbacks(h)[0];const body=JSON.parse(request.body);
  assert.equal(body.channel,'C123');assert.equal(body.ts,'1792686074.000001');assert.equal(body.job.status,'live');
  assert.equal(body.job.privateInternal,undefined);assert.equal(body.job.monitorKey,undefined);assert.equal(body.job.slack,undefined);
  assert.equal(body.job.assetTotal,10);assert.equal(body.job.pageTotal,3);
  const stamp=request.headers['x-publishing-timestamp'];
  assert.equal(request.headers['x-publishing-signature'],crypto.createHmac('sha256',signingSecret).update(stamp+'.'+request.body).digest('hex'));
  assert.equal(request.redirect,'error');assert.ok(!request.body.includes('fixture-private-api-token'));
});

test('failed Slack callback keeps terminal job monitored and retries without tracking or exporting again',async()=>{
  const h=harness({callbackFails:true});await h.run();
  assert.equal(h.job.status,'live');assert.equal(h.job.monitorKey,'active');assert.equal(h.job.notificationHash,undefined);
  const before=h.calls.length;h.callbackFails=false;await h.run();
  assert.equal(callbacks(h).length,2);assert.equal(h.job.monitorKey,undefined);assert.ok(h.job.notificationHash);
  assert.ok(!h.calls.slice(before).some(c=>c[0]==='fetch'&&c[1].startsWith('https://api.vercel.com')));
});

test('conditional stale observation cannot overwrite state or deliver a stale Slack card',async()=>{
  const h=harness({stale:true});await h.run();
  assert.equal(h.job.status,'deployment_requested');assert.equal(callbacks(h).length,0);assert.equal(h.job.notificationHash,undefined);
});

test('tracking API errors preserve state and phase, and unchanged snapshot sends only once',async()=>{
  const h=harness({apiError:true});await h.run();await h.run();
  assert.equal(h.job.status,'deployment_requested');assert.equal(h.job.phase,'requested');assert.equal(callbacks(h).length,1);assert.equal(h.job.monitorKey,'active');
});

test('monitor records failed and canceled deployments without treating them as live',async()=>{
  for(const readyState of ['ERROR','CANCELED']){
    const h=harness({deployment:{readyState}});await h.run();assert.equal(h.job.status,'failed');assert.equal(h.job.phase,readyState==='ERROR'?'build_failed':'canceled');assert.equal(h.job.monitorKey,undefined);
  }
});

test('expired jobs require attention and terminal jobs without Slack never send callbacks',async()=>{
  const h=harness({job:{createdAt:Math.floor(Date.now()/1000)-86401,slack:undefined}});await h.run();
  assert.equal(h.job.status,'attention_required');assert.equal(h.job.monitorKey,undefined);assert.equal(h.calls.filter(c=>c[0]==='fetch').length,0);
  const synced=harness({job:{status:'synced',slack:undefined}});await synced.run();assert.equal(synced.job.monitorKey,undefined);assert.equal(callbacks(synced).length,0);
});

test('canonical alias must match before and after health, including production pointer recheck',async()=>{
  for(const options of [{aliasId:'dpl_other'},{changedAliasId:'dpl_other'},{changedProductionId:'dpl_other'},{alias:{projectId:'prj_other'}},{alias:{alias:'other.example'}},{alias:{redirect:'other.example'}}]){
    const h=harness(options);await h.run();assert.equal(h.job.status,'ready');assert.equal(h.job.phase,'awaiting_promotion');assert.equal(h.job.monitorKey,'active');
  }
  const h=harness();await h.run();assert.equal(h.calls.filter(c=>c[0]==='fetch'&&c[1].includes('/v4/aliases/')).length,2);
});

test('callback configuration cannot send signed payloads to another host or port',async()=>{
  for(const endpoint of ['https://attacker.example/internal/publishing-status','https://mono-deploy-bot.vercel.app:444/internal/publishing-status']){
    const h=harness({env:{BOT_STATUS_URL:endpoint}});await h.run();assert.equal(callbacks(h).length,0);assert.equal(h.job.monitorKey,'active');assert.equal(h.job.notificationHash,undefined);
  }
});
