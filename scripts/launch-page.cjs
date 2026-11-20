const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');

const css = `
  :root { color-scheme: dark; font: 16px "Segoe UI", system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(ellipse at 50% 0%, #17362c, #0b1413 60%); color: #f2f8f5; }
  main { width: min(400px, 100%); padding: clamp(24px, 7vw, 36px); border: 1px solid #304840;
    border-radius: 22px; background: #13221e; box-shadow: 0 18px 60px #060e0c80; }
  img { display: block; width: 62px; height: 62px; }
  h1 { margin: 18px 0 0; font-size: 28px; line-height: 1.2; letter-spacing: -.03em; }
  .track { height: 5px; margin-top: 26px; overflow: hidden; border-radius: 999px; background: #2b4038; }
  .track span { display: block; height: 100%; width: 12%; border-radius: inherit;
    background: #40df98; transition: width .35s ease; }
  [data-step="1"] .track span { width: 24%; }
  [data-step="2"] .track span { width: 45%; }
  [data-step="3"] .track span { width: 66%; }
  [data-step="4"] .track span { width: 90%; }
  [data-state="failed"] .track { display: none; }
  p { margin: 12px 0 0; color: #bcd0c7; font-size: 14px; line-height: 1.5; }
  @media (prefers-reduced-motion: reduce) { .track span { transition: none; } }
`;

const clientScript = `
  async function poll() {
    try {
      const response = await fetch(location.pathname + '/status', {cache: 'no-store'});
      if (!response.ok) throw Error('Status indisponível');
      const progress = await response.json();
      if (progress.ready) { location.replace(location.pathname); return; }
      const card = document.querySelector('main');
      card.dataset.step = progress.step;
      document.querySelector('#status').textContent = progress.status;
      if (progress.failed) {
        card.dataset.state = 'failed';
        document.querySelector('h1').textContent = 'Não foi possível iniciar';
        return;
      }
    } catch {}
    setTimeout(poll, 800);
  }
  poll();
`;

async function startLaunchPage(projectRoot, targetUrl) {
  const token = randomBytes(16).toString('hex');
  const logo = await fs.readFile(path.join(projectRoot, 'public/icons/whats-ai.svg'));
  const pagePath = '/' + token;
  const assets = new Map([
    [pagePath + '/style', ['text/css', css]],
    [pagePath + '/logo', ['image/svg+xml', logo]],
    [pagePath + '/poll', ['text/javascript', clientScript]],
  ]);
  let ready = false;
  let failed = false;
  let progress = {step:0,status:'Preparando configurações…'};
  let finishTimeout;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.headers.host !== '127.0.0.1:' + server.address().port ||
        req.method !== 'GET') {
      res.writeHead(404);
      return res.end();
    }
    if (req.url === pagePath + '/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({...progress,ready,failed}));
    }
    const asset = assets.get(req.url);
    if (asset) {
      res.setHeader('Content-Type', asset[0]);
      return res.end(asset[1]);
    }
    if (req.url !== pagePath) {
      res.writeHead(404);
      return res.end();
    }
    if (ready) {
      res.writeHead(302, {Location: targetUrl});
      res.once('finish', () => server.close());
      return res.end();
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const title = failed ? 'Não foi possível iniciar' : 'Abrindo Whats AI…';
    const description = failed
      ? 'Confira o aviso do iniciador ou abra o atalho para tentar de novo.'
      : 'Preparando configurações…';
    res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Whats AI</title><link rel="icon" href="${pagePath}/logo">
      <link rel="stylesheet" href="${pagePath}/style">
      ${failed ? '' : `<script defer src="${pagePath}/poll"></script>`}</head>
      <body><main data-state="${failed?'failed':'loading'}">
      <img src="${pagePath}/logo" alt=""><h1>${title}</h1>
      <div class="track" aria-hidden="true"><span></span></div>
      <p id="status" role="status">${description}</p></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const expiry = setTimeout(() => server.close(), 10 * 60_000);
  expiry.unref();
  server.once('close', () => {clearTimeout(expiry);clearTimeout(finishTimeout);});
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/' + token,
    update(event) { progress = event; },
    ready() {
      ready = true;
      finishTimeout ??= setTimeout(() => server.close(), 30_000);
    },
    fail() {
      failed = true;
      // Dá ao navegador tempo de exibir o erro e libera o iniciador para avisar no Windows.
      progress = {step:0,status:'Confira o aviso do iniciador ou abra o atalho para tentar de novo.'};
      finishTimeout ??= setTimeout(() => server.close(), 2000);
    },
    close() { server.close(); }
  };
}

module.exports = {startLaunchPage};
