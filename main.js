/*
 * PROCESSO PRINCIPAL DO ELECTRON
 * Reúne banco SQLite, janelas, autenticação, permissões, backups e operações
 * de negócio. A tela acessa essas funções apenas pelos canais do preload.
 */
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const descobertaFirebird = require('./database/firebird/descoberta');
const configuracaoFirebird = require('./database/firebird/configuracao');
const { criarConexaoFirebird } = require('./database/firebird/conexao');
const { criarBackupFirebird, validarBackupFirebird, restaurarBackupFirebird } = require('./database/firebird/backup');
const {
    obterEstadoInicializacaoFirebird,
    configurarAdministradorInicialFirebird
} = require('./database/firebird/inicializacao');
const { criarAdaptadorSqlite } = require('./database/adaptador-sqlite');
const { migrarSqliteParaFirebird } = require('./tools/migrar-sqlite-para-firebird.cjs');
const {
    PORTA_PAREAMENTO,
    criarServidorPareamento,
    parearComServidor
} = require('./database/firebird/pareamento');

// Mantém userData estável mesmo se o nome exibido ou o empacotamento mudar.
// Este caminho já corresponde à pasta usada pela configuração de backup existente.
app.setPath('userData', path.join(app.getPath('appData'), 'gestor-facil'));

const licenciamento = require('./licenciamento');
const db = require('./database/banco');
let acessoBanco = criarAdaptadorSqlite(db);
let tipoBancoAtivo = 'sqlite';
let configuracaoFirebirdRuntime = null;
let bancoFirebirdRuntime = null;
let papelInstalacao = 'desconhecido';
let servidorPareamentoFirebird = null;

let atualizacaoPronta = false;
let anunciadorFirebird = null;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function enviarStatusAtualizacao(status, dados = {}) {
    for (const janela of BrowserWindow.getAllWindows()) {
        if (!janela.isDestroyed()) janela.webContents.send('status-atualizacao', { status, ...dados });
    }
}

autoUpdater.on('checking-for-update', () => enviarStatusAtualizacao('verificando'));
autoUpdater.on('update-available', info => enviarStatusAtualizacao('disponivel', { versao: info?.version }));
autoUpdater.on('update-not-available', info => enviarStatusAtualizacao('atualizado', { versao: info?.version }));
autoUpdater.on('download-progress', progresso => enviarStatusAtualizacao('baixando', { percentual: Math.round(progresso?.percent || 0) }));
autoUpdater.on('update-downloaded', info => {
    atualizacaoPronta = true;
    enviarStatusAtualizacao('pronta', { versao: info?.version });
});
autoUpdater.on('error', erro => {
    console.error('Erro no atualizador:', erro);
    enviarStatusAtualizacao('erro');
});



// ==================================================
// ESTOQUE — TABELA DE MOVIMENTAÇÕES
// ==================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        quantidade INTEGER NOT NULL,
        estoque_anterior INTEGER NOT NULL,
        estoque_posterior INTEGER NOT NULL,
        motivo TEXT,
        origem TEXT,
        origem_id INTEGER,
        data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (produto_id)
            REFERENCES produtos(id)
            ON DELETE RESTRICT
    )
`);

// Tabela de itens da garantia: uma garantia pode conter vários produtos.
// ==================================================
// AUDITORIA — HISTÓRICO DE AÇÕES
// ==================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER,
        usuario_nome TEXT,
        usuario_login TEXT,
        perfil TEXT,
        acao TEXT NOT NULL,
        modulo TEXT,
        descricao TEXT NOT NULL,
        entidade_tipo TEXT,
        entidade_id INTEGER,
        data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Auditoria 2.0 — guarda o estado anterior e posterior das alterações.
for (const coluna of ['dados_antes', 'dados_depois']) {
    try { db.exec(`ALTER TABLE auditoria ADD COLUMN ${coluna} TEXT`); } catch (_) {}
}

// Registra uma ação administrativa; falhas de auditoria não interrompem a operação principal.
async function registrarAuditoria(usuario, dados = {}) {
    try {
        const u = usuario || {};
        await acessoBanco.executar(`
            INSERT INTO auditoria (
                usuario_id, usuario_nome, usuario_login, perfil,
                acao, modulo, descricao, entidade_tipo, entidade_id, dados_antes, dados_depois
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            u.id ? Number(u.id) : null,
            String(u.nome || ''),
            String(u.usuario || ''),
            String(u.perfil || ''),
            String(dados.acao || 'acao'),
            String(dados.modulo || ''),
            String(dados.descricao || 'Ação realizada.'),
            dados.entidade_tipo ? String(dados.entidade_tipo) : null,
            dados.entidade_id != null && dados.entidade_id !== '' ? Number(dados.entidade_id) : null,
            dados.dados_antes ? JSON.stringify(dados.dados_antes) : null,
            dados.dados_depois ? JSON.stringify(dados.dados_depois) : null
        ]);
    } catch (erro) {
        console.error('Erro ao registrar auditoria:', erro.message);
    }
}

db.exec(`
    CREATE TABLE IF NOT EXISTS garantia_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        garantia_id INTEGER NOT NULL,
        produto_id INTEGER NOT NULL,
        FOREIGN KEY (garantia_id) REFERENCES garantias(id) ON DELETE CASCADE,
        FOREIGN KEY (produto_id) REFERENCES produtos(id)
    );
`);

// Migração dos registros antigos: agrupa garantias repetidas da mesma origem
// em uma única garantia e preserva os produtos em garantia_itens.
try {
    const grupos = db.prepare(`
        SELECT
            COALESCE(venda_id, 0) AS venda_id,
            COALESCE(os_id, 0) AS os_id,
            cliente_id
        FROM garantias
        GROUP BY COALESCE(venda_id, 0), COALESCE(os_id, 0), cliente_id
        HAVING COUNT(*) > 1
    `).all();

    const migrarGrupo = db.transaction((grupo) => {
        const registros = db.prepare(`
            SELECT * FROM garantias
            WHERE COALESCE(venda_id, 0) = ?
              AND COALESCE(os_id, 0) = ?
              AND cliente_id = ?
            ORDER BY id ASC
        `).all(grupo.venda_id, grupo.os_id, grupo.cliente_id);

        if (registros.length < 2) return;

        const principal = registros[0];
        const ids = [];

        for (const registro of registros) {
            if (registro.produto_id) ids.push(Number(registro.produto_id));
        }

        const inserirItem = db.prepare(`
            INSERT INTO garantia_itens (garantia_id, produto_id)
            VALUES (?, ?)
        `);

        const jaTem = db.prepare(`
            SELECT 1 FROM garantia_itens
            WHERE garantia_id = ? AND produto_id = ?
        `);

        db.prepare(`
            UPDATE garantias
            SET produto_id = NULL
            WHERE id = ?
        `).run(principal.id);

        for (const produtoId of [...new Set(ids)]) {
            if (!jaTem.get(principal.id, produtoId)) {
                inserirItem.run(principal.id, produtoId);
            }
        }

        const excluir = db.prepare(`DELETE FROM garantias WHERE id = ?`);
        for (const registro of registros.slice(1)) {
            db.prepare(`DELETE FROM garantia_itens WHERE garantia_id = ?`).run(registro.id);
            excluir.run(registro.id);
        }
    });

    for (const grupo of grupos) migrarGrupo(grupo);
} catch (erro) {
    console.error('Migração das garantias:', erro.message);
}


/*
    ==================================================
    SEGURANÇA / AUTENTICAÇÃO
    ==================================================
*/

// Deriva o hash da senha com salt individual; a senha original nunca é persistida.
function gerarSenha(senha, salt = crypto.randomBytes(16).toString('hex')) {

    const hash = crypto
        .scryptSync(senha, salt, 64)
        .toString('hex');

    return { hash, salt };

}


/*
    ==================================================
    GESTÃO DE SESSÃO E PERMISSÕES — ETAPA 5.3
    ==================================================
*/

const sessoesGestor = new Map();

const MODULOS_PERMISSAO = [
    'dashboard',
    'produtos',
    'clientes',
    'vendas',
    'os',
    'garantias',
    'estoque',
    'relatorios',
    'usuarios'
];

const PERMISSOES_FUNCIONARIO_PADRAO = {
    dashboard: { consultar: 1, criar: 0, editar: 0, excluir: 0 },
    produtos:  { consultar: 1, criar: 0, editar: 0, excluir: 0 },
    clientes:  { consultar: 1, criar: 1, editar: 1, excluir: 1 },
    vendas:    { consultar: 1, criar: 1, editar: 0, excluir: 0 },
    os:        { consultar: 1, criar: 1, editar: 1, excluir: 0 },
    garantias: { consultar: 1, criar: 1, editar: 0, excluir: 0 },
    estoque:   { consultar: 1, criar: 1, editar: 1, excluir: 0 },
    relatorios:{ consultar: 1, criar: 0, editar: 0, excluir: 0 },
    usuarios:  { consultar: 0, criar: 0, editar: 0, excluir: 0 }
};

function permissoesAdministrador() {
    return MODULOS_PERMISSAO.map(modulo => ({
        modulo,
        consultar: 1,
        criar: 1,
        editar: 1,
        excluir: 1
    }));
}

