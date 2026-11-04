const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createStore}=require('../lib/store.cjs');
const {createVoiceFlow}=require('../lib/voice-flow.cjs');
const {createAssistantService}=require('../lib/assistant.cjs');
const {createSpeechEngines,speakable,normalizeSpeech}=require('../lib/speech.cjs');

const jid='5511998765432@s.whatsapp.net';
const keyStore=()=>{const keys=new Map();return {keys,has:async name=>keys.has(name),get:async name=>keys.get(name) || null,set:async(name,value)=>{keys.set(name,value);},remove:async name=>{keys.delete(name);}};};

// Ambiente com relógio, conversa, transcrições e voz controlados. Nada sai deste processo.
async function setup(t,{speechFails=false}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-local-voice-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(dir),clock={t:Date.now()},credentials=keyStore();
  const env={store,clock,credentials,sent:[],voices:[],enqueued:[],jobs:new Map(),spoken:[],messages:[],chats:[{jid,name:'Ana',lastMessage:null}]};
  const client={
    chats:async()=>env.chats,messages:async()=>({messages:env.messages}),
    sendText:async(to,text)=>{env.sent.push({to,text});return {id:'txt-'+env.sent.length};},
    sendVoice:async(to,input)=>{env.voices.push({to,...input});return {id:'voz-'+env.voices.length};}
  };
  const transcriptions={
    enqueue:async input=>{env.enqueued.push(input);const job={id:'j'+env.enqueued.length,jid:input.jid,messageId:input.messageId,provider:input.provider,status:'queued',auto:input.auto,createdAt:clock.t,updatedAt:clock.t};env.jobs.set(input.messageId,job);return job;},
    results:async()=>new Map(env.jobs)
  };
  const speech={windowsAvailable:true,voices:async()=>[],synthesize:async({text,settings})=>{env.spoken.push({text,settings});if(speechFails) throw Object.assign(new Error('Sem voz'),{status:503});return {base64:Buffer.from('RIFF-voz').toString('base64'),mimeType:'audio/wav',provider:settings.provider};}};
  env.voice=createVoiceFlow({store,client,transcriptions,speech,credentials,now:()=>clock.t});
  env.client=client;env.transcriptions=transcriptions;
  env.add=(id,type,{fromMe=false,text=''}={})=>{clock.t+=1000;const message={id,jid,fromMe,type,text,timestamp:clock.t,key:{id,remoteJid:jid,fromMe}};env.messages.push(message);env.chats[0].lastMessage=message;return message;};
  env.complete=(id,text)=>{Object.assign(env.jobs.get(id),{status:'completed',text,updatedAt:clock.t});};
  return env;
}

test('transcrição automática só pega áudios recebidos depois de ligar, uma vez cada',async t=>{
  const env=await setup(t);
  env.add('antigo','audio');
  await env.voice.tick();assert.equal(env.enqueued.length,0,'desligada por padrão');
  await env.voice.save({autoTranscribe:true});
  await env.voice.tick();assert.equal(env.enqueued.length,0,'áudio anterior à ativação não entra');
  env.add('novo','audio');env.add('meu','audio',{fromMe:true});env.add('texto','text',{text:'Oi'});
  await env.voice.tick();await env.voice.tick();
  assert.deepEqual(env.enqueued.map(item=>[item.messageId,item.provider,item.auto]),[['novo','whisper',true]]);
  assert.equal((await env.voice.view()).log[0].action,'transcribe');
  await assert.rejects(env.voice.save({transcribeProvider:'ai'}),/chave da OpenAI/);
  assert.equal((await env.voice.save({transcribeProvider:'ai',openaiApiKey:'sk-teste-123456'})).openaiConfigured,true);
  assert.doesNotMatch(JSON.stringify(await store(env).read()),/sk-teste/);
  await assert.rejects(env.voice.save({replyFormat:'video'}),{status:422});
  await assert.rejects(env.voice.save({speech:{speed:5}}),{status:422});
});
const store=env=>env.store;

test('resposta no formato do cliente: áudio vira voz, texto continua texto, e a voz que falha vira texto com registro',async t=>{
  const env=await setup(t);
  await env.voice.save({replyFormat:'mirror',speech:{provider:'windows',speed:1.2}});
  const audio=env.add('a1','audio'),text=env.add('t1','text',{text:'Oi'});
  assert.equal((await env.voice.reply(jid,'Claro!',{last:audio,delay:900})).format,'audio');
  assert.deepEqual(env.voices.at(-1),{to:jid,base64:Buffer.from('RIFF-voz').toString('base64'),delay:900});
  assert.equal(env.spoken.at(-1).settings.speed,1.2);
  assert.equal((await env.voice.reply(jid,'Claro!',{last:text})).format,'text');
  assert.equal((await env.voice.transcripts(jid)).get('voz-1'),'Claro!','o texto falado fica disponível para a IA');
  const failing=await setup(t,{speechFails:true});await failing.voice.save({replyFormat:'audio'});
  const sent=await failing.voice.reply(jid,'Resposta',{last:failing.add('x','text',{text:'Oi'})});
  assert.equal(sent.format,'text');assert.equal(failing.sent.length,1);assert.equal(failing.voices.length,0);
  assert.equal((await failing.voice.view()).log[0].action,'fallback');
});

