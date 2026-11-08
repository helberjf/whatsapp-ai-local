const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {externalizeMedia,hydrateMedia}=require('../lib/persisted-media.cjs');

const limit=10*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const media=(type='audio',bytes=Buffer.from('mídia'))=>({type,mimeType:type==='document'?'application/pdf':type+'/test',fileName:'anexo.bin',caption:'Legenda preservada',base64:bytes.toString('base64')});
const state=messages=>({triggers:{settings:{rules:[{id:'rule',messages}]}}});
const messages=data=>data.triggers.settings.rules[0].messages;
async function directory(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-persisted-media-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('whatsapp-persisted-media-'));await fs.rm(root,{recursive:true,force:true});});return root;
}

test('externalizes only known trigger attachments and restores bytes and metadata',async t=>{
  const root=await directory(t),data=state(['audio','image','video','document'].map((type,index)=>media(type,Buffer.from('mídia '+index))));
  data.credentials={base64:'SEGREDO'};data.triggers.executions=[{base64:'SEGREDO'}];messages(data).push({type:'text',text:'Olá',base64:'SEGREDO'},{type:'poll',name:'Escolha',base64:'SEGREDO'});
  const original=structuredClone(data);await externalizeMedia(data,root);
  for(let index=0;index<4;index++) {const message=messages(data)[index],bytes=Buffer.from(messages(original)[index].base64,'base64');assert.equal(message.base64,undefined);assert.equal(message.mediaRef,'sha256:'+hash(bytes));assert.deepEqual(await fs.readFile(path.join(root,'trigger-media',hash(bytes))),bytes);assert.deepEqual({...message,base64:undefined,mediaRef:undefined},{...messages(original)[index],base64:undefined,mediaRef:undefined});}
  assert.equal(data.credentials.base64,'SEGREDO');assert.equal(messages(data)[4].base64,'SEGREDO');assert.equal(data.triggers.executions[0].base64,'SEGREDO');
  await hydrateMedia(data,root);assert.deepEqual(data,original);
});

test('both operations are idempotent and duplicate bytes reuse an immutable file',async t=>{
  const root=await directory(t),data=state([media(),media('image')]),original=structuredClone(data);
  await externalizeMedia(data,root);const saved=structuredClone(data),file=path.join(root,'trigger-media',messages(data)[0].mediaRef.slice(7)),stat=await fs.stat(file);
  await externalizeMedia(data,root);assert.deepEqual(data,saved);assert.deepEqual(await fs.readdir(path.join(root,'trigger-media')),[path.basename(file)]);assert.equal((await fs.stat(file)).mtimeMs,stat.mtimeMs);
  if(process.platform!=='win32') assert.equal(stat.mode & 0o777,0o600);
  await hydrateMedia(data,root);await hydrateMedia(data,root);assert.deepEqual(data,original);assert.deepEqual(await fs.readFile(file),Buffer.from('mídia'));
});

test('missing trigger structure and unrelated base64 values never create files',async t=>{
  const root=await directory(t);
  for(const data of [{},null,{base64:'SEGREDO'},{triggers:{settings:{rules:[{messages:[{type:'text',base64:'SEGREDO'}]},{messages:{base64:'SEGREDO'}}]}}}]) {await externalizeMedia(data,root);await hydrateMedia(data,root);}
  assert.deepEqual(await fs.readdir(root),[]);
});

test('rejects malformed and noncanonical base64 without changing state or writing files',async t=>{
  const root=await directory(t);
  for(const base64 of ['',null,42,'not base64','aGk','aGk=\n','data:audio/ogg;base64,aGk=','Zh==','====']) {const data=state([media(),{...media(),base64}]),original=structuredClone(data);await assert.rejects(externalizeMedia(data,root),/base64/i);assert.deepEqual(data,original);}
  assert.deepEqual(await fs.readdir(root),[]);
});

test('accepts exactly 10 MiB and rejects individual or aggregate media over the limit',async t=>{
  const root=await directory(t),bytes=Buffer.alloc(limit,7),data=state([media('video',bytes)]);await externalizeMedia(data,root);await hydrateMedia(data,root);assert.equal(Buffer.byteLength(messages(data)[0].base64,'base64'),limit);
  for(const oversized of [[media('video',Buffer.alloc(limit+1))],[media('audio',Buffer.alloc(limit/2+1)),media('image',Buffer.alloc(limit/2))]]) {const next=state(oversized),original=structuredClone(next);await assert.rejects(externalizeMedia(next,root),/10 MB/);assert.deepEqual(next,original);}
});

