const path = require('node:path');

// npm runs Puppeteer's installer before index.js, so load .env here too.
// On a fresh install dotenv may not be unpacked yet; env vars still work then.
try {
    require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
} catch (_) {}

const executablePath = process.env.CHROME_PATH || undefined;

module.exports = {
    executablePath,
    // Keep the normal bundled-browser setup when CHROME_PATH is unset.
    skipDownload: Boolean(executablePath)
};
