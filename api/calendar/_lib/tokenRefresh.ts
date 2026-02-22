/**
 * Shared token refresh utility for Google Calendar API
 * Handles token refresh with proper error handling
 */

interface TokenRefreshResult {
  accessToken: string
  expiryDate: number
  success: boolean
  error?: string
}

/**
 * Refresh Google Calendar access token
 * Returns the new access token and expiry date, or the existing token if refresh is not needed
 */
export async function refreshGoogleToken(
  accessToken: string,
  refreshToken: string,
  expiryDate: number
): Promise<TokenRefreshResult> {
  const now = Date.now()
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return {
      accessToken,
      expiryDate,
      success: false,
      error: 'Google OAuth credentials not configured',
    }
  }

  // Only refresh if token expires within 5 minutes
  if (expiryDate - now >= 5 * 60 * 1000) {
    return {
      accessToken,
      expiryDate,
      success: true,
    }
  }

  try {
    const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (!refreshResponse.ok) {
      const errorData = await refreshResponse.json().catch(() => ({}))
      console.error('[tokenRefresh] Token refresh failed:', {
        status: refreshResponse.status,
        error: errorData,
      })
      return {
        accessToken,
        expiryDate,
        success: false,
        error: `Token refresh failed: ${refreshResponse.status} ${JSON.stringify(errorData)}`,
      }
    }

    const refreshData = await refreshResponse.json()
    const newExpiryDate = Date.now() + (refreshData.expires_in * 1000)

    return {
      accessToken: refreshData.access_token,
      expiryDate: newExpiryDate,
      success: true,
    }
  } catch (err: any) {
    console.error('[tokenRefresh] Token refresh error:', err)
    return {
      accessToken,
      expiryDate,
      success: false,
      error: `Token refresh error: ${err?.message || 'Unknown error'}`,
    }
  }
}
