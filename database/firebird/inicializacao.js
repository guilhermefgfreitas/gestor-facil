const crypto = require('node:crypto');

const TABELAS_ESPERADAS = [
    'configuracao_sistema', 'produtos', 'clientes', 'vendas', 'itens_venda',
    'ordens_servico', 'itens_os', 'garantias', 'garantia_itens', 'usuarios',
    'permissoes_usuarios', 'movimentacoes_estoque', 'auditoria'
];

const COLUNAS_ESPERADAS = {
    configuracao_sistema: ['id', 'administrador_configurado'],
    produtos: ['id', 'nome', 'codigo', 'sku', 'codigo_barras', 'categoria', 'preco_custo', 'preco_venda', 'estoque', 'estoque_minimo', 'criado_em'],
    clientes: ['id', 'nome', 'cpf_cnpj', 'telefone', 'celular', 'email', 'cep', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'estado', 'observacoes', 'criado_em'],
    vendas: ['id', 'numero', 'cliente_id', 'subtotal', 'desconto', 'total', 'forma_pagamento', 'observacoes', 'status', 'cancelada_em', 'cancelamento_motivo', 'data_hora'],
    itens_venda: ['id', 'venda_id', 'produto_id', 'quantidade', 'preco_unitario', 'subtotal'],
    ordens_servico: ['id', 'numero', 'cliente_id', 'tipo_equipamento', 'marca', 'modelo', 'numero_serie', 'sistema_operacional', 'senha_equipamento', 'acessorios', 'estado_fisico', 'avarias', 'problema_relatado', 'diagnostico', 'servico_realizado', 'previsao_entrega', 'data_conclusao', 'data_entrega', 'status', 'valor_pecas', 'valor_mao_obra', 'desconto', 'total', 'observacoes', 'data_hora_abertura'],
    itens_os: ['id', 'os_id', 'produto_id', 'descricao', 'tipo', 'quantidade', 'valor_unitario', 'subtotal'],
    garantias: ['id', 'venda_id', 'os_id', 'cliente_id', 'produto_id', 'descricao', 'prazo_dias', 'data_inicio', 'data_fim', 'status', 'observacoes', 'cobertura', 'exclusoes', 'criado_em'],
    garantia_itens: ['id', 'garantia_id', 'produto_id'],
    usuarios: ['id', 'nome', 'usuario', 'senha_hash', 'senha_salt', 'perfil', 'ativo', 'primeiro_acesso', 'criado_em', 'atualizado_em'],
    permissoes_usuarios: ['id', 'usuario_id', 'modulo', 'consultar', 'criar', 'editar', 'excluir', 'criado_em', 'atualizado_em'],
    movimentacoes_estoque: ['id', 'produto_id', 'tipo', 'quantidade', 'estoque_anterior', 'estoque_posterior', 'motivo', 'origem', 'origem_id', 'data_hora'],
    auditoria: ['id', 'usuario_id', 'usuario_nome', 'usuario_login', 'perfil', 'acao', 'modulo', 'descricao', 'entidade_tipo', 'entidade_id', 'data_hora', 'dados_antes', 'dados_depois']
};

const CHAVES_ESTRANGEIRAS_ESPERADAS = [
    ['vendas', 'cliente_id', 'clientes', 'id'],
    ['itens_venda', 'venda_id', 'vendas', 'id'],
    ['itens_venda', 'produto_id', 'produtos', 'id'],
    ['ordens_servico', 'cliente_id', 'clientes', 'id'],
    ['itens_os', 'os_id', 'ordens_servico', 'id'],
    ['itens_os', 'produto_id', 'produtos', 'id'],
    ['garantias', 'venda_id', 'vendas', 'id'],
    ['garantias', 'os_id', 'ordens_servico', 'id'],
    ['garantias', 'cliente_id', 'clientes', 'id'],
    ['garantias', 'produto_id', 'produtos', 'id'],
    ['garantia_itens', 'garantia_id', 'garantias', 'id'],
    ['garantia_itens', 'produto_id', 'produtos', 'id'],
    ['permissoes_usuarios', 'usuario_id', 'usuarios', 'id'],
    ['movimentacoes_estoque', 'produto_id', 'produtos', 'id']
];

