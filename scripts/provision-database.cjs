const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {ensureDatabaseConfig}=require('../lib/database-config.cjs');
function provisionDatabase(root=path.resolve(__dirname,'..')) {
  const config=ensureDatabaseConfig(root);
  if(config.database!=='whatsapp_central' || config.user!=='whatsapp_central' || config.host!=='127.0.0.1' || config.port!==8768) throw new Error('A preparação automática requer a conexão local padrão da central. Prepare seu banco personalizado separadamente.');
  const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
  const sql=`SELECT format('CREATE ROLE whatsapp_central LOGIN PASSWORD %L', ${literal(config.password)}) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='whatsapp_central')\n\\gexec\nSELECT 'CREATE DATABASE whatsapp_central OWNER whatsapp_central' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='whatsapp_central')\n\\gexec\n`;
  try {execFileSync('docker',['compose','-f',path.join(root,'infra','compose.yaml'),'exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','whatsapp','-d','postgres'],{input:sql,encoding:'utf8',windowsHide:true,timeout:30000,stdio:['pipe','pipe','pipe']});}
  catch {throw new Error('Não foi possível preparar o banco PostgreSQL da central. Confira se o serviço postgres do Docker está saudável.');}
}
if(require.main===module) {try {provisionDatabase();console.log('Banco PostgreSQL da central pronto. Banco do conector preservado.');}catch(error) {console.error(error.message);process.exitCode=1;}}
module.exports={provisionDatabase};