// Executa a manutenção de permissões dentro de uma transação já aberta.
async function garantirPermissoesNoEscopo(banco, usuarioId, perfil) {
    const permissoes = perfil === 'administrador'
        ? permissoesAdministrador()
        : MODULOS_PERMISSAO.map(modulo => ({
            modulo,
            ...(PERMISSOES_FUNCIONARIO_PADRAO[modulo] || { consultar: 0, criar: 0, editar: 0, excluir: 0 })
        }));

    for (const p of permissoes) {
        const existente = await banco.consultarUm(
            'SELECT id FROM permissoes_usuarios WHERE usuario_id = ? AND modulo = ?',
            [usuarioId, p.modulo]
        );
        if (existente) {
            if (perfil === 'administrador') {
                await banco.executar(`
                    UPDATE permissoes_usuarios
                    SET consultar = ?, criar = ?, editar = ?, excluir = ?, atualizado_em = CURRENT_TIMESTAMP
                    WHERE usuario_id = ? AND modulo = ?
                `, [p.consultar, p.criar, p.editar, p.excluir, usuarioId, p.modulo]);
            }
            continue;
        }
        await banco.executar(`
            INSERT INTO permissoes_usuarios (usuario_id, modulo, consultar, criar, editar, excluir)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [usuarioId, p.modulo, p.consultar, p.criar, p.editar, p.excluir]);
    }
}

// Prepara permissões ausentes e garante acesso completo aos administradores.
async function garantirPermissoesUsuario(usuarioId, perfil) {
    return acessoBanco.transacao(banco => garantirPermissoesNoEscopo(banco, usuarioId, perfil));
}

async function buscarPermissoesUsuario(usuarioId, perfil) {
    if (perfil === 'administrador') return permissoesAdministrador();
    await garantirPermissoesUsuario(usuarioId, perfil);
    return acessoBanco.consultar(`
        SELECT modulo, consultar, criar, editar, excluir
        FROM permissoes_usuarios
        WHERE usuario_id = ?
        ORDER BY id
    `, [usuarioId]);
}

// Confere no banco o estado ativo e a permissão exigida para a chamada atual.
async function usuarioTemPermissao(usuarioId, modulo, acao = 'consultar') {
    const usuario = await acessoBanco.consultarUm('SELECT id, perfil, ativo FROM usuarios WHERE id = ?', [usuarioId]);
    if (!usuario || Number(usuario.ativo) !== 1) return false;
    if (usuario.perfil === 'administrador') return true;

    await garantirPermissoesUsuario(usuario.id, usuario.perfil);
    const permissao = await acessoBanco.consultarUm(`
        SELECT ${acao === 'criar' || acao === 'editar' || acao === 'excluir' ? acao : 'consultar'} AS permitido
        FROM permissoes_usuarios
        WHERE usuario_id = ? AND modulo = ?
    `, [usuario.id, modulo]);
    return Number(permissao?.permitido || 0) === 1;
}

// Associa cada canal IPC protegido à permissão de módulo que ele exige.
function definirPermissaoPorCanal(canal) {
    const regras = {
        'listar-produtos': ['produtos', 'consultar'],
        'buscar-produto': ['produtos', 'consultar'],
        'cadastrar-produto': ['produtos', 'criar'],
        'editar-produto': ['produtos', 'editar'],
        'excluir-produto': ['produtos', 'excluir'],

        'listar-clientes': ['clientes', 'consultar'],
        'buscar-cliente': ['clientes', 'consultar'],
        'cadastrar-cliente': ['clientes', 'criar'],
        'editar-cliente': ['clientes', 'editar'],
        'excluir-cliente': ['clientes', 'excluir'],

        'listar-vendas': ['vendas', 'consultar'],
        'buscar-venda': ['vendas', 'consultar'],
        'finalizar-venda': ['vendas', 'criar'],
        'cancelar-venda': ['vendas', 'editar'],
        'excluir-venda': ['vendas', 'excluir'],

        'listar-ordens-servico': ['os', 'consultar'],
        'buscar-ordem-servico': ['os', 'consultar'],
        'cadastrar-ordem-servico': ['os', 'criar'],
        'editar-ordem-servico': ['os', 'editar'],
        'excluir-ordem-servico': ['os', 'excluir'],

        'listar-garantias': ['garantias', 'consultar'],
        'cadastrar-garantia': ['garantias', 'criar'],
        'editar-garantia': ['garantias', 'editar'],

        'listar-movimentacoes-estoque': ['estoque', 'consultar'],
        'entrada-estoque': ['estoque', 'criar'],
        'saida-estoque': ['estoque', 'criar'],
        'ajuste-estoque': ['estoque', 'editar'],

        // O módulo Relatórios precisa de uma leitura própria. Permitir que
        // ele dependa das permissões de Vendas, OS e Produtos fazia usuários
        // autorizados para relatórios receberem objetos de acesso negado no
        // lugar das listas e a tela quebrava ao tentar filtrá-los.
        'obter-dados-dashboard': ['dashboard', 'consultar'],
        'obter-dados-relatorio': ['relatorios', 'consultar']
    };
    return regras[canal] || null;
}


function obterIdAuditoria(canal, dados, resultado) {
    const d = dados || {};
    if (canal === 'finalizar-venda') return Number(resultado?.venda?.id || resultado?.venda?.venda_id || resultado?.venda_id || resultado?.id) || null;
    if (canal === 'cadastrar-ordem-servico') return Number(resultado?.os?.id || resultado?.id) || null;
    if (['cadastrar-produto','cadastrar-cliente','cadastrar-garantia','cadastrar-usuario'].includes(canal)) return Number(resultado?.id || resultado?.lastInsertRowid) || null;
    if (canal.includes('usuario')) return Number(d.usuario_id || d.id) || null;
    if (canal.includes('estoque')) return Number(d.produto_id) || null;
    return Number(typeof d === 'object' ? d.id : d) || null;
}

async function capturarSnapshotAuditoria(canal, dados, resultado) {
    const id = obterIdAuditoria(canal, dados, resultado);
    if (!id) return null;
    try {
        if (canal.includes('produto') || canal.includes('estoque')) {
            return await acessoBanco.consultarUm(`SELECT id,nome,codigo,sku,codigo_barras,categoria,preco_custo,preco_venda,estoque,estoque_minimo FROM produtos WHERE id = ?`, [id]);
        }
        if (canal.includes('cliente')) {
            return await acessoBanco.consultarUm(`SELECT id,nome,cpf_cnpj,telefone,celular,email,cep,endereco,numero,complemento,bairro,cidade,estado,observacoes FROM clientes WHERE id = ?`, [id]);
        }
        if (canal.includes('ordem-servico')) {
            return await acessoBanco.consultarUm(`SELECT id,numero,cliente_id,tipo_equipamento,marca,modelo,numero_serie,sistema_operacional,acessorios,estado_fisico,avarias,problema_relatado,diagnostico,servico_realizado,previsao_entrega,status,valor_pecas,valor_mao_obra,desconto,total,observacoes FROM ordens_servico WHERE id = ?`, [id]);
        }
        if (canal.includes('usuario')) {
            return await acessoBanco.consultarUm(`SELECT id,nome,usuario,perfil,ativo,primeiro_acesso FROM usuarios WHERE id = ?`, [id]);
        }
        if (canal.includes('garantia')) {
            return await acessoBanco.consultarUm(`SELECT id,venda_id,os_id,cliente_id,produto_id,descricao,prazo_dias,data_inicio,data_fim,status,observacoes,cobertura,exclusoes FROM garantias WHERE id = ?`, [id]);
        }
        if (canal === 'finalizar-venda' || canal === 'excluir-venda' || canal === 'cancelar-venda') {
            const venda = await acessoBanco.consultarUm(`SELECT id,numero,cliente_id,subtotal,desconto,total,forma_pagamento,observacoes,status,cancelada_em,cancelamento_motivo,data_hora FROM vendas WHERE id = ?`, [id]);
            if (!venda) return null;
            if (canal === 'excluir-venda' || canal === 'cancelar-venda') {
                venda.itens = await acessoBanco.consultar(`SELECT id,produto_id,quantidade,preco_unitario,subtotal FROM itens_venda WHERE venda_id = ? ORDER BY id`, [id]);
            }
            return venda;
        }
    } catch (erro) {
        console.error('Erro ao capturar snapshot da auditoria:', erro.message);
    }
    return null;
}

function formatarSnapshotAuditoria(snapshot) {
    if (!snapshot) return null;
    const limpar = {};
    for (const [chave, valor] of Object.entries(snapshot)) {
        if (chave === 'senha_hash' || chave === 'senha_salt') continue;
        limpar[chave] = valor;
    }
    return limpar;
}

function mapaAuditoriaCanal(canal, dados, resultado, sessao, snapshotAntes = null, snapshotDepois = null) {
    const d = dados || {};
    const id = (v) => v != null && v !== '' ? Number(v) : null;
    const regras = {
        'cadastrar-produto': ['criar','produtos','produto','Cadastrou um produto'],
        'editar-produto': ['editar','produtos','produto','Editou um produto'],
        'excluir-produto': ['excluir','produtos','produto','Excluiu um produto'],
        'cadastrar-cliente': ['criar','clientes','cliente','Cadastrou um cliente'],
        'editar-cliente': ['editar','clientes','cliente','Editou um cliente'],
        'excluir-cliente': ['excluir','clientes','cliente','Excluiu um cliente'],
        'finalizar-venda': ['criar','vendas','venda','Finalizou uma venda'],
        'cancelar-venda': ['editar','vendas','venda','Cancelou uma venda'],
        'excluir-venda': ['excluir','vendas','venda','Excluiu uma venda'],
        'cadastrar-ordem-servico': ['criar','os','ordem_servico','Cadastrou uma ordem de serviço'],
        'editar-ordem-servico': ['editar','os','ordem_servico','Editou uma ordem de serviço'],
        'excluir-ordem-servico': ['excluir','os','ordem_servico','Excluiu uma ordem de serviço'],
        'cadastrar-garantia': ['criar','garantias','garantia','Cadastrou uma garantia'],
        'editar-garantia': ['editar','garantias','garantia','Editou uma garantia'],
        'entrada-estoque': ['criar','estoque','produto','Registrou uma entrada de estoque'],
        'saida-estoque': ['criar','estoque','produto','Registrou uma saída de estoque'],
        'ajuste-estoque': ['editar','estoque','produto','Realizou um ajuste de estoque'],
        'cadastrar-usuario': ['criar','seguranca','usuario','Cadastrou um usuário'],
        'editar-usuario': ['editar','seguranca','usuario','Editou um usuário'],
        'alterar-senha-usuario': ['editar','seguranca','usuario','Alterou a senha de um usuário'],
        'alternar-status-usuario': ['editar','seguranca','usuario','Alterou o status de um usuário'],
        'salvar-permissoes-usuario': ['editar','seguranca','usuario','Alterou as permissões de um usuário'],
        'fazer-backup': ['backup','seguranca','backup','Realizou um backup do banco de dados']
    };
    if (canal === 'registrar-logout') return { acao:'logout', modulo:'seguranca', descricao:'Saiu do sistema.' };
    const regra = regras[canal];
    if (!regra) return null;
    let entidadeId = null;
    if (canal === 'finalizar-venda') entidadeId = id(resultado?.venda?.venda_id || resultado?.venda_id);
    else if (canal === 'excluir-venda' || canal === 'cancelar-venda') entidadeId = id(typeof d === 'object' ? d.id : d);
    else if (canal === 'cadastrar-produto' || canal === 'cadastrar-cliente' || canal === 'cadastrar-garantia' || canal === 'cadastrar-usuario') entidadeId = id(resultado?.id || resultado?.lastInsertRowid);
    else if (canal === 'cadastrar-ordem-servico') entidadeId = id(resultado?.os?.id || resultado?.id);
    else if (canal === 'editar-produto' || canal === 'excluir-produto' || canal === 'editar-cliente' || canal === 'excluir-cliente' || canal === 'editar-garantia' || canal.includes('ordem-servico')) entidadeId = id(typeof d === 'object' ? d.id : d);
    else if (canal.includes('usuario')) entidadeId = id(typeof d === 'object' ? (d.id || d.usuario_id) : d);
    else if (canal.includes('estoque')) entidadeId = id(d.produto_id);
    const audit = { acao: regra[0], modulo: regra[1], descricao: regra[3], entidade_tipo: regra[2], entidade_id: entidadeId };
    if (snapshotAntes) audit.dados_antes = formatarSnapshotAuditoria(snapshotAntes);
    if (snapshotDepois) audit.dados_depois = formatarSnapshotAuditoria(snapshotDepois);
    return audit;
}

// Camada comum aos handlers: exige sessão, valida permissões e centraliza auditoria.
const ipcHandleOriginal = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (canal, listener) => {
    return ipcHandleOriginal(canal, async (event, ...args) => {
        if (['obter-estado-licenca', 'ativar-licenca', 'obter-versao-aplicativo'].includes(canal)) {
            return listener(event, ...args);
        }

        if ([
            'obter-estado-inicializacao',
            'configurar-administrador-inicial',
            'obter-estado-implantacao-firebird',
            'descobrir-servidores-firebird',
            'testar-conexao-firebird',
            'parear-estacao-firebird'
        ].includes(canal)) {
            return listener(event, ...args);
        }

        if (canal === 'login') {
            if (tipoBancoAtivo === 'pareamento') {
                return { sucesso: false, mensagem: 'Esta estação ainda não está conectada ao servidor. Conclua o pareamento para entrar.' };
            }
            const estadoLicenca = licenciamento.obterEstadoLicenca();
            if (!estadoLicenca.ativa) {
                return { sucesso: false, mensagem: 'Ative o Gestor Fácil para continuar.' };
            }
            const resultado = await listener(event, ...args);
            if (resultado?.sucesso && resultado.usuario?.id) {
                const usuarioId = Number(resultado.usuario.id);
                const perfil = resultado.usuario.perfil;
                await garantirPermissoesUsuario(usuarioId, perfil);
                const permissoes = await buscarPermissoesUsuario(usuarioId, perfil);
                sessoesGestor.set(event.sender.id, {
                    id: usuarioId,
                    nome: resultado.usuario.nome,
                    usuario: resultado.usuario.usuario,
                    perfil,
                    permissoes
                });
                resultado.usuario.permissoes = permissoes;
            }
            return resultado;
        }

        const sessao = sessoesGestor.get(event.sender.id);
        if (!sessao) {
            return { sucesso: false, mensagem: 'Sessão expirada. Faça login novamente.' };
        }

        if (canal === 'registrar-logout') {
            return listener(event, ...args);
        }

        const canaisAdministrativosBackup = [
            'fazer-backup',
            'restaurar-backup',
            'obter-config-backup',
            'selecionar-pasta-backup',
            'salvar-config-backup',
            'testar-backup-automatico'
        ];
        if (canaisAdministrativosBackup.includes(canal) && sessao.perfil !== 'administrador') {
            return { sucesso: false, mensagem: 'Acesso restrito ao administrador.' };
        }

        // A restauração fecha o banco e reinicia o aplicativo.
        // Não devemos tentar registrar auditoria depois que o processo de
        // restauração encerrou a conexão ou destruiu a janela do renderer.
        if (canal === 'restaurar-backup') {
            return listener(event, ...args);
        }

        const regra = definirPermissaoPorCanal(canal);
        if (regra && !(await usuarioTemPermissao(sessao.id, regra[0], regra[1]))) {
            return { sucesso: false, mensagem: 'Você não possui permissão para realizar esta ação.' };
        }

        if (['listar-usuarios', 'cadastrar-usuario', 'editar-usuario', 'alterar-senha-usuario', 'alternar-status-usuario', 'buscar-permissoes-usuario', 'salvar-permissoes-usuario'].includes(canal)) {
            if (sessao.perfil !== 'administrador') {
                return { sucesso: false, mensagem: 'Acesso restrito ao administrador.' };
            }
        }

        const snapshotAntes = ['editar-produto','excluir-produto','editar-cliente','excluir-cliente','editar-ordem-servico','excluir-ordem-servico','editar-garantia','editar-usuario','alterar-senha-usuario','alternar-status-usuario','salvar-permissoes-usuario','entrada-estoque','saida-estoque','ajuste-estoque','excluir-venda','cancelar-venda'].includes(canal)
            ? await capturarSnapshotAuditoria(canal, args[0], null)
            : null;

        const resultado = await listener(event, ...args);

        if (resultado?.sucesso !== false) {
            const snapshotDepois = ['cadastrar-produto','editar-produto','cadastrar-cliente','editar-cliente','cadastrar-ordem-servico','editar-ordem-servico','editar-garantia','cadastrar-usuario','editar-usuario','alternar-status-usuario','salvar-permissoes-usuario','entrada-estoque','saida-estoque','ajuste-estoque','cadastrar-garantia','finalizar-venda','cancelar-venda'].includes(canal)
                ? await capturarSnapshotAuditoria(canal, args[0], resultado)
                : null;
            const audit = mapaAuditoriaCanal(canal, args[0], resultado, sessao, snapshotAntes, snapshotDepois);
            if (audit) await registrarAuditoria(sessao, audit);
        }

        return resultado;
    });
};

app.on('browser-window-created', (_event, janela) => {
    // Use o evento da própria BrowserWindow. O WebContents pode já estar
    // destruído quando o Electron estiver encerrando/reiniciando a janela.
    janela.on('closed', () => {
        try {
            if (janela.webContents) {
                sessoesGestor.delete(janela.webContents.id);
            }
        } catch (_) {}
    });
});


ipcMain.handle('obter-estado-licenca', () => licenciamento.obterEstadoLicenca());
ipcMain.handle('obter-versao-aplicativo', () => app.getVersion());

ipcMain.handle('obter-estado-inicializacao', async () => {
    try {
        if (tipoBancoAtivo === 'pareamento') {
            return { necessitaAdministrador: false, precisaParear: true };
        }
        if (tipoBancoAtivo === 'firebird') {
            const estado = await obterEstadoInicializacaoFirebird(acessoBanco);
            return { necessitaAdministrador: estado.precisaConfigurarAdministrador };
        }
        const resultado = await acessoBanco.consultarUm('SELECT COUNT(*) AS total FROM usuarios');
        return { necessitaAdministrador: Number(resultado?.total || 0) === 0 };
    } catch (erro) {
        console.error('Não foi possível verificar a inicialização do sistema:', erro);
        return { necessitaAdministrador: false, mensagem: 'Não foi possível consultar o banco de dados.' };
    }
});

ipcMain.handle('configurar-administrador-inicial', async (_event, dados) => {
    if (tipoBancoAtivo === 'pareamento') {
        return { sucesso: false, mensagem: 'Conecte esta estação ao servidor antes de configurar usuários.' };
    }
    if (!licenciamento.obterEstadoLicenca().ativa) {
        return { sucesso: false, mensagem: 'Ative o Gestor Fácil para continuar.' };
    }

    const nome = String(dados?.nome || '').trim();
    const usuario = String(dados?.usuario || '').trim();
    const senha = String(dados?.senha || '');
    if (!nome || nome.length > 200) return { sucesso: false, mensagem: 'Informe um nome válido para o administrador.' };
    if (!/^[a-zA-Z0-9._-]{3,100}$/.test(usuario)) {
        return { sucesso: false, mensagem: 'O usuário deve ter de 3 a 100 caracteres: letras, números, ponto, hífen ou sublinhado.' };
    }
    if (senha.length < 10) return { sucesso: false, mensagem: 'A senha do administrador deve ter pelo menos 10 caracteres.' };

    try {
        if (tipoBancoAtivo === 'firebird') {
            const administrador = await configurarAdministradorInicialFirebird(acessoBanco, { nome, usuario, senha });
            await registrarAuditoria(administrador, {
                acao: 'criar', modulo: 'seguranca', descricao: 'Configurou o administrador inicial do sistema.',
                entidade_tipo: 'usuario', entidade_id: administrador.id
            });
            return { sucesso: true, usuario: { id: administrador.id, nome, usuario } };
        }

        const usuarioId = await acessoBanco.transacao(async banco => {
            const total = await banco.consultarUm('SELECT COUNT(*) AS total FROM usuarios');
            if (Number(total?.total || 0) !== 0) {
                throw new Error('A configuração inicial já foi concluída. Entre com uma conta existente.');
            }

            const senhaSegura = gerarSenha(senha);
            await banco.executar(`
                INSERT INTO usuarios (nome, usuario, senha_hash, senha_salt, perfil, ativo, primeiro_acesso)
                VALUES (?, ?, ?, ?, 'administrador', 1, 0)
            `, [nome, usuario, senhaSegura.hash, senhaSegura.salt]);
            const id = Number(insercao.lastInsertRowid);
            if (!id) throw new Error('Não foi possível criar a conta de administrador.');
            await garantirPermissoesNoEscopo(banco, id, 'administrador');
            return id;
        });

        await registrarAuditoria({ id: usuarioId, nome, usuario, perfil: 'administrador' }, {
            acao: 'criar', modulo: 'seguranca', descricao: 'Configurou o administrador inicial do sistema.',
            entidade_tipo: 'usuario', entidade_id: usuarioId
        });
        return { sucesso: true, usuario: { id: usuarioId, nome, usuario } };
    } catch (erro) {
        if (['SQLITE_CONSTRAINT_UNIQUE', 'FIREBIRD_CONSTRAINT_UNIQUE'].includes(erro.code)) {
            return { sucesso: false, mensagem: 'Este nome de usuário já está em uso.' };
        }
        return { sucesso: false, mensagem: erro.message || 'Não foi possível configurar o administrador inicial.' };
    }
});

// Procura servidores somente na rede local; a descoberta nunca transmite senhas.
ipcMain.handle('descobrir-servidores-firebird', async () => {
    try {
        const servidores = await descobertaFirebird.descobrirServidores();
        return { sucesso: true, servidores };
    } catch (erro) {
        console.error('Falha ao procurar Firebird na rede local:', erro);
        return { sucesso: false, servidores: [], mensagem: 'Não foi possível procurar o servidor na rede local.' };
    }
});

// Testa os dados digitados na estação sem salvá-los e sem alterar o servidor.
ipcMain.handle('testar-conexao-firebird', async (_event, dados = {}) => {
    let banco;
    try {
        banco = criarConexaoFirebird({
            host: dados.host,
            port: dados.port,
            database: dados.database,
            user: dados.user,
            password: dados.password
        }, { timeoutMs: 8000, limiteConexoes: 1 });
        const estado = await obterEstadoInicializacaoFirebird(banco);
        return {
            sucesso: true,
            servidorPreparado: true,
            precisaConfigurarAdministrador: estado.precisaConfigurarAdministrador
        };
    } catch (erro) {
        console.warn('Falha ao validar conexão Firebird informada:', erro.message);
        return {
            sucesso: false,
            mensagem: 'Não foi possível validar a conexão ou o esquema do Gestor Fácil. Confira servidor, porta, alias, credenciais e instalação do banco.'
        };
    } finally {
        if (banco) {
            try { await banco.fechar(); } catch (erro) {
                console.warn('Falha ao encerrar conexão de validação Firebird:', erro.message);
            }
        }
    }
});

ipcMain.handle('obter-estado-implantacao-firebird', () => ({
    papel: tipoBancoAtivo === 'firebird' ? configuracaoFirebirdRuntime?.papel : papelInstalacao,
    precisaParear: papelInstalacao === 'cliente' && tipoBancoAtivo === 'pareamento',
    bancoCompartilhado: tipoBancoAtivo === 'firebird'
}));

ipcMain.handle('parear-estacao-firebird', async (_event, dados = {}) => {
    if (papelInstalacao !== 'cliente' || tipoBancoAtivo !== 'pareamento') {
        return { sucesso: false, mensagem: 'Este computador não está aguardando o pareamento com um servidor.' };
    }

    let firebird;
    try {
        const config = await parearComServidor({
            host: dados.host,
            portaPareamento: dados.portaPareamento,
            codigo: dados.codigo,
            serverId: dados.serverId
        });
        firebird = criarConexaoFirebird(config, { limiteConexoes: 8, timeoutMs: 12000 });
        await obterEstadoInicializacaoFirebird(firebird);
        configuracaoFirebird.salvarConfiguracao(app.getPath('userData'), safeStorage, config);
        configuracaoFirebirdRuntime = config;
        bancoFirebirdRuntime = firebird;
        acessoBanco = firebird;
        tipoBancoAtivo = 'firebird';
        db.close();
        return { sucesso: true };
    } catch (erro) {
        if (firebird && bancoFirebirdRuntime !== firebird) {
            try { await firebird.fechar(); } catch (_) {}
        }
        console.warn('Falha no pareamento da estação Firebird:', erro.message);
        return { sucesso: false, mensagem: erro.message || 'Não foi possível conectar esta estação ao servidor.' };
    }
});

ipcMain.handle('gerar-codigo-pareamento-firebird', async (event) => {
    const sessao = sessoesGestor.get(event.sender.id);
    if (tipoBancoAtivo !== 'firebird' || configuracaoFirebirdRuntime?.papel !== 'servidor' || !sessao || sessao.perfil !== 'administrador') {
        return { sucesso: false, mensagem: 'Somente um administrador conectado ao servidor pode gerar um código de pareamento.' };
    }
    if (!servidorPareamentoFirebird) return { sucesso: false, mensagem: 'O serviço de pareamento do servidor não está disponível.' };

    const codigo = servidorPareamentoFirebird.gerarCodigo();
    await registrarAuditoria(sessao, {
        acao: 'criar', modulo: 'seguranca', descricao: 'Gerou um código temporário de pareamento para uma estação.',
        entidade_tipo: 'estacao'
    });
    return { sucesso: true, codigo, expiraEmSegundos: 300 };
});

ipcMain.handle('ativar-licenca', (_event, token) => licenciamento.ativarLicenca(token));

ipcMain.handle('verificar-atualizacoes', async () => {
    if (!app.isPackaged) return { sucesso: false, desenvolvimento: true };
    if (atualizacaoPronta) return { sucesso: true, pronta: true };

    try {
        await autoUpdater.checkForUpdates();
        return { sucesso: true };
    } catch (erro) {
        console.error('Não foi possível consultar atualizações:', erro);
        return { sucesso: false };
    }
});

ipcMain.handle('instalar-atualizacao', () => {
    if (!atualizacaoPronta) return { sucesso: false };
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { sucesso: true };
});


ipcMain.handle(
    'login',
    async (event, dados) => {

        if (papelInstalacao === 'cliente' && tipoBancoAtivo !== 'firebird') {
            return { sucesso: false, mensagem: 'Esta estação precisa ser pareada ao servidor antes do login.' };
        }

        const usuarioInformado = String(dados?.usuario || '').trim();
        const senhaInformada = String(dados?.senha || '');

        if (!usuarioInformado || !senhaInformada) {
            return {
                sucesso: false,
                mensagem: 'Informe o usuário e a senha.'
            };
        }

        const usuario = await acessoBanco.consultarUm(`
            SELECT
                id,
                nome,
                usuario,
                senha_hash,
                senha_salt,
                perfil,
                ativo,
                primeiro_acesso
            FROM usuarios
            WHERE lower(usuario) = lower(?)
            LIMIT 1
        `, [usuarioInformado]);

        if (!usuario || Number(usuario.ativo) !== 1) {
            return {
                sucesso: false,
                mensagem: 'Usuário ou senha inválidos.'
            };
        }

        const hashInformado = crypto
            .scryptSync(senhaInformada, usuario.senha_salt, 64)
            .toString('hex');

        const valido = crypto.timingSafeEqual(
            Buffer.from(hashInformado, 'hex'),
            Buffer.from(usuario.senha_hash, 'hex')
        );

        if (!valido) {
            return {
                sucesso: false,
                mensagem: 'Usuário ou senha inválidos.'
            };
        }

        await acessoBanco.executar(`
            UPDATE usuarios
            SET atualizado_em = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [usuario.id]);

        await registrarAuditoria({
            id: usuario.id, nome: usuario.nome, usuario: usuario.usuario, perfil: usuario.perfil
        }, {
            acao: 'login', modulo: 'seguranca', descricao: 'Entrou no sistema.'
        });

        return {
            sucesso: true,
            usuario: {
                id: usuario.id,
                nome: usuario.nome,
                usuario: usuario.usuario,
                perfil: usuario.perfil,
                primeiro_acesso: Number(usuario.primeiro_acesso) === 1
            }
        };

    }
);


