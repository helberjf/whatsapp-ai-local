const {ApiError}=require('./evolution.cjs');
const {createStore}=require('./store.cjs');
const {createCredentialStore}=require('./credentials.cjs');
const {PROVIDERS,isProvider,credentialName,endpoint,conversational}=require('./ai-providers.cjs');
// Modelo de embeddings padrão por provedor. Os demais precisam do campo "Modelo de embeddings" (API compatível com /embeddings).
const EMBEDDINGS={openai:'text-embedding-3-small',gemini:'gemini-embedding-001',ollama:'bge-m3',anthropic:'bge-m3'};
const initial={provider:'openai',model:'',baseUrl:''};
// A escala do cosseno muda de modelo para modelo. Medido com a base real em perguntas relacionadas e sem relação; os demais usam o padrão do índice.
const SIMILARITY={'bge-m3':.45};
// A Anthropic não oferece embeddings: com ela, os vetores são gerados pelo Ollama local. "off" mantém só o BM25.
function embeddingTarget(config) {
  const model=config.embeddingModel || EMBEDDINGS[config.provider];
  if(!model || model==='off') return null;
  const provider=config.provider==='anthropic'?'ollama':config.provider,baseUrl=config.provider==='anthropic'?'':config.baseUrl || '';
  return {provider,model,baseUrl,signature:[provider,baseUrl,model].join('|'),minSimilarity:SIMILARITY[model.split(':')[0]]};
}

