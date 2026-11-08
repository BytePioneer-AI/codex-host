const frame = document.querySelector("#prototype");
let material = "glass";
const notes = {
  thread: [
    "刚才的会话，一点返回。",
    "顶部只保留标题与最近访问两行。左右滑动浏览，点选才切换；项目与分支移到标题打开的选择层。「更多」始终可点。",
  ],
  recents: [
    "找回刚才的上下文。",
    "当前会话显示项目与分支；列表显示完整标题、项目、Harness、草稿与任务状态。按访问顺序排列，可搜索；不是按消息更新时间排序。",
  ],
  "recent-empty": [
    "没有记录，就不占一行。",
    "无访问记录或只有当前会话时，顶部不放空快捷栏。从侧栏打开对话后才加入最近访问；空白的新对话不加入。",
  ],
  threads: [
    "保持单行，状态沿用现有 Web。",
    "会话条目统一 48px，不在标题下添加状态。右侧沿用运行指示器、状态点和待审批 / 待回答短文案；触控端隐藏普通时间。顶部保持搜索、视图选项、添加工作区三个入口。",
  ],
  "sidebar-more": [
    "保留熟悉的三个入口。",
    "搜索、视图选项与添加工作区直接显示。此旧预览链接打开当前侧栏，不再使用合并菜单。",
  ],
  "view-options": [
    "列表怎么显示，由你选择。",
    "分组、最近更新排序与归档筛选都保留，在侧栏内切换，不叠加第二个模态框。只改变示例侧栏，不改变顶部最近访问顺序。",
  ],
  "add-workspace": [
    "选的是 Host 电脑目录。",
    "保留添加工作区与新建对话的流程。此处只有固定目录样本，不读取手机或电脑文件，不创建目录。",
  ],
  composer: [
    "同一个 Composer，更适合触控。",
    "保留附件、权限、模型、Harness 与发送的位置关系。输入区 16 px，控制区 44 px；磨砂底层承接下方滚动内容。",
  ],
  usage: [
    "统计不是可以省略的装饰。",
    "底部保留 CH 缓存命中率、输出速度与费用，点开看含义。所有数值为示例；未提供的字段隐藏，不用 0 代替未知。",
  ],
  context: [
    "上下文占用，独立看清。",
    "圆环显示上下文已用比例，不是账号剩余额度。点开查看用量与容量，缺少容量信息时不展示虚假的百分比。",
  ],
  screenshot: [
    "手机发起，截 Host 电脑。",
    "沿用桌面截图入口。此处只演示静态画面预览、附加到当前草稿和权限失败；不捕获手机或电脑屏幕。",
  ],
  voice: [
    "语音就地输入，不跳到另一页。",
    "录音演示接管工具行；结束填入草稿，发送按钮可明确转写并发送。切换会话或修改草稿后，结果不自动插入。全程不使用麦克风。",
  ],
  "voice-error": [
    "权限失败要能恢复。",
    "演示浏览器麦克风权限错误与重试入口，不触发系统授权。真实功能需要浏览器录音能力以及 Host 的可用转写服务。",
  ],
  approval: [
    "批准留在原来的位置。",
    "沿用 ApprovalPanel 对 Composer 的接管方式，不跳独立页面。命令、目录、拒绝与允许一次都在底部操作区。",
  ],
  question: [
    "会话不动，原位回答。",
    "选择范围在 Composer 区域完成。没有增加另一层全屏流程，也不把问题和权限审批混为一谈。",
  ],
  settings: [
    "保留设置分类，不重组功能。",
    "沿用设置浮层和手机端横向分类。通用、连接设备、连接、账号等仍是原入口；本次只设计窄屏容器与材质。",
  ],
  harness: [
    "保留 Composer 内的 Harness 入口。",
    "Harness 与模型分别选择。新对话可以选择，已有 Thread 中其他 Harness 禁用，不产生跨 Harness 迁移。",
  ],
  new: [
    "还是原来的新对话。",
    "沿用“今天想做点什么？”、工作区选择与 Composer，不加入手机专属任务模板或另一套导航。",
  ],
  empty: [
    "没有工作区，也不另起一页。",
    "空状态仍在新对话中。选择工作区后激活输入，布局与已有入口保持一致。",
  ],
  error: [
    "断线时仍留在当前会话。",
    "连接提示出现在 Composer 上方；草稿依然可见。重试不自动重发，远端任务状态不作推断。",
  ],
  diff: [
    "变更就地展开。",
    "保留会话里的工具 / 代码展示。统一 diff 局部横向滚动，导航和 Composer 不变。",
  ],
  files: [
    "原文件侧栏，窄屏覆盖。",
    "文件区域从右侧打开，不另做手机文件管理器。点文件后在会话中查看示例 diff。",
  ],
};
function select(route) {
  document
    .querySelectorAll("[data-route]")
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.route === route)));
  const note = notes[route] || notes.thread;
  document.querySelector("#note-title").textContent = note[0];
  document.querySelector("#note-copy").textContent = note[1];
  document.querySelector("#direct-link").href = `app.html?material=${material}#${route}`;
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.route) {
    if (matchMedia("(max-width: 700px)").matches) {
      location.href = `app.html?material=${material}#${button.dataset.route}`;
      return;
    }
    frame.src = `app.html?preview=1&material=${material}#${button.dataset.route}`;
    select(button.dataset.route);
  }
  if (button.dataset.width) {
    document.documentElement.style.setProperty("--preview-width", `${button.dataset.width}px`);
    document.querySelector("#viewport-label").textContent = `${button.dataset.width} × 844`;
    document
      .querySelectorAll("[data-width]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  }
  if (button.dataset.material) {
    material = button.dataset.material;
    frame.contentWindow.postMessage({ prototypeMaterial: material }, "*");
    document
      .querySelectorAll("[data-material]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    const link = document.querySelector("#direct-link");
    link.href = `app.html?material=${material}${new URL(link.href).hash}`;
  }
});
window.addEventListener("message", (e) => {
  if (e.source === frame.contentWindow && typeof e.data?.prototypeRoute === "string")
    select(e.data.prototypeRoute);
});
