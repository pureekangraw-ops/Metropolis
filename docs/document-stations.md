# Notion and Drive through Greenhouse

Metro authenticates and authorizes an existing Work handoff, persists the exact approved
job, then sends it to Greenhouse/PIXIE. PIXIE dispatches through the existing private
service binding. Metro rechecks current station/operation authority before calling the
provider. Provider credentials never enter the queue, Work, receipt, or client response.
No new Work, identity issuer, credential export endpoint, or parallel runner is needed.

## Existing Work routes

- Drive: `WORK-dd02ccfc-9724-432f-88f6-65fa7dd1854c`, `DRIVE_STATION`.
- Notion: `WORK-e459319b-9077-46ca-8191-9e45c30f618d`, `NOTION_STATION`.
- GO's grants target these exact Works and named operations. Existing LIGHT grants are unchanged.
  Future Works require their own destination scope, as with existing station handoffs.

Call `metropolis_work` action `handoff` with `payload.stationId`, `payload.operation`,
and `payload.payload`. Read the same Work through HERMES until its correlated delivery
is verified. Provider data is in `record.handoff.external.stationResult.data`.

| Station | Operation | Provider parameters |
| --- | --- | --- |
| Drive | list / search | folderId (optional), query (search), limit, cursor |
| Drive | read / read_content | fileId |
| Drive | create_text | name, text, folderId (optional) |
| Drive | update_text | fileId, text |
| Notion | search | query, limit, cursor |
| Notion | read / read_blocks | pageId; limit/cursor for blocks |
| Notion | create_page | parentId, title, text |
| Notion | append_text | pageId, text |

Drive list/search covers the selected folder's direct children, defaulting to the owner
root. Read/mutation verifies ancestry to `GOOGLE_DRIVE_ROOT_FOLDER_ID`; shortcuts are
not followed. Text reads support plain text, Markdown, JSON, CSV, and Google Docs export.
Text update supports existing plain text only. This is not a general Sheets/Slides editor.
Notion access remains limited by the integration's shared pages and capabilities;
create_page creates a child of a page, not a database row.

## Credentials and limits

Set secrets on Worker `metropolis`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`, and `NOTION_TOKEN`.
Google access tokens refresh server-side. Existing Notion token found on legacy `go-hub`
is not automatically available on `metropolis`; Cloudflare secret listing returns names
only. A token configured in ChatGPT's Notion connector is also a separate connection.
Do not expose/export secret values to move them. Set the same authorized token directly
in Metro's Worker secret settings if it is not already present.

Requests use fixed provider origins, strict operation/parameter allowlists, bounded
content, a 15-second per-request timeout, and a 16-KiB serialized result limit.
Large lists/blocks should use a smaller limit and cursor. Drive writes independently
read back text; Notion writes independently read the created page/returned block IDs.
Ambiguous writes stay OUTCOME_UNKNOWN for investigation and are never blindly retried.
Duplicate queue delivery reuses the saved result/receipt. A verified tool operation
does not close the Work; MIMIR's existing lifecycle remains separate.

Provider contracts: [Drive files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
and [Notion API](https://developers.notion.com/reference/intro).
