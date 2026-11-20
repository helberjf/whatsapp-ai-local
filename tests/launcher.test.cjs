const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {EventEmitter}=require('node:events');
const {spawnSync}=require('node:child_process');
const {runScript}=require('../scripts/launcher.cjs');
const {ensureDocker}=require('../scripts/open-central.cjs');

test('a abertura espera pelo motor mesmo quando o Docker Desktop já informou sucesso',async()=>{
  let probes=0,starts=0,waits=0;
  await ensureDocker({run(args){
    if(args[0]==='info') return {status:++probes===3?0:1};
    if(!args.includes('--help')) starts++;
    return {status:0};
  },wait:async()=>{waits++;},log(){}});
  assert.deepEqual({probes,starts,waits},{probes:3,starts:1,waits:1});
});
const {classifyLine,runVisualLauncher}=require('../scripts/launcher-ui.cjs');

// Dependências simuladas: nenhum PowerShell nem git de verdade é executado.
function deps({present=true,status=0,error=null,gitFails=false}={}) {
  const calls={written:[],removed:[],spawned:[],logged:[]};
  return {calls,deps:{
    folder:'C:/central/scripts',exists:()=>present,
    gitShow:name=>{if(gitFails) throw new Error('fatal: path not in HEAD');return Buffer.from('\uFEFFWrite-Output "'+name+'"\r\n');},
    write:(file,text)=>calls.written.push({file,text}),remove:file=>calls.removed.push(file),
    spawn:(file,args)=>{calls.spawned.push({file,args});return error?{error}:{status};},log:text=>calls.logged.push(text)
  }};
}

test('script presente roda direto, com os argumentos, e devolve o código de saída',()=>{
  const {deps:d,calls}=deps({status:3});
  assert.equal(runScript('stop.ps1',['-NoBrowser'],d),3);
  assert.deepEqual(calls.spawned,[{file:path.join('C:/central/scripts','stop.ps1'),args:['-NoBrowser']}]);
  assert.deepEqual([calls.written.length,calls.removed.length],[0,0]);
});

test('script apagado da cópia local vem do commit, roda na mesma pasta e a cópia temporária é removida',()=>{
  const {deps:d,calls}=deps({present:false});
  assert.equal(runScript('stop.ps1',[],d),0);
  const [written]=calls.written;
  assert.equal(path.dirname(written.file),path.normalize('C:/central/scripts'),'Na mesma pasta: o script acha os dados pela própria pasta.');
  assert.match(path.basename(written.file),/^\.stop-[0-9a-f-]{36}\.ps1$/);
  assert.equal(written.text,'\uFEFFWrite-Output "stop.ps1"\r\n','Uma única marca de início, para o PowerShell ler os acentos.');
  assert.equal(calls.spawned[0].file,written.file);assert.deepEqual(calls.removed,[written.file]);
});

test('falha do PowerShell ou do commit vira código 1 com mensagem, e a cópia temporária não fica para trás',()=>{
  const spawnFailure=deps({present:false,error:new Error('powershell.exe não encontrado')});
  assert.equal(runScript('start-central.ps1',[],spawnFailure.deps),1);
  assert.match(spawnFailure.calls.logged[0],/start-central\.ps1: powershell\.exe não encontrado/);
  assert.equal(spawnFailure.calls.removed.length,1);
  const missing=deps({present:false,gitFails:true});
  assert.equal(runScript('stop.ps1',[],missing.deps),1);assert.equal(missing.calls.spawned.length,0);
  assert.match(missing.calls.logged[0],/path not in HEAD/);
});

test('atalhos de iniciar e parar usam fim de linha do Windows e chamam os scripts certos',()=>{
  const root=path.join(__dirname,'..');
  for(const [file,script] of [['Iniciar WhatsApp Central.cmd','open-central.cjs'],['Parar WhatsApp Central.cmd','stop-central.cjs']]) {
    const text=fs.readFileSync(path.join(root,file),'utf8');
    assert.match(text,new RegExp('node scripts\\\\'+script.replace('.','\\.')));
    assert.equal(text.split('\n').length-1,text.split('\r\n').length-1,file+' precisa de CRLF em todas as linhas.');
  }
  const scripts=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts;
  assert.deepEqual([scripts.start,scripts.stop],['node scripts/open-central.cjs','node scripts/stop-central.cjs']);
});

test('somente os iniciadores canônicos de abrir e parar permanecem',()=>{
  const root=path.join(__dirname,'..');
  assert.equal(fs.existsSync(path.join(root,'Iniciar WhatsApp Central.cmd')),true);
  assert.equal(fs.existsSync(path.join(root,'Parar WhatsApp Central.cmd')),true);
  for(const legacy of ['Abrir WhatsApp.cmd','Iniciar WhatsApp.cmd','Iniciar WhatsApp Local.cmd','Parar WhatsApp.cmd']) assert.equal(fs.existsSync(path.join(root,legacy)),false,legacy+' deve ser removido');
});

