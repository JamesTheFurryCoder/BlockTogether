import React from 'react'
import './LandingPage.css'

export default function LandingPageView({ onViewStats }) {
  const username = sessionStorage.getItem('blocktogether:username')
  return (
    <div className="landing-page">
      <header className="site-header">
          <div className="header-container">
            <a className="logo" href="#home">BlockTogether</a>
            <nav aria-label="Main navigation">
              <ul className="nav-list">
                <li><a className="nav-link active" href="#home">Home</a></li>
                <li><a className="nav-link" href="#minigames">Minigames</a></li>
                <li><a className="nav-link" href="#profile">Profile</a></li>
              </ul>
            </nav>
          </div>
        </header>
      
        <main className="home-grid" id="home">
          <article className="card profile-card" id="profile" data-profile="">
            <p className="eyebrow">PLAYER PROFILE</p>
            <div className="profile-heading">
              <div className="avatar-wrap">
                <div className="avatar" aria-hidden="true" data-avatar="">AJ</div>
                <button className="avatar-edit" type="button" aria-label="Edit avatar" data-action="edit-avatar">Edit</button>
              </div>
              <div>
                <h1 data-player-name="">{username}</h1>
                <p className="muted" data-player-handle="">@blockbuilder</p>
              </div>
            </div>
            <p className="profile-bio muted">Building, exploring, and chasing high scores with friends.</p>
            <dl className="profile-stats">
              <div><dt>Games played</dt><dd>12</dd></div>
              <div><dt>Friends</dt><dd>8</dd></div>
              <div><dt>Rank</dt><dd>Level 7</dd></div>
            </dl>
            <a className="text-link" href="#stats" onClick={onViewStats} data-action="view-profile">View profile <span aria-hidden="true">→</span></a>
          </article>
      
          <section className="card recent-games" id="minigames" aria-labelledby="recent-games-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p>
                <h2 id="recent-games-title">Recent minigames</h2>
              </div>
              <a className="text-link" href="#minigames" data-action="view-all-games">All games <span aria-hidden="true">→</span></a>
            </div>
            <div className="game-list" data-game-list=""></div>
          </section>
        </main>
      
        <footer className="site-footer">
          <div className="footer-content">
            <div>
              <h2>Ready for another adventure?</h2>
              <p>Your worlds and friends are waiting.</p>
            </div>
            <div className="footer-actions">
              <a className="button button-primary" href="playerhome.html" data-action="enter-home">Enter my home</a>
              <a className="button button-secondary" href="#minigames" data-action="play-minigames">Play minigames</a>
              <a className="button button-primary" href="#stats" onClick={onViewStats} data-action="view-stats">View stats</a>
            </div>
          </div>
        </footer>
    </div>
  )
}
