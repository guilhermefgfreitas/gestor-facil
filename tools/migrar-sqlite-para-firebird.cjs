/*
 * Importa uma cópia da base SQLite para uma base Firebird já criada com
 * database/firebird/schema.sql. Nunca altera nem remove o arquivo de origem.
 * É uma ferramenta de migração inicial, não um sincronizador contínuo.
 *
 * Variáveis necessárias:
 *   GESTOR_SQLITE_FILE       caminho do arquivo .db de origem
 *   GESTOR_FIREBIRD_HOST     computador que executa o Firebird Server
 *   GESTOR_FIREBIRD_DATABASE alias ou caminho da base no servidor
 *   GESTOR_FIREBIRD_USER     usuário restrito de migração
 *   GESTOR_FIREBIRD_PASSWORD senha desse usuário
 * Variável opcional: GESTOR_FIREBIRD_PORT (padrão 3050)
 */
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const Firebird = require('node-firebird');
const { validarEsquemaFirebird } = require('../database/firebird/inicializacao');

const TABELAS = [
    'clientes',
    'produtos',
    'usuarios',
    'permissoes_usuarios',
    'vendas',
    'itens_venda',
    'ordens_servico',
    'itens_os',
    'garantias',
    'garantia_itens',
    'movimentacoes_estoque',
    'auditoria'
];
const COLUNAS_APENAS_DATA = new Set([
    'ordens_servico.previsao_entrega',
    'garantias.data_inicio',
    'garantias.data_fim'
]);
const TABELAS_COM_MIGRACAO_OPCIONAL = new Set(['permissoes_usuarios']);
const CAMPOS_UNICOS = [
    ['produtos', 'sku'],
    ['produtos', 'codigo_barras'],
    ['clientes', 'cpf_cnpj'],
    ['vendas', 'numero'],
    ['ordens_servico', 'numero']
];
const CAMPOS_UNICOS_SEM_DISTINGUIR_CAIXA = [
    ['usuarios', 'usuario']
];

function obrigatoria(nome) {
    const valor = String(process.env[nome] || '').trim();
    if (!valor) throw new Error(`Defina a variável ${nome}.`);
    return valor;
}

function conectarFirebird(opcoes) {
    return new Promise((resolve, reject) => {
        Firebird.attach(opcoes, (erro, banco) => erro ? reject(erro) : resolve(banco));
    });
}

function valorContagem(linhas) {
    if (!linhas.length) return 0;
    const valor = Object.values(linhas[0])[0];
    return Number(valor || 0);
}

