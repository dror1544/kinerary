# Voucher upload pattern for the live trip site

Verified pattern from this session:

1. Read the incoming PDF locally and extract text.
2. Map the voucher to a live booking shape:
   - `phase`: destination bucket such as `los-angeles`
   - `type`: for the tested case, `car`
   - `name`: supplier plus short product description
   - `date_from` / `date_to`: normalized from pickup/dropoff dates
   - `confirmation`: voucher confirmation number
   - `notes`: contract number, pickup/dropoff times, included coverage, and important restrictions
3. Call `get_bookings`.
4. If no live booking exists yet, create one with `add_booking`.
5. Upload the PDF with `upload_booking_confirmation`.
6. Re-read with `get_bookings` and confirm `conf_file` is present.
7. If the organizer still does not see it on the site, treat that as a display/debugging issue until proven otherwise.

Concrete tested case:
- Voucher type: car rental
- Supplier: Alamo USA
- Phase: `los-angeles`
- Upload succeeded only after creating a live booking record first
- Server verification came from `get_bookings`, which returned a booking row with populated `conf_file`

Do not infer from `get_config.bookings` that the upload target already exists in the live editable booking table.
