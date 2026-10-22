import 'dotenv/config';
import { createApp } from './app';
import { pushAssets } from './lib/assets';
import { pushToEnvironment } from './lib/push-to-env';

const webhook = process.env.VERCEL_DEPLOY_WEBHOOK;
if (webhook) {
  const url = new URL(webhook);
  if (url.origin !== 'https://api.vercel.com' || !url.pathname.startsWith('/v1/integrations/deploy/')) {
    throw new Error('VERCEL_DEPLOY_WEBHOOK must be a Vercel deploy hook');
  }
}

const app = createApp(process.env.DEPLOYMENT_KEY || '', async () => {
  const assets = await pushAssets();
  if (assets.failed.length) throw new Error('Asset upload failed');
  await pushToEnvironment();
  if (webhook) {
    const response = await fetch(webhook, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Vercel deploy hook failed');
  }
});
app.listen(process.env.PORT || 3000, () => { console.log('Deployer listening'); });
