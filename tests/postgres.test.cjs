const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {createPostgresPersistence}=require('../lib/postgres.cjs');
const {createCredentialStore}=require('../lib/credentials.cjs');
const {createWhatsAppServer}=require('../server.cjs');
const enabled=process.env.WHATSAPP_PG_TEST==='1';
async function fixture(t) {
  const config=JSON.parse(await fs.readFile(path.join(__dirname,'../data/database.json'),'utf8'));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-pg-test-')),schema='qa_'+randomBytes(8).toString('hex');
  const persistence=createPostgresPersistence(config,directory,{schema});await persistence.initialize();
  t.after(async()=>{assert.match(schema,/^qa_[a-f0-9]{16}$/);await persistence.pool.query(`DROP SCHEMA "${schema}" CASCADE`);await persistence.close();assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^wa-pg-test-/);await fs.rm(directory,{recursive:true,force:true});});return {config,directory,persistence,schema};
}
test('PostgreSQL preserva atualizações concorrentes de duas instâncias e faz rollback',{skip:!enabled},async t=>{
  const f=await fixture(t),one=f.persistence.store(f.directory,{file:'state.json',initial:{count:0}}),two=f.persistence.store(f.directory,{file:'state.json',initial:{count:0}});
  await Promise.all(Array.from({length:30},(_,i)=>(i%2?one:two).update(data=>{data.count++;})));assert.equal((await one.read()).count,30);
  await assert.rejects(one.update(data=>{data.count=999;throw new Error('rollback');}));assert.equal((await two.read()).count,30);
  assert.deepEqual(await fs.readdir(f.directory),[]);
});
test('migração é idempotente, confere conteúdo e mantém arquivos locais preservados',{skip:!enabled},async t=>{
  const f=await fixture(t),media=Buffer.from('fixture video bytes').toString('base64'),original={contacts:{fixture:{notes:[{text:'preservada'}]}},requests:{},settings:{},triggers:{settings:{rules:[{messages:[{type:'video',base64:media,fileName:'fixture.mp4',mimeType:'video/mp4',caption:'Vídeo'}]}]}}};
  await fs.writeFile(path.join(f.directory,'atendimento.json'),JSON.stringify(original));await fs.mkdir(path.join(f.directory,'contas','secundaria'),{recursive:true});await fs.writeFile(path.join(f.directory,'contas','secundaria','atendimento.json'),JSON.stringify({contacts:{other:{}},requests:{},settings:{}}));
  const docId='11111111-1111-1111-1111-111111111111';await fs.mkdir(path.join(f.directory,'knowledge'));await fs.writeFile(path.join(f.directory,'knowledge',docId+'.txt'),'Política de entrega preservada.');await fs.writeFile(path.join(f.directory,'knowledge.json'),JSON.stringify({documents:[{id:docId,name:'Política'}],skipped:[]}));
  const migration=await f.persistence.migrate();assert.equal(migration.imported,true);assert.deepEqual(await f.persistence.store(f.directory).read(),original);
  const raw=(await f.persistence.pool.query(`SELECT data FROM "${f.schema}".documents WHERE scope='' AND name='atendimento.json'`)).rows[0].data;assert.doesNotMatch(JSON.stringify(raw),new RegExp(media));assert.match(raw.triggers.settings.rules[0].messages[0].mediaRef,/^sha256:[a-f0-9]{64}$/);
  assert.equal(await f.persistence.knowledge.read(docId),'Política de entrega preservada.');await f.persistence.knowledge.write(docId,'Atualizada');assert.equal(await f.persistence.knowledge.read(docId),'Atualizada');
  await f.persistence.store(f.directory).update(data=>{data.contacts.fixture.notes.push({text:'nova'});});assert.equal((await f.persistence.migrate()).imported,false);assert.equal((await f.persistence.store(f.directory).read()).contacts.fixture.notes.length,2);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'atendimento.json'),'utf8')),original);
  assert.equal(Object.hasOwn((await f.persistence.store(path.join(f.directory,'contas','secundaria')).read()).contacts,'fixture'),false);
});
test('credenciais e chave legada chegam criptografadas ao PostgreSQL e continuam legíveis',{skip:!enabled || process.platform!=='win32'},async t=>{
  const f=await fixture(t),secret='sk-PRIVATE-PG-'+Date.now();await fs.writeFile(path.join(f.directory,'ai.json'),JSON.stringify({provider:'openai',model:'test',apiKey:secret}));await fs.writeFile(path.join(f.directory,'config.json'),JSON.stringify({apiUrl:'http://localhost:8767',apiKey:'connector-PRIVATE',integrationToken:'integration-PRIVATE',instanceName:'fixture'}));
  const legacy=createCredentialStore(f.directory);await legacy.set('openai','audio-PRIVATE');await legacy.close();await f.persistence.migrate();
  const vault=createCredentialStore(f.directory,{repository:f.persistence.credentials});t.after(()=>vault.close());assert.equal(await vault.get('assistant:openai'),secret);assert.equal(await vault.get('openai'),'audio-PRIVATE');
  const state=await f.persistence.store(f.directory,{file:'ai.json',initial:{}}).read();assert.equal(Object.hasOwn(state,'apiKey'),false);
  const configState=await f.persistence.store(f.directory,{file:'config.json',initial:{}}).read();assert.doesNotMatch(JSON.stringify(configState),/PRIVATE|apiKey|integrationToken/);assert.equal(await vault.get('evolution'),'connector-PRIVATE');assert.equal(await vault.get('integration'),'integration-PRIVATE');
  const rows=await f.persistence.pool.query(`SELECT ciphertext FROM "${f.schema}".credentials`);assert.ok(rows.rows.every(row=>!row.ciphertext.includes(Buffer.from('PRIVATE'))));await vault.set('assistant:groq','groq-PRIVATE');assert.equal(await vault.get('assistant:groq'),'groq-PRIVATE');await vault.remove('assistant:groq');assert.equal(await vault.has('assistant:groq'),false);
});
test('migração inválida reverte tudo e pode tentar novamente sem marcar sucesso',{skip:!enabled},async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.directory,'atendimento.json'),'{"contacts":{}}');await fs.writeFile(path.join(f.directory,'produtos.json'),'{INVALID');
  await assert.rejects(f.persistence.migrate());assert.equal((await f.persistence.pool.query(`SELECT count(*)::int AS count FROM "${f.schema}".documents`)).rows[0].count,0);await fs.writeFile(path.join(f.directory,'produtos.json'),'{"products":[]}');assert.equal((await f.persistence.migrate()).imported,true);
});
test('servidor usa PostgreSQL nas rotas, reinicia com contas salvas e arquiva conta isoladamente',{skip:!enabled},async t=>{
  const f=await fixture(t),config={apiUrl:'http://127.0.0.1:9',apiKey:'fixture',instanceName:'fixture'},upstream=async()=>Response.json({instance:{state:'open'}});
  let server;
  const close=async()=>{if(server){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await server.cleanup;server=null;}};t.after(close);
  async function open(){const registry=await f.persistence.store(f.directory,{file:'contas.json',initial:{accounts:[{id:'principal',name:'Conta principal',instanceName:'fixture',createdAt:null}]}}).read();server=createWhatsAppServer({storeDir:f.directory,config,fetchImpl:upstream,disableWorkers:true,persistence:f.persistence,initialAccounts:registry.accounts});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,token=(await(await fetch(base)).text()).match(/whatsapp-session" content="([a-f0-9]+)"/)[1];return async(route,method='GET',body,account)=>{const response=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json','X-WhatsApp-Token':token,...(account?{'X-WhatsApp-Account':account}:{})},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.ok,true);return response.json();};}
  let req=await open();const added=await req('/accounts','POST',{name:'Segunda'});await req('/notes','POST',{jid:'5511999999999@s.whatsapp.net',text:'Nota no banco'},added.id);const doc=await req('/kb','POST',{name:'Política.txt',text:'Entregamos em cinco dias úteis.'});await close();req=await open();assert.equal((await req('/accounts')).length,2);assert.equal((await req('/kb/doc?id='+doc.id)).text,'Entregamos em cinco dias úteis.');assert.equal((await req('/contact?jid=5511999999999%40s.whatsapp.net','GET',undefined,added.id)).notes[0].text,'Nota no banco');await req('/accounts/'+added.id,'DELETE');assert.equal((await req('/accounts')).length,1);await req('/kb?id='+doc.id,'DELETE');assert.equal(await f.persistence.knowledge.read(doc.id),'');await close();assert.deepEqual(await fs.readdir(f.directory),[]);
});
