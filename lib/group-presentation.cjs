const {ApiError,groupJid}=require('./evolution.cjs');

const MAX_GROUPS=5000;
function clean(list) {
  if(!Array.isArray(list) || list.length>MAX_GROUPS || list.some(jid=>typeof jid!=='string' || !groupJid(jid)) || new Set(list).size!==list.length)
    throw new ApiError('Ordem de grupos inválida.',422);
  return [...list];
}
function savedState(data) {
  const value=data?.groupPresentation;
  return {version:2,pinned:Array.isArray(value?.pinned)?[...value.pinned]:[],normal:Array.isArray(value?.normal)?[...value.normal]:[],archived:Array.isArray(value?.archived)?[...value.archived]:[]};
}
function sameMembers(left,right) {
  return left.length===right.length && [...left].sort().every((value,index)=>value===[...right].sort()[index]);
}
function createGroupPresentation({store}) {
  return {
    read:async()=>savedState(await store.read()),
    reconcile:ids=>store.update(data=>{
      const known=clean(ids),current=savedState(data),present=new Set(known);
      const archived=current.archived.filter(groupJid),archivedSet=new Set(archived);
      const pinned=current.pinned.filter(jid=>present.has(jid) && !archivedSet.has(jid));
      const normal=current.normal.filter(jid=>present.has(jid) && !archivedSet.has(jid) && !pinned.includes(jid));
      const ordered=new Set([...pinned,...normal,...archived]);
      normal.push(...known.filter(jid=>!ordered.has(jid)));
      return data.groupPresentation={version:2,pinned,normal,archived};
    }),
    reorder:input=>store.update(data=>{
      if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==3 || Object.keys(input).some(key=>!['pinned','normal','archived'].includes(key))) throw new ApiError('Ordem de grupos inválida.',422);
      const previous=savedState(data),pinned=clean(input.pinned),normal=clean(input.normal),archived=clean(input.archived);
      const all=[...pinned,...normal,...archived];
      if(new Set(all).size!==all.length) throw new ApiError('Ordem de grupos inválida.',422);
      if(!sameMembers(previous.pinned,pinned) || !sameMembers(previous.normal,normal) || !sameMembers(previous.archived,archived)) throw new ApiError('Use o menu do grupo para mudar o bloco.',409);
      return data.groupPresentation={version:2,pinned,normal,archived};
    }),
    setPinned:(jid,pinned)=>store.update(data=>{
      if(typeof jid!=='string' || !groupJid(jid) || typeof pinned!=='boolean') throw new ApiError('Grupo inválido.',422);
      const current=savedState(data);
      if(current.archived.includes(jid)) throw new ApiError('Desarquive o grupo antes de fixá-lo.',409);
      current.pinned=current.pinned.filter(id=>id!==jid);
      current.normal=current.normal.filter(id=>id!==jid);
      (pinned?current.pinned:current.normal).unshift(jid);
      return data.groupPresentation=current;
    }),
    setArchived:(jid,archived)=>store.update(data=>{
      if(typeof jid!=='string' || !groupJid(jid) || typeof archived!=='boolean') throw new ApiError('Grupo inválido.',422);
      const current=savedState(data),already=current.archived.includes(jid);
      if(already===archived) return data.groupPresentation=current;
      current.pinned=current.pinned.filter(id=>id!==jid);
      current.normal=current.normal.filter(id=>id!==jid);
      current.archived=current.archived.filter(id=>id!==jid);
      (archived?current.archived:current.normal).unshift(jid);
      return data.groupPresentation=current;
    })
  };
}

module.exports={createGroupPresentation};
