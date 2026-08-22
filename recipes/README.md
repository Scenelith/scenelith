# Scenelith recipes

Recipes are portable canvas templates in the versioned `.scenelith.json` format. They contain node layout, prompts, model settings, and connections. They never contain generated media, identity assets, account IDs, API keys, or private storage URLs.

Import a recipe through `POST /api/projects/import` or use it as a starting point for your own shared workflow. After import, nodes marked as inputs need media or an identity from the local Scenelith instance.

## Contributing a recipe

1. Export a canvas from `GET /api/projects/{canvasId}/export`.
2. Open the exported JSON and confirm the prompts are safe to publish.
3. Validate it with `npm test`.
4. Add a short explanation to this file when the recipe introduces a new pattern.

Bundled examples:

- `portrait-reference.scenelith.json` — retain a subject while changing composition and lighting.
- `image-to-video.scenelith.json` — animate a still image with a controlled start-frame workflow.
