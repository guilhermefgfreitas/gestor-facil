/*
 * Conexão compartilhada com Firebird Server para uso na rede local.
 * As credenciais são fornecidas pelo chamador; nunca use SYSDBA no aplicativo.
 */
const Firebird = require('node-firebird');
const { normalizarParametros } = require('../parametros');
const { adaptarSqlFirebird } = require('./dialeto');

function validarConfiguracao(config = {}) {
    const host = String(config.host || '').trim();
    const database = String(config.database || '').trim();
    const user = String(config.user || '').trim();
    const password = String(config.password || '');
    const port = Number(config.port || 3050);

    if (!host) throw new Error('Informe o computador que hospeda o Firebird.');
    if (!database) throw new Error('Informe o alias ou caminho da base Firebird no servidor.');
    if (!user || !password) throw new Error('Informe as credenciais de acesso ao banco.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('A porta do Firebird deve ser um número entre 1 e 65535.');
    }
    if (user.toUpperCase() === 'SYSDBA') {
        throw new Error('Não use SYSDBA no Gestor Fácil. Configure uma conta restrita para o aplicativo.');
    }

    return { host, database, user, password, port };
}

function normalizarResultadoExecucao(resultado) {
    const linhas = Array.isArray(resultado?.rows)
        ? resultado.rows
        : resultado?.rows && typeof resultado.rows === 'object'
            ? [resultado.rows]
            : [];
    const linhaInserida = linhas[0] || {};
    const idRetornado = linhaInserida.id ?? linhaInserida.ID ?? linhaInserida.Id;
    return {
        changes: Number(resultado?.affectedRows || 0),
        lastInsertRowid: Number(idRetornado || 0),
        rows: linhas
    };
}

function normalizarErroFirebird(erro) {
    const codigoGds = Number(erro?.gdscode || erro?.gdsCode || 0);
    const codigoSql = Number(erro?.sqlcode || erro?.sqlCode || 0);
    if (codigoGds === 335544665 || codigoSql === -803) {
        erro.code = 'FIREBIRD_CONSTRAINT_UNIQUE';
    }
    return erro;
}

function criarConexaoFirebird(config, { limiteConexoes = 8, timeoutMs = 10000 } = {}) {
    const validada = validarConfiguracao(config);
    const pool = Firebird.pool(Math.max(1, Math.min(32, Number(limiteConexoes) || 8)), {
        ...validada,
        encoding: 'UTF8',
        lowercase_keys: true,
        // node-firebird expõe BLOB SUB_TYPE TEXT como callback por padrão.
        // Esses callbacks não podem ser enviados pela IPC do Electron e
        // quebram a tela de Auditoria ao retornar snapshots para o renderer.
        // Com blobAsText, os textos chegam resolvidos como strings comuns.
        blobAsText: true,
        typeCast: (coluna, next) => {
            const valor = next();
            if (valor == null || !(valor instanceof Date) || Number.isNaN(valor.getTime())) return valor;
            if (coluna.typeName === 'DATE') return valor.toISOString().slice(0, 10);
            if (coluna.typeName === 'TIMESTAMP') return valor.toISOString().replace('T', ' ').slice(0, 19);
            return valor;
        },
        wireCrypt: Firebird.WIRE_CRYPT_ENABLE,
        connectTimeout: timeoutMs
    });

    return {
        async consultar(sql, parametros = []) {
            const normalizados = normalizarParametros(adaptarSqlFirebird(sql), parametros);
            try {
                return await pool.withConnection(conexao => conexao.queryAsync(normalizados.sql, normalizados.parametros));
            } catch (erro) { throw normalizarErroFirebird(erro); }
        },

        async consultarUm(sql, parametros = []) {
            const normalizados = normalizarParametros(adaptarSqlFirebird(sql), parametros);
            try {
                const linhas = await pool.withConnection(conexao => conexao.queryAsync(normalizados.sql, normalizados.parametros));
                return linhas[0] || null;
            } catch (erro) { throw normalizarErroFirebird(erro); }
        },

        async executar(sql, parametros = []) {
            const normalizados = normalizarParametros(adaptarSqlFirebird(sql), parametros);
            try {
                return await pool.withConnection(async conexao => {
                    const resultado = await conexao.executeAsync(normalizados.sql, normalizados.parametros, { withMeta: true });
                    return normalizarResultadoExecucao(resultado);
                });
            } catch (erro) { throw normalizarErroFirebird(erro); }
        },

        async transacao(operacao, opcoes = {}) {
            if (typeof operacao !== 'function') throw new TypeError('A transação exige uma função.');
            try {
                return await pool.withConnection(conexao => conexao.withTransaction(async transacao => {
                    const contexto = {
                        consultar: (sql, parametros = []) => {
                            const normalizados = normalizarParametros(adaptarSqlFirebird(sql), parametros);
                            return transacao.queryAsync(normalizados.sql, normalizados.parametros);
                        },
                        consultarUm: async (sql, parametros = []) => {
                            const normalizados = normalizarParametros(adaptarSqlFirebird(sql), parametros);
                            const linhas = await transacao.queryAsync(normalizados.sql, normalizados.parametros);
                            return linhas[0] || null;
                        },
                        executar: async (sql, parametros = []) => {
                            const normalizados = normalizarParametros(adaptarSqlFirebird(sql), parametros);
                            const resultado = await transacao.executeAsync(normalizados.sql, normalizados.parametros, { withMeta: true });
                            return normalizarResultadoExecucao(resultado);
                        }
                    };
                    return operacao(contexto);
                }, opcoes));
            } catch (erro) { throw normalizarErroFirebird(erro); }
        },

        async fechar() {
            await pool.destroyAsync();
        }
    };
}

module.exports = { criarConexaoFirebird, validarConfiguracao, normalizarResultadoExecucao, normalizarErroFirebird };
