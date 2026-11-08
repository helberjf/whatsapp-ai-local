// Roda um script PowerShell da pasta scripts. Se o arquivo faltar na cópia local (os iniciadores antigos podem ter sido
// apagados e ficar protegidos contra escrita), usa a versão do último commit com um nome temporário na mesma pasta:
// o PowerShell usa a pasta do script para localizar os dados e o Docker Compose.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');

const root=path.join(__dirname,'..');

function runScript(name,args=[],deps={}) {
  const {exists=fs.existsSync,gitShow=file=>execFileSync('git',['show','HEAD:scripts/'+file],{cwd:root,windowsHide:true}),write=(file,text)=>fs.writeFileSync(file,text,{flag:'wx'}),remove=file=>fs.rmSync(file,{force:true}),spawn=(file,rest)=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...rest],{cwd:root,stdio:'inherit'}),log=console.error,folder=__dirname}=deps;
  let script=path.join(folder,name),temporary;
  try {
    if(!exists(script)) {
      const source=gitShow(name).toString('utf8').replace(/^﻿/,'');
      temporary=path.join(folder,`.${path.basename(name,'.ps1')}-${randomUUID()}.ps1`);
      write(temporary,'﻿'+source);script=temporary;
    }
    const result=spawn(script,args);
    if(result.error) throw result.error;
    return result.status ?? 1;
  } catch(error) {
    log('Falha ao executar '+name+': '+error.message);
    return 1;
  } finally {
    if(temporary) remove(temporary);
  }
}
module.exports={runScript};
