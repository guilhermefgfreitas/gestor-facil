/* Verifica conexão, esquema e estado de configuração sem alterar a base. */
const { criarConexaoFirebird } = require('../database/firebird/conexao');
const { obterEstadoInicializacaoFirebird } = require('../database/firebird/inicializacao');

function obrigatoria(nome) {
    const valor = String(process.env[nome] || '').trim();
    if (!valor) throw new Error(`Defina a variável ${nome}.`);
    return valor;
}

async function executar() {
    const config = {
        host: obrigatoria('GESTOR_FIREBIRD_HOST'),
        port: Number(process.env.GESTOR_FIREBIRD_PORT || 3050),
        database: obrigatoria('GESTOR_FIREBIRD_DATABASE'),
        user: obrigatoria('GESTOR_FIREBIRD_USER'),
        password: obrigatoria('GESTOR_FIREBIRD_PASSWORD'),
        timeoutMs: 10000
    };

    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        throw new Error('GESTOR_FIREBIRD_PORT deve estar entre 1 e 65535.');
    }
    if (config.user.toUpperCase() === 'SYSDBA') {
        throw new Error('Use uma conta restrita do Gestor Fácil, não SYSDBA.');
    }

    const banco = criarConexaoFirebird(config, { timeoutMs: config.timeoutMs });
    try {
        const linha = await banco.consultarUm(
            "SELECT CURRENT_USER AS usuario, RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS versao FROM RDB$DATABASE"
        );
        const valores = Object.fromEntries(Object.entries(linha || {}).map(([chave, valor]) => [chave.toLowerCase(), valor]));
        console.log('Conexão Firebird estabelecida com sucesso.');
        console.log(`Servidor: ${config.host}:${config.port}`);
        console.log(`Base/alias: ${config.database}`);
        console.log(`Usuário conectado: ${valores.usuario || config.user}`);
        console.log(`Versão do Firebird: ${String(valores.versao || '').trim() || 'não informada'}`);
        try {
            const estado = await obterEstadoInicializacaoFirebird(banco);
            console.log(`Esquema do Gestor Fácil: íntegro (${estado.quantidadeUsuarios} usuário(s)).`);
            console.log(estado.precisaConfigurarAdministrador
                ? 'Estado: aguardando a configuração do primeiro administrador.'
                : 'Estado: administrador já configurado.');
        } catch (erroEsquema) {
            console.log(`Esquema/configuração do Gestor Fácil: ${erroEsquema.message}`);
        }
        console.log('Este diagnóstico apenas consultou o servidor; nenhum dado foi alterado.');
    } finally {
        await banco.fechar();
    }
}

executar().catch(erro => {
    console.error(`Falha na conexão Firebird: ${erro.message}`);
    console.error('Confira se o serviço está iniciado, se host/alias/usuário estão corretos e se a porta TCP está liberada na rede local.');
    process.exitCode = 1;
});
