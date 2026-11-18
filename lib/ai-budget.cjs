const {ApiError}=require('./evolution.cjs');
// Limite de gastos da IA paga. Os provedores cobram em dólar por milhão de tokens; o limite pode ser em reais com a cotação informada.
// Preços sugeridos (US$ por 1 milhão de tokens). Os demais modelos precisam do preço informado na tela.
const DEFAULT_PRICES={
  'openai:gpt-4.1':{input:2,output:8},
  'openai:gpt-4.1-mini':{input:.4,output:1.6},
  'openai:gpt-4.1-nano':{input:.1,output:.4},
  'openai:gpt-4o':{input:2.5,output:10},
  'openai:gpt-4o-mini':{input:.15,output:.6},
  'openai:text-embedding-3-small':{input:.02,output:0},
  'openai:text-embedding-3-large':{input:.13,output:0}
};
const CURRENCIES=['BRL','USD'];
const initialBudget={enabled:false,limit:0,currency:'BRL',rate:5.5,prices:{}};
const MAX_MONEY=1_000_000;
const free=provider=>provider==='ollama';
const priceKey=(provider,model)=>provider+':'+model;
const estimateTokens=text=>Math.ceil(String(text || '').length/4);
const periodOf=date=>{const d=new Date(date);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');};
const round=value=>Math.round(value*1e6)/1e6;

// Normaliza a contagem de tokens que cada provedor devolve.
function usageOf(provider,data,kind='chat') {
  if(provider==='anthropic') {const u=data?.usage || {};return {input:(u.input_tokens || 0)+(u.cache_creation_input_tokens || 0)+(u.cache_read_input_tokens || 0),output:u.output_tokens || 0};}
  if(provider==='gemini') {const u=data?.usageMetadata;if(!u) return null;return {input:u.promptTokenCount || 0,output:(u.candidatesTokenCount || 0)+(u.thoughtsTokenCount || 0)};}
  if(provider==='ollama') return {input:data?.prompt_eval_count || 0,output:data?.eval_count || 0};
  const u=data?.usage;if(!u) return null;
  return kind==='embedding'?{input:u.prompt_tokens ?? u.total_tokens ?? 0,output:0}:{input:u.prompt_tokens || 0,output:u.completion_tokens || 0};
}

function normalizeBudget(input,current=initialBudget) {
  if(!input || typeof input!=='object') throw new ApiError('Limite de gastos inválido.',422);
  const next={...initialBudget,...current,prices:{...(current.prices || {})}};
  const money=(value,label,{allowZero=false}={})=>{const n=Number(value);if(!Number.isFinite(n) || n<0 || n>MAX_MONEY || (!allowZero && n===0)) throw new ApiError(`Informe ${label} válido.`,422);return round(n);};
  if(input.enabled!==undefined) {if(typeof input.enabled!=='boolean') throw new ApiError('Ativação do limite inválida.',422);next.enabled=input.enabled;}
  if(input.currency!==undefined) {if(!CURRENCIES.includes(input.currency)) throw new ApiError('Escolha reais (BRL) ou dólares (USD).',422);next.currency=input.currency;}
  if(input.limit!==undefined) next.limit=money(input.limit,'um limite',{allowZero:true});
  if(input.rate!==undefined) next.rate=money(input.rate,'a cotação do dólar');
  if(next.enabled && !(next.limit>0)) throw new ApiError('Informe um limite maior que zero para ativar o controle de gastos.',422);
  if(input.prices!==undefined) {
    if(!input.prices || typeof input.prices!=='object' || Array.isArray(input.prices)) throw new ApiError('Preços inválidos.',422);
    for(const [key,price] of Object.entries(input.prices)) {
      if(typeof key!=='string' || key.length>200 || !/^[a-z]+:\S+$/.test(key)) throw new ApiError('Modelo inválido na tabela de preços.',422);
      if(price===null) {delete next.prices[key];continue;}
      next.prices[key]={input:money(price?.input ?? 0,'o preço de entrada',{allowZero:true}),output:money(price?.output ?? 0,'o preço de saída',{allowZero:true})};
    }
  }
  return next;
}

function createBudget({configStore,usageStore,now=Date.now}) {
  const reserved=new Map();let sequence=0;
  const settings=async()=>({...initialBudget,...((await configStore.read()).budget || {})});
  const priceOf=(budget,provider,model)=>free(provider)?{input:0,output:0}:budget.prices?.[priceKey(provider,model)] || DEFAULT_PRICES[priceKey(provider,model)] || null;
  const limitUsd=budget=>budget.currency==='USD'?budget.limit:budget.limit/budget.rate;
  async function usage() {
    const period=periodOf(now()),saved=await usageStore.read();
    return saved.period===period?saved:{period,costUsd:0,inputTokens:0,outputTokens:0,calls:0,blocked:0};
  }
  const pending=()=>[...reserved.values()].reduce((sum,value)=>sum+value,0);
  // Bloqueia antes de chamar o provedor quando o pior caso (entrada estimada + máximo de saída) passaria do limite.
  async function reserve({provider,model,inputText='',maxOutput=0,kind='chat'}) {
    if(free(provider)) return null;
    const budget=await settings();if(!budget.enabled) return {id:++sequence,provider,model,kind,cost:0};
    const price=priceOf(budget,provider,model);
    if(!price) throw new ApiError(`Informe o preço do modelo ${model} em Limite de gastos para usar a IA com o controle de gastos ativo.`,402);
    const estimate=(estimateTokens(inputText)*price.input+maxOutput*price.output)/1e6,current=await usage(),limit=limitUsd(budget);
    if(current.costUsd+pending()+estimate>limit) {
      await usageStore.update(saved=>{const base=saved.period===current.period?saved:{...current};Object.assign(saved,base,{blocked:(base.blocked || 0)+1});});
      throw new ApiError('Limite de gastos da IA atingido neste mês. Aumente o limite ou zere o contador em Assistente de IA › Limite de gastos.',402);
    }
    const id=++sequence;reserved.set(id,estimate);return {id,provider,model,kind,cost:estimate};
  }
  const release=ticket=>{if(ticket) reserved.delete(ticket.id);};
  // Registra o custo real informado pelo provedor; sem contagem, usa a estimativa para não subestimar.
  async function settle(ticket,tokens,fallback={}) {
    if(!ticket) return;
    try {
      const budget=await settings(),price=priceOf(budget,ticket.provider,ticket.model) || {input:0,output:0};
      const used=tokens || {input:estimateTokens(fallback.input),output:estimateTokens(fallback.output)};
      const cost=(used.input*price.input+used.output*price.output)/1e6,period=periodOf(now());
      await usageStore.update(saved=>{
        if(saved.period!==period) {for(const key of Object.keys(saved)) delete saved[key];Object.assign(saved,{period,costUsd:0,inputTokens:0,outputTokens:0,calls:0,blocked:0});}
        saved.costUsd=round((saved.costUsd || 0)+cost);saved.inputTokens=(saved.inputTokens || 0)+used.input;saved.outputTokens=(saved.outputTokens || 0)+used.output;saved.calls=(saved.calls || 0)+1;
      });
    }catch(error) {console.error('Não foi possível registrar o gasto da IA:',error.message);}
    finally {release(ticket);}
  }
  async function view(config) {
    const budget=await settings(),current=await usage(),limit=budget.limit>0?limitUsd(budget):0;
    const toCurrency=usd=>round(budget.currency==='USD'?usd:usd*budget.rate);
    const model=config?.model || '',provider=config?.provider || '',embedding=config?.embeddingTarget;
    return {
      enabled:budget.enabled,limit:budget.limit,currency:budget.currency,rate:budget.rate,
      period:current.period,spent:toCurrency(current.costUsd),spentUsd:round(current.costUsd),inputTokens:current.inputTokens,outputTokens:current.outputTokens,calls:current.calls,blocked:current.blocked || 0,
      remaining:budget.limit>0?toCurrency(Math.max(0,limit-current.costUsd)):null,reached:budget.enabled && current.costUsd>=limit,
      free:free(provider),
      model:{key:priceKey(provider,model),price:priceOf(budget,provider,model),custom:Boolean(budget.prices?.[priceKey(provider,model)])},
      embedding:embedding?{key:priceKey(embedding.provider,embedding.model),free:free(embedding.provider),price:priceOf(budget,embedding.provider,embedding.model),custom:Boolean(budget.prices?.[priceKey(embedding.provider,embedding.model)])}:null
    };
  }
  async function save(input) {
    await configStore.update(config=>{config.budget=normalizeBudget(input,config.budget);});
  }
  async function reset() {const period=periodOf(now());await usageStore.update(saved=>{for(const key of Object.keys(saved)) delete saved[key];Object.assign(saved,{period,costUsd:0,inputTokens:0,outputTokens:0,calls:0,blocked:0});});}
  return {reserve,release,settle,view,save,reset};
}
module.exports={createBudget,normalizeBudget,usageOf,estimateTokens,DEFAULT_PRICES,initialBudget};
