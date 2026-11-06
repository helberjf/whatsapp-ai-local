const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {ApiError}=require('./evolution.cjs');
const {createStore}=require('./store.cjs');
const PRIMARY='principal',MAX_ACCOUNTS=10,REGISTRY='contas.json';
const validId=/^[a-z0-9-]{1,40}$/,validInstance=/^[a-zA-Z0-9_-]{1,80}$/;
function accountName(value) {
  if(typeof value!=='string' || !value.trim() || value.trim().length>60) throw new ApiError('Dê um nome de até 60 caracteres à conta.',422);
  return value.trim();
}
// A conta que já existia continua em data/atendimento.json: nada é movido e a instância pareada é a mesma.
const accountDir=(dataDir,id)=>id===PRIMARY?dataDir:path.join(dataDir,'contas',id);
function loadAccounts(dataDir,config) {
  let saved=null;
  try {saved=JSON.parse(fs.readFileSync(path.join(dataDir,REGISTRY),'utf8'));}
  catch(error) {if(error.code!=='ENOENT') throw new Error('data/contas.json está inválido. Corrija o arquivo: as contas não foram alteradas.');}
  if(saved===null) return [{id:PRIMARY,name:'Conta principal',instanceName:config?.instanceName,createdAt:null}];
  if(!Array.isArray(saved.accounts) || !saved.accounts.length || saved.accounts.some(item=>!validId.test(item?.id || '') || !validInstance.test(item?.instanceName || '') || typeof item.name!=='string')) throw new Error('data/contas.json está inválido. Corrija o arquivo: as contas não foram alteradas.');
  return saved.accounts;
}
// Lista de contas. O arquivo só nasce quando a primeira alteração acontece; até lá vale a instância de config.json.
function createAccountRegistry(dataDir,config,now=Date.now,options={}) {
  let accounts=options.accounts || loadAccounts(dataDir,config);
  if(!Array.isArray(accounts) || !accounts.length || accounts.some(item=>!validId.test(item?.id || '') || !validInstance.test(item?.instanceName || '') || typeof item.name!=='string')) throw new Error('Cadastro de contas inválido. As contas não foram alteradas.');
  const store=(options.storeFactory || createStore)(dataDir,{file:REGISTRY,initial:{accounts:[]}});
  const save=next=>store.update(data=>{data.accounts=next;}).then(()=>{accounts=next;});
  const find=id=>{const account=accounts.find(item=>item.id===id);if(!account) throw new ApiError('Conta não encontrada. Recarregue a página.',404);return account;};
  const unique=(name,id)=>{if(accounts.some(item=>item.id!==id && item.name.toLocaleLowerCase('pt-BR')===name.toLocaleLowerCase('pt-BR'))) throw new ApiError('Já existe uma conta com este nome.',409);return name;};
  let queue=Promise.resolve();
  const serial=task=>{const operation=queue.then(task);queue=operation.catch(()=>{});return operation;};
  return {
    list:()=>accounts.map(item=>({...item})),
    get:id=>({...find(id)}),
    fallback:()=>({...accounts[0]}),
    add:input=>serial(async()=>{
      const name=unique(accountName(input),null);if(accounts.length>=MAX_ACCOUNTS) throw new ApiError(`Conecte até ${MAX_ACCOUNTS} contas.`,422);
      const id=randomBytes(6).toString('hex'),account={id,name,instanceName:'whats-ai-'+id,createdAt:new Date(now()).toISOString()};
      await save([...accounts,account]);return {...account};
    }),
    rename:(id,input)=>serial(async()=>{
      const current=find(id),name=unique(accountName(input),id),account={...current,name};
      await save(accounts.map(item=>item.id===id?account:item));return {...account};
    }),
    // A checagem e a limpeza no conector ficam na fila: remoções simultâneas não podem zerar a lista.
    remove:(id,cleanup)=>serial(async()=>{
      find(id);if(accounts.length===1) throw new ApiError('Esta é a única conta. Use Desconectar para encerrar a sessão.',409);
      await cleanup();await save(accounts.filter(item=>item.id!==id));
    })
  };
}
// Remover uma conta não apaga notas nem automações: o arquivo local é guardado fora do uso.
async function archiveAccount(dataDir,id,now=Date.now) {
  const target=path.join(dataDir,'contas-arquivadas');await fs.promises.mkdir(target,{recursive:true});
  try {await fs.promises.rename(path.join(accountDir(dataDir,id),'atendimento.json'),path.join(target,`${id}-${now()}.json`));}
  catch(error) {if(error.code!=='ENOENT') throw error;}
  if(id!==PRIMARY) await fs.promises.rmdir(accountDir(dataDir,id)).catch(()=>{});
}
module.exports={createAccountRegistry,archiveAccount,accountDir,accountName,PRIMARY,MAX_ACCOUNTS};
