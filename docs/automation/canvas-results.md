# Canvas results and camera position

`output.add-to-canvas` (versions 1–3) places results as one group in nearby empty space. Images follow input order from left to right, up to three per row, then continue below. Row heights account for image aspect ratios, card titles, handles and result history. Plan notes occupy a separate column alongside the images, including every part of long plans in version 3.

Connect the original TikTok `source` output to the final node's `source` input:

- **Beside the source** anchors the group beside that source and searches nearby free space if it is occupied.
- **On a new row** starts below that source and its imported slides, rather than below unrelated content elsewhere on the canvas.
- Without a source, results start below existing content. Existing nodes are never moved by placement. Retries keep existing result IDs and positions.

These settings and descriptions are also exposed through the automation MCP capability catalogue. Layout does not generate media or change asset contracts.

Canvas pan and zoom are private to each browser tab and project. Reload restores the saved view before considering an initial fit to nodes. Project switching restores each project's view, including when its graph arrives through collaboration. Movement is saved when it ends and when the page is hidden or unloaded; incoming collaboration updates do not follow another user's camera.
