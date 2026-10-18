# Grok generated images in Codex Desktop

Grok Imagine (`image_gen` / `image_edit`) writes a file under the native session `images/` directory and reports ACP `rawOutput.type` `ImageGen` or `ImageEdit` with an absolute `path`.

The Grok Adapter emits a Host `generatedImage` Item with that `savedPath`. Protocol Core projects it to Desktop `imageGeneration` (`item/started` then `item/completed` with `completedAtMs`). Desktop renders the official generated-image gallery.

This is separate from local-media Markdown rewrite (`![](/abs/file)` / backticks), which remains for videos and for agent text that already cites a file.

Do not project Imagine files as `fileChange`. Do not send image base64 through the 64 KB tool-output budget.

Live JPEG gallery display still needs a Desktop session check after this projection.
