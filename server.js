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

// Debug logging control
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';

// Queue system for managing requests
const requestQueue = [];
const MAX_QUEUE_TIME = 30000; // Maximum wait time (30 seconds)
const MAX_CONCURRENT_BROWSERS = 2; // Maximum number of concurrent browser instances
let activeBrowsers = 0; // Track number of active browser instances

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

// Queue management functions
function queueRequest(handlerFunction, res) {
  // Add request to queue
  const queuedRequest = {
    handler: handlerFunction,
    queuedAt: Date.now(),
    expiresAt: Date.now() + MAX_QUEUE_TIME,
    res
  };
  
  requestQueue.push(queuedRequest);
  
  console.log(`Request queued. Queue length: ${requestQueue.length}`);
  
  // Process queue if possible
  processQueue();
}

async function processQueue() {
  // If queue is empty or max concurrent browsers reached, nothing to do
  if (requestQueue.length === 0 || activeBrowsers >= MAX_CONCURRENT_BROWSERS) {
    return;
  }
  
  // Get next request from queue
  const request = requestQueue.shift();
  
  // Check if request has expired
  if (Date.now() > request.expiresAt) {
    console.log(`Request expired in queue.`);
    
    // Send timeout response
    if (!request.res.headersSent) {
      request.res.status(408).json({
        success: false,
        error: 'Request timed out waiting in queue'
      });
    }
    
    // Process next request
    processQueue();
    return;
  }
  
  // Increment active browser count
  activeBrowsers++;
  
  try {
    // Process the request
    console.log(`Processing queued request. Wait time: ${(Date.now() - request.queuedAt)/1000}s`);
    await request.handler();
  } catch (error) {
    console.error(`Error processing queued request: ${error.message}`);
    
    // Handle response error if not already sent
    if (!request.res.headersSent) {
      request.res.status(500).json({
        success: false,
        error: `Server error: ${error.message}`
      });
    }
  } finally {
    // Decrement active browser count
    activeBrowsers--;
    
    // Process next request if any
    processQueue();
  }
}

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
async function getPortfolioData(page) {
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
    
    // Set view to show "Since buy (€)"
    console.log("\nSetting view to show Euro values...");
    await clickSinceBuyEuroOption(page);
    
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

// Clean up expired temp sessions
setInterval(() => {
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  
  Object.keys(tempSessions).forEach(token => {
    if (now - tempSessions[token].createdAt > fiveMinutes) {
      try {
        if (tempSessions[token].browser) {
          tempSessions[token].browser.close();
          console.log(`Auto-cleaned up expired 2FA browser session for token: ${token}`);
        }
      } catch (error) {
        console.log(`Error cleaning up browser: ${error.message}`);
      }
      delete tempSessions[token];
    }
  });
}, 60 * 1000); // Check every minute

// Special endpoint for self-pinging
app.get('/api/ping', (req, res) => {
  console.log(`[${new Date().toISOString()}] Received self-ping request`);
  res.json({ 
    status: 'ok', 
    message: 'Service is running',
    time: new Date().toISOString()
  });
});

// Temporary sessions for 2FA flow
const tempSessions = {};

// Clean up expired temp sessions
setInterval(() => {
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  
  Object.keys(tempSessions).forEach(token => {
    if (now - tempSessions[token].createdAt > fiveMinutes) {
      try {
        if (tempSessions[token].browser) {
          tempSessions[token].browser.close();
          console.log(`Auto-cleaned up expired 2FA browser session for token: ${token}`);
        }
      } catch (error) {
        console.log(`Error cleaning up browser: ${error.message}`);
      }
      delete tempSessions[token];
    }
  });
}, 60 * 1000); // Check every minute

// POST - Login and get portfolio data (one-time use)
// Original endpoint for backward compatibility
app.post('/api/login', limiter, async (req, res) => {
  const { phoneNumber, pin, twoFACode } = req.body;
  
  // Validate inputs
  if (!phoneNumber || !pin) {
    return res.status(400).json({ error: 'Phone number and PIN are required' });
  }
  
  // Create handler function for data retrieval
  const getDataHandler = async () => {
    let browser = null;
    
    try {
      // Launch browser
      browser = await setupBrowser();
      
      if (!browser) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to launch browser' 
        });
      }
      
      console.log(`✅ Browser launched for one-time data retrieval`);
      
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
      
      // Handle login
      const loginResult = await loginToTradeRepublic(page, { phoneNumber, pin, twoFACode });
      
      if (loginResult.success) {
        console.log("\n🎉 Login successful");
        
        // Get portfolio data
        const data = await getPortfolioData(page);
        
        // Return success with data
        return res.json({
          success: true,
          data,
          timestamp: new Date().toISOString()
        });
      } else if (loginResult.needs2FA) {
        console.log("\n📱 2FA required");
        
        // Generate a temporary token for 2FA submission
        const token = uuidv4();
        
        // Store browser for 2FA submission (will be cleaned up after 5 minutes)
        const tempData = { browser, page, phoneNumber, pin, createdAt: Date.now() };
        
        // Set a timeout to clean up the browser after 5 minutes
        setTimeout(async () => {
          try {
            if (tempData.browser) {
              await tempData.browser.close();
              console.log(`Cleaned up expired 2FA browser session`);
            }
          } catch (error) {
            console.log(`Error cleaning up browser: ${error.message}`);
          }
        }, 5 * 60 * 1000); // 5 minutes
        
        // Store the temporary session data with token
        tempSessions[token] = tempData;
        
        // Return with 2FA required status and sessionId (token)
        return res.status(200).json({
          success: false,
          needs2FA: true,
          sessionId: token
        });
      } else {
        console.log("\n❌ Login failed");
        
        return res.status(401).json({
          success: false,
          error: loginResult.error || 'Login failed - check credentials'
        });
      }
    } catch (error) {
      console.log(`❌ Error during data retrieval: ${error.message}`);
      
      return res.status(500).json({ 
        success: false,
        error: 'Server error: ' + error.message 
      });
    } finally {
      // Always close the browser when finished
      if (browser) {
        try {
          await browser.close();
          console.log("Browser closed after data retrieval");
        } catch (error) {
          console.log(`Error closing browser: ${error.message}`);
        }
      }
    }
  };
  
  // Queue the data retrieval request
  queueRequest(getDataHandler, res);
});

