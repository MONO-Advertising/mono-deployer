import { randomUUID, createHash } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CloudFrontClient, CreateInvalidationCommand, waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront';
import type { SQSEvent, Context } from 'aws-lambda';
import { db, table, getJob, readSecret, requirePatchedNode, terminalStatuses } from './common';

const cf = new CloudFrontClient({ region: 'us-east-1' });
async function publishingSecrets() {
  const values = JSON.parse(await readSecret(process.env.PUBLISHING_SECRET_ARN!));
  if (typeof values.BUILDER_PRIVATE_KEY !== 'string' || !values.BUILDER_PRIVATE_KEY.startsWith('bpk-')) throw new Error('Builder key not configured');
  const hook = new URL(values.VERCEL_DEPLOY_WEBHOOK);
  if (hook.origin !== 'https://api.vercel.com' || !hook.pathname.startsWith('/v1/integrations/deploy/') || hook.username || hook.password) throw new Error('Invalid deploy hook');
  if (process.env.TRACKING_SECRET_ARN) {
    const automation = JSON.parse(await readSecret(process.env.TRACKING_SECRET_ARN));
    values.VERCEL_API_TOKEN = automation.VERCEL_API_TOKEN;
  }
  if (values.VERCEL_API_TOKEN && (!/^team_[A-Za-z0-9]+$/.test(process.env.VERCEL_TEAM_ID || '') || !/^prj_[A-Za-z0-9]+$/.test(process.env.VERCEL_PROJECT_ID || '') || !/^\d+$/.test(process.env.VERCEL_GITHUB_REPO_ID || ''))) throw new Error('Deployment tracking configuration missing');
  process.env.BUILDER_PRIVATE_KEY = values.BUILDER_PRIVATE_KEY;
  return values as { BUILDER_PRIVATE_KEY: string; VERCEL_DEPLOY_WEBHOOK: string; VERCEL_API_TOKEN?: string };
}

