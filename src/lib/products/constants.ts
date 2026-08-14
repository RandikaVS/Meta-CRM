/** Common retail units of measurement. Free text on the DB side
 *  (`products.unit`) — this is just the create/edit form's picklist,
 *  not an enum constraint, so a fork can type in anything else. */
export const UNIT_OPTIONS = [
  "pcs",
  "box",
  "bottle",
  "pack",
  "set",
  "kg",
  "g",
  "l",
  "ml",
] as const;
