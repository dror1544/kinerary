import { z } from "zod";
const bi = z
  .union([
    z.string(),
    z.object({ he: z.string().optional(), en: z.string().optional() }),
  ])
  .optional();
const packing = z.array(z.tuple([bi, bi])).optional();
export const parityFields = {
  tasks: z
    .array(
      z.object({
        id: z.string(),
        text: bi,
        owner: bi,
        deadline: z.string().optional(),
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
            flag: z.string().optional(),
            callingCode: z.string().optional(),
            currency: z
              .object({
                code: z.string().optional(),
                name: z.string().optional(),
                symbol: z.string().optional(),
              })
              .optional(),
            emergency: z
              .object({
                general: z.string().nullable().optional(),
                police: z.string().optional(),
                ambulance: z.string().optional(),
                fire: z.string().optional(),
                unified112: z.boolean().optional(),
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
  short_id: z.string().optional(),
  packing,
  venues: z
    .array(
      z.object({
        id: z.string().optional(),
        name: bi,
        tickets: z.string().optional(),
        url: z.string().optional(),
        maps: z.string().optional(),
        waze: z.string().optional(),
      }),
    )
    .optional(),
  rsvp_activities: z
    .array(
      z.object({
        id: z.string(),
        item_uid: z.string().optional(),
        title: bi,
        name: bi,
        desc: bi,
        price: bi,
        date: z.string().optional(),
      }),
    )
    .optional(),
  days: z
    .array(
      z.object({
        date: z.string().optional(),
        label: bi,
        items: z
          .array(z.object({ time: z.string().optional(), text: bi }))
          .optional(),
      }),
    )
    .optional(),
};
