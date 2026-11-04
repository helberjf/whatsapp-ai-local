// Eventos da Evolution pelo WebSocket (Socket.IO 4 / Engine.IO 4), numa conexão de saída para o conector local.
// Os eventos só antecipam a próxima consulta: se a conexão cair, a consulta periódica continua cobrindo tudo.
const RELEVANT=new Set(['messages.upsert','messages.update','messages.delete','messages.edited','send.message','chats.upsert','chats.update','chats.delete','contacts.upsert','contacts.update','connection.update']);
const RETRY_MS=[2000,5000,15000,30000,60000];

function createEvolutionEvents({config,WebSocketImpl=globalThis.WebSocket,onEvent=()=>{},retryMs=RETRY_MS,now=Date.now}) {
  let socket=null,stopped=true,attempt=0,retryTimer=null,heartbeat=null,connected=false,lastEventAt=null,lastError=null,limitMs=60_000;
  function address() {
    const url=new URL('/socket.io/',config.apiUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    url.search=new URLSearchParams({EIO:'4',transport:'websocket',apikey:config.apiKey}).toString();return url.href;
  }
  function retry() {
    if(stopped) return;clearTimeout(retryTimer);
    retryTimer=setTimeout(connect,retryMs[Math.min(attempt,retryMs.length-1)]);attempt++;retryTimer.unref?.();
  }
  // Sem ping do servidor dentro do prazo combinado, a conexão é considerada perdida e reaberta.
  function watch(ws) {clearTimeout(heartbeat);heartbeat=setTimeout(()=>{lastError='O conector parou de responder aos eventos.';try {ws.close();}catch {}},limitMs);heartbeat.unref?.();}
  function handle(ws,raw) {
    const data=typeof raw==='string'?raw:Buffer.from(raw).toString('utf8');watch(ws);
    if(data[0]==='0') {try {const open=JSON.parse(data.slice(1));limitMs=(Number(open.pingInterval)||25_000)+(Number(open.pingTimeout)||20_000)+5000;}catch {}ws.send('40');return;}
    if(data==='2') {ws.send('3');return;}
    if(data.startsWith('40')) {connected=true;attempt=0;lastError=null;onEvent('connected',null);return;}
    if(data.startsWith('44')) {lastError='O conector recusou a conexão de eventos. Confira a configuração do Docker.';try {ws.close();}catch {}return;}
    const event=data.match(/^42\d*(\[[\s\S]*\])$/);if(!event) return;
    let payload;try {payload=JSON.parse(event[1]);}catch {return;}
    if(!Array.isArray(payload) || typeof payload[0]!=='string') return;
    const [name,message]=payload;
    if(message?.instance && config.instanceName && message.instance!==config.instanceName) return;
    lastEventAt=now();if(RELEVANT.has(name)) onEvent(name,message?.data ?? null);
  }
  function connect() {
    if(stopped) return;
    if(typeof WebSocketImpl!=='function') {lastError='Este Node.js não tem WebSocket; a central segue com consultas periódicas.';return;}
    let ws;try {ws=new WebSocketImpl(address());}catch {lastError='Não foi possível abrir os eventos do conector.';retry();return;}
    socket=ws;
    ws.onmessage=event=>{if(socket===ws) handle(ws,event.data);};
    ws.onerror=()=>{if(!lastError) lastError='Eventos do conector indisponíveis; a central segue com consultas periódicas.';};
    ws.onclose=()=>{if(socket!==ws) return;const was=connected;socket=null;connected=false;clearTimeout(heartbeat);if(was) onEvent('disconnected',null);retry();};
  }
  return {
    start() {if(!stopped) return;stopped=false;attempt=0;connect();},
    stop() {stopped=true;clearTimeout(retryTimer);clearTimeout(heartbeat);const ws=socket;socket=null;connected=false;try {ws?.close();}catch {}},
    status:()=>({connected,lastEventAt,lastError})
  };
}
module.exports={createEvolutionEvents,RELEVANT};
