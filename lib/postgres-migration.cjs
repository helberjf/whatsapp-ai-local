const fs=require('node:fs/promises');
const path=require('node:path');
const {isDeepStrictEqual}=require('node:util');
const {protectedData}=require('./credentials.cjs');
const {isProvider,credentialName,endpoint}=require('./ai-providers.cjs');
const {externalizeMedia}=require('./persisted-media.cjs');
async function importLegacy({directory,prefix,transaction,protect=bytes=>protectedData('protect',bytes),unprotect=bytes=>protectedData('unprotect',bytes)}) {
  return transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['whats-ai-import:'+prefix]);
    if((await client.query(`SELECT 1 FROM ${prefix}.migrations WHERE id='legacy-files-v1'`)).rowCount) return {imported:false};
    const documents=[],credentials=new Map(),texts=[];
    const addFile=async(scope,name,source)=>{
      let raw;try {raw=await fs.readFile(source,'utf8');}catch(error) {if(error.code==='ENOENT') return;throw error;}
      let data;try {data=JSON.parse(raw);}catch {throw new Error('Arquivo de dados inválido na migração: '+path.relative(directory,source));}
      if(!data || typeof data!=='object' || Array.isArray(data)) throw new Error('Formato de dados inválido na migração: '+name);
      documents.push({scope,name,data});
    };
    for(const name of ['atendimento.json','contas.json','ai.json','knowledge.json','produtos.json','config.json']) await addFile('',name,path.join(directory,name));
    for(const entry of await fs.readdir(path.join(directory,'contas'),{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT') return [];throw error;})) if(entry.isDirectory() && /^[a-z0-9-]{1,40}$/.test(entry.name)) await addFile('contas/'+entry.name,'atendimento.json',path.join(directory,'contas',entry.name,'atendimento.json'));
    for(const entry of await fs.readdir(path.join(directory,'contas-arquivadas'),{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT') return [];throw error;})) if(entry.isFile() && /^[a-z0-9-]+\.json$/.test(entry.name)) await addFile('arquivadas/'+entry.name.replace(/\.json$/,''),'atendimento.json',path.join(directory,'contas-arquivadas',entry.name));
    for(const doc of documents.find(item=>item.name==='knowledge.json')?.data.documents || []) {
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(doc.id || '')) throw new Error('Identificador inválido na base de conhecimento legada.');
      texts.push({id:doc.id,content:await fs.readFile(path.join(directory,'knowledge',doc.id+'.txt'),'utf8')});
    }
    const sqlite=path.join(directory,'credentials.sqlite');
    try {
      await fs.access(sqlite);const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(sqlite,{readOnly:true});
      try {for(const row of db.prepare('SELECT name,ciphertext,updated_at FROM credentials').all()) {if(!row.ciphertext?.length) throw new Error('Credencial legada inválida.');credentials.set(row.name,{ciphertext:Buffer.from(row.ciphertext),updatedAt:Number(row.updated_at)});}}finally {db.close();}
    }catch(error) {if(error.code!=='ENOENT') throw error;}
    async function encrypt(name,value) {
      if(typeof value!=='string' || !value || value.length>4096) throw new Error('Credencial legada inválida.');
      const bytes=Buffer.from(value);let check;
      try {const ciphertext=await protect(bytes);check=await unprotect(ciphertext);if(!Buffer.isBuffer(ciphertext) || !ciphertext.length || !Buffer.isBuffer(check) || !bytes.equals(check)) throw new Error('Não foi possível conferir a proteção da credencial legada.');credentials.set(name,{ciphertext,updatedAt:Date.now()});}
      finally {bytes.fill(0);check?.fill(0);}
    }
    for(const doc of documents) {
      if(doc.name==='ai.json' && Object.hasOwn(doc.data,'apiKey')) {
        if(doc.data.apiKey) {if(!isProvider(doc.data.provider)) throw new Error('Provedor legado inválido.');const name=doc.data.provider==='ollama'?'assistant-unassigned':credentialName(doc.data.provider);await encrypt(name,doc.data.apiKey);if(doc.data.provider!=='ollama') (doc.data.keyBaseUrls ||= {})[doc.data.provider]=endpoint(doc.data.provider,doc.data.baseUrl);}
        delete doc.data.apiKey;
      }
      if(doc.name==='config.json') for(const [field,name] of [['apiKey','evolution'],['integrationToken','integration']]) {if(doc.data[field]) await encrypt(name,doc.data[field]);delete doc.data[field];}
      await externalizeMedia(doc.data,directory);
      await client.query(`INSERT INTO ${prefix}.documents(scope,name,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,[doc.scope,doc.name,JSON.stringify(doc.data)]);
      const saved=(await client.query(`SELECT data FROM ${prefix}.documents WHERE scope=$1 AND name=$2`,[doc.scope,doc.name])).rows[0]?.data;if(!isDeepStrictEqual(saved,doc.data)) throw new Error('Já existem dados diferentes no PostgreSQL. A importação foi interrompida para preservá-los.');
    }
    for(const [name,row] of credentials) {
      await client.query(`INSERT INTO ${prefix}.credentials(name,ciphertext,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[name,row.ciphertext,row.updatedAt]);
      const saved=(await client.query(`SELECT ciphertext FROM ${prefix}.credentials WHERE name=$1`,[name])).rows[0]?.ciphertext;if(!saved || !saved.equals(row.ciphertext)) throw new Error('Já existe outra credencial no PostgreSQL. A importação não a substituiu.');
    }
    for(const text of texts) {
      await client.query(`INSERT INTO ${prefix}.knowledge_text(id,content) VALUES($1,$2) ON CONFLICT DO NOTHING`,[text.id,text.content]);
      const saved=(await client.query(`SELECT content FROM ${prefix}.knowledge_text WHERE id=$1`,[text.id])).rows[0]?.content;if(saved!==text.content) throw new Error('Já existe outro texto da base no PostgreSQL. A importação não o substituiu.');
    }
    const details={documents:documents.length,credentials:credentials.size,texts:texts.length};await client.query(`INSERT INTO ${prefix}.migrations(id,details) VALUES('legacy-files-v1',$1::jsonb)`,[JSON.stringify(details)]);return {imported:true,...details};
  });
}
module.exports={importLegacy};
