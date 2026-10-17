import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installRendererBinding } from "./install-renderer-binding.js";
import { installExternalVoiceLaunchHook } from "./renderer-external-voice-launch.js";

installCpaLiveVoiceHook();
installExternalVoiceLaunchHook();

const installBinding = (): void => {
  installRendererBinding();
};

if (document.documentElement && document.body) {
  installBinding();
} else {
  window.addEventListener("DOMContentLoaded", installBinding, { once: true });
}
