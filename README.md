# Lantern Inn

A social deduction game: guests fix up the inn, Gremlins sneak among them. Webcams and mics are live (WebRTC). When you're eliminated, your mic is cut until the next round. Earn lanterns (coins) and spend them on hats and colors.

## Run locally
    npm install
    npm start        # http://localhost:3000

(Camera/mic need HTTPS or localhost.)

## Deploy
1. Push this folder to a GitHub repo.
2. On render.com: New > Web Service > pick the repo. `render.yaml` sets build/start. Render gives you HTTPS automatically.

## Notes
- 3-10 players per room, join by 4-letter code.
- Voice/video is peer-to-peer using a free STUN server. Strict networks may need a TURN server (add it to `iceServers` in public/index.html).
- Coins/cosmetics are stored in each player's browser (localStorage), so they can be edited by the player. Move them to a database if you want it cheat-proof.
- Render's free tier sleeps after inactivity; first load can take ~30s.
