const {randomUUID,randomBytes}=require('node:crypto');
const {ApiError,assertJid}=require('./evolution.cjs');

// Vendas com IA: qualificação de leads, agenda de reuniões, cobrança por Pix e envio de contrato.
// A IA não executa nada sozinha: ela escreve uma marcação ([[LEAD: …]], [[AGENDAR: …]], [[PIX: …]], [[CONTRATO]])
// e a central confere tudo antes de agir. Horário fora da agenda, valor fora do catálogo ou recurso desligado
// viram pedido de atendente, nunca um envio. Tudo começa desligado.
const WEEKDAYS=['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
const KEY_TYPES=['cpf','cnpj','email','phone','random'];
const LABELS={lead:'Lead qualificado',meeting:'Reunião agendada',pix:'Pix enviado',contract:'Contrato enviado'};
const MAX_CONTRACT_BYTES=2*1024*1024,NOTICE_MS=2*3600_000,HOUR=3600_000;
const LIMITS={pix:3,contract:2};
const MARKER=/\[\[\s*(LEAD|AGENDAR|PIX|CONTRATO)\s*(?::\s*([^\]]*))?\]\]/gi;

const defaults=()=>({
  qualify:{enabled:false},
  agenda:{enabled:false,subject:'uma reunião',days:[1,2,3,4,5],start:'09:00',end:'18:00',slotMinutes:30,horizonDays:7,timezone:'America/Sao_Paulo',note:''},
  pix:{enabled:false,keyType:'cpf',key:'',name:'',city:'',description:''},
  contract:{enabled:false,message:'Segue o contrato para assinatura. Qualquer dúvida, é só chamar.',link:'',file:null},
  appointments:[],sent:{},log:[]
});
function settingsOf(data) {
  const base=defaults(),saved=data.sales || {};
  return {qualify:{...base.qualify,...saved.qualify},agenda:{...base.agenda,...saved.agenda},pix:{...base.pix,...saved.pix},contract:{...base.contract,...saved.contract},
    appointments:Array.isArray(saved.appointments)?saved.appointments:[],sent:saved.sent || {},log:Array.isArray(saved.log)?saved.log:[]};
}
const fail=message=>{throw new ApiError(message,422);};
const money=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value).replace(/ /g,' ');
const pad=value=>String(value).padStart(2,'0');
const minutesOf=value=>Number(value.slice(0,2))*60+Number(value.slice(3));

// ---------- Pix "copia e cola" (BR Code estático, padrão do Banco Central) ----------
const ascii=(text,max)=>String(text).normalize('NFD').replace(/\p{M}/gu,'').replace(/[^A-Za-z0-9 $%*+\-./:]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const field=(id,value)=>id+pad(value.length)+value;
function crc16(text) {
  let crc=0xFFFF;
  for(const char of Buffer.from(text,'utf8')) {crc^=char<<8;for(let bit=0;bit<8;bit++) crc=crc&0x8000?((crc<<1)^0x1021)&0xFFFF:(crc<<1)&0xFFFF;}
  return crc.toString(16).toUpperCase().padStart(4,'0');
}
function normalizeKey(type,value) {
  const raw=String(value ?? '').trim(),digits=raw.replace(/\D/g,'');
  if(type==='cpf') {if(digits.length!==11) fail('Chave Pix: o CPF precisa ter 11 números.');return digits;}
  if(type==='cnpj') {if(digits.length!==14) fail('Chave Pix: o CNPJ precisa ter 14 números.');return digits;}
  if(type==='email') {if(!/^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,}$/.test(raw) || raw.length>77) fail('Chave Pix: informe um e-mail válido.');return raw.toLowerCase();}
  if(type==='phone') {
    const local=digits.length>=12 && digits.startsWith('55')?digits.slice(2):digits;
    if(local.length<10 || local.length>11) fail('Chave Pix: informe o celular com DDD.');return '+55'+local;
  }
  if(type==='random') {if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) fail('Chave Pix: a chave aleatória tem o formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.');return raw.toLowerCase();}
  return fail('Escolha o tipo da chave Pix.');
}
function pixCode({key,name,city,description='',amount=null,txid='***'}) {
  const account=field('00','br.gov.bcb.pix')+field('01',key)+(description?field('02',ascii(description,40)):'');
  const payload=field('00','01')+field('26',account)+field('52','0000')+field('53','986')+(amount?field('54',amount.toFixed(2)):'')+field('58','BR')
    +field('59',ascii(name,25).toUpperCase())+field('60',ascii(city,15).toUpperCase())+field('62',field('05',txid))+'6304';
  return payload+crc16(payload);
}
// Aceita "199,90", "R$ 1.234,56" e "199.90"; devolve o valor em reais ou null.
function parseAmount(value) {
  const clean=String(value ?? '').replace(/[^\d,.]/g,'');if(!clean) return null;
  const number=Number(clean.includes(',')?clean.replace(/\./g,'').replace(',','.'):/^\d+\.\d{1,2}$/.test(clean)?clean:clean.replace(/\./g,''));
  return Number.isFinite(number) && number>0 && number<=10_000_000?Math.round(number*100)/100:null;
}

