const {ApiError,assertJid}=require('./evolution.cjs');
async function prepareForward(client,input) {
  const sourceJid=assertJid(input.sourceJid),targetJid=assertJid(input.targetJid),id=input.messageId;
  if(typeof id!=='string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(id) || id.includes('..')) throw new ApiError('Mensagem de origem inválida.',422);
  const message=await client.message(sourceJid,id);
  if(message?.jid!==sourceJid || message.id!==id) throw new ApiError('Mensagem de origem não encontrada nesta conversa.',404);
  if(message.canForward===false) throw new ApiError('Este tipo de mensagem não pode ser encaminhado pela central. Use o WhatsApp para encaminhar o original.',422);
  if(message.type==='text') {
    if(typeof message.text!=='string' || !message.text.trim() || message.text.length>10000) throw new ApiError('Esta mensagem não possui texto disponível para encaminhar.',422);
    return ()=>client.sendText(targetJid,message.text);
  }
  if(!['image','audio','video','document','sticker'].includes(message.type)) throw new ApiError('Este tipo de mensagem não pode ser encaminhado pela central.',422);
  const media=await client.media(sourceJid,id),base64=String(media.base64 || '').replace(/^data:[^,]*,/,'').replace(/[\r\n]/g,'');
  if(!base64 || Buffer.byteLength(base64,'base64')>10*1024*1024 || base64.length%4 || /[^A-Za-z0-9+/=]/.test(base64) || Buffer.from(base64,'base64').toString('base64')!==base64) throw new ApiError('Anexo indisponível ou maior que 10 MB. Abra o original no celular.',422);
  if(message.type==='sticker') return ()=>client.sendSticker(targetJid,{base64});
  const mimeType=String(media.mimetype || media.mimeType || message.mimeType || 'application/octet-stream').split(';')[0].trim();
  if(!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new ApiError('Tipo do anexo original inválido.',422);
  const fileName=String(media.fileName || message.fileName || {image:'imagem.jpg',audio:'audio.ogg',video:'video.mp4',document:'documento'}[message.type]).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,180);
  const caption=message.type==='document' && message.text===message.fileName?'':String(message.text || '').slice(0,4000);
  return ()=>client.sendMedia(targetJid,{base64,mimeType,fileName,caption,mediaType:message.type});
}
async function forwardMessage(client,input) {return (await prepareForward(client,input))();}
module.exports={forwardMessage,prepareForward};
