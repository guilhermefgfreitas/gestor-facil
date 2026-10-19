/* Converte placeholders nomeados para a forma posicional aceita pelos drivers. */
function normalizarParametros(sql, parametros = []) {
    if (Array.isArray(parametros)) return { sql, parametros };
    if (!parametros || typeof parametros !== 'object') {
        throw new TypeError('Os parâmetros SQL devem ser uma lista ou um objeto.');
    }

    const valores = [];
    const convertido = String(sql).replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_token, nome) => {
        if (!Object.prototype.hasOwnProperty.call(parametros, nome)) {
            throw new Error(`Falta o parâmetro SQL @${nome}.`);
        }
        valores.push(parametros[nome]);
        return '?';
    });
    return { sql: convertido, parametros: valores };
}

module.exports = { normalizarParametros };
