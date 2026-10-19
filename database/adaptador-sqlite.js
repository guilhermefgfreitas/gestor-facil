/*
 * Interface assíncrona comum para consultas no SQLite enquanto o runtime é
 * migrado por etapas. A conexão SQLite continua sendo a fonte atual dos dados.
 */
const { normalizarParametros } = require('./parametros');

function criarAdaptadorSqlite(banco) {
    if (!banco || typeof banco.prepare !== 'function' || typeof banco.exec !== 'function') {
        throw new TypeError('A conexão SQLite informada é inválida.');
    }

    let fila = Promise.resolve();
    const exclusivo = operacao => {
        const resultado = fila.then(operacao, operacao);
        fila = resultado.catch(() => undefined);
        return resultado;
    };

    function criarEscopo() {
        return {
            consultar: (sql, parametros = []) => {
                const normalizados = normalizarParametros(sql, parametros);
                return banco.prepare(normalizados.sql).all(...normalizados.parametros);
            },
            consultarUm: (sql, parametros = []) => {
                const normalizados = normalizarParametros(sql, parametros);
                return banco.prepare(normalizados.sql).get(...normalizados.parametros) || null;
            },
            executar: (sql, parametros = []) => {
                const normalizados = normalizarParametros(sql, parametros);
                const resultado = banco.prepare(normalizados.sql).run(...normalizados.parametros);
                return {
                    changes: Number(resultado.changes || 0),
                    lastInsertRowid: Number(resultado.lastInsertRowid || 0)
                };
            }
        };
    }

    return {
        consultar: (sql, parametros = []) => exclusivo(() => criarEscopo().consultar(sql, parametros)),
        consultarUm: (sql, parametros = []) => exclusivo(() => criarEscopo().consultarUm(sql, parametros)),
        executar: (sql, parametros = []) => exclusivo(() => criarEscopo().executar(sql, parametros)),

        transacao(operacao) {
            if (typeof operacao !== 'function') throw new TypeError('A transação exige uma função.');
            return exclusivo(async () => {
                banco.exec('BEGIN IMMEDIATE');
                try {
                    const resultado = await operacao(criarEscopo());
                    banco.exec('COMMIT');
                    return resultado;
                } catch (erro) {
                    try { banco.exec('ROLLBACK'); } catch (_) {}
                    throw erro;
                }
            });
        }
    };
}

module.exports = { criarAdaptadorSqlite };
