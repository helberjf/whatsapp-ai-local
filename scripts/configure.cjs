const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const root=path.resolve(__dirname,'..'),data=path.join(root,'data'),configFile=path.join(data,'config.json'),envFile=path.join(root,'infra','.env');
fs.mkdirSync(data,{recursive:true});
fs.mkdirSync(path.join(data,'certs'),{recursive:true});
if(!fs.existsSync(path.join(data,'certs','windows-ca.pem'))) fs.writeFileSync(path.join(data,'certs','windows-ca.pem'),'');
// O configurador nunca substitui segredos existentes: a sessão deve sobreviver a novas inicializações.
if(!fs.existsSync(configFile) && !fs.existsSync(envFile)) {
  const apiKey=randomBytes(32).toString('hex');
  fs.writeFileSync(configFile,JSON.stringify({apiUrl:'http://127.0.0.1:8767',apiKey,instanceName:'whatsapp-local'},null,2)+'\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(envFile,`AUTHENTICATION_API_KEY=${apiKey}\nPOSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nREDIS_PASSWORD=${randomBytes(32).toString('hex')}\n`,{flag:'wx',mode:0o600});
} else if(!fs.existsSync(configFile) || !fs.existsSync(envFile)) {
  console.error('Configuração incompleta. Restaure data/config.json e infra/.env do mesmo backup antes de continuar.');process.exit(1);
}
console.log('Configuração local pronta. Segredos preservados.');
