import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import LandingPageView from './LandingPageView'
import PlayerStatsView from './PlayerStatsView'

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

function showPlayerStats() {
    reactRoot.render(<PlayerStats />)
  }

function showLandingPage() {
  reactRoot.render(<LandingPage />)
}

function LandingPage() {

  return (
    <LandingPageView onViewStats={showPlayerStats} />
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
    <PlayerStatsView
     onHomePage={showLandingPage}
      stats={stats}
      error={error}
      loading={loading}
      onRefresh={() => setAttempt(value => value + 1)}
    />
  )
}

const root = document.getElementById('stats-root')
if (!root) throw new Error('Could not find the player statistics mount point.')

const reactRoot = createRoot(root)
reactRoot.render(<LandingPage />)
