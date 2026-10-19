# Gestor Fácil em rede local com Firebird

## Implementado no código

- A instalação pergunta se o computador é o servidor ou uma estação.
- No primeiro início no servidor, o programa valida o esquema Firebird. Se o banco central estiver vazio e houver dados SQLite locais, importa esses dados sem apagar a origem. Um banco central que já contém registros nunca recebe uma mesclagem automática.
- O runtime usa uma única fonte de dados por vez. Depois de abrir o Firebird, fecha o SQLite local; falhas de conexão encerram a inicialização em vez de salvar localmente.
- A estação procura o servidor na rede local e é pareada com código temporário de uso único. O tráfego de credenciais é cifrado no pareamento; a descoberta por broadcast não divulga senhas.
- O acesso à rede usa a conta restrita `GESTOR_APP`. A credencial da conta de backup fica protegida localmente e não é transmitida às estações.
- O backup usa o serviço nativo do Firebird e arquivos `.fbk`. Depois de criar a cópia, testa a restauração em um arquivo temporário antes de reportar sucesso. Backups automáticos têm retenção configurável e podem ocorrer em horários diferentes no mesmo dia.
- A restauração valida o `.fbk`, cria e valida primeiro um backup da base atual, depois substitui a base e reinicia o aplicativo. Estações devem ser fechadas antes da restauração.
- O backup automático roda enquanto o Gestor Fácil está aberto no servidor. O local escolhido precisa ser acessível ao serviço Firebird.

## Proteção dos dados

- A instalação de servidor não sobrescreve uma base Firebird que já exista.
- A importação conserva o SQLite original e verifica esquema, integridade referencial, limites de texto/número e correspondência de registros/IDs antes do commit.
- O instalador não substitui uma instalação Firebird preexistente; ele interrompe o processo para preservar o serviço.
- A senha `SYSDBA` é usada apenas na configuração inicial do Firebird. O programa de gestão usa `GESTOR_APP`; o backup usa uma conta separada com o papel administrativo necessário ao serviço de backup.
- Não publique a porta Firebird na Internet. O desenho é para rede local privada.

## Limite da validação

As rotinas JavaScript foram verificadas sintaticamente. Este ambiente não confirmou uma instalação Firebird real, uma conexão de estação em outra máquina, nem um ciclo real de backup/restauração. Antes de distribuir a atualização, valide o instalador numa cópia de dados e numa rede de ensaio; não use a base de produção para o primeiro ensaio.

## Comandos de manutenção

- `npm run preparar:firebird`: baixa e valida a distribuição oficial usada pelo instalador.
- `npm run criar:esquema-firebird`: cria/valida o esquema numa base configurada para manutenção.
- `npm run diagnosticar:firebird`: diagnóstico de conectividade e estrutura.
- `npm run migrar:firebird`: importação manual controlada do SQLite para Firebird.
- `npm run dist`: cria o instalador Windows sem publicar uma Release.

As ferramentas de migração não devem ser executadas manualmente contra a base de produção sem uma cópia de segurança verificada.
