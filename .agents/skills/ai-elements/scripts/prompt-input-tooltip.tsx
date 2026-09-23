/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/prompt-input-tooltip.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * Adapted by codexhost: attribution pointer updated; see ../../NOTICE.md for license and provenance.
 */
"use client";

import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { GlobeIcon, MicIcon, PaperclipIcon } from "lucide-react";

const handleSubmit = () => {
  // Handle submit
};

const Example = () => (
  <PromptInput onSubmit={handleSubmit}>
    <PromptInputBody>
      <PromptInputTextarea />
    </PromptInputBody>
    <PromptInputFooter>
      <PromptInputTools>
        <PromptInputButton tooltip="Attach files">
          <PaperclipIcon size={16} />
        </PromptInputButton>
        <PromptInputButton tooltip={{ content: "Search the web", shortcut: "⌘K" }}>
          <GlobeIcon size={16} />
        </PromptInputButton>
        <PromptInputButton tooltip={{ content: "Voice input", shortcut: "⌘M", side: "bottom" }}>
          <MicIcon size={16} />
        </PromptInputButton>
      </PromptInputTools>
      <PromptInputSubmit />
    </PromptInputFooter>
  </PromptInput>
);

export default Example;
