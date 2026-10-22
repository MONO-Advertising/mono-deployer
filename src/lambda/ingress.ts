import { createHash, timingSafeEqual } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { db, table, getJob, readSecret, requirePatchedNode, terminalStatuses } from './common';

const sqs = new SQSClient({});
const hash = (value: string) => createHash('sha256').update(value).digest();
const reply = (statusCode: number, body: object) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
export async function handler(event: APIGatewayProxyEventV2) {
  try {
    requirePatchedNode();
    const provided = event.headers?.['x-deployment-key'];
    if (!provided) return reply(401, { error: 'Unauthorized' });
    const expected = await readSecret(process.env.INGRESS_SECRET_ARN!);
    if (!timingSafeEqual(hash(provided), hash(expected))) return reply(401, { error: 'Unauthorized' });
    if (event.requestContext.http.method === 'GET') {
      const id = event.pathParameters?.jobId || '';
      if (!/^[a-f0-9]{64}$/.test(id)) return reply(400, { error: 'Invalid job ID' });
      const job = await getJob(id);
      return job ? reply(200, { jobId: id, status: job.status, updatedAt: job.updatedAt, vercelJobId: job.vercelJobId }) : reply(404, { error: 'Job not found' });
    }
    if (event.requestContext.http.method !== 'POST' || event.rawPath !== '/api/deploy') return reply(404, { error: 'Not found' });
    if (process.env.PUBLISH_ENABLED !== 'true') return reply(503, { error: 'Publishing is paused' });
    const key = event.headers?.['idempotency-key'];
    if (!key || key.length < 16 || key.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(key)) return reply(400, { error: 'A valid Idempotency-Key is required' });
    let payload: { mode?: string; pageId?: string } = {};
    if (event.body) {
      if (event.isBase64Encoded || event.body.length > 4096) return reply(400, { error: 'Invalid payload' });
      try { payload = JSON.parse(event.body); } catch { return reply(400, { error: 'Invalid JSON' }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(400, { error: 'Invalid payload' });
    }
    const mode = payload.mode === undefined ? 'deploy' : payload.mode;
    const pageId = payload.pageId;
    if (!['sync','deploy'].includes(mode) || (pageId !== undefined && (typeof pageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(pageId)))) return reply(400, { error: 'Invalid publishing request' });
    const requestHash = hash(JSON.stringify({ mode, pageId })).toString('hex');
    const jobId = hash(key).toString('hex');
    const existing = await getJob(jobId);
    if (existing?.requestHash && existing.requestHash !== requestHash) return reply(409, { error: 'Idempotency key already used for a different request' });
    if (existing && terminalStatuses.has(existing.status)) return reply(409, { error: 'Job already processed; check its status', jobId, status: existing.status });
    if (!existing) {
      // Acceptance is based on durable queue delivery, never a database record alone.
      await sqs.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL!, MessageBody: JSON.stringify({ jobId, mode, pageId, requestHash }), MessageGroupId: 'production', MessageDeduplicationId: jobId }));
      const now = Math.floor(Date.now() / 1000);
      try {
        await db.send(new PutCommand({ TableName: table, Item: { jobId, requestHash, status: 'queued', updatedAt: now, expiresAt: now + 30 * 86400 }, ConditionExpression: 'attribute_not_exists(jobId)' }));
      } catch (e) {
        if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
        const winner = await getJob(jobId);
        if (winner?.requestHash !== requestHash) return reply(409, { error: 'Idempotency key already used for a different request' });
      }
    }
    return reply(202, { jobId, status: 'queued' });
  } catch {
    console.error('Ingress request failed');
    return reply(503, { error: 'Publishing service unavailable' });
  }
}
