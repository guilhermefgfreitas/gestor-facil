/*
 * INTERFACE DO GESTOR FÁCIL
 * Este renderer monta as páginas dentro de #conteudo, chama window.api para
 * ler/gravar dados e alterna os módulos conforme as permissões do usuário.
 * Os dados persistentes e as validações finais ficam no processo principal.
 */
const conteudo = document.getElementById('conteudo');

const rodapeVersao = document.getElementById('versao-aplicativo');
if (rodapeVersao && window.api.versaoAplicativo) {
    rodapeVersao.textContent = `Versão ${window.api.versaoAplicativo}`;
}

const menuInicio = document.getElementById('menu-inicio');
const menuProdutos = document.getElementById('menu-produtos');
const menuClientes = document.getElementById('menu-clientes');
const menuVendas = document.getElementById('menu-vendas');
const menuEstoque = document.getElementById('menu-estoque');
const menuOS = document.getElementById('menu-os');
const menuGarantias = document.getElementById('menu-garantias');
const menuRelatorios = document.getElementById('menu-relatorios');
const menuUsuarios = document.getElementById('menu-usuarios');
const menuAuditoria = document.getElementById('menu-auditoria');

// ESC fecha o modal ativo usando o mesmo controle de fechamento do botão X.
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;

    const modais = document.querySelectorAll(
        '#modal-seguranca-gestor, #modal-config-backup-gestor, .modal-overlay-gestor, .vendas-modal-overlay'
    );
    const modal = modais[modais.length - 1];
    if (!modal) return;

    event.preventDefault();
    const botaoFechar = modal.querySelector('button.vendas-modal-fechar, button[id^="fechar-"]');
    if (botaoFechar) botaoFechar.click();
    else modal.remove();
});

// As datas com hora gravadas pelo SQLite sem fuso são UTC (CURRENT_TIMESTAMP).
// Convertemos para o fuso local antes de exibir ou comparar com datas locais.
function converterDataHoraLocal(valor) {
    if (!valor) return null;

    const texto = String(valor).trim();
    if (!texto) return null;

    // Datas sem horário (ex.: validade da garantia) devem permanecer no dia local informado.
    if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
        const data = new Date(`${texto}T00:00:00`);
        return Number.isNaN(data.getTime()) ? null : data;
    }

    const normalizado = texto.includes('T') ? texto : texto.replace(' ', 'T');
    const possuiFuso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalizado);
    const data = new Date(possuiFuso ? normalizado : `${normalizado}Z`);
    return Number.isNaN(data.getTime()) ? null : data;
}

function formatarDataHoraLocal(valor) {
    const data = converterDataHoraLocal(valor);
    if (!data) return '-';
    return `${data.toLocaleDateString('pt-BR')} ${data.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
    })}`;
}


/*
    ==================================================
    AUTENTICAÇÃO
    ==================================================
*/

let usuarioLogado = null;
let intervaloSincronizacaoDados = null;
let revisaoDadosCompartilhados = null;
let verificandoRevisaoDados = false;



// Consulta as permissões enviadas pelo login antes de exibir ou executar ações.
function usuarioPode(modulo, acao = 'consultar') {
    if (!usuarioLogado) return false;
    if (usuarioLogado.perfil === 'administrador') return true;
    const p = (usuarioLogado.permissoes || []).find(item => item.modulo === modulo);
    return Number(p?.[acao] || 0) === 1;
}

// Atualiza listas abertas quando outra estação grava no banco compartilhado.
async function atualizarTelaListaCompartilhada() {
    if (!usuarioLogado) return false;
    const conteudoAtual = document.getElementById('conteudo');
    if (!conteudoAtual || conteudoAtual.querySelector('form')) return false;
    if (document.querySelector('.modal-overlay-gestor, #modal-seguranca-gestor, .vendas-modal-overlay')) return false;

    const ativo = document.querySelector('.menu-item.active')?.id;
    const campoFocado = document.activeElement;
    if (campoFocado && conteudoAtual.contains(campoFocado) && /^(INPUT|SELECT|TEXTAREA)$/.test(campoFocado.tagName)) return false;

    const paginas = {
        'menu-inicio': ['dash-vendas-recentes', mostrarInicio],
        'menu-produtos': ['lista-produtos', mostrarProdutos],
        'menu-clientes': ['lista-clientes', mostrarClientes],
        'menu-os': ['lista-os', mostrarOrdensServico],
        'menu-garantias': ['lista-garantias', mostrarGarantias],
        'menu-estoque': document.getElementById('lista-historico-estoque')
            ? ['lista-historico-estoque', mostrarHistoricoEstoque]
            : ['lista-estoque', mostrarEstoque],
        'menu-relatorios': ['relatorio-total-vendas', mostrarRelatorios],
        'menu-usuarios': ['tabela-usuarios', mostrarUsuarios],
        'menu-auditoria': ['tabela-auditoria', mostrarAuditoria]
    };

    // A tela de nova venda mantém carrinho e cliente selecionado só na memória.
    // Atualizar ali apagaria a venda em andamento; o histórico pode ser recarregado.
    if (ativo === 'menu-vendas') {
        if (!document.getElementById('historico-vendas-lista')) return false;
        paginas[ativo] = ['historico-vendas-lista', mostrarHistoricoVendas];
    }

    const pagina = paginas[ativo];
    if (!pagina || !document.getElementById(pagina[0])) return false;

    const posicao = window.scrollY;
    const valores = new Map(
        [...conteudoAtual.querySelectorAll('input[id], select[id], textarea[id]')]
            .map(campo => [campo.id, campo.type === 'checkbox' ? campo.checked : campo.value])
    );
    await pagina[1]();
    for (const [id, valor] of valores) {
        const campo = document.getElementById(id);
        if (!campo) continue;
        if (campo.type === 'checkbox') campo.checked = valor;
        else campo.value = valor;
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        campo.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (ativo === 'menu-relatorios') {
        document.getElementById('aplicar-filtro-relatorio')?.click();
    }
    window.scrollTo(0, posicao);
    return true;
}

function iniciarSincronizacaoDadosCompartilhados() {
    clearInterval(intervaloSincronizacaoDados);
    revisaoDadosCompartilhados = null;

    const verificar = async () => {
        if (!usuarioLogado || verificandoRevisaoDados) return;
        verificandoRevisaoDados = true;
        try {
            const resposta = await window.api.obterRevisaoDadosCompartilhados();
            if (!resposta?.sucesso) return;
            const revisao = Number(resposta.revisao || 0);
            if (revisaoDadosCompartilhados === null) {
                revisaoDadosCompartilhados = revisao;
                return;
            }
            if (revisao === revisaoDadosCompartilhados) return;
            if (await atualizarTelaListaCompartilhada()) revisaoDadosCompartilhados = revisao;
        } catch (erro) {
            // Uma falha temporária de rede não deve interromper a tela;
            // a próxima consulta tenta sincronizar novamente.
            console.warn('Não foi possível verificar alterações de outra estação:', erro?.message || erro);
        } finally {
            verificandoRevisaoDados = false;
        }
    };

    verificar();
    intervaloSincronizacaoDados = setInterval(verificar, 1000);
}

// Esconde módulos sem acesso; a autorização definitiva também é verificada no main.js.
function atualizarInterfacePermissoes() {
    const admin = usuarioLogado?.perfil === 'administrador';
    if (menuUsuarios) menuUsuarios.style.display = admin ? '' : 'none';
    if (menuAuditoria) menuAuditoria.style.display = admin ? '' : 'none';
    if (!admin && menuUsuarios?.classList.contains('active')) mostrarInicio();

    const menuMap = [
        ['menu-inicio', 'dashboard'],
        ['menu-produtos', 'produtos'],
        ['menu-clientes', 'clientes'],
        ['menu-vendas', 'vendas'],
        ['menu-os', 'os'],
        ['menu-garantias', 'garantias'],
        ['menu-estoque', 'estoque'],
        ['menu-relatorios', 'relatorios']
    ];
    for (const [id, modulo] of menuMap) {
        const el = document.getElementById(id);
        if (el) el.style.display = usuarioPode(modulo) ? '' : 'none';
    }
}

function acaoNegada() {
    alert('Seu usuário não possui permissão para realizar esta ação.');
}

function escaparLogin(texto) {

    return String(texto || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

}

// Mensagem visual não bloqueante para avisos de estado da interface.
function mostrarToast(mensagem, tipo = 'sucesso') {
    let container = document.getElementById('gf-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'gf-toast-container';
        container.className = 'gf-toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `gf-toast ${tipo}`;
    toast.textContent = String(mensagem || '');
    container.appendChild(toast);
    window.setTimeout(() => {
        toast.remove();
        if (!container.childElementCount) container.remove();
    }, 4200);
}

let atualizacaoBaixada = false;

function configurarBotaoAtualizacoes() {
    const botao = document.getElementById('botao-atualizacoes');
    const texto = document.getElementById('texto-atualizacoes');
    if (!botao || !texto) return;
    botao.style.display = 'inline-flex';
    if (botao.dataset.configurado === '1') return;
    botao.dataset.configurado = '1';

    botao.addEventListener('click', async () => {
        if (atualizacaoBaixada) {
            if (!window.confirm('A atualização foi baixada. Deseja reiniciar o Gestor Fácil para instalá-la agora?')) return;
            texto.textContent = 'Reiniciando...';
            botao.disabled = true;
            const resultado = await window.api.instalarAtualizacao();
            if (!resultado?.sucesso) {
                botao.disabled = false;
                texto.textContent = 'Reiniciar para atualizar';
                mostrarToast('Não foi possível iniciar a instalação. Tente novamente.', 'erro');
            }
            return;
        }

        botao.disabled = true;
        texto.textContent = 'Verificando...';
        try {
            const resultado = await window.api.verificarAtualizacoes();
            if (resultado?.desenvolvimento) {
                botao.disabled = false;
                texto.textContent = 'Verificar atualizações';
                mostrarToast('A verificação fica disponível na versão instalada do Gestor Fácil.', 'info');
            } else if (!resultado?.sucesso) {
                botao.disabled = false;
                texto.textContent = 'Verificar atualizações';
                mostrarToast('Não foi possível consultar as atualizações. Confira sua conexão e tente novamente.', 'erro');
            }
        } catch (erro) {
            console.error('Erro ao verificar atualizações:', erro);
            botao.disabled = false;
            texto.textContent = 'Verificar atualizações';
            mostrarToast('Não foi possível consultar as atualizações.', 'erro');
        }
    });

    window.api.aoAtualizarStatus((evento) => {
        if (!evento) return;
        if (evento.status === 'verificando') {
            botao.disabled = true;
            texto.textContent = 'Verificando...';
        } else if (evento.status === 'disponivel') {
            texto.textContent = 'Preparando download...';
            mostrarToast(`Nova versão${evento.versao ? ` ${evento.versao}` : ''} encontrada. O download começou.`);
        } else if (evento.status === 'baixando') {
            botao.disabled = true;
            texto.textContent = `Baixando ${evento.percentual || 0}%`;
            botao.title = `Download da atualização: ${evento.percentual || 0}%`;
        } else if (evento.status === 'atualizado') {
            botao.disabled = false;
            texto.textContent = 'Verificar atualizações';
            mostrarToast('Você já está usando a versão mais recente.');
        } else if (evento.status === 'pronta') {
            atualizacaoBaixada = true;
            botao.disabled = false;
            texto.textContent = 'Reiniciar para atualizar';
            botao.title = 'Reinicie para concluir a atualização';
            mostrarToast(`Atualização${evento.versao ? ` ${evento.versao}` : ''} pronta para instalar.`);
        } else if (evento.status === 'erro') {
            botao.disabled = false;
            texto.textContent = 'Verificar atualizações';
            mostrarToast('Não foi possível consultar ou baixar a atualização.', 'erro');
        }
    });
}


/*
    ==================================================
    NOTIFICAÇÕES
    ==================================================
    Usa o mesmo estoque mínimo já utilizado pela dashboard.
    Não cria uma nova regra de estoque: apenas apresenta
    uma notificação global para o usuário.
*/

let intervaloNotificacoes = null;

function esconderNotificacoes() {
    const painel = document.getElementById('painel-notificacoes');
    if (painel) painel.style.display = 'none';
}

function escaparNotificacao(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Busca produtos e transforma estoque no nível mínimo em alertas do cabeçalho.
async function atualizarNotificacoes() {
    const botao = document.getElementById('botao-notificacoes');
    const badge = document.getElementById('badge-notificacoes');
    const lista = document.getElementById('lista-notificacoes');
    const resumo = document.getElementById('notificacoes-resumo');

    if (!botao || !badge || !lista || !resumo) return;

    if (!usuarioLogado || !usuarioPode('estoque')) {
        botao.style.display = 'none';
        badge.style.display = 'none';
        lista.innerHTML = '';
        resumo.textContent = 'Sem acesso ao estoque';
        return;
    }

    botao.style.display = 'flex';

    try {
        const produtos = await window.api.listarProdutos();
        const alertas = (produtos || [])
            .filter(p => Number(p.estoque || 0) <= Number(p.estoque_minimo || 0))
            .sort((a, b) => Number(a.estoque || 0) - Number(b.estoque || 0));

        badge.textContent = alertas.length > 99 ? '99+' : String(alertas.length);
        badge.style.display = alertas.length ? 'block' : 'none';

        if (!alertas.length) {
            resumo.textContent = 'Nenhum alerta de estoque';
            lista.innerHTML = `
                <div class="notificacoes-vazio">
                    <div class="icone">✅</div>
                    <strong>Estoque em dia</strong>
                    <span>Nenhum produto atingiu o estoque mínimo.</span>
                </div>
            `;
            return;
        }

        resumo.textContent = `${alertas.length} produto${alertas.length === 1 ? '' : 's'} precisa${alertas.length === 1 ? '' : 'm'} de atenção`;

        const exibidos = alertas.slice(0, 8);
        lista.innerHTML = exibidos.map(p => {
            const estoque = Number(p.estoque || 0);
            const minimo = Number(p.estoque_minimo || 0);
            const zerado = estoque <= 0;
            return `
                <div class="notificacao-item">
                    <div class="notificacao-icone ${zerado ? 'zero' : 'baixo'}">${zerado ? '🔴' : '⚠️'}</div>
                    <div class="notificacao-conteudo">
                        <strong title="${escaparNotificacao(p.nome)}">${escaparNotificacao(p.nome || 'Produto')}</strong>
                        <span>${zerado ? 'Sem estoque' : 'Estoque baixo'} · Atual: <b>${estoque}</b> · Mínimo: <b>${minimo}</b></span>
                    </div>
                </div>
            `;
        }).join('');

        if (alertas.length > exibidos.length) {
            lista.innerHTML += `<div style="padding:10px 16px;color:#6b7280;font-size:11px;text-align:center;">+ ${alertas.length - exibidos.length} outro(s) produto(s) com alerta</div>`;
        }

        lista.innerHTML += `
            <div class="notificacoes-rodape">
                <button type="button" id="notificacoes-ver-estoque">Ver estoque</button>
            </div>
        `;

        document.getElementById('notificacoes-ver-estoque')?.addEventListener('click', () => {
            esconderNotificacoes();
            mostrarEstoque();
        });

    } catch (erro) {
        console.error('Erro ao atualizar notificações:', erro);
        resumo.textContent = 'Não foi possível consultar o estoque';
        lista.innerHTML = `
            <div class="notificacoes-vazio">
                <div class="icone">⚠️</div>
                <strong>Falha ao carregar notificações</strong>
                <span>Tente novamente em alguns instantes.</span>
            </div>
        `;
    }
}

function configurarNotificacoes() {
    const botao = document.getElementById('botao-notificacoes');
    const painel = document.getElementById('painel-notificacoes');
    const fechar = document.getElementById('fechar-notificacoes');
    if (!botao || !painel || botao.dataset.configurado === '1') return;

    botao.dataset.configurado = '1';
    botao.addEventListener('click', async (event) => {
        event.stopPropagation();
        await atualizarNotificacoes();
        painel.style.display = painel.style.display === 'none' ? 'block' : 'none';
    });

    fechar?.addEventListener('click', (event) => {
        event.stopPropagation();
        esconderNotificacoes();
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('#notificacoes-wrap')) esconderNotificacoes();
    });

    atualizarNotificacoes();
    clearInterval(intervaloNotificacoes);
    intervaloNotificacoes = setInterval(atualizarNotificacoes, 15000);
}


// Encerra a sessão local e volta para o formulário de login.
function configurarBotaoLogout() {
    const usuarioTopo = document.querySelector('.user');
    if (!usuarioTopo || document.getElementById('botao-logout-gestor')) return;
    const botao = document.createElement('button');
    botao.id = 'botao-logout-gestor';
    botao.type = 'button';
    botao.textContent = '↪ Sair';
    botao.title = 'Encerrar sessão';
    botao.style.cssText = 'margin-left:12px;padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;font-size:13px;font-weight:700;cursor:pointer;';
    botao.addEventListener('click', async () => {
        if (!window.confirm('Deseja realmente sair do Gestor Fácil?')) return;
        try { await window.api.registrarLogout(); } catch (erro) { console.error('Erro ao registrar logout:', erro); }
        usuarioLogado = null; window.gestorUsuarioLogado = null;
        esconderNotificacoes();
        clearInterval(intervaloNotificacoes);
        clearInterval(intervaloSincronizacaoDados);
        revisaoDadosCompartilhados = null;
        document.getElementById('tela-login-gestor')?.remove();
        document.getElementById('botao-logout-gestor')?.remove();
        criarTelaLogin();
    });
    usuarioTopo.appendChild(botao);
}


// Exige uma licença assinada antes do login nas versões instaladas.
async function iniciarTelaInicial() {
    try {
        const estado = await window.api.obterEstadoLicenca();
        if (!estado?.ativa) {
            criarTelaAtivacao(estado || {});
            return;
        }
        const implantacao = await window.api.obterEstadoImplantacaoFirebird();
        if (implantacao?.precisaParear) {
            criarTelaPareamentoFirebird();
            return;
        }
        criarTelaLogin();
    } catch (erro) {
        console.error('Erro ao verificar licença:', erro);
        criarTelaAtivacao({ erro: 'Não foi possível verificar a licença neste computador.' });
    }
}

async function criarTelaPareamentoFirebird() {
    if (document.getElementById('tela-pareamento-firebird')) return;
    const tela = document.createElement('div');
    tela.id = 'tela-pareamento-firebird';
    tela.style.cssText = 'position:fixed;inset:0;z-index:1000000;display:flex;align-items:center;justify-content:center;padding:24px;background:linear-gradient(135deg,#f5f7fb 0%,#e9eef7 100%);font-family:Arial,sans-serif;';
    tela.innerHTML = `
        <section style="width:min(520px,100%);box-sizing:border-box;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:32px;box-shadow:0 18px 50px rgba(15,23,42,.14)">
            <div style="width:54px;height:54px;margin:0 auto 14px;border-radius:15px;display:grid;place-items:center;background:#2563eb;color:#fff;font-weight:800">GF</div>
            <h1 style="margin:0;text-align:center;color:#111827;font-size:23px">Conectar ao servidor da empresa</h1>
            <p style="margin:8px 0 22px;text-align:center;color:#64748b;font-size:14px">Esta estação usará a base Firebird compartilhada. Procure o servidor e informe o código temporário gerado por um administrador nele.</p>
            <label for="servidor-pareamento-firebird" style="display:block;margin:0 0 7px;color:#374151;font-size:13px;font-weight:700">Servidor encontrado na rede</label>
            <div style="display:flex;gap:8px;margin-bottom:16px">
                <select id="servidor-pareamento-firebird" style="flex:1;min-width:0;height:42px;border:1px solid #d1d5db;border-radius:9px;padding:0 10px;background:#fff"><option value="">Clique em procurar servidores</option></select>
                <button id="procurar-pareamento-firebird" type="button" style="border:1px solid #d1d5db;border-radius:9px;background:#fff;padding:0 12px;cursor:pointer">Procurar</button>
            </div>
            <label for="codigo-pareamento-firebird" style="display:block;margin:0 0 7px;color:#374151;font-size:13px;font-weight:700">Código temporário</label>
            <input id="codigo-pareamento-firebird" type="password" autocomplete="off" maxlength="100" placeholder="Cole o código gerado no servidor" style="width:100%;height:44px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:9px;padding:0 12px;font:13px monospace">
            <div id="erro-pareamento-firebird" role="alert" style="display:none;margin-top:12px;padding:10px 12px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13px"></div>
            <button id="conectar-pareamento-firebird" type="button" style="width:100%;height:44px;margin-top:16px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer">Conectar estação</button>
            <p style="margin:16px 0 0;text-align:center;color:#94a3b8;font-size:11px">O código expira após cinco minutos e só pode ser usado uma vez.</p>
        </section>`;
    document.body.appendChild(tela);

    const seletor = tela.querySelector('#servidor-pareamento-firebird');
    const erro = tela.querySelector('#erro-pareamento-firebird');
    const botaoProcurar = tela.querySelector('#procurar-pareamento-firebird');
    const botaoConectar = tela.querySelector('#conectar-pareamento-firebird');
    let servidores = [];
    const mostrarErro = mensagem => {
        erro.textContent = mensagem;
        erro.style.display = 'block';
    };
    const procurar = async () => {
        erro.style.display = 'none';
        botaoProcurar.disabled = true;
        botaoProcurar.textContent = 'Procurando…';
        seletor.innerHTML = '<option value="">Procurando na rede local…</option>';
        try {
            const resultado = await window.api.descobrirServidoresFirebird();
            servidores = resultado?.servidores || [];
            if (!resultado?.sucesso || !servidores.length) {
                seletor.innerHTML = '<option value="">Nenhum servidor encontrado</option>';
                mostrarErro(resultado?.mensagem || 'Nenhum servidor respondeu. Confirme se os dois computadores estão na mesma rede local, se a rede do Windows no servidor está definida como Privada e se o serviço Firebird está em execução. Depois, clique em Procurar novamente.');
                return;
            }
            seletor.innerHTML = servidores.map((servidor, indice) =>
                `<option value="${indice}">${escaparLogin(servidor.nome)} — ${escaparLogin(servidor.host)}</option>`
            ).join('');
        } catch (falha) {
            seletor.innerHTML = '<option value="">Falha na busca</option>';
            mostrarErro('Não foi possível procurar o servidor na rede local. Confirme se os dois computadores estão na mesma rede e se a rede do Windows no servidor está definida como Privada.');
        } finally {
            botaoProcurar.disabled = false;
            botaoProcurar.textContent = 'Procurar';
        }
    };
    botaoProcurar.addEventListener('click', procurar);
    botaoConectar.addEventListener('click', async () => {
        erro.style.display = 'none';
        const servidor = servidores[Number(seletor.value)];
        const codigo = tela.querySelector('#codigo-pareamento-firebird').value.trim();
        if (!servidor) return mostrarErro('Selecione o servidor da empresa.');
        if (!codigo) return mostrarErro('Informe o código temporário gerado no servidor.');
        botaoConectar.disabled = true;
        botaoConectar.textContent = 'Validando conexão…';
        try {
            const resultado = await window.api.parearEstacaoFirebird({
                host: servidor.host,
                portaPareamento: servidor.portaPareamento,
                serverId: servidor.id,
                codigo
            });
            if (!resultado?.sucesso) {
                mostrarErro(resultado?.mensagem || 'Não foi possível conectar esta estação.');
                return;
            }
            botaoConectar.textContent = 'Conectado. Abrindo…';
            window.location.reload();
        } catch (falha) {
            mostrarErro('A conexão falhou. Confira o código e tente novamente.');
        } finally {
            botaoConectar.disabled = false;
            if (botaoConectar.isConnected && botaoConectar.textContent !== 'Conectado. Abrindo…') {
                botaoConectar.textContent = 'Conectar estação';
            }
        }
    });
    await procurar();
}

function criarTelaAtivacao(estado) {
    if (document.getElementById('tela-ativacao-gestor')) return;

    const tela = document.createElement('div');
    tela.id = 'tela-ativacao-gestor';
    tela.style.cssText = 'position:fixed;inset:0;z-index:1000000;display:flex;align-items:center;justify-content:center;padding:24px;background:linear-gradient(135deg,#f5f7fb 0%,#e9eef7 100%);font-family:Arial,sans-serif;';
    tela.innerHTML = `
        <section style="width:min(480px,100%);box-sizing:border-box;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:32px;box-shadow:0 18px 50px rgba(15,23,42,.14)">
            <div style="width:54px;height:54px;margin:0 auto 14px;border-radius:15px;display:grid;place-items:center;background:#2563eb;color:#fff;font-weight:800">GF</div>
            <h1 style="margin:0;text-align:center;color:#111827;font-size:23px">Ativar Gestor Fácil</h1>
            <p style="margin:8px 0 22px;text-align:center;color:#64748b;font-size:14px">A licença é vinculada a este computador.</p>
            <label for="codigo-maquina-licenca" style="display:block;margin:0 0 7px;color:#374151;font-size:13px;font-weight:700">Código deste computador</label>
            <div style="display:flex;gap:8px;margin-bottom:18px">
                <input id="codigo-maquina-licenca" readonly value="${escaparLogin(estado.codigoMaquina || '')}" style="flex:1;min-width:0;height:42px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:9px;padding:0 11px;color:#334155;font:12px monospace">
                <button id="copiar-maquina-licenca" type="button" style="border:1px solid #d1d5db;border-radius:9px;background:#fff;padding:0 12px;cursor:pointer">Copiar</button>
            </div>
            <label for="codigo-ativacao-licenca" style="display:block;margin:0 0 7px;color:#374151;font-size:13px;font-weight:700">Código de ativação</label>
            <textarea id="codigo-ativacao-licenca" rows="4" placeholder="Cole aqui o código de licença recebido" style="width:100%;box-sizing:border-box;resize:vertical;border:1px solid #d1d5db;border-radius:9px;padding:11px;font:12px monospace"></textarea>
            <div id="erro-ativacao-licenca" role="alert" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:13px"></div>
            <button id="confirmar-ativacao-licenca" type="button" style="width:100%;height:44px;margin-top:16px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer">Ativar licença</button>
            <p style="margin:16px 0 0;text-align:center;color:#94a3b8;font-size:11px">Se precisar trocar de computador, solicite uma nova licença ao suporte.</p>
        </section>
    `;
    document.body.appendChild(tela);

    const copiar = document.getElementById('copiar-maquina-licenca');
    const codigoMaquina = document.getElementById('codigo-maquina-licenca');
    const erro = document.getElementById('erro-ativacao-licenca');
    const botao = document.getElementById('confirmar-ativacao-licenca');

    copiar.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(codigoMaquina.value);
        } catch (_) {
            codigoMaquina.focus();
            codigoMaquina.select();
            document.execCommand('copy');
        }
        copiar.textContent = 'Copiado';
    });

    botao.addEventListener('click', async () => {
        erro.style.display = 'none';
        botao.disabled = true;
        botao.textContent = 'Validando...';
        try {
            const resultado = await window.api.ativarLicenca(document.getElementById('codigo-ativacao-licenca').value);
            if (!resultado?.sucesso) {
                erro.textContent = resultado?.mensagem || 'Não foi possível ativar a licença.';
                erro.style.display = 'block';
                return;
            }
            tela.remove();
            iniciarTelaInicial();
        } catch (erroAtivacao) {
            console.error('Erro ao ativar licença:', erroAtivacao);
            erro.textContent = 'Ocorreu um erro ao validar a licença.';
            erro.style.display = 'block';
        } finally {
            botao.disabled = false;
            botao.textContent = 'Ativar licença';
        }
    });

    if (estado.erro) {
        erro.textContent = estado.erro;
        erro.style.display = 'block';
    }
}


// Desenha o formulário de autenticação e conecta o envio ao canal login.
async function criarTelaLogin() {

    if (document.getElementById('tela-login-gestor')) {
        return;
    }

    let precisaConfigurarAdministrador = false;
    try {
        const estadoInicial = await window.api.obterEstadoInicializacao();
        precisaConfigurarAdministrador = estadoInicial?.necessitaAdministrador === true;
    } catch (erro) {
        console.error('Não foi possível verificar a configuração inicial:', erro);
    }

    const tela = document.createElement('div');

    tela.id = 'tela-login-gestor';

    tela.innerHTML = `
        <style>
            #tela-login-gestor {
                position: fixed;
                inset: 0;
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 24px;
                background: linear-gradient(135deg, #f5f7fb 0%, #e9eef7 100%);
                font-family: Arial, sans-serif;
            }
            #tela-login-gestor .login-card {
                width: min(${precisaConfigurarAdministrador ? '480px' : '420px'}, 100%);
                background: #fff;
                border: 1px solid #e5e7eb;
                border-radius: 18px;
                padding: 34px;
                box-shadow: 0 18px 50px rgba(15, 23, 42, .14);
            }
            #tela-login-gestor .login-logo {
                width: 58px;
                height: 58px;
                border-radius: 15px;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 16px;
                background: #111827;
                color: #fff;
                font-size: 19px;
                font-weight: 800;
            }
            #tela-login-gestor h1 {
                margin: 0;
                text-align: center;
                color: #111827;
                font-size: 24px;
            }
            #tela-login-gestor .login-subtitulo {
                margin: 7px 0 26px;
                text-align: center;
                color: #6b7280;
                font-size: 14px;
            }
            #tela-login-gestor .login-campo {
                margin-bottom: 16px;
            }
            #tela-login-gestor label {
                display: block;
                margin-bottom: 7px;
                color: #374151;
                font-size: 13px;
                font-weight: 700;
            }
            #tela-login-gestor input {
                width: 100%;
                height: 44px;
                box-sizing: border-box;
                border: 1px solid #d1d5db;
                border-radius: 9px;
                padding: 0 13px;
                font-size: 14px;
                outline: none;
            }
            #tela-login-gestor input:focus {
                border-color: #111827;
                box-shadow: 0 0 0 3px rgba(17, 24, 39, .08);
            }
            #tela-login-gestor .senha-wrap {
                position: relative;
            }
            #tela-login-gestor .senha-wrap input {
                padding-right: 48px;
            }
            #tela-login-gestor .mostrar-senha {
                position: absolute;
                right: 7px;
                top: 7px;
                width: 32px;
                height: 30px;
                border: 0;
                background: transparent;
                cursor: pointer;
                border-radius: 6px;
            }
            #tela-login-gestor .mostrar-senha:hover {
                background: #f3f4f6;
            }
            #tela-login-gestor .login-erro {
                display: none;
                margin: 0 0 15px;
                padding: 10px 12px;
                border-radius: 8px;
                background: #fef2f2;
                border: 1px solid #fecaca;
                color: #b91c1c;
                font-size: 13px;
            }
            #tela-login-gestor .login-botao {
                width: 100%;
                height: 44px;
                border: 0;
                border-radius: 9px;
                background: #111827;
                color: #fff;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
            }
            #tela-login-gestor .login-botao:hover {
                background: #1f2937;
            }
            #tela-login-gestor .login-botao:disabled {
                opacity: .65;
                cursor: wait;
            }
            #tela-login-gestor .login-info {
                margin-top: 18px;
                padding-top: 15px;
                border-top: 1px solid #f0f0f0;
                text-align: center;
                color: #9ca3af;
                font-size: 11px;
            }
        </style>

        <div class="login-card">
            <div class="login-logo">GF</div>
            <h1>${precisaConfigurarAdministrador ? 'Configuração inicial' : 'Gestor Fácil'}</h1>
            <p class="login-subtitulo">${precisaConfigurarAdministrador ? 'Crie a conta de administrador para começar a usar o sistema.' : 'Acesse o sistema para continuar'}</p>

            <form id="form-login-gestor">
                ${precisaConfigurarAdministrador ? `
                    <div class="login-campo">
                        <label for="login-nome-admin">Nome do administrador</label>
                        <input id="login-nome-admin" type="text" maxlength="200" autocomplete="name" placeholder="Seu nome" required autofocus>
                    </div>
                ` : ''}
                <div class="login-campo">
                    <label for="login-usuario">Usuário</label>
                    <input
                        id="login-usuario"
                        type="text"
                        autocomplete="username"
                        placeholder="${precisaConfigurarAdministrador ? 'Crie um nome de usuário' : 'Digite seu usuário'}"
                        minlength="${precisaConfigurarAdministrador ? '3' : '1'}"
                        maxlength="100"
                        required
                        autofocus
                    >
                </div>

                <div class="login-campo">
                    <label for="login-senha">Senha</label>
                    <div class="senha-wrap">
                        <input
                            id="login-senha"
                            type="password"
                            autocomplete="${precisaConfigurarAdministrador ? 'new-password' : 'current-password'}"
                            minlength="${precisaConfigurarAdministrador ? '10' : '1'}"
                            placeholder="${precisaConfigurarAdministrador ? 'Crie uma senha com pelo menos 10 caracteres' : 'Digite sua senha'}"
                            required
                        >
                        <button
                            type="button"
                            class="mostrar-senha"
                            id="mostrar-senha-login"
                            title="Mostrar senha"
                        >👁️</button>
                    </div>
                </div>

                ${precisaConfigurarAdministrador ? `
                    <div class="login-campo">
                        <label for="login-confirmar-senha">Confirmar senha</label>
                        <input id="login-confirmar-senha" type="password" autocomplete="new-password" minlength="10" placeholder="Digite a senha novamente" required>
                    </div>
                ` : ''}

                <div class="login-erro" id="login-erro"></div>

                <button class="login-botao" id="botao-login" type="submit">
                    ${precisaConfigurarAdministrador ? 'Criar administrador' : 'Entrar'}
                </button>
            </form>

            ${precisaConfigurarAdministrador ? '<div class="login-info">A senha será protegida e não poderá ser recuperada pelo suporte.</div>' : ''}
        </div>
    `;

    document.body.appendChild(tela);

    const form = document.getElementById('form-login-gestor');
    const senha = document.getElementById('login-senha');
    const erro = document.getElementById('login-erro');
    const botao = document.getElementById('botao-login');
    const mostrarSenha = document.getElementById('mostrar-senha-login');

    mostrarSenha?.addEventListener('click', () => {
        const exibindo = senha.type === 'text';
        senha.type = exibindo ? 'password' : 'text';
        mostrarSenha.textContent = exibindo ? '👁️' : '🙈';
        mostrarSenha.title = exibindo ? 'Mostrar senha' : 'Ocultar senha';
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        erro.style.display = 'none';
        erro.textContent = '';
        botao.disabled = true;
        botao.textContent = precisaConfigurarAdministrador ? 'Configurando...' : 'Entrando...';

        try {
            if (precisaConfigurarAdministrador) {
                const nome = document.getElementById('login-nome-admin').value.trim();
                const usuario = document.getElementById('login-usuario').value.trim();
                const senhaConfirmacao = document.getElementById('login-confirmar-senha').value;
                if (senha.value !== senhaConfirmacao) {
                    erro.textContent = 'As senhas não coincidem.';
                    erro.style.display = 'block';
                    return;
                }
                const criacao = await window.api.configurarAdministradorInicial({ nome, usuario, senha: senha.value });
                if (!criacao?.sucesso) {
                    erro.textContent = criacao?.mensagem || 'Não foi possível criar o administrador.';
                    erro.style.display = 'block';
                    return;
                }
                tela.remove();
                await criarTelaLogin();
                const campoUsuario = document.getElementById('login-usuario');
                if (campoUsuario) campoUsuario.value = usuario;
                return;
            }

            const resultado = await window.api.login({
                usuario: document.getElementById('login-usuario').value,
                senha: senha.value
            });

            if (!resultado?.sucesso) {
                erro.textContent = resultado?.mensagem || 'Não foi possível entrar no sistema.';
                erro.style.display = 'block';
                senha.focus();
                senha.select();
                return;
            }

            usuarioLogado = resultado.usuario;
            window.gestorUsuarioLogado = usuarioLogado;

            const usuarioTopo = document.querySelector('.user');
            if (usuarioTopo) {
                usuarioTopo.dataset.usuario = usuarioLogado.usuario;
                usuarioTopo.dataset.perfil = usuarioLogado.perfil;
                const nomeTopo = usuarioTopo.querySelector('#usuario-topo-nome, strong');
                const perfilTopo = usuarioTopo.querySelector('#usuario-topo-perfil, small');
                if (nomeTopo) nomeTopo.textContent = usuarioLogado.nome;
                if (perfilTopo) perfilTopo.textContent = usuarioLogado.perfil === 'administrador' ? 'Administrador' : 'Funcionário';
                const icone = usuarioTopo.querySelector('.user-icon');
                if (icone) icone.textContent = String(usuarioLogado.nome || 'U').charAt(0).toUpperCase();
            }

            atualizarInterfacePermissoes();
            configurarBotaoLogout();
            configurarBotaoAtualizacoes();
            configurarNotificacoes();
            atualizarNotificacoes();
            tela.remove();
            mostrarInicio();
            iniciarSincronizacaoDadosCompartilhados();

        } catch (erroLogin) {
            console.error('Erro no login:', erroLogin);
            erro.textContent = 'Não foi possível conectar ao módulo de autenticação.';
            erro.style.display = 'block';
        } finally {
            botao.disabled = false;
            botao.textContent = precisaConfigurarAdministrador ? 'Criar administrador' : 'Entrar';
        }
    });

}

