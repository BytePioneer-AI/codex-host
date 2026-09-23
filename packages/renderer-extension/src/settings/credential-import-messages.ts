export const credentialImportEnglish = {
  column: "Use in Harness",
  sectionTitle: "Accounts in Pi",
  sectionEmpty:
    "No logins in Pi yet. Use the Pi mark on a Codex or Grok account above to import one.",
  rowReimport: "Copy again",
  rowRemove: "Remove",
  othersTitle: "Pi's own logins",
  typeOauth: "OAuth",
  typeApiKey: "API Key",
  typeOther: "Other",
  failed:
    "Could not complete the operation. Refresh the page, check the source login and Pi installation, or choose an unused entry name.",
  add: "Import into Pi",
  importedHint: "Pi · {name}/… · Copied",
  entry: "Entry in Pi",
  name: "Model entry name",
  source: "Source account",
  preview: "Creates {name}/… in Pi. Existing Provider configurations remain unchanged.",
  warning:
    "Copies the current authorization once; it does not synchronize logins or add quota. Pi and the original app may refresh the same token, which can require signing in again. Usage follows this Provider's billing rules.",
  confirm: "Confirm import",
  cancel: "Cancel",
  reimport: "Copy authorization again",
  reimportPreview:
    "Replaces only the imported credential for {name}/… using the same source account. Other Pi configurations remain unchanged.",
  remove: "Remove from Pi",
  removeWarning:
    "Remove {name}/… and its imported credential from Pi? The original login and other Pi configurations are not affected. Sessions using this entry may stop working.",
  copied: "Copied",
  invalidName:
    "Use 1–48 lowercase letters, digits or hyphens, starting with a letter. Choose a new, unused name.",
  doneTitle: "Copied to Pi",
  done: "New Pi sessions can use this entry right away; no restart needed. If an already open session does not list it, reopen that session. Copying does not verify model calls; start a Pi session with it to check.",
  close: "Done",
};
export type CredentialImportMessages = typeof credentialImportEnglish;
export const credentialImportChinese: CredentialImportMessages = {
  column: "用于 Harness",
  sectionTitle: "Pi 中的账号",
  sectionEmpty: "Pi 中还没有登录。点击上方 Codex 或 Grok 账号行的 Pi 图标即可导入。",
  rowReimport: "重新导入",
  rowRemove: "移除",
  othersTitle: "Pi 自有配置",
  typeOauth: "OAuth",
  typeApiKey: "API Key",
  typeOther: "其他",
  failed: "操作未完成。请刷新页面，检查来源登录和 Pi 安装，或换一个未使用的入口名称。",
  add: "导入到 Pi",
  importedHint: "Pi · {name}/… · 已复制",
  entry: "Pi 中的入口",
  name: "模型入口名称",
  source: "来源账号",
  preview: "将在 Pi 中新增 {name}/…，保留全部已有 Provider 配置。",
  warning:
    "仅复制当前授权，不持续同步登录，也不增加额度。Pi 与原生工具分别刷新同一凭证时，可能需要重新登录。实际用量遵循该 Provider 的计费规则。",
  confirm: "确认导入",
  cancel: "取消",
  reimport: "重新导入凭证",
  reimportPreview: "使用同一来源账号更新 {name}/… 的导入凭证，不修改其他 Pi 配置。",
  remove: "从 Pi 移除",
  removeWarning:
    "从 Pi 移除 {name}/… 及其导入凭证？不影响来源登录和其他 Pi 配置。使用此入口的会话可能无法继续调用。",
  copied: "已复制",
  invalidName: "请输入 1–48 位小写字母、数字或连字符，以字母开头，并使用未占用的新名称。",
  doneTitle: "已复制到 Pi",
  done: "新开的 Pi 会话即可选用该入口，无需重启。已打开的会话若没有看到，重新打开该会话即可。复制不代表已验证模型调用，可在 Pi 会话中选用该入口检验。",
  close: "完成",
};
