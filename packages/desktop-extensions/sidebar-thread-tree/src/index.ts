import type { DesktopExtensionDefine } from "@codexhost/shared-contracts";
import { activate } from "./sidebar-tree.js";

declare const define: DesktopExtensionDefine;

define({ activate });
