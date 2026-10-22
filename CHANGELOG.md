# Changelog

## 0.1.5 — 2026-10-22

### Code blocks

- Typing inside a fenced code block in the Split left pane keeps the caret in place. Each keystroke previously sent the caret back to the start of the block, so typed text came out reversed and landed above the opening fence. Indented lines, long wrapped lines, backspace, and IME input all stay anchored.
- Fenced code blocks keep their syntax colors when clicked open for editing in Preview. Previously only YAML and Mermaid kept their colors, and every other language flattened to a single dim gray. Colors now follow the rendered palette in both light and dark themes, update as you type, and cover the full set of languages the renderer highlights rather than just JavaScript, TypeScript, and Python.

### Diagrams and zoom

- Zoomed diagrams stay sharp. Mermaid and Graphviz diagrams remain vectors in the zoom view instead of being flattened into a snapshot, which also fixes the distorted aspect ratio Mermaid showed when opened. ECharts charts are re-exported above display resolution so zooming in reveals detail.

### Document opening

- Switching a Markdown file to the plain text editor no longer snaps back to the visual editor. Reopen Editor With and the equivalent command now keep the editor the user picked, with or without neighbouring tabs in the group.

## 0.1.4 — 2026-10-22

### Tables

- Added content-aware column sizing based on text wrapping and row height. Short or empty columns remain compact, text-heavy columns receive more reading space, and complex tables can scroll horizontally when necessary.
- Recalculate automatic widths when the workspace changes size while preserving user-adjusted widths during normal editing.
- Added Fit page width, Distribute Columns, Header Row, and Header Column controls. Layout state remains session-only and does not add metadata to Markdown files.
- Added full-height column resize handles, including sticky-header and frozen-first-column boundaries. Resizing affects only the selected column.
- Added range selection across cells, full-row and full-column selection handles, themed selection highlighting, and edge auto-scroll while selecting.
- Added table paste support for HTML tables, TSV, Markdown tables, and multiline plain text. Data beyond the selected destination range is truncated instead of creating rows or columns.
- Added table context-menu actions for layout, row and column management, deleting the table, Link, and File Link.
- Improved row, column, header, and whole-table deletion behavior, including selections that contain the last row.
- Preserved viewport position, horizontal scroll, column widths, caret state, and undo/redo during editing, clearing, and paste operations.
- Reworked sticky headers to use the original editable header instead of a duplicate editing surface, improving caret stability, IME input, empty-cell editing, and source synchronization.
- Improved fixed-column clipping, divider hit testing, selection color layering, table borders, resize tracks, and row/column selection handles.
- Added correct `<br>` rendering inside table cells.

### Outline and headings

- Improved the outline minimap for long documents with adaptive spacing, hierarchy simplification, marker aggregation, two-level visual depth, centered vertical alignment, and right alignment.
- Added collapsible H1–H6 sections. Collapsed sections include tables and other body blocks.
- Improved the first-hover response, marker styling, spacing, positioning, and interaction between expanded outlines and sticky table headers.

### Links and insertion

- Added File Link, Image, and 3×3 Table to the insert menu with consistent icons and grouping.
- File Link supports multiple local document types, displays the filename extension, opens files in VS Code when possible.
- Added full path and URL tooltips in Read Only and the Split preview pane.
- Routed web links through VS Code's external-link flow without navigating the Markdown editor away from the document or showing duplicate confirmations.
- Restricted image selection to supported image files and retained asset-folder handling.

### Images, diagrams, code blocks, and YAML

- Added pointer interaction and single-click fullscreen viewing for rendered images and diagrams, with zoom, pan, and close controls.
- Added a compact Edit action for rendered diagrams in Preview Edit. The action is hidden while source editing is active and is not shown in the Split preview pane.
- Mermaid, Graphviz, ECharts, and related diagram sources now restore the text caret and remain editable after switching from the rendered view to source.
- Rendered diagram labels remain read-only unless source editing is explicitly opened.
- Unified code-block copy buttons and the copied-state icon across modes.
- Preserved syntax colors while editing YAML front matter and yaml/yml code blocks in Preview Edit without inserting formatting markup into the source.
- Matched YAML colors in the Split preview pane with Preview, including themed front-matter keys and consistent fenced-code highlighting.

### Document opening and Agent context

- Improved automatic SightMD opening for Markdown documents launched from Agent conversations and other non-folder entry points.
- Preserved an explicit user choice to switch a document to the Text Editor.
- Prevented duplicate concurrent editor takeovers while allowing the same URI to open in SightMD again later.
- Added active-document and selection context for compatible Agent extensions, with exact source offsets when available and rendered-text selection when exact line mapping is unavailable.

### Todo and Split synchronization

- Synchronized Todo changes in Read Only with the Markdown source, saved content, and undo/redo history.
- Changed Todo interaction in the Split preview pane to update the matching source marker locally instead of rebuilding the entire document, reducing scroll jumps and visual shaking.
- Improved heading-anchor matching, bidirectional scroll synchronization, and coordination between pending source edits and preview-side Todo changes.

### Notes

- Advanced diagram renderers may still require network access to load their runtime resources.
- Agent integrations must consume the provided active-context interface; this release does not modify third-party Agent extensions.
- Automatic table widths and layout controls are session state and return to the default reading layout when the document is reopened.
