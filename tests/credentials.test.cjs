const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createCredentialStore}=require('../lib/credentials.cjs');
test('chave fica criptografada no SQLite e só é recuperada pelo mesmo usuário Windows',{skip:process.platform!=='win32'},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-credential-test-'));
  const vault=createCredentialStore(directory);let restarted;
  t.after(async()=>{await vault.close();await restarted?.close();assert.equal(path.dirname(directory),os.tmpdir());assert.match(path.basename(directory),/^wa-credential-test-/);await fs.rm(directory,{recursive:true,force:true});});
  const secret='sk-TESTE-criptografia-'+Date.now();
  await vault.set('openai',secret);assert.equal(await vault.has('openai'),true);assert.equal(await vault.get('openai'),secret);
  assert.equal((await fs.readFile(path.join(directory,'credentials.sqlite'))).includes(Buffer.from(secret)),false);
  await vault.close();restarted=createCredentialStore(directory);assert.equal(await restarted.get('openai'),secret);
  await restarted.remove('openai');assert.equal(await restarted.has('openai'),false);assert.equal(await restarted.get('openai'),null);
});