const INDICES_UNICOS_ESPERADOS = [
    ['produtos', ['sku']],
    ['produtos', ['codigo_barras']],
    ['clientes', ['cpf_cnpj']],
    ['vendas', ['numero']],
    ['ordens_servico', ['numero']],
    ['usuarios', ['usuario']],
    ['permissoes_usuarios', ['usuario_id', 'modulo']]
];
const INDICES_COMPUTADOS_ESPERADOS = ['UQ_USUARIOS_USUARIO_CI'];
const SEQUENCIAS_E_GATILHOS_ID = [
    ['GEN_PRODUTOS_ID', 'BI_GF_PRODUTOS_ID'],
    ['GEN_CLIENTES_ID', 'BI_GF_CLIENTES_ID'],
    ['GEN_VENDAS_ID', 'BI_GF_VENDAS_ID'],
    ['GEN_ITENS_VENDA_ID', 'BI_GF_ITENS_VENDA_ID'],
    ['GEN_ORDENS_SERVICO_ID', 'BI_GF_ORDENS_SERVICO_ID'],
    ['GEN_ITENS_OS_ID', 'BI_GF_ITENS_OS_ID'],
    ['GEN_GARANTIAS_ID', 'BI_GF_GARANTIAS_ID'],
    ['GEN_GARANTIA_ITENS_ID', 'BI_GF_GARANTIA_ITENS_ID'],
    ['GEN_USUARIOS_ID', 'BI_GF_USUARIOS_ID'],
    ['GEN_PERMISSOES_USUARIOS_ID', 'BI_GF_PERMISSOES_ID'],
    ['GEN_MOVIMENTACOES_ESTOQUE_ID', 'BI_GF_MOVIMENTACOES_ID'],
    ['GEN_AUDITORIA_ID', 'BI_GF_AUDITORIA_ID']
];

const MODULOS_ADMINISTRADOR = [
    'dashboard', 'produtos', 'clientes', 'vendas', 'os',
    'garantias', 'estoque', 'relatorios', 'usuarios'
];

function criarHashSenha(senha) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
    return { salt, hash };
}