/*
    ==================================================
    BACKUP AUTOMÁTICO
    ==================================================
*/

const caminhoConfigBackup = path.join(app.getPath('userData'), 'backup-config.json');
let timerBackupAutomatico = null;
let backupEmExecucao = false;
let ultimoAgendamentoBackupEmMemoria = '';

// Valores usados quando ainda não há arquivo de configuração de backup.
function configuracaoBackupPadrao() {
    const pastaPadrao = tipoBancoAtivo === 'firebird' && configuracaoFirebirdRuntime?.papel === 'servidor'
        ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'GestorFacil', 'Backups')
        : path.join(app.getPath('documents'), 'Gestor Fácil', 'Backups');
    return {
        habilitado: false,
        horario: '20:00',
        pasta: pastaPadrao,
        manter: 7,
        ultimoBackup: '',
        ultimoBackupDataHora: '',
        ultimoBackupAgendado: '',
        ultimoErroBackup: '',
        ultimoErroBackupDataHora: ''
    };
}

function lerConfiguracaoBackup() {
    const padrao = configuracaoBackupPadrao();
    try {
        if (!fs.existsSync(caminhoConfigBackup)) return padrao;
        const dados = JSON.parse(fs.readFileSync(caminhoConfigBackup, 'utf8'));
        return {
            ...padrao,
            ...dados,
            habilitado: dados.habilitado === true,
            horario: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(dados.horario || '')) ? dados.horario : padrao.horario,
            pasta: typeof dados.pasta === 'string' ? dados.pasta : padrao.pasta,
            manter: Math.max(1, Math.min(100, Math.trunc(Number(dados.manter) || padrao.manter)))
        };
    } catch (_) {
        return padrao;
    }
}

function salvarConfiguracaoBackup(config) {
    const final = {
        ...configuracaoBackupPadrao(),
        ...config,
        manter: Math.max(1, Math.min(100, Math.trunc(Number(config.manter) || 7)))
    };
    fs.mkdirSync(path.dirname(caminhoConfigBackup), { recursive: true });
    const temporario = `${caminhoConfigBackup}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(final, null, 2), 'utf8');
    fs.renameSync(temporario, caminhoConfigBackup);
    return final;
}

const tabelasBackupObrigatorias = [
    'auditoria', 'clientes', 'garantia_itens', 'garantias', 'itens_os',
    'itens_venda', 'movimentacoes_estoque', 'ordens_servico',
    'permissoes_usuarios', 'produtos', 'usuarios', 'vendas'
];

// Só consideramos utilizável um backup SQLite íntegro e com o esquema esperado.
function validarArquivoBackup(caminho, exigirEsquemaCompleto = false) {
    let bancoBackup = null;
    try {
        bancoBackup = new Database(caminho, { readonly: true, fileMustExist: true });
        const integridade = bancoBackup.pragma('integrity_check', { simple: true });
        if (integridade !== 'ok') throw new Error('O arquivo não passou na verificação de integridade.');

        const tabelas = new Set(bancoBackup.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(item => item.name));
        const esquemaObrigatorio = exigirEsquemaCompleto
            ? tabelasBackupObrigatorias
            : ['produtos', 'clientes', 'vendas', 'ordens_servico', 'usuarios'];
        const faltantes = esquemaObrigatorio.filter(nome => !tabelas.has(nome));
        if (faltantes.length) throw new Error(`O arquivo não contém todas as tabelas do Gestor Fácil: ${faltantes.join(', ')}.`);

        const violacoes = bancoBackup.pragma('foreign_key_check');
        if (violacoes.length) throw new Error(`O arquivo contém ${violacoes.length} violação(ões) de chave estrangeira.`);
        return true;
    } finally {
        try { bancoBackup?.close(); } catch (_) {}
    }
}

function limparBackupsAntigos(pasta, prefixo, limite, extensao = '.db') {
    const arquivos = fs.readdirSync(pasta)
        .filter(nome => nome.toLowerCase().startsWith(prefixo) && nome.toLowerCase().endsWith(extensao))
        .map(nome => {
            const caminho = path.join(pasta, nome);
            return { caminho, mtime: fs.statSync(caminho).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

    for (const arquivo of arquivos.slice(limite)) fs.unlinkSync(arquivo.caminho);
}

const TABELAS_IMPORTACAO_INICIAL = [
    'clientes', 'produtos', 'usuarios', 'permissoes_usuarios', 'vendas', 'itens_venda',
    'ordens_servico', 'itens_os', 'garantias', 'garantia_itens', 'movimentacoes_estoque', 'auditoria'
];

function lerPapelInstalacao() {
    const arquivos = [
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'GestorFacil', 'implantacao.ini'),
        path.join(app.getPath('userData'), 'implantacao.ini')
    ];

    for (const arquivo of arquivos) {
        try {
            if (!fs.existsSync(arquivo)) continue;
            const conteudo = fs.readFileSync(arquivo, 'utf8');
            const papel = conteudo.match(/^\s*papel\s*=\s*(server|client)\s*$/im)?.[1]?.toLowerCase();
            if (papel === 'server') return 'servidor';
            if (papel === 'client') return 'cliente';
        } catch (_) {
            // Se uma localização não puder ser lida, tenta a configuração legada do usuário.
        }
    }
    return 'desconhecido';
}

function contarDadosSqliteLocal() {
    let total = 0;
    for (const tabela of TABELAS_IMPORTACAO_INICIAL) {
        try {
            total += Number(db.prepare(`SELECT COUNT(*) AS total FROM "${tabela}"`).get()?.total || 0);
        } catch (_) {
            // Tabelas opcionais de versões antigas são incluídas no importador
            // somente se existirem na origem.
        }
    }
    return total;
}

async function inicializarProvedorBanco() {
    papelInstalacao = lerPapelInstalacao();
    const pastaDadosUsuario = app.getPath('userData');
    const pastasProtegidasPrioritarias = papelInstalacao === 'servidor'
        ? [path.join(process.env.ProgramData || 'C:\\ProgramData', 'GestorFacil')]
        : [];
    const config = configuracaoFirebird.lerConfiguracao(
        pastaDadosUsuario,
        safeStorage,
        { pastasProtegidasPrioritarias }
    );
    if (!config) {
        if (papelInstalacao === 'cliente') {
            tipoBancoAtivo = 'pareamento';
            return { tipo: 'pareamento' };
        }
        if (papelInstalacao === 'servidor') {
            throw new Error('A instalação foi definida como servidor, mas a configuração protegida do Firebird não foi encontrada.');
        }
        return { tipo: 'sqlite' };
    }

    const firebird = criarConexaoFirebird(config, { limiteConexoes: 12, timeoutMs: 12000 });
    try {
        let estado = await obterEstadoInicializacaoFirebird(firebird);

        // Na primeira abertura do servidor, importa a base local apenas quando
        // o banco central ainda está vazio. Uma base central já usada nunca é
        // mesclada nem sobrescrita automaticamente.
        if (config.papel === 'servidor') {
            const contagensCentrais = await Promise.all(TABELAS_IMPORTACAO_INICIAL.map(async tabela => {
                const linha = await firebird.consultarUm(`SELECT COUNT(*) AS total FROM ${tabela}`);
                return Number(linha?.total || 0);
            }));
            const centralVazio = contagensCentrais.every(total => total === 0);
            const arquivoLocal = path.join(app.getPath('userData'), 'gestor-facil.db');
            const baseLocalExiste = fs.existsSync(arquivoLocal) && contarDadosSqliteLocal() > 0;
            if (centralVazio && baseLocalExiste) {
                await migrarSqliteParaFirebird(arquivoLocal, config);
                estado = await obterEstadoInicializacaoFirebird(firebird);
                console.info('A base SQLite local foi importada para o Firebird central; o arquivo original foi preservado.');
            }
        }

        tipoBancoAtivo = 'firebird';
        configuracaoFirebirdRuntime = config;
        bancoFirebirdRuntime = firebird;
        acessoBanco = firebird;

        if (config.papel === 'servidor') {
            servidorPareamentoFirebird = criarServidorPareamento(() => configuracaoFirebirdRuntime);
            await servidorPareamentoFirebird.iniciar();
        }

        // A partir deste ponto nenhum handler pode voltar ao SQLite local.
        // Ele fica fechado para impedir gravações acidentais fora da rede.
        db.close();
        return { tipo: 'firebird', estado };
    } catch (erro) {
        try { await firebird.fechar(); } catch (_) {}
        throw erro;
    }
}

function nomeBackupAutomatico() {
    const agora = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `gestor-facil-auto-${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}.${tipoBancoAtivo === 'firebird' ? 'fbk' : 'db'}`;
}

// Copia o banco SQLite para a pasta configurada e aplica o nome com data/hora.
async function executarBackupAutomatico(chaveAgendamento) {
    if (tipoBancoAtivo === 'pareamento') return { sucesso: false, ignorado: true, motivo: 'estação ainda não conectada ao servidor' };
    if (backupEmExecucao) return { sucesso: false, ignorado: true, motivo: 'backup em andamento' };
    backupEmExecucao = true;
    try {
        const config = lerConfiguracaoBackup();
        if (!config.habilitado || !config.pasta) return { sucesso: false, ignorado: true };

        fs.mkdirSync(config.pasta, { recursive: true });
        const destino = path.join(config.pasta, nomeBackupAutomatico());
        if (tipoBancoAtivo === 'firebird') await criarBackupFirebird(configuracaoFirebirdRuntime, destino, { validar: true });
        else {
            await db.backup(destino);
            try { validarArquivoBackup(destino, true); }
            catch (erroValidacao) { try { fs.unlinkSync(destino); } catch (_) {} throw erroValidacao; }
        }

        const agora = new Date();
        const hoje = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
        ultimoAgendamentoBackupEmMemoria = chaveAgendamento;
        const configAtual = lerConfiguracaoBackup();
        try {
            salvarConfiguracaoBackup({
                ...configAtual,
                ultimoBackup: hoje,
                ultimoBackupDataHora: agora.toISOString(),
                ultimoBackupAgendado: chaveAgendamento,
                ultimoErroBackup: '',
                ultimoErroBackupDataHora: ''
            });
        } catch (erroConfig) {
            console.error('O backup foi criado e validado, mas não foi possível atualizar o registro do agendamento:', erroConfig);
        }

        // Falhas na retenção não invalidam o backup recém-criado e conferido.
        try {
            limparBackupsAntigos(config.pasta, 'gestor-facil-auto-', config.manter, tipoBancoAtivo === 'firebird' ? '.fbk' : '.db');
        } catch (erroRetencao) {
            console.error('Backup criado e validado, mas não foi possível aplicar a retenção:', erroRetencao);
        }

        await registrarAuditoria(null, {
            acao: 'backup',
            modulo: 'seguranca',
            descricao: `Backup automático realizado: ${path.basename(destino)}.`,
            entidade_tipo: 'backup'
        });

        return { sucesso: true, caminho: destino, nome_arquivo: path.basename(destino) };
    } catch (erro) {
        console.error('Erro no backup automático:', erro);
        try {
            const configFalha = lerConfiguracaoBackup();
            salvarConfiguracaoBackup({
                ...configFalha,
                ultimoErroBackup: String(erro.message || erro).slice(0, 400),
                ultimoErroBackupDataHora: new Date().toISOString()
            });
        } catch (erroRegistro) {
            console.error('Não foi possível registrar a falha do backup automático:', erroRegistro);
        }
        return { sucesso: false, mensagem: 'Não foi possível realizar o backup automático.' };
    } finally {
        backupEmExecucao = false;
    }
}

async function verificarBackupAutomatico() {
    const config = lerConfiguracaoBackup();
    if (!config.habilitado || !config.pasta) return { sucesso: false, ignorado: true };

    const agora = new Date();
    const partes = String(config.horario || '20:00').split(':').map(Number);
    const hora = partes[0];
    const minuto = partes[1];
    if (!Number.isInteger(hora) || hora < 0 || hora > 23 || !Number.isInteger(minuto) || minuto < 0 || minuto > 59) return { sucesso: false, ignorado: true };

    const hoje = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
    const chaveAgendamento = `${hoje}|${config.horario}`;
    const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
    const minutosConfigurados = hora * 60 + minuto;

    // Cada horário configurado pode gerar um backup próprio no mesmo dia.
    if (minutosAgora >= minutosConfigurados && config.ultimoBackupAgendado !== chaveAgendamento && ultimoAgendamentoBackupEmMemoria !== chaveAgendamento) {
        return await executarBackupAutomatico(chaveAgendamento);
    }

    return { sucesso: false, ignorado: true };
}

// Verifica periodicamente se chegou o horário definido para o backup automático.
function iniciarBackupAutomatico() {
    if (tipoBancoAtivo === 'pareamento') return;
    if (timerBackupAutomatico) {
        clearInterval(timerBackupAutomatico);
        timerBackupAutomatico = null;
    }

    // Verifica imediatamente ao iniciar o programa e depois a cada 10 segundos.
    verificarBackupAutomatico().catch(erro => console.error('Erro na verificação inicial do backup automático:', erro));

    timerBackupAutomatico = setInterval(() => {
        verificarBackupAutomatico().catch(erro => console.error('Erro na verificação do backup automático:', erro));
    }, 10 * 1000);
}

ipcMain.handle('obter-config-backup', () => lerConfiguracaoBackup());

ipcMain.handle('selecionar-pasta-backup', async (event) => {
    if (tipoBancoAtivo === 'firebird' && configuracaoFirebirdRuntime?.papel !== 'servidor') return { sucesso: false, mensagem: 'Configure os backups no computador servidor.' };
    const janela = BrowserWindow.fromWebContents(event.sender);
    const escolha = await dialog.showOpenDialog(janela, {
        title: 'Escolher pasta para backups automáticos',
        properties: ['openDirectory', 'createDirectory']
    });
    if (escolha.canceled || !escolha.filePaths?.[0]) return { sucesso: false, cancelado: true };
    return { sucesso: true, pasta: escolha.filePaths[0] };
});


async function executarBackupAutomaticoForcado() {
    if (backupEmExecucao) return { sucesso: false, mensagem: 'Já existe um backup em andamento. Tente novamente em instantes.' };
    backupEmExecucao = true;
    try {
        const config = lerConfiguracaoBackup();
        if (!config.pasta) return { sucesso: false, mensagem: 'Configure primeiro a pasta de destino.' };
        fs.mkdirSync(config.pasta, { recursive: true });
        const destino = path.join(config.pasta, nomeBackupAutomatico().replace('gestor-facil-auto-', 'gestor-facil-teste-'));
        if (tipoBancoAtivo === 'firebird') await criarBackupFirebird(configuracaoFirebirdRuntime, destino, { validar: true });
        else { await db.backup(destino); validarArquivoBackup(destino, true); }
        try { limparBackupsAntigos(config.pasta, 'gestor-facil-teste-', 1, tipoBancoAtivo === 'firebird' ? '.fbk' : '.db'); }
        catch (erroRetencao) { console.error('Backup de teste validado, mas não foi possível remover testes antigos:', erroRetencao); }
        return { sucesso: true, caminho: destino, nome_arquivo: path.basename(destino) };
    } catch (erro) {
        console.error('Erro no teste do backup automático:', erro);
        return { sucesso: false, mensagem: `Não foi possível testar o backup: ${erro.message}` };
    } finally {
        backupEmExecucao = false;
    }
}

ipcMain.handle('salvar-config-backup', async (event, dados) => {
    if (tipoBancoAtivo === 'pareamento' || (tipoBancoAtivo === 'firebird' && configuracaoFirebirdRuntime?.papel !== 'servidor')) {
        return { sucesso: false, mensagem: 'Configure o backup automático no computador servidor.' };
    }
    const sessao = sessoesGestor.get(event.sender.id);
    if (!sessao || sessao.perfil !== 'administrador') return { sucesso: false, mensagem: 'Acesso restrito ao administrador.' };

    const horario = String(dados?.horario || '20:00').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) {
        return { sucesso: false, mensagem: 'Informe um horário válido.' };
    }

    const pasta = String(dados?.pasta || '').trim();
    if (!pasta) {
        return { sucesso: false, mensagem: 'Escolha uma pasta para salvar os backups.' };
    }

    const configAnterior = lerConfiguracaoBackup();
    const config = salvarConfiguracaoBackup({
        habilitado: Boolean(dados?.habilitado),
        horario,
        pasta,
        manter: Number(dados?.manter) || 7,
        ultimoBackup: configAnterior.ultimoBackup || '',
        ultimoBackupDataHora: configAnterior.ultimoBackupDataHora || '',
        ultimoBackupAgendado: configAnterior.ultimoBackupAgendado || '',
        ultimoErroBackup: configAnterior.ultimoErroBackup || '',
        ultimoErroBackupDataHora: configAnterior.ultimoErroBackupDataHora || ''
    });

    // Confirma que a configuração foi realmente gravada em disco.
    const conferida = lerConfiguracaoBackup();
    if (conferida.horario !== horario || conferida.pasta !== pasta || Boolean(conferida.habilitado) !== Boolean(dados?.habilitado)) {
        return { sucesso: false, mensagem: 'A configuração não pôde ser confirmada no disco.' };
    }

    // Reinicia o verificador para aplicar imediatamente o novo horário.
    iniciarBackupAutomatico();
    // Registra explicitamente a alteração da configuração do backup automático.
    // Fazemos isso aqui, fora do mapa genérico de canais, para garantir que
    // toda mudança de horário/pasta/quantidade/ativação apareça na Auditoria.
    const descricaoBackup = [
        `Alterou o backup automático`,
        `horário: ${configAnterior.horario || 'não definido'} → ${horario}`,
        `status: ${configAnterior.habilitado ? 'Ativado' : 'Desativado'} → ${conferida.habilitado ? 'Ativado' : 'Desativado'}`,
        `manter: ${Number(configAnterior.manter || 7)} → ${Number(conferida.manter || 7)}`,
        `pasta: ${configAnterior.pasta || 'não definida'} → ${conferida.pasta || 'não definida'}`
    ].join(' | ');

    await registrarAuditoria(sessao, {
        acao: 'editar',
        modulo: 'seguranca',
        descricao: descricaoBackup,
        entidade_tipo: 'backup',
        dados_antes: {
            habilitado: Boolean(configAnterior.habilitado),
            horario: configAnterior.horario || '',
            pasta: configAnterior.pasta || '',
            manter: Number(configAnterior.manter || 7)
        },
        dados_depois: {
            habilitado: Boolean(conferida.habilitado),
            horario: conferida.horario || '',
            pasta: conferida.pasta || '',
            manter: Number(conferida.manter || 7)
        }
    });

    return { sucesso: true, config: conferida };
});

ipcMain.handle('testar-backup-automatico', async (event) => {
    if (tipoBancoAtivo === 'pareamento' || (tipoBancoAtivo === 'firebird' && configuracaoFirebirdRuntime?.papel !== 'servidor')) {
        return { sucesso: false, mensagem: 'O teste de backup deve ser executado no computador servidor.' };
    }
    const sessao = sessoesGestor.get(event.sender.id);
    if (!sessao || sessao.perfil !== 'administrador') return { sucesso: false, mensagem: 'Acesso restrito ao administrador.' };

    const config = lerConfiguracaoBackup();
    if (!config.pasta) return { sucesso: false, mensagem: 'Configure primeiro a pasta de destino.' };

    const resultado = await executarBackupAutomaticoForcado();
    if (resultado?.sucesso) {
        await registrarAuditoria(sessao, { acao: 'backup', modulo: 'seguranca', descricao: `Testou o backup automático: ${resultado.nome_arquivo}.`, entidade_tipo: 'backup' });
    }
    return resultado;
});

/*
    ==================================================
    BACKUP MANUAL DO BANCO
    ==================================================
*/

ipcMain.handle('fazer-backup', async (event) => {
    if (tipoBancoAtivo === 'pareamento' || (tipoBancoAtivo === 'firebird' && configuracaoFirebirdRuntime?.papel !== 'servidor')) {
        return { sucesso: false, mensagem: 'O backup central deve ser criado no computador servidor.' };
    }
    if (backupEmExecucao) return { sucesso: false, mensagem: 'Já existe um backup em andamento. Tente novamente em instantes.' };
    backupEmExecucao = true;
    try {
        const agora = new Date();
        const pad = n => String(n).padStart(2, '0');
        const extensao = tipoBancoAtivo === 'firebird' ? 'fbk' : 'db';
        const nomePadrao = `gestor-facil-backup-${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}.${extensao}`;

        const janela = BrowserWindow.fromWebContents(event.sender);
        const escolha = await dialog.showSaveDialog(janela, {
            title: 'Salvar backup do Gestor Fácil',
            defaultPath: path.join(app.getPath('documents'), nomePadrao),
            filters: [
                { name: 'Backup do Gestor Fácil', extensions: [extensao] },
                { name: 'Todos os arquivos', extensions: ['*'] }
            ]
        });

        if (escolha.canceled || !escolha.filePath) {
            return { sucesso: false, cancelado: true };
        }

        let destino = escolha.filePath;
        if (!destino.toLowerCase().endsWith(`.${extensao}`)) destino += `.${extensao}`;

        if (tipoBancoAtivo === 'firebird') await criarBackupFirebird(configuracaoFirebirdRuntime, destino, { validar: true });
        else { await db.backup(destino); validarArquivoBackup(destino, true); }

        return {
            sucesso: true,
            caminho: destino,
            nome_arquivo: path.basename(destino)
        };
    } catch (erro) {
        console.error('Erro ao realizar backup:', erro);
        return {
            sucesso: false,
            mensagem: tipoBancoAtivo === 'firebird'
                ? `Não foi possível criar e validar o backup Firebird: ${String(erro.message || erro)}`
                : 'Não foi possível realizar o backup do banco de dados.'
        };
    } finally {
        backupEmExecucao = false;
    }
});


/*
    ==================================================
    RESTAURAÇÃO DE BACKUP
    ==================================================
*/

// A restauração valida e preserva o banco atual antes de substituir o arquivo e reiniciar.
ipcMain.handle('restaurar-backup', async (event) => {
    if (tipoBancoAtivo === 'pareamento' || (tipoBancoAtivo === 'firebird' && configuracaoFirebirdRuntime?.papel !== 'servidor')) {
        return { sucesso: false, mensagem: 'A restauração da base central deve ser executada no computador servidor.' };
    }
    if (backupEmExecucao) return { sucesso: false, mensagem: 'Aguarde o backup em andamento terminar antes de restaurar.' };
    backupEmExecucao = true;
    try {
        const janela = BrowserWindow.fromWebContents(event.sender);
        if (tipoBancoAtivo === 'firebird') {
            const estado = await obterEstadoInicializacaoFirebird(acessoBanco);
            if (estado?.precisaConfigurarAdministrador) return { sucesso: false, mensagem: 'Configure o administrador do sistema antes de restaurar um backup.' };
            const escolha = await dialog.showOpenDialog(janela, {
                title: 'Selecionar backup Firebird do Gestor Fácil', properties: ['openFile'],
                filters: [{ name: 'Backup Firebird', extensions: ['fbk'] }, { name: 'Todos os arquivos', extensions: ['*'] }]
            });
            if (escolha.canceled || !escolha.filePaths?.[0]) return { sucesso: false, cancelado: true };
            const origem = path.resolve(escolha.filePaths[0]);
            await validarBackupFirebird(configuracaoFirebirdRuntime, origem);

            const configBackup = lerConfiguracaoBackup();
            const pastaSeguranca = configBackup.pasta || path.join(app.getPath('documents'), 'Gestor Fácil', 'Backups');
            fs.mkdirSync(pastaSeguranca, { recursive: true });
            const agora = new Date();
            const pad = n => String(n).padStart(2, '0');
            const nomeSeguranca = `gestor-facil-pre-restauracao-${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}.fbk`;
            const backupSeguranca = path.join(pastaSeguranca, nomeSeguranca);
            await criarBackupFirebird(configuracaoFirebirdRuntime, backupSeguranca, { validar: true });

            const bancoAnterior = bancoFirebirdRuntime;
            try { await bancoAnterior?.fechar(); } catch (_) {}
            bancoFirebirdRuntime = null;
            try {
                await restaurarBackupFirebird(configuracaoFirebirdRuntime, origem, { substituir: true });
            } catch (erroRestauracao) {
                bancoFirebirdRuntime = criarConexaoFirebird(configuracaoFirebirdRuntime, { limiteConexoes: 12, timeoutMs: 12000 });
                acessoBanco = bancoFirebirdRuntime;
                throw new Error(`A restauração falhou. O backup de segurança foi preservado em ${backupSeguranca}. Feche todas as estações e tente novamente. ${erroRestauracao.message}`);
            }
            setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
            return { sucesso: true, reiniciando: true, backup_seguranca: backupSeguranca, nome_backup_seguranca: path.basename(backupSeguranca) };
        }

        const escolha = await dialog.showOpenDialog(janela, {
            title: 'Selecionar backup do Gestor Fácil',
            properties: ['openFile'],
            filters: [
                { name: 'Banco de dados do Gestor Fácil', extensions: ['db'] },
                { name: 'Todos os arquivos', extensions: ['*'] }
            ]
        });

        if (escolha.canceled || !escolha.filePaths?.[0]) {
            return { sucesso: false, cancelado: true };
        }

        const origem = path.resolve(escolha.filePaths[0]);
        const bancoAtual = path.resolve(path.join(app.getPath('userData'), 'gestor-facil.db'));

        if (!fs.existsSync(origem)) {
            return { sucesso: false, mensagem: 'O arquivo de backup não foi encontrado.' };
        }

        if (origem.toLowerCase() === bancoAtual.toLowerCase()) {
            return { sucesso: false, mensagem: 'Selecione um arquivo de backup diferente do banco atual.' };
        }

        // Valida o arquivo antes de substituir o banco atual.
        try {
            validarArquivoBackup(origem);
        } catch (erroValidacao) {
            return { sucesso: false, mensagem: erroValidacao.message || 'O arquivo selecionado não é um backup válido do Gestor Fácil.' };
        }

        // Cria uma cópia de segurança do banco atual antes da restauração.
        const agora = new Date();
        const pad = n => String(n).padStart(2, '0');
        const nomeSeguranca = `gestor-facil-pre-restauracao-${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}.db`;
        const backupSeguranca = path.join(app.getPath('documents'), nomeSeguranca);

        await db.backup(backupSeguranca);
        validarArquivoBackup(backupSeguranca, true);

        // Fecha a conexão antes de substituir o arquivo físico.
        db.close();
        fs.copyFileSync(origem, bancoAtual);

        // Reinicia o aplicativo para abrir a conexão usando o banco restaurado.
        setTimeout(() => {
            app.relaunch();
            app.exit(0);
        }, 300);

        return {
            sucesso: true,
            reiniciando: true,
            backup_seguranca: backupSeguranca,
            nome_backup_seguranca: path.basename(backupSeguranca)
        };
    } catch (erro) {
        console.error('Erro ao restaurar backup:', erro);
        return {
            sucesso: false,
            mensagem: tipoBancoAtivo === 'firebird'
                ? `Não foi possível restaurar o backup Firebird: ${String(erro.message || erro)}`
                : 'Não foi possível restaurar o backup. O banco atual não foi substituído, se a falha ocorreu antes da restauração.'
        };
    } finally {
        backupEmExecucao = false;
    }
});


/*
    ==================================================
    CRIAR JANELA
    ==================================================
*/

app.on('before-quit', () => {
    anunciadorFirebird?.fechar().catch(erro => console.error('Falha ao encerrar anúncio Firebird:', erro));
    servidorPareamentoFirebird?.fechar().catch(erro => console.error('Falha ao encerrar pareamento Firebird:', erro));
    bancoFirebirdRuntime?.fechar().catch(erro => console.error('Falha ao encerrar pool Firebird:', erro));
});

// Cria a janela principal com preload e isolamento de contexto habilitados.
function criarJanela() {

    const janela = new BrowserWindow({

        width: 1200,
        height: 700,

        minWidth: 900,
        minHeight: 600,

        maximizable: true,

        webPreferences: {

            preload: path.join(
                __dirname,
                'preload.js'
            ),

            contextIsolation: true,
            nodeIntegration: false

        }

    });


    janela.loadFile(
        path.join(
            __dirname,
            'src',
            'index.html'
        )
    );

    // Abre o Gestor Fácil maximizado ao iniciar.
    janela.maximize();

}


/*
    ==================================================
    PRODUTOS
    ==================================================
*/


/*
    LISTAR PRODUTOS
*/

ipcMain.handle(
    'listar-produtos',
    async () => {
        return acessoBanco.consultar(`
            SELECT *
            FROM produtos
            ORDER BY id DESC
        `);
    }
);


/*
    CADASTRAR PRODUTO
*/

ipcMain.handle(
    'cadastrar-produto',
    async (event, produto) => {
        const resultado = await acessoBanco.executar(`
            INSERT INTO produtos (
                nome,
                codigo,
                sku,
                codigo_barras,
                categoria,
                preco_custo,
                preco_venda,
                estoque,
                estoque_minimo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            produto.nome,
            produto.codigo || null,
            produto.sku || null,
            produto.codigo_barras || null,
            produto.categoria || null,
            Number(produto.preco_custo) || 0,
            Number(produto.preco_venda) || 0,
            Number(produto.estoque) || 0,
            Number(produto.estoque_minimo) || 0
        ]);
        return {
            sucesso: true,
            id: resultado.lastInsertRowid
        };
    }
);


