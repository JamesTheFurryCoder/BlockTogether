import React from 'react'

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

export default function PlayerStatsView({ stats, error, loading, onRefresh,onHomePage }) {
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
              onClick={onRefresh}
              disabled={loading}
            >
              {loading ? 'Updating…' : 'Refresh'}
            </button>
          </div>

          {loading && <p className="stats-message" role="status">Loading your statistics…</p>}
          {error && (
            <div className="stats-error" role="alert">
              <p>{error} Make sure the backend is running on port 3001.</p>
              <button type="button" onClick={onRefresh}>Try again</button>
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
        <button onClick={onHomePage}>Back to Home</button>
      </main>
    </>
  )
}
