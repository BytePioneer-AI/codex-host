<!--
Derived from vercel/ai-elements (skills/ai-elements/references/canvas.md).
Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
Modified by ZCode: local integration, formatting and adaptations.
Adapted by codexhost: attribution pointer updated; see ../../NOTICE.md for license and provenance.
-->

# Canvas

A React Flow-based canvas component for building interactive node-based interfaces.

The `Canvas` component provides a React Flow-based canvas for building interactive node-based interfaces. It comes pre-configured with sensible defaults for AI applications, including panning, zooming, and selection behaviors.

## Installation

```bash
npx ai-elements@latest add canvas
```

## Features

- Pre-configured React Flow canvas with AI-optimized defaults
- Pan on scroll enabled for intuitive navigation
- Selection on drag for multi-node operations
- Customizable background color using CSS variables
- Delete key support (Backspace and Delete keys)
- Auto-fit view to show all nodes
- Disabled double-click zoom for better UX
- Disabled pan on drag to prevent accidental canvas movement
- Fully compatible with React Flow props and API

## Props

### `<Canvas />`

| Prop       | Type             | Default | Description                                                                             |
| ---------- | ---------------- | ------- | --------------------------------------------------------------------------------------- |
| `children` | `ReactNode`      | -       | Child components like Background, Controls, or MiniMap.                                 |
| `...props` | `ReactFlowProps` | -       | Any other React Flow props like nodes, edges, nodeTypes, edgeTypes, onNodesChange, etc. |
