/**
 * WhatsApp ZIP bot
 * ----------------
 * Only the number(s) in TARGET_NUMBER (.env, comma separated) can use it.
 * Each number has its own queue, so their files never mix.
 *
 *   1. They send files (photos, videos, documents, audio).
 *   2. They send a text message  ->  that text becomes the ZIP name.
 *   3. The bot zips everything and sends <name>.zip back.
 *
 * Commands (from the allowed number only):
 *   /status   show what's queued
 *   /cancel   discard queued files
 *   /help     show usage
 *
 * Every other chat, group and status update is ignored silently.
 */

require('dotenv').config({ quiet: true });
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const archiver = require('archiver');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------- config

const digits = (s) => String(s || '').replace(/\D/g, '');

// One or more allowed numbers, comma separated: TARGET_NUMBER=94771234567,94767654321
const TARGET_NUMBERS = [
    ...new Set(
        String(process.env.TARGET_NUMBER || '')
            .split(',')
            .map(digits)
            .filter(Boolean)
    )
];
if (!TARGET_NUMBERS.length) {
    console.error('❌ TARGET_NUMBER is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

// Optional extra WhatsApp IDs (e.g. "123456789@lid"), comma separated.
// Write "<number>=<id>" to say whose ID it is; a bare ID belongs to the first number.
const EXTRA_IDS = new Map(); // id -> number
for (const entry of String(process.env.TARGET_IDS || '').split(',')) {
    const s = entry.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    const num = eq > 0 ? digits(s.slice(0, eq)) : TARGET_NUMBERS[0];
    const id = eq > 0 ? s.slice(eq + 1).trim() : s;
    if (!TARGET_NUMBERS.includes(num)) {
        console.error(`❌ TARGET_IDS entry "${s}" names +${num}, which is not in TARGET_NUMBER.`);
        process.exit(1);
    }
    if (id) EXTRA_IDS.set(id, num);
}

const CHROME_PATH = process.env.CHROME_PATH || undefined; // unset = puppeteer's own Chromium
// Where the WhatsApp login is kept. On Railway/Render point this at a persistent volume.
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, '.wwebjs_auth');
const CLIENT_ID = 'zip-bot';
// Optional: the BOT's own number. When set, log in with an 8-character pairing code
// (typed on the bot's phone) instead of scanning a QR code.
const PAIRING_NUMBER = digits(process.env.PAIRING_NUMBER);
const HEADLESS = process.env.HEADLESS !== 'false';
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_SEC || 180) * 1000;
const MAX_ZIP_MB = Number(process.env.MAX_ZIP_MB || 100);
const MAX_ZIP_BYTES = MAX_ZIP_MB * 1024 * 1024;
const ACK_DELAY_MS = 3000; // wait for a burst of files to finish before replying once

const BOT_PREFIX = '🤖 ';
const ALLOWED_TYPES = new Set(['image', 'video', 'document', 'audio', 'ptt']);
const TYPE_PREFIX = { image: 'IMG', video: 'VID', document: 'DOC', audio: 'AUD', ptt: 'VOICE' };

// Formats that are already compressed: store them as-is (much faster, same size)
const ALREADY_COMPRESSED =
    /\.(jpe?g|png|gif|webp|heic|avif|mp4|mov|mkv|avi|webm|3gp|mp3|m4a|aac|ogg|opus|zip|rar|7z|gz|pdf|docx|xlsx|pptx)$/i;

const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
    'application/vnd.ms-powerpoint': 'ppt', 'text/plain': 'txt', 'text/csv': 'csv'
};

const WORK_DIR = path.join(__dirname, 'work');
const FILES_DIR = path.join(WORK_DIR, 'files');
const OUT_DIR = path.join(WORK_DIR, 'out');

// ---------------------------------------------------------------- state

// One queue per allowed number, so two people's files never mix
const queues = new Map(); // number -> queue

function getQueue(num) {
    let q = queues.get(num);
    if (!q) {
        q = {
            files: [], // { path, name, size }
            bytes: 0,
            usedNames: new Set(), // lower-case, so Windows case-insensitivity can't collide
            counters: {},
            ackTimer: null,
            newSinceAck: 0,
            filesDir: path.join(FILES_DIR, num),
            outDir: path.join(OUT_DIR, num)
        };
        queues.set(num, q);
    }
    return q;
}

