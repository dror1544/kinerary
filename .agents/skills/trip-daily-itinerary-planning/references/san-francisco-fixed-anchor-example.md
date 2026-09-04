# San Francisco fixed-anchor example

Condensed lessons from a live family-planning session.

## Scenario
- Hotel: Galleria Park Hotel, 191 Sutter St, San Francisco
- Dinner reservation: Greens Restaurant, Fort Mason, 19:30
- Reservation note from screenshot: paid hourly parking at Fort Mason Center; parking availability may vary with events; 10-minute grace period; call if later than 10 minutes
- Additional fixed anchor added later: World Cup watch at 12:00 in a sports pub near the hotel
- User preference: include plain-language explanations because they are not familiar with the city; find a cafe that is not Starbucks

## Verified planning facts used
- Hotel -> Greens driving estimate from maps tool: about 10 minutes without parking uncertainty
- Hotel -> Golden Gate Bridge Vista Point driving estimate: about 26.5 min outbound and 16.6 min return in the checked route
- Hotel -> Union Square walking estimate: about 0.58 km
- Union Square and the Powell/Market cable car turnaround are in the same area and should be grouped together

## Durable planning pattern
1. Anchor the dinner first because it has a lateness penalty.
2. Add a real arrival target before the official booking time (around 19:05-19:15 for a 19:30 table with a 10-minute grace period).
3. When a noon match/pub stop is added, rebuild the whole day around it instead of just inserting it.
4. Put Golden Gate / Battery Spencer before the match if doing it at all; put Union Square + cable car after the match because they co-locate.
5. Reserve a hotel reset block before dinner for showers, changing, and regrouping.
6. If using Uber for dinner, keep the arrival buffer but drop parking anxiety; if driving, leave earlier because parking is the main uncertainty.

## Output preference captured
- Give the schedule in a compact timeline.
- Add one-line explanations of what each place actually is and why it fits.
- If the user asks for a coffee stop, treat it as part of the day plan rather than an afterthought.