/*
    EDITAR PRODUTO
*/

ipcMain.handle(
    'editar-produto',
    async (event, produto) => {
        const resultado = await acessoBanco.executar(`
            UPDATE produtos
            SET nome = ?, codigo = ?, sku = ?, codigo_barras = ?, categoria = ?,
                preco_custo = ?, preco_venda = ?, estoque = ?, estoque_minimo = ?
            WHERE id = ?
        `, [
            produto.nome,
            produto.codigo || null,
            produto.sku || null,
            produto.codigo_barras || null,
            produto.categoria || null,
            Number(produto.preco_custo) || 0,
            Number(produto.preco_venda) || 0,
            Number(produto.estoque) || 0,
            Number(produto.estoque_minimo) || 0,
            produto.id
        ]);
        return {
            sucesso: resultado.changes > 0
        };
    }
);


/*
    EXCLUIR PRODUTO
*/

ipcMain.handle(
    'excluir-produto',
    async (event, id) => {

        const produtoId = Number(id);

        if (!Number.isInteger(produtoId) || produtoId <= 0) {
            return {
                sucesso: false,
                mensagem: 'Produto inválido.'
            };
        }

        try {
            const produtoRemovido = await acessoBanco.transacao(async banco => {
                const produto = await banco.consultarUm(`
                    SELECT id, nome
                    FROM produtos
                    WHERE id = ?
                `, [produtoId]);

                if (!produto) {
                    throw new Error('Produto não encontrado.');
                }

                /*
                    EXCLUSÃO DEFINITIVA DO PRODUTO
                    --------------------------------
                    Como o administrador confirmou a exclusão, removemos
                    também todos os registros históricos que apontam para
                    este produto. Tudo acontece dentro de uma única
                    transação: se qualquer etapa falhar, nada é apagado.
                */

                // 1) Garantias: remove o produto das garantias com múltiplos
                // itens e remove a garantia antiga quando ela fica sem item.
                const garantiasAfetadas = await banco.consultar(`
                    SELECT DISTINCT garantia_id
                    FROM garantia_itens
                    WHERE produto_id = ?
                `, [produtoId]);

                await banco.executar(`
                    DELETE FROM garantia_itens
                    WHERE produto_id = ?
                `, [produtoId]);

                await banco.executar(`
                    UPDATE garantias
                    SET produto_id = NULL
                    WHERE produto_id = ?
                `, [produtoId]);

                const apagarGarantiaVazia = `
                    DELETE FROM garantias
                    WHERE id = ?
                      AND produto_id IS NULL
                      AND NOT EXISTS (
                          SELECT 1
                          FROM garantia_itens gi
                          WHERE gi.garantia_id = garantias.id
                      )
                `;

                for (const garantia of garantiasAfetadas) {
                    await banco.executar(apagarGarantiaVazia, [Number(garantia.garantia_id)]);
                }

                // 2) Ordens de serviço: remove somente as peças deste
                // produto e recalcula os valores das OS afetadas.
                const osAfetadas = await banco.consultar(`
                    SELECT DISTINCT os_id
                    FROM itens_os
                    WHERE produto_id = ?
                `, [produtoId]);

                await banco.executar(`
                    DELETE FROM itens_os
                    WHERE produto_id = ?
                `, [produtoId]);

                const recalcularOS = `
                    SELECT
                        COALESCE(SUM(subtotal), 0) AS valor_pecas
                    FROM itens_os
                    WHERE os_id = ?
                `;

                const atualizarOS = `
                    UPDATE ordens_servico
                    SET
                        valor_pecas = ?,
                        total = ?
                    WHERE id = ?
                `;

                for (const os of osAfetadas) {
                    const valores = await banco.consultarUm(recalcularOS, [Number(os.os_id)]);
                    const valorPecas = Number(valores?.valor_pecas || 0);
                    const atual = await banco.consultarUm('SELECT valor_mao_obra, desconto FROM ordens_servico WHERE id = ?', [Number(os.os_id)]);
                    const total = Math.max(0, valorPecas + Number(atual?.valor_mao_obra || 0) - Number(atual?.desconto || 0));
                    await banco.executar(atualizarOS, [valorPecas, total, Number(os.os_id)]);
                }

                // 3) Vendas: remove o item do produto do histórico.
                // Se aquela venda não tiver mais nenhum item, a venda inteira
                // é removida para não deixar uma venda vazia no histórico.
                const vendasAfetadas = await banco.consultar(`
                    SELECT DISTINCT venda_id
                    FROM itens_venda
                    WHERE produto_id = ?
                `, [produtoId]);

                await banco.executar(`
                    DELETE FROM itens_venda
                    WHERE produto_id = ?
                `, [produtoId]);

                const contarItensVenda = `
                    SELECT COUNT(*) AS quantidade
                    FROM itens_venda
                    WHERE venda_id = ?
                `;

                const recalcularVenda = `
                    SELECT COALESCE(SUM(subtotal), 0) AS subtotal
                    FROM itens_venda
                    WHERE venda_id = ?
                `;

                const atualizarVenda = `
                    UPDATE vendas
                    SET
                        subtotal = ?,
                        desconto = ?,
                        total = ?
                    WHERE id = ?
                `;

                const apagarVendaVazia = `
                    DELETE FROM vendas
                    WHERE id = ?
                      AND NOT EXISTS (
                          SELECT 1
                          FROM itens_venda iv
                          WHERE iv.venda_id = vendas.id
                      )
                `;

                for (const venda of vendasAfetadas) {
                    const vendaId = Number(venda.venda_id);
                    const quantidadeItens = Number((await banco.consultarUm(contarItensVenda, [vendaId]))?.quantidade || 0);

                    if (quantidadeItens === 0) {
                        // ON DELETE CASCADE remove garantias ligadas à venda.
                        await banco.executar(apagarVendaVazia, [vendaId]);
                        continue;
                    }

                    const subtotal = Number((await banco.consultarUm(recalcularVenda, [vendaId]))?.subtotal || 0);
                    const atual = await banco.consultarUm('SELECT desconto FROM vendas WHERE id = ?', [vendaId]);
                    const desconto = Math.min(Number(atual?.desconto || 0), subtotal);
                    await banco.executar(atualizarVenda, [subtotal, desconto, subtotal - desconto, vendaId]);
                }

                // 4) Histórico de movimentações de estoque do produto.
                await banco.executar(`
                    DELETE FROM movimentacoes_estoque
                    WHERE produto_id = ?
                `, [produtoId]);

                // 5) Por último, exclui o cadastro do produto.
                const resultado = await banco.executar(`
                    DELETE FROM produtos
                    WHERE id = ?
                `, [produtoId]);

                if (resultado.changes !== 1) {
                    throw new Error('O produto não foi excluído.');
                }

                return {
                    id: produtoId,
                    nome: produto.nome
                };
            });

            return {
                sucesso: true,
                id: produtoRemovido.id,
                nome: produtoRemovido.nome
            };

        } catch (erro) {
            console.error('Erro ao excluir produto:', erro);

            return {
                sucesso: false,
                mensagem: erro.message || 'Não foi possível excluir o produto.'
            };
        }
    }
);



