// Abre a central: Docker, banco e servidor. Usado por "Iniciar WhatsApp Central.cmd" e `npm start`.
const {runScript}=require('./launcher.cjs');
const {spawnSync}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

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

module.exports={ensureDocker};
if(require.main===module) ensureDocker().then(()=>{
  process.exitCode=runScript('start-central.ps1',process.argv.slice(2));
}).catch(error=>{
  console.error(error.message);
  process.exitCode=1;
});
