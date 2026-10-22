const esbuild = require('esbuild');
esbuild.buildSync({ entryPoints:['src/lambda/ingress.ts','src/lambda/worker.ts'], bundle:true, platform:'node', target:'node22', format:'cjs', outdir:'build/lambda', sourcemap:false, minify:false });
