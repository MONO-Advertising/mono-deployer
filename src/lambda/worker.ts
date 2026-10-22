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
  process.env.BUILDER_PRIVATE_KEY = values.BUILDER_PRIVATE_KEY;
  return values as { BUILDER_PRIVATE_KEY: string; VERCEL_DEPLOY_WEBHOOK: string };
}

async function processJob(jobId: string, context: Context, mode: 'sync' | 'deploy' = 'deploy', pageId?: string, requestHash?: string) {
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
    UpdateExpression: 'SET #s = :running, attempt = :attempt, leaseUntil = :lease, updatedAt = :now, expiresAt = :expires, requestHash = :requestHash',
    ConditionExpression: '(attribute_not_exists(requestHash) OR requestHash = :requestHash) AND (attribute_not_exists(jobId) OR #s = :queued OR #s = :retry OR (#s = :running AND leaseUntil < :now))',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':requestHash':requestHash, ':running':'running', ':queued':'queued', ':retry':'retry', ':attempt':attempt, ':lease': now + 930, ':now':now, ':expires':now+30*86400 } }));
  const update = async (values: Record<string, unknown>) => {
    const keys = Object.keys(values);
    const names: Record<string,string> = {};
    const vals: Record<string,unknown> = { ':attempt':attempt };
    for (const [i,key] of keys.entries()) { names[`#k${i}`]=key; vals[`:v${i}`]=values[key]; }
    await db.send(new UpdateCommand({ TableName:table, Key:{jobId}, ConditionExpression:'attempt = :attempt', UpdateExpression:'SET '+keys.map((_,i)=>`#k${i} = :v${i}`).join(', '), ExpressionAttributeNames:names, ExpressionAttributeValues:vals }));
  };
  let dispatching = false;
  try {
    const secrets = await publishingSecrets();
    // Import after injecting secrets; the legacy exporters validate env at module init.
    const { pushAssets } = await import('../lib/assets');
    const { pushToEnvironment } = await import('../lib/push-to-env');
    let paths = prior?.paths as string[] | undefined;
    if (!paths) {
      const assets = await pushAssets();
      if (assets.failed.length) throw new Error('Asset export failed');
      ({ paths } = await pushToEnvironment(pageId, { invalidate: false }));
      if (!paths.length) throw new Error('No published pages exported');
      await update({ paths, updatedAt: Math.floor(Date.now()/1000) });
    }
    let invalidationId = prior?.invalidationId as string | undefined;
    if (!invalidationId) {
      const response = await cf.send(new CreateInvalidationCommand({ DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID!, InvalidationBatch: { CallerReference: jobId, Paths: { Quantity: paths.length, Items: paths } } }));
      invalidationId = response.Invalidation?.Id;
      if (!invalidationId) throw new Error('Invalidation not created');
      await update({ invalidationId });
    }
    const remaining = Math.floor(context.getRemainingTimeInMillis()/1000)-45;
    if (remaining < 30) throw new Error('Insufficient time for invalidation');
    await waitUntilInvalidationCompleted({ client: cf, maxWaitTime: Math.min(remaining,300), minDelay: 10, maxDelay: 20 }, { DistributionId: process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID!, Id: invalidationId });
    if (mode === 'sync') {
      await update({ status:'synced', updatedAt:Math.floor(Date.now()/1000) });
      console.log(JSON.stringify({jobId,status:'synced'}));
      return;
    }
    // Record BEFORE dispatch: a timeout may mean Vercel accepted the request.
    await update({ status:'hook_dispatching', updatedAt:Math.floor(Date.now()/1000) });
    dispatching = true;
    const response = await fetch(secrets.VERCEL_DEPLOY_WEBHOOK, { method:'POST', redirect:'error', signal:AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Deploy hook did not confirm acceptance');
    const body = await response.json() as { job?: { id?: string } };
    if (!body.job?.id) throw new Error('Deploy hook response not confirmed');
    await update({ status:'deployment_requested', vercelJobId:body.job.id, updatedAt:Math.floor(Date.now()/1000) });
    console.log(JSON.stringify({ jobId, status:'deployment_requested', vercelJobId:body.job.id }));
  } catch {
    await update({ status:dispatching ? 'hook_unknown' : 'retry', updatedAt:Math.floor(Date.now()/1000) });
    console.error(JSON.stringify({ jobId, status:dispatching ? 'hook_unknown' : 'retry' }));
    if (!dispatching) throw new Error('Publishing failed before deploy hook');
  }
}

export async function handler(event: SQSEvent | { healthcheck: true } | { validate: true }, context: Context) {
  requirePatchedNode();
  if ('healthcheck' in event && event.healthcheck === true) {
    let secretsReady = false;
    try { await publishingSecrets(); secretsReady = true; } catch { /* report readiness only */ }
    return { runtime:process.versions.node, secretsReady, publishingEnabled:process.env.PUBLISH_ENABLED === 'true' };
  }
  if ('validate' in event && event.validate === true) {
    await publishingSecrets();
    const prefix = `builder/validation/${randomUUID()}`;
    process.env.S3_KEY_PREFIX = prefix;
    process.env.PUBLIC_ASSET_BASE_URL = `https://d1ttqs35fxgawv.cloudfront.net/${prefix}`;
    const start = Date.now();
    try {
      const { pushAssets } = await import('../lib/assets');
      const { pushToEnvironment } = await import('../lib/push-to-env');
      const assets = await pushAssets();
      if (assets.failed.length) return { runtime:process.versions.node, prefix, assetCount:assets.uploaded.length+assets.skipped.length+assets.failed.length, failedAssets:assets.failed.length, elapsedSeconds:(Date.now()-start)/1000 };
      const { paths } = await pushToEnvironment(undefined,{invalidate:false});
      return { runtime:process.versions.node, prefix, assetCount:assets.uploaded.length+assets.skipped.length, pageCount:paths.length, failedAssets:0, elapsedSeconds:(Date.now()-start)/1000 };
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
      const { jobId, mode = 'deploy', pageId, requestHash } = JSON.parse(record.body);
      if (!['sync','deploy'].includes(mode) || (pageId !== undefined && (typeof pageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pageId)))) throw new Error('Invalid job mode');
      if (!/^[a-f0-9]{64}$/.test(jobId)) throw new Error('Invalid job');
      await processJob(jobId, context, mode, pageId, requestHash);
    } catch {
      failures.push(...records.slice(index).map(item => ({ itemIdentifier: item.messageId })));
      break;
    }
  }
  return { batchItemFailures:failures };
}
