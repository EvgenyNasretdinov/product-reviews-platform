# 0005: Cursor pagination over offset

## Context

Three list endpoints need pagination: `GET /products`, `GET
/products/:id/reviews`, and `GET /me/reviews`. All three sit behind lists
that change while a client is paging through them — new reviews arrive
continuously, and moderation approves or unpublishes rows, changing which
rows even qualify for the list.

## Decision

Pagination is cursor-based: each page response carries an opaque,
base64-encoded cursor built from the sort key plus the row's `id` as a
tiebreaker, and the next page's query is `WHERE (sort_key, id) >
(cursor_sort_key, cursor_id) ORDER BY sort_key, id LIMIT n`, not
`LIMIT/OFFSET`.

## Consequences

- Paging is **correct under concurrent writes**. A client reading page 2
  while a new review is approved does not see a row shift into or out of
  its window the way an offset-based page would — the cursor names a
  position in the ordering, not a row count, so insertions elsewhere in
  the list cannot skip or repeat a row for this client.
- Cost at depth is flat. `WHERE (sort_key, id) > (...)` uses the same
  index the query already needs for `ORDER BY`, so page 50 costs the same
  as page 1. `OFFSET 5000` costs Postgres a scan-and-discard of the first
  5000 matching rows every time, on every request, for every client
  currently on that page.
- The cursor is opaque to the client by design — it encodes implementation
  details (the exact sort key in use) that would otherwise become a public
  contract if a client were expected to construct or interpret it, which
  would block ever changing the underlying sort implementation.
- It is not possible to jump to an arbitrary page number ("go to page 7")
  the way offset pagination allows. Nothing in this product's UI needs
  that — the frontend uses "load more," not page numbers — so the
  trade-off costs nothing here in practice.

## Alternatives considered

- **`LIMIT/OFFSET`.** Rejected on both grounds in the decision above:
  correctness under concurrent inserts (rows shift between pages,
  producing skipped or duplicated results for any client paging while the
  list changes underneath them) and cost at depth (`OFFSET` forces
  Postgres to walk and discard every earlier row on every request,
  scaling linearly with page depth rather than staying flat). Offset
  pagination is simpler to implement and does support "jump to page N,"
  which is the one thing it can do that cursor pagination cannot — but
  neither correctness nor that feature was worth trading away here.
