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

// Function to log debug messages
function logDebug(message) {
  if (DEBUG_LOGGING) {
    console.log(message);
  }
}

// Self-ping mechanism to prevent Render from spinning down
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

// Simple queue system for managing concurrent requests
const requestQueue = [];
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 3; // Increased for better throughput

// Process queue function
function processQueue() {
  if (requestQueue.length === 0 || activeRequests >= MAX_CONCURRENT_REQUESTS) {
    return;
  }
  
  // Get next request from queue
  const nextRequest = requestQueue.shift();
  
  // Increment active requests
  activeRequests++;
  
  // Execute the handler
  nextRequest.handler().finally(() => {
    // Decrement active requests
    activeRequests--;
    
    // Process next item in queue
    processQueue();
  });
}

// Add request to queue
function queueRequest(handler, res) {
  // Add to queue
  requestQueue.push({
    handler,
    res
  });
  
  console.log(`Request added to queue. Queue length: ${requestQueue.length}`);
  
  // Try to process queue
  processQueue();
}

// ===== BROWSER SESSIONS FOR 2FA =====
// We need to store browser sessions during 2FA flow
const pendingSessions = new Map();

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  
  for (const [token, session] of pendingSessions.entries()) {
    // Check if session has expired (5 minutes)
    if (now - session.createdAt > 5 * 60 * 1000) {
      console.log(`Cleaning up expired session: ${token}`);
      
      // Close browser if still open
      if (session.browser) {
        session.browser.close().catch(err => {
          console.error(`Error closing browser: ${err.message}`);
        });
      }
      
      // Remove from map
      pendingSessions.delete(token);
    }
  }
}, 60 * 1000);

// ===== BROWSER HELPER FUNCTIONS =====

// Simplified sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fast typing function - instant typing with no delay
async function fastType(page, selector, text) {
  logDebug(`Typing into ${selector}...`);
  await page.focus(selector);
  await page.evaluate((selector, text) => {
    const input = document.querySelector(selector);
    if (input) input.value = text;
  }, selector, text);
  logDebug("Typing complete");
}

// Wait for element function with shorter timeouts
async function waitForElement(page, selector, timeout = 3000, description = "element") {
  try {
    logDebug(`Looking for: ${description}`);
    const element = await page.waitForSelector(selector, { 
      visible: true, 
      timeout: timeout 
    });
    
    if (element) {
      logDebug(`Found: ${description}`);
      return element;
    } else {
      logDebug(`Element found but may not be visible: ${description}`);
      return null;
    }
  } catch (error) {
    logDebug(`Could not find: ${description} - ${error.message}`);
    return null;
  }
}

// Setup browser - optimized for speed
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
        '--disable-extensions',
        '--disable-audio-output',
        '--window-size=1200,800',
        '--incognito',
        '--no-zygote', 
        '--no-first-run',
        '--disable-features=site-per-process',
        '--disable-dev-tools',
        '--disable-ipc-flooding-protection',
        '--disable-backgrounding-occluded-windows'
      ],
      ignoreHTTPSErrors: true,
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

// ===== TRADE REPUBLIC FUNCTIONS =====

// Check if already logged in - fast version
async function checkIfLoggedIn(page) {
  try {
    // Check URL first (most reliable indicator)
    const currentUrl = await page.url();
    if (currentUrl.includes('/portfolio') || 
        currentUrl.includes('/dashboard') || 
        currentUrl.includes('/timeline') ||
        currentUrl.includes('/profile')) {
      return true;
    }
    
    // Check for login phone input - if present, we are NOT logged in
    const hasPhoneInput = await page.evaluate(() => {
      return !!document.querySelector('#loginPhoneNumber__input');
    });
    
    if (hasPhoneInput) {
      return false;
    }
    
    // Quick check for portfolio elements
    const isLoggedIn = await page.evaluate(() => {
      const selectors = [
        ".currencyStatus",
        ".portfolioInstrumentList",
        "[class*='portfolioValue']",
        "[class*='dashboard']",
        "[class*='portfolio']"
      ];
      
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) return true;
      }
      
      return false;
    });
    
    return isLoggedIn;
  } catch (error) {
    console.log(`Error checking login status: ${error.message}`);
    return false;
  }
}

