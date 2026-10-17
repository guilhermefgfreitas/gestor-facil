const campoCliente = document.getElementById('cliente');
const campoMaquina = document.getElementById('maquina');
const campoValidade = document.getElementById('validade');
const campoDias = document.getElementById('dias');
const codigo = document.getElementById('codigo');
const mensagem = document.getElementById('mensagem');
const botaoGerar = document.getElementById('gerar');
const botaoCopiar = document.getElementById('copiar');
const botaoSalvar = document.getElementById('salvar');
const seloStatus = document.getElementById('selo-status');

function mostrarMensagem(texto, sucesso = false) {
    mensagem.textContent = texto || '';
    mensagem.className = `mensagem${sucesso ? ' sucesso' : ''}`;
}

function diasSelecionados() {
    if (campoValidade.value === 'custom') return campoDias.value;
    return campoValidade.value;
}

campoMaquina.addEventListener('input', () => {
    const cursor = campoMaquina.selectionStart;
    const normalizado = campoMaquina.value.toUpperCase().replace(/\s+/g, '');
    if (campoMaquina.value !== normalizado) {
        campoMaquina.value = normalizado;
        campoMaquina.setSelectionRange(cursor, cursor);
    }
});

campoValidade.addEventListener('change', () => {
    document.getElementById('campo-dias').hidden = campoValidade.value !== 'custom';
});

botaoGerar.addEventListener('click', async () => {
    mostrarMensagem('');
    botaoGerar.disabled = true;
    botaoGerar.textContent = 'Gerando...';
    try {
        const dias = diasSelecionados();
        const resultado = await window.licenciador.gerar({
            cliente: campoCliente.value,
            maquina: campoMaquina.value,
            dias: dias === '' ? null : dias
        });
        if (!resultado.sucesso) {
            mostrarMensagem(resultado.mensagem);
            return;
        }
        codigo.value = resultado.codigo;
        botaoCopiar.disabled = false;
        botaoSalvar.disabled = false;
        seloStatus.textContent = 'Licença gerada';
        seloStatus.classList.add('ativo');
        mostrarMensagem('Licença pronta. Copie o código ou salve em um arquivo para enviar ao cliente.', true);
    } catch (erro) {
        mostrarMensagem(erro.message || 'Não foi possível gerar a licença.');
    } finally {
        botaoGerar.disabled = false;
        botaoGerar.textContent = 'Gerar licença';
    }
});

botaoCopiar.addEventListener('click', async () => {
    const resultado = await window.licenciador.copiar(codigo.value);
    mostrarMensagem(resultado.sucesso ? 'Código copiado para a área de transferência.' : resultado.mensagem, resultado.sucesso);
});

botaoSalvar.addEventListener('click', async () => {
    const resultado = await window.licenciador.salvar(codigo.value);
    if (resultado.sucesso) mostrarMensagem(`Licença salva em ${resultado.caminho}`, true);
    else if (!resultado.cancelado) mostrarMensagem(resultado.mensagem);
});

window.licenciador.estado().then(estado => {
    document.getElementById('aviso-chave').hidden = estado.chaveDisponivel;
}).catch(() => {
    document.getElementById('aviso-chave').hidden = false;
});
