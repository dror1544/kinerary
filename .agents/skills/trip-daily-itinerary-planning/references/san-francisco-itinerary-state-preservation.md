# San Francisco itinerary state preservation example

Use case: the user built Sunday and Monday San Francisco schedules over multiple back-and-forth turns, then became frustrated when earlier trip-plan content was reintroduced and Sunday/Monday were mixed.

## Durable lesson

When a day plan has been corrected and the user says "save this" or "this is the final itinerary", future answers should use the latest saved/corrected plan as the source of truth for that day. Do not rebuild from the old trip plan unless asked.

## Final state from this session

### Sunday / tomorrow
- 08:00 leave hotel
- 08:10-09:00 relaxed coffee near hotel
- 09:00-10:30 Golden Gate Bridge / Battery Spencer
- 10:30-11:15 return toward hotel
- 11:30 settle into pub
- 12:00 World Cup
- During game:
  - girls: Union Square, then Chinatown, shops/stroll/coffee/something sweet
  - boys: stay at pub
- After game: meet around Union Square, Cable Car, short area stroll, coffee/cheesecake at Cheesecake Factory
- ~17:00 return to hotel, showers/rest/change
- 18:30 leave hotel for Greens to protect parking/walking time
- 19:00-19:10 target arrival
- 19:30 Greens
- Missing: pub for World Cup, morning coffee place

### Monday / day after tomorrow
- 08:00 leave hotel
- 08:10-09:00 relaxed coffee
- 09:30-11:45 Pier 39 + sea lions
- 12:15-13:00 Lombard Street
- 13:30-15:00 Chinatown — stroll, stalls, bakery, snacks
- From 15:00 decide by energy: hotel rest, North Beach, Ferry Building/Embarcadero, or Union Square
- 17:30 latest everyone back at hotel
- ~19:30 dinner, restaurant not finalized initially; Original Joe's North Beach was later recommended as the best fit
- Missing: morning coffee place, final 15:00 choice, dinner reservation

## Response pattern after corrections

Good:
- "Using your latest saved version: Sunday is World Cup + Greens; Monday is Pier 39/Lombard/Chinatown. Here is the clean schedule..."

Bad:
- Pulling Muir Woods, Golden Gate, or other original-trip-plan items back into Monday after the user already corrected the plan.
- Saying only "saved" without actually preserving the details in a working note or answerable state.