iniciarTelaInicial();


/*
    ==================================================
    NORMALIZAÇÃO DE TEXTO
    ==================================================
    Usada nas buscas de clientes e OS.
    Remove acentos e ignora maiúsculas/minúsculas.
*/
// Remove diferenças de acento e caixa para tornar as buscas mais tolerantes.
function normalizarTexto(texto) {

    return String(texto || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

}


/*
    ==================================================
    INÍCIO
    ==================================================
*/

// Carrega os indicadores e listas resumidas que formam o dashboard inicial.
async function mostrarInicio() {

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Dashboard</h2>
                <p>Visão geral do seu negócio</p>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button class="button" id="dashboard-nova-venda">+ Nova venda</button>
                <button class="button secondary" id="dashboard-nova-os">+ Nova OS</button>
                ${usuarioPode('clientes', 'criar') ? '<button class="button secondary" id="dashboard-novo-cliente">+ Novo cliente</button>' : ''}
            </div>
        </div>

        <div class="cards">
            <div class="card">
                <div class="card-icon green">💰</div>
                <div><span>Faturamento hoje</span><h2 id="dash-faturamento">R$ 0,00</h2></div>
            </div>
            <div class="card">
                <div class="card-icon blue">🛒</div>
                <div><span>Vendas hoje</span><h2 id="dash-vendas">0</h2></div>
            </div>
            <div class="card">
                <div class="card-icon orange">🔧</div>
                <div><span>OS em andamento</span><h2 id="dash-os">0</h2></div>
            </div>
            <div class="card">
                <div class="card-icon purple">👥</div>
                <div><span>Clientes</span><h2 id="dash-clientes">0</h2></div>
            </div>
            <div class="card">
                <div class="card-icon blue">📦</div>
                <div><span>Produtos</span><h2 id="dash-produtos">0</h2></div>
            </div>
            <div class="card">
                <div class="card-icon orange">⚠️</div>
                <div><span>Estoque baixo</span><h2 id="dash-estoque-baixo">0</h2></div>
            </div>
        </div>

        <div class="dashboard-grid" style="margin-top:20px;">
            <div class="panel">
                <div class="panel-header">
                    <div><h3>Vendas recentes</h3><span>Últimas vendas realizadas</span></div>
                    <button class="button" id="dashboard-ver-vendas">Ver vendas</button>
                </div>
                <div id="dash-vendas-recentes"></div>
            </div>

            <div class="panel">
                <div class="panel-header">
                    <div><h3>Estoque baixo</h3><span>Produtos que precisam de reposição</span></div>
                    <button class="button" id="dashboard-ver-estoque">Ver estoque</button>
                </div>
                <div id="dash-alertas-estoque"></div>
            </div>
        </div>

        <div class="dashboard-grid" style="margin-top:20px;">
            <div class="panel">
                <div class="panel-header">
                    <div><h3>Ordens de serviço recentes</h3><span>Acompanhamento das manutenções</span></div>
                    <button class="button" id="dashboard-ver-os">Ver OS</button>
                </div>
                <div id="dash-os-recentes"></div>
            </div>

            <div class="panel">
                <div class="panel-header">
                    <div><h3>Resumo do estoque</h3><span>Situação atual dos produtos</span></div>
                </div>
                <div id="dash-resumo-estoque"></div>
            </div>
        </div>
    `;

    const moeda = valor => Number(valor || 0).toLocaleString('pt-BR', {
        style: 'currency', currency: 'BRL'
    });

    const escaparDash = texto => String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const dataLocal = valor => {
        return converterDataHoraLocal(valor);
    };

    const hoje = new Date();
    const inicioHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const fimHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 23, 59, 59, 999);
    const hojeMesmoDia = valor => {
        const data = dataLocal(valor);
        return !!data && data >= inicioHoje && data <= fimHoje;
    };

    const dataHora = valor => {
        const data = dataLocal(valor);
        return data ? data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
    };

    try {
        const dadosDashboard = await window.api.obterDadosDashboard();
        if (!dadosDashboard || dadosDashboard.sucesso === false) {
            throw new Error(dadosDashboard?.mensagem || 'Não foi possível consultar os dados do dashboard.');
        }

        const vendas = Array.isArray(dadosDashboard.vendas) ? dadosDashboard.vendas : [];
        const ordens = Array.isArray(dadosDashboard.ordens) ? dadosDashboard.ordens : [];
        const produtos = Array.isArray(dadosDashboard.produtos) ? dadosDashboard.produtos : [];
        const clientes = Array.isArray(dadosDashboard.clientes) ? dadosDashboard.clientes : [];

        const vendasAtivas = (vendas || []).filter(v => !String(v.status || '').toLowerCase().includes('cancel'));
        const vendasHoje = vendasAtivas.filter(v => hojeMesmoDia(v.data_hora));
        const faturamentoHoje = vendasHoje.reduce((soma, v) => soma + Number(v.total || 0), 0);
        const ordensAbertas = (ordens || []).filter(os => !['Entregue', 'Cancelado'].includes(String(os.status || '')));
        const estoqueBaixo = (produtos || []).filter(p => Number(p.estoque || 0) <= Number(p.estoque_minimo || 0));
        const semEstoque = (produtos || []).filter(p => Number(p.estoque || 0) <= 0);
        const estoqueTotal = (produtos || []).reduce((soma, p) => soma + Number(p.estoque || 0), 0);
        const valorEstoqueVenda = (produtos || []).reduce((soma, p) => soma + (Number(p.estoque || 0) * Number(p.preco_venda || 0)), 0);

        document.getElementById('dash-faturamento').textContent = moeda(faturamentoHoje);
        document.getElementById('dash-vendas').textContent = vendasHoje.length;
        document.getElementById('dash-os').textContent = ordensAbertas.length;
        document.getElementById('dash-clientes').textContent = (clientes || []).length;
        document.getElementById('dash-produtos').textContent = (produtos || []).length;
        document.getElementById('dash-estoque-baixo').textContent = estoqueBaixo.length;

        const mapaClientes = new Map((clientes || []).map(c => [Number(c.id), c]));

        const vendasRecentes = [...vendasAtivas]
            .sort((a, b) => (dataLocal(b.data_hora)?.getTime() || 0) - (dataLocal(a.data_hora)?.getTime() || 0))
            .slice(0, 5);

        document.getElementById('dash-vendas-recentes').innerHTML = vendasRecentes.length ? `
            <div class="table-container">
                <table>
                    <thead><tr><th>Venda</th><th>Cliente</th><th>Total</th><th>Data</th></tr></thead>
                    <tbody>
                        ${vendasRecentes.map(v => {
                            const cliente = mapaClientes.get(Number(v.cliente_id));
                            return `<tr>
                                <td><strong>${escaparDash(String(v.numero ?? v.id ?? '').padStart(6, '0'))}</strong></td>
                                <td>${escaparDash(cliente?.nome || 'Consumidor não informado')}</td>
                                <td>${moeda(v.total)}</td>
                                <td>${dataHora(v.data_hora)}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        ` : `<div class="empty"><div class="empty-icon">🛒</div><h3>Nenhuma venda registrada</h3><p>As vendas realizadas aparecerão aqui.</p></div>`;

        const alertas = [...estoqueBaixo]
            .sort((a, b) => Number(a.estoque || 0) - Number(b.estoque || 0))
            .slice(0, 6);

        document.getElementById('dash-alertas-estoque').innerHTML = alertas.length ? `
            <div class="table-container">
                <table>
                    <thead><tr><th>Produto</th><th>Estoque</th><th>Mínimo</th><th>Status</th></tr></thead>
                    <tbody>
                        ${alertas.map(p => {
                            const qtd = Number(p.estoque || 0);
                            const minimo = Number(p.estoque_minimo || 0);
                            const sem = qtd <= 0;
                            return `<tr>
                                <td><strong>${escaparDash(p.nome)}</strong></td>
                                <td>${qtd}</td>
                                <td>${minimo}</td>
                                <td><span style="font-weight:700;">${sem ? 'Sem estoque' : 'Baixo'}</span></td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        ` : `<div class="empty"><div class="empty-icon">✅</div><h3>Estoque em dia</h3><p>Nenhum produto está abaixo do estoque mínimo.</p></div>`;

        const osRecentes = [...(ordens || [])]
            .sort((a, b) => (dataLocal(b.data_hora_abertura)?.getTime() || 0) - (dataLocal(a.data_hora_abertura)?.getTime() || 0))
            .slice(0, 5);

        document.getElementById('dash-os-recentes').innerHTML = osRecentes.length ? `
            <div class="table-container">
                <table>
                    <thead><tr><th>OS</th><th>Cliente</th><th>Equipamento</th><th>Status</th></tr></thead>
                    <tbody>
                        ${osRecentes.map(os => {
                            const cliente = mapaClientes.get(Number(os.cliente_id));
                            const equipamento = [os.tipo_equipamento, os.marca, os.modelo].filter(Boolean).join(' ');
                            return `<tr>
                                <td><strong>OS ${escaparDash(String(os.numero ?? os.id ?? '').padStart(6, '0'))}</strong></td>
                                <td>${escaparDash(cliente?.nome || 'Cliente não informado')}</td>
                                <td>${escaparDash(equipamento || '-')}</td>
                                <td>${escaparDash(os.status || '-')}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        ` : `<div class="empty"><div class="empty-icon">🔧</div><h3>Nenhuma OS registrada</h3><p>As ordens de serviço aparecerão aqui.</p></div>`;

        document.getElementById('dash-resumo-estoque').innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                <div style="padding:16px;border:1px solid #e5e7eb;border-radius:10px;">
                    <span style="font-size:13px;color:#6b7280;">Quantidade de itens</span>
                    <h3 style="margin:6px 0 0;">${estoqueTotal}</h3>
                </div>
                <div style="padding:16px;border:1px solid #e5e7eb;border-radius:10px;">
                    <span style="font-size:13px;color:#6b7280;">Valor de venda</span>
                    <h3 style="margin:6px 0 0;">${moeda(valorEstoqueVenda)}</h3>
                </div>
                <div style="padding:16px;border:1px solid #e5e7eb;border-radius:10px;">
                    <span style="font-size:13px;color:#6b7280;">Estoque baixo</span>
                    <h3 style="margin:6px 0 0;">${estoqueBaixo.length}</h3>
                </div>
                <div style="padding:16px;border:1px solid #e5e7eb;border-radius:10px;">
                    <span style="font-size:13px;color:#6b7280;">Sem estoque</span>
                    <h3 style="margin:6px 0 0;">${semEstoque.length}</h3>
                </div>
            </div>
        `;

    } catch (erro) {
        console.error('Erro ao carregar dashboard:', erro);
        document.getElementById('dash-vendas-recentes').innerHTML = `<div class="empty"><h3>Não foi possível carregar o dashboard</h3><p>Verifique o console para mais detalhes.</p></div>`;
        mostrarToast('Não foi possível carregar os dados do dashboard.', 'erro');
    }

    atualizarNotificacoes();

    document.getElementById('dashboard-nova-venda')?.addEventListener('click', () => {
        marcarMenuAtivo(menuVendas);
        mostrarVendas();
    });
    document.getElementById('dashboard-nova-os')?.addEventListener('click', () => {
        marcarMenuAtivo(menuOS);
        mostrarOrdensServico();
    });
    document.getElementById('dashboard-novo-cliente')?.addEventListener('click', () => {
        marcarMenuAtivo(menuClientes);
        mostrarFormularioCliente();
    });
    document.getElementById('dashboard-ver-vendas')?.addEventListener('click', () => {
        marcarMenuAtivo(menuVendas);
        mostrarVendas();
    });
    document.getElementById('dashboard-ver-os')?.addEventListener('click', () => {
        marcarMenuAtivo(menuOS);
        mostrarOrdensServico();
    });
    document.getElementById('dashboard-ver-estoque')?.addEventListener('click', () => {
        marcarMenuAtivo(menuEstoque);
        mostrarEstoque();
    });
}

/*
    ==================================================
    PRODUTOS
    ==================================================
*/

// Lista o catálogo e filtra os produtos localmente enquanto o usuário digita.
async function mostrarProdutos() {

    conteudo.innerHTML = `

        <div class="page-header">

            <div>

                <h2>Produtos</h2>

                <p>
                    Gerencie os produtos do seu negócio
                </p>

            </div>


            <button
                class="button"
                id="novo-produto"
            >
                + Novo produto
            </button>

        </div>


        <div class="panel">

            <div class="search-area">

                <input
                    type="text"
                    id="buscar-produto"
                    placeholder="🔍 Buscar por nome, SKU, código de barras..."
                >

            </div>


            <div class="table-container">

                <table>

                    <thead>

                        <tr>

                            <th>SKU</th>
                            <th>Produto</th>
                            <th>Categoria</th>
                            <th>Estoque</th>
                            <th>Preço</th>
                            <th>Ações</th>

                        </tr>

                    </thead>


                    <tbody id="lista-produtos">

                    </tbody>

                </table>

            </div>

        </div>

    `;


    document
        .getElementById('novo-produto')
        .addEventListener(
            'click',
            () => mostrarFormularioProduto()
        );


    const produtos =
        await window.api.listarProdutos();


    const lista =
        document.getElementById('lista-produtos');


    const campoBusca =
        document.getElementById('buscar-produto');


    function renderizarProdutos(
        produtosFiltrados
    ) {

        if (produtosFiltrados.length === 0) {

            lista.innerHTML = `

                <tr>

                    <td
                        colspan="6"
                        class="empty-table"
                    >

                        📦

                        <strong>
                            Nenhum produto encontrado
                        </strong>

                        <span>
                            Tente outro nome, SKU,
                            código de barras ou categoria.
                        </span>

                    </td>

                </tr>

            `;

            return;

        }


        lista.innerHTML =
            produtosFiltrados.map(
                produto => `

                <tr>

                    <td>

                        <strong>
                            ${produto.sku || '-'}
                        </strong>

                    </td>


                    <td>

                        <strong>
                            ${produto.nome}
                        </strong>


                        ${produto.codigo_barras
                        ? `
                                    <small
                                        style="
                                            display: block;
                                            color: #6b7280;
                                            margin-top: 4px;
                                        "
                                    >
                                        EAN:
                                        ${produto.codigo_barras}
                                    </small>
                                `
                        : ''
                    }

                    </td>


                    <td>
                        ${produto.categoria || '-'}
                    </td>


                    <td>
                        ${produto.estoque}
                    </td>


                    <td>

                        R$ ${Number(
                        produto.preco_venda
                    )
                        .toFixed(2)
                        .replace('.', ',')}

                    </td>


                    <td>

                        <button
                            class="button btn-editar"
                            data-id="${produto.id}"
                            style="background: #6b7280;"
                        >
                            Editar
                        </button>


                        <button
                            class="button btn-excluir"
                            data-id="${produto.id}"
                            style="background: #dc2626;"
                        >
                            Excluir
                        </button>

                    </td>

                </tr>

            `
            ).join('');


        document
            .querySelectorAll('.btn-editar')
            .forEach(botao => {

                botao.addEventListener(
                    'click',
                    () => {

                        const id =
                            Number(
                                botao.dataset.id
                            );


                        const produto =
                            produtos.find(
                                item =>
                                    item.id === id
                            );


                        if (produto) {

                            mostrarFormularioProduto(
                                produto
                            );

                        }

                    }
                );

            });


        document
            .querySelectorAll('.btn-excluir')
            .forEach(botao => {

                botao.addEventListener(
                    'click',
                    () => {

                        const id =
                            Number(
                                botao.dataset.id
                            );


                        excluirProduto(id);

                    }
                );

            });

    }


    renderizarProdutos(produtos);


    campoBusca.addEventListener(
        'input',
        () => {

            const termo =
                campoBusca.value
                    .trim()
                    .toLowerCase();


            if (termo === '') {

                renderizarProdutos(produtos);

                return;

            }


            const produtosFiltrados =
                produtos.filter(
                    produto => {

                        const nome =
                            String(
                                produto.nome || ''
                            ).toLowerCase();


                        const sku =
                            String(
                                produto.sku || ''
                            ).toLowerCase();


                        const codigoBarras =
                            String(
                                produto.codigo_barras || ''
                            ).toLowerCase();


                        const categoria =
                            String(
                                produto.categoria || ''
                            ).toLowerCase();


                        return (

                            nome.includes(termo) ||

                            sku.includes(termo) ||

                            codigoBarras.includes(termo) ||

                            categoria.includes(termo)

                        );

                    }
                );


            renderizarProdutos(
                produtosFiltrados
            );

        }
    );

}


/*
    FORMULÁRIO DE PRODUTO
*/

// Compartilha o mesmo formulário para cadastro e edição de produtos.
function mostrarFormularioProduto(
    produto = null
) {

    const editando =
        produto !== null;


    conteudo.innerHTML = `

        <div class="page-header">

            <div>

                <h2>

                    ${editando
            ? 'Editar produto'
            : 'Novo produto'
        }

                </h2>


                <p>

                    ${editando
            ? 'Altere os dados do produto'
            : 'Cadastre um novo produto no sistema'
        }

                </p>

            </div>

        </div>


        <div class="panel">

            <form
                id="form-produto"
                style="padding: 25px;"
            >

                <div
                    style="
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 20px;
                    "
                >

                    <div>

                        <label>
                            Nome do produto
                        </label>


                        <input
                            type="text"
                            id="nome"
                            placeholder="Ex: Fone Bluetooth"
                            required
                            value="${editando && produto.nome
            ? produto.nome
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <div>

                        <label>
                            SKU / Código interno
                        </label>


                        <input
                            type="text"
                            id="sku"
                            placeholder="Ex: FONE-A9"
                            value="${editando
            ? produto.sku || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <div>

                        <label>
                            Código de barras
                        </label>


                        <input
                            type="text"
                            id="codigo-barras"
                            placeholder="Ex: 7891234567890"
                            inputmode="numeric"
                            value="${editando
            ? produto.codigo_barras || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <div>

                        <label>
                            Categoria
                        </label>


                        <input
                            type="text"
                            id="categoria"
                            placeholder="Ex: Eletrônicos"
                            value="${editando
            ? produto.categoria || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <div>

                        <label>
                            Estoque
                        </label>


                        <input
                            type="number"
                            id="estoque"
                            value="${editando
            ? produto.estoque
            : 0
        }"
                            min="0"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <div>

                        <label>
                            Preço de custo
                        </label>


                        <input
                            type="number"
                            id="preco-custo"
                            value="${editando
            ? produto.preco_custo
            : 0
        }"
                            min="0"
                            step="0.01"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <div>

                        <label>
                            Preço de venda
                        </label>


                        <input
                            type="number"
                            id="preco-venda"
                            value="${editando
            ? produto.preco_venda
            : 0
        }"
                            min="0"
                            step="0.01"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <div>

                        <label>
                            Estoque mínimo
                        </label>


                        <input
                            type="number"
                            id="estoque-minimo"
                            value="${editando
            ? produto.estoque_minimo
            : 0
        }"
                            min="0"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>

                </div>


                <div
                    style="
                        margin-top: 30px;
                        display: flex;
                        gap: 10px;
                    "
                >

                    <button
                        type="submit"
                        class="button"
                    >
                        💾

                        ${editando
            ? 'Salvar alterações'
            : 'Salvar produto'
        }

                    </button>


                    <button
                        type="button"
                        class="button"
                        id="cancelar-produto"
                        style="background: #6b7280;"
                    >
                        Cancelar
                    </button>

                </div>

            </form>

        </div>

    `;


    document
        .getElementById('form-produto')
        .addEventListener(
            'submit',
            event => {

                salvarProduto(
                    event,
                    produto
                );

            }
        );


    document
        .getElementById('cancelar-produto')
        .addEventListener(
            'click',
            mostrarProdutos
        );

}


/*
    SALVAR PRODUTO
*/

// Valida os campos e envia o produto ao handler apropriado no processo principal.
async function salvarProduto(
    event,
    produtoExistente = null
) {

    event.preventDefault();


    const produto = {

        nome:
            document
                .getElementById('nome')
                .value
                .trim(),

        sku:
            document
                .getElementById('sku')
                .value
                .trim(),

        codigo_barras:
            document
                .getElementById('codigo-barras')
                .value
                .trim(),

        categoria:
            document
                .getElementById('categoria')
                .value
                .trim(),

        estoque:
            Number(
                document
                    .getElementById('estoque')
                    .value
            ),

        preco_custo:
            Number(
                document
                    .getElementById('preco-custo')
                    .value
            ),

        preco_venda:
            Number(
                document
                    .getElementById('preco-venda')
                    .value
            ),

        estoque_minimo:
            Number(
                document
                    .getElementById('estoque-minimo')
                    .value
            )

    };


    if (produtoExistente) {

        produto.id =
            produtoExistente.id;


        try {

            const resultado =
                await window.api.editarProduto(
                    produto
                );


            if (resultado.sucesso) {

                alert(
                    'Produto atualizado com sucesso!'
                );

                await mostrarProdutos();
                await atualizarNotificacoes();

            }

        } catch (erro) {

            console.error(erro);

            alert(
                'SKU ou código de barras já cadastrado.'
            );

        }


        return;

    }


    try {

        const resultado =
            await window.api.cadastrarProduto(
                produto
            );


        if (resultado.sucesso) {

            alert(
                'Produto cadastrado com sucesso!'
            );

            await mostrarProdutos();
            await atualizarNotificacoes();

        }

    } catch (erro) {

        console.error(erro);


        if (
            erro.message &&
            erro.message.includes(
                'UNIQUE constraint failed'
            )
        ) {

            alert(
                'SKU ou código de barras já cadastrado.'
            );

        } else {

            alert(
                'Não foi possível cadastrar o produto.'
            );

        }

    }

}


/*
    EXCLUIR PRODUTO
*/

// Confirma a exclusão e atualiza a listagem após a resposta do banco.
async function excluirProduto(id) {

    const confirmar =
        confirm(
            'Tem certeza que deseja excluir este produto?'
        );


    if (!confirmar) {

        return;

    }


    const resultado =
        await window.api.excluirProduto(id);


    if (resultado.sucesso) {

        alert(
            'Produto excluído com sucesso!'
        );

        mostrarProdutos();

    } else {

        alert(
            'Não foi possível excluir o produto.'
        );

    }

}


/*
    ==================================================
    CLIENTES
    ==================================================
*/

// Exibe a busca de clientes e suas ações de cadastro, edição e histórico.
async function mostrarClientes() {

    conteudo.innerHTML = `

        <div class="page-header">

            <div>

                <h2>Clientes</h2>

                <p>
                    Gerencie os clientes do seu negócio
                </p>

            </div>


            <button
                class="button"
                id="novo-cliente"
            >
                + Novo cliente
            </button>

        </div>


        <div class="panel">

            <div class="search-area">

                <input
                    type="text"
                    id="buscar-cliente"
                    placeholder="🔍 Buscar por nome, CPF/CNPJ, telefone, celular ou e-mail..."
                >

            </div>


            <div class="table-container">

                <table>

                    <thead>

                        <tr>

                            <th>Nome</th>

                            <th>CPF/CNPJ</th>

                            <th>Telefone</th>

                            <th>Celular</th>

                            <th>E-mail</th>

                            <th>Cidade</th>

                            <th>Ações</th>

                        </tr>

                    </thead>


                    <tbody id="lista-clientes">

                    </tbody>

                </table>

            </div>

        </div>

    `;


    /*
        NOVO CLIENTE
    */

    document
        .getElementById('novo-cliente')
        .addEventListener(
            'click',
            () => mostrarFormularioCliente()
        );


    /*
        BUSCAR CLIENTES
    */

    const clientes =
        await window.api.listarClientes();


    const lista =
        document.getElementById(
            'lista-clientes'
        );


    const campoBusca =
        document.getElementById(
            'buscar-cliente'
        );

    // Combina as OS e vendas permitidas em uma visão única daquele cliente.
    async function abrirHistoricoCliente(cliente) {
        let ordens = [];
        let vendas = [];
        let erroCarregamento = '';

        try {
            const [ordensResultado, vendasResultado] = await Promise.all([
                usuarioPode('os') ? window.api.listarOrdensServico() : Promise.resolve(null),
                usuarioPode('vendas') ? window.api.listarVendas() : Promise.resolve(null)
            ]);
            ordens = Array.isArray(ordensResultado)
                ? ordensResultado.filter(item => Number(item.cliente_id) === Number(cliente.id))
                : [];
            vendas = Array.isArray(vendasResultado)
                ? vendasResultado.filter(item => Number(item.cliente_id) === Number(cliente.id))
                : [];
        } catch (erro) {
            console.error('Erro ao carregar histórico do cliente:', erro);
            erroCarregamento = 'Não foi possível carregar o histórico deste cliente.';
        }

        const escapar = valor => escaparLogin(valor ?? '');
        const formatarData = valor => {
            if (!valor) return '—';
            const data = converterDataHoraLocal(valor);
            return data ? formatarDataHoraLocal(valor) : escapar(String(valor));
        };
        const moeda = valor => `R$ ${Number(valor || 0).toFixed(2).replace('.', ',')}`;
        const numero = valor => String(Number(valor || 0)).padStart(6, '0');
        const tabelaVazia = mensagem => `
            <tr><td colspan="5" class="empty-table">
                <strong>${escapar(mensagem)}</strong>
            </td></tr>`;

        const linhasOS = ordens.length ? ordens.map(os => `
            <tr>
                <td><strong>OS ${numero(os.numero)}</strong></td>
                <td>${escapar(os.tipo_equipamento || '—')}${os.marca || os.modelo ? `<br><small>${escapar([os.marca, os.modelo].filter(Boolean).join(' '))}</small>` : ''}</td>
                <td>${escapar(os.status || '—')}</td>
                <td>${formatarData(os.data_hora_abertura)}</td>
                <td><strong>${moeda(os.total)}</strong></td>
            </tr>`).join('') : tabelaVazia(
                usuarioPode('os') ? 'Nenhuma ordem de serviço para este cliente.' : 'Sem permissão para consultar ordens de serviço.'
            );

        const linhasVendas = vendas.length ? vendas.map(venda => `
            <tr>
                <td><strong>Venda ${numero(venda.numero)}</strong></td>
                <td>${formatarData(venda.data_hora)}</td>
                <td>${escapar(venda.forma_pagamento || '—')}</td>
                <td>${escapar(venda.status || 'Concluída')}</td>
                <td><strong>${moeda(venda.total)}</strong></td>
            </tr>`).join('') : tabelaVazia(
            usuarioPode('vendas') ? 'Nenhuma venda para este cliente.' : 'Sem permissão para consultar vendas.'
            );

        const contatoCliente = [
            cliente.telefone ? `Tel.: ${cliente.telefone}` : '',
            cliente.celular ? `Cel.: ${cliente.celular}` : ''
        ].filter(Boolean).join(' · ');
        const enderecoCliente = [cliente.endereco, cliente.numero, cliente.bairro, cliente.cidade, cliente.estado]
            .filter(Boolean)
            .join(', ');

        conteudo.innerHTML = `
            <div class="page-header">
                <div>
                    <h2>Histórico do cliente</h2>
                    <p>${escapar(cliente.nome)}${cliente.cpf_cnpj ? ` · ${escapar(cliente.cpf_cnpj)}` : ''}</p>
                </div>
                <button type="button" class="button" id="voltar-clientes-historico" style="background:#6b7280;">← Voltar aos clientes</button>
            </div>
            <div class="panel cliente-resumo">
                <div>
                    <span class="cliente-resumo-label">Contato</span>
                    <strong>${escapar(contatoCliente || 'Telefone não informado')}</strong>
                </div>
                <div>
                    <span class="cliente-resumo-label">E-mail</span>
                    <strong>${escapar(cliente.email || 'E-mail não informado')}</strong>
                </div>
                <div>
                    <span class="cliente-resumo-label">Endereço</span>
                    <strong>${escapar(enderecoCliente || 'Endereço não informado')}</strong>
                </div>
                <div class="cliente-resumo-atalhos">
                    ${usuarioPode('vendas', 'criar') ? '<button type="button" class="button" id="cliente-historico-nova-venda">+ Nova venda</button>' : ''}
                    ${usuarioPode('os', 'criar') ? '<button type="button" class="button secondary" id="cliente-historico-nova-os">+ Nova OS</button>' : ''}
                </div>
            </div>
            ${erroCarregamento ? `<div class="panel" style="padding:18px;color:#b91c1c;">${escapar(erroCarregamento)}</div>` : `
                <div class="panel" style="margin-bottom:20px;overflow:hidden;">
                    <div class="panel-header"><div><h3>Ordens de serviço</h3><span>${ordens.length} registro(s)</span></div></div>
                    <div class="table-container"><table><thead><tr><th>Número</th><th>Equipamento</th><th>Status</th><th>Abertura</th><th>Total</th></tr></thead><tbody>${linhasOS}</tbody></table></div>
                </div>
                <div class="panel" style="overflow:hidden;">
                    <div class="panel-header"><div><h3>Vendas</h3><span>${vendas.length} registro(s)</span></div></div>
                    <div class="table-container"><table><thead><tr><th>Número</th><th>Data</th><th>Pagamento</th><th>Status</th><th>Total</th></tr></thead><tbody>${linhasVendas}</tbody></table></div>
                </div>
            `}
        `;

        document.getElementById('voltar-clientes-historico')
            .addEventListener('click', mostrarClientes);
        document.getElementById('cliente-historico-nova-venda')
            ?.addEventListener('click', () => mostrarVendas(cliente.id));
        document.getElementById('cliente-historico-nova-os')
            ?.addEventListener('click', () => mostrarFormularioOS(null, cliente.id));
    }


    /*
        RENDERIZAR CLIENTES
    */

    function renderizarClientes(
        clientesFiltrados
    ) {

        if (
            clientesFiltrados.length === 0
        ) {

            lista.innerHTML = `

                <tr>

                    <td
                        colspan="7"
                        class="empty-table"
                    >

                        👥

                        <strong>
                            Nenhum cliente encontrado
                        </strong>

                        <span>
                            Cadastre um novo cliente
                            para começar.
                        </span>

                    </td>

                </tr>

            `;

            return;

        }


        lista.innerHTML =
            clientesFiltrados.map(
                cliente => `

                <tr>

                    <td>

                        <strong>
                            ${cliente.nome}
                        </strong>

                    </td>


                    <td>
                        ${cliente.cpf_cnpj || '-'}
                    </td>


                    <td>
                        ${cliente.telefone || '-'}
                    </td>


                    <td>
                        ${cliente.celular || '-'}
                    </td>


                    <td>
                        ${cliente.email || '-'}
                    </td>


                    <td>

                        ${cliente.cidade
                        ? `${cliente.cidade}/${cliente.estado || ''}`
                        : '-'
                    }

                    </td>


                    <td>

                        <button
                            class="button btn-historico-cliente"
                            data-id="${cliente.id}"
                            style="background: #2563eb;"
                        >
                            Histórico
                        </button>

                        <button
                            class="button btn-editar-cliente"
                            data-id="${cliente.id}"
                            style="background: #6b7280;"
                        >
                            Editar
                        </button>


                        <button
                            class="button btn-excluir-cliente"
                            data-id="${cliente.id}"
                            style="background: #dc2626;"
                        >
                            Excluir
                        </button>

                    </td>

                </tr>

            `
            ).join('');


        /*
            BOTÃO EDITAR
        */

        document
            .querySelectorAll(
                '.btn-historico-cliente'
            )
            .forEach(botao => {
                botao.addEventListener('click', () => {
                    const cliente = clientes.find(item => Number(item.id) === Number(botao.dataset.id));
                    if (cliente) abrirHistoricoCliente(cliente);
                });
            });

        document
            .querySelectorAll(
                '.btn-editar-cliente'
            )
            .forEach(botao => {

                botao.addEventListener(
                    'click',
                    () => {

                        const id =
                            Number(
                                botao.dataset.id
                            );


                        const cliente =
                            clientes.find(
                                item =>
                                    item.id === id
                            );


                        if (cliente) {

                            mostrarFormularioCliente(
                                cliente
                            );

                        }

                    }
                );

            });


        /*
            BOTÃO EXCLUIR
        */

        document
            .querySelectorAll(
                '.btn-excluir-cliente'
            )
            .forEach(botao => {

                botao.addEventListener(
                    'click',
                    () => {

                        const id =
                            Number(
                                botao.dataset.id
                            );


                        excluirCliente(id);

                    }
                );

            });

    }


    /*
        MOSTRAR CLIENTES
    */

    renderizarClientes(clientes);


    /*
        ==================================================
        BUSCA EM TEMPO REAL
        ==================================================
    */

    campoBusca.addEventListener(
        'input',
        () => {

            const termo =
                campoBusca.value
                    .trim()
                    .toLowerCase();


            if (termo === '') {

                renderizarClientes(
                    clientes
                );

                return;

            }


            const clientesFiltrados =
                clientes.filter(
                    cliente => {

                        const nome =
                            String(
                                cliente.nome || ''
                            ).toLowerCase();


                        const cpfCnpj =
                            String(
                                cliente.cpf_cnpj || ''
                            ).toLowerCase();


                        const telefone =
                            String(
                                cliente.telefone || ''
                            ).toLowerCase();


                        const celular =
                            String(
                                cliente.celular || ''
                            ).toLowerCase();


                        const email =
                            String(
                                cliente.email || ''
                            ).toLowerCase();


                        return (

                            nome.includes(termo) ||

                            cpfCnpj.includes(termo) ||

                            telefone.includes(termo) ||

                            celular.includes(termo) ||

                            email.includes(termo)

                        );

                    }
                );


            renderizarClientes(
                clientesFiltrados
            );

        }
    );

}


/*
    ==================================================
    FORMULÁRIO DE CLIENTE
    ==================================================
*/

// O formulário aceita tanto um novo cadastro quanto um cliente existente.
function mostrarFormularioCliente(
    cliente = null
) {

    const editando =
        cliente !== null;


    conteudo.innerHTML = `

        <div class="page-header">

            <div>

                <h2>

                    ${editando
            ? 'Editar cliente'
            : 'Novo cliente'
        }

                </h2>


                <p>

                    ${editando
            ? 'Altere os dados do cliente'
            : 'Cadastre um novo cliente no sistema'
        }

                </p>

            </div>

        </div>


        <div class="panel">

            <form
                id="form-cliente"
                style="padding: 25px;"
            >

                <div
                    style="
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 20px;
                    "
                >

                    <!-- NOME -->

                    <div>

                        <label>
                            Nome / Razão social
                        </label>


                        <input
                            type="text"
                            id="cliente-nome"
                            placeholder="Nome completo ou razão social"
                            required
                            value="${editando
            ? cliente.nome || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- CPF / CNPJ -->

                    <div>

                        <label>
                            CPF / CNPJ
                        </label>


                        <input
                            type="text"
                            id="cliente-cpf-cnpj"
                            placeholder="CPF ou CNPJ"
                            value="${editando
            ? cliente.cpf_cnpj || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- TELEFONE -->

                    <div>

                        <label>
                            Telefone
                        </label>


                        <input
                            type="text"
                            id="cliente-telefone"
                            placeholder="(18) 9999-9999"
                            value="${editando
            ? cliente.telefone || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- CELULAR -->

                    <div>

                        <label>
                            Celular
                        </label>


                        <input
                            type="text"
                            id="cliente-celular"
                            placeholder="(18) 99999-9999"
                            value="${editando
            ? cliente.celular || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- E-MAIL -->

                    <div>

                        <label>
                            E-mail
                        </label>


                        <input
                            type="email"
                            id="cliente-email"
                            placeholder="cliente@email.com"
                            value="${editando
            ? cliente.email || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- CEP -->

                    <div>

                        <label>
                            CEP
                        </label>


                        <input
                            type="text"
                            id="cliente-cep"
                            placeholder="00000-000"
                            value="${editando
            ? cliente.cep || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- ENDEREÇO -->

                    <div>

                        <label>
                            Endereço
                        </label>


                        <input
                            type="text"
                            id="cliente-endereco"
                            placeholder="Rua, Avenida..."
                            value="${editando
            ? cliente.endereco || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- NÚMERO -->

                    <div>

                        <label>
                            Número
                        </label>


                        <input
                            type="text"
                            id="cliente-numero"
                            placeholder="Número"
                            value="${editando
            ? cliente.numero || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- COMPLEMENTO -->

                    <div>

                        <label>
                            Complemento
                        </label>


                        <input
                            type="text"
                            id="cliente-complemento"
                            placeholder="Apartamento, sala..."
                            value="${editando
            ? cliente.complemento || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- BAIRRO -->

                    <div>

                        <label>
                            Bairro
                        </label>


                        <input
                            type="text"
                            id="cliente-bairro"
                            placeholder="Bairro"
                            value="${editando
            ? cliente.bairro || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- CIDADE -->

                    <div>

                        <label>
                            Cidade
                        </label>


                        <input
                            type="text"
                            id="cliente-cidade"
                            placeholder="Cidade"
                            value="${editando
            ? cliente.cidade || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>


                    <!-- ESTADO -->

                    <div>

                        <label>
                            Estado
                        </label>


                        <input
                            type="text"
                            id="cliente-estado"
                            placeholder="SP"
                            maxlength="2"
                            value="${editando
            ? cliente.estado || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                                text-transform: uppercase;
                            "
                        >

                    </div>


                    <!-- OBSERVAÇÕES -->

                    <div>

                        <label>
                            Observações
                        </label>


                        <input
                            type="text"
                            id="cliente-observacoes"
                            placeholder="Observações sobre o cliente"
                            value="${editando
            ? cliente.observacoes || ''
            : ''
        }"
                            style="
                                width: 100%;
                                padding: 11px;
                                margin-top: 6px;
                                border: 1px solid #d1d5db;
                                border-radius: 7px;
                            "
                        >

                    </div>

                </div>


                <div
                    style="
                        margin-top: 30px;
                        display: flex;
                        gap: 10px;
                    "
                >

                    <button
                        type="submit"
                        class="button"
                    >

                        💾

                        ${editando
            ? 'Salvar alterações'
            : 'Salvar cliente'
        }

                    </button>


                    <button
                        type="button"
                        class="button"
                        id="cancelar-cliente"
                        style="background: #6b7280;"
                    >
                        Cancelar
                    </button>

                </div>

            </form>

        </div>

    `;


    /*
        SALVAR FORMULÁRIO
    */

    document
        .getElementById('form-cliente')
        .addEventListener(
            'submit',
            event => {

                salvarCliente(
                    event,
                    cliente
                );

            }
        );

    document
        .getElementById('cancelar-cliente')
        .addEventListener('click', mostrarClientes);


    /*
        BUSCA AUTOMÁTICA DE CEP
        Consulta o ViaCEP ao sair do campo CEP.
    */

    const campoCEP = document.getElementById('cliente-cep');
    const campoEndereco = document.getElementById('cliente-endereco');
    const campoBairro = document.getElementById('cliente-bairro');
    const campoCidade = document.getElementById('cliente-cidade');
    const campoEstado = document.getElementById('cliente-estado');

    async function buscarEnderecoPorCEP() {

        const cep = String(campoCEP.value || '')
            .replace(/\D/g, '');

        if (!cep) {
            return;
        }

        if (!/^\d{8}$/.test(cep)) {
            alert('Digite um CEP válido com 8 números.');
            return;
        }

        campoCEP.value = `${cep.slice(0, 5)}-${cep.slice(5)}`;

        const valoresAnteriores = {
            endereco: campoEndereco.value,
            bairro: campoBairro.value,
            cidade: campoCidade.value,
            estado: campoEstado.value
        };

        campoEndereco.value = 'Consultando...';
        campoBairro.value = 'Consultando...';
        campoCidade.value = 'Consultando...';
        campoEstado.value = '...';

        try {

            const resposta = await fetch(
                `https://viacep.com.br/ws/${cep}/json/`,
                {
                    method: 'GET',
                    headers: {
                        Accept: 'application/json'
                    }
                }
            );

            if (!resposta.ok) {
                throw new Error('Falha na consulta do CEP.');
            }

            const dados = await resposta.json();

            if (dados.erro) {
                campoEndereco.value = valoresAnteriores.endereco;
                campoBairro.value = valoresAnteriores.bairro;
                campoCidade.value = valoresAnteriores.cidade;
                campoEstado.value = valoresAnteriores.estado;

                alert('CEP não encontrado.');
                return;
            }

            campoEndereco.value = dados.logradouro || '';
            campoBairro.value = dados.bairro || '';
            campoCidade.value = dados.localidade || '';
            campoEstado.value = dados.uf || '';

            // O número e o complemento continuam sendo preenchidos manualmente.

        } catch (erro) {

            console.error('Erro ao consultar CEP:', erro);

            campoEndereco.value = valoresAnteriores.endereco;
            campoBairro.value = valoresAnteriores.bairro;
            campoCidade.value = valoresAnteriores.cidade;
            campoEstado.value = valoresAnteriores.estado;

            alert(
                'Não foi possível consultar o CEP. Verifique sua conexão com a internet e, se necessário, preencha o endereço manualmente.'
            );
        }
    }

    campoCEP.addEventListener(
        'blur',
        buscarEnderecoPorCEP
    );

    campoCEP.addEventListener(
        'input',
        () => {
            const numeros = campoCEP.value.replace(/\D/g, '').slice(0, 8);

            campoCEP.value = numeros.length > 5
                ? `${numeros.slice(0, 5)}-${numeros.slice(5)}`
                : numeros;
        }
    );

}


