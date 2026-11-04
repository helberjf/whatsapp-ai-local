// Trabalho em segundo plano para as respostas automáticas: no máximo uma tarefa por contato,
// limite global de execuções simultâneas e acompanhamento para idle()/testes.
function createLimiter(max) {
  let active=0;const waiting=[];
  const next=()=>{if(active>=max || !waiting.length) return;active++;const {fn,resolve,reject}=waiting.shift();Promise.resolve().then(fn).then(resolve,reject).finally(()=>{active--;next();});};
  return {
    run(fn) {return new Promise((resolve,reject)=>{waiting.push({fn,resolve,reject});next();});},
    get active() {return active;},
    get waiting() {return waiting.length;}
  };
}

function createBackground() {
  const byKey=new Map(),all=new Set();
  return {
    // Retorna false quando o contato já tem uma tarefa em andamento; o próximo ciclo confere de novo.
    dispatch(key,fn) {
      if(byKey.has(key)) return false;
      const task=Promise.resolve().then(fn).catch(()=>{}).finally(()=>{all.delete(task);if(byKey.get(key)===task) byKey.delete(key);});
      byKey.set(key,task);all.add(task);return true;
    },
    // Encadeia depois da tarefa atual do mesmo contato (mantém a ordem das mensagens).
    chain(key,fn) {
      const previous=byKey.get(key) || Promise.resolve();
      const task=previous.then(fn).catch(()=>{}).finally(()=>{all.delete(task);if(byKey.get(key)===task) byKey.delete(key);});
      byKey.set(key,task);all.add(task);return task;
    },
    busy:key=>byKey.has(key),
    get size() {return all.size;},
    async idle() {while(all.size) await Promise.allSettled([...all]);}
  };
}
module.exports={createLimiter,createBackground};
