const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pastaPrivada = path.join(process.env.APPDATA || os.homedir(), 'Gestor Facil Licencas');
const arquivoPrivado = path.join(pastaPrivada, 'license-private-v2.pem');
const arquivoPublico = path.join(__dirname, '..', '..', 'licenses', 'license-public-v2.pem');

fs.mkdirSync(pastaPrivada, { recursive: true });
fs.mkdirSync(path.dirname(arquivoPublico), { recursive: true });

let chavePrivada;
if (fs.existsSync(arquivoPrivado)) {
    chavePrivada = fs.readFileSync(arquivoPrivado, 'utf8');
} else {
    if (fs.existsSync(arquivoPublico)) {
        throw new Error(`A chave privada v2 não foi encontrada, mas a pública v2 já existe. Não gere outra para evitar incompatibilidade. Privada esperada: ${arquivoPrivado}`);
    }
    const par = crypto.generateKeyPairSync('ed25519');
    chavePrivada = par.privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.writeFileSync(arquivoPrivado, chavePrivada, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

const chavePublica = crypto.createPublicKey(chavePrivada).export({ type: 'spki', format: 'pem' });
if (fs.existsSync(arquivoPublico)) {
    const atual = fs.readFileSync(arquivoPublico, 'utf8');
    if (crypto.createPublicKey(atual).export({ type: 'spki', format: 'pem' }) !== chavePublica) {
        throw new Error(`A chave pública v2 existente não corresponde à privada. Não substitua automaticamente. Privada: ${arquivoPrivado}`);
    }
} else {
    fs.writeFileSync(arquivoPublico, chavePublica, { encoding: 'utf8', flag: 'wx' });
}

console.log('Par de chaves v2 pronto.');
console.log(`Chave privada (mantenha em sigilo e faça uma cópia segura): ${arquivoPrivado}`);
console.log(`Chave pública v2: ${arquivoPublico}`);
