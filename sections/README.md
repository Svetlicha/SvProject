# Sections

This folder is reserved for the next migration step: moving one app section at a time into its own HTML/JS module.

Stage 1 keeps the app behavior intact and only extracts CSS/JS from the original huge HTML files. Do not delete the section markup from `index.html`/`mobile.html` until the matching section has been migrated and tested.

Suggested order:

1. Tasks
2. Contracts
3. Prices
4. Discounts
5. Discount reservations
6. Cancellations and deposits
7. Hotels, nights, room types, mapping