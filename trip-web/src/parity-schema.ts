// NULL IS ABSENT. Every optional field below accepts null as well as undefined.
//
// The server writes null for a value it does not have — an untimed day item is
// `"time": null` — and zod's `.optional()` accepts undefined only. On
// 2026-09-13 a live interview-built trip carried five `time: null` items, so
// `configSchema.parse` threw on the whole config: the modern site lost its
// hero, its map stops and every phase's date range, fell back to planned days
// only, and showed "Offline or stale data" over a server that had answered 200
// to every request. One optional field took the whole config down with it, so
// the rule is applied to the whole file rather than to the field that failed.
import { z } from "zod";
// Null on the wire means absent — converted BEFORE validation, so the schema
// (and every type inferred from it) stays exactly `optional()`. Two rejected
// alternatives: `.nullable()` leaks null into ten consumers written against
// `string | undefined`; `.transform()` makes the optional key required in the
// output type and broke every fixture that omits one.
const nullAsAbsent = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema);
const optStr = nullAsAbsent(z.string().optional());
const optBool = nullAsAbsent(z.boolean().optional());
const bi = nullAsAbsent(
  z
    .union([
      z.string(),
      z.object({ he: optStr, en: optStr }),
    ])
    .optional(),
);
const packing = z.array(z.tuple([bi, bi])).optional();
export const parityFields = {
  tasks: z
    .array(
      z.object({
        id: z.string(),
        text: bi,
        owner: bi,
        deadline: optStr,
      }),
    )
    .optional(),
  packing_general: packing,
  travel_info: z
    .object({
      countries: z
        .record(
          z.string(),
          z.object({
            flag: optStr,
            callingCode: optStr,
            currency: z
              .object({
                code: optStr,
                name: optStr,
                symbol: optStr,
              })
              .optional(),
            emergency: z
              .object({
                general: z.string().nullable().optional(),
                police: optStr,
                ambulance: optStr,
                fire: optStr,
                unified112: optBool,
              })
              .optional(),
          }),
        )
        .optional(),
      emergency_contacts: z
        .array(z.object({ name: bi, phone: z.string() }))
        .optional(),
      health: z.array(bi).optional(),
      money: z.array(bi).optional(),
      communication: z.array(bi).optional(),
      hospitals: z.array(z.object({ area: bi, name: z.string() })).optional(),
      age_notes: z.array(z.object({ who: bi, note: bi })).optional(),
    })
    .optional(),
};
export const phaseParityFields = {
  short_id: optStr,
  packing,
  venues: z
    .array(
      z.object({
        id: optStr,
        item_uid: optStr,
        name: bi,
        tickets: optStr,
        url: optStr,
        maps: optStr,
        waze: optStr,
      }),
    )
    .optional(),
  rsvp_activities: z
    .array(
      z.object({
        id: z.string(),
        item_uid: optStr,
        title: bi,
        name: bi,
        desc: bi,
        price: bi,
        date: optStr,
      }),
    )
    .optional(),
  days: z
    .array(
      z.object({
        date: optStr,
        label: bi,
        items: z
          .array(z.object({ time: optStr, text: bi }))
          .optional(),
      }),
    )
    .optional(),
};
