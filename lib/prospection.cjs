const {ApiError}=require('./evolution.cjs');
const ENDPOINT='http://127.0.0.1:3000/api/outreach/review-batch';
function assertProspectionAccount(account,config={}) {
  const allowed=config.prospectionAccountId?account.id===config.prospectionAccountId:String(account.name).trim().toLocaleLowerCase('pt-BR')==='suporte';
  if(!allowed) throw new ApiError('Os rascunhos de prospecção estão disponíveis somente na conta suporte. Troque de conta para continuar.',403);
}
async function prospectionDrafts({account,config={},method,input,fetchImpl=fetch}) {
  assertProspectionAccount(account,config);
  if(!['GET','POST','PATCH'].includes(method)) throw new ApiError('Método não permitido para rascunhos de prospecção.',405);
  if(typeof config.integrationToken!=='string' || config.integrationToken.length<32) throw new ApiError('Configure a integração local de prospecção para acessar os rascunhos.',503);
  let body;
  if(method==='POST') body={};
  if(method==='PATCH') {
    if(typeof input?.messageId!=='string' || !input.messageId.trim() || input.messageId.length>200 || typeof input.body!=='string' || !input.body.trim() || input.body.length>10000 || typeof input.expectedBody!=='string' || input.expectedBody.length>10000) throw new ApiError('Informe o rascunho, o texto revisado e a versão original da mensagem.',422);
    body={messageId:input.messageId,body:input.body,expectedBody:input.expectedBody};
  }
  let response,data;
  try {
    response=await fetchImpl(ENDPOINT,{method,headers:{'X-Integration-Token':config.integrationToken,'X-WhatsApp-Account':account.id,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(method==='POST'?90000:15000),...(body?{body:JSON.stringify(body)}:{})});
  } catch {throw new ApiError('O sistema de prospecção está indisponível. Abra a prospecção neste computador e tente novamente.',502);}
  if(!response.ok) {
    const errors={401:'A integração de prospecção precisa ser configurada novamente.',403:'A conta suporte não está autorizada na integração de prospecção.',409:'Este rascunho foi alterado no sistema de prospecção. Preserve seu texto e atualize a fila antes de tentar novamente.',422:'O sistema de prospecção não aceitou os dados deste rascunho.',503:'O sistema de prospecção ainda não está configurado para esta integração.'};
    throw new ApiError(errors[response.status] || 'O sistema de prospecção não conseguiu concluir a solicitação. Tente novamente.',errors[response.status]?response.status:502);
  }
  try {data=await response.json();} catch {throw new ApiError('O sistema de prospecção retornou uma resposta inválida.',502);}
  if(!data || data.accountId!==account.id || !Array.isArray(data.items) || data.items.length>10 || data.items.some(item=>!item || ['messageId','conversationId','businessId','name','phone','body'].some(key=>typeof item[key]!=='string'))) throw new ApiError('O sistema de prospecção retornou uma fila inválida para esta conta.',502);
  return data;
}
module.exports={prospectionDrafts,assertProspectionAccount};
