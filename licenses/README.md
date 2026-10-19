# Licenciamento do Gestor Fácil

O instalador contém somente as chaves públicas. A chave privada de emissão v2 fica fora do projeto, em `%APPDATA%\Gestor Facil Licencas\license-private-v2.pem`. A chave pública v1 permanece no aplicativo para validar licenças já emitidas.

1. Execute `npm run licenca:preparar:v2` uma única vez neste computador de emissão.
2. Faça uma cópia segura da chave privada. Nunca a envie aos clientes nem a inclua no repositório ou instalador.
3. Peça ao cliente o código da máquina exibido na tela de ativação.
4. Gere uma licença com `npm run licenca:gerar -- --cliente "Nome do cliente" --maquina GF-CODIGO`.
5. Para uma licença com prazo, acrescente `--dias 365` (ou outro número de dias).
6. Envie ao cliente somente o código de licença gerado.

As licenças são assinadas com Ed25519, vinculadas a um código derivado do identificador de instalação do Windows e validadas localmente. O aplicativo mantém a chave pública v1 para licenças anteriores e inclui a chave pública v2 para novas emissões. Os clientes precisam atualizar o Gestor Fácil antes de ativar licenças v2. Esta versão não oferece revogação remota nem limite centralizado de ativações.
