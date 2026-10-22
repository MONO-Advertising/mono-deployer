import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export const table = process.env.JOBS_TABLE!;
const secrets = new SecretsManagerClient({});
export async function readSecret(id: string): Promise<string> {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: id }));
  if (!result.SecretString) throw new Error('Secret is not configured');
  return result.SecretString;
}
export function requirePatchedNode(version = process.versions.node) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major !== 22 || minor < 23 || (minor === 23 && patch < 4)) {
    throw new Error('Patched Node 22 runtime required');
  }
}
export async function getJob(jobId: string) {
  return (await db.send(new GetCommand({ TableName: table, Key: { jobId }, ConsistentRead: true }))).Item;
}
export const terminalStatuses = new Set(['deployment_requested', 'hook_unknown', 'validated', 'synced']);
