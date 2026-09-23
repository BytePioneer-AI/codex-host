/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/schema-display-basic.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * Adapted by codexhost: attribution pointer updated; see ../../NOTICE.md for license and provenance.
 */
"use client";

import { SchemaDisplay } from "@/components/ai-elements/schema-display";

const Example = () => <SchemaDisplay description="List all users" method="GET" path="/api/users" />;

export default Example;
