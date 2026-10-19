param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$SchemaPath,
    [Parameter(Mandatory = $true)][string]$AppDataPath,
    [string]$MachineConfigPath = (Join-Path $env:ProgramData 'GestorFacil'),
    [string]$DatabaseDirectory = (Join-Path $env:ProgramData 'GestorFacil\Database'),
    [string]$AppVersion = 'desconhecida'
)

$ErrorActionPreference = 'Stop'
$LogPath = Join-Path $env:ProgramData 'GestorFacil\logs\firebird-install.log'
$StatePath = Join-Path $env:ProgramData 'GestorFacil\firebird-install-state.dpapi'
$LegacyStatePath = Join-Path $AppDataPath 'firebird-install-state.dpapi'
$EtapaAtual = 'inicialização'

function Write-InstallLog([string]$Mensagem) {
    $pastaLog = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Path $pastaLog -Force | Out-Null
    Add-Content -LiteralPath $LogPath -Value ('{0:yyyy-MM-dd HH:mm:ss.fff} {1}' -f (Get-Date), $Mensagem) -Encoding UTF8
}

function Get-SetupLogDirectories {
    $pastas = @([System.IO.Path]::GetTempPath())
    # O instalador NSIS pode elevar o PowerShell e mudar TEMP para o perfil
    # administrativo. O log do Inno, porém, foi criado no perfil que iniciou
    # o instalador; derive o TEMP desse perfil a partir do AppDataPath recebido.
    $appData = Split-Path -Parent (Split-Path -Parent $AppDataPath)
    if ($appData) {
        $tempDoUsuario = Join-Path (Join-Path $appData 'Local') 'Temp'
        if (Test-Path -LiteralPath $tempDoUsuario -PathType Container) { $pastas += $tempDoUsuario }
    }
    return @($pastas | Select-Object -Unique)
}

function Get-FirebirdInstallDirectory {
    $servico = Get-CimInstance Win32_Service -Filter "Name='FirebirdServerDefaultInstance'" -ErrorAction Stop
    if (-not $servico -or -not $servico.PathName) { throw 'O caminho do serviço Firebird não pôde ser localizado.' }
    $executavel = [regex]::Match([string]$servico.PathName, '^\s*"([^"]+\.exe)"|^\s*([^\s]+\.exe)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $caminhoExe = if ($executavel.Groups[1].Success) { $executavel.Groups[1].Value } else { $executavel.Groups[2].Value }
    if (-not $caminhoExe -or [System.IO.Path]::GetFileName($caminhoExe) -ine 'firebird.exe' -or
        -not (Test-Path -LiteralPath $caminhoExe -PathType Leaf)) {
        throw 'O serviço Firebird aponta para um executável inesperado ou inexistente.'
    }
    return (Split-Path -Parent $caminhoExe)
}

function Test-RecentEmptyFirebirdInstall([string]$DiretorioFirebird, [string]$DatabasePath, [string]$ConfigPath) {
    $service = Get-CimInstance Win32_Service -Filter "Name='FirebirdServerDefaultInstance'" -ErrorAction Stop
    $securityDb = Join-Path $DiretorioFirebird 'security5.fdb'
    $uninstaller = Join-Path $DiretorioFirebird 'unins000.exe'
    if (Test-Path -LiteralPath $DatabasePath) { Write-InstallLog 'Retomada recusada: já existe o banco principal do Gestor Fácil.'; return $false }
    if (Test-Path -LiteralPath $ConfigPath) {
        Write-InstallLog ("Encontrou configuração Firebird em {0}; ela será preservada antes da retomada." -f $ConfigPath)
    }
    if (-not (Test-Path -LiteralPath $securityDb)) { Write-InstallLog 'Retomada recusada: security5.fdb não foi encontrado.'; return $false }
    if (-not (Test-Path -LiteralPath $uninstaller)) { Write-InstallLog 'Retomada recusada: desinstalador Firebird não foi encontrado.'; return $false }

    $bancosInstalacao = @(Get-ChildItem -LiteralPath $DiretorioFirebird -Filter '*.fdb' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ine 'security5.fdb' })
    if ($bancosInstalacao.Count -gt 0) {
        Write-InstallLog ("Retomada recusada: encontrou outros bancos na pasta Firebird: {0}." -f (($bancosInstalacao.Name) -join ', '))
        return $false
    }

    $caminhoExe = [string]$service.PathName -replace '^\s*"([^"]+\.exe)".*$', '$1'
    $eventos = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 7045 } -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match 'Firebird Server - DefaultInstance' -and
            $_.Message.IndexOf($caminhoExe, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        Sort-Object TimeCreated -Descending)
    if ($eventos.Count -eq 0) { Write-InstallLog 'Retomada recusada: não encontrou no log do Windows o registro do serviço Firebird atual.'; return $false }
    $evento = $eventos[0]
    $nomeSetup = [System.IO.Path]::GetFileName($InstallerPath)
    $logsSetup = @(Get-SetupLogDirectories | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Filter 'Setup Log *.txt' -File -ErrorAction SilentlyContinue
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 24)
    $instalacaoComprovada = $false
    foreach ($arquivoLog in $logsSetup) {
        if ([Math]::Abs(($arquivoLog.LastWriteTime - $evento.TimeCreated).TotalMinutes) -gt 10) { continue }
        try {
            $conteudo = [System.IO.File]::ReadAllText($arquivoLog.FullName)
            if ($conteudo -match ('(?im)^.*Original Setup EXE:.*' + [regex]::Escape($nomeSetup)) -and
                $conteudo -match '(?i)Installation process succeeded\.') {
                $instalacaoComprovada = $true
                break
            }
        } catch { }
    }
    if (-not $instalacaoComprovada) {
        Write-InstallLog ("Retomada recusada: nenhum log confirmou instalação recente do pacote Firebird {0} ligada ao serviço registrado." -f $nomeSetup)
        return $false
    }
    Write-InstallLog 'Confirmou pacote Firebird, evento de registro do serviço e ausência de banco/configuração ativa; a recuperação controlada pode prosseguir.'
    return $true
}

