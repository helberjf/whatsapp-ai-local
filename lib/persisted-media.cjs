const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

const MAX_BYTES=10*1024*1024;
const MAX_BASE64=4*Math.ceil(MAX_BYTES/3);
const mediaTypes=new Set(['audio','image','video','document']);
const writes=new Map();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const limitError=()=>new Error('Os anexos dos gatilhos podem somar até 10 MB.');
const integrityError=()=>new Error('Falha de integridade no arquivo de mídia do gatilho.');

// Deliberately visit only trigger responses. Other base64 fields may contain secrets.
function attachments(data) {
  const rules=data?.triggers?.settings?.rules;if(!Array.isArray(rules)) return [];
  return rules.flatMap(rule=>Array.isArray(rule?.messages)?rule.messages.filter(message=>message && typeof message==='object' && !Array.isArray(message) && mediaTypes.has(message.type)):[]);
}
function decode(base64) {
  if(typeof base64!=='string' || !base64.length) throw new Error('Anexo do gatilho em base64 inválido.');
  if(base64.length>MAX_BASE64) throw limitError();
  if(base64.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Anexo do gatilho em base64 inválido.');
  const bytes=Buffer.from(base64,'base64');if(bytes.length>MAX_BYTES) throw limitError();
  if(!bytes.length || bytes.toString('base64')!==base64) throw new Error('Anexo do gatilho em base64 inválido.');
  return bytes;
}
function referenceHash(reference) {
  if(typeof reference!=='string' || !/^sha256:[a-f0-9]{64}$/.test(reference)) throw new Error('Referência de mídia do gatilho inválida.');
  return reference.slice(7);
}
async function checkDirectory(directory,create=false) {
  if(create) await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stat=await fs.lstat(directory);if(!stat.isDirectory() || stat.isSymbolicLink()) throw integrityError();
}
async function readBlob(directory,hash) {
  try {
    await checkDirectory(directory);const file=path.join(directory,hash),stat=await fs.lstat(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size<1) throw integrityError();
    if(stat.size>MAX_BYTES) throw limitError();
    const handle=await fs.open(file,'r');
    try {
      const opened=await handle.stat();if(!opened.isFile() || opened.ino!==stat.ino || opened.dev!==stat.dev || opened.size!==stat.size) throw integrityError();
      const bytes=await handle.readFile();if(bytes.length>MAX_BYTES) throw limitError();
      if(bytes.length!==stat.size || digest(bytes)!==hash) throw integrityError();return bytes;
    } finally {await handle.close();}
  } catch(error) {
    if(error.code==='ENOENT') throw new Error('Arquivo de mídia do gatilho não encontrado.',{cause:error});throw error;
  }
}
async function writeBlob(directory,hash,bytes) {
  const file=path.join(directory,hash);if(writes.has(file)) return writes.get(file);
  const operation=(async()=>{
    const temporary=path.join(directory,'.'+hash+'.'+randomUUID()+'.tmp');let created=false;
    try {
      const handle=await fs.open(temporary,'wx',0o600);created=true;
      try {await handle.writeFile(bytes);await handle.sync();}finally {await handle.close();}
      // A hard link publishes complete bytes atomically and refuses to replace a blob.
      try {await fs.link(temporary,file);}
      catch(error) {if(error.code!=='EEXIST') throw error;await readBlob(directory,hash);}
    } finally {if(created) await fs.unlink(temporary);}
  })();
  writes.set(file,operation);try {await operation;}finally {writes.delete(file);}
}
async function prepare(data,directory) {
  const candidates=attachments(data),entries=[];let total=0;
  // Validate all input before any file writes or mutations to the caller's object.
  for(const message of candidates) {
    const inline=Object.hasOwn(message,'base64'),reference=Object.hasOwn(message,'mediaRef');
    if(inline && reference) throw new Error('O anexo não pode conter base64 e referência ao mesmo tempo.');
    if(!inline && !reference) throw new Error('O anexo precisa de base64 ou referência de mídia.');
    const bytes=inline?decode(message.base64):null,hash=inline?digest(bytes):referenceHash(message.mediaRef);
    if(bytes) {total+=bytes.length;if(total>MAX_BYTES) throw limitError();}
    entries.push({message,inline,hash,bytes});
  }
  if(!entries.length) return {entries};
  const mediaDirectory=path.resolve(directory,'trigger-media'),loaded=new Map();
  for(const entry of entries) if(!entry.inline) {
    if(!loaded.has(entry.hash)) loaded.set(entry.hash,await readBlob(mediaDirectory,entry.hash));
    entry.bytes=loaded.get(entry.hash);total+=entry.bytes.length;if(total>MAX_BYTES) throw limitError();
  }
  return {entries,mediaDirectory};
}
async function externalizeMedia(data,directory) {
  const {entries,mediaDirectory}=await prepare(data,directory);
  if(entries.some(entry=>entry.inline)) await checkDirectory(mediaDirectory,true);
  for(const entry of entries) if(entry.inline) await writeBlob(mediaDirectory,entry.hash,entry.bytes);
  for(const {message,hash} of entries) {message.mediaRef='sha256:'+hash;delete message.base64;}
  return data;
}
async function hydrateMedia(data,directory) {
  const {entries}=await prepare(data,directory);
  for(const {message,bytes} of entries) {message.base64=bytes.toString('base64');delete message.mediaRef;}
  return data;
}
module.exports={externalizeMedia,hydrateMedia};
