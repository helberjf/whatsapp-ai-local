const {randomUUID}=require('node:crypto');
const {ApiError,assertJid}=require('./evolution.cjs');

// Etapas e próximo contato adaptados do CRM do menu-hospede para uso pessoal.
const stages=[{id:'new',label:'Novo'},{id:'contacted',label:'Em contato'},{id:'negotiating',label:'Em negociação'},{id:'won',label:'Concluído'},{id:'lost',label:'Não avançou'}];
const has=(value,key)=>Object.hasOwn(value,key);
function crmDetails(contact={}) {
  const value=contact.crm || {};
  return {stage:stages.some(stage=>stage.id===value.stage)?value.stage:'new',followUpAt:value.followUpAt || null,notes:typeof value.notes==='string'?value.notes:'',history:Array.isArray(value.history)?value.history.slice(-100):[]};
}
function createCrmService({store}) {
  return {
    async list(chats=[]) {
      const data=await store.read();
      return {stages:structuredClone(stages),contacts:chats.map(chat=>{
        const contact=data.contacts?.[chat.jid] || {};
        return {...chat,...contact,jid:chat.jid,crm:crmDetails(contact),automationPaused:contact.automationPaused===true};
      })};
    },
    async update(jid,input) {
      assertJid(jid);
      const allowed=['stage','followUpAt','notes','automationPaused'];
      if(!input || typeof input!=='object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key=>!allowed.includes(key))) throw new ApiError('Informe os dados válidos do CRM.',422);
      const patch={};
      if(has(input,'stage')) {if(!stages.some(stage=>stage.id===input.stage)) throw new ApiError('Escolha uma etapa válida.',422);patch.stage=input.stage;}
      if(has(input,'notes')) {if(typeof input.notes!=='string' || input.notes.length>10000) throw new ApiError('As observações devem ter até 10.000 caracteres.',422);patch.notes=input.notes.trim();}
      if(has(input,'automationPaused') && typeof input.automationPaused!=='boolean') throw new ApiError('Informe se o robô deve ficar pausado para este contato.',422);
      if(has(input,'followUpAt')) {
        if(input.followUpAt===null) patch.followUpAt=null;
        else {
          if(typeof input.followUpAt!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.followUpAt) || !Number.isFinite(Date.parse(input.followUpAt))) throw new ApiError('Informe uma data e hora válidas para o próximo contato.',422);
          const day=input.followUpAt.slice(0,10);
          if(new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day || Number(input.followUpAt.slice(11,13))>23) throw new ApiError('Informe uma data e hora válidas para o próximo contato.',422);
          patch.followUpAt=new Date(input.followUpAt).toISOString();
        }
      }
      return store.update(data=>{
        data.contacts ||= {};const contact=data.contacts[jid] ||= {},current=crmDetails(contact),history=current.history;
        for(const [key,type] of [['stage','stage'],['followUpAt','follow_up']]) if(has(patch,key) && patch[key]!==current[key]) history.push({id:randomUUID(),type,from:current[key],to:patch[key],at:new Date().toISOString()});
        contact.crm={...current,...patch,history:history.slice(-100)};
        if(has(input,'automationPaused')) contact.automationPaused=input.automationPaused;
        return {jid,...contact,crm:crmDetails(contact),automationPaused:contact.automationPaused===true};
      });
    }
  };
}
module.exports={createCrmService};
