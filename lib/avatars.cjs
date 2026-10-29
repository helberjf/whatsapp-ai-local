const {assertJid}=require('./evolution.cjs');
function createAvatarService({profileLoader,fetchImpl=fetch}) {
  const cache=new Map(),pending=new Map();
  const empty=()=>({base64:null,mimeType:null});
  async function load(jid) {
    let result=empty();
    try {
      const profile=await profileLoader(jid),raw=profile?.profilePictureUrl || profile?.pictureUrl || profile?.url;
      const url=new URL(raw);
      if(url.protocol!=='https:' || url.username || url.password || url.port || !(url.hostname==='whatsapp.net' || url.hostname.endsWith('.whatsapp.net'))) return result;
      const response=await fetchImpl(url,{signal:AbortSignal.timeout(12000),redirect:'error'});
      const mimeType=String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if(!response.ok || !['image/jpeg','image/png','image/webp'].includes(mimeType) || Number(response.headers.get('content-length'))>1024*1024) {await response.body?.cancel();return result;}
      let size=0;const chunks=[];
      for await(const chunk of response.body || []) {size+=chunk.length;if(size>1024*1024) throw Error('Foto grande');chunks.push(chunk);}
      if(size) result={base64:Buffer.concat(chunks).toString('base64'),mimeType};
    } catch {}
    return result;
  }
  return {
    get(jid) {
      assertJid(jid);const previous=cache.get(jid);
      if(previous && previous.expires>Date.now()) return Promise.resolve(previous.result);
      if(pending.has(jid)) return pending.get(jid);
      const operation=load(jid).then(result=>{cache.set(jid,{result,expires:Date.now()+(result.base64?3600000:300000)});if(cache.size>256) cache.delete(cache.keys().next().value);return result;}).finally(()=>pending.delete(jid));
      pending.set(jid,operation);return operation;
    }
  };
}
module.exports={createAvatarService};
