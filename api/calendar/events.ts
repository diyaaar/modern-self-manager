import type { VercelRequest, VercelResponse } from '@vercel/node'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

// ── Local types ──────────────────────────────────────────────
interface CalendarRecord {
  id: string
  google_calendar_id: string | null
  color: string
  name: string
  is_primary: boolean
}

// ── Supabase client factory ──────────────────────────────────
function getSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return null
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ── Google OAuth client with token refresh ───────────────────
async function getAuthenticatedCalendar(supabase: ReturnType<typeof getSupabase>, userId: string) {
  if (!supabase) return null

  const { data: tokens, error: tokenError } = await supabase
    .from('google_calendar_tokens')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (tokenError || !tokens) {
    if (tokenError && tokenError.code !== 'PGRST116') {
      console.error('[events] Token fetch error:', tokenError)
    }
    return null
  }

  // Use shared token refresh utility
  const { refreshGoogleToken } = await import('./_lib/tokenRefresh')
  const refreshResult = await refreshGoogleToken(
    tokens.access_token,
    tokens.refresh_token,
    tokens.expiry_date
  )

  // If refresh failed and token is expired, return null
  if (!refreshResult.success) {
    const now = Date.now()
    if (tokens.expiry_date - now < 0) {
      console.error('[events] Token expired and refresh failed:', refreshResult.error)
      return null
    }
    // If token is still valid, proceed with existing token
    console.warn('[events] Token refresh failed but using existing token:', refreshResult.error)
  }

  // Update token in database if refresh was successful
  if (refreshResult.success && refreshResult.accessToken !== tokens.access_token) {
    await supabase
      .from('google_calendar_tokens')
      .update({
        access_token: refreshResult.accessToken,
        expiry_date: refreshResult.expiryDate,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .catch((err) => {
        console.warn('[events] Failed to update token in database:', err)
      })
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  )
  oauth2Client.setCredentials({ access_token: refreshResult.accessToken })

  return google.calendar({ version: 'v3', auth: oauth2Client })
}

// ── Helper: Get Google Calendar ID from calendar ID ─────────────
async function getGoogleCalendarId(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  calendarId: string | null | undefined
): Promise<string> {
  // Default to primary calendar
  if (!calendarId || calendarId === 'primary') {
    return 'primary'
  }

  // Look up calendar in database
  const { data: calRecord, error } = await supabase
    .from('calendars')
    .select('google_calendar_id')
    .eq('id', calendarId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error && error.code !== 'PGRST116') {
    console.warn(`[events] Error looking up calendar ${calendarId}:`, error)
  }

  return calRecord?.google_calendar_id || 'primary'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const authHeader = req.headers.authorization
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' })

  // user_id can come from query string (GET) or request body (POST)
  const userId = (req.query.user_id as string) || (req.body?.user_id as string) || null
  if (!userId) return res.status(401).json({ error: 'User ID required' })

  const supabase = getSupabase()
  if (!supabase) {
    console.error('[events] Missing Supabase environment variables')
    return res.status(500).json({ error: 'Supabase configuration missing' })
  }

  // ── GET: Fetch events ────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { timeMin, timeMax, calendarIds } = req.query

      if (!timeMin || !timeMax) {
        return res.status(400).json({ error: 'timeMin and timeMax are required' })
      }

      const calendar = await getAuthenticatedCalendar(supabase, userId)
      if (!calendar) {
        return res.status(401).json({ error: 'Google Calendar not connected. Please reconnect.' })
      }

      const requestedCalendarIds = calendarIds
        ? (calendarIds as string).split(',').filter(Boolean)
        : []

      // Get user's calendars from database
      const { data: userCalendars } = await supabase
        .from('calendars')
        .select('*')
        .eq('user_id', userId)

      let calendarsToFetch: Array<{ id: string; googleId: string; color: string; name: string }> = []

      if (userCalendars && userCalendars.length > 0) {
        const filtered: CalendarRecord[] = requestedCalendarIds.length > 0
          ? userCalendars.filter((c: CalendarRecord) => requestedCalendarIds.includes(c.id))
          : userCalendars

        calendarsToFetch = filtered
          .filter((c: CalendarRecord) => c.google_calendar_id)
          .map((c: CalendarRecord) => ({
            id: c.id,
            googleId: c.google_calendar_id!,
            color: c.color,
            name: c.name,
          }))
      }

      if (calendarsToFetch.length === 0) {
        calendarsToFetch = [{ id: 'primary', googleId: 'primary', color: '#10b981', name: 'Primary' }]
      }

      const allEvents: Array<{
        id: string; summary: string; description?: string
        start: string; end: string; allDay: boolean
        colorId?: string; location?: string; calendarId: string; color?: string
      }> = []

      for (const cal of calendarsToFetch) {
        try {
          const response = await calendar.events.list({
            calendarId: cal.googleId,
            timeMin: timeMin as string,
            timeMax: timeMax as string,
            maxResults: 2500,
            singleEvents: true,
            orderBy: 'startTime',
          })

          const items = response.data.items || []
          for (const item of items) {
            if (!item?.id) continue
            const isAllDay = !item.start?.dateTime
            const start = item.start?.dateTime || item.start?.date || ''
            const end = item.end?.dateTime || item.end?.date || ''
            allEvents.push({
              id: item.id,
              summary: item.summary || 'Untitled Event',
              description: item.description || undefined,
              start,
              end,
              allDay: isAllDay,
              colorId: item.colorId || undefined,
              location: item.location || undefined,
              calendarId: cal.id,
              color: cal.color,
            })
          }
        } catch (err: any) {
          // Handle specific Google API errors
          if (err.code === 401 || err.status === 401) {
            console.error(`[events GET] Authentication failed for calendar ${cal.name}:`, err)
            // Continue with other calendars instead of failing completely
            continue
          }
          if (err.code === 403 || err.status === 403) {
            console.error(`[events GET] Access denied for calendar ${cal.name}:`, err)
            // Continue with other calendars instead of failing completely
            continue
          }
          console.error(`[events GET] Error fetching calendar ${cal.name}:`, {
            message: err?.message,
            code: err?.code,
            status: err?.status,
          })
        }
      }

      allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      return res.status(200).json({ events: allEvents })

    } catch (err: any) {
      console.error('[events GET] Error:', err?.message)
      return res.status(500).json({ error: 'Failed to fetch events' })
    }
  }

  // ── POST: Create event ───────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const {
        summary, title,
        description,
        start, end,
        startDate, endDate,
        startDateTime, endDateTime,
        allDay,
        colorId,
        location,
        calendarId: requestedCalendarId,
        timeZone,
      } = req.body

      const eventTitle = (summary || title || '').trim()
      if (!eventTitle) {
        return res.status(400).json({ error: 'Event title (summary) is required' })
      }

      const calendar = await getAuthenticatedCalendar(supabase, userId)
      if (!calendar) {
        return res.status(401).json({ error: 'Google Calendar not connected. Please reconnect.' })
      }

      // Determine target Google calendar ID
      const googleCalendarId = await getGoogleCalendarId(supabase, userId, requestedCalendarId)

      // Always default to Europe/Istanbul for this app; never fall back to server-side UTC
      const tz = timeZone || 'Europe/Istanbul'

      // Build start/end for Google Calendar API (allDay uses date, timed uses dateTime)
      let googleStart: { date?: string; dateTime?: string; timeZone?: string }
      let googleEnd: { date?: string; dateTime?: string; timeZone?: string }

      const isAllDay = allDay === true || (typeof start === 'string' && start.length === 10)

      if (isAllDay) {
        const sDate = startDate || (typeof start === 'string' ? start.slice(0, 10) : null)
        let eDate = endDate || (typeof end === 'string' ? end.slice(0, 10) : sDate)
        if (!sDate) return res.status(400).json({ error: 'startDate is required for all-day events' })

        // Google Calendar requires all-day event end-dates to be exclusive
        if (sDate === eDate) {
          const d = new Date(sDate)
          d.setDate(d.getDate() + 1)
          eDate = d.toISOString().slice(0, 10)
        }

        googleStart = { date: sDate }
        googleEnd = { date: eDate || sDate }
      } else {
        const sDt = startDateTime || start
        const eDt = endDateTime || end
        if (!sDt || !eDt) return res.status(400).json({ error: 'start and end dateTime are required' })

        // IMPORTANT: Do NOT use new Date(...).toISOString() here.
        // toISOString() always converts to UTC and appends 'Z', which causes Google
        // Calendar to ignore the timeZone field, resulting in a +3h offset for Istanbul.
        // Instead, normalize the datetime string to RFC3339 format (with seconds)
        // and pair it with an explicit IANA timeZone.
        const { normalizeDateTimeForGoogle } = await import('./_lib/dateFormat')
        googleStart = { dateTime: normalizeDateTimeForGoogle(sDt), timeZone: tz }
        googleEnd = { dateTime: normalizeDateTimeForGoogle(eDt), timeZone: tz }
      }

      const eventResource = {
        summary: eventTitle,
        description: description || undefined,
        location: location || undefined,
        start: googleStart,
        end: googleEnd,
        colorId: colorId ? String(colorId) : undefined,
      }

      const response = await calendar.events.insert({
        calendarId: googleCalendarId,
        requestBody: eventResource,
      })

      const ev = response.data
      const evIsAllDay = !ev.start?.dateTime

      return res.status(200).json({
        id: ev.id || '',
        summary: ev.summary || 'Untitled Event',
        description: ev.description || undefined,
        start: ev.start?.dateTime || ev.start?.date || '',
        end: ev.end?.dateTime || ev.end?.date || '',
        allDay: evIsAllDay,
        colorId: ev.colorId || undefined,
        location: ev.location || undefined,
        calendarId: requestedCalendarId || 'primary',
      })

    } catch (err: any) {
      // Handle specific Google API errors
      if (err.code === 401 || err.status === 401) {
        return res.status(401).json({
          error: 'Google Calendar authentication failed',
          detail: err?.message,
        })
      }
      if (err.code === 403 || err.status === 403) {
        return res.status(403).json({
          error: 'Google Calendar access denied',
          detail: err?.message,
        })
      }
      console.error('[events POST] Error creating event:', {
        message: err?.message,
        code: err?.code,
        status: err?.status,
      })
      return res.status(500).json({
        error: 'Failed to create event',
        detail: err?.message,
      })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
