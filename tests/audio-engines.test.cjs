const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createAudioEngines}=require('../lib/audio-engines.cjs');
async function temp(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-engine-test-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^wa-engine-test-/);await fs.rm(directory,{recursive:true,force:true});});return directory;
}
test('normaliza OGG por processos sem shell, transcreve UTF-8 e remove arquivos temporários',async t=>{
  const directory=await temp(t),calls=[];
  const engines=createAudioEngines({temporaryRoot:directory,runFile:async(executable,args,options)=>{
    calls.push({executable,args,options});assert.equal(options.windowsHide,true);assert.notEqual(options.shell,true);
    if(calls.length===1) {assert.equal(args.includes('-nostdin'),true);await fs.writeFile(args.at(-1),Buffer.alloc(200));}
    else {assert.equal(args[args.indexOf('--model')+1],'base');await fs.writeFile(args[args.indexOf('--output')+1],JSON.stringify({text:'Transcrição em português.'}));}
  }});
  const result=await engines.whisperEngine({bytes:Buffer.from('ogg'),settings:{whisperModel:'base',language:'pt'}});assert.equal(result.text,'Transcrição em português.');assert.equal(calls.length,2);assert.deepEqual(await fs.readdir(directory),[]);
});
test('falhas de decodificação e modelo não instalado deixam erro útil e limpam áudio',async t=>{
  const directory=await temp(t);
  const broken=createAudioEngines({temporaryRoot:directory,runFile:async()=>{throw Error('conteúdo privado do ffmpeg');}});
  await assert.rejects(broken.whisperEngine({bytes:Buffer.from('x'),settings:{whisperModel:'base',language:'pt'}}),error=>error.status===422 && /decodificar/.test(error.message) && !/privado/.test(error.message));assert.deepEqual(await fs.readdir(directory),[]);
  let count=0;
  const noModel=createAudioEngines({temporaryRoot:directory,runFile:async(exe,args)=>{
    if(++count===1) await fs.writeFile(args.at(-1),Buffer.alloc(100));
    else {await fs.writeFile(args[args.indexOf('--output')+1],JSON.stringify({error:'missing_model'}));throw Error('exit 1');}
  }});
  await assert.rejects(noModel.whisperEngine({bytes:Buffer.from('x'),settings:{whisperModel:'small',language:'pt'}}),/modelo Whisper small não está instalado/);assert.deepEqual(await fs.readdir(directory),[]);
});
test('áudio longo não é enviado para IA nem truncado silenciosamente',async t=>{
  const directory=await temp(t),engines=createAudioEngines({temporaryRoot:directory,runFile:async(exe,args)=>fs.writeFile(args.at(-1),Buffer.alloc(601*32000)),fetchImpl:()=>assert.fail('não enviar áudio longo')});
  await assert.rejects(engines.aiEngine({bytes:Buffer.from('x'),settings:{aiApiKey:'sk-privado',language:'pt'}}),/10 minutos/);assert.deepEqual(await fs.readdir(directory),[]);
});
