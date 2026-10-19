/* Cria o esquema do Gestor Fácil em uma base Firebird vazia. */
const fs = require('node:fs');
const path = require('node:path');
const Firebird = require('node-firebird');

function obrigatoria(nome) {
    const valor = String(process.env[nome] || '').trim();
    if (!valor) throw new Error(`Defina a variável ${nome}.`);
    return valor;
}

function dividirComandos(sql) {
    const comandos = [];
    let terminador = ';';
    let acumulado = '';
    for (const linha of String(sql).split(/\r?\n/)) {
        const diretiva = linha.match(/^\s*SET\s+TERM\s+(\S+)\s+\S+\s*;?\s*$/i);
        if (diretiva) {
            terminador = diretiva[1];
            continue;
        }
        acumulado += `${linha}\n`;
        const fim = acumulado.lastIndexOf(terminador);
        if (fim < 0) continue;
        const comando = acumulado.slice(0, fim)
            .split(/\r?\n/)
            .filter(item => !item.trim().startsWith('--'))
            .join('\n')
            .trim();
        if (comando) comandos.push(comando);
        acumulado = acumulado.slice(fim + terminador.length);
    }
    if (acumulado.trim()) throw new Error('O arquivo de esquema terminou com um comando sem terminador.');
    return comandos;
}

async function executar() {
    const config = {
        host: obrigatoria('GESTOR_FIREBIRD_HOST'),
        port: Number(process.env.GESTOR_FIREBIRD_PORT || 3050),
        database: obrigatoria('GESTOR_FIREBIRD_DATABASE'),
        user: obrigatoria('GESTOR_FIREBIRD_USER'),
        password: obrigatoria('GESTOR_FIREBIRD_PASSWORD'),
        encoding: 'UTF8',
        lowercase_keys: true,
        wireCrypt: Firebird.WIRE_CRYPT_ENABLE
    };
    if (config.user.toUpperCase() === 'SYSDBA') {
        throw new Error('Crie um usuário de implantação específico; não execute o Gestor Fácil com SYSDBA.');
    }

    const arquivoSchema = path.join(__dirname, '..', 'database', 'firebird', 'schema.sql');
    const comandos = dividirComandos(fs.readFileSync(arquivoSchema, 'utf8'));
    const banco = await Firebird.attachAsync(config);
    try {
        const existentes = await banco.queryAsync(
            "SELECT COUNT(*) AS quantidade FROM RDB$RELATIONS WHERE RDB$SYSTEM_FLAG = 0"
        );
        if (Number(Object.values(existentes[0] || {})[0] || 0) > 0) {
            throw new Error('A base não está vazia. O esquema não foi alterado.');
        }

        await banco.withTransaction(async transacao => {
            for (const comando of comandos) await transacao.executeAsync(comando);
        });
        console.log(`Esquema criado com ${comandos.length} comandos. A base de dados anterior não foi modificada.`);
    } finally {
        await banco.detachAsync();
    }
}

executar().catch(erro => {
    console.error(`Não foi possível criar o esquema Firebird: ${erro.message}`);
    process.exitCode = 1;
});