function resetQueue(queue) {
    queue.files = [];
    queue.bytes = 0;
    queue.usedNames.clear();
    queue.counters = {};
    queue.newSinceAck = 0;
    if (queue.ackTimer) clearTimeout(queue.ackTimer);
    queue.ackTimer = null;
}

// ---------------------------------------------------------------- helpers

/** Make any string safe to use as a file name on Windows, macOS and Linux. */
function safeName(raw, maxLen = 120) {
    let n = String(raw || '')
        .normalize('NFC')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') // illegal chars + path separators
        .replace(/\s+/g, ' ')
        .replace(/^[.\s]+|[.\s]+$/g, '') // no leading dots (hidden/../), no trailing dots/spaces
        .slice(0, maxLen)
        .trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n; // Windows reserved names
    return n;
}

function extForMime(mime) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (MIME_EXT[m]) return MIME_EXT[m];
    const sub = m.split('/')[1] || '';
    return /^[a-z0-9]{1,5}$/.test(sub) ? sub : 'bin';
}

function uniqueName(queue, name) {
    const { name: base, ext } = path.parse(name);
    let candidate = name;
    let i = 2;
    while (queue.usedNames.has(candidate.toLowerCase())) candidate = `${base} (${i++})${ext}`;
    queue.usedNames.add(candidate.toLowerCase());
    return candidate;
}

function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------- client

const client = new Client({
    authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: SESSION_DIR }),
    puppeteer: {
        headless: HEADLESS,
        executablePath: CHROME_PATH,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run',
            // lighter on small servers
            '--disable-gpu', '--disable-extensions', '--mute-audio',
            '--disable-background-networking', '--disable-default-apps', '--disable-sync'
        ]
    },
    // How long WhatsApp Web may take to load. The library default (30s) is too short for
    // small shared-CPU servers, which then fail with "auth timeout".
    authTimeoutMs: AUTH_TIMEOUT_MS,
    ...(PAIRING_NUMBER && { pairWithPhoneNumber: { phoneNumber: PAIRING_NUMBER, showNotification: true } })
});

/** Send without marking the chat as seen (avoids a known WhatsApp Web error). */
async function say(chatId, text) {
    try {
        return await client.sendMessage(chatId, BOT_PREFIX + text, { sendSeen: false });
    } catch (e) {
        console.log('sendMessage failed:', e.message || e);
    }
}

// ---------------------------------------------------------------- who is allowed

const idCache = new Map(); // chatId -> { num, at }
const NEGATIVE_TTL_MS = 10 * 60 * 1000; // re-check "not target" after 10 min (in case a lookup failed)
const loggedIgnored = new Set();

const allowed = (n) => (TARGET_NUMBERS.includes(digits(n)) ? digits(n) : null);

