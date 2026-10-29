const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createCredentialStore}=require('../lib/credentials.cjs');
const {createTranscriptionService}=require('../lib/transcription.cjs');
const {transcribeWithOpenAI}=require('../lib/audio-engines.cjs');
const jid='5511998765432@s.whatsapp.net';
async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-transcription-test-'));
  let credentials;
  t.after(async()=>{await credentials?.close();assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^wa-transcription-test-/);await fs.rm(directory,{recursive:true,force:true});});
  const store=createStore(directory),calls=[];
  credentials=createCredentialStore(directory);
  const service=createTranscriptionService({store,credentials,mediaLoader:async(...args)=>{calls.push(args);return {base64:'aGVsbG8=',mimetype:'audio/ogg; codecs=opus'};},whisperEngine:async()=>({text:'Olá, tudo bem?'}),aiEngine:async()=>({text:'IA'}),...options});
  return {directory,store,calls,service};
}
test('Whisper local é padrão; pedidos concorrentes duplicados usam uma transcrição e cache persistente',async t=>{
  let local=0,cloud=0;
  const {directory,calls,service}=await fixture(t,{whisperEngine:async({settings})=>{local++;assert.equal(settings.whisperModel,'base');assert.equal(settings.language,'pt');return {text:'Olá, tudo bem?'};},aiEngine:async()=>{cloud++;}});
  assert.equal((await service.settings()).defaultProvider,'whisper');
  const [a,b]=await Promise.all([service.enqueue({jid,messageId:'audio-1'}),service.enqueue({jid,messageId:'audio-1'})]);
  assert.equal(a.id,b.id);await service.idle();assert.equal(local,1);assert.equal(cloud,0);assert.equal(calls.length,1);
  const restarted=createTranscriptionService({store:createStore(directory),mediaLoader:async()=>{throw Error('não deve baixar');},whisperEngine:async()=>{throw Error('não deve transcrever');}});
  const cached=await restarted.enqueue({jid,messageId:'audio-1'});assert.equal(cached.status,'completed');assert.equal(cached.text,'Olá, tudo bem?');
  assert.equal((await restarted.list(jid)).length,1);
});
test('fila limita execução a um áudio e isola resultados por conversa',async t=>{
  let release,started;const startedPromise=new Promise(r=>started=r),gate=new Promise(r=>release=r);let running=0,maximum=0;
  const {service}=await fixture(t,{whisperEngine:async()=>{running++;maximum=Math.max(maximum,running);started();await gate;running--;return {text:'Texto'};}});
  await service.enqueue({jid,messageId:'first'});await startedPromise;
  await service.enqueue({jid:'5521998765432@s.whatsapp.net',messageId:'second'});
  assert.equal((await service.list(jid))[0].status,'running');release();await service.idle();assert.equal(maximum,1);
  assert.deepEqual((await service.list(jid)).map(j=>j.messageId),['first']);
});
test('IA exige configuração explícita, não expõe chave e usa o provedor escolhido',async t=>{
  let local=0,cloud=0;
  const {service,store}=await fixture(t,{whisperEngine:async()=>{local++;return {text:'Local'};},aiEngine:async({settings})=>{cloud++;assert.equal(settings.aiApiKey,'sk-chave-privada-teste');return {text:'Texto via IA'};}});
  await assert.rejects(service.enqueue({jid,messageId:'audio-ai',provider:'ai'}),/Configure.*chave/i);
  const settings=await service.saveSettings({aiApiKey:'sk-chave-privada-teste',whisperModel:'small',language:'auto'});
  assert.equal(settings.aiConfigured,true);assert.doesNotMatch(JSON.stringify(settings),/chave-privada/);
  await service.enqueue({jid,messageId:'audio-ai',provider:'ai'});await service.idle();assert.equal(cloud,1);assert.equal(local,0);
  assert.doesNotMatch(JSON.stringify(await service.list(jid)),/chave-privada/);
  assert.equal((await store.read()).settings.transcription,undefined);
  assert.equal((await service.saveSettings({removeAiKey:true})).aiConfigured,false);
});
test('falhas não disparam fallback nem repetição sem pedido explícito; erros internos não vazam',async t=>{
  let local=0,cloud=0;
  const {service}=await fixture(t,{whisperEngine:async()=>{local++;if(local===1) throw Error('sk-chave-secreta /caminho/privado');return {text:'Recuperado'};},aiEngine:async()=>{cloud++;}});
  await service.enqueue({jid,messageId:'falha'});await service.idle();
  const failed=(await service.list(jid))[0];assert.equal(failed.status,'failed');assert.doesNotMatch(failed.error,/secreta|privado/);
  await service.enqueue({jid,messageId:'falha'});await service.idle();assert.equal(local,1);assert.equal(cloud,0);
  await service.enqueue({jid,messageId:'falha',retry:true});await service.idle();assert.equal(local,2);assert.equal((await service.list(jid))[0].text,'Recuperado');
});
test('valida identificadores, modelos, provedor, tipo e tamanho antes de chamar motores',async t=>{
  const {service}=await fixture(t);
  for(const input of [{jid:'123@g.us',messageId:'x'},{jid,messageId:'../audio'},{jid,messageId:'x',provider:'outro'}]) await assert.rejects(service.enqueue(input),{status:422});
  await assert.rejects(service.saveSettings({whisperModel:'../../script'}),{status:422});
  await assert.rejects(service.saveSettings({language:'pt; comando'}),{status:422});
  await assert.rejects(service.saveSettings({defaultProvider:'ai'}),{status:422});
  const bad=await fixture(t,{mediaLoader:async()=>({base64:'aGVsbG8=',mimetype:'text/plain'}),whisperEngine:async()=>{assert.fail('arquivo não é áudio');}});
  await bad.service.enqueue({jid,messageId:'not-audio'});await bad.service.idle();assert.match((await bad.service.list(jid))[0].error,/áudio/);
  const oversized=await fixture(t,{mediaLoader:async()=>({base64:Buffer.alloc(10*1024*1024+1).toString('base64'),mimetype:'audio/ogg'})});
  await oversized.service.enqueue({jid,messageId:'large'});await oversized.service.idle();assert.match((await oversized.service.list(jid))[0].error,/10 MB/);
});
test('reinício marca pendências interrompidas e não reenvia áudio para IA',async t=>{
  const {store,directory}=await fixture(t);
  await store.update(data=>{data.transcriptions={old:{id:'old',jid,messageId:'pending',provider:'ai',status:'running',createdAt:Date.now(),updatedAt:Date.now()}};});
  const restarted=createTranscriptionService({store:createStore(directory),mediaLoader:()=>assert.fail('não baixar'),aiEngine:()=>assert.fail('não reenviar')});
  const jobs=await restarted.list(jid);assert.equal(jobs[0].status,'failed');assert.match(jobs[0].error,/interrompida/);
});
test('multipart OpenAI usa endpoint oficial, WAV, modelo atual e retorna apenas texto',async()=>{
  const result=await transcribeWithOpenAI({audio:Buffer.from('wav'),settings:{aiApiKey:'sk-segredo',language:'pt'}},async(url,options)=>{
    assert.equal(String(url),'https://api.openai.com/v1/audio/transcriptions');assert.equal(options.headers.Authorization,'Bearer sk-segredo');
    assert.equal(options.body.get('model'),'gpt-transcribe');assert.equal(options.body.get('file').type,'audio/wav');assert.match(options.body.get('file').name,/\.wav$/);
    assert.equal(options.body.get('response_format'),'json');
    return new Response(JSON.stringify({text:'Reconhecido',other:'ignorado'}));
  });assert.deepEqual(result,{text:'Reconhecido'});
  await assert.rejects(transcribeWithOpenAI({audio:Buffer.from('x'),settings:{aiApiKey:'sk-SECRET'}},async()=>new Response('sk-SECRET upstream',{status:401})),error=>error.status===422 && !error.message.includes('SECRET'));
});
