import { installCpaLiveVoiceHook } from "./renderer-cpa-live-voice-hook.js";
import { installClientOwnedVoiceHook } from "./renderer-client-owned-voice.js";
import { installOverlayExternalFollowUps } from "./renderer-overlay-external-followups.js";
import { installOverlayThreadIsolation } from "./renderer-overlay-thread-isolation.js";
import { installVoiceStartCapabilityHook } from "./renderer-voice-start-capability.js";

// Document-start: do not wait for body. Voice constructs clientOwnsCall during start.
installCpaLiveVoiceHook();
installClientOwnedVoiceHook();
installVoiceStartCapabilityHook();
installOverlayThreadIsolation();
installOverlayExternalFollowUps();