// Vercel's shared HTML otherwise keeps serving for up to an hour after CloudFront refreshes.
// Delete rather than invalidate when pages were removed, so a removed page is never served again.
async function purgePublicHtml(token: string, removed: boolean) {
  const action = removed ? 'dangerously-delete-by-tags' : 'invalidate-by-tags';
  const response = await fetch(`https://api.vercel.com/v1/edge-cache/${action}?projectIdOrName=${encodeURIComponent(process.env.VERCEL_PROJECT_ID!)}&teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID!)}`, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(30_000),
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({tags:'public-html'}),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Vercel cache purge not confirmed');
}

async function processJob(jobId: string, context: Context, mode: 'sync' | 'deploy' = 'deploy', pageId?: string, requestHash?: string, slack?: {channel:string;ts:string}) {
  const expectedHash = createHash('sha256').update(JSON.stringify({ mode, pageId })).digest('hex');
  if (requestHash !== expectedHash) throw new Error('Invalid request fingerprint');
  const prior = await getJob(jobId);
  if (prior?.requestHash && prior.requestHash !== requestHash) throw new Error('Request fingerprint conflict');
  if (prior && terminalStatuses.has(prior.status)) return;
  if (prior?.status === 'hook_dispatching') {
    await db.send(new UpdateCommand({ TableName: table, Key: { jobId }, UpdateExpression: 'SET #s = :unknown, updatedAt = :now', ConditionExpression: '#s = :dispatching', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':unknown': 'hook_unknown', ':dispatching': 'hook_dispatching', ':now': Math.floor(Date.now()/1000) } }));
    console.error(JSON.stringify({ jobId, status: 'hook_unknown' }));
    return;
  }
  const attempt = randomUUID();
  const now = Math.floor(Date.now()/1000);
  await db.send(new UpdateCommand({ TableName: table, Key: { jobId },
    UpdateExpression: 'SET #s = :running, attempt = :attempt, leaseUntil = :lease, updatedAt = :now, expiresAt = :expires, requestHash = :requestHash, createdAt = if_not_exists(createdAt, :now), #mode = :mode, monitorKey = :active' + (slack ? ', slack = if_not_exists(slack, :slack)' : ''),
    ConditionExpression: '(attribute_not_exists(requestHash) OR requestHash = :requestHash) AND (attribute_not_exists(jobId) OR #s = :queued OR #s = :retry OR (#s = :running AND leaseUntil < :now))',
    ExpressionAttributeNames: { '#s': 'status', '#mode':'mode' },
    ExpressionAttributeValues: { ':mode':mode, ':active':'active', ...(slack ? {':slack':slack} : {}), ':requestHash':requestHash, ':running':'running', ':queued':'queued', ':retry':'retry', ':attempt':attempt, ':lease': now + 930, ':now':now, ':expires':now+30*86400 } }));
  const update = async (values: Record<string, unknown>) => {
    const keys = Object.keys(values);
    const names: Record<string,string> = {};
    const vals: Record<string,unknown> = { ':attempt':attempt };
    for (const [i,key] of keys.entries()) { names[`#k${i}`]=key; vals[`:v${i}`]=values[key]; }
    await db.send(new UpdateCommand({ TableName:table, Key:{jobId}, ConditionExpression:'attempt = :attempt', UpdateExpression:'SET '+keys.map((_,i)=>`#k${i} = :v${i}`).join(', '), ExpressionAttributeNames:names, ExpressionAttributeValues:vals }));
  };
  let dispatching = false;
  let phase = 'assets';
  let lastProgress = 0;
  const progress = async (values: Record<string,number>, complete:boolean) => {
    if (!complete && Date.now()-lastProgress < 5000) return;
    lastProgress=Date.now();
    await update({...values, phase, updatedAt:Math.floor(Date.now()/1000)});
  };
  try {
    const secrets = await publishingSecrets();
    // Import after injecting secrets; the legacy exporters validate env at module init.
    const { pushAssets } = await import('../lib/assets');
    const { pushToEnvironment } = await import('../lib/push-to-env');
    let paths = prior?.paths as string[] | undefined;
    let removedKeys = (prior?.removedKeys ?? []) as string[];
    if (!paths) {
      await update({phase, updatedAt:Math.floor(Date.now()/1000)});
      const assets = await pushAssets({onProgress: p => progress({assetTotal:p.total,assetCompleted:p.completed,assetUploaded:p.uploaded,assetSkipped:p.skipped,assetFailed:p.failed},p.completed===p.total)});
      if (assets.failed.length) throw new Error('Asset export failed');
      phase='pages'; lastProgress=0;
      await update({phase, updatedAt:Math.floor(Date.now()/1000)});
      const exported = await pushToEnvironment(pageId, { invalidate: false, onProgress:p=>progress({pageTotal:p.total,pageCompleted:p.completed},p.completed===p.total) });
      paths = exported.paths;
      removedKeys = exported.removedKeys;
      if (exported.missingAssets?.length) await update({ missingAssetCount: exported.missingAssets.length });
      // A full export must write pages; only a single-page sync may consist of a removal alone.
      if (!paths.length && !(pageId && removedKeys.length)) throw new Error('No published pages exported');
      // Removals checkpoint with the paths so a retry still invalidates and purges them.
      await update({ paths, pagesRemoved: exported.pagesRemoved, removedKeys, ...(exported.reconcileSkipped ? { reconcileSkipped: exported.reconcileSkipped } : {}), updatedAt: Math.floor(Date.now()/1000) });
    }
    const invalidationPaths = [...paths, ...removedKeys.map(key => '/' + key)];
    phase='invalidating';
    await update({phase, updatedAt:Math.floor(Date.now()/1000)});
    let invalidationId = prior?.invalidationId as string | undefined;
    if (!invalidationId) {
      const response = await cf.send(new CreateInvalidationCommand({ DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID!, InvalidationBatch: { CallerReference: jobId, Paths: { Quantity: invalidationPaths.length, Items: invalidationPaths } } }));
      invalidationId = response.Invalidation?.Id;
      if (!invalidationId) throw new Error('Invalidation not created');
      await update({ invalidationId });
    }
    const remaining = Math.floor(context.getRemainingTimeInMillis()/1000)-45;
    if (remaining < 30) throw new Error('Insufficient time for invalidation');
    await waitUntilInvalidationCompleted({ client: cf, maxWaitTime: Math.min(remaining,300), minDelay: 10, maxDelay: 20 }, { DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID!, Id: invalidationId });
    if (mode === 'sync') {
      // Deploy jobs skip this: their new deployment starts with an empty cache.
      if (secrets.VERCEL_API_TOKEN) await purgePublicHtml(secrets.VERCEL_API_TOKEN, removedKeys.length > 0);
      await update({ status:'synced', phase:'synced', updatedAt:Math.floor(Date.now()/1000) });
      console.log(JSON.stringify({jobId,status:'synced'}));
      return;
    }
    phase='building';
    // Record BEFORE dispatch: a timeout may mean Vercel accepted the request.
    await update({ status:'hook_dispatching', phase:'building', updatedAt:Math.floor(Date.now()/1000) });
    dispatching = true;
    if (secrets.VERCEL_API_TOKEN) {
      const response = await fetch(`https://api.vercel.com/v13/deployments?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID!)}`, {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(30_000),
        headers:{authorization:`Bearer ${secrets.VERCEL_API_TOKEN}`,'content-type':'application/json'},
        body:JSON.stringify({name:'mono-dotcom',project:process.env.VERCEL_PROJECT_ID,target:'production',
          gitSource:{type:'github',repoId:process.env.VERCEL_GITHUB_REPO_ID,ref:'main'},meta:{publishingJobId:jobId}})
      });
      if (!response.ok) throw new Error('Deployment request not confirmed');
      const body = await response.json() as {id?:string;url?:string;projectId?:string};
      if (!body.id || !/^dpl_[A-Za-z0-9]+$/.test(body.id) || body.projectId !== process.env.VERCEL_PROJECT_ID || !body.url || !/^[a-zA-Z0-9-]+\.vercel\.app$/.test(body.url)) throw new Error('Deployment response not confirmed');
      await update({status:'deployment_requested', phase:'building', deploymentId:body.id, deploymentUrl:`https://${body.url}`, updatedAt:Math.floor(Date.now()/1000)});
    } else {
      // Legacy hook compatibility. Without an exact deployment ID the monitor must
      // never infer completion from a nearby build or a successful homepage fetch.
      const response = await fetch(secrets.VERCEL_DEPLOY_WEBHOOK, { method:'POST', redirect:'error', signal:AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('Deploy hook did not confirm acceptance');
      const body = await response.json() as { job?: { id?: string } };
      if (!body.job?.id) throw new Error('Deploy hook response not confirmed');
      await update({ status:'deployment_requested', phase:'building', vercelJobId:body.job.id, updatedAt:Math.floor(Date.now()/1000) });
    }
    console.log(JSON.stringify({ jobId, status:'deployment_requested' }));
  } catch {
    await update({ status:dispatching ? 'hook_unknown' : 'retry', phase, updatedAt:Math.floor(Date.now()/1000) });
    console.error(JSON.stringify({ jobId, status:dispatching ? 'hook_unknown' : 'retry' }));
    if (!dispatching) throw new Error('Publishing failed before deploy hook');
  }
}

export async function handler(event: SQSEvent | { healthcheck: true } | { validate: true; validationId?: string }, context: Context) {
  requirePatchedNode();
  if ('healthcheck' in event && event.healthcheck === true) {
    let secretsReady = false;
    try { await publishingSecrets(); secretsReady = true; } catch { /* report readiness only */ }
    return { runtime:process.versions.node, secretsReady, publishingEnabled:process.env.PUBLISH_ENABLED === 'true' };
  }
  if ('validate' in event && event.validate === true) {
    await publishingSecrets();
    const validationId = event.validationId || randomUUID();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(validationId)) throw new Error('Invalid validation ID');
    const prefix = `builder/validation/${validationId}`;
    process.env.S3_KEY_PREFIX = prefix;
    process.env.PUBLIC_ASSET_BASE_URL = `https://d1ttqs35fxgawv.cloudfront.net/${prefix}`;
    const start = Date.now();
    try {
      const { pushAssets } = await import('../lib/assets');
      const { pushToEnvironment } = await import('../lib/push-to-env');
      const assets = await pushAssets();
      if (assets.failed.length) return { runtime:process.versions.node, prefix, assetCount:assets.uploaded.length+assets.skipped.length+assets.failed.length, failedAssets:assets.failed.length, elapsedSeconds:(Date.now()-start)/1000 };
      const { paths, missingAssets } = await pushToEnvironment(undefined,{invalidate:false});
      return { runtime:process.versions.node, prefix, assetCount:assets.uploaded.length+assets.skipped.length, pageCount:paths.length, missingAssets:missingAssets || [], failedAssets:0, elapsedSeconds:(Date.now()-start)/1000 };
    } finally {
      delete process.env.S3_KEY_PREFIX;
      delete process.env.PUBLIC_ASSET_BASE_URL;
    }
  }
  if (process.env.PUBLISH_ENABLED !== 'true') throw new Error('Publishing is paused');
  const records = (event as SQSEvent).Records;
  const failures: {itemIdentifier:string}[] = [];
  for (const [index, record] of records.entries()) {
    try {
      const { jobId, mode = 'deploy', pageId, requestHash, slack } = JSON.parse(record.body);
      if (!['sync','deploy'].includes(mode) || (pageId !== undefined && (typeof pageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pageId)))) throw new Error('Invalid job mode');
      if (!/^[a-f0-9]{64}$/.test(jobId)) throw new Error('Invalid job');
      if (slack !== undefined && (!slack || typeof slack.channel !== 'string' || !/^[CDG][A-Z0-9]{1,30}$/.test(slack.channel) || typeof slack.ts !== 'string' || !/^\d{10,16}\.\d{6}$/.test(slack.ts))) throw new Error('Invalid notification');
      await processJob(jobId, context, mode, pageId, requestHash, slack ? {channel:slack.channel,ts:slack.ts} : undefined);
    } catch {
      failures.push(...records.slice(index).map(item => ({ itemIdentifier: item.messageId })));
      break;
    }
  }
  return { batchItemFailures:failures };
}
