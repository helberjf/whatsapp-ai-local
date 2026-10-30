const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppServer}=require('../server.cjs');

const integrationToken='a'.repeat(40);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

test('token de integração libera apenas status, consulta de número, envio de texto e leitura',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-integration-'));
  const upstreamCalls=[];
  const fetchImpl=async(url,init={})=>{
    upstreamCalls.push(new URL(url).pathname);
    const body=new URL(url).pathname.startsWith('/instance/connectionState')?{instance:{state:'open'}}:{};
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:9',apiKey:'k',instanceName:'teste',integrationToken},storeDir:directory,fetchImpl,disableWorkers:true});
  await listen(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(route,method='GET',token=integrationToken,body)=>fetch(base+route,{method,headers:{'X-Integration-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});

  assert.notEqual((await call('/api/connection')).status,403);
  assert.equal((await call('/api/connection','GET','b'.repeat(40))).status,403,'token errado');
  assert.equal((await call('/api/crm')).status,403,'rota fora da lista');
  assert.equal((await call('/api/disconnect','POST',integrationToken,{})).status,403,'desconectar não é liberado');
  assert.equal((await call('/api/settings')).status,403);
  // Sem o header, o comportamento antigo continua: exige a sessão da própria tela.
  assert.equal((await fetch(base+'/api/connection')).status,403);
});

test('sem token configurado, qualquer token de integração é recusado',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'whatsapp-integration-'));
  const server=createWhatsAppServer({config:{apiUrl:'http://127.0.0.1:9',apiKey:'k',instanceName:'teste'},storeDir:directory,fetchImpl:async()=>new Response('{}'),disableWorkers:true});
  await listen(server);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/connection`,{headers:{'X-Integration-Token':'x'.repeat(40)}});
  assert.equal(response.status,403);
});
