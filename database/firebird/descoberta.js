/* Descoberta do servidor Firebird na rede local via UDP; nunca envia credenciais. */
const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');

const PORTA_DESCOBERTA = 45876;
const PORTA_PAREAMENTO = 45877;
const PROTOCOLO = 'gestor-facil-firebird';
const VERSAO_PROTOCOLO = 1;

function inteiroIpv4(endereco) {
    const partes = String(endereco || '').split('.');
    if (partes.length !== 4 || partes.some(parte => !/^\d{1,3}$/.test(parte) || Number(parte) > 255)) return null;
    return partes.reduce((total, parte) => ((total << 8) | Number(parte)) >>> 0, 0);
}

function broadcastIpv4(endereco, mascara) {
    const ip = inteiroIpv4(endereco);
    const mask = inteiroIpv4(mascara);
    if (ip === null || mask === null) return null;
    const valor = (ip | (~mask >>> 0)) >>> 0;
    return [24, 16, 8, 0]
        .map(deslocamento => (valor >>> deslocamento) & 255).join('.');
}

function obterBroadcasts() {
    const broadcasts = new Set(['255.255.255.255']);
    for (const enderecos of Object.values(os.networkInterfaces())) {
        for (const endereco of enderecos || []) {
            if (endereco.family !== 'IPv4' || endereco.internal) continue;
            const broadcast = broadcastIpv4(endereco.address, endereco.netmask);
            if (broadcast && broadcast !== endereco.address) broadcasts.add(broadcast);
        }
    }
    return [...broadcasts];
}

function textoCurto(valor, maximo, campo) {
    const texto = String(valor || '').trim();
    if (!texto || texto.length > maximo || /[\r\n\0]/.test(texto)) {
        throw new Error(`O campo ${campo} da descoberta Firebird é inválido.`);
    }
    return texto;
}

function validarPorta(valor, campo) {
    const porta = Number(valor);
    if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
        throw new Error(`A porta ${campo} deve estar entre 1 e 65535.`);
    }
    return porta;
}

function criarAnunciador({ id, nome, portaFirebird = 3050, portaPareamento = PORTA_PAREAMENTO, alias }) {
    const servidor = {
        protocolo: PROTOCOLO,
        versao: VERSAO_PROTOCOLO,
        id: textoCurto(id || crypto.randomUUID(), 80, 'id'),
        nome: textoCurto(nome || os.hostname(), 100, 'nome'),
        porta: validarPorta(portaFirebird, 'Firebird'),
        portaPareamento: validarPorta(portaPareamento, 'pareamento'),
        alias: textoCurto(alias, 128, 'alias')
    };

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let iniciado = false;
    socket.on('message', (mensagem, origem) => {
        let pedido;
        try { pedido = JSON.parse(mensagem.toString('utf8')); } catch (_) { return; }
        if (pedido?.protocolo !== PROTOCOLO || pedido?.versao !== VERSAO_PROTOCOLO || pedido?.tipo !== 'procurar') return;
        if (typeof pedido.nonce !== 'string' || pedido.nonce.length < 16 || pedido.nonce.length > 100) return;

        const resposta = Buffer.from(JSON.stringify({
            ...servidor,
            tipo: 'servidor',
            nonce: pedido.nonce
        }));
        socket.send(resposta, origem.port, origem.address, erro => {
            if (erro) console.warn('Não foi possível responder à descoberta Firebird:', erro.message);
        });
    });

    return {
        iniciar() {
            if (iniciado) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const falha = erro => {
                    socket.removeListener('listening', pronto);
                    reject(erro);
                };
                const pronto = () => {
                    socket.removeListener('error', falha);
                    iniciado = true;
                    resolve();
                };
                socket.once('error', falha);
                socket.once('listening', pronto);
                socket.bind(PORTA_DESCOBERTA, '0.0.0.0');
            });
        },
        async fechar() {
            if (!iniciado) return;
            iniciado = false;
            await new Promise(resolve => socket.close(resolve));
        }
    };
}

function descobrirServidores({ tempoLimiteMs = 2200 } = {}) {
    const limite = Math.max(300, Math.min(10000, Number(tempoLimiteMs) || 2200));
    const nonce = crypto.randomBytes(18).toString('hex');
    const pedido = Buffer.from(JSON.stringify({
        protocolo: PROTOCOLO,
        versao: VERSAO_PROTOCOLO,
        tipo: 'procurar',
        nonce
    }));

    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const encontrados = new Map();
        let finalizado = false;
        const encerrar = erro => {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(relogio);
            try { socket.close(); } catch (_) {}
            if (erro) reject(erro);
            else resolve([...encontrados.values()]);
        };

        const relogio = setTimeout(() => encerrar(), limite);
        socket.on('error', erro => encerrar(erro));
        socket.on('message', (mensagem, origem) => {
            let resposta;
            try { resposta = JSON.parse(mensagem.toString('utf8')); } catch (_) { return; }
            if (resposta?.protocolo !== PROTOCOLO || resposta?.versao !== VERSAO_PROTOCOLO ||
                resposta?.tipo !== 'servidor' || resposta?.nonce !== nonce ||
                typeof resposta.id !== 'string' || typeof resposta.nome !== 'string' ||
                typeof resposta.alias !== 'string') return;
            try {
                const servidor = {
                    id: textoCurto(resposta.id, 80, 'id'),
                    nome: textoCurto(resposta.nome, 100, 'nome'),
                    host: origem.address,
                    porta: validarPorta(resposta.porta, 'Firebird'),
                    portaPareamento: validarPorta(resposta.portaPareamento, 'pareamento'),
                    alias: textoCurto(resposta.alias, 128, 'alias')
                };
                encontrados.set(servidor.id, servidor);
            } catch (_) { /* Ignora respostas malformadas. */ }
        });
        socket.bind(0, '0.0.0.0', () => {
            try {
                socket.setBroadcast(true);
                for (const broadcast of obterBroadcasts()) {
                    socket.send(pedido, PORTA_DESCOBERTA, broadcast, () => {});
                }
            } catch (erro) { encerrar(erro); }
        });
    });
}

module.exports = { PORTA_DESCOBERTA, PORTA_PAREAMENTO, criarAnunciador, descobrirServidores };