/** Returns the allowed number this message came from, or null. */
async function senderNumber(msg) {
    const id = msg.from;
    if (!id || msg.fromMe) return null;
    if (id.endsWith('@g.us') || id.endsWith('@broadcast') || id.endsWith('@newsletter')) return null;

    if (id.endsWith('@c.us') && allowed(id.split('@')[0])) return allowed(id.split('@')[0]);
    if (EXTRA_IDS.has(id)) return EXTRA_IDS.get(id);

    const hit = idCache.get(id);
    if (hit && (hit.num || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.num;

    let num = null;
    try {
        const contact = await msg.getContact();
        if (contact) num = allowed(contact.number);

        // Newer WhatsApp "@lid" IDs hide the phone number; ask WhatsApp to map it back.
        if (!num && id.endsWith('@lid') && typeof client.getContactLidAndPhone === 'function') {
            const map = await client.getContactLidAndPhone([id]);
            if (map && map[0]) num = allowed(map[0].pn);
        }
    } catch (e) {
        console.log(`Could not resolve ${id}: ${e.message || e}`);
    }

    idCache.set(id, { num, at: Date.now() });
    if (num) console.log(`✔ ${id} identified as +${num}`);
    return num;
}

// ---------------------------------------------------------------- message handling

// whatsapp-web.js re-attaches its listeners whenever WhatsApp Web reloads inside the
// browser, so the same message can be emitted several times. Handle each id once.
const seenMsgIds = new Set();
const SEEN_MAX = 5000;

function firstTime(msg) {
    fixMessageId(msg);
    const key = msg.id && msg.id._serialized;
    if (!key) return true; // can't tell, so don't drop it
    if (seenMsgIds.has(key)) return false;
    seenMsgIds.add(key);
    if (seenMsgIds.size > SEEN_MAX) seenMsgIds.delete(seenMsgIds.values().next().value); // oldest
    return true;
}

// Handle messages strictly one at a time, in order
let chain = Promise.resolve();
client.on('message', (msg) => {
    if (!firstTime(msg)) return;
    chain = chain.then(() => handleMessage(msg)).catch((e) => console.error('Handler error:', e.stack || e));
});

async function handleMessage(msg) {
    const num = await senderNumber(msg);
    if (!num) {
        if (msg.from && !msg.from.endsWith('@g.us') && !loggedIgnored.has(msg.from)) {
            loggedIgnored.add(msg.from);
            console.log(`(ignored) ${msg.from}`);
        }
        return;
    }

    fixMessageId(msg);
    const chatId = msg.from;
    const queue = getQueue(num);

    if (msg.hasMedia) return handleMedia(msg, chatId, queue);

    const text = (msg.body || '').trim();
    if (!text) return;

    const cmd = text.toLowerCase();
    if (cmd === '/help' || cmd === '/start') return sendHelp(chatId);
    if (cmd === '/status') return sendStatus(chatId, queue);
    if (cmd === '/cancel') {
        const n = queue.files.length;
        resetQueue(queue);
        await clearDir(queue.filesDir);
        return say(chatId, n ? `Cancelled. ${n} file(s) discarded.` : 'Nothing to cancel.');
    }

    if (queue.files.length === 0) {
        return say(chatId, 'Send me some files first, then send a name and I\'ll zip them. (/help)');
    }

    const zipName = safeName(text, 100);
    if (!zipName) return say(chatId, 'That name has no usable characters. Try another name.');

    await zipAndSend(chatId, queue, zipName);
}

/**
 * Newer WhatsApp Web builds expose the serialized message id as "$1" instead of
 * "_serialized", so downloadMedia() looks up `undefined` and fails with "r".
 * https://github.com/wwebjs/whatsapp-web.js/issues/201830
 */
function fixMessageId(msg) {
    const id = msg.id;
    if (!id || id._serialized) return;
    id._serialized = id.$1 || `${id.fromMe}_${id.remote}_${id.id}`;
}

async function handleMedia(msg, chatId, queue) {
    if (!ALLOWED_TYPES.has(msg.type)) {
        return say(chatId, `Skipped a ${msg.type} — I only zip photos, videos, documents and audio.`);
    }

    let media;
    try {
        media = await withTimeout(msg.downloadMedia(), 5 * 60 * 1000, 'Download');
    } catch (e) {
        console.log(`downloadMedia failed (${msg.type}, id=${msg.id && msg.id._serialized}):`, e.stack || e);
    }
    if (!media || !media.data) {
        return say(chatId, 'Couldn\'t download one file. Please send it again.');
    }

    const buf = Buffer.from(media.data, 'base64');
    media.data = null; // free memory early

    if (queue.bytes + buf.length > MAX_ZIP_BYTES) {
        return say(
            chatId,
            `That file would push the ZIP over ${MAX_ZIP_MB} MB, so I skipped it.\n` +
                `Send a name now to zip the ${queue.files.length} file(s) you have, then send the rest.`
        );
    }

    // Build a safe, unique file name
    let name = safeName(media.filename);
    if (!name) {
        const prefix = TYPE_PREFIX[msg.type] || 'FILE';
        queue.counters[prefix] = (queue.counters[prefix] || 0) + 1;
        name = `${prefix}_${String(queue.counters[prefix]).padStart(3, '0')}`;
    }
    if (!path.extname(name)) name += '.' + extForMime(media.mimetype);
    name = uniqueName(queue, name);

    await fsp.mkdir(queue.filesDir, { recursive: true });
    const filePath = path.join(queue.filesDir, name);
    await fsp.writeFile(filePath, buf);

    queue.files.push({ path: filePath, name, size: buf.length });
    queue.bytes += buf.length;
    queue.newSinceAck++;
    console.log(`💾 ${name} (${fmtSize(buf.length)}) — ${queue.files.length} queued`);

    // One reply per burst of files instead of one per file
    if (queue.ackTimer) clearTimeout(queue.ackTimer);
    queue.ackTimer = setTimeout(() => {
        queue.ackTimer = null;
        const added = queue.newSinceAck;
        queue.newSinceAck = 0;
        if (!queue.files.length) return;
        say(
            chatId,
            `Got ${added} file(s). Queue: ${queue.files.length} file(s), ${fmtSize(queue.bytes)}.\n` +
                'Send a name for the ZIP, or /cancel.'
        );
    }, ACK_DELAY_MS);
}

async function zipAndSend(chatId, queue, zipName) {
    if (queue.ackTimer) clearTimeout(queue.ackTimer);
    queue.ackTimer = null;

    const files = [...queue.files];
    const zipPath = path.join(queue.outDir, `${zipName}.zip`);
    console.log(`🚀 Zipping ${files.length} file(s) → ${zipName}.zip`);

    try {
        await say(chatId, `Zipping ${files.length} file(s) into "${zipName}.zip"...`);
        await fsp.mkdir(queue.outDir, { recursive: true });
        const size = await createZip(files, zipPath);

        if (size > MAX_ZIP_BYTES) throw new Error(`ZIP is ${fmtSize(size)}, over the ${MAX_ZIP_MB} MB limit`);

        const zipMedia = MessageMedia.fromFilePath(zipPath);
        await client.sendMessage(chatId, zipMedia, {
            sendSeen: false,
            sendMediaAsDocument: true,
            caption: `${BOT_PREFIX}${zipName}.zip — ${files.length} file(s), ${fmtSize(size)}`
        });
        console.log(`✅ Sent ${zipName}.zip (${fmtSize(size)})`);
    } catch (err) {
        console.error('ZIP error:', err.stack || err);
        await say(chatId, `Sorry, something went wrong making the ZIP: ${err.message || err}`);
    } finally {
        resetQueue(queue);
        await clearDir(queue.filesDir);
        await clearDir(queue.outDir);
    }
}

function createZip(files, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 6 } });

        output.on('close', () => resolve(archive.pointer()));
        output.on('error', reject);
        archive.on('error', reject);
        archive.on('warning', (e) => (e.code === 'ENOENT' ? console.warn(e) : reject(e)));

        archive.pipe(output);
        for (const f of files) {
            archive.file(f.path, { name: f.name, store: ALREADY_COMPRESSED.test(f.name) });
        }
        archive.finalize();
    });
}