async function validarEsquemaFirebird(banco) {
    const linhas = await banco.consultar(`
        SELECT TRIM(RDB$RELATION_NAME) AS nome
        FROM RDB$RELATIONS
        WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0
          AND RDB$VIEW_BLR IS NULL
    `);
    const existentes = new Set(linhas.map(linha => String(linha.nome || '').trim().toLowerCase()));
    const faltantes = TABELAS_ESPERADAS.filter(tabela => !existentes.has(tabela));
    if (faltantes.length) {
        throw new Error(`A base Firebird está incompleta. Tabelas ausentes: ${faltantes.join(', ')}.`);
    }

    const nomesTabelas = Object.keys(COLUNAS_ESPERADAS);
    const campos = await banco.consultar(`
        SELECT TRIM(RDB$RELATION_NAME) AS tabela, TRIM(RDB$FIELD_NAME) AS coluna
        FROM RDB$RELATION_FIELDS
        WHERE RDB$RELATION_NAME IN (${nomesTabelas.map(() => '?').join(', ')})
    `, nomesTabelas.map(nome => nome.toUpperCase()));
    const colunasPorTabela = new Map();
    for (const campo of campos) {
        const tabela = String(campo.tabela || '').trim().toLowerCase();
        if (!colunasPorTabela.has(tabela)) colunasPorTabela.set(tabela, new Set());
        colunasPorTabela.get(tabela).add(String(campo.coluna || '').trim().toLowerCase());
    }

    const faltantesPorTabela = [];
    for (const [tabela, colunas] of Object.entries(COLUNAS_ESPERADAS)) {
        const existentesNaTabela = colunasPorTabela.get(tabela) || new Set();
        const faltantesNaTabela = colunas.filter(coluna => !existentesNaTabela.has(coluna));
        if (faltantesNaTabela.length) faltantesPorTabela.push(`${tabela}: ${faltantesNaTabela.join(', ')}`);
    }
    if (faltantesPorTabela.length) {
        throw new Error(`O esquema Firebird não corresponde ao Gestor Fácil. Colunas ausentes: ${faltantesPorTabela.join('; ')}.`);
    }

    const relacionamentos = await banco.consultar(`
        SELECT
            TRIM(rc.RDB$RELATION_NAME) AS tabela,
            TRIM(local_segmento.RDB$FIELD_NAME) AS coluna,
            TRIM(tabela_referenciada.RDB$RELATION_NAME) AS tabela_referenciada,
            TRIM(segmento_referenciado.RDB$FIELD_NAME) AS coluna_referenciada
        FROM RDB$RELATION_CONSTRAINTS rc
        INNER JOIN RDB$REF_CONSTRAINTS ref
            ON ref.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
        INNER JOIN RDB$INDICES indice_local
            ON indice_local.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
        INNER JOIN RDB$INDEX_SEGMENTS local_segmento
            ON local_segmento.RDB$INDEX_NAME = indice_local.RDB$INDEX_NAME
        INNER JOIN RDB$RELATION_CONSTRAINTS constraint_referenciada
            ON constraint_referenciada.RDB$CONSTRAINT_NAME = ref.RDB$CONST_NAME_UQ
        INNER JOIN RDB$INDICES indice_referenciado
            ON indice_referenciado.RDB$INDEX_NAME = constraint_referenciada.RDB$INDEX_NAME
        INNER JOIN RDB$INDEX_SEGMENTS segmento_referenciado
            ON segmento_referenciado.RDB$INDEX_NAME = indice_referenciado.RDB$INDEX_NAME
           AND segmento_referenciado.RDB$FIELD_POSITION = local_segmento.RDB$FIELD_POSITION
        INNER JOIN RDB$RELATIONS tabela_referenciada
            ON tabela_referenciada.RDB$RELATION_NAME = indice_referenciado.RDB$RELATION_NAME
        WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY'
    `);
    const relacionamentosExistentes = new Set(relacionamentos.map(relacao => [
        String(relacao.tabela || '').trim().toLowerCase(),
        String(relacao.coluna || '').trim().toLowerCase(),
        String(relacao.tabela_referenciada || '').trim().toLowerCase(),
        String(relacao.coluna_referenciada || '').trim().toLowerCase()
    ].join('.')));
    const relacionamentosAusentes = CHAVES_ESTRANGEIRAS_ESPERADAS.filter(chave => !relacionamentosExistentes.has(chave.join('.')));
    if (relacionamentosAusentes.length) {
        throw new Error(`O esquema Firebird está sem chaves estrangeiras esperadas: ${relacionamentosAusentes.map(chave => `${chave[0]}.${chave[1]} → ${chave[2]}.${chave[3]}`).join('; ')}.`);
    }

    const indices = await banco.consultar(`
        SELECT
            TRIM(indice.RDB$RELATION_NAME) AS tabela,
            TRIM(indice.RDB$INDEX_NAME) AS indice,
            TRIM(segmento.RDB$FIELD_NAME) AS coluna,
            segmento.RDB$FIELD_POSITION AS posicao
        FROM RDB$INDICES indice
        INNER JOIN RDB$INDEX_SEGMENTS segmento
            ON segmento.RDB$INDEX_NAME = indice.RDB$INDEX_NAME
        WHERE COALESCE(indice.RDB$UNIQUE_FLAG, 0) = 1
          AND COALESCE(indice.RDB$SYSTEM_FLAG, 0) = 0
    `);
    const colunasPorIndice = new Map();
    for (const linha of indices) {
        const chave = `${String(linha.tabela || '').trim().toLowerCase()}.${String(linha.indice || '').trim().toLowerCase()}`;
        if (!colunasPorIndice.has(chave)) colunasPorIndice.set(chave, { tabela: chave.split('.')[0], colunas: [] });
        colunasPorIndice.get(chave).colunas[Number(linha.posicao || 0)] = String(linha.coluna || '').trim().toLowerCase();
    }
    const indicesExistentes = new Set([...colunasPorIndice.values()].map(item => `${item.tabela}.${item.colunas.join(',')}`));
    const indicesAusentes = INDICES_UNICOS_ESPERADOS.filter(([tabela, colunas]) => !indicesExistentes.has(`${tabela}.${colunas.join(',')}`));
    if (indicesAusentes.length) {
        throw new Error(`O esquema Firebird está sem índices únicos esperados: ${indicesAusentes.map(([tabela, colunas]) => `${tabela}(${colunas.join(', ')})`).join('; ')}.`);
    }
    const indicesComputados = await banco.consultar(`
        SELECT TRIM(RDB$INDEX_NAME) AS indice
        FROM RDB$INDICES
        WHERE COALESCE(RDB$UNIQUE_FLAG, 0) = 1
          AND RDB$EXPRESSION_BLR IS NOT NULL
          AND RDB$INDEX_NAME IN (${INDICES_COMPUTADOS_ESPERADOS.map(() => '?').join(', ')})
    `, INDICES_COMPUTADOS_ESPERADOS);
    const computadosEncontrados = new Set(indicesComputados.map(item => String(item.indice || '').trim().toUpperCase()));
    const computadosAusentes = INDICES_COMPUTADOS_ESPERADOS.filter(nome => !computadosEncontrados.has(nome));
    if (computadosAusentes.length) {
        throw new Error(`O esquema Firebird está sem índices únicos computados esperados: ${computadosAusentes.join(', ')}.`);
    }

    const sequencias = await banco.consultar(`
        SELECT TRIM(RDB$GENERATOR_NAME) AS nome
        FROM RDB$GENERATORS
        WHERE RDB$GENERATOR_NAME IN (${SEQUENCIAS_E_GATILHOS_ID.map(() => '?').join(', ')})
    `, SEQUENCIAS_E_GATILHOS_ID.map(([sequencia]) => sequencia));
    const sequenciasEncontradas = new Set(sequencias.map(item => String(item.nome || '').trim().toUpperCase()));
    const sequenciasAusentes = SEQUENCIAS_E_GATILHOS_ID.map(([sequencia]) => sequencia).filter(nome => !sequenciasEncontradas.has(nome));
    const gatilhos = await banco.consultar(`
        SELECT TRIM(RDB$TRIGGER_NAME) AS nome
        FROM RDB$TRIGGERS
        WHERE RDB$TRIGGER_NAME IN (${SEQUENCIAS_E_GATILHOS_ID.map(() => '?').join(', ')})
          AND COALESCE(RDB$TRIGGER_INACTIVE, 0) = 0
    `, SEQUENCIAS_E_GATILHOS_ID.map(([, gatilho]) => gatilho));
    const gatilhosEncontrados = new Set(gatilhos.map(item => String(item.nome || '').trim().toUpperCase()));
    const gatilhosAusentes = SEQUENCIAS_E_GATILHOS_ID.map(([, gatilho]) => gatilho).filter(nome => !gatilhosEncontrados.has(nome));
    if (sequenciasAusentes.length || gatilhosAusentes.length) {
        const partes = [];
        if (sequenciasAusentes.length) partes.push(`sequências: ${sequenciasAusentes.join(', ')}`);
        if (gatilhosAusentes.length) partes.push(`gatilhos ativos: ${gatilhosAusentes.join(', ')}`);
        throw new Error(`O esquema Firebird está sem geradores de ID necessários (${partes.join('; ')}).`);
    }

    return {
        tabelas: TABELAS_ESPERADAS.length,
        colunas: Object.values(COLUNAS_ESPERADAS).reduce((total, lista) => total + lista.length, 0),
        chavesEstrangeiras: CHAVES_ESTRANGEIRAS_ESPERADAS.length,
        indicesUnicos: INDICES_UNICOS_ESPERADOS.length + INDICES_COMPUTADOS_ESPERADOS.length,
        geradoresId: SEQUENCIAS_E_GATILHOS_ID.length
    };
}

