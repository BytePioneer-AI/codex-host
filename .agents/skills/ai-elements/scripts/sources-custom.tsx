/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/sources-custom.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * Adapted by codexhost: attribution pointer updated; see ../../NOTICE.md for license and provenance.
 */
"use client";

import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";

const sources = [
  { href: "https://stripe.com/docs/api", title: "Stripe API Documentation" },
  { href: "https://docs.github.com/en/rest", title: "GitHub REST API" },
  {
    href: "https://docs.aws.amazon.com/sdk-for-javascript/",
    title: "AWS SDK for JavaScript",
  },
];

const Example = () => (
  <div style={{ height: "110px" }}>
    <Sources>
      <SourcesTrigger count={sources.length}>
        <p className="font-medium">Using {sources.length} citations</p>
        <ChevronDownIcon className="size-4" />
      </SourcesTrigger>
      <SourcesContent>
        {sources.map((source) => (
          <Source href={source.href} key={source.href}>
            {source.title}
            <ExternalLinkIcon className="size-4" />
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  </div>
);

export default Example;
