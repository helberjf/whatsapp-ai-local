const fs=require('node:fs/promises');
const path=require('node:path');
const {withDatabase,transaction,getMeta,setMeta}=require('./database.cjs');
const defaults={contacts:{},requests:{},settings:{templates:[{name:'Boas-vindas',body:'Olá! Como posso ajudar?'},{name:'Aguarde um momento',body:'Vou conferir as informações e já retorno.'}]}};
// Coleções grandes do atendimento: cada item vira uma linha no SQLite e só o item alterado é gravado.
const COLLECTIONS=new Set(['contacts','requests','replyClaims','transcriptions','starred']);

// Arquivos pequenos (produtos, IA, base): JSON com gravação atômica e sequencial.
function createJsonStore(directory,{file:name,initial}) {
  const file=path.join(directory,name);let loaded,queue=Promise.resolve();
  async function load() {
    if(!loaded) loaded=(async()=>{
      try {return JSON.parse(await fs.readFile(file,'utf8'));}
      catch(error) {if(error.code!=='ENOENT') throw error;return structuredClone(initial);}
    })();
    return loaded;
  }
  return {
    read:async()=>structuredClone(await load()),
    update(fn) {
      const operation=queue.then(async()=>{
        const next=structuredClone(await load()),result=fn(next);
        await fs.mkdir(directory,{recursive:true});const temp=file+'.tmp';
        await fs.writeFile(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);
        loaded=Promise.resolve(next);return structuredClone(result);
      });
      queue=operation.catch(()=>{});return operation;
    }
  };
}

const isPlainObject=value=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype;
const copy=value=>value===undefined?undefined:structuredClone(value);
const put=(target,key,value)=>Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});
function detach(value) {
  if(value===null || typeof value!=='object') return value;
  try {return structuredClone(value);}catch {return JSON.parse(JSON.stringify(value));}
}

