# San Francisco final two-day itinerary state and correction pattern

Use case: user iteratively finalized Sunday/Monday San Francisco plans via Telegram and became frustrated when the agent reintroduced old stops or mixed day assignments.

## Final state from the session

### Sunday / tomorrow
- 07:50 leave hotel
- 08:10-09:00 Round House Cafe / Golden Gate Bridge Plaza
- 09:00-10:30 Golden Gate / Battery Spencer
- 10:30-11:15 return toward hotel / pub
- 11:30 settle into pub for World Cup
- 12:00 World Cup
- During match:
  - boys stay at pub
  - girls: Union Square only; shops / stroll / coffee / sweet; stay close
  - explicitly **no Chinatown on Sunday**
- After match:
  - everyone meets around Union Square
  - Cable Car
  - short area stroll
  - Cheesecake Factory coffee / cheesecake stop
- ~17:00 return to hotel for showers/rest/change
- 18:30 leave hotel for Greens
- 19:00-19:10 target arrival / parking / settle
- 19:30 Greens dinner; sunset timing was desired and OK (SF sunset around 20:29 on 2026-07-19)
- Missing: World Cup pub

### Monday / day after tomorrow
- 08:15 leave hotel
- 08:20-09:00 Joe & The Juice, 525 Market St
- 09:30-11:45 Pier 39 + sea lions
- 12:15-13:00 Lombard Street
- 13:30-15:00 Chinatown **everyone together**
- From 15:00 choose by energy:
  - return to hotel, or North Beach, or Ferry Building / Embarcadero, or Union Square
- 17:30 latest everyone back at hotel
- 18:45-19:00 leave for Osha Thai / Embarcadero
- 19:15-19:20 arrive and settle
- 19:30 Osha Thai Restaurant and Bar reservation

## Durable workflow lesson

When the user says "זה מה שבנינו", "תשמור", "זה ליום שני", "בלי X", or corrects a day assignment, immediately update the working itinerary state and stop relying on older source-plan defaults. The final answer should reflect only the latest accepted state.

## Presentation lesson

When asked for a copyable itinerary, provide plain chronological bullets without tables. Tables are useful for internal clarity, but the user explicitly asked for a no-table version to copy.

## Cable Car note

For a single Cable Car experience, MuniMobile item is **Single Cable Car Ride — $9.00**. Do not recommend the Muni Day Pass without Cable Car. The 1-Day Muni + Cable Car Pass is only worthwhile if they plan additional Muni rides that day.
