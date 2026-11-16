// Diagnóstico: perguntas que estouraram os 90 s do app, repetidas com o mesmo prompt e prazo maior.
// Não é resultado do app (ele teria falhado); serve para saber o que o modelo teria respondido.
const fs=require('node:fs');
const path=require('node:path');
const {snapshot,createInstance,core}=require('./harness.cjs');
const data=require('./dataset.cjs');
(async()=>{
  const prod=snapshot(),instance=await createInstance({documents:prod.documents,products:prod.products,ai:prod.ai}),catalog=await instance.services.catalogText(),output=[];
  for(const id of process.argv.slice(2)) {
    const test=data.real.find(item=>item.id===id),sources=await instance.services.retrieve(test.q),started=Date.now();
    const answer=await instance.services.ai.complete({system:core.buildSystem({rules:prod.assistant.rules,catalog,sources,reliability:prod.reliability}),user:test.q,maxTokens:700,timeoutMs:400_000});
    output.push({id,ms:Date.now()-started,sources:sources.map(item=>item.docName+'#'+item.index+':'+item.confidence),chars:answer.length,answer});
    console.log(id,Math.round((Date.now()-started)/1000)+'s',answer.length+' caracteres\n'+answer+'\n');
  }
  fs.writeFileSync(path.join(__dirname,'results','timeouts.json'),JSON.stringify(output,null,1));await instance.close();
})().catch(error=>{console.error(error);process.exit(1);});
