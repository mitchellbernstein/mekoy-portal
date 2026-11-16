export type CalendarInvitee = {
  name: string | null;
  email: string | null;
  response: "pending" | "accepted" | "declined" | "tentative" | "delegated" | "completed" | "in_process" | null;
};

export type CalendarEvent = {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timeZone: string | null;
  location: string | null;
  meetingURL: string | null;
  invitees: CalendarInvitee[];
};

export type CalendarState = {
  status: "not_connected" | "loading" | "ready" | "error";
  events: CalendarEvent[];
  error: string | null;
};