// Dados da central no SQLite (data/central.sqlite) com a mesma interface (read/update). Cada arquivo antigo vira um "store".
// Leituras copiam só o que for acessado; gravações levam apenas as chaves e itens alterados, numa transação.
function createSqliteStore(directory,{store,legacyFiles=[],initial}) {
  const legacy=legacyFiles.map(name=>path.join(directory,name));
  let base=null,loading=null,queue=Promise.resolve();
  const kinds=new Map(),texts=new Map(),entryTexts=new Map();
  const withDb=fn=>withDatabase(directory,fn);
  // Mesma assinatura de antes; o nome do store é aplicado aqui.
  const statements=db=>{
    const raw={
      upsertDoc:db.prepare('INSERT INTO documents (store, key, kind, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, key) DO UPDATE SET kind=excluded.kind, value=excluded.value'),
      deleteDoc:db.prepare('DELETE FROM documents WHERE store=? AND key=?'),
      upsertEntry:db.prepare('INSERT INTO entries (store, collection, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(store, collection, key) DO UPDATE SET value=excluded.value'),
      deleteEntry:db.prepare('DELETE FROM entries WHERE store=? AND collection=? AND key=?'),
      clearEntries:db.prepare('DELETE FROM entries WHERE store=? AND collection=?')
    };
    return Object.fromEntries(Object.entries(raw).map(([name,statement])=>[name,{run:(...args)=>statement.run(store,...args)}]));
  };
  // Formato do commit anterior: data/atendimento.sqlite com as tabelas sem coluna de store.
  function readLegacySqlite(file) {
    const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file);
    try {return {documents:db.prepare('SELECT key, kind, value FROM documents ORDER BY rowid').all(),entries:db.prepare('SELECT collection, key, value FROM entries ORDER BY rowid').all()};}finally {db.close();}
  }
  function readAll(db) {
    const data={};kinds.clear();texts.clear();entryTexts.clear();
    for(const row of db.prepare('SELECT key, kind, value FROM documents WHERE store=? ORDER BY rowid').all(store)) {
      kinds.set(row.key,row.kind);
      if(row.kind==='collection') {put(data,row.key,{});entryTexts.set(row.key,new Map());}
      else {put(data,row.key,JSON.parse(row.value));texts.set(row.key,row.value);}
    }
    for(const row of db.prepare('SELECT collection, key, value FROM entries WHERE store=? ORDER BY rowid').all(store)) {
      if(kinds.get(row.collection)!=='collection') continue;
      put(data[row.collection],row.key,JSON.parse(row.value));entryTexts.get(row.collection).set(row.key,row.value);
    }
    return data;
  }
  // Escreve uma chave inteira (nova, substituída ou fora das coleções) e devolve o valor como ficou salvo.
  function writeKey(sql,key,value) {
    if(COLLECTIONS.has(key) && isPlainObject(value)) {
      sql.upsertDoc.run(key,'collection','{}');sql.clearEntries.run(key);
      const map={},strings=new Map();
      for(const [entry,item] of Object.entries(value)) {const json=JSON.stringify(item);if(json===undefined) continue;sql.upsertEntry.run(key,entry,json);put(map,entry,JSON.parse(json));strings.set(entry,json);}
      return {kind:'collection',value:map,strings};
    }
    sql.clearEntries.run(key);
    const json=JSON.stringify(value);
    if(json===undefined) {sql.deleteDoc.run(key);return {kind:null};}
    sql.upsertDoc.run(key,'value',json);return {kind:'value',value:JSON.parse(json),json};
  }
  async function load() {
    if(base) return base;
    if(!loading) loading=(async()=>{
      if(!withDb(db=>getMeta(db,store,'initialized'))) {
        // Primeira abertura: importa a versão mais recente que existir (SQLite antigo, depois JSON) ou começa do zero.
        let source=null,legacyData=null,legacySqlite=null;
        for(const file of legacy) {
          try {
            if(file.endsWith('.sqlite')) {await fs.access(file);legacySqlite=readLegacySqlite(file);}
            else legacyData=JSON.parse(await fs.readFile(file,'utf8'));
            source=file;break;
          } catch(error) {if(error.code!=='ENOENT') throw error;}
        }
        const migrated=withDb(db=>transaction(db,()=>{
          if(getMeta(db,store,'initialized')) return false;
          const sql=statements(db);
          if(legacySqlite) {
            for(const row of legacySqlite.documents) sql.upsertDoc.run(row.key,row.kind,row.value);
            for(const row of legacySqlite.entries) sql.upsertEntry.run(row.collection,row.key,row.value);
          } else for(const [key,value] of Object.entries(legacyData ?? structuredClone(initial))) writeKey(sql,key,value);
          setMeta(db,store,'initialized',new Date().toISOString());
          if(source) setMeta(db,store,'migratedFrom',path.basename(source));
          return Boolean(source);
        }));
        // O arquivo antigo fica guardado como cópia de segurança; ele não é mais lido.
        if(migrated) await fs.rename(source,source+'.migrado').catch(()=>{});
      }
      base=withDb(readAll);return base;
    })().catch(error=>{loading=null;throw error;});
    return loading;
  }
  // Visão de uma coleção: cada item é copiado só quando acessado; alterações ficam registradas para a gravação.
  function collectionView(map) {
    const cache=new Map(),removed=new Set(),touched=new Set();
    const own=key=>!removed.has(key) && (cache.has(key) || Object.hasOwn(map,key));
    const get=key=>{if(!cache.has(key)) {cache.set(key,copy(map[key]));touched.add(key);}return cache.get(key);};
    const set=(key,value)=>{cache.set(key,value);removed.delete(key);touched.add(key);};
    const proxy=new Proxy({},{
      get(target,key,receiver) {return typeof key==='string' && own(key)?get(key):Reflect.get(target,key,receiver);},
      set(target,key,value) {if(typeof key!=='string') return Reflect.set(target,key,value);set(key,value);return true;},
      deleteProperty(target,key) {if(typeof key!=='string') return Reflect.deleteProperty(target,key);if(own(key)) {removed.add(key);cache.delete(key);touched.add(key);}return true;},
      has(target,key) {return (typeof key==='string' && own(key)) || Reflect.has(target,key);},
      ownKeys() {const keys=Object.keys(map).filter(key=>!removed.has(key));for(const key of cache.keys()) if(!Object.hasOwn(map,key)) keys.push(key);return keys;},
      getOwnPropertyDescriptor(target,key) {return typeof key==='string' && own(key)?{get:()=>get(key),set:value=>set(key,value),enumerable:true,configurable:true}:undefined;},
      defineProperty(target,key,descriptor) {if(typeof key!=='string' || !('value' in descriptor)) return false;set(key,descriptor.value);return true;}
    });
    return {proxy,cache,removed,touched};
  }
  function createView(snapshot) {
    const view={},cache=new Map(),touched=new Set(),replaced=new Set(),collections=new Map(),getters=new Map();
    for(const key of Object.keys(snapshot)) {
      const collection=kinds.get(key)==='collection';
      const getter=collection?()=>{if(replaced.has(key)) return cache.get(key);if(!collections.has(key)) collections.set(key,collectionView(snapshot[key]));return collections.get(key).proxy;}:()=>{if(!cache.has(key)) cache.set(key,copy(snapshot[key]));touched.add(key);return cache.get(key);};
      const setter=value=>{if(collection && !replaced.has(key) && value===collections.get(key)?.proxy) return;cache.set(key,value);touched.add(key);if(collection) replaced.add(key);};
      getters.set(key,getter);Object.defineProperty(view,key,{get:getter,set:setter,enumerable:true,configurable:true});
    }
    return {view,cache,touched,replaced,collections,getters,snapshot};
  }
  function commit(draft) {
    const {view,cache,touched,replaced,collections,getters,snapshot}=draft,next={...snapshot},present=new Set(Object.keys(view)),changes=[];
    for(const key of Object.keys(snapshot)) if(!present.has(key)) changes.push({key,remove:true});
    for(const key of present) {
      const managed=getters.has(key) && Object.getOwnPropertyDescriptor(view,key)?.get===getters.get(key);
      if(managed && kinds.get(key)==='collection' && !replaced.has(key)) {const state=collections.get(key);if(state?.touched.size) changes.push({key,entries:state});continue;}
      if(managed && !touched.has(key)) continue;
      changes.push({key,value:managed?cache.get(key):view[key]});
    }
    if(!changes.length) return;
    const updates=[];
    withDb(db=>transaction(db,()=>{
      const sql=statements(db);
      for(const change of changes) {
        if(change.remove) {sql.deleteDoc.run(change.key);sql.clearEntries.run(change.key);updates.push({key:change.key,remove:true});continue;}
        if(change.entries) {
          const strings=entryTexts.get(change.key),map={...snapshot[change.key]},written=new Map();let dirty=false;
          for(const entry of change.entries.touched) {
            const json=change.entries.removed.has(entry)?undefined:JSON.stringify(change.entries.cache.get(entry));
            if(json===undefined) {if(Object.hasOwn(map,entry)) {sql.deleteEntry.run(change.key,entry);delete map[entry];written.set(entry,undefined);dirty=true;}continue;}
            if(strings.get(entry)===json) continue;
            sql.upsertEntry.run(change.key,entry,json);put(map,entry,JSON.parse(json));written.set(entry,json);dirty=true;
          }
          if(dirty) updates.push({key:change.key,entries:written,map});
          continue;
        }
        if(!(COLLECTIONS.has(change.key) && isPlainObject(change.value)) && kinds.get(change.key)==='value' && texts.get(change.key)===JSON.stringify(change.value)) continue;
        updates.push({key:change.key,saved:writeKey(sql,change.key,change.value)});
      }
    }));
    // Só depois da transação confirmada a memória passa a refletir o banco.
    for(const update of updates) {
      if(update.remove) {delete next[update.key];kinds.delete(update.key);texts.delete(update.key);entryTexts.delete(update.key);continue;}
      if(update.entries) {next[update.key]=update.map;const strings=entryTexts.get(update.key);for(const [entry,json] of update.entries) if(json===undefined) strings.delete(entry);else strings.set(entry,json);continue;}
      const saved=update.saved;
      if(!saved.kind) {delete next[update.key];kinds.delete(update.key);texts.delete(update.key);entryTexts.delete(update.key);continue;}
      put(next,update.key,saved.value);kinds.set(update.key,saved.kind);
      if(saved.kind==='collection') {entryTexts.set(update.key,saved.strings);texts.delete(update.key);}else {texts.set(update.key,saved.json);entryTexts.delete(update.key);}
    }
    base=next;
  }
  return {
    store,
    read:async()=>createView(await load()).view,
    update(fn) {
      const operation=queue.then(async()=>{
        const draft=createView(await load()),result=fn(draft.view);
        commit(draft);return detach(result);
      });
      queue=operation.catch(()=>{});return operation;
    }
  };
}

// Atendimento, base de conhecimento e produtos ficam em data/central.sqlite (um store para cada).
// ai.json continua em JSON: guarda só provedor e modelo, e a migração protegida da chave de IA depende dele.
const SQLITE_STORES={'atendimento.json':['atendimento.sqlite','atendimento.json'],'knowledge.json':['knowledge.json'],'produtos.json':['produtos.json']};
function createStore(directory,{file:name='atendimento.json',initial=defaults,engine}={}) {
  const kind=engine || (SQLITE_STORES[name]?'sqlite':'json');
  return kind==='sqlite'?createSqliteStore(directory,{store:name.replace(/\.json$/,''),legacyFiles:SQLITE_STORES[name] || [name],initial}):createJsonStore(directory,{file:name,initial});
}
module.exports={createStore,COLLECTIONS,defaults};
