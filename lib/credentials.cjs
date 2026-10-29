const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {timingSafeEqual}=require('node:crypto');
const {ApiError}=require('./evolution.cjs');
function protectedData(operation,bytes) {
  if(process.platform!=='win32') return Promise.reject(new ApiError('A proteção de credenciais desta instalação requer seu usuário do Windows.',503));
  return new Promise((resolve,reject)=>{
    // O segredo passa somente por stdin/stdout, nunca por argumentos, logs ou arquivo temporário.
    const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'..','scripts','protect-secret.ps1'),'-Operation',operation],{windowsHide:true,timeout:15000,maxBuffer:64000,encoding:'utf8'},(error,stdout)=>{
      if(error || !/^[A-Za-z0-9+/=]+$/.test(stdout.trim())) return reject(new ApiError('Não foi possível proteger ou abrir a chave com este usuário do Windows.',503));
      resolve(Buffer.from(stdout.trim(),'base64'));
    });
    child.stdin.on('error',()=>{});child.stdin.end(bytes.toString('base64'));
  });
}
function createCredentialStore(directory,options={}) {
  let database,opening,queue=Promise.resolve(),closing,closed=false;
  const protect=options.protect || (bytes=>protectedData('protect',bytes)),unprotect=options.unprotect || (bytes=>protectedData('unprotect',bytes));
  async function db() {
    if(!opening) opening=(async()=>{
      await fs.mkdir(directory,{recursive:true});
      const {DatabaseSync}=require('node:sqlite');database=new DatabaseSync(path.join(directory,'credentials.sqlite'));
      database.exec('PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS credentials (name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL)');
      return database;
    })();return opening;
  }
  const valid=name=>{if(!['openai','assistant'].includes(name)) throw new ApiError('Credencial inválida.',422);};
  function operation(fn) {
    if(closed) return Promise.reject(new ApiError('O banco seguro de credenciais está fechado.',503));
    const pending=queue.then(fn).catch(()=>{throw new ApiError('Não foi possível proteger ou abrir a chave com este usuário do Windows.',503);});queue=pending.catch(()=>{});return pending;
  }
  return {
    async has(name) {valid(name);return operation(async()=>!!(await db()).prepare('SELECT 1 FROM credentials WHERE name=?').get(name));},
    async get(name) {valid(name);return operation(async()=>{const row=(await db()).prepare('SELECT ciphertext FROM credentials WHERE name=?').get(name);return row?(await unprotect(Buffer.from(row.ciphertext))).toString('utf8'):null;});},
    async set(name,value) {
      valid(name);if(typeof value!=='string' || !value || value.length>4096) throw new ApiError('Chave de API inválida.',422);
      return operation(async()=>{
        const plaintext=Buffer.from(value,'utf8');let checked;
        try {
          const ciphertext=await protect(plaintext);if(!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error('Invalid ciphertext');
          checked=await unprotect(ciphertext);if(!Buffer.isBuffer(checked) || plaintext.length!==checked.length || !timingSafeEqual(plaintext,checked)) throw new Error('Protection verification failed');
          (await db()).prepare('INSERT INTO credentials(name,ciphertext,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').run(name,ciphertext,Date.now());
        }finally {plaintext.fill(0);if(Buffer.isBuffer(checked)) checked.fill(0);}
      });
    },
    async remove(name) {valid(name);return operation(async()=>{(await db()).prepare('DELETE FROM credentials WHERE name=?').run(name);});},
    close() {if(!closing) {closed=true;closing=queue.then(async()=>{if(opening) await opening.catch(()=>{});if(database) database.close();database=null;opening=null;});}return closing;}
  };
}
module.exports={createCredentialStore};
