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

test('cofre separa chave do assistente e transcrição, verifica proteção e preserva rotação anterior em falha',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'wa-credential-test-'));let fail=false;
  const options={protect:async bytes=>fail?Buffer.from('invalid'):Buffer.from('protected:'+bytes.toString('base64')),unprotect:async bytes=>{if(!bytes.toString().startsWith('protected:')) throw new Error('SECRET');return Buffer.from(bytes.toString().slice(10),'base64');}};
  const vault=createCredentialStore(directory,options);t.after(async()=>{await vault.close();await fs.rm(directory,{recursive:true,force:true});});
  await vault.set('assistant','assistant-SECRET');await vault.set('openai','audio-SECRET');assert.equal(await vault.get('assistant'),'assistant-SECRET');assert.equal(await vault.get('openai'),'audio-SECRET');
  const raw=await fs.readFile(path.join(directory,'credentials.sqlite'));assert.equal(raw.includes(Buffer.from('assistant-SECRET')),false);
  fail=true;await assert.rejects(vault.set('assistant','new-SECRET'),error=>error.status===503&&!error.message.includes('SECRET'));assert.equal(await vault.get('assistant'),'assistant-SECRET');
  await vault.remove('assistant');assert.equal(await vault.has('assistant'),false);assert.equal(await vault.has('openai'),true);
});
