const fs=require('node:fs');
const path=require('node:path');
const {spawn:spawnChild}=require('node:child_process');

const root=path.join(__dirname,'..');

function classifyLine(line) {
  if(line.includes('Configuração local pronta')) return {step:2,status:'Iniciando serviços...'};
  if(line.includes('Preparando WhatsApp')) return {step:3,status:'Conectando ao WhatsApp...'};
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
  append(`[${now().toISOString()}] inicio\n`);
  return new Promise(resolve=>{
    let settled=false;
    const finish=code=>{if(settled) return;settled=true;append(`[${now().toISOString()}] exit=${code}\n`);resolve(code);};
    let child;
    try {
      child=spawn(nodePath,[path.join(projectRoot,'scripts','open-central.cjs'),...extraArgs],{cwd:projectRoot,windowsHide:true,stdio:['ignore','pipe','pipe']});
    } catch(error) {
      append(`[${now().toISOString()}] erro=${error.message}\n`);finish(1);return;
    }
    let stdoutBuffer='';
    const consume=(chunk,stream)=>{
      const text=chunk.toString();append(`[${now().toISOString()}] [${stream}] ${text}`);
      if(stream!=='stdout') return;
      stdoutBuffer+=text;
      const lines=stdoutBuffer.split(/\r?\n/);stdoutBuffer=lines.pop() || '';
      for(const line of lines) {const event=classifyLine(line);if(event) emit(event);}
    };
    child.stdout.on('data',chunk=>consume(chunk,'stdout'));
    child.stderr.on('data',chunk=>consume(chunk,'stderr'));
    child.on('error',error=>{append(`[${now().toISOString()}] erro=${error.message}\n`);finish(1);});
    child.on('close',code=>{
      if(stdoutBuffer) {const event=classifyLine(stdoutBuffer);if(event) emit(event);}
      finish(Number.isInteger(code)?code:1);
    });
  });
}

module.exports={classifyLine,runVisualLauncher};

if(require.main===module) runVisualLauncher({extraArgs:process.argv.slice(2)}).then(code=>{process.exitCode=code;});
