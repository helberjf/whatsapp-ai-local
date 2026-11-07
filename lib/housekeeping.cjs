// Limpeza das reservas que só servem para não responder a mesma mensagem duas vezes.
// Uma mensagem só pode ser tratada nos primeiros 15 minutos (atrasos de gatilho chegam a 24 h); guardar 3 dias sobra com folga.
const DAY=86_400_000;
const RETENTION={claimDays:3,requestDays:7};
const timeOf=value=>typeof value==='number'?value:Date.parse(value || '');
function pruneState(data,now=Date.now(),{claimDays=RETENTION.claimDays,requestDays=RETENTION.requestDays}={}) {
  const removed={replyClaims:0,processed:0,requests:0},claimCutoff=now-claimDays*DAY,requestCutoff=now-requestDays*DAY;
  // Só remove o que tem data e está fora do prazo; registros sem data ficam para não perder uma deduplicação.
  const old=(value,cutoff)=>Number.isFinite(timeOf(value)) && timeOf(value)<cutoff;
  if(data.replyClaims) for(const key of Object.keys(data.replyClaims)) if(old(data.replyClaims[key]?.claimedAt,claimCutoff)) {delete data.replyClaims[key];removed.replyClaims++;}
  for(const name of ['triggers','automation']) {
    const processed=data[name]?.processed;if(!processed) continue;
    for(const key of Object.keys(processed)) if(old(processed[key]?.at,claimCutoff)) {delete processed[key];removed.processed++;}
  }
  if(data.requests) for(const key of Object.keys(data.requests)) if(old(data.requests[key]?.at,requestCutoff)) {delete data.requests[key];removed.requests++;}
  return removed;
}
module.exports={pruneState,RETENTION};
