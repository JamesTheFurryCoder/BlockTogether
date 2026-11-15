import React, { useState } from 'react'
import './login.css'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '')

async function submitCredentials(endpoint, username, password) {
  let response
  try {
    response = await fetch(`${API_BASE_URL}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    })
  } catch {
    throw new Error('Unable to reach the server. Please try again.')
  }

  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Unable to complete your request.')
  return result
}

async function rightLogin(username, password, landingPageCallback) {
  const result = await submitCredentials('login', username, password)
  sessionStorage.setItem('blocktogether:username', result.user.username)
  sessionStorage.setItem('blocktogether:demoLoggedIn', 'true')
  landingPageCallback()
}

export default function Login({ showLandingPage }) {
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [registerUsername, setRegisterUsername] = useState('')
  const [registerPassword, setRegisterPassword] = useState('')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function handleSubmit(event, action) {
    event.preventDefault()
    if (pending) return
    setPending(action)
    setError('')
    setMessage('')
    try {
      if (action === 'login') {
        await rightLogin(loginUsername, loginPassword, showLandingPage)
      } else {
        await submitCredentials('register', registerUsername, registerPassword)
        setLoginUsername(registerUsername)
        setRegisterPassword('')
        setMessage('Account created! Sign in above to start playing.')
      }
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setPending('')
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand"><span className="login-mark" aria-hidden="true" />BlockTogether</div>
        <p className="login-eyebrow">YOUR NEXT ADVENTURE STARTS HERE</p>
        <h2 id="login-title">Welcome back,<br />builder.</h2>
        <p className="login-intro">Your world. Your friends. Endless possibilities.</p>
        {error && <p className="login-error" role="alert">{error}</p>}
        {message && <p className="login-message" role="status">{message}</p>}
        <form onSubmit={event => handleSubmit(event, 'login')}>
          <label htmlFor="login-username">Username</label>
          <input id="login-username" type="text" placeholder="Enter your username" autoComplete="username" className="user" value={loginUsername} onChange={event => setLoginUsername(event.target.value)} required disabled={!!pending} />
          <label htmlFor="login-password">Password</label>
          <input id="login-password" type="password" placeholder="Enter your password" autoComplete="current-password" className="pass" value={loginPassword} onChange={event => setLoginPassword(event.target.value)} required disabled={!!pending} />
          <button type="submit" disabled={!!pending}>
            {pending === 'login' ? 'Signing in…' : 'Let’s play'} <span aria-hidden="true">↗</span>
          </button>
        </form>
        <section className="login-register" aria-labelledby="register-title">
          <h3 id="register-title">New here? Create an account.</h3>
          <form onSubmit={event => handleSubmit(event, 'register')}>
            <label htmlFor="register-username">Username</label>
            <input id="register-username" type="text" placeholder="Choose a username" autoComplete="username" value={registerUsername} onChange={event => setRegisterUsername(event.target.value)} required disabled={!!pending} />
            <label htmlFor="register-password">Password</label>
            <input id="register-password" type="password" placeholder="Choose a password" autoComplete="new-password" value={registerPassword} onChange={event => setRegisterPassword(event.target.value)} required disabled={!!pending} />
            <button type="submit" disabled={!!pending}>
              {pending === 'register' ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </section>
        <p className="login-footer">Build something great together.</p>
      </section>
      <aside className="login-world" aria-label="A world of blocks waiting to be built">
        <span className="login-world-tag">A LITTLE IMAGINATION. A WHOLE NEW WORLD.</span>
        <div className="login-blocks" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
        <div className="login-world-copy"><p>Better blocks.<br />Even better company.</p><span>Jump in. Make it yours.</span></div>
      </aside>
    </main>
  )
}
