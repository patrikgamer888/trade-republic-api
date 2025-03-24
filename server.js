const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

// Use stealth plugin to help avoid detection
puppeteer.use(StealthPlugin());

// Create Express app
const app = express();
const PORT = process.env.PORT || 10000;

// Configure middleware
app.use(bodyParser.json());

// IMPORTANT: Fix for Render's proxy environment
app.set('trust proxy', 1);

// API key middleware
const apiKeyAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.API_KEY || 'your-secret-api-key';
  
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

// Apply API key auth to all routes
app.use(apiKeyAuth);

// Session storage for browser instances
const sessions = {};

// SUPER AGGRESSIVE AUTOMATIC SESSION MAINTENANCE - EVERY 4 MINUTES
const AUTO_REFRESH_INTERVAL = 4 * 60 * 1000; // 4 minutes

// Start automatic session refresh
console.log(`Setting up automatic session maintenance every ${AUTO_REFRESH_INTERVAL/60000} minutes`);
setInterval(async () => {
  console.log(`[${new Date().toISOString()}] Running automatic session maintenance...`);
  
  for (const sessionId in sessions) {
    const session = sessions[sessionId];
    
    try {
      console.log(`Refreshing session ${sessionId}...`);
      
      // Get the page from the session
      const page = session.page;
      
      if (!page) {
        console.log(`No page for session ${sessionId}, skipping`);
        continue;
      }
      
      // Check if still logged in
      const isLoggedIn = await checkIfLoggedIn(page);
      
      if (!isLoggedIn) {
        console.log(`Session ${sessionId} is not logged in, attempting to reconnect...`);
        
        // Try automatic re-login
        const credentials = session.credentials;
        
        if (credentials && credentials.phoneNumber && credentials.pin) {
          console.log("Attempting automatic re-login...");
          
          // Navigate back to portfolio
          await page.goto("https://app.traderepublic.com/portfolio", { 
            waitUntil: 'networkidle2',
            timeout: 30000
          });
          
          // Login again
          const loginResult = await loginToTradeRepublic(page, credentials);
          
          if (loginResult.success) {
            console.log(`✅ Automatic re-login successful for session ${sessionId}`);
            session.lastActivity = Date.now();
          } else {
            console.log(`❌ Automatic re-login failed for session ${sessionId}`);
            // Keep the session, we'll try again later
          }
        } else {
          console.log(`No credentials for session ${sessionId}, can't reconnect`);
        }
      } else {
        console.log(`Session ${sessionId} is still logged in`);
        
        // Just refresh the page to keep the session alive
        try {
          await page.reload({ waitUntil: 'networkidle2' });
          console.log(`Refreshed page for session ${sessionId}`);
          session.lastActivity = Date.now();
        } catch (refreshError) {
          console.log(`Error refreshing page for session ${sessionId}: ${refreshError.message}`);
        }
      }
    } catch (error) {
      console.log(`Error maintaining session ${sessionId}: ${error.message}`);
    }
  }
  
  console.log(`[${new Date().toISOString()}] Session maintenance completed`);
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
}, 24 * 60 * 60 * 1000); // Run once per day

// Helper functions

// Simplified sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fast typing function
async function fastType(page, selector, text) {
  console.log(`Typing into ${selector}...`);
  await page.focus(selector);
  await page.keyboard.type(text, {delay: 0});
  console.log("Typing complete");
}

// Wait for element function
async function waitForElement(page, selector, timeout = 5000, description = "element") {
  try {
    console.log(`👀 Looking for: ${description}`);
    const element = await page.waitForSelector(selector, { 
      visible: true, 
      timeout: timeout 
    });
    
    if (element) {
      console.log(`✅ Found: ${description}`);
      return element;
    } else {
      console.log(`⚠️ Element found but may not be visible: ${description}`);
      return null;
    }
  } catch (error) {
    console.log(`❌ Could not find: ${description} - ${error.message}`);
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
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--incognito'],
      defaultViewport: null
    });
    return browser;
  }
}

// Check if already logged in
async function checkIfLoggedIn(page) {
  try {
    console.log("Checking login status...");
    
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
            console.log("✅ Already logged in");
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
      console.log("✅ Already logged in (based on URL)");
      return true;
    }
    
    console.log("Not logged in yet");
    return false;
  } catch (error) {
    console.log(`Error checking login status: ${error.message}`);
    return false;
  }
}

// Handle cookie consent
async function handleCookieConsent(page) {
  try {
    console.log("Checking for cookie consent dialog...");
    
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
          console.log(`Found cookie button: ${selector}`);
          await cookieButton.click();
          console.log("✅ Accepted cookies");
          return true;
        }
      } catch (error) {
        continue;
      }
    }
    
    console.log("No cookie consent dialog found");
    return false;
  } catch (error) {
    console.log(`Error handling cookie consent: ${error.message}`);
    return false;
  }
}

