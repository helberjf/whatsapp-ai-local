const fs=require('node:fs');
const path=require('node:path');

// Banco único da central (data/central.sqlite). Cada conjunto de dados usa um "store" próprio nas mesmas tabelas.
// A conexão é aberta só durante cada operação: no Windows a pasta continua livre para backup, cópia e testes.
const FILE='central.sqlite';
const SCHEMA=`PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS documents (store TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));
CREATE TABLE IF NOT EXISTS entries (store TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, collection, key));
CREATE TABLE IF NOT EXISTS blobs (store TEXT NOT NULL, key TEXT NOT NULL, data BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (store, key));
CREATE TABLE IF NOT EXISTS meta (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key));`;
const databasePath=directory=>path.join(directory,FILE);
function withDatabase(directory,fn) {
  fs.mkdirSync(directory,{recursive:true});
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(databasePath(directory));
  try {db.exec(SCHEMA);return fn(db);}finally {db.close();}
}
function transaction(db,fn) {
  db.exec('BEGIN IMMEDIATE');
  try {const result=fn();db.exec('COMMIT');return result;}catch(error) {try {db.exec('ROLLBACK');}catch {}throw error;}
}
const getMeta=(db,store,key)=>db.prepare('SELECT value FROM meta WHERE store=? AND key=?').get(store,key)?.value ?? null;
const setMeta=(db,store,key,value)=>db.prepare('INSERT INTO meta (store, key, value) VALUES (?, ?, ?) ON CONFLICT(store, key) DO UPDATE SET value=excluded.value').run(store,key,value);

// Arquivos da central (textos da base, fotos de produtos, vetores) guardados como BLOB.
// Uma pasta antiga é importada uma única vez e renomeada para "<pasta>.migrado".
function createBlobStore(directory,store,{legacyDir,keyOf=name=>name}={}) {
  let ready=null;
  async function migrate() {
    if(!legacyDir) return;
    if(withDatabase(directory,db=>getMeta(db,store,'migrated'))) return;
    let names=[];try {names=(await fs.promises.readdir(legacyDir,{withFileTypes:true})).filter(item=>item.isFile() && !item.name.endsWith('.tmp')).map(item=>item.name);}catch(error) {if(error.code!=='ENOENT') throw error;}
    const files=[];for(const name of names) files.push({key:keyOf(name),data:await fs.promises.readFile(path.join(legacyDir,name))});
    const imported=withDatabase(directory,db=>transaction(db,()=>{
      if(getMeta(db,store,'migrated')) return false;
      const insert=db.prepare('INSERT INTO blobs (store, key, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(store, key) DO NOTHING');
      for(const file of files) if(file.key) insert.run(store,file.key,file.data,Date.now());
      setMeta(db,store,'migrated',new Date().toISOString());return files.length>0;
    }));
    if(imported) await fs.promises.rename(legacyDir,legacyDir+'.migrado').catch(()=>{});
  }
  const prepared=()=>ready || (ready=migrate().catch(error=>{ready=null;throw error;}));
  const run=async fn=>{await prepared();return withDatabase(directory,fn);};
  const buffer=value=>value===undefined || value===null?null:Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  return {
    get:key=>run(db=>buffer(db.prepare('SELECT data FROM blobs WHERE store=? AND key=?').get(store,key)?.data)),
    async getText(key) {const data=await this.get(key);return data?data.toString('utf8'):null;},
    // Vários itens numa única abertura do banco (ex.: todos os textos da base para uma busca).
    getTexts:keys=>run(db=>{const statement=db.prepare('SELECT data FROM blobs WHERE store=? AND key=?'),result=new Map();for(const key of keys) {const row=statement.get(store,key);if(row) result.set(key,buffer(row.data).toString('utf8'));}return result;}),
    put:(key,data)=>run(db=>{db.prepare('INSERT INTO blobs (store, key, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(store, key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').run(store,key,Buffer.isBuffer(data)?data:Buffer.from(String(data),'utf8'),Date.now());}),
    remove:key=>run(db=>{db.prepare('DELETE FROM blobs WHERE store=? AND key=?').run(store,key);}),
    keys:()=>run(db=>db.prepare('SELECT key FROM blobs WHERE store=? ORDER BY rowid').all(store).map(row=>row.key))
  };
}
module.exports={FILE,databasePath,withDatabase,transaction,getMeta,setMeta,createBlobStore};
