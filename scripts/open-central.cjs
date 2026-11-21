// Abre a central: Docker, banco e servidor. Usado por "Iniciar WhatsApp Central.cmd" e `npm start`.
const {runScript}=require('./launcher.cjs');
const {spawnSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const fs=require('node:fs/promises');
const path=require('node:path');

function docker(args,timeout) {
  return spawnSync('docker',args,{windowsHide:true,encoding:'utf8',timeout});
}

async function ensureDocker({run=docker,wait=delay,log=console.log}={}) {
  const probe=()=>run(['info','--format','{{.ServerVersion}}'],5000);
  const initial=probe();
  if(initial.status===0) return;
  if(initial.error?.code==='ENOENT') throw Error('Docker Desktop não está instalado ou não está no PATH.');
  // Versões anteriores ao comando "desktop start" usam a abertura pelo script do Windows.
  if(run(['desktop','start','--help'],5000).status!==0) return;
  log('Aguardando Docker Desktop...');
  const started=run(['desktop','start','--timeout','180'],190000);
  for(let attempt=0;attempt<10;attempt++) {
    if(probe().status===0) return;
    if(attempt<9) await wait(2000);
  }
  throw Error('Docker Desktop não ficou pronto. '+(started.stderr?.trim() || started.error?.message || 'Verifique o estado do motor no Docker Desktop.'));
}

async function canReuseCentral(connector,request=fetch) {
  try {
    const options={signal:AbortSignal.timeout(4000),cache:'no-store'};
    const [central,evolution]=await Promise.all([request('http://127.0.0.1:8766/health',options),request(connector,options)]);
    if(!central.ok || !evolution.ok) return false;
    const health=await central.json();
    return health.service==='whatsapp-local' && Boolean(health.build) && health.stale===false;
  } catch {return false;}
}

async function openCentral(args) {
  if(args.includes('-ReuseReady')) {
    const config=await fs.readFile(path.join(__dirname,'..','data','config.json'),'utf8')
      .then(text=>JSON.parse(text)).catch(()=>null);
    if(config?.apiUrl && await canReuseCentral(config.apiUrl)) {
      console.log('Central ja iniciada. Reutilizando a sessao.');
      return 0;
    }
  }
  await ensureDocker();
  return runScript('start-central.ps1',args.filter(arg=>arg!=='-ReuseReady'));
}

module.exports={ensureDocker,canReuseCentral};
if(require.main===module) openCentral(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{
  console.error(error.message);
  process.exitCode=1;
});
