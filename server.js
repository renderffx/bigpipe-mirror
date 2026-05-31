import http from 'node:http';
import BigPipeEngine from './BigPipeEngine.js';
import Pagelet, { PRIORITY } from './Pagelet.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BigPipe Demo</title>
<style>
body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px}
.box{background:#f5f5f5;border-radius:8px;padding:16px;margin-bottom:12px;min-height:60px}
.box.loading{background:linear-gradient(90deg,#eee 25%,#fafafa 50%,#eee 75%);background-size:200% 100%;animation:s 1.2s ease-in-out infinite}
@keyframes s{0%{background-position:200% 0}to{background-position:-200% 0}}
h2{margin:0 0 8px;font-size:1rem}
p{margin:0;color:#555;font-size:.9rem}
.tag{font-size:.7rem;color:#999;display:inline-block;margin-bottom:8px}
</style>
</head>
<body>
<h1>BigPipe Streaming</h1>
<p style="color:#666;margin-bottom:24px">Pagelets stream out of order &mdash; watch them arrive.</p>
<div id="fast" class="box loading"></div>
<div id="slow" class="box loading"></div>
<div id="medium" class="box loading"></div>
`;

const FOOTER = `</body>\n</html>\n`;

async function fetchFast() {
  await delay(300);
  return { html: '<h2>Fast pagelet (300ms)</h2><p>This arrived first even though it was sent last.</p>' };
}

async function fetchMedium() {
  await delay(1500);
  return { html: '<h2>Medium pagelet (1500ms)</h2><p>This arrived second.</p>' };
}

async function fetchSlow() {
  await delay(3000);
  return { html: '<h2>Slow pagelet (3000ms)</h2><p>This arrived last even though it was sent first.</p>' };
}

const server = http.createServer((req, res) => {
  if (req.url !== '/' || req.method !== 'GET') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const engine = new BigPipeEngine(res);
  engine.on('error', err => console.error(err.message));

  engine.sendHead(SHELL);

  let remaining = 3;
  const t0 = Date.now();

  const onDone = name => {
    remaining--;
    console.log(`[+${Date.now() - t0}ms] \u2714 ${name}`);
    if (remaining === 0) engine.close(FOOTER);
  };

  const onErr = err => {
    console.error(err.message);
    if (!res.destroyed) engine.close();
  };

  fetchSlow().then(({ html }) => {
    console.log(`[+${Date.now() - t0}ms] \u25B6 sending slow`);
    engine.sendPagelet(new Pagelet({ id: 'slow', html }));
    engine.flush();
    onDone('slow');
  }).catch(onErr);

  fetchMedium().then(({ html }) => {
    console.log(`[+${Date.now() - t0}ms] \u25B6 sending medium`);
    engine.sendPagelet(new Pagelet({ id: 'medium', html }));
    engine.flush();
    onDone('medium');
  }).catch(onErr);

  fetchFast().then(({ html }) => {
    console.log(`[+${Date.now() - t0}ms] \u25B6 sending fast`);
    engine.sendPagelet(new Pagelet({ id: 'fast', html }));
    engine.flush();
    onDone('fast');
  }).catch(onErr);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BigPipe demo: http://localhost:${PORT}/`);
  console.log(`Order: fast(300ms) -> medium(1500ms) -> slow(3000ms)`);
  console.log(`Slow is sent FIRST but arrives LAST (out of order).\n`);
});
