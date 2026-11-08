const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');

const root=path.join(__dirname,'..');
let launcher=path.join(__dirname,'start-central.ps1'),temporary;

try {
  if(!fs.existsSync(launcher)) {
    const source=execFileSync('git',['show','HEAD:scripts/start-central.ps1'],{cwd:root,windowsHide:true});
    temporary=path.join(__dirname,`.start-central-${randomUUID()}.ps1`);
    // O PowerShell usa a pasta deste script para localizar os dados e o Docker Compose.
    const script=source.toString('utf8').replace(/^\uFEFF/,'');
    fs.writeFileSync(temporary,'\uFEFF'+script,{flag:'wx'});
    launcher=temporary;
  }

  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',launcher,...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
  if(result.error) throw result.error;
  process.exitCode=result.status ?? 1;
} catch(error) {
  console.error('Falha ao abrir o WhatsApp: '+error.message);
  process.exitCode=1;
} finally {
  if(temporary) fs.rmSync(temporary,{force:true});
}
