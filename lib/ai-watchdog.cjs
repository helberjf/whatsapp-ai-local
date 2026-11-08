// Vigia o Ollama local quando a central depende dele (IA de respostas ou embeddings) e o religa se cair.
// Sem ele, a busca cai em silêncio para palavras-chave e a IA deixa de responder.
const LOCAL_HOSTS=['127.0.0.1','localhost','[::1]'];
const isLocal=baseUrl=>{
  if(!baseUrl) return true;
  try {const url=new URL(baseUrl);return LOCAL_HOSTS.includes(url.hostname) && url.port==='11434';}catch {return false;}
};

function createAiWatchdog({ai,localAi,onRecovered=()=>{},now=Date.now,intervalMs=60_000,retryMs=2*60_000}) {
  let state={watching:false,running:null,since:null,restarts:0,lastAttemptAt:null,lastError:''},timer=null,busy=null,stopped=false;

  async function dependsOnOllama() {
    const config=await ai.config().catch(()=>null);
    if(config?.configured && config.provider==='ollama' && isLocal(config.baseUrl)) return true;
    const target=await ai.embedding().catch(()=>null);
    return target?.provider==='ollama' && isLocal(target.baseUrl);
  }
  // Registra a mudança de estado e avisa quando o Ollama volta, seja quem for que o religou.
  function mark(running) {
    const recovered=state.running===false && running;
    if(state.running!==running) state={...state,running,since:now()};
    if(running) state.lastError='';
    if(recovered) onRecovered();
  }
  async function run() {
    if(stopped) return state;
    if(!await dependsOnOllama()) {state={...state,watching:false,running:null,since:null,lastError:''};return state;}
    state.watching=true;
    if(await localAi.running()) {mark(true);return state;}
    mark(false);
    if(state.lastAttemptAt===null || now()-state.lastAttemptAt>=retryMs) {
      state.lastAttemptAt=now();
      try {
        if(await localAi.revive()) {state.restarts++;mark(true);}
        else state.lastError='O Ollama foi iniciado, mas não respondeu a tempo.';
      } catch(error) {state.lastError=error.message;}
    }
    return state;
  }
  function check() {
    if(!busy) busy=run().finally(()=>{busy=null;});
    return busy;
  }
  return {
    check,
    status() {
      const next=state.running===false && state.lastAttemptAt!==null?state.lastAttemptAt+retryMs:null;
      return {watching:state.watching,running:state.running,since:state.since && new Date(state.since).toISOString(),restarts:state.restarts,lastError:state.lastError,nextAttemptAt:next && new Date(next).toISOString()};
    },
    start() {if(timer || stopped) return;timer=setInterval(()=>{check().catch(()=>{});},intervalMs);timer.unref?.();check().catch(()=>{});},
    stop() {stopped=true;clearInterval(timer);timer=null;},
    idle:()=>busy || Promise.resolve()
  };
}
module.exports={createAiWatchdog,isLocal};
