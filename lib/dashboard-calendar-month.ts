import dayjs from "dayjs";

// Dashboard and Results use host-local calendar date ranges. UTC formatting
// selects the wrong month near midnight at a month boundary.
export function dashboardLocalMonth(now = new Date()): string {
  return dayjs(now).format("YYYY-MM");
}
