import React from 'react'
import './login.css'

function rightLogin(landingPageCallback) {
  // Logic for successful login can be added here
  let user = document.getElementsByClassName('user')[0];
  let pass = document.getElementsByClassName('pass')[0];
  console.log(user.value, pass.value);
  if(user.value === "admin" && pass.value === "password") {
    landingPageCallback();
  } else {
    alert("Invalid username or password");
  }
}


export default function Login({showLandingPage}) {
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
      <div className="login-brand"><span className="login-mark" aria-hidden="true" />BlockTogether</div>
      <p className="login-eyebrow">YOUR NEXT ADVENTURE STARTS HERE</p>
      <h2 id="login-title">Welcome back,<br />builder.</h2>
      <p className="login-intro">Your world. Your friends. Endless possibilities.</p>
      <form>
        <label htmlFor="login-username">Username</label>
        <input id="login-username" type="text" placeholder="Enter your username" autoComplete="username" className="user"/>
        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" placeholder="Enter your password" autoComplete="current-password" className="pass"/>
        <button type="submit" onClick={(e) => {
          e.preventDefault()
          rightLogin(showLandingPage)
        }}>
          Let’s play <span aria-hidden="true">↗</span>
        </button>
      </form>
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