async function migrarSqliteParaFirebird(arquivoOrigemInformado, configuracaoInformada) {
    const arquivoOrigem = path.resolve(String(arquivoOrigemInformado || ''));
    if (!fs.existsSync(arquivoOrigem)) throw new Error(`Base SQLite não encontrada: ${arquivoOrigem}`);

    const opcoes = {
        host: String(configuracaoInformada?.host || '').trim(),
        port: Number(configuracaoInformada?.port || 3050),
        database: String(configuracaoInformada?.database || '').trim(),
        user: String(configuracaoInformada?.user || '').trim(),
        password: String(configuracaoInformada?.password || ''),
        lowercase_keys: true,
        encoding: 'UTF8',
        wireCrypt: Firebird.WIRE_CRYPT_ENABLE
    };
    if (!opcoes.host || !opcoes.database || !opcoes.user || !opcoes.password) {
        throw new Error('A configuração de conexão Firebird está incompleta.');
    }
    if (opcoes.user.toUpperCase() === 'SYSDBA') {
        throw new Error('A importação deve usar uma conta restrita, não SYSDBA.');
    }
    if (!Number.isInteger(opcoes.port) || opcoes.port < 1 || opcoes.port > 65535) {
        throw new Error('A porta Firebird está inválida.');
    }

    const origem = new Database(arquivoOrigem, { readonly: true, fileMustExist: true });
    let destino;
    try {
        // Mantém uma visão consistente de todas as tabelas durante a cópia,
        // mesmo que o Gestor Fácil continue recebendo alterações no SQLite.
        origem.exec('BEGIN');
        const integridade = origem.pragma('integrity_check', { simple: true });
        if (integridade !== 'ok') throw new Error(`A origem SQLite falhou na verificação: ${integridade}`);
        const referenciasInvalidas = origem.pragma('foreign_key_check');
        if (referenciasInvalidas.length) {
            const exemplos = referenciasInvalidas.slice(0, 5).map(item => `${item.table} linha ${item.rowid} → ${item.parent}`).join('; ');
            throw new Error(`A origem contém ${referenciasInvalidas.length} referência(s) entre tabelas inválida(s). Corrija antes de importar; nada foi gravado. ${exemplos}`);
        }

        const existentes = new Set(origem.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(item => item.name));
        const faltantes = TABELAS.filter(tabela => !existentes.has(tabela) && !TABELAS_COM_MIGRACAO_OPCIONAL.has(tabela));
        if (faltantes.length) {
            throw new Error(`A base de origem não possui as tabelas esperadas: ${faltantes.join(', ')}. Nenhum dado foi importado.`);
        }
        const tabelasOrigem = TABELAS.filter(tabela => existentes.has(tabela));

        destino = await conectarFirebird(opcoes);
        await validarEsquemaFirebird({
            consultar: (sql, parametros = []) => destino.queryAsync(sql, parametros)
        });

        // Confere o contrato de colunas antes da transação de importação. Isso
        // transforma diferenças de esquema em um erro claro, sem iniciar uma
        // carga que só falharia depois de percorrer os registros.
        for (const tabela of tabelasOrigem) {
            const colunasOrigem = origem.prepare(`PRAGMA table_info(${tabela})`).all().map(coluna => coluna.name.toLowerCase());
            const metadados = await destino.queryAsync(
                'SELECT TRIM(RDB$FIELD_NAME) AS field_name FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = ?',
                [tabela.toUpperCase()]
            );
            const colunasDestino = new Set(metadados.map(coluna => String(coluna.field_name || '').trim().toLowerCase()));
            const ausentes = colunasOrigem.filter(coluna => !colunasDestino.has(coluna));
            if (ausentes.length) {
                throw new Error(`A tabela ${tabela} no Firebird não possui as colunas da origem: ${ausentes.join(', ')}. Atualize o esquema antes de importar; nenhum dado foi gravado.`);
            }
        }

        // Detecta texto que excederia VARCHAR antes de iniciar a importação.
        // BLOBs de texto não têm esse limite; CHAR/VARCHAR usam o tamanho em
        // caracteres publicado nos metadados do Firebird.
        const camposTexto = await destino.queryAsync(`
            SELECT
                TRIM(rf.RDB$RELATION_NAME) AS tabela,
                TRIM(rf.RDB$FIELD_NAME) AS coluna,
                f.RDB$CHARACTER_LENGTH AS tamanho
            FROM RDB$RELATION_FIELDS rf
            INNER JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
            WHERE rf.RDB$RELATION_NAME IN (${tabelasOrigem.map(() => '?').join(', ')})
              AND f.RDB$FIELD_TYPE IN (14, 37)
        `, tabelasOrigem.map(tabela => tabela.toUpperCase()));
        const limites = [];
        for (const campo of camposTexto) {
            const tabela = String(campo.tabela || '').trim().toLowerCase();
            const coluna = String(campo.coluna || '').trim();
            if (!tabelasOrigem.includes(tabela) || !coluna) continue;
            const identificador = `"${coluna.replace(/"/g, '""')}"`;
            const maior = origem.prepare(`SELECT COALESCE(MAX(length(${identificador})), 0) AS tamanho FROM "${tabela}"`).get();
            const tamanhoAtual = Number(maior?.tamanho || 0);
            const tamanhoMaximo = Number(campo.tamanho || 0);
            if (tamanhoAtual > tamanhoMaximo) {
                limites.push(`${tabela}.${coluna}: ${tamanhoAtual} caracteres (limite ${tamanhoMaximo})`);
            }
        }
        if (limites.length) {
            throw new Error(`Há textos maiores que os campos VARCHAR da base Firebird. Ajuste o esquema ou os dados antes de importar; nada foi gravado. ${limites.join('; ')}`);
        }

        // Compara a capacidade dos campos inteiros e decimais com os valores
        // da origem. A consulta usa o metadado de precisão/escala do Firebird.
        const camposNumericos = await destino.queryAsync(`
            SELECT
                TRIM(rf.RDB$RELATION_NAME) AS tabela,
                TRIM(rf.RDB$FIELD_NAME) AS coluna,
                f.RDB$FIELD_TYPE AS tipo,
                f.RDB$FIELD_SUB_TYPE AS subtipo,
                f.RDB$FIELD_PRECISION AS precisao,
                f.RDB$FIELD_SCALE AS escala
            FROM RDB$RELATION_FIELDS rf
            INNER JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
            WHERE rf.RDB$RELATION_NAME IN (${tabelasOrigem.map(() => '?').join(', ')})
              AND f.RDB$FIELD_TYPE IN (7, 8, 16, 26)
        `, tabelasOrigem.map(tabela => tabela.toUpperCase()));
        const incompatibilidadesNumericas = [];
        for (const campo of camposNumericos) {
            const tabela = String(campo.tabela || '').trim().toLowerCase();
            const coluna = String(campo.coluna || '').trim();
            if (!tabelasOrigem.includes(tabela) || !coluna) continue;
            const identificador = `"${coluna.replace(/"/g, '""')}"`;
            const tipo = Number(campo.tipo);
            const subtipo = Number(campo.subtipo || 0);
            const escala = Math.abs(Number(campo.escala || 0));
            let limiteAbsoluto = null;
            let limiteInteiroExclusivo = false;
            if ((tipo === 7 || tipo === 8 || tipo === 16 || tipo === 26) && (subtipo === 1 || subtipo === 2)) {
                const precisao = Number(campo.precisao || 0);
                const digitosInteiros = precisao - escala;
                if (digitosInteiros > 0 && digitosInteiros < 16) limiteAbsoluto = 10 ** digitosInteiros;
            } else if (tipo === 7) { limiteAbsoluto = 32768; limiteInteiroExclusivo = true; }
            else if (tipo === 8) { limiteAbsoluto = 2147483648; limiteInteiroExclusivo = true; }

            if (limiteAbsoluto !== null) {
                const foraDoLimite = origem.prepare(`
                    SELECT COUNT(*) AS quantidade FROM "${tabela}"
                    WHERE "${coluna.replace(/"/g, '""')}" IS NOT NULL
                      AND ${limiteInteiroExclusivo
                        ? `(CAST(${identificador} AS REAL) < ? OR CAST(${identificador} AS REAL) >= ?)`
                        : `ABS(CAST(${identificador} AS REAL)) >= ?`}
                `).get(...(limiteInteiroExclusivo ? [-limiteAbsoluto, limiteAbsoluto] : [limiteAbsoluto]));
                if (Number(foraDoLimite?.quantidade || 0) > 0) {
                    incompatibilidadesNumericas.push(`${tabela}.${coluna}: excede o limite de ${limiteAbsoluto}`);
                }
            }

            if ((subtipo === 1 || subtipo === 2) && escala > 0) {
                const casasExcedentes = origem.prepare(`
                    SELECT COUNT(*) AS quantidade FROM "${tabela}"
                    WHERE ${identificador} IS NOT NULL
                      AND ABS(CAST(${identificador} AS REAL) - ROUND(CAST(${identificador} AS REAL), ?)) > 0.0000001
                `).get(escala);
                if (Number(casasExcedentes?.quantidade || 0) > 0) {
                    incompatibilidadesNumericas.push(`${tabela}.${coluna}: possui mais de ${escala} casas decimais`);
                }
            }
        }
        if (incompatibilidadesNumericas.length) {
            throw new Error(`Há valores numéricos incompatíveis com o esquema Firebird. Ajuste os dados antes de importar; nada foi gravado. ${incompatibilidadesNumericas.join('; ')}`);
        }

        // Os índices UNIQUE do esquema de destino podem rejeitar dados legados
        // que passaram a existir antes de a validação de duplicidade no app.
        const duplicidades = [];
        for (const [tabela, coluna] of CAMPOS_UNICOS) {
            if (!tabelasOrigem.includes(tabela)) continue;
            const duplicados = origem.prepare(`
                SELECT "${coluna}" AS valor, COUNT(*) AS quantidade
                FROM "${tabela}"
                WHERE "${coluna}" IS NOT NULL AND TRIM(CAST("${coluna}" AS TEXT)) <> ''
                GROUP BY "${coluna}"
                HAVING COUNT(*) > 1
                LIMIT 5
            `).all();
            for (const item of duplicados) {
                duplicidades.push(`${tabela}.${coluna}=${String(item.valor)} (${item.quantidade} registros)`);
            }
        }
        for (const [tabela, coluna] of CAMPOS_UNICOS_SEM_DISTINGUIR_CAIXA) {
            if (!tabelasOrigem.includes(tabela)) continue;
            const duplicados = origem.prepare(`
                SELECT lower(trim("${coluna}")) AS valor, COUNT(*) AS quantidade
                FROM "${tabela}"
                WHERE "${coluna}" IS NOT NULL AND TRIM(CAST("${coluna}" AS TEXT)) <> ''
                GROUP BY lower(trim("${coluna}"))
                HAVING COUNT(*) > 1
                LIMIT 5
            `).all();
            for (const item of duplicados) {
                duplicidades.push(`${tabela}.${coluna} (ignorando maiúsculas/minúsculas)=${String(item.valor)} (${item.quantidade} registros)`);
            }
        }
        if (duplicidades.length) {
            throw new Error(`A origem contém valores duplicados em campos únicos do Firebird. Corrija antes de importar; nada foi gravado. ${duplicidades.join('; ')}`);
        }

        const resumo = await destino.withTransaction(async transacao => {
            const vazias = [];
            for (const tabela of TABELAS) {
                const linhas = await transacao.queryAsync(`SELECT COUNT(*) AS quantidade FROM ${tabela}`);
                const quantidade = valorContagem(linhas);
                if (quantidade !== 0) {
                    throw new Error(`A tabela ${tabela} no Firebird já contém ${quantidade} registro(s). A importação exige uma base vazia; nada foi confirmado.`);
                }
                vazias.push(tabela);
            }

            const contagens = {};
            const identificadores = {};
            for (const tabela of tabelasOrigem) {
                const colunas = origem.prepare(`PRAGMA table_info(${tabela})`).all().map(coluna => coluna.name);
                const registros = origem.prepare(`SELECT * FROM ${tabela} ORDER BY id`).all();
                contagens[tabela] = registros.length;
                identificadores[tabela] = registros.map(registro => Number(registro.id));
                if (!registros.length) continue;

                const sql = `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${colunas.map(() => '?').join(', ')})`;
                const lote = 200;
                for (let inicio = 0; inicio < registros.length; inicio += lote) {
                    const linhas = registros.slice(inicio, inicio + lote).map(registro => colunas.map(coluna => {
                        const valor = registro[coluna] ?? null;
                        if (valor == null || !COLUNAS_APENAS_DATA.has(`${tabela}.${coluna}`)) return valor;
                        const texto = String(valor).trim();
                        return /^\d{4}-\d{2}-\d{2}/.test(texto) ? texto.slice(0, 10) : valor;
                    }));
                    await transacao.executeBatchAsync(sql, linhas);
                }
            }

            // O marcador acompanha a origem importada: base com contas já
            // migradas não pode oferecer novamente o cadastro do primeiro admin.
            if (Number(contagens.usuarios || 0) > 0) {
                await transacao.executeAsync(`
                    UPDATE configuracao_sistema
                    SET administrador_configurado = 1
                    WHERE id = 1
                `);
            }

            // Confirma as contagens dentro da mesma transação, antes do commit.
            // Qualquer divergência cancela a importação inteira.
            for (const tabela of tabelasOrigem) {
                const esperado = contagens[tabela];
                const linhas = await transacao.queryAsync(`SELECT COUNT(*) AS quantidade FROM ${tabela}`);
                const importado = valorContagem(linhas);
                if (importado !== esperado) {
                    throw new Error(`A conferência da tabela ${tabela} encontrou ${importado} registro(s), mas eram esperados ${esperado}. A transação será cancelada.`);
                }

                const idsDestino = await transacao.queryAsync(`SELECT id FROM ${tabela} ORDER BY id`);
                const idsImportados = idsDestino.map(linha => Number(linha.id));
                const idsOrigem = identificadores[tabela];
                if (idsImportados.length !== idsOrigem.length || idsImportados.some((id, indice) => id !== idsOrigem[indice])) {
                    throw new Error(`A conferência de identificadores da tabela ${tabela} divergiu da origem. A transação será cancelada.`);
                }
            }
            return contagens;
        });

        console.log('Importação concluída. A base SQLite original foi mantida intacta.');
        for (const [tabela, quantidade] of Object.entries(resumo)) console.log(`${tabela}: ${quantidade}`);
    } finally {
        if (origem.inTransaction) origem.exec('ROLLBACK');
        origem.close();
        if (destino) await destino.detachAsync();
    }
}

async function executarCli() {
    const arquivoOrigem = obrigatoria('GESTOR_SQLITE_FILE');
    const config = {
        host: obrigatoria('GESTOR_FIREBIRD_HOST'),
        port: Number(process.env.GESTOR_FIREBIRD_PORT || 3050),
        database: obrigatoria('GESTOR_FIREBIRD_DATABASE'),
        user: obrigatoria('GESTOR_FIREBIRD_USER'),
        password: obrigatoria('GESTOR_FIREBIRD_PASSWORD')
    };
    await migrarSqliteParaFirebird(arquivoOrigem, config);
}

if (require.main === module) {
    executarCli().catch(erro => {
        console.error(`Migração não concluída: ${erro.message}`);
        process.exitCode = 1;
    });
}

module.exports = { migrarSqliteParaFirebird };