async function obterEstadoInicializacaoFirebird(banco) {
    await validarEsquemaFirebird(banco);
    const [marcador, totalUsuarios] = await Promise.all([
        banco.consultarUm('SELECT administrador_configurado FROM configuracao_sistema WHERE id = 1'),
        banco.consultarUm('SELECT COUNT(*) AS total FROM usuarios')
    ]);
    if (!marcador) throw new Error('O marcador de inicialização do Firebird não foi encontrado.');

    const usuarios = Number(totalUsuarios?.total || 0);
    const administradorConfigurado = Number(marcador.administrador_configurado) === 1;
    if (usuarios > 0 && !administradorConfigurado) {
        throw new Error('A base já possui usuários, mas o marcador de inicialização está inconsistente.');
    }
    if (administradorConfigurado && usuarios === 0) {
        throw new Error('A inicialização está marcada como concluída, mas nenhum usuário administrador existe.');
    }

    return {
        precisaConfigurarAdministrador: !administradorConfigurado && usuarios === 0,
        administradorConfigurado,
        quantidadeUsuarios: usuarios
    };
}

async function configurarAdministradorInicialFirebird(banco, dados = {}) {
    const nome = String(dados.nome || '').trim();
    const usuario = String(dados.usuario || '').trim();
    const senha = String(dados.senha || '');
    if (!nome || nome.length > 200) throw new Error('Informe um nome válido para o administrador.');
    if (!/^[a-zA-Z0-9._-]{3,100}$/.test(usuario)) {
        throw new Error('O usuário deve ter de 3 a 100 caracteres: letras, números, ponto, hífen ou sublinhado.');
    }
    if (senha.length < 10) throw new Error('A senha do administrador deve ter pelo menos 10 caracteres.');

    const senhaSegura = criarHashSenha(senha);
    return banco.transacao(async transacao => {
        // A atualização condicional trava a linha singleton. Em chamadas
        // concorrentes, somente a primeira transação consegue reivindicá-la.
        const reivindicacao = await transacao.executar(`
            UPDATE configuracao_sistema
            SET administrador_configurado = 1
            WHERE id = 1 AND administrador_configurado = 0
        `);
        if (Number(reivindicacao.changes) !== 1) {
            throw new Error('A configuração inicial já foi concluída neste servidor.');
        }

        const total = await transacao.consultarUm('SELECT COUNT(*) AS total FROM usuarios');
        if (Number(total?.total || 0) !== 0) {
            throw new Error('A base já possui usuários. A configuração inicial foi cancelada.');
        }

        await transacao.executar(`
            INSERT INTO usuarios (nome, usuario, senha_hash, senha_salt, perfil, ativo, primeiro_acesso)
            VALUES (?, ?, ?, ?, 'administrador', 1, 0)
        `, [nome, usuario, senhaSegura.hash, senhaSegura.salt]);
        // O driver node-firebird não preenche lastInsertRowid em INSERT.
        // Leia a chave recém-criada dentro desta transação antes das permissões.
        const usuarioCriado = await transacao.consultarUm(
            'SELECT id FROM usuarios WHERE usuario = ?',
            [usuario]
        );
        const usuarioId = Number(usuarioCriado?.id || 0);
        if (!usuarioId) throw new Error('O Firebird não retornou o identificador do administrador criado.');

        for (const modulo of MODULOS_ADMINISTRADOR) {
            await transacao.executar(`
                INSERT INTO permissoes_usuarios (usuario_id, modulo, consultar, criar, editar, excluir)
                VALUES (?, ?, 1, 1, 1, 1)
            `, [usuarioId, modulo]);
        }
        return { id: usuarioId, nome, usuario, perfil: 'administrador' };
    });
}

module.exports = {
    TABELAS_ESPERADAS,
    COLUNAS_ESPERADAS,
    validarEsquemaFirebird,
    obterEstadoInicializacaoFirebird,
    configurarAdministradorInicialFirebird
};
