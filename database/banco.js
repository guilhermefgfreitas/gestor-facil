/*
 * ESQUEMA E INICIALIZAÇÃO DO SQLITE
 * Abre o banco local, garante as tabelas e aplica pequenas migrações para
 * instalações antigas. main.js importa esta conexão para executar as consultas.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');


/*
    ==================================================
    CRIAR PASTA DO BANCO
    ==================================================
*/

const pastaBanco = app.getPath('userData');
const caminhoBanco = path.join(pastaBanco, 'gestor-facil.db');
const caminhoBancoAntigo = path.join(__dirname, 'gestor-facil.db');

fs.mkdirSync(pastaBanco, { recursive: true });

// Migra uma única vez o banco que ficava dentro da pasta do programa.
// VACUUM INTO cria uma cópia consistente, incluindo dados ainda presentes no WAL.
if (!fs.existsSync(caminhoBanco) && fs.existsSync(caminhoBancoAntigo)) {
    const caminhoTemporario = `${caminhoBanco}.migrando`;
    try {
        if (fs.existsSync(caminhoTemporario)) fs.unlinkSync(caminhoTemporario);

        const bancoAntigo = new Database(caminhoBancoAntigo);
        try {
            bancoAntigo.exec(`VACUUM INTO '${caminhoTemporario.replace(/'/g, "''")}'`);
        } finally {
            bancoAntigo.close();
        }

        const bancoMigrado = new Database(caminhoTemporario, { readonly: true, fileMustExist: true });
        try {
            const integridade = bancoMigrado.pragma('integrity_check', { simple: true });
            if (integridade !== 'ok') throw new Error('A cópia do banco não passou na verificação de integridade.');
        } finally {
            bancoMigrado.close();
        }

        fs.renameSync(caminhoTemporario, caminhoBanco);
        console.log('Banco de dados migrado para a pasta de dados do usuário.');
    } catch (erro) {
        try { if (fs.existsSync(caminhoTemporario)) fs.unlinkSync(caminhoTemporario); } catch (_) {}
        throw new Error(`Não foi possível migrar o banco de dados existente: ${erro.message}`);
    }
}


/*
    ==================================================
    CONECTAR AO BANCO
    ==================================================
*/

// O banco fica fora da pasta instalável e sobrevive à substituição do programa.
const db = new Database(caminhoBanco);


db.pragma('foreign_keys = ON');


/*
    ==================================================
    TABELA PRODUTOS
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS produtos (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        nome TEXT NOT NULL,

        codigo TEXT,

        categoria TEXT,

        preco_custo REAL NOT NULL DEFAULT 0,

        preco_venda REAL NOT NULL DEFAULT 0,

        estoque INTEGER NOT NULL DEFAULT 0,

        estoque_minimo INTEGER NOT NULL DEFAULT 0,

        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP

    )
`);


/*
    ==================================================
    VERIFICAR COLUNAS DOS PRODUTOS
    ==================================================
*/

const colunasProdutos = db
    .prepare(`PRAGMA table_info(produtos)`)
    .all();


const possuiSku = colunasProdutos.some(
    coluna => coluna.name === 'sku'
);


const possuiCodigoBarras = colunasProdutos.some(
    coluna => coluna.name === 'codigo_barras'
);


/*
    ==================================================
    ADICIONAR SKU
    ==================================================
*/

// Adiciona colunas em bancos já existentes sem recriar ou apagar produtos.
if (!possuiSku) {

    db.exec(`
        ALTER TABLE produtos
        ADD COLUMN sku TEXT
    `);

}


/*
    ==================================================
    ADICIONAR CÓDIGO DE BARRAS
    ==================================================
*/

if (!possuiCodigoBarras) {

    db.exec(`
        ALTER TABLE produtos
        ADD COLUMN codigo_barras TEXT
    `);

}


/*
    ==================================================
    GERAR SKU PARA PRODUTOS ANTIGOS
    ==================================================
*/

const produtosSemSku = db
    .prepare(`
        SELECT id
        FROM produtos
        WHERE sku IS NULL
        OR sku = ''
        ORDER BY id
    `)
    .all();


const atualizarSku = db.prepare(`
    UPDATE produtos

    SET sku = ?

    WHERE id = ?
`);


