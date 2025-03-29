const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Use stealth plugin to help avoid detection
puppeteer.use(StealthPlugin());

// Create Express app
const app = express();
const PORT = process.env.PORT || 10000;

// Debug logging control
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';

// Queue system for managing session access
const sessionBusy = {};       // Tracks if a session is busy with maintenance or requests
const sessionQueues = {};     // Queues for each session
const MAX_QUEUE_TIME = 30000; // Maximum wait time (30 seconds)

// Session tracking
let lastSessionsHash = '';  // For efficient session saving

// Function to log debug messages
function logDebug(message) {
  if (DEBUG_LOGGING) {
    console.log(message);
  }
}

// Self-ping mechanism to prevent Render from spinning down
// Render free tier spins down after 15 minutes of inactivity
const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
const SERVICE_URL = process.env.SERVICE_URL || 'https://trade-republic-api.onrender.com';

// Function to ping our own service
function pingService() {
  console.log(`[${new Date().toISOString()}] Pinging service to prevent spin-down: ${SERVICE_URL}`);
  
  const url = new URL(SERVICE_URL);
  const options = {
    hostname: url.hostname,
    port: url.protocol === 'https:' ? 443 : 80,
    path: '/api/ping',
    method: 'GET',
    headers: {
      'x-api-key': process.env.API_KEY || 'a1b2c3d4e5f6g7h8i9j0'
    }
  };
  
  const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        logDebug(`Ping response: ${res.statusCode} ${data}`);
      } catch (e) {
        logDebug(`Ping response: ${res.statusCode}`);
      }
    });
  });
  
  req.on('error', (error) => {
    console.error(`Error pinging service: ${error.message}`);
  });
  
  req.end();
}

// Start the ping interval
console.log(`Setting up self-ping every ${PING_INTERVAL/60000} minutes to prevent spin-down`);
setInterval(pingService, PING_INTERVAL);

// Configure middleware
app.use(bodyParser.json());

// IMPORTANT: Fix for Render's proxy environment
app.set('trust proxy', 1);

// Session storage
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json');
const SESSION_SAVE_INTERVAL = 10 * 60 * 1000; // 10 minutes

// Create sessions directory if it doesn't exist
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory sessions object
const sessions = {};

// API key middleware
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.API_KEY || 'a1b2c3d4e5f6g7h8i9j0';
  
  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }
  
  next();
};

// Rate limiting to prevent abuse (15 requests per hour)
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15, // 15 requests per hour
  message: { error: 'Too many requests, please try again later' }
});

// Apply API key auth to all routes except ping
app.use((req, res, next) => {
  if (req.path === '/api/ping') {
    return next();
  }
  apiKeyAuth(req, res, next);
});

// Load saved sessions if available
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const savedSessionsData = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const savedSessions = JSON.parse(savedSessionsData);
    console.log(`Found ${Object.keys(savedSessions).length} saved sessions`);
    
    // Store session metadata for restoration
    Object.keys(savedSessions).forEach(sessionId => {
      sessions[sessionId] = {
        ...savedSessions[sessionId],
        browser: null,
        page: null,
        needsRestore: true
      };
    });
  }
} catch (error) {
  console.error(`Error loading saved sessions: ${error.message}`);
}

// Queue management functions
function queueSessionRequest(sessionId, handlerFunction, res) {
  // Initialize queue if it doesn't exist
  if (!sessionQueues[sessionId]) {
    sessionQueues[sessionId] = [];
  }
  
  // Add request to queue
  const queuedRequest = {
    handler: handlerFunction,
    queuedAt: Date.now(),
    expiresAt: Date.now() + MAX_QUEUE_TIME,
    res
  };
  
  sessionQueues[sessionId].push(queuedRequest);
  
  console.log(`Request queued for session ${sessionId}. Queue length: ${sessionQueues[sessionId].length}`);
  
  // If this is the first request and session is not busy, process it immediately
  if (sessionQueues[sessionId].length === 1 && !sessionBusy[sessionId]) {
    processNextQueuedRequest(sessionId);
  }
}

async function processNextQueuedRequest(sessionId) {
  // If queue is empty or session doesn't exist, nothing to do
  if (!sessionQueues[sessionId] || sessionQueues[sessionId].length === 0 || !sessions[sessionId]) {
    return;
  }
  
  // If session is busy, wait for it to become available
  if (sessionBusy[sessionId]) {
    console.log(`Session ${sessionId} is busy, will check again in 1 second...`);
    setTimeout(() => processNextQueuedRequest(sessionId), 1000);
    return;
  }
  
  // Get next request from queue
  const request = sessionQueues[sessionId][0];
  
  // Check if request has expired
  if (Date.now() > request.expiresAt) {
    console.log(`Request for session ${sessionId} expired in queue.`);
    sessionQueues[sessionId].shift(); // Remove expired request
    
    // Send timeout response
    if (!request.res.headersSent) {
      request.res.status(408).json({
        success: false,
        error: 'Request timed out waiting in queue'
      });
    }
    
    // Process next request
    processNextQueuedRequest(sessionId);
    return;
  }
  
  // Mark session as busy
  sessionBusy[sessionId] = true;
  
  try {
    // Remove request from queue
    sessionQueues[sessionId].shift();
    
    // Process the request
    console.log(`Processing queued request for session ${sessionId}. Wait time: ${(Date.now() - request.queuedAt)/1000}s`);
    await request.handler();
  } catch (error) {
    console.error(`Error processing queued request for session ${sessionId}: ${error.message}`);
    
    // Handle response error if not already sent
    if (!request.res.headersSent) {
      request.res.status(500).json({
        success: false,
        error: `Server error: ${error.message}`
      });
    }
  } finally {
    // Mark session as available
    sessionBusy[sessionId] = false;
    
    // Process next request if any
    if (sessionQueues[sessionId] && sessionQueues[sessionId].length > 0) {
      processNextQueuedRequest(sessionId);
    }
  }
}

