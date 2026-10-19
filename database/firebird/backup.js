const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Firebird = require('node-firebird');

function pastaServicoBackup() {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'GestorFacil', 'Backups');
}

function nomeTemporarioServico(extensao) {
    return path.join(pastaServicoBackup(), `.gf-${crypto.randomUUID()}.${extensao}`);
}

function criarGerenciador(config) {
    const host = String(config?.host || '').trim();
    const database = String(config?.database || '').trim();
    const user = String(config.backupUser || '').trim();
    const password = String(config.backupPassword || '');
    if (!host || !database) {
        throw new Error('O servidor e o alias do banco Firebird não estão configurados para o backup.');
    }
    if (!user || !password) {
        throw new Error('A conta protegida de backup Firebird não está configurada. Reinstale/repare o serviço Firebird do Gestor Fácil no servidor.');
    }
    return Firebird.attachAsync({
        host,
        port: Number(config.port || 3050),
        // node-firebird precisa do banco de destino no handshake mesmo para
        // depois abrir a conexão ao Services Manager (manager: true).
        database,
        user,
        password,
        role: 'RDB$ADMIN',
        manager: true,
        encoding: 'UTF8',
        wireCrypt: Firebird.WIRE_CRYPT_ENABLE,
        connectTimeout: 12000
    });
}

function executarOperacao(servico, metodo, opcoes) {
    return new Promise((resolve, reject) => {
        servico[metodo](opcoes, (erro, fluxo) => {
            if (erro) return reject(erro);
            if (!fluxo || typeof fluxo.on !== 'function') return reject(new Error('O serviço Firebird não retornou o resultado da operação.'));
            const mensagens = [];
            fluxo.on('data', linha => mensagens.push(Buffer.isBuffer(linha) ? linha.toString('utf8') : String(linha)));
            fluxo.once('error', reject);
            fluxo.once('end', () => resolve(mensagens.join('\n').trim()));
        });
    });
}

function caminhoBancoTemporario() {
    return nomeTemporarioServico('fdb');
}

async function restaurarParaValidacao(servico, caminhoBackup) {
    const temporario = caminhoBancoTemporario();
    try {
        const saida = await executarOperacao(servico, 'restore', {
            database: temporario,
            files: [caminhoBackup],
            create: true,
            verbose: true
        });
        let info;
        try { info = await fs.promises.stat(temporario); }
        catch (_) {
            throw new Error(`O Firebird não criou a base temporária de validação.${saida ? ` Detalhes: ${saida}` : ''}`);
        }
        if (!info.isFile() || info.size < 4096) throw new Error('A validação não produziu uma base Firebird utilizável.');
    } finally {
        try { await fs.promises.rm(temporario, { force: true }); } catch (_) {}
    }
}

async function criarBackupFirebird(config, destino, { validar = true } = {}) {
    const arquivoTemporario = nomeTemporarioServico('fbk');
    const arquivoDestinoTemporario = `${destino}.${crypto.randomUUID()}.tmp`;
    const servico = await criarGerenciador(config);
    try {
        await fs.promises.mkdir(pastaServicoBackup(), { recursive: true });
        await executarOperacao(servico, 'backup', {
            database: config.database,
            files: [{ filename: arquivoTemporario, sizefile: '0' }],
            verbose: true
        });
        const info = await fs.promises.stat(arquivoTemporario);
        if (!info.isFile() || info.size < 1024) throw new Error('O Firebird terminou sem criar um arquivo de backup válido.');
        if (validar) await restaurarParaValidacao(servico, arquivoTemporario);
        await fs.promises.mkdir(path.dirname(destino), { recursive: true });
        await fs.promises.copyFile(arquivoTemporario, arquivoDestinoTemporario);
        await fs.promises.rename(arquivoDestinoTemporario, destino);
        return { caminho: destino, bytes: info.size };
    } finally {
        try { await servico.detachAsync(); }
        finally {
            try { await fs.promises.rm(arquivoTemporario, { force: true }); } catch (_) {}
            try { await fs.promises.rm(arquivoDestinoTemporario, { force: true }); } catch (_) {}
        }
    }
}

async function validarBackupFirebird(config, caminhoBackup) {
    const info = await fs.promises.stat(caminhoBackup);
    if (!info.isFile() || info.size < 1024) throw new Error('O arquivo selecionado está vazio ou incompleto.');
    await fs.promises.mkdir(pastaServicoBackup(), { recursive: true });
    const arquivoTemporario = nomeTemporarioServico('fbk');
    const servico = await criarGerenciador(config);
    try {
        await fs.promises.copyFile(caminhoBackup, arquivoTemporario);
        await restaurarParaValidacao(servico, arquivoTemporario);
    } finally {
        try { await servico.detachAsync(); }
        finally { try { await fs.promises.rm(arquivoTemporario, { force: true }); } catch (_) {} }
    }
    return true;
}

async function restaurarBackupFirebird(config, caminhoBackup, { substituir = false } = {}) {
    await fs.promises.mkdir(pastaServicoBackup(), { recursive: true });
    const arquivoTemporario = nomeTemporarioServico('fbk');
    const servico = await criarGerenciador(config);
    try {
        await fs.promises.copyFile(caminhoBackup, arquivoTemporario);
        await restaurarParaValidacao(servico, arquivoTemporario);
        await executarOperacao(servico, 'restore', {
            database: config.database,
            files: [arquivoTemporario],
            replace: substituir,
            create: !substituir,
            verbose: true
        });
    } finally {
        try { await servico.detachAsync(); }
        finally { try { await fs.promises.rm(arquivoTemporario, { force: true }); } catch (_) {} }
    }
}

module.exports = { criarBackupFirebird, validarBackupFirebird, restaurarBackupFirebird };
