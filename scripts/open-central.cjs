// Abre a central: Docker, banco e servidor. Usado por "Iniciar WhatsApp Central.cmd" e `npm start`.
const {runScript}=require('./launcher.cjs');
process.exitCode=runScript('start-central.ps1',process.argv.slice(2));
