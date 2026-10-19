const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const NOME_ARQUIVO = 'firebird-config.json';

function caminhoConfiguracao(pastaDados) {
    return path.join(pastaDados, NOME_ARQUIVO);
}

function lerConfiguracao(pastaDados, armazenamentoSeguro, opcoes = {}) {
    const arquivo = caminhoConfiguracao(pastaDados);
    const pastasPrioritarias = Array.isArray(opcoes.pastasProtegidasPrioritarias)
        ? opcoes.pastasProtegidasPrioritarias
        : [];
    const configuracaoProtegidaPrioritaria = pastasPrioritarias
        .map(pasta => path.join(pasta, 'firebird-config.dpapi'))
        .find(caminho => fs.existsSync(caminho));

    const protegido = configuracaoProtegidaPrioritaria || path.join(pastaDados, 'firebird-config.dpapi');
    if (configuracaoProtegidaPrioritaria || !fs.existsSync(arquivo)) {
        if (!fs.existsSync(protegido)) return null;

        let helper = path.join(process.resourcesPath || '', 'firebird', 'ler-configuracao.ps1');
        if (!fs.existsSync(helper)) helper = path.join(__dirname, '..', '..', 'tools', 'ler-configuracao-firebird.ps1');
        let recuperada;
        try {
            const json = execFileSync('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', helper, '-Arquivo', protegido
            ], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
            recuperada = JSON.parse(json);
        } catch (_) {
            throw new Error('Não foi possível desbloquear a configuração inicial do Firebird neste usuário do Windows.');
        }
        salvarConfiguracao(pastaDados, armazenamentoSeguro, recuperada);
        return recuperada;
    }

    const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (salvo.versao !== 1 || !salvo.senhaProtegida) {
        throw new Error('A configuração local do Firebird não está completa. Configure a conexão novamente.');
    }

    let password;
    let backupPassword = '';
    try {
        password = armazenamentoSeguro.decryptString(Buffer.from(salvo.senhaProtegida, 'base64'));
        if (salvo.backupSenhaProtegida) {
            backupPassword = armazenamentoSeguro.decryptString(Buffer.from(salvo.backupSenhaProtegida, 'base64'));
        }
    } catch (_) {
        throw new Error('Não foi possível desbloquear a senha salva do Firebird neste computador. Reconfigure a conexão.');
    }

    return {
        host: String(salvo.host || ''),
        port: Number(salvo.port || 3050),
        database: String(salvo.database || ''),
        user: String(salvo.user || ''),
        password,
        backupUser: String(salvo.backupUser || ''),
        backupPassword,
        papel: salvo.papel === 'servidor' ? 'servidor' : 'cliente',
        serverId: String(salvo.serverId || ''),
        anunciar: salvo.anunciar === true
    };
}

function lerConfiguracaoAnuncio(pastaDados) {
    const arquivo = caminhoConfiguracao(pastaDados);
    if (!fs.existsSync(arquivo)) return null;
    const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (salvo.versao !== 1 || salvo.papel !== 'servidor') return null;
    return {
        id: String(salvo.serverId || ''),
        alias: String(salvo.database || ''),
        portaFirebird: Number(salvo.port || 3050)
    };
}

function salvarConfiguracao(pastaDados, armazenamentoSeguro, config) {
    if (!armazenamentoSeguro.isEncryptionAvailable()) {
        throw new Error('O Windows não disponibilizou proteção local para salvar a senha do Firebird.');
    }

    const texto = String(config?.password || '');
    if (!texto) throw new Error('Informe a senha do usuário do banco.');

    const criptografada = armazenamentoSeguro.encryptString(texto).toString('base64');
    const backupUser = String(config?.backupUser || '').trim();
    const backupPassword = String(config?.backupPassword || '');
    const backupSenhaProtegida = backupPassword
        ? armazenamentoSeguro.encryptString(backupPassword).toString('base64')
        : '';
    const destino = caminhoConfiguracao(pastaDados);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const temporario = `${destino}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify({
        versao: 1,
        host: String(config.host || '').trim(),
        port: Number(config.port || 3050),
        database: String(config.database || '').trim(),
        user: String(config.user || '').trim(),
        papel: config.papel === 'servidor' ? 'servidor' : 'cliente',
        serverId: String(config.serverId || crypto.randomUUID()),
        anunciar: config.anunciar === true,
        senhaProtegida: criptografada,
        backupUser,
        backupSenhaProtegida
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporario, destino);
}

module.exports = { caminhoConfiguracao, lerConfiguracao, lerConfiguracaoAnuncio, salvarConfiguracao };
