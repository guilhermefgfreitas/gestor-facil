/*
 * PROCESSO PRINCIPAL DO ELECTRON
 * Reúne banco SQLite, janelas, autenticação, permissões, backups e operações
 * de negócio. A tela acessa essas funções apenas pelos canais do preload.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Mantém userData estável mesmo se o nome exibido ou o empacotamento mudar.
// Este caminho já corresponde à pasta usada pela configuração de backup existente.
app.setPath('userData', path.join(app.getPath('appData'), 'gestor-facil'));

const licenciamento = require('./licenciamento');
const db = require('./database/banco');

let atualizacaoPronta = false;
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
function registrarAuditoria(usuario, dados = {}) {
    try {
        const u = usuario || {};
        db.prepare(`
            INSERT INTO auditoria (
                usuario_id, usuario_nome, usuario_login, perfil,
                acao, modulo, descricao, entidade_tipo, entidade_id, dados_antes, dados_depois
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
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
        );
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


// Só cria a conta de administração padrão quando ainda não existe nenhum usuário.
function garantirAdministradorInicial() {

    const total = db
        .prepare('SELECT COUNT(*) AS total FROM usuarios')
        .get();

    if (Number(total?.total || 0) > 0) {
        return;
    }

    const senha = gerarSenha('admin123');

    db.prepare(`
        INSERT INTO usuarios (
            nome,
            usuario,
            senha_hash,
            senha_salt,
            perfil,
            ativo,
            primeiro_acesso
        )
        VALUES (
            @nome,
            @usuario,
            @senha_hash,
            @senha_salt,
            'administrador',
            1,
            1
        )
    `).run({
        nome: 'Administrador',
        usuario: 'admin',
        senha_hash: senha.hash,
        senha_salt: senha.salt
    });

    console.log('Usuário administrador inicial criado: admin');

}


garantirAdministradorInicial();



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

// Prepara as permissões que faltarem e garante acesso completo aos administradores.
function garantirPermissoesUsuario(usuarioId, perfil) {
    if (perfil === 'administrador') {
        for (const p of permissoesAdministrador()) {
            db.prepare(`
                INSERT INTO permissoes_usuarios (usuario_id, modulo, consultar, criar, editar, excluir)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(usuario_id, modulo) DO UPDATE SET
                    consultar = excluded.consultar,
                    criar = excluded.criar,
                    editar = excluded.editar,
                    excluir = excluded.excluir,
                    atualizado_em = CURRENT_TIMESTAMP
            `).run(usuarioId, p.modulo, p.consultar, p.criar, p.editar, p.excluir);
        }
        return;
    }

    for (const modulo of MODULOS_PERMISSAO) {
        const p = PERMISSOES_FUNCIONARIO_PADRAO[modulo] || { consultar: 0, criar: 0, editar: 0, excluir: 0 };
        db.prepare(`
            INSERT INTO permissoes_usuarios (usuario_id, modulo, consultar, criar, editar, excluir)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(usuario_id, modulo) DO NOTHING
        `).run(usuarioId, modulo, p.consultar, p.criar, p.editar, p.excluir);
    }
}

function buscarPermissoesUsuario(usuarioId, perfil) {
    if (perfil === 'administrador') return permissoesAdministrador();
    garantirPermissoesUsuario(usuarioId, perfil);
    return db.prepare(`
        SELECT modulo, consultar, criar, editar, excluir
        FROM permissoes_usuarios
        WHERE usuario_id = ?
        ORDER BY id
    `).all(usuarioId);
}

// Confere no banco o estado ativo e a permissão exigida para a chamada atual.
function usuarioTemPermissao(usuarioId, modulo, acao = 'consultar') {
    const usuario = db.prepare(`SELECT id, perfil, ativo FROM usuarios WHERE id = ?`).get(usuarioId);
    if (!usuario || Number(usuario.ativo) !== 1) return false;
    if (usuario.perfil === 'administrador') return true;

    garantirPermissoesUsuario(usuario.id, usuario.perfil);
    const permissao = db.prepare(`
        SELECT ${acao === 'criar' || acao === 'editar' || acao === 'excluir' ? acao : 'consultar'} AS permitido
        FROM permissoes_usuarios
        WHERE usuario_id = ? AND modulo = ?
    `).get(usuario.id, modulo);
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
        'ajuste-estoque': ['estoque', 'editar']
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

function capturarSnapshotAuditoria(canal, dados, resultado) {
    const id = obterIdAuditoria(canal, dados, resultado);
    if (!id) return null;
    try {
        if (canal.includes('produto') || canal.includes('estoque')) {
            return db.prepare(`SELECT id,nome,codigo,sku,codigo_barras,categoria,preco_custo,preco_venda,estoque,estoque_minimo FROM produtos WHERE id = ?`).get(id) || null;
        }
        if (canal.includes('cliente')) {
            return db.prepare(`SELECT id,nome,cpf_cnpj,telefone,celular,email,cep,endereco,numero,complemento,bairro,cidade,estado,observacoes FROM clientes WHERE id = ?`).get(id) || null;
        }
        if (canal.includes('ordem-servico')) {
            return db.prepare(`SELECT id,numero,cliente_id,tipo_equipamento,marca,modelo,numero_serie,sistema_operacional,acessorios,estado_fisico,avarias,problema_relatado,diagnostico,servico_realizado,previsao_entrega,status,valor_pecas,valor_mao_obra,desconto,total,observacoes FROM ordens_servico WHERE id = ?`).get(id) || null;
        }
        if (canal.includes('usuario')) {
            return db.prepare(`SELECT id,nome,usuario,perfil,ativo,primeiro_acesso FROM usuarios WHERE id = ?`).get(id) || null;
        }
        if (canal.includes('garantia')) {
            return db.prepare(`SELECT id,venda_id,os_id,cliente_id,produto_id,descricao,prazo_dias,data_inicio,data_fim,status,observacoes,cobertura,exclusoes FROM garantias WHERE id = ?`).get(id) || null;
        }
        if (canal === 'finalizar-venda' || canal === 'excluir-venda' || canal === 'cancelar-venda') {
            const venda = db.prepare(`SELECT id,numero,cliente_id,subtotal,desconto,total,forma_pagamento,observacoes,status,cancelada_em,cancelamento_motivo,data_hora FROM vendas WHERE id = ?`).get(id) || null;
            if (!venda) return null;
            if (canal === 'excluir-venda' || canal === 'cancelar-venda') {
                venda.itens = db.prepare(`SELECT id,produto_id,quantidade,preco_unitario,subtotal FROM itens_venda WHERE venda_id = ? ORDER BY id`).all(id);
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
        if (['obter-estado-licenca', 'ativar-licenca'].includes(canal)) {
            return listener(event, ...args);
        }

        if (canal === 'login') {
            const estadoLicenca = licenciamento.obterEstadoLicenca();
            if (!estadoLicenca.ativa) {
                return { sucesso: false, mensagem: 'Ative o Gestor Fácil para continuar.' };
            }
            const resultado = await listener(event, ...args);
            if (resultado?.sucesso && resultado.usuario?.id) {
                const usuarioId = Number(resultado.usuario.id);
                const perfil = resultado.usuario.perfil;
                garantirPermissoesUsuario(usuarioId, perfil);
                sessoesGestor.set(event.sender.id, {
                    id: usuarioId,
                    nome: resultado.usuario.nome,
                    usuario: resultado.usuario.usuario,
                    perfil,
                    permissoes: buscarPermissoesUsuario(usuarioId, perfil)
                });
                resultado.usuario.permissoes = buscarPermissoesUsuario(usuarioId, perfil);
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
        if (regra && !usuarioTemPermissao(sessao.id, regra[0], regra[1])) {
            return { sucesso: false, mensagem: 'Você não possui permissão para realizar esta ação.' };
        }

        if (['listar-usuarios', 'cadastrar-usuario', 'editar-usuario', 'alterar-senha-usuario', 'alternar-status-usuario', 'buscar-permissoes-usuario', 'salvar-permissoes-usuario'].includes(canal)) {
            if (sessao.perfil !== 'administrador') {
                return { sucesso: false, mensagem: 'Acesso restrito ao administrador.' };
            }
        }

        const snapshotAntes = ['editar-produto','excluir-produto','editar-cliente','excluir-cliente','editar-ordem-servico','excluir-ordem-servico','editar-garantia','editar-usuario','alterar-senha-usuario','alternar-status-usuario','salvar-permissoes-usuario','entrada-estoque','saida-estoque','ajuste-estoque','excluir-venda','cancelar-venda'].includes(canal)
            ? capturarSnapshotAuditoria(canal, args[0], null)
            : null;

        const resultado = await listener(event, ...args);

        if (resultado?.sucesso !== false) {
            const snapshotDepois = ['cadastrar-produto','editar-produto','cadastrar-cliente','editar-cliente','cadastrar-ordem-servico','editar-ordem-servico','editar-garantia','cadastrar-usuario','editar-usuario','alternar-status-usuario','salvar-permissoes-usuario','entrada-estoque','saida-estoque','ajuste-estoque','cadastrar-garantia','finalizar-venda','cancelar-venda'].includes(canal)
                ? capturarSnapshotAuditoria(canal, args[0], resultado)
                : null;
            const audit = mapaAuditoriaCanal(canal, args[0], resultado, sessao, snapshotAntes, snapshotDepois);
            if (audit) registrarAuditoria(sessao, audit);
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
    (event, dados) => {

        const usuarioInformado = String(dados?.usuario || '').trim();
        const senhaInformada = String(dados?.senha || '');

        if (!usuarioInformado || !senhaInformada) {
            return {
                sucesso: false,
                mensagem: 'Informe o usuário e a senha.'
            };
        }

        const usuario = db.prepare(`
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
        `).get(usuarioInformado);

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

        db.prepare(`
            UPDATE usuarios
            SET atualizado_em = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(usuario.id);

        registrarAuditoria({
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
    return {
        habilitado: false,
        horario: '20:00',
        pasta: path.join(app.getPath('documents'), 'Gestor Fácil', 'Backups'),
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

function limparBackupsAntigos(pasta, prefixo, limite) {
    const arquivos = fs.readdirSync(pasta)
        .filter(nome => nome.toLowerCase().startsWith(prefixo) && nome.toLowerCase().endsWith('.db'))
        .map(nome => {
            const caminho = path.join(pasta, nome);
            return { caminho, mtime: fs.statSync(caminho).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

    for (const arquivo of arquivos.slice(limite)) fs.unlinkSync(arquivo.caminho);
}

function nomeBackupAutomatico() {
    const agora = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `gestor-facil-auto-${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}.db`;
}

// Copia o banco SQLite para a pasta configurada e aplica o nome com data/hora.
async function executarBackupAutomatico(chaveAgendamento) {
    if (backupEmExecucao) return { sucesso: false, ignorado: true, motivo: 'backup em andamento' };
    backupEmExecucao = true;
    try {
        const config = lerConfiguracaoBackup();
        if (!config.habilitado || !config.pasta) return { sucesso: false, ignorado: true };

        fs.mkdirSync(config.pasta, { recursive: true });
        const destino = path.join(config.pasta, nomeBackupAutomatico());
        await db.backup(destino);
        try {
            validarArquivoBackup(destino, true);
        } catch (erroValidacao) {
            try { fs.unlinkSync(destino); } catch (_) {}
            throw erroValidacao;
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
            limparBackupsAntigos(config.pasta, 'gestor-facil-auto-', config.manter);
        } catch (erroRetencao) {
            console.error('Backup criado e validado, mas não foi possível aplicar a retenção:', erroRetencao);
        }

        registrarAuditoria(null, {
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
        await db.backup(destino);
        validarArquivoBackup(destino, true);
        try { limparBackupsAntigos(config.pasta, 'gestor-facil-teste-', 1); }
        catch (erroRetencao) { console.error('Backup de teste validado, mas não foi possível remover testes antigos:', erroRetencao); }
        return { sucesso: true, caminho: destino, nome_arquivo: path.basename(destino) };
    } catch (erro) {
        console.error('Erro no teste do backup automático:', erro);
        return { sucesso: false, mensagem: `Não foi possível testar o backup: ${erro.message}` };
    } finally {
        backupEmExecucao = false;
    }
}

ipcMain.handle('salvar-config-backup', (event, dados) => {
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

    registrarAuditoria(sessao, {
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
    const sessao = sessoesGestor.get(event.sender.id);
    if (!sessao || sessao.perfil !== 'administrador') return { sucesso: false, mensagem: 'Acesso restrito ao administrador.' };

    const config = lerConfiguracaoBackup();
    if (!config.pasta) return { sucesso: false, mensagem: 'Configure primeiro a pasta de destino.' };

    const resultado = await executarBackupAutomaticoForcado();
    if (resultado?.sucesso) {
        registrarAuditoria(sessao, { acao: 'backup', modulo: 'seguranca', descricao: `Testou o backup automático: ${resultado.nome_arquivo}.`, entidade_tipo: 'backup' });
    }
    return resultado;
});

/*
    ==================================================
    BACKUP MANUAL DO BANCO
    ==================================================
*/

