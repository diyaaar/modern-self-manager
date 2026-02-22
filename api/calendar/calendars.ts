import type { VercelRequest, VercelResponse } from '@vercel/node'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // Get user ID from query
  const userId = req.query.user_id as string

  if (!userId) {
    return res.status(401).json({ error: 'User ID required' })
  }

  // Initialize Supabase client
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[calendars] Missing Supabase config:', {
      hasUrl: !!supabaseUrl,
      hasServiceKey: !!supabaseServiceKey,
      method: req.method,
    })
    return res.status(500).json({ error: 'Supabase configuration missing', detail: { hasUrl: !!supabaseUrl, hasServiceKey: !!supabaseServiceKey } })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  if (req.method === 'GET') {
    try {
      // Get user's calendars from database
      const { data: calendars, error } = await supabase
        .from('calendars')
        .select('*')
        .eq('user_id', userId)
        .order('is_primary', { ascending: false })
        .order('name', { ascending: true })

      if (error) {
        // If table doesn't exist, return empty array
        if (error.code === 'PGRST301' || error.message?.includes('Not Acceptable')) {
          return res.status(200).json({ calendars: [] })
        }
        throw error
      }

      return res.status(200).json({ calendars: calendars || [] })
    } catch (err) {
      console.error('Error fetching calendars:', err)
      return res.status(500).json({ error: 'Failed to fetch calendars' })
    }
  }

  if (req.method === 'POST') {
    try {
      // Sync calendars from Google Calendar
      console.log('[calendars POST] Starting sync for user:', userId)
      const { data: tokens, error: tokenError } = await supabase
        .from('google_calendar_tokens')
        .select('*')
        .eq('user_id', userId)
        .single()

      if (tokenError || !tokens) {
        console.error('[calendars POST] Token fetch error:', tokenError)
        return res.status(401).json({ error: 'Google Calendar not connected' })
      }

      // Refresh token if needed using shared utility
      const { refreshGoogleToken } = await import('./_lib/tokenRefresh')
      const refreshResult = await refreshGoogleToken(
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date
      )

      // If refresh failed and token is expired, return error
      if (!refreshResult.success) {
        const now = Date.now()
        if (tokens.expiry_date - now < 0) {
          console.error('[calendars POST] Token expired and refresh failed:', refreshResult.error)
          return res.status(401).json({ error: 'Google Calendar token expired. Please reconnect.' })
        }
        // If token is still valid, proceed with existing token
        console.warn('[calendars POST] Token refresh failed but using existing token:', refreshResult.error)
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
            console.warn('[calendars POST] Failed to update token in database:', err)
          })
      }

      const accessToken = refreshResult.accessToken

      // Initialize Google Calendar API
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      )
      oauth2Client.setCredentials({ access_token: accessToken })

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

      // Fetch calendar list from Google
      let googleCalendars: any[] = []
      try {
        const response = await calendar.calendarList.list({
          minAccessRole: 'reader',
        })
        googleCalendars = response.data.items || []
      } catch (apiError: any) {
        console.error('[calendars POST] Google Calendar API error:', {
          message: apiError?.message,
          code: apiError?.code,
          status: apiError?.status,
        })
        // Handle specific Google API errors
        if (apiError?.code === 401 || apiError?.status === 401) {
          return res.status(401).json({ error: 'Google Calendar authentication failed. Please reconnect.' })
        }
        if (apiError?.code === 403 || apiError?.status === 403) {
          return res.status(403).json({ error: 'Google Calendar access denied. Please check permissions.' })
        }
        throw apiError
      }

      // Map Google Calendar colors
      const colorMap: Record<string, string> = {
        '1': '#a4bdfc', // Lavender
        '2': '#7ae7bf', // Sage
        '3': '#dbadff', // Grape
        '4': '#ff887c', // Flamingo
        '5': '#fbd75b', // Banana
        '6': '#ffb878', // Tangerine
        '7': '#46d6db', // Peacock
        '8': '#e1e1e1', // Graphite
        '9': '#5484ed', // Blueberry
        '10': '#51b749', // Basil
        '11': '#dc2127', // Tomato
      }

      // Sync calendars to database
      const syncedCalendars = []
      const syncErrors: string[] = []

      for (const googleCal of googleCalendars) {
        if (!googleCal.id) {
          console.warn('[calendars POST] Skipping calendar without ID:', googleCal.summary)
          continue
        }

        try {
          const calendarColor = googleCal.backgroundColor || colorMap[googleCal.colorId || ''] || '#3b82f6'
          const isPrimary = googleCal.primary === true

          // Check if calendar already exists
          const { data: existing, error: selectError } = await supabase
            .from('calendars')
            .select('id')
            .eq('user_id', userId)
            .eq('google_calendar_id', googleCal.id)
            .maybeSingle()

          if (selectError && selectError.code !== 'PGRST116') {
            console.error(`[calendars POST] Error checking existing calendar ${googleCal.id}:`, selectError)
            syncErrors.push(`Failed to check calendar ${googleCal.summary || googleCal.id}`)
            continue
          }

          if (existing) {
            // Update existing calendar
            const { data: updated, error: updateError } = await supabase
              .from('calendars')
              .update({
                name: googleCal.summary || 'Untitled Calendar',
                color: calendarColor,
                is_primary: isPrimary,
                updated_at: new Date().toISOString(),
              })
              .eq('id', existing.id)
              .select()
              .single()

            if (updateError) {
              console.error(`[calendars POST] Error updating calendar ${googleCal.id}:`, updateError)
              syncErrors.push(`Failed to update calendar ${googleCal.summary || googleCal.id}`)
            } else if (updated) {
              syncedCalendars.push(updated)
            }
          } else {
            // Create new calendar
            const { data: created, error: insertError } = await supabase
              .from('calendars')
              .insert({
                user_id: userId,
                name: googleCal.summary || 'Untitled Calendar',
                color: calendarColor,
                is_primary: isPrimary,
                google_calendar_id: googleCal.id,
              })
              .select()
              .single()

            if (insertError) {
              console.error(`[calendars POST] Error creating calendar ${googleCal.id}:`, insertError)
              syncErrors.push(`Failed to create calendar ${googleCal.summary || googleCal.id}`)
            } else if (created) {
              syncedCalendars.push(created)
            }
          }
        } catch (syncErr: any) {
          console.error(`[calendars POST] Unexpected error syncing calendar ${googleCal.id}:`, syncErr)
          syncErrors.push(`Unexpected error syncing calendar ${googleCal.summary || googleCal.id}`)
        }
      }

      // If we have sync errors but also some successful syncs, return partial success
      if (syncErrors.length > 0 && syncedCalendars.length > 0) {
        console.warn('[calendars POST] Partial sync success:', {
          synced: syncedCalendars.length,
          errors: syncErrors.length,
        })
      }

      return res.status(200).json({
        calendars: syncedCalendars,
        ...(syncErrors.length > 0 && { warnings: syncErrors }),
      })
    } catch (err: any) {
      console.error('[calendars POST] Error syncing calendars:', {
        message: err?.message,
        code: err?.code,
        status: err?.status,
        stack: err?.stack,
      })

      // Return appropriate status code based on error type
      if (err?.code === 401 || err?.status === 401) {
        return res.status(401).json({ error: 'Google Calendar authentication failed', detail: err?.message })
      }
      if (err?.code === 403 || err?.status === 403) {
        return res.status(403).json({ error: 'Google Calendar access denied', detail: err?.message })
      }

      return res.status(500).json({ error: 'Failed to sync calendars', detail: err?.message })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

