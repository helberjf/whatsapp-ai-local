const {createHash,randomBytes}=require('node:crypto');
// A tela pede só o que mudou desde a última versão que recebeu. Guarda poucas versões (só hashes) em memória.
function createChatDelta({keep=8}={}) {
  const prefix=randomBytes(4).toString('hex'),versions=new Map();let counter=0,latest=null;
  const digest=chat=>createHash('sha1').update(JSON.stringify(chat)).digest('base64');
  const same=(a,b)=>a.size===b.size && [...b].every(([jid,hash])=>a.get(jid)===hash);
  return {
    diff(list,since) {
      const hashes=new Map(list.map(chat=>[chat.jid,digest(chat)]));
      if(!latest || !same(latest.hashes,hashes)) {
        latest={id:prefix+'-'+(++counter),hashes};versions.set(latest.id,hashes);
        while(versions.size>keep) versions.delete(versions.keys().next().value);
      }
      const previous=since?versions.get(since):null;
      if(!previous) return {version:latest.id,full:true,chats:list};
      return {version:latest.id,full:false,changed:list.filter(chat=>previous.get(chat.jid)!==hashes.get(chat.jid)),removed:[...previous.keys()].filter(jid=>!hashes.has(jid))};
    }
  };
}
module.exports={createChatDelta};