// Handle cookie consent - fast version
async function handleCookieConsent(page) {
  try {
    // Execute all in page context for speed
    return await page.evaluate(() => {
      const cookieSelectors = [
        "button.buttonBase.consentCard__action.buttonPrimary",
        ".buttonBase.consentCard__action.buttonPrimary",
        "[data-testid='cookie-banner-accept']",
        ".cookie-banner__accept"
      ];
      
      for (const selector of cookieSelectors) {
        const button = document.querySelector(selector);
        if (button) {
          button.click();
          return true;
        }
      }
      
      return false;
    });
  } catch (error) {
    return false;
  }
}

// Enter phone number - fast version
async function enterPhoneNumber(page, phoneNumber) {
  try {
    // Check for phone field
    const phoneField = await waitForElement(
      page, 
      "#loginPhoneNumber__input", 
      5000, 
      "phone number field"
    );
    
    if (!phoneField) {
      return false;
    }
    
    // Fast type phone number using evaluate (instant)
    await page.evaluate((phoneNumber) => {
      const input = document.querySelector("#loginPhoneNumber__input");
      if (input) input.value = phoneNumber;
    }, phoneNumber);
    
    console.log(`Entered phone number: ${phoneNumber.substring(0, 2)}***`);
    
    // Find and click next button
    const clicked = await page.evaluate(() => {
      const selectors = [
        "button.buttonBase.loginPhoneNumber__action.buttonPrimary",
        ".buttonBase.loginPhoneNumber__action",
        "[data-testid='login-phone-next']"
      ];
      
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button) {
          button.click();
          return true;
        }
      }
      
      return false;
    });
    
    if (!clicked) {
      return false;
    }
    
    return true;
  } catch (error) {
    console.log(`Error entering phone number: ${error.message}`);
    return false;
  }
}

// Enter PIN - fast version
async function enterPIN(page, pin) {
  try {
    // Wait briefly for PIN field to appear
    await sleep(300);
    
    // Use page.evaluate for speed to handle PIN entry
    const pinSuccess = await page.evaluate((pin) => {
      try {
        // First try specific class
        let inputs = document.querySelectorAll('fieldset#loginPin__input input.codeInput__character[type="password"]');
        
        // If not found, try more generic selector
        if (!inputs || inputs.length === 0) {
          inputs = document.querySelectorAll('#loginPin__input input[type="password"]');
        }
        
        // Last resort - try any password input
        if (!inputs || inputs.length === 0) {
          inputs = document.querySelectorAll('input[type="password"]');
        }
        
        if (inputs.length === 0) {
          return false;
        }
        
        // If single input
        if (inputs.length === 1) {
          inputs[0].value = pin;
          const event = new Event('input', { bubbles: true });
          inputs[0].dispatchEvent(event);
          return true;
        }
        
        // If multiple inputs (one per digit)
        for (let i = 0; i < pin.length && i < inputs.length; i++) {
          inputs[i].value = pin[i];
          const event = new Event('input', { bubbles: true });
          inputs[i].dispatchEvent(event);
          
          // Simulate focus on next field
          if (i < inputs.length - 1) {
            inputs[i+1].focus();
          }
        }
        
        return true;
      } catch (e) {
        console.log("Error in PIN entry:", e);
        return false;
      }
    }, pin);
    
    return pinSuccess;
  } catch (error) {
    console.log(`Error entering PIN: ${error.message}`);
    return false;
  }
}

