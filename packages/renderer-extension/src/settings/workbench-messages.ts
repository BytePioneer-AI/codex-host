import type { RendererSettingsLocale } from "./localization.js";

const english = {
  description: "Your knowledge, projects, and conversations in one place.",
  local: "Saved on this computer. Links open only when you choose them.",
  manage: "Manage links",
  add: "Add link",
  save: "Save changes",
  cancel: "Cancel",
  remove: "Remove link",
  name: "Name",
  icon: "Icon",
  url: "Link",
  category: "Category",
  empty: "Keep your everyday destinations close.",
  emptyDetail: "Add a knowledge base, a project board, or a group conversation to get started.",
  loading: "Loading links…",
  saving: "Saving…",
  retry: "Try again",
  failed:
    "Could not load links. Check the local configuration file and its permissions, then try again.",
  saveFailed:
    "Changes were not saved. Your edits are still here; check the local configuration and try again.",
  invalid:
    "Give every link a name, an icon, and a valid HTTP(S) address without embedded credentials.",
  categories: { knowledge: "Knowledge", projects: "Projects", chats: "Conversations" },
};
export function workbenchMessages(locale: RendererSettingsLocale): typeof english {
  if (locale !== "zh-CN") return english;
  return {
    description: "把常用知识库、项目和群聊放在一起。",
    local: "配置保存在这台电脑，仅在点击时打开链接。",
    manage: "管理入口",
    add: "添加入口",
    save: "保存更改",
    cancel: "取消",
    remove: "移除入口",
    name: "名称",
    icon: "图标",
    url: "链接",
    category: "分类",
    empty: "让常用入口触手可及。",
    emptyDetail: "添加知识库、项目看板或群聊，开始使用工作台。",
    loading: "正在加载入口…",
    saving: "正在保存…",
    retry: "重试",
    failed: "无法读取入口。请检查本地配置文件及其权限后重试。",
    saveFailed: "更改未保存，编辑内容仍保留。请检查本地配置后重试。",
    invalid: "请为每个入口填写名称、图标及有效的 HTTP(S) 链接，链接不能包含账号密码。",
    categories: { knowledge: "知识库", projects: "项目", chats: "群聊" },
  };
}
