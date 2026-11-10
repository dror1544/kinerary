/**
 * The trip-username field, made forgiving of how phones fill it in.
 *
 * iOS capitalises the first letter of a pasted or typed value and keyboards add
 * trailing spaces; the server lowercases and trims (portal.ts) but the old
 * `pattern="[a-z0-9]..."` refused the value before the server ever saw it — so
 * a username the organizer had pasted correctly "could not be pasted". The
 * browser constraint is now loose (the server stays the authority) and the
 * value is normalised as it arrives.
 */
export const normaliseUsername = (value: string): string => value.trim().toLowerCase();

/**
 * `-` is escaped because browsers compile `pattern` in unicode-sets mode, where a bare
 * trailing hyphen in a class is a syntax error and the whole pattern is silently dropped.
 */
export const TRIP_USERNAME_PATTERN = "\\s*[A-Za-z0-9][A-Za-z0-9._\\-]{1,63}\\s*";

export const tripUsernameInputProps = {
  required: true,
  pattern: TRIP_USERNAME_PATTERN,
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
  autoComplete: "username",
} as const;

/** Options for react-hook-form's `register`: normalise what is shown and what is submitted. */
export const tripUsernameRegisterOptions = {
  setValueAs: (value: unknown) => (typeof value === "string" ? normaliseUsername(value) : ""),
  onChange: (event: { target: { value: string } }) => {
    const normalised = normaliseUsername(event.target.value);
    if (normalised !== event.target.value) event.target.value = normalised;
  },
};
