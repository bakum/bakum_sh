; NSIS installer: Ukrainian is the main language (D70). The installer speaks the language of the app setting
; (`language:` in %APPDATA%\Odoo Branch Manager\app.yaml), Ukrainian when there is none (a fresh install) — not the
; Windows language: NSIS takes that from the regional format, so a Russian format would give Russian.
!ifndef BM_APP_YAML
  !define BM_APP_YAML "$APPDATA\${PRODUCT_NAME}\app.yaml"
!endif

!macro bmPickLanguage
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  !ifdef LANG_UKRAINIAN
    StrCpy $LANGUAGE ${LANG_UKRAINIAN}
  !endif
  ClearErrors
  FileOpen $R0 "${BM_APP_YAML}" r
  IfErrors bmLangDone
  bmLangLine:
    ClearErrors
    FileRead $R0 $R1
    IfErrors bmLangClose
    StrCpy $R2 $R1 9
    StrCmp $R2 "language:" 0 bmLangLine
    StrCpy $R1 $R1 "" 9
    ; The value: the first two characters after spaces and quotes.
    bmLangSkip:
      StrCpy $R2 $R1 1
      StrCmp $R2 " " +3
      StrCmp $R2 "'" +2
      StrCmp $R2 '"' 0 bmLangValue
      StrCpy $R1 $R1 "" 1
      Goto bmLangSkip
    bmLangValue:
    StrCpy $R3 $R1 2
    !ifdef LANG_RUSSIAN
      StrCmp $R3 "ru" 0 +3
      StrCpy $LANGUAGE ${LANG_RUSSIAN}
      Goto bmLangClose
    !endif
    !ifdef LANG_ENGLISH
      StrCmp $R3 "en" 0 +2
      StrCpy $LANGUAGE ${LANG_ENGLISH}
    !endif
  bmLangClose:
    FileClose $R0
  bmLangDone:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro preInit
  !insertmacro bmPickLanguage
!macroend

!macro customUnInit
  !insertmacro bmPickLanguage
!macroend

; electron-builder's own messages (messages.yml,
; assistedMessages.yml) lack Ukrainian for the install-mode page, the uninstall confirmation and a few progress lines,
; so they would show in English. customHeader is inserted after electron-builder's LangStrings and after the languages
; are loaded (LANG_* exist only for the languages in nsis.installerLanguages); the later definition wins, so warning 6030
; («set multiple times») is expected here.
!macro customHeader
  !pragma warning push
  !pragma warning disable 6030

  !ifdef LANG_UKRAINIAN
    LangString win7Required ${LANG_UKRAINIAN} "Потрібна Windows 7 або новіша"
    LangString x64WinRequired ${LANG_UKRAINIAN} "Потрібна 64-розрядна Windows"
    LangString installing ${LANG_UKRAINIAN} "Встановлення, зачекайте…"
    LangString areYouSureToUninstall ${LANG_UKRAINIAN} "Видалити ${PRODUCT_NAME}?"
    LangString decompressionFailed ${LANG_UKRAINIAN} "Не вдалося розпакувати файли. Спробуйте запустити інсталятор ще раз."
    LangString appClosing ${LANG_UKRAINIAN} "Закриваю запущений ${PRODUCT_NAME}…"

    LangString chooseInstallationOptions ${LANG_UKRAINIAN} "Параметри встановлення"
    LangString chooseUninstallationOptions ${LANG_UKRAINIAN} "Параметри видалення"
    LangString whichInstallationShouldBeRemoved ${LANG_UKRAINIAN} "Яке встановлення видалити?"
    LangString whoShouldThisApplicationBeInstalledFor ${LANG_UKRAINIAN} "Для кого встановити застосунок?"
    LangString selectUserMode ${LANG_UKRAINIAN} "Виберіть, чи буде програма доступна всім користувачам, чи лише вам"
    LangString whichInstallationRemove ${LANG_UKRAINIAN} "Програму встановлено і для всіх користувачів, і для поточного.$\r$\nЯке встановлення видалити?"
    LangString freshInstallForAll ${LANG_UKRAINIAN} "Нове встановлення для всіх користувачів (знадобляться права адміністратора)."
    LangString freshInstallForCurrent ${LANG_UKRAINIAN} "Нове встановлення лише для поточного користувача."
    LangString onlyForMe ${LANG_UKRAINIAN} "Лише для &мене"
    LangString forAll ${LANG_UKRAINIAN} "Для всіх користувачів цього комп’ютера (&усі)"
    LangString loginWithAdminAccount ${LANG_UKRAINIAN} "Щоб продовжити, увійдіть з обліковим записом із групи адміністраторів…"
    LangString perUserInstallExists ${LANG_UKRAINIAN} "Уже є встановлення для поточного користувача."
    LangString perUserInstall ${LANG_UKRAINIAN} "Є встановлення для поточного користувача."
    LangString perMachineInstallExists ${LANG_UKRAINIAN} "Уже є встановлення для всіх користувачів."
    LangString perMachineInstall ${LANG_UKRAINIAN} "Є встановлення для всіх користувачів."
    LangString reinstallUpgrade ${LANG_UKRAINIAN} "Буде перевстановлено / оновлено."
    LangString uninstall ${LANG_UKRAINIAN} "Буде видалено."
  !endif

  !ifdef LANG_RUSSIAN
    LangString appClosing ${LANG_RUSSIAN} "Закрываю запущенный ${PRODUCT_NAME}…"
  !endif

  !pragma warning pop
!macroend
