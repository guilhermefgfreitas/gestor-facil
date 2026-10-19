const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Firebird = require('node-firebird');

function criarGerenciador(config) {
    const user = String(config.backupUser || '').trim();
    const password = String(config.backupPassword || '');
    if (!user || !password) {
        throw new Error('A conta protegida de backup Firebird não está configurada. Reinstale/repare o serviço Firebird do Gestor Fácil no servidor.');
    }
    return Firebird.attachAsync({
        host: config.host,
        port: Number(config.port || 3050),
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
            fluxo.on('data', () => {});
            fluxo.once('error', reject);
            fluxo.once('end', resolve);
        });
    });
}

function caminhoBancoTemporario(caminhoBackup) {
    return path.join(path.dirname(caminhoBackup), `.gf-validacao-${crypto.randomUUID()}.fdb`);
}

async function restaurarParaValidacao(servico, caminhoBackup) {
    const temporario = caminhoBancoTemporario(caminhoBackup);
    try {
        await executarOperacao(servico, 'restore', {
            database: temporario,
            files: [caminhoBackup],
            create: true,
            verbose: true
        });
        const info = await fs.promises.stat(temporario);
        if (!info.isFile() || info.size < 4096) throw new Error('A validação não produziu uma base Firebird utilizável.');
    } finally {
        try { await fs.promises.rm(temporario, { force: true }); } catch (_) {}
    }
}

async function criarBackupFirebird(config, destino, { validar = true } = {}) {
    const servico = await criarGerenciador(config);
    try {
        await fs.promises.mkdir(path.dirname(destino), { recursive: true });
        await executarOperacao(servico, 'backup', {
            database: config.database,
            files: [{ filename: destino, sizefile: '0' }],
            verbose: true
        });
        const info = await fs.promises.stat(destino);
        if (!info.isFile() || info.size < 1024) throw new Error('O Firebird terminou sem criar um arquivo de backup válido.');
        if (validar) await restaurarParaValidacao(servico, destino);
        return { caminho: destino, bytes: info.size };
    } catch (erro) {
        // Cópias cujo processo falhou ou que não passaram na restauração não
        // podem permanecer com aparência de backup válido.
        try { await fs.promises.rm(destino, { force: true }); } catch (_) {}
        throw erro;
    } finally {
        await servico.detachAsync();
    }
}

async function validarBackupFirebird(config, caminhoBackup) {
    const info = await fs.promises.stat(caminhoBackup);
    if (!info.isFile() || info.size < 1024) throw new Error('O arquivo selecionado está vazio ou incompleto.');
    const servico = await criarGerenciador(config);
    try { await restaurarParaValidacao(servico, caminhoBackup); }
    finally { await servico.detachAsync(); }
    return true;
}

async function restaurarBackupFirebird(config, caminhoBackup, { substituir = false } = {}) {
    const servico = await criarGerenciador(config);
    try {
        await restaurarParaValidacao(servico, caminhoBackup);
        await executarOperacao(servico, 'restore', {
            database: config.database,
            files: [caminhoBackup],
            replace: substituir,
            create: !substituir,
            verbose: true
        });
    } finally {
        await servico.detachAsync();
    }
}

module.exports = { criarBackupFirebird, validarBackupFirebird, restaurarBackupFirebird };