function Test-LatestFirebirdAuthenticationFailure {
    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { return $false }
    $linhas = @(Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue | Select-Object -Last 200)
    $falhaAuth = -1
    $sucesso = -1
    for ($i = 0; $i -lt $linhas.Count; $i++) {
        if ($linhas[$i] -match 'SQLSTATE\s*=\s*28000' -and $linhas[$i] -match 'password|user name') { $falhaAuth = $i }
        if ($linhas[$i] -match 'Servidor Firebird, esquema e configuração protegida concluídos com sucesso') { $sucesso = $i }
    }
    return ($falhaAuth -gt $sucesso)
}

function Get-RecoverableSysdbaPassword {
    $estadoProtegido = $null
    foreach ($statePath in @($StatePath, $LegacyStatePath)) {
      if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try {
            $protegido = [Convert]::FromBase64String([System.IO.File]::ReadAllText($statePath, [System.Text.Encoding]::ASCII).Trim())
            $escopo = if ($statePath -eq $StatePath) { [System.Security.Cryptography.DataProtectionScope]::LocalMachine } else { [System.Security.Cryptography.DataProtectionScope]::CurrentUser }
            $claro = [System.Security.Cryptography.ProtectedData]::Unprotect($protegido, $null, $escopo)
            $texto = [System.Text.Encoding]::UTF8.GetString($claro)
            try {
                $estado = $texto | ConvertFrom-Json -ErrorAction Stop
                if ($estado.sysdbaPassword -match '^[A-Fa-f0-9]{64}$') { $estadoProtegido = $estado; break }
            } catch { }
            if ($texto -match '^[A-Fa-f0-9]{64}$') {
                $estadoProtegido = [pscustomobject]@{ sysdbaPassword = $texto; senhaAplicacao = ''; senhaBackup = ''; bancoPronto = $false }
                break
            }
        } catch { Write-InstallLog 'O estado protegido existente não pôde ser aberto; verificando recuperação pela instalação recém-concluída.' }
      }
    }

    # Recuperação restrita ao caso em que esta instalação acabou de instalar o
    # serviço, mas parou antes de criar a base. O log Inno é local ao usuário;
    # a senha permanece somente em memória e não é copiada para o log do app.
    try {
        $script:FirebirdInstallDirectory = Get-FirebirdInstallDirectory
    } catch {
        Write-InstallLog ("Não foi possível obter a pasta do Firebird pelo serviço: {0}" -f $_.Exception.Message)
        return $null
    }
    $securityDb = Join-Path $script:FirebirdInstallDirectory 'security5.fdb'
    if (-not (Test-Path -LiteralPath $securityDb) -or
        (Get-Item -LiteralPath $securityDb).LastWriteTime -lt (Get-Date).AddHours(-2)) {
        Write-InstallLog 'A recuperação pela instalação recente não se aplica: os arquivos do Firebird não correspondem a uma preparação incompleta recente.'
        return $null
    }

    $nomeSetup = [System.IO.Path]::GetFileName($InstallerPath)
    $logsSetup = @(Get-SetupLogDirectories | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Filter 'Setup Log *.txt' -File -ErrorAction SilentlyContinue
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 24)
    Write-InstallLog ("Procurando o log da instalação Firebird recente em {0}; arquivos de log candidatos: {1}." -f ((Get-SetupLogDirectories) -join ', '), $logsSetup.Count)
    foreach ($arquivoLog in $logsSetup) {
        try {
            $conteudo = [System.IO.File]::ReadAllText($arquivoLog.FullName)
            if ($conteudo -notmatch ('(?im)^.*Original Setup EXE:.*' + [regex]::Escape($nomeSetup)) -or
                $conteudo -notmatch '(?i)Installation process succeeded\.') { continue }
            if ([Math]::Abs(((Get-Item -LiteralPath $securityDb).LastWriteTime - $arquivoLog.LastWriteTime).TotalMinutes) -gt 10) { continue }
            $comando = [regex]::Match($conteudo, '(?im)^.*Setup command line:.*?/SYSDBAPASSWORD="?([^"\s]+)')
            if ($comando.Success -and $comando.Groups[1].Value -match '^[A-Fa-f0-9]{64}$') {
                $script:LogSetupRecuperacao = $arquivoLog.FullName
                $senhaRecuperada = $comando.Groups[1].Value
                if ($estadoProtegido) {
                    if ($estadoProtegido.sysdbaPassword -ine $senhaRecuperada) {
                        Write-InstallLog 'O estado protegido divergia da senha registrada pelo instalador Firebird; corrigindo o estado de retomada.'
                        $estadoProtegido.sysdbaPassword = $senhaRecuperada
                        $estadoProtegido.senhaAplicacao = ''
                        $estadoProtegido.senhaBackup = ''
                        $estadoProtegido.bancoPronto = $false
                        Save-InstallState $estadoProtegido
                    }
                    Write-InstallLog 'Validou a credencial do estado protegido com o log da instalação Firebird recente.'
                    return $estadoProtegido
                }
                Write-InstallLog 'Recuperou a credencial da instalação Firebird recém-concluída para continuar a preparação do Gestor Fácil.'
                return [pscustomobject]@{ sysdbaPassword = $senhaRecuperada; senhaAplicacao = ''; senhaBackup = ''; bancoPronto = $false }
            }
            Write-InstallLog ("O log recente {0} corresponde ao pacote, mas não contém um formato seguro de credencial para retomada." -f $arquivoLog.Name)
        } catch { }
    }
    return $estadoProtegido
}

