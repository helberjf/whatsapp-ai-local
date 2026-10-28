const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const url='http://127.0.0.1:8766/';
let starting;
async function isReady() {
  try {
    const [result,connector]=await Promise.all([fetch(url+'health',{signal:AbortSignal.timeout(1500)}),fetch('http://127.0.0.1:8767/',{signal:AbortSignal.timeout(1500)})]);
    await connector.body?.cancel();return result.ok && connector.ok && (await result.json()).service==='whatsapp-local';
  }catch{return false;}
}
async function openWhatsApp() {
  if(await isReady()) return {url};
  if(starting) return starting;
  starting=(async()=>{
    const project=process.env.WHATSAPP_CENTRAL_DIR || path.join(os.homedir(),'projects','whatsapp-central'),script=path.join(project,'scripts','start.ps1');
    try {await fs.access(script);}catch {throw Object.assign(new Error('Projeto WhatsApp Central não encontrado. Abra Abrir WhatsApp.cmd em projects/whatsapp-central ou configure WHATSAPP_CENTRAL_DIR.'),{status:503});}
    const logs=path.join(project,'data');await fs.mkdir(logs,{recursive:true});
    const log=await fs.open(path.join(logs,'startup.log'),'a');
    let childProcess;
    try {
      childProcess=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-NoBrowser'],{cwd:project,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});
      await new Promise((resolve,reject)=>{childProcess.once('spawn',resolve);childProcess.once('error',reject);});childProcess.unref();
    } finally {await log.close();}
    // A instalação pode levar alguns minutos; a interface consulta este mesmo endpoint sem lançar outra pilha.
    const deadline=Date.now()+240000;
    while(Date.now()<deadline) {
      if(await isReady()) return {url};
      if(childProcess.exitCode!==null || childProcess.signalCode!==null) break;
      await new Promise(resolve=>setTimeout(resolve,700));
    }
    throw Object.assign(new Error('A central ainda não iniciou. Abra Abrir WhatsApp.cmd e consulte data/startup.log na pasta whatsapp-central.'),{status:503});
  })().finally(()=>{starting=null;});
  return starting;
}
module.exports={openWhatsApp};