function sendHelp(chatId) {
    return say(
        chatId,
        'How to use me:\n' +
            '1. Send photos, videos, documents or audio.\n' +
            '2. Send a text message — it becomes the ZIP name.\n' +
            '3. I send back <name>.zip.\n\n' +
            '/status – what\'s queued\n/cancel – discard queued files\n/help – this message\n\n' +
            `Max ZIP size: ${MAX_ZIP_MB} MB.`
    );
}

function sendStatus(chatId, queue) {
    if (!queue.files.length) return say(chatId, 'Queue is empty. Send some files.');
    const list = queue.files
        .slice(0, 30)
        .map((f, i) => `${i + 1}. ${f.name} (${fmtSize(f.size)})`)
        .join('\n');
    const more = queue.files.length > 30 ? `\n...and ${queue.files.length - 30} more` : '';
    return say(chatId, `${queue.files.length} file(s), ${fmtSize(queue.bytes)}:\n${list}${more}`);
}

async function clearDir(dir) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------- lifecycle

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('\nScan this QR code with the WhatsApp account the bot should run on');
    console.log('(WhatsApp → Settings → Linked devices → Link a device).');
});
client.on('code', (code) => {
    const pretty = String(code).replace(/^(.{4})(.{4})$/, '$1-$2');
    console.log(`\n🔑 Pairing code for +${PAIRING_NUMBER}:  ${pretty}`);
    console.log('On the bot\'s phone: WhatsApp → Settings → Linked devices → Link a device →');
    console.log('"Link with phone number instead" → enter this code. A new code comes every 3 minutes.');
});
// The same re-attach also repeats "authenticated"/"ready"; log each once per burst
const lastLogged = {};
function logOnce(key, text, windowMs = 30 * 1000) {
    if (lastLogged[key] && Date.now() - lastLogged[key] < windowMs) return;
    lastLogged[key] = Date.now();
    console.log(text);
}

