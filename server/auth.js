// Run once: node auth.js
// Opens browser for Google authorization and saves refresh_token to .env
require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:4000/callback';
const ENV_FILE = path.join(__dirname, '.env');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\nOpening browser for Google authorization...');
console.log('If the browser does not open, paste this URL manually:\n');
console.log(authUrl + '\n');

// Try to open browser automatically
const { exec } = require('child_process');
exec('start "" "' + authUrl + '"');

// Temporary HTTP server to catch the redirect
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/callback') return;

  const code = parsed.query.code;
  if (!code) {
    res.end('No code received. Please try again.');
    server.close();
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      res.end('No refresh token received. Try revoking access at myaccount.google.com/permissions and running auth.js again.');
      server.close();
      return;
    }

    // Write GOOGLE_REFRESH_TOKEN into .env
    let envContent = fs.readFileSync(ENV_FILE, 'utf8');
    if (/^GOOGLE_REFRESH_TOKEN=.*/m.test(envContent)) {
      envContent = envContent.replace(/^GOOGLE_REFRESH_TOKEN=.*/m, 'GOOGLE_REFRESH_TOKEN=' + refreshToken);
    } else {
      envContent += '\nGOOGLE_REFRESH_TOKEN=' + refreshToken;
    }
    fs.writeFileSync(ENV_FILE, envContent);

    res.end('<h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>');
    console.log('\nRefresh token saved to .env successfully!');
    console.log('You can now start the server: node server.js\n');
    server.close();
  } catch (e) {
    res.end('Error getting token: ' + e.message);
    console.error('Error:', e.message);
    server.close();
  }
});

server.listen(4000, () => {
  console.log('Waiting for authorization on http://localhost:4000/callback ...\n');
});