// Save sessions to file - improved version
function saveSessionsToFile() {
  try {
    // Create a version of sessions without browser/page objects
    const sessionsToSave = {};
    
    Object.keys(sessions).forEach(sessionId => {
      const { browser, page, ...sessionData } = sessions[sessionId];
      sessionsToSave[sessionId] = sessionData;
    });
    
    // Check if sessions have actually changed before saving
    const currentHash = JSON.stringify(sessionsToSave);
    if (currentHash === lastSessionsHash) {
      // Sessions haven't changed, no need to write to disk
      return;
    }
    
    // Save updated sessions and update hash
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsToSave, null, 2));
    lastSessionsHash = currentHash;
    
    // Only log when debugging is enabled
    if (DEBUG_LOGGING) {
      console.log(`Saved ${Object.keys(sessionsToSave).length} sessions to ${SESSIONS_FILE}`);
    }
  } catch (error) {
    console.error(`Error saving sessions: ${error.message}`);
  }
}

// Force save sessions
function forceSaveSession() {
  logDebug("Forcing session save");
  saveSessionsToFile();
}

// Save sessions less frequently
setInterval(saveSessionsToFile, SESSION_SAVE_INTERVAL);

// AUTOMATIC PAGE REFRESH WITH SITE NAVIGATION - EVERY 8 MINUTES
const AUTO_REFRESH_INTERVAL = 8 * 60 * 1000; // 8 minutes

// Restore a session
async function restoreSession(sessionId) {
  try {
    const session = sessions[sessionId];
    
    if (!session) {
      console.log(`Session ${sessionId} not found, cannot restore`);
      return false;
    }
    
    if (!session.credentials || !session.credentials.phoneNumber || !session.credentials.pin) {
      console.log(`Session ${sessionId} has no credentials, cannot restore`);
      return false;
    }
    
    console.log(`Restoring session ${sessionId}...`);
    
    // Set up new browser
    const browser = await setupBrowser();
    if (!browser) {
      console.log(`Failed to create browser for session ${sessionId}`);
      return false;
    }
    
    // Create new page
    const pages = await browser.pages();
    const page = pages[0];
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate to Trade Republic
    await page.goto("https://app.traderepublic.com/portfolio", { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Login
    const loginResult = await loginToTradeRepublic(page, session.credentials);
    
    if (loginResult.success) {
      console.log(`✅ Successfully restored session ${sessionId}`);
      
      // Update session with new browser and page
      session.browser = browser;
      session.page = page;
      session.lastActivity = Date.now();
      session.needsRestore = false;
      
      return true;
    } else if (loginResult.needs2FA) {
      console.log(`❌ Cannot automatically restore session ${sessionId} - 2FA required`);
      
      // Close browser
      try {
        await browser.close();
      } catch (error) {
        console.log(`Error closing browser: ${error.message}`);
      }
      
      return false;
    } else {
      console.log(`❌ Failed to restore session ${sessionId}: ${loginResult.error}`);
      
      // Close browser
      try {
        await browser.close();
      } catch (error) {
        console.log(`Error closing browser: ${error.message}`);
      }
      
      return false;
    }
  } catch (error) {
    console.log(`Error restoring session ${sessionId}: ${error.message}`);
    return false;
  }
}

// Function to simulate user activity by navigating through the app
async function simulateUserActivity(page) {
  try {
    console.log("Simulating user activity with page navigation...");
    
    // Check if we are already on the portfolio page
    const currentUrl = await page.url();
    if (!currentUrl.includes('/portfolio')) {
      console.log("Not on portfolio page, navigating there first...");
      await page.goto("https://app.traderepublic.com/portfolio", { 
        waitUntil: 'networkidle2',
        timeout: 15000
      });
      await sleep(1000);
    }
    
    // Navigate to transactions page
    console.log("Navigating to transactions page...");
    const transactionsLink = await page.$('a.navigationItem__link[href="/profile/transactions"]');
    
    if (transactionsLink) {
      await transactionsLink.click();
      console.log("Clicked transactions link");
      await sleep(2000); // Wait for transactions page to load
    } else {
      console.log("Transactions link not found, trying direct navigation...");
      await page.goto("https://app.traderepublic.com/profile/transactions", {
        waitUntil: 'networkidle2',
        timeout: 15000
      });
      await sleep(2000);
    }
    
    // Navigate back to portfolio page
    console.log("Navigating back to portfolio page...");
    await page.goto("https://app.traderepublic.com/portfolio", {
      waitUntil: 'networkidle2',
      timeout: 15000
    });
    await sleep(1000);
    
    console.log("User activity simulation completed");
    return true;
  } catch (error) {
    console.log(`Error simulating user activity: ${error.message}`);
    return false;
  }
}

// Start automatic session refresh
console.log(`Setting up automatic page refresh with navigation every ${AUTO_REFRESH_INTERVAL/60000} minutes to prevent session timeouts`);
setInterval(async () => {
  console.log(`[${new Date().toISOString()}] Running automatic page refresh with navigation...`);
  
  for (const sessionId in sessions) {
    const session = sessions[sessionId];
    
    // Skip if session has queued user requests or is already busy
    if (sessionBusy[sessionId]) {
      console.log(`Skipping refresh for session ${sessionId} - session is busy`);
      continue;
    }
    
    if (sessionQueues[sessionId] && sessionQueues[sessionId].length > 0) {
      console.log(`Skipping refresh for session ${sessionId} - has ${sessionQueues[sessionId].length} queued requests`);
      continue;
    }
    
    // Mark session as busy with maintenance
    sessionBusy[sessionId] = true;
    
    try {
      // Check if session needs to be restored (after server restart)
      if (session.needsRestore) {
        const restored = await restoreSession(sessionId);
        if (!restored) {
          console.log(`Failed to restore session ${sessionId}, will retry later`);
          sessionBusy[sessionId] = false;
          continue;
        }
      }
      
      console.log(`Running maintenance for session ${sessionId}...`);
      
      // Get the page from the session
      const page = session.page;
      
      if (!page) {
        console.log(`No page for session ${sessionId}, skipping`);
        sessionBusy[sessionId] = false;
        continue;
      }
      
      // Check if still logged in
      const isLoggedIn = await checkIfLoggedIn(page);
      
      if (!isLoggedIn) {
        console.log(`⚠️ Session ${sessionId} is not logged in, attempting to re-login...`);
        
        // Try automatic re-login
        const credentials = session.credentials;
        
        if (credentials && credentials.phoneNumber && credentials.pin) {
          console.log("Attempting automatic re-login...");
          
          // Navigate to Trade Republic
          await page.goto("https://app.traderepublic.com/portfolio", { 
            waitUntil: 'networkidle2',
            timeout: 30000
          });
          
          // Login again
          const loginResult = await loginToTradeRepublic(page, credentials);
          
          if (loginResult.success) {
            console.log(`✅ Automatic re-login successful for session ${sessionId}`);
            session.lastActivity = Date.now();
          } else if (loginResult.needs2FA) {
            console.log(`❌ Automatic re-login failed - 2FA required for session ${sessionId}`);
            // Keep the session, we'll try again later
          } else {
            console.log(`❌ Automatic re-login failed for session ${sessionId}`);
            // Keep the session, we'll try again later
          }
        } else {
          console.log(`No credentials for session ${sessionId}, can't reconnect`);
        }
      } else {
        console.log(`✅ Session ${sessionId} is logged in, simulating user activity...`);
        
        // Simulate user activity by navigating to different pages
        await simulateUserActivity(page);
        
        // Update last activity timestamp
        session.lastActivity = Date.now();
        console.log(`✅ Maintenance completed for session ${sessionId}`);
      }
    } catch (error) {
      console.log(`Error maintaining session ${sessionId}: ${error.message}`);
    } finally {
      // Always release the session when maintenance is done
      sessionBusy[sessionId] = false;
      
      // Check if there are queued requests to process now
      if (sessionQueues[sessionId] && sessionQueues[sessionId].length > 0) {
        console.log(`Maintenance completed for ${sessionId}, processing ${sessionQueues[sessionId].length} queued requests`);
        processNextQueuedRequest(sessionId);
      }
    }
  }
  
  console.log(`[${new Date().toISOString()}] Page refresh with navigation completed`);
  
  // Save sessions to file after maintenance
  saveSessionsToFile();
  
}, AUTO_REFRESH_INTERVAL);

// Cleanup stale sessions only after 30 days of inactivity
setInterval(() => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  
  Object.keys(sessions).forEach(sessionId => {
    const session = sessions[sessionId];
    // Only close extremely old sessions (30 days)
    if (now - session.lastActivity > thirtyDays) {
      console.log(`Closing very old session: ${sessionId}`);
      try {
        if (session.browser) {
          session.browser.close();
        }
      } catch (error) {
        console.error(`Error closing browser: ${error.message}`);
      }
      delete sessions[sessionId];
    }
  });
  
  // Save sessions to file after cleanup
  saveSessionsToFile();
  
}, 24 * 60 * 60 * 1000); // Run once per day

// Helper functions

// Simplified sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fast typing function
async function fastType(page, selector, text) {
  logDebug(`Typing into ${selector}...`);
  await page.focus(selector);
  await page.keyboard.type(text, {delay: 0});
  logDebug("Typing complete");
}

// Wait for element function
async function waitForElement(page, selector, timeout = 5000, description = "element") {
  try {
    logDebug(`👀 Looking for: ${description}`);
    const element = await page.waitForSelector(selector, { 
      visible: true, 
      timeout: timeout 
    });
    
    if (element) {
      logDebug(`✅ Found: ${description}`);
      return element;
    } else {
      logDebug(`⚠️ Element found but may not be visible: ${description}`);
      return null;
    }
  } catch (error) {
    logDebug(`❌ Could not find: ${description} - ${error.message}`);
    return null;
  }
}

// Setup browser for headless environment
async function setupBrowser() {
  console.log("Setting up browser in headless mode...");
  
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-sandbox',
        '--disable-gpu',
        '--window-size=1200,800',
        '--incognito',
      ],
      defaultViewport: null
    });
    
    return browser;
  } catch (error) {
    console.log(`Error setting up browser: ${error.message}`);
    
    // Fallback with minimal settings
    console.log("Trying with minimal settings...");
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--incognito'],
        defaultViewport: null
      });
      return browser;
    } catch (fallbackError) {
      console.log(`Fallback browser setup also failed: ${fallbackError.message}`);
      return null;
    }
  }
}