/*
    ==================================================
    SALVAR CLIENTE
    ==================================================
*/

// Normaliza os dados do formulário e chama cadastro ou atualização no banco.
async function salvarCliente(
    event,
    clienteExistente = null
) {

    event.preventDefault();


    const cliente = {

        nome:
            document
                .getElementById('cliente-nome')
                .value
                .trim(),


        cpf_cnpj:
            document
                .getElementById('cliente-cpf-cnpj')
                .value
                .trim(),


        telefone:
            document
                .getElementById('cliente-telefone')
                .value
                .trim(),


        celular:
            document
                .getElementById('cliente-celular')
                .value
                .trim(),


        email:
            document
                .getElementById('cliente-email')
                .value
                .trim(),


        cep:
            document
                .getElementById('cliente-cep')
                .value
                .trim(),


        endereco:
            document
                .getElementById('cliente-endereco')
                .value
                .trim(),


        numero:
            document
                .getElementById('cliente-numero')
                .value
                .trim(),


        complemento:
            document
                .getElementById('cliente-complemento')
                .value
                .trim(),


        bairro:
            document
                .getElementById('cliente-bairro')
                .value
                .trim(),


        cidade:
            document
                .getElementById('cliente-cidade')
                .value
                .trim(),


        estado:
            document
                .getElementById('cliente-estado')
                .value
                .trim()
                .toUpperCase(),


        observacoes:
            document
                .getElementById('cliente-observacoes')
                .value
                .trim()

    };


    /*
        ==================================================
        EDITAR CLIENTE
        ==================================================
    */

    if (clienteExistente) {

        cliente.id =
            clienteExistente.id;


        try {

            const resultado =
                await window.api.editarCliente(
                    cliente
                );


            if (resultado.sucesso) {

                alert(
                    'Cliente atualizado com sucesso!'
                );


                mostrarClientes();

            } else {

                alert(
                    'Não foi possível atualizar o cliente.'
                );

            }

        } catch (erro) {

            console.error(erro);


            alert(
                'CPF/CNPJ já cadastrado.'
            );

        }


        return;

    }


    /*
        ==================================================
        NOVO CLIENTE
        ==================================================
    */

    try {

        const resultado =
            await window.api.cadastrarCliente(
                cliente
            );


        if (resultado.sucesso) {

            alert(
                'Cliente cadastrado com sucesso!'
            );


            mostrarClientes();

        }

    } catch (erro) {

        console.error(erro);


        if (
            erro.message &&
            erro.message.includes(
                'UNIQUE constraint failed'
            )
        ) {

            alert(
                'CPF/CNPJ já cadastrado.'
            );

        } else {

            alert(
                'Não foi possível cadastrar o cliente.'
            );

        }

    }

}


/*
    ==================================================
    EXCLUIR CLIENTE
    ==================================================
*/

// Pede confirmação antes de solicitar ao processo principal a exclusão do cliente.
async function excluirCliente(id) {

    const confirmar =
        confirm(
            'Tem certeza que deseja excluir este cliente?'
        );


    if (!confirmar) {

        return;

    }


    const resultado =
        await window.api.excluirCliente(
            id
        );


    if (resultado.sucesso) {

        alert(
            'Cliente excluído com sucesso!'
        );


        mostrarClientes();

    } else {

        alert(
            'Não foi possível excluir o cliente.'
        );

    }

}




/*
    ==================================================
    VENDAS
    ==================================================
*/

// Monta o carrinho, seleciona cliente e produto e finaliza a venda pela API.
async function mostrarVendas(clienteInicialId = null) {

    marcarMenuAtivo(menuVendas);

    const clientes =
        await window.api.listarClientes();

    const produtos =
        await window.api.listarProdutos();


    let clienteSelecionado = null;

    let itensVenda = [];


    conteudo.innerHTML = `

        <div class="page-header vendas-page-header">

            <div>

                <h2>Vendas</h2>

                <p>
                    Registre vendas de produtos
                </p>

            </div>

            <button
                type="button"
                class="button vendas-historico-button"
                id="vendas-abrir-historico"
            >
                📋 Histórico de vendas
            </button>

        </div>


        <div class="panel">

            <div style="padding: 25px;">

                <h3 style="margin-top: 0;">
                    Cliente
                </h3>


                <div style="
                    position: relative;
                    margin-bottom: 25px;
                ">

                    <input
                        type="text"
                        id="venda-buscar-cliente"
                        placeholder="Digite o nome ou CPF do cliente..."
                        autocomplete="off"
                        style="
                            width: 100%;
                            padding: 12px;
                            border: 1px solid #d1d5db;
                            border-radius: 8px;
                            font-size: 14px;
                            box-sizing: border-box;
                        "
                    >


                    <div
                        id="venda-clientes-sugestoes"
                        style="
                            display: none;
                            position: absolute;
                            top: 100%;
                            left: 0;
                            right: 0;
                            background: white;
                            border: 1px solid #d1d5db;
                            border-radius: 0 0 8px 8px;
                            max-height: 220px;
                            overflow-y: auto;
                            z-index: 1000;
                            box-shadow: 0 4px 12px rgba(0,0,0,0.12);
                        "
                    ></div>

                </div>


                <div
                    id="venda-cliente-selecionado"
                    style="
                        display: none;
                        padding: 15px;
                        background: #f3f4f6;
                        border-radius: 8px;
                        margin-bottom: 25px;
                    "
                ></div>


                <h3>
                    Produtos
                </h3>


                <div style="
                    display: grid;
                    grid-template-columns: 1fr 130px 120px;
                    gap: 10px;
                    align-items: end;
                    margin-bottom: 20px;
                ">

                    <div>

                        <label>
                            Produto
                        </label>

                        <div style="position: relative;">

                            <input
                                type="text"
                                id="venda-produto"
                                placeholder="Digite o nome, SKU ou código de barras..."
                                autocomplete="off"
                                style="
                                    width: 100%;
                                    padding: 11px;
                                    border: 1px solid #d1d5db;
                                    border-radius: 8px;
                                    box-sizing: border-box;
                                "
                            >

                            <div
                                id="venda-produto-sugestoes"
                                style="
                                    display: none;
                                    position: absolute;
                                    top: calc(100% + 4px);
                                    left: 0;
                                    right: 0;
                                    max-height: 280px;
                                    overflow-y: auto;
                                    background: #fff;
                                    border: 1px solid #d1d5db;
                                    border-radius: 8px;
                                    box-shadow: 0 8px 20px rgba(0,0,0,.12);
                                    z-index: 1000;
                                "
                            ></div>

                        </div>

                    </div>


                    <div>

                        <label>
                            Quantidade
                        </label>

                        <input
                            type="number"
                            id="venda-quantidade"
                            min="1"
                            value="1"
                            style="
                                width: 100%;
                                padding: 11px;
                                border: 1px solid #d1d5db;
                                border-radius: 8px;
                                box-sizing: border-box;
                            "
                        >

                    </div>


                    <button
                        type="button"
                        class="button"
                        id="venda-adicionar-produto"
                    >
                        + Adicionar
                    </button>

                </div>


                <div class="table-container">

                    <table>

                        <thead>

                            <tr>

                                <th>
                                    Produto
                                </th>

                                <th>
                                    Qtd.
                                </th>

                                <th>
                                    Valor unitário
                                </th>

                                <th>
                                    Subtotal
                                </th>

                                <th>
                                    Ação
                                </th>

                            </tr>

                        </thead>


                        <tbody id="venda-itens">

                        </tbody>

                    </table>

                </div>


                <div
                    id="venda-resumo"
                    style="
                        margin-top: 25px;
                        display: flex;
                        justify-content: flex-end;
                    "
                >

                    <div style="
                        width: 320px;
                    ">

                        <div style="
                            display: flex;
                            justify-content: space-between;
                            margin-bottom: 10px;
                        ">

                            <span>
                                Subtotal:
                            </span>

                            <strong id="venda-subtotal">
                                R$ 0,00
                            </strong>

                        </div>


                        <div style="
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                            margin-bottom: 10px;
                            gap: 12px;
                        ">

                            <label style="font-weight: 600;">
                                Desconto (%):
                            </label>

                            <div style="position: relative; width: 120px;">
                                <input
                                    type="number"
                                    id="venda-desconto"
                                    min="0"
                                    max="100"
                                    step="0.01"
                                    value="0"
                                    placeholder="0,00"
                                    style="
                                        width: 100%;
                                        padding: 8px 28px 8px 8px;
                                        border: 1px solid #d1d5db;
                                        border-radius: 6px;
                                        text-align: right;
                                        box-sizing: border-box;
                                    "
                                >
                                <span style="
                                    position: absolute;
                                    right: 9px;
                                    top: 50%;
                                    transform: translateY(-50%);
                                    color: #6b7280;
                                    font-weight: 700;
                                    pointer-events: none;
                                ">%</span>
                            </div>

                        </div>

                        <div style="
                            display: flex;
                            justify-content: space-between;
                            margin-bottom: 10px;
                            color: #6b7280;
                            font-size: 13px;
                        ">
                            <span>Valor do desconto:</span>
                            <strong id="venda-desconto-valor">R$ 0,00</strong>
                        </div>


                        <div style="
                            display: flex;
                            justify-content: space-between;
                            font-size: 20px;
                            padding-top: 15px;
                            border-top: 1px solid #ddd;
                        ">

                            <strong>
                                Total:
                            </strong>

                            <strong id="venda-total">
                                R$ 0,00
                            </strong>

                        </div>


                        <div style="
                            margin-top: 20px;
                        ">

                            <label>
                                Forma de pagamento
                            </label>

                            <select
                                id="venda-forma-pagamento"
                                style="
                                    width: 100%;
                                    padding: 11px;
                                    border: 1px solid #d1d5db;
                                    border-radius: 8px;
                                    box-sizing: border-box;
                                "
                            >

                                <option value="">
                                    Selecione
                                </option>

                                <option value="Dinheiro">
                                    Dinheiro
                                </option>

                                <option value="PIX">
                                    PIX
                                </option>

                                <option value="Cartão de débito">
                                    Cartão de débito
                                </option>

                                <option value="Cartão de crédito">
                                    Cartão de crédito
                                </option>

                                <option value="Transferência">
                                    Transferência
                                </option>

                                <option value="Outro">
                                    Outro
                                </option>

                            </select>

                        </div>


                        <button
                            type="button"
                            class="button"
                            id="venda-finalizar"
                            style="
                                width: 100%;
                                margin-top: 20px;
                                font-size: 16px;
                                padding: 13px;
                            "
                        >
                            ✓ Finalizar venda
                        </button>

                    </div>

                </div>

            </div>

        </div>

    `;


    /*
        ==================================================
        ELEMENTOS
        ==================================================
    */

    const campoCliente =
        document.getElementById(
            'venda-buscar-cliente'
        );


    const sugestoesCliente =
        document.getElementById(
            'venda-clientes-sugestoes'
        );


    const clienteSelecionadoDiv =
        document.getElementById(
            'venda-cliente-selecionado'
        );


    const campoProduto =
        document.getElementById(
            'venda-produto'
        );

    const sugestoesProduto =
        document.getElementById(
            'venda-produto-sugestoes'
        );

    let produtoSelecionado = null;


    const campoQuantidade =
        document.getElementById(
            'venda-quantidade'
        );


    const botaoAdicionar =
        document.getElementById(
            'venda-adicionar-produto'
        );


    const listaItens =
        document.getElementById(
            'venda-itens'
        );


    const campoDesconto =
        document.getElementById(
            'venda-desconto'
        );


    const campoFormaPagamento =
        document.getElementById(
            'venda-forma-pagamento'
        );


    const botaoFinalizar =
        document.getElementById(
            'venda-finalizar'
        );


    /*
        ==================================================
        CARREGAR PRODUTOS
        ==================================================
    */

    function selecionarProdutoVenda(produto) {

        produtoSelecionado = produto;

        campoProduto.value = produto.nome;

        sugestoesProduto.style.display = 'none';

        sugestoesProduto.innerHTML = '';

        campoQuantidade.focus();

    }

    function renderizarSugestoesProdutoVenda() {

        const termo = normalizarTexto(campoProduto.value);

        produtoSelecionado = null;

        sugestoesProduto.innerHTML = '';

        if (!termo) {
            sugestoesProduto.style.display = 'none';
            return;
        }

        const encontrados = produtos.filter(produto => {
            const nome = normalizarTexto(produto.nome || '');
            const sku = normalizarTexto(produto.sku || '');
            const codigo = normalizarTexto(produto.codigo_barras || '');
            return nome.includes(termo) || sku.includes(termo) || codigo.includes(termo);
        }).slice(0, 15);

        if (!encontrados.length) {
            sugestoesProduto.innerHTML = '<div style="padding:12px;color:#666;">Nenhum produto encontrado.</div>';
            sugestoesProduto.style.display = 'block';
            return;
        }

        encontrados.forEach(produto => {
            const item = document.createElement('div');
            item.style.padding = '10px 12px';
            item.style.cursor = 'pointer';
            item.style.borderBottom = '1px solid #eee';

            const estoque = Number(produto.estoque || 0);
            const preco = Number(produto.preco_venda || 0).toFixed(2).replace('.', ',');

            item.innerHTML = `
                <strong>${produto.nome}</strong>
                <div style="font-size:12px;color:#666;margin-top:3px;">
                    SKU: ${produto.sku || '-'} | Código: ${produto.codigo_barras || '-'} | Estoque: ${estoque} | R$ ${preco}
                </div>
            `;

            item.addEventListener('mouseenter', () => item.style.background = '#f3f4f6');
            item.addEventListener('mouseleave', () => item.style.background = '#fff');
            item.addEventListener('click', () => selecionarProdutoVenda(produto));
            sugestoesProduto.appendChild(item);
        });

        sugestoesProduto.style.display = 'block';
    }

    campoProduto.addEventListener('input', renderizarSugestoesProdutoVenda);

    campoProduto.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            const primeiro = produtos.filter(produto => {
                const termo = normalizarTexto(campoProduto.value);
                return normalizarTexto(produto.nome || '').includes(termo) ||
                       normalizarTexto(produto.sku || '').includes(termo) ||
                       normalizarTexto(produto.codigo_barras || '').includes(termo);
            })[0];
            if (primeiro) selecionarProdutoVenda(primeiro);
        }
        if (event.key === 'Escape') {
            sugestoesProduto.style.display = 'none';
        }
    });


    /*
        ==================================================
        BUSCA DE CLIENTES
        ==================================================
    */

    campoCliente.addEventListener(
        'input',
        () => {

            const termo =
                campoCliente.value
                    .trim()
                    .toLowerCase();


            clienteSelecionado =
                null;


            clienteSelecionadoDiv.style.display =
                'none';


            if (termo === '') {

                sugestoesCliente.style.display =
                    'none';

                return;

            }


            const termoNormalizado =
                normalizarTexto(termo);


            const encontrados =
                clientes.filter(cliente => {

                    const nome =
                        normalizarTexto(
                            cliente.nome
                        );

                    const cpf =
                        normalizarTexto(
                            cliente.cpf_cnpj
                        );

                    return (
                        nome.includes(termoNormalizado) ||
                        cpf.includes(termoNormalizado)
                    );

                });


            sugestoesCliente.innerHTML =
                '';


            if (
                encontrados.length === 0
            ) {

                sugestoesCliente.innerHTML = `

                    <div style="
                        padding: 12px;
                        color: #666;
                    ">
                        Nenhum cliente encontrado.
                    </div>

                `;


                sugestoesCliente.style.display =
                    'block';

                return;

            }


            encontrados.forEach(cliente => {

                const item =
                    document.createElement('div');


                item.style.padding =
                    '12px';


                item.style.cursor =
                    'pointer';


                item.style.borderBottom =
                    '1px solid #eee';


                const nome =
                    document.createElement('strong');


                nome.textContent =
                    cliente.nome;


                const cpf =
                    document.createElement('div');


                cpf.style.fontSize =
                    '12px';


                cpf.style.color =
                    '#666';


                cpf.textContent =
                    `CPF/CNPJ: ${cliente.cpf_cnpj || 'Não informado'}`;


                item.appendChild(
                    nome
                );


                item.appendChild(
                    cpf
                );


                item.addEventListener(
                    'mouseenter',
                    () => {

                        item.style.background =
                            '#f3f4f6';

                    }
                );


                item.addEventListener(
                    'mouseleave',
                    () => {

                        item.style.background =
                            'white';

                    }
                );


                item.addEventListener(
                    'click',
                    () => {

                        clienteSelecionado =
                            cliente;


                        campoCliente.value =
                            cliente.nome;


                        clienteSelecionadoDiv.innerHTML = `

                            <strong>
                                Cliente selecionado
                            </strong>

                            <div style="
                                margin-top: 6px;
                            ">

                                ${cliente.nome}

                            </div>

                            <div style="
                                font-size: 13px;
                                color: #666;
                                margin-top: 3px;
                            ">

                                CPF/CNPJ:
                                ${cliente.cpf_cnpj || 'Não informado'}

                            </div>

                        `;


                        clienteSelecionadoDiv.style.display =
                            'block';


                        sugestoesCliente.style.display =
                            'none';

                    }
                );


                sugestoesCliente.appendChild(
                    item
                );

            });


            sugestoesCliente.style.display =
                'block';

        }
    );


    // Ações no histórico do cliente podem abrir a venda já vinculada a ele.
    if (clienteInicialId != null) {
        const clienteInicial = clientes.find(cliente => Number(cliente.id) === Number(clienteInicialId));
        if (clienteInicial) {
            clienteSelecionado = clienteInicial;
            campoCliente.value = clienteInicial.nome || '';
            clienteSelecionadoDiv.innerHTML = `
                <strong>Cliente selecionado</strong>
                <div style="margin-top:6px;">${escaparLogin(clienteInicial.nome || '')}</div>
                <div style="font-size:13px;color:#666;margin-top:3px;">CPF/CNPJ: ${escaparLogin(clienteInicial.cpf_cnpj || 'Não informado')}</div>
            `;
            clienteSelecionadoDiv.style.display = 'block';
        }
    }

    /*
        ==================================================
        ADICIONAR PRODUTO
        ==================================================
    */

    botaoAdicionar.addEventListener(
        'click',
        () => {

            const produtoId =
                produtoSelecionado
                    ? Number(produtoSelecionado.id)
                    : 0;


            const quantidade =
                Number(
                    campoQuantidade.value
                );


            if (!produtoId) {

                alert(
                    'Digite o nome, SKU ou código de barras e selecione um produto.'
                );

                return;

            }


            if (
                !Number.isInteger(quantidade) ||
                quantidade <= 0
            ) {

                alert(
                    'Informe uma quantidade válida.'
                );

                return;

            }


            const produto =
                produtos.find(
                    item =>
                        item.id === produtoId
                );


            if (!produto) {

                return;

            }


            if (
                quantidade >
                produto.estoque
            ) {

                alert(
                    `Estoque insuficiente. Disponível: ${produto.estoque}.`
                );

                return;

            }


            const itemExistente =
                itensVenda.find(
                    item =>
                        item.produto_id ===
                        produto.id
                );


            if (itemExistente) {

                const novaQuantidade =
                    itemExistente.quantidade +
                    quantidade;


                if (
                    novaQuantidade >
                    produto.estoque
                ) {

                    alert(
                        `Estoque insuficiente. Disponível: ${produto.estoque}.`
                    );

                    return;

                }


                itemExistente.quantidade =
                    novaQuantidade;


                itemExistente.subtotal =
                    novaQuantidade *
                    itemExistente.preco_unitario;

            } else {

                itensVenda.push({

                    produto_id:
                        produto.id,

                    nome:
                        produto.nome,

                    quantidade:
                        quantidade,

                    preco_unitario:
                        Number(
                            produto.preco_venda
                        ) || 0,

                    subtotal:
                        quantidade *
                        (
                            Number(
                                produto.preco_venda
                            ) || 0
                        )

                });

            }


            campoQuantidade.value =
                '1';


            produtoSelecionado = null;

            campoProduto.value = '';

            sugestoesProduto.style.display = 'none';

            sugestoesProduto.innerHTML = '';


            renderizarItensVenda();

        }
    );


    /*
        ==================================================
        RENDERIZAR ITENS
        ==================================================
    */

    function renderizarItensVenda() {

        if (
            itensVenda.length === 0
        ) {

            listaItens.innerHTML = `

                <tr>

                    <td
                        colspan="5"
                        class="empty-table"
                    >

                        Nenhum produto
                        adicionado à venda.

                    </td>

                </tr>

            `;


            atualizarTotais();

            return;

        }


        listaItens.innerHTML =
            itensVenda.map(
                (item, index) => `

                    <tr>

                        <td>

                            <strong>
                                ${item.nome}
                            </strong>

                        </td>


                        <td>
                            ${item.quantidade}
                        </td>


                        <td>
                            R$ ${item.preco_unitario
                        .toFixed(2)
                        .replace('.', ',')}
                        </td>


                        <td>

                            R$ ${item.subtotal
                        .toFixed(2)
                        .replace('.', ',')}

                        </td>


                        <td>

                            <button
                                type="button"
                                class="button btn-remover-item-venda"
                                data-index="${index}"
                                style="
                                    background: #dc2626;
                                "
                            >
                                Remover
                            </button>

                        </td>

                    </tr>

                `
            )
                .join('');


        document
            .querySelectorAll(
                '.btn-remover-item-venda'
            )
            .forEach(botao => {

                botao.addEventListener(
                    'click',
                    () => {

                        const index =
                            Number(
                                botao.dataset.index
                            );


                        itensVenda.splice(
                            index,
                            1
                        );


                        renderizarItensVenda();

                    }
                );

            });


        atualizarTotais();

    }


    /*
        ==================================================
        ATUALIZAR TOTAIS
        ==================================================
    */

    function atualizarTotais() {

        const subtotal =
            itensVenda.reduce(
                (
                    total,
                    item
                ) =>
                    total +
                    item.subtotal,
                0
            );


        let percentualDesconto =
            Number(
                campoDesconto.value
            ) || 0;


        percentualDesconto = Math.min(
            100,
            Math.max(0, percentualDesconto)
        );


        const desconto =
            subtotal *
            (percentualDesconto / 100);


        const total =
            Math.max(0, subtotal - desconto);


        const campoValorDesconto =
            document.getElementById(
                'venda-desconto-valor'
            );

        if (campoValorDesconto) {
            campoValorDesconto.textContent =
                `R$ ${desconto.toFixed(2).replace('.', ',')}`;
        }


        document
            .getElementById(
                'venda-subtotal'
            )
            .textContent =
            `R$ ${subtotal.toFixed(2).replace('.', ',')}`;


        document
            .getElementById(
                'venda-total'
            )
            .textContent =
            `R$ ${total.toFixed(2).replace('.', ',')}`;

    }


    /*
        ==================================================
        DESCONTO
        ==================================================
    */

    campoDesconto.addEventListener(
        'input',
        atualizarTotais
    );


    /*
        ==================================================
        FINALIZAR VENDA
        ==================================================
    */

    botaoFinalizar.addEventListener(
        'click',
        async () => {

            if (
                itensVenda.length === 0
            ) {

                alert(
                    'Adicione pelo menos um produto à venda.'
                );

                return;

            }


            if (
                !campoFormaPagamento.value
            ) {

                alert(
                    'Selecione a forma de pagamento.'
                );

                return;

            }


            const confirmar =
                confirm(
                    'Deseja realmente finalizar esta venda?'
                );


            if (!confirmar) {

                return;

            }


            const subtotal =
                itensVenda.reduce(
                    (total, item) => total + item.subtotal,
                    0
                );

            let percentualDesconto =
                Number(campoDesconto.value) || 0;

            percentualDesconto = Math.min(
                100,
                Math.max(0, percentualDesconto)
            );

            const desconto =
                subtotal *
                (percentualDesconto / 100);


            const resultado =
                await window.api.finalizarVenda({

                    cliente_id:
                        clienteSelecionado
                            ? clienteSelecionado.id
                            : null,

                    itens:
                        itensVenda.map(item => ({

                            produto_id:
                                item.produto_id,

                            quantidade:
                                item.quantidade

                        })),

                    desconto:
                        desconto,

                    forma_pagamento:
                        campoFormaPagamento.value

                });


            if (
                resultado.sucesso
            ) {

                alert(
                    `Venda nº ${String(resultado.venda.numero).padStart(6, '0')} realizada com sucesso!`
                );


                await mostrarVendas();
                await atualizarNotificacoes();

            } else {

                alert(
                    resultado.mensagem ||
                    'Não foi possível finalizar a venda.'
                );

            }

        }
    );


    /*
        ==================================================
        INICIAR TABELA
        ==================================================
    */

    renderizarItensVenda();

    document
        .getElementById('vendas-abrir-historico')
        ?.addEventListener('click', () => {
            mostrarHistoricoVendas();
        });

}

/*
    ==================================================
    HISTÓRICO DE VENDAS
    ==================================================
*/