function Save-InstallState($Estado) {
    $json = $Estado | ConvertTo-Json -Compress
    $protegido = [System.Security.Cryptography.ProtectedData]::Protect(
        [System.Text.Encoding]::UTF8.GetBytes($json), $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    [System.IO.File]::WriteAllText($StatePath, [Convert]::ToBase64String($protegido), [System.Text.Encoding]::ASCII)
    $acl = Get-Acl -LiteralPath $StatePath
    $acl.SetAccessRuleProtection($true, $false)
    $administradores = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $sistema = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $regraAdministradores = [System.Security.AccessControl.FileSystemAccessRule]::new($administradores, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
    $regraSistema = [System.Security.AccessControl.FileSystemAccessRule]::new($sistema, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.SetAccessRule($regraAdministradores)
    $acl.SetAccessRule($regraSistema)
    Set-Acl -LiteralPath $StatePath -AclObject $acl
}

function Remove-SetupCredentialLogs([string]$Senha) {
    $nomeSetup = [System.IO.Path]::GetFileName($InstallerPath)
    Get-SetupLogDirectories | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Filter 'Setup Log *.txt' -File -ErrorAction SilentlyContinue
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 24 | ForEach-Object {
            try {
                $conteudo = [System.IO.File]::ReadAllText($_.FullName)
                if ($conteudo -match ('(?im)^.*Original Setup EXE:.*' + [regex]::Escape($nomeSetup)) -and
                    $conteudo.Contains($Senha)) {
                    Remove-Item -LiteralPath $_.FullName -Force
                }
            } catch { Write-InstallLog 'Não foi possível remover um log temporário do instalador Firebird que continha a senha administrativa.' }
        }
}

function New-RandomSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '')
}

try {
    $EtapaAtual = 'verificação dos arquivos do pacote'
    Write-InstallLog ("Iniciando preparação do servidor Firebird; versão do Gestor Fácil: {0}." -f $AppVersion)
    Add-Type -AssemblyName System.Security
    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw 'O instalador Firebird não foi encontrado no pacote.' }
    if (-not (Test-Path -LiteralPath $SchemaPath -PathType Leaf)) { throw 'O esquema Firebird do Gestor Fácil não foi encontrado no pacote.' }

    New-Item -ItemType Directory -Path $AppDataPath -Force | Out-Null
    $servicosExistentes = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'FirebirdServer*' })
    if ($servicosExistentes.Count -gt 0) {
        $EtapaAtual = 'retomada de um serviço Firebird já instalado'
        $estadoInstalacao = Get-RecoverableSysdbaPassword
        if ($estadoInstalacao -and (Test-LatestFirebirdAuthenticationFailure)) {
            Write-InstallLog 'A retomada anterior comprovou senha SYSDBA inválida; verificará se o serviço e a base de segurança pertencem à instalação incompleta recém-criada.'
            $estadoInstalacao = $null
        }
        if (-not $estadoInstalacao) {
            $script:FirebirdInstallDirectory = Get-FirebirdInstallDirectory
            $databaseAlvo = Join-Path $DatabaseDirectory 'gestor-facil.fdb'
            $configAlvos = @(
                (Join-Path $MachineConfigPath 'firebird-config.dpapi'),
                (Join-Path $AppDataPath 'firebird-config.dpapi')
            ) | Select-Object -Unique
            $configAlvo = $configAlvos | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
            if (-not $configAlvo) { $configAlvo = Join-Path $MachineConfigPath 'firebird-config.dpapi' }
            if (-not (Test-RecentEmptyFirebirdInstall $script:FirebirdInstallDirectory $databaseAlvo $configAlvo)) {
                throw 'Este computador possui um serviço Firebird sem estado recuperável. Não foi possível comprovar que ele pertence a uma instalação recente e vazia do Gestor Fácil; o serviço foi preservado.'
            }

            $EtapaAtual = 'recriação segura do serviço Firebird incompleto'
            Write-InstallLog 'Confirmou uma instalação Firebird recém-criada, sem banco do Gestor Fácil nem outros bancos na pasta do serviço; vai recriar somente essa instalação vazia.'
            $sysdbaPassword = New-RandomSecret
            $estadoInstalacao = [pscustomobject]@{ sysdbaPassword = $sysdbaPassword; senhaAplicacao = ''; senhaBackup = ''; bancoPronto = $false }
            $pastaPreservacao = Join-Path $env:ProgramData 'GestorFacil\Backups'
            New-Item -ItemType Directory -Path $pastaPreservacao -Force | Out-Null
            if (Test-Path -LiteralPath $configAlvo -PathType Leaf) {
                $configPreservada = Join-Path $pastaPreservacao ('firebird-config-incompleto-{0}.dpapi' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
                Copy-Item -LiteralPath $configAlvo -Destination $configPreservada -ErrorAction Stop
                Write-InstallLog ("Preservou a configuração Firebird anterior em {0}." -f $configPreservada)
            }
            $securityDb = Join-Path $script:FirebirdInstallDirectory 'security5.fdb'
            if (Test-Path -LiteralPath $securityDb -PathType Leaf) {
                $EtapaAtual = 'preservação da base de segurança Firebird incompleta'
                Stop-Service -Name 'FirebirdServerDefaultInstance' -Force -ErrorAction Stop
                (Get-Service -Name 'FirebirdServerDefaultInstance').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
                $securityPreservada = Join-Path $pastaPreservacao ('security5-incompleto-{0}.fdb' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
                Move-Item -LiteralPath $securityDb -Destination $securityPreservada -ErrorAction Stop
                Write-InstallLog ("Preservou a base de segurança Firebird incompleta em {0}." -f $securityPreservada)
            }
            $uninstaller = Join-Path $script:FirebirdInstallDirectory 'unins000.exe'
            $processoRemocao = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLEAN') -Wait -PassThru
            Write-InstallLog "A remoção da instalação vazia do Firebird terminou com código $($processoRemocao.ExitCode)."
            if (Get-Service -Name 'FirebirdServerDefaultInstance' -ErrorAction SilentlyContinue) {
                throw 'O serviço Firebird não foi removido pelo desinstalador; nenhuma nova instalação foi iniciada.'
            }

            Save-InstallState $estadoInstalacao
            $EtapaAtual = 'reinstalação protegida do serviço Firebird'
            $argumentos = @(
                '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
                "/SYSDBAPASSWORD=$sysdbaPassword",
                '/MERGETASKS=UseSuperServerTask,UseServiceTask,AutoStartTask'
            )
            $processoInstalador = Start-Process -FilePath $InstallerPath -ArgumentList $argumentos -Wait -PassThru
            Write-InstallLog "O instalador Firebird terminou com código $($processoInstalador.ExitCode)."
            if ($processoInstalador.ExitCode -ne 0 -and -not (Get-Service -Name 'FirebirdServerDefaultInstance' -ErrorAction SilentlyContinue)) {
                throw "O instalador do Firebird terminou com código $($processoInstalador.ExitCode)."
            }
            $script:FirebirdInstallDirectory = $null
        } else {
            $sysdbaPassword = [string]$estadoInstalacao.sysdbaPassword
            Write-InstallLog 'Encontrou uma instalação Firebird incompleta do Gestor Fácil e retomará a criação sem reinstalar o serviço.'
        }
    } else {
        $EtapaAtual = 'preparação das credenciais temporárias'
        $sysdbaPassword = New-RandomSecret
        $estadoInstalacao = [pscustomobject]@{ sysdbaPassword = $sysdbaPassword; senhaAplicacao = ''; senhaBackup = ''; bancoPronto = $false }
        Save-InstallState $estadoInstalacao

        $EtapaAtual = 'instalação do serviço Firebird'
        Write-InstallLog 'Executando o instalador oficial do Firebird em modo silencioso.'
        $argumentos = @(
            '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
            "/SYSDBAPASSWORD=$sysdbaPassword",
            '/MERGETASKS=UseSuperServerTask,UseServiceTask,AutoStartTask'
        )
        $processoInstalador = Start-Process -FilePath $InstallerPath -ArgumentList $argumentos -Wait -PassThru
        Write-InstallLog "O instalador Firebird terminou com código $($processoInstalador.ExitCode)."
        if ($processoInstalador.ExitCode -ne 0) {
            $servicoParcial = Get-Service -Name 'FirebirdServerDefaultInstance' -ErrorAction SilentlyContinue
            if (-not $servicoParcial) { throw "O instalador do Firebird terminou com código $($processoInstalador.ExitCode)." }
            Write-InstallLog 'O serviço foi registrado apesar do código de saída; a rotina retomará a preparação em vez de descartar o estado protegido.'
        }
    }

    if (-not $estadoInstalacao.senhaAplicacao) { $estadoInstalacao.senhaAplicacao = New-RandomSecret }
    if (-not $estadoInstalacao.senhaBackup) { $estadoInstalacao.senhaBackup = New-RandomSecret }
    $senhaAplicacao = [string]$estadoInstalacao.senhaAplicacao
    $senhaBackup = [string]$estadoInstalacao.senhaBackup
    Save-InstallState $estadoInstalacao

    $EtapaAtual = 'inicialização do serviço Firebird'
    $servico = Get-Service -Name 'FirebirdServerDefaultInstance' -ErrorAction Stop
    if ($servico.Status -ne 'Running') {
        Start-Service -Name $servico.Name
        $servico.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }

    $EtapaAtual = 'localização das ferramentas Firebird'
    if (-not $script:FirebirdInstallDirectory) { $script:FirebirdInstallDirectory = Get-FirebirdInstallDirectory }
    $isql = Join-Path $script:FirebirdInstallDirectory 'isql.exe'
    if (-not (Test-Path -LiteralPath $isql -PathType Leaf)) { throw 'O Firebird foi instalado, mas a ferramenta isql.exe não foi encontrada.' }

    $EtapaAtual = 'preparação das pastas de dados e backup'
    New-Item -ItemType Directory -Path $DatabaseDirectory -Force | Out-Null
    $BackupDirectory = Join-Path (Split-Path -Parent $DatabaseDirectory) 'Backups'
    New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $AppDataPath -Force | Out-Null
    New-Item -ItemType Directory -Path $MachineConfigPath -Force | Out-Null
    $servicoInfo = Get-CimInstance Win32_Service -Filter "Name='FirebirdServerDefaultInstance'"
    $contaServico = switch -Regex ([string]$servicoInfo.StartName) {
        '^LocalSystem$' { 'NT AUTHORITY\SYSTEM'; break }
        '^NT AUTHORITY\\LocalService$' { 'NT AUTHORITY\LOCAL SERVICE'; break }
        '^NT AUTHORITY\\NetworkService$' { 'NT AUTHORITY\NETWORK SERVICE'; break }
        default { [string]$servicoInfo.StartName }
    }
    $contasPermitidas = @("$env:USERDOMAIN\$env:USERNAME", $contaServico) | Select-Object -Unique
    foreach ($conta in $contasPermitidas) {
        $regraAcesso = '{0}:(OI)(CI)M' -f $conta
        & icacls.exe $BackupDirectory /grant $regraAcesso | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Não foi possível conceder acesso seguro à pasta de backup para $conta." }
    }
    $databasePath = Join-Path $DatabaseDirectory 'gestor-facil.fdb'
    if ($estadoInstalacao.bancoPronto -and -not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
        throw 'O estado de retomada informa que a base já deveria existir, mas o arquivo não foi encontrado. A instalação foi interrompida para preservar os dados.'
    }
    if ((Test-Path -LiteralPath $databasePath) -and -not $estadoInstalacao.bancoPronto) {
        $incompleto = "$databasePath.incompleto-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Move-Item -LiteralPath $databasePath -Destination $incompleto
        Write-InstallLog "Preservou o arquivo de uma criação interrompida como $incompleto antes de recomeçar o esquema."
    }

    if (-not $estadoInstalacao.bancoPronto) {
        $EtapaAtual = 'criação e configuração do banco central'
        $sqlTemporario = Join-Path ([System.IO.Path]::GetTempPath()) ("gestor-facil-firebird-{0}.sql" -f [guid]::NewGuid().ToString('N'))
        $saidaTemporaria = Join-Path ([System.IO.Path]::GetTempPath()) ("gestor-facil-firebird-{0}.stdout.log" -f [guid]::NewGuid().ToString('N'))
        $erroTemporario = Join-Path ([System.IO.Path]::GetTempPath()) ("gestor-facil-firebird-{0}.stderr.log" -f [guid]::NewGuid().ToString('N'))
        try {
            $databaseSql = $databasePath.Replace("'", "''")
            $schema = [System.IO.File]::ReadAllText($SchemaPath, [System.Text.Encoding]::UTF8)
            $tabelas = @(
                'produtos', 'clientes', 'vendas', 'itens_venda', 'ordens_servico', 'itens_os',
                'garantias', 'garantia_itens', 'usuarios', 'permissoes_usuarios',
                'movimentacoes_estoque', 'auditoria'
            )
            $grants = ($tabelas | ForEach-Object { "GRANT SELECT, INSERT, UPDATE, DELETE ON $_ TO GESTOR_APP;" }) -join "`r`n"
            $sql = @"
SET BAIL ON;
SET SQL DIALECT 3;
CREATE DATABASE 'localhost:$databaseSql' USER 'SYSDBA' PASSWORD '$sysdbaPassword' DEFAULT CHARACTER SET UTF8;
$schema
CREATE USER GESTOR_APP PASSWORD '$senhaAplicacao' USING PLUGIN Srp;
CREATE USER GESTOR_BACKUP PASSWORD '$senhaBackup' USING PLUGIN Srp;
GRANT RDB`$ADMIN TO GESTOR_BACKUP;
$grants
GRANT SELECT, UPDATE ON configuracao_sistema TO GESTOR_APP;
COMMIT;
EXIT;
"@
            [System.IO.File]::WriteAllText($sqlTemporario, $sql, [System.Text.UTF8Encoding]::new($false))
            $processoIsql = Start-Process -FilePath $isql -ArgumentList @('-b', '-i', ('"{0}"' -f $sqlTemporario)) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $saidaTemporaria -RedirectStandardError $erroTemporario
            $codigoIsql = $processoIsql.ExitCode
            $saida = @((Get-Content -LiteralPath $saidaTemporaria -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath $erroTemporario -ErrorAction SilentlyContinue))
            if ($codigoIsql -ne 0) {
                $saidaSanitizada = ($saida -join ' ') -replace [regex]::Escape($sysdbaPassword), '[REDACTED]' -replace [regex]::Escape($senhaAplicacao), '[REDACTED]' -replace [regex]::Escape($senhaBackup), '[REDACTED]'
                Write-InstallLog ("isql encerrou com código {0}: {1}" -f $codigoIsql, $saidaSanitizada)
                throw "Não foi possível criar a base/esquema Firebird (isql $codigoIsql). $saidaSanitizada"
            }
            $estadoInstalacao.bancoPronto = $true
            Save-InstallState $estadoInstalacao
        } finally {
            Remove-Item -LiteralPath $sqlTemporario -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $saidaTemporaria -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $erroTemporario -Force -ErrorAction SilentlyContinue
        }
    }

    $EtapaAtual = 'configuração do firewall privado'
    if (-not (Get-NetFirewallRule -Name 'GestorFacil-Firebird-TCP' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'GestorFacil-Firebird-TCP' -DisplayName 'Gestor Fácil - Firebird na rede privada' -Direction Inbound -Protocol TCP -LocalPort 3050 -Profile Private -Action Allow | Out-Null
    }
    if (-not (Get-NetFirewallRule -Name 'GestorFacil-Firebird-Descoberta-UDP' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'GestorFacil-Firebird-Descoberta-UDP' -DisplayName 'Gestor Fácil - descoberta local' -Direction Inbound -Protocol UDP -LocalPort 45876 -Profile Private -Action Allow | Out-Null
    }
    if (-not (Get-NetFirewallRule -Name 'GestorFacil-Firebird-Pareamento-TCP' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'GestorFacil-Firebird-Pareamento-TCP' -DisplayName 'Gestor Fácil - pareamento local' -Direction Inbound -Protocol TCP -LocalPort 45877 -Profile Private -Action Allow | Out-Null
    }

    $EtapaAtual = 'proteção da configuração local do Firebird'
    Add-Type -AssemblyName System.Security
    $config = [ordered]@{
        versao = 1
        host = '127.0.0.1'
        port = 3050
        database = $databasePath
        user = 'GESTOR_APP'
        password = $senhaAplicacao
        backupUser = 'GESTOR_BACKUP'
        backupPassword = $senhaBackup
        papel = 'servidor'
        serverId = [guid]::NewGuid().ToString()
        anunciar = $true
    }
    $bytesConfig = [System.Text.Encoding]::UTF8.GetBytes(($config | ConvertTo-Json -Compress))
    $protegido = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytesConfig,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    $arquivoConfiguracao = Join-Path $MachineConfigPath 'firebird-config.dpapi'
    [System.IO.File]::WriteAllText(
        $arquivoConfiguracao,
        [Convert]::ToBase64String($protegido),
        [System.Text.Encoding]::ASCII
    )

    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $LegacyStatePath -Force -ErrorAction SilentlyContinue
    Remove-SetupCredentialLogs $sysdbaPassword
    Write-InstallLog ("Configuração Firebird protegida gravada em {0}." -f $arquivoConfiguracao)
    Write-InstallLog 'Servidor Firebird, esquema e configuração protegida concluídos com sucesso.'
    Write-Output 'Servidor Firebird e base inicial do Gestor Fácil preparados.'
    exit 0
} catch {
    try { Write-InstallLog ("FALHA na etapa '$EtapaAtual': $($_.Exception.Message)") } catch {}
    Write-Error "Falha na etapa '$EtapaAtual'. Consulte o log: $LogPath. $($_.Exception.Message)" -ErrorAction Continue
    exit 1
}
