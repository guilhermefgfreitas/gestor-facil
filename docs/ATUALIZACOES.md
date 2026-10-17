# Publicação e atualização do Gestor Fácil

O aplicativo instalado consulta o provedor GitHub definido no `app-update.yml` gerado durante a compilação. O destino configurado é `guilhermefgfreitas/gestor-facil`.

## Primeira publicação

1. Publique o código e o fluxo de compilação no repositório ou configure um repositório-fonte separado que publique os artefatos nele.
2. Mantenha a versão do aplicativo em `package.json`.
3. Gere e instale a primeira versão publicada. Instalações anteriores sem configuração do atualizador precisam receber esse instalador manualmente uma vez.

## Publicar uma atualização

1. Incremente `version` em `package.json` (por exemplo, de `1.0.0` para `1.0.1`).
2. Envie as alterações ao repositório.
3. Crie e envie a tag correspondente (por exemplo, `v1.0.1`). A ação em `.github/workflows/release.yml` compila o instalador Windows e publica os artefatos da versão no GitHub Releases.
4. No computador do cliente, o botão **Verificar atualizações** consulta o GitHub, baixa a versão nova e oferece reiniciar para concluir a instalação.

O repositório e suas Releases precisam estar públicos para que as instalações dos clientes consultem os arquivos sem credenciais. A chave de licença privada não deve ser adicionada ao repositório.
