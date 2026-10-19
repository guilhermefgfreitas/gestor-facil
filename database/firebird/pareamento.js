/* Pareamento local autenticado; a descoberta UDP nunca transporta credenciais. */
const net = require('node:net');
const crypto = require('node:crypto');

const PROTOCOLO = 'gestor-facil-pareamento-v1';
const PORTA_PAREAMENTO = 45877;
const TEMPO_CODIGO_MS = 5 * 60 * 1000;
const LIMITE_MENSAGEM = 8192;

function hmac(chave, texto) {
    return crypto.createHmac('sha256', chave).update(texto).digest();
}

function derivarChave(segredo, nonceCliente, nonceServidor) {
    const salt = Buffer.concat([Buffer.from(nonceCliente, 'hex'), Buffer.from(nonceServidor, 'hex')]);
    return Buffer.from(crypto.hkdfSync('sha256', segredo, salt, PROTOCOLO, 32));
}

function montarAad(id, nonceCliente, nonceServidor) {
    return Buffer.from(`${PROTOCOLO}|${id}|${nonceCliente}|${nonceServidor}`, 'utf8');
}

function criarServidorPareamento(obterConfiguracao) {
    const codigos = new Map();
    const servidor = net.createServer(socket => {
        socket.setTimeout(10000, () => socket.destroy());
        let acumulado = Buffer.alloc(0);
        let processado = false;
        socket.on('data', dados => {
            if (processado) return;
            acumulado = Buffer.concat([acumulado, dados]);
            if (acumulado.length > LIMITE_MENSAGEM) return socket.destroy();
            const fim = acumulado.indexOf(10);
            if (fim < 0) return;
            processado = true;

            let pedido;
            try { pedido = JSON.parse(acumulado.subarray(0, fim).toString('utf8')); }
            catch (_) { return socket.destroy(); }

            const entrada = codigos.get(String(pedido?.id || ''));
            const nonceCliente = String(pedido?.nonce || '');
            if (!entrada || entrada.expira < Date.now() || pedido?.protocolo !== PROTOCOLO || !/^[a-f0-9]{64}$/i.test(nonceCliente)) {
                if (entrada) codigos.delete(String(pedido.id));
                return socket.destroy();
            }
            const esperado = hmac(entrada.segredo, `${PROTOCOLO}|${pedido.id}|${nonceCliente}`);
            let recebido;
            try { recebido = Buffer.from(String(pedido.prova || ''), 'hex'); } catch (_) { return socket.destroy(); }
            if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) return socket.destroy();

            // O código é de uso único e expira mesmo se o cliente desconectar.
            codigos.delete(String(pedido.id));
            try {
                const config = obterConfiguracao();
                const nonceServidor = crypto.randomBytes(32).toString('hex');
                const chave = derivarChave(entrada.segredo, nonceCliente, nonceServidor);
                const iv = crypto.randomBytes(12);
                const aad = montarAad(String(pedido.id), nonceCliente, nonceServidor);
                const cifra = crypto.createCipheriv('aes-256-gcm', chave, iv);
                cifra.setAAD(aad);
                const dados = Buffer.concat([
                    cifra.update(JSON.stringify({
                        protocolo: PROTOCOLO,
                        serverId: String(config.serverId || ''),
                        port: Number(config.port || 3050),
                        database: String(config.database || ''),
                        user: String(config.user || ''),
                        password: String(config.password || '')
                    }), 'utf8'),
                    cifra.final()
                ]);
                socket.end(JSON.stringify({
                    protocolo: PROTOCOLO,
                    nonceServidor,
                    iv: iv.toString('hex'),
                    tag: cifra.getAuthTag().toString('hex'),
                    dados: dados.toString('base64')
                }) + '\n');
            } catch (_) {
                socket.destroy();
            }
        });
        socket.on('error', () => {});
    });

    return {
        gerarCodigo() {
            for (const [id, entrada] of codigos) if (entrada.expira < Date.now()) codigos.delete(id);
            const id = crypto.randomBytes(8).toString('hex');
            const segredo = crypto.randomBytes(32);
            codigos.set(id, { segredo, expira: Date.now() + TEMPO_CODIGO_MS });
            return `${id}.${segredo.toString('hex')}`;
        },
        iniciar() {
            if (servidor.listening) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const erroInicial = erro => { servidor.removeListener('listening', pronto); reject(erro); };
                const pronto = () => { servidor.removeListener('error', erroInicial); resolve(); };
                servidor.once('error', erroInicial);
                servidor.once('listening', pronto);
                servidor.listen(PORTA_PAREAMENTO, '0.0.0.0');
            });
        },
        fechar() {
            codigos.clear();
            if (!servidor.listening) return Promise.resolve();
            return new Promise(resolve => servidor.close(() => resolve()));
        }
    };
}

