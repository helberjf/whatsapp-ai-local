const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {ensureDatabaseConfig}=require('../lib/database-config.cjs');

function runSql(root,database,sql) {
  execFileSync('docker',['compose','-f',path.join(root,'infra','compose.yaml'),'exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','whatsapp','-d',database],{input:sql,encoding:'utf8',windowsHide:true,timeout:45000,stdio:['pipe','pipe','pipe']});
}

function provisionDatabase(root=path.resolve(__dirname,'..')) {
  const config=ensureDatabaseConfig(root);
  if(config.database!=='whatsapp_central' || config.user!=='whatsapp_central' || config.host!=='127.0.0.1' || config.port!==8768) throw new Error('A preparação automática requer a conexão local padrão da central. Prepare seu banco personalizado separadamente.');
  const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
  const sql=`SELECT format('CREATE ROLE whatsapp_central LOGIN PASSWORD %L', ${literal(config.password)}) WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='whatsapp_central')\n\\gexec\nSELECT 'CREATE DATABASE whatsapp_central OWNER whatsapp_central' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='whatsapp_central')\n\\gexec\n`;
  try {runSql(root,'postgres',sql);}
  catch {throw new Error('Não foi possível preparar o banco PostgreSQL da central. Confira se o serviço postgres do Docker está saudável.');}

  // A Evolution conta mensagens não lidas por conversa usando o identificador dentro do JSON.
  const connectorIndex=`SET lock_timeout = '5s';
SET statement_timeout = '30s';
SELECT $index$CREATE INDEX IF NOT EXISTS whats_ai_message_chat_status_idx
  ON public."Message" ("instanceId", ("key"->>'remoteJid'), "status")$index$
WHERE to_regclass('public."Message"') IS NOT NULL
  AND to_regclass('public.whats_ai_message_chat_status_idx') IS NULL
\\gexec
`;
  try {runSql(root,'whatsapp',connectorIndex);}
  catch {console.warn('O índice de conversas será tentado de novo na próxima inicialização completa.');}
}
if(require.main===module) {try {provisionDatabase();console.log('Banco PostgreSQL da central pronto. Banco do conector preservado.');}catch(error) {console.error(error.message);process.exitCode=1;}}
module.exports={provisionDatabase};
