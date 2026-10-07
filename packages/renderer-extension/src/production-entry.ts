import { installRendererBinding } from "./install-renderer-binding.js";

const install = (): void => {
  installRendererBinding();
};

if (document.documentElement && document.body) {
  install();
} else {
  window.addEventListener("DOMContentLoaded", install, { once: true });
}
