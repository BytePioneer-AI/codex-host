/** Local-only measurements for comparing browser UI density. */
import css from "./ui-metrics.module.css";

/** Show on Web startup; closing or disposing releases all sampling. */
export function installUiMetrics(document: Document): () => void {
  const browser = document.defaultView;
  if (browser === null || "dshDesktop" in browser || "dshDesktopBoot" in browser) return () => {};

  const panel = document.createElement("section");
  panel.className = css.panel ?? "";
  panel.setAttribute("aria-label", "界面尺寸诊断 / UI metrics");
  const header = document.createElement("div");
  header.className = css.header ?? "";
  const title = document.createElement("strong");
  title.textContent = "UI 尺寸 · 本地实时";
  const position = document.createElement("button");
  position.type = "button";
  position.textContent = "移到底部";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  const output = document.createElement("pre");
  output.className = css.output ?? "";
  header.append(title, position, close);
  panel.append(header, output);
  document.body.append(panel);

  const number = (value: number | undefined) =>
    value === undefined ? "—" : String(Math.round(value * 100) / 100);
  const size = (width: number, height: number) => `${number(width)}×${number(height)}`;
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return (
      !element.closest('[hidden], [aria-hidden="true"]') &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < browser.innerHeight &&
      rect.left < browser.innerWidth &&
      browser.getComputedStyle(element).visibility === "visible"
    );
  };
  const find = (selector: string) =>
    [...document.querySelectorAll<HTMLElement>(selector)].find(visible);
  const box = (element: HTMLElement | undefined) => {
    if (element === undefined) return "未显示";
    const rect = element.getBoundingClientRect();
    return `${size(rect.width, rect.height)} / ${size(element.offsetWidth, element.offsetHeight)}`;
  };
  const font = (element: HTMLElement | undefined) => {
    if (element === undefined) return "未显示";
    const style = browser.getComputedStyle(element);
    return `${style.fontSize}/${style.lineHeight}`;
  };
  const sample = () => {
    if (document.hidden) return;
    const root = document.documentElement;
    const style = browser.getComputedStyle(root);
    const bodyStyle = browser.getComputedStyle(document.body);
    const viewport = browser.visualViewport;
    const hero = find("[data-hero-title]");
    const sessionTitle = find("[data-phone-drawer] [data-session-title]");
    const row = sessionTitle?.closest<HTMLElement>("[data-row-key]") ?? undefined;
    const toolbar = find("[data-composer-toolbar]");
    const toolbarStyle = toolbar === undefined ? undefined : browser.getComputedStyle(toolbar);
    const buttons =
      toolbar === undefined
        ? []
        : [...toolbar.querySelectorAll<HTMLButtonElement>("button")].filter(visible);
    const add = buttons.find((button) => button.closest("[data-composer-tools]"));
    const send = buttons.at(-1);
    const centers = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return number(rect.top + rect.height / 2);
    });
    const adjust =
      style.getPropertyValue("text-size-adjust") ||
      style.getPropertyValue("-webkit-text-size-adjust") ||
      "未报告";
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const text = [
      `布局 ${size(root.clientWidth, root.clientHeight)} · inner ${size(browser.innerWidth, browser.innerHeight)}`,
      `可视 ${viewport ? size(viewport.width, viewport.height) : "不支持"} · scale ${number(viewport?.scale)}`,
      `screen ${size(browser.screen.width, browser.screen.height)} · DPR ${number(browser.devicePixelRatio)}`,
      `根字 ${style.fontSize} · zoom 根/体 ${style.getPropertyValue("zoom") || "未报告"}/${bodyStyle.getPropertyValue("zoom") || "未报告"}`,
      `text-size-adjust ${adjust}`,
      `首页字 ${font(hero)} · 行标题字 ${font(sessionTitle)}`,
      `侧栏行 ${box(row)}`,
      `输入卡 ${box(find("[data-composer-card]"))}`,
      `工具栏 ${box(toolbar)} · ${toolbarStyle?.flexWrap ?? "—"}`,
      `＋ ${box(add)} · 末按钮 ${box(send)}`,
      `按钮 ${buttons.length} · 中心Y ${centers.join(",") || "—"}`,
      `viewport: ${viewportMeta?.content ?? "未设置"}`,
      `UA: ${browser.navigator.userAgent}`,
      "尺寸：矩形/布局盒，单位CSS px（非物理px）。",
      "系统显示/字体大小、站点Zoom：网页无法可靠读取。",
    ].join("\n");
    if (output.textContent !== text) output.textContent = text;
  };
  position.onclick = () => {
    const bottom = panel.toggleAttribute("data-bottom");
    position.textContent = bottom ? "移到顶部" : "移到底部";
  };
  const timer = browser.setInterval(sample, 1000);
  browser.addEventListener("resize", sample);
  browser.visualViewport?.addEventListener("resize", sample);
  document.addEventListener("visibilitychange", sample);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    browser.clearInterval(timer);
    browser.removeEventListener("resize", sample);
    browser.visualViewport?.removeEventListener("resize", sample);
    document.removeEventListener("visibilitychange", sample);
    position.onclick = null;
    close.onclick = null;
    panel.remove();
  };
  close.onclick = dispose;
  sample();
  return dispose;
}
