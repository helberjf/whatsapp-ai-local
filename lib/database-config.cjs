const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
function ensureDatabaseConfig(root) {
  const envFile=path.join(root,'infra','.env'),file=path.join(root,'data','database.json');
  if(fs.existsSync(file)) return JSON.parse(fs.readFileSync(file,'utf8'));
  let env=fs.readFileSync(envFile,'utf8'),password=env.match(/^CENTRAL_DB_PASSWORD=([^\r\n]+)$/m)?.[1];
  if(!password) {password=randomBytes(32).toString('hex');env+=(env.endsWith('\n')?'':'\n')+'CENTRAL_DB_PASSWORD='+password+'\n';fs.writeFileSync(envFile,env,{mode:0o600});}
  const config={host:'127.0.0.1',port:8768,database:'whatsapp_central',user:'whatsapp_central',password};
  fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});return config;
}
module.exports={ensureDatabaseConfig};
