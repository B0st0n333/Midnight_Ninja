# Midnight Ninja Online

The game plus a small server so anyone can play each other from different devices,
with optional player accounts (usernames and saved progress).
You host the server, so you are the owner.

## What is in the folder

- `server.js` the game server: serves the game, pairs players, handles accounts.
- `db.js` where accounts are stored (your Neon database, or a local file for testing).
- `public/index.html` the game.
- `package.json` the add-ons the server needs (`ws` and `pg`).
- `render.yaml` one-click settings for Render.

## Run it on your own computer

1. Install Node.js 22.5 or newer from nodejs.org.
2. In this folder run `npm install`, then `npm start`.
3. Open http://localhost:3000 in two browser tabs.

Without a database set up, accounts are saved in a file called `data.db` next to the server,
which is fine for trying things out.

## Put it online (Render)

1. Put this folder in a GitHub repository (upload every file and the `public` folder).
2. On render.com choose New, then Blueprint, and pick the repository. Apply.
3. Share the address Render gives you.

Free plans put the server to sleep when nobody is playing, so the first player may wait
about a minute for it to wake up.

## Turn on saved accounts (free Neon database)

Render's free disk is erased every time the server restarts, so accounts must live in a
separate database. Neon has a free plan with no credit card.

1. Sign up at neon.com and create a project (any name).
2. On the project page click **Connect** and copy the connection string. It starts with `postgresql://`.
3. In Render open your service, then **Environment**, then add a variable named `DATABASE_URL`
   with that string as the value. Save. Render redeploys by itself.
4. Open your game. An **Account** button appears on the menu.

Until `DATABASE_URL` is set the game still works for everyone as guests. If you see the
Account button disappear after you add the variable, the string was probably copied
wrong. Check the Logs tab in Render for a line starting with "Accounts are OFF".

## What accounts do

- Sign up with a username (3 to 16 letters, numbers or underscores) and a password
  (8 or more characters). Passwords are scrambled with scrypt and never stored as typed.
- Progress is saved: cleared levels (shown with a tick), kills, best survival time, duel wins and losses.
- Your name shows above your head in online duels. The server sets the name, so nobody can fake it.
- A top-10 list of duel winners is on the Account screen.
- Playing as a guest still works. Guests have no name (shown as Guest) and nothing is saved.

## How duel results are counted

A duel counts for the leaderboard only when both players are logged in and both report the
same round, one as a win and one as a loss. Duels against guests do not count, and the same
two players can earn at most 10 counted duels a day. Levels and survival progress are
reported by the player's own game, so they are for fun and are not on the public list.

## Owner tools

- Set `ADMIN_KEY` (Render makes one for you in `render.yaml`) and open
  `https://your-address/stats?key=YOUR_KEY` to see players online, rooms, accounts, duels recorded, uptime.
- `https://your-address/health` answers `ok`.
- There is no "forgot password" because there is no email. To remove an account or let someone
  start over, open the Neon **SQL Editor** and run
  `DELETE FROM sessions WHERE uname = 'theirname'; DELETE FROM users WHERE uname = 'theirname';`
  (use their name in lowercase). They can then sign up again with the same name.

## If the game page lives on a different website than the server

Add this line in `public/index.html` just before the last `<script>` tag:

    <script>window.MN_SERVER='wss://your-server.onrender.com'</script>

and set the environment variable `ALLOWED_ORIGINS` on the server to your game site address,
for example `https://mygame.com`.

## Good to know

- Each player's game runs on their own device and the two share positions and shots through the
  server. Hits are decided by the shooter's screen. Fine for friends and casual play; a determined
  cheater could edit their own copy of the game.
- Free Neon databases hold about 0.5 GB and go to sleep when idle, so the first login after a quiet
  spell can take a second longer.
- If the page is opened without this server behind it, room codes fall back to a direct
  PeerJS link between the two browsers. Quick Match and accounts need the server.