/*
    ==================================================
    CLIENTES
    ==================================================
*/


/*
    LISTAR CLIENTES
*/

ipcMain.handle(
    'listar-clientes',
    async () => {
        return acessoBanco.consultar(`
            SELECT *
            FROM clientes
            ORDER BY id DESC
        `);
    }
);


/*
    BUSCAR CLIENTE POR ID
*/

ipcMain.handle(
    'buscar-cliente',
    async (event, id) => {
        return acessoBanco.consultarUm(`
            SELECT *
            FROM clientes
            WHERE id = ?
        `, [id]);
    }
);


/*
    CADASTRAR CLIENTE
*/

ipcMain.handle(
    'cadastrar-cliente',
    async (event, cliente) => {
        const resultado = await acessoBanco.executar(`
            INSERT INTO clientes (
                nome,
                cpf_cnpj,
                telefone,
                celular,
                email,
                cep,
                endereco,
                numero,
                complemento,
                bairro,
                cidade,
                estado,
                observacoes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            cliente.nome,
            cliente.cpf_cnpj || null,
            cliente.telefone || null,
            cliente.celular || null,
            cliente.email || null,
            cliente.cep || null,
            cliente.endereco || null,
            cliente.numero || null,
            cliente.complemento || null,
            cliente.bairro || null,
            cliente.cidade || null,
            cliente.estado || null,
            cliente.observacoes || null
        ]);
        return {
            sucesso: true,
            id: resultado.lastInsertRowid
        };
    }
);


/*
    EDITAR CLIENTE
*/

ipcMain.handle(
    'editar-cliente',
    async (event, cliente) => {
        const resultado = await acessoBanco.executar(`
            UPDATE clientes
            SET nome = ?, cpf_cnpj = ?, telefone = ?, celular = ?, email = ?,
                cep = ?, endereco = ?, numero = ?, complemento = ?, bairro = ?,
                cidade = ?, estado = ?, observacoes = ?
            WHERE id = ?
        `, [
            cliente.nome,
            cliente.cpf_cnpj || null,
            cliente.telefone || null,
            cliente.celular || null,
            cliente.email || null,
            cliente.cep || null,
            cliente.endereco || null,
            cliente.numero || null,
            cliente.complemento || null,
            cliente.bairro || null,
            cliente.cidade || null,
            cliente.estado || null,
            cliente.observacoes || null,
            cliente.id
        ]);
        return {
            sucesso: resultado.changes > 0
        };
    }
);


/*
    EXCLUIR CLIENTE
*/

ipcMain.handle(
    'excluir-cliente',
    async (event, id) => {
        const resultado = await acessoBanco.executar(`
            DELETE FROM clientes
            WHERE id = ?
        `, [id]);
        return {
            sucesso: resultado.changes > 0
        };
    }
);




/*
    ==================================================
    ESTOQUE — ENTRADA E HISTÓRICO
    ==================================================
*/


ipcMain.handle(
    'entrada-estoque',
    async (event, dados) => {

        try {

            const produtoId = Number(dados?.produto_id);
            const quantidade = Number(dados?.quantidade);
            const motivo = String(dados?.motivo || '').trim();

            if (!Number.isInteger(produtoId) || produtoId <= 0) {
                return {
                    sucesso: false,
                    mensagem: 'Selecione um produto.'
                };
            }

            if (!Number.isInteger(quantidade) || quantidade <= 0) {
                return {
                    sucesso: false,
                    mensagem: 'Informe uma quantidade válida maior que zero.'
                };
            }

            if (!motivo) {
                return {
                    sucesso: false,
                    mensagem: 'Informe o motivo da entrada.'
                };
            }

            const movimento = await acessoBanco.transacao(async banco => {
                const produto = await banco.consultarUm(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `, [produtoId]);

                if (!produto) {
                    throw new Error('Produto não encontrado.');
                }

                const estoqueAnterior = Number(produto.estoque) || 0;
                const estoquePosterior = estoqueAnterior + quantidade;

                await banco.executar(`
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `, [
                    estoquePosterior,
                    produtoId
                ]);

                const resultado = await banco.executar(`
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem
                    ) VALUES (
                        ?, 'entrada', ?, ?, ?, ?, 'manual'
                    )
                `, [
                    produtoId,
                    quantidade,
                    estoqueAnterior,
                    estoquePosterior,
                    motivo
                ]);

                return {
                    id: Number(resultado.lastInsertRowid),
                    produto_id: produtoId,
                    produto_nome: produto.nome,
                    quantidade,
                    estoque_anterior: estoqueAnterior,
                    estoque_posterior: estoquePosterior
                };
            });

            return {
                sucesso: true,
                id: movimento.id,
                produto_id: movimento.produto_id,
                produto_nome: movimento.produto_nome,
                quantidade: movimento.quantidade,
                estoque_anterior: movimento.estoque_anterior,
                estoque_posterior: movimento.estoque_posterior
            };

        } catch (erro) {

            console.error('Erro ao registrar entrada de estoque:', erro);

            return {
                sucesso: false,
                mensagem: erro.message || 'Não foi possível registrar a entrada de estoque.'
            };
        }
    }
);


ipcMain.handle(
    'saida-estoque',
    async (event, dados) => {

        try {

            const produtoId = Number(dados?.produto_id);
            const quantidade = Number(dados?.quantidade);
            const motivo = String(dados?.motivo || '').trim();

            if (!Number.isInteger(produtoId) || produtoId <= 0) {
                return {
                    sucesso: false,
                    mensagem: 'Selecione um produto.'
                };
            }

            if (!Number.isInteger(quantidade) || quantidade <= 0) {
                return {
                    sucesso: false,
                    mensagem: 'Informe uma quantidade válida maior que zero.'
                };
            }

            if (!motivo) {
                return {
                    sucesso: false,
                    mensagem: 'Informe o motivo da saída.'
                };
            }

            const movimento = await acessoBanco.transacao(async banco => {
                const produto = await banco.consultarUm(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `, [produtoId]);

                if (!produto) {
                    throw new Error('Produto não encontrado.');
                }

                const estoqueAnterior = Number(produto.estoque) || 0;

                if (quantidade > estoqueAnterior) {
                    throw new Error(`Estoque insuficiente. Estoque atual: ${estoqueAnterior}.`);
                }

                const estoquePosterior = estoqueAnterior - quantidade;

                await banco.executar(`
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `, [
                    estoquePosterior,
                    produtoId
                ]);

                const resultado = await banco.executar(`
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem
                    ) VALUES (
                        ?, 'saida', ?, ?, ?, ?, 'manual'
                    )
                `, [
                    produtoId,
                    quantidade,
                    estoqueAnterior,
                    estoquePosterior,
                    motivo
                ]);

                return {
                    id: Number(resultado.lastInsertRowid),
                    produto_id: produtoId,
                    produto_nome: produto.nome,
                    quantidade,
                    estoque_anterior: estoqueAnterior,
                    estoque_posterior: estoquePosterior
                };
            });

            return {
                sucesso: true,
                id: movimento.id,
                produto_id: movimento.produto_id,
                produto_nome: movimento.produto_nome,
                quantidade: movimento.quantidade,
                estoque_anterior: movimento.estoque_anterior,
                estoque_posterior: movimento.estoque_posterior
            };

        } catch (erro) {

            console.error('Erro ao registrar saída de estoque:', erro);

            return {
                sucesso: false,
                mensagem: erro.message || 'Não foi possível registrar a saída de estoque.'
            };
        }
    }
);


// Ajusta o saldo para a quantidade física informada e registra a movimentação.
ipcMain.handle(
    'ajuste-estoque',
    async (event, dados) => {

        try {
            const produtoId = Number(dados?.produto_id);
            const quantidadeFisica = Number(dados?.quantidade_fisica);
            const motivo = String(dados?.motivo || '').trim();

            if (!Number.isInteger(produtoId) || produtoId <= 0) {
                return { sucesso: false, mensagem: 'Selecione um produto.' };
            }

            if (!Number.isInteger(quantidadeFisica) || quantidadeFisica < 0) {
                return { sucesso: false, mensagem: 'Informe uma quantidade física válida.' };
            }

            if (!motivo) {
                return { sucesso: false, mensagem: 'Informe o motivo do ajuste.' };
            }

            const movimento = await acessoBanco.transacao(async banco => {
                const produto = await banco.consultarUm(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `, [produtoId]);

                if (!produto) {
                    throw new Error('Produto não encontrado.');
                }

                const estoqueAnterior = Number(produto.estoque) || 0;
                const diferenca = quantidadeFisica - estoqueAnterior;

                await banco.executar(`
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `, [quantidadeFisica, produtoId]);

                const insercao = await banco.executar(`
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem
                    ) VALUES (?, 'ajuste', ?, ?, ?, ?, 'manual')
                `, [
                    produtoId,
                    Math.abs(diferenca),
                    estoqueAnterior,
                    quantidadeFisica,
                    motivo
                ]);

                return {
                    id: Number(insercao.lastInsertRowid),
                    produto_id: produtoId,
                    produto_nome: produto.nome,
                    estoque_anterior: estoqueAnterior,
                    diferenca,
                    estoque_posterior: quantidadeFisica
                };
            });

            return { sucesso: true, ...movimento };
        } catch (erro) {
            console.error('Erro ao registrar ajuste de estoque:', erro);
            return {
                sucesso: false,
                mensagem: erro.message || 'Não foi possível registrar o ajuste de estoque.'
            };
        }
    }
);


ipcMain.handle(
    'listar-movimentacoes-estoque',
    async () => {
        return acessoBanco.consultar(`
            SELECT
                movimentacoes_estoque.*,
                produtos.nome AS produto_nome,
                produtos.sku,
                produtos.codigo_barras
            FROM movimentacoes_estoque
            INNER JOIN produtos
                ON produtos.id = movimentacoes_estoque.produto_id
            ORDER BY movimentacoes_estoque.id DESC
        `);
    }
);


/*
    ==================================================
    ORDENS DE SERVIÇO
    ==================================================
*/


// Número sequencial apresentado nas telas; não substitui a chave interna do banco.
async function proximoNumeroOS(banco = acessoBanco) {
    const resultado = await banco.consultarUm(`
            SELECT COALESCE(MAX(numero), 0) + 1 AS proximo_numero
            FROM ordens_servico
        `);
    return Number(resultado.proximo_numero) || 1;
}


// Valida e uniformiza as peças recebidas da interface antes de alterar o estoque.
function normalizarItensOS(itens) {

    if (!Array.isArray(itens)) {
        return [];
    }

    return itens.map(item => ({
        produto_id: Number(item.produto_id),
        descricao: item.descricao || item.nome || '',
        tipo: item.tipo || 'peca',
        quantidade: Number(item.quantidade),
        valor_unitario: Number(item.preco_unitario ?? item.valor_unitario) || 0,
        subtotal: Number(item.subtotal) || 0
    })).filter(item =>
        Number.isInteger(item.produto_id) &&
        item.produto_id > 0 &&
        Number.isInteger(item.quantidade) &&
        item.quantidade > 0
    );
}


ipcMain.handle(
    'listar-ordens-servico',
    async () => {
        return acessoBanco.consultar(`
            SELECT
                ordens_servico.*,
                clientes.nome AS cliente_nome,
                clientes.cpf_cnpj AS cliente_cpf_cnpj
            FROM ordens_servico
            LEFT JOIN clientes
                ON clientes.id = ordens_servico.cliente_id
            ORDER BY ordens_servico.id DESC
        `);
    }
);


ipcMain.handle(
    'buscar-ordem-servico',
    async (event, id) => {

        const os = await acessoBanco.consultarUm(`
            SELECT
                ordens_servico.*,
                clientes.nome AS cliente_nome,
                clientes.cpf_cnpj AS cliente_cpf_cnpj,
                clientes.telefone AS cliente_telefone,
                clientes.celular AS cliente_celular,
                clientes.email AS cliente_email
            FROM ordens_servico
            LEFT JOIN clientes
                ON clientes.id = ordens_servico.cliente_id
            WHERE ordens_servico.id = ?
        `, [id]);

        if (!os) {
            return null;
        }

        os.itens_os = await acessoBanco.consultar(`
            SELECT
                itens_os.id,
                itens_os.os_id,
                itens_os.produto_id,
                itens_os.descricao,
                itens_os.tipo,
                itens_os.quantidade,
                itens_os.valor_unitario,
                itens_os.subtotal,
                produtos.nome AS produto_nome
            FROM itens_os
            LEFT JOIN produtos
                ON produtos.id = itens_os.produto_id
            WHERE itens_os.os_id = ?
            ORDER BY itens_os.id ASC
        `, [id]);

        return os;

    }
);


ipcMain.handle(
    'cadastrar-ordem-servico',
    async (event, os) => {

        try {

            if (!os || !os.cliente_id) {
                return {
                    sucesso: false,
                    mensagem: 'Selecione um cliente para a ordem de serviço.'
                };
            }

            if (!os.tipo_equipamento || !os.tipo_equipamento.trim()) {
                return {
                    sucesso: false,
                    mensagem: 'Informe o tipo de equipamento.'
                };
            }

            const itens = normalizarItensOS(os.itens_pecas);
            const numero = await proximoNumeroOS();

            const resultadoExecucao = await acessoBanco.transacao(async banco => {

                for (const item of itens) {

                    const produto = await banco.consultarUm(`
                        SELECT id, nome, estoque, preco_venda
                        FROM produtos
                        WHERE id = ?
                    `, [item.produto_id]);

                    if (!produto) {
                        throw new Error(`Produto não encontrado: ${item.produto_id}`);
                    }

                    if (produto.estoque < item.quantidade) {
                        throw new Error(
                            `Estoque insuficiente para o produto "${produto.nome}". Disponível: ${produto.estoque}.`
                        );
                    }

                    item.descricao = produto.nome;
                    item.valor_unitario = Number(produto.preco_venda) || item.valor_unitario || 0;
                    item.subtotal = item.valor_unitario * item.quantidade;
                }

                const resultado = await banco.executar(`
                    INSERT INTO ordens_servico (
                        numero,
                        cliente_id,
                        tipo_equipamento,
                        marca,
                        modelo,
                        numero_serie,
                        sistema_operacional,
                        senha_equipamento,
                        acessorios,
                        estado_fisico,
                        avarias,
                        problema_relatado,
                        diagnostico,
                        servico_realizado,
                        previsao_entrega,
                        data_conclusao,
                        data_entrega,
                        status,
                        valor_pecas,
                        valor_mao_obra,
                        desconto,
                        total,
                        observacoes
                    ) VALUES (
                        @numero,
                        @cliente_id,
                        @tipo_equipamento,
                        @marca,
                        @modelo,
                        @numero_serie,
                        @sistema_operacional,
                        @senha_equipamento,
                        @acessorios,
                        @estado_fisico,
                        @avarias,
                        @problema_relatado,
                        @diagnostico,
                        @servico_realizado,
                        @previsao_entrega,
                        @data_conclusao,
                        @data_entrega,
                        @status,
                        @valor_pecas,
                        @valor_mao_obra,
                        @desconto,
                        @total,
                        @observacoes
                    )
                `, {
                    numero,
                    cliente_id: Number(os.cliente_id),
                    tipo_equipamento: os.tipo_equipamento.trim(),
                    marca: os.marca || null,
                    modelo: os.modelo || null,
                    numero_serie: os.numero_serie || null,
                    sistema_operacional: os.sistema_operacional || null,
                    senha_equipamento: os.senha_equipamento || null,
                    acessorios: os.acessorios || null,
                    estado_fisico: os.estado_fisico || null,
                    avarias: os.avarias || null,
                    problema_relatado: os.problema_relatado || null,
                    diagnostico: os.diagnostico || null,
                    servico_realizado: os.servico_realizado || null,
                    previsao_entrega: os.previsao_entrega || null,
                    data_conclusao: os.data_conclusao || null,
                    data_entrega: os.data_entrega || null,
                    status: os.status || 'Aguardando avaliação',
                    valor_pecas: itens.reduce((s, item) => s + item.subtotal, 0),
                    valor_mao_obra: Number(os.valor_mao_obra) || 0,
                    desconto: Number(os.desconto) || 0,
                    total: Number(os.total) || 0,
                    observacoes: os.observacoes || null
                });

                // node-firebird executa o INSERT, mas executeAsync não entrega
                // a linha de RETURNING. Recupere a chave pela numeração única
                // da OS dentro da própria transação antes de gravar suas peças.
                const osGravadaNaTransacao = await banco.consultarUm(
                    'SELECT id FROM ordens_servico WHERE numero = ?',
                    [numero]
                );
                const osId = Number(osGravadaNaTransacao?.id || resultado.lastInsertRowid || 0);
                if (!osId) throw new Error('A OS foi inserida, mas não foi possível obter seu identificador.');

                const inserirItem = `
                    INSERT INTO itens_os (
                        os_id,
                        produto_id,
                        descricao,
                        tipo,
                        quantidade,
                        valor_unitario,
                        subtotal
                    ) VALUES (
                        @os_id,
                        @produto_id,
                        @descricao,
                        @tipo,
                        @quantidade,
                        @valor_unitario,
                        @subtotal
                    )
                `;

                const baixarEstoque = `
                    UPDATE produtos
                    SET estoque = estoque - @quantidade
                    WHERE id = @produto_id
                `;

                const registrarMovimentacao = `
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem,
                        origem_id
                    ) VALUES (
                        @produto_id,
                        'saida',
                        @quantidade,
                        @estoque_anterior,
                        @estoque_posterior,
                        @motivo,
                        'os',
                        @origem_id
                    )
                `;

                for (const item of itens) {
                    await banco.executar(inserirItem, {
                        os_id: osId,
                        produto_id: item.produto_id,
                        descricao: item.descricao,
                        tipo: item.tipo,
                        quantidade: item.quantidade,
                        valor_unitario: item.valor_unitario,
                        subtotal: item.subtotal
                    });

                    const estoqueAnterior = Number((await banco.consultarUm(
                        'SELECT estoque FROM produtos WHERE id = ?', [item.produto_id]
                    ))?.estoque || 0);

                    await banco.executar(baixarEstoque, {
                        produto_id: item.produto_id,
                        quantidade: item.quantidade
                    });

                    const estoquePosterior = estoqueAnterior - Number(item.quantidade);

                    await banco.executar(registrarMovimentacao, {
                        produto_id: Number(item.produto_id),
                        quantidade: Number(item.quantidade),
                        estoque_anterior: estoqueAnterior,
                        estoque_posterior: estoquePosterior,
                        motivo: `OS nº ${String(numero).padStart(6, '0')}`,
                        origem_id: osId
                    });
                    console.log(
                        'MOVIMENTAÇÃO OS REGISTRADA:',
                        {
                            produto_id: Number(item.produto_id),
                            quantidade: Number(item.quantidade),
                            estoque_anterior: estoqueAnterior,
                            estoque_posterior: estoquePosterior,
                            origem: 'os',
                            origem_id: osId
                        }
                    );
                }

                return {
                    id: osId,
                    numero,
                    itens
                };
            });

            // Busca novamente os dados gravados no banco para garantir
            // que o número exibido seja exatamente o número persistido.
            const osGravada = await acessoBanco.consultarUm(`
                SELECT id, numero
                FROM ordens_servico
                WHERE id = ?
            `, [resultadoExecucao.id]);

            return {
                sucesso: true,
                os: {
                    id: Number(osGravada?.id) || 0,
                    numero: Number(osGravada?.numero) || 0,
                    itens: Array.isArray(resultadoExecucao.itens)
                        ? resultadoExecucao.itens.map(item => ({
                            produto_id: Number(item.produto_id) || 0,
                            descricao: String(item.descricao || ''),
                            tipo: String(item.tipo || 'peca'),
                            quantidade: Number(item.quantidade) || 0,
                            valor_unitario: Number(item.valor_unitario) || 0,
                            subtotal: Number(item.subtotal) || 0
                        }))
                        : []
                }
            };

        } catch (erro) {

            console.error('Erro ao cadastrar OS:', erro);

            return {
                sucesso: false,
                mensagem: erro.message || 'Não foi possível cadastrar a ordem de serviço.'
            };
        }
    }
);


