/**
 * Local fixes for whatsapp-web.js 1.34.7 against current WhatsApp Web.
 * Runs on `npm install` (postinstall). Each patch is skipped if already applied
 * or if the library code changed (then it just warns).
 *
 * 1. Message.js: downloadAndMaybeDecrypt() is called without a mimetype, so
 *    WhatsApp Web rejects every uncached download with the opaque error "r".
 *    https://github.com/wwebjs/whatsapp-web.js/issues/201908
 * 2. Utils.js: MediaData's private __x_id overwrites the outgoing Msg id, so
 *    sending any media fails with "Data passed to getter must include an id".
 *    https://github.com/wwebjs/whatsapp-web.js/issues/201922
 * 3. Puppeteer.js + Client.js: page.exposeFunction can fail with "Target closed"
 *    during startup; the error is swallowed and "ready" never fires. Retry it,
 *    and log any remaining attachEventListeners failure.
 *    https://github.com/wwebjs/whatsapp-web.js/issues/201946
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src');

const patches = [
    {
        name: 'download mimetype',
        file: path.join(root, 'structures', 'Message.js'),
        done: /type: msg\.type,\s*mimetype: msg\.mimetype,/,
        re: /(\r?\n)(\s*)(type: msg\.type,)(\r?\n\s*signal: new AbortController\(\)\.signal,)/,
        to: '$1$2$3$1$2mimetype: msg.mimetype,$4'
    },
    {
        name: 'media send __x_id',
        file: path.join(root, 'util', 'Injected', 'Utils.js'),
        done: /delete message\.__x_id/,
        re: /(\r?\n)(\s*\.\.\.extraOptions,\r?\n\s*\};)(\r?\n\r?\n\s*\/\/ Bot's won't reply)/,
        to:
            '$1$2$1' +
            "$1        // MediaData's private __x_id collides with Msg's id when spread (wwebjs#201922)" +
            '$1        if (message.__x_id) delete message.__x_id;' +
            '$1        message.id = newMsgKey;$3'
    },
    {
        name: 'exposeFunction retry',
        file: path.join(root, 'util', 'Puppeteer.js'),
        done: /wwebjs#201946/,
        re: /async function exposeFunctionIfAbsent\(page, name, fn\) \{\n[\s\S]*?\n    await page\.exposeFunction\(name, fn\);\n\}/,
        // a function, so "$" in the code isn't treated as a replacement pattern
        to: () => `async function exposeFunctionIfAbsent(page, name, fn) {
    // Retry on "Target closed": a short-lived pdf-viewer iframe can close mid-call
    // and silently stop "ready" from firing (wwebjs#201946)
    for (let attempt = 1; ; attempt++) {
        try {
            const exist = await page.evaluate((name) => !!window[name], name);
            if (exist) return;
            await page.exposeFunction(name, fn);
            return;
        } catch (err) {
            const msg = String((err && err.message) || err);
            if (/already exists/i.test(msg)) return; // an earlier attempt got through
            if (!/Target closed/i.test(msg) || attempt >= 5) throw err;
            await new Promise((r) => setTimeout(r, 250));
        }
    }
}`
    },
    {
        name: 'log attachEventListeners errors',
        file: path.join(root, 'Client.js'),
        done: /attachEventListeners failed/,
        re: /\n([ \t]*)await this\.attachEventListeners\(\);\n/,
        to: (_, i) => `
${i}try {
${i}    await this.attachEventListeners();
${i}} catch (err) {
${i}    // otherwise swallowed and "ready" never fires (wwebjs#201946)
${i}    console.error('attachEventListeners failed:', err);
${i}    throw err;
${i}}
`
    }
];

for (const p of patches) {
    if (!fs.existsSync(p.file)) continue;
    const src = fs.readFileSync(p.file, 'utf8');
    if (p.done.test(src)) {
        console.log(`whatsapp-web.js patch "${p.name}" already applied`);
    } else if (!p.re.test(src)) {
        console.warn(`⚠ whatsapp-web.js patch "${p.name}": pattern not found, skipped (library changed?)`);
    } else {
        fs.writeFileSync(p.file, src.replace(p.re, p.to));
        console.log(`✔ whatsapp-web.js patch "${p.name}" applied`);
    }
}
