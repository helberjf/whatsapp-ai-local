const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {runScript}=require('../scripts/launcher.cjs');

// Dependências simuladas: nenhum PowerShell nem git de verdade é executado.
function deps({present=true,status=0,error=null,gitFails=false}={}) {
  const calls={written:[],removed:[],spawned:[],logged:[]};
  return {calls,deps:{
    folder:'C:/central/scripts',exists:()=>present,
    gitShow:name=>{if(gitFails) throw new Error('fatal: path not in HEAD');return Buffer.from('\uFEFFWrite-Output "'+name+'"\r\n');},
    write:(file,text)=>calls.written.push({file,text}),remove:file=>calls.removed.push(file),
    spawn:(file,args)=>{calls.spawned.push({file,args});return error?{error}:{status};},log:text=>calls.logged.push(text)
  }};
}

test('script presente roda direto, com os argumentos, e devolve o código de saída',()=>{
  const {deps:d,calls}=deps({status:3});
  assert.equal(runScript('stop.ps1',['-NoBrowser'],d),3);
  assert.deepEqual(calls.spawned,[{file:path.join('C:/central/scripts','stop.ps1'),args:['-NoBrowser']}]);
  assert.deepEqual([calls.written.length,calls.removed.length],[0,0]);
});

test('script apagado da cópia local vem do commit, roda na mesma pasta e a cópia temporária é removida',()=>{
  const {deps:d,calls}=deps({present:false});
  assert.equal(runScript('stop.ps1',[],d),0);
  const [written]=calls.written;
  assert.equal(path.dirname(written.file),path.normalize('C:/central/scripts'),'Na mesma pasta: o script acha os dados pela própria pasta.');
  assert.match(path.basename(written.file),/^\.stop-[0-9a-f-]{36}\.ps1$/);
  assert.equal(written.text,'\uFEFFWrite-Output "stop.ps1"\r\n','Uma única marca de início, para o PowerShell ler os acentos.');
  assert.equal(calls.spawned[0].file,written.file);assert.deepEqual(calls.removed,[written.file]);
});

test('falha do PowerShell ou do commit vira código 1 com mensagem, e a cópia temporária não fica para trás',()=>{
  const spawnFailure=deps({present:false,error:new Error('powershell.exe não encontrado')});
  assert.equal(runScript('start-central.ps1',[],spawnFailure.deps),1);
  assert.match(spawnFailure.calls.logged[0],/start-central\.ps1: powershell\.exe não encontrado/);
  assert.equal(spawnFailure.calls.removed.length,1);
  const missing=deps({present:false,gitFails:true});
  assert.equal(runScript('stop.ps1',[],missing.deps),1);assert.equal(missing.calls.spawned.length,0);
  assert.match(missing.calls.logged[0],/path not in HEAD/);
});

test('atalhos de iniciar e parar usam fim de linha do Windows e chamam os scripts certos',()=>{
  const root=path.join(__dirname,'..');
  for(const [file,script] of [['Iniciar WhatsApp Central.cmd','open-central.cjs'],['Parar WhatsApp Central.cmd','stop-central.cjs']]) {
    const text=fs.readFileSync(path.join(root,file),'utf8');
    assert.match(text,new RegExp('node scripts\\\\'+script.replace('.','\\.')));
    assert.equal(text.split('\n').length-1,text.split('\r\n').length-1,file+' precisa de CRLF em todas as linhas.');
  }
  const scripts=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts;
  assert.deepEqual([scripts.start,scripts.stop],['node scripts/open-central.cjs','node scripts/stop-central.cjs']);
});
