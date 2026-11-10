// One way to write dates and times everywhere: "8 Nov 2026, 19:55", 24-hour, the viewer's zone.

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const parse = (value: string | number | Date) => (value instanceof Date ? value : new Date(value));

export const formatDate = (value: string | number | Date) => DATE.format(parse(value));

export const formatTime = (value: string | number | Date) => TIME.format(parse(value));

export const formatDateTime = (value: string | number | Date) =>
  `${formatDate(value)}, ${formatTime(value)}`;
