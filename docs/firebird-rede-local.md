# Instalação do Gestor Fácil em rede local

## Preparação

1. Escolha um computador que permanecerá ligado durante o expediente para atuar como servidor.
2. Instale o Gestor Fácil no servidor e selecione **Servidor principal** no instalador.
3. Confirme o UAC do Windows. O instalador prepara Firebird 5, a base e o esquema iniciais, as contas restritas do aplicativo e do backup e as regras de firewall da rede privada.
4. Abra o Gestor Fácil no servidor. Se a instalação anterior tinha dados SQLite, esses dados são importados somente quando a base Firebird central está vazia; o arquivo SQLite original é preservado.
5. Conclua o cadastro do administrador inicial.

## Adicionar uma estação

1. Instale o Gestor Fácil no outro computador e selecione **Estação**.
2. Abra o programa e aguarde a busca pelo servidor local.
3. No servidor, entre como administrador e abra **Auditoria > Conectar estação**.
4. Copie o código temporário e informe-o na estação. O código expira em cinco minutos e só pode ser usado uma vez.
5. A estação salva a configuração protegida pelo Windows e passa a entrar no mesmo banco Firebird do servidor.

O broadcast de descoberta informa apenas identificador, nome/alias e portas. O código de pareamento protege a credencial de conexão durante a transmissão. A senha administrativa da conta de backup nunca é enviada à estação.

## Backup e restauração

- Configure backup manual ou automático em **Auditoria > Backup e segurança** no servidor. As estações não executam operações de backup.
- Os arquivos são backups Firebird `.fbk`, armazenados no computador servidor. O Firebird cria o arquivo em `C:\ProgramData\GestorFacil\Backups`, onde o serviço tem acesso, e o Gestor Fácil copia o resultado para a pasta de destino escolhida.
- O backup só informa sucesso quando a operação do Firebird termina sem erro e o arquivo foi criado com conteúdo. A conferência por restauração é feita quando o arquivo é restaurado; ela não é usada durante cada backup porque exigiria conceder ao usuário de backup permissão global para criar bancos.
- O agendamento é executado enquanto o programa está aberto no servidor. Se o servidor for desligado, o horário perdido será tentado na próxima abertura.
- Antes da restauração, feche o programa em todas as estações. O servidor valida o arquivo, grava uma cópia de segurança da base atual e só então substitui a base e reinicia o Gestor Fácil.

Guarde também cópias em outro disco ou dispositivo protegido. A retenção automática só controla os arquivos de backup daquela pasta; não substitui uma cópia fora do computador servidor.

## Rede e segurança

- Firebird comunica pela porta TCP 3050. A descoberta local usa UDP 45876; o pareamento usa TCP 45877. O instalador cria regras apenas para o perfil privado do firewall.
- Mantenha os computadores na mesma rede local. Se a descoberta não encontrar o servidor, confirme que a rede Windows está como **Privada**, que o serviço Firebird está em execução e que as regras privadas estão ativas. Também é possível resolver o nome do servidor pela rede local e usar a tela de conexão disponível no programa.
- Não exponha a porta 3050 na Internet e não mova o arquivo `.fdb` para OneDrive, NAS ou pasta SMB. As estações conectam ao serviço; apenas o servidor acessa o arquivo de banco.

## Limite de validação desta versão

O código e o instalador foram preparados para esse fluxo, mas o ciclo completo precisa ser validado em dois computadores com Firebird instalado antes de uso em produção. Faça o primeiro ensaio numa base de cópia: crie um registro numa estação, confirme-o no servidor e na outra estação, crie um `.fbk`, confira o teste automático e faça uma restauração de ensaio.
