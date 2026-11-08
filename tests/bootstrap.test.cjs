const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {reserveApplicationPort}=require('../lib/bootstrap.cjs');
test('porta ocupada impede qualquer inicialização ou migração',async t=>{
  const existing=http.createServer((req,res)=>res.end('legacy'));await new Promise(resolve=>existing.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>existing.close(resolve)));
  let initialized=false;await assert.rejects((async()=>{const reserved=await reserveApplicationPort(existing.address().port);initialized=true;await reserved.close();})(),error=>error.code==='EADDRINUSE');assert.equal(initialized,false);
});
test('reserva responde indisponível até ativação e mantém a mesma porta',async()=>{
  const reserved=await reserveApplicationPort(0),url='http://127.0.0.1:'+reserved.server.address().port;
  try {assert.equal((await fetch(url+'/health')).status,503);reserved.activate();reserved.server.on('request',(req,res)=>res.end('ready'));assert.equal(await(await fetch(url)).text(),'ready');}finally {await reserved.close();}
});