// ---------- Agenda ----------
function zoned(at,timezone) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));
  return {year:Number(parts.year),month:Number(parts.month),day:Number(parts.day),hour:Number(parts.hour),minute:Number(parts.minute)};
}
// Data e hora "de parede" no fuso escolhido → instante real.
function toInstant(year,month,day,hour,minute,timezone) {
  const wanted=Date.UTC(year,month-1,day,hour,minute);let guess=wanted;
  for(let pass=0;pass<2;pass++) {const seen=zoned(guess,timezone);guess-=Date.UTC(seen.year,seen.month-1,seen.day,seen.hour,seen.minute)-wanted;}
  return guess;
}
const slotKey=(at,timezone)=>{const local=zoned(at,timezone);return `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}`;};
function slotLabel(at,timezone) {
  const local=zoned(at,timezone),weekday=WEEKDAYS[new Date(Date.UTC(local.year,local.month-1,local.day)).getUTCDay()];
  return `${weekday}, ${pad(local.day)}/${pad(local.month)} às ${pad(local.hour)}:${pad(local.minute)}`;
}
function freeSlots(agenda,appointments,now) {
  const today=zoned(now,agenda.timezone),first=minutesOf(agenda.start),last=minutesOf(agenda.end),slots=[];
  const busy=appointments.filter(item=>item.status==='confirmed').map(item=>[Date.parse(item.start),Date.parse(item.end)]);
  for(let offset=0;offset<=agenda.horizonDays;offset++) {
    const date=new Date(Date.UTC(today.year,today.month-1,today.day+offset));
    if(!agenda.days.includes(date.getUTCDay())) continue;
    for(let minute=first;minute+agenda.slotMinutes<=last;minute+=agenda.slotMinutes) {
      const start=toInstant(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate(),Math.floor(minute/60),minute%60,agenda.timezone),end=start+agenda.slotMinutes*60_000;
      if(start<now+NOTICE_MS || busy.some(([from,to])=>start<to && end>from)) continue;
      slots.push({start,end,key:slotKey(start,agenda.timezone)});
    }
  }
  return slots;
}

// ---------- Marcações da IA ----------
function parse(raw) {
  const actions=[];
  const text=String(raw ?? '').replace(MARKER,(match,kind,value)=>{actions.push({kind:kind.toLowerCase(),value:(value || '').trim()});return '';}).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return {text,actions};
}
const describe=actions=>actions.map(action=>({lead:'marcar como lead qualificado',agendar:'agendar '+action.value,pix:'enviar Pix de '+action.value,contrato:'enviar o contrato'}[action.kind])).join('; ');