// Check if already logged in
async function checkIfLoggedIn(page) {
  try {
    logDebug("Checking login status...");
    
    // Check URL first (most reliable indicator)
    const currentUrl = await page.url();
    if (currentUrl.includes('/portfolio') || 
        currentUrl.includes('/dashboard') || 
        currentUrl.includes('/timeline') ||
        currentUrl.includes('/profile')) {
      logDebug("✅ Already logged in (based on URL)");
      return true;
    }
    
    // Check for login phone input - if present, we are NOT logged in
    const hasPhoneInput = await page.evaluate(() => {
      return !!document.querySelector('#loginPhoneNumber__input');
    });
    
    if (hasPhoneInput) {
      logDebug("❌ Found phone number input - not logged in");
      return false;
    }
    
    // Now check for logged in indicators
    const loggedInIndicators = [
      ".currencyStatus",
      ".portfolioInstrumentList",
      "[class*='portfolioValue']",
      "[class*='dashboard']",
      "[class*='portfolio']",
      "[class*='cashAccount']"
    ];
    
    for (const selector of loggedInIndicators) {
      try {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await page.evaluate(el => {
            const style = window.getComputedStyle(el);
            return style && style.display !== 'none' && style.visibility !== 'hidden';
          }, element);
          
          if (isVisible) {
            logDebug("✅ Already logged in");
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // Check for PIN input field - this means we're still logged in but need PIN
    const hasPinInput = await page.evaluate(() => {
      return !!document.querySelector('fieldset#loginPin__input');
    });
    
    if (hasPinInput) {
      // If PIN input is showing, we're still logged in but need to enter PIN
      console.log("Found PIN re-authentication prompt - session needs PIN");
      return false; // We'll handle this as "not logged in" so the maintenance flow will re-login
    }
    
    logDebug("No login indicators found");
    return false;
  } catch (error) {
    console.log(`Error checking login status: ${error.message}`);
    return false;
  }
}

// Handle cookie consent
async function handleCookieConsent(page) {
  try {
    logDebug("Checking for cookie consent dialog...");
    
    const cookieSelectors = [
      "button.buttonBase.consentCard__action.buttonPrimary",
      ".buttonBase.consentCard__action.buttonPrimary",
      "[data-testid='cookie-banner-accept']",
      ".cookie-banner__accept"
    ];
    
    for (const selector of cookieSelectors) {
      try {
        const cookieButton = await page.$(selector);
        if (cookieButton) {
          logDebug(`Found cookie button: ${selector}`);
          await cookieButton.click();
          logDebug("✅ Accepted cookies");
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    logDebug("No cookie consent dialog found");
    return false;
  } catch (error) {
    console.log(`Error handling cookie consent: ${error.message}`);
    return false;
  }
}

// Enter phone number
async function enterPhoneNumber(page, phoneNumber) {
  try {
    logDebug("Starting phone number entry...");
    
    // Wait for phone number field
    const phoneField = await waitForElement(
      page, 
      "#loginPhoneNumber__input", 
      10000, 
      "phone number field"
    );
    
    if (!phoneField) {
      console.log("❌ Phone number field not found");
      return false;
    }
    
    // Clear field just in case
    await page.evaluate(() => {
      const input = document.querySelector("#loginPhoneNumber__input");
      if (input) input.value = '';
    });
    
    // Fast type phone number - no delays
    console.log(`Entering phone number: ${phoneNumber.substring(0, 2)}***`);
    await fastType(page, "#loginPhoneNumber__input", phoneNumber);
    
    // Try to find next button
    logDebug("Looking for next button...");
    
    const nextButtonSelectors = [
      "button.buttonBase.loginPhoneNumber__action.buttonPrimary",
      ".buttonBase.loginPhoneNumber__action",
      "[data-testid='login-phone-next']"
    ];
    
    let clicked = false;
    
    for (const selector of nextButtonSelectors) {
      try {
        // Wait specifically for this button
        const nextButton = await waitForElement(page, selector, 5000, `next button (${selector})`);
        
        if (nextButton) {
          logDebug(`Clicking next button: ${selector}`);
          await nextButton.click();
          
          logDebug("✅ Clicked next button");
          clicked = true;
          
          // Brief wait for next page to load
          await sleep(500);
          break;
        }
      } catch (error) {
        logDebug(`Error with button ${selector}: ${error.message}`);
      }
    }
    
    if (!clicked) {
      console.log("❌ Could not find or click any next button");
      return false;
    }
    
    return true;
  } catch (error) {
    console.log(`Error entering phone number: ${error.message}`);
    return false;
  }
}

// Enter PIN
async function enterPIN(page, pin) {
  try {
    logDebug("Starting PIN entry...");
    
    // Brief wait for PIN field to appear
    await sleep(500);
    
    // Try to find PIN input
    logDebug("Looking for PIN input fields...");
    
    // First try with specific class
    let pinInputs = await page.$$('fieldset#loginPin__input input.codeInput__character[type="password"]');
    
    // If not found, try more generic selector
    if (!pinInputs || pinInputs.length === 0) {
      logDebug("Trying alternative PIN selector...");
      pinInputs = await page.$$('#loginPin__input input[type="password"]');
    }
    
    // Last resort - try any password input
    if (!pinInputs || pinInputs.length === 0) {
      logDebug("Trying any password input as last resort...");
      pinInputs = await page.$$('input[type="password"]');
    }
    
    logDebug(`Found ${pinInputs.length} PIN input fields`);
    
    if (pinInputs.length === 0) {
      console.log("❌ No PIN input fields found");
      return false;
    }
    
    // Enter all digits rapidly
    if (pinInputs.length === 1) {
      // If only one input field for all digits
      await pinInputs[0].type(pin, {delay: 0});
    } else {
      // Enter each digit much faster
      for (let i = 0; i < pin.length && i < pinInputs.length; i++) {
        // Focus and type rapidly
        await pinInputs[i].click();
        await pinInputs[i].type(pin[i], {delay: 0});
      }
    }
    
    logDebug("✅ PIN entry complete");
    
    // Wait for PIN processing but reduced time
    logDebug("Waiting for PIN processing...");
    await sleep(1500);
    
    return true;
  } catch (error) {
    console.log(`Error entering PIN: ${error.message}`);
    return false;
  }
}

// Handle 2FA
async function handle2FA(page, twoFACode) {
  try {
    logDebug("Checking if 2FA is required...");
    
    // Check for 2FA input
    const is2FARequired = await page.evaluate(() => {
      return !!document.querySelector('#smsCode__input') || 
             !!document.querySelector('[class*="smsCode"]');
    });
    
    if (!is2FARequired) {
      logDebug("No 2FA required");
      return { success: true, needs2FA: false };
    }
    
    console.log("📱 2FA authentication required");
    
    if (!twoFACode) {
      console.log("No 2FA code provided, client needs to submit code");
      return { success: false, needs2FA: true };
    }
    
    // Wait for SMS code field
    const smsField = await waitForElement(page, "#smsCode__input", 5000, "2FA input field");
    
    if (!smsField) {
      console.log("❌ 2FA input field not found");
      return { success: false, needs2FA: true, error: "2FA input field not found" };
    }
    
    // Find SMS input fields
    const smsInputs = await page.$$('#smsCode__input input');
    
    if (smsInputs.length === 0) {
      console.log("❌ No 2FA input fields found");
      return { success: false, needs2FA: true, error: "No 2FA input fields found" };
    }
    
    // Enter SMS code instantly
    if (smsInputs.length === 1) {
      // Single input field - paste entire code
      await smsInputs[0].type(twoFACode, {delay: 0});
    } else {
      // Multiple input fields (one per digit) - type rapidly
      for (let i = 0; i < twoFACode.length && i < smsInputs.length; i++) {
        await smsInputs[i].type(twoFACode[i], {delay: 0});
      }
    }
    
    logDebug("✅ 2FA code entered");
    
    // Brief wait for processing
    await sleep(1000);
    
    return { success: true, needs2FA: false };
  } catch (error) {
    console.log(`Error handling 2FA: ${error.message}`);
    return { success: false, needs2FA: true, error: error.message };
  }
}

// Login to Trade Republic
async function loginToTradeRepublic(page, credentials) {
  try {
    console.log("\n📱 Starting Trade Republic login process...");
    
    const { phoneNumber, pin, twoFACode } = credentials;
    
    if (!phoneNumber || !pin) {
      console.log("❌ Missing required credentials");
      return { success: false, error: "Missing credentials" };
    }
    
    console.log(`Using phone number: ${phoneNumber.substring(0, 2)}***`);
    
    // Check if already logged in
    if (await checkIfLoggedIn(page)) {
      return { success: true };
    }
    
    // Handle cookie consent if present
    await handleCookieConsent(page);
    
    // Enter phone number and proceed
    const phoneSuccess = await enterPhoneNumber(page, phoneNumber);
    
    if (!phoneSuccess) {
      console.log("❌ Failed during phone number entry");
      return { success: false, error: "Failed during phone number entry" };
    }
    
    // Enter PIN code
    const pinSuccess = await enterPIN(page, pin);
    
    if (!pinSuccess) {
      console.log("❌ Failed during PIN entry");
      return { success: false, error: "Failed during PIN entry" };
    }
    
    // Handle 2FA if needed
    const twoFAResult = await handle2FA(page, twoFACode);
    
    if (twoFAResult.needs2FA) {
      console.log("2FA required but not completed");
      return { 
        success: false, 
        needs2FA: true, 
        error: "2FA code required" 
      };
    }
    
    // Wait for login to complete
    console.log("Waiting for login to complete...");
    await sleep(2000);
    
    // Final check to verify login success
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (isLoggedIn) {
      console.log("✅ Successfully logged in!");
      return { success: true };
    } else {
      console.log("❌ Login verification failed");
      console.log("Current URL: " + await page.url());
      return { 
        success: false, 
        error: "Login verification failed" 
      };
    }
  } catch (error) {
    console.log(`❌ Login process error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Function to click dropdown
async function clickSinceBuyEuroOption(page) {
  try {
    console.log("\n🔄 Setting view to 'Since buy (€)'...");
    
    // Find and click dropdown button
    console.log("Looking for dropdown button...");
    const dropdownButtonSelector = ".dropdownList__openButton";
    try {
      await page.click(dropdownButtonSelector);
      console.log("✅ Clicked dropdown button");
    } catch (clickError) {
      console.log(`❌ Failed to click dropdown button: ${clickError.message}`);
      return false;
    }
    
    // Brief wait for dropdown to appear
    await sleep(500);
    
    // Try multiple selection methods in sequence
    const selectionMethods = [
      // Direct click by ID
      async () => {
        logDebug("Trying to click by ID...");
        await page.click("#investments-sinceBuyabs");
        return true;
      },
      
      // Try by paragraph class
      async () => {
        logDebug("Trying by paragraph class...");
        const found = await page.evaluate(() => {
          const paragraphs = document.querySelectorAll('p.dropdownList__optionName');
          for (let i = 0; i < paragraphs.length; i++) {
            const p = paragraphs[i];
            if (p.textContent.includes('Since buy') && p.textContent.includes('€')) {
              const li = p.closest('li');
              if (li) {
                li.click();
                return true;
              }
            }
          }
          return false;
        });
        return found;
      },
      
      // Try direct XPath
      async () => {
        logDebug("Trying XPath method...");
        const [element] = await page.$x("//p[contains(text(), 'Since buy') and contains(text(), '€')]/ancestor::li");
        if (element) {
          await element.click();
          return true;
        }
        return false;
      }
    ];
    
    // Try each method until one works
    for (const method of selectionMethods) {
      try {
        if (await method()) {
          console.log("✅ Selected 'Since buy (€)' option");
          await sleep(500);
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    console.log("❌ Could not find or click 'Since buy (€)' option");
    return false;
  } catch (error) {
    console.log(`Error setting view: ${error.message}`);
    return false;
  }
}

// Get portfolio data
async function getPortfolioData(page, isRefresh = false) {
  const data = {
    portfolio_balance: "Not available",
    positions: [],
    cash_balance: "Not available",
    timestamp: new Date().toISOString()
  };
  
  try {
    console.log("\n📊 Fetching portfolio data...");
    
    // Get portfolio balance
    try {
      const balanceSelectors = [
        ".currencyStatus span[role='status']", 
        "[class*='portfolioValue']",
        "[class*='portfolioBalance']"
      ];
      
      for (const selector of balanceSelectors) {
        const balanceElement = await page.$(selector);
        if (balanceElement) {
          data.portfolio_balance = await page.evaluate(el => el.textContent.trim(), balanceElement);
          console.log(`💰 Portfolio balance: ${data.portfolio_balance}`);
          break;
        }
      }
    } catch (error) {
      console.log(`Error getting portfolio balance: ${error.message}`);
    }
    
    // Set view to show "Since buy (€)" - but only on first load, not on refresh
    if (!isRefresh) {
      console.log("\nSetting view to show Euro values...");
      await clickSinceBuyEuroOption(page);
    } else {
      logDebug("Skipping dropdown selection (using existing view)");
    }
    
    // Get all position data
    try {
      console.log("Looking for portfolio positions...");
      
      // Wait for portfolio list to become available
      await sleep(1500);
      
      // Get all position data with multiple selector attempts
      const positions = await page.evaluate(() => {
        const results = [];
        
        // Try multiple selectors for the portfolio list
        const possibleListSelectors = [
          'ul.portfolioInstrumentList',
          '[class*="portfolioInstrumentList"]',
          '[class*="positionsList"]',
          '[class*="instrumentList"]',
          'ul[class*="portfolio"]'
        ];
        
        let list = null;
        let items = [];
        
        // Try each selector until we find a list
        for (const selector of possibleListSelectors) {
          list = document.querySelector(selector);
          if (list) {
            console.log(`Found list with selector: ${selector}`);
            items = list.querySelectorAll('li');
            if (items.length > 0) break;
          }
        }
        
        // If we still don't have items, try a more generic approach
        if (items.length === 0) {
          console.log("Trying generic approach to find positions");
          items = document.querySelectorAll('[class*="instrumentListItem"], [class*="positionItem"]');
        }
        
        console.log(`Found ${items.length} potential position items`);
        
        // Process each position with multiple possible selectors
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const id = item.id || `position-${i}`;
          
          // Try multiple selectors for name
          const nameSelectors = [
            '.instrumentListItem__name',
            '[class*="instrumentName"]',
            '[class*="positionName"]',
            '[class*="instrumentTitle"]'
          ];
          
          // Try multiple selectors for price
          const priceSelectors = [
            '.instrumentListItem__currentPrice',
            '[class*="currentPrice"]',
            '[class*="positionValue"]',
            '[class*="instrumentValue"]'
          ];
          
          // Try multiple selectors for shares
          const sharesSelectors = [
            '.tag.instrumentListItem__sharesTag',
            '[class*="sharesTag"]',
            '[class*="positionQuantity"]',
            '[class*="shares"]'
          ];
          
          // Find elements with potential selectors
          let nameElement = null;
          for (const selector of nameSelectors) {
            nameElement = item.querySelector(selector);
            if (nameElement) break;
          }
          
          let priceElement = null;
          for (const selector of priceSelectors) {
            priceElement = item.querySelector(selector);
            if (priceElement) break;
          }
          
          let sharesElement = null;
          for (const selector of sharesSelectors) {
            sharesElement = item.querySelector(selector);
            if (sharesElement) break;
          }
          
          // Extract text values
          const name = nameElement ? nameElement.textContent.trim() : "Unknown";
          const value = priceElement ? priceElement.textContent.trim() : "Unknown";
          const shares = sharesElement ? sharesElement.textContent.trim() : "Unknown";
          
          // Only add to results if we have meaningful data
          if (name !== "Unknown" || value !== "Unknown") {
            results.push({
              id,
              name,
              shares,
              total_value: value
            });
          }
        }
        
        return results;
      });
      
      console.log(`Found ${positions.length} positions`);
      
      if (positions.length === 0) {
        console.log("⚠️ No positions found. Waiting longer and trying one more time...");
        await sleep(3000);
        
        // One more attempt with forced page reload
        await page.reload({ waitUntil: 'networkidle2' });
        await sleep(3000);
        
        const retryPositions = await page.evaluate(() => {
          // Same logic as above, but simplified for brevity
          const results = [];
          const items = document.querySelectorAll('[class*="instrumentListItem"], [class*="positionItem"], li');
          
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            // Extract basic info
            const name = item.textContent.trim();
            if (name && name.length > 0 && !name.includes("No positions")) {
              results.push({
                id: `retry-${i}`,
                name: name.substring(0, 30), // Take first 30 chars as name
                shares: "Unknown",
                total_value: "Unknown"
              });
            }
          }
          return results;
        });
        
        if (retryPositions.length > 0) {
          console.log(`Second attempt found ${retryPositions.length} positions`);
          data.positions = retryPositions;
        }
      } else {
        // Add positions to data
        positions.forEach((pos, index) => {
          logDebug(`📊 Position ${index+1}: ${pos.name} (${pos.id})`);
          logDebug(`   Shares: ${pos.shares}`);
          logDebug(`   Value: ${pos.total_value}`);
          data.positions.push(pos);
        });
      }
      
    } catch (error) {
      console.log(`Error getting positions: ${error.message}`);
    }
    
    // Get cash balance by navigating to transactions page
    try {
      console.log("\n💵 Looking for cash balance...");
      
      // Navigate to transactions page
      console.log("Navigating to transactions page...");
      
      // Find the transactions link
      const transactionsLink = await page.$('a.navigationItem__link[href="/profile/transactions"]');
      
      if (transactionsLink) {
        // Click the link
        await transactionsLink.click();
        console.log("Clicked transactions link");
        
        // Brief wait for page to load
        await sleep(1000);
        
        // Find the cash balance element
        const cashBalanceElement = await page.$('.cashBalance__amount');
        if (cashBalanceElement) {
          data.cash_balance = await page.evaluate(el => el.textContent.trim(), cashBalanceElement);
          console.log(`💰 Cash balance: ${data.cash_balance}`);
        } else {
          console.log("Cash balance element not found on transactions page");
        }
        
        // Navigate back to portfolio
        console.log("Navigating back to portfolio...");
        await page.goBack();
        await sleep(1000);
      } else {
        console.log("Could not find transactions link");
      }
    } catch (error) {
      console.log(`Error getting cash balance: ${error.message}`);
    }
    
    return data;
  } catch (error) {
    console.log(`Error getting portfolio data: ${error.message}`);
    return data;
  }
}

// Define API routes

// Special endpoint for self-pinging
app.get('/api/ping', (req, res) => {
  console.log(`[${new Date().toISOString()}] Received self-ping request`);
  res.json({ 
    status: 'ok', 
    message: 'Service is running',
    time: new Date().toISOString()
  });
});

// DELETE - Close a session - IMPROVED WITH QUEUE
app.delete('/api/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  // Check if session exists
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  // Define handler for closing session
  const closeSessionHandler = async () => {
    try {
      console.log(`Closing session ${sessionId} by user request...`);
      
      // Close browser
      if (sessions[sessionId].browser) {
        await sessions[sessionId].browser.close();
      }
      
      // Delete session
      delete sessions[sessionId];
      
      // Save sessions after deletion
      saveSessionsToFile();
      
      // Clean up queue if it exists
      delete sessionQueues[sessionId];
      
      return res.json({ 
        success: true, 
        message: `Session ${sessionId} closed successfully` 
      });
    } catch (error) {
      console.log(`Error closing session ${sessionId}: ${error.message}`);
      
      // Delete session regardless of error
      delete sessions[sessionId];
      
      // Clean up queue if it exists
      delete sessionQueues[sessionId];
      
      // Save sessions after deletion
      saveSessionsToFile();
      
      return res.json({ 
        success: true, 
        message: `Session ${sessionId} deleted with errors: ${error.message}` 
      });
    }
  };
  
  // Queue the session closure
  queueSessionRequest(sessionId, closeSessionHandler, res);
});

// POST - Start a new session and login
app.post('/api/login', limiter, async (req, res) => {
  const { phoneNumber, pin, twoFACode } = req.body;
  
  // Validate inputs
  if (!phoneNumber || !pin) {
    return res.status(400).json({ error: 'Phone number and PIN are required' });
  }
  
  // Create a new session
  const sessionId = uuidv4();
  
  try {
    // Launch browser
    const browser = await setupBrowser();
    
    if (!browser) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to launch browser' 
      });
    }
    
    console.log(`✅ Browser launched for session: ${sessionId}`);
    
    // Create session
    sessions[sessionId] = {
      browser,
      lastActivity: Date.now(),
      credentials: {
        phoneNumber,
        pin
      }
    };
    
    // Prepare handler function for the actual login process
    const loginHandler = async () => {
      try {
        // Use first page
        const pages = await browser.pages();
        const page = pages[0];
        
        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate to Trade Republic
        console.log("\n🌐 Opening Trade Republic portfolio...");
        await page.goto("https://app.traderepublic.com/portfolio", { 
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        console.log("✅ Trade Republic page loaded");
        
        // Store page in session
        sessions[sessionId].page = page;
        
        // Handle login
        const loginResult = await loginToTradeRepublic(page, { phoneNumber, pin, twoFACode });
        
        if (loginResult.success) {
          console.log("\n🎉 Login successful");
          
          // Get portfolio data
          const data = await getPortfolioData(page);
          
          // Save sessions
          saveSessionsToFile();
          
          // Return success with sessionId
          return res.json({
            success: true,
            sessionId,
            data
          });
        } else if (loginResult.needs2FA) {
          console.log("\n📱 2FA required");
          
          // Save sessions (even though not fully authenticated yet)
          saveSessionsToFile();
          
          // Return with 2FA required status
          return res.status(200).json({
            success: false,
            needs2FA: true,
            sessionId // Return the sessionId so client can use it for 2FA submission
          });
        } else {
          console.log("\n❌ Login failed");
          
          // Clean up failed session
          try {
            await browser.close();
          } catch (error) {
            console.log(`Error closing browser: ${error.message}`);
          }
          
          delete sessions[sessionId];
          
          // Save sessions after deletion
          saveSessionsToFile();
          
          return res.status(401).json({
            success: false,
            error: loginResult.error || 'Login failed - check credentials'
          });
        }
      } catch (error) {
        console.log(`❌ Error during login: ${error.message}`);
        
        // Clean up session on error
        try {
          await browser.close();
        } catch (closeError) {
          console.log(`Error closing browser: ${closeError.message}`);
        }
        
        delete sessions[sessionId];
        
        return res.status(500).json({ 
          success: false,
          error: 'Server error: ' + error.message 
        });
      }
    };
    
    // Login is a special case - since this is a new session, we don't need to queue
    // We can immediately execute the login handler
    sessionBusy[sessionId] = true;
    await loginHandler();
    sessionBusy[sessionId] = false;
    
  } catch (error) {
    console.log(`❌ Error setting up session: ${error.message}`);
    
    // Clean up session on error
    if (sessions[sessionId]?.browser) {
      try {
        await sessions[sessionId].browser.close();
      } catch (closeError) {
        console.log(`Error closing browser: ${closeError.message}`);
      }
    }
    
    delete sessions[sessionId];
    
    return res.status(500).json({ 
      success: false,
      error: 'Server error: ' + error.message 
    });
  }
});

// POST - Submit 2FA code for an existing session - IMPROVED WITH QUEUE
app.post('/api/submit-2fa', limiter, async (req, res) => {
  const { sessionId, twoFACode } = req.body;
  
  // Validate inputs
  if (!sessionId || !twoFACode) {
    return res.status(400).json({ error: 'Session ID and 2FA code are required' });
  }
  
  // Check if session exists
  if (!sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  
  // Define handler for 2FA submission
  const submit2FAHandler = async () => {
    // Check if session needs to be restored
    if (sessions[sessionId].needsRestore) {
      const restored = await restoreSession(sessionId);
      if (!restored) {
        return res.status(500).json({ error: 'Failed to restore session' });
      }
    }
    
    try {
      // Update last activity timestamp
      sessions[sessionId].lastActivity = Date.now();
      
      // Get page from session
      const page = sessions[sessionId].page;
      
      if (!page) {
        return res.status(500).json({ error: 'Session page not found' });
      }
      
      // Submit 2FA code
      const twoFAResult = await handle2FA(page, twoFACode);
      
      if (twoFAResult.success) {
        console.log("✅ 2FA verification successful");
        
        // Wait for login to complete
        console.log("Waiting for login to complete...");
        await sleep(2000);
        
        // Check login status
        const isLoggedIn = await checkIfLoggedIn(page);
        
        if (isLoggedIn) {
          console.log("✅ Successfully logged in after 2FA");
          
          // Get portfolio data
          const data = await getPortfolioData(page);
          
          // Save sessions
          saveSessionsToFile();
          
          // Return success with data
          return res.json({
            success: true,
            sessionId,
            data
          });
        } else {
          console.log("❌ Login failed after 2FA");
          
          return res.status(401).json({
            success: false,
            error: 'Login failed after 2FA verification'
          });
        }
      } else {
        console.log("❌ 2FA verification failed");
        
        return res.status(401).json({
          success: false,
          error: twoFAResult.error || '2FA verification failed'
        });
      }
      
    } catch (error) {
      console.log(`❌ Error during 2FA submission: ${error.message}`);
      
      return res.status(500).json({ 
        success: false,
        error: 'Server error: ' + error.message 
      });
    }
  };
  
  // Queue the 2FA submission
  queueSessionRequest(sessionId, submit2FAHandler, res);
});

// GET - Refresh portfolio data for an existing session - IMPROVED WITH QUEUE
app.get('/api/refresh/:sessionId', limiter, async (req, res) => {
  const { sessionId } = req.params;
  
  // Check if session exists
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  
  // Define handler for refreshing data
  const refreshHandler = async () => {
    // Check if session needs to be restored
    if (sessions[sessionId].needsRestore) {
      const restored = await restoreSession(sessionId);
      if (!restored) {
        return res.status(500).json({ error: 'Failed to restore session' });
      }
    }
    
    try {
      // Update last activity timestamp
      sessions[sessionId].lastActivity = Date.now();
      
      // Get page from session
      const page = sessions[sessionId].page;
      
      if (!page) {
        return res.status(500).json({ error: 'Session page not found' });
      }
      
      // Simulate user activity
      await simulateUserActivity(page);
      
      // Get updated portfolio data
      const data = await getPortfolioData(page, true);
      
      // Return success with data
      return res.json({
        success: true,
        data
      });
      
    } catch (error) {
      console.log(`❌ Error during refresh: ${error.message}`);
      
      return res.status(500).json({ 
        success: false,
        error: 'Server error: ' + error.message 
      });
    }
  };
  
  // Queue the refresh request
  queueSessionRequest(sessionId, refreshHandler, res);
});

// GET - Check API status
app.get('/api/status', (req, res) => {
  // Calculate active queue sizes
  const queueSizes = {};
  Object.keys(sessionQueues).forEach(sessionId => {
    if (sessionQueues[sessionId].length > 0) {
      queueSizes[sessionId] = sessionQueues[sessionId].length;
    }
  });
  
  // Count busy sessions
  const busySessions = Object.keys(sessionBusy).filter(id => sessionBusy[id]).length;
  
  res.json({ 
    status: 'ok',
    service: 'Trade Republic API',
    version: '1.8.0', // Updated version
    activeSessions: Object.keys(sessions).length,
    busySessions,
    queuedRequests: queueSizes,
    autoRefreshMinutes: AUTO_REFRESH_INTERVAL / 60000,
    autoPingMinutes: PING_INTERVAL / 60000,
    persistence: true,
    preventSpinDown: true,
    maintenanceStrategy: "Page refresh with navigation every 8 minutes"
  });
});

// For backwards compatibility - map old endpoint to new login endpoint
app.post('/api/portfolio', limiter, async (req, res) => {
  // Just forward to the login endpoint
  console.log("Legacy /api/portfolio endpoint called, forwarding to /api/login");
  
  // Forward the request to /api/login handler
  const { phoneNumber, pin, twoFACode } = req.body;
  
  if (!phoneNumber || !pin) {
    return res.status(400).json({ error: 'Phone number and PIN are required' });
  }
  
  // Create a new session
  const sessionId = uuidv4();
  
  try {
    // Launch browser
    const browser = await setupBrowser();
    
    if (!browser) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to launch browser' 
      });
    }
    
    console.log(`✅ Browser launched for session: ${sessionId}`);
    
    // Create session
    sessions[sessionId] = {
      browser,
      lastActivity: Date.now(),
      credentials: {
        phoneNumber,
        pin
      }
    };
    
    // Define handler for portfolio login
    const portfolioLoginHandler = async () => {
      try {
        // Use first page
        const pages = await browser.pages();
        const page = pages[0];
        
        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Navigate to Trade Republic
        console.log("\n🌐 Opening Trade Republic portfolio...");
        await page.goto("https://app.traderepublic.com/portfolio", { 
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        console.log("✅ Trade Republic page loaded");
        
        // Store page in session
        sessions[sessionId].page = page;
        
        // Handle login
        const loginResult = await loginToTradeRepublic(page, { phoneNumber, pin, twoFACode });
        
        if (loginResult.success) {
          console.log("\n🎉 Login successful");
          
          // Get portfolio data
          const data = await getPortfolioData(page);
          
          // Save sessions
          saveSessionsToFile();
          
          // Return success with sessionId and data in the old format for compatibility
          return res.json({
            success: true,
            data,
            // Include sessionId so client can use it for refresh
            sessionId
          });
        } else if (loginResult.needs2FA) {
          console.log("\n📱 2FA required");
          
          // Save sessions
          saveSessionsToFile();
          
          // Return with 2FA required status in a format compatible with old clients
          return res.status(401).json({
            success: false,
            error: "2FA code required",
            needs2FA: true,
            sessionId // Return the sessionId so client can use it for 2FA submission
          });
        } else {
          console.log("\n❌ Login failed");
          
          // Clean up failed session
          try {
            await browser.close();
          } catch (error) {
            console.log(`Error closing browser: ${error.message}`);
          }
          
          delete sessions[sessionId];
          
          return res.status(401).json({
            success: false,
            error: loginResult.error || 'Login failed - check credentials'
          });
        }
      } catch (error) {
        console.log(`❌ Error during portfolio login: ${error.message}`);
        
        // Clean up session on error
        try {
          await browser.close();
        } catch (closeError) {
          console.log(`Error closing browser: ${closeError.message}`);
        }
        
        delete sessions[sessionId];
        
        return res.status(500).json({ 
          success: false,
          error: 'Server error: ' + error.message 
        });
      }
    };
    
    // Login is a special case - since this is a new session, we don't need to queue
    // We can immediately execute the handler
    sessionBusy[sessionId] = true;
    await portfolioLoginHandler();
    sessionBusy[sessionId] = false;
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return res.status(500).json({ 
      success: false,
      error: 'Server error: ' + error.message 
    });
  }
});

// Graceful shutdown - Save sessions before closing
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, saving sessions before shutdown...');
  
  // Save all sessions to file
  saveSessionsToFile();
  
  // Close all browsers, but don't delete the sessions from memory
  // This way they can be restored when the server restarts
  for (const sessionId in sessions) {
    try {
      if (sessions[sessionId].browser) {
        await sessions[sessionId].browser.close();
        sessions[sessionId].browser = null;
        sessions[sessionId].page = null;
        sessions[sessionId].needsRestore = true;
      }
    } catch (error) {
      console.log(`Error closing browser for session ${sessionId}: ${error.message}`);
    }
  }
  
  console.log('Graceful shutdown complete');
  process.exit(0);
});

// Same for SIGINT
process.on('SIGINT', async () => {
  console.log('SIGINT received, saving sessions before shutdown...');
  
  // Save all sessions to file
  saveSessionsToFile();
  
  // Close all browsers, but don't delete the sessions
  for (const sessionId in sessions) {
    try {
      if (sessions[sessionId].browser) {
        await sessions[sessionId].browser.close();
        sessions[sessionId].browser = null;
        sessions[sessionId].page = null;
        sessions[sessionId].needsRestore = true;
      }
    } catch (error) {
      console.log(`Error closing browser for session ${sessionId}: ${error.message}`);
    }
  }
  
  console.log('Graceful shutdown complete');
  process.exit(0);
});

// Do an initial ping when the server starts
setTimeout(pingService, 5000);

// Start the server
app.listen(PORT, () => {
  console.log(`Trade Republic API server running on port ${PORT}`);
  console.log(`Automatic page refresh with navigation EVERY ${AUTO_REFRESH_INTERVAL/60000} MINUTES`);
  console.log(`Self-ping EVERY ${PING_INTERVAL/60000} MINUTES to prevent spin-down`);
  console.log(`Sessions will be kept alive for 30 DAYS of inactivity`);
  console.log(`Session persistence ENABLED - Sessions will survive server restarts`);
  console.log(`Version 1.8.0 - Using page navigation every 8 minutes to simulate user activity`);
});
