import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installOverlayThreadIsolation } from "./renderer-overlay-thread-isolation.js";

// Document-start: do not wait for body. Voice constructs clientOwnsCall during start.
installCpaLiveVoiceHook();
installOverlayThreadIsolation();
