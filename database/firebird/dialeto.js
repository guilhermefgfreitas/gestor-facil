/* Ajustes pontuais para SQL do aplicativo executado pelo Firebird. */
function adaptarSqlFirebird(sql) {
    let convertido = String(sql).trim().replace(/;\s*$/, '');

    // A forma equivalente do Firebird aceita o parâmetro posicional do limite.
    convertido = convertido.replace(/\bLIMIT\s+(\?|\d+)\s*$/i, 'FETCH FIRST $1 ROWS ONLY');

    // SQLite trata LIKE sem distinguir maiúsculas/minúsculas para texto ASCII.
    // Preserva a semântica nos filtros de auditoria simples usados pelo app.
    convertido = convertido.replace(
        /\b([A-Za-z_][A-Za-z0-9_.]*)\s+LIKE\s+(\?|\'[^\']*\')/gi,
        (_match, coluna, padrao) => `UPPER(${coluna}) LIKE UPPER(${padrao})`
    );

    // Traduções usadas pela consulta de garantias. Mantém as consultas da
    // aplicação legíveis para SQLite e adapta apenas a cópia enviada ao Firebird.
    convertido = convertido.replace(
        /\bGROUP_CONCAT\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:,\s*('[^']*'|\?))?\s*\)/gi,
        (_match, expressao, separador) => `LIST(${expressao}${separador ? `, ${separador}` : ''})`
    );
    convertido = convertido.replace(
        /\bdate\(\s*data_fim\s*\)\s*<\s*date\(\s*'now'\s*,\s*'localtime'\s*\)/gi,
        'data_fim < CURRENT_DATE'
    );

    // O runtime usa o ID gerado em cadastros. RETURNING expõe esse ID na
    // mesma instrução e dentro da mesma transação, sem consultas MAX(id).
    if (/^INSERT\s+INTO\b/i.test(convertido) && !/\bRETURNING\b/i.test(convertido)) {
        convertido += ' RETURNING id';
    }

    return convertido;
}

module.exports = { adaptarSqlFirebird };
