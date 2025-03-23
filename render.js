const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// Use stealth plugin to help avoid detection
puppeteer.use(StealthPlugin());

// Simplified sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Get credentials from environment variables
const PHONE_NUMBER = process.env.TR_PHONE_NUMBER;
const PIN = process.env.TR_PIN;

// Stored credentials for fast login
let savedCredentials = {
  phone: PHONE_NUMBER,
  pin: PIN
};

// Fast typing function
async function fastType(page, selector, text) {
  console.log(`Typing into ${selector}...`);
  await page.focus(selector);
  await page.keyboard.type(text, {delay: 0});
  console.log("Typing complete");
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

// Check if already logged in
async function checkIfLoggedIn(page) {
  // Same implementation as your original script
  // ...
}

// Handle cookie consent
async function handleCookieConsent(page) {
  // Same implementation as your original script
  // ...
}

// Enter phone number
async function enterPhoneNumber(page, phoneNumber) {
  // Same implementation as your original script
  // ...
}

// Enter PIN
async function enterPIN(page, pin) {
  // Same implementation as your original script
  // ...
}

// Handle 2FA with special handling for Render
async function handle2FA(page) {
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
    
    // Since we can't interactively input 2FA codes in Render,
    // we need to use another approach
    
    // Option 1: Use a predefined 2FA code (less secure)
    const predefined2FA = process.env.TR_2FA_CODE;
    
    if (predefined2FA) {
      console.log("Using predefined 2FA code from environment variable");
      
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
      
      // Enter predefined SMS code
      if (smsInputs.length === 1) {
        await smsInputs[0].type(predefined2FA, {delay: 0});
      } else {
        for (let i = 0; i < predefined2FA.length && i < smsInputs.length; i++) {
          await smsInputs[i].type(predefined2FA[i], {delay: 0});
        }
      }
      
      console.log("✅ 2FA code entered");
      
      // Brief wait for processing
      await sleep(1000);
      
      return true;
    } else {
      console.log("❌ 2FA required but no predefined code available");
      console.log("Consider using a service without 2FA or implementing a webhook for 2FA codes");
      return false;
    }
  } catch (error) {
    console.log(`Error handling 2FA: ${error.message}`);
    return false;
  }
}

// Login to Trade Republic
async function loginToTradeRepublic(page) {
  try {
    console.log("\n📱 Starting Trade Republic login process...");
    
    // Use credentials from environment variables
    const phoneNumber = PHONE_NUMBER;
    const pin = PIN;
    
    if (!phoneNumber || !pin) {
      console.log("❌ Missing credentials in environment variables");
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
    await handle2FA(page);
    
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
      
      // Try to capture any error messages
      try {
        const errorElements = await page.$('[class*="error"]');
        
        if (errorElements && errorElements.length > 0) {
          console.log("Error messages found:");
          
          for (const el of errorElements) {
            const text = await page.evaluate(e => e.textContent, el);
            console.log(`- ${text}`);
          }
        }
      } catch (error) {
        console.log("Could not extract error messages");
      }
      
      return false;
    }
  } catch (error) {
    console.log(`❌ Login process error: ${error.message}`);
    return false;
  }
}

// Include the rest of your functions (getPortfolioData, printSummary, etc.)
// ...

// Modified main function for Render
async function main() {
  console.log("Trade Republic Portfolio Reader (Render Version)");
  console.log("------------------------------------------------");
  console.log(`Starting service at: ${new Date().toISOString()}`);
  
  let browser = null;
  
  try {
    // Launch browser
    browser = await setupBrowser();
    console.log("✅ Browser launched successfully");
    
    // Use existing page
    const pages = await browser.pages();
    const page = pages[0];
    console.log(`Found ${pages.length} browser page(s)`);
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate directly to portfolio page for faster access
    console.log("\n🌐 Opening Trade Republic portfolio...");
    await page.goto("https://app.traderepublic.com/portfolio", { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    console.log("✅ Trade Republic page loaded");
    
    // Handle login
    const loginSuccess = await loginToTradeRepublic(page);
    
    if (loginSuccess) {
      console.log("\n🎉 Login successful");
      
      // Get portfolio data
      const data = await getPortfolioData(page);
      
      // Print summary
      printSummary(data);
      
      // Optional: Save data to file or send to a webhook
      try {
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const dataToSave = JSON.stringify(data, null, 2);
        
        // Check if WEBHOOK_URL is defined in environment variables
        const webhookUrl = process.env.WEBHOOK_URL;
        if (webhookUrl) {
          console.log(`Sending data to webhook: ${webhookUrl}`);
          // Use fetch to send data to webhook
          const fetch = require('node-fetch');
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: dataToSave
          });
          console.log("✅ Data sent to webhook");
        }
      } catch (error) {
        console.log(`Error saving/sending data: ${error.message}`);
      }
      
      // Set up auto-refresh timer
      let refreshCount = 0;
      const refreshMinutes = parseInt(process.env.REFRESH_MINUTES || "5");
      
      // Run for a limited time to avoid continuous resource usage
      const maxRefreshes = parseInt(process.env.MAX_REFRESHES || "12"); // Default: 12 refreshes
      
      console.log(`\n⏱️ Auto-refresh set for every ${refreshMinutes} minutes, max ${maxRefreshes} times`);
      
      const refreshInterval = setInterval(async () => {
        refreshCount++;
        console.log(`\n🔄 Auto-refresh #${refreshCount} of ${maxRefreshes} triggered (${new Date().toISOString()})`);
        
        await refreshData(page);
        
        // If we've reached the maximum refreshes, stop
        if (refreshCount >= maxRefreshes) {
          console.log(`\n🛑 Reached maximum refresh count (${maxRefreshes}). Shutting down...`);
          clearInterval(refreshInterval);
          
          // Close browser and exit
          await browser.close();
          console.log("Browser closed");
          
          console.log("Service completed successfully");
          process.exit(0);
        }
      }, refreshMinutes * 60 * 1000);
      
    } else {
      console.log("\n❌ Login failed");
      
      try {
        const currentUrl = await page.url();
        console.log(`Current URL: ${currentUrl}`);
        
        // Take a screenshot for debugging
        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const screenshotPath = `/tmp/login-failure-${timestamp}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Screenshot saved to: ${screenshotPath}`);
        
      } catch (error) {
        console.log(`Error during diagnostics: ${error.message}`);
      }
      
      // Close browser and exit with error
      await browser.close();
      process.exit(1);
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    
    // Close browser and exit with error
    if (browser) await browser.close();
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