test('atalhos do Windows usam a abertura visual e reconhecem formatos antigos do projeto',()=>{
  const root=path.join(__dirname,'..'),shortcut=fs.readFileSync(path.join(root,'scripts','shortcut.ps1'),'utf8'),autostart=fs.readFileSync(path.join(root,'scripts','autostart.ps1'),'utf8');
  assert.match(shortcut,/open-central-ui\.vbs/);
  assert.match(shortcut,/System32\\wscript\.exe/);
  assert.match(shortcut,/public\\icons\\whats-ai\.ico/);
  assert.match(autostart,/open-central-ui\.vbs/);
  assert.match(autostart,/System32\\wscript\.exe/);
  assert.match(autostart,/-NoBrowser/);
  assert.match(shortcut,/Iniciar WhatsApp Central\.cmd/);
  assert.match(autostart,/Iniciar WhatsApp Central\.cmd/);
  assert.doesNotMatch(shortcut+autostart,/\$shortcut\.TargetPath=.*cmd\.exe/);
});

test('iniciador PowerShell antigo usa o launcher resiliente quando o script principal foi apagado',()=>{
  const root=path.join(__dirname,'..'),legacy=fs.readFileSync(path.join(root,'scripts','start.ps1'),'utf8');
  assert.match(legacy,/open-central\.cjs/);
  assert.doesNotMatch(legacy,/Join-Path \$PSScriptRoot 'start-central\.ps1'/);
});

test('iniciador abre uma URL nova para não reutilizar a aba antiga em cache',()=>{
  let start;
  assert.equal(runScript('start-central.ps1',[],{spawn:file=>{start=fs.readFileSync(file,'utf8');return {status:0};}}),0);
  assert.match(start,/\$launchNonce=\[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\)/);
  assert.match(start,/\$launchUrl=\$centralUrl\+'\?iniciar='\+\$launchNonce/);
  assert.match(start,/Start-Process \$launchUrl/);
  assert.match(start,/Start-Process \(\$launchUrl\+'\&conectar=1'\)/);
  assert.doesNotMatch(start,/Start-Process \$centralUrl/);
});

test('carregamento visual traduz somente marcos estáveis do iniciador',()=>{
  assert.deepEqual(classifyLine('Configuração local pronta. Segredos preservados.'),{step:2,status:'Iniciando serviços...'});
  assert.deepEqual(classifyLine('Preparando WhatsApp, banco e sessão persistente…'),{step:3,status:'Iniciando banco e conector...'});
  assert.deepEqual(classifyLine('Banco PostgreSQL da central pronto. Banco do conector preservado.'),{step:4,status:'Abrindo a Central...'});
  assert.deepEqual(classifyLine('Central ja iniciada. Reutilizando a sessao.'),{step:4,status:'Central pronta.',done:true});
  assert.deepEqual(classifyLine('Whats AI pronto: http://127.0.0.1:8766/'),{step:4,status:'Central pronta.',done:true});
  assert.equal(classifyLine('uma linha técnica qualquer'),null);
});

test('o servidor da central é iniciado fora da árvore de processos do atalho',()=>{
  let start;
  assert.equal(runScript('start-central.ps1',[],{spawn:file=>{start=fs.readFileSync(file,'utf8');return {status:0};}}),0);
  assert.match(start,/Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(start,/run-central-server\.ps1/);
  assert.doesNotMatch(start,/Start-Process -FilePath \$nodePath/);
});

test('a conferência aguarda a central sair da inicialização',async()=>{
  const {waitForCentral}=require('../scripts/launcher-ui.cjs');
  let attempts=0;
  await waitForCentral({wait:async()=>{},request:async()=>{
    attempts++;
    if(attempts===1) throw new TypeError('fetch failed');
    if(attempts===2) return Response.json({service:'whatsapp-local',ready:false},{status:503});
    return Response.json({service:'whatsapp-local'});
  }});
  assert.equal(attempts,3);
});

test('adaptador visual oculta o processo, registra saídas e preserva argumentos',async()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const calls={spawned:[],appended:[],emitted:[]};
  const promise=runVisualLauncher({
    root:'C:/central',extraArgs:['-NoBrowser'],
    spawn:(file,args,options)=>{calls.spawned.push({file,args,options});return child;},
    append:text=>calls.appended.push(text),emit:event=>calls.emitted.push(event),now:()=>new Date('2026-11-16T12:00:00.000Z'),
    nodePath:'C:/node/node.exe',checkReady:async()=>{}
  });
  child.stdout.emit('data',Buffer.from('Configuração local pronta. Segredos preservados.\r\nBanco PostgreSQL da central pronto.\r\n'));
  child.stderr.emit('data',Buffer.from('aviso técnico\r\n'));
  child.emit('close',0);
  assert.equal(await promise,0);
  assert.deepEqual(calls.spawned,[{file:'C:/node/node.exe',args:[path.join('C:/central','scripts','open-central.cjs'),'-NoBrowser'],options:{cwd:'C:/central',windowsHide:true,stdio:['ignore','pipe','pipe']}}]);
  assert.deepEqual(calls.emitted,[{step:2,status:'Iniciando serviços...'},{step:4,status:'Abrindo a Central...'}]);
  assert.match(calls.appended.join(''),/2026-11-16T12:00:00\.000Z.*inicio/);
  assert.match(calls.appended.join(''),/aviso técnico/);
  assert.match(calls.appended.join(''),/exit=0/);
});

