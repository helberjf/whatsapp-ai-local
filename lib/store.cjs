const fs=require('node:fs/promises');
const path=require('node:path');
const defaults={contacts:{},requests:{},settings:{templates:[{name:'Boas-vindas',body:'Olá! Como posso ajudar?'},{name:'Aguarde um momento',body:'Vou conferir as informações e já retorno.'}]}};
// Cada arquivo guarda um conjunto independente (atendimento, produtos, IA). Gravação atômica e sequencial.
function createStore(directory,{file:name='atendimento.json',initial=defaults}={}) {
  const file=path.join(directory,name);let loaded,queue=Promise.resolve();
  async function load() {
    if(!loaded) loaded=(async()=>{
      try {return JSON.parse(await fs.readFile(file,'utf8'));}
      catch(error) {if(error.code!=='ENOENT') throw error;return structuredClone(initial);}
    })();
    return loaded;
  }
  return {
    read:async()=>structuredClone(await load()),
    update(fn) {
      const operation=queue.then(async()=>{
        const next=structuredClone(await load()),result=fn(next);
        await fs.mkdir(directory,{recursive:true});const temp=file+'.tmp';
        await fs.writeFile(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);
        loaded=Promise.resolve(next);return structuredClone(result);
      });
      queue=operation.catch(()=>{});return operation;
    }
  };
}
module.exports={createStore};
