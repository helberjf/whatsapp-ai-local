// Sugestões iniciais. A lista da conta é consultada sob demanda, sem fixar o catálogo do provedor.
const provider=(label,baseUrl,models,key=true)=>({label,baseUrl,model:models[0] || '',models:models.map(id=>({id,label:id})),key});
const PROVIDERS={
  openai:provider('OpenAI','https://api.openai.com/v1',['gpt-4.1-mini','gpt-4.1','gpt-4.1-nano','gpt-4o-mini','gpt-4o']),
  anthropic:provider('Anthropic (Claude)','https://api.anthropic.com/v1',['claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5']),
  gemini:provider('Google Gemini','https://generativelanguage.googleapis.com/v1beta',['gemini-3.8-flash']),
  deepseek:provider('DeepSeek','https://api.deepseek.com',['deepseek-flash','deepseek-v4-pro']),
  groq:provider('Groq','https://api.groq.com/openai/v1',[]),
  mistral:provider('Mistral AI','https://api.mistral.ai/v1',['mistral-small-latest','mistral-large-latest']),
  xai:provider('xAI (Grok)','https://api.x.ai/v1',['grok-4.7']),
  openrouter:provider('OpenRouter · vários fabricantes','https://openrouter.ai/api/v1',[]),
  together:provider('Together AI','https://api.together.xyz/v1',[]),
  perplexity:provider('Perplexity','https://api.perplexity.ai',['sonar','sonar-pro','sonar-reasoning-pro']),
  ollama:provider('Ollama (local)','http://127.0.0.1:11434',['qwen2.5:7b','qwen3:8b','llama3.2:3b','gemma3:4b'],false),
  custom:provider('API compatível com OpenAI','',[],false)
};
const isProvider=id=>typeof id==='string' && Object.hasOwn(PROVIDERS,id);
const credentialName=id=>'assistant:'+id;
function endpoint(provider,baseUrl='') {
  const value=(baseUrl || PROVIDERS[provider].baseUrl).replace(/\/+$/,'');
  let url;try {url=new URL(value);}catch {return null;}
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  return value;
}
function conversational(provider,item) {
  const id=provider==='gemini'?item?.name?.replace(/^models\//,''):provider==='ollama'?item?.name || item?.model:item?.id;
  if(typeof id!=='string' || !id || id.length>120 || /\s/.test(id)) return null;
  if(provider==='gemini' && !item.supportedGenerationMethods?.includes('generateContent')) return null;
  if(provider==='ollama' && (item.remote_host || item.remote_model || /(?:-cloud|:cloud)$/.test(id))) return null;
  if(item.active===false || item.lifecycle==='retired' || item.capabilities?.completion_chat===false) return null;
  if(item.type && ['embedding','image','audio','rerank','moderation','transcription'].includes(item.type)) return null;
  if(item.architecture?.output_modalities && !item.architecture.output_modalities.includes('text')) return null;
  if(/embed|whisper|dall-e|tts|moderation|rerank|transcri|(?:^|[-/])(?:image|imagine|video|audio|realtime|live|instruct)(?:[-/:]|$)/i.test(id)) return null;
  if(provider==='openai' && !/^(?:gpt-|chatgpt-|o\d|ft:)/.test(id)) return null;
  return {id,label:String(item.display_name || item.displayName || item.name || id).slice(0,200)};
}
module.exports={PROVIDERS,isProvider,credentialName,endpoint,conversational};
