# WhatsApp ZIP Bot

Send files to the bot on WhatsApp, then send a name — it replies with `<name>.zip`.
It only responds to **one number** (set in `.env`); every other chat, group and status is ignored.

## How it works in chat

```
You:  [photo] [photo] [report.pdf]
Bot:  🤖 Got 3 file(s). Queue: 3 file(s), 4.2 MB.
      Send a name for the ZIP, or /cancel.
You:  Trip photos 2026
Bot:  🤖 Zipping 3 file(s) into "Trip photos 2026.zip"...
Bot:  📎 Trip photos 2026.zip
```

Commands: `/status` (list queued files), `/cancel` (discard them), `/help`.

## Important: use a separate WhatsApp account for the bot

The bot logs in **as** a WhatsApp account (like WhatsApp Web) and reacts to messages *sent to it*.
So it must run on a **different number** from `+94763570108` — e.g. a spare SIM or a WhatsApp Business
account on a second number. `+94763570108` then just chats with that bot number normally.

## Setup

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In this folder, create `.env` if you do not already have one:
   ```bash
   cp .env.example .env        # Windows: copy .env.example .env
   ```
3. Set `TARGET_NUMBER` in `.env` to the allowed sender's number, including country code.
   To use installed Chrome, set its path **before installing dependencies**:
   ```dotenv
   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"
   ```
   Use the actual path on your computer. `.puppeteerrc.cjs` reads this setting during
   installation and skips Puppeteer's browser download. Leave `CHROME_PATH` unset to
   download and use the bundled browser instead. Then install dependencies:
   ```bash
   npm install
   ```
4. Start it:
   ```bash
   npm start
   ```
5. A QR code appears in the terminal. On the **bot's** phone: WhatsApp → Settings → Linked devices →
   Link a device → scan it. The login is saved in `.wwebjs_auth/`, so you only scan once.

When you see `✅ Ready. Only responding to +94763570108`, send it a file from that number.

## Keeping it running

The bot works only while the computer is on and the script is running. To restart it automatically
if it crashes or WhatsApp disconnects:

```bash
npm install -g pm2
pm2 start index.js --name zip-bot
pm2 save
```

## Deploy free on Oracle Cloud (runs 24/7, scan the QR once)

Oracle Cloud's **Always Free** tier gives you a small Linux server that stays on for free. The bot
runs there in Docker, and the WhatsApp login is kept on a Docker volume, so it survives restarts,
reboots and code updates. You scan the QR **once**.

### 1. Create the server (one time)

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). A card is asked for
   identity checks only. Always Free resources are not charged.
2. **Compute → Instances → Create instance**:
   - Image: **Canonical Ubuntu 24.04**
   - Shape: **Ampere (VM.Standard.A1.Flex)**, 1 OCPU and 6 GB RAM is plenty.
     If it says "out of capacity", try again later or pick **VM.Standard.E2.1.Micro** (also free;
     the setup script adds swap for its 1 GB RAM).
   - SSH keys: **Generate a key pair** and download the private key (e.g. `oracle.key`).
3. Copy the instance's **Public IP address**. No ports need opening; the bot only makes outgoing
   connections.

### 2. Upload the bot (from this folder, in PowerShell on your PC)

```powershell
$IP = "YOUR.SERVER.IP"
$KEY = "C:\path\to\oracle.key"
tar --exclude=node_modules --exclude=.wwebjs_auth --exclude=.wwebjs_cache --exclude=work -czf "$env:TEMP\zip-bot.tgz" .
scp -i $KEY "$env:TEMP\zip-bot.tgz" ubuntu@${IP}:~/
ssh -i $KEY ubuntu@$IP "mkdir -p ~/zip-bot && tar -xzf ~/zip-bot.tgz -C ~/zip-bot && rm ~/zip-bot.tgz"
```

This includes your `.env`. Its Windows `CHROME_PATH` is ignored on the server.

### 3. Start it and scan the QR

```powershell
ssh -i $KEY ubuntu@$IP
```
then on the server:
```bash
cd ~/zip-bot
bash deploy/server-setup.sh      # installs Docker, builds, starts (first run ~3–5 min)
sudo docker compose logs -f      # shows the QR: scan it from the BOT's phone
```

Wait for `✅ Ready`, then press **Ctrl+C** to stop watching. The bot keeps running.
**Stop the copy on your PC first.** Two running copies would both answer every message.

### Everyday commands (on the server, in `~/zip-bot`)

| What | Command |
|---|---|
| See the log | `sudo docker compose logs -f --tail 100` |
| Restart | `sudo docker compose restart` |
| Stop / start | `sudo docker compose stop` / `sudo docker compose up -d` |
| Update after changing code | re-run step 2 from your PC, then `bash deploy/server-setup.sh` |
| Log in with a different number | `sudo docker compose down -v` (deletes the login), then `bash deploy/server-setup.sh` and scan again |

Updating keeps the login. Only `down -v` deletes it. If the bot crashes or WhatsApp disconnects,
Docker restarts it automatically, also after a server reboot.

## Settings (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `TARGET_NUMBER` | — | The only number allowed to use the bot |
| `TARGET_IDS` | empty | Extra WhatsApp IDs (`...@lid`) for that person; normally auto-detected |
| `CHROME_PATH` | bundled Chromium | Path to your own Chrome; also skips the browser download during `npm install` |
| `HEADLESS` | `true` | `false` shows the browser window |
| `MAX_ZIP_MB` | `100` | Largest ZIP it will build |
| `SESSION_DIR` | `.wwebjs_auth` | Where the WhatsApp login is saved (Docker uses `/data/session` on a volume) |

## Notes

- Supported: photos, videos, documents, audio and voice notes. Stickers etc. are skipped.
- Photos and videos are stored in the ZIP without recompression (they're already compressed), so
  zipping is fast.
- Files are deleted from the computer as soon as the ZIP is sent (or on `/cancel`, or on restart).
- Never share or commit `.env` or `.wwebjs_auth/` — the latter is a logged-in WhatsApp session.
- This uses `whatsapp-web.js`, an unofficial library. WhatsApp doesn't officially allow automation,
  so there's a small risk the bot number gets restricted. Another reason to use a spare number.

## Troubleshooting

- **`npm install` fails with `Failed to set up chrome` / `ECONNRESET`:** the browser
  download was interrupted. Set `CHROME_PATH` in `.env` to an existing Chrome executable
  as shown above, then run `npm install` again. The `glob` and `fluent-ffmpeg`
  deprecation warnings are separate from this download failure.
- **Bot doesn't reply:** check the terminal. If you see `(ignored) 1234...@lid`, put that ID in
  `TARGET_IDS` in `.env` and restart.
- **QR keeps appearing / auth failure:** delete the `.wwebjs_auth` folder and scan again.
- **Breaks after a WhatsApp update:** run `npm update whatsapp-web.js`.
