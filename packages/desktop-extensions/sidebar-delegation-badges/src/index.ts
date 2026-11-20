import type { DesktopExtensionDefine } from "@codexhost/shared-contracts";
import { activate } from "./badges.js";

declare const define: DesktopExtensionDefine;

define({ activate });