function createAi(directory,fetchImpl=globalThis.fetch,options={}) {
  const store=options.store || createStore(directory,{file:'ai.json',initial});
  const credentials=options.credentials || createCredentialStore(directory);let ready,queue=Promise.resolve(),closed=false;
  const credentialError=()=>new ApiError('Não foi possível proteger ou abrir a chave de IA com este usuário do Windows.',503);
  const credential=async(method,...args)=>{try {return await credentials[method](...args);}catch {throw credentialError();}};
  const configured=(config,hasKey)=>Boolean(config.model && PROVIDERS[config.provider] && (PROVIDERS[config.provider].key?hasKey:true) && (config.provider!=='custom' || config.baseUrl));
  async function view(config) {
    const providers=Object.fromEntries(await Promise.all(Object.entries(PROVIDERS).map(async([id,item])=>[id,{...item,embedding:EMBEDDINGS[id] || '',hasKey:id!=='ollama' && await credential('has',credentialName(id))}]))),hasKey=Boolean(providers[config.provider]?.hasKey);
    return {provider:config.provider,model:config.model,baseUrl:config.baseUrl,embeddingModel:config.embeddingModel || '',ollamaNumGpu:config.provider==='ollama' && config.ollamaNumGpu===0?0:null,hasKey,configured:configured(config,hasKey),providers};
  }
  async function storeKey(provider,value) {const name=credentialName(provider);await credential('set',name,value);if(await credential('get',name)!==value) throw credentialError();}
  async function initialize() {
    if(!ready) ready=(async()=>{
      const config=await store.read();if(!isProvider(config.provider)) throw new ApiError('Escolha um provedor de IA válido.',422);
      let bindKey=false;
      if(config.apiKey) {
        if(typeof config.apiKey!=='string' || config.apiKey.length>4096) throw credentialError();
        // Configurações antigas com Ollama não identificam a qual serviço pertencia a chave.
        if(config.provider==='ollama') {await credential('set','assistant-unassigned',config.apiKey);if(await credential('get','assistant-unassigned')!==config.apiKey) throw credentialError();}
        else {
          const current=await credential('has',credentialName(config.provider))?await credential('get',credentialName(config.provider)):null;
          if(current!==config.apiKey) await storeKey(config.provider,config.apiKey);
          bindKey=true;
        }
      }
      if(await credential('has','assistant')) {
        if(config.provider==='ollama') {
          const key=await credential('get','assistant');if(!key) throw credentialError();await credential('set','assistant-unassigned',key);if(await credential('get','assistant-unassigned')!==key) throw credentialError();
        }else {
          if(await credential('has',credentialName(config.provider))) {if(!await credential('get',credentialName(config.provider))) throw credentialError();}
          else {const key=await credential('get','assistant');if(!key) throw credentialError();await storeKey(config.provider,key);}
          bindKey=true;
        }
        await credential('remove','assistant');
      }
      // Só retira o campo antigo depois de conferir a leitura da chave protegida.
      if(Object.hasOwn(config,'apiKey') || bindKey) await store.update(next=>{delete next.apiKey;if(bindKey) (next.keyBaseUrls ||= {})[config.provider]=endpoint(config.provider,config.baseUrl);});
    })().catch(error=>{ready=null;throw error;});return ready;
  }
  function operation(fn,{initializeFirst=true}={}) {
    if(closed) return Promise.reject(new ApiError('O serviço de IA está fechado.',503));
    const pending=queue.then(async()=>{if(initializeFirst) await initialize();return fn();});queue=pending.catch(()=>{});return pending;
  }
  async function post(url,headers,body,signal=AbortSignal.timeout(90_000)) {
    let response;
    try {response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal});}
    catch(error) {throw new ApiError('Não foi possível falar com o provedor de IA. Confira a conexão e o endereço.');}
    let raw;try {raw=await response.text();}catch {throw new ApiError('Não foi possível ler a resposta do provedor de IA.');}
    let data;try {data=JSON.parse(raw);}catch {data=null;}
    if(!response.ok) throw new ApiError(`O provedor de IA respondeu ${Number(response.status)||502}. Confira a chave, o modelo e a disponibilidade do provedor.`);
    if(!data) throw new ApiError('Resposta inválida do provedor de IA.');
    return data;
  }
  const resolved=()=>operation(async()=>{
    const metadata=await store.read(),name=credentialName(metadata.provider),hasKey=metadata.provider!=='ollama' && await credential('has',name);
    if(!configured(metadata,hasKey)) throw new ApiError('Configure o Assistente de IA (provedor, modelo e chave) antes de usar este recurso.',409);
    const apiKey=hasKey?await credential('get',name):'';
    if(hasKey && metadata.provider!=='ollama' && !apiKey) throw credentialError();return {...metadata,apiKey};
  });
  // Devolve os vetores junto da assinatura do modelo que os gerou. `task` separa documento de pergunta nos provedores que distinguem.
  async function embed(texts,{task='document',timeoutMs=90_000,signal}={}) {
    const config=await resolved(),target=embeddingTarget(config);
    if(!target) throw new ApiError('Este provedor não está configurado para gerar embeddings.',409);
    const base=endpoint(target.provider,target.baseUrl);
    if(!base) throw new ApiError('Endereço do provedor inválido.',422);
    const limit=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
    let vectors;
    if(target.provider==='gemini') {
      const taskType=task==='query'?'RETRIEVAL_QUERY':'RETRIEVAL_DOCUMENT',model=encodeURIComponent(target.model);
      const data=await post(`${base}/models/${model}:batchEmbedContents`,{'x-goog-api-key':config.apiKey},{requests:texts.map(text=>({model:'models/'+target.model,taskType,content:{parts:[{text}]}}))},limit);
      vectors=(data.embeddings || []).map(item=>item.values);
    } else if(target.provider==='ollama') {
      const data=await post(base.replace(/\/v1$/,'')+'/api/embed',{},{model:target.model,input:texts,...(config.ollamaNumGpu===0?{options:{num_gpu:0}}:{})},limit);
      vectors=data.embeddings || [];
    } else {
      const data=await post(base+'/embeddings',config.apiKey?{Authorization:'Bearer '+config.apiKey}:{},{model:target.model,input:texts},limit);
      vectors=[...(data.data || [])].sort((a,b)=>a.index-b.index).map(item=>item.embedding);
    }
    const size=vectors[0]?.length;
    if(vectors.length!==texts.length || !size || vectors.some(vector=>!Array.isArray(vector) || vector.length!==size || vector.some(value=>!Number.isFinite(value)))) throw new ApiError('Resposta inválida do provedor de embeddings.');
    return {vectors,signature:target.signature};
  }
  // `messages` (opcional) traz o histórico da conversa; sem ele, usa só `user`.
  async function complete({system,user,messages,json=false,maxTokens=2000,timeoutMs=90_000}) {
    // A geração local em CPU pode passar de 90 s; quem pede uma resposta longa informa um prazo maior.
    const send=(url,headers,body)=>post(url,headers,body,AbortSignal.timeout(timeoutMs));
    const config=await resolved();
    const base=endpoint(config.provider,config.baseUrl);
    if(!base) throw new ApiError('Endereço do provedor inválido.',422);
    const turns=messages || [{role:'user',content:user}];
    if(config.provider==='anthropic') {
      const data=await send(base+'/messages',{'x-api-key':config.apiKey,'anthropic-version':'2023-06-01'},{model:config.model,max_tokens:maxTokens,system,messages:turns});
      return (data.content || []).filter(part=>part.type==='text').map(part=>part.text).join('').trim();
    }
    if(config.provider==='gemini') {
      const data=await send(`${base}/models/${encodeURIComponent(config.model)}:generateContent`,{'x-goog-api-key':config.apiKey},{systemInstruction:{parts:[{text:system}]},contents:turns.map(turn=>({role:turn.role==='assistant'?'model':'user',parts:[{text:turn.content}]})),generationConfig:{temperature:.2,maxOutputTokens:maxTokens,...(json?{responseMimeType:'application/json'}:{})}});
      return (data.candidates?.[0]?.content?.parts || []).map(part=>part.text || '').join('').trim();
    }
    if(config.provider==='ollama') {
      // API nativa do Ollama: permite aumentar o contexto (o padrão de 4096 tokens é curto para catálogo + base + conversa).
      const data=await send(base.replace(/\/v1$/,'')+'/api/chat',{},{model:config.model,stream:false,messages:[{role:'system',content:system},...turns],...(json?{format:'json'}:{}),options:{temperature:.2,num_ctx:8192,num_predict:maxTokens,...(config.ollamaNumGpu===0?{num_gpu:0}:{})}});
      return String(data.message?.content || '').trim();
    }
    const openai=config.provider==='openai';
    const data=await send(base+'/chat/completions',config.apiKey?{Authorization:'Bearer '+config.apiKey}:{},{model:config.model,...(!openai?{temperature:.2}:{}),messages:[{role:'system',content:system},...turns],[openai?'max_completion_tokens':'max_tokens']:maxTokens,...(json && openai?{response_format:{type:'json_object'}}:{})});
    return String(data.choices?.[0]?.message?.content || '').trim();
  }
  return {
    complete,
    embed,
    // Sem modelo nem embeddings configurados, responde sem abrir o cofre de chaves.
    async embedding() {
      const draft=await store.read();if(!draft.model || !embeddingTarget(draft)) return null;
      return operation(async()=>{const config=await store.read(),hasKey=config.provider!=='ollama' && await credential('has',credentialName(config.provider));return configured(config,hasKey)?embeddingTarget(config):null;});
    },
    async config() {return operation(async()=>view(await store.read()));},
    async models(input) {
      if(!input || !isProvider(input.provider)) throw new ApiError('Escolha um provedor de IA válido.',422);
      const {provider}=input,baseUrl=typeof input.baseUrl==='string'?input.baseUrl.trim():'';
      if(input.apiKey!==undefined && (typeof input.apiKey!=='string' || input.apiKey.length>4096 || /\s/.test(input.apiKey))) throw new ApiError('Chave de API inválida.',422);
      const base=endpoint(provider,baseUrl);if(!base) throw new ApiError('Informe um endereço de API http:// ou https:// sem credenciais, parâmetros ou fragmentos.',422);
      const apiKey=await operation(async()=>{
        if(provider==='ollama') return '';
        if(input.apiKey) return input.apiKey;
        const name=credentialName(provider);if(!await credential('has',name)) {if(PROVIDERS[provider].key) throw new ApiError('Cole ou salve a chave deste provedor para carregar os modelos.',409);return '';}
        const saved=await store.read(),savedBase=saved.keyBaseUrls?.[provider] || (saved.provider===provider?endpoint(provider,saved.baseUrl):null);
        if(base!==savedBase) throw new ApiError('Cole a chave para consultar um endereço diferente do configurado.',409);
        const key=await credential('get',name);if(!key) throw credentialError();return key;
      });
      const headers=provider==='anthropic'?{'x-api-key':apiKey,'anthropic-version':'2023-06-01'}:provider==='gemini'?{'x-goog-api-key':apiKey}:apiKey?{Authorization:'Bearer '+apiKey}:{};
      const url=new URL(provider==='ollama'?base.replace(/\/v1$/,'')+'/api/tags':base+'/models'),models=new Map(),cursors=new Set(),signal=AbortSignal.timeout(20000);
      if(provider==='gemini') url.searchParams.set('pageSize','1000');if(provider==='anthropic') url.searchParams.set('limit','1000');
      for(let page=0;page<100;page++) {
        let response,data;
        try {response=await fetchImpl(url.toString(),{method:'GET',headers,redirect:'error',signal});if(response.ok) data=JSON.parse(await response.text());}
        catch {throw new ApiError('Não foi possível carregar os modelos. Confira a conexão e o endereço da API.',502);}
        if(!response.ok) throw new ApiError(`O provedor respondeu ${Number(response.status)||502} ao listar modelos. Confira a chave e a disponibilidade do serviço.`,502);
        const rows=provider==='gemini' || provider==='ollama'?data?.models:Array.isArray(data)?data:data?.data;
        if(!Array.isArray(rows)) throw new ApiError('O provedor não retornou uma lista válida de modelos. Você pode informar o modelo manualmente.',502);
        for(const row of rows) {const item=conversational(provider,row);if(item) models.set(item.id,item);}
        const cursor=provider==='gemini'?data.nextPageToken:provider==='anthropic' && data.has_more?data.last_id:null;
        if(!cursor) return {provider,models:[...models.values()].sort((a,b)=>a.label.localeCompare(b.label))};
        if(typeof cursor!=='string' || cursors.has(cursor)) break;cursors.add(cursor);url.searchParams.set(provider==='gemini'?'pageToken':'after_id',cursor);
      }
      throw new ApiError('O provedor não concluiu a lista de modelos. Tente novamente ou informe o modelo manualmente.',502);
    },
    async removeKey(input) {
      if(!input || !isProvider(input.provider)) throw new ApiError('Escolha um provedor de IA válido.',422);
      return operation(async()=>{
        const config=await store.read();if(config.provider!==input.provider) await initialize();
        await credential('remove',credentialName(input.provider));
        if(config.provider===input.provider) await credential('remove','assistant');
        const saved=await store.update(next=>{if(config.provider===input.provider) delete next.apiKey;if(next.keyBaseUrls) delete next.keyBaseUrls[input.provider];return next;});
        ready=Promise.resolve();return view(saved);
      },{initializeFirst:false});
    },
    async save(input) {
      if(!input || !isProvider(input.provider)) throw new ApiError('Escolha um provedor de IA válido.',422);
      const model=typeof input.model==='string'?input.model.trim():'',baseUrl=typeof input.baseUrl==='string'?input.baseUrl.trim():'';
      if(!model || model.length>120) throw new ApiError('Informe o modelo (até 120 caracteres).',422);
      if((baseUrl || input.provider==='custom') && !endpoint(input.provider,baseUrl)) throw new ApiError('O endereço do provedor deve começar com http:// ou https://, sem credenciais, parâmetros ou fragmentos.',422);
      if(input.apiKey!==undefined && (typeof input.apiKey!=='string' || input.apiKey.length>4096 || /\s/.test(input.apiKey))) throw new ApiError('Chave de API inválida.',422);
      if(input.clearKey!==undefined && typeof input.clearKey!=='boolean') throw new ApiError('Exclusão de chave inválida.',422);
      if(input.ollamaNumGpu!==undefined && input.ollamaNumGpu!==null && input.ollamaNumGpu!==0) throw new ApiError('Escolha hardware automático ou CPU para o Ollama.',422);
      if(input.embeddingModel!==undefined && (typeof input.embeddingModel!=='string' || input.embeddingModel.trim().length>120)) throw new ApiError('Informe o modelo de embeddings (até 120 caracteres).',422);
      const saved=await operation(async()=>{
        // Migra a chave antiga usando o provedor anterior antes de trocar a configuração.
        // A exclusão/substituição explícita permite recuperar um cofre antigo inacessível.
        let previous=await store.read();
        if(previous.provider!==input.provider) {await initialize();previous=await store.read();}
        const name=credentialName(input.provider);
        const boundBase=previous.keyBaseUrls?.[input.provider] || (previous.provider===input.provider?endpoint(input.provider,previous.baseUrl):null);
        if(!input.clearKey && !input.apiKey && input.provider!=='ollama' && await credential('has',name) && boundBase!==endpoint(input.provider,baseUrl)) throw new ApiError('A chave salva pertence a outro endereço de API. Use o endereço anterior ou cole a chave para este endereço.',409);
        if(input.clearKey) await credential('remove',name);else if(input.apiKey && input.provider!=='ollama') await storeKey(input.provider,input.apiKey);
        if(previous.provider===input.provider && (input.clearKey || input.apiKey)) await credential('remove','assistant');
        const config=await store.update(config=>{const ollamaNumGpu=input.provider==='ollama' && (input.ollamaNumGpu===0 || (input.ollamaNumGpu===undefined && config.provider==='ollama' && config.model===model && config.ollamaNumGpu===0))?0:null;Object.assign(config,{provider:input.provider,model,baseUrl,ollamaNumGpu});if(input.embeddingModel!==undefined) config.embeddingModel=input.embeddingModel.trim();delete config.apiKey;if(input.clearKey) {if(config.keyBaseUrls) delete config.keyBaseUrls[input.provider];}else if(input.apiKey && input.provider!=='ollama') (config.keyBaseUrls ||= {})[input.provider]=endpoint(input.provider,baseUrl);return config;});ready=Promise.resolve();return view(config);
      },{initializeFirst:!input.clearKey&&!input.apiKey});
      options.onChange?.();return saved;
    },
    async test() {
      const text=await complete({system:'Responda apenas com a palavra: ok',user:'Teste de conexão.',maxTokens:20});
      return {ok:true,reply:text.slice(0,80)};
    },
    async close() {closed=true;await queue;if(!options.credentials) await credentials.close();}
  };
}
module.exports={createAi,PROVIDERS,EMBEDDINGS};
