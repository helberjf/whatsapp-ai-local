const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {ensureDatabaseConfig}=require('../lib/database-config.cjs');
test('configurador cria conexão separada sem substituir segredos do conector',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-db-config-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(path.join(directory,'infra'));await fs.mkdir(path.join(directory,'data'));
  const original='POSTGRES_PASSWORD=existing-private\nAUTHENTICATION_API_KEY=keep-private\n';await fs.writeFile(path.join(directory,'infra','.env'),original);const config=ensureDatabaseConfig(directory);
  assert.equal(config.database,'whatsapp_central');assert.equal(config.user,'whatsapp_central');assert.equal(config.port,8768);assert.match(config.password,/^[a-f0-9]{64}$/);assert.equal((await fs.readFile(path.join(directory,'infra','.env'),'utf8')).startsWith(original),true);
  const env=await fs.readFile(path.join(directory,'infra','.env'),'utf8');assert.deepEqual(ensureDatabaseConfig(directory),config);assert.equal(await fs.readFile(path.join(directory,'infra','.env'),'utf8'),env);
});