// Mantém compatibilidade com produtos antigos que ainda não tinham SKU.
for (const produto of produtosSemSku) {

    const sku = `PROD-${String(produto.id).padStart(5, '0')}`;

    atualizarSku.run(
        sku,
        produto.id
    );

}


/*
    ==================================================
    GARANTIR SKU ÚNICO
    ==================================================
*/

db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    idx_produtos_sku
    ON produtos(sku)
`);


/*
    ==================================================
    GARANTIR CÓDIGO DE BARRAS ÚNICO
    ==================================================
*/

db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    idx_produtos_codigo_barras
    ON produtos(codigo_barras)
`);


/*
    ==================================================
    TABELA CLIENTES
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        nome TEXT NOT NULL,

        cpf_cnpj TEXT,

        telefone TEXT,

        celular TEXT,

        email TEXT,

        cep TEXT,

        endereco TEXT,

        numero TEXT,

        complemento TEXT,

        bairro TEXT,

        cidade TEXT,

        estado TEXT,

        observacoes TEXT,

        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP

    )
`);


/*
    ==================================================
    VERIFICAR COLUNAS DOS CLIENTES
    ==================================================
*/

const colunasClientes = db
    .prepare(`PRAGMA table_info(clientes)`)
    .all();


const possuiCelular = colunasClientes.some(
    coluna => coluna.name === 'celular'
);


/*
    ==================================================
    ADICIONAR CELULAR EM CLIENTES ANTIGOS
    ==================================================
*/

if (!possuiCelular) {

    db.exec(`
        ALTER TABLE clientes
        ADD COLUMN celular TEXT
    `);

}


/*
    ==================================================
    GARANTIR CPF/CNPJ ÚNICO
    ==================================================
*/

db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    idx_clientes_cpf_cnpj
    ON clientes(cpf_cnpj)
`);


/*
    ==================================================
    TABELA VENDAS
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS vendas (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        numero INTEGER NOT NULL UNIQUE,

        cliente_id INTEGER,

        subtotal REAL NOT NULL DEFAULT 0,

        desconto REAL NOT NULL DEFAULT 0,

        total REAL NOT NULL DEFAULT 0,

        forma_pagamento TEXT,

        observacoes TEXT,

        status TEXT NOT NULL DEFAULT 'Concluída',

        cancelada_em DATETIME,

        cancelamento_motivo TEXT,

        data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (cliente_id)
            REFERENCES clientes(id)

            ON DELETE SET NULL

    )
`);

// Migração idempotente para instalações que já possuem vendas cadastradas.
const colunasVendas = new Set(db.prepare('PRAGMA table_info(vendas)').all().map(coluna => coluna.name));
if (!colunasVendas.has('status')) db.exec("ALTER TABLE vendas ADD COLUMN status TEXT NOT NULL DEFAULT 'Concluída'");
if (!colunasVendas.has('cancelada_em')) db.exec('ALTER TABLE vendas ADD COLUMN cancelada_em DATETIME');
if (!colunasVendas.has('cancelamento_motivo')) db.exec('ALTER TABLE vendas ADD COLUMN cancelamento_motivo TEXT');

