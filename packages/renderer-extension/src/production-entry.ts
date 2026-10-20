import { installNativeChatVoiceHook } from "./renderer-native-chat-voice.js";
import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installClientOwnedVoiceHook } from "./renderer-client-owned-voice.js";
import { installRendererBinding } from "./install-renderer-binding.js";
import { installExternalVoiceLaunchHook } from "./renderer-external-voice-launch.js";

installCpaLiveVoiceHook();
installClientOwnedVoiceHook();
installExternalVoiceLaunchHook();
installNativeChatVoiceHook();

const installBinding = (): void => {
  installRendererBinding();
};

if (document.documentElement && document.body) {
  installBinding();
} else {
  window.addEventListener("DOMContentLoaded", installBinding, { once: true });
}
