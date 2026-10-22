import { createHash, createHmac } from 'node:crypto';
import { QueryCommand, UpdateCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { db, table, readSecret, requirePatchedNode } from './common';

type Job = Record<string, any>;
const finished = new Set(['synced', 'live', 'failed', 'hook_unknown', 'attention_required', 'validated']);
const tracking = new Set(['deployment_requested', 'building', 'ready']);
const publicFields = ['jobId', 'status', 'phase', 'createdAt', 'updatedAt', 'mode', 'deploymentId', 'deploymentUrl', 'assetTotal', 'assetCompleted', 'assetUploaded', 'assetSkipped', 'assetFailed', 'pageTotal', 'pageCompleted', 'missingAssetCount'];
const healthUrl = 'https://www.mono-1.com/';
const callbackHost = 'mono-deploy-bot.vercel.app';
const nowSeconds = () => Math.floor(Date.now() / 1000);
function snapshot(job: Job): Job {
  return Object.fromEntries(publicFields.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
}
function slackDestination(job: Job) {
  if (!job.slack) return undefined;
  if (!/^[CDG][A-Z0-9]{1,30}$/.test(job.slack.channel) || !/^\d{10,16}\.\d{6}$/.test(job.slack.ts)) throw new Error('Invalid notification destination');
  return { channel: job.slack.channel, ts: job.slack.ts };
}

export async function handler(_event: unknown, context?: Context) {
  requirePatchedNode();
  const deadline = Date.now() + Math.min(48_000, Math.max(1, (context?.getRemainingTimeInMillis() ?? 60_000) - 1000));
  const signal = (maximum: number) => AbortSignal.timeout(Math.max(1, Math.min(maximum, deadline - Date.now())));
  const send = (command: any) => db.send(command, { abortSignal: signal(5000) });
  const secretWithinDeadline = (arn: string): Promise<string> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Secret lookup timed out')), Math.max(1, Math.min(5000, deadline - Date.now())));
    readSecret(arn).then(value => { clearTimeout(timeout); resolve(value); }, () => { clearTimeout(timeout); reject(new Error('Secret lookup unavailable')); });
  });
  let token: string | undefined;
  let signingSecret: string | undefined;
  let processed = 0;
  const api = async (path: string) => {
    if (!token) {
      const secret = JSON.parse(await secretWithinDeadline(process.env.TRACKING_SECRET_ARN!));
      if (typeof secret.VERCEL_API_TOKEN !== 'string' || !secret.VERCEL_API_TOKEN) throw new Error('Tracking credential unavailable');
      token = secret.VERCEL_API_TOKEN;
    }
    if (!process.env.VERCEL_TEAM_ID || !process.env.VERCEL_PROJECT_ID) throw new Error('Tracking scope unavailable');
    const url = new URL(path, 'https://api.vercel.com');
    url.searchParams.set('teamId', process.env.VERCEL_TEAM_ID);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: signal(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Deployment tracking unavailable'); }
    return await response.json() as Job;
  };
  const servingDeployment = async (deploymentId: string) => {
    const project = await api('/v9/projects/' + encodeURIComponent(process.env.VERCEL_PROJECT_ID!));
    if (project.id !== process.env.VERCEL_PROJECT_ID) throw new Error('Project correlation mismatch');
    if (project.targets?.production?.id !== deploymentId) return false;
    const alias = await api('/v4/aliases/www.mono-1.com');
    return alias.alias === 'www.mono-1.com' && alias.projectId === process.env.VERCEL_PROJECT_ID &&
      alias.deploymentId === deploymentId && !alias.redirect && !alias.deletedAt;
  };
  const healthy = async () => {
    const response = await fetch(healthUrl, { headers: { 'cache-control': 'no-cache' }, redirect: 'error', signal: signal(10_000) });
    if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); return false; }
    const reader = response.body?.getReader();
    if (!reader) return false;
    let size = 0;
    let html = '';
    try {
      while (size < 65536) {
        const next = await reader.read();
        if (next.done) break;
        html += Buffer.from(next.value).toString('utf8');
        size += next.value.byteLength;
        if (/<(?:!doctype\s+html|html)(?:\s|>)/i.test(html)) return true;
      }
      return false;
    } finally { await reader.cancel(); }
  };
  const update = async (observed: Job, values: Job, remove: string[] = []) => {
    const names: Record<string, string> = { '#status': 'status', '#updated': 'updatedAt', '#monitor': 'monitorKey' };
    const vals: Record<string, any> = { ':oldStatus': observed.status, ':oldUpdated': observed.updatedAt, ':active': 'active' };
    const setters = Object.entries(values).map(([key, value], i) => { names[`#v${i}`] = key; vals[`:v${i}`] = value; return `#v${i} = :v${i}`; });
    const removers = remove.map((key, i) => { names[`#r${i}`] = key; return `#r${i}`; });
    await send(new UpdateCommand({
      TableName: table, Key: { jobId: observed.jobId },
      ConditionExpression: '#status = :oldStatus AND #updated = :oldUpdated AND #monitor = :active',
      UpdateExpression: [setters.length ? 'SET ' + setters.join(', ') : '', removers.length ? 'REMOVE ' + removers.join(', ') : ''].filter(Boolean).join(' '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    }));
  };
  const notify = async (body: string) => {
    const endpoint = new URL(process.env.BOT_STATUS_URL || '');
    if (endpoint.protocol !== 'https:' || endpoint.host !== callbackHost || endpoint.pathname !== '/internal/publishing-status' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid callback endpoint');
    signingSecret ??= await secretWithinDeadline(process.env.STATUS_SECRET_ARN!);
    if (signingSecret.length < 32) throw new Error('Notification signing secret unavailable');
    const timestamp = String(nowSeconds());
    const signature = createHmac('sha256', signingSecret).update(timestamp + '.').update(body).digest('hex');
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: signal(8000), body,
      headers: { 'content-type': 'application/json', 'x-publishing-timestamp': timestamp, 'x-publishing-signature': signature } });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Notification not accepted');
  };
  let cursor: Record<string, any> | undefined;
  for (let page = 0; page < 10 && Date.now() < deadline - 1000; page++) {
    const result = await send(new QueryCommand({ TableName: table, IndexName: 'MonitorIndex', KeyConditionExpression: '#monitor = :active', ExpressionAttributeNames: { '#monitor': 'monitorKey' }, ExpressionAttributeValues: { ':active': 'active' }, Limit: 25, ExclusiveStartKey: cursor })) as QueryCommandOutput;
    for (const observed of (result.Items || []) as Job[]) {
      if (Date.now() >= deadline - 1000) { console.error(JSON.stringify({ event: 'monitor_capacity_limit', processed })); return { processed }; }
      if (!/^[a-f0-9]{64}$/.test(observed.jobId) || typeof observed.status !== 'string' || !Number.isSafeInteger(observed.updatedAt)) continue;
      try {
        let next = { ...observed };
        if (!finished.has(observed.status)) {
          const started = Number.isSafeInteger(observed.createdAt) ? observed.createdAt : observed.updatedAt;
          if (nowSeconds() - started > 86400) {
            next = { ...next, status: 'attention_required', phase: 'tracking_expired' };
          } else if (tracking.has(observed.status) && /^dpl_[A-Za-z0-9]+$/.test(observed.deploymentId || '')) {
            try {
              const deployment = await api('/v13/deployments/' + encodeURIComponent(observed.deploymentId));
              if (deployment.id !== observed.deploymentId || deployment.projectId !== process.env.VERCEL_PROJECT_ID || deployment.meta?.publishingJobId !== observed.jobId || deployment.target !== 'production') throw new Error('Deployment correlation mismatch');
              const state = deployment.readyState || deployment.status;
              if (state === 'ERROR' || state === 'CANCELED') next = { ...next, status: 'failed', phase: state === 'ERROR' ? 'build_failed' : 'canceled' };
              else if (state === 'READY') {
                if (!await servingDeployment(observed.deploymentId)) next = { ...next, status: 'ready', phase: 'awaiting_promotion' };
                else if (!await healthy()) next = { ...next, status: 'ready', phase: 'health_check_pending' };
                // Recheck the production pointer and exact canonical alias after health.
                // This establishes an observed live state, not a permanent traffic guarantee.
                else if (await servingDeployment(observed.deploymentId)) next = { ...next, status: 'live', phase: 'live' };
                else next = { ...next, status: 'ready', phase: 'awaiting_promotion' };
              } else if (['QUEUED', 'INITIALIZING', 'BUILDING'].includes(state)) next = { ...next, status: 'building', phase: 'building' };
            } catch {
              // Transient API/health failures are not publishing failure or success.
              console.error(JSON.stringify({ event: 'tracking_unavailable', jobId: observed.jobId }));
            }
          }
        }
        const changed = next.status !== observed.status || next.phase !== observed.phase;
        if (changed) next.updatedAt = nowSeconds();
        const destination = slackDestination(next);
        const body = JSON.stringify({ ...destination, job: snapshot(next) });
        const hash = createHash('sha256').update(body).digest('hex');
        const terminal = finished.has(next.status);
        // Even unchanged snapshots must still match the observed worker state before delivery.
        await update(observed, { ...(changed ? { status: next.status, phase: next.phase, updatedAt: next.updatedAt } : {}), monitorCheckedAt: nowSeconds() }, !destination && terminal ? ['monitorKey'] : []);
        if (destination && hash !== observed.notificationHash) {
          if (Date.now() >= deadline - 1000) continue;
          await notify(body);
          await update(next, { notificationHash: hash }, terminal ? ['monitorKey'] : []);
        } else if (destination && terminal) {
          await update(next, { notificationHash: hash }, ['monitorKey']);
        }
        processed++;
      } catch (error) {
        console.error(JSON.stringify({ event: (error as Error).name === 'ConditionalCheckFailedException' ? 'monitor_stale_snapshot' : 'monitor_retry', jobId: observed.jobId }));
      }
    }
    cursor = result.LastEvaluatedKey;
    if (!cursor) break;
  }
  // Bounded scanning intentionally favors low-volume publishing; alert on this signal
  // before sustained backlog requires a durable scan cursor or partitioning.
  if (cursor) console.error(JSON.stringify({ event: 'monitor_capacity_limit', processed }));
  return { processed };
}
