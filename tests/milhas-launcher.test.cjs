const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');

async function launchWith(env={}) {
  const calls=[];let started=false;
  const child=new EventEmitter();Object.assign(child,{exitCode:null,signalCode:null,unref(){}});
  const fakeFs={access:async()=>{},mkdir:async()=>{},open:async()=>({fd:42,close:async()=>{}})};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','integrations','milhas','whatsapp-local.cjs'),'utf8'),{
    module,exports:module.exports,__dirname:path.join('C:\\','Milhas'),process:{env},URL,AbortSignal,Date,Promise,
    require(name) {
      if(name==='node:fs/promises') return fakeFs;
      if(name==='node:path') return path;
      if(name==='node:os') return {homedir:()=>path.join('C:\\','Pessoa')};
      if(name==='node:child_process') return {spawn(command,args,options){calls.push({command,args,options});started=true;setImmediate(()=>child.emit('spawn'));return child;}};
      throw new Error('Dependência inesperada: '+name);
    },
    fetch:async()=>{if(!started) throw new Error('Serviço parado');return {ok:true,json:async()=>({service:'whatsapp-local'}),body:{cancel:async()=>{}}};},
    setTimeout:callback=>{setImmediate(callback);return 1;}
  });
  const result=await module.exports.openWhatsApp();return {result,calls};
}

test('Milhas inicia central parada na pasta configurada e retorna o webapp',async()=>{
  const project=path.join('C:\\','Minha central pessoal');
  const {result,calls}=await launchWith({WHATSAPP_CENTRAL_DIR:project});
  assert.equal(result.url,'http://127.0.0.1:8766/');assert.equal(calls.length,1);
  assert.equal(calls[0].options.cwd,project);
  assert.equal(calls[0].args.at(-2),path.join(project,'scripts','start.ps1'));
  assert.equal(calls[0].options.windowsHide,true);
});

test('Milhas usa projects/whatsapp-central por padrão ao iniciar o serviço',async()=>{
  const {calls}=await launchWith();
  assert.equal(calls[0].options.cwd,path.join('C:\\','Pessoa','projects','whatsapp-central'));
});
