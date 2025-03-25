const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');

// Use stealth plugin to help avoid detection
puppeteer.use(StealthPlugin());

// Create Express app
const app = express();
const PORT = process.env.PORT || 10000;

// Self-ping mechanism to prevent Render from spinning down
// Render free tier spins down after 15 minutes of inactivity
const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
const SERVICE_URL = process.env.SERVICE_URL || 'https://trade-republic-api.onrender.com';

// Configure middleware
app.use(bodyParser.json());

// IMPORTANT: Fix for Render's proxy environment
app.set('trust proxy', 1);

// In-memory sessions object
const sessions = {};

// Lock system to prevent request interference
const locks = {};

// Function to acquire a lock for a session
function acquireLock(sessionId) {
  return new Promise((resolve) => {
    const checkLock = () => {
      if (locks[sessionId]) {
        // Lock exists, wait and check again
        setTimeout(checkLock, 500);
      } else {
        // Lock is free, acquire it
        locks[sessionId] = true;
        resolve();
      }
    };
    checkLock();
  });
}

// Function to release a lock
function releaseLock(sessionId) {
  locks[sessionId] = false;
}

// Function to ping our own service
function pingService() {
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
      // Ping successful, no need to log
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

// OPTIMIZED SESSION MAINTENANCE - EVERY 4 MINUTES
const AUTO_REFRESH_INTERVAL = 4 * 60 * 1000; // 4 minutes

// Start automatic session refresh
console.log(`Setting up automatic session maintenance every ${AUTO_REFRESH_INTERVAL/60000} minutes`);
setInterval(async () => {
  for (const sessionId in sessions) {
    // Skip if session is locked by a user request
    if (locks[sessionId]) {
      continue;
    }
    
    // Acquire lock for maintenance
    locks[sessionId] = true;
    
    try {
      const session = sessions[sessionId];
      
      // Get the page from the session
      const page = session.page;
      
      if (!page) {
        continue;
      }
      
      // Simplified refresh - just reload the page to keep session alive
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        session.lastActivity = Date.now();
      } catch (refreshError) {
        // Suppress error logs to reduce noise
      }
    } catch (error) {
      // Suppress error logs to reduce noise
    } finally {
      // Release lock
      releaseLock(sessionId);
    }
  }
  
}, AUTO_REFRESH_INTERVAL);

// Cleanup stale sessions only after 30 days of inactivity
setInterval(() => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  
  Object.keys(sessions).forEach(sessionId => {
    const session = sessions[sessionId];
    // Only close extremely old sessions (30 days)
    if (now - session.lastActivity > thirtyDays) {
      try {
        if (session.browser) {
          session.browser.close();
        }
      } catch (error) {
        // Suppress error logs
      }
      delete sessions[sessionId];
    }
  });
  
}, 24 * 60 * 60 * 1000); // Run once per day

// Helper functions

// Simplified sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fast typing function
async function fastType(page, selector, text) {
  await page.focus(selector);
  await page.keyboard.type(text, {delay: 0});
}

// Wait for element function
async function waitForElement(page, selector, timeout = 5000, description = "element") {
  try {
    const element = await page.waitForSelector(selector, { 
      visible: true, 
      timeout: timeout 
    });
    
    if (element) {
      return element;
    } else {
      return null;
    }
  } catch (error) {
    return null;
  }
}

