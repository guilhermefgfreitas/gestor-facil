const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const CHAVES_PUBLICAS = [
    path.join(__dirname, 'licenses', 'license-public.pem'),
    path.join(__dirname, 'licenses', 'license-public-v2.pem')
];
const ARQUIVO_LICENCA = path.join(app.getPath('userData'), 'licenca.json');
const PRODUTO = 'gestor-facil';

function obterCodigoMaquina() {
    let identificador;

    if (process.platform === 'win32') {
        const saida = execFileSync('reg.exe', [
            'query',
            'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
            '/v',
            'MachineGuid'
        ], { encoding: 'utf8', windowsHide: true });
        identificador = saida.match(/MachineGuid\s+REG_SZ\s+(.+)/i)?.[1]?.trim();
    } else {
        identificador = `${os.platform()}|${os.hostname()}|${os.homedir()}`;
    }

    if (!identificador) throw new Error('Não foi possível identificar este computador.');
    return `GF-${crypto.createHash('sha256').update(`gestor-facil:${identificador}`).digest('hex').slice(0, 32).toUpperCase()}`;
}

function validarToken(token, codigoMaquina) {
    const partes = String(token || '').trim().split('.');
    if (partes.length !== 2) return { valida: false, mensagem: 'A licença informada não está em um formato válido.' };

    try {
        const payloadBytes = Buffer.from(partes[0], 'base64url');
        const assinatura = Buffer.from(partes[1], 'base64url');
        const payloadTexto = payloadBytes.toString('utf8');
        const payload = JSON.parse(payloadTexto);
        const assinaturaValida = CHAVES_PUBLICAS.some((arquivo) => {
            try {
                const chavePublica = fs.readFileSync(arquivo, 'utf8');
                return crypto.verify(null, Buffer.from(payloadTexto), chavePublica, assinatura);
            } catch (_) {
                return false;
            }
        });

        if (!assinaturaValida || payload.produto !== PRODUTO) {
            return { valida: false, mensagem: 'A licença não foi emitida pelo Gestor Fácil.' };
        }
        if (payload.maquina !== codigoMaquina) {
            return { valida: false, mensagem: 'Esta licença foi emitida para outro computador.' };
        }
        if (payload.expiraEm && Date.now() > Date.parse(payload.expiraEm)) {
            return { valida: false, mensagem: 'Esta licença expirou.' };
        }

        return { valida: true, payload };
    } catch (_) {
        return { valida: false, mensagem: 'Não foi possível validar a licença. Confira o código e tente novamente.' };
    }
}

function obterEstadoLicenca() {
    if (!app.isPackaged) return { ativa: true, desenvolvimento: true };

    let codigoMaquina;
    try {
        codigoMaquina = obterCodigoMaquina();
    } catch (erro) {
        return { ativa: false, erro: erro.message };
    }

    try {
        const token = fs.readFileSync(ARQUIVO_LICENCA, 'utf8');
        const resultado = validarToken(token, codigoMaquina);
        if (resultado.valida) {
            return {
                ativa: true,
                codigoMaquina,
                cliente: resultado.payload.cliente || '',
                expiraEm: resultado.payload.expiraEm || null
            };
        }
    } catch (_) {}

    return { ativa: false, codigoMaquina };
}

function ativarLicenca(token) {
    if (!app.isPackaged) return { sucesso: true, desenvolvimento: true };

    let codigoMaquina;
    try {
        codigoMaquina = obterCodigoMaquina();
    } catch (erro) {
        return { sucesso: false, mensagem: erro.message };
    }

    const resultado = validarToken(token, codigoMaquina);
    if (!resultado.valida) return { sucesso: false, mensagem: resultado.mensagem };

    fs.mkdirSync(path.dirname(ARQUIVO_LICENCA), { recursive: true });
    const temporario = `${ARQUIVO_LICENCA}.tmp`;
    fs.writeFileSync(temporario, String(token).trim(), { encoding: 'utf8', flag: 'w' });
    fs.renameSync(temporario, ARQUIVO_LICENCA);
    return { sucesso: true, cliente: resultado.payload.cliente || '' };
}

module.exports = { obterCodigoMaquina, obterEstadoLicenca, ativarLicenca };