function validate(input,current) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['qualify','agenda','pix','contract'].includes(key))) fail('Configuração de vendas inválida.');
  const bool=(value,label)=>{if(typeof value!=='boolean') fail(label+': use ligado ou desligado.');return value;};
  const text=(value,max,label)=>{if(typeof value!=='string' || value.length>max) fail(`${label}: use até ${max} caracteres.`);return value.trim();};
  const next={qualify:{...current.qualify},agenda:{...current.agenda},pix:{...current.pix},contract:{...current.contract}};
  if(input.qualify?.enabled!==undefined) next.qualify.enabled=bool(input.qualify.enabled,'Qualificação');
  if(input.agenda) {
    const agenda=input.agenda,target=next.agenda;
    if(agenda.enabled!==undefined) target.enabled=bool(agenda.enabled,'Agenda');
    if(agenda.subject!==undefined) target.subject=text(agenda.subject,80,'O que será agendado') || 'uma reunião';
    if(agenda.note!==undefined) target.note=text(agenda.note,500,'Instruções da reunião');
    if(agenda.days!==undefined) {if(!Array.isArray(agenda.days) || !agenda.days.length || agenda.days.some(day=>!Number.isInteger(day) || day<0 || day>6)) fail('Agenda: escolha ao menos um dia da semana.');target.days=[...new Set(agenda.days)].sort();}
    for(const key of ['start','end']) if(agenda[key]!==undefined) {if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(agenda[key] || '')) fail('Agenda: informe horários válidos.');target[key]=agenda[key];}
    if(agenda.slotMinutes!==undefined) {if(![15,20,30,45,60,90,120].includes(agenda.slotMinutes)) fail('Agenda: escolha uma duração válida.');target.slotMinutes=agenda.slotMinutes;}
    if(agenda.horizonDays!==undefined) {if(!Number.isInteger(agenda.horizonDays) || agenda.horizonDays<1 || agenda.horizonDays>30) fail('Agenda: ofereça horários para 1 a 30 dias.');target.horizonDays=agenda.horizonDays;}
    if(agenda.timezone!==undefined) {try {new Intl.DateTimeFormat('pt-BR',{timeZone:agenda.timezone});}catch {fail('Agenda: fuso horário inválido.');}target.timezone=agenda.timezone;}
    if(minutesOf(target.start)+target.slotMinutes>minutesOf(target.end)) fail('Agenda: o horário final precisa caber ao menos uma reunião depois do inicial.');
  }
  if(input.pix) {
    const pix=input.pix,target=next.pix;
    if(pix.enabled!==undefined) target.enabled=bool(pix.enabled,'Pix');
    if(pix.keyType!==undefined) {if(!KEY_TYPES.includes(pix.keyType)) fail('Escolha o tipo da chave Pix.');target.keyType=pix.keyType;}
    if(pix.key!==undefined) target.key=text(pix.key,80,'Chave Pix');
    if(pix.name!==undefined) target.name=text(pix.name,25,'Nome do recebedor');
    if(pix.city!==undefined) target.city=text(pix.city,15,'Cidade');
    if(pix.description!==undefined) target.description=text(pix.description,40,'Descrição do Pix');
    if(target.key) target.key=normalizeKey(target.keyType,target.key);
    if(target.enabled && (!target.key || !ascii(target.name,25) || !ascii(target.city,15))) fail('Para ligar o Pix, preencha a chave, o nome do recebedor e a cidade (como estão no banco).');
  }
  if(input.contract) {
    const contract=input.contract,target=next.contract;
    if(contract.enabled!==undefined) target.enabled=bool(contract.enabled,'Contrato');
    if(contract.message!==undefined) target.message=text(contract.message,1000,'Mensagem do contrato');
    if(contract.link!==undefined) {const link=text(contract.link,500,'Link de assinatura');if(link && !/^https:\/\/[^\s]+$/.test(link)) fail('Link de assinatura: use um endereço https://.');target.link=link;}
    if(contract.file===null) target.file=null;
    else if(contract.file!==undefined) {
      const file=contract.file;
      if(!file || typeof file.base64!=='string' || !file.base64.length || file.base64.length%4!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64) || Buffer.byteLength(file.base64,'base64')>MAX_CONTRACT_BYTES) fail('Contrato: envie um arquivo de até 2 MB.');
      if(typeof file.fileName!=='string' || !file.fileName.trim() || file.fileName.length>160 || /[\x00-\x1f\/\\]/.test(file.fileName) || typeof file.mimeType!=='string' || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) || file.mimeType.length>100) fail('Contrato: arquivo inválido.');
      target.file={base64:file.base64,mimeType:file.mimeType,fileName:file.fileName.trim()};
    }
    if(target.enabled && !target.link && !target.file) fail('Para ligar o contrato, anexe o arquivo ou informe o link de assinatura.');
    if(target.enabled && !target.message) fail('Escreva a mensagem que acompanha o contrato.');
  }
  return next;
}

