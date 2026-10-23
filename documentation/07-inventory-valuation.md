# 07 · Inventory and valuation

Code: `server/src/inventory.ts`, `server/src/documents/posting.ts → buildMoves`, `server/src/masters.ts` (items).

## Items

- `type`: `goods` or `service`. Only goods with `track_inventory = 1` are stock items.
- `tracking`: `none`, `batch` (batch number, quantity, optional expiry) or `serial` (one serial per unit). Cannot change
  once the item has stock moves.
- `hsn_code`: 4, 6 or 8 digits (the lengths GST portals accept), checked when the code is set or changed so items saved
  earlier remain editable. Services use SAC codes (start with 99).
- `tax_preference`: `taxable` (with `tax_id`), `exempt`, `nil`, `non_gst`.
- Accounts: sales (default Sales or Service Income), purchase (default COGS for stock items, Purchases otherwise),
  inventory (default Inventory Asset).
- `opening_stock`: per warehouse quantity, rate and tracking; posted on the opening balance date.
- Names and SKUs are unique (case-insensitive name check when a name is set or changed).
- Price lists: percentage mark-up/mark-down on the base rate, or a per-item rate (`priceFor`).

## Stock moves

Every stock effect is a row in `stock_moves`, owned by its source (`source_type`, `source_id`). A move can be:

- **physical** — goods actually entered or left a warehouse (drives quantity on hand and negative-stock checks);
- **accounting** — the move carries value into the books (drives valuation and COGS);
- or both.

| Source | Physical | Accounting | Kind |
|---|---|---|---|
| Opening stock | ✓ | ✓ | opening |
| Bill without PO/receive | ✓ | ✓ | purchase |
| Bill from PO or receive | | ✓ | purchase |
| Purchase receive (accepted qty) | ✓ | | receive |
| Invoice without SO/challan | ✓ | ✓ | sale |
| Invoice from SO or challan | | ✓ | sale |
| Package (when shipped) | ✓ | | ship |
| Delivery challan | ✓ | | challan |
| Sales return (when received) | ✓ | | receive |
| Credit note (not from a return) | ✓ | ✓ | return_in |
| Credit note from a sales return | | ✓ | return_in |
| Vendor credit (returned goods) | ✓ | ✓ | return_out |
| Vendor credit (price correction) | | ✓ (qty 0) | value_adjust |
| Transfer order | ✓ out on send, ✓ in on receipt | ✓ (value-neutral) | transfer |
| Inventory adjustment (quantity) | ✓ | ✓ | adjust |
| Inventory adjustment (value) | | ✓ (qty 0) | value_adjust |
| Manufacturing order | ✓ | ✓ | mo_consume / mo_produce |

Lines with `data.return_to_stock = false` on credit notes do not bring goods back.

**Why two views?** In practice goods and paperwork arrive separately. A purchase order's goods arrive on a receive
(physical) and the vendor's bill arrives later (accounting). A sales order's goods leave on a package (physical) and the
invoice books the sale (accounting). A bill or invoice raised directly does both.

### Validation

`validateStock(source)` runs whenever a source has physical moves:

- with "Prevent stock from going negative" on, physical quantity per item and warehouse cannot go below zero;
- a batch cannot go below zero;
- a serial number can be in stock at most once, and can only leave a warehouse it is in.

`splitTracking` expands a line into one move per batch or serial and checks that batch quantities add up and that the
number of serials equals the quantity.

## Valuation: replay

Valuation method is set at setup (FIFO or weighted average) and cannot change once stock transactions exist.

`revalueItems(itemIds)` replays every accounting move of each item in order:

```
ORDER BY date, then inflows (qty > 0) first, then value adjustments (qty = 0), then outflows, with returns last; then id
```

- **Inflows with a fixed value** (opening, purchase, adjust, receive): unit cost from the move.
- **Returns in** (credit notes): the original sale's unit cost (`ref_source_line_id`), else current average.
- **Manufacturing output**: (consumed component value + labour + overhead) ÷ total produced quantity.
- **Value adjustments**: the delta is spread over the units on hand.
- **Outflows**: FIFO consumes the oldest layers; weighted average uses the current average. Issuing more than is on
  hand creates a deficit at the last known cost that later receipts fill.

Every move whose value changes is updated, and its source's journal is re-posted through the hook registered in
`seed.ts → registerHooks()`. Manufacturing orders whose component costs change requeue their finished item. This is
what makes back-dated purchases correctly re-cost later sales and production.

## Price corrections from vendors

A vendor credit line marked "price correction" (`return_to_stock = false`) reduces what was paid for goods without
returning them. `unitsRemainingFromLine(item, billLine, date)` works out how many units **from that bill line** are still
in stock on the credit's date:

- FIFO: the bill line's units remain only after everything received before them has been issued;
- weighted average: the line keeps the same share as the pool that remains out of everything available since it was
  received.

That share of the reduction lowers inventory (a `value_adjust` move); the rest is booked to cost of goods sold. A
correction whose units have all been consumed, or that is not linked to a bill line, goes entirely to cost of goods
sold. Price corrections together may cover at most the billed quantity of the line (`consumedQty(…, priceCorrections)`),
and they do not use up the quantity that can still be returned.

## Stock queries

| Function | Meaning |
|---|---|
| `stockSummary(item)` | physical, accounting, committed, available (= physical − committed), incoming, value, average cost, per warehouse |
| `committedQty(item, wh?)` | quantity on confirmed sales orders not yet shipped (shipped/delivered packages and live challans count as shipped) |
| `incomingQty(item)` | quantity on issued purchase orders not yet received (accepted quantity) |
| `availableBatches(item, wh)` | batches with stock, earliest expiry first |
| `availableSerials(item, wh)` | serials in stock |
| `currentUnitCost(item)` | accounting value ÷ accounting quantity, else purchase rate |

## Inventory documents

- **Transfer order**: `in_transit` moves stock out of the source warehouse; `mark_transferred` (with a date) moves it into
  the destination. Source and destination must differ.
- **Inventory adjustment**: `mode = quantity` (positive at a given rate or current cost; negative at current cost) or
  `mode = value` (enter the new total value per item). Counter account defaults to "Inventory Adjustments" and can be set
  in `data.account_id`.
- **Stock count**: `start_count` snapshots the expected physical quantity per line; `complete_count` takes counted
  quantities and, if anything differs, creates and posts an inventory adjustment for the variances.
- **Opening stock**: on the item; re-posted when the opening balance date changes.
