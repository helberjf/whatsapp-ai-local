// Para a central e os serviços do Docker, preservando a sessão do WhatsApp e o histórico.
// Usado por "Parar WhatsApp Central.cmd" e `npm run stop`.
const {runScript}=require('./launcher.cjs');
process.exitCode=runScript('stop.ps1',process.argv.slice(2));