test('IA lê o áudio transcrito e responde em áudio; sem leitura ligada o áudio é ignorado',async t=>{
  const env=await setup(t),calls=[];
  await env.store.update(data=>{data.contacts[jid]={status:'open',labels:[],notes:[],aiMode:'auto',aiSince:new Date(env.clock.t-60_000).toISOString()};data.assistant={enabled:true,enabledSince:new Date(env.clock.t-60_000).toISOString(),audience:'classified'};});
  const ai={config:async()=>({configured:true}),complete:async options=>{calls.push(options);return 'Temos sim, qual tamanho?';}};
  const assistant=createAssistantService({store:env.store,client:env.client,ai,loadTexts:async()=>[],catalogText:async()=>'',now:()=>env.clock.t,voice:env.voice});
  assistant.start({poll:false});env.clock.t+=5000;
  env.add('pergunta','audio');env.jobs.set('pergunta',{messageId:'pergunta',status:'queued'});
  await env.voice.save({replyFormat:'mirror'});
  await assistant.tick();assert.equal(calls.length,0,'leitura de áudio desligada');
  await env.voice.save({aiReadsAudio:true});
  await assistant.tick();assert.equal(calls.length,0,'espera a transcrição terminar');
  env.complete('pergunta','Vocês têm camiseta azul?');
  await assistant.tick();
  assert.equal(calls.length,1);assert.match(calls[0].messages.at(-1).content,/\[áudio transcrito\] Vocês têm camiseta azul\?/);
  assert.equal(env.voices.length,1);assert.equal(env.sent.length,0);
  const log=(await env.store.read()).assistant.log[0];assert.equal(log.action,'sent');assert.equal(log.format,'audio');
  await assistant.tick();assert.equal(calls.length,1,'a mesma mensagem não é respondida duas vezes');
  assistant.stop();
});

test('voz: texto falável, limites e motores locais/nuvem controlados',async t=>{
  assert.equal(speakable('Veja https://exemplo.com/x 😀 **agora**'),'Veja link enviado na conversa agora');
  assert.throws(()=>speakable('😀'),{status:422});assert.throws(()=>speakable('a'.repeat(1501)),/1500/);
  assert.throws(()=>normalizeSpeech({provider:'eleven'}),{status:422});assert.throws(()=>normalizeSpeech({voice:'x"; rm'}),{status:422});
  const posted=[];
  const cloud=createSpeechEngines({platform:'linux',fetchImpl:async(url,options)=>{posted.push({url,body:JSON.parse(options.body),auth:options.headers.Authorization});return new Response(Buffer.alloc(200,1));}});
  const result=await cloud.synthesize({text:'Olá!',settings:{provider:'openai',openaiVoice:'coral',openaiModel:'gpt-4o-mini-tts',speed:1.1},apiKey:'sk-x'});
  assert.equal(result.mimeType,'audio/mpeg');assert.equal(posted[0].url,'https://api.openai.com/v1/audio/speech');
  assert.deepEqual({...posted[0].body,instructions:Boolean(posted[0].body.instructions)},{model:'gpt-4o-mini-tts',voice:'coral',input:'Olá!',response_format:'mp3',speed:1.1,instructions:true});
  assert.equal(posted[0].auth,'Bearer sk-x');
  await assert.rejects(cloud.synthesize({text:'Oi',settings:{provider:'openai'}}),/chave da OpenAI/);
  await assert.rejects(cloud.synthesize({text:'Oi',settings:{provider:'windows'}}),/Windows/);
  const temporaryRoot=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-voice-root-'));t.after(()=>fs.rm(temporaryRoot,{recursive:true,force:true}));
  const runs=[];
  const local=createSpeechEngines({platform:'win32',temporaryRoot,runFile:async(file,args)=>{runs.push(args);const output=args[args.indexOf('-Output')+1];assert.equal(await fs.readFile(args[args.indexOf('-TextFile')+1],'utf8'),'Bom dia');await fs.writeFile(output,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(100)]));return {stdout:''};}});
  const wav=await local.synthesize({text:'Bom dia',settings:{provider:'windows',voice:'Microsoft Maria',speed:1.5}});
  assert.equal(wav.mimeType,'audio/wav');assert.equal(runs[0][runs[0].indexOf('-Rate')+1],'5');assert.equal(runs[0][runs[0].indexOf('-Voice')+1],'Microsoft Maria');
  assert.deepEqual(await fs.readdir(temporaryRoot),[],'arquivos temporários removidos');
});
