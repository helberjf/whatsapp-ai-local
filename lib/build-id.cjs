// Identifica o código da central que está em disco. Muda a cada atualização (git pull, zip novo),
// então o iniciador e a página percebem quando a central em execução ainda é a versão anterior.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ROOT=path.join(__dirname,'..');

function sourceFiles(root) {
  const files=['server.cjs','package.json'];
  for(const dir of ['lib','public']) {
    let names=[];try {names=fs.readdirSync(path.join(root,dir),{withFileTypes:true});}catch {continue;}
    for(const entry of names) if(entry.isFile()) files.push(dir+'/'+entry.name);
  }
  return files.sort();
}
function buildId(root=ROOT) {
  const hash=crypto.createHash('sha256');
  for(const file of sourceFiles(root)) {
    let content;try {content=fs.readFileSync(path.join(root,file));}catch {continue;}
    hash.update(file+'\0').update(String(content.length)+'\0').update(content);
  }
  return hash.digest('hex').slice(0,16);
}
module.exports={buildId};
if(require.main===module) process.stdout.write(buildId());
