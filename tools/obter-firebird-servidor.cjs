/* Baixa o instalador oficial do Firebird e valida o SHA-256 publicado no GitHub. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSAO = '5.0.4';
const NOME = 'Firebird-5.0.4.1812-0-windows-x64.exe';
const SHA256 = '26881a3300e03d45d1a4d4ade645ab66ab6f8666fea9678e4cbffa7c70fe15ff';
const URL = `https://github.com/FirebirdSQL/firebird/releases/download/v${VERSAO}/${NOME}`;
const DESTINO = path.join(__dirname, '..', 'build', 'firebird', NOME);

function sha256(arquivo) {
    return crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex');
}

async function executar() {
    if (fs.existsSync(DESTINO)) {
        const atual = sha256(DESTINO);
        if (atual === SHA256) {
            console.log(`Instalador Firebird ${VERSAO} já está disponível e íntegro.`);
            return;
        }
        throw new Error(`O arquivo local ${NOME} existe, mas o SHA-256 não confere. Remova-o e execute novamente.`);
    }

    fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
    const temporario = `${DESTINO}.download`;
    try {
        console.log(`Baixando instalador oficial Firebird ${VERSAO}...`);
        const resposta = await fetch(URL, { redirect: 'follow' });
        if (!resposta.ok) throw new Error(`Download respondeu HTTP ${resposta.status}.`);
        const bytes = Buffer.from(await resposta.arrayBuffer());
        const calculado = crypto.createHash('sha256').update(bytes).digest('hex');
        if (calculado !== SHA256) throw new Error(`SHA-256 inesperado: ${calculado}.`);
        fs.writeFileSync(temporario, bytes, { flag: 'wx' });
        fs.renameSync(temporario, DESTINO);
        console.log(`Instalador baixado e validado: ${DESTINO}`);
    } catch (erro) {
        try { fs.rmSync(temporario, { force: true }); } catch (_) {}
        throw erro;
    }
}

executar().catch(erro => {
    console.error(`Não foi possível preparar o instalador Firebird: ${erro.message}`);
    process.exitCode = 1;
});