// Enter phone number
async function enterPhoneNumber(page, phoneNumber) {
  try {
    console.log("Starting phone number entry...");
    
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
    console.log("Looking for next button...");
    
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
          console.log(`Clicking next button: ${selector}`);
          await nextButton.click();
          
          console.log("✅ Clicked next button");
          clicked = true;
          
          // Brief wait for next page to load
          await sleep(500);
          break;
        }
      } catch (error) {
        console.log(`Error with button ${selector}: ${error.message}`);
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
    console.log("Starting PIN entry...");
    
    // Brief wait for PIN field to appear
    await sleep(500);
    
    // Try to find PIN input
    console.log("Looking for PIN input fields...");
    
    // First try with specific class
    let pinInputs = await page.$$('fieldset#loginPin__input input.codeInput__character[type="password"]');
    
    // If not found, try more generic selector
    if (!pinInputs || pinInputs.length === 0) {
      console.log("Trying alternative PIN selector...");
      pinInputs = await page.$$('#loginPin__input input[type="password"]');
    }
    
    // Last resort - try any password input
    if (!pinInputs || pinInputs.length === 0) {
      console.log("Trying any password input as last resort...");
      pinInputs = await page.$$('input[type="password"]');
    }
    
    console.log(`Found ${pinInputs.length} PIN input fields`);
    
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
    
    console.log("✅ PIN entry complete");
    
    // Wait for PIN processing but reduced time
    console.log("Waiting for PIN processing...");
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
    console.log("Checking if 2FA is required...");
    
    // Check for 2FA input
    const is2FARequired = await page.evaluate(() => {
      return !!document.querySelector('#smsCode__input') || 
             !!document.querySelector('[class*="smsCode"]');
    });
    
    if (!is2FARequired) {
      console.log("No 2FA required");
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
    
    console.log("✅ 2FA code entered");
    
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

// Function to click dropdown (was missing)
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
        console.log("Trying to click by ID...");
        await page.click("#investments-sinceBuyabs");
        return true;
      },
      
      // Try by paragraph class
      async () => {
        console.log("Trying by paragraph class...");
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
        console.log("Trying XPath method...");
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
      console.log("Skipping dropdown selection (using existing view)");
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
          console.log(`📊 Position ${index+1}: ${pos.name} (${pos.id})`);
          console.log(`   Shares: ${pos.shares}`);
          console.log(`   Value: ${pos.total_value}`);
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

// DELETE - Close a session
app.delete('/api/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  // Check if session exists
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    console.log(`Closing session ${sessionId} by user request...`);
    
    // Close browser
    if (sessions[sessionId].browser) {
      await sessions[sessionId].browser.close();
    }
    
    // Delete session
    delete sessions[sessionId];
    
    return res.json({ 
      success: true, 
      message: `Session ${sessionId} closed successfully` 
    });
  } catch (error) {
    console.log(`Error closing session ${sessionId}: ${error.message}`);
    
    // Delete session regardless of error
    delete sessions[sessionId];
    
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
      
      // Return success with sessionId
      return res.json({
        success: true,
        sessionId,
        data
      });
    } else if (loginResult.needs2FA) {
      console.log("\n📱 2FA required");
      
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
      
      return res.status(401).json({
        success: false,
        error: loginResult.error || 'Login failed - check credentials'
      });
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    
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
});

// GET - Refresh portfolio data for an existing session
app.get('/api/refresh/:sessionId', limiter, async (req, res) => {
  const { sessionId } = req.params;
  
  // Check if session exists
  if (!sessionId || !sessions[sessionId]) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  
  try {
    // Update last activity timestamp
    sessions[sessionId].lastActivity = Date.now();
    
    // Get page from session
    const page = sessions[sessionId].page;
    
    if (!page) {
      return res.status(500).json({ error: 'Session page not found' });
    }
    
    // Check if still logged in
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (!isLoggedIn) {
      console.log("❌ Session expired, need to login again");
      
      // Try automatic re-login
      const credentials = sessions[sessionId].credentials;
      
      if (credentials && credentials.phoneNumber && credentials.pin) {
        console.log("Attempting automatic re-login...");
        
        // Navigate back to portfolio
        await page.goto("https://app.traderepublic.com/portfolio", { 
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        
        // Login again
        const loginResult = await loginToTradeRepublic(page, credentials);
        
        if (loginResult.success) {
          console.log("✅ Automatic re-login successful");
        } else if (loginResult.needs2FA) {
          console.log("❌ 2FA required for re-login, cannot proceed automatically");
          return res.status(401).json({
            success: false,
            needs2FA: true,
            error: 'Session expired and 2FA required for re-login'
          });
        } else {
          console.log("❌ Automatic re-login failed");
          return res.status(401).json({
            success: false,
            error: 'Session expired and automatic re-login failed'
          });
        }
      } else {
        return res.status(401).json({
          success: false,
          error: 'Session expired, please login again'
        });
      }
    }
    
    // Refresh portfolio data
    console.log("Refreshing portfolio data...");
    
    // Make sure we're on the portfolio page
    const currentUrl = await page.url();
    if (!currentUrl.includes('/portfolio')) {
      console.log("Not on portfolio page, navigating to portfolio...");
      await page.goto("https://app.traderepublic.com/portfolio", { 
        waitUntil: 'networkidle2',
        timeout: 15000
      });
      await sleep(2000); // Wait for page to load
    } else {
      // Just refresh the current page
      await page.reload({ waitUntil: 'networkidle2' });
      await sleep(2000); // Wait for page to load
    }
    
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
});

// GET - Check API status
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Trade Republic API',
    version: '1.2.0',
    activeSessions: Object.keys(sessions).length,
    autoRefreshMinutes: AUTO_REFRESH_INTERVAL / 60000
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
  
  try {
    // Create a new session
    const sessionId = uuidv4();
    
    // Launch browser
    const browser = await setupBrowser();
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
      
      // Return success with sessionId and data in the old format for compatibility
      return res.json({
        success: true,
        data,
        // Include sessionId so client can use it for refresh
        sessionId
      });
    } else if (loginResult.needs2FA) {
      console.log("\n📱 2FA required");
      
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
    console.log(`❌ Error: ${error.message}`);
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
      console.log(`Error closing browser for session ${sessionId}: ${error.message}`);
    }
  }
  
  process.exit(0);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Trade Republic API server running on port ${PORT}`);
  console.log(`Automatic session maintenance EVERY ${AUTO_REFRESH_INTERVAL/60000} MINUTES`);
  console.log(`Sessions will be kept alive for 30 DAYS of inactivity`);
});
