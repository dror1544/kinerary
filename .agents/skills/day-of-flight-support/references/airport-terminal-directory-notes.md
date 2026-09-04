# Airport terminal directory notes

Use these notes when the user asks a **terminal/check-in** question rather than a pure live-status question.

## Newark (EWR)

### Official source
- Airport site: `https://www.newarkairport.com/flights/airlines`
- Useful because it maps each airline to its terminal/check-in area.

### Reliable extraction pattern
- Fetch the page HTML.
- Parse the embedded `__NEXT_DATA__` JSON.
- Search the airline rows for the target carrier.
- For American Airlines, the EWR record includes:
  - `"iataCode":"AA"`
  - `"airlineName":"American Airlines"`
  - `"terminals":["A"]`
  - `"optionalColumnInfo":"Level 2"`

### How to use it
- Answer the user's terminal question from the airport directory.
- Phrase `Level 2` as the **check-in/departures level**, not as the gate.
- Remind yourself that the **gate can still change** and should come from a live flight-status source closer to departure.

### Why this matters
- Airline and airport directories can be more reliable than generic flight trackers for **which terminal to arrive at**.
- Live trackers are still better for **gate, delay, and runway/takeoff timing**.
