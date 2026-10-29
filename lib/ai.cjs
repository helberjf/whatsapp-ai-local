const {ApiError}=require('./evolution.cjs');
const {createStore}=require('./store.cjs');

const PROVIDERS={
  openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1',model:'gpt-4o-mini',key:true},
  anthropic:{label:'Anthropic (Claude)',baseUrl:'https://api.anthropic.com/v1',model:'claude-haiku-5-5',key:true},
  gemini:{label:'Google Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-2.0-flash',key:true},
  ollama:{label:'Ollama (local)',baseUrl:'http://127.0.0.1:11434',model:'qwen2.5:7b',key:false},
  custom:{label:'API compatível com OpenAI',baseUrl:'',model:'',key:false}
};
const initial={provider:'openai',model:'',baseUrl:'',apiKey:''};

function createAi(directory,fetchImpl=globalThis.fetch) {
  const store=createStore(directory,{file:'ai.json',initial});
  const configured=config=>Boolean(config.model && (PROVIDERS[config.provider]?.key?config.apiKey:true) && (config.provider!=='custom' || config.baseUrl));
  // A chave fica apenas neste arquivo local e nunca volta para a interface.
  const view=config=>({provider:config.provider,model:config.model,baseUrl:config.baseUrl,hasKey:Boolean(config.apiKey),configured:configured(config),providers:Object.fromEntries(Object.entries(PROVIDERS).map(([id,item])=>[id,{label:item.label,model:item.model,baseUrl:item.baseUrl,key:item.key}]))});
  async function post(url,headers,body) {
    let response;
    try {response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});}
    catch(error) {throw new ApiError('Não foi possível falar com o provedor de IA. Confira a conexão e o endereço.');}
    const raw=await response.text();let data;try {data=JSON.parse(raw);}catch {data=null;}
    if(!response.ok) throw new ApiError(`O provedor de IA respondeu ${response.status}: ${String(data?.error?.message || data?.error || raw).slice(0,200)}`);
    if(!data) throw new ApiError('Resposta inválida do provedor de IA.');
    return data;
  }
  // `messages` (opcional) traz o histórico da conversa; sem ele, usa só `user`.
  async function complete({system,user,messages,json=false,maxTokens=2000}) {
    const config=await store.read();
    if(!configured(config)) throw new ApiError('Configure o Assistente de IA (provedor, modelo e chave) antes de usar este recurso.',409);
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
      const data=await post(base.replace(/\/v1$/,'')+'/api/chat',{},{model:config.model,stream:false,messages:[{role:'system',content:system},...turns],...(json?{format:'json'}:{}),options:{temperature:.2,num_ctx:8192,num_predict:maxTokens}});
      return String(data.message?.content || '').trim();
    }
    const openai=config.provider==='openai';
    const data=await post(base+'/chat/completions',config.apiKey?{Authorization:'Bearer '+config.apiKey}:{},{model:config.model,temperature:.2,messages:[{role:'system',content:system},...turns],[openai?'max_completion_tokens':'max_tokens']:maxTokens,...(json && openai?{response_format:{type:'json_object'}}:{})});
    return String(data.choices?.[0]?.message?.content || '').trim();
  }
  return {
    complete,
    async config() {return view(await store.read());},
    async save(input) {
      if(!PROVIDERS[input.provider]) throw new ApiError('Escolha um provedor de IA válido.',422);
      const model=typeof input.model==='string'?input.model.trim():'',baseUrl=typeof input.baseUrl==='string'?input.baseUrl.trim():'';
      if(!model || model.length>120) throw new ApiError('Informe o modelo (até 120 caracteres).',422);
      if(baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new ApiError('O endereço do provedor deve começar com http:// ou https://.',422);
      if(input.apiKey!==undefined && (typeof input.apiKey!=='string' || input.apiKey.length>500 || /\s/.test(input.apiKey))) throw new ApiError('Chave de API inválida.',422);
      return view(await store.update(config=>{
        Object.assign(config,{provider:input.provider,model,baseUrl});
        if(input.clearKey) config.apiKey='';
        else if(input.apiKey) config.apiKey=input.apiKey;
        return config;
      }));
    },
    async test() {
      const text=await complete({system:'Responda apenas com a palavra: ok',user:'Teste de conexão.',maxTokens:20});
      return {ok:true,reply:text.slice(0,80)};
    }
  };
}
module.exports={createAi,PROVIDERS};
