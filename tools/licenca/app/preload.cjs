const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenciador', {
    gerar: (dados) => ipcRenderer.invoke('licenca:gerar', dados),
    copiar: (codigo) => ipcRenderer.invoke('licenca:copiar', codigo),
    salvar: (codigo) => ipcRenderer.invoke('licenca:salvar', codigo),
    estado: () => ipcRenderer.invoke('licenca:estado')
});