/*
    ==================================================
    TABELA ITENS DA VENDA
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS itens_venda (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        venda_id INTEGER NOT NULL,

        produto_id INTEGER NOT NULL,

        quantidade INTEGER NOT NULL DEFAULT 1,

        preco_unitario REAL NOT NULL DEFAULT 0,

        subtotal REAL NOT NULL DEFAULT 0,

        FOREIGN KEY (venda_id)
            REFERENCES vendas(id)

            ON DELETE CASCADE,

        FOREIGN KEY (produto_id)
            REFERENCES produtos(id)

            ON DELETE RESTRICT

    )
`);


/*
    ==================================================
    TABELA ORDENS DE SERVIÇO
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS ordens_servico (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        numero INTEGER NOT NULL UNIQUE,

        cliente_id INTEGER,

        tipo_equipamento TEXT,

        marca TEXT,

        modelo TEXT,

        numero_serie TEXT,

        sistema_operacional TEXT,

        senha_equipamento TEXT,

        acessorios TEXT,

        estado_fisico TEXT,

        avarias TEXT,

        problema_relatado TEXT,

        diagnostico TEXT,

        servico_realizado TEXT,

        previsao_entrega DATE,

        data_conclusao DATETIME,

        data_entrega DATETIME,

        status TEXT NOT NULL DEFAULT 'Aguardando avaliação',

        valor_pecas REAL NOT NULL DEFAULT 0,

        valor_mao_obra REAL NOT NULL DEFAULT 0,

        desconto REAL NOT NULL DEFAULT 0,

        total REAL NOT NULL DEFAULT 0,

        observacoes TEXT,

        data_hora_abertura DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (cliente_id)
            REFERENCES clientes(id)

            ON DELETE SET NULL

    )
`);


/*
    ==================================================
    TABELA ITENS DA ORDEM DE SERVIÇO
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS itens_os (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        os_id INTEGER NOT NULL,

        produto_id INTEGER,

        descricao TEXT NOT NULL,

        tipo TEXT NOT NULL DEFAULT 'servico',

        quantidade INTEGER NOT NULL DEFAULT 1,

        valor_unitario REAL NOT NULL DEFAULT 0,

        subtotal REAL NOT NULL DEFAULT 0,

        FOREIGN KEY (os_id)
            REFERENCES ordens_servico(id)

            ON DELETE CASCADE,

        FOREIGN KEY (produto_id)
            REFERENCES produtos(id)

            ON DELETE RESTRICT

    )
`);


/*
    ==================================================
    TABELA GARANTIAS
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS garantias (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        venda_id INTEGER,

        os_id INTEGER,

        cliente_id INTEGER NOT NULL,

        produto_id INTEGER,

        descricao TEXT,

        prazo_dias INTEGER NOT NULL DEFAULT 90,

        data_inicio DATETIME NOT NULL,

        data_fim DATETIME NOT NULL,

        status TEXT NOT NULL DEFAULT 'Ativa',

        observacoes TEXT,

        cobertura TEXT,

        exclusoes TEXT,

        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (venda_id)
            REFERENCES vendas(id)

            ON DELETE CASCADE,

        FOREIGN KEY (os_id)
            REFERENCES ordens_servico(id)

            ON DELETE CASCADE,

        FOREIGN KEY (cliente_id)
            REFERENCES clientes(id)

            ON DELETE CASCADE,

        FOREIGN KEY (produto_id)
            REFERENCES produtos(id)

            ON DELETE SET NULL

    )
`);

// Migração compatível com bancos já existentes: adiciona campos opcionais do termo profissional.
const colunasGarantias = new Set(db.prepare('PRAGMA table_info(garantias)').all().map(coluna => coluna.name));
if (!colunasGarantias.has('cobertura')) db.exec('ALTER TABLE garantias ADD COLUMN cobertura TEXT');
if (!colunasGarantias.has('exclusoes')) db.exec('ALTER TABLE garantias ADD COLUMN exclusoes TEXT');

/*
    ==================================================
    TABELA USUÁRIOS
    ==================================================
*/

db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (

        id INTEGER PRIMARY KEY AUTOINCREMENT,

        nome TEXT NOT NULL,

        usuario TEXT NOT NULL UNIQUE,

        senha_hash TEXT NOT NULL,

        senha_salt TEXT NOT NULL,

        perfil TEXT NOT NULL DEFAULT 'funcionario'
            CHECK (perfil IN ('administrador', 'funcionario')),

        ativo INTEGER NOT NULL DEFAULT 1,

        primeiro_acesso INTEGER NOT NULL DEFAULT 1,

        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,

        atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);


/*
    ==================================================
    MENSAGENS DO BANCO
    ==================================================
*/

console.log('Banco de dados conectado!');
console.log('Tabela produtos pronta!');
console.log('SKU e código de barras preparados!');
console.log('Tabela clientes pronta!');
console.log('Telefone e celular preparados!');
console.log('Tabela vendas pronta!');
console.log('Tabela itens_venda pronta!');
console.log('Tabela ordens_servico pronta!');
console.log('Tabela itens_os pronta!');
console.log('Tabela garantias pronta!');
console.log('Tabela usuarios pronta!');


/*
    ==================================================
    EXPORTAR BANCO
    ==================================================
*/

module.exports = db;