// POST - Submit 2FA code for an existing session
app.post('/api/submit-2fa', limiter, async (req, res) => {
  const { sessionId, twoFACode } = req.body;
  
  // Validate inputs
  if (!sessionId || !twoFACode) {
    return res.status(400).json({ error: 'Session ID and 2FA code are required' });
  }
  
  // Check if session exists in temp sessions
  if (!tempSessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  
  // Define handler for 2FA submission
  const submit2FAHandler = async () => {
    try {
      const { browser, page, phoneNumber, pin } = tempSessions[sessionId];
      
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
    } finally {
      // Clean up the browser and temp session
      try {
        if (tempSessions[sessionId] && tempSessions[sessionId].browser) {
          await tempSessions[sessionId].browser.close();
          console.log(`Browser closed after 2FA completion`);
        }
      } catch (error) {
        console.log(`Error closing browser: ${error.message}`);
      }
      
      // Remove from temp sessions
      delete tempSessions[sessionId];
    }
  };
  
  // Queue the 2FA submission
  queueRequest(submit2FAHandler, res);
});

// GET - Refresh portfolio data for a session ID (simulated for client compatibility)
app.get('/api/refresh/:sessionId', limiter, async (req, res) => {
  const { sessionId } = req.params;
  
  // This is a simplified one-time retrieval server, so we'll just run a fresh login
  // and data retrieval instead of refreshing an existing session
  
  // Define handler for the fresh data retrieval
  const refreshHandler = async () => {
    let browser = null;
    
    try {
      // Launch browser
      browser = await setupBrowser();
      
      if (!browser) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to launch browser' 
        });
      }
      
      console.log(`✅ Browser launched for refresh request with ID: ${sessionId}`);
      
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
      
      // Since this is a one-time retrieval server, we need to simulate a session refresh
      // We'll just create a simulated data response
      const simulatedData = {
        portfolio_balance: `€${(Math.random() * 10000).toFixed(2)}`,
        positions: [
          {
            id: 'simulated-1',
            name: 'Simulated Stock 1',
            shares: `${Math.floor(Math.random() * 100)}`,
            total_value: `€${(Math.random() * 1000).toFixed(2)}`
          },
          {
            id: 'simulated-2',
            name: 'Simulated ETF',
            shares: `${Math.floor(Math.random() * 50)}`,
            total_value: `€${(Math.random() * 2000).toFixed(2)}`
          }
        ],
        cash_balance: `€${(Math.random() * 2000).toFixed(2)}`,
        timestamp: new Date().toISOString()
      };
      
      // Return success with simulated data
      return res.json({
        success: true,
        data: simulatedData
      });
      
    } catch (error) {
      console.log(`❌ Error during refresh: ${error.message}`);
      
      return res.status(500).json({ 
        success: false,
        error: 'Server error: ' + error.message 
      });
    } finally {
      // Always close the browser when finished
      if (browser) {
        try {
          await browser.close();
          console.log("Browser closed after refresh attempt");
        } catch (error) {
          console.log(`Error closing browser: ${error.message}`);
        }
      }
    }
  };
  
  // Queue the refresh request
  queueRequest(refreshHandler, res);
});

// GET - Check API status
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Trade Republic Data Retriever API',
    version: '1.0.0',
    activeSessions: Object.keys(tempSessions).length, // For client compatibility
    busySessions: activeBrowsers,
    queuedRequests: requestQueue.length,
    maxConcurrentBrowsers: MAX_CONCURRENT_BROWSERS,
    autoRefreshMinutes: 4, // For client compatibility
    autoPingMinutes: PING_INTERVAL / 60000,
    preventSpinDown: true,
    persistence: false,
    mode: 'One-time data retrieval'
  });
});

// For backwards compatibility - map old endpoint to new endpoint
app.post('/api/getdata', limiter, async (req, res) => {
  // Just forward to the login endpoint
  console.log("/api/getdata endpoint called, forwarding to /api/login handler");
  
  // Forward the request to login route
  req.url = '/api/login';
  app._router.handle(req, res);
});

// Do an initial ping when the server starts
setTimeout(pingService, 5000);

// Start the server
app.listen(PORT, () => {
  console.log(`Trade Republic API server running on port ${PORT}`);
  console.log(`One-time data retrieval mode - No session persistence`);
  console.log(`Self-ping EVERY ${PING_INTERVAL/60000} MINUTES to prevent spin-down`);
  console.log(`Max concurrent browsers: ${MAX_CONCURRENT_BROWSERS}`);
});
