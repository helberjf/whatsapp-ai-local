const http=require('node:http');
async function reserveApplicationPort(port,host='127.0.0.1') {
  const booting=(req,res)=>{res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Retry-After':'2'});res.end(JSON.stringify({service:'whatsapp-local',ready:false}));};
  const server=http.createServer(booting);
  await new Promise((resolve,reject)=>{const failed=error=>{server.removeListener('listening',listening);reject(error);},listening=()=>{server.removeListener('error',failed);resolve();};server.once('error',failed);server.once('listening',listening);server.listen(port,host);});
  return {server,activate:()=>server.removeListener('request',booting),close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
module.exports={reserveApplicationPort};
