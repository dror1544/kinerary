# Release A — Hebrew read of the typed-change strings and the two menu descriptions (gate G3)

**Reviewer:** the Sprint 6 lead session (Claude Sonnet 5), at Dror's request, 2026-09-26. **Source:** `control-plane/api/src/intake-copy.ts` (`change.*` and `changePendingBlocksConfirm`, Hebrew and English) and `control-plane/api/src/relay/command-menu.ts` on `integration/sprint-6` at `bbe2746`; behaviour read from `typed-changes-render.ts`, `typed-changes.ts` and `relay/poller.ts` at the same commit.
**Limit:** this is a read by a model, not a native speaker's sign-off. Every proposed wording below is for Dror to accept, change or reject. **No string has been changed by this review.**

## Scope

- **Asked for:** the 12 typed-change strings of the plan's gate G, plus the two menu descriptions; particular attention to the four non-refundable-booking warnings (they must not imply that Kinerary knows or guarantees a booking's real cancellation terms); and the yes/no flows (it must always be clear what is being confirmed or rejected).
- **Read:** all 77 typed-change strings in both languages (not only the 12), because the yes/no flows and the booking warnings only make sense together with the strings around them, and the menu block. Each string's use was checked in the code where its meaning depends on it (`{nonRefundable}` is a count; an unseen change is only re-shown by a yes or a no; `dropsField` applies to stops and to travellers; "and 1 more" is never said for the capped booking list).

## Findings to change before release

Ranked. F1–F4 answer the two questions asked; F5–F9 are grammar or consistency errors an organizer would see. All are string edits in `intake-copy.ts` (F9 in `command-menu.ts`); tests that pin these strings need the same edit.

### F1. The four non-refundable warnings state a marking as a fact and point nowhere

**Keys:** `change.warn.bookingInRemovedStop.non_refundable`, `.moreNonRefundable`, `change.warn.bookingForRemovedTraveller.non_refundable`, `.moreNonRefundable` (the four in the asked-for set are `.more` and `.moreNonRefundable` for a stop and for a traveller; I also read their four single-booking siblings, `.unknown` and `.non_refundable`, because the same wording appears there. The `.unknown` and `.more` variants already say "I don't know" and are sound; the defect is in the two `.moreNonRefundable` and the two single-booking `.non_refundable`).

- **Problem 1, attribution.** "מסומנת כבלתי ניתנת להחזר / לביטול" ("marked non-refundable / cannot be cancelled") does not say who marked it. The code's own comment says these are "the ones the data says" are non-refundable: a field extracted from a document the organizer sent, not something Kinerary knows. A reader can take it as Kinerary asserting the terms, and either give up on a cancellation that was possible or assume the opposite for the bookings that are not flagged.
- **Problem 2, "check what, with whom".** "כדאי לבדוק לפני שמסירים" does not say to check with the provider.
- **Problem 3 (the two `.moreNonRefundable`).** `{nonRefundable}` is a **count** (`String(hiddenNonRefundable)`), and the Hebrew puts it after a colon at the end: "…מסומנות כבלתי ניתנות להחזר / לביטול: 2". It reads like a list of booking names, and the English ("{nonRefundable} of them marked…") is not ambiguous. A count of 1 also cannot be put in front of a plural adjective ("1 מסומנות").