ipcMain.handle(
    'editar-ordem-servico',
    async (event, os) => {

        try {

            if (!os || !os.id) {
                return { sucesso: false, mensagem: 'OS inválida.' };
            }

            const itensNovos = normalizarItensOS(os.itens_pecas);

            const sucessoEdicao = await acessoBanco.transacao(async banco => {

                const atual = await banco.consultarUm(`
                    SELECT id, numero, valor_pecas
                    FROM ordens_servico
                    WHERE id = ?
                `, [os.id]);

                if (!atual) {
                    throw new Error('Ordem de serviço não encontrada.');
                }

                const itensAntigos = await banco.consultar(`
                    SELECT produto_id, quantidade
                    FROM itens_os
                    WHERE os_id = ?
                `, [os.id]);

                const buscarEstoqueAtual = `
                    SELECT id, nome, estoque, preco_venda
                    FROM produtos
                    WHERE id = ?
                `;

                const atualizarEstoque = `
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `;

                const registrarMovimentacao = `
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem,
                        origem_id
                    ) VALUES (
                        @produto_id,
                        @tipo,
                        @quantidade,
                        @estoque_anterior,
                        @estoque_posterior,
                        @motivo,
                        'os',
                        @origem_id
                    )
                `;

                // Devolve ao estoque as peças da versão anterior da OS.
                for (const item of itensAntigos) {

                    if (!item.produto_id) continue;

                    const produto = await banco.consultarUm(buscarEstoqueAtual, [item.produto_id]);

                    if (!produto) {
                        throw new Error(`Produto não encontrado: ${item.produto_id}`);
                    }

                    const quantidade = Number(item.quantidade) || 0;
                    const estoqueAnterior = Number(produto.estoque) || 0;
                    const estoquePosterior = estoqueAnterior + quantidade;

                    await banco.executar(atualizarEstoque, [
                        estoquePosterior,
                        Number(item.produto_id)
                    ]);

                    await banco.executar(registrarMovimentacao, {
                        produto_id: Number(item.produto_id),
                        tipo: 'entrada',
                        quantidade,
                        estoque_anterior: estoqueAnterior,
                        estoque_posterior: estoquePosterior,
                        motivo: `Estorno da edição da OS nº ${String(atual.numero).padStart(6, '0')}`,
                        origem_id: Number(atual.id)
                    });
                }

                // Valida os novos itens com o estoque já restaurado.
                for (const item of itensNovos) {

                    const produto = await banco.consultarUm(buscarEstoqueAtual, [item.produto_id]);

                    if (!produto) {
                        throw new Error(`Produto não encontrado: ${item.produto_id}`);
                    }

                    if (produto.estoque < item.quantidade) {
                        throw new Error(
                            `Estoque insuficiente para o produto "${produto.nome}". Disponível: ${produto.estoque}.`
                        );
                    }

                    item.descricao = produto.nome;
                    item.valor_unitario =
                        Number(produto.preco_venda) ||
                        item.valor_unitario ||
                        0;
                    item.subtotal =
                        item.valor_unitario * item.quantidade;
                }

                await banco.executar(`
                    DELETE FROM itens_os
                    WHERE os_id = ?
                `, [os.id]);

                const valorPecasNovas = itensNovos.reduce(
                    (soma, item) => soma + item.subtotal,
                    0
                );

                const valorPecasLegado = itensAntigos.length === 0
                    ? Number(atual.valor_pecas) || 0
                    : 0;

                const valorPecas = valorPecasLegado + valorPecasNovas;

                const resultado = await banco.executar(`
                    UPDATE ordens_servico
                    SET
                        cliente_id = @cliente_id,
                        tipo_equipamento = @tipo_equipamento,
                        marca = @marca,
                        modelo = @modelo,
                        numero_serie = @numero_serie,
                        sistema_operacional = @sistema_operacional,
                        senha_equipamento = @senha_equipamento,
                        acessorios = @acessorios,
                        estado_fisico = @estado_fisico,
                        avarias = @avarias,
                        problema_relatado = @problema_relatado,
                        diagnostico = @diagnostico,
                        servico_realizado = @servico_realizado,
                        previsao_entrega = @previsao_entrega,
                        data_conclusao = @data_conclusao,
                        data_entrega = @data_entrega,
                        status = @status,
                        valor_pecas = @valor_pecas,
                        valor_mao_obra = @valor_mao_obra,
                        desconto = @desconto,
                        total = @total,
                        observacoes = @observacoes
                    WHERE id = @id
                `, {
                    id: Number(os.id),
                    cliente_id: Number(os.cliente_id),
                    tipo_equipamento: os.tipo_equipamento || '',
                    marca: os.marca || null,
                    modelo: os.modelo || null,
                    numero_serie: os.numero_serie || null,
                    sistema_operacional: os.sistema_operacional || null,
                    senha_equipamento: os.senha_equipamento || null,
                    acessorios: os.acessorios || null,
                    estado_fisico: os.estado_fisico || null,
                    avarias: os.avarias || null,
                    problema_relatado: os.problema_relatado || null,
                    diagnostico: os.diagnostico || null,
                    servico_realizado: os.servico_realizado || null,
                    previsao_entrega: os.previsao_entrega || null,
                    data_conclusao: os.data_conclusao || null,
                    data_entrega: os.data_entrega || null,
                    status: os.status || 'Aguardando avaliação',
                    valor_pecas: valorPecas,
                    valor_mao_obra: Number(os.valor_mao_obra) || 0,
                    desconto: Number(os.desconto) || 0,
                    total: Number(os.total) || 0,
                    observacoes: os.observacoes || null
                });

                const inserirItem = `
                    INSERT INTO itens_os (
                        os_id,
                        produto_id,
                        descricao,
                        tipo,
                        quantidade,
                        valor_unitario,
                        subtotal
                    ) VALUES (
                        @os_id,
                        @produto_id,
                        @descricao,
                        @tipo,
                        @quantidade,
                        @valor_unitario,
                        @subtotal
                    )
                `;

                const baixarEstoque = `
                    UPDATE produtos
                    SET estoque = estoque - @quantidade
                    WHERE id = @produto_id
                `;

                // Baixa os novos itens e registra cada saída.
                for (const item of itensNovos) {

                    await banco.executar(inserirItem, {
                        os_id: Number(os.id),
                        produto_id: item.produto_id,
                        descricao: item.descricao,
                        tipo: item.tipo,
                        quantidade: item.quantidade,
                        valor_unitario: item.valor_unitario,
                        subtotal: item.subtotal
                    });

                    const produto = await banco.consultarUm(buscarEstoqueAtual, [item.produto_id]);
                    const estoqueAnterior = Number(produto.estoque) || 0;

                    await banco.executar(baixarEstoque, {
                        produto_id: item.produto_id,
                        quantidade: item.quantidade
                    });

                    const estoquePosterior =
                        estoqueAnterior - Number(item.quantidade);

                    await banco.executar(registrarMovimentacao, {
                        produto_id: Number(item.produto_id),
                        tipo: 'saida',
                        quantidade: Number(item.quantidade),
                        estoque_anterior: estoqueAnterior,
                        estoque_posterior: estoquePosterior,
                        motivo: `Edição da OS nº ${String(atual.numero).padStart(6, '0')}`,
                        origem_id: Number(atual.id)
                    });
                }

                return resultado.changes > 0;
            });

            return { sucesso: Boolean(sucessoEdicao) };

        } catch (erro) {

            console.error('Erro ao editar OS:', erro);

            return {
                sucesso: false,
                mensagem:
                    erro.message ||
                    'Não foi possível editar a ordem de serviço.'
            };
        }
    }
);


ipcMain.handle(
    'excluir-ordem-servico',
    async (event, id) => {

        try {

            const osId = Number(id);

            if (!Number.isInteger(osId) || osId <= 0) {
                return {
                    sucesso: false,
                    mensagem: 'ID da ordem de serviço inválido.'
                };
            }

            const ordemExcluida = await acessoBanco.transacao(async banco => {

                const osExistente = await banco.consultarUm(`
                    SELECT id, numero
                    FROM ordens_servico
                    WHERE id = ?
                `, [osId]);

                if (!osExistente) {
                    throw new Error('Ordem de serviço não encontrada.');
                }

                const itens = await banco.consultar(`
                    SELECT produto_id, quantidade
                    FROM itens_os
                    WHERE os_id = ?
                `, [osId]);

                const buscarEstoqueAtual = `
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `;

                const devolverEstoque = `
                    UPDATE produtos
                    SET estoque = estoque + @quantidade
                    WHERE id = @produto_id
                `;

                const registrarMovimentacao = `
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem,
                        origem_id
                    ) VALUES (
                        @produto_id,
                        'entrada',
                        @quantidade,
                        @estoque_anterior,
                        @estoque_posterior,
                        @motivo,
                        'os',
                        @origem_id
                    )
                `;

                // Ao excluir a OS, devolve as peças ao estoque
                // e registra cada devolução no histórico.
                for (const item of itens) {

                    if (!item.produto_id) continue;

                    const produto = await banco.consultarUm(buscarEstoqueAtual, [item.produto_id]);

                    if (!produto) {
                        throw new Error(`Produto não encontrado: ${item.produto_id}`);
                    }

                    const quantidade = Number(item.quantidade) || 0;
                    const estoqueAnterior = Number(produto.estoque) || 0;
                    const estoquePosterior = estoqueAnterior + quantidade;

                    await banco.executar(devolverEstoque, {
                        produto_id: Number(item.produto_id),
                        quantidade
                    });

                    await banco.executar(registrarMovimentacao, {
                        produto_id: Number(item.produto_id),
                        quantidade,
                        estoque_anterior: estoqueAnterior,
                        estoque_posterior: estoquePosterior,
                        motivo: `Estorno da exclusão da OS nº ${String(osExistente.numero).padStart(6, '0')}`,
                        origem_id: Number(osExistente.id)
                    });
                }

                await banco.executar(`
                    DELETE FROM garantias
                    WHERE os_id = ?
                `, [osId]);

                await banco.executar(`
                    DELETE FROM itens_os
                    WHERE os_id = ?
                `, [osId]);

                const resultado = await banco.executar(`
                    DELETE FROM ordens_servico
                    WHERE id = ?
                `, [osId]);

                if (resultado.changes !== 1) {
                    throw new Error('A ordem de serviço não foi excluída.');
                }

                return {
                    id: Number(osExistente.id),
                    numero: Number(osExistente.numero)
                };
            });

            return {
                sucesso: true,
                os: {
                    id: Number(ordemExcluida.id),
                    numero: Number(ordemExcluida.numero)
                }
            };

        } catch (erro) {

            console.error('Erro ao excluir OS:', erro);

            return {
                sucesso: false,
                mensagem:
                    erro.message ||
                    'Não foi possível excluir a ordem de serviço.'
            };
        }
    }
);


/*
    ==================================================
    GARANTIAS
    ==================================================
*/

ipcMain.handle(
    'listar-garantias',
    async () => {
        // Sincroniza garantias originadas de vendas que já foram canceladas.
        await acessoBanco.executar(`
            UPDATE garantias
            SET status = 'Cancelada'
            WHERE venda_id IN (
                SELECT id FROM vendas
                WHERE lower(COALESCE(status, '')) LIKE '%cancel%'
            )
              AND status <> 'Cancelada'
        `);

        await acessoBanco.executar(`
            UPDATE garantias
            SET status = 'Expirada'
            WHERE status = 'Ativa'
              AND date(data_fim) < date('now', 'localtime')
        `);

        return acessoBanco.consultar(`
            SELECT
                garantias.*,
                clientes.nome AS cliente_nome,
                clientes.cpf_cnpj AS cliente_documento,
                COALESCE(
                    (
                        SELECT GROUP_CONCAT(prod.nome, '||')
                        FROM garantia_itens gi
                        INNER JOIN produtos prod ON prod.id = gi.produto_id
                        WHERE gi.garantia_id = garantias.id
                    ),
                    produtos.nome
                ) AS produtos_nomes,
                (
                    SELECT COUNT(*)
                    FROM garantia_itens gi2
                    WHERE gi2.garantia_id = garantias.id
                ) AS quantidade_produtos,
                (
                    SELECT GROUP_CONCAT(gi3.produto_id, ',')
                    FROM garantia_itens gi3
                    WHERE gi3.garantia_id = garantias.id
                ) AS produto_ids,
                vendas.numero AS venda_numero,
                ordens_servico.numero AS os_numero
            FROM garantias
            LEFT JOIN clientes ON clientes.id = garantias.cliente_id
            LEFT JOIN produtos ON produtos.id = garantias.produto_id
            LEFT JOIN vendas ON vendas.id = garantias.venda_id
            LEFT JOIN ordens_servico ON ordens_servico.id = garantias.os_id
            ORDER BY garantias.id DESC
        `);
    }
);