function parearComServidor({ host, portaPareamento = PORTA_PAREAMENTO, codigo, serverId, timeoutMs = 10000 }) {
    const partes = String(codigo || '').trim().split('.');
    if (partes.length !== 2 || !/^[a-f0-9]{16}$/i.test(partes[0]) || !/^[a-f0-9]{64}$/i.test(partes[1])) {
        return Promise.reject(new Error('O código de pareamento está inválido ou expirou.'));
    }
    const [id, segredoHex] = partes;
    const segredo = Buffer.from(segredoHex, 'hex');
    const nonceCliente = crypto.randomBytes(32).toString('hex');
    const prova = hmac(segredo, `${PROTOCOLO}|${id}|${nonceCliente}`).toString('hex');

    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: Number(portaPareamento) });
        let acumulado = Buffer.alloc(0);
        let concluido = false;
        const encerrar = (erro, resultado) => {
            if (concluido) return;
            concluido = true;
            clearTimeout(relogio);
            socket.destroy();
            if (erro) reject(erro);
            else resolve(resultado);
        };
        const relogio = setTimeout(() => encerrar(new Error('Tempo esgotado ao parear com o servidor.')), timeoutMs);
        socket.once('error', () => encerrar(new Error('Não foi possível alcançar o servidor. Confirme se os computadores estão na mesma rede local, se a rede do Windows no servidor está definida como Privada e se o firewall permite o Gestor Fácil na porta 45877.')));
        socket.once('connect', () => socket.write(JSON.stringify({ protocolo: PROTOCOLO, id, nonce: nonceCliente, prova }) + '\n'));
        socket.on('data', dados => {
            acumulado = Buffer.concat([acumulado, dados]);
            if (acumulado.length > LIMITE_MENSAGEM) return encerrar(new Error('Resposta inválida do servidor.'));
            const fim = acumulado.indexOf(10);
            if (fim < 0) return;
            try {
                const resposta = JSON.parse(acumulado.subarray(0, fim).toString('utf8'));
                if (resposta.protocolo !== PROTOCOLO || !/^[a-f0-9]{64}$/i.test(resposta.nonceServidor || '') ||
                    !/^[a-f0-9]{24}$/i.test(resposta.iv || '') || !/^[a-f0-9]{32}$/i.test(resposta.tag || '')) {
                    throw new Error('Resposta de pareamento inválida.');
                }
                const chave = derivarChave(segredo, nonceCliente, resposta.nonceServidor);
                const decifra = crypto.createDecipheriv('aes-256-gcm', chave, Buffer.from(resposta.iv, 'hex'));
                decifra.setAAD(montarAad(id, nonceCliente, resposta.nonceServidor));
                decifra.setAuthTag(Buffer.from(resposta.tag, 'hex'));
                const claro = Buffer.concat([decifra.update(Buffer.from(resposta.dados, 'base64')), decifra.final()]);
                const config = JSON.parse(claro.toString('utf8'));
                if (config.protocolo !== PROTOCOLO || config.serverId !== serverId || !config.user || !config.password || !config.database) {
                    throw new Error('O código pertence a outro servidor ou a configuração está incompleta.');
                }
                encerrar(null, { ...config, host, papel: 'cliente', anunciar: false });
            } catch (_) {
                encerrar(new Error('O código expirou, já foi usado ou não corresponde a este servidor.'));
            }
        });
    });
}

module.exports = { PORTA_PAREAMENTO, criarServidorPareamento, parearComServidor };
