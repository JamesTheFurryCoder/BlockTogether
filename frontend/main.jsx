import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '')
const STATS_ENDPOINT = `${API_BASE_URL}/api/users/me/stats`
const STAT_FIELDS = [
  'totalSessions',
  'totalPlaytimeMinutes',
  'averageSessionMinutes',
  'blocksInWorld',
  'blocksPlaced',
  'blocksBroken',
  'entityKills',
]

function isStatsResponse(value) {
  return value !== null
    && typeof value === 'object'
    && STAT_FIELDS.every(field => Number.isFinite(value[field]) && value[field] >= 0)
    && typeof value.breakReminder === 'boolean'
    && (value.breakReminderMessage === null || typeof value.breakReminderMessage === 'string')
}

function formatPlaytime(minutes) {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return hours ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`
}

function Stat({ label, value }) {
  return (
    <div className="player-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function PlayerStats() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true

    async function loadStats() {
      setLoading(true)
      setError('')

      try {
        const response = await fetch(STATS_ENDPOINT, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) {
          throw new Error(`The stats service returned HTTP ${response.status}.`)
        }

        const result = await response.json()
        if (!isStatsResponse(result)) {
          throw new Error('The stats service returned an unexpected response.')
        }
        if (active) setStats(result)
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'An unexpected error occurred.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    loadStats()
    return () => {
      active = false
    }
  }, [attempt])

  return (
    <>
      <header className="site-header">
        <a className="logo" href="/">BlockTogether</a>
        <nav aria-label="Main navigation">
          <a href="#stats">Player stats</a>
        </nav>
      </header>
      <main className="stats-shell" id="stats">
        <section className="stats-card" aria-labelledby="player-stats-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR PLAY INSIGHTS</p>
              <h1 id="player-stats-title">Player statistics</h1>
            </div>
            <button
              className="stats-refresh"
              type="button"
              onClick={() => setAttempt(value => value + 1)}
              disabled={loading}
            >
              {loading ? 'Updating…' : 'Refresh'}
            </button>
          </div>

          {loading && <p className="stats-message" role="status">Loading your statistics…</p>}
          {error && (
            <div className="stats-error" role="alert">
              <p>{error} Make sure the backend is running on port 3001.</p>
              <button type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>
            </div>
          )}
          {!loading && !error && stats && (
            <>
              {stats.breakReminder && stats.breakReminderMessage && (
                <p className="break-reminder" role="status">{stats.breakReminderMessage}</p>
              )}
              <dl className="player-stats-grid" aria-live="polite">
                <Stat label="Total playtime" value={formatPlaytime(stats.totalPlaytimeMinutes)} />
                <Stat label="Sessions" value={stats.totalSessions} />
                <Stat label="Average session" value={formatPlaytime(stats.averageSessionMinutes)} />
                <Stat label="Blocks in world" value={stats.blocksInWorld} />
                <Stat label="Blocks placed" value={stats.blocksPlaced} />
                <Stat label="Blocks broken" value={stats.blocksBroken} />
                <Stat label="Entities defeated" value={stats.entityKills} />
              </dl>
            </>
          )}
        </section>
      </main>
    </>
  )
}

const root = document.getElementById('stats-root')
if (!root) throw new Error('Could not find the player statistics mount point.')

createRoot(root).render(<PlayerStats />)
