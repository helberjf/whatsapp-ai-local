const {ApiError,groupJid}=require('./evolution.cjs');

const MAX_GROUPS=5000;
function clean(list) {
  if(!Array.isArray(list) || list.length>MAX_GROUPS || list.some(jid=>typeof jid!=='string' || !groupJid(jid)) || new Set(list).size!==list.length)
    throw new ApiError('Ordem de grupos inválida.',422);
  return [...list];
}
function savedState(data) {
  const value=data?.groupPresentation;
  return {version:1,pinned:Array.isArray(value?.pinned)?[...value.pinned]:[],normal:Array.isArray(value?.normal)?[...value.normal]:[]};
}
function sameMembers(left,right) {
  return left.length===right.length && [...left].sort().every((value,index)=>value===[...right].sort()[index]);
}
function createGroupPresentation({store}) {
  return {
    read:async()=>savedState(await store.read()),
    reconcile:ids=>store.update(data=>{
      const known=clean(ids),current=savedState(data),present=new Set(known);
      const pinned=current.pinned.filter(jid=>present.has(jid));
      const normal=current.normal.filter(jid=>present.has(jid) && !pinned.includes(jid));
      const ordered=new Set([...pinned,...normal]);
      normal.push(...known.filter(jid=>!ordered.has(jid)));
      return data.groupPresentation={version:1,pinned,normal};
    }),
    reorder:input=>store.update(data=>{
      if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['pinned','normal'].includes(key))) throw new ApiError('Ordem de grupos inválida.',422);
      const previous=savedState(data),pinned=clean(input.pinned),normal=clean(input.normal);
      if(pinned.some(jid=>normal.includes(jid))) throw new ApiError('Ordem de grupos inválida.',422);
      if(!sameMembers(previous.pinned,pinned)) throw new ApiError('Use Fixar ou Desafixar para mudar o bloco.',409);
      if(!sameMembers([...previous.pinned,...previous.normal],[...pinned,...normal])) throw new ApiError('Atualize a lista de grupos e tente novamente.',409);
      return data.groupPresentation={version:1,pinned,normal};
    }),
    setPinned:(jid,pinned)=>store.update(data=>{
      if(typeof jid!=='string' || !groupJid(jid) || typeof pinned!=='boolean') throw new ApiError('Grupo inválido.',422);
      const current=savedState(data);
      current.pinned=current.pinned.filter(id=>id!==jid);
      current.normal=current.normal.filter(id=>id!==jid);
      (pinned?current.pinned:current.normal).unshift(jid);
      return data.groupPresentation=current;
    })
  };
}

module.exports={createGroupPresentation};