test('validates reference syntax before accessing files',async t=>{
  const root=await directory(t);
  for(const mediaRef of ['../secret','sha256:../../secret','sha256:'+'A'.repeat(64),'sha256:'+'a'.repeat(63),'sha256:'+'a'.repeat(64)+'/secret',null,42]) {
    const data=state([{type:'document',mediaRef}]),original=structuredClone(data);await assert.rejects(hydrateMedia(data,root),/referência/i);assert.deepEqual(data,original);await assert.rejects(externalizeMedia(data,root),/referência/i);
  }
});

test('missing and corrupted referenced files are rejected without partially hydrating data',async t=>{
  const root=await directory(t),data=state([media(),media('image',Buffer.from('outra'))]);await externalizeMedia(data,root);const saved=structuredClone(data),file=path.join(root,'trigger-media',messages(data)[1].mediaRef.slice(7));
  await fs.writeFile(file,'corrompida');await assert.rejects(hydrateMedia(data,root),/integridade/i);assert.deepEqual(data,saved);await assert.rejects(externalizeMedia(data,root),/integridade/i);
  const missing=state([{type:'audio',mediaRef:'sha256:'+'0'.repeat(64)}]);await assert.rejects(hydrateMedia(missing,root),/não encontrado/i);await assert.rejects(externalizeMedia(missing,root),/não encontrado/i);
});

test('an existing corrupt blob is never overwritten by externalization',async t=>{
  const root=await directory(t),data=state([media()]),digest=hash(Buffer.from('mídia'));await fs.mkdir(path.join(root,'trigger-media'));const file=path.join(root,'trigger-media',digest);await fs.writeFile(file,'bad');
  await assert.rejects(externalizeMedia(data,root),/integridade/i);assert.equal(await fs.readFile(file,'utf8'),'bad');assert.ok(messages(data)[0].base64);assert.equal(messages(data)[0].mediaRef,undefined);
});

test('oversized referenced files and ambiguous base64 plus reference are rejected',async t=>{
  const root=await directory(t),bytes=Buffer.alloc(limit+1),digest=hash(bytes);await fs.mkdir(path.join(root,'trigger-media'));await fs.writeFile(path.join(root,'trigger-media',digest),bytes);
  await assert.rejects(hydrateMedia(state([{type:'video',mediaRef:'sha256:'+digest}]),root),/10 MB/);
  const ambiguous=state([{...media(),mediaRef:'sha256:'+hash(Buffer.from('mídia'))}]);await assert.rejects(externalizeMedia(ambiguous,root),/base64.*referência|referência.*base64/i);await assert.rejects(hydrateMedia(ambiguous,root),/base64.*referência|referência.*base64/i);
});

test('concurrent externalizations of identical bytes share the same verified blob',async t=>{
  const root=await directory(t),copies=Array.from({length:4},()=>state([media('video',Buffer.alloc(1024*1024,3))]));await Promise.all(copies.map(data=>externalizeMedia(data,root)));
  assert.equal(new Set(copies.map(data=>messages(data)[0].mediaRef)).size,1);assert.equal((await fs.readdir(path.join(root,'trigger-media'))).length,1);await Promise.all(copies.map(data=>hydrateMedia(data,root)));assert.ok(copies.every(data=>messages(data)[0].base64));
});

test('an interrupted write never publishes a partial blob and can be retried',async t=>{
  const root=await directory(t),data=state([media()]),original=structuredClone(data),open=fs.open.bind(fs);let fail=true;
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await open(...args);if(args[1]!=='wx' || !fail) return handle;fail=false;
    return {async writeFile(bytes) {await handle.writeFile(bytes.subarray(0,1));throw Object.assign(new Error('injected EIO'),{code:'EIO'});},sync:()=>handle.sync(),close:()=>handle.close()};
  });
  await assert.rejects(externalizeMedia(data,root),/injected EIO/);assert.deepEqual(data,original);
  const final=path.join(root,'trigger-media',hash(Buffer.from('mídia')));await assert.rejects(fs.stat(final),error=>error.code==='ENOENT');
  await externalizeMedia(data,root);await hydrateMedia(data,root);assert.deepEqual(data,original);assert.deepEqual(await fs.readdir(path.join(root,'trigger-media')),[path.basename(final)]);
});