// Handle 2FA - optimized version
async function handle2FA(page, twoFACode) {
  try {
    // Check for 2FA input fields directly
    const is2FARequired = await page.evaluate(() => {
      return !!document.querySelector('#smsCode__input') || 
             !!document.querySelector('[class*="smsCode"]');
    });
    
    if (!is2FARequired) {
      return { success: true, needs2FA: false };
    }
    
    console.log("📱 2FA authentication required");
    
    if (!twoFACode) {
      return { success: false, needs2FA: true };
    }
    
    // Enter 2FA code using direct DOM manipulation for speed
    const codeEntered = await page.evaluate((code) => {
      try {
        // Find SMS input fields
        const inputs = document.querySelectorAll('#smsCode__input input');
        
        if (inputs.length === 0) {
          return false;
        }
        
        // Single input field
        if (inputs.length === 1) {
          inputs[0].value = code;
          const event = new Event('input', { bubbles: true });
          inputs[0].dispatchEvent(event);
          return true;
        }
        
        // Multiple input fields
        for (let i = 0; i < code.length && i < inputs.length; i++) {
          inputs[i].value = code[i];
          const event = new Event('input', { bubbles: true });
          inputs[i].dispatchEvent(event);
          
          // Simulate focus on next field
          if (i < inputs.length - 1) {
            inputs[i+1].focus();
          }
        }
        
        return true;
      } catch (e) {
        return false;
      }
    }, twoFACode);
    
    if (!codeEntered) {
      return { success: false, needs2FA: true, error: "Failed to enter 2FA code" };
    }
    
    console.log("✅ 2FA code entered");
    
    // Brief wait for 2FA processing
    await sleep(500);
    
    return { success: true, needs2FA: false };
  } catch (error) {
    console.log(`Error handling 2FA: ${error.message}`);
    return { success: false, needs2FA: true, error: error.message };
  }
}

