# Licenciamento do Gestor Fácil

O instalador contém somente a chave pública. A chave privada de emissão fica fora do projeto, em `%APPDATA%\Gestor Facil Licencas\license-private.pem`.

1. Execute `npm run licenca:preparar` uma única vez neste computador de emissão.
2. Faça uma cópia segura da chave privada. Nunca a envie aos clientes nem a inclua no repositório ou instalador.
3. Peça ao cliente o código da máquina exibido na tela de ativação.
4. Gere uma licença com `npm run licenca:gerar -- --cliente "Nome do cliente" --maquina GF-CODIGO`.
5. Para uma licença com prazo, acrescente `--dias 365` (ou outro número de dias).
6. Envie ao cliente somente o código de licença gerado.

Licenças atuais são assinadas com Ed25519, vinculadas a um código derivado do identificador de instalação do Windows e validadas localmente. Esta versão não oferece revogação remota nem limite centralizado de ativações. Para isso será necessário um serviço online de licenças.