test('atalho abre o webapp durante a inicialização e só libera a central após a conferência',async()=>{
  for(const available of [false,true]) {
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    const events=[];
    const result=runVisualLauncher({
      spawn:()=>child,append:()=>{},emit:()=>{},
      startPage:async()=>({url:'http://127.0.0.1:12345/loading',ready:()=>events.push('ready'),fail:()=>events.push('failed'),close:()=>{}}),
      checkReady:async()=>{events.push('health');if(!available) throw Error('offline');},
      openBrowser:async url=>{assert.equal(url,'http://127.0.0.1:12345/loading');events.push('browser');}
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,['browser'],'abre antes de o processo de inicialização terminar');
    child.emit('close',0);
    assert.equal(await result,available?0:1);
    assert.deepEqual(events,available?['browser','health','ready']:['browser','health','failed']);
  }
});

test('tela de abertura espera, redireciona quando pronta e mostra falha de inicialização',async()=>{
  const {startLaunchPage}=require('../scripts/launch-page.cjs');
  for(const success of [true,false]) {
    const page=await startLaunchPage(path.join(__dirname,'..'),'http://127.0.0.1:8766/?iniciar=123');
    try {
      const loading=await fetch(page.url);
      assert.match(await loading.text(),/Abrindo Whats AI/);
      if(success) {
        page.ready();
        const target='http://127.0.0.1:8766/?iniciar=123';
        for(let attempt=0;attempt<2;attempt++) {
          const ready=await fetch(page.url,{redirect:'manual',headers:{Connection:'close'}});
          assert.equal(ready.status,302);
          assert.equal(ready.headers.get('location'),target);
        }
        const status=await (await fetch(page.url+'/status')).json();
        assert.equal(status.targetUrl,target);
      } else {
        page.fail();
        const failed=await (await fetch(page.url)).text();
        assert.match(failed,/Não foi possível iniciar/);
        assert.doesNotMatch(failed,/http-equiv="refresh"/);
      }
    } finally {page.close();}
  }
});

test('libera o webapp quando o processo termina mesmo com canais herdados ainda abertos',async()=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  let ready=false;
  const result=runVisualLauncher({
    spawn:()=>child,append:()=>{},emit:()=>{},
    checkReady:async()=>{},openBrowser:async()=>{},
    startPage:async()=>({url:'http://127.0.0.1:12345/loading',ready:()=>{ready=true;},close(){},fail(){}})
  });
  await new Promise(resolve=>setImmediate(resolve));
  child.emit('exit',0);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ready,true);
  assert.equal(await result,0);
  child.emit('close',0);
});

test('falha na abertura não mantém o iniciador preso pelo servidor de carregamento',()=>{
  const source=`require('./scripts/launch-page.cjs').startLaunchPage(process.cwd(),'http://127.0.0.1:8766/').then(page=>page.fail())`;
  const result=spawnSync(process.execPath,['-e',source],{cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(result.status,0,result.stderr);
});

test('iniciador invisível abre a interface WPF e preserva o modo sem navegador',()=>{
  const root=path.join(__dirname,'..');
  const vbs=fs.readFileSync(path.join(root,'scripts','open-central-ui.vbs'),'utf8');
  const ui=fs.readFileSync(path.join(root,'scripts','start-ui.ps1'),'utf8');
  assert.match(vbs,/WScript\.Shell/i);
  assert.match(vbs,/start-ui\.ps1/i);
  assert.match(vbs,/-WindowStyle Hidden/i);
  assert.match(vbs,/-NoBrowser/i);
  assert.match(ui,/PresentationFramework/);
  assert.match(ui,/launcher-ui\.cjs/);
  assert.match(ui,/CreateNoWindow\s*=\s*\$true/);
  assert.match(ui,/launcher\.log/);
  assert.match(ui,/Substring\(\$statusPrefix\.Length\)/);
  assert.match(ui,/Central pronta/);
  assert.match(ui,/Fechar/);
  assert.match(ui,/ShowDialog/);
});

test('XAML da abertura visual carrega no Windows',()=>{
  const script=path.join(__dirname,'..','scripts','start-ui.ps1');
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-ValidateOnly'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr || result.stdout);
});