// Permite filtrar as vendas por cliente/número, status, período e pagamento.
async function mostrarHistoricoVendas() {

    marcarMenuAtivo(menuVendas);

    let vendas = [];

    try {
        vendas = await window.api.listarVendas();
    } catch (erro) {
        console.error('Erro ao carregar histórico de vendas:', erro);
        mostrarToast('Não foi possível carregar o histórico de vendas.', 'erro');
        return;
    }

    const escapar = (valor) => String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const moeda = (valor) =>
        `R$ ${Number(valor || 0).toFixed(2).replace('.', ',')}`;

    const numeroVenda = (valor) =>
        String(Number(valor || 0)).padStart(6, '0');

    const dataHora = (valor) => {
        if (!valor) return '—';
        const data = converterDataHoraLocal(valor);
        return data ? formatarDataHoraLocal(valor) : String(valor);
    };

    const obterStatus = (venda) => {
        const bruto = String(venda?.status || '').trim();
        if (!bruto) return 'Concluída';
        const normalizado = bruto.toLowerCase();
        if (normalizado.includes('cancel') || normalizado.includes('estorn')) return 'Cancelada';
        return bruto;
    };

    const classeStatus = (status) =>
        String(status).toLowerCase().includes('cancel') ? 'cancelada' : 'concluida';

    conteudo.innerHTML = `
        <div class="page-header vendas-page-header">
            <div>
                <h2>Vendas</h2>
                <p>Histórico de vendas realizadas</p>
            </div>

            <button
                type="button"
                class="button vendas-voltar-button"
                id="vendas-voltar-nova"
            >
                ← Nova venda
            </button>
        </div>

        <div class="panel vendas-historico-panel">
            <div class="vendas-filtros">
                <input
                    type="text"
                    id="historico-vendas-busca"
                    placeholder="🔎 Buscar por número ou cliente..."
                >

                <select id="historico-vendas-status">
                    <option value="todos">Todos os status</option>
                    <option value="concluida">Concluídas</option>
                    <option value="cancelada">Canceladas</option>
                </select>

                <input type="date" id="historico-vendas-data-inicial" title="Data inicial">
                <span class="vendas-filtro-separador">até</span>
                <input type="date" id="historico-vendas-data-final" title="Data final">

                <select id="historico-vendas-pagamento">
                    <option value="todos">Todos os pagamentos</option>
                    <option value="Dinheiro">Dinheiro</option>
                    <option value="PIX">PIX</option>
                    <option value="Cartão de débito">Cartão de débito</option>
                    <option value="Cartão de crédito">Cartão de crédito</option>
                    <option value="Transferência">Transferência</option>
                    <option value="Outro">Outro</option>
                </select>

                <div class="vendas-filtros-acoes">
                    <button type="button" class="button" id="historico-vendas-filtrar">
                        🔎 Filtrar
                    </button>
                    <button type="button" class="button vendas-filtro-limpar" id="historico-vendas-limpar">
                        Limpar
                    </button>
                </div>
            </div>

            <div class="vendas-historico-tabela table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Nº</th>
                            <th>Data e hora</th>
                            <th>Cliente</th>
                            <th>Pagamento</th>
                            <th>Total</th>
                            <th>Status</th>
                            <th>Ações</th>
                        </tr>
                    </thead>
                    <tbody id="historico-vendas-lista"></tbody>
                </table>
            </div>

            <div id="historico-vendas-contador" class="vendas-historico-contador"></div>
        </div>
    `;

    const campoBusca = document.getElementById('historico-vendas-busca');
    const campoStatus = document.getElementById('historico-vendas-status');
    const campoDataInicial = document.getElementById('historico-vendas-data-inicial');
    const campoDataFinal = document.getElementById('historico-vendas-data-final');
    const campoPagamento = document.getElementById('historico-vendas-pagamento');
    const lista = document.getElementById('historico-vendas-lista');
    const contador = document.getElementById('historico-vendas-contador');
    const chaveFiltros = 'gestor-facil:vendas:filtros:v1';

    // Guarda preferências no perfil local do renderer; se o armazenamento falhar,
    // os filtros continuam funcionando normalmente durante esta sessão.
    try {
        const salvos = JSON.parse(localStorage.getItem(chaveFiltros) || '{}');
        campoBusca.value = String(salvos.busca || '');
        campoDataInicial.value = String(salvos.dataInicial || '');
        campoDataFinal.value = String(salvos.dataFinal || '');
        if ([...campoStatus.options].some(opcao => opcao.value === salvos.status)) {
            campoStatus.value = salvos.status;
        }
        if ([...campoPagamento.options].some(opcao => opcao.value === salvos.pagamento)) {
            campoPagamento.value = salvos.pagamento;
        }
    } catch (erro) {
        console.warn('Não foi possível recuperar os filtros salvos:', erro);
    }

    function salvarFiltros() {
        try {
            localStorage.setItem(chaveFiltros, JSON.stringify({
                busca: campoBusca.value,
                status: campoStatus.value,
                dataInicial: campoDataInicial.value,
                dataFinal: campoDataFinal.value,
                pagamento: campoPagamento.value
            }));
        } catch (erro) {
            console.warn('Não foi possível salvar os filtros:', erro);
        }
    }

    function dataComparavel(valor) {
        if (!valor) return '';
        const data = converterDataHoraLocal(valor);
        if (!data) return '';
        return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
    }

    function renderizarHistorico() {
        const termo = String(campoBusca.value || '').trim().toLowerCase();
        const statusFiltro = campoStatus.value;
        const pagamentoFiltro = campoPagamento.value;
        const dataInicial = campoDataInicial.value;
        const dataFinal = campoDataFinal.value;

        const filtradas = (vendas || []).filter(venda => {
            const numero = numeroVenda(venda.numero).toLowerCase();
            const cliente = String(venda.cliente_nome || 'Cliente não informado').toLowerCase();
            const status = obterStatus(venda);
            const pagamento = String(venda.forma_pagamento || 'Não informado');
            const data = dataComparavel(venda.data_hora);

            if (termo && !numero.includes(termo) && !cliente.includes(termo)) return false;
            if (statusFiltro !== 'todos' && classeStatus(status) !== statusFiltro) return false;
            if (pagamentoFiltro !== 'todos' && pagamento !== pagamentoFiltro) return false;
            if (dataInicial && data && data < dataInicial) return false;
            if (dataFinal && data && data > dataFinal) return false;
            return true;
        });

        if (!filtradas.length) {
            lista.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-table">
                        📋
                        <strong>Nenhuma venda encontrada</strong>
                        <span>Ajuste os filtros ou realize uma nova venda.</span>
                    </td>
                </tr>
            `;
        } else {
            lista.innerHTML = filtradas.map(venda => {
                const status = obterStatus(venda);
                const classe = classeStatus(status);
                return `
                    <tr>
                        <td><strong>${numeroVenda(venda.numero)}</strong></td>
                        <td>${escapar(dataHora(venda.data_hora))}</td>
                        <td>${escapar(venda.cliente_nome || 'Cliente não informado')}</td>
                        <td>${escapar(venda.forma_pagamento || 'Não informado')}</td>
                        <td><strong>${moeda(venda.total)}</strong></td>
                        <td><span class="venda-status-badge ${classe}">${classe === 'cancelada' ? '✕' : '✓'} ${escapar(status)}</span></td>
                        <td>
                            <button type="button" class="button venda-btn-ver" data-id="${Number(venda.id)}">
                                👁 Ver
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        contador.textContent = `Mostrando ${filtradas.length} de ${vendas.length} venda${vendas.length === 1 ? '' : 's'}`;

        lista.querySelectorAll('.venda-btn-ver').forEach(botao => {
            botao.addEventListener('click', async () => {
                await abrirDetalhesVenda(Number(botao.dataset.id));
            });
        });
    }

    async function abrirDetalhesVenda(id) {
        const venda = await window.api.buscarVenda(id);
        if (!venda) {
            alert('Venda não encontrada.');
            return;
        }

        const status = obterStatus(venda);
        const bruto = Number(venda.subtotal || 0);
        const valorDesconto = Number(venda.desconto || 0);
        const percentual = bruto > 0 ? (valorDesconto / bruto) * 100 : 0;

        const overlay = document.createElement('div');
        overlay.className = 'vendas-modal-overlay';
        overlay.innerHTML = `
            <div class="vendas-modal-card" role="dialog" aria-modal="true">
                <div class="vendas-modal-header">
                    <div>
                        <h2>Detalhes da venda nº ${numeroVenda(venda.numero)}</h2>
                        <p>${escapar(dataHora(venda.data_hora))}</p>
                    </div>
                    <button type="button" class="vendas-modal-fechar" id="venda-modal-fechar">✕</button>
                </div>

                <div class="vendas-detalhes-grid">
                    <div><span>Cliente</span><strong>${escapar(venda.cliente_nome || 'Cliente não informado')}</strong></div>
                    <div><span>Pagamento</span><strong>${escapar(venda.forma_pagamento || 'Não informado')}</strong></div>
                    <div><span>Status</span><strong>${escapar(status)}</strong></div>
                    <div><span>Número</span><strong>${numeroVenda(venda.numero)}</strong></div>
                </div>

                <div class="vendas-modal-tabela table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>Produto</th>
                                <th>Qtd.</th>
                                <th>Valor unitário</th>
                                <th>Subtotal</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${(Array.isArray(venda.itens) ? venda.itens : []).map(item => `
                                <tr>
                                    <td><strong>${escapar(item.produto_nome || 'Produto')}</strong></td>
                                    <td>${Number(item.quantidade || 0)}</td>
                                    <td>${moeda(item.preco_unitario)}</td>
                                    <td>${moeda(item.subtotal)}</td>
                                </tr>
                            `).join('') || '<tr><td colspan="4" class="empty-table">Nenhum item encontrado.</td></tr>'}
                        </tbody>
                    </table>
                </div>

                <div class="vendas-totais-detalhes">
                    <div><span>Subtotal:</span><strong>${moeda(venda.subtotal)}</strong></div>
                    <div><span>Desconto (${percentual.toFixed(2).replace('.', ',')}%):</span><strong class="desconto">- ${moeda(valorDesconto)}</strong></div>
                    <div class="total"><span>Total:</span><strong>${moeda(venda.total)}</strong></div>
                </div>

                ${String(status).toLowerCase().includes('cancel') ? `<div class="venda-observacoes"><strong>Venda cancelada</strong><span>Em ${escapar(venda.cancelada_em ? formatarDataHoraLocal(venda.cancelada_em) : '-')} · Motivo: ${escapar(venda.cancelamento_motivo || 'Não informado')}</span></div>` : ''}

                ${venda.observacoes ? `<div class="venda-observacoes"><strong>Observações</strong><span>${escapar(venda.observacoes)}</span></div>` : ''}

                <div class="vendas-modal-acoes">
                    <button type="button" class="button vendas-btn-imprimir" id="venda-modal-imprimir">🖨 Imprimir</button>
                    ${!String(status).toLowerCase().includes('cancel') && usuarioPode('vendas', 'editar') ? `<button type="button" class="button" id="venda-modal-cancelar" style="background:#dc2626;">Cancelar venda</button>` : ''}
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const fechar = () => overlay.remove();
        overlay.querySelector('#venda-modal-fechar').addEventListener('click', fechar);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) fechar();
        });

        overlay.querySelector('#venda-modal-imprimir').addEventListener('click', () => {
            imprimirVenda(venda);
        });

        const botaoCancelar = overlay.querySelector('#venda-modal-cancelar');
        botaoCancelar?.addEventListener('click', () => {
            if (overlay.querySelector('#form-cancelar-venda')) return;

            const formularioCancelamento = document.createElement('section');
            formularioCancelamento.id = 'form-cancelar-venda';
            formularioCancelamento.setAttribute('role', 'dialog');
            formularioCancelamento.setAttribute('aria-modal', 'true');
            formularioCancelamento.setAttribute('aria-labelledby', 'titulo-cancelar-venda');
            formularioCancelamento.style.cssText = 'margin-top:18px;padding:18px;border:1px solid #fecaca;border-radius:12px;background:#fff7f7;';
            formularioCancelamento.innerHTML = `
                <h3 id="titulo-cancelar-venda" style="margin:0 0 6px;color:#991b1b;">Confirmar cancelamento da venda nº ${numeroVenda(venda.numero)}</h3>
                <p style="margin:0 0 12px;color:#64748b;font-size:13px;">A venda continuará no histórico e os produtos retornarão ao estoque. Informe o motivo para registrar a operação.</p>
                <label for="motivo-cancelamento-venda" style="display:block;margin-bottom:6px;font-weight:700;font-size:13px;">Motivo do cancelamento</label>
                <textarea id="motivo-cancelamento-venda" rows="3" maxlength="500" placeholder="Descreva o motivo (obrigatório)" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;resize:vertical;"></textarea>
                <div id="erro-cancelamento-venda" role="alert" style="display:none;margin-top:7px;color:#b91c1c;font-size:12px;"></div>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
                    <button type="button" class="button secondary" id="voltar-cancelamento-venda">Voltar</button>
                    <button type="button" class="button" id="confirmar-cancelamento-venda" style="background:#dc2626;">Confirmar cancelamento</button>
                </div>
            `;
            overlay.querySelector('.vendas-modal-card').appendChild(formularioCancelamento);

            const campoMotivo = formularioCancelamento.querySelector('#motivo-cancelamento-venda');
            const botaoConfirmar = formularioCancelamento.querySelector('#confirmar-cancelamento-venda');
            const mensagemErro = formularioCancelamento.querySelector('#erro-cancelamento-venda');
            campoMotivo.focus();

            formularioCancelamento.querySelector('#voltar-cancelamento-venda').addEventListener('click', () => {
                formularioCancelamento.remove();
            });

            botaoConfirmar.addEventListener('click', async () => {
                const motivo = campoMotivo.value.trim();
                if (motivo.length < 3) {
                    mensagemErro.textContent = 'Informe um motivo com pelo menos 3 caracteres.';
                    mensagemErro.style.display = 'block';
                    campoMotivo.focus();
                    return;
                }

                botaoConfirmar.disabled = true;
                botaoConfirmar.textContent = 'Processando...';
                mensagemErro.style.display = 'none';
                try {
                    const resultado = await window.api.cancelarVenda({ id: venda.id, motivo });
                    if (!resultado?.sucesso) {
                        mensagemErro.textContent = resultado?.mensagem || 'Não foi possível cancelar a venda.';
                        mensagemErro.style.display = 'block';
                        botaoConfirmar.disabled = false;
                        botaoConfirmar.textContent = 'Confirmar cancelamento';
                        return;
                    }

                    overlay.remove();
                    mostrarToast(`Venda nº ${numeroVenda(venda.numero)} cancelada. O estoque foi devolvido e o histórico foi preservado.`, 'sucesso');
                    await mostrarHistoricoVendas();
                } catch (erro) {
                    console.error('Erro ao cancelar venda:', erro);
                    mensagemErro.textContent = erro?.message || 'Não foi possível concluir o cancelamento. Tente novamente.';
                    mensagemErro.style.display = 'block';
                    botaoConfirmar.disabled = false;
                    botaoConfirmar.textContent = 'Confirmar cancelamento';
                }
            });
        });
    }

    function imprimirVenda(venda) {
        const janela = window.open('', '_blank', 'width=900,height=700');
        if (!janela) {
            alert('Não foi possível abrir a janela de impressão.');
            return;
        }

        const bruto = Number(venda.subtotal || 0);
        const desconto = Number(venda.desconto || 0);
        const percentual = bruto > 0 ? (desconto / bruto) * 100 : 0;
        const itens = Array.isArray(venda.itens) ? venda.itens : [];

        janela.document.write(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <title>Venda ${numeroVenda(venda.numero)} - Gestor Fácil</title>
                <style>
                    *{box-sizing:border-box} body{font-family:Arial,sans-serif;margin:0;padding:30px;color:#111;background:#fff} .cabecalho{border-bottom:2px solid #111;padding-bottom:15px;margin-bottom:20px}.cabecalho h1{margin:0 0 5px;font-size:24px}.cabecalho p{margin:0;color:#555;font-size:13px}.info{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}.info div{border:1px solid #ddd;border-radius:7px;padding:10px}.info span{display:block;color:#666;font-size:11px;margin-bottom:4px}.info strong{font-size:13px}table{width:100%;border-collapse:collapse;margin-bottom:20px}th,td{padding:9px;border-bottom:1px solid #ddd;text-align:left;font-size:12px}th{background:#f5f5f5}.totais{width:320px;margin-left:auto}.totais div{display:flex;justify-content:space-between;padding:6px 0}.totais .total{border-top:2px solid #111;margin-top:5px;padding-top:10px;font-size:18px;font-weight:bold}.observacoes{margin-top:20px;border:1px solid #ddd;padding:12px;border-radius:7px}.rodape{margin-top:35px;text-align:center;color:#666;font-size:11px}@media print{body{padding:10mm}.nao-imprimir{display:none!important}}
                </style>
            </head>
            <body>
                <div class="cabecalho"><h1>Gestor Fácil</h1><p>Comprovante de venda nº ${numeroVenda(venda.numero)}</p><p>${escapar(dataHora(venda.data_hora))}</p></div>
                <div class="info">
                    <div><span>Cliente</span><strong>${escapar(venda.cliente_nome || 'Cliente não informado')}</strong></div>
                    <div><span>Forma de pagamento</span><strong>${escapar(venda.forma_pagamento || 'Não informado')}</strong></div>
                </div>
                <table><thead><tr><th>Produto</th><th>Qtd.</th><th>Unitário</th><th>Subtotal</th></tr></thead><tbody>
                    ${itens.map(item => `<tr><td>${escapar(item.produto_nome || 'Produto')}</td><td>${Number(item.quantidade || 0)}</td><td>${moeda(item.preco_unitario)}</td><td>${moeda(item.subtotal)}</td></tr>`).join('')}
                </tbody></table>
                <div class="totais">
                    <div><span>Subtotal</span><strong>${moeda(venda.subtotal)}</strong></div>
                    <div><span>Desconto (${percentual.toFixed(2).replace('.', ',')}%)</span><strong>- ${moeda(desconto)}</strong></div>
                    <div class="total"><span>Total</span><strong>${moeda(venda.total)}</strong></div>
                </div>
                ${venda.observacoes ? `<div class="observacoes"><strong>Observações</strong><br>${escapar(venda.observacoes)}</div>` : ''}
                <div class="rodape">Gestor Fácil — Sistema de Gestão</div>
            </body>
            </html>
        `);
        janela.document.close();
        janela.focus();
        janela.setTimeout(() => janela.print(), 200);
    }

    document.getElementById('vendas-voltar-nova').addEventListener('click', () => mostrarVendas());

    const aplicarFiltros = () => {
        salvarFiltros();
        renderizarHistorico();
    };
    document.getElementById('historico-vendas-filtrar').addEventListener('click', aplicarFiltros);
    document.getElementById('historico-vendas-limpar').addEventListener('click', () => {
        campoBusca.value = '';
        campoStatus.value = 'todos';
        campoDataInicial.value = '';
        campoDataFinal.value = '';
        campoPagamento.value = 'todos';
        aplicarFiltros();
        mostrarToast('Filtros limpos. As preferências padrão foram salvas.', 'info');
    });
    campoBusca.addEventListener('input', aplicarFiltros);
    campoStatus.addEventListener('change', aplicarFiltros);
    campoPagamento.addEventListener('change', aplicarFiltros);
    campoDataInicial.addEventListener('change', aplicarFiltros);
    campoDataFinal.addEventListener('change', aplicarFiltros);

    renderizarHistorico();
}

/*
    ==================================================
    ESTOQUE
    ==================================================
*/

// Resume o estoque atual e oferece os fluxos de entrada, saída e ajuste.
async function mostrarEstoque() {

    marcarMenuAtivo(menuEstoque);

    let produtos = await window.api.listarProdutos();

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Estoque</h2>
                <p>Consulte e controle o estoque dos seus produtos</p>
            </div>
            <div style="display:flex;gap:10px;align-items:center;">
                <button class="button" id="entrada-estoque">➕ Entrada</button>
                <button class="button" id="saida-estoque" style="background:#dc2626;">➖ Saída</button>
                <button class="button" id="ajuste-estoque" style="background:#7c3aed;">🔧 Ajuste</button>
                <button class="button" id="historico-estoque" style="background:#374151;">📋 Histórico</button>
                <button class="button" id="atualizar-estoque">↻ Atualizar</button>
            </div>
        </div>

        <div class="cards" style="margin-bottom:20px;">
            <div class="card">
                <div class="card-icon blue">📦</div>
                <div><span>Total de produtos</span><h2 id="estoque-total-produtos">0</h2></div>
            </div>
            <div class="card">
                <div class="card-icon green">✅</div>
                <div><span>Estoque normal</span><h2 id="estoque-normal">0</h2></div>
            </div>
            <div class="card">
                <div class="card-icon orange">⚠️</div>
                <div><span>Estoque baixo</span><h2 id="estoque-baixo">0</h2></div>
            </div>
            <div class="card">
                <div class="card-icon purple">🔴</div>
                <div><span>Sem estoque</span><h2 id="estoque-zero">0</h2></div>
            </div>
        </div>

        <div class="panel">
            <div class="search-area">
                <input type="text" id="buscar-estoque" placeholder="🔍 Buscar por produto, SKU ou código de barras...">
            </div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>SKU</th>
                            <th>Produto</th>
                            <th>Categoria</th>
                            <th>Estoque atual</th>
                            <th>Estoque mínimo</th>
                            <th>Status</th>
                            <th>Preço de custo</th>
                            <th>Preço de venda</th>
                        </tr>
                    </thead>
                    <tbody id="lista-estoque"></tbody>
                </table>
            </div>
        </div>
    `;

    const lista = document.getElementById('lista-estoque');
    const busca = document.getElementById('buscar-estoque');

    const moeda = valor => `R$ ${Number(valor || 0).toFixed(2).replace('.', ',')}`;

    function statusProduto(produto) {
        const estoque = Number(produto.estoque) || 0;
        const minimo = Number(produto.estoque_minimo) || 0;
        if (estoque <= 0) return { texto: 'Sem estoque', fundo: '#fee2e2', cor: '#b91c1c' };
        if (estoque <= minimo) return { texto: 'Estoque baixo', fundo: '#ffedd5', cor: '#c2410c' };
        return { texto: 'Normal', fundo: '#dcfce7', cor: '#15803d' };
    }

    function atualizarResumo(listaProdutos) {
        let normal = 0, baixo = 0, zero = 0;
        listaProdutos.forEach(produto => {
            const status = statusProduto(produto).texto;
            if (status === 'Sem estoque') zero++;
            else if (status === 'Estoque baixo') baixo++;
            else normal++;
        });
        document.getElementById('estoque-total-produtos').textContent = listaProdutos.length;
        document.getElementById('estoque-normal').textContent = normal;
        document.getElementById('estoque-baixo').textContent = baixo;
        document.getElementById('estoque-zero').textContent = zero;
    }

    function renderizar(listaProdutos) {
        atualizarResumo(produtos);
        if (!listaProdutos.length) {
            lista.innerHTML = `<tr><td colspan="8" class="empty-table">📦<strong>Nenhum produto encontrado</strong><span>Tente outro nome, SKU ou código de barras.</span></td></tr>`;
            return;
        }
        lista.innerHTML = listaProdutos.map(produto => {
            const status = statusProduto(produto);
            return `
                <tr>
                    <td><strong>${produto.sku || '-'}</strong></td>
                    <td><strong>${produto.nome || '-'}</strong>${produto.codigo_barras ? `<small style="display:block;color:#6b7280;margin-top:4px;">EAN: ${produto.codigo_barras}</small>` : ''}</td>
                    <td>${produto.categoria || '-'}</td>
                    <td><strong style="font-size:16px;">${Number(produto.estoque) || 0}</strong></td>
                    <td>${Number(produto.estoque_minimo) || 0}</td>
                    <td><span style="display:inline-block;padding:5px 9px;border-radius:999px;background:${status.fundo};color:${status.cor};font-size:12px;font-weight:700;">${status.texto}</span></td>
                    <td>${moeda(produto.preco_custo)}</td>
                    <td>${moeda(produto.preco_venda)}</td>
                </tr>`;
        }).join('');
    }

    function filtrar() {
        const termo = normalizarTexto(busca.value);
        const filtrados = !termo ? produtos : produtos.filter(produto =>
            normalizarTexto(produto.nome).includes(termo) ||
            normalizarTexto(produto.sku).includes(termo) ||
            normalizarTexto(produto.codigo_barras).includes(termo) ||
            normalizarTexto(produto.categoria).includes(termo)
        );
        renderizar(filtrados);
    }

    busca.addEventListener('input', filtrar);
    document.getElementById('atualizar-estoque').addEventListener('click', async () => {
        produtos = await window.api.listarProdutos();
        filtrar();
    });

    document.getElementById('entrada-estoque').addEventListener('click', () => {
        abrirEntradaEstoque();
    });

    document.getElementById('saida-estoque').addEventListener('click', () => {
        abrirSaidaEstoque();
    });

    document.getElementById('ajuste-estoque').addEventListener('click', () => {
        abrirAjusteEstoque();
    });

    document.getElementById('historico-estoque').addEventListener('click', () => {
        mostrarHistoricoEstoque();
    });

    renderizar(produtos);
}


// Mostra entradas, saídas e ajustes com produto, origem e saldo resultante.
async function mostrarHistoricoEstoque() {

    const movimentacoes = await window.api.listarMovimentacoesEstoque();

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Histórico de Estoque</h2>
                <p>Consulte todas as movimentações realizadas no estoque</p>
            </div>
            <button class="button" id="voltar-estoque-historico">← Voltar ao estoque</button>
        </div>

        <div class="panel">
            <div style="padding:20px;display:grid;grid-template-columns:1fr 220px;gap:12px;">
                <input type="text" id="buscar-historico-estoque" placeholder="🔍 Buscar por produto, SKU ou código de barras..." style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;">
                <select id="filtro-tipo-historico" style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;">
                    <option value="">Todos os movimentos</option>
                    <option value="entrada">Entrada</option>
                    <option value="saida">Saída</option>
                    <option value="ajuste">Ajuste</option>
                </select>
            </div>

            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Data/Hora</th>
                            <th>Produto</th>
                            <th>Tipo</th>
                            <th>Quantidade</th>
                            <th>Anterior</th>
                            <th>Final</th>
                            <th>Motivo</th>
                            <th>Origem</th>
                        </tr>
                    </thead>
                    <tbody id="lista-historico-estoque"></tbody>
                </table>
            </div>
        </div>
    `;

    const lista = document.getElementById('lista-historico-estoque');
    const busca = document.getElementById('buscar-historico-estoque');
    const filtroTipo = document.getElementById('filtro-tipo-historico');

    function formatarData(data) {
        if (!data) return '-';
        return formatarDataHoraLocal(data);
    }

    function dadosMovimento(movimento) {
        const tipo = String(movimento.tipo || '').toLowerCase();
        if (tipo === 'entrada') return { texto: 'Entrada', cor: '#15803d', fundo: '#dcfce7', sinal: '+' };
        if (tipo === 'saida') return { texto: 'Saída', cor: '#b91c1c', fundo: '#fee2e2', sinal: '-' };
        return { texto: 'Ajuste', cor: '#6d28d9', fundo: '#ede9fe', sinal: '' };
    }

    function renderizarHistorico() {
        const termo = normalizarTexto(busca.value);
        const tipo = filtroTipo.value;

        const filtradas = movimentacoes.filter(movimento => {
            const correspondeTipo = !tipo || String(movimento.tipo || '').toLowerCase() === tipo;
            const textoBusca = normalizarTexto([
                movimento.produto_nome,
                movimento.sku,
                movimento.codigo_barras,
                movimento.motivo,
                movimento.origem,
                movimento.origem_id
            ].join(' '));
            return correspondeTipo && (!termo || textoBusca.includes(termo));
        });

        if (!filtradas.length) {
            lista.innerHTML = `
                <tr>
                    <td colspan="8" class="empty-table">
                        📋
                        <strong>Nenhuma movimentação encontrada</strong>
                        <span>Tente alterar os filtros ou realizar uma nova movimentação.</span>
                    </td>
                </tr>`;
            return;
        }

        lista.innerHTML = filtradas.map(movimento => {
            const info = dadosMovimento(movimento);
            const quantidade = Number(movimento.quantidade) || 0;

            let origemTexto = 'Manual';

            if (String(movimento.origem || '').toLowerCase() === 'venda') {
                origemTexto = `Venda ${String(movimento.origem_id || '').padStart(6, '0')}`;
            } else if (String(movimento.origem || '').toLowerCase() === 'os') {
                origemTexto = `OS ${String(movimento.origem_id || '').padStart(6, '0')}`;
            }

            return `
                <tr>
                    <td>${formatarData(movimento.data_hora)}</td>
                    <td>
                        <strong>${movimento.produto_nome || '-'}</strong>
                        ${movimento.sku ? `<small style="display:block;color:#6b7280;margin-top:3px;">SKU: ${movimento.sku}</small>` : ''}
                    </td>
                    <td><span style="display:inline-block;padding:5px 9px;border-radius:999px;background:${info.fundo};color:${info.cor};font-size:12px;font-weight:700;">${info.texto}</span></td>
                    <td><strong style="color:${info.cor};">${info.sinal}${quantidade}</strong></td>
                    <td>${Number(movimento.estoque_anterior) || 0}</td>
                    <td><strong>${Number(movimento.estoque_posterior) || 0}</strong></td>
                    <td>${movimento.motivo || '-'}</td>
                    <td><strong>${origemTexto}</strong></td>
                </tr>`;
        }).join('');
    }

    busca.addEventListener('input', renderizarHistorico);
    filtroTipo.addEventListener('change', renderizarHistorico);
    document.getElementById('voltar-estoque-historico').addEventListener('click', mostrarEstoque);

    renderizarHistorico();
}


// Registra reposição e informa motivo; o processo principal calcula o novo saldo.
async function abrirEntradaEstoque() {
    const produtosEntrada = await window.api.listarProdutos();
    let produtoSelecionado = null;

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Entrada de Estoque</h2>
                <p>Registre a entrada de produtos no estoque</p>
            </div>
        </div>

        <div class="panel">
            <form id="form-entrada-estoque" style="padding:25px;">
                <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;">
                    <div style="position:relative;">
                        <label for="entrada-produto">Produto</label>
                        <input id="entrada-produto" type="text" autocomplete="off" required placeholder="Digite nome, SKU ou código de barras..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                        <div id="entrada-produto-menu" style="display:none;position:absolute;z-index:1000;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #d1d5db;border-radius:7px;box-shadow:0 8px 20px rgba(0,0,0,.12);max-height:280px;overflow-y:auto;"></div>
                    </div>

                    <div>
                        <label>Quantidade</label>
                        <input id="entrada-quantidade" type="number" min="1" step="1" value="1" required style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>
                </div>

                <div style="margin-top:20px;">
                    <label>Motivo da entrada</label>
                    <input id="entrada-motivo" type="text" required placeholder="Ex.: Compra de fornecedor, reposição..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                </div>

                <div style="margin-top:30px;display:flex;gap:10px;">
                    <button type="submit" class="button">💾 Registrar entrada</button>
                    <button type="button" class="button" id="cancelar-entrada-estoque" style="background:#6b7280;">Cancelar</button>
                </div>
            </form>
        </div>
    `;

    const campoProduto = document.getElementById('entrada-produto');
    const menuProdutos = document.getElementById('entrada-produto-menu');
    const campoQuantidade = document.getElementById('entrada-quantidade');

    function textoProduto(produto) {
        return `${produto.nome} | SKU: ${produto.sku || '-'} | Estoque atual: ${Number(produto.estoque) || 0}`;
    }

    function esconderMenuProdutos() {
        menuProdutos.style.display = 'none';
        menuProdutos.innerHTML = '';
    }

    function selecionarProduto(produto) {
        produtoSelecionado = produto;
        campoProduto.value = textoProduto(produto);
        campoProduto.dataset.produtoId = String(produto.id);
        esconderMenuProdutos();
        campoQuantidade.focus();
        campoQuantidade.select();
    }

    function mostrarSugestoes() {
        const termo = campoProduto.value.trim().toLowerCase();
        const produtosFiltrados = produtosEntrada.filter(produto => {
            if (!termo) return true;
            const nome = String(produto.nome || '').toLowerCase();
            const sku = String(produto.sku || '').toLowerCase();
            const codigo = String(produto.codigo_barras || '').toLowerCase();
            return nome.includes(termo) || sku.includes(termo) || codigo.includes(termo);
        }).slice(0, 15);

        menuProdutos.innerHTML = '';

        if (!produtosFiltrados.length) {
            const vazio = document.createElement('div');
            vazio.textContent = 'Nenhum produto encontrado.';
            vazio.style.cssText = 'padding:12px;color:#6b7280;';
            menuProdutos.appendChild(vazio);
            menuProdutos.style.display = 'block';
            return;
        }

        produtosFiltrados.forEach(produto => {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = textoProduto(produto);
            item.style.cssText = 'display:block;width:100%;padding:11px 12px;border:0;background:#fff;text-align:left;cursor:pointer;font:inherit;color:#111827;';
            item.addEventListener('mouseenter', () => { item.style.background = '#f3f4f6'; });
            item.addEventListener('mouseleave', () => { item.style.background = '#fff'; });
            item.addEventListener('mousedown', event => {
                event.preventDefault();
                selecionarProduto(produto);
            });
            menuProdutos.appendChild(item);
        });

        menuProdutos.style.display = 'block';
    }

    campoProduto.addEventListener('focus', mostrarSugestoes);
    campoProduto.addEventListener('input', () => {
        produtoSelecionado = null;
        delete campoProduto.dataset.produtoId;
        mostrarSugestoes();
    });
    campoProduto.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            esconderMenuProdutos();
            return;
        }

        if (event.key === 'Enter' && menuProdutos.style.display !== 'none') {
            const termo = campoProduto.value.trim().toLowerCase();
            const primeiro = produtosEntrada.filter(produto => {
                if (!termo) return true;
                const nome = String(produto.nome || '').toLowerCase();
                const sku = String(produto.sku || '').toLowerCase();
                const codigo = String(produto.codigo_barras || '').toLowerCase();
                return nome.includes(termo) || sku.includes(termo) || codigo.includes(termo);
            })[0];

            if (primeiro) {
                event.preventDefault();
                selecionarProduto(primeiro);
            }
        }
    });
    campoProduto.addEventListener('blur', () => setTimeout(esconderMenuProdutos, 150));

    document.getElementById('cancelar-entrada-estoque').addEventListener('click', mostrarEstoque);

    document.getElementById('form-entrada-estoque').addEventListener('submit', async event => {
        event.preventDefault();

        const produtoId = Number(produtoSelecionado?.id);
        const quantidade = Number(campoQuantidade.value);
        const motivo = document.getElementById('entrada-motivo').value.trim();

        if (!produtoId) {
            alert('Selecione um produto da lista de sugestões.');
            campoProduto.focus();
            mostrarSugestoes();
            return;
        }

        if (!Number.isInteger(quantidade) || quantidade <= 0) {
            alert('Informe uma quantidade inteira maior que zero.');
            return;
        }

        if (!motivo) {
            alert('Informe o motivo da entrada.');
            return;
        }

        try {
            const resultado = await window.api.entradaEstoque({ produto_id: produtoId, quantidade, motivo });

            if (!resultado.sucesso) {
                alert(resultado.mensagem || 'Não foi possível registrar a entrada.');
                return;
            }

            alert(`Entrada registrada com sucesso!\nEstoque anterior: ${resultado.estoque_anterior}\nEstoque atual: ${resultado.estoque_posterior}`);
            await mostrarEstoque();
            await atualizarNotificacoes();
        } catch (erro) {
            console.error('Erro ao registrar entrada:', erro);
            alert('Não foi possível registrar a entrada de estoque.');
        }
    });
}

// Registra retirada manual; validação de quantidade e saldo ocorre no main.js.
async function abrirSaidaEstoque() {
    const produtosSaida = await window.api.listarProdutos();
    let produtoSelecionado = null;

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Saída de Estoque</h2>
                <p>Registre a saída de produtos do estoque</p>
            </div>
        </div>

        <div class="panel">
            <form id="form-saida-estoque" style="padding:25px;">
                <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;">
                    <div style="position:relative;">
                        <label for="saida-produto">Produto</label>
                        <input id="saida-produto" type="text" autocomplete="off" required placeholder="Digite nome, SKU ou código de barras..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                        <div id="saida-produto-menu" style="display:none;position:absolute;z-index:1000;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #d1d5db;border-radius:7px;box-shadow:0 8px 20px rgba(0,0,0,.12);max-height:280px;overflow-y:auto;"></div>
                    </div>

                    <div>
                        <label>Quantidade</label>
                        <input id="saida-quantidade" type="number" min="1" step="1" value="1" required style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>
                </div>

                <div style="margin-top:20px;">
                    <label>Motivo da saída</label>
                    <input id="saida-motivo" type="text" required placeholder="Ex.: Venda manual, perda, uso interno..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                </div>

                <div style="margin-top:30px;display:flex;gap:10px;">
                    <button type="submit" class="button" style="background:#dc2626;">➖ Registrar saída</button>
                    <button type="button" class="button" id="cancelar-saida-estoque" style="background:#6b7280;">Cancelar</button>
                </div>
            </form>
        </div>
    `;

    const campoProduto = document.getElementById('saida-produto');
    const menuProdutos = document.getElementById('saida-produto-menu');
    const campoQuantidade = document.getElementById('saida-quantidade');

    function textoProduto(produto) {
        return `${produto.nome} | SKU: ${produto.sku || '-'} | Estoque atual: ${Number(produto.estoque) || 0}`;
    }

    function esconderMenuProdutos() {
        menuProdutos.style.display = 'none';
        menuProdutos.innerHTML = '';
    }

    function selecionarProduto(produto) {
        produtoSelecionado = produto;
        campoProduto.value = textoProduto(produto);
        campoProduto.dataset.produtoId = String(produto.id);
        esconderMenuProdutos();
        campoQuantidade.focus();
        campoQuantidade.select();
    }

    function mostrarSugestoes() {
        const termo = campoProduto.value.trim().toLowerCase();
        const produtosFiltrados = produtosSaida.filter(produto => {
            if (!termo) return true;
            const nome = String(produto.nome || '').toLowerCase();
            const sku = String(produto.sku || '').toLowerCase();
            const codigo = String(produto.codigo_barras || '').toLowerCase();
            return nome.includes(termo) || sku.includes(termo) || codigo.includes(termo);
        }).slice(0, 15);

        menuProdutos.innerHTML = '';

        if (!produtosFiltrados.length) {
            const vazio = document.createElement('div');
            vazio.textContent = 'Nenhum produto encontrado.';
            vazio.style.cssText = 'padding:12px;color:#6b7280;';
            menuProdutos.appendChild(vazio);
            menuProdutos.style.display = 'block';
            return;
        }

        produtosFiltrados.forEach(produto => {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = textoProduto(produto);
            item.style.cssText = 'display:block;width:100%;padding:11px 12px;border:0;background:#fff;text-align:left;cursor:pointer;font:inherit;color:#111827;';
            item.addEventListener('mouseenter', () => { item.style.background = '#f3f4f6'; });
            item.addEventListener('mouseleave', () => { item.style.background = '#fff'; });
            item.addEventListener('mousedown', event => {
                event.preventDefault();
                selecionarProduto(produto);
            });
            menuProdutos.appendChild(item);
        });

        menuProdutos.style.display = 'block';
    }

    campoProduto.addEventListener('focus', mostrarSugestoes);
    campoProduto.addEventListener('input', () => {
        produtoSelecionado = null;
        delete campoProduto.dataset.produtoId;
        mostrarSugestoes();
    });
    campoProduto.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            esconderMenuProdutos();
            return;
        }

        if (event.key === 'Enter' && menuProdutos.style.display !== 'none') {
            const termo = campoProduto.value.trim().toLowerCase();
            const primeiro = produtosSaida.filter(produto => {
                if (!termo) return true;
                const nome = String(produto.nome || '').toLowerCase();
                const sku = String(produto.sku || '').toLowerCase();
                const codigo = String(produto.codigo_barras || '').toLowerCase();
                return nome.includes(termo) || sku.includes(termo) || codigo.includes(termo);
            })[0];

            if (primeiro) {
                event.preventDefault();
                selecionarProduto(primeiro);
            }
        }
    });
    campoProduto.addEventListener('blur', () => setTimeout(esconderMenuProdutos, 150));

    document.getElementById('cancelar-saida-estoque').addEventListener('click', mostrarEstoque);

    document.getElementById('form-saida-estoque').addEventListener('submit', async event => {
        event.preventDefault();

        const produtoId = Number(produtoSelecionado?.id);
        const quantidade = Number(campoQuantidade.value);
        const motivo = document.getElementById('saida-motivo').value.trim();

        if (!produtoId) {
            alert('Selecione um produto da lista de sugestões.');
            campoProduto.focus();
            mostrarSugestoes();
            return;
        }

        if (!Number.isInteger(quantidade) || quantidade <= 0) {
            alert('Informe uma quantidade inteira maior que zero.');
            return;
        }

        if (!motivo) {
            alert('Informe o motivo da saída.');
            return;
        }

        try {
            const resultado = await window.api.saidaEstoque({ produto_id: produtoId, quantidade, motivo });

            if (!resultado.sucesso) {
                alert(resultado.mensagem || 'Não foi possível registrar a saída.');
                return;
            }

            alert(`Saída registrada com sucesso!\nEstoque anterior: ${resultado.estoque_anterior}\nEstoque atual: ${resultado.estoque_posterior}`);
            await mostrarEstoque();
            await atualizarNotificacoes();
        } catch (erro) {
            console.error('Erro ao registrar saída:', erro);
            alert('Não foi possível registrar a saída de estoque.');
        }
    });
}

