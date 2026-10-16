import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installRendererBinding } from "./install-renderer-binding.js";

installCpaLiveVoiceHook();

const installBinding = (): void => {
  installRendererBinding();
};

if (document.documentElement && document.body) {
  installBinding();
} else {
  window.addEventListener("DOMContentLoaded", installBinding, { once: true });
}
