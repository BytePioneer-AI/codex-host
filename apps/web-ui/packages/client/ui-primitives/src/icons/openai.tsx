/**
 * Public OpenAI SVG artwork for the Codex-style navigation surfaces.
 * Source: @openai/apps-sdk-ui 0.2.2, MIT, Copyright 2025 OpenAI.
 * License: apps/web-ui/OPENAI_ICONS_LICENSE.txt.
 * This is the public icon family, not an extraction of private Desktop assets.
 */
import type { IconProps } from "./props.ts";
import { openaiGlyphs } from "./openai-glyphs.ts";

function icon(name: keyof typeof openaiGlyphs) {
  const glyph = openaiGlyphs[name];
  const paths = glyph.paths.map((path, index) => <path key={index} {...path} />);
  return function OpenAIIcon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={glyph.viewBox}
        className={className}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        data-openai-icon={name}
      >
        {paths}
      </svg>
    );
  };
}

export const OpenAIArchiveIcon = icon("Archive");
export const OpenAIBranchIcon = icon("Branch");
export const OpenAICaretRightIcon = icon("CaretRight");
export const OpenAISortIcon = icon("ChevronUpDown");
export const OpenAIClockIcon = icon("Clock");
export const OpenAINewChatIcon = icon("ComposeEditSquare");
export const OpenAIMoreIcon = icon("DotsHorizontal");
export const OpenAIDownloadIcon = icon("Download");
export const OpenAIEditIcon = icon("Edit");
export const OpenAIEyeIcon = icon("Eye");
export const OpenAIEyeOffIcon = icon("EyeClosed");
export const OpenAIFolderIcon = icon("Folder");
export const OpenAIFolderAddIcon = icon("FolderPlus");
export const OpenAIFoldersIcon = icon("Folders");
export const OpenAIListIcon = icon("Menu");
export const OpenAIPinIcon = icon("Pin");
export const OpenAIPinFilledIcon = icon("PinFilled");
export const OpenAIPlusIcon = icon("Plus");
export const OpenAISearchIcon = icon("Search");
export const OpenAISettingsIcon = icon("SettingsCog");
export const OpenAIViewOptionsIcon = icon("SettingsSlider");
export const OpenAISidebarIcon = icon("SidebarLeft");
export const OpenAITrashIcon = icon("Trash");
export const OpenAIUnarchiveIcon = icon("Unarchive");
export const OpenAICloseIcon = icon("X");
