import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installClientOwnedVoiceHook } from "./renderer-client-owned-voice.js";
import { installOverlayThreadIsolation } from "./renderer-overlay-thread-isolation.js";

// Document-start: do not wait for body. Voice constructs clientOwnsCall during start.
installCpaLiveVoiceHook();
installClientOwnedVoiceHook();
installOverlayThreadIsolation();
