const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {ApiError}=require('./evolution.cjs');
const BASE='http://127.0.0.1:11434';
function inputOf(input={}) {
  if(!input || typeof input!=='object' || Array.isArray(input) || (input.model!==undefined && typeof input.model!=='string')) throw new ApiError('Informe um modelo local válido.',422);
  const model=typeof input.model==='string'?input.model.trim():'qwen2.5:7b';
  if(!model || model.length>120 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model) || /(?:-cloud|:cloud)$/.test(model)) throw new ApiError('Escolha um modelo local válido, como qwen2.5:7b.',422);
  if(input.baseUrl) {let url;try {url=new URL(input.baseUrl);}catch{throw new ApiError('Use o endereço local padrão do Ollama.',422);}
    if(url.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.port!=='11434' || url.username || url.password || url.search || url.hash || !['/','/v1','/v1/'].includes(url.pathname)) throw new ApiError('Para ligar a IA neste computador, use http://127.0.0.1:11434 ou deixe o endereço vazio.',422);
  }
  const device=input.device || 'auto';if(!['auto','cpu'].includes(device)) throw new ApiError('Escolha o modo automático ou CPU.',422);
  return {model,device};
}
async function findExecutable() {
  const candidates=process.platform==='win32'?[process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs','Ollama','ollama.exe'),process.env.ProgramFiles&&path.join(process.env.ProgramFiles,'Ollama','ollama.exe')]:['/usr/local/bin/ollama','/usr/bin/ollama'];
  for(const candidate of candidates.filter(Boolean)) {try {if((await fs.stat(candidate)).isFile()) return candidate;}catch{}}
  return null;
}
function launch(executable) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['serve'],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,OLLAMA_HOST:'127.0.0.1:11434'}});
    child.once('error',()=>reject(new ApiError('Não foi possível iniciar o Ollama. Abra o aplicativo Ollama e tente novamente.',503)));
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
function createLocalAi(options={}) {
  const fetchImpl=options.fetchImpl || fetch,locate=options.findExecutable || findExecutable,open=options.launch || launch,delay=options.delay || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let pending=null;
  async function request(route,body,timeout=2000) {
    try {
      const response=await fetchImpl(BASE+route,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeout),...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
      let size=0;const chunks=[];for await(const chunk of response.body || []) {size+=chunk.length;if(size>2_000_000) throw Error();chunks.push(chunk);}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!response.ok) {if(typeof result.error==='string' && /out.of.memory|cudaMalloc|unable to allocate|insufficient memory/i.test(result.error)) throw new ApiError('Não há memória livre suficiente na GPU. Marque Usar CPU para ligar sem a placa de vídeo ou libere memória e tente novamente.',502);throw Error();}
      return result;
    } catch(error) {if(error instanceof ApiError) throw error;throw new ApiError('O Ollama não confirmou a operação. Verifique se ele está aberto e se há memória disponível para o modelo.',502);}
  }
  async function probe() {try {const data=await request('/api/version');return typeof data.version==='string' && data.version.length>0 && data.version.length<80;}catch{return false;}}
  const sameModel=(left,right)=>left===right || (!right.includes(':') && left===right+':latest');
  async function status(input={}) {
    const {model,device}=inputOf(input),[executable,running]=await Promise.all([locate(),probe()]);
    const state={installed:Boolean(executable),running,model,device,executionMode:null,modelInstalled:false,loaded:false,models:[],starting:Boolean(pending)};
    if(!running) return state;
    const [tags,ps]=await Promise.all([request('/api/tags'),request('/api/ps')]);
    if(!Array.isArray(tags.models) || !Array.isArray(ps.models)) throw new ApiError('O serviço local não retornou uma lista válida de modelos.',502);
    const local=tags.models.filter(item=>typeof (item.name || item.model)==='string' && !item.remote_host && !item.remote_model && !/(?:-cloud|:cloud)$/.test(item.name || item.model));
    state.models=local.map(item=>item.name || item.model).slice(0,100);state.modelInstalled=state.models.some(name=>sameModel(name,model));const active=ps.models.find(item=>sameModel(item.name || item.model,model));state.loaded=state.modelInstalled && Boolean(active);state.executionMode=state.loaded && Number.isFinite(active.size_vram)?active.size_vram===0?'cpu':'gpu':null;return state;
  }
  async function prepare(input) {
    let state=await status(input);
    if(!state.running) {
      const executable=await locate();if(!executable) throw new ApiError('Instale o Ollama neste computador para usar a IA local.',409);
      await open(executable);
      for(let attempt=0;attempt<30;attempt++) {if(await probe()) {state=await status(input);break;}await delay(500);}
      if(!state.running) throw new ApiError('O Ollama está iniciando. Aguarde um pouco e clique novamente.',503);
    }
    if(!state.modelInstalled) throw new ApiError(`O modelo ${input.model} ainda não está instalado no Ollama. Instale-o no aplicativo Ollama e tente novamente.`,409);
    if(!state.loaded || (input.device==='cpu' && state.executionMode!=='cpu')) {
      const result=await request('/api/generate',{model:input.model,stream:false,keep_alive:'30m',options:{num_ctx:8192,...(input.device==='cpu'?{num_gpu:0}:{})}},120000);
      if(result.done!==true) throw new ApiError('O Ollama não confirmou o carregamento do modelo.',502);
      state=await status(input);if(!state.loaded || (input.device==='cpu' && state.executionMode==='gpu')) throw new ApiError('O modelo ainda não ficou pronto no modo escolhido. Confira a memória disponível e tente novamente.',502);
    }
    return {...state,starting:false};
  }
  return {status,start(input={}) {
    let value;try {value=inputOf(input);}catch(error){return Promise.reject(error);}
    if(pending) return pending.model===value.model && pending.device===value.device?pending.promise:Promise.reject(new ApiError('Outro modelo ou modo está sendo preparado. Aguarde a conclusão.',409));
    const promise=prepare({...value,baseUrl:input.baseUrl}).finally(()=>{if(pending?.promise===promise) pending=null;});pending={model:value.model,device:value.device,promise};return promise;
  }};
}
module.exports={createLocalAi};
