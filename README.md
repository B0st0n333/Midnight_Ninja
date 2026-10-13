# Midnight Ninja Online

The game plus a small server that lets anyone play each other from different devices.
You host the server, so you are the owner.

## What is in the folder

- `server.js` the game server. It serves the game and pairs players over WebSocket.
- `public/index.html` the game (same game as before, with Quick Match added).
- `package.json` lists the one dependency (`ws`).
- `render.yaml` one-click settings for Render.

## Run it on your own computer

1. Install Node.js 18 or newer from nodejs.org.
2. In this folder run `npm install`, then `npm start`.
3. Open http://localhost:3000 in two browser tabs, choose Online PvP, press Quick Match in both.

## Put it online so everyone can play

You need a host that runs Node.js apps (not plain static hosting such as GitHub Pages).
Render, Railway and Fly.io all work. With Render:

1. Put this folder in a GitHub repository.
2. On render.com choose New, then Blueprint, and pick the repository. The included `render.yaml`
   fills in every setting for you, including a secret `ADMIN_KEY` for your stats page
   (you can read it later in the service's Environment tab).
   (Doing it by hand instead: New, Web Service, pick the repository, Free instance,
   build command `npm install`, start command `npm start`.)
3. Deploy. Your game is at the address Render gives you. Share that link.

Free plans may put the server to sleep when nobody is playing, so the first player can wait
about a minute for it to wake up.

## How players find each other

- **Quick Match** pairs you with anyone else who presses it.
- **Room code** lets friends type the same code and play each other.
- Each room holds exactly two players. Any number of rooms can run at once.

## Owner tools

Set an environment variable `ADMIN_KEY` to a secret of your choice, then open
`https://your-address/stats?key=YOUR_SECRET` to see players online, active rooms, players
waiting for a match, matches started and uptime. Without `ADMIN_KEY` the page stays off.

`https://your-address/health` answers `ok` and is handy for uptime checkers.

## If the game page lives on a different website than the server

Add this line in `public/index.html` just before the last `<script>` tag, using your server address:

    <script>window.MN_SERVER='wss://your-server.onrender.com'</script>

Then set the environment variable `ALLOWED_ORIGINS` on the server to your game site address,
for example `https://mygame.com`, so other sites cannot use your server.

## Good to know

- Each player's game runs on their own device and the two share positions and shots through the
  server, so a slow connection can make the other player look slightly behind.
- Hits are decided by the shooter's screen and damage is applied by the player who was hit.
  That keeps it responsive, but a determined cheater could edit their own copy of the game.
  Fine for friends and casual play; ranked or prize play would need a server that runs the
  whole game.
- If the page is opened without this server behind it, room codes fall back to a direct
  PeerJS link between the two browsers. Quick Match needs the server.
