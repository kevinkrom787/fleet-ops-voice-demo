// Minimal client for the parts of Calendly's public API (https://api.calendly.com) this app
// needs: resolving the estimate event type from its public scheduling URL, listing real open
// slots, and generating a one-time booking link. Uses a Personal Access Token (Calendly ->
// Integrations -> API & Webhooks -> "Get a token now"), which works on any Calendly plan for
// these read/link-creation endpoints.
//
// NOTE: booking a slot directly (no link, no redirect) is a separate "Scheduling API" endpoint
// that requires a paid Calendly plan - not used here. This client only reads availability and
// creates a single-use link for the caller to confirm, which works on every plan.
//
// DEMO MODE: if CALENDLY_API_TOKEN isn't set, both calls below fall back to a canned set of
// weekday-business-hours slots instead of hitting the API, so the demo runs end-to-end with no
// Calendly account wired up. The booking link still points at the real scheduling URL, so it's
// genuinely clickable - just not a real single-use link. Once CALENDLY_API_TOKEN is set this
// switches to live data automatically, no code changes needed.

const API_BASE = 'https://api.calendly.com';

export interface CalendlyConfig {
  apiToken: string;
  schedulingUrl: string;
}

export function calendlyConfigFromEnv(): CalendlyConfig {
  return {
    apiToken: process.env.CALENDLY_API_TOKEN ?? '',
    // Set CALENDLY_EVENT_TYPE_URL in .env to your own event type's public scheduling URL.
    schedulingUrl: process.env.CALENDLY_EVENT_TYPE_URL || 'https://calendly.com/your-org/estimate',
  };
}

interface ResolvedEventType {
  eventTypeUri: string;
  eventTypeName: string;
  hostTimezone: string;
}

// Resolved once per process and reused - the event type behind a scheduling URL doesn't change
// mid-session, and this avoids a round trip on every availability check.
let cachedEventType: ResolvedEventType | null = null;

async function calendlyFetch(cfg: CalendlyConfig, path: string, init: RequestInit = {}) {
  if (!cfg.apiToken) {
    throw new Error('CALENDLY_API_TOKEN is not set - copy .env.example to .env and add your Calendly Personal Access Token.');
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Calendly API ${path} failed: ${res.status} ${res.statusText} - ${body}`);
  }
  return res.json() as Promise<Record<string, any>>;
}

async function resolveEventType(cfg: CalendlyConfig): Promise<ResolvedEventType> {
  if (cachedEventType) return cachedEventType;

  const me = await calendlyFetch(cfg, '/users/me');
  const userUri: string = me.resource.uri;
  const hostTimezone: string = me.resource.timezone;

  let pageToken: string | undefined;
  let match: Record<string, any> | undefined;
  do {
    const qs = new URLSearchParams({ user: userUri, count: '100', ...(pageToken ? { page_token: pageToken } : {}) });
    const page = await calendlyFetch(cfg, `/event_types?${qs.toString()}`);
    match = (page.collection as Array<Record<string, any>>).find((et) => et.scheduling_url === cfg.schedulingUrl);
    pageToken = page.pagination?.next_page_token || undefined;
  } while (!match && pageToken);

  if (!match) {
    throw new Error(
      `No event type on this Calendly account matches ${cfg.schedulingUrl}. Check CALENDLY_EVENT_TYPE_URL and ` +
        'that CALENDLY_API_TOKEN belongs to the account that owns that link.',
    );
  }

  cachedEventType = { eventTypeUri: match.uri, eventTypeName: match.name, hostTimezone };
  return cachedEventType;
}

export interface AvailableSlot {
  startTimeIso: string;
  /** Human-friendly, in the host's own timezone (e.g. "Tuesday, September 8 at 2:00 PM EDT"). */
  label: string;
}

function formatSlot(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

let warnedDemoMode = false;
function warnDemoModeOnce() {
  if (warnedDemoMode) return;
  warnedDemoMode = true;
  console.warn(
    '[calendly] CALENDLY_API_TOKEN not set - serving canned demo availability instead of your real calendar. ' +
      'Set CALENDLY_API_TOKEN in .env to switch to live Calendly data.',
  );
}

// Weekday, business-hours slots starting tomorrow - deterministic (no randomness) so a demo run
// is reproducible, and skips anything already in the past today.
function mockAvailableSlots(days: number, limit: number): AvailableSlot[] {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const businessHours = [9, 11, 13, 15];
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const slots: AvailableSlot[] = [];
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1); // start tomorrow

  while (slots.length < limit && cursor <= cutoff) {
    const dayOfWeek = cursor.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      for (const hour of businessHours) {
        if (slots.length >= limit) break;
        const slot = new Date(cursor);
        slot.setHours(hour, 0, 0, 0);
        if (slot > now) slots.push({ startTimeIso: slot.toISOString(), label: formatSlot(slot.toISOString(), timeZone) });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

export async function listAvailableSlots(
  cfg: CalendlyConfig,
  opts: { days?: number; limit?: number } = {},
): Promise<AvailableSlot[]> {
  if (!cfg.apiToken) {
    warnDemoModeOnce();
    return mockAvailableSlots(Math.min(Math.max(opts.days ?? 6, 1), 6), opts.limit ?? 5);
  }

  const { eventTypeUri, hostTimezone } = await resolveEventType(cfg);

  // Calendly caps `event_type_available_times` to a 7-day window per call.
  const days = Math.min(Math.max(opts.days ?? 6, 1), 6);
  const start = new Date();
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

  const qs = new URLSearchParams({
    event_type: eventTypeUri,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
  });
  const data = await calendlyFetch(cfg, `/event_type_available_times?${qs.toString()}`);
  const slots: AvailableSlot[] = ((data.collection as Array<Record<string, any>>) ?? [])
    .filter((s) => s.status === 'available')
    .map((s) => ({ startTimeIso: s.start_time, label: formatSlot(s.start_time, hostTimezone) }));

  return opts.limit ? slots.slice(0, opts.limit) : slots;
}

/** Creates a single-use scheduling link (max_event_count: 1) for the caller to confirm a time on. */
export async function createBookingLink(cfg: CalendlyConfig): Promise<string> {
  if (!cfg.apiToken) {
    warnDemoModeOnce();
    // No account to create a real single-use link against - hand back the real public
    // scheduling page instead. It's genuinely clickable, just not pre-scoped to one use.
    return cfg.schedulingUrl;
  }

  const { eventTypeUri } = await resolveEventType(cfg);
  const data = await calendlyFetch(cfg, '/scheduling_links', {
    method: 'POST',
    body: JSON.stringify({ max_event_count: 1, owner: eventTypeUri, owner_type: 'EventType' }),
  });
  return data.resource.booking_url;
}
