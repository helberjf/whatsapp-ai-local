const fs=require('node:fs');
const path=require('node:path');
const {spawn:spawnChild}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {startLaunchPage}=require('./launch-page.cjs');

const root=path.join(__dirname,'..');
const centralUrl='http://127.0.0.1:8766/';

async function waitForCentral({request=fetch,wait=delay}={}) {
  const deadline=Date.now()+30_000;
  let lastError;
  do {
    try {
      const response=await request(centralUrl+'health',{signal:AbortSignal.timeout(2000),cache:'no-store'});
      if(response.ok && (await response.json()).service==='whatsapp-local') return;
      lastError=new Error('HTTP '+response.status);
    } catch(error) {lastError=error;}
    await wait(500);
  } while(Date.now()<deadline);
  throw new Error('A central não respondeu na porta 8766. Confira data/server.err.log.',{cause:lastError});
}

function classifyLine(line) {
  if(line.includes('Aguardando Docker Desktop')) return {step:1,status:'Aguardando Docker Desktop...'};
  if(line.includes('Configuração local pronta')) return {step:2,status:'Iniciando serviços...'};
  if(line.includes('Preparando WhatsApp')) return {step:3,status:'Iniciando banco e conector...'};
  if(line.includes('Banco PostgreSQL da central pronto')) return {step:4,status:'Abrindo a Central...'};
  if(line.includes('Central ja iniciada') || line.includes('Whats AI pronto:')) return {step:4,status:'Central pronta.',done:true};
  return null;
}

function runVisualLauncher(deps={}) {
  const projectRoot=deps.root || root;
  const extraArgs=deps.extraArgs || [];
  const spawn=deps.spawn || spawnChild;
  const now=deps.now || (()=>new Date());
  const nodePath=deps.nodePath || process.execPath;
  const logPath=path.join(projectRoot,'data','launcher.log');
  const append=deps.append || (text=>{fs.mkdirSync(path.dirname(logPath),{recursive:true});fs.appendFileSync(logPath,text);});
  const emit=deps.emit || (event=>process.stdout.write('@@WHATS_AI_STATUS '+JSON.stringify(event)+'\n'));
  const checkReady=deps.checkReady || waitForCentral;
  const openBrowser=deps.openBrowser || (url=>new Promise((resolve,reject)=>{
    const opener=spawn('powershell.exe',['-NoProfile','-Command',`Start-Process -FilePath '${url}' -ErrorAction Stop`],{windowsHide:true,stdio:'ignore'});
    opener.once('error',reject);
    opener.once('close',code=>code===0?resolve():reject(new Error('Não foi possível abrir o navegador padrão.')));
  }));
  append(`[${now().toISOString()}] inicio\n`);
  return new Promise(resolve=>{
    let settled=false;
    let launchPage;
    let currentStatus;
    const report=event=>{currentStatus=event;launchPage?.update?.(event);emit(event);};
    const startPage=deps.startPage || startLaunchPage;
    const targetUrl=centralUrl+'?iniciar='+now().getTime()+'&conectar=1';
    const noBrowser=extraArgs.some(arg=>arg.toLowerCase()==='-nobrowser');
    const browserTask=noBrowser
      ? Promise.resolve()
      : startPage(projectRoot,targetUrl).then(page=>{
        launchPage=page;
        if(settled) {page.close();return;}
        if(currentStatus) page.update?.(currentStatus);
        return openBrowser(page.url);
      }).catch(error=>{
        append(`[${now().toISOString()}] navegador=${error.message}\n`);
        launchPage?.close();
        launchPage=null;
      });
    const finish=code=>{if(settled) return;settled=true;if(code!==0) launchPage?.fail();append(`[${now().toISOString()}] exit=${code}\n`);resolve(code);};
    let child;
    try {
      const childArgs=extraArgs.filter(arg=>arg.toLowerCase()!=='-nobrowser');
      child=spawn(nodePath,[path.join(projectRoot,'scripts','open-central.cjs'),...childArgs,'-NoBrowser','-ReuseReady'],{cwd:projectRoot,windowsHide:true,stdio:['ignore','pipe','pipe']});
    } catch(error) {
      append(`[${now().toISOString()}] erro=${error.message}\n`);finish(1);return;
    }
    let stdoutBuffer='';
    const consume=(chunk,stream)=>{
      const text=chunk.toString();append(`[${now().toISOString()}] [${stream}] ${text}`);
      if(stream!=='stdout') return;
      stdoutBuffer+=text;
      const lines=stdoutBuffer.split(/\r?\n/);stdoutBuffer=lines.pop() || '';
      for(const line of lines) {const event=classifyLine(line);if(event) report(event);}
    };
    child.stdout.on('data',chunk=>consume(chunk,'stdout'));
    child.stderr.on('data',chunk=>consume(chunk,'stderr'));
    child.on('error',error=>{append(`[${now().toISOString()}] erro=${error.message}\n`);finish(1);});
    let handlingExit=false;
    const handleExit=async code=>{
      if(handlingExit || settled) return;
      handlingExit=true;
      child.stdout.unref?.();
      child.stderr.unref?.();
      child.unref?.();
      if(stdoutBuffer) {const event=classifyLine(stdoutBuffer);if(event) report(event);}
      if(code===0) {
        try {
          await checkReady();
          await browserTask;
          if(!launchPage && !noBrowser) await openBrowser(targetUrl);
          launchPage?.ready();
        } catch(error) {
          append(`[${now().toISOString()}] erro=${error.message}\n`);
          finish(1);return;
        }
      }
      finish(Number.isInteger(code)?code:1);
    };
    // No Windows, o servidor pode manter pipes herdados abertos após o iniciador sair.
    child.once('exit',handleExit);
    child.once('close',handleExit);
  });
}

module.exports={classifyLine,waitForCentral,runVisualLauncher};

if(require.main===module) runVisualLauncher({extraArgs:process.argv.slice(2)}).then(code=>{process.exitCode=code;});
