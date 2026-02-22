import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Get user_id from query or body
  const userId = (req.query.user_id as string) || (req.body?.user_id as string) || null
  if (!userId) {
    return res.status(400).json({ error: 'user_id is required' })
  }

  // Initialize Supabase client
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[disconnect] Missing Supabase config:', {
      hasUrl: !!supabaseUrl,
      hasServiceKey: !!supabaseServiceKey,
    })
    return res.status(500).json({ error: 'Supabase configuration missing' })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  try {
    // Delete tokens from Supabase
    const { error: deleteError } = await supabase
      .from('google_calendar_tokens')
      .delete()
      .eq('user_id', userId)

    if (deleteError) {
      // If table doesn't exist or no rows found, that's okay
      if (deleteError.code === 'PGRST301' || deleteError.code === 'PGRST116') {
        console.warn('[disconnect] Tokens table may not exist or no tokens found:', deleteError.message)
        return res.status(200).json({ success: true, message: 'No tokens found to delete' })
      }
      console.error('[disconnect] Error deleting tokens:', deleteError)
      return res.status(500).json({ error: 'Failed to disconnect Google Calendar', detail: deleteError.message })
    }

    return res.status(200).json({ success: true, message: 'Google Calendar disconnected successfully' })
  } catch (err: any) {
    console.error('[disconnect] Unexpected error:', err)
    return res.status(500).json({ error: 'Failed to disconnect Google Calendar', detail: err?.message })
  }
}

