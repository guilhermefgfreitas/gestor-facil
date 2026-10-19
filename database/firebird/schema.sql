-- Gestor Fácil - esquema inicial Firebird 5
-- Executar uma única vez em uma base Firebird vazia, usando uma conta de implantação.
-- Crie a base com DEFAULT CHARACTER SET UTF8 antes de executar este arquivo.
-- O aplicativo deve conectar com um usuário restrito, nunca com SYSDBA.

-- Marcador singleton para permitir somente uma configuração inicial do admin.
CREATE TABLE configuracao_sistema (
    id SMALLINT NOT NULL PRIMARY KEY,
    administrador_configurado SMALLINT DEFAULT 0 NOT NULL
        CHECK (administrador_configurado IN (0, 1))
);

INSERT INTO configuracao_sistema (id, administrador_configurado) VALUES (1, 0);

CREATE TABLE produtos (
    id INTEGER NOT NULL PRIMARY KEY,
    nome VARCHAR(200) NOT NULL,
    codigo VARCHAR(100),
    sku VARCHAR(100),
    codigo_barras VARCHAR(80),
    categoria VARCHAR(120),
    preco_custo DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    preco_venda DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    estoque INTEGER DEFAULT 0 NOT NULL,
    estoque_minimo INTEGER DEFAULT 0 NOT NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX uq_produtos_sku ON produtos (sku);
CREATE UNIQUE INDEX uq_produtos_cod_barras ON produtos (codigo_barras);

CREATE TABLE clientes (
    id INTEGER NOT NULL PRIMARY KEY,
    nome VARCHAR(200) NOT NULL,
    cpf_cnpj VARCHAR(30),
    telefone VARCHAR(40),
    celular VARCHAR(40),
    email VARCHAR(254),
    cep VARCHAR(20),
    endereco VARCHAR(250),
    numero VARCHAR(40),
    complemento VARCHAR(150),
    bairro VARCHAR(120),
    cidade VARCHAR(120),
    estado VARCHAR(2),
    observacoes BLOB SUB_TYPE TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX uq_clientes_documento ON clientes (cpf_cnpj);

CREATE TABLE vendas (
    id INTEGER NOT NULL PRIMARY KEY,
    numero INTEGER NOT NULL UNIQUE,
    cliente_id INTEGER,
    subtotal DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    desconto DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    total DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    forma_pagamento VARCHAR(80),
    observacoes BLOB SUB_TYPE TEXT,
    status VARCHAR(40) DEFAULT 'Concluída' NOT NULL,
    cancelada_em TIMESTAMP,
    cancelamento_motivo BLOB SUB_TYPE TEXT,
    data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vendas_cliente FOREIGN KEY (cliente_id)
        REFERENCES clientes (id) ON DELETE SET NULL
);

CREATE TABLE itens_venda (
    id INTEGER NOT NULL PRIMARY KEY,
    venda_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    quantidade INTEGER DEFAULT 1 NOT NULL,
    preco_unitario DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    subtotal DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    CONSTRAINT fk_itens_venda_venda FOREIGN KEY (venda_id)
        REFERENCES vendas (id) ON DELETE CASCADE,
    CONSTRAINT fk_itens_venda_produto FOREIGN KEY (produto_id)
        REFERENCES produtos (id) ON DELETE NO ACTION
);

CREATE TABLE ordens_servico (
    id INTEGER NOT NULL PRIMARY KEY,
    numero INTEGER NOT NULL UNIQUE,
    cliente_id INTEGER,
    tipo_equipamento VARCHAR(120),
    marca VARCHAR(120),
    modelo VARCHAR(160),
    numero_serie VARCHAR(160),
    sistema_operacional VARCHAR(120),
    senha_equipamento VARCHAR(500),
    acessorios BLOB SUB_TYPE TEXT,
    estado_fisico BLOB SUB_TYPE TEXT,
    avarias BLOB SUB_TYPE TEXT,
    problema_relatado BLOB SUB_TYPE TEXT,
    diagnostico BLOB SUB_TYPE TEXT,
    servico_realizado BLOB SUB_TYPE TEXT,
    previsao_entrega DATE,
    data_conclusao TIMESTAMP,
    data_entrega TIMESTAMP,
    status VARCHAR(60) DEFAULT 'Aguardando avaliação' NOT NULL,
    valor_pecas DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    valor_mao_obra DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    desconto DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    total DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    observacoes BLOB SUB_TYPE TEXT,
    data_hora_abertura TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_os_cliente FOREIGN KEY (cliente_id)
        REFERENCES clientes (id) ON DELETE SET NULL
);

CREATE TABLE itens_os (
    id INTEGER NOT NULL PRIMARY KEY,
    os_id INTEGER NOT NULL,
    produto_id INTEGER,
    descricao BLOB SUB_TYPE TEXT NOT NULL,
    tipo VARCHAR(40) DEFAULT 'servico' NOT NULL,
    quantidade INTEGER DEFAULT 1 NOT NULL,
    valor_unitario DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    subtotal DECIMAL(14, 2) DEFAULT 0 NOT NULL,
    CONSTRAINT fk_itens_os_os FOREIGN KEY (os_id)
        REFERENCES ordens_servico (id) ON DELETE CASCADE,
    CONSTRAINT fk_itens_os_produto FOREIGN KEY (produto_id)
        REFERENCES produtos (id) ON DELETE NO ACTION
);

CREATE TABLE garantias (
    id INTEGER NOT NULL PRIMARY KEY,
    venda_id INTEGER,
    os_id INTEGER,
    cliente_id INTEGER NOT NULL,
    produto_id INTEGER,
    descricao BLOB SUB_TYPE TEXT,
    prazo_dias INTEGER DEFAULT 90 NOT NULL,
    data_inicio DATE NOT NULL,
    data_fim DATE NOT NULL,
    status VARCHAR(40) DEFAULT 'Ativa' NOT NULL,
    observacoes BLOB SUB_TYPE TEXT,
    cobertura BLOB SUB_TYPE TEXT,
    exclusoes BLOB SUB_TYPE TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_garantia_venda FOREIGN KEY (venda_id)
        REFERENCES vendas (id) ON DELETE CASCADE,
    CONSTRAINT fk_garantia_os FOREIGN KEY (os_id)
        REFERENCES ordens_servico (id) ON DELETE CASCADE,
    CONSTRAINT fk_garantia_cliente FOREIGN KEY (cliente_id)
        REFERENCES clientes (id) ON DELETE CASCADE,
    CONSTRAINT fk_garantia_produto FOREIGN KEY (produto_id)
        REFERENCES produtos (id) ON DELETE SET NULL
);

CREATE TABLE garantia_itens (
    id INTEGER NOT NULL PRIMARY KEY,
    garantia_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    CONSTRAINT fk_garantia_itens_garantia FOREIGN KEY (garantia_id)
        REFERENCES garantias (id) ON DELETE CASCADE,
    CONSTRAINT fk_garantia_itens_produto FOREIGN KEY (produto_id)
        REFERENCES produtos (id) ON DELETE NO ACTION
);

CREATE TABLE usuarios (
    id INTEGER NOT NULL PRIMARY KEY,
    nome VARCHAR(200) NOT NULL,
    usuario VARCHAR(100) NOT NULL UNIQUE,
    senha_hash VARCHAR(256) NOT NULL,
    senha_salt VARCHAR(128) NOT NULL,
    perfil VARCHAR(30) DEFAULT 'funcionario' NOT NULL
        CHECK (perfil IN ('administrador', 'funcionario')),
    ativo SMALLINT DEFAULT 1 NOT NULL CHECK (ativo IN (0, 1)),
    primeiro_acesso SMALLINT DEFAULT 1 NOT NULL CHECK (primeiro_acesso IN (0, 1)),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- O login é comparado sem distinção entre maiúsculas e minúsculas no app.
-- O índice computado também fecha a condição de corrida entre estações.
CREATE UNIQUE INDEX uq_usuarios_usuario_ci ON usuarios COMPUTED BY (UPPER(usuario));

CREATE TABLE permissoes_usuarios (
    id INTEGER NOT NULL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    modulo VARCHAR(60) NOT NULL,
    consultar SMALLINT DEFAULT 0 NOT NULL CHECK (consultar IN (0, 1)),
    criar SMALLINT DEFAULT 0 NOT NULL CHECK (criar IN (0, 1)),
    editar SMALLINT DEFAULT 0 NOT NULL CHECK (editar IN (0, 1)),
    excluir SMALLINT DEFAULT 0 NOT NULL CHECK (excluir IN (0, 1)),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_permissao_usuario_modulo UNIQUE (usuario_id, modulo),
    CONSTRAINT fk_permissao_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuarios (id) ON DELETE CASCADE
);

CREATE TABLE movimentacoes_estoque (
    id INTEGER NOT NULL PRIMARY KEY,
    produto_id INTEGER NOT NULL,
    tipo VARCHAR(40) NOT NULL,
    quantidade INTEGER NOT NULL,
    estoque_anterior INTEGER NOT NULL,
    estoque_posterior INTEGER NOT NULL,
    motivo BLOB SUB_TYPE TEXT,
    origem VARCHAR(80),
    origem_id INTEGER,
    data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mov_estoque_produto FOREIGN KEY (produto_id)
        REFERENCES produtos (id) ON DELETE NO ACTION
);

CREATE TABLE auditoria (
    id INTEGER NOT NULL PRIMARY KEY,
    usuario_id INTEGER,
    usuario_nome VARCHAR(200),
    usuario_login VARCHAR(100),
    perfil VARCHAR(30),
    acao VARCHAR(80) NOT NULL,
    modulo VARCHAR(80),
    descricao BLOB SUB_TYPE TEXT NOT NULL,
    entidade_tipo VARCHAR(80),
    entidade_id INTEGER,
    data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    dados_antes BLOB SUB_TYPE TEXT,
    dados_depois BLOB SUB_TYPE TEXT
);

-- Sequências controladas por triggers geram IDs nas operações normais e
-- acompanham IDs explícitos durante a importação inicial do SQLite.
CREATE SEQUENCE gen_produtos_id;
CREATE SEQUENCE gen_clientes_id;
CREATE SEQUENCE gen_vendas_id;
CREATE SEQUENCE gen_itens_venda_id;
CREATE SEQUENCE gen_ordens_servico_id;
CREATE SEQUENCE gen_itens_os_id;
CREATE SEQUENCE gen_garantias_id;
CREATE SEQUENCE gen_garantia_itens_id;
CREATE SEQUENCE gen_usuarios_id;
CREATE SEQUENCE gen_permissoes_usuarios_id;
CREATE SEQUENCE gen_movimentacoes_estoque_id;
CREATE SEQUENCE gen_auditoria_id;

SET TERM ^ ;

CREATE TRIGGER bi_gf_produtos_id FOR produtos ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_produtos_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_produtos_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_produtos_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_clientes_id FOR clientes ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_clientes_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_clientes_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_clientes_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_vendas_id FOR vendas ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_vendas_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_vendas_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_vendas_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_itens_venda_id FOR itens_venda ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_itens_venda_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_itens_venda_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_itens_venda_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_ordens_servico_id FOR ordens_servico ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_ordens_servico_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_ordens_servico_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_ordens_servico_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_itens_os_id FOR itens_os ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_itens_os_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_itens_os_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_itens_os_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_garantias_id FOR garantias ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_garantias_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_garantias_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_garantias_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_garantia_itens_id FOR garantia_itens ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_garantia_itens_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_garantia_itens_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_garantia_itens_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_usuarios_id FOR usuarios ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_usuarios_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_usuarios_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_usuarios_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_permissoes_id FOR permissoes_usuarios ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_permissoes_usuarios_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_permissoes_usuarios_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_permissoes_usuarios_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_movimentacoes_id FOR movimentacoes_estoque ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_movimentacoes_estoque_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_movimentacoes_estoque_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_movimentacoes_estoque_id, NEW.id - id_atual);
    END
END^

CREATE TRIGGER bi_gf_auditoria_id FOR auditoria ACTIVE BEFORE INSERT POSITION 0
AS
DECLARE VARIABLE id_atual INTEGER;
BEGIN
    IF (NEW.id IS NULL) THEN NEW.id = GEN_ID(gen_auditoria_id, 1);
    ELSE BEGIN
        id_atual = GEN_ID(gen_auditoria_id, 0);
        IF (NEW.id > id_atual) THEN id_atual = GEN_ID(gen_auditoria_id, NEW.id - id_atual);
    END
END^

SET TERM ; ^

GRANT USAGE ON SEQUENCE gen_produtos_id TO TRIGGER bi_gf_produtos_id;
GRANT USAGE ON SEQUENCE gen_clientes_id TO TRIGGER bi_gf_clientes_id;
GRANT USAGE ON SEQUENCE gen_vendas_id TO TRIGGER bi_gf_vendas_id;
GRANT USAGE ON SEQUENCE gen_itens_venda_id TO TRIGGER bi_gf_itens_venda_id;
GRANT USAGE ON SEQUENCE gen_ordens_servico_id TO TRIGGER bi_gf_ordens_servico_id;
GRANT USAGE ON SEQUENCE gen_itens_os_id TO TRIGGER bi_gf_itens_os_id;
GRANT USAGE ON SEQUENCE gen_garantias_id TO TRIGGER bi_gf_garantias_id;
GRANT USAGE ON SEQUENCE gen_garantia_itens_id TO TRIGGER bi_gf_garantia_itens_id;
GRANT USAGE ON SEQUENCE gen_usuarios_id TO TRIGGER bi_gf_usuarios_id;
GRANT USAGE ON SEQUENCE gen_permissoes_usuarios_id TO TRIGGER bi_gf_permissoes_id;
GRANT USAGE ON SEQUENCE gen_movimentacoes_estoque_id TO TRIGGER bi_gf_movimentacoes_id;
GRANT USAGE ON SEQUENCE gen_auditoria_id TO TRIGGER bi_gf_auditoria_id;

CREATE INDEX ix_vendas_cliente ON vendas (cliente_id);
CREATE INDEX ix_itens_venda_venda ON itens_venda (venda_id);
CREATE INDEX ix_itens_os_os ON itens_os (os_id);
CREATE INDEX ix_garantias_cliente ON garantias (cliente_id);
CREATE INDEX ix_mov_estoque_prod ON movimentacoes_estoque (produto_id);
CREATE INDEX ix_auditoria_data ON auditoria (data_hora);