// Login to Trade Republic - optimized version
async function loginToTradeRepublic(page, credentials) {
  try {
    console.log("\n📱 Starting Trade Republic login process...");
    
    const { phoneNumber, pin, twoFACode } = credentials;
    
    if (!phoneNumber || !pin) {
      return { success: false, error: "Missing credentials" };
    }
    
    // Check if already logged in
    if (await checkIfLoggedIn(page)) {
      return { success: true };
    }
    
    // Handle cookie consent
    await handleCookieConsent(page);
    
    // Enter phone number
    const phoneSuccess = await enterPhoneNumber(page, phoneNumber);
    
    if (!phoneSuccess) {
      return { success: false, error: "Failed during phone number entry" };
    }
    
    // Minimum wait for page transition
    await sleep(300);
    
    // Enter PIN
    const pinSuccess = await enterPIN(page, pin);
    
    if (!pinSuccess) {
      return { success: false, error: "Failed during PIN entry" };
    }
    
    // Brief wait for PIN processing
    await sleep(500);
    
    // Handle 2FA if provided
    const twoFAResult = await handle2FA(page, twoFACode);
    
    if (twoFAResult.needs2FA) {
      return { success: false, needs2FA: true, error: "2FA code required" };
    }
    
    // Quick wait for login completion
    await sleep(1000);
    
    // Verify login
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (isLoggedIn) {
      console.log("✅ Successfully logged in!");
      return { success: true };
    } else {
      console.log("❌ Login verification failed");
      return { success: false, error: "Login verification failed" };
    }
  } catch (error) {
    console.log(`❌ Login process error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Function to click dropdown - optimized
async function clickSinceBuyEuroOption(page) {
  try {
    // Execute in page context for speed
    return await page.evaluate(() => {
      try {
        // Click dropdown button
        const dropdownButton = document.querySelector(".dropdownList__openButton");
        if (!dropdownButton) return false;
        
        dropdownButton.click();
        
        // Small timeout to wait for dropdown to open
        setTimeout(() => {
          try {
            // Try direct ID first
            let option = document.querySelector("#investments-sinceBuyabs");
            if (option) {
              option.click();
              return true;
            }
            
            // Try by text content
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
          } catch (e) {
            return false;
          }
        }, 300);
        
        return true;
      } catch (e) {
        return false;
      }
    });
  } catch (error) {
    return false;
  }
}

// Get portfolio data - optimized for speed
async function getPortfolioData(page) {
  const data = {
    portfolio_balance: "Not available",
    positions: [],
    cash_balance: "Not available",
    timestamp: new Date().toISOString()
  };
  
  try {
    console.log("\n📊 Fetching portfolio data...");
    
    // Get everything in parallel for speed
    await Promise.all([
      // Get portfolio balance
      (async () => {
        try {
          data.portfolio_balance = await page.evaluate(() => {
            const selectors = [
              ".currencyStatus span[role='status']", 
              "[class*='portfolioValue']",
              "[class*='portfolioBalance']"
            ];
            
            for (const selector of selectors) {
              const el = document.querySelector(selector);
              if (el) return el.textContent.trim();
            }
            
            return "Not available";
          });
          
          console.log(`💰 Portfolio balance: ${data.portfolio_balance}`);
        } catch (error) {
          console.log(`Error getting portfolio balance: ${error.message}`);
        }
      })(),
      
      // Set view to Euro values and get positions
      (async () => {
        try {
          // Try to set view (not critical if it fails)
          await clickSinceBuyEuroOption(page);
          
          // Get positions with a more efficient approach
          const positions = await page.evaluate(() => {
            // Function to scrape positions
            const getPositions = () => {
              const results = [];
              
              // Try to find the list of positions
              const selectors = [
                'ul.portfolioInstrumentList',
                '[class*="portfolioInstrumentList"]',
                '[class*="positionsList"]',
                '[class*="instrumentList"]'
              ];
              
              let items = [];
              
              // Try each selector to find items
              for (const selector of selectors) {
                const list = document.querySelector(selector);
                if (list) {
                  items = list.querySelectorAll('li');
                  if (items.length > 0) break;
                }
              }
              
              // If nothing found, try a generic approach
              if (items.length === 0) {
                items = document.querySelectorAll('[class*="instrumentListItem"], [class*="positionItem"]');
              }
              
              // Process each position
              for (let i = 0; i < items.length; i++) {
                const item = items[i];
                
                // Get name, value, and shares
                let name = "Unknown";
                let value = "Unknown";
                let shares = "Unknown";
                
                // Get name
                const nameElement = item.querySelector('[class*="instrumentName"], [class*="positionName"], [class*="instrumentTitle"]');
                if (nameElement) name = nameElement.textContent.trim();
                
                // Get value
                const valueElement = item.querySelector('[class*="currentPrice"], [class*="positionValue"], [class*="instrumentValue"]');
                if (valueElement) value = valueElement.textContent.trim();
                
                // Get shares
                const sharesElement = item.querySelector('[class*="sharesTag"], [class*="positionQuantity"], [class*="shares"]');
                if (sharesElement) shares = sharesElement.textContent.trim();
                
                // Only add if we have meaningful data
                if (name !== "Unknown" || value !== "Unknown") {
                  results.push({
                    id: `position-${i}`,
                    name,
                    shares,
                    total_value: value
                  });
                }
              }
              
              return results;
            };
            
            return getPositions();
          });
          
          console.log(`Found ${positions.length} positions`);
          
          if (positions.length > 0) {
            data.positions = positions;
          } else {
            // Try once more if no positions found
            setTimeout(async () => {
              const retryPositions = await page.evaluate(getPositions);
              if (retryPositions.length > 0) {
                data.positions = retryPositions;
              }
            }, 1000);
          }
        } catch (error) {
          console.log(`Error getting positions: ${error.message}`);
        }
      })(),
      
      // Get cash balance
      (async () => {
        try {
          // Try to get cash balance from the current page first
          data.cash_balance = await page.evaluate(() => {
            const cashElement = document.querySelector('.cashBalance__amount, [class*="cashBalance"]');
            return cashElement ? cashElement.textContent.trim() : null;
          });
          
          // If we couldn't find it, try navigating to transactions page
          if (!data.cash_balance) {
            // Find transactions link
            const transactionsLink = await page.$('a.navigationItem__link[href="/profile/transactions"]');
            
            if (transactionsLink) {
              await transactionsLink.click();
              await sleep(500);
              
              data.cash_balance = await page.evaluate(() => {
                const cashElement = document.querySelector('.cashBalance__amount, [class*="cashBalance"]');
                return cashElement ? cashElement.textContent.trim() : "Not available";
              });
              
              if (data.cash_balance) {
                console.log(`💰 Cash balance: ${data.cash_balance}`);
              }
              
              // Go back to portfolio
              await page.goto("https://app.traderepublic.com/portfolio", { 
                waitUntil: 'domcontentloaded',
                timeout: 5000
              });
            }
          } else {
            console.log(`💰 Cash balance: ${data.cash_balance}`);
          }
        } catch (error) {
          console.log(`Error getting cash balance: ${error.message}`);
        }
      })()
    ]);
    
    return data;
  } catch (error) {
    console.log(`Error getting portfolio data: ${error.message}`);
    return data;
  }
}

// ===== API ROUTES =====

// Special endpoint for self-pinging
app.get('/api/ping', (req, res) => {
  console.log(`[${new Date().toISOString()}] Received self-ping request`);
  res.json({ 
    status: 'ok', 
    message: 'Service is running',
    time: new Date().toISOString()
  });
});

// GET - Check API status
app.get('/api/status', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'Trade Republic Fast Data API',
    version: '1.1.0',
    activeRequests,
    queuedRequests: requestQueue.length,
    pendingSessions: pendingSessions.size,
    maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
    autoPingMinutes: PING_INTERVAL / 60000,
    preventSpinDown: true
  });
});

// GET DATA endpoint - handles login and retrieval
app.post('/api/getdata', limiter, async (req, res) => {
  const { phoneNumber, pin, twoFACode } = req.body;
  
  // Validate required fields
  if (!phoneNumber || !pin) {
    return res.status(400).json({
      success: false,
      error: 'Phone number and PIN are required'
    });
  }
  
  // Create handler function
  const handler = async () => {
    let browser = null;
    
    try {
      console.log(`Processing request for phone number ${phoneNumber.substring(0, 2)}***`);
      
      // First, check if this is a follow-up request with a 2FA code
      if (twoFACode) {
        console.log("2FA code provided, checking for pending session...");
        
        // Find session by phone/pin
        for (const [token, session] of pendingSessions.entries()) {
          if (session.phoneNumber === phoneNumber && session.pin === pin) {
            console.log(`Found pending 2FA session for ${phoneNumber.substring(0, 2)}***`);
            
            try {
              // Re-use the existing browser and page
              browser = session.browser;
              const page = session.page;
              
              // Submit 2FA code
              console.log("Submitting 2FA code...");
              const twoFAResult = await handle2FA(page, twoFACode);
              
              if (twoFAResult.success) {
                console.log("✅ 2FA verification successful");
                
                // Quick verification
                await sleep(1000);
                const isLoggedIn = await checkIfLoggedIn(page);
                
                if (isLoggedIn) {
                  console.log("✅ Successfully logged in after 2FA!");
                  
                  // Get portfolio data
                  const data = await getPortfolioData(page);
                  
                  // Success! Return data
                  return res.json({
                    success: true,
                    data
                  });
                } else {
                  console.log("❌ Login verification failed after 2FA");
                  return res.status(401).json({
                    success: false,
                    error: "Login verification failed after 2FA"
                  });
                }
              } else {
                console.log("❌ 2FA verification failed");
                return res.status(401).json({
                  success: false,
                  error: twoFAResult.error || "2FA verification failed"
                });
              }
            } catch (error) {
              console.log(`Error processing 2FA: ${error.message}`);
              return res.status(500).json({
                success: false,
                error: `Server error: ${error.message}`
              });
            } finally {
              // Clean up the session regardless of outcome
              console.log("Closing browser after 2FA processing");
              try {
                await browser.close();
              } catch (error) {
                console.log(`Error closing browser: ${error.message}`);
              }
              
              // Remove from pending sessions
              pendingSessions.delete(token);
            }
          }
        }
        
        console.log("No matching pending 2FA session found, starting fresh login");
      }
      
      // This is either a new request or no matching pending session was found
      // Start a fresh login process
      
      // Launch browser with optimized settings
      const startTime = Date.now();
      browser = await setupBrowser();
      console.log(`Browser launched in ${Date.now() - startTime}ms`);
      
      if (!browser) {
        return res.status(500).json({
          success: false,
          error: "Failed to launch browser"
        });
      }
      
      // Get first page and pre-configure
      const pages = await browser.pages();
      const page = pages[0];
      
      // Set user agent and other optimizations
      await Promise.all([
        page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
        page.setRequestInterception(true),
        page.setDefaultNavigationTimeout(15000)
      ]);
      
      // Block unnecessary resources
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
          req.abort();
        } else {
          req.continue();
        }
      });
      
      // Navigate to Trade Republic
      console.log("\n🌐 Opening Trade Republic portfolio...");
      await page.goto("https://app.traderepublic.com/portfolio", { 
        waitUntil: 'domcontentloaded', // Faster than networkidle2
        timeout: 15000
      });
      console.log("✅ Trade Republic page loaded");
      
      // Handle login
      const loginResult = await loginToTradeRepublic(page, { phoneNumber, pin, twoFACode });
      
      if (loginResult.success) {
        console.log("\n🎉 Login successful");
        
        // Get portfolio data
        const data = await getPortfolioData(page);
        
        // Close browser after getting data
        await browser.close();
        browser = null;
        
        // Return success with data
        return res.json({
          success: true,
          data
        });
      } else if (loginResult.needs2FA) {
        console.log("\n📱 2FA required");
        
        // Generate token for 2FA session
        const token = uuidv4();
        
        // Store the session for later use
        pendingSessions.set(token, {
          browser,
          page,
          phoneNumber,
          pin,
          createdAt: Date.now()
        });
        
        console.log(`Stored browser session for 2FA. Token: ${token.substring(0, 8)}...`);
        console.log("LEAVING BROWSER OPEN - waiting for 2FA code submission");
        
        // Set browser to null to prevent it from being closed
        browser = null;
        
        // Return needs2FA response
        return res.status(200).json({
          success: false,
          needs2FA: true,
          message: "2FA code required. Please submit the code you received via SMS."
        });
      } else {
        console.log("\n❌ Login failed");
        
        return res.status(401).json({
          success: false,
          error: loginResult.error || "Login failed - check your credentials"
        });
      }
    } catch (error) {
      console.log(`❌ Error during request: ${error.message}`);
      
      return res.status(500).json({
        success: false,
        error: `Server error: ${error.message}`
      });
    } finally {
      // Close browser only if it's not stored in pendingSessions
      if (browser) {
        console.log("Closing browser at end of request");
        try {
          await browser.close();
        } catch (error) {
          console.log(`Error closing browser: ${error.message}`);
        }
      }
    }
  };
  
  // Queue the request
  queueRequest(handler, res);
});

// For backward compatibility - map /api/login to /api/getdata
app.post('/api/login', (req, res) => {
  console.log("Legacy /api/login endpoint called, forwarding to /api/getdata");
  req.url = '/api/getdata';
  app._router.handle(req, res);
});

// Do an initial ping when the server starts
setTimeout(pingService, 5000);

// Start the server
app.listen(PORT, () => {
  console.log(`Trade Republic API server running on port ${PORT}`);
  console.log(`OPTIMIZED for SPEED - One-time data retrieval mode`);
  console.log(`Self-ping EVERY ${PING_INTERVAL/60000} MINUTES to prevent spin-down`);
  console.log(`Max concurrent requests: ${MAX_CONCURRENT_REQUESTS}`);
});