// Corrige o saldo para uma contagem física, mantendo um registro de auditoria.
async function abrirAjusteEstoque() {
    const produtosAjuste = await window.api.listarProdutos();
    let produtoSelecionado = null;

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Ajuste de Estoque</h2>
                <p>Corrija o estoque conforme a quantidade física encontrada</p>
            </div>
        </div>

        <div class="panel">
            <form id="form-ajuste-estoque" style="padding:25px;">
                <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;">
                    <div style="position:relative;">
                        <label for="ajuste-produto">Produto</label>
                        <input id="ajuste-produto" type="text" autocomplete="off" required placeholder="Digite nome, SKU ou código de barras..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                        <div id="ajuste-produto-menu" style="display:none;position:absolute;z-index:1000;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #d1d5db;border-radius:7px;box-shadow:0 8px 20px rgba(0,0,0,.12);max-height:280px;overflow-y:auto;"></div>
                    </div>

                    <div>
                        <label>Quantidade física</label>
                        <input id="ajuste-quantidade" type="number" min="0" step="1" value="0" required style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>
                </div>

                <div id="ajuste-resumo" style="margin-top:18px;padding:14px;background:#f3f4f6;border-radius:8px;color:#374151;">
                    Digite e selecione um produto para visualizar a diferença.
                </div>

                <div style="margin-top:20px;">
                    <label>Motivo do ajuste</label>
                    <input id="ajuste-motivo" type="text" required placeholder="Ex.: Inventário, contagem física, correção de cadastro..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                </div>

                <div style="margin-top:30px;display:flex;gap:10px;">
                    <button type="submit" class="button" style="background:#7c3aed;">🔧 Registrar ajuste</button>
                    <button type="button" class="button" id="cancelar-ajuste-estoque" style="background:#6b7280;">Cancelar</button>
                </div>
            </form>
        </div>
    `;

    const campoProduto = document.getElementById('ajuste-produto');
    const menuProdutos = document.getElementById('ajuste-produto-menu');
    const campoQuantidade = document.getElementById('ajuste-quantidade');
    const resumo = document.getElementById('ajuste-resumo');

    function textoProduto(produto) {
        return `${produto.nome} | SKU: ${produto.sku || '-'} | Estoque atual: ${Number(produto.estoque) || 0}`;
    }

    function atualizarResumo() {
        const estoqueAtual = produtoSelecionado
            ? Number(produtoSelecionado.estoque) || 0
            : null;
        const quantidadeFisica = Number(campoQuantidade.value);

        if (estoqueAtual === null || !Number.isInteger(quantidadeFisica) || quantidadeFisica < 0) {
            resumo.textContent = 'Digite e selecione um produto para visualizar a diferença.';
            return;
        }

        const diferenca = quantidadeFisica - estoqueAtual;
        const sinal = diferenca > 0 ? '+' : '';
        resumo.innerHTML = `Estoque atual: <strong>${estoqueAtual}</strong> &nbsp;|&nbsp; Diferença: <strong>${sinal}${diferenca}</strong> &nbsp;|&nbsp; Novo estoque: <strong>${quantidadeFisica}</strong>`;
    }

    function esconderMenuProdutos() {
        menuProdutos.style.display = 'none';
        menuProdutos.innerHTML = '';
    }

    function selecionarProduto(produto) {
        produtoSelecionado = produto;
        campoProduto.value = textoProduto(produto);
        campoProduto.dataset.produtoId = String(produto.id);
        esconderMenuProdutos();
        atualizarResumo();
        campoQuantidade.focus();
        campoQuantidade.select();
    }

    function mostrarSugestoes() {
        const termo = campoProduto.value.trim().toLowerCase();
        const produtosFiltrados = produtosAjuste.filter(produto => {
            if (!termo) return true;
            const nome = String(produto.nome || '').toLowerCase();
            const sku = String(produto.sku || '').toLowerCase();
            const codigo = String(produto.codigo_barras || '').toLowerCase();
            return nome.includes(termo) || sku.includes(termo) || codigo.includes(termo);
        }).slice(0, 15);

        menuProdutos.innerHTML = '';

        if (!produtosFiltrados.length) {
            const vazio = document.createElement('div');
            vazio.textContent = 'Nenhum produto encontrado.';
            vazio.style.cssText = 'padding:12px;color:#6b7280;';
            menuProdutos.appendChild(vazio);
            menuProdutos.style.display = 'block';
            return;
        }

        produtosFiltrados.forEach(produto => {
            const item = document.createElement('button');
            item.type = 'button';
            item.textContent = textoProduto(produto);
            item.style.cssText = 'display:block;width:100%;padding:11px 12px;border:0;background:#fff;text-align:left;cursor:pointer;font:inherit;color:#111827;';
            item.addEventListener('mouseenter', () => { item.style.background = '#f3f4f6'; });
            item.addEventListener('mouseleave', () => { item.style.background = '#fff'; });
            item.addEventListener('mousedown', event => {
                event.preventDefault();
                selecionarProduto(produto);
            });
            menuProdutos.appendChild(item);
        });

        menuProdutos.style.display = 'block';
    }

    campoProduto.addEventListener('focus', mostrarSugestoes);
    campoProduto.addEventListener('input', () => {
        produtoSelecionado = null;
        delete campoProduto.dataset.produtoId;
        atualizarResumo();
        mostrarSugestoes();
    });
    campoProduto.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            esconderMenuProdutos();
            return;
        }

        if (event.key === 'Enter' && menuProdutos.style.display !== 'none') {
            const primeiro = produtosAjuste.filter(produto => {
                const termo = campoProduto.value.trim().toLowerCase();
                if (!termo) return true;
                const nome = String(produto.nome || '').toLowerCase();
                const sku = String(produto.sku || '').toLowerCase();
                const codigo = String(produto.codigo_barras || '').toLowerCase();
                return nome.includes(termo) || sku.includes(termo) || codigo.includes(termo);
            })[0];

            if (primeiro) {
                event.preventDefault();
                selecionarProduto(primeiro);
            }
        }
    });
    campoProduto.addEventListener('blur', () => {
        setTimeout(esconderMenuProdutos, 150);
    });

    campoQuantidade.addEventListener('input', atualizarResumo);
    document.getElementById('cancelar-ajuste-estoque').addEventListener('click', mostrarEstoque);

    document.getElementById('form-ajuste-estoque').addEventListener('submit', async event => {
        event.preventDefault();

        const produtoId = Number(produtoSelecionado?.id);
        const quantidadeFisica = Number(campoQuantidade.value);
        const motivo = document.getElementById('ajuste-motivo').value.trim();

        if (!produtoId) {
            alert('Selecione um produto da lista de sugestões.');
            campoProduto.focus();
            mostrarSugestoes();
            return;
        }

        if (!Number.isInteger(quantidadeFisica) || quantidadeFisica < 0) {
            alert('Informe uma quantidade física válida.');
            return;
        }

        if (!motivo) {
            alert('Informe o motivo do ajuste.');
            return;
        }

        try {
            const resultado = await window.api.ajusteEstoque({
                produto_id: produtoId,
                quantidade_fisica: quantidadeFisica,
                motivo
            });

            if (!resultado.sucesso) {
                alert(resultado.mensagem || 'Não foi possível registrar o ajuste.');
                return;
            }

            const sinal = resultado.diferenca > 0 ? '+' : '';
            alert(
                `Ajuste registrado com sucesso!\n` +
                `Estoque anterior: ${resultado.estoque_anterior}\n` +
                `Diferença: ${sinal}${resultado.diferenca}\n` +
                `Estoque atual: ${resultado.estoque_posterior}`
            );

            await mostrarEstoque();
            await atualizarNotificacoes();
        } catch (erro) {
            console.error('Erro ao registrar ajuste de estoque:', erro);
            alert(erro.message || 'Não foi possível registrar o ajuste de estoque.');
        }
    });
}

/*
    ==================================================
    ORDENS DE SERVIÇO
    ==================================================
*/

// Lista OS e conecta filtros e ações de visualização, edição e criação.
async function mostrarOrdensServico() {

    marcarMenuAtivo(menuOS);

    const ordens =
        await window.api.listarOrdensServico();


    conteudo.innerHTML = `

        <div class="page-header">

            <div>

                <h2>Ordens de Serviço</h2>

                <p>
                    Gerencie as manutenções de computadores
                </p>

            </div>


            <button
                class="button"
                id="nova-os"
            >
                + Nova OS
            </button>

        </div>


        <div class="panel">

            <div class="search-area">

                <input
                    type="text"
                    id="buscar-os"
                    placeholder="🔍 Buscar por número, cliente, CPF/CNPJ, equipamento ou status..."
                >

            </div>


            <div class="table-container">

                <table>

                    <thead>

                        <tr>
                            <th>OS</th>
                            <th>Cliente</th>
                            <th>Equipamento</th>
                            <th>Problema</th>
                            <th>Status</th>
                            <th>Total</th>
                            <th>Ações</th>
                        </tr>

                    </thead>

                    <tbody id="lista-os"></tbody>

                </table>

            </div>

        </div>

    `;


    const lista = document.getElementById('lista-os');
    const campoBusca = document.getElementById('buscar-os');


    function renderizarOS(listaFiltrada) {

        if (listaFiltrada.length === 0) {

            lista.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-table">
                        🛠️
                        <strong>Nenhuma ordem de serviço encontrada</strong>
                        <span>Cadastre uma nova OS para começar.</span>
                    </td>
                </tr>
            `;

            return;

        }


        lista.innerHTML = listaFiltrada.map(os => {

            const total = Number(os.total || 0)
                .toFixed(2)
                .replace('.', ',');

            const status = os.status || 'Aguardando avaliação';

            return `
                <tr>

                    <td>
                        <strong>
                            OS ${String(os.numero).padStart(6, '0')}
                        </strong>
                        <small style="display:block;color:#6b7280;margin-top:4px;">
                            ${formatarDataHoraLocal(os.data_hora_abertura)}
                        </small>
                    </td>

                    <td>
                        <strong>${os.cliente_nome || '-'}</strong>
                        <small style="display:block;color:#6b7280;margin-top:4px;">
                            ${os.cliente_cpf_cnpj || ''}
                        </small>
                    </td>

                    <td>
                        ${os.tipo_equipamento || '-'}
                        <small style="display:block;color:#6b7280;margin-top:4px;">
                            ${os.marca || ''} ${os.modelo || ''}
                        </small>
                    </td>

                    <td>
                        ${os.problema_relatado || '-'}
                    </td>

                    <td>
                        <span style="
                            display:inline-block;
                            padding:5px 9px;
                            border-radius:999px;
                            background:#eef2ff;
                            color:#374151;
                            font-size:12px;
                            font-weight:600;
                        ">
                            ${status}
                        </span>
                    </td>

                    <td>
                        <strong>R$ ${total}</strong>
                    </td>

                    <td>
                        <button
                            class="button btn-editar-os"
                            data-id="${os.id}"
                            style="background:#6b7280;"
                        >
                            Editar
                        </button>

                        <button
                            class="button btn-imprimir-os"
                            data-id="${os.id}"
                            style="background:#2563eb;"
                        >
                            🖨️ Imprimir
                        </button>

                        <button
                            class="button btn-excluir-os"
                            data-id="${os.id}"
                            style="background:#dc2626;"
                        >
                            Excluir
                        </button>
                    </td>

                </tr>
            `;

        }).join('');


        document.querySelectorAll('.btn-editar-os').forEach(botao => {

            botao.addEventListener('click', async () => {

                const id = Number(botao.dataset.id);
                const os = await window.api.buscarOrdemServico(id);

                if (os) {
                    mostrarFormularioOS(os);
                }

            });

        });


        document.querySelectorAll('.btn-imprimir-os').forEach(botao => {

            botao.addEventListener('click', async () => {

                const id = Number(botao.dataset.id);

                const os = await window.api.buscarOrdemServico(id);

                if (!os) {
                    alert('Não foi possível localizar a ordem de serviço.');
                    return;
                }

                const cliente = {
                    nome: os.cliente_nome,
                    cpf_cnpj: os.cliente_cpf_cnpj,
                    telefone: os.cliente_telefone,
                    celular: os.cliente_celular,
                    email: os.cliente_email
                };

                const numeroOS = String(os.numero).padStart(6, '0');

                imprimirOrdemServico(os, numeroOS, cliente);

            });

        });


        document.querySelectorAll('.btn-excluir-os').forEach(botao => {

            botao.addEventListener('click', async () => {

                const id = Number(botao.dataset.id);

                const confirmar = confirm(
                    'Tem certeza que deseja excluir esta ordem de serviço?'
                );

                if (!confirmar) {
                    return;
                }

                const resultado =
                    await window.api.excluirOrdemServico(id);

                if (resultado.sucesso) {

                    await mostrarOrdensServico();
                    alert('Ordem de serviço excluída com sucesso!');

                } else {

                    alert(
                        resultado.mensagem ||
                        'Não foi possível excluir a ordem de serviço.'
                    );

                }

            });

        });

    }


    renderizarOS(ordens);


    campoBusca.addEventListener('input', () => {

        const termo = normalizarTexto(campoBusca.value);

        if (!termo) {
            renderizarOS(ordens);
            return;
        }

        const filtradas = ordens.filter(os => {

            const numero = String(os.numero || '');
            const cliente = normalizarTexto(os.cliente_nome);
            const cpf = normalizarTexto(os.cliente_cpf_cnpj);
            const equipamento = normalizarTexto(
                `${os.tipo_equipamento || ''} ${os.marca || ''} ${os.modelo || ''} ${os.numero_serie || ''}`
            );
            const problema = normalizarTexto(os.problema_relatado);
            const status = normalizarTexto(os.status);

            return (
                numero.includes(termo) ||
                cliente.includes(termo) ||
                cpf.includes(termo) ||
                equipamento.includes(termo) ||
                problema.includes(termo) ||
                status.includes(termo)
            );

        });

        renderizarOS(filtradas);

    });


    document
        .getElementById('nova-os')
        .addEventListener('click', () => mostrarFormularioOS());

}


// Cria/edita uma OS; peças selecionadas são enviadas para baixa de estoque.
async function mostrarFormularioOS(os = null, clienteInicialId = null) {

    marcarMenuAtivo(menuOS);

    const editando = os !== null;

    const titulo = editando
        ? `Editar OS ${String(os.numero).padStart(6, '0')}`
        : 'Nova Ordem de Serviço';


    conteudo.innerHTML = `

        <div class="page-header">

            <div>
                <h2>${titulo}</h2>
                <p>Cadastro e acompanhamento da manutenção</p>
            </div>

        </div>


        <div class="panel">

            <form id="form-os" style="padding:25px;">

                <h3 style="margin-top:0;">Cliente</h3>

                <div style="position:relative;margin-bottom:25px;">

                    <input
                        type="text"
                        id="os-buscar-cliente"
                        placeholder="Digite o nome ou CPF/CNPJ do cliente..."
                        autocomplete="off"
                        value="${editando ? (os.cliente_nome || '') : ''}"
                        style="width:100%;padding:12px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;"
                    >

                    <div
                        id="os-clientes-sugestoes"
                        style="display:none;position:absolute;top:100%;left:0;right:0;background:white;border:1px solid #d1d5db;border-radius:0 0 8px 8px;max-height:220px;overflow-y:auto;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,0.12);"
                    ></div>

                </div>

                <div
                    id="os-cliente-selecionado"
                    style="padding:14px;background:#f3f4f6;border-radius:8px;margin-bottom:25px;"
                >
                    ${editando && os.cliente_nome
            ? `<strong>${os.cliente_nome}</strong><br><small>${os.cliente_cpf_cnpj || ''}</small>`
            : 'Nenhum cliente selecionado.'}
                </div>


                <h3>Equipamento</h3>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">

                    <div>
                        <label>Tipo de equipamento</label>
                        <select id="os-tipo" required style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;">
                            <option value="">Selecione</option>
                            <option value="Desktop">Desktop</option>
                            <option value="Notebook">Notebook</option>
                            <option value="All-in-One">All-in-One</option>
                            <option value="Servidor">Servidor</option>
                        </select>
                    </div>

                    <div>
                        <label>Marca</label>
                        <input type="text" id="os-marca" value="${editando ? os.marca || '' : ''}" placeholder="Ex: Dell" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                    <div>
                        <label>Modelo</label>
                        <input type="text" id="os-modelo" value="${editando ? os.modelo || '' : ''}" placeholder="Ex: Inspiron 15" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                    <div>
                        <label>Número de série</label>
                        <input type="text" id="os-serie" value="${editando ? os.numero_serie || '' : ''}" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                    <div>
                        <label>Sistema operacional</label>
                        <input type="text" id="os-sistema" value="${editando ? os.sistema_operacional || '' : ''}" placeholder="Ex: Windows 11" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                    <div>
                        <label>Senha do equipamento</label>
                        <input type="text" id="os-senha" value="${editando ? os.senha_equipamento || '' : ''}" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                    <div style="grid-column:1 / -1;">
                        <label>Acessórios</label>
                        <input type="text" id="os-acessorios" value="${editando ? os.acessorios || '' : ''}" placeholder="Ex: Fonte, carregador, mouse..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                </div>


                <h3 style="margin-top:30px;">Entrada</h3>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">

                    <div>
                        <label>Previsão de entrega</label>
                        <input type="date" id="os-previsao" value="${editando ? os.previsao_entrega || '' : ''}" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                    <div>
                        <label>Status</label>
                        <select id="os-status" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;">
                            <option>Aguardando avaliação</option>
                            <option>Em diagnóstico</option>
                            <option>Orçamento enviado</option>
                            <option>Aguardando aprovação</option>
                            <option>Aguardando peça</option>
                            <option>Em manutenção</option>
                            <option>Pronto</option>
                            <option>Entregue</option>
                            <option>Cancelado</option>
                        </select>
                    </div>

                    <div style="grid-column:1 / -1;">
                        <label>Estado físico</label>
                        <textarea id="os-estado" rows="3" placeholder="Descreva o estado do equipamento na entrada..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;resize:vertical;">${editando ? os.estado_fisico || '' : ''}</textarea>
                    </div>

                    <div style="grid-column:1 / -1;">
                        <label>Avarias</label>
                        <textarea id="os-avarias" rows="3" placeholder="Riscos, trincas, peças quebradas, etc..." style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;resize:vertical;">${editando ? os.avarias || '' : ''}</textarea>
                    </div>

                    <div style="grid-column:1 / -1;">
                        <label>Observações</label>
                        <textarea id="os-observacoes" rows="3" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;resize:vertical;">${editando ? os.observacoes || '' : ''}</textarea>
                    </div>

                </div>


                <h3 style="margin-top:30px;">Diagnóstico e serviço</h3>

                <div style="display:grid;grid-template-columns:1fr;gap:18px;">

                    <div>
                        <label>Problema relatado pelo cliente</label>
                        <textarea id="os-problema" rows="4" required style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;resize:vertical;">${editando ? os.problema_relatado || '' : ''}</textarea>
                    </div>

                    <div>
                        <label>Diagnóstico</label>
                        <textarea id="os-diagnostico" rows="4" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;resize:vertical;">${editando ? os.diagnostico || '' : ''}</textarea>
                    </div>

                    <div>
                        <label>Serviço realizado</label>
                        <textarea id="os-servico" rows="4" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;resize:vertical;">${editando ? os.servico_realizado || '' : ''}</textarea>
                    </div>

                </div>


                <h3 style="margin-top:30px;">Peças e valores</h3>

                <div style="padding:16px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;">

                    <div style="display:grid;grid-template-columns:2fr 1fr auto;gap:12px;align-items:end;">

                        <div>
                            <label>Peça / produto</label>
                            <select id="os-produto-peca" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                                <option value="">Selecione uma peça do estoque...</option>
                            </select>
                        </div>

                        <div>
                            <label>Quantidade</label>
                            <input type="number" id="os-quantidade-peca" min="1" step="1" value="1" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                        </div>

                        <button type="button" class="button" id="os-adicionar-peca">
                            + Adicionar
                        </button>

                    </div>

                    <div id="os-itens-pecas" style="margin-top:16px;"></div>

                    <div style="margin-top:14px;text-align:right;font-weight:700;">
                        Total de peças: <span id="os-total-pecas">R$ 0,00</span>
                    </div>

                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px;">

                    <div>
                        <label>Mão de obra</label>
                        <input type="number" id="os-mao-obra" min="0" step="0.01" value="${editando ? Number(os.valor_mao_obra || 0) : 0}" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                    <div>
                        <label>Desconto (%)</label>
                        <input type="number" id="os-desconto" min="0" max="100" step="0.01" value="0" placeholder="Ex.: 10" style="width:100%;padding:11px;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
                    </div>

                </div>

                <div style="margin-top:14px;padding:12px 15px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-weight:600;color:#9a3412;">Valor do desconto:</span>
                    <strong id="os-valor-desconto" style="font-size:18px;color:#c2410c;">R$ 0,00</strong>
                </div>


                <div style="margin-top:20px;padding:18px;background:#f3f4f6;border-radius:8px;text-align:right;">
                    <span style="display:block;color:#6b7280;">Total da OS</span>
                    <strong id="os-total" style="font-size:26px;">R$ 0,00</strong>
                </div>


                <div style="margin-top:30px;display:flex;gap:10px;">

                    <button type="submit" class="button">
                        💾 ${editando ? 'Salvar alterações' : 'Salvar OS'}
                    </button>

                    <button
                        type="button"
                        class="button"
                        id="cancelar-os"
                        style="background:#6b7280;"
                    >
                        Cancelar
                    </button>

                </div>

            </form>

        </div>

    `;


    document.getElementById('os-tipo').value =
        editando ? (os.tipo_equipamento || '') : '';

    document.getElementById('os-status').value =
        editando ? (os.status || 'Aguardando avaliação') : 'Aguardando avaliação';


    const clientes = await window.api.listarClientes();
    const produtos = await window.api.listarProdutos();

    let clienteSelecionado = editando
        ? clientes.find(cliente => cliente.id === Number(os.cliente_id)) || null
        : clientes.find(cliente => Number(cliente.id) === Number(clienteInicialId)) || null;

    const itensPecas = editando
        ? (Array.isArray(os.itens_os) ? os.itens_os.map(item => ({
            id: item.id,
            produto_id: Number(item.produto_id),
            nome: item.produto_nome || item.descricao || 'Produto',
            quantidade: Number(item.quantidade) || 0,
            preco_unitario: Number(item.valor_unitario) || 0,
            subtotal: Number(item.subtotal) || 0,
            salvo: true
        })) : [])
        : [];

    // OS antigas podem ter somente o valor total das peças salvo, sem os itens.
    // Esse valor legado não pode ser associado automaticamente a um produto.
    const valorPecasJaRegistrado = editando && itensPecas.length === 0
        ? Number(os.valor_pecas || 0)
        : 0;

    const campoCliente = document.getElementById('os-buscar-cliente');
    const sugestoes = document.getElementById('os-clientes-sugestoes');
    const clienteBox = document.getElementById('os-cliente-selecionado');


    function atualizarClienteSelecionado() {

        if (!clienteSelecionado) {
            clienteBox.innerHTML = 'Nenhum cliente selecionado.';
            return;
        }

        clienteBox.innerHTML = `
            <strong>${clienteSelecionado.nome}</strong><br>
            <small>${clienteSelecionado.cpf_cnpj || 'CPF/CNPJ não informado'}</small>
        `;

        campoCliente.value = clienteSelecionado.nome;

    }


    function renderizarSugestoesOS() {

        const termo = normalizarTexto(campoCliente.value);

        if (!termo) {
            sugestoes.style.display = 'none';
            sugestoes.innerHTML = '';
            return;
        }

        const encontrados = clientes.filter(cliente => {

            const nome = normalizarTexto(cliente.nome);
            const cpf = normalizarTexto(cliente.cpf_cnpj);

            return nome.includes(termo) || cpf.includes(termo);

        });

        if (encontrados.length === 0) {
            sugestoes.innerHTML = `
                <div style="padding:12px;color:#6b7280;">
                    Nenhum cliente encontrado.
                </div>
            `;
            sugestoes.style.display = 'block';
            return;
        }

        sugestoes.innerHTML = encontrados.map(cliente => `
            <div
                class="os-cliente-opcao"
                data-id="${cliente.id}"
                style="padding:12px;cursor:pointer;border-bottom:1px solid #f1f5f9;"
            >
                <strong>${cliente.nome}</strong>
                <small style="display:block;color:#6b7280;margin-top:3px;">
                    ${cliente.cpf_cnpj || 'CPF/CNPJ não informado'}
                </small>
            </div>
        `).join('');

        sugestoes.style.display = 'block';

        sugestoes.querySelectorAll('.os-cliente-opcao').forEach(opcao => {

            opcao.addEventListener('click', () => {

                const id = Number(opcao.dataset.id);

                clienteSelecionado = clientes.find(
                    cliente => cliente.id === id
                ) || null;

                atualizarClienteSelecionado();
                sugestoes.style.display = 'none';

            });

        });

    }


    campoCliente.addEventListener('input', () => {
        clienteSelecionado = null;
        atualizarClienteSelecionado();
        renderizarSugestoesOS();
    });


    document.addEventListener('click', event => {

        if (
            !event.target.closest('#os-buscar-cliente') &&
            !event.target.closest('#os-clientes-sugestoes')
        ) {
            sugestoes.style.display = 'none';
        }

    }, { once: true });


    atualizarClienteSelecionado();


    const selectProdutoPeca =
        document.getElementById('os-produto-peca');

    const campoQuantidadePeca =
        document.getElementById('os-quantidade-peca');

    const listaItensPecas =
        document.getElementById('os-itens-pecas');

    const campoMaoObra =
        document.getElementById('os-mao-obra');

    const campoDesconto =
        document.getElementById('os-desconto');


    produtos.forEach(produto => {

        const option = document.createElement('option');

        option.value = produto.id;

        option.textContent =
            `${produto.nome} | Estoque: ${produto.estoque} | R$ ${Number(produto.preco_venda || 0).toFixed(2).replace('.', ',')}`;

        selectProdutoPeca.appendChild(option);

    });


    function formatarMoeda(valor) {
        return `R$ ${Number(valor || 0).toFixed(2).replace('.', ',')}`;
    }


    function totalPecas() {
        return valorPecasJaRegistrado + itensPecas.reduce(
            (total, item) => total + item.subtotal,
            0
        );
    }


    function renderizarItensPecas() {

        let htmlPecasJaRegistradas = '';

        if (valorPecasJaRegistrado > 0) {
            htmlPecasJaRegistradas = `
                <div style="padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:7px;margin-bottom:8px;">
                    <strong>Valor de peças já registrado:</strong> ${formatarMoeda(valorPecasJaRegistrado)}
                    <small style="display:block;color:#9a3412;margin-top:3px;">Esta OS foi criada antes do controle detalhado de peças. O produto original não foi salvo no banco.</small>
                </div>
            `;
        }

        if (itensPecas.length === 0) {

            listaItensPecas.innerHTML = htmlPecasJaRegistradas + `
                <div style="padding:12px;color:#6b7280;background:white;border:1px dashed #d1d5db;border-radius:7px;">
                    Nenhuma peça vinculada a esta OS.
                </div>
            `;

        } else {

            listaItensPecas.innerHTML = htmlPecasJaRegistradas + itensPecas.map((item, index) => `
                <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:10px;align-items:center;padding:10px;background:white;border-bottom:1px solid #e5e7eb;">
                    <div>
                        <strong>${item.nome}</strong>
                        <small style="display:block;color:#6b7280;">${formatarMoeda(item.preco_unitario)} cada</small>
                    </div>
                    <div>Qtd.: ${item.quantidade}</div>
                    <div><strong>${formatarMoeda(item.subtotal)}</strong></div>
                    <button type="button" class="button btn-remover-peca-os" data-index="${index}" style="background:#dc2626;">
                        Remover
                    </button>
                </div>
            `).join('');

        }

        document.getElementById('os-total-pecas').textContent =
            formatarMoeda(totalPecas());

        listaItensPecas.querySelectorAll('.btn-remover-peca-os').forEach(botao => {
            botao.addEventListener('click', () => {
                itensPecas.splice(Number(botao.dataset.index), 1);
                renderizarItensPecas();
                atualizarTotalOS();
            });
        });

    }


    function atualizarTotalOS() {

        const pecas = totalPecas();
        const maoObra = Number(campoMaoObra.value) || 0;
        const percentualDesconto = Math.min(100, Math.max(0, Number(campoDesconto.value) || 0));

        const bruto = pecas + maoObra;
        const descontoAplicado = bruto * (percentualDesconto / 100);
        const total = Math.max(0, bruto - descontoAplicado);

        document.getElementById('os-valor-desconto').textContent =
            formatarMoeda(descontoAplicado);

        document.getElementById('os-total').textContent =
            formatarMoeda(total);

        return {
            pecas,
            maoObra,
            percentualDesconto,
            desconto: descontoAplicado,
            total
        };

    }


    document.getElementById('os-adicionar-peca').addEventListener('click', () => {

        const produtoId = Number(selectProdutoPeca.value);
        const quantidade = Number(campoQuantidadePeca.value);

        if (!produtoId) {
            alert('Selecione uma peça/produto.');
            return;
        }

        if (!Number.isInteger(quantidade) || quantidade <= 0) {
            alert('Informe uma quantidade válida.');
            return;
        }

        const produto = produtos.find(item => item.id === produtoId);

        if (!produto) {
            alert('Produto não encontrado.');
            return;
        }

        const existente = itensPecas.find(item => item.produto_id === produtoId);
        const quantidadeAtual = existente ? existente.quantidade : 0;
        const estoqueOriginalDaOS = existente && existente.salvo
            ? quantidadeAtual
            : 0;
        const estoqueDisponivelParaEdicao = Number(produto.estoque || 0) + estoqueOriginalDaOS;

        if (quantidadeAtual + quantidade > estoqueDisponivelParaEdicao) {
            alert(`Estoque insuficiente. Disponível para esta OS: ${estoqueDisponivelParaEdicao}.`);
            return;
        }

        if (existente) {
            existente.quantidade += quantidade;
            existente.subtotal = existente.quantidade * existente.preco_unitario;
        } else {
            const preco = Number(produto.preco_venda || 0);

            itensPecas.push({
                produto_id: produto.id,
                nome: produto.nome,
                quantidade,
                preco_unitario: preco,
                subtotal: preco * quantidade
            });
        }

        selectProdutoPeca.value = '';
        campoQuantidadePeca.value = '1';

        renderizarItensPecas();
        atualizarTotalOS();

    });


    campoMaoObra.addEventListener('input', atualizarTotalOS);
    campoDesconto.addEventListener('input', atualizarTotalOS);

    if (editando) {
        const brutoInicial = totalPecas() + (Number(campoMaoObra.value) || 0);
        const descontoPercentualInicial = brutoInicial > 0
            ? ((Number(os.desconto || 0) / brutoInicial) * 100)
            : 0;

        campoDesconto.value = descontoPercentualInicial
            .toFixed(2)
            .replace(/\.?0+$/, '');
    }

    renderizarItensPecas();
    atualizarTotalOS();


    document.getElementById('cancelar-os').addEventListener(
        'click',
        mostrarOrdensServico
    );


    document.getElementById('form-os').addEventListener('submit', async event => {

        event.preventDefault();

        if (!clienteSelecionado) {
            alert('Selecione um cliente para a ordem de serviço.');
            return;
        }

        const valores = atualizarTotalOS();

        const pecas = valores.pecas;
        const maoObra = valores.maoObra;
        const desconto = valores.desconto;
        const total = valores.total;

        const dados = {

            cliente_id: clienteSelecionado.id,
            tipo_equipamento: document.getElementById('os-tipo').value,
            marca: document.getElementById('os-marca').value.trim(),
            modelo: document.getElementById('os-modelo').value.trim(),
            numero_serie: document.getElementById('os-serie').value.trim(),
            sistema_operacional: document.getElementById('os-sistema').value.trim(),
            senha_equipamento: document.getElementById('os-senha').value.trim(),
            acessorios: document.getElementById('os-acessorios').value.trim(),
            estado_fisico: document.getElementById('os-estado').value.trim(),
            avarias: document.getElementById('os-avarias').value.trim(),
            problema_relatado: document.getElementById('os-problema').value.trim(),
            diagnostico: document.getElementById('os-diagnostico').value.trim(),
            servico_realizado: document.getElementById('os-servico').value.trim(),
            previsao_entrega: document.getElementById('os-previsao').value || null,
            status: document.getElementById('os-status').value,
            valor_pecas: pecas,
            itens_pecas: itensPecas.map(item => ({
                produto_id: item.produto_id,
                descricao: item.nome,
                tipo: 'peca',
                quantidade: item.quantidade,
                preco_unitario: item.preco_unitario,
                subtotal: item.subtotal
            })),
            valor_mao_obra: maoObra,
            desconto,
            total,
            observacoes: document.getElementById('os-observacoes').value.trim()

        };


        if (editando) {
            dados.id = os.id;
        }


        const resultado = editando
            ? await window.api.editarOrdemServico(dados)
            : await window.api.cadastrarOrdemServico(dados);


        if (resultado.sucesso) {

            const numeroOS = editando
                ? String(os.numero).padStart(6, '0')
                : String(resultado.os.numero).padStart(6, '0');

            alert(
                editando
                    ? 'Ordem de serviço atualizada com sucesso!'
                    : `OS ${numeroOS} cadastrada com sucesso!`
            );

            if (!editando) {

                const imprimir = confirm(
                    `OS ${numeroOS} cadastrada com sucesso!\n\nDeseja imprimir a Ordem de Serviço agora?`
                );

                if (imprimir) {
                    imprimirOrdemServico(dados, numeroOS, clienteSelecionado);
                }

            }

            await mostrarOrdensServico();

        } else {

            alert(
                resultado.mensagem ||
                'Não foi possível salvar a ordem de serviço.'
            );

        }

    });

}


/*
    ==================================================
    IMPRIMIR ORDEM DE SERVIÇO
    ==================================================
*/

