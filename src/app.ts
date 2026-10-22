import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

export function createApp(deployKey: string, deploy: () => Promise<void>) {
  if (!deployKey) throw new Error('DEPLOYMENT_KEY must be set');
  const app = express();
  app.disable('x-powered-by');
  let running = false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  app.get('/', (_req, res) => { res.json({ status: 'ok' }); });
  // This endpoint takes no payload; do not parse/decompress caller bodies.
  app.post('/api/deploy', (req, res) => {
    const key = req.header('x-deployment-key');
    if (!key || !timingSafeEqual(digest(key), digest(deployKey))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (running) {
      res.status(409).json({ error: 'Deployment already running' });
      return;
    }
    running = true;
    void Promise.resolve().then(deploy).then(() => {
      console.log('Deployment completed');
    }).catch(() => {
      // Provider errors can contain credential-bearing URLs or headers.
      console.error('Deployment failed; downstream deployment was not completed');
    }).finally(() => { running = false; });
    res.status(202).json({ message: 'Deployment accepted' });
  });
  return app;
}
