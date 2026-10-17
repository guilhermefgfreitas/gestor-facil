/*
 * PONTE SEGURA ENTRE A INTERFACE E O PROCESSO PRINCIPAL
 * Somente os métodos declarados abaixo ficam disponíveis em window.api.
 * Cada método encaminha uma operação nomeada; a tela não recebe acesso direto
 * a ipcRenderer, ao sistema de arquivos ou ao banco de dados.
 */
const { contextBridge, ipcRenderer } = require('electron');


// API pública mínima consumida por src/renderer.js.
contextBridge.exposeInMainWorld('api', {

    obterEstadoLicenca: () => ipcRenderer.invoke('obter-estado-licenca'),

    ativarLicenca: (codigo) => ipcRenderer.invoke('ativar-licenca', codigo),

    verificarAtualizacoes: () => ipcRenderer.invoke('verificar-atualizacoes'),

    instalarAtualizacao: () => ipcRenderer.invoke('instalar-atualizacao'),

    aoAtualizarStatus: (callback) => {
        const listener = (_event, status) => callback(status);
        ipcRenderer.on('status-atualizacao', listener);
        return () => ipcRenderer.removeListener('status-atualizacao', listener);
    },


    /*
        ==========================================
        AUTENTICAÇÃO
        ==========================================
    */


    login: (dados) => {

        return ipcRenderer.invoke(
            'login',
            dados
        );

    },


    /*
        ==========================================
        PRODUTOS
        ==========================================
    */


    listarProdutos: () => {

        return ipcRenderer.invoke(
            'listar-produtos'
        );

    },


    cadastrarProduto: (produto) => {

        return ipcRenderer.invoke(
            'cadastrar-produto',
            produto
        );

    },


    editarProduto: (produto) => {

        return ipcRenderer.invoke(
            'editar-produto',
            produto
        );

    },


    excluirProduto: (id) => {

        return ipcRenderer.invoke(
            'excluir-produto',
            id
        );

    },


    /*
        ==========================================
        CLIENTES
        ==========================================
    */


    listarClientes: () => {

        return ipcRenderer.invoke(
            'listar-clientes'
        );

    },


    buscarCliente: (id) => {

        return ipcRenderer.invoke(
            'buscar-cliente',
            id
        );

    },


    cadastrarCliente: (cliente) => {

        return ipcRenderer.invoke(
            'cadastrar-cliente',
            cliente
        );

    },


    editarCliente: (cliente) => {

        return ipcRenderer.invoke(
            'editar-cliente',
            cliente
        );

    },


    excluirCliente: (id) => {

        return ipcRenderer.invoke(
            'excluir-cliente',
            id
        );

    },


    /*
        ==========================================
        ORDENS DE SERVIÇO
        ==========================================
    */


    listarOrdensServico: () => {

        return ipcRenderer.invoke(
            'listar-ordens-servico'
        );

    },


    buscarOrdemServico: (id) => {

        return ipcRenderer.invoke(
            'buscar-ordem-servico',
            id
        );

    },


    cadastrarOrdemServico: (os) => {

        return ipcRenderer.invoke(
            'cadastrar-ordem-servico',
            os
        );

    },


    editarOrdemServico: (os) => {

        return ipcRenderer.invoke(
            'editar-ordem-servico',
            os
        );

    },


    excluirOrdemServico: (id) => {

        return ipcRenderer.invoke(
            'excluir-ordem-servico',
            id
        );

    },


    /*
        ==========================================
        GARANTIAS
        ==========================================
    */

    listarGarantias: () => {
        return ipcRenderer.invoke('listar-garantias');
    },

    cadastrarGarantia: (garantia) => {
        return ipcRenderer.invoke('cadastrar-garantia', garantia);
    },

    editarGarantia: (garantia) => {
        return ipcRenderer.invoke('editar-garantia', garantia);
    },

    /*
        ==========================================
        VENDAS
        ==========================================
    */


    finalizarVenda: (venda) => {

        return ipcRenderer.invoke(
            'finalizar-venda',
            venda
        );

    },


    listarVendas: () => {

        return ipcRenderer.invoke(
            'listar-vendas'
        );

    },


    buscarVenda: (id) => {

        return ipcRenderer.invoke(
            'buscar-venda',
            id
        );

    },


    cancelarVenda: (dados) => ipcRenderer.invoke('cancelar-venda', dados),

    excluirVenda: (id) => {

        return ipcRenderer.invoke(
            'excluir-venda',
            id
        );

    },


    /*
        ==========================================
        ESTOQUE
        ==========================================
    */

    entradaEstoque: (dados) => ipcRenderer.invoke('entrada-estoque', dados),
    saidaEstoque: (dados) => ipcRenderer.invoke('saida-estoque', dados),
    ajusteEstoque: (dados) => ipcRenderer.invoke('ajuste-estoque', dados),
    listarMovimentacoesEstoque: () => ipcRenderer.invoke('listar-movimentacoes-estoque'),


    /*
        ==========================================
        USUÁRIOS E PERMISSÕES
        ==========================================
    */

    listarUsuarios: () => ipcRenderer.invoke('listar-usuarios'),
    cadastrarUsuario: (dados) => ipcRenderer.invoke('cadastrar-usuario', dados),
    editarUsuario: (dados) => ipcRenderer.invoke('editar-usuario', dados),
    alterarSenhaUsuario: (dados) => ipcRenderer.invoke('alterar-senha-usuario', dados),
    alternarStatusUsuario: (id) => ipcRenderer.invoke('alternar-status-usuario', id),
    buscarPermissoesUsuario: (id) => ipcRenderer.invoke('buscar-permissoes-usuario', id),
    salvarPermissoesUsuario: (dados) => ipcRenderer.invoke('salvar-permissoes-usuario', dados),
    listarAuditoria: (filtros) => ipcRenderer.invoke('listar-auditoria', filtros || {}),
    fazerBackup: () => ipcRenderer.invoke('fazer-backup'),
    restaurarBackup: () => ipcRenderer.invoke('restaurar-backup'),
    obterConfigBackup: () => ipcRenderer.invoke('obter-config-backup'),
    selecionarPastaBackup: () => ipcRenderer.invoke('selecionar-pasta-backup'),
    salvarConfigBackup: (dados) => ipcRenderer.invoke('salvar-config-backup', dados),
    testarBackupAutomatico: () => ipcRenderer.invoke('testar-backup-automatico'),
    registrarLogout: () => ipcRenderer.invoke('registrar-logout')

});
