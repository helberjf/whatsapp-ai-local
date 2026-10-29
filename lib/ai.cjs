const {ApiError}=require('./evolution.cjs');
const {createStore}=require('./store.cjs');
const {createCredentialStore}=require('./credentials.cjs');

const PROVIDERS={
  openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1',model:'gpt-4o-mini',key:true},
  anthropic:{label:'Anthropic (Claude)',baseUrl:'https://api.anthropic.com/v1',model:'claude-haiku-5-5',key:true},
  gemini:{label:'Google Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-2.0-flash',key:true},
  ollama:{label:'Ollama (local)',baseUrl:'http://127.0.0.1:11434',model:'qwen2.5:7b',key:false},
  custom:{label:'API compatível com OpenAI',baseUrl:'',model:'',key:false}
};
const initial={provider:'openai',model:'',baseUrl:''};

function createAi(directory,fetchImpl=globalThis.fetch,options={}) {
  const store=createStore(directory,{file:'ai.json',initial});
  const credentials=options.credentials || createCredentialStore(directory);let ready,queue=Promise.resolve(),closed=false;
  const credentialError=()=>new ApiError('Não foi possível proteger ou abrir a chave de IA com este usuário do Windows.',503);
  const credential=async(method,...args)=>{try {return await credentials[method](...args);}catch {throw credentialError();}};
  const configured=(config,hasKey)=>Boolean(config.model && PROVIDERS[config.provider] && (PROVIDERS[config.provider].key?hasKey:true) && (config.provider!=='custom' || config.baseUrl));
  const view=(config,hasKey)=>({provider:config.provider,model:config.model,baseUrl:config.baseUrl,ollamaNumGpu:config.provider==='ollama' && config.ollamaNumGpu===0?0:null,hasKey,configured:configured(config,hasKey),providers:Object.fromEntries(Object.entries(PROVIDERS).map(([id,item])=>[id,{label:item.label,model:item.model,baseUrl:item.baseUrl,key:item.key}]))});
  async function storeKey(value) {await credential('set','assistant',value);if(await credential('get','assistant')!==value) throw credentialError();}
  async function initialize() {
    if(!ready) ready=(async()=>{
      const config=await store.read();if(!Object.hasOwn(config,'apiKey')) return;
      if(config.apiKey) {
        if(typeof config.apiKey!=='string' || config.apiKey.length>4096) throw credentialError();
        const current=await credential('has','assistant')?await credential('get','assistant'):null;
        if(current!==config.apiKey) await storeKey(config.apiKey);
      }
      // Só retira o campo antigo depois de conferir a leitura da chave protegida.
      await store.update(next=>{delete next.apiKey;});
    })().catch(error=>{ready=null;throw error;});return ready;
  }
  function operation(fn,{initializeFirst=true}={}) {
    if(closed) return Promise.reject(new ApiError('O serviço de IA está fechado.',503));
    const pending=queue.then(async()=>{if(initializeFirst) await initialize();return fn();});queue=pending.catch(()=>{});return pending;
  }
  async function post(url,headers,body) {
    let response;
    try {response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});}
    catch(error) {throw new ApiError('Não foi possível falar com o provedor de IA. Confira a conexão e o endereço.');}
    let raw;try {raw=await response.text();}catch {throw new ApiError('Não foi possível ler a resposta do provedor de IA.');}
    let data;try {data=JSON.parse(raw);}catch {data=null;}
    if(!response.ok) throw new ApiError(`O provedor de IA respondeu ${Number(response.status)||502}. Confira a chave, o modelo e a disponibilidade do provedor.`);
    if(!data) throw new ApiError('Resposta inválida do provedor de IA.');
    return data;
  }
  // `messages` (opcional) traz o histórico da conversa; sem ele, usa só `user`.
  async function complete({system,user,messages,json=false,maxTokens=2000}) {
    const config=await operation(async()=>{
      const metadata=await store.read(),hasKey=await credential('has','assistant');
      if(!configured(metadata,hasKey)) throw new ApiError('Configure o Assistente de IA (provedor, modelo e chave) antes de usar este recurso.',409);
      const apiKey=hasKey&&metadata.provider!=='ollama'?await credential('get','assistant'):'';
      if(hasKey && metadata.provider!=='ollama' && !apiKey) throw credentialError();return {...metadata,apiKey};
    });
    const base=(config.baseUrl || PROVIDERS[config.provider].baseUrl).replace(/\/+$/,'');
    if(!/^https?:\/\//.test(base)) throw new ApiError('Endereço do provedor inválido.',422);
    const turns=messages || [{role:'user',content:user}];
    if(config.provider==='anthropic') {
      const data=await post(base+'/messages',{'x-api-key':config.apiKey,'anthropic-version':'2023-06-01'},{model:config.model,max_tokens:maxTokens,system,messages:turns});
      return (data.content || []).filter(part=>part.type==='text').map(part=>part.text).join('').trim();
    }
    if(config.provider==='gemini') {
      const data=await post(`${base}/models/${encodeURIComponent(config.model)}:generateContent`,{'x-goog-api-key':config.apiKey},{systemInstruction:{parts:[{text:system}]},contents:turns.map(turn=>({role:turn.role==='assistant'?'model':'user',parts:[{text:turn.content}]})),generationConfig:{temperature:.2,maxOutputTokens:maxTokens,...(json?{responseMimeType:'application/json'}:{})}});
      return (data.candidates?.[0]?.content?.parts || []).map(part=>part.text || '').join('').trim();
    }
    if(config.provider==='ollama') {
      // API nativa do Ollama: permite aumentar o contexto (o padrão de 4096 tokens é curto para catálogo + base + conversa).
      const data=await post(base.replace(/\/v1$/,'')+'/api/chat',{},{model:config.model,stream:false,messages:[{role:'system',content:system},...turns],...(json?{format:'json'}:{}),options:{temperature:.2,num_ctx:8192,num_predict:maxTokens,...(config.ollamaNumGpu===0?{num_gpu:0}:{})}});
      return String(data.message?.content || '').trim();
    }
    const openai=config.provider==='openai';
    const data=await post(base+'/chat/completions',config.apiKey?{Authorization:'Bearer '+config.apiKey}:{},{model:config.model,temperature:.2,messages:[{role:'system',content:system},...turns],[openai?'max_completion_tokens':'max_tokens']:maxTokens,...(json && openai?{response_format:{type:'json_object'}}:{})});
    return String(data.choices?.[0]?.message?.content || '').trim();
  }
  return {
    complete,
    async config() {return operation(async()=>view(await store.read(),await credential('has','assistant')));},
    async save(input) {
      if(!PROVIDERS[input.provider]) throw new ApiError('Escolha um provedor de IA válido.',422);
      const model=typeof input.model==='string'?input.model.trim():'',baseUrl=typeof input.baseUrl==='string'?input.baseUrl.trim():'';
      if(!model || model.length>120) throw new ApiError('Informe o modelo (até 120 caracteres).',422);
      if(baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new ApiError('O endereço do provedor deve começar com http:// ou https://.',422);
      if(input.apiKey!==undefined && (typeof input.apiKey!=='string' || input.apiKey.length>500 || /\s/.test(input.apiKey))) throw new ApiError('Chave de API inválida.',422);
      if(input.clearKey!==undefined && typeof input.clearKey!=='boolean') throw new ApiError('Exclusão de chave inválida.',422);
      if(input.ollamaNumGpu!==undefined && input.ollamaNumGpu!==null && input.ollamaNumGpu!==0) throw new ApiError('Escolha hardware automático ou CPU para o Ollama.',422);
      return operation(async()=>{
        if(input.clearKey) await credential('remove','assistant');else if(input.apiKey) await storeKey(input.apiKey);
        const config=await store.update(config=>{const ollamaNumGpu=input.provider==='ollama' && (input.ollamaNumGpu===0 || (input.ollamaNumGpu===undefined && config.provider==='ollama' && config.model===model && config.ollamaNumGpu===0))?0:null;Object.assign(config,{provider:input.provider,model,baseUrl,ollamaNumGpu});delete config.apiKey;return config;});ready=Promise.resolve();return view(config,await credential('has','assistant'));
      },{initializeFirst:!input.clearKey&&!input.apiKey});
    },
    async test() {
      const text=await complete({system:'Responda apenas com a palavra: ok',user:'Teste de conexão.',maxTokens:20});
      return {ok:true,reply:text.slice(0,80)};
    },
    async close() {closed=true;await queue;if(!options.credentials) await credentials.close();}
  };
}
module.exports={createAi,PROVIDERS};
