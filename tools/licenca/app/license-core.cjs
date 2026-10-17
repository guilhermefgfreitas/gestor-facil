const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function caminhoChavePrivada() {
    return path.join(process.env.APPDATA || os.homedir(), 'Gestor Facil Licencas', 'license-private.pem');
}

function gerarLicenca({ cliente, maquina, dias }) {
    const nomeCliente = String(cliente || '').trim();
    const codigoMaquina = String(maquina || '').trim().toUpperCase();
    const validadeDias = dias === null || dias === undefined || dias === '' ? null : Number(dias);

    if (!nomeCliente) throw new Error('Informe o nome do cliente.');
    if (!/^GF-[0-9A-F]{32}$/.test(codigoMaquina)) throw new Error('O código da máquina deve começar com GF- e conter 32 caracteres hexadecimais.');
    if (validadeDias !== null && (!Number.isInteger(validadeDias) || validadeDias < 1 || validadeDias > 36500)) {
        throw new Error('A validade deve ser de 1 a 36500 dias.');
    }

    const arquivoPrivado = caminhoChavePrivada();
    if (!fs.existsSync(arquivoPrivado)) {
        throw new Error(`Chave privada não encontrada. Ela deve estar neste computador: ${arquivoPrivado}`);
    }

    const emitidaEm = new Date();
    const payload = {
        produto: 'gestor-facil',
        id: crypto.randomUUID(),
        cliente: nomeCliente,
        maquina: codigoMaquina,
        emitidaEm: emitidaEm.toISOString(),
        expiraEm: validadeDias === null ? null : new Date(emitidaEm.getTime() + validadeDias * 86400000).toISOString()
    };
    const textoPayload = JSON.stringify(payload);
    const dados = Buffer.from(textoPayload).toString('base64url');
    const assinatura = crypto.sign(null, Buffer.from(textoPayload), fs.readFileSync(arquivoPrivado, 'utf8')).toString('base64url');
    return `${dados}.${assinatura}`;
}

module.exports = { caminhoChavePrivada, gerarLicenca };