let readyWatchdog = null;
client.on('authenticated', () => {
    logOnce('auth', '🔐 Authenticated');
    // whatsapp-web.js swallows errors between "authenticated" and "ready", so if
    // ready never comes, probe each startup step ourselves and report what broke.
    if (readyWatchdog) clearTimeout(readyWatchdog);
    readyWatchdog = setTimeout(diagnoseStuckStartup, 60 * 1000);
});
client.on('loading_screen', (percent) => console.log(`⏳ Loading ${percent}%`));

async function diagnoseStuckStartup() {
    console.log('⚠️ Still not ready 60s after authenticating. Checking startup steps...');
    try {
        const report = await client.pupPage.evaluate(() => {
            const out = {
                waVersion: window.Debug && window.Debug.VERSION,
                wwebjsInjected: !!window.WWebJS,
                // first and last hooks attachEventListeners() registers: shows how far it got
                firstListener: typeof window.onAddMessageEvent,
                lastListener: typeof window.onPollVoteEvent
            };
            const tryStep = (name, fn) => {
                try {
                    const v = fn();
                    out[name] = v === undefined ? 'ok (undefined)' : 'ok';
                } catch (e) {
                    out[name] = 'FAILED: ' + (e && (e.stack || e.message) || e);
                }
            };
            tryStep('WAWebConnModel.Conn.serialize', () => window.require('WAWebConnModel').Conn.serialize());
            tryStep('WAWebUserPrefsMeUser', () => {
                const m = window.require('WAWebUserPrefsMeUser');
                return m.getMaybeMePnUser() || m.getMaybeMeLidUser();
            });
            tryStep('WAWebCollections.Msg', () => window.require('WAWebCollections').Msg);
            tryStep('WAWebCollections.Chat', () => window.require('WAWebCollections').Chat);
            return out;
        });
        console.log('Startup diagnosis:', JSON.stringify(report, null, 2));
    } catch (e) {
        console.log('Startup diagnosis failed:', e.stack || e);
    }
}
client.on('auth_failure', (m) => console.error('❌ Auth failure:', m));
client.on('disconnected', (r) => {
    console.log('⚠️ Disconnected:', r);
    process.exit(1); // let a process manager (pm2 / nodemon / a loop) restart it
});
client.on('ready', () => {
    if (readyWatchdog) clearTimeout(readyWatchdog);
    logOnce('ready', `✅ Ready. Only responding to ${TARGET_NUMBERS.map((n) => '+' + n).join(', ')}`);
});

async function shutdown() {
    console.log('\nShutting down...');
    try {
        await client.destroy();
    } catch (_) {}
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
    await clearDir(WORK_DIR); // leftovers from a previous run
    // A container that was killed leaves Chromium's profile locks on the volume, and the
    // next start then refuses with "profile appears to be in use". Nothing else uses it.
    const profile = path.join(SESSION_DIR, `session-${CLIENT_ID}`);
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        await fsp.rm(path.join(profile, f), { force: true }).catch(() => {});
    }
    console.log('Starting WhatsApp client...');
    client.initialize().catch((e) => {
        // e.g. WhatsApp Web not fully loaded on a cold start; Docker/pm2 restarts us
        console.error('❌ Startup failed, exiting so it restarts:', e.stack || e);
        process.exit(1);
    });
})();
