import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";

// Document-start: do not wait for body. Voice constructs clientOwnsCall during start.
installCpaLiveVoiceHook();
