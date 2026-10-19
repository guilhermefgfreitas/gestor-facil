!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!include nsDialogs.nsh
!define GF_ROLE_DIR "$WINDIR\..\ProgramData\GestorFacil"

Var GfInstallRole
Var GfSavedRole
Var GfServerRadio
Var GfClientRadio
Var GfRolePage

Function GfInstallRolePage
  ReadINIStr $GfSavedRole "${GF_ROLE_DIR}\implantacao.ini" "instalacao" "papel"
  StrCpy $GfInstallRole $GfSavedRole

  nsDialogs::Create 1018
  Pop $GfRolePage
  ${If} $GfRolePage == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 34u "Servidor principal: instala o serviço Firebird e mantém a base central da empresa. Escolha esta opção em apenas um computador."
  Pop $0
  ${NSD_CreateRadioButton} 0 42u 100% 16u "Este é o servidor principal da empresa"
  Pop $GfServerRadio
  ${NSD_Uncheck} $GfServerRadio
  ${NSD_CreateLabel} 0 70u 100% 34u "Estação: procura o servidor principal na rede local e usa a base compartilhada."
  Pop $1
  ${NSD_CreateRadioButton} 0 112u 100% 16u "Este computador é uma estação"
  Pop $GfClientRadio
  ${NSD_Uncheck} $GfClientRadio

  ${If} $GfInstallRole == "client"
    ${NSD_Check} $GfClientRadio
  ${ElseIf} $GfInstallRole == "server"
    ${NSD_Check} $GfServerRadio
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function GfInstallRoleLeave
  ${NSD_GetState} $GfServerRadio $0
  ${NSD_GetState} $GfClientRadio $1
  ${If} $0 == ${BST_CHECKED}
    StrCpy $GfInstallRole "server"
  ${ElseIf} $1 == ${BST_CHECKED}
    StrCpy $GfInstallRole "client"
  ${Else}
    MessageBox MB_ICONEXCLAMATION "Selecione se este computador será o servidor principal ou uma estação para continuar."
    Abort
  ${EndIf}

  ${If} $GfSavedRole == "server"
  ${AndIf} $GfInstallRole != "server"
    MessageBox MB_ICONEXCLAMATION "Este computador já está configurado como servidor. A atualização vai preservar esse papel e a base de dados. Para usar uma estação, instale o Gestor Fácil em outro computador."
    Abort
  ${EndIf}
  ${If} $GfSavedRole == "client"
  ${AndIf} $GfInstallRole != "client"
    MessageBox MB_ICONEXCLAMATION "Este computador já está configurado como estação. A atualização vai preservar esse papel. Para configurar um novo servidor, faça a instalação em um computador preparado para hospedar a base."
    Abort
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  Page custom GfInstallRolePage GfInstallRoleLeave
!macroend

!macro customInstall
  ReadINIStr $0 "${GF_ROLE_DIR}\implantacao.ini" "instalacao" "papel"
  ${If} $0 == "server"
    Goto GfInstallRoleExists
  ${EndIf}
  ${If} $0 == "client"
    Goto GfInstallRoleExists
  ${EndIf}
  ${If} $GfInstallRole == "server"
      ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\firebird\instalar-servidor.ps1" -InstallerPath "$INSTDIR\resources\firebird\servidor-setup.exe" -SchemaPath "$INSTDIR\resources\firebird\schema.sql" -AppDataPath "$APPDATA\gestor-facil" -MachineConfigPath "${GF_ROLE_DIR}" -AppVersion "${VERSION}"' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "A preparação automática do servidor Firebird falhou. Os detalhes estão em C:\ProgramData\GestorFacil\logs\firebird-install.log. Reexecute este instalador atualizado para retomar a preparação; o serviço Firebird existente será preservado."
      Abort
    ${EndIf}
  ${EndIf}
  CreateDirectory "${GF_ROLE_DIR}"
  WriteINIStr "${GF_ROLE_DIR}\implantacao.ini" "instalacao" "papel" "$GfInstallRole"
  CreateDirectory "$APPDATA\gestor-facil"
  WriteINIStr "$APPDATA\gestor-facil\implantacao.ini" "instalacao" "papel" "$GfInstallRole"
GfInstallRoleExists:
!macroend
!endif
