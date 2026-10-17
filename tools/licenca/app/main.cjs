const { app, BrowserWindow, clipboard, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { gerarLicenca, caminhoChavePrivada } = require('./license-core.cjs');

function criarJanela() {
    const janela = new BrowserWindow({
        width: 760,
        height: 700,
        minWidth: 640,
        minHeight: 620,
        autoHideMenuBar: true,
        backgroundColor: '#f4f7fc',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    janela.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('licenca:gerar', (_event, dados) => {
    try {
        return { sucesso: true, codigo: gerarLicenca(dados) };
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message };
    }
});

ipcMain.handle('licenca:copiar', (_event, codigo) => {
    if (!String(codigo || '').trim()) return { sucesso: false, mensagem: 'Gere uma licença primeiro.' };
    clipboard.writeText(String(codigo).trim());
    return { sucesso: true };
});

ipcMain.handle('licenca:salvar', async (_event, codigo) => {
    const texto = String(codigo || '').trim();
    if (!texto) return { sucesso: false, mensagem: 'Gere uma licença primeiro.' };
    const resultado = await dialog.showSaveDialog({
        title: 'Salvar código de licença',
        defaultPath: path.join(app.getPath('documents'), 'licenca-gestor-facil.txt'),
        filters: [{ name: 'Arquivo de texto', extensions: ['txt'] }]
    });
    if (resultado.canceled || !resultado.filePath) return { sucesso: false, cancelado: true };
    fs.writeFileSync(resultado.filePath, `${texto}\r\n`, 'utf8');
    return { sucesso: true, caminho: resultado.filePath };
});

ipcMain.handle('licenca:estado', () => ({ chaveDisponivel: fs.existsSync(caminhoChavePrivada()) }));

app.whenReady().then(() => {
    criarJanela();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) criarJanela();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
