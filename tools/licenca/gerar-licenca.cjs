const { gerarLicenca } = require('./app/license-core.cjs');

function argumento(nome) {
    const indice = process.argv.indexOf(`--${nome}`);
    return indice < 0 ? null : process.argv[indice + 1];
}

try {
    const codigo = gerarLicenca({
        cliente: argumento('cliente'),
        maquina: argumento('maquina'),
        dias: argumento('dias')
    });
    console.log(codigo);
} catch (erro) {
    console.error(erro.message);
    process.exit(1);
}
