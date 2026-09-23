/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/shimmer-elements.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * Adapted by codexhost: attribution pointer updated; see ../../NOTICE.md for license and provenance.
 */
"use client";

import { Shimmer } from "@/components/ai-elements/shimmer";

const Example = () => (
  <div className="flex flex-col gap-6 p-8">
    <div className="text-center">
      <p className="mb-3 text-muted-foreground text-sm">As paragraph (default)</p>
      <Shimmer as="p">This is rendered as a paragraph</Shimmer>
    </div>

    <div className="text-center">
      <p className="mb-3 text-muted-foreground text-sm">As heading</p>
      <Shimmer as="h2" className="font-bold text-2xl">
        Large Heading with Shimmer
      </Shimmer>
    </div>

    <div className="text-center">
      <p className="mb-3 text-muted-foreground text-sm">As span (inline)</p>
      <div>
        Processing your request{" "}
        <Shimmer as="span" className="inline">
          with AI magic
        </Shimmer>
        ...
      </div>
    </div>

    <div className="text-center">
      <p className="mb-3 text-muted-foreground text-sm">As div with custom styling</p>
      <Shimmer as="div" className="font-semibold text-lg">
        Custom styled shimmer text
      </Shimmer>
    </div>
  </div>
);

export default Example;