// Setup browser for headless environment
async function setupBrowser() {
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
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    // Also check URL to see if we're in a logged-in section
    const currentUrl = await page.url();
    if (currentUrl.includes('/portfolio') || 
        currentUrl.includes('/dashboard') || 
        currentUrl.includes('/timeline')) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Handle cookie consent
async function handleCookieConsent(page) {
  try {
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
          await cookieButton.click();
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Enter phone number
async function enterPhoneNumber(page, phoneNumber) {
  try {
    // Wait for phone number field
    const phoneField = await waitForElement(
      page, 
      "#loginPhoneNumber__input", 
      10000, 
      "phone number field"
    );
    
    if (!phoneField) {
      return false;
    }
    
    // Clear field just in case
    await page.evaluate(() => {
      const input = document.querySelector("#loginPhoneNumber__input");
      if (input) input.value = '';
    });
    
    // Fast type phone number - no delays
    await fastType(page, "#loginPhoneNumber__input", phoneNumber);
    
    // Try to find next button
    const nextButtonSelectors = [
      "button.buttonBase.loginPhoneNumber__action.buttonPrimary",
      ".buttonBase.loginPhoneNumber__action",
      "[data-testid='login-phone-next']"
    ];
    
    let clicked = false;
    
    for (const selector of nextButtonSelectors) {
      try {
        // Wait specifically for this button
        const nextButton = await waitForElement(page, selector, 5000);
        
        if (nextButton) {
          await nextButton.click();
          clicked = true;
          
          // Brief wait for next page to load
          await sleep(300);
          break;
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!clicked) {
      return false;
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

// Enter PIN - Optimized version
async function enterPIN(page, pin) {
  try {
    // Brief wait for PIN field to appear
    await sleep(300);
    
    // First try with specific class
    let pinInputs = await page.$$('fieldset#loginPin__input input.codeInput__character[type="password"]');
    
    // If not found, try more generic selector
    if (!pinInputs || pinInputs.length === 0) {
      pinInputs = await page.$$('#loginPin__input input[type="password"]');
    }
    
    // Last resort - try any password input
    if (!pinInputs || pinInputs.length === 0) {
      pinInputs = await page.$$('input[type="password"]');
    }
    
    if (pinInputs.length === 0) {
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
    
    // Shorter wait for PIN processing
    await sleep(1000);
    
    return true;
  } catch (error) {
    return false;
  }
}

// Handle 2FA - Optimized version
async function handle2FA(page, twoFACode) {
  try {
    // Check for 2FA input
    const is2FARequired = await page.evaluate(() => {
      return !!document.querySelector('#smsCode__input') || 
             !!document.querySelector('[class*="smsCode"]');
    });
    
    if (!is2FARequired) {
      return { success: true, needs2FA: false };
    }
    
    if (!twoFACode) {
      return { success: false, needs2FA: true };
    }
    
    // Wait for SMS code field
    const smsField = await waitForElement(page, "#smsCode__input", 5000);
    
    if (!smsField) {
      return { success: false, needs2FA: true, error: "2FA input field not found" };
    }
    
    // Find SMS input fields
    const smsInputs = await page.$$('#smsCode__input input');
    
    if (smsInputs.length === 0) {
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
    
    // Brief wait for processing
    await sleep(800);
    
    return { success: true, needs2FA: false };
  } catch (error) {
    return { success: false, needs2FA: true, error: error.message };
  }
}

// Login to Trade Republic - Optimized version
async function loginToTradeRepublic(page, credentials) {
  try {
    const { phoneNumber, pin, twoFACode } = credentials;
    
    if (!phoneNumber || !pin) {
      return { success: false, error: "Missing credentials" };
    }
    
    // Check if already logged in
    if (await checkIfLoggedIn(page)) {
      return { success: true };
    }
    
    // Handle cookie consent if present
    await handleCookieConsent(page);
    
    // Enter phone number and proceed
    const phoneSuccess = await enterPhoneNumber(page, phoneNumber);
    
    if (!phoneSuccess) {
      return { success: false, error: "Failed during phone number entry" };
    }
    
    // Enter PIN code
    const pinSuccess = await enterPIN(page, pin);
    
    if (!pinSuccess) {
      return { success: false, error: "Failed during PIN entry" };
    }
    
    // Handle 2FA if needed
    const twoFAResult = await handle2FA(page, twoFACode);
    
    if (twoFAResult.needs2FA) {
      return { 
        success: false, 
        needs2FA: true, 
        error: "2FA code required" 
      };
    }
    
    // Wait for login to complete
    await sleep(1500);
    
    // Final check to verify login success
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (isLoggedIn) {
      return { success: true };
    } else {
      return { 
        success: false, 
        error: "Login verification failed" 
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Function to click dropdown - Optimized version
async function clickSinceBuyEuroOption(page) {
  try {
    // Find and click dropdown button
    const dropdownButtonSelector = ".dropdownList__openButton";
    try {
      await page.click(dropdownButtonSelector);
    } catch (clickError) {
      return false;
    }
    
    // Brief wait for dropdown to appear
    await sleep(300);
    
    // Try multiple selection methods in sequence
    const selectionMethods = [
      // Direct click by ID
      async () => {
        await page.click("#investments-sinceBuyabs");
        return true;
      },
      
      // Try by paragraph class
      async () => {
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
          await sleep(300);
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Get portfolio data - Optimized version
async function getPortfolioData(page, isRefresh = false) {
  const data = {
    portfolio_balance: "Not available",
    positions: [],
    cash_balance: "Not available",
    timestamp: new Date().toISOString()
  };
  
  try {
    // Get portfolio balance - Fast approach
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
          break;
        }
      }
    } catch (error) {
      // Suppress error
    }
    
    // Set view to show "Since buy (€)" - but only on first load, not on refresh
    if (!isRefresh) {
      await clickSinceBuyEuroOption(page);
    }
    
    // Get all position data - Fast approach
    try {
      // Wait shorter time for portfolio list
      await sleep(1000);
      
      // Get all position data with simplified selector approach
      const positions = await page.evaluate(() => {
        const results = [];
        
        // Try with list selectors first
        const items = Array.from(document.querySelectorAll('[class*="instrumentListItem"], [class*="positionItem"], li[class*="portfolio"]'));
        
        items.forEach((item, i) => {
          // Extract text content directly for names and values
          const fullText = item.textContent.trim();
          
          // Skip items that are likely not positions
          if (fullText.length < 5 || 
              fullText.includes("No positions") || 
              fullText.includes("Loading")) {
            return;
          }
          
          // Try to find name and value elements
          let name = "Unknown";
          let value = "Unknown";
          let shares = "Unknown";
          
          // Look for name
          const nameElement = item.querySelector('[class*="name"], [class*="title"]');
          if (nameElement) {
            name = nameElement.textContent.trim();
          }
          
          // Look for value
          const valueElement = item.querySelector('[class*="price"], [class*="value"]');
          if (valueElement) {
            value = valueElement.textContent.trim();
          }
          
          // Look for shares
          const sharesElement = item.querySelector('[class*="shares"], [class*="quantity"]');
          if (sharesElement) {
            shares = sharesElement.textContent.trim();
          }
          
          // Only add if we have some meaningful data
          if (name !== "Unknown" || value !== "Unknown") {
            results.push({
              id: `position-${i}`,
              name: name.length > 30 ? name.substring(0, 30) + '...' : name,
              shares,
              total_value: value
            });
          }
        });
        
        return results;
      });
      
      // Add positions to data
      data.positions = positions;
      
    } catch (error) {
      // Suppress error
    }
    
    // Get cash balance by navigating to transactions page - Fast approach
    try {
      // Find the transactions link
      const transactionsLink = await page.$('a.navigationItem__link[href="/profile/transactions"]');
      
      if (transactionsLink) {
        // Click the link
        await transactionsLink.click();
        
        // Brief wait for page to load
        await sleep(800);
        
        // Find the cash balance element
        const cashBalanceElement = await page.$('.cashBalance__amount');
        if (cashBalanceElement) {
          data.cash_balance = await page.evaluate(el => el.textContent.trim(), cashBalanceElement);
        }
        
        // Navigate back to portfolio
        await page.goBack();
        await sleep(800);
      }
    } catch (error) {
      // Suppress error
    }
    
    return data;
  } catch (error) {
    return data;
  }
}

// Define API routes

// Special endpoint for self-pinging
app.get('/api/ping', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString()
  });
});

// DELETE - Close a session
app.delete('/api/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  // Check if session exists
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    // Acquire lock for the session
    await acquireLock(sessionId);
    
    // Close browser
    if (sessions[sessionId].browser) {
      await sessions[sessionId].browser.close();
    }
    
    // Delete session
    delete sessions[sessionId];
    
    // Release lock
    releaseLock(sessionId);
    
    return res.json({ 
      success: true, 
      message: `Session ${sessionId} closed successfully` 
    });
  } catch (error) {
    // Delete session regardless of error
    delete sessions[sessionId];
    releaseLock(sessionId);
    
    return res.json({ 
      success: true, 
      message: `Session ${sessionId} deleted with errors: ${error.message}` 
    });
  }
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
    
    // Create session
    sessions[sessionId] = {
      browser,
      lastActivity: Date.now(),
      credentials: {
        phoneNumber,
        pin
      }
    };
    
    // Acquire lock for the session
    locks[sessionId] = true;
    
    // Use first page
    const pages = await browser.pages();
    const page = pages[0];
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate to Trade Republic
    await page.goto("https://app.traderepublic.com/portfolio", { 
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    // Store page in session
    sessions[sessionId].page = page;
    
    // Handle login
    const loginResult = await loginToTradeRepublic(page, { phoneNumber, pin, twoFACode });
    
    if (loginResult.success) {
      // Get portfolio data
      const data = await getPortfolioData(page);
      
      // Release lock
      releaseLock(sessionId);
      
      // Return success with sessionId
      return res.json({
        success: true,
        sessionId,
        data
      });
    } else if (loginResult.needs2FA) {
      // Release lock
      releaseLock(sessionId);
      
      // Return with 2FA required status
      return res.status(200).json({
        success: false,
        needs2FA: true,
        sessionId // Return the sessionId so client can use it for 2FA submission
      });
    } else {
      // Clean up failed session
      try {
        await browser.close();
      } catch (error) {
        // Suppress error
      }
      
      delete sessions[sessionId];
      releaseLock(sessionId);
      
      return res.status(401).json({
        success: false,
        error: loginResult.error || 'Login failed - check credentials'
      });
    }
    
  } catch (error) {
    // Clean up session on error
    if (sessions[sessionId]?.browser) {
      try {
        await sessions[sessionId].browser.close();
      } catch (closeError) {
        // Suppress error
      }
    }
    
    delete sessions[sessionId];
    if (locks[sessionId]) releaseLock(sessionId);
    
    return res.status(500).json({ 
      success: false,
      error: 'Server error: ' + error.message 
    });
  }
});

// POST - Submit 2FA code for an existing session
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
  
  try {
    // Acquire lock for the session
    await acquireLock(sessionId);
    
    // Update last activity timestamp
    sessions[sessionId].lastActivity = Date.now();
    
    // Get page from session
    const page = sessions[sessionId].page;
    
    if (!page) {
      releaseLock(sessionId);
      return res.status(500).json({ error: 'Session page not found' });
    }
    
    // Submit 2FA code
    const twoFAResult = await handle2FA(page, twoFACode);
    
    if (twoFAResult.success) {
      // Wait for login to complete
      await sleep(1500);
      
      // Check login status
      const isLoggedIn = await checkIfLoggedIn(page);
      
      if (isLoggedIn) {
        // Get portfolio data
        const data = await getPortfolioData(page);
        
        // Release lock
        releaseLock(sessionId);
        
        // Return success with data
        return res.json({
          success: true,
          sessionId,
          data
        });
      } else {
        releaseLock(sessionId);
        return res.status(401).json({
          success: false,
          error: 'Login failed after 2FA verification'
        });
      }
    } else {
      releaseLock(sessionId);
      return res.status(401).json({
        success: false,
        error: twoFAResult.error || '2FA verification failed'
      });
    }
    
  } catch (error) {
    if (locks[sessionId]) releaseLock(sessionId);
    
    return res.status(500).json({ 
      success: false,
      error: 'Server error: ' + error.message 
    });
  }
});

// GET - Refresh portfolio data for an existing session
app.get('/api/refresh/:sessionId', limiter, async (req, res) => {
  const { sessionId } = req.params;
  
  // Check if session exists
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  
  try {
    // Acquire lock for the session
    await acquireLock(sessionId);
    
    // Update last activity timestamp
    sessions[sessionId].lastActivity = Date.now();
    
    // Get page from session
    const page = sessions[sessionId].page;
    
    if (!page) {
      releaseLock(sessionId);
      return res.status(500).json({ error: 'Session page not found' });
    }
    
    // Check if still logged in
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (!isLoggedIn) {
      releaseLock(sessionId);
      return res.status(401).json({
        success: false,
        error: 'Session expired, please login again'
      });
    }
    
    // Refresh portfolio data - OPTIMIZED
    
    // Make sure we're on the portfolio page - FASTER NAVIGATION
    const currentUrl = await page.url();
    if (!currentUrl.includes('/portfolio')) {
      // Navigate to portfolio with faster loading strategy
      await page.goto("https://app.traderepublic.com/portfolio", { 
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      await sleep(1000);
    } else {
      // Just refresh the current page with faster loading strategy
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(1000);
    }
    
    // Get updated portfolio data
    const data = await getPortfolioData(page, true);
    
    // Release lock
    releaseLock(sessionId);
    
    // Return success with data
    return res.json({
      success: true,
      data
    });
    
  } catch (error) {
    if (locks[sessionId]) releaseLock(sessionId);
    
    return res.status(500).json({ 
      success: false,
      error: 'Server error: ' + error.message 
    });
  }
});

// GET - Check API status
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Trade Republic API',
    version: '2.0.0',
    activeSessions: Object.keys(sessions).length,
    autoRefreshMinutes: AUTO_REFRESH_INTERVAL / 60000,
    autoPingMinutes: PING_INTERVAL / 60000,
    optimizedForSpeed: true
  });
});

// For backwards compatibility - map old endpoint to new login endpoint
app.post('/api/portfolio', limiter, async (req, res) => {
  // Just forward to the login endpoint
  const { phoneNumber, pin, twoFACode } = req.body;
  
  if (!phoneNumber || !pin) {
    return res.status(400).json({ error: 'Phone number and PIN are required' });
  }
  
  try {
    // Create a new session
    const sessionId = uuidv4();
    
    // Launch browser
    const browser = await setupBrowser();
    
    if (!browser) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to launch browser' 
      });
    }
    
    // Create session
    sessions[sessionId] = {
      browser,
      lastActivity: Date.now(),
      credentials: {
        phoneNumber,
        pin
      }
    };
    
    // Acquire lock for the session
    locks[sessionId] = true;
    
    // Use first page
    const pages = await browser.pages();
    const page = pages[0];
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate to Trade Republic
    await page.goto("https://app.traderepublic.com/portfolio", { 
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    // Store page in session
    sessions[sessionId].page = page;
    
    // Handle login
    const loginResult = await loginToTradeRepublic(page, { phoneNumber, pin, twoFACode });
    
    if (loginResult.success) {
      // Get portfolio data
      const data = await getPortfolioData(page);
      
      // Release lock
      releaseLock(sessionId);
      
      // Return success with sessionId and data in the old format for compatibility
      return res.json({
        success: true,
        data,
        // Include sessionId so client can use it for refresh
        sessionId
      });
    } else if (loginResult.needs2FA) {
      // Release lock
      releaseLock(sessionId);
      
      // Return with 2FA required status in a format compatible with old clients
      return res.status(401).json({
        success: false,
        error: "2FA code required",
        needs2FA: true,
        sessionId // Return the sessionId so client can use it for 2FA submission
      });
    } else {
      // Clean up failed session
      try {
        await browser.close();
      } catch (error) {
        // Suppress error
      }
      
      delete sessions[sessionId];
      releaseLock(sessionId);
      
      return res.status(401).json({
        success: false,
        error: loginResult.error || 'Login failed - check credentials'
      });
    }
  } catch (error) {
    return res.status(500).json({ 
      success: false,
      error: 'Server error: ' + error.message 
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  // Close all browser instances
  for (const sessionId in sessions) {
    try {
      if (sessions[sessionId].browser) {
        await sessions[sessionId].browser.close();
      }
    } catch (error) {
      // Suppress error
    }
  }
  
  process.exit(0);
});

// Same for SIGINT
process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  
  // Close all browser instances
  for (const sessionId in sessions) {
    try {
      if (sessions[sessionId].browser) {
        await sessions[sessionId].browser.close();
      }
    } catch (error) {
      // Suppress error
    }
  }
  
  process.exit(0);
});

// Do an initial ping when the server starts
setTimeout(pingService, 5000);

// Start the server
app.listen(PORT, () => {
  console.log(`Trade Republic API server running on port ${PORT}`);
});
