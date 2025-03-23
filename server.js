const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const rateLimit = require('express-rate-limit');

// Use stealth plugin to help avoid detection
puppeteer.use(StealthPlugin());

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Configure middleware
app.use(bodyParser.json());

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
      return true;
    }
    
    console.log("📱 2FA authentication required");
    
    if (!twoFACode) {
      console.log("❌ 2FA required but no code provided");
      return false;
    }
    
    // Wait for SMS code field
    const smsField = await waitForElement(page, "#smsCode__input", 5000, "2FA input field");
    
    if (!smsField) {
      console.log("❌ 2FA input field not found");
      return false;
    }
    
    // Find SMS input fields
    const smsInputs = await page.$$('#smsCode__input input');
    
    if (smsInputs.length === 0) {
      console.log("❌ No 2FA input fields found");
      return false;
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
    
    return true;
  } catch (error) {
    console.log(`Error handling 2FA: ${error.message}`);
    return false;
  }
}

// Login to Trade Republic
async function loginToTradeRepublic(page, credentials) {
  try {
    console.log("\n📱 Starting Trade Republic login process...");
    
    const { phoneNumber, pin, twoFACode } = credentials;
    
    if (!phoneNumber || !pin) {
      console.log("❌ Missing required credentials");
      return false;
    }
    
    console.log(`Using phone number: ${phoneNumber.substring(0, 2)}***`);
    
    // Check if already logged in
    if (await checkIfLoggedIn(page)) {
      return true;
    }
    
    // Handle cookie consent if present
    await handleCookieConsent(page);
    
    // Enter phone number and proceed
    const phoneSuccess = await enterPhoneNumber(page, phoneNumber);
    
    if (!phoneSuccess) {
      console.log("❌ Failed during phone number entry");
      return false;
    }
    
    // Enter PIN code
    const pinSuccess = await enterPIN(page, pin);
    
    if (!pinSuccess) {
      console.log("❌ Failed during PIN entry");
      return false;
    }
    
    // Handle 2FA if needed
    if (twoFACode) {
      await handle2FA(page, twoFACode);
    }
    
    // Wait for login to complete
    console.log("Waiting for login to complete...");
    await sleep(2000);
    
    // Final check to verify login success
    const isLoggedIn = await checkIfLoggedIn(page);
    
    if (isLoggedIn) {
      console.log("✅ Successfully logged in!");
      return true;
    } else {
      console.log("❌ Login verification failed");
      console.log("Current URL: " + await page.url());
      return false;
    }
  } catch (error) {
    console.log(`❌ Login process error: ${error.message}`);
    return false;
  }
}

// Get portfolio data (include your existing implementation here)
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
      await clickSinceBuyEuroOption(page);  // You need to include this function from your original script
    } else {
      console.log("Skipping dropdown selection (using existing view)");
    }
    
    // Get all position data
    // Include your existing implementation for finding positions
    
    // Get cash balance
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
        await sleep(500);
        
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
        await sleep(500);
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

// Define the main API routes

// POST - Get portfolio data with provided credentials
app.post('/api/portfolio', limiter, async (req, res) => {
  const { phoneNumber, pin, twoFACode } = req.body;
  
  // Validate inputs
  if (!phoneNumber || !pin) {
    return res.status(400).json({ error: 'Phone number and PIN are required' });
  }
  
  let browser = null;
  
  try {
    // Launch browser
    browser = await setupBrowser();
    console.log("✅ Browser launched successfully");
    
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
    const loginSuccess = await loginToTradeRepublic(page, { phoneNumber, pin, twoFACode });
    
    if (loginSuccess) {
      console.log("\n🎉 Login successful");
      
      // Get portfolio data
      const data = await getPortfolioData(page);
      
      // Close browser
      await browser.close();
      
      // Return data as JSON
      return res.json({
        success: true,
        data: data
      });
      
    } else {
      console.log("\n❌ Login failed");
      
      // Close browser
      await browser.close();
      
      return res.status(401).json({
        success: false,
        error: 'Login failed - check credentials or 2FA code'
      });
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    
    // Close browser if it exists
    if (browser) await browser.close();
    
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
    version: '1.0.0'
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Trade Republic API server running on port ${PORT}`);
});