ipcMain.handle('fazer-backup', async (event) => {
    if (backupEmExecucao) return { sucesso: false, mensagem: 'Já existe um backup em andamento. Tente novamente em instantes.' };
    backupEmExecucao = true;
    try {
        const agora = new Date();
        const pad = n => String(n).padStart(2, '0');
        const nomePadrao = `gestor-facil-backup-${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}-${pad(agora.getSeconds())}.db`;

        const janela = BrowserWindow.fromWebContents(event.sender);
        const escolha = await dialog.showSaveDialog(janela, {
            title: 'Salvar backup do Gestor Fácil',
            defaultPath: path.join(app.getPath('documents'), nomePadrao),
            filters: [
                { name: 'Banco de dados do Gestor Fácil', extensions: ['db'] },
                { name: 'Todos os arquivos', extensions: ['*'] }
            ]
        });

        if (escolha.canceled || !escolha.filePath) {
            return { sucesso: false, cancelado: true };
        }

        let destino = escolha.filePath;
        if (!destino.toLowerCase().endsWith('.db')) destino += '.db';

        await db.backup(destino);
        validarArquivoBackup(destino, true);

        return {
            sucesso: true,
            caminho: destino,
            nome_arquivo: path.basename(destino)
        };
    } catch (erro) {
        console.error('Erro ao realizar backup:', erro);
        return {
            sucesso: false,
            mensagem: 'Não foi possível realizar o backup do banco de dados.'
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
    if (backupEmExecucao) return { sucesso: false, mensagem: 'Aguarde o backup em andamento terminar antes de restaurar.' };
    backupEmExecucao = true;
    try {
        const janela = BrowserWindow.fromWebContents(event.sender);
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
            mensagem: 'Não foi possível restaurar o backup. O banco atual não foi substituído, se a falha ocorreu antes da restauração.'
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

app.whenReady().then(() => {
    iniciarBackupAutomatico();
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
    () => {

        const produtos = db
            .prepare(`
                SELECT *
                FROM produtos
                ORDER BY id DESC
            `)
            .all();


        return produtos;

    }
);


/*
    CADASTRAR PRODUTO
*/

ipcMain.handle(
    'cadastrar-produto',
    (event, produto) => {

        const comando = db.prepare(`

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

            )

            VALUES (

                @nome,
                @codigo,
                @sku,
                @codigo_barras,
                @categoria,
                @preco_custo,
                @preco_venda,
                @estoque,
                @estoque_minimo

            )

        `);


        const resultado = comando.run({

            nome:
                produto.nome,

            codigo:
                produto.codigo || null,

            sku:
                produto.sku || null,

            codigo_barras:
                produto.codigo_barras || null,

            categoria:
                produto.categoria || null,

            preco_custo:
                Number(produto.preco_custo) || 0,

            preco_venda:
                Number(produto.preco_venda) || 0,

            estoque:
                Number(produto.estoque) || 0,

            estoque_minimo:
                Number(produto.estoque_minimo) || 0

        });


        return {

            sucesso: true,

            id:
                resultado.lastInsertRowid

        };

    }
);


/*
    EDITAR PRODUTO
*/

ipcMain.handle(
    'editar-produto',
    (event, produto) => {

        const comando = db.prepare(`

            UPDATE produtos

            SET

                nome = @nome,

                codigo = @codigo,

                sku = @sku,

                codigo_barras = @codigo_barras,

                categoria = @categoria,

                preco_custo = @preco_custo,

                preco_venda = @preco_venda,

                estoque = @estoque,

                estoque_minimo = @estoque_minimo

            WHERE id = @id

        `);


        const resultado = comando.run({

            id:
                produto.id,

            nome:
                produto.nome,

            codigo:
                produto.codigo || null,

            sku:
                produto.sku || null,

            codigo_barras:
                produto.codigo_barras || null,

            categoria:
                produto.categoria || null,

            preco_custo:
                Number(produto.preco_custo) || 0,

            preco_venda:
                Number(produto.preco_venda) || 0,

            estoque:
                Number(produto.estoque) || 0,

            estoque_minimo:
                Number(produto.estoque_minimo) || 0

        });


        return {

            sucesso:
                resultado.changes > 0

        };

    }
);


/*
    EXCLUIR PRODUTO
*/

ipcMain.handle(
    'excluir-produto',
    (event, id) => {

        const produtoId = Number(id);

        if (!Number.isInteger(produtoId) || produtoId <= 0) {
            return {
                sucesso: false,
                mensagem: 'Produto inválido.'
            };
        }

        try {
            const executar = db.transaction(() => {

                const produto = db.prepare(`
                    SELECT id, nome
                    FROM produtos
                    WHERE id = ?
                `).get(produtoId);

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
                const garantiasAfetadas = db.prepare(`
                    SELECT DISTINCT garantia_id
                    FROM garantia_itens
                    WHERE produto_id = ?
                `).all(produtoId);

                db.prepare(`
                    DELETE FROM garantia_itens
                    WHERE produto_id = ?
                `).run(produtoId);

                db.prepare(`
                    UPDATE garantias
                    SET produto_id = NULL
                    WHERE produto_id = ?
                `).run(produtoId);

                const apagarGarantiaVazia = db.prepare(`
                    DELETE FROM garantias
                    WHERE id = ?
                      AND produto_id IS NULL
                      AND NOT EXISTS (
                          SELECT 1
                          FROM garantia_itens gi
                          WHERE gi.garantia_id = garantias.id
                      )
                `);

                for (const garantia of garantiasAfetadas) {
                    apagarGarantiaVazia.run(Number(garantia.garantia_id));
                }

                // 2) Ordens de serviço: remove somente as peças deste
                // produto e recalcula os valores das OS afetadas.
                const osAfetadas = db.prepare(`
                    SELECT DISTINCT os_id
                    FROM itens_os
                    WHERE produto_id = ?
                `).all(produtoId);

                db.prepare(`
                    DELETE FROM itens_os
                    WHERE produto_id = ?
                `).run(produtoId);

                const recalcularOS = db.prepare(`
                    SELECT
                        COALESCE(SUM(subtotal), 0) AS valor_pecas
                    FROM itens_os
                    WHERE os_id = ?
                `);

                const atualizarOS = db.prepare(`
                    UPDATE ordens_servico
                    SET
                        valor_pecas = ?,
                        total = MAX(0, ? + COALESCE(valor_mao_obra, 0) - COALESCE(desconto, 0))
                    WHERE id = ?
                `);

                for (const os of osAfetadas) {
                    const valores = recalcularOS.get(Number(os.os_id));
                    const valorPecas = Number(valores?.valor_pecas || 0);
                    atualizarOS.run(valorPecas, valorPecas, Number(os.os_id));
                }

                // 3) Vendas: remove o item do produto do histórico.
                // Se aquela venda não tiver mais nenhum item, a venda inteira
                // é removida para não deixar uma venda vazia no histórico.
                const vendasAfetadas = db.prepare(`
                    SELECT DISTINCT venda_id
                    FROM itens_venda
                    WHERE produto_id = ?
                `).all(produtoId);

                db.prepare(`
                    DELETE FROM itens_venda
                    WHERE produto_id = ?
                `).run(produtoId);

                const contarItensVenda = db.prepare(`
                    SELECT COUNT(*) AS quantidade
                    FROM itens_venda
                    WHERE venda_id = ?
                `);

                const recalcularVenda = db.prepare(`
                    SELECT COALESCE(SUM(subtotal), 0) AS subtotal
                    FROM itens_venda
                    WHERE venda_id = ?
                `);

                const atualizarVenda = db.prepare(`
                    UPDATE vendas
                    SET
                        subtotal = ?,
                        desconto = MIN(COALESCE(desconto, 0), ?),
                        total = ? - MIN(COALESCE(desconto, 0), ?)
                    WHERE id = ?
                `);

                const apagarVendaVazia = db.prepare(`
                    DELETE FROM vendas
                    WHERE id = ?
                      AND NOT EXISTS (
                          SELECT 1
                          FROM itens_venda iv
                          WHERE iv.venda_id = vendas.id
                      )
                `);

                for (const venda of vendasAfetadas) {
                    const vendaId = Number(venda.venda_id);
                    const quantidadeItens = Number(contarItensVenda.get(vendaId)?.quantidade || 0);

                    if (quantidadeItens === 0) {
                        // ON DELETE CASCADE remove garantias ligadas à venda.
                        apagarVendaVazia.run(vendaId);
                        continue;
                    }

                    const subtotal = Number(recalcularVenda.get(vendaId)?.subtotal || 0);
                    atualizarVenda.run(subtotal, subtotal, subtotal, subtotal, vendaId);
                }

                // 4) Histórico de movimentações de estoque do produto.
                db.prepare(`
                    DELETE FROM movimentacoes_estoque
                    WHERE produto_id = ?
                `).run(produtoId);

                // 5) Por último, exclui o cadastro do produto.
                const resultado = db.prepare(`
                    DELETE FROM produtos
                    WHERE id = ?
                `).run(produtoId);

                if (resultado.changes !== 1) {
                    throw new Error('O produto não foi excluído.');
                }

                return {
                    id: produtoId,
                    nome: produto.nome
                };
            });

            const resultadoExecucao = executar();

            return {
                sucesso: true,
                id: resultadoExecucao.id,
                nome: resultadoExecucao.nome
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
    () => {

        const clientes = db
            .prepare(`
                SELECT *
                FROM clientes
                ORDER BY id DESC
            `)
            .all();


        return clientes;

    }
);


/*
    BUSCAR CLIENTE POR ID
*/

ipcMain.handle(
    'buscar-cliente',
    (event, id) => {

        const cliente = db
            .prepare(`
                SELECT *
                FROM clientes
                WHERE id = ?
            `)
            .get(id);


        return cliente || null;

    }
);


/*
    CADASTRAR CLIENTE
*/

ipcMain.handle(
    'cadastrar-cliente',
    (event, cliente) => {

        const comando = db.prepare(`

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

            )

            VALUES (

                @nome,
                @cpf_cnpj,
                @telefone,
                @celular,
                @email,
                @cep,
                @endereco,
                @numero,
                @complemento,
                @bairro,
                @cidade,
                @estado,
                @observacoes

            )

        `);


        const resultado = comando.run({

            nome:
                cliente.nome,

            cpf_cnpj:
                cliente.cpf_cnpj || null,

            telefone:
                cliente.telefone || null,

            celular:
                cliente.celular || null,

            email:
                cliente.email || null,

            cep:
                cliente.cep || null,

            endereco:
                cliente.endereco || null,

            numero:
                cliente.numero || null,

            complemento:
                cliente.complemento || null,

            bairro:
                cliente.bairro || null,

            cidade:
                cliente.cidade || null,

            estado:
                cliente.estado || null,

            observacoes:
                cliente.observacoes || null

        });


        return {

            sucesso: true,

            id:
                resultado.lastInsertRowid

        };

    }
);


/*
    EDITAR CLIENTE
*/

ipcMain.handle(
    'editar-cliente',
    (event, cliente) => {

        const comando = db.prepare(`

            UPDATE clientes

            SET

                nome = @nome,

                cpf_cnpj = @cpf_cnpj,

                telefone = @telefone,

                celular = @celular,

                email = @email,

                cep = @cep,

                endereco = @endereco,

                numero = @numero,

                complemento = @complemento,

                bairro = @bairro,

                cidade = @cidade,

                estado = @estado,

                observacoes = @observacoes

            WHERE id = @id

        `);


        const resultado = comando.run({

            id:
                cliente.id,

            nome:
                cliente.nome,

            cpf_cnpj:
                cliente.cpf_cnpj || null,

            telefone:
                cliente.telefone || null,

            celular:
                cliente.celular || null,

            email:
                cliente.email || null,

            cep:
                cliente.cep || null,

            endereco:
                cliente.endereco || null,

            numero:
                cliente.numero || null,

            complemento:
                cliente.complemento || null,

            bairro:
                cliente.bairro || null,

            cidade:
                cliente.cidade || null,

            estado:
                cliente.estado || null,

            observacoes:
                cliente.observacoes || null

        });


        return {

            sucesso:
                resultado.changes > 0

        };

    }
);


/*
    EXCLUIR CLIENTE
*/

ipcMain.handle(
    'excluir-cliente',
    (event, id) => {

        const comando = db.prepare(`

            DELETE FROM clientes

            WHERE id = ?

        `);


        const resultado = comando.run(id);


        return {

            sucesso:
                resultado.changes > 0

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
    (event, dados) => {

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

            const executar = db.transaction(() => {

                const produto = db.prepare(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `).get(produtoId);

                if (!produto) {
                    throw new Error('Produto não encontrado.');
                }

                const estoqueAnterior = Number(produto.estoque) || 0;
                const estoquePosterior = estoqueAnterior + quantidade;

                db.prepare(`
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `).run(
                    estoquePosterior,
                    produtoId
                );

                const resultado = db.prepare(`
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
                `).run(
                    produtoId,
                    quantidade,
                    estoqueAnterior,
                    estoquePosterior,
                    motivo
                );

                return {
                    id: Number(resultado.lastInsertRowid),
                    produto_id: produtoId,
                    produto_nome: produto.nome,
                    quantidade,
                    estoque_anterior: estoqueAnterior,
                    estoque_posterior: estoquePosterior
                };
            });

            const movimento = executar();

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
    (event, dados) => {

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

            const executar = db.transaction(() => {

                const produto = db.prepare(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `).get(produtoId);

                if (!produto) {
                    throw new Error('Produto não encontrado.');
                }

                const estoqueAnterior = Number(produto.estoque) || 0;

                if (quantidade > estoqueAnterior) {
                    throw new Error(`Estoque insuficiente. Estoque atual: ${estoqueAnterior}.`);
                }

                const estoquePosterior = estoqueAnterior - quantidade;

                db.prepare(`
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `).run(
                    estoquePosterior,
                    produtoId
                );

                const resultado = db.prepare(`
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
                `).run(
                    produtoId,
                    quantidade,
                    estoqueAnterior,
                    estoquePosterior,
                    motivo
                );

                return {
                    id: Number(resultado.lastInsertRowid),
                    produto_id: produtoId,
                    produto_nome: produto.nome,
                    quantidade,
                    estoque_anterior: estoqueAnterior,
                    estoque_posterior: estoquePosterior
                };
            });

            const movimento = executar();

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
    (event, dados) => {

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

            const executar = db.transaction(() => {
                const produto = db.prepare(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `).get(produtoId);

                if (!produto) {
                    throw new Error('Produto não encontrado.');
                }

                const estoqueAnterior = Number(produto.estoque) || 0;
                const diferenca = quantidadeFisica - estoqueAnterior;

                db.prepare(`
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `).run(quantidadeFisica, produtoId);

                const insercao = db.prepare(`
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem
                    ) VALUES (?, 'ajuste', ?, ?, ?, ?, 'manual')
                `).run(
                    produtoId,
                    Math.abs(diferenca),
                    estoqueAnterior,
                    quantidadeFisica,
                    motivo
                );

                return {
                    id: Number(insercao.lastInsertRowid),
                    produto_id: produtoId,
                    produto_nome: produto.nome,
                    estoque_anterior: estoqueAnterior,
                    diferenca,
                    estoque_posterior: quantidadeFisica
                };
            });

            return { sucesso: true, ...executar() };
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
    () => {

        return db.prepare(`
            SELECT
                movimentacoes_estoque.*,
                produtos.nome AS produto_nome,
                produtos.sku,
                produtos.codigo_barras
            FROM movimentacoes_estoque
            INNER JOIN produtos
                ON produtos.id = movimentacoes_estoque.produto_id
            ORDER BY movimentacoes_estoque.id DESC
        `).all();

    }
);


/*
    ==================================================
    ORDENS DE SERVIÇO
    ==================================================
*/


// Número sequencial apresentado nas telas; não substitui a chave interna do banco.
function proximoNumeroOS() {

    const resultado = db
        .prepare(`
            SELECT COALESCE(MAX(numero), 0) + 1 AS proximo_numero
            FROM ordens_servico
        `)
        .get();

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
    () => {

        return db.prepare(`
            SELECT
                ordens_servico.*,
                clientes.nome AS cliente_nome,
                clientes.cpf_cnpj AS cliente_cpf_cnpj
            FROM ordens_servico
            LEFT JOIN clientes
                ON clientes.id = ordens_servico.cliente_id
            ORDER BY ordens_servico.id DESC
        `).all();

    }
);


ipcMain.handle(
    'buscar-ordem-servico',
    (event, id) => {

        const os = db.prepare(`
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
        `).get(id);

        if (!os) {
            return null;
        }

        os.itens_os = db.prepare(`
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
        `).all(id);

        return os;

    }
);


ipcMain.handle(
    'cadastrar-ordem-servico',
    (event, os) => {

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
            const numero = proximoNumeroOS();

            const executar = db.transaction(() => {

                for (const item of itens) {

                    const produto = db.prepare(`
                        SELECT id, nome, estoque, preco_venda
                        FROM produtos
                        WHERE id = ?
                    `).get(item.produto_id);

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

                const resultado = db.prepare(`
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
                `).run({
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

                const osId = Number(resultado.lastInsertRowid);

                const inserirItem = db.prepare(`
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
                `);

                const buscarEstoqueAtual = db.prepare(`
                    SELECT estoque
                    FROM produtos
                    WHERE id = ?
                `);

                const baixarEstoque = db.prepare(`
                    UPDATE produtos
                    SET estoque = estoque - @quantidade
                    WHERE id = @produto_id
                `);

                const registrarMovimentacao = db.prepare(`
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
                `);

                for (const item of itens) {
                    inserirItem.run({
                        os_id: osId,
                        produto_id: item.produto_id,
                        descricao: item.descricao,
                        tipo: item.tipo,
                        quantidade: item.quantidade,
                        valor_unitario: item.valor_unitario,
                        subtotal: item.subtotal
                    });

                    const estoqueAnterior = Number(
                        buscarEstoqueAtual.get(item.produto_id)?.estoque || 0
                    );

                    baixarEstoque.run({
                        produto_id: item.produto_id,
                        quantidade: item.quantidade
                    });

                    const estoquePosterior = estoqueAnterior - Number(item.quantidade);

                    registrarMovimentacao.run({
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

            // Executa de fato a transação.
            // Antes, db.transaction(...) era criada, mas não era chamada.
            const resultadoExecucao = executar();

            // Busca novamente os dados gravados no banco para garantir
            // que o número exibido seja exatamente o número persistido.
            const osGravada = db.prepare(`
                SELECT id, numero
                FROM ordens_servico
                WHERE id = ?
            `).get(resultadoExecucao.id);

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
    (event, os) => {

        try {

            if (!os || !os.id) {
                return { sucesso: false, mensagem: 'OS inválida.' };
            }

            const itensNovos = normalizarItensOS(os.itens_pecas);

            const executar = db.transaction(() => {

                const atual = db.prepare(`
                    SELECT id, numero, valor_pecas
                    FROM ordens_servico
                    WHERE id = ?
                `).get(os.id);

                if (!atual) {
                    throw new Error('Ordem de serviço não encontrada.');
                }

                const itensAntigos = db.prepare(`
                    SELECT produto_id, quantidade
                    FROM itens_os
                    WHERE os_id = ?
                `).all(os.id);

                const buscarEstoqueAtual = db.prepare(`
                    SELECT id, nome, estoque, preco_venda
                    FROM produtos
                    WHERE id = ?
                `);

                const atualizarEstoque = db.prepare(`
                    UPDATE produtos
                    SET estoque = ?
                    WHERE id = ?
                `);

                const registrarMovimentacao = db.prepare(`
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
                `);

                // Devolve ao estoque as peças da versão anterior da OS.
                for (const item of itensAntigos) {

                    if (!item.produto_id) continue;

                    const produto = buscarEstoqueAtual.get(item.produto_id);

                    if (!produto) {
                        throw new Error(`Produto não encontrado: ${item.produto_id}`);
                    }

                    const quantidade = Number(item.quantidade) || 0;
                    const estoqueAnterior = Number(produto.estoque) || 0;
                    const estoquePosterior = estoqueAnterior + quantidade;

                    atualizarEstoque.run(
                        estoquePosterior,
                        Number(item.produto_id)
                    );

                    registrarMovimentacao.run({
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

                    const produto = buscarEstoqueAtual.get(item.produto_id);

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

                db.prepare(`
                    DELETE FROM itens_os
                    WHERE os_id = ?
                `).run(os.id);

                const valorPecasNovas = itensNovos.reduce(
                    (soma, item) => soma + item.subtotal,
                    0
                );

                const valorPecasLegado = itensAntigos.length === 0
                    ? Number(atual.valor_pecas) || 0
                    : 0;

                const valorPecas = valorPecasLegado + valorPecasNovas;

                const resultado = db.prepare(`
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
                `).run({
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

                const inserirItem = db.prepare(`
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
                `);

                const baixarEstoque = db.prepare(`
                    UPDATE produtos
                    SET estoque = estoque - @quantidade
                    WHERE id = @produto_id
                `);

                // Baixa os novos itens e registra cada saída.
                for (const item of itensNovos) {

                    inserirItem.run({
                        os_id: Number(os.id),
                        produto_id: item.produto_id,
                        descricao: item.descricao,
                        tipo: item.tipo,
                        quantidade: item.quantidade,
                        valor_unitario: item.valor_unitario,
                        subtotal: item.subtotal
                    });

                    const produto = buscarEstoqueAtual.get(item.produto_id);
                    const estoqueAnterior = Number(produto.estoque) || 0;

                    baixarEstoque.run({
                        produto_id: item.produto_id,
                        quantidade: item.quantidade
                    });

                    const estoquePosterior =
                        estoqueAnterior - Number(item.quantidade);

                    registrarMovimentacao.run({
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

            const resultadoExecucao = executar();

            return { sucesso: Boolean(resultadoExecucao) };

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
    (event, id) => {

        try {

            const osId = Number(id);

            if (!Number.isInteger(osId) || osId <= 0) {
                return {
                    sucesso: false,
                    mensagem: 'ID da ordem de serviço inválido.'
                };
            }

            const executar = db.transaction(() => {

                const osExistente = db.prepare(`
                    SELECT id, numero
                    FROM ordens_servico
                    WHERE id = ?
                `).get(osId);

                if (!osExistente) {
                    throw new Error('Ordem de serviço não encontrada.');
                }

                const itens = db.prepare(`
                    SELECT produto_id, quantidade
                    FROM itens_os
                    WHERE os_id = ?
                `).all(osId);

                const buscarEstoqueAtual = db.prepare(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `);

                const devolverEstoque = db.prepare(`
                    UPDATE produtos
                    SET estoque = estoque + @quantidade
                    WHERE id = @produto_id
                `);

                const registrarMovimentacao = db.prepare(`
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
                `);

                // Ao excluir a OS, devolve as peças ao estoque
                // e registra cada devolução no histórico.
                for (const item of itens) {

                    if (!item.produto_id) continue;

                    const produto = buscarEstoqueAtual.get(item.produto_id);

                    if (!produto) {
                        throw new Error(`Produto não encontrado: ${item.produto_id}`);
                    }

                    const quantidade = Number(item.quantidade) || 0;
                    const estoqueAnterior = Number(produto.estoque) || 0;
                    const estoquePosterior = estoqueAnterior + quantidade;

                    devolverEstoque.run({
                        produto_id: Number(item.produto_id),
                        quantidade
                    });

                    registrarMovimentacao.run({
                        produto_id: Number(item.produto_id),
                        quantidade,
                        estoque_anterior: estoqueAnterior,
                        estoque_posterior: estoquePosterior,
                        motivo: `Estorno da exclusão da OS nº ${String(osExistente.numero).padStart(6, '0')}`,
                        origem_id: Number(osExistente.id)
                    });
                }

                db.prepare(`
                    DELETE FROM garantias
                    WHERE os_id = ?
                `).run(osId);

                db.prepare(`
                    DELETE FROM itens_os
                    WHERE os_id = ?
                `).run(osId);

                const resultado = db.prepare(`
                    DELETE FROM ordens_servico
                    WHERE id = ?
                `).run(osId);

                if (resultado.changes !== 1) {
                    throw new Error('A ordem de serviço não foi excluída.');
                }

                return {
                    id: Number(osExistente.id),
                    numero: Number(osExistente.numero)
                };
            });

            const resultadoExecucao = executar();

            return {
                sucesso: true,
                os: {
                    id: Number(resultadoExecucao.id),
                    numero: Number(resultadoExecucao.numero)
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
    () => {
        // Sincroniza garantias originadas de vendas que já foram canceladas.
        db.prepare(`
            UPDATE garantias
            SET status = 'Cancelada'
            WHERE venda_id IN (
                SELECT id FROM vendas
                WHERE lower(COALESCE(status, '')) LIKE '%cancel%'
            )
              AND status <> 'Cancelada'
        `).run();

        db.prepare(`
            UPDATE garantias
            SET status = 'Expirada'
            WHERE status = 'Ativa'
              AND date(data_fim) < date('now', 'localtime')
        `).run();

        return db.prepare(`
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
        `).all();
    }
);

ipcMain.handle(
    'cadastrar-garantia',
    (event, garantia) => {
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
                return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())} ${pad(data.getHours())}:${pad(data.getMinutes())}:${pad(data.getSeconds())}`;
            };

            const dataInicio = formatarSQLite(inicio);
            const dataFim = formatarSQLite(fim);

            const executar = db.transaction(() => {
                const resultado = db.prepare(`
                    INSERT INTO garantias (
                        venda_id, os_id, cliente_id, produto_id,
                        descricao, prazo_dias, data_inicio, data_fim,
                        status, observacoes, cobertura, exclusoes
                    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'Ativa', ?, ?, ?)
                `).run(
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
                );

                const garantiaId = Number(resultado.lastInsertRowid);

                if (produtoIds.length) {
                    const produtoStmt = db.prepare(`SELECT id FROM produtos WHERE id = ?`);
                    const itemStmt = db.prepare(`
                        INSERT INTO garantia_itens (garantia_id, produto_id)
                        VALUES (?, ?)
                    `);

                    for (const produtoId of produtoIds) {
                        const produto = produtoStmt.get(produtoId);
                        if (!produto) {
                            throw new Error(`Produto não encontrado: ${produtoId}`);
                        }
                        itemStmt.run(garantiaId, produtoId);
                    }
                }

                return { id: garantiaId, quantidade: produtoIds.length };
            });

            const resultado = executar();

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
    (event, dados) => {
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

            const atual = db.prepare(`
                SELECT id, data_inicio
                FROM garantias
                WHERE id = ?
            `).get(garantiaId);
            if (!atual) return { sucesso: false, mensagem: 'Garantia não encontrada.' };

            const origem = vendaId
                ? db.prepare('SELECT id, cliente_id FROM vendas WHERE id = ?').get(vendaId)
                : db.prepare('SELECT id, cliente_id FROM ordens_servico WHERE id = ?').get(osId);
            if (!origem) return { sucesso: false, mensagem: 'Venda ou ordem de serviço não encontrada.' };
            if (Number(origem.cliente_id) !== clienteId) {
                return { sucesso: false, mensagem: 'A origem selecionada não pertence ao cliente escolhido.' };
            }

            const produtoIds = Array.isArray(dados?.produto_ids)
                ? [...new Set(dados.produto_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))]
                : [];
            const itensOrigem = vendaId
                ? db.prepare('SELECT DISTINCT produto_id FROM itens_venda WHERE venda_id = ?').all(vendaId)
                : db.prepare('SELECT DISTINCT produto_id FROM itens_os WHERE os_id = ? AND produto_id IS NOT NULL').all(osId);
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
            const formatarSQLite = data => `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())} ${pad(data.getHours())}:${pad(data.getMinutes())}:${pad(data.getSeconds())}`;
            const fimFormatado = formatarSQLite(dataFim);
            const agora = new Date();
            const hoje = `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}`;
            const status = fimFormatado.slice(0, 10) < hoje ? 'Expirada' : 'Ativa';

            const executar = db.transaction(() => {
                db.prepare(`
                    UPDATE garantias
                    SET venda_id = ?, os_id = ?, cliente_id = ?, produto_id = NULL,
                        descricao = ?, prazo_dias = ?, data_fim = ?, status = ?, observacoes = ?,
                        cobertura = ?, exclusoes = ?
                    WHERE id = ?
                `).run(
                    vendaId, osId, clienteId, descricao, prazoDias,
                    fimFormatado, status, observacoes, cobertura, exclusoes, garantiaId
                );

                db.prepare('DELETE FROM garantia_itens WHERE garantia_id = ?').run(garantiaId);
                const inserirProduto = db.prepare(`
                    INSERT INTO garantia_itens (garantia_id, produto_id)
                    VALUES (?, ?)
                `);
                for (const produtoId of produtoIds) inserirProduto.run(garantiaId, produtoId);

                return { id: garantiaId, quantidade: produtoIds.length, data_fim: fimFormatado, status };
            });

            return { sucesso: true, ...executar() };
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
function proximoNumeroVenda() {

    const resultado = db
        .prepare(`
            SELECT
                COALESCE(
                    MAX(numero),
                    0
                ) + 1 AS proximo_numero

            FROM vendas
        `)
        .get();


    return resultado.proximo_numero;

}


/*
    FINALIZAR VENDA
*/

ipcMain.handle(
    'finalizar-venda',
    (event, venda) => {

        try {

            /*
                ======================================
                VALIDAR ITENS
                ======================================
            */

            if (
                !venda ||
                !Array.isArray(venda.itens) ||
                venda.itens.length === 0
            ) {

                return {

                    sucesso: false,

                    mensagem:
                        'A venda precisa ter pelo menos um produto.'

                };

            }


            /*
                ======================================
                VALIDAR QUANTIDADES
                ======================================
            */

            for (const item of venda.itens) {

                const quantidade =
                    Number(item.quantidade);


                if (
                    !Number.isInteger(quantidade) ||
                    quantidade <= 0
                ) {

                    return {

                        sucesso: false,

                        mensagem:
                            'A quantidade dos produtos deve ser maior que zero.'

                    };

                }

            }


            /*
                ======================================
                TRANSAÇÃO
                ======================================
            */

            const executarVenda =
                db.transaction(() => {

                    let subtotal = 0;

                    const itensProcessados = [];


                    /*
                        ==============================
                        BUSCAR PRODUTOS
                        ==============================
                    */

                    for (const item of venda.itens) {

                        const produto =
                            db
                                .prepare(`
                                    SELECT *

                                    FROM produtos

                                    WHERE id = ?
                                `)
                                .get(item.produto_id);


                        if (!produto) {

                            throw new Error(
                                `Produto não encontrado: ${item.produto_id}`
                            );

                        }


                        const quantidade =
                            Number(item.quantidade);


                        /*
                            ==========================
                            VERIFICAR ESTOQUE
                            ==========================
                        */

                        if (
                            produto.estoque <
                            quantidade
                        ) {

                            throw new Error(
                                `Estoque insuficiente para o produto "${produto.nome}". Estoque disponível: ${produto.estoque}.`
                            );

                        }


                        /*
                            ==========================
                            USAR PREÇO ATUAL
                            ==========================
                        */

                        const precoUnitario =
                            Number(
                                produto.preco_venda
                            ) || 0;


                        const subtotalItem =
                            precoUnitario *
                            quantidade;


                        subtotal +=
                            subtotalItem;


                        itensProcessados.push({

                            produto_id:
                                produto.id,

                            quantidade:
                                quantidade,

                            preco_unitario:
                                precoUnitario,

                            subtotal:
                                subtotalItem

                        });

                    }


                    /*
                        ==============================
                        DESCONTO
                        ==============================
                    */

                    let desconto =
                        Number(venda.desconto) || 0;


                    if (desconto < 0) {

                        desconto = 0;

                    }


                    if (desconto > subtotal) {

                        desconto = subtotal;

                    }


                    const total =
                        subtotal - desconto;


                    /*
                        ==============================
                        NÚMERO DA VENDA
                        ==============================
                    */

                    const numero =
                        proximoNumeroVenda();


                    /*
                        ==============================
                        GRAVAR VENDA
                        ==============================
                    */

                    const resultadoVenda =
                        db
                            .prepare(`

                                INSERT INTO vendas (

                                    numero,

                                    cliente_id,

                                    subtotal,

                                    desconto,

                                    total,

                                    forma_pagamento,

                                    observacoes

                                )

                                VALUES (

                                    @numero,

                                    @cliente_id,

                                    @subtotal,

                                    @desconto,

                                    @total,

                                    @forma_pagamento,

                                    @observacoes

                                )

                            `)
                            .run({

                                numero:

                                    numero,

                                cliente_id:

                                    venda.cliente_id ||
                                    null,

                                subtotal:

                                    subtotal,

                                desconto:

                                    desconto,

                                total:

                                    total,

                                forma_pagamento:

                                    venda.forma_pagamento ||
                                    null,

                                observacoes:

                                    venda.observacoes ||
                                    null

                            });


                    const vendaId =
                        resultadoVenda.lastInsertRowid;


                    /*
                        ==============================
                        GRAVAR ITENS
                        ==============================
                    */

                    const inserirItem =
                        db.prepare(`

                            INSERT INTO itens_venda (

                                venda_id,

                                produto_id,

                                quantidade,

                                preco_unitario,

                                subtotal

                            )

                            VALUES (

                                @venda_id,

                                @produto_id,

                                @quantidade,

                                @preco_unitario,

                                @subtotal

                            )

                        `);


                    /*
                        ==============================
                        BAIXAR ESTOQUE
                        ==============================
                    */

                    const buscarEstoqueAtual =
                        db.prepare(`
                            SELECT estoque
                            FROM produtos
                            WHERE id = ?
                        `);


                    const baixarEstoque =
                        db.prepare(`

                            UPDATE produtos

                            SET estoque =
                                estoque - ?

                            WHERE id = ?

                        `);


                    const registrarMovimentacao =
                        db.prepare(`
                            INSERT INTO movimentacoes_estoque (
                                produto_id,
                                tipo,
                                quantidade,
                                estoque_anterior,
                                estoque_posterior,
                                motivo,
                                origem,
                                origem_id
                            )
                            VALUES (
                                @produto_id,
                                'saida',
                                @quantidade,
                                @estoque_anterior,
                                @estoque_posterior,
                                @motivo,
                                'venda',
                                @origem_id
                            )
                        `);


                    for (
                        const item
                        of itensProcessados
                    ) {

                        inserirItem.run({

                            venda_id:
                                vendaId,

                            produto_id:
                                item.produto_id,

                            quantidade:
                                item.quantidade,

                            preco_unitario:
                                item.preco_unitario,

                            subtotal:
                                item.subtotal

                        });


                        const estoqueAntes =
                            buscarEstoqueAtual
                                .get(item.produto_id);

                        const estoqueAnterior =
                            Number(estoqueAntes?.estoque || 0);

                        baixarEstoque.run(

                            item.quantidade,

                            item.produto_id

                        );

                        const estoquePosterior =
                            estoqueAnterior - item.quantidade;

                        registrarMovimentacao.run({
                            produto_id: item.produto_id,
                            quantidade: item.quantidade,
                            estoque_anterior: estoqueAnterior,
                            estoque_posterior: estoquePosterior,
                            motivo: `Venda nº ${String(numero).padStart(6, '0')}`,
                            origem_id: Number(vendaId)
                        });

                    }


                    /*
                        ==============================
                        RETORNAR RESULTADO
                        ==============================
                    */

                    return {

                        venda_id:
                            Number(vendaId),

                        numero:
                            numero,

                        subtotal:
                            subtotal,

                        desconto:
                            desconto,

                        total:
                            total

                    };

                });


            const resultado =
                executarVenda();


            return {

                sucesso: true,

                venda:
                    resultado

            };

        }

        catch (erro) {

            console.error(
                'Erro ao finalizar venda:',
                erro
            );


            return {

                sucesso: false,

                mensagem:
                    erro.message ||
                    'Não foi possível finalizar a venda.'

            };

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
    () => {

        const vendas = db
            .prepare(`

                SELECT

                    vendas.*,

                    clientes.nome AS cliente_nome

                FROM vendas

                LEFT JOIN clientes

                    ON clientes.id =
                       vendas.cliente_id

                ORDER BY
                    vendas.id DESC

            `)
            .all();


        return vendas;

    }
);


/*
    ==================================================
    BUSCAR VENDA
    ==================================================
*/

ipcMain.handle(
    'buscar-venda',
    (event, id) => {

        const venda =
            db
                .prepare(`

                    SELECT

                        vendas.*,

                        clientes.nome AS cliente_nome,

                        clientes.cpf_cnpj,

                        clientes.telefone,

                        clientes.celular,

                        clientes.email

                    FROM vendas

                    LEFT JOIN clientes

                        ON clientes.id =
                           vendas.cliente_id

                    WHERE vendas.id = ?

                `)
                .get(id);


        if (!venda) {

            return null;

        }


        const itens =
            db
                .prepare(`

                    SELECT

                        itens_venda.*,

                        produtos.nome AS produto_nome,

                        produtos.sku,

                        produtos.codigo_barras

                    FROM itens_venda

                    INNER JOIN produtos

                        ON produtos.id =
                           itens_venda.produto_id

                    WHERE itens_venda.venda_id = ?

                    ORDER BY itens_venda.id

                `)
                .all(id);


        return {

            ...venda,

            itens:
                itens

        };

    }
);





/*
    ==================================================
    CANCELAR VENDA — PRESERVA HISTÓRICO E DEVOLVE ESTOQUE
    ==================================================
*/

ipcMain.handle('cancelar-venda', (event, dados) => {
    try {
        const vendaId = Number(typeof dados === 'object' ? dados?.id : dados);
        const motivo = String(typeof dados === 'object' ? dados?.motivo || '' : '').trim();
        if (!Number.isInteger(vendaId) || vendaId <= 0) return { sucesso: false, mensagem: 'Venda inválida.' };
        if (motivo.length < 3) return { sucesso: false, mensagem: 'Informe o motivo do cancelamento.' };
        if (motivo.length > 500) return { sucesso: false, mensagem: 'O motivo deve ter até 500 caracteres.' };

        const executar = db.transaction(() => {
            const venda = db.prepare('SELECT id, numero, status FROM vendas WHERE id = ?').get(vendaId);
            if (!venda) throw new Error('Venda não encontrada.');
            if (String(venda.status || '').toLowerCase().includes('cancel')) throw new Error('Esta venda já foi cancelada.');

            const itens = db.prepare('SELECT produto_id, quantidade FROM itens_venda WHERE venda_id = ? ORDER BY id').all(vendaId);
            const buscarProduto = db.prepare('SELECT id, nome, estoque FROM produtos WHERE id = ?');
            const devolverEstoque = db.prepare('UPDATE produtos SET estoque = estoque + ? WHERE id = ?');
            const registrarEstorno = db.prepare(`
                INSERT INTO movimentacoes_estoque (produto_id,tipo,quantidade,estoque_anterior,estoque_posterior,motivo,origem,origem_id)
                VALUES (?,'entrada',?,?,?,?, 'cancelamento_venda',?)
            `);

            for (const item of itens) {
                const produto = buscarProduto.get(item.produto_id);
                if (!produto) throw new Error(`O produto ID ${item.produto_id} não foi encontrado. A venda não foi cancelada.`);
                const quantidade = Number(item.quantidade) || 0;
                const anterior = Number(produto.estoque) || 0;
                const posterior = anterior + quantidade;
                devolverEstoque.run(quantidade, item.produto_id);
                registrarEstorno.run(item.produto_id, quantidade, anterior, posterior,
                    `Estorno da venda nº ${String(venda.numero).padStart(6, '0')} — ${motivo}`, vendaId);
            }

            db.prepare(`UPDATE vendas SET status = 'Cancelada', cancelada_em = CURRENT_TIMESTAMP, cancelamento_motivo = ? WHERE id = ?`).run(motivo, vendaId);
            db.prepare(`
                UPDATE garantias
                SET status = 'Cancelada'
                WHERE venda_id = ? AND status <> 'Cancelada'
            `).run(vendaId);
            return { venda_id: vendaId, numero: Number(venda.numero), itens_devolvidos: itens.length };
        });

        return { sucesso: true, venda: executar() };
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
    (event, idInformado) => {
        try {
            const vendaId = Number(
                typeof idInformado === 'object' ? idInformado?.id : idInformado
            );

            if (!Number.isInteger(vendaId) || vendaId <= 0) {
                return { sucesso: false, mensagem: 'Venda inválida.' };
            }

            const executar = db.transaction(() => {
                const venda = db.prepare(`
                    SELECT id, numero, subtotal, desconto, total
                    FROM vendas
                    WHERE id = ?
                `).get(vendaId);

                if (!venda) {
                    throw new Error('Venda não encontrada.');
                }

                const itens = db.prepare(`
                    SELECT produto_id, quantidade
                    FROM itens_venda
                    WHERE venda_id = ?
                    ORDER BY id
                `).all(vendaId);

                const buscarProduto = db.prepare(`
                    SELECT id, nome, estoque
                    FROM produtos
                    WHERE id = ?
                `);

                const devolverEstoque = db.prepare(`
                    UPDATE produtos
                    SET estoque = estoque + ?
                    WHERE id = ?
                `);

                const registrarEstorno = db.prepare(`
                    INSERT INTO movimentacoes_estoque (
                        produto_id,
                        tipo,
                        quantidade,
                        estoque_anterior,
                        estoque_posterior,
                        motivo,
                        origem,
                        origem_id
                    ) VALUES (?, 'entrada', ?, ?, ?, ?, 'estorno_venda', ?)
                `);

                for (const item of itens) {
                    const produto = buscarProduto.get(item.produto_id);
                    if (!produto) {
                        throw new Error(`O produto ID ${item.produto_id} não foi encontrado. A venda não foi excluída.`);
                    }

                    const quantidade = Number(item.quantidade) || 0;
                    const estoqueAnterior = Number(produto.estoque) || 0;
                    const estoquePosterior = estoqueAnterior + quantidade;

                    devolverEstoque.run(quantidade, item.produto_id);

                    registrarEstorno.run(
                        item.produto_id,
                        quantidade,
                        estoqueAnterior,
                        estoquePosterior,
                        `Estorno da venda nº ${String(venda.numero).padStart(6, '0')} — venda excluída`,
                        vendaId
                    );
                }

                // Remove as movimentações originais da venda para que ela deixe
                // de aparecer como uma venda válida no histórico de estoque.
                db.prepare(`
                    DELETE FROM movimentacoes_estoque
                    WHERE origem = 'venda' AND origem_id = ?
                `).run(vendaId);

                // itens_venda possui ON DELETE CASCADE.
                db.prepare(`DELETE FROM vendas WHERE id = ?`).run(vendaId);

                return {
                    venda_id: vendaId,
                    numero: Number(venda.numero),
                    itens_devolvidos: itens.length
                };
            });

            const resultado = executar();
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

ipcMain.handle('listar-usuarios', () => {
    const usuarios = db.prepare(`
        SELECT id, nome, usuario, perfil, ativo, primeiro_acesso, criado_em, atualizado_em
        FROM usuarios
        ORDER BY id ASC
    `).all();

    return usuarios.map(usuario => ({
        ...usuario,
        ativo: Number(usuario.ativo) === 1,
        primeiro_acesso: Number(usuario.primeiro_acesso) === 1,
        permissoes: buscarPermissoesUsuario(usuario.id, usuario.perfil)
    }));
});

ipcMain.handle('cadastrar-usuario', (event, dados) => {
    try {
        const nome = String(dados?.nome || '').trim();
        const usuario = String(dados?.usuario || '').trim();
        const senha = String(dados?.senha || '');
        const perfil = dados?.perfil === 'administrador' ? 'administrador' : 'funcionario';

        if (!nome || !usuario || !senha) return { sucesso: false, mensagem: 'Preencha nome, usuário e senha.' };
        if (senha.length < 6) return { sucesso: false, mensagem: 'A senha deve possuir pelo menos 6 caracteres.' };
        if (!/^[a-zA-Z0-9._-]+$/.test(usuario)) return { sucesso: false, mensagem: 'O usuário deve conter apenas letras, números, ponto, hífen ou sublinhado.' };
        if (db.prepare(`SELECT id FROM usuarios WHERE lower(usuario) = lower(?)`).get(usuario)) return { sucesso: false, mensagem: 'Este nome de usuário já está em uso.' };

        const senhaGerada = gerarSenha(senha);
        const resultado = db.prepare(`
            INSERT INTO usuarios (nome, usuario, senha_hash, senha_salt, perfil, ativo, primeiro_acesso)
            VALUES (?, ?, ?, ?, ?, 1, 1)
        `).run(nome, usuario, senhaGerada.hash, senhaGerada.salt, perfil);

        garantirPermissoesUsuario(Number(resultado.lastInsertRowid), perfil);
        return { sucesso: true, id: Number(resultado.lastInsertRowid) };
    } catch (erro) {
        console.error('Erro ao cadastrar usuário:', erro);
        return { sucesso: false, mensagem: erro.message || 'Não foi possível cadastrar o usuário.' };
    }
});

ipcMain.handle('editar-usuario', (event, dados) => {
    try {
        const id = Number(dados?.id);
        const nome = String(dados?.nome || '').trim();
        const usuario = String(dados?.usuario || '').trim();
        const perfil = dados?.perfil === 'administrador' ? 'administrador' : 'funcionario';
        const sessao = sessoesGestor.get(event.sender.id);

        if (!id || !nome || !usuario) return { sucesso: false, mensagem: 'Preencha os dados obrigatórios.' };
        if (sessao && Number(sessao.id) === id && perfil !== 'administrador') return { sucesso: false, mensagem: 'O administrador não pode remover o próprio perfil administrativo.' };
        const existente = db.prepare(`SELECT * FROM usuarios WHERE id = ?`).get(id);
        if (!existente) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
        const duplicado = db.prepare(`SELECT id FROM usuarios WHERE lower(usuario) = lower(?) AND id <> ?`).get(usuario, id);
        if (duplicado) return { sucesso: false, mensagem: 'Este nome de usuário já está em uso.' };

        if (existente.perfil === 'administrador' && perfil !== 'administrador') {
            const totalAdmins = db.prepare(`SELECT COUNT(*) AS total FROM usuarios WHERE perfil = 'administrador' AND ativo = 1`).get();
            if (Number(totalAdmins.total) <= 1) return { sucesso: false, mensagem: 'O sistema precisa manter pelo menos um administrador ativo.' };
        }

        db.prepare(`UPDATE usuarios SET nome = ?, usuario = ?, perfil = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(nome, usuario, perfil, id);
        garantirPermissoesUsuario(id, perfil);
        return { sucesso: true };
    } catch (erro) {
        console.error('Erro ao editar usuário:', erro);
        return { sucesso: false, mensagem: erro.message || 'Não foi possível editar o usuário.' };
    }
});

ipcMain.handle('alterar-senha-usuario', (event, dados) => {
    try {
        const id = Number(dados?.id);
        const senha = String(dados?.senha || '');
        if (!id || senha.length < 6) return { sucesso: false, mensagem: 'A senha deve possuir pelo menos 6 caracteres.' };
        const novo = gerarSenha(senha);
        const resultado = db.prepare(`UPDATE usuarios SET senha_hash = ?, senha_salt = ?, primeiro_acesso = 0, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(novo.hash, novo.salt, id);
        return { sucesso: resultado.changes === 1 };
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message || 'Não foi possível alterar a senha.' };
    }
});

ipcMain.handle('alternar-status-usuario', (event, idInformado) => {
    try {
        const id = Number(idInformado);
        const sessao = sessoesGestor.get(event.sender.id);
        if (!id) return { sucesso: false, mensagem: 'Usuário inválido.' };
        if (sessao && Number(sessao.id) === id) return { sucesso: false, mensagem: 'Você não pode desativar o próprio usuário.' };
        const usuario = db.prepare(`SELECT id, perfil, ativo FROM usuarios WHERE id = ?`).get(id);
        if (!usuario) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
        if (Number(usuario.ativo) === 1 && usuario.perfil === 'administrador') {
            const totalAdmins = db.prepare(`SELECT COUNT(*) AS total FROM usuarios WHERE perfil = 'administrador' AND ativo = 1`).get();
            if (Number(totalAdmins.total) <= 1) return { sucesso: false, mensagem: 'Não é possível desativar o último administrador ativo.' };
        }
        const novoStatus = Number(usuario.ativo) === 1 ? 0 : 1;
        db.prepare(`UPDATE usuarios SET ativo = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(novoStatus, id);
        return { sucesso: true, ativo: novoStatus === 1 };
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message || 'Não foi possível alterar o status.' };
    }
});

ipcMain.handle('buscar-permissoes-usuario', (event, idInformado) => {
    const id = Number(idInformado);
    const usuario = db.prepare(`SELECT id, perfil FROM usuarios WHERE id = ?`).get(id);
    if (!usuario) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
    return { sucesso: true, perfil: usuario.perfil, permissoes: buscarPermissoesUsuario(usuario.id, usuario.perfil) };
});

ipcMain.handle('salvar-permissoes-usuario', (event, dados) => {
    try {
        const usuarioId = Number(dados?.usuario_id);
        const usuario = db.prepare(`SELECT id, perfil FROM usuarios WHERE id = ?`).get(usuarioId);
        if (!usuario) return { sucesso: false, mensagem: 'Usuário não encontrado.' };
        if (usuario.perfil === 'administrador') return { sucesso: false, mensagem: 'Administradores possuem acesso total.' };
        const permissoes = Array.isArray(dados?.permissoes) ? dados.permissoes : [];

        const salvar = db.transaction(() => {
            for (const modulo of MODULOS_PERMISSAO) {
                const item = permissoes.find(p => p.modulo === modulo) || {};
                db.prepare(`
                    INSERT INTO permissoes_usuarios (usuario_id, modulo, consultar, criar, editar, excluir)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(usuario_id, modulo) DO UPDATE SET
                        consultar = excluded.consultar,
                        criar = excluded.criar,
                        editar = excluded.editar,
                        excluir = excluded.excluir,
                        atualizado_em = CURRENT_TIMESTAMP
                `).run(
                    usuarioId,
                    modulo,
                    item.consultar ? 1 : 0,
                    item.criar ? 1 : 0,
                    item.editar ? 1 : 0,
                    item.excluir ? 1 : 0
                );
            }
        });
        salvar();
        return { sucesso: true };
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message || 'Não foi possível salvar as permissões.' };
    }
});

ipcMain.handle('listar-auditoria', (event, filtros = {}) => {
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

    const registros = db.prepare(sql).all(...params);

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
                const item = db.prepare(`
                    SELECT v.id, v.numero, v.total, v.forma_pagamento,
                           c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj
                    FROM vendas v
                    LEFT JOIN clientes c ON c.id = v.cliente_id
                    WHERE v.id = ?
                `).get(idEntidade);
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
                const item = db.prepare(`
                    SELECT o.id, o.numero, o.status, o.total, o.tipo_equipamento, o.marca, o.modelo,
                           c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj
                    FROM ordens_servico o
                    LEFT JOIN clientes c ON c.id = o.cliente_id
                    WHERE o.id = ?
                `).get(idEntidade);
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
                const item = db.prepare(`SELECT id, nome, sku, codigo_barras, estoque FROM produtos WHERE id = ?`).get(idEntidade);
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
                const item = db.prepare(`SELECT id, nome, cpf_cnpj, celular, email FROM clientes WHERE id = ?`).get(idEntidade);
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
                const item = db.prepare(`SELECT id, nome, usuario, perfil, ativo FROM usuarios WHERE id = ?`).get(idEntidade);
                if (item) {
                    registro.origem_nome = item.nome || null;
                    registro.origem_documento = item.usuario || null;
                    registro.origem_descricao = `Usuário: ${item.nome} (${item.usuario})`;
                    registro.origem_detalhes = `Perfil: ${item.perfil === 'administrador' ? 'Administrador' : 'Funcionário'} • Status: ${Number(item.ativo) === 1 ? 'Ativo' : 'Inativo'}`;
                }
            } else if (idEntidade && tipo === 'garantia') {
                const item = db.prepare(`
                    SELECT g.id, g.venda_id, g.os_id, g.status, c.nome AS cliente_nome
                    FROM garantias g LEFT JOIN clientes c ON c.id = g.cliente_id
                    WHERE g.id = ?
                `).get(idEntidade);
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

ipcMain.handle('registrar-logout', (event) => {
    const sessao = sessoesGestor.get(event.sender.id);
    if (!sessao) return { sucesso: true };
    registrarAuditoria(sessao, { acao:'logout', modulo:'seguranca', descricao:'Saiu do sistema.' });
    sessoesGestor.delete(event.sender.id);
    return { sucesso:true };
});

/*
    ==================================================
    INICIAR APLICAÇÃO
    ==================================================
*/

app.whenReady().then(() => {

    criarJanela();


    app.on(
        'activate',
        () => {

            if (
                BrowserWindow.getAllWindows().length === 0
            ) {

                criarJanela();

            }

        }
    );

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

