## 1. Renderer Behavior

- [x] 1.1 Track the most recently submitted Agent in `DraftAgentController` and use it only for newly mounted default Composers.
- [x] 1.2 Record the current Agent from the existing Renderer submission path without changing Thread ownership or prewarm routing.

## 2. Tests

- [x] 2.1 Add focused controller coverage for submitted-Agent inheritance, passive conversation opening, unsubmitted switching, and Model reset.
- [x] 2.2 Run the Renderer Extension focused tests, typecheck, and browser bundle build.

## 3. Baselines

- [x] 3.1 Update the PRD and main `versioned-renderer-agent-routing` spec to define the new in-process default.
- [x] 3.2 Validate the OpenSpec change strictly.