ipcMain.handle(
    'cadastrar-garantia',
    async (event, garantia) => {
        try {
            if (!garantia || !Number.isInteger(Number(garantia.cliente_id)) || Number(garantia.cliente_id) <= 0) {
                return { sucesso: false, mensagem: 'Selecione um cliente.' };
            }

            const clienteId = Number(garantia.cliente_id);
            const vendaId = garantia.venda_id ? Number(garantia.venda_id) : null;
            const osId = garantia.os_id ? Number(garantia.os_id) : null;
            const prazoDias = Math.max(1, Math.floor(Number(garantia.prazo_dias) || 90));

            if ((vendaId && osId) || (!vendaId && !osId)) {
                return { sucesso: false, mensagem: 'A garantia deve estar vinculada a uma venda ou a uma ordem de serviço.' };
            }

            let produtoIds = Array.isArray(garantia.produto_ids)
                ? garantia.produto_ids
                    .map(Number)
                    .filter(id => Number.isInteger(id) && id > 0)
                : [];

            // Compatibilidade com a versão anterior, que aceitava apenas um produto.
            if (!produtoIds.length && garantia.produto_id) {
                const produtoIdLegado = Number(garantia.produto_id);
                if (Number.isInteger(produtoIdLegado) && produtoIdLegado > 0) {
                    produtoIds = [produtoIdLegado];
                }
            }

            produtoIds = [...new Set(produtoIds)];

            const inicio = new Date();
            const fim = new Date(inicio.getTime());
            fim.setDate(fim.getDate() + prazoDias);

            const formatarSQLite = data => {
                const pad = n => String(n).padStart(2, '0');
                return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())}`;
            };

            const dataInicio = formatarSQLite(inicio);
            const dataFim = formatarSQLite(fim);

            const resultado = await acessoBanco.transacao(async banco => {
                const insercao = await banco.executar(`
                    INSERT INTO garantias (
                        venda_id, os_id, cliente_id, produto_id,
                        descricao, prazo_dias, data_inicio, data_fim,
                        status, observacoes, cobertura, exclusoes
                    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'Ativa', ?, ?, ?)
                `, [
                    vendaId,
                    osId,
                    clienteId,
                    garantia.descricao || '',
                    prazoDias,
                    dataInicio,
                    dataFim,
                    garantia.observacoes || '',
                    garantia.cobertura || '',
                    garantia.exclusoes || ''
                ]);

                const garantiaId = Number(insercao.lastInsertRowid);

                if (produtoIds.length) {
                    const itemSql = `
                        INSERT INTO garantia_itens (garantia_id, produto_id)
                        VALUES (?, ?)
                    `;

                    for (const produtoId of produtoIds) {
                        const produto = await banco.consultarUm('SELECT id FROM produtos WHERE id = ?', [produtoId]);
                        if (!produto) {
                            throw new Error(`Produto não encontrado: ${produtoId}`);
                        }
                        await banco.executar(itemSql, [garantiaId, produtoId]);
                    }
                }

                return { id: garantiaId, quantidade: produtoIds.length };
            });

            return {
                sucesso: true,
                ids: [resultado.id],
                quantidade: resultado.quantidade,
                garantia_id: resultado.id,
                data_inicio: dataInicio,
                data_fim: dataFim
            };
        } catch (erro) {
            return {
                sucesso: false,
                mensagem: erro.message || 'Não foi possível cadastrar a garantia.'
            };
        }
    }
);

ipcMain.handle(
    'editar-garantia',
    async (event, dados) => {
        try {
            const garantiaId = Number(dados?.id);
            const clienteId = Number(dados?.cliente_id);
            const vendaId = dados?.venda_id ? Number(dados.venda_id) : null;
            const osId = dados?.os_id ? Number(dados.os_id) : null;
            const prazoDias = Math.floor(Number(dados?.prazo_dias));
            const descricao = String(dados?.descricao || '').trim();
            const observacoes = String(dados?.observacoes || '').trim();
            const cobertura = String(dados?.cobertura || '').trim();
            const exclusoes = String(dados?.exclusoes || '').trim();

            if (!Number.isInteger(garantiaId) || garantiaId <= 0) {
                return { sucesso: false, mensagem: 'Garantia inválida.' };
            }
            if (!Number.isInteger(clienteId) || clienteId <= 0) {
                return { sucesso: false, mensagem: 'Selecione um cliente válido.' };
            }
            if ((vendaId && osId) || (!vendaId && !osId) ||
                (vendaId && (!Number.isInteger(vendaId) || vendaId <= 0)) ||
                (osId && (!Number.isInteger(osId) || osId <= 0))) {
                return { sucesso: false, mensagem: 'Selecione uma origem válida para a garantia.' };
            }
            if (!Number.isInteger(prazoDias) || prazoDias < 1) {
                return { sucesso: false, mensagem: 'Informe um prazo válido em dias.' };
            }

            const atual = await acessoBanco.consultarUm(`
                SELECT id, data_inicio
                FROM garantias
                WHERE id = ?
            `, [garantiaId]);
            if (!atual) return { sucesso: false, mensagem: 'Garantia não encontrada.' };

            const origem = vendaId
                ? await acessoBanco.consultarUm('SELECT id, cliente_id FROM vendas WHERE id = ?', [vendaId])
                : await acessoBanco.consultarUm('SELECT id, cliente_id FROM ordens_servico WHERE id = ?', [osId]);
            if (!origem) return { sucesso: false, mensagem: 'Venda ou ordem de serviço não encontrada.' };
            if (Number(origem.cliente_id) !== clienteId) {
                return { sucesso: false, mensagem: 'A origem selecionada não pertence ao cliente escolhido.' };
            }

            const produtoIds = Array.isArray(dados?.produto_ids)
                ? [...new Set(dados.produto_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))]
                : [];
            const itensOrigem = vendaId
                ? await acessoBanco.consultar('SELECT DISTINCT produto_id FROM itens_venda WHERE venda_id = ?', [vendaId])
                : await acessoBanco.consultar('SELECT DISTINCT produto_id FROM itens_os WHERE os_id = ? AND produto_id IS NOT NULL', [osId]);
            const produtosPermitidos = new Set(itensOrigem.map(item => Number(item.produto_id)));
            if (produtoIds.some(id => !produtosPermitidos.has(id))) {
                return { sucesso: false, mensagem: 'Selecione somente produtos vinculados à origem escolhida.' };
            }

            const dataInicio = new Date(String(atual.data_inicio).replace(' ', 'T'));
            if (Number.isNaN(dataInicio.getTime())) {
                return { sucesso: false, mensagem: 'A data inicial da garantia está inválida.' };
            }
            const dataFim = new Date(dataInicio.getTime());
            dataFim.setDate(dataFim.getDate() + prazoDias);
            const pad = numero => String(numero).padStart(2, '0');
            const formatarSQLite = data => `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())}`;
            const fimFormatado = formatarSQLite(dataFim);
            const agora = new Date();
            const hoje = `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}`;
            const status = fimFormatado.slice(0, 10) < hoje ? 'Expirada' : 'Ativa';

            const resultado = await acessoBanco.transacao(async banco => {
                await banco.executar(`
                    UPDATE garantias
                    SET venda_id = ?, os_id = ?, cliente_id = ?, produto_id = NULL,
                        descricao = ?, prazo_dias = ?, data_fim = ?, status = ?, observacoes = ?,
                        cobertura = ?, exclusoes = ?
                    WHERE id = ?
                `, [
                    vendaId, osId, clienteId, descricao, prazoDias,
                    fimFormatado, status, observacoes, cobertura, exclusoes, garantiaId
                ]);

                await banco.executar('DELETE FROM garantia_itens WHERE garantia_id = ?', [garantiaId]);
                const inserirProduto = `
                    INSERT INTO garantia_itens (garantia_id, produto_id)
                    VALUES (?, ?)
                `;
                for (const produtoId of produtoIds) await banco.executar(inserirProduto, [garantiaId, produtoId]);

                return { id: garantiaId, quantidade: produtoIds.length, data_fim: fimFormatado, status };
            });

            return { sucesso: true, ...resultado };
        } catch (erro) {
            console.error('Erro ao editar garantia:', erro);
            return { sucesso: false, mensagem: erro.message || 'Não foi possível atualizar a garantia.' };
        }
    }
);

/*
    ==================================================
    VENDAS
    ==================================================
*/


/*
    GERAR PRÓXIMO NÚMERO DA VENDA
*/

// Calcula o próximo número amigável que será impresso e mostrado ao usuário.
async function proximoNumeroVenda(banco = acessoBanco) {
    const resultado = await banco.consultarUm(`
        SELECT COALESCE(MAX(numero), 0) + 1 AS proximo_numero
        FROM vendas
    `);
    return Number(resultado?.proximo_numero || 1);
}


/*
    FINALIZAR VENDA
*/

ipcMain.handle(
    'finalizar-venda',
    async (event, venda) => {
        try {
            if (!venda || !Array.isArray(venda.itens) || venda.itens.length === 0) {
                return { sucesso: false, mensagem: 'A venda precisa ter pelo menos um produto.' };
            }
            for (const item of venda.itens) {
                if (!Number.isInteger(Number(item.quantidade)) || Number(item.quantidade) <= 0) {
                    return { sucesso: false, mensagem: 'A quantidade dos produtos deve ser maior que zero.' };
                }
            }

            const resultado = await acessoBanco.transacao(async banco => {
                let subtotal = 0;
                const itensProcessados = [];
                for (const item of venda.itens) {
                    const produto = await banco.consultarUm('SELECT * FROM produtos WHERE id = ?', [item.produto_id]);
                    if (!produto) throw new Error(`Produto não encontrado: ${item.produto_id}`);
                    const quantidade = Number(item.quantidade);
                    if (Number(produto.estoque) < quantidade) {
                        throw new Error(`Estoque insuficiente para o produto "${produto.nome}". Estoque disponível: ${produto.estoque}.`);
                    }
                    const precoUnitario = Number(produto.preco_venda) || 0;
                    const subtotalItem = precoUnitario * quantidade;
                    subtotal += subtotalItem;
                    itensProcessados.push({ produto_id: Number(produto.id), quantidade, preco_unitario: precoUnitario, subtotal: subtotalItem });
                }

                const desconto = Math.min(subtotal, Math.max(0, Number(venda.desconto) || 0));
                const total = subtotal - desconto;
                const numero = await proximoNumeroVenda(banco);
                const insercao = await banco.executar(`
                    INSERT INTO vendas (numero, cliente_id, subtotal, desconto, total, forma_pagamento, observacoes)
                    VALUES (@numero, @cliente_id, @subtotal, @desconto, @total, @forma_pagamento, @observacoes)
                `, {
                    numero,
                    cliente_id: venda.cliente_id || null,
                    subtotal,
                    desconto,
                    total,
                    forma_pagamento: venda.forma_pagamento || null,
                    observacoes: venda.observacoes || null
                });
                // O executeAsync do node-firebird confirma INSERT ... RETURNING,
                // mas não entrega a linha retornada. Use o número único da venda
                // para recuperar a chave na mesma transação antes de gravar itens.
                const vendaGravada = await banco.consultarUm(
                    'SELECT id FROM vendas WHERE numero = ?',
                    [numero]
                );
                const vendaId = Number(vendaGravada?.id || insercao.lastInsertRowid || 0);
                if (!vendaId) throw new Error('Não foi possível obter o identificador da venda gravada.');

                for (const item of itensProcessados) {
                    await banco.executar(`
                        INSERT INTO itens_venda (venda_id, produto_id, quantidade, preco_unitario, subtotal)
                        VALUES (@venda_id, @produto_id, @quantidade, @preco_unitario, @subtotal)
                    `, { venda_id: vendaId, ...item });

                    const estoqueAntes = await banco.consultarUm('SELECT estoque FROM produtos WHERE id = ?', [item.produto_id]);
                    const estoqueAnterior = Number(estoqueAntes?.estoque || 0);
                    await banco.executar('UPDATE produtos SET estoque = estoque - ? WHERE id = ?', [item.quantidade, item.produto_id]);
                    await banco.executar(`
                        INSERT INTO movimentacoes_estoque (
                            produto_id, tipo, quantidade, estoque_anterior, estoque_posterior, motivo, origem, origem_id
                        ) VALUES (?, 'saida', ?, ?, ?, ?, 'venda', ?)
                    `, [item.produto_id, item.quantidade, estoqueAnterior, estoqueAnterior - item.quantidade,
                        `Venda nº ${String(numero).padStart(6, '0')}`, vendaId]);
                }
                return { venda_id: vendaId, numero, subtotal, desconto, total };
            });
            return { sucesso: true, venda: resultado };
        } catch (erro) {
            console.error('Erro ao finalizar venda:', erro);
            return { sucesso: false, mensagem: erro.message || 'Não foi possível finalizar a venda.' };
        }
    }
);


/*
    ==================================================
    LISTAR VENDAS
    ==================================================
*/

ipcMain.handle(
    'listar-vendas',
    () => acessoBanco.consultar(`
        SELECT vendas.*, clientes.nome AS cliente_nome
        FROM vendas
        LEFT JOIN clientes ON clientes.id = vendas.cliente_id
        ORDER BY vendas.id DESC
    `)
);


/*
    ==================================================
    DADOS DO RELATÓRIO
    ==================================================
*/

ipcMain.handle('obter-dados-relatorio', async () => {
    const [vendas, ordens, produtos, itensVenda] = await Promise.all([
        acessoBanco.consultar(`
            SELECT id, cliente_id, status, total, forma_pagamento, data_hora
            FROM vendas
            ORDER BY id DESC
        `),
        acessoBanco.consultar(`
            SELECT id, cliente_id, status, total, data_hora_abertura
            FROM ordens_servico
            ORDER BY id DESC
        `),
        acessoBanco.consultar(`
            SELECT id, nome, estoque, estoque_minimo
            FROM produtos
            ORDER BY id DESC
        `),
        acessoBanco.consultar(`
            SELECT itens_venda.venda_id, itens_venda.produto_id,
                   itens_venda.quantidade, itens_venda.preco_unitario,
                   itens_venda.subtotal, produtos.nome AS produto_nome,
                   produtos.sku, produtos.codigo_barras
            FROM itens_venda
            INNER JOIN produtos ON produtos.id = itens_venda.produto_id
            ORDER BY itens_venda.venda_id DESC, itens_venda.id ASC
        `)
    ]);

    return { vendas, ordens, produtos, itensVenda };
});

ipcMain.handle('obter-dados-dashboard', async () => {
    const [vendas, ordens, produtos, clientes] = await Promise.all([
        acessoBanco.consultar(`
            SELECT id, numero, cliente_id, status, total, data_hora
            FROM vendas
            ORDER BY id DESC
        `),
        acessoBanco.consultar(`
            SELECT id, numero, cliente_id, tipo_equipamento, marca, modelo,
                   status, data_hora_abertura
            FROM ordens_servico
            ORDER BY id DESC
        `),
        acessoBanco.consultar(`
            SELECT id, nome, estoque, estoque_minimo, preco_venda
            FROM produtos
            ORDER BY id DESC
        `),
        acessoBanco.consultar(`
            SELECT id, nome
            FROM clientes
            ORDER BY id DESC
        `)
    ]);

    return { vendas, ordens, produtos, clientes };
});

// Revisão leve para as estações detectarem gravações feitas por outro computador.
ipcMain.handle('obter-revisao-dados-compartilhados', async () => {
    const linha = await acessoBanco.consultarUm(
        'SELECT COALESCE(MAX(id), 0) AS revisao FROM auditoria'
    );
    return { sucesso: true, revisao: Number(linha?.revisao || 0) };
});


/*
    ==================================================
    BUSCAR VENDA
    ==================================================
*/

ipcMain.handle(
    'buscar-venda',
    async (event, id) => {
        const venda = await acessoBanco.consultarUm(`
            SELECT vendas.*, clientes.nome AS cliente_nome, clientes.cpf_cnpj,
                   clientes.telefone, clientes.celular, clientes.email
            FROM vendas
            LEFT JOIN clientes ON clientes.id = vendas.cliente_id
            WHERE vendas.id = ?
        `, [id]);
        if (!venda) return null;
        const itens = await acessoBanco.consultar(`
            SELECT itens_venda.*, produtos.nome AS produto_nome, produtos.sku, produtos.codigo_barras
            FROM itens_venda
            INNER JOIN produtos ON produtos.id = itens_venda.produto_id
            WHERE itens_venda.venda_id = ?
            ORDER BY itens_venda.id
        `, [id]);
        return { ...venda, itens };
    }
);





/*
    ==================================================
    CANCELAR VENDA — PRESERVA HISTÓRICO E DEVOLVE ESTOQUE
    ==================================================
*/

ipcMain.handle('cancelar-venda', async (event, dados) => {
    try {
        const vendaId = Number(typeof dados === 'object' ? dados?.id : dados);
        const motivo = String(typeof dados === 'object' ? dados?.motivo || '' : '').trim();
        if (!Number.isInteger(vendaId) || vendaId <= 0) return { sucesso: false, mensagem: 'Venda inválida.' };
        if (motivo.length < 3) return { sucesso: false, mensagem: 'Informe o motivo do cancelamento.' };
        if (motivo.length > 500) return { sucesso: false, mensagem: 'O motivo deve ter até 500 caracteres.' };

        const resultado = await acessoBanco.transacao(async banco => {
            const venda = await banco.consultarUm('SELECT id, numero, status FROM vendas WHERE id = ?', [vendaId]);
            if (!venda) throw new Error('Venda não encontrada.');
            if (String(venda.status || '').toLowerCase().includes('cancel')) throw new Error('Esta venda já foi cancelada.');

            const itens = await banco.consultar('SELECT produto_id, quantidade FROM itens_venda WHERE venda_id = ? ORDER BY id', [vendaId]);
            for (const item of itens) {
                const produto = await banco.consultarUm('SELECT id, nome, estoque FROM produtos WHERE id = ?', [item.produto_id]);
                if (!produto) throw new Error(`O produto ID ${item.produto_id} não foi encontrado. A venda não foi cancelada.`);
                const quantidade = Number(item.quantidade) || 0;
                const anterior = Number(produto.estoque) || 0;
                const posterior = anterior + quantidade;
                await banco.executar('UPDATE produtos SET estoque = estoque + ? WHERE id = ?', [quantidade, item.produto_id]);
                await banco.executar(`
                INSERT INTO movimentacoes_estoque (produto_id,tipo,quantidade,estoque_anterior,estoque_posterior,motivo,origem,origem_id)
                VALUES (?,'entrada',?,?,?,?, 'cancelamento_venda',?)
                `, [item.produto_id, quantidade, anterior, posterior,
                    `Estorno da venda nº ${String(venda.numero).padStart(6, '0')} — ${motivo}`, vendaId]);
            }

            await banco.executar(`UPDATE vendas SET status = 'Cancelada', cancelada_em = CURRENT_TIMESTAMP, cancelamento_motivo = ? WHERE id = ?`, [motivo, vendaId]);
            await banco.executar(`
                UPDATE garantias
                SET status = 'Cancelada'
                WHERE venda_id = ? AND status <> 'Cancelada'
            `, [vendaId]);
            return { venda_id: vendaId, numero: Number(venda.numero), itens_devolvidos: itens.length };
        });

        return { sucesso: true, venda: resultado };
    } catch (erro) {
        console.error('Erro ao cancelar venda:', erro);
        return { sucesso: false, mensagem: erro.message || 'Não foi possível cancelar a venda.' };
    }
});


/*
    ==================================================
    EXCLUIR VENDA — DEVOLVE ESTOQUE
    ==================================================
*/

ipcMain.handle(
    'excluir-venda',
    async (event, idInformado) => {
        try {
            const vendaId = Number(
                typeof idInformado === 'object' ? idInformado?.id : idInformado
            );

            if (!Number.isInteger(vendaId) || vendaId <= 0) {
                return { sucesso: false, mensagem: 'Venda inválida.' };
            }

            const resultado = await acessoBanco.transacao(async banco => {
                const venda = await banco.consultarUm(`
                    SELECT id, numero, subtotal, desconto, total
                    FROM vendas
                    WHERE id = ?
                `, [vendaId]);

                if (!venda) {
                    throw new Error('Venda não encontrada.');
                }

                const itens = await banco.consultar(`
                    SELECT produto_id, quantidade
                    FROM itens_venda
                    WHERE venda_id = ?
                    ORDER BY id
                `, [vendaId]);

                for (const item of itens) {
                    const produto = await banco.consultarUm('SELECT id, nome, estoque FROM produtos WHERE id = ?', [item.produto_id]);
                    if (!produto) {
                        throw new Error(`O produto ID ${item.produto_id} não foi encontrado. A venda não foi excluída.`);
                    }

                    const quantidade = Number(item.quantidade) || 0;
                    const estoqueAnterior = Number(produto.estoque) || 0;
                    const estoquePosterior = estoqueAnterior + quantidade;

                    await banco.executar('UPDATE produtos SET estoque = estoque + ? WHERE id = ?', [quantidade, item.produto_id]);
                    await banco.executar(`
                        INSERT INTO movimentacoes_estoque (
                            produto_id, tipo, quantidade, estoque_anterior, estoque_posterior,
                            motivo, origem, origem_id
                        ) VALUES (?, 'entrada', ?, ?, ?, ?, 'estorno_venda', ?)
                    `, [item.produto_id, quantidade, estoqueAnterior, estoquePosterior,
                        `Estorno da venda nº ${String(venda.numero).padStart(6, '0')} — venda excluída`, vendaId]);
                }

                // Remove as movimentações originais da venda para que ela deixe
                // de aparecer como uma venda válida no histórico de estoque.
                await banco.executar(`
                    DELETE FROM movimentacoes_estoque
                    WHERE origem = 'venda' AND origem_id = ?
                `, [vendaId]);

                // itens_venda possui ON DELETE CASCADE.
                await banco.executar(`DELETE FROM vendas WHERE id = ?`, [vendaId]);

                return {
                    venda_id: vendaId,
                    numero: Number(venda.numero),
                    itens_devolvidos: itens.length
                };
            });
            return { sucesso: true, venda: resultado };
        } catch (erro) {
            console.error('Erro ao excluir venda:', erro);
            return {
                sucesso: false,
                mensagem: erro.message || 'Não foi possível excluir a venda.'
            };
        }
    }
);



/*
    ==================================================
    USUÁRIOS E PERMISSÕES — ETAPA 5.2/5.3
    ==================================================
*/

ipcMain.handle('listar-usuarios', async () => {
    const usuarios = await acessoBanco.consultar(`
        SELECT id, nome, usuario, perfil, ativo, primeiro_acesso, criado_em, atualizado_em
        FROM usuarios
        ORDER BY id ASC
    `);

    return Promise.all(usuarios.map(async usuario => ({
        ...usuario,
        ativo: Number(usuario.ativo) === 1,
        primeiro_acesso: Number(usuario.primeiro_acesso) === 1,
        permissoes: await buscarPermissoesUsuario(usuario.id, usuario.perfil)
    })));
});

ipcMain.handle('cadastrar-usuario', async (event, dados) => {
    try {
        const nome = String(dados?.nome || '').trim();
        const usuario = String(dados?.usuario || '').trim();
        const senha = String(dados?.senha || '');
        const perfil = dados?.perfil === 'administrador' ? 'administrador' : 'funcionario';

        if (!nome || !usuario || !senha) return { sucesso: false, mensagem: 'Preencha nome, usuário e senha.' };
        if (senha.length < 6) return { sucesso: false, mensagem: 'A senha deve possuir pelo menos 6 caracteres.' };
        if (!/^[a-zA-Z0-9._-]+$/.test(usuario)) return { sucesso: false, mensagem: 'O usuário deve conter apenas letras, números, ponto, hífen ou sublinhado.' };
        const resultado = await acessoBanco.transacao(async banco => {
            if (await banco.consultarUm('SELECT id FROM usuarios WHERE lower(usuario) = lower(?)', [usuario])) {
                throw new Error('Este nome de usuário já está em uso.');
            }

            const senhaGerada = gerarSenha(senha);
            const insercao = await banco.executar(`
                INSERT INTO usuarios (nome, usuario, senha_hash, senha_salt, perfil, ativo, primeiro_acesso)
                VALUES (?, ?, ?, ?, ?, 1, 1)
            `, [nome, usuario, senhaGerada.hash, senhaGerada.salt, perfil]);

            // O adaptador Firebird não fornece lastInsertRowid para INSERT.
            // Recupere o ID pela chave de usuário, dentro da mesma transação,
            // antes de inserir as permissões que dependem da FK.
            const usuarioCriado = await banco.consultarUm(
                'SELECT id FROM usuarios WHERE usuario = ?',
                [usuario]
            );
            const usuarioId = Number(usuarioCriado?.id || 0);
            if (!usuarioId) throw new Error('O usuário foi inserido, mas não foi possível recuperar seu identificador.');

            await garantirPermissoesNoEscopo(banco, usuarioId, perfil);
            return usuarioId;
        });
        return { sucesso: true, id: resultado };
    } catch (erro) {
        if (erro.message === 'Este nome de usuário já está em uso.') return { sucesso: false, mensagem: erro.message };
        console.error('Erro ao cadastrar usuário:', erro);
        return { sucesso: false, mensagem: erro.message || 'Não foi possível cadastrar o usuário.' };
    }
});

ipcMain.handle('editar-usuario', async (event, dados) => {
    try {
        const id = Number(dados?.id);
        const nome = String(dados?.nome || '').trim();
        const usuario = String(dados?.usuario || '').trim();
        const perfil = dados?.perfil === 'administrador' ? 'administrador' : 'funcionario';
        const sessao = sessoesGestor.get(event.sender.id);

        if (!id || !nome || !usuario) return { sucesso: false, mensagem: 'Preencha os dados obrigatórios.' };
        if (sessao && Number(sessao.id) === id && perfil !== 'administrador') return { sucesso: false, mensagem: 'O administrador não pode remover o próprio perfil administrativo.' };
        const resultado = await acessoBanco.transacao(async banco => {
            const existente = await banco.consultarUm('SELECT * FROM usuarios WHERE id = ?', [id]);
            if (!existente) throw new Error('Usuário não encontrado.');
            const duplicado = await banco.consultarUm('SELECT id FROM usuarios WHERE lower(usuario) = lower(?) AND id <> ?', [usuario, id]);
            if (duplicado) throw new Error('Este nome de usuário já está em uso.');

            if (existente.perfil === 'administrador' && perfil !== 'administrador') {
                const totalAdmins = await banco.consultarUm("SELECT COUNT(*) AS total FROM usuarios WHERE perfil = 'administrador' AND ativo = 1");
                if (Number(totalAdmins.total) <= 1) throw new Error('O sistema precisa manter pelo menos um administrador ativo.');
            }

            await banco.executar('UPDATE usuarios SET nome = ?, usuario = ?, perfil = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?', [nome, usuario, perfil, id]);
            await garantirPermissoesNoEscopo(banco, id, perfil);
        });
        return { sucesso: true };
    } catch (erro) {
        if (['Usuário não encontrado.', 'Este nome de usuário já está em uso.', 'O sistema precisa manter pelo menos um administrador ativo.'].includes(erro.message)) {
            return { sucesso: false, mensagem: erro.message };
        }
        console.error('Erro ao editar usuário:', erro);
        return { sucesso: false, mensagem: erro.message || 'Não foi possível editar o usuário.' };
    }
});

ipcMain.handle('alterar-senha-usuario', async (event, dados) => {
    try {
        const id = Number(dados?.id);
        const senha = String(dados?.senha || '');
        if (!id || senha.length < 6) return { sucesso: false, mensagem: 'A senha deve possuir pelo menos 6 caracteres.' };
        const novo = gerarSenha(senha);
        const resultado = await acessoBanco.executar(`UPDATE usuarios SET senha_hash = ?, senha_salt = ?, primeiro_acesso = 0, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`, [novo.hash, novo.salt, id]);
        return { sucesso: resultado.changes === 1 };
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message || 'Não foi possível alterar a senha.' };
    }
});

ipcMain.handle('alternar-status-usuario', async (event, idInformado) => {
    try {
        const id = Number(idInformado);
        const sessao = sessoesGestor.get(event.sender.id);
        if (!id) return { sucesso: false, mensagem: 'Usuário inválido.' };
        if (sessao && Number(sessao.id) === id) return { sucesso: false, mensagem: 'Você não pode desativar o próprio usuário.' };
        const usuario = await acessoBanco.consultarUm(`SELECT id, perfil, ativo FROM usuarios WHERE id = ?`, [id]);
        if (!usuario) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
        if (Number(usuario.ativo) === 1 && usuario.perfil === 'administrador') {
            const totalAdmins = await acessoBanco.consultarUm(`SELECT COUNT(*) AS total FROM usuarios WHERE perfil = 'administrador' AND ativo = 1`);
            if (Number(totalAdmins.total) <= 1) return { sucesso: false, mensagem: 'Não é possível desativar o último administrador ativo.' };
        }
        const novoStatus = Number(usuario.ativo) === 1 ? 0 : 1;
        await acessoBanco.executar(`UPDATE usuarios SET ativo = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`, [novoStatus, id]);
        return { sucesso: true, ativo: novoStatus === 1 };
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message || 'Não foi possível alterar o status.' };
    }
});

ipcMain.handle('buscar-permissoes-usuario', async (event, idInformado) => {
    const id = Number(idInformado);
    const usuario = await acessoBanco.consultarUm(`SELECT id, perfil FROM usuarios WHERE id = ?`, [id]);
    if (!usuario) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
    return { sucesso: true, perfil: usuario.perfil, permissoes: await buscarPermissoesUsuario(usuario.id, usuario.perfil) };
});

ipcMain.handle('salvar-permissoes-usuario', async (event, dados) => {
    try {
        const usuarioId = Number(dados?.usuario_id);
        const usuario = await acessoBanco.consultarUm(`SELECT id, perfil FROM usuarios WHERE id = ?`, [usuarioId]);
        if (!usuario) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
        if (usuario.perfil === 'administrador') return { sucesso: false, mensagem: 'Administradores possuem acesso total.' };
        const permissoes = Array.isArray(dados?.permissoes) ? dados.permissoes : [];

        await acessoBanco.transacao(async banco => {
            for (const modulo of MODULOS_PERMISSAO) {
                const item = permissoes.find(p => p.modulo === modulo) || {};
                const valores = [
                    item.consultar ? 1 : 0,
                    item.criar ? 1 : 0,
                    item.editar ? 1 : 0,
                    item.excluir ? 1 : 0
                ];
                const atualizada = await banco.executar(`
                    UPDATE permissoes_usuarios
                    SET consultar = ?, criar = ?, editar = ?, excluir = ?, atualizado_em = CURRENT_TIMESTAMP
                    WHERE usuario_id = ? AND modulo = ?
                `, [...valores, usuarioId, modulo]);
                if (!atualizada.changes) {
                    await banco.executar(`
                        INSERT INTO permissoes_usuarios (usuario_id, modulo, consultar, criar, editar, excluir)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [usuarioId, modulo, ...valores]);
                }
            }
        });
        return { sucesso: true };
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message || 'Não foi possível salvar as permissões.' };
    }
});

