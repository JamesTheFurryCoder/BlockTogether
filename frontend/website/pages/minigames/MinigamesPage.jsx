import React from 'react'

export default function MinigamesPage({onHomePage}) {
    return (
        <div>
            <h1>Minigames</h1>
            <p>Welcome to the Minigames page!</p>
            <button onClick={onHomePage}>Back to Home</button>
            <a href="/game/mazegame.html" data-action="enter-mazegame">Maze Game</a>
            <a href="/game/arenashooter.html" data-action="enter-arenashooter">Arena Shooter</a>
            <a href="/game/platformrunner.html" data-action="enter-platformrunner">Platform RUN!</a>
        </div>
    )
}