function createSalesService({store,client,products=async()=>[],now=Date.now}) {
  const log=(data,entry)=>{data.sales ||= {};data.sales.log=[{at:new Date(now()).toISOString(),...entry},...(data.sales.log || [])].slice(0,80);};
  const prices=async()=>(await products()).filter(item=>item.active!==false && item.price!==null && item.price!==undefined).map(item=>Math.round(item.price*(100-(item.discountPercent || 0)))/100).filter(value=>value>0);
  const recent=(settings,jid,kind)=>(settings.sent?.[jid]?.[kind] || []).filter(time=>now()-time<HOUR);

  function touchContact(data,jid,{stage,from=['new'],label,followUpAt,note}={}) {
    data.contacts ||= {};const contact=data.contacts[jid] ||= {status:'open',labels:[],notes:[]},crm=contact.crm ||= {},at=new Date(now()).toISOString();
    crm.history=Array.isArray(crm.history)?crm.history:[];
    const current=crm.stage || 'new';
    if(stage && from.includes(current)) {crm.history.push({id:randomUUID(),type:'stage',from:current,to:stage,at});crm.stage=stage;}
    if(followUpAt && followUpAt!==crm.followUpAt) {crm.history.push({id:randomUUID(),type:'follow_up',from:crm.followUpAt || null,to:followUpAt,at});crm.followUpAt=followUpAt;}
    if(note) crm.notes=[crm.notes,note].filter(Boolean).join('\n').slice(-10000);
    crm.history=crm.history.slice(-100);
    const labels=Array.isArray(contact.labels)?contact.labels:[];
    if(label && !labels.includes(label)) contact.labels=[...labels.slice(0,9),label];
  }
  function pixMessages(settings,amount) {
    const txid='WA'+randomBytes(5).toString('hex').toUpperCase(),code=pixCode({...settings.pix,amount,txid});
    return {txid,messages:[{type:'text',text:`Pix${amount?' de '+money(amount):''} para ${settings.pix.name}.\nCopie o código da próxima mensagem e cole no app do seu banco, em Pix Copia e Cola. Depois é só me enviar o comprovante.`},{type:'text',text:code}]};
  }
  function contractMessages(settings) {
    const {message,link,file}=settings.contract,text=[message,link].filter(Boolean).join('\n');
    return file?[{type:'document',...file,caption:text.slice(0,1000)}]:[{type:'text',text}];
  }
  const deliver=async(jid,messages)=>{for(const message of messages) {if(message.type==='text') await client.sendText(jid,message.text);else {const {type,...media}=message;await client.sendMedia(jid,{...media,mediaType:type});}}};

  // Trecho das instruções da IA com as ferramentas ligadas; vazio quando nada está ligado.
  async function prompt() {
    const settings=settingsOf(await store.read()),tools=[];
    if(settings.qualify.enabled) tools.push('- Qualificação: quando o cliente já tiver dito o que precisa e mostrar interesse real em contratar ou comprar, acrescente [[LEAD: resumo, em uma frase, do que ele quer]]. Use uma única vez por conversa.');
    if(settings.agenda.enabled) {
      const slots=freeSlots(settings.agenda,settings.appointments,now()),perDay=new Map();
      for(const slot of slots) {const day=slot.key.slice(0,10);if(!perDay.has(day)) perDay.set(day,[]);if(perDay.get(day).length<8) perDay.get(day).push(slot);}
      const lines=[...perDay.values()].slice(0,6).flat().map(slot=>`  ${slot.key} → ${slotLabel(slot.start,settings.agenda.timezone)}`);
      tools.push(lines.length
        ?`- Agenda: agora são ${slotLabel(now(),settings.agenda.timezone)}. Para marcar ${settings.agenda.subject} (${settings.agenda.slotMinutes} minutos), ofereça somente horários livres desta lista e escreva a hora no formato HH:MM:\n${lines.join('\n')}\n  Quando o cliente escolher um horário da lista, confirme na resposta e acrescente [[AGENDAR: AAAA-MM-DD HH:MM]] com esse horário. Nunca marque nem prometa horário fora da lista.`
        :`- Agenda: não há horários livres para ${settings.agenda.subject} nos próximos dias. Se o cliente quiser marcar, responda apenas [[HUMANO]].`);
    }
    if(settings.pix.enabled) tools.push('- Pix: quando o cliente confirmar que quer pagar um item do <catalogo> que tem preço definido, diga que está enviando o código Pix e acrescente [[PIX: valor]] com o valor exato do catálogo (exemplo: [[PIX: 199,90]]). Nunca escreva chave ou código Pix: a central envia. Para valor sob consulta, orçamento, mais de um item ou desconto, responda apenas [[HUMANO]]. Nunca diga que um pagamento foi confirmado: quem confere o comprovante é um atendente.');
    if(settings.contract.enabled) tools.push('- Contrato: quando o cliente aceitar a proposta e pedir o contrato para assinar, diga que está enviando e acrescente [[CONTRATO]].');
    return tools.length?'Ferramentas de venda. Cada marcação entre colchetes duplos vai sozinha na última linha da resposta; o cliente não a vê e a central executa a ação. Use só quando o cliente pedir ou confirmar:\n'+tools.join('\n'):'';
  }

  // Confere as marcações sem executar nada. Qualquer problema vira {problem}: a conversa segue para um atendente.
  async function plan(jid,actions) {
    const settings=settingsOf(await store.read()),steps=[],seen=new Set();
    for(const action of actions) {
      if(seen.has(action.kind)) continue;seen.add(action.kind);
      if(action.kind==='lead') {if(settings.qualify.enabled) steps.push({kind:'lead',summary:action.value.slice(0,300)});continue;}
      if(action.kind==='agendar') {
        if(!settings.agenda.enabled) return {problem:'A IA tentou agendar, mas a agenda está desligada.'};
        const key=action.value.replace('T',' ').slice(0,16),slot=freeSlots(settings.agenda,settings.appointments.filter(item=>item.jid!==jid),now()).find(item=>item.key===key);
        if(!slot) return {problem:`A IA tentou agendar "${action.value}", que não é um horário livre da agenda.`};
        steps.push({kind:'agendar',slot});continue;
      }
      if(action.kind==='pix') {
        if(!settings.pix.enabled) return {problem:'A IA tentou enviar um Pix, mas a cobrança por Pix está desligada.'};
        const amount=parseAmount(action.value);
        if(!amount || !(await prices()).some(price=>Math.round(price*100)===Math.round(amount*100))) return {problem:`A IA tentou cobrar "${action.value}" por Pix, valor que não é o preço de nenhum item do catálogo.`};
        if(recent(settings,jid,'pix').length>=LIMITS.pix) return {problem:'Limite de códigos Pix por hora para este contato.'};
        steps.push({kind:'pix',amount});continue;
      }
      if(action.kind==='contrato') {
        if(!settings.contract.enabled) return {problem:'A IA tentou enviar o contrato, mas o envio de contrato está desligado.'};
        if(recent(settings,jid,'contract').length>=LIMITS.contract) return {problem:'Limite de envios de contrato por hora para este contato.'};
        steps.push({kind:'contrato'});
      }
    }
    return {steps};
  }

  // Executa o que foi conferido, depois que a resposta da IA saiu. Devolve um resumo para o registro do assistente.
  async function execute(jid,steps=[],{name=''}={}) {
    const done=[];
    await store.update(data=>{if(settingsOf(data).qualify.enabled) touchContact(data,jid,{stage:'contacted'});});
    for(const step of steps) {
      const settings=settingsOf(await store.read());
      if(step.kind==='lead') {
        const fresh=await store.update(data=>{const labels=data.contacts?.[jid]?.labels || [];if(labels.includes(LABELS.lead)) return false;touchContact(data,jid,{stage:'negotiating',from:['new','contacted'],label:LABELS.lead,note:step.summary?'Lead qualificado pela IA: '+step.summary:''});log(data,{jid,action:'lead',detail:step.summary || 'Lead qualificado.'});return true;});
        if(fresh) done.push('lead qualificado');
      }
      if(step.kind==='agendar') {
        const booked=await store.update(data=>{
          const current=settingsOf(data),start=step.slot.start,end=step.slot.end;
          if(current.appointments.some(item=>item.status==='confirmed' && item.jid!==jid && start<Date.parse(item.end) && end>Date.parse(item.start))) return null;
          // Um compromisso futuro por contato: marcar outro horário é remarcar.
          for(const item of current.appointments) if(item.jid===jid && item.status==='confirmed' && Date.parse(item.start)>now()) item.status='cancelled';
          const appointment={id:randomUUID(),jid,name:String(name).slice(0,160),start:new Date(start).toISOString(),end:new Date(end).toISOString(),status:'confirmed',source:'ai',createdAt:new Date(now()).toISOString()};
          data.sales ||= {};data.sales.appointments=[...current.appointments,appointment].slice(-500);
          touchContact(data,jid,{stage:'negotiating',from:['new','contacted'],label:LABELS.meeting,followUpAt:appointment.start});
          log(data,{jid,action:'meeting',detail:'Agendado para '+slotLabel(start,current.agenda.timezone)+'.'});return appointment;
        });
        if(!booked) {await store.update(data=>log(data,{jid,action:'error',detail:'O horário escolhido acabou de ser ocupado. Confirme outro horário com o cliente.'}));done.push('horário ocupado: confirme outro');continue;}
        await deliver(jid,[{type:'text',text:`✅ Agendado: ${slotLabel(step.slot.start,settings.agenda.timezone)}.`+(settings.agenda.note?'\n'+settings.agenda.note:'')}]);
        done.push('reunião agendada');
      }
      if(step.kind==='pix' || step.kind==='contrato') {
        const kind=step.kind==='pix'?'pix':'contract',pix=kind==='pix'?pixMessages(settings,step.amount):null;
        await store.update(data=>{data.sales ||= {};const sent=data.sales.sent ||= {},entry=sent[jid] ||= {};entry[kind]=[...(entry[kind] || []).filter(time=>now()-time<HOUR),now()];});
        await deliver(jid,pix?pix.messages:contractMessages(settings));
        await store.update(data=>{
          touchContact(data,jid,{stage:'negotiating',from:['new','contacted'],label:LABELS[kind]});
          if(pix) data.contacts[jid].status='pending';
          log(data,{jid,action:kind,detail:pix?`Pix de ${money(step.amount)} enviado (identificador ${pix.txid}). Confira o comprovante.`:'Contrato enviado para assinatura.'});
        });
        done.push(pix?'Pix de '+money(step.amount)+' enviado':'contrato enviado');
      }
    }
    return done;
  }

  async function view() {
    const settings=settingsOf(await store.read()),{file,...contract}=settings.contract;
    return {
      qualify:settings.qualify,agenda:settings.agenda,pix:settings.pix,
      contract:{...contract,file:file?{fileName:file.fileName,mimeType:file.mimeType,bytes:Buffer.byteLength(file.base64,'base64')}:null},
      appointments:settings.appointments.filter(item=>item.status==='confirmed' && Date.parse(item.end)>now()-HOUR).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)).map(item=>({...item,label:slotLabel(Date.parse(item.start),settings.agenda.timezone)})),
      nextSlots:settings.agenda.enabled?freeSlots(settings.agenda,settings.appointments,now()).slice(0,6).map(slot=>slotLabel(slot.start,settings.agenda.timezone)):[],
      log:settings.log.slice(0,30)
    };
  }
  async function save(input) {
    const next=validate(input,settingsOf(await store.read()));
    await store.update(data=>{data.sales={...data.sales,...next};});
    return view();
  }
  async function handle(req,route,url,readBody) {
    const ok=(body,status=200)=>({status,body});
    if(route==='/api/sales' && req.method==='GET') return ok(await view());
    if(route==='/api/sales' && req.method==='PUT') return ok(await save(await readBody(req)));
    if(route==='/api/sales/appointments' && req.method==='DELETE') {
      const id=url.searchParams.get('id');
      const found=await store.update(data=>{const item=settingsOf(data).appointments.find(entry=>entry.id===id && entry.status==='confirmed');if(!item) return false;item.status='cancelled';log(data,{jid:item.jid,action:'cancelled',detail:'Compromisso cancelado na central. Avise o cliente.'});return true;});
      if(!found) throw new ApiError('Compromisso não encontrado.',404);
      return ok(await view());
    }
    // Código de exemplo para conferir no app do banco antes de ligar a cobrança.
    if(route==='/api/sales/pix/preview' && req.method==='POST') {
      const input=await readBody(req),settings=settingsOf(await store.read());
      if(!settings.pix.key || !settings.pix.name || !settings.pix.city) throw new ApiError('Salve antes a chave, o nome e a cidade do Pix.',409);
      const amount=input.amount===undefined || input.amount===''?null:parseAmount(input.amount);
      if(input.amount!==undefined && input.amount!=='' && !amount) throw new ApiError('Informe um valor válido.',422);
      return ok({code:pixCode({...settings.pix,amount,txid:'TESTE'}),amount});
    }
    // Envio manual pelo atendente: Pix (com ou sem valor) ou contrato para a conversa escolhida.
    if(route==='/api/sales/send' && req.method==='POST') {
      const input=await readBody(req),jid=assertJid(input.jid),settings=settingsOf(await store.read());
      if(input.kind==='pix') {
        if(!settings.pix.key || !settings.pix.name || !settings.pix.city) throw new ApiError('Configure a chave Pix antes de enviar.',409);
        const amount=input.amount===undefined || input.amount===''?null:parseAmount(input.amount);
        if(input.amount!==undefined && input.amount!=='' && !amount) throw new ApiError('Informe um valor válido.',422);
        const pix=pixMessages(settings,amount);await deliver(jid,pix.messages);
        await store.update(data=>{touchContact(data,jid,{stage:'negotiating',from:['new','contacted'],label:LABELS.pix});log(data,{jid,action:'pix',detail:`Pix${amount?' de '+money(amount):' sem valor'} enviado pelo atendente (identificador ${pix.txid}).`});});
        return ok({sent:true,kind:'pix',amount});
      }
      if(input.kind==='contract') {
        if(!settings.contract.link && !settings.contract.file) throw new ApiError('Anexe o contrato ou informe o link de assinatura antes de enviar.',409);
        await deliver(jid,contractMessages(settings));
        await store.update(data=>{touchContact(data,jid,{stage:'negotiating',from:['new','contacted'],label:LABELS.contract});log(data,{jid,action:'contract',detail:'Contrato enviado pelo atendente.'});});
        return ok({sent:true,kind:'contract'});
      }
      throw new ApiError('Escolha enviar Pix ou contrato.',422);
    }
    return undefined;
  }
  return {prompt,parse,plan,execute,describe,view,save,handle};
}
module.exports={createSalesService,pixCode,crc16,normalizeKey,parseAmount,freeSlots,slotLabel,parse,describe,LABELS};