ipcMain.handle('listar-auditoria', async (event, filtros = {}) => {
    const sessao = sessoesGestor.get(event.sender.id);
    if (!sessao || sessao.perfil !== 'administrador') {
        return { sucesso: false, mensagem: 'Acesso restrito ao administrador.', registros: [] };
    }
    const limite = Math.min(Math.max(Number(filtros.limite) || 500, 1), 1000);
    const termo = String(filtros.termo || '').trim();
    let sql = `SELECT id, usuario_id, usuario_nome, usuario_login, perfil, acao, modulo, descricao, entidade_tipo, entidade_id, data_hora, dados_antes, dados_depois FROM auditoria`;
    const params=[];
    if (termo) { sql += ` WHERE usuario_nome LIKE ? OR usuario_login LIKE ? OR descricao LIKE ? OR modulo LIKE ? OR acao LIKE ?`; const t=`%${termo}%`; params.push(t,t,t,t,t); }
    sql += ` ORDER BY id DESC LIMIT ?`; params.push(limite);

    const registros = await acessoBanco.consultar(sql, params);

    // Enriquece cada registro com uma referência humana ao objeto afetado.
    // Isso permite que a auditoria mostre, por exemplo, "Venda #000007 — João"
    // em vez de apenas "venda #7".
    for (const registro of registros) {
        registro.origem_tipo = registro.entidade_tipo || null;
        registro.origem_numero = null;
        registro.origem_nome = null;
        registro.origem_documento = null;
        registro.origem_descricao = null;
        registro.origem_detalhes = null;

        const tipo = String(registro.entidade_tipo || '').toLowerCase();
        const idEntidade = registro.entidade_id != null ? Number(registro.entidade_id) : null;

        try {
            if (idEntidade && tipo === 'venda') {
                const item = await acessoBanco.consultarUm(`
                    SELECT v.id, v.numero, v.total, v.forma_pagamento,
                           c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj
                    FROM vendas v
                    LEFT JOIN clientes c ON c.id = v.cliente_id
                    WHERE v.id = ?
                `, [idEntidade]);
                if (item) {
                    registro.origem_numero = Number(item.numero);
                    registro.origem_nome = item.cliente_nome || null;
                    registro.origem_documento = item.cliente_cpf_cnpj || null;
                    registro.origem_descricao = `Venda #${String(item.numero).padStart(6, '0')}`;
                    registro.origem_detalhes = [
                        item.cliente_nome ? `Cliente: ${item.cliente_nome}` : null,
                        item.total != null ? `Total: R$ ${Number(item.total).toFixed(2).replace('.', ',')}` : null,
                        item.forma_pagamento ? `Pagamento: ${item.forma_pagamento}` : null
                    ].filter(Boolean).join(' • ');
                }
            } else if (idEntidade && tipo === 'ordem_servico') {
                const item = await acessoBanco.consultarUm(`
                    SELECT o.id, o.numero, o.status, o.total, o.tipo_equipamento, o.marca, o.modelo,
                           c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj
                    FROM ordens_servico o
                    LEFT JOIN clientes c ON c.id = o.cliente_id
                    WHERE o.id = ?
                `, [idEntidade]);
                if (item) {
                    registro.origem_numero = Number(item.numero);
                    registro.origem_nome = item.cliente_nome || null;
                    registro.origem_documento = item.cliente_cpf_cnpj || null;
                    registro.origem_descricao = `OS #${String(item.numero).padStart(6, '0')}`;
                    const equipamento = [item.tipo_equipamento, item.marca, item.modelo].filter(Boolean).join(' ');
                    registro.origem_detalhes = [
                        item.cliente_nome ? `Cliente: ${item.cliente_nome}` : null,
                        equipamento ? `Equipamento: ${equipamento}` : null,
                        item.status ? `Status: ${item.status}` : null,
                        item.total != null ? `Total: R$ ${Number(item.total).toFixed(2).replace('.', ',')}` : null
                    ].filter(Boolean).join(' • ');
                }
            } else if (idEntidade && tipo === 'produto') {
                const item = await acessoBanco.consultarUm(`SELECT id, nome, sku, codigo_barras, estoque FROM produtos WHERE id = ?`, [idEntidade]);
                if (item) {
                    registro.origem_nome = item.nome || null;
                    registro.origem_documento = item.sku || item.codigo_barras || null;
                    registro.origem_descricao = `Produto: ${item.nome}`;
                    registro.origem_detalhes = [
                        item.sku ? `SKU: ${item.sku}` : null,
                        item.codigo_barras ? `EAN: ${item.codigo_barras}` : null,
                        item.estoque != null ? `Estoque atual: ${item.estoque}` : null
                    ].filter(Boolean).join(' • ');
                }
            } else if (idEntidade && tipo === 'cliente') {
                const item = await acessoBanco.consultarUm(`SELECT id, nome, cpf_cnpj, celular, email FROM clientes WHERE id = ?`, [idEntidade]);
                if (item) {
                    registro.origem_nome = item.nome || null;
                    registro.origem_documento = item.cpf_cnpj || null;
                    registro.origem_descricao = `Cliente: ${item.nome}`;
                    registro.origem_detalhes = [
                        item.cpf_cnpj ? `CPF/CNPJ: ${item.cpf_cnpj}` : null,
                        item.celular ? `Celular: ${item.celular}` : null,
                        item.email ? `E-mail: ${item.email}` : null
                    ].filter(Boolean).join(' • ');
                }
            } else if (idEntidade && tipo === 'usuario') {
                const item = await acessoBanco.consultarUm(`SELECT id, nome, usuario, perfil, ativo FROM usuarios WHERE id = ?`, [idEntidade]);
                if (item) {
                    registro.origem_nome = item.nome || null;
                    registro.origem_documento = item.usuario || null;
                    registro.origem_descricao = `Usuário: ${item.nome} (${item.usuario})`;
                    registro.origem_detalhes = `Perfil: ${item.perfil === 'administrador' ? 'Administrador' : 'Funcionário'} • Status: ${Number(item.ativo) === 1 ? 'Ativo' : 'Inativo'}`;
                }
            } else if (idEntidade && tipo === 'garantia') {
                const item = await acessoBanco.consultarUm(`
                    SELECT g.id, g.venda_id, g.os_id, g.status, c.nome AS cliente_nome
                    FROM garantias g LEFT JOIN clientes c ON c.id = g.cliente_id
                    WHERE g.id = ?
                `, [idEntidade]);
                if (item) {
                    registro.origem_nome = item.cliente_nome || null;
                    registro.origem_descricao = `Garantia #${item.id}`;
                    registro.origem_detalhes = [
                        item.cliente_nome ? `Cliente: ${item.cliente_nome}` : null,
                        item.venda_id ? `Venda #${String(item.venda_id).padStart(6, '0')}` : null,
                        item.os_id ? `OS #${String(item.os_id).padStart(6, '0')}` : null,
                        item.status ? `Status: ${item.status}` : null
                    ].filter(Boolean).join(' • ');
                }
            }
        } catch (erroOrigem) {
            console.warn('Não foi possível enriquecer auditoria:', erroOrigem.message);
        }
    }

    return { sucesso:true, registros };
});

ipcMain.handle('registrar-logout', async (event) => {
    const sessao = sessoesGestor.get(event.sender.id);
    if (!sessao) return { sucesso: true };
    await registrarAuditoria(sessao, { acao:'logout', modulo:'seguranca', descricao:'Saiu do sistema.' });
    sessoesGestor.delete(event.sender.id);
    return { sucesso:true };
});

/*
    ==================================================
    INICIAR APLICAÇÃO
    ==================================================
*/

app.whenReady().then(async () => {
    try {
        const runtime = await inicializarProvedorBanco();
        if (runtime.tipo === 'sqlite' || runtime.tipo === 'firebird') iniciarBackupAutomatico();

        const anuncio = configuracaoFirebird.lerConfiguracaoAnuncio(app.getPath('userData'));
        if (runtime.tipo === 'firebird' && anuncio?.id && anuncio?.alias) {
            anunciadorFirebird = descobertaFirebird.criarAnunciador(anuncio);
            await anunciadorFirebird.iniciar();
            console.info('Anúncio de descoberta Firebird local ativado.');
        }
        criarJanela();
    } catch (erro) {
        console.error('Falha ao inicializar o banco de dados configurado:', erro);
        dialog.showErrorBox(
            'Não foi possível abrir o banco do Gestor Fácil',
            `A configuração Firebird existe, mas a conexão, a validação do esquema ou a importação inicial falhou. O SQLite local não será usado como substituto.\n\nDetalhes: ${String(erro.message || erro)}`
        );
        app.quit();
        return;
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) criarJanela();
    });
});


/*
    ==================================================
    FECHAR APLICAÇÃO
    ==================================================
*/

app.on(
    'window-all-closed',
    () => {

        if (
            process.platform !== 'darwin'
        ) {

            app.quit();

        }

    }
);

