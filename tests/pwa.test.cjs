const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file));
const text=file=>read(file).toString('utf8');
const pngSize=file=>{const value=read(file);assert.deepEqual([...value.subarray(0,8)],[137,80,78,71,13,10,26,10]);return [value.readUInt32BE(16),value.readUInt32BE(20)];};

test('identidade Whats AI tem fonte vetorial, PNGs PWA e ícone do Windows',()=>{
  const svg=text('public/icons/whats-ai.svg');
  assert.match(svg,/aria-label="Whats AI"/);
  assert.match(svg,/>AI</);
  assert.deepEqual(pngSize('public/icons/whats-ai-192.png'),[192,192]);
  assert.deepEqual(pngSize('public/icons/whats-ai-512.png'),[512,512]);
  assert.deepEqual(pngSize('public/icons/whats-ai-maskable-512.png'),[512,512]);
  const ico=read('public/icons/whats-ai.ico');
  assert.deepEqual([...ico.subarray(0,4)],[0,0,1,0]);
});

test('manifesto instala o Whats AI com ícones normal e maskable',()=>{
  const manifest=JSON.parse(text('public/manifest.webmanifest'));
  assert.equal(manifest.name,'Whats AI');
  assert.equal(manifest.short_name,'Whats AI');
  assert.equal(manifest.start_url,'/');
  assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');
  assert.ok(manifest.icons.some(icon=>icon.sizes==='192x192'));
  assert.ok(manifest.icons.some(icon=>icon.sizes==='512x512' && icon.purpose==='maskable'));
});

test('service worker nunca guarda API, saúde, conversas ou mídia',()=>{
  const worker=text('public/service-worker.js');
  assert.match(worker,/pathname\.startsWith\('\/api\/'\)/);
  assert.match(worker,/pathname==='\/health'/);
  assert.match(worker,/request\.mode==='navigate'/);
  assert.match(worker,/fetch\(request\)/);
  assert.doesNotMatch(worker,/cache\.put\(request/);
});

test('página publica metadados PWA e a nova marca',()=>{
  const html=text('public/index.html');
  assert.match(html,/<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html,/<meta name="theme-color" content="#102b25">/);
  assert.match(html,/<link rel="icon" href="\/icons\/whats-ai\.svg" type="image\/svg\+xml">/);
  assert.match(html,/<link rel="apple-touch-icon" href="\/icons\/whats-ai-192\.png">/);
  assert.match(html,/<script defer src="\/pwa\.js"><\/script>/);
  assert.match(html,/class="brand-logo"[^>]+src="\/icons\/whats-ai\.svg"/);
});
