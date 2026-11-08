const fs=require('node:fs/promises');
const path=require('node:path');
const {Pool}=require('pg');
const {defaults}=require('./store.cjs');
const {externalizeMedia,hydrateMedia}=require('./persisted-media.cjs');
function createPostgresPersistence(config,directory,{schema='central'}={}) {
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Esquema PostgreSQL inválido.');
  const prefix='"'+schema+'"',root=path.resolve(directory),pool=new Pool({...config,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,application_name:'whats_ai_central'});
  pool.on('error',error=>console.error('Conexão PostgreSQL interrompida:',error.code || 'indisponível'));
  let ready,closing;
  async function transaction(work) {
    const client=await pool.connect();try {await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
    catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}finally {client.release();}
  }
  const scopeOf=dir=>{const relative=path.relative(root,path.resolve(dir));if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error('Armazenamento fora da pasta da central.');return relative.split(path.sep).join('/');};
  const service={
    pool,
    initialize() {
      if(!ready) ready=transaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['whats-ai-schema:'+schema]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${prefix}`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${prefix}.documents (scope TEXT NOT NULL, name TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(scope,name)); CREATE TABLE IF NOT EXISTS ${prefix}.credentials (name TEXT PRIMARY KEY, ciphertext BYTEA NOT NULL, updated_at BIGINT NOT NULL); CREATE TABLE IF NOT EXISTS ${prefix}.knowledge_text (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS ${prefix}.migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), details JSONB NOT NULL); CREATE TABLE IF NOT EXISTS ${prefix}.blobs (store TEXT NOT NULL, key TEXT NOT NULL, data BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(store,key))`);
      }).catch(error=>{ready=null;throw error;});return ready;
    },
    store(dir,{file='atendimento.json',initial=defaults}={}) {
      const scope=scopeOf(dir);if(!/^[a-zA-Z0-9_.-]+\.json$/.test(file)) throw new Error('Nome de documento inválido.');
      let seed;const initialJson=()=>seed ||= externalizeMedia(structuredClone(initial),root).then(value=>JSON.stringify(value));
      return {
        async read() {await service.initialize();const {rows}=await pool.query(`SELECT data FROM ${prefix}.documents WHERE scope=$1 AND name=$2`,[scope,file]);return hydrateMedia(structuredClone(rows[0]?.data ?? initial),root);},
        async update(fn) {
          await service.initialize();return transaction(async client=>{
            await client.query(`INSERT INTO ${prefix}.documents(scope,name,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,[scope,file,await initialJson()]);
            const {rows}=await client.query(`SELECT data FROM ${prefix}.documents WHERE scope=$1 AND name=$2 FOR UPDATE`,[scope,file]),next=await hydrateMedia(structuredClone(rows[0].data),root),result=fn(next);
            if(result && typeof result.then==='function') throw new Error('A atualização do estado deve ser síncrona.');
            const copiedResult=structuredClone(result);await externalizeMedia(next,root);
            await client.query(`UPDATE ${prefix}.documents SET data=$3::jsonb,updated_at=now() WHERE scope=$1 AND name=$2`,[scope,file,JSON.stringify(next)]);return copiedResult;
          });
        }
      };
    },
    // Arquivos da central (textos da base, fotos de produtos, vetores de busca): mesma interface do createBlobStore do SQLite.
    // Na primeira abertura de cada conjunto, a pasta antiga (e, para os textos, a tabela knowledge_text) é copiada uma vez; as origens ficam preservadas.
    blobs(store,{legacyDir,keyOf=name=>name}={}) {
      if(!/^[a-z][a-z0-9-]{0,40}$/.test(store)) throw new Error('Conjunto de arquivos inválido.');
      let imported;
      const prepare=()=>imported ||= (async()=>{
        await service.initialize();
        let names=[];if(legacyDir) try {names=(await fs.readdir(legacyDir,{withFileTypes:true})).filter(item=>item.isFile() && !item.name.endsWith('.tmp')).map(item=>item.name);}catch(error) {if(error.code!=='ENOENT') throw error;}
        const files=[];for(const name of names) {const key=keyOf(name);if(key) files.push({key,data:await fs.readFile(path.join(legacyDir,name))});}
        await transaction(async client=>{
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['whats-ai-blobs:'+schema+':'+store]);
          if((await client.query(`SELECT 1 FROM ${prefix}.migrations WHERE id=$1`,['blobs:'+store])).rowCount) return;
          if(store==='knowledge-texts') await client.query(`INSERT INTO ${prefix}.blobs(store,key,data) SELECT $1,id,convert_to(content,'UTF8') FROM ${prefix}.knowledge_text ON CONFLICT DO NOTHING`,[store]);
          for(const file of files) await client.query(`INSERT INTO ${prefix}.blobs(store,key,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[store,file.key,file.data]);
          await client.query(`INSERT INTO ${prefix}.migrations(id,details) VALUES($1,$2::jsonb)`,['blobs:'+store,JSON.stringify({files:files.length})]);
        });
      })().catch(error=>{imported=null;throw error;});
      const query=async(sql,values)=>{await prepare();return pool.query(sql,values);};
      return {
        async get(key) {return (await query(`SELECT data FROM ${prefix}.blobs WHERE store=$1 AND key=$2`,[store,key])).rows[0]?.data ?? null;},
        async getText(key) {const data=await this.get(key);return data?data.toString('utf8'):null;},
        async getTexts(keys) {const {rows}=await query(`SELECT key,data FROM ${prefix}.blobs WHERE store=$1 AND key=ANY($2::text[])`,[store,[...keys]]);return new Map(rows.map(row=>[row.key,row.data.toString('utf8')]));},
        async put(key,data) {await query(`INSERT INTO ${prefix}.blobs(store,key,data,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(store,key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,[store,key,Buffer.isBuffer(data)?data:Buffer.from(String(data))]);},
        async remove(key) {await query(`DELETE FROM ${prefix}.blobs WHERE store=$1 AND key=$2`,[store,key]);},
        async keys() {return (await query(`SELECT key FROM ${prefix}.blobs WHERE store=$1 ORDER BY updated_at,key`,[store])).rows.map(row=>row.key);}
      };
    },
    credentials:{
      async has(name) {await service.initialize();return (await pool.query(`SELECT 1 FROM ${prefix}.credentials WHERE name=$1`,[name])).rowCount>0;},
      async get(name) {await service.initialize();return (await pool.query(`SELECT ciphertext FROM ${prefix}.credentials WHERE name=$1`,[name])).rows[0]?.ciphertext || null;},
      async set(name,ciphertext) {await service.initialize();await pool.query(`INSERT INTO ${prefix}.credentials(name,ciphertext,updated_at) VALUES($1,$2,$3) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at`,[name,ciphertext,Date.now()]);},
      async remove(name) {await service.initialize();await pool.query(`DELETE FROM ${prefix}.credentials WHERE name=$1`,[name]);}
    },
    knowledge:{
      async read(id) {await service.initialize();return (await pool.query(`SELECT content FROM ${prefix}.knowledge_text WHERE id=$1`,[id])).rows[0]?.content || '';},
      async write(id,content) {await service.initialize();await pool.query(`INSERT INTO ${prefix}.knowledge_text(id,content) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=now()`,[id,content]);},
      async remove(id) {await service.initialize();await pool.query(`DELETE FROM ${prefix}.knowledge_text WHERE id=$1`,[id]);}
    },
    async migrate(options={}) {await service.initialize();return require('./postgres-migration.cjs').importLegacy({directory:root,prefix,transaction,...options});},
    async archiveAccount(id,now=Date.now) {
      if(!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('Conta inválida para arquivamento.');
      await service.initialize();return transaction(async client=>{
        const scope=id==='principal'?'':'contas/'+id;
        await client.query(`UPDATE ${prefix}.documents SET scope=$2,updated_at=now() WHERE scope=$1 AND name='atendimento.json'`,[scope,'arquivadas/'+id+'/'+now()]);
      });
    },
    close:()=>closing ||= pool.end()
  };return service;
}
module.exports={createPostgresPersistence};
