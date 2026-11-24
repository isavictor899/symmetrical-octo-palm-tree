const nairobi = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const todayNairobi = (date = new Date()) => nairobi.format(date); // YYYY-MM-DD