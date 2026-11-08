# Pokémon Degen: standalone web game

One tiny Node server (no npm packages) serves the game and runs the accounts, cloud saves, leaderboards and global chat.
Players need an account (username + password, no email). There is no guest mode.

## Run it
    node server.js            # http://localhost:3000
Env vars: PORT, DATA_DIR (where accounts and saves live, default ./data), TRUST_PROXY=0 if not behind a proxy.

## Put it online (so anyone can play)
It is a normal Node web app, so any host that runs Node or Docker works. The one thing that matters:
**DATA_DIR must be on a persistent disk/volume**, otherwise accounts vanish whenever the host restarts or redeploys.

- Render: New > Web Service from a GitHub repo containing these files. Build command: empty. Start command: `node server.js`.
  Add a Disk (paid plan) mounted at `/var/data` and set env `DATA_DIR=/var/data`.
- Railway: deploy the repo, add a Volume at `/data`, set `DATA_DIR=/data`.
- Fly.io: `fly launch` (uses the Dockerfile), `fly volumes create data`, mount it at `/data`.
- Any VPS: `node server.js` behind Caddy or nginx for HTTPS (passwords travel over the connection, so use HTTPS).

## How it works
- Passwords are hashed with scrypt on the server. Login sessions are random tokens (stored hashed).
- The game saves to the account every few seconds and when you close the tab. The newest copy always wins.
- The **daily bonus is decided by the server** (one claim per account per day), so logging out/in, clearing storage or resetting cannot repeat it.
- Leaderboards and chat are shared by everyone on your server.

## Honest limits
Game logic runs in the browser, so a determined player can edit their own save or leaderboard numbers. That is fine for a
virtual-coin game among friends; moving the rules server-side would be the next step for a competitive public launch.

## Casino tables
- **Blackjack** has an offline table (solo, local) and online tables (Pikachu Pit, Charizard Lounge, Mewtwo High Roller). Online tables are run by the server: one shared dealer, 5 seats, 15 second turn clock. Table state lives in server memory, so a restart resets tables (bets in flight are refunded client side).
- **Roulette** is Lightning style: every spin strikes 1 bonus number and 2 to 5 lucky numbers (50x to 250x). The bonus number starts a four-reel slot bonus worth 250x to 1000x. To keep the economy sane, a normal straight-up pays 19:1 (`R_BASE` in index.html). Tune `LW`, `BW` and `R_BASE` to change the payouts; the odds panel recalculates the return automatically.