// Gera uma página imprimível separada com dados do equipamento, serviço e cliente.
function imprimirOrdemServico(dados, numeroOS, cliente = {}) {

    const formatarData = valor => {
        if (!valor) return '-';

        const partes = String(valor).split('-');

        if (partes.length === 3) {
            return `${partes[2]}/${partes[1]}/${partes[0]}`;
        }

        return valor;
    };

    const agora = new Date();

    const dataHoraImpressao =
        agora.toLocaleDateString('pt-BR') +
        ' às ' +
        agora.toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit'
        });

    const escapar = valor =>
        String(valor ?? '-')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\"/g, '&quot;')
            .replace(/'/g, '&#039;');

    const janela = window.open('', '_blank', 'width=900,height=700');

    if (!janela) {
        alert('Não foi possível abrir a tela de impressão. Verifique se o bloqueio de janelas está ativado.');
        return;
    }

    janela.document.write(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <title>OS ${escapar(numeroOS)}</title>
            <style>
                * { box-sizing: border-box; }
                body { font-family: Arial, sans-serif; margin: 0; padding: 30px; color: #111; }
                .cabecalho { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 15px; margin-bottom: 20px; }
                h1 { margin: 0; font-size: 24px; }
                .secao { margin-top: 18px; border: 1px solid #ccc; padding: 15px; }
                .titulo { font-weight: bold; font-size: 15px; margin-bottom: 10px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 25px; }
                .campo { margin-bottom: 6px; }
                .rotulo { font-weight: bold; }
                .texto { white-space: pre-wrap; min-height: 25px; }
                .titulo-cliente { display: flex; justify-content: space-between; align-items: center; }
                .assinatura-cliente { width: 58%; margin: 55px auto 0; page-break-inside: avoid; }
                .linha { border-top: 1px solid #111; text-align: center; padding-top: 7px; }
                .data-hora { text-align: center; font-size: 10px; margin-top: 8px; }
                .termos-cliente {
                    margin: 0 0 14px 0;
                    padding: 0 0 12px 0;
                    border-bottom: 2px dashed #111;
                    page-break-inside: avoid;
                }
                .termos-cabecalho {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    gap: 15px;
                    margin-bottom: 8px;
                }
                .termos-titulo {
                    font-size: 13px;
                    font-weight: 800;
                    text-transform: uppercase;
                    margin: 0;
                }
                .termos-os {
                    font-size: 15px;
                    font-weight: 800;
                    white-space: nowrap;
                }
                .termo {
                    font-size: 9.5px;
                    line-height: 1.35;
                    text-align: justify;
                    margin-bottom: 7px;
                }
                .termo {
                    font-size: 10.5px;
                    line-height: 1.45;
                    text-align: justify;
                    margin-bottom: 10px;
                }
                .termo:last-child { margin-bottom: 0; }
                .termo strong { font-weight: 700; }
                .rodape { margin-top: 25px; font-size: 11px; text-align: center; color: #666; }
                @media print { body { padding: 10mm; } .termos { page-break-inside: avoid; } #btn-imprimir-documento { display: none !important; } }
            </style>
        </head>
        <body>
            <div class="cabecalho">
                <div>
                    <h1>ORDEM DE SERVIÇO</h1>
                    <div>Gestor Fácil</div>
                </div>
            </div>

            <div class="termos-cliente">
                <div class="termos-cabecalho">
                    <div class="termos-titulo">TERMOS DE RETIRADA E COMUNICAÇÃO ELETRÔNICA</div>
                    <div class="termos-os">OS Nº ${escapar(numeroOS)}</div>
                </div>

                <div class="termo">
                    <strong>1. PRAZO DE RETIRADA E TAXA DE ARMAZENAMENTO:</strong> O cliente concorda e declara-se ciente de que, após ser oficialmente notificado da conclusão do serviço (ou da impossibilidade de sua execução), terá o prazo de <strong>30 dias corridos</strong> para realizar a retirada do equipamento sem custos adicionais. Decorrido este prazo, caso o objeto permaneça sob a guarda da assistência técnica, será cobrada uma taxa diária de armazenamento no valor de <strong>R$ 2,00</strong> a título de depósito do bem, cujo valor acumulado limita-se ao valor total do orçamento ou do próprio equipamento.
                </div>

                <div class="termo">
                    <strong>2. CONSENTIMENTO DE NOTIFICAÇÃO ELETRÔNICA:</strong> O cliente autoriza expressamente o envio de notificações, orçamentos, avisos de conclusão e alertas de cobrança por meio dos canais digitais informados nesta Ordem de Serviço, tais como WhatsApp, E-mail, SMS e Ligação. Os avisos enviados por estas plataformas eletrônicas possuem validade legal de comunicação formal e inequívoca a partir da data de confirmação de envio ou entrega registrada pelo sistema.
                </div>
            </div>

            <div class="secao">
                <div class="titulo titulo-cliente">
                    <span>CLIENTE</span>
                    <span style="text-align:right;">
                        OS Nº ${escapar(numeroOS)}<br>
                        <small style="font-weight:normal;">${escapar(dataHoraImpressao)}</small>
                    </span>
                </div>
                <div class="grid">
                    <div class="campo"><span class="rotulo">Nome:</span> ${escapar(cliente.nome)}</div>
                    <div class="campo"><span class="rotulo">CPF/CNPJ:</span> ${escapar(cliente.cpf_cnpj)}</div>
                    <div class="campo"><span class="rotulo">Telefone:</span> ${escapar(cliente.telefone || cliente.celular)}</div>
                    <div class="campo"><span class="rotulo">E-mail:</span> ${escapar(cliente.email)}</div>
                </div>
            </div>

            <div class="secao">
                <div class="titulo">EQUIPAMENTO</div>
                <div class="grid">
                    <div class="campo"><span class="rotulo">Tipo:</span> ${escapar(dados.tipo_equipamento)}</div>
                    <div class="campo"><span class="rotulo">Marca:</span> ${escapar(dados.marca)}</div>
                    <div class="campo"><span class="rotulo">Modelo:</span> ${escapar(dados.modelo)}</div>
                    <div class="campo"><span class="rotulo">Nº de série:</span> ${escapar(dados.numero_serie)}</div>
                    <div class="campo"><span class="rotulo">Sistema operacional:</span> ${escapar(dados.sistema_operacional)}</div>
                    <div class="campo"><span class="rotulo">Acessórios:</span> ${escapar(dados.acessorios)}</div>
                </div>
            </div>

            <div class="secao">
                <div class="titulo">ATENDIMENTO</div>
                <div class="campo"><span class="rotulo">Problema relatado:</span><div class="texto">${escapar(dados.problema_relatado)}</div></div>
                <div class="campo"><span class="rotulo">Estado físico:</span><div class="texto">${escapar(dados.estado_fisico)}</div></div>
                <div class="campo"><span class="rotulo">Avarias:</span><div class="texto">${escapar(dados.avarias)}</div></div>
                <div class="campo"><span class="rotulo">Observações:</span><div class="texto">${escapar(dados.observacoes)}</div></div>
            </div>

            <div class="secao">
                <div class="titulo">PRAZO E STATUS</div>
                <div class="grid">
                    <div class="campo"><span class="rotulo">Status:</span> ${escapar(dados.status)}</div>
                    <div class="campo"><span class="rotulo">Previsão de entrega:</span> ${escapar(formatarData(dados.previsao_entrega))}</div>
                </div>
            </div>

            <div class="secao">
                <div class="titulo">VALORES</div>
                <div class="grid">
                    <div class="campo"><span class="rotulo">Peças:</span> R$ ${Number(dados.valor_pecas || 0).toFixed(2).replace('.', ',')}</div>
                    <div class="campo"><span class="rotulo">Mão de obra:</span> R$ ${Number(dados.valor_mao_obra || 0).toFixed(2).replace('.', ',')}</div>
                    <div class="campo"><span class="rotulo">Desconto:</span> ${(() => { const bruto = Number(dados.valor_pecas || 0) + Number(dados.valor_mao_obra || 0); const valor = Number(dados.desconto || 0); const pct = bruto > 0 ? (valor / bruto) * 100 : 0; return `${pct.toFixed(2).replace('.', ',')}% — R$ ${valor.toFixed(2).replace('.', ',')}`; })()}</div>
                    <div class="campo"><span class="rotulo">Total:</span> <strong>R$ ${Number(dados.total || 0).toFixed(2).replace('.', ',')}</strong></div>
                </div>
            </div>

            <div class="assinatura-cliente">
                <div class="linha">Assinatura do cliente</div>
            </div>

            <div class="rodape">Documento gerado pelo Gestor Fácil</div>

            <div style="position:fixed;top:15px;left:15px;z-index:9999;">
                <button
                    id="btn-imprimir-documento"
                    type="button"
                    style="padding:12px 24px;background:#2563eb;color:white;border:none;border-radius:7px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.18);"
                >
                    🖨️ Imprimir OS
                </button>
            </div>

            <script>
                window.onload = function() {
                    const botao = document.getElementById('btn-imprimir-documento');

                    if (botao) {
                        botao.addEventListener('click', function() {
                            window.print();
                        });
                    }
                };
            <\/script>
        </body>
        </html>
    `);

    janela.document.close();

}


/*
    ==================================================
    FIM VENDAS
    ==================================================
*/

/* ==================================================
   GARANTIAS
   ================================================== */

// Lista garantias e usa vendas/OS selecionadas como origem do vínculo.
async function mostrarGarantias() {
    conteudo.innerHTML = `
        <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;gap:15px;flex-wrap:wrap;">
            <div>
                <h2>Garantias</h2>
                <p>Consulte e cadastre as garantias dos serviços e produtos.</p>
            </div>
            <button id="nova-garantia" class="button button-primary">+ Nova garantia</button>
        </div>

        <div id="formulario-garantia"></div>

        <div style="margin-top:20px;">
            <input id="busca-garantia" type="text" placeholder="Buscar cliente, CPF/CNPJ, OS ou venda..." style="max-width:420px;width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:7px;box-sizing:border-box;">
        </div>

        <div class="card" style="margin-top:15px;overflow:auto;">
            <div id="lista-garantias"></div>
        </div>
    `;

    const lista = document.getElementById('lista-garantias');
    const form = document.getElementById('formulario-garantia');
    const busca = document.getElementById('busca-garantia');
    const podeEditarGarantia = usuarioPode('garantias', 'editar');
    let garantias = [];

    const escapar = valor => String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const dataBR = valor => {
        if (!valor) return '-';
        const data = new Date(String(valor).replace(' ', 'T'));
        if (Number.isNaN(data.getTime())) return String(valor);
        return data.toLocaleDateString('pt-BR');
    };

    const formatarDocumento = valor => {
        const original = String(valor ?? '').trim();
        const digitos = original.replace(/\D/g, '');

        if (digitos.length === 11) {
            return digitos.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        }

        if (digitos.length === 14) {
            return digitos.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
        }

        return original || '-';
    };

    const statusBadge = status => {
        const classe = status === 'Ativa' ? '#166534' : '#991b1b';
        const fundo = status === 'Ativa' ? '#dcfce7' : '#fee2e2';
        return `<span style="display:inline-block;padding:5px 9px;border-radius:999px;background:${fundo};color:${classe};font-size:12px;font-weight:700;">${escapar(status)}</span>`;
    };

    function renderizarLista() {
        const termo = normalizarTexto(busca.value);
        const filtradas = garantias.filter(g => {
            const texto = [
                g.cliente_nome,
                g.cliente_documento,
                g.os_numero ? `OS ${g.os_numero}` : '',
                g.venda_numero ? `Venda ${g.venda_numero}` : '',
                g.produto_nome,
                g.produtos_nomes,
                g.descricao,
                g.status
            ].join(' ');
            return normalizarTexto(texto).includes(termo);
        });

        if (!filtradas.length) {
            lista.innerHTML = `<div style="padding:30px;text-align:center;color:#6b7280;">Nenhuma garantia encontrada.</div>`;
            return;
        }

        lista.innerHTML = `
            <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
                <thead>
                    <tr style="text-align:left;border-bottom:1px solid #e5e7eb;">
                        <th style="padding:10px 9px;width:15%;">Cliente</th>
                        <th style="padding:10px 9px;width:9%;">Origem</th>
                        <th style="padding:10px 9px;width:19%;">Produto/Serviço</th>
                        <th style="padding:10px 9px;width:10%;">Início</th>
                        <th style="padding:10px 9px;width:10%;">Término</th>
                        <th style="padding:10px 9px;width:8%;">Prazo</th>
                        <th style="padding:10px 9px;width:8%;">Status</th>
                        <th style="padding:10px 9px;width:21%;text-align:center;">Ações</th>
                    </tr>
                </thead>
                <tbody>
                    ${filtradas.map(g => `
                        <tr style="border-bottom:1px solid #f1f5f9;">
                            <td style="padding:10px 9px;overflow-wrap:anywhere;"><strong>${escapar(g.cliente_nome)}</strong><br><small style="color:#6b7280;">${escapar(formatarDocumento(g.cliente_documento))}</small></td>
                            <td style="padding:10px 9px;overflow-wrap:anywhere;">${g.os_numero ? `OS ${escapar(g.os_numero)}` : `Venda ${escapar(g.venda_numero)}`}</td>
                            <td style="padding:10px 9px;white-space:normal;overflow-wrap:anywhere;line-height:1.35;">${g.produtos_nomes ? escapar(String(g.produtos_nomes).split('||').join(', ')) : escapar(g.produto_nome || g.descricao || 'Serviço')}</td>
                            <td style="padding:10px 9px;">${dataBR(g.data_inicio)}</td>
                            <td style="padding:10px 9px;">${dataBR(g.data_fim)}</td>
                            <td style="padding:10px 9px;">${escapar(g.prazo_dias)} dias</td>
                            <td style="padding:10px 9px;">${statusBadge(g.status)}</td>
                            <td style="padding:10px 9px;text-align:center;">
                                <div style="display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;">
                                    ${podeEditarGarantia ? `<button type="button" class="button btn-editar-garantia" data-id="${g.id}" style="padding:7px 10px;min-height:36px;background:#fff;color:#344054;border:1px solid #d7deea;box-shadow:none;">✏️ Editar</button>` : ''}
                                    <button type="button" class="button btn-imprimir-garantia" data-id="${g.id}" style="padding:7px 11px;min-height:36px;">🖨️ Imprimir</button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        lista.querySelectorAll('.btn-editar-garantia').forEach(botao => {
            botao.addEventListener('click', () => {
                const garantia = garantias.find(item => Number(item.id) === Number(botao.dataset.id));
                if (garantia) abrirFormulario(garantia);
            });
        });
        lista.querySelectorAll('.btn-imprimir-garantia').forEach(botao => {
            botao.addEventListener('click', () => {
                const garantia = garantias.find(item => Number(item.id) === Number(botao.dataset.id));
                if (garantia) imprimirGarantia(garantia);
            });
        });
    }

    async function imprimirGarantia(garantia) {
        const agora = new Date();
        const dataHora = agora.toLocaleString('pt-BR');
        const numeroGarantia = String(garantia.id || 0).padStart(6, '0');
        const ehOS = Boolean(garantia.os_id || garantia.os_numero);
        const origem = ehOS
            ? `OS ${String(garantia.os_numero || garantia.os_id || 0).padStart(6, '0')}`
            : `Venda ${String(garantia.venda_numero || garantia.venda_id || 0).padStart(6, '0')}`;
        const inicio = dataBR(garantia.data_inicio);
        const fim = dataBR(garantia.data_fim);
        const janela = window.open('', '_blank', 'width=1000,height=950');
        if (!janela) {
            alert('Não foi possível abrir a pré-visualização. Verifique se o navegador/janela está sendo bloqueado.');
            return;
        }
        janela.document.write('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Garantia ' + numeroGarantia + '</title><style>body{margin:0;padding:24px;background:#eef2f7;color:#172033;font:14px Arial,sans-serif}.documento{max-width:900px;margin:auto;padding:38px;background:#fff;box-shadow:0 4px 24px #1720331a}.acoes{max-width:900px;margin:0 auto 14px;text-align:right}.acoes button{border:0;border-radius:7px;padding:11px 18px;background:#2563eb;color:#fff;font-weight:bold;cursor:pointer}.cabecalho{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #2563eb;padding-bottom:20px;margin-bottom:22px}.marca{font-size:23px;font-weight:bold;color:#1d3557}.submarca{color:#64748b;margin-top:5px}.selo{text-align:right;color:#334155}.selo strong{display:block;font-size:18px;color:#1d3557}.secao{margin:18px 0;padding:16px;border:1px solid #dbe3ee;border-radius:8px;break-inside:avoid}.secao h2{margin:0 0 13px;color:#1d3557;font-size:14px;text-transform:uppercase;letter-spacing:.04em}.grid{display:grid;grid-template-columns:1fr 1fr;gap:13px 22px}.campo small{display:block;margin-bottom:4px;color:#64748b;font-size:10px;text-transform:uppercase}.campo strong{font-size:13px;overflow-wrap:anywhere}.tabela{width:100%;border-collapse:collapse}.tabela th,.tabela td{padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:left}.tabela th{background:#f3f6fa;color:#52627a;font-size:10px;text-transform:uppercase}.tabela td.num,.tabela th.num{text-align:right;white-space:nowrap}.tabela tfoot td{font-weight:bold;border-top:2px solid #cbd5e1}.texto{line-height:1.55;white-space:pre-wrap}.assinaturas{display:grid;grid-template-columns:1fr 1fr;gap:48px;margin:54px 10px 12px}.linha{text-align:center;border-top:1px solid #475569;padding-top:8px;font-size:12px}.rodape{border-top:1px solid #e2e8f0;padding-top:12px;margin-top:20px;text-align:right;font-size:10px;color:#64748b}@media print{body{padding:0;background:#fff}.documento{max-width:none;padding:10mm;box-shadow:none}.acoes{display:none}}</style></head><body><div class="acoes"><button id="btn-imprimir-garantia">Imprimir garantia</button></div><main class="documento"><div class="cabecalho"><div><div class="marca">Gestor Fácil</div><div class="submarca">Certificado técnico de garantia</div></div><div class="selo"><strong>GARANTIA Nº ' + escapar(numeroGarantia) + '</strong><span>' + escapar(garantia.status || 'Ativa') + '</span></div></div><div id="conteudo-garantia" class="texto">Carregando dados da garantia…</div><div class="rodape">Documento emitido em ' + escapar(dataHora) + '</div></main></body></html>');
        janela.document.close();
        try {
            const origemDados = ehOS
                ? await window.api.buscarOrdemServico(Number(garantia.os_id))
                : await window.api.buscarVenda(Number(garantia.venda_id));
            const cliente = origemDados?.cliente || {};
            const clienteNome = garantia.cliente_nome || origemDados?.cliente_nome || cliente.nome || '-';
            const documento = garantia.cliente_documento || origemDados?.cliente_cpf_cnpj || cliente.cpf_cnpj || '';
            const telefone = origemDados?.cliente_telefone || origemDados?.cliente_celular || origemDados?.telefone || origemDados?.celular || cliente.telefone || cliente.celular || '';
            const email = origemDados?.cliente_email || origemDados?.email || cliente.email || '';
            const itensOrigem = ehOS
                ? (Array.isArray(origemDados?.itens_os) ? origemDados.itens_os : [])
                : (Array.isArray(origemDados?.itens) ? origemDados.itens : (Array.isArray(origemDados?.itens_venda) ? origemDados.itens_venda : []));
            const idsSelecionados = String(garantia.produto_ids || '').split(',').map(Number).filter(Number.isFinite);
            const idLegado = Number(garantia.produto_id || 0);
            const itensCobertos = idsSelecionados.length || idLegado
                ? itensOrigem.filter(item => idsSelecionados.includes(Number(item.produto_id)) || Number(item.produto_id) === idLegado)
                : itensOrigem;
            const moeda = valor => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(valor) || 0);
            const esc = valor => escapar(valor == null || valor === '' ? '-' : String(valor));
            const total = itensCobertos.reduce((soma, item) => soma + (Number(item.subtotal) || (Number(item.quantidade || 1) * Number(item.preco_unitario || item.valor_unitario || 0))), 0);
            const linhas = itensCobertos.length ? itensCobertos.map(item => {
                const quantidade = Number(item.quantidade) || 1;
                const unitario = Number(item.preco_unitario ?? item.valor_unitario ?? 0);
                const subtotal = Number(item.subtotal ?? (quantidade * unitario));
                return '<tr><td>' + esc(item.produto_nome || item.nome || item.descricao || garantia.descricao || 'Serviço') + (item.sku ? '<br><small>Cód.: ' + esc(item.sku) + '</small>' : '') + '</td><td class="num">' + esc(quantidade) + '</td><td class="num">' + moeda(unitario) + '</td><td class="num">' + moeda(subtotal) + '</td></tr>';
            }).join('') : '<tr><td>' + esc(garantia.descricao || 'Serviço coberto') + '</td><td class="num">1</td><td class="num">' + moeda(0) + '</td><td class="num">' + moeda(0) + '</td></tr>';
            const referenciaData = origemDados?.data_hora || origemDados?.data_hora_abertura || origemDados?.data_venda || origemDados?.data_criacao || origemDados?.criado_em || '';
            const equipamento = ehOS ? [origemDados?.tipo_equipamento, origemDados?.marca, origemDados?.modelo].filter(Boolean).join(' / ') : '';
            const telefoneEmail = [telefone, email].filter(Boolean).map(esc).join(' · ') || '-';
            const conteudo = '<section class="secao"><h2>Identificação do cliente</h2><div class="grid"><div class="campo"><small>Nome</small><strong>' + esc(clienteNome) + '</strong></div><div class="campo"><small>CPF/CNPJ</small><strong>' + esc(formatarDocumento(documento)) + '</strong></div><div class="campo" style="grid-column:1/-1"><small>Contato</small><strong>' + telefoneEmail + '</strong></div></div></section>' +
                '<section class="secao"><h2>Referência e vigência</h2><div class="grid"><div class="campo"><small>Documento de origem</small><strong>' + esc(origem) + '</strong></div><div class="campo"><small>Data da venda/OS</small><strong>' + esc(referenciaData ? formatarDataHoraLocal(referenciaData) : '-') + '</strong></div><div class="campo"><small>Início da garantia</small><strong>' + esc(inicio) + '</strong></div><div class="campo"><small>Fim da garantia</small><strong>' + esc(fim) + '</strong></div><div class="campo"><small>Prazo</small><strong>' + esc(garantia.prazo_dias) + ' dias</strong></div><div class="campo"><small>Status</small><strong>' + esc(garantia.status || 'Ativa') + '</strong></div>' + (ehOS ? '<div class="campo"><small>Equipamento</small><strong>' + esc(equipamento || '-') + '</strong></div><div class="campo"><small>Número de série</small><strong>' + esc(origemDados?.numero_serie || '-') + '</strong></div>' : '') + '</div></section>' +
                '<section class="secao"><h2>Produtos e valores cobertos</h2><table class="tabela"><thead><tr><th>Produto/serviço</th><th class="num">Qtd.</th><th class="num">Preço unitário</th><th class="num">Subtotal</th></tr></thead><tbody>' + linhas + '</tbody><tfoot><tr><td colspan="3" class="num">Total dos itens cobertos</td><td class="num">' + moeda(total) + '</td></tr></tfoot></table></section>' +
                (garantia.cobertura ? '<section class="secao"><h2>Cobertura</h2><div class="texto">' + esc(garantia.cobertura) + '</div></section>' : '') +
                (garantia.exclusoes ? '<section class="secao"><h2>Itens não cobertos</h2><div class="texto">' + esc(garantia.exclusoes) + '</div></section>' : '') +
                (garantia.descricao ? '<section class="secao"><h2>Descrição</h2><div class="texto">' + esc(garantia.descricao) + '</div></section>' : '') +
                (garantia.observacoes ? '<section class="secao"><h2>Observações</h2><div class="texto">' + esc(garantia.observacoes) + '</div></section>' : '') +
                '<section class="secao"><h2>Declaração</h2><div class="texto">Declaro que recebi as informações referentes à garantia dos produtos ou serviços identificados neste certificado e estou ciente do prazo e das condições descritas acima.</div></section><div class="assinaturas"><div class="linha">Assinatura do cliente</div><div class="linha">Assinatura do técnico responsável</div></div>';
            janela.document.getElementById('conteudo-garantia').innerHTML = conteudo;
            janela.document.getElementById('btn-imprimir-garantia').addEventListener('click', () => janela.print());
        } catch (erro) {
            console.error('Erro ao montar certificado de garantia:', erro);
            janela.document.getElementById('conteudo-garantia').textContent = 'Não foi possível carregar os detalhes da venda ou ordem de serviço.';
        }
    }

    async function carregarGarantias() {
        garantias = await window.api.listarGarantias();
        renderizarLista();
    }

    async function abrirFormulario(garantiaEdicao = null) {
        const editando = !!garantiaEdicao;
        const clientes = await window.api.listarClientes();
        const vendas = await window.api.listarVendas();
        const ordens = await window.api.listarOrdensServico();

        form.innerHTML = `
            <div class="card" style="margin-top:18px;">
                <h3 style="margin-top:0;">${editando ? 'Editar garantia' : 'Nova garantia'}</h3>
                <form id="form-garantia">
                    <div style="margin-top:5px;position:relative;">
                        <label>Cliente</label>
                        <input
                            id="garantia-cliente"
                            type="text"
                            autocomplete="off"
                            placeholder="Digite o nome ou CPF/CNPJ do cliente..."
                            style="width:100%;padding:10px;box-sizing:border-box;"
                        >
                        <input type="hidden" id="garantia-cliente-id">
                        <div
                            id="garantia-clientes-sugestoes"
                            style="position:absolute;left:0;right:0;top:100%;z-index:20;background:#fff;border:1px solid #d1d5db;border-top:none;border-radius:0 0 8px 8px;max-height:220px;overflow:auto;display:none;box-shadow:0 8px 18px rgba(0,0,0,.08);"
                        ></div>
                        <small style="display:block;margin-top:6px;color:#6b7280;">Digite o nome ou CPF/CNPJ e selecione o cliente. Depois disso, as opções de origem serão liberadas.</small>
                    </div>

                    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px;margin-top:15px;">
                        <div>
                            <label>Tipo de origem</label>
                            <select id="garantia-origem" required disabled style="width:100%;padding:10px;background:#f3f4f6;">
                                <option value="os">Ordem de Serviço</option>
                                <option value="venda">Venda</option>
                            </select>
                        </div>
                        <div>
                            <label>Origem</label>
                            <select id="garantia-origem-id" required disabled style="width:100%;padding:10px;background:#f3f4f6;">
                                <option value="">Selecione primeiro o cliente...</option>
                            </select>
                        </div>
                    </div>

                    <div style="margin-top:15px;">
                        <label>Produtos cobertos pela garantia</label>
                        <div id="garantia-produtos" style="margin-top:8px;border:1px solid #d1d5db;border-radius:8px;padding:10px;background:#f9fafb;max-height:220px;overflow:auto;">
                            <div style="color:#6b7280;font-size:14px;">Selecione o cliente e depois uma venda ou OS para carregar os produtos.</div>
                        </div>
                        <small style="display:block;margin-top:6px;color:#6b7280;">Você pode selecionar vários produtos da mesma venda ou OS.</small>
                    </div>

                    <div style="display:grid;grid-template-columns:1fr 2fr;gap:15px;margin-top:15px;">
                        <div>
                            <label>Prazo (dias)</label>
                            <input id="garantia-prazo" type="number" min="1" value="90" required style="width:100%;padding:10px;">
                        </div>
                        <div>
                            <label>Descrição</label>
                            <input id="garantia-descricao" placeholder="Ex.: Garantia de serviço / peça" style="width:100%;padding:10px;">
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:15px;">
                        <div>
                            <label>Cobertura da garantia</label>
                            <textarea id="garantia-cobertura" rows="3" placeholder="Descreva o que está coberto" style="width:100%;padding:10px;box-sizing:border-box;"></textarea>
                        </div>
                        <div>
                            <label>Itens não cobertos</label>
                            <textarea id="garantia-exclusoes" rows="3" placeholder="Informe exclusões acordadas com o cliente" style="width:100%;padding:10px;box-sizing:border-box;"></textarea>
                        </div>
                    </div>
                    <div style="margin-top:15px;">
                        <label>Observações</label>
                        <textarea id="garantia-observacoes" rows="3" style="width:100%;padding:10px;box-sizing:border-box;"></textarea>
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
                        <button type="button" id="cancelar-garantia" class="button">Cancelar</button>
                        <button type="submit" class="button button-primary">${editando ? 'Salvar alterações' : 'Salvar garantia'}</button>
                    </div>
                </form>
            </div>
        `;

        const origem = document.getElementById('garantia-origem');
        const origemId = document.getElementById('garantia-origem-id');
        const cliente = document.getElementById('garantia-cliente');
        const clienteId = document.getElementById('garantia-cliente-id');
        const sugestoes = document.getElementById('garantia-clientes-sugestoes');
        const produtosContainer = document.getElementById('garantia-produtos');

        function limparOrigem() {
            origem.disabled = true;
            origem.style.background = '#f3f4f6';
            origemId.disabled = true;
            origemId.style.background = '#f3f4f6';
            origemId.innerHTML = '<option value="">Selecione primeiro o cliente...</option>';
            produtosContainer.innerHTML = '<div style="color:#6b7280;font-size:14px;">Selecione o cliente e depois uma venda ou OS para carregar os produtos.</div>';
        }

        function habilitarOrigem() {
            origem.disabled = false;
            origem.style.background = '#fff';
            origemId.disabled = false;
            origemId.style.background = '#fff';
        }

        function selecionarCliente(clienteSelecionado) {
            cliente.value = clienteSelecionado.nome || '';
            clienteId.value = clienteSelecionado.id || '';
            sugestoes.innerHTML = '';
            sugestoes.style.display = 'none';
            habilitarOrigem();
            atualizarOrigem();
        }

        function renderizarSugestoesClientes() {
            const termo = normalizarTexto(cliente.value);
            if (!termo) {
                clienteId.value = '';
                limparOrigem();
                sugestoes.innerHTML = '';
                sugestoes.style.display = 'none';
                return;
            }

            const resultados = clientes.filter(c => {
                const nome = normalizarTexto(c.nome || '');
                const documento = normalizarTexto(c.cpf_cnpj || '');
                return nome.includes(termo) || documento.includes(termo);
            }).slice(0, 20);

            if (!resultados.length) {
                clienteId.value = '';
                limparOrigem();
                sugestoes.innerHTML = '<div style="padding:12px;color:#6b7280;">Nenhum cliente encontrado.</div>';
                sugestoes.style.display = 'block';
                return;
            }

            sugestoes.innerHTML = resultados.map(c => `
                <button
                    type="button"
                    class="garantia-cliente-sugestao"
                    data-id="${c.id}"
                    style="display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #f1f5f9;background:#fff;padding:11px 12px;cursor:pointer;"
                >
                    <strong>${escapar(c.nome || '')}</strong>
                    <span style="display:block;color:#6b7280;font-size:12px;margin-top:3px;">${escapar(c.cpf_cnpj || 'CPF/CNPJ não informado')}</span>
                </button>
            `).join('');
            sugestoes.style.display = 'block';

            sugestoes.querySelectorAll('.garantia-cliente-sugestao').forEach(botao => {
                botao.addEventListener('click', () => {
                    const selecionado = clientes.find(c => Number(c.id) === Number(botao.dataset.id));
                    if (selecionado) selecionarCliente(selecionado);
                });
            });
        }

        async function atualizarOrigem() {
            const idCliente = Number(clienteId.value);
            if (!idCliente) {
                limparOrigem();
                return;
            }

            const ehOS = origem.value === 'os';
            const itens = (ehOS ? ordens : vendas).filter(item => Number(item.cliente_id) === idCliente);
            origemId.innerHTML = `<option value="">Selecione...</option>` + itens.map(item => {
                const numero = Number(item.numero || 0).toString().padStart(6, '0');
                return `<option value="${item.id}">${ehOS ? 'OS' : 'Venda'} ${numero}</option>`;
            }).join('');
            produtosContainer.innerHTML = '<div style="color:#6b7280;font-size:14px;">Selecione uma venda ou OS para carregar os produtos.</div>';
        }

        async function carregarOrigemSelecionada() {
            const id = Number(origemId.value);
            if (!id) {
                produtosContainer.innerHTML = '<div style="color:#6b7280;font-size:14px;">Selecione uma venda ou OS para carregar os produtos.</div>';
                return;
            }

            const ehOS = origem.value === 'os';
            const dados = ehOS
                ? await window.api.buscarOrdemServico(id)
                : await window.api.buscarVenda(id);

            if (!dados) return;

            const idClienteOrigem = Number(dados.cliente_id || 0);
            if (idClienteOrigem && idClienteOrigem !== Number(clienteId.value)) {
                alert('A origem selecionada não pertence ao cliente escolhido.');
                origemId.value = '';
                produtosContainer.innerHTML = '<div style="color:#6b7280;font-size:14px;">Selecione uma origem válida para o cliente.</div>';
                return;
            }

            const itens = ehOS
                ? (Array.isArray(dados.itens_os) ? dados.itens_os : [])
                : (Array.isArray(dados.itens) ? dados.itens : (Array.isArray(dados.itens_venda) ? dados.itens_venda : []));
            const itensProdutos = itens.filter(item => item.produto_id);
            produtosContainer.innerHTML = itensProdutos.length
                ? itensProdutos.map(item => `
                    <label style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid #e5e7eb;cursor:pointer;">
                        <input type="checkbox" class="garantia-produto-check" value="${item.produto_id}">
                        <span><strong>${escapar(item.produto_nome || item.nome || item.descricao || 'Produto')}</strong>${item.quantidade ? ` — Qtd.: ${escapar(item.quantidade)}` : ''}</span>
                    </label>
                `).join('')
                : '<div style="color:#6b7280;font-size:14px;">Esta origem não possui produtos vinculados. A garantia será cadastrada como serviço.</div>';
        }

        cliente.addEventListener('input', renderizarSugestoesClientes);
        cliente.addEventListener('focus', renderizarSugestoesClientes);
        document.addEventListener('click', event => {
            if (!cliente.contains(event.target) && !sugestoes.contains(event.target)) {
                sugestoes.style.display = 'none';
            }
        }, { once: true });

        origem.addEventListener('change', async () => {
            await atualizarOrigem();
        });
        origemId.addEventListener('change', carregarOrigemSelecionada);
        document.getElementById('cancelar-garantia').addEventListener('click', () => {
            form.innerHTML = '';
        });
        document.getElementById('form-garantia').addEventListener('submit', async event => {
            event.preventDefault();
            const idOrigem = Number(origemId.value);
            const idCliente = Number(clienteId.value);
            if (!idCliente) {
                alert('Selecione um cliente válido na busca.');
                cliente.focus();
                return;
            }
            if (!idOrigem) {
                alert('Selecione uma origem válida para o cliente escolhido.');
                return;
            }

            const garantia = {
                id: garantiaEdicao?.id,
                cliente_id: idCliente,
                venda_id: origem.value === 'venda' ? idOrigem : null,
                os_id: origem.value === 'os' ? idOrigem : null,
                produto_ids: [...document.querySelectorAll('.garantia-produto-check:checked')].map(input => Number(input.value)),
                descricao: document.getElementById('garantia-descricao').value.trim(),
                prazo_dias: Number(document.getElementById('garantia-prazo').value),
                observacoes: document.getElementById('garantia-observacoes').value.trim(),
                cobertura: document.getElementById('garantia-cobertura').value.trim(),
                exclusoes: document.getElementById('garantia-exclusoes').value.trim()
            };

            let resultado;
            try {
                resultado = editando
                    ? await window.api.editarGarantia(garantia)
                    : await window.api.cadastrarGarantia(garantia);
            } catch (erro) {
                console.error('Erro ao salvar garantia:', erro);
                alert(erro.message || 'Não foi possível salvar a garantia.');
                return;
            }
            if (!resultado.sucesso) {
                alert(resultado.mensagem || (editando ? 'Não foi possível atualizar a garantia.' : 'Não foi possível cadastrar a garantia.'));
                return;
            }

            alert(`${editando ? 'Garantia atualizada' : 'Garantia cadastrada'} com sucesso!\n${resultado.quantidade || 0} produto(s) coberto(s) em uma única garantia.\nVálida por ${garantia.prazo_dias} dias.`);
            form.innerHTML = '';
            await carregarGarantias();
        });

        limparOrigem();

        if (editando) {
            const clienteAtual = clientes.find(item => Number(item.id) === Number(garantiaEdicao.cliente_id));
            if (!clienteAtual) {
                alert('O cliente desta garantia não foi encontrado.');
                form.innerHTML = '';
                return;
            }

            cliente.value = clienteAtual.nome || '';
            clienteId.value = String(clienteAtual.id);
            origem.value = garantiaEdicao.os_id ? 'os' : 'venda';
            habilitarOrigem();
            await atualizarOrigem();
            origemId.value = String(garantiaEdicao.os_id || garantiaEdicao.venda_id || '');

            if (!origemId.value) {
                alert('A venda ou ordem de serviço vinculada a esta garantia não foi encontrada.');
                form.innerHTML = '';
                return;
            }

            await carregarOrigemSelecionada();
            document.getElementById('garantia-prazo').value = String(garantiaEdicao.prazo_dias || 90);
            document.getElementById('garantia-descricao').value = garantiaEdicao.descricao || '';
            document.getElementById('garantia-observacoes').value = garantiaEdicao.observacoes || '';
            document.getElementById('garantia-cobertura').value = garantiaEdicao.cobertura || '';
            document.getElementById('garantia-exclusoes').value = garantiaEdicao.exclusoes || '';

            let produtosMarcados = String(garantiaEdicao.produto_ids || '')
                .split(',')
                .map(Number)
                .filter(id => Number.isInteger(id) && id > 0);
            if (!produtosMarcados.length && Number(garantiaEdicao.produto_id) > 0) {
                produtosMarcados = [Number(garantiaEdicao.produto_id)];
            }
            const idsMarcados = new Set(produtosMarcados);
            document.querySelectorAll('.garantia-produto-check').forEach(input => {
                input.checked = idsMarcados.has(Number(input.value));
            });
        }
    }

    document.getElementById('nova-garantia').addEventListener('click', () => abrirFormulario());
    busca.addEventListener('input', () => {
        renderizarLista();
    });
    await carregarGarantias();
}


/*
    ==================================================
    RELATÓRIOS — ETAPA 1
    ==================================================
*/

// Calcula os indicadores do período com dados das vendas, OS e estoque.
async function mostrarRelatorios() {

    conteudo.innerHTML = `

        <div class="page-header">
            <div>
                <h2>Relatórios</h2>
                <p>Consulte os principais indicadores do seu negócio</p>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button class="button" id="relatorio-imprimir">🖨️ Imprimir relatório</button>
                <button class="button" id="relatorio-pdf">📄 Salvar PDF</button>
            </div>
        </div>

        <section class="panel relatorio-filtro-panel" aria-label="Filtros do relatório">
            <div class="relatorio-filtro-intro">
                <span class="relatorio-filtro-icone" aria-hidden="true">☷</span>
                <div>
                    <h3>Filtros do relatório</h3>
                    <p>Escolha o período para consultar os indicadores</p>
                </div>
            </div>
            <div class="relatorio-filtro-controles">
                <div class="relatorio-campo-periodo">
                    <label>Período</label>
                    <select id="relatorio-periodo">
                        <option value="hoje">Hoje</option>
                        <option value="ontem">Ontem</option>
                        <option value="7dias" selected>Últimos 7 dias</option>
                        <option value="30dias">Últimos 30 dias</option>
                        <option value="mes">Este mês</option>
                        <option value="mes-anterior">Mês anterior</option>
                        <option value="personalizado">Personalizado</option>
                    </select>
                </div>
                <div class="relatorio-campo-data" id="relatorio-data-inicial-container" style="display:none;">
                    <label>Data inicial</label>
                    <input type="date" id="relatorio-data-inicial">
                </div>
                <div class="relatorio-campo-data" id="relatorio-data-final-container" style="display:none;">
                    <label>Data final</label>
                    <input type="date" id="relatorio-data-final">
                </div>
                <button class="button relatorio-aplicar-filtro" id="aplicar-filtro-relatorio">🔎 Atualizar relatório</button>
            </div>
        </section>

        <div class="cards">
            <div class="card"><div class="card-icon green">💰</div><div><span>Vendas no período</span><h2 id="relatorio-total-vendas">R$ 0,00</h2></div></div>
            <div class="card"><div class="card-icon blue">🛒</div><div><span>Quantidade de vendas</span><h2 id="relatorio-qtd-vendas">0</h2></div></div>
            <div class="card"><div class="card-icon orange">🔧</div><div><span>Ordens de serviço</span><h2 id="relatorio-qtd-os">0</h2></div></div>
            <div class="card"><div class="card-icon purple">👥</div><div><span>Clientes atendidos</span><h2 id="relatorio-clientes-atendidos">0</h2></div></div>
        </div>

        <div class="dashboard-grid" style="margin-top:20px;">
            <div class="panel">
                <div class="panel-header"><div><h3>Resumo financeiro</h3><span>Valores do período selecionado</span></div></div>
                <div style="padding:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:15px;">
                    <div style="padding:18px;border:1px solid #e5e7eb;border-radius:10px;"><small>Faturamento de OS</small><strong id="relatorio-faturamento-os" style="display:block;font-size:24px;margin-top:6px;">R$ 0,00</strong></div>
                    <div style="padding:18px;border:1px solid #e5e7eb;border-radius:10px;"><small>Ticket médio das vendas</small><strong id="relatorio-ticket-medio" style="display:block;font-size:24px;margin-top:6px;">R$ 0,00</strong></div>
                    <div style="padding:18px;border:1px solid #e5e7eb;border-radius:10px;"><small>Faturamento total</small><strong id="relatorio-faturamento-total" style="display:block;font-size:24px;margin-top:6px;">R$ 0,00</strong></div>
                </div>
            </div>

            <div class="panel">
                <div class="panel-header"><div><h3>Resumo de estoque</h3><span>Situação atual dos produtos cadastrados</span></div></div>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:15px;padding:20px;">
                    <div style="padding:18px;border:1px solid #e5e7eb;border-radius:10px;"><small>Total de produtos</small><strong id="relatorio-produtos" style="display:block;font-size:24px;margin-top:6px;">0</strong></div>
                    <div style="padding:18px;border:1px solid #e5e7eb;border-radius:10px;"><small>Estoque baixo</small><strong id="relatorio-estoque-baixo" style="display:block;font-size:24px;margin-top:6px;">0</strong></div>
                    <div style="padding:18px;border:1px solid #e5e7eb;border-radius:10px;"><small>Sem estoque</small><strong id="relatorio-sem-estoque" style="display:block;font-size:24px;margin-top:6px;">0</strong></div>
                </div>
            </div>
        </div>

        <div class="dashboard-grid" style="margin-top:20px;">
            <div class="panel">
                <div class="panel-header"><div><h3>🏆 Produtos mais vendidos</h3><span>Quantidade vendida no período</span></div></div>
                <div class="table-container"><table><thead><tr><th>Produto</th><th>Qtd.</th><th>Faturamento</th></tr></thead><tbody id="relatorio-produtos-mais-vendidos"></tbody></table></div>
            </div>
            <div class="panel">
                <div class="panel-header"><div><h3>💳 Formas de pagamento</h3><span>Distribuição das vendas no período</span></div></div>
                <div class="table-container"><table><thead><tr><th>Forma</th><th>Vendas</th><th>Total</th></tr></thead><tbody id="relatorio-formas-pagamento"></tbody></table></div>
            </div>
        </div>

        <div class="dashboard-grid" style="margin-top:20px;">
            <div class="panel">
                <div class="panel-header"><div><h3>📈 Vendas por dia</h3><span>Quantidade e faturamento no período</span></div></div>
                <div id="relatorio-vendas-dia" style="padding:20px;"></div>
            </div>
            <div class="panel">
                <div class="panel-header"><div><h3>🔧 OS por status</h3><span>Distribuição das ordens de serviço</span></div></div>
                <div id="relatorio-os-status" style="padding:20px;"></div>
            </div>
        </div>

        <div class="dashboard-grid" style="margin-top:20px;">
            <div class="panel">
                <div class="panel-header"><div><h3>📊 Vendas × OS</h3><span>Comparativo financeiro do período</span></div></div>
                <div id="relatorio-comparativo" style="padding:20px;"></div>
            </div>
            <div class="panel">
                <div class="panel-header"><div><h3>📦 Produtos com estoque baixo</h3><span>Produtos que precisam de reposição</span></div></div>
                <div id="relatorio-estoque-baixo-lista" style="padding:20px;"></div>
            </div>
        </div>

        <div class="panel" style="margin-top:20px;">
            <div class="panel-header"><div><h3>🏆 Ranking dos produtos mais vendidos</h3><span>Visualização por quantidade vendida</span></div></div>
            <div id="relatorio-ranking-produtos" style="padding:20px;"></div>
        </div>
    `;

    const periodo = document.getElementById('relatorio-periodo');
    const dataInicial = document.getElementById('relatorio-data-inicial');
    const dataFinal = document.getElementById('relatorio-data-final');
    const containerInicial = document.getElementById('relatorio-data-inicial-container');
    const containerFinal = document.getElementById('relatorio-data-final-container');

    function moeda(valor) {
        return `R$ ${Number(valor || 0).toFixed(2).replace('.', ',')}`;
    }

    function escaparRelatorio(valor) {
        return String(valor ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function intervaloPeriodo(tipo) {
        const agora = new Date();
        let inicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
        let fim = new Date(inicio);
        if (tipo === 'hoje') {
            fim.setHours(23,59,59,999);
        } else if (tipo === 'ontem') {
            inicio.setDate(inicio.getDate()-1); fim = new Date(inicio); fim.setHours(23,59,59,999);
        } else if (tipo === '7dias') {
            inicio.setDate(inicio.getDate()-6); fim.setHours(23,59,59,999);
        } else if (tipo === '30dias') {
            inicio.setDate(inicio.getDate()-29); fim.setHours(23,59,59,999);
        } else if (tipo === 'mes') {
            inicio = new Date(agora.getFullYear(),agora.getMonth(),1);
            fim = new Date(agora.getFullYear(),agora.getMonth()+1,0,23,59,59,999);
        } else if (tipo === 'mes-anterior') {
            inicio = new Date(agora.getFullYear(),agora.getMonth()-1,1);
            fim = new Date(agora.getFullYear(),agora.getMonth(),0,23,59,59,999);
        } else if (tipo === 'personalizado') {
            if (!dataInicial.value || !dataFinal.value) return null;
            const pi = dataInicial.value.split('-').map(Number), pf = dataFinal.value.split('-').map(Number);
            inicio = new Date(pi[0],pi[1]-1,pi[2],0,0,0,0);
            fim = new Date(pf[0],pf[1]-1,pf[2],23,59,59,999);
        }
        return {inicio,fim};
    }

    function dataDoRegistro(valor) {
        return converterDataHoraLocal(valor);
    }

    function estaNoPeriodo(valor, intervalo) {
        const data = dataDoRegistro(valor);
        return !!data && !!intervalo && data >= intervalo.inicio && data <= intervalo.fim;
    }

    function atualizarCamposPersonalizados() {
        const visivel = periodo.value === 'personalizado';
        containerInicial.style.display = visivel ? 'block' : 'none';
        containerFinal.style.display = visivel ? 'block' : 'none';
    }

    async function atualizarRelatorio() {
        const intervalo = intervaloPeriodo(periodo.value);
        if (!intervalo) { alert('Informe a data inicial e a data final.'); return; }
        if (intervalo.inicio > intervalo.fim) { alert('A data inicial não pode ser maior que a data final.'); return; }

        try {
            const dadosRelatorio = await window.api.obterDadosRelatorio();
            if (!dadosRelatorio || dadosRelatorio.sucesso === false) {
                throw new Error(dadosRelatorio?.mensagem || 'Não foi possível consultar os dados do relatório.');
            }

            const vendas = Array.isArray(dadosRelatorio.vendas) ? dadosRelatorio.vendas : [];
            const ordens = Array.isArray(dadosRelatorio.ordens) ? dadosRelatorio.ordens : [];
            const produtos = Array.isArray(dadosRelatorio.produtos) ? dadosRelatorio.produtos : [];
            const itensVenda = Array.isArray(dadosRelatorio.itensVenda) ? dadosRelatorio.itensVenda : [];

            const vendasPeriodo = vendas.filter(v => !String(v.status || '').toLowerCase().includes('cancel') && estaNoPeriodo(v.data_hora, intervalo));
            const ordensPeriodo = ordens.filter(os => estaNoPeriodo(os.data_hora_abertura, intervalo));
            const totalVendas = vendasPeriodo.reduce((t,v) => t + Number(v.total || 0), 0);
            const faturamentoOS = ordensPeriodo.reduce((t,os) => t + Number(os.total || 0), 0);
            const faturamentoTotal = totalVendas + faturamentoOS;
            const ticketMedio = vendasPeriodo.length ? totalVendas / vendasPeriodo.length : 0;
            const clientesAtendidos = new Set(vendasPeriodo.map(v=>Number(v.cliente_id)).concat(ordensPeriodo.map(o=>Number(o.cliente_id))).filter(id=>Number.isInteger(id)&&id>0)).size;

            const estoqueBaixo = produtos.filter(p=>Number(p.estoque||0)>0 && Number(p.estoque||0)<=Number(p.estoque_minimo||0)).length;
            const semEstoque = produtos.filter(p=>Number(p.estoque||0)<=0).length;

            document.getElementById('relatorio-total-vendas').textContent = moeda(totalVendas);
            document.getElementById('relatorio-qtd-vendas').textContent = String(vendasPeriodo.length);
            document.getElementById('relatorio-qtd-os').textContent = String(ordensPeriodo.length);
            document.getElementById('relatorio-clientes-atendidos').textContent = String(clientesAtendidos);
            document.getElementById('relatorio-faturamento-os').textContent = moeda(faturamentoOS);
            document.getElementById('relatorio-ticket-medio').textContent = moeda(ticketMedio);
            document.getElementById('relatorio-faturamento-total').textContent = moeda(faturamentoTotal);
            document.getElementById('relatorio-produtos').textContent = String(produtos.length);
            document.getElementById('relatorio-estoque-baixo').textContent = String(estoqueBaixo);
            document.getElementById('relatorio-sem-estoque').textContent = String(semEstoque);

            const mapaProdutos = new Map();
            const mapaPagamento = new Map();

            vendasPeriodo.forEach(venda => {
                const forma = String(venda.forma_pagamento || 'Não informado');
                const pagamento = mapaPagamento.get(forma) || {quantidade:0,total:0};
                pagamento.quantidade += 1;
                pagamento.total += Number(venda.total || 0);
                mapaPagamento.set(forma,pagamento);
            });

            const idsVendasPeriodo = new Set(vendasPeriodo.map(v => Number(v.id)));
            itensVenda.filter(item => idsVendasPeriodo.has(Number(item.venda_id))).forEach(item => {
                const id = Number(item.produto_id);
                const nome = item.produto_nome || 'Produto';
                const chave = Number.isInteger(id) && id > 0 ? `id-${id}` : `nome-${nome}`;
                const produto = mapaProdutos.get(chave) || {nome,quantidade:0,total:0};
                produto.quantidade += Number(item.quantidade || 0);
                produto.total += Number(item.subtotal || (Number(item.quantidade||0)*Number(item.preco_unitario||0)) || 0);
                mapaProdutos.set(chave,produto);
            });

            const produtosMaisVendidos = [...mapaProdutos.values()].sort((a,b)=>b.quantidade-a.quantidade || b.total-a.total).slice(0,10);
            const listaProdutos = document.getElementById('relatorio-produtos-mais-vendidos');
            listaProdutos.innerHTML = produtosMaisVendidos.length ? produtosMaisVendidos.map(item=>`<tr><td>${escaparRelatorio(item.nome)}</td><td>${item.quantidade}</td><td>${moeda(item.total)}</td></tr>`).join('') : `<tr><td colspan="3" class="empty-table">Nenhuma venda de produto no período.</td></tr>`;

            const pagamentos = [...mapaPagamento.entries()].sort((a,b)=>b[1].total-a[1].total);
            const listaPagamentos = document.getElementById('relatorio-formas-pagamento');
            listaPagamentos.innerHTML = pagamentos.length ? pagamentos.map(([forma,dados])=>`<tr><td>${escaparRelatorio(forma)}</td><td>${dados.quantidade}</td><td>${moeda(dados.total)}</td></tr>`).join('') : `<tr><td colspan="3" class="empty-table">Nenhuma venda no período.</td></tr>`;

            // Vendas por dia + faturamento por dia
            const dias = new Map();
            const cursor = new Date(intervalo.inicio);
            cursor.setHours(0,0,0,0);
            const fimDia = new Date(intervalo.fim);
            fimDia.setHours(0,0,0,0);
            while (cursor <= fimDia) {
                const chave = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`;
                dias.set(chave,{data:new Date(cursor),quantidade:0,total:0});
                cursor.setDate(cursor.getDate()+1);
            }
            vendasPeriodo.forEach(v=>{
                const d=dataDoRegistro(v.data_hora); if(!d) return;
                const chave=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                const item=dias.get(chave); if(item){item.quantidade++; item.total+=Number(v.total||0);}
            });
            const dadosDias=[...dias.values()];
            const maxDia=Math.max(1,...dadosDias.map(d=>d.total));
            document.getElementById('relatorio-vendas-dia').innerHTML=dadosDias.length ? dadosDias.map(d=>{
                const pct=(d.total/maxDia)*100;
                return `<div style="display:grid;grid-template-columns:82px 1fr 110px;gap:10px;align-items:center;margin-bottom:9px;font-size:13px;"><span>${String(d.data.getDate()).padStart(2,'0')}/${String(d.data.getMonth()+1).padStart(2,'0')}</span><div style="height:14px;background:#eef2f7;border-radius:8px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:#2563eb;border-radius:8px;"></div></div><strong style="text-align:right;">${moeda(d.total)} · ${d.quantidade}</strong></div>`;
            }).join('') : '<div class="empty-table">Nenhum dado no período.</div>';

            // OS por status
            const statusMap=new Map();
            ordensPeriodo.forEach(os=>{const status=String(os.status||'Não informado'); statusMap.set(status,(statusMap.get(status)||0)+1);});
            const statusDados=[...statusMap.entries()].sort((a,b)=>b[1]-a[1]);
            const maxStatus=Math.max(1,...statusDados.map(x=>x[1]));
            document.getElementById('relatorio-os-status').innerHTML=statusDados.length ? statusDados.map(([status,qtd])=>`<div style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;margin-bottom:5px;"><span>${escaparRelatorio(status)}</span><strong>${qtd}</strong></div><div style="height:12px;background:#eef2f7;border-radius:8px;overflow:hidden;"><div style="height:100%;width:${(qtd/maxStatus)*100}%;background:#7c3aed;border-radius:8px;"></div></div></div>`).join('') : '<div class="empty-table">Nenhuma OS no período.</div>';

            // Comparativo financeiro
            const maxComparativo=Math.max(1,totalVendas,faturamentoOS);
            document.getElementById('relatorio-comparativo').innerHTML=`
                <div style="display:grid;gap:18px;">
                    <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>🛒 Vendas</span><strong>${moeda(totalVendas)}</strong></div><div style="height:18px;background:#eef2f7;border-radius:10px;overflow:hidden;"><div style="height:100%;width:${(totalVendas/maxComparativo)*100}%;background:#16a34a;border-radius:10px;"></div></div></div>
                    <div><div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>🔧 OS</span><strong>${moeda(faturamentoOS)}</strong></div><div style="height:18px;background:#eef2f7;border-radius:10px;overflow:hidden;"><div style="height:100%;width:${(faturamentoOS/maxComparativo)*100}%;background:#f59e0b;border-radius:10px;"></div></div></div>
                </div>`;

            // Produtos com estoque baixo
            const baixos=produtos.filter(p=>Number(p.estoque||0)>0 && Number(p.estoque||0)<=Number(p.estoque_minimo||0)).sort((a,b)=>Number(a.estoque||0)-Number(b.estoque||0));
            document.getElementById('relatorio-estoque-baixo-lista').innerHTML=baixos.length ? `<div style="display:grid;gap:9px;">${baixos.slice(0,10).map(p=>`<div style="display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;"><span>${escaparRelatorio(p.nome)}</span><strong>${Number(p.estoque||0)} / mín. ${Number(p.estoque_minimo||0)}</strong></div>`).join('')}</div>${baixos.length>10?`<small style="display:block;margin-top:10px;color:#6b7280;">Mostrando 10 de ${baixos.length} produtos.</small>`:''}` : '<div class="empty-table">Nenhum produto com estoque baixo.</div>';

            // Ranking visual
            const ranking=produtosMaisVendidos;
            const maxRanking=Math.max(1,...ranking.map(x=>x.quantidade));
            document.getElementById('relatorio-ranking-produtos').innerHTML=ranking.length ? ranking.map((item,index)=>`<div style="display:grid;grid-template-columns:34px 180px 1fr 70px;gap:10px;align-items:center;margin-bottom:11px;"><strong>#${index+1}</strong><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escaparRelatorio(item.nome)}</span><div style="height:16px;background:#eef2f7;border-radius:9px;overflow:hidden;"><div style="height:100%;width:${(item.quantidade/maxRanking)*100}%;background:#0f766e;border-radius:9px;"></div></div><strong style="text-align:right;">${item.quantidade}</strong></div>`).join('') : '<div class="empty-table">Nenhum produto vendido no período.</div>';

        } catch (erro) {
            console.error('Erro ao carregar relatórios:', erro);
            alert(`Não foi possível carregar os dados dos relatórios.\n\n${erro?.message || 'Verifique a conexão com o banco de dados e tente novamente.'}`);
        }
    }

    function nomePeriodoAtual() {
        const nomes = {
            hoje: 'Hoje',
            ontem: 'Ontem',
            '7dias': 'Últimos 7 dias',
            '30dias': 'Últimos 30 dias',
            mes: 'Este mês',
            'mes-anterior': 'Mês anterior',
            personalizado: 'Período personalizado'
        };
        return nomes[periodo.value] || 'Período selecionado';
    }

    function obterDataPeriodoTexto() {
        const intervalo = intervaloPeriodo(periodo.value);
        if (!intervalo) return 'Período não informado';
        const inicio = intervalo.inicio.toLocaleDateString('pt-BR');
        const fim = intervalo.fim.toLocaleDateString('pt-BR');
        return inicio === fim ? inicio : `${inicio} até ${fim}`;
    }

    function abrirPreviewRelatorio() {
        const janela = window.open('', '_blank', 'width=1100,height=800');
        if (!janela) {
            alert('Não foi possível abrir a prévia. Verifique se o bloqueio de janelas está ativado.');
            return null;
        }

        const conteudoRelatorio = document.getElementById('conteudo');
        const clone = conteudoRelatorio.cloneNode(true);
        clone.querySelectorAll('button').forEach(botao => botao.remove());
        clone.querySelectorAll('select, input').forEach(el => el.remove());

        janela.document.write(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <title>Relatório - Gestor Fácil</title>
                <style>
                    * { box-sizing:border-box; }
                    body { font-family:Arial,sans-serif; margin:0; padding:25px; color:#111; background:#fff; }
                    .cabecalho-relatorio { border-bottom:2px solid #111; padding-bottom:14px; margin-bottom:18px; }
                    .cabecalho-relatorio h1 { margin:0 0 6px; font-size:24px; }
                    .cabecalho-relatorio p { margin:0; color:#555; }
                    .page-header { display:none !important; }
                    .panel { border:1px solid #ddd; border-radius:8px; margin-bottom:16px; background:#fff; box-shadow:none !important; }
                    .panel-header { padding:14px 16px; border-bottom:1px solid #e5e7eb; }
                    .panel-header h3 { margin:0 0 4px; }
                    .panel-header span { color:#666; font-size:12px; }
                    .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
                    .card { border:1px solid #ddd; border-radius:8px; padding:15px; display:flex; gap:12px; align-items:center; }
                    .card h2 { margin:5px 0 0; font-size:20px; }
                    .card-icon { font-size:24px; }
                    .dashboard-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px !important; }
                    table { width:100%; border-collapse:collapse; }
                    th,td { padding:8px 10px; border-bottom:1px solid #eee; text-align:left; }
                    th { background:#f5f5f5; }
                    @media print { body { padding:10mm; } .dashboard-grid { break-inside:avoid; } .panel { break-inside:avoid; } }
                    @media (max-width:800px) { .cards,.dashboard-grid { grid-template-columns:1fr; } }
                </style>
            </head>
            <body>
                <div class="cabecalho-relatorio">
                    <h1>Gestor Fácil — Relatório</h1>
                    <p>${escaparRelatorio(nomePeriodoAtual())} · ${escaparRelatorio(obterDataPeriodoTexto())}</p>
                </div>
                ${clone.innerHTML}
            </body>
            </html>
        `);
        janela.document.close();
        janela.focus();
        return janela;
    }

    document.getElementById('relatorio-imprimir').addEventListener('click', () => {
        const janela = abrirPreviewRelatorio();
        if (!janela) return;
        const botaoImprimir = janela.document.createElement('button');
        botaoImprimir.textContent = '🖨️ Imprimir relatório';
        botaoImprimir.style.cssText = 'position:fixed;right:20px;top:20px;padding:11px 16px;border:0;border-radius:7px;background:#111;color:#fff;font-weight:700;cursor:pointer;z-index:9999;';
        botaoImprimir.onclick = () => janela.print();
        janela.document.body.appendChild(botaoImprimir);
    });

    document.getElementById('relatorio-pdf').addEventListener('click', () => {
        const janela = abrirPreviewRelatorio();
        if (!janela) return;
        const aviso = janela.document.createElement('div');
        aviso.textContent = '📄 Na janela de impressão, selecione "Salvar como PDF" como destino.';
        aviso.style.cssText = 'position:fixed;left:20px;bottom:20px;padding:10px 14px;border:1px solid #ddd;border-radius:7px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.12);font-size:13px;z-index:9999;';
        janela.document.body.appendChild(aviso);
        janela.setTimeout(() => janela.print(), 150);
    });

    periodo.addEventListener('change', atualizarCamposPersonalizados);
    document.getElementById('aplicar-filtro-relatorio').addEventListener('click', atualizarRelatorio);
    atualizarCamposPersonalizados();
    await atualizarRelatorio();
}



/*
    ==================================================
    AUDITORIA / HISTÓRICO DE AÇÕES
    ==================================================
*/

// Apresenta filtros e histórico das ações gravadas pelo processo principal.
async function mostrarAuditoria() {
    if (usuarioLogado?.perfil !== 'administrador') { acaoNegada(); return; }

    document.getElementById('estilo-auditoria-layout')?.remove();
    const estiloAuditoria = document.createElement('style');
    estiloAuditoria.id = 'estilo-auditoria-layout';
    estiloAuditoria.textContent = `
        #conteudo .auditoria-tabela th,
        #conteudo .auditoria-tabela td {
            padding: 10px 8px;
            font-size: 12px;
            vertical-align: middle;
            overflow-wrap: anywhere;
            word-break: break-word;
        }
        #conteudo .auditoria-tabela td:nth-child(1) { white-space: nowrap; }
        #conteudo .auditoria-tabela td:nth-child(2) { text-align: center; }
        #conteudo .auditoria-tabela td:nth-child(8) { text-align: center !important; white-space: nowrap; }
        #conteudo .auditoria-tabela td:nth-child(8) .button { min-width: 58px; }
        #conteudo #aud-busca { min-width: 0 !important; }
        @media (max-width: 1050px) {
            #conteudo .auditoria-tabela th,
            #conteudo .auditoria-tabela td { padding: 8px 6px; font-size: 11px; }
            #conteudo .auditoria-tabela td:nth-child(8) .button { padding: 6px 7px !important; font-size: 11px !important; }
        }
        @media (max-width: 800px) {
            #conteudo .panel:has(#aud-filtro-usuario) > div:nth-child(2) { grid-template-columns: repeat(2,minmax(0,1fr)) !important; }
            #conteudo .panel:has(#aud-filtro-usuario) #aud-busca { grid-column: span 2 !important; }
            #conteudo .auditoria-tabela th,
            #conteudo .auditoria-tabela td { padding: 7px 5px; font-size: 10px; }
        }
    `;
    document.head.appendChild(estiloAuditoria);

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Auditoria</h2>
                <p>Histórico completo das ações realizadas no sistema.</p>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="button secondary" id="auditoria-limpar">Limpar filtros</button>
                <button class="button" id="auditoria-atualizar">↻ Atualizar</button>
            </div>
        </div>

        <div class="cards" style="margin-bottom:20px;">
            <div class="card"><div class="card-icon blue">📋</div><div><span>Ações hoje</span><h2 id="aud-card-acoes">0</h2></div></div>
            <div class="card"><div class="card-icon green">🔐</div><div><span>Logins hoje</span><h2 id="aud-card-logins">0</h2></div></div>
            <div class="card"><div class="card-icon orange">✏️</div><div><span>Alterações hoje</span><h2 id="aud-card-alteracoes">0</h2></div></div>
            <div class="card"><div class="card-icon purple">🗑️</div><div><span>Exclusões hoje</span><h2 id="aud-card-exclusoes">0</h2></div></div>
            <div class="card"><div class="card-icon green">👥</div><div><span>Usuários ativos</span><h2 id="aud-card-usuarios">0</h2></div></div>
        </div>

        <div class="panel" style="margin-bottom:20px;min-height:0;height:auto;">
            <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;gap:15px;flex-wrap:wrap;">
                <div><h3>Backup e segurança</h3><span>Proteja e recupere os dados do sistema. Disponível para administradores.</span></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="button secondary" id="botao-backup-auditoria" type="button">💾 Fazer backup</button>
                    <button class="button secondary" id="botao-restaurar-auditoria" type="button">🔄 Restaurar</button>
                    <button class="button secondary" id="botao-config-backup-auditoria" type="button">⚙️ Backup automático</button>
                    <button class="button secondary" id="botao-parear-estacao-firebird" type="button" style="display:none;">🔗 Conectar estação</button>
                </div>
            </div>
        </div>

        <div class="panel" style="margin-bottom:20px;min-height:0;height:auto;">
            <div class="panel-header">
                <div><h3>Filtros avançados</h3><span>Refine o histórico por usuário, módulo, ação, nível e período.</span></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:start;box-sizing:border-box;width:100%;">
                <div><label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Usuário</label><select id="aud-filtro-usuario" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;"><option value="">Todos</option></select></div>
                <div><label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Módulo</label><select id="aud-filtro-modulo" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;"><option value="">Todos</option></select></div>
                <div><label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Tipo de ação</label><select id="aud-filtro-acao" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;"><option value="">Todas</option></select></div>
                <div><label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Nível</label><select id="aud-filtro-nivel" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;"><option value="">Todos</option><option value="info">Informação</option><option value="atencao">Atenção</option><option value="critico">Crítico</option></select></div>
                <div><label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Data inicial</label><input id="aud-data-inicial" type="date" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;"></div>
                <div><label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Data final</label><input id="aud-data-final" type="date" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;"></div>
                <div style="grid-column:span 2;"><label style="display:block;font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Busca livre</label><input id="aud-busca" placeholder="🔎 Descrição, usuário, módulo, ação ou registro afetado..." style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;"></div>
            </div>
        </div>

        <div class="panel">
            <div class="panel-header" style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;">
                <div><h3>Histórico de ações</h3><span id="aud-total">Carregando...</span></div>
                <span id="aud-status-filtro" style="font-size:12px;color:#6b7280;"></span>
            </div>
            <div class="auditoria-tabela-wrap" style="overflow-x:hidden;overflow-y:visible;width:100%;">
                <table class="auditoria-tabela" style="width:100%;table-layout:fixed;border-collapse:collapse;">
                    <colgroup>
                        <col style="width:11%;">
                        <col style="width:12%;">
                        <col style="width:15%;">
                        <col style="width:13%;">
                        <col style="width:8%;">
                        <col style="width:8%;">
                        <col style="width:25%;">
                        <col style="width:8%;">
                    </colgroup>
                    <thead><tr><th>Data/Hora</th><th>Nível</th><th>Usuário</th><th>Perfil</th><th>Módulo</th><th>Ação</th><th>Descrição</th><th style="text-align:center;">Detalhes</th></tr></thead>
                    <tbody id="tabela-auditoria"><tr><td colspan="8" class="empty-table">Carregando...</td></tr></tbody>
                </table>
            </div>
        </div>
    `;

    const botaoBackup = document.getElementById('botao-backup-auditoria');
    const botaoPareamento = document.getElementById('botao-parear-estacao-firebird');
    try {
        const estadoImplantacao = await window.api.obterEstadoImplantacaoFirebird();
        if (estadoImplantacao?.papel === 'servidor' && estadoImplantacao?.bancoCompartilhado) {
            botaoPareamento.style.display = 'inline-flex';
        }
        if (estadoImplantacao?.papel === 'cliente' && estadoImplantacao?.bancoCompartilhado) {
            ['botao-backup-auditoria', 'botao-restaurar-auditoria', 'botao-config-backup-auditoria'].forEach(id => {
                const botao = document.getElementById(id);
                if (botao) botao.style.display = 'none';
            });
        }
    } catch (_) {}
    botaoPareamento?.addEventListener('click', async () => {
        botaoPareamento.disabled = true;
        try {
            const resposta = await window.api.gerarCodigoPareamentoFirebird();
            if (!resposta?.sucesso) {
                alert(resposta?.mensagem || 'Não foi possível gerar o código.');
                return;
            }
            const modal = document.createElement('div');
            modal.className = 'modal-overlay-gestor';
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.48);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100000;';
            modal.innerHTML = `<div style="width:min(520px,calc(100vw - 32px));box-sizing:border-box;background:#fff;border-radius:16px;padding:24px;box-shadow:0 18px 50px rgba(15,23,42,.22);">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;"><h2 style="margin:0;font-size:20px;">Conectar uma estação</h2><button id="fechar-codigo-pareamento" class="button secondary" type="button">✕</button></div>
                <p style="color:#64748b;font-size:14px;line-height:1.5;">No outro computador, procure este servidor e cole o código abaixo. Ele é temporário, de uso único e contém a credencial de conexão criptografada durante o pareamento.</p>
                <input id="codigo-pareamento-gerado" readonly value="${escaparLogin(resposta.codigo)}" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #d1d5db;border-radius:9px;font:13px monospace;">
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;"><button id="copiar-codigo-pareamento" class="button" type="button">📋 Copiar código</button></div>
            </div>`;
            document.body.appendChild(modal);
            modal.querySelector('#fechar-codigo-pareamento').onclick = () => modal.remove();
            modal.addEventListener('click', event => { if (event.target === modal) modal.remove(); });
            modal.querySelector('#copiar-codigo-pareamento').onclick = async event => {
                try {
                    await navigator.clipboard.writeText(resposta.codigo);
                    event.currentTarget.textContent = 'Copiado';
                } catch (_) {
                    const campo = modal.querySelector('#codigo-pareamento-gerado');
                    campo.select();
                    document.execCommand('copy');
                    event.currentTarget.textContent = 'Copiado';
                }
            };
        } catch (erro) {
            console.error('Erro ao gerar código para estação:', erro);
            alert('Não foi possível gerar o código de pareamento.');
        } finally {
            botaoPareamento.disabled = false;
        }
    });

    botaoBackup?.addEventListener('click', async () => {
        if (!confirm('Deseja criar um backup completo do banco de dados agora?')) return;
        botaoBackup.disabled = true;
        botaoBackup.textContent = '⏳ Criando backup...';
        try {
            const resposta = await window.api.fazerBackup();
            if (resposta?.cancelado) return;
            if (!resposta?.sucesso) {
                alert(resposta?.mensagem || 'Não foi possível realizar o backup.');
                return;
            }
            alert(`Backup realizado com sucesso!\n\nArquivo: ${resposta.nome_arquivo || 'backup.db'}`);
        } catch (erro) {
            console.error('Erro no backup:', erro);
            alert('Não foi possível realizar o backup.');
        } finally {
            botaoBackup.disabled = false;
            botaoBackup.textContent = '💾 Backup do sistema';
        }
    });

    const botaoConfigBackup = document.getElementById('botao-config-backup-auditoria');
    botaoConfigBackup?.addEventListener('click', async () => {
        const config = await window.api.obterConfigBackup();
        const implantacao = await window.api.obterEstadoImplantacaoFirebird().catch(() => null);
        const modal = document.createElement('div');
        modal.id = 'modal-config-backup-gestor';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;';
        modal.innerHTML = `
            <div style="background:#fff;width:min(560px,100%);border-radius:14px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.2);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
                    <div><h3 style="margin:0 0 4px;">⚙️ Backup automático</h3><span style="font-size:13px;color:#6b7280;">Configure a proteção automática dos dados.</span></div>
                    <button id="fechar-config-backup" type="button" style="border:0;background:#f3f4f6;border-radius:8px;padding:7px 10px;cursor:pointer;">✕</button>
                </div>
                <label style="display:flex;gap:10px;align-items:center;font-weight:700;margin-bottom:18px;"><input id="backup-auto-habilitado" type="checkbox" ${config?.habilitado ? 'checked' : ''}> Ativar backup automático</label>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
                    <div><label style="display:block;font-size:12px;font-weight:700;margin-bottom:6px;">Horário diário</label><input id="backup-auto-horario" type="time" value="${config?.horario || '20:00'}" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;"></div>
                    <div><label style="display:block;font-size:12px;font-weight:700;margin-bottom:6px;">Manter últimos backups</label><input id="backup-auto-manter" type="number" min="1" max="100" value="${Number(config?.manter || 7)}" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;"></div>
                </div>
                <div style="margin-top:14px;"><label style="display:block;font-size:12px;font-weight:700;margin-bottom:6px;">Pasta de destino</label><div style="display:flex;gap:8px;"><input id="backup-auto-pasta" readonly value="${escaparLogin(config?.pasta || '')}" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;"><button class="button secondary" id="backup-auto-escolher" type="button">📁 Escolher</button></div></div>
                <div style="margin-top:16px;padding:12px;border-radius:9px;background:#f8fafc;border:1px solid #e5e7eb;font-size:12px;color:#64748b;">O backup é executado no horário configurado enquanto o Gestor Fácil estiver aberto${implantacao?.papel === 'servidor' ? ' no computador servidor' : ''}. Você pode gerar mais de um no mesmo dia: ao alterar o horário, o novo agendamento será respeitado. Se o horário já tiver passado, o backup será iniciado ao salvar.${implantacao?.papel === 'servidor' ? ' A pasta de destino precisa estar acessível ao serviço Firebird.' : ''}</div>
                <div style="margin-top:10px;font-size:12px;color:#64748b;">Último backup automático registrado: <strong>${config?.ultimoBackupDataHora && !Number.isNaN(new Date(config.ultimoBackupDataHora).getTime()) ? new Date(config.ultimoBackupDataHora).toLocaleString('pt-BR') : (config?.ultimoBackup ? config.ultimoBackup.split('-').reverse().join('/') : 'Ainda não realizado')}</strong></div>
                ${config?.ultimoErroBackup ? `<div style="margin-top:8px;padding:10px 12px;border-radius:8px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;font-size:12px;"><strong>Última falha:</strong> ${escaparLogin(config.ultimoErroBackup)}${config.ultimoErroBackupDataHora && !Number.isNaN(new Date(config.ultimoErroBackupDataHora).getTime()) ? ` · ${new Date(config.ultimoErroBackupDataHora).toLocaleString('pt-BR')}` : ''}</div>` : ''}
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;"><button class="button secondary" id="backup-auto-cancelar" type="button">Cancelar</button><button class="button secondary" id="backup-auto-testar" type="button">🧪 Testar agora</button><button class="button" id="backup-auto-salvar" type="button">💾 Salvar configuração</button></div>
            </div>`;
        document.body.appendChild(modal);
        const pasta = modal.querySelector('#backup-auto-pasta');
        modal.querySelector('#fechar-config-backup').onclick = () => modal.remove();
        modal.querySelector('#backup-auto-cancelar').onclick = () => modal.remove();
        modal.querySelector('#backup-auto-escolher').onclick = async () => {
            const escolha = await window.api.selecionarPastaBackup();
            if (escolha?.sucesso) pasta.value = escolha.pasta;
        };
        modal.querySelector('#backup-auto-testar').onclick = async () => {
            const botaoTeste = modal.querySelector('#backup-auto-testar');
            botaoTeste.disabled = true;
            botaoTeste.textContent = '⏳ Testando...';
            try {
                const salvarAntes = await window.api.salvarConfigBackup({
                    habilitado: modal.querySelector('#backup-auto-habilitado').checked,
                    horario: modal.querySelector('#backup-auto-horario').value,
                    pasta: pasta.value,
                    manter: Number(modal.querySelector('#backup-auto-manter').value)
                });
                if (!salvarAntes?.sucesso) {
                    alert(salvarAntes?.mensagem || 'Salve uma configuração válida antes de testar.');
                    return;
                }
                const respostaTeste = await window.api.testarBackupAutomatico();
                if (respostaTeste?.sucesso) alert(`Teste realizado com sucesso!\n\nArquivo criado em:\n${respostaTeste.caminho}`);
                else alert(respostaTeste?.mensagem || 'O teste do backup falhou.');
            } catch (erro) {
                console.error(erro);
                alert('Não foi possível testar o backup automático.');
            } finally {
                botaoTeste.disabled = false;
                botaoTeste.textContent = '🧪 Testar agora';
            }
        };
        modal.querySelector('#backup-auto-salvar').onclick = async () => {
            const botaoSalvar = modal.querySelector('#backup-auto-salvar');
            botaoSalvar.disabled = true;
            const resposta = await window.api.salvarConfigBackup({
                habilitado: modal.querySelector('#backup-auto-habilitado').checked,
                horario: modal.querySelector('#backup-auto-horario').value,
                pasta: pasta.value,
                manter: Number(modal.querySelector('#backup-auto-manter').value)
            });
            if (!resposta?.sucesso) {
                alert(resposta?.mensagem || 'Não foi possível salvar a configuração.');
                botaoSalvar.disabled = false;
                return;
            }
            modal.remove();
            alert('Configuração de backup automático salva com sucesso.');
        };
    });

    const botaoRestaurar = document.getElementById('botao-restaurar-auditoria');
    botaoRestaurar?.addEventListener('click', async () => {
        const implantacaoBackup = await window.api.obterEstadoImplantacaoFirebird().catch(() => null);
        const avisoEstacoes = implantacaoBackup?.papel === 'servidor' && implantacaoBackup?.bancoCompartilhado
            ? 'Feche o Gestor Fácil em todas as estações antes de continuar.\n\n'
            : '';
        const confirmar = confirm(
            'ATENÇÃO! A restauração substituirá os dados atuais pelo conteúdo do backup.\n\n' +
            avisoEstacoes +
            'Antes de restaurar, o sistema criará automaticamente uma cópia de segurança do banco atual.\n\n' +
            'Deseja continuar?'
        );
        if (!confirmar) return;

        botaoRestaurar.disabled = true;
        botaoRestaurar.textContent = '⏳ Validando backup...';

        try {
            const resposta = await window.api.restaurarBackup();
            if (resposta?.cancelado) return;
            if (!resposta?.sucesso) {
                alert(resposta?.mensagem || 'Não foi possível restaurar o backup.');
                return;
            }

            alert(
                'Backup restaurado com sucesso!\n\n' +
                'O Gestor Fácil será reiniciado para carregar os dados restaurados.\n\n' +
                'Cópia de segurança anterior:\n' +
                (resposta.nome_backup_seguranca || 'backup de segurança')
            );
        } catch (erro) {
            console.error('Erro na restauração:', erro);
            alert('Não foi possível restaurar o backup.');
        } finally {
            botaoRestaurar.disabled = false;
            botaoRestaurar.textContent = '🔄 Restaurar backup';
        }
    });

    const tabela = document.getElementById('tabela-auditoria');
    const busca = document.getElementById('aud-busca');
    const filtroUsuario = document.getElementById('aud-filtro-usuario');
    const filtroModulo = document.getElementById('aud-filtro-modulo');
    const filtroAcao = document.getElementById('aud-filtro-acao');
    const filtroNivel = document.getElementById('aud-filtro-nivel');
    const dataInicial = document.getElementById('aud-data-inicial');
    const dataFinal = document.getElementById('aud-data-final');
    let registros = [];
    let usuarios = [];

    const esc = v => String(v ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#039;');

    // O SQLite CURRENT_TIMESTAMP grava em UTC.
    // Convertemos explicitamente para UTC antes de exibir no horário local.
    const dataObj = v => {
        if (!v) return null;
        const texto = String(v).trim();
        if (!texto) return null;
        const normalizado = texto.includes('T') ? texto : texto.replace(' ', 'T');
        const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalizado)
            ? normalizado
            : `${normalizado}Z`);
        return Number.isNaN(d.getTime()) ? null : d;
    };

    const dataHora = v => {
        const d = dataObj(v);
        return d ? d.toLocaleString('pt-BR') : '-';
    };

    const chaveAcao = v => normalizarTexto(v).replace(/\s+/g,'_');

    const nivelAuditoria = registro => {
        const acao = chaveAcao(registro.acao);
        const modulo = normalizarTexto(registro.modulo);
        const descricao = normalizarTexto(registro.descricao);
        if (['excluir','exclusao','excluiu','deletar','delete'].some(x => acao.includes(x) || descricao.includes(x)) || acao.includes('alternar_status') || acao.includes('alterar_senha')) {
            return { chave:'critico', texto:'Crítico', icone:'🔴', estilo:'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;' };
        }
        if (['editar','ajuste','saida','entrada','cancelar','permiss'].some(x => acao.includes(x) || descricao.includes(x)) || modulo === 'estoque') {
            return { chave:'atencao', texto:'Atenção', icone:'🟠', estilo:'background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;' };
        }
        return { chave:'info', texto:'Informação', icone:'🔵', estilo:'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;' };
    };

    const descricaoAuditoriaDetalhada = registro => {
        const acao = chaveAcao(registro.acao);
        const origem = registro.origem_descricao || '';
        const nome = registro.origem_nome || '';
        if (acao.includes('finalizou_venda')) return `Finalizou ${origem || 'uma venda'}${nome ? ` para ${nome}` : ''}.`;
        if (acao.includes('cadastrou') || acao.includes('cadastrar') || acao === 'criar') return `${registro.descricao || 'Cadastrou um registro.'}${origem ? ` — ${origem}` : ''}${nome ? ` — ${nome}` : ''}`;
        if (acao.includes('editou') || acao === 'editar') return `${registro.descricao || 'Editou um registro.'}${origem ? ` — ${origem}` : ''}${nome ? ` — ${nome}` : ''}`;
        if (acao.includes('excluiu') || acao === 'excluir') return `${registro.descricao || 'Excluiu um registro.'}${origem ? ` — ${origem}` : ''}${nome ? ` — ${nome}` : ''}`;
        if (registro.descricao && (origem || nome)) return `${registro.descricao} — ${origem || nome}`;
        return registro.descricao || '-';
    };

    const referenciaAuditoria = registro => {
        if (registro.origem_descricao) return registro.origem_descricao;
        if (registro.entidade_tipo) return `${registro.entidade_tipo}${registro.entidade_id != null ? ` #${registro.entidade_id}` : ''}`;
        return '-';
    };

    const preencherSelect = (select, valores, rotulo) => {
        const atuais = [...new Set(valores.filter(Boolean).map(v => String(v)))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
        select.innerHTML = `<option value="">${rotulo}</option>` + atuais.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    };

    const hoje = new Date();
    const mesmoDia = (valor, dataBase = hoje) => {
        const d = dataObj(valor);
        return !!d && d.getFullYear() === dataBase.getFullYear() && d.getMonth() === dataBase.getMonth() && d.getDate() === dataBase.getDate();
    };

    const aplicarCards = () => {
        const hojeRegistros = registros.filter(x => mesmoDia(x.data_hora));
        const numero = campo => hojeRegistros.filter(x => chaveAcao(x.acao).includes(campo)).length;
        document.getElementById('aud-card-acoes').textContent = hojeRegistros.length;
        document.getElementById('aud-card-logins').textContent = hojeRegistros.filter(x => chaveAcao(x.acao).includes('login')).length;
        document.getElementById('aud-card-alteracoes').textContent = hojeRegistros.filter(x => ['editar','alterar','ajuste','status','permiss'].some(k => chaveAcao(x.acao).includes(k))).length;
        document.getElementById('aud-card-exclusoes').textContent = hojeRegistros.filter(x => ['excluir','exclusao','delet'].some(k => chaveAcao(x.acao).includes(k))).length;
        document.getElementById('aud-card-usuarios').textContent = usuarios.filter(x => Number(x.ativo) === 1).length;
    };

    const render = () => {
        const termo = normalizarTexto(busca.value);
        const ini = dataInicial.value ? new Date(`${dataInicial.value}T00:00:00`) : null;
        const fim = dataFinal.value ? new Date(`${dataFinal.value}T23:59:59.999`) : null;
        const lista = registros.filter(x => {
            const nivel = nivelAuditoria(x);
            const texto = normalizarTexto(`${x.usuario_nome || ''} ${x.usuario_login || ''} ${x.modulo || ''} ${x.acao || ''} ${x.descricao || ''} ${x.entidade_tipo || ''} ${x.entidade_id || ''}`);
            const d = dataObj(x.data_hora);
            if (filtroUsuario.value && String(x.usuario_id || '') !== filtroUsuario.value) return false;
            if (filtroModulo.value && String(x.modulo || '') !== filtroModulo.value) return false;
            if (filtroAcao.value && chaveAcao(x.acao) !== filtroAcao.value) return false;
            if (filtroNivel.value && nivel.chave !== filtroNivel.value) return false;
            if (ini && (!d || d < ini)) return false;
            if (fim && (!d || d > fim)) return false;
            if (termo && !texto.includes(termo)) return false;
            return true;
        });

        document.getElementById('aud-total').textContent = `${lista.length} registro(s) encontrado(s) de ${registros.length} carregado(s).`;
        document.getElementById('aud-status-filtro').textContent = (filtroUsuario.value || filtroModulo.value || filtroAcao.value || filtroNivel.value || ini || fim || termo) ? 'Filtros ativos' : 'Sem filtros';

        tabela.innerHTML = lista.length ? lista.map(x => {
            const nivel = nivelAuditoria(x);
            return `<tr>
                <td>${esc(dataHora(x.data_hora))}</td>
                <td><span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:800;${nivel.estilo}">${nivel.icone} ${nivel.texto}</span></td>
                <td><strong>${esc(x.usuario_nome || x.usuario_login || '-')}</strong><br><small>${esc(x.usuario_login || '')}</small></td>
                <td>${x.perfil === 'administrador' ? '👑 Administrador' : '👤 Funcionário'}</td>
                <td>${esc(x.modulo || '-')}</td>
                <td><strong>${esc(x.acao || '-')}</strong></td>
                <td>${esc(descricaoAuditoriaDetalhada(x))}<br><small style="color:#64748b;">${esc(referenciaAuditoria(x))}</small></td>
                <td style="text-align:right;"><button type="button" class="button secondary" data-auditoria-id="${Number(x.id)}" style="padding:7px 10px;font-size:12px;">👁 Ver</button></td>
            </tr>`;
        }).join('') : '<tr><td colspan="8" class="empty-table">Nenhum registro encontrado com os filtros selecionados.</td></tr>';

        tabela.querySelectorAll('[data-auditoria-id]').forEach(botao => {
            botao.addEventListener('click', () => {
                const registro = registros.find(x => Number(x.id) === Number(botao.dataset.auditoriaId));
                if (registro) abrirDetalhesAuditoria(registro);
            });
        });
    };

    function abrirDetalhesAuditoria(registro) {
        document.querySelectorAll('.modal-overlay-gestor').forEach(el => el.remove());
        const nivel = nivelAuditoria(registro);

        const parseSnapshot = valor => {
            if (!valor) return null;
            if (typeof valor === 'object') return valor;
            try { return JSON.parse(valor); } catch (_) { return null; }
        };

        const rotulosSnapshot = {
            id:'ID', nome:'Nome', usuario:'Usuário', perfil:'Perfil', ativo:'Status', primeiro_acesso:'Primeiro acesso',
            numero:'Número', cliente_id:'ID do cliente', tipo_equipamento:'Equipamento', marca:'Marca', modelo:'Modelo', numero_serie:'Número de série',
            sistema_operacional:'Sistema operacional', acessorios:'Acessórios', estado_fisico:'Estado físico', avarias:'Avarias', problema_relatado:'Problema relatado',
            diagnostico:'Diagnóstico', servico_realizado:'Serviço realizado', previsao_entrega:'Previsão de entrega', status:'Status', valor_pecas:'Valor das peças',
            valor_mao_obra:'Mão de obra', desconto:'Desconto', total:'Total', observacoes:'Observações', codigo:'Código', sku:'SKU', codigo_barras:'Código de barras',
            categoria:'Categoria', preco_custo:'Preço de custo', preco_venda:'Preço de venda', estoque:'Estoque', estoque_minimo:'Estoque mínimo', cpf_cnpj:'CPF/CNPJ',
            telefone:'Telefone', celular:'Celular', email:'E-mail', cep:'CEP', endereco:'Endereço', numero:'Número', complemento:'Complemento', bairro:'Bairro',
            cidade:'Cidade', estado:'Estado', subtotal:'Subtotal', forma_pagamento:'Forma de pagamento', data_hora:'Data/hora', venda_id:'ID da venda', os_id:'ID da OS',
            produto_id:'ID do produto', descricao:'Descrição', prazo_dias:'Prazo (dias)', data_inicio:'Data inicial', data_fim:'Data final'
        };

        const formatarSnapshotValor = (chave, valor) => {
            if (valor === null || valor === undefined || valor === '') return '—';
            if (['preco_custo','preco_venda','subtotal','desconto','total','valor_pecas','valor_mao_obra'].includes(chave)) {
                const n = Number(valor);
                return Number.isFinite(n) ? `R$ ${n.toFixed(2).replace('.', ',')}` : String(valor);
            }
            if (chave === 'ativo') return Number(valor) === 1 ? 'Ativo' : 'Inativo';
            if (chave === 'primeiro_acesso') return Number(valor) === 1 ? 'Sim' : 'Não';
            return String(valor);
        };

        const renderAntesDepois = registro => {
            const antes = parseSnapshot(registro.dados_antes);
            const depois = parseSnapshot(registro.dados_depois);
            if (!antes && !depois) return '';
            const chaves = [...new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})])].filter(k => k !== 'id');
            const alteradas = chaves.filter(k => JSON.stringify((antes || {})[k]) !== JSON.stringify((depois || {})[k]));
            const lista = (antes && depois) ? alteradas : chaves;
            if (!lista.length) return '';
            const titulo = antes && depois ? 'Alterações realizadas (Antes × Depois)' : (depois ? 'Dados registrados' : 'Dados anteriores à exclusão');
            return `<div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:16px;">
                <h4 style="margin:0 0 10px;font-size:14px;color:#111827;">${titulo}</h4>
                <div style="overflow:auto;border:1px solid #e5e7eb;border-radius:10px;">
                    <table style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr><th style="text-align:left;padding:9px;background:#f8fafc;">Campo</th>${antes ? '<th style="text-align:left;padding:9px;background:#fef2f2;">Antes</th>' : ''}${depois ? '<th style="text-align:left;padding:9px;background:#f0fdf4;">Depois</th>' : ''}</tr></thead>
                        <tbody>${lista.map(k => `<tr><td style="padding:9px;border-top:1px solid #f1f5f9;font-weight:700;">${esc(rotulosSnapshot[k] || k)}</td>${antes ? `<td style="padding:9px;border-top:1px solid #f1f5f9;color:#b91c1c;">${esc(formatarSnapshotValor(k, antes[k]))}</td>` : ''}${depois ? `<td style="padding:9px;border-top:1px solid #f1f5f9;color:#166534;">${esc(formatarSnapshotValor(k, depois[k]))}</td>` : ''}</tr>`).join('')}</tbody>
                    </table>
                </div>
            </div>`;
        };
        const modal = document.createElement('div');
        modal.className = 'modal-overlay-gestor';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.48);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100000;';
        const linha = (titulo, valor) => `<div style="padding:12px 0;border-bottom:1px solid #f1f5f9;"><div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;margin-bottom:4px;">${titulo}</div><div style="font-size:14px;color:#111827;word-break:break-word;">${esc(valor || '-')}</div></div>`;
        modal.innerHTML = `<div style="width:min(680px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.22);padding:24px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:15px;margin-bottom:12px;">
                <div><h3 style="margin:0 0 5px;">Detalhes da auditoria</h3><span style="font-size:13px;color:#64748b;">Registro #${esc(registro.id)}</span></div>
                <button type="button" id="fechar-detalhe-auditoria" style="border:0;background:#f1f5f9;border-radius:8px;padding:7px 10px;cursor:pointer;font-size:18px;">×</button>
            </div>
            <div style="margin:8px 0 15px;"><span style="display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:800;${nivel.estilo}">${nivel.icone} ${nivel.texto}</span></div>
            ${linha('Data e hora', dataHora(registro.data_hora))}
            ${linha('Usuário', `${registro.usuario_nome || '-'} (${registro.usuario_login || '-'})`)}
            ${linha('Perfil', registro.perfil === 'administrador' ? 'Administrador' : 'Funcionário')}
            ${linha('Módulo', registro.modulo)}
            ${linha('Ação', registro.acao)}
            ${linha('O que foi feito', descricaoAuditoriaDetalhada(registro))}
            ${linha('Origem / referência', referenciaAuditoria(registro))}
            ${linha('Pessoa / cliente relacionado', registro.origem_nome || '-')}
            ${linha('Detalhes do registro', registro.origem_detalhes || registro.descricao || '-')}
            ${linha('ID do registro', registro.entidade_id != null ? registro.entidade_id : '-')}
            ${linha('Tipo do registro', registro.entidade_tipo || '-')}
            ${linha('ID do usuário', registro.usuario_id)}
            ${renderAntesDepois(registro)}
            <div style="display:flex;justify-content:flex-end;margin-top:18px;"><button type="button" class="button secondary" id="fechar-detalhe-auditoria-2">Fechar</button></div>
        </div>`;
        document.body.appendChild(modal);
        const fechar = () => modal.remove();
        modal.querySelector('#fechar-detalhe-auditoria').onclick = fechar;
        modal.querySelector('#fechar-detalhe-auditoria-2').onclick = fechar;
        modal.addEventListener('click', e => { if (e.target === modal) fechar(); });
    }

    const carregar = async () => {
        try {
        const resposta = await window.api.listarAuditoria({limite:1000});
        if (!resposta?.sucesso) throw new Error(resposta?.mensagem || 'O banco não retornou os registros de auditoria.');
        registros = Array.isArray(resposta.registros) ? resposta.registros : [];
        try {
            const respostaUsuarios = await window.api.listarUsuarios();
            usuarios = Array.isArray(respostaUsuarios) ? respostaUsuarios : (Array.isArray(respostaUsuarios?.usuarios) ? respostaUsuarios.usuarios : []);
        } catch (erro) {
            console.warn('Não foi possível carregar usuários para o indicador:', erro);
            usuarios = [];
        }
        preencherSelect(filtroUsuario, registros.map(x => x.usuario_id), 'Todos');
        filtroUsuario.querySelectorAll('option').forEach(opt => {
            if (!opt.value) return;
            const registro = registros.find(x => String(x.usuario_id || '') === opt.value);
            if (registro) opt.textContent = `${registro.usuario_nome || registro.usuario_login || 'Usuário'} (${registro.usuario_login || ''})`;
        });
        preencherSelect(filtroModulo, registros.map(x => x.modulo), 'Todos');
        preencherSelect(filtroAcao, registros.map(x => chaveAcao(x.acao)), 'Todas');
        filtroAcao.querySelectorAll('option').forEach(opt => {
            if (!opt.value) return;
            const registro = registros.find(x => chaveAcao(x.acao) === opt.value);
            if (registro) opt.textContent = registro.acao;
        });
        aplicarCards();
        render();
        } catch (erro) {
            console.error('Erro ao carregar auditoria:', erro);
            const total = document.getElementById('aud-total');
            if (total) total.textContent = 'Não foi possível carregar os registros';
            if (tabela) tabela.innerHTML = `<tr><td colspan="8" class="empty-table">Falha ao carregar a auditoria: ${esc(erro?.message || 'erro inesperado')}. Clique em Atualizar para tentar novamente.</td></tr>`;
        }
    };

    const controles = [filtroUsuario, filtroModulo, filtroAcao, filtroNivel, dataInicial, dataFinal];
    controles.forEach(el => el.addEventListener('change', render));
    busca.addEventListener('input', render);
    document.getElementById('auditoria-atualizar').addEventListener('click', carregar);
    document.getElementById('auditoria-limpar').addEventListener('click', () => {
        filtroUsuario.value = ''; filtroModulo.value = ''; filtroAcao.value = ''; filtroNivel.value = '';
        dataInicial.value = ''; dataFinal.value = ''; busca.value = ''; render();
    });

    await carregar();
}


/*
    ==================================================
    USUÁRIOS E PERMISSÕES
    ==================================================
*/

// Administração de usuários, estado das contas e permissões por módulo.
async function mostrarUsuarios() {
    if (!usuarioPode('usuarios')) {
        acaoNegada();
        mostrarInicio();
        return;
    }

    conteudo.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Usuários</h2>
                <p>Gerencie usuários, perfis, acesso e permissões do sistema.</p>
            </div>
            <button class="button" id="novo-usuario">+ Novo usuário</button>
        </div>

        <div class="panel">
            <div class="panel-header" style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;">
                <div><h3>Usuários cadastrados</h3><span>Somente administradores podem gerenciar acessos.</span></div>
                <input id="busca-usuarios" placeholder="🔎 Buscar por nome ou usuário" style="min-width:280px;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;">
            </div>
            <div style="overflow:auto;">
                <table>
                    <thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Status</th><th>Última atualização</th><th style="text-align:right;">Ações</th></tr></thead>
                    <tbody id="tabela-usuarios"><tr><td colspan="6" class="empty-table">Carregando...</td></tr></tbody>
                </table>
            </div>
        </div>
    `;

    let usuarios = [];

    const escapar = valor => String(valor ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    const dataHora = valor => formatarDataHoraLocal(valor);

    function renderizar(filtro='') {
        const termo = normalizarTexto(filtro);
        const lista = usuarios.filter(u => !termo || normalizarTexto(u.nome).includes(termo) || normalizarTexto(u.usuario).includes(termo));
        const tbody = document.getElementById('tabela-usuarios');
        tbody.innerHTML = lista.length ? lista.map(u => `
            <tr>
                <td><strong>${escapar(u.nome)}</strong></td>
                <td>${escapar(u.usuario)}</td>
                <td>${u.perfil === 'administrador' ? '👑 Administrador' : '👤 Funcionário'}</td>
                <td>${u.ativo ? '<span style="color:#15803d;font-weight:700;">● Ativo</span>' : '<span style="color:#b91c1c;font-weight:700;">● Inativo</span>'}</td>
                <td>${escapar(dataHora(u.atualizado_em))}</td>
                <td style="text-align:right;white-space:nowrap;">
                    <button class="button secondary btn-editar-usuario" data-id="${u.id}">✏️ Editar</button>
                    <button class="button secondary btn-senha-usuario" data-id="${u.id}">🔑 Senha</button>
                    ${u.perfil === 'funcionario' ? `<button class="button secondary btn-permissoes-usuario" data-id="${u.id}">⚙️ Permissões</button>` : ''}
                    ${Number(u.id) !== Number(usuarioLogado.id) ? `<button class="button secondary btn-status-usuario" data-id="${u.id}">${u.ativo ? '🚫 Desativar' : '✅ Ativar'}</button>` : ''}
                </td>
            </tr>
        `).join('') : '<tr><td colspan="6" class="empty-table">Nenhum usuário encontrado.</td></tr>';

        tbody.querySelectorAll('.btn-editar-usuario').forEach(btn => btn.addEventListener('click', () => abrirModalUsuario(usuarios.find(u => u.id === Number(btn.dataset.id)))));
        tbody.querySelectorAll('.btn-senha-usuario').forEach(btn => btn.addEventListener('click', () => alterarSenha(usuarios.find(u => u.id === Number(btn.dataset.id)))));
        tbody.querySelectorAll('.btn-permissoes-usuario').forEach(btn => btn.addEventListener('click', () => abrirModalPermissoes(usuarios.find(u => u.id === Number(btn.dataset.id)))));
        tbody.querySelectorAll('.btn-status-usuario').forEach(btn => btn.addEventListener('click', () => alternarStatus(usuarios.find(u => u.id === Number(btn.dataset.id)))));
    }

    async function carregar() {
        const resultado = await window.api.listarUsuarios();
        if (resultado?.sucesso === false) { alert(resultado.mensagem); return; }
        usuarios = Array.isArray(resultado) ? resultado : [];
        renderizar(document.getElementById('busca-usuarios').value);
    }

    function fecharModal() { document.getElementById('modal-seguranca-gestor')?.remove(); }
    function criarModal(conteudoModal) {
        fecharModal();
        const modal=document.createElement('div');
        modal.id='modal-seguranca-gestor';
        modal.innerHTML=`<div style="position:fixed;inset:0;background:rgba(15,23,42,.48);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;">
            <div style="width:min(720px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.2);padding:24px;">${conteudoModal}</div>
        </div>`;
        document.body.appendChild(modal);
        modal.firstElementChild.addEventListener('click', e => { if(e.target===modal.firstElementChild) fecharModal(); });
        return modal;
    }

    function abrirModalUsuario(usuario=null) {
        const editando=!!usuario;
        const modal=criarModal(`
            <div style="display:flex;justify-content:space-between;align-items:center;gap:15px;"><div><h2 style="margin:0;">${editando?'Editar usuário':'Novo usuário'}</h2><p style="margin:5px 0 0;color:#6b7280;">${editando?'Atualize os dados do usuário.':'Cadastre um novo acesso ao sistema.'}</p></div><button id="fechar-modal-usuario" class="button secondary">✕</button></div>
            <form id="form-usuario-seguranca" style="margin-top:22px;display:grid;gap:15px;">
                <div><label>Nome</label><input id="usuario-nome" required value="${escapar(usuario?.nome||'')}" style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;"></div>
                <div><label>Usuário</label><input id="usuario-login" required value="${escapar(usuario?.usuario||'')}" style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;"></div>
                <div><label>Perfil</label><select id="usuario-perfil" style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;"><option value="funcionario">👤 Funcionário</option><option value="administrador">👑 Administrador</option></select></div>
                ${!editando ? '<div><label>Senha inicial</label><input id="usuario-senha" type="password" minlength="6" required placeholder="Mínimo 6 caracteres" style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;"></div>' : ''}
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:5px;"><button type="button" class="button secondary" id="cancelar-modal-usuario">Cancelar</button><button class="button" type="submit">💾 Salvar</button></div>
            </form>`);
        modal.querySelector('#usuario-perfil').value=usuario?.perfil||'funcionario';
        modal.querySelector('#fechar-modal-usuario').onclick=fecharModal;
        modal.querySelector('#cancelar-modal-usuario').onclick=fecharModal;
        modal.querySelector('#form-usuario-seguranca').addEventListener('submit', async e=>{
            e.preventDefault();
            const dados={id:usuario?.id,nome:modal.querySelector('#usuario-nome').value.trim(),usuario:modal.querySelector('#usuario-login').value.trim(),perfil:modal.querySelector('#usuario-perfil').value};
            if(!editando) dados.senha=modal.querySelector('#usuario-senha').value;
            const r=editando?await window.api.editarUsuario(dados):await window.api.cadastrarUsuario(dados);
            if(!r?.sucesso){alert(r?.mensagem||'Não foi possível salvar o usuário.');return;}
            fecharModal(); await carregar();
        });
    }

    async function alterarSenha(usuario) {
        if (!usuario) {
            alert('Usuário não encontrado.');
            return;
        }

        const modal = criarModal(`
            <div style="display:flex;justify-content:space-between;align-items:center;gap:15px;">
                <div>
                    <h2 style="margin:0;">Alterar senha</h2>
                    <p style="margin:5px 0 0;color:#6b7280;">Defina uma nova senha para <strong>${escapar(usuario.nome)}</strong>.</p>
                </div>
                <button type="button" id="fechar-modal-senha" class="button secondary">✕</button>
            </div>
            <form id="form-alterar-senha" style="margin-top:22px;display:grid;gap:15px;">
                <div>
                    <label>Nova senha</label>
                    <input id="nova-senha-usuario" type="password" minlength="6" required autocomplete="new-password" placeholder="Mínimo 6 caracteres" style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;">
                </div>
                <div>
                    <label>Confirmar nova senha</label>
                    <input id="confirmar-senha-usuario" type="password" minlength="6" required autocomplete="new-password" placeholder="Digite a senha novamente" style="width:100%;padding:11px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;">
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:5px;">
                    <button type="button" class="button secondary" id="cancelar-modal-senha">Cancelar</button>
                    <button type="submit" class="button">🔑 Alterar senha</button>
                </div>
            </form>
        `);

        const fechar = () => fecharModal();
        modal.querySelector('#fechar-modal-senha').onclick = fechar;
        modal.querySelector('#cancelar-modal-senha').onclick = fechar;

        modal.querySelector('#form-alterar-senha').addEventListener('submit', async event => {
            event.preventDefault();

            const senha = modal.querySelector('#nova-senha-usuario').value;
            const confirmacao = modal.querySelector('#confirmar-senha-usuario').value;

            if (senha.length < 6) {
                alert('A senha deve possuir pelo menos 6 caracteres.');
                return;
            }

            if (senha !== confirmacao) {
                alert('As senhas não coincidem.');
                return;
            }

            const r = await window.api.alterarSenhaUsuario({ id: usuario.id, senha });
            if (!r?.sucesso) {
                alert(r?.mensagem || 'Não foi possível alterar a senha.');
                return;
            }

            fecharModal();
            alert('Senha alterada com sucesso.');
            await carregar();
        });

        setTimeout(() => modal.querySelector('#nova-senha-usuario')?.focus(), 0);
    }

    async function alternarStatus(usuario) {
        const acao=usuario.ativo?'desativar':'ativar';
        if(!confirm(`Deseja ${acao} o usuário ${usuario.nome}?`))return;
        const r=await window.api.alternarStatusUsuario(usuario.id);
        if(!r?.sucesso){alert(r?.mensagem||'Não foi possível alterar o status.');return;}
        await carregar();
    }

    async function abrirModalPermissoes(usuario) {
        const r=await window.api.buscarPermissoesUsuario(usuario.id);
        if(!r?.sucesso){alert(r?.mensagem||'Não foi possível carregar as permissões.');return;}
        const modulos=[['dashboard','Dashboard'],['produtos','Produtos'],['clientes','Clientes'],['vendas','Vendas'],['os','Ordens de Serviço'],['garantias','Garantias'],['estoque','Estoque'],['relatorios','Relatórios']];
        const mapa=Object.fromEntries((r.permissoes||[]).map(p=>[p.modulo,p]));
        const modal=criarModal(`
            <div style="display:flex;justify-content:space-between;align-items:center;gap:15px;"><div><h2 style="margin:0;">Permissões — ${escapar(usuario.nome)}</h2><p style="margin:5px 0 0;color:#6b7280;">Defina o que o funcionário pode consultar, criar, editar ou excluir.</p></div><button id="fechar-modal-perm" class="button secondary">✕</button></div>
            <div style="overflow:auto;margin-top:20px;"><table><thead><tr><th>Módulo</th><th>Consultar</th><th>Criar</th><th>Editar</th><th>Excluir</th></tr></thead><tbody>${modulos.map(([key,nome])=>{const p=mapa[key]||{};return `<tr><td><strong>${nome}</strong></td><td><input type="checkbox" data-modulo="${key}" data-acao="consultar" ${p.consultar?'checked':''}></td><td><input type="checkbox" data-modulo="${key}" data-acao="criar" ${p.criar?'checked':''}></td><td><input type="checkbox" data-modulo="${key}" data-acao="editar" ${p.editar?'checked':''}></td><td><input type="checkbox" data-modulo="${key}" data-acao="excluir" ${p.excluir?'checked':''}></td></tr>`}).join('')}</tbody></table></div>
            <div style="margin-top:18px;padding:12px;background:#f8fafc;border-radius:8px;color:#475569;font-size:13px;">Dica: se uma ação exigir criação, edição ou exclusão, o sistema também exige a permissão de consulta para acessar o módulo.</div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;"><button class="button secondary" id="cancelar-perm">Cancelar</button><button class="button" id="salvar-perm">💾 Salvar permissões</button></div>`);
        modal.querySelector('#fechar-modal-perm').onclick=fecharModal;
        modal.querySelector('#cancelar-perm').onclick=fecharModal;
        modal.querySelector('#salvar-perm').onclick=async()=>{
            const permissoes=modulos.map(([key])=>{const item={modulo:key};for(const acao of ['consultar','criar','editar','excluir']) item[acao]=modal.querySelector(`[data-modulo="${key}"][data-acao="${acao}"]`).checked;return item;});
            // Ações de alteração exigem consulta.
            for(const p of permissoes){if(p.criar||p.editar||p.excluir)p.consultar=true;}
            const resp=await window.api.salvarPermissoesUsuario({usuario_id:usuario.id,permissoes});
            if(!resp?.sucesso){alert(resp?.mensagem||'Não foi possível salvar as permissões.');return;}
            fecharModal(); await carregar();
        };
    }

    document.getElementById('novo-usuario').addEventListener('click',()=>abrirModalUsuario());
    document.getElementById('busca-usuarios').addEventListener('input',e=>renderizar(e.target.value));
    await carregar();
}

// Mantém o destaque de navegação sincronizado com a página aberta.
function marcarMenuAtivo(menuAtivo) {
    document.querySelectorAll('.menu-item').forEach(item => item.classList.remove('active'));
    if (menuAtivo) menuAtivo.classList.add('active');

    const titulos = {
        'menu-inicio': ['Dashboard', 'Visão geral do seu negócio'],
        'menu-produtos': ['Produtos', 'Catálogo e controle de produtos'],
        'menu-clientes': ['Clientes', 'Cadastro e relacionamento com clientes'],
        'menu-vendas': ['Vendas', 'Registro e histórico de vendas'],
        'menu-os': ['Ordens de Serviço', 'Acompanhamento de manutenções'],
        'menu-garantias': ['Garantias', 'Controle de garantias ativas'],
        'menu-estoque': ['Estoque', 'Movimentações e níveis de estoque'],
        'menu-relatorios': ['Relatórios', 'Indicadores do negócio'],
        'menu-usuarios': ['Usuários', 'Contas e permissões de acesso'],
        'menu-auditoria': ['Auditoria', 'Histórico de ações do sistema']
    };
    const titulo = menuAtivo ? titulos[menuAtivo.id] : null;
    if (titulo) {
        const tituloTopo = document.querySelector('.topbar h1');
        const descricaoTopo = document.querySelector('.topbar p');
        if (tituloTopo) tituloTopo.textContent = titulo[0];
        if (descricaoTopo) descricaoTopo.textContent = titulo[1];
    }
}

menuInicio.addEventListener(
    'click',
    () => {
        marcarMenuAtivo(menuInicio);
        mostrarInicio();
    }
);

if (menuRelatorios) {
    menuRelatorios.addEventListener('click', () => {
        if (usuarioPode('relatorios')) {
            marcarMenuAtivo(menuRelatorios);
            mostrarRelatorios();
        } else {
            acaoNegada();
        }
    });
}

menuProdutos.addEventListener('click', () => {
    if (usuarioPode('produtos')) {
        marcarMenuAtivo(menuProdutos);
        mostrarProdutos();
    } else acaoNegada();
});

menuClientes.addEventListener('click', () => {
    if (usuarioPode('clientes')) {
        marcarMenuAtivo(menuClientes);
        mostrarClientes();
    } else acaoNegada();
});

menuVendas.addEventListener('click', () => {
    if (usuarioPode('vendas')) {
        marcarMenuAtivo(menuVendas);
        mostrarVendas();
    } else acaoNegada();
});

if (menuUsuarios) {
    menuUsuarios.addEventListener('click', () => {
        marcarMenuAtivo(menuUsuarios);
        mostrarUsuarios();
    });
}

if (menuAuditoria) {
    menuAuditoria.addEventListener('click', () => {
        marcarMenuAtivo(menuAuditoria);
        mostrarAuditoria();
    });
}

if (menuEstoque) {
    menuEstoque.addEventListener('click', () => {
        if (usuarioPode('estoque')) {
            marcarMenuAtivo(menuEstoque);
            mostrarEstoque();
        } else acaoNegada();
    });
}

menuOS.addEventListener('click', () => {
    if (usuarioPode('os')) {
        marcarMenuAtivo(menuOS);
        mostrarOrdensServico();
    } else acaoNegada();
});

menuGarantias.addEventListener('click', () => {
    if (usuarioPode('garantias')) {
        marcarMenuAtivo(menuGarantias);
        mostrarGarantias();
    } else acaoNegada();
});

marcarMenuAtivo(menuInicio);

