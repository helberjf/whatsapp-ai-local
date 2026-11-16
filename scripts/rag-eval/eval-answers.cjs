// Avaliação das RESPOSTAS com o modelo real, pelos caminhos do app:
//  - perguntas isoladas: rota POST /api/kb/ask ("Testar a base"), com as regras da produção;
//  - conversas: serviço de respostas automáticas (contato em rascunho), com origem "base de conhecimento".
// Uso: node eval-answers.cjs [real|synt] [--repeat N] [--only ID,ID]. Retoma de onde parou. Saída: results/answers-<corpus>.json
const fs=require('node:fs');
const path=require('node:path');
const {snapshot,createInstance,score,assistantReply,grade,unsupportedNumbers}=require('./harness.cjs');
const data=require('./dataset.cjs');
const HANDOFF_TEXT='Não encontrei essa informação na base. Vou consultar um atendente para ajudar.';
const corpus=process.argv[2]==='synt'?'synt':'real',flag=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];};
const repeat=Number(flag('--repeat') || 1),only=flag('--only')?.split(','),file=path.join(__dirname,'results',`answers-${corpus}${process.env.RUN_TAG || ''}.json`);

(async()=>{
  const prod=snapshot(),rules=prod.assistant.rules,rulesText=rules.map(rule=>rule.text).join('\n');
  const tests=(corpus==='real'?data.real:data.synthetic.tests).filter(test=>!only || only.includes(test.id));
  const documents=corpus==='real'?prod.documents:[...prod.documents,...data.synthetic.documents.map(doc=>doc.csv?{name:doc.name,base64:Buffer.from(doc.csv).toString('base64')}:{name:doc.name,text:doc.text})];
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const output=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{startedAt:new Date().toISOString(),config:{ai:prod.ai,reliability:prod.reliability,rules:rules.length,chat:{source:'base',tone:prod.assistant.tone,history:prod.assistant.history}},runs:[]};
  const instance=await createInstance({documents,products:prod.products,ai:prod.ai}),catalog=await instance.services.catalogText();
  output.catalogChars=catalog.length;
  for(let round=0;round<repeat;round++) for(const test of tests) {
    if(output.runs.some(run=>run.id===test.id && run.round===round)) continue;
    const started=Date.now(),run={id:test.id,round,cat:test.cat,mode:test.mode};
    try {
      if(test.mode==='chat') {
        const result=await assistantReply(instance,{history:test.history,rules,settings:{source:'base',tone:prod.assistant.tone,history:prod.assistant.history},otherContacts:test.other?[test.other]:[]});
        const sources=result.queries[0]?.results || [];
        Object.assign(run,{question:test.history.map(message=>message.from+': '+message.text).join(' | '),retrievalQuery:result.queries[0]?.query,answer:result.answer,handoff:result.handoff,guard:/^Resposta retida/.test(result.detail || '')?result.detail:undefined,action:result.action,detail:result.detail,sources:sources.map(item=>({doc:item.docName,index:item.index,confidence:item.confidence,via:item.via})),sourceTexts:sources.map(item=>item.text),system:result.prompts[0]?.system,generationMs:result.prompts[0]?.ms,retrievalMs:result.queries[0]?.ms});
        if(test.gold) run.goldSent=score(sources,test.gold,sources.length || 1).all;
        run.context=[catalog,rulesText,...run.sourceTexts,...test.history.map(message=>message.text)].join('\n');
      } else {
        const result=await instance.call('POST','/api/kb/ask',{question:test.q},{rules:async()=>rules});
        const sources=result.sources.map(item=>({docName:item.doc,text:item.text,confidence:item.confidence,via:item.via}));
        Object.assign(run,{question:test.q,answer:result.answer,handoff:result.answer===HANDOFF_TEXT,guard:result.guard,usedAi:result.usedAi,confidence:result.confidence,sources:result.sources.map(item=>({doc:item.doc,confidence:item.confidence,via:item.via})),sourceTexts:result.sources.map(item=>item.text),appMs:result.ms});
        if(test.gold) run.goldSent=score(sources,test.gold,sources.length || 1).all;
        run.context=[catalog,rulesText,...run.sourceTexts,test.q].join('\n');
      }
      run.auto=grade(test,run.answer,run.handoff);
      run.unsupported=run.handoff?[]:unsupportedNumbers(run.answer,run.context);
    } catch(error) {run.error=error.message;run.auto={pass:false,reasons:['erro: '+error.message]};}
    run.ms=Date.now()-started;delete run.context;
    output.runs.push(run);fs.writeFileSync(file,JSON.stringify(output,null,1));
    console.log(`${test.id} r${round} ${run.auto.pass?'ok   ':'FALHA'} ${(run.ms/1000).toFixed(0)}s ${run.handoff?'[encaminhou] ':''}${String(run.answer || run.error || '').replace(/\s+/g,' ').slice(0,150)}${run.auto.pass?'':' <<'+run.auto.reasons.join('; ')+'>>'}`);
  }
  await instance.close();
})().catch(error=>{console.error(error);process.exit(1);});
