import { installNativeChatVoiceHook } from "./renderer-native-chat-voice.js";
import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installClientOwnedVoiceHook } from "./renderer-client-owned-voice.js";
import { installRendererBinding } from "./install-renderer-binding.js";
import { installExternalVoiceLaunchHook } from "./renderer-external-voice-launch.js";
import { installVoiceCapabilityProjection } from "./renderer-voice-capability.js";
import { installVoiceSettingsExplanation } from "./renderer-voice-settings.js";

installCpaLiveVoiceHook();
installClientOwnedVoiceHook();
installExternalVoiceLaunchHook();
installNativeChatVoiceHook();
installVoiceCapabilityProjection();
installVoiceSettingsExplanation();

const installBinding = (): void => {
  installRendererBinding();
};

if (document.documentElement && document.body) {
  installBinding();
} else {
  window.addEventListener("DOMContentLoaded", installBinding, { once: true });
}