**Proposed Hebrew** (keeps each key's existing content; adds the source, the limit of what Kinerary can know, and who to ask):

| Key | Now | Proposed |
|---|---|---|
| `bookingInRemovedStop.non_refundable` | ⚠️ ההזמנה {booking} נופלת בתוך {stop} ומסומנת כבלתי ניתנת להחזר / לביטול. היא נשארת ברשומה — כדאי לבדוק לפני שמסירים. | ⚠️ ההזמנה {booking} נופלת בתוך {stop} ונשארת ברשומה. לפי מה שרשום אצלי היא כבלתי ניתנת להחזר או לביטול, אבל אני לא יכול לדעת מה התנאים בפועל — כדאי לבדוק מול הספק לפני שמסירים. |
| `bookingForRemovedTraveller.non_refundable` | ⚠️ ההזמנה {booking} על שם {traveller} ומסומנת כבלתי ניתנת להחזר / לביטול — כדאי לבדוק לפני שמסירים. | ⚠️ ההזמנה {booking} על שם {traveller}. לפי מה שרשום אצלי היא כבלתי ניתנת להחזר או לביטול, אבל אני לא יכול לדעת מה התנאים בפועל — כדאי לבדוק מול הספק לפני שמסירים. |
| `bookingInRemovedStop.moreNonRefundable` | ⚠️ ועוד {count} הזמנות מאושרות נופלות בתוך {stop} ונשארות ברשומה — מתוכן, מסומנות כבלתי ניתנות להחזר / לביטול: {nonRefundable}. כדאי לבדוק אותן לפני שמסירים. | ⚠️ ועוד {count} הזמנות מאושרות נופלות בתוך {stop} ונשארות ברשומה. מספר ההזמנות מביניהן שרשום אצלי כבלתי ניתנות להחזר או לביטול: {nonRefundable}. אני לא יכול לדעת מה התנאים בפועל — כדאי לבדוק מול הספק לפני שמסירים. |
| `bookingForRemovedTraveller.moreNonRefundable` | ⚠️ ועוד {count} הזמנות מאושרות על שם {traveller} — מתוכן, מסומנות כבלתי ניתנות להחזר / לביטול: {nonRefundable}. כדאי לבדוק אותן לפני שמסירים. | ⚠️ ועוד {count} הזמנות מאושרות על שם {traveller}. מספר ההזמנות מביניהן שרשום אצלי כבלתי ניתנות להחזר או לביטול: {nonRefundable}. אני לא יכול לדעת מה התנאים בפועל — כדאי לבדוק מול הספק לפני שמסירים. |

**Proposed English** (same changes, so the two languages say the same thing):
- single, stop: "⚠️ {booking} falls inside {stop} and stays on record. My records say it is non-refundable / cannot be cancelled, but I can't know the actual terms — check with the provider before removing."
- single, traveller: "⚠️ {booking} is in {traveller}'s name. My records say it is non-refundable / cannot be cancelled, but I can't know the actual terms — check with the provider before removing."
- more, stop: "⚠️ …and {count} more confirmed bookings fall inside {stop} and stay on record. My records mark {nonRefundable} of them non-refundable / not cancellable, but I can't know the actual terms — check with the provider before removing."
- more, traveller: the same with "are in {traveller}'s name" and no "stay on record".

**Optional, for consistency:** end the four `.unknown` / `.more` warnings with "מול הספק" too ("כדאי לבדוק מול הספק לפני שמסירים").

### F2. `change.sendFailed`: "reply yes or no" does not say that neither decides anything

`לא הצלחתי להראות לכם את השינוי עכשיו, אז הוא ממתין. ענו "כן" או "לא" ואציג אותו שוב.`

In the code (`relay/poller.ts`, "NOTHING HAPPENS TO A CHANGE THE ORGANIZER HAS NOT SEEN") a yes and a no on a change whose preview never arrived are answered the same way: the change is shown, and neither is acted on. The message never says that, and it gives a yes/no with no question. An organizer can reasonably read "yes" as "apply it".

- **Proposed Hebrew:** `לא הצלחתי להציג לכם את השינוי עכשיו, והוא ממתין. עדיין לא שיניתי כלום. ענו "כן" או "לא" ואציג אותו שוב — ורק אחרי שתראו אותו תוכלו לאשר או להשאיר הכול כמו שהיה.`
- **Proposed English:** `I couldn't show you that change just now, so it's waiting — nothing has been changed. Reply "yes" or "no" and I'll show it to you again; it's only applied after you've seen it and confirmed.`

### F3. "No, cancel" collides with booking cancellation

`change.cancel` = "לא, לבטל" ("No, cancel"). In the same message the booking warnings talk about "תנאי הביטול" (cancellation terms). Someone reading a warning about a non-refundable booking and then a button "No, cancel" can take it as cancelling the booking. The same word ("בטלו אותו") is how three other strings say "reject the waiting change".

- **`change.cancel`:** "לא, לבטל" → **"לא, להשאיר כמו שהיה"** (matches the confirmation the bot then sends, `change.cancelled` "בסדר — נשאר בדיוק כמו שהיה."). English: "No, cancel" → "No, leave it as it was".
- **`changePendingBlocksConfirm`:** "אשרו אותו או בטלו אותו" → `יש שינוי שממתין לאישור — עדכנו אותו או השאירו הכול כמו שהיה, ורק אז נסיים.` (English: "…apply it or leave everything as it was first…").
- **`change.tooBig`:** "אשרו או בטלו את מה שממתין" → `זה הרבה בבת אחת — קודם ענו על השינוי שממתין (לעדכן או להשאיר כמו שהיה), ואז שלחו את השאר.`
- **`change.stillBlocked`:** "…או בטלו אותו" → "…או השאירו הכול כמו שהיה".

### F4. The plain "yes or no" has no question

`change.footer` = "לחצו על כפתור, או פשוט ענו כן או לא." The buttons say what a yes means ("כן, לעדכן"), but the typed reply is a bare yes/no to a message that ends without a question. After F3 the two buttons are unambiguous; the footer should ask the question they answer.

- **Proposed Hebrew:** `לעדכן? לחצו על כפתור, או פשוט ענו כן או לא.` **English:** "Apply this? Tap a button, or just reply yes or no."

### F5. `change.line.dropsField` is grammatically feminine for every entry, including male travellers

`• {entry} מאבדת את ה{field}`. The code emits this line for both stops and travellers (`typed-changes.ts`, replace of a stop or a traveller): "דן מאבדת את הגיל" for a man. A gender-neutral form that also avoids agreeing with the field (which is masculine, feminine or plural depending on the field):

- **Proposed Hebrew:** `• {entry}: הסרת ה{field}` (English can stay as it is).

### F6. `change.blocked.possibleDuplicate` assumes the person is male

`האם {name} הוא מישהו שכבר ברשימה ({candidates}) או נוסע חדש?` — "הוא" (he) for someone whose gender the bot does not know; visible whenever a woman's name is typed.

- **Proposed Hebrew:** `האם {name} כבר ברשימה ({candidates}), או שזה נוסע חדש? אם זה אותו אדם, כתבו מה לשנות; אם זה מישהו חדש, כתבו את שמו המלא.`

### F7. `change.effect.organizerIdentityReopens` is not Hebrew

`אז אצטרך לשאול שוב מי מהנוסעים הוא אתם.` — "who of the travellers is you (plural)", with a singular masculine "הוא".

- **Proposed Hebrew:** `אז אצטרך לשאול שוב מי מהנוסעים אתם.`

### F8. Count of 1 and "who/what"

- **`change.warn.bookingsWhoseNameUnknown`**: `יש {count} הזמנות מאושרות…` — with a count of 1 this says "there are 1 bookings" (the English hedges with "booking(s)"; the count is any positive number from `typed-changes.ts` and nothing pluralises it). **Proposed:** `⚠️ לא ברור לי על שם מי רשומות ההזמנות המאושרות (טיסות או כרטיסים): {count}. כדאי לבדוק אותן לפני שמסירים מישהו.`
- **`change.ask.whichNone`**: `למי התכוונתם?` is asked about stops as well as travellers; "who" is wrong for a stop. **Proposed:** `למי או למה התכוונתם?` (the wording `change.ask.which` already uses).

### F9. Vocabulary and register (small, but these ship to live Hebrew-speaking users)

- **Menu descriptions, which the plan flags as visible to live Hebrew-speaking organizers after the release.** Their neighbours are infinitive verbs ("להציג או לשנות את השם שלי", "לחבר אותי לקבוצה המשפחתית"); these two are noun phrases. **Proposed:** `trips`: `להציג את הטיולים שלך ולאיזה מהם הצ׳אט הזה מחובר`; `switch`: `לחבר את הצ׳אט הזה לטיול אחר`.
- **`change.warn.removesEverything.phases`**: "העצירות" — the rest of the flow says "תחנות" (`change.noun.stops`, the options) — and "ימחק" ("delete") where the flow says "להסיר" (remove). **Proposed:** `⚠️ זה יסיר את כל התחנות — את כל מסלול הטיול.` and `.travelers`: `⚠️ זה יסיר את כל הנוסעים — את כל הרשימה.` Likewise `change.warn.daysDropped` "שיימחקו" → "שיוסרו".

## The four non-refundable warnings — verdict per string

| Key | Says Kinerary does not know the terms? | Implies knowledge or a guarantee? | Verdict |
|---|---|---|---|
| `bookingInRemovedStop.unknown` | yes ("אני לא יודע מה תנאי הביטול שלה") | no | sound |
| `bookingForRemovedTraveller.unknown` | yes | no | sound |
| `bookingInRemovedStop.more` | yes ("אני לא יודע מה תנאי הביטול שלהן") | no | sound |
| `bookingForRemovedTraveller.more` | yes | no | sound |
| `bookingInRemovedStop.non_refundable` | no | **reads as a fact** ("מסומנת כבלתי ניתנת להחזר") | change (F1) |
| `bookingForRemovedTraveller.non_refundable` | no | **reads as a fact** | change (F1) |
| `bookingInRemovedStop.moreNonRefundable` | no | **reads as a fact; the count is ambiguous** | change (F1) |
| `bookingForRemovedTraveller.moreNonRefundable` | no | **reads as a fact; the count is ambiguous** | change (F1) |

## The yes/no flows — what each decision confirms

| Where | What a yes / a tap confirms | What a no confirms | Clear? |
|---|---|---|---|
| The preview (`change.header` … `change.footer`, buttons) | applies exactly the listed lines ("כן, לעדכן") | leaves everything as it was ("לא, לבטל") | header is clear ("עדיין לא שיניתי כלום"); the button word "לבטל" and the missing question are F3, F4 |
| `change.sendFailed` (an unseen change) | nothing: it only re-shows the change | nothing: it only re-shows the change | **not clear**, F2 |
| `changePendingBlocksConfirm`, `change.tooBig`, `change.stillBlocked` | "approve or cancel" the waiting change | | "cancel" is F3 |
| `change.stale` / `change.updated` (the answer or change moved after it was shown) | states plainly that nothing was applied, then shows the current change again | | clear |
| `change.applied` / `change.cancelled` / `change.alreadyApplied` / `change.gone` | | | clear ("בוצע — עודכן.", "בסדר — נשאר בדיוק כמו שהיה.") |
| `change.droppedUnshown` / `change.droppedTooBig` | | | clear (they say the change was dropped and nothing was changed) |
| `change.blocked.*` / `change.ask.*` (questions with tap choices) | a choice among named options, each option says what it does | | clear |

## Noted, not blocking

- **Prefix letters attached to a placeholder** (`מ{entry}`, `ב{to}`, `ל{stop}`, `ב{what}`, `ל{to}`): if a stop's name is typed in Latin letters the result is "בKyoto", where Hebrew style wants "ב-Kyoto". Names in Hebrew are unaffected. Low frequency; a fix needs a helper that adds a hyphen before a Latin-script value, not a string edit.
- **`change.value.none` "(כלום)"** is colloquial; "(ריק)" or "(ללא)" would read more formally. Not wrong.
- **Direction of the arrow in `change.line.field`** ("{from} ← {to}") is correct for right-to-left text: the old value is on the right, the arrow points to the new one on the left.
- **Bot voice** is masculine throughout ("לא יודע", "לא הייתי בטוח"), and users are addressed in the plural ("אתם", "שלכם"), which is neutral for men and women. Consistent within the flow. The menu's "שלך" is singular (also neutral).

## Read and found sound

`change.header`, `change.line.add`, `.remove`, `.replace`, `.reorder`, `.unchanged`, `.unchangedMore`, all `change.field.*`, `change.warn.outsideTripDates.*`, `change.warn.bookingInRemovedStop.unknown`, `.more`, `change.warn.bookingForRemovedTraveller.unknown`, `.more`, `change.effect.dietaryScopeNamesNobody`, `change.blocked.overlap`, `.moveDated`, `.datesReversed`, `.invalid`, `.generic`, `change.ask.which`, `.choose`, `change.noun.stops`, `.travellers`, all `change.option.*`, `change.applied`, `.cancelled`, `.stale`, `.alreadyApplied`, `.gone`, `.notUnderstood`, `.notUnderstoodAbout`, `.updated`, `.tooBigFresh`, `.droppedTooBig`, `.sessionConfirmed`, `.uneditable`, `.droppedUnshown`, `change.invalid.detail.*`, and the `help`, `name` and `group` menu descriptions.

## Status

- No string has been changed. Proposed wordings are for Dror to accept, edit or reject; any accepted change goes in one small PR with the pinned tests updated, before the Release A commit.
- After the change: re-run the interview and typed-change test suites and re-read the changed strings once in the rendered message (the walk, item 15 of the plan, shows the site; this needs a typed-change step on a throwaway trip to see the preview).
