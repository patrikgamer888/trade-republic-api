# portfolio_fetcher.py - Modified for API use
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException
import time
import traceback
import base64
import os

def fetch_portfolio(phone_number, pin):
    """
    Fetch portfolio data from Trade Republic using Selenium.
    Takes credentials as parameters instead of prompting for input.
    
    Parameters:
    - phone_number: Trade Republic phone number
    - pin: Trade Republic PIN
    
    Returns:
    - Dictionary with portfolio data
    """
    driver = None
    result = {
        "success": False,
        "error": None,
        "portfolio_balance": "Not available",
        "positions": [],
        "cash_balance": "Not available"
    }
    
    try:
        # Setup headless driver
        driver = setup_headless_driver()
        
        # Navigate to Trade Republic
        driver.get("https://app.traderepublic.com")
        print("Opened Trade Republic")
        
        # Handle login using provided credentials
        if login_to_trade_republic(driver, phone_number, pin):
            print("Successfully logged in")
            
            # Get portfolio data
            data = get_portfolio_data(driver)
            
            # Update result with portfolio data
            result.update(data)
            result["success"] = True
        else:
            error_msg = "Login failed"
            print(error_msg)
            result["error"] = error_msg
    except Exception as e:
        error_msg = f"An error occurred: {str(e)}"
        print(error_msg)
        traceback.print_exc()
        result["error"] = error_msg
    finally:
        if driver:
            driver.quit()
    
    return result

def setup_headless_driver():
    """Set up a highly undetectable headless Chrome browser with proper GPU settings."""
    options = Options()
    
    # Headless mode
    options.add_argument("--headless=new")  # Use the new headless mode
    
    # Fix GPU/WebGL issues
    options.add_argument("--disable-gpu")
    options.add_argument("--enable-unsafe-swiftshader")  # Allow software WebGL rendering
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--no-sandbox")
    
    # Disable logging for cleaner output
    options.add_argument("--log-level=3")
    options.add_experimental_option("excludeSwitches", ["enable-logging"])
    
    # Set a realistic viewport and window size
    options.add_argument("--window-size=1920,1080")
    
    # Add a realistic user agent
    options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    
    # Hide automation flags
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    
    # Add arguments that make detection harder
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-web-security")
    options.add_argument("--disable-notifications")
    options.add_argument("--disable-popup-blocking")
    options.add_argument("--ignore-certificate-errors")
    options.add_argument("--allow-running-insecure-content")
    
    # JavaScript preferences
    prefs = {
        "profile.default_content_setting_values.javascript": 1,
        "profile.managed_default_content_settings.javascript": 1,
        "credentials_enable_service": False,
        "profile.password_manager_enabled": False
    }
    options.add_experimental_option("prefs", prefs)
    
    # Set service log level to suppress console errors
    service = Service(log_output=os.devnull)
    
    try:
        driver = webdriver.Chrome(options=options, service=service)
        
        # Mask WebDriver presence
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": """
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """
        })
        
        # Verify the browser is working
        print("Chrome driver initialized, checking JavaScript...")
        driver.get("about:blank")
        driver.execute_script("return 'JavaScript working!'")
        
        return driver
    except Exception as e:
        print(f"Error setting up headless driver: {e}")
        traceback.print_exc()
        try:
            # Fallback to non-headless if headless fails
            print("Trying to initialize non-headless driver as fallback...")
            options = Options()
            options.add_argument("--start-minimized")
            options.add_argument("--window-size=1,1")
            driver = webdriver.Chrome(options=options)
            return driver
        except:
            raise

def captcha_debug_screenshot(driver, name):
    """Take an in-memory screenshot for debugging without saving to disk."""
    try:
        # Take screenshot as base64
        screenshot = driver.get_screenshot_as_base64()
        print(f"Debug screenshot [{name}] - size: {len(base64.b64decode(screenshot))} bytes")
        # We're not saving it, just indicating it was captured for debugging
    except:
        print(f"Could not take debug screenshot [{name}]")

def wait_for_element(driver, by, selector, timeout=10, description="element"):
    """Wait for an element to be present with detailed error reporting."""
    try:
        element = WebDriverWait(driver, timeout).until(
            EC.presence_of_element_located((by, selector))
        )
        print(f"Found {description}")
        return element
    except TimeoutException:
        print(f"Timeout waiting for {description}")
        captcha_debug_screenshot(driver, f"timeout_{description}")
        return None
    except Exception as e:
        print(f"Error finding {description}: {e}")
        captcha_debug_screenshot(driver, f"error_{description}")
        return None

def login_to_trade_republic(driver, phone_number, pin):
    """Handle the login process with credentials passed as parameters."""
    try:
        # Wait for login page to load fully
        print("Waiting for page to load...")
        wait_for_element(driver, By.TAG_NAME, "body", 20, "page body")
        
        # Take debug screenshot
        captcha_debug_screenshot(driver, "initial_page")
        
        # Handle cookie consent if present
        try:
            cookie_selectors = [
                "button.buttonBase.consentCard__action.buttonPrimary",
                ".buttonBase.consentCard__action.buttonPrimary",
                "[data-testid='cookie-banner-accept']",
                ".cookie-banner__accept"
            ]
            
            for selector in cookie_selectors:
                try:
                    cookie_button = wait_for_element(driver, By.CSS_SELECTOR, selector, 5, "cookie button")
                    if cookie_button:
                        cookie_button.click()
                        print("Accepted cookies")
                        time.sleep(1)
                        break
                except:
                    continue
        except:
            print("No cookie prompt found or already accepted")
        
        # Wait for and enter phone number
        phone_field = wait_for_element(driver, By.ID, "loginPhoneNumber__input", 15, "phone number field")
        if not phone_field:
            print("Phone number field not found, checking if already logged in...")
            # Check if we're already logged in
            if check_if_logged_in(driver):
                return True
            else:
                return False
                
        # Enter phone number
        phone_field.clear()
        phone_field.send_keys(phone_number)
        
        # Click next button (try multiple selector approaches)
        next_button_selectors = [
            "button.buttonBase.loginPhoneNumber__action.buttonPrimary",
            ".buttonBase.loginPhoneNumber__action",
            "[data-testid='login-phone-next']"
        ]
        
        next_button = None
        for selector in next_button_selectors:
            try:
                next_button = wait_for_element(driver, By.CSS_SELECTOR, selector, 5, "next button")
                if next_button:
                    break
            except:
                continue
                
        if not next_button:
            print("Next button not found")
            captcha_debug_screenshot(driver, "next_button_not_found")
            return False
            
        next_button.click()
        print("Entered phone number")
        time.sleep(2)
        
        # Check for errors in phone number entry
        try:
            error_element = driver.find_element(By.CSS_SELECTOR, "[class*='error']")
            if error_element.is_displayed():
                print(f"Error after phone entry: {error_element.text}")
                captcha_debug_screenshot(driver, "phone_error")
                return False
        except:
            pass
        
        # Wait for PIN input
        pin_fieldset = wait_for_element(driver, By.ID, "loginPin__input", 15, "PIN fieldset")
        if not pin_fieldset:
            print("PIN input not found")
            captcha_debug_screenshot(driver, "pin_input_not_found")
            return False
            
        pin_inputs = pin_fieldset.find_elements(By.TAG_NAME, "input")
        
        if len(pin_inputs) == 0:
            print("No PIN input fields found")
            captcha_debug_screenshot(driver, "no_pin_fields")
            return False
            
        # Enter PIN
        if len(pin_inputs) == 1:
            pin_inputs[0].clear()
            pin_inputs[0].send_keys(pin)
        else:
            for i, digit in enumerate(pin):
                if i < len(pin_inputs):
                    pin_inputs[i].clear()
                    pin_inputs[i].send_keys(digit)
        
        print("Entered PIN")
        time.sleep(3)
        
        # Check for errors in PIN entry
        try:
            error_element = driver.find_element(By.CSS_SELECTOR, "[class*='error']")
            if error_element.is_displayed():
                print(f"Error after PIN entry: {error_element.text}")
                captcha_debug_screenshot(driver, "pin_error")
                return False
        except:
            pass
        
        # Handle 2FA if needed
        try:
            sms_fieldset = wait_for_element(driver, By.ID, "smsCode__input", 8, "2FA input")
            if sms_fieldset:
                # For API use, we need to handle 2FA differently - returning a status that requires 2FA
                print("2FA required but not supported in API mode")
                return False
        except:
            print("No 2FA prompt found or already logged in")
        
        # Wait for login to complete
        print("Waiting for login to complete...")
        time.sleep(10)
        
        # Verify we're logged in
        return check_if_logged_in(driver)
        
    except Exception as e:
        print(f"Login error: {e}")
        traceback.print_exc()
        captcha_debug_screenshot(driver, "login_error")
        return False

# The rest of the functions remain almost the same
def check_if_logged_in(driver):
    """Check if we're already logged in to Trade Republic."""
    # Try different elements that would indicate successful login
    try:
        # Try to find the portfolio balance element or other dashboard elements
        logged_in_indicators = [
            ".currencyStatus",
            ".portfolioInstrumentList",
            "[class*='portfolioValue']",
            "[class*='dashboard']"
        ]
        
        for selector in logged_in_indicators:
            try:
                element = driver.find_element(By.CSS_SELECTOR, selector)
                if element.is_displayed():
                    print(f"Login successful (detected {selector})")
                    return True
            except:
                continue
                
        print("Could not verify login success")
        captcha_debug_screenshot(driver, "login_verification")
        return False
    except Exception as e:
        print(f"Error checking login status: {e}")
        return False

def set_view_to_total_value(driver):
    """Click dropdown and select 'Since buy (€)' to show total values."""
    try:
        # Find and click the dropdown button
        dropdown_selectors = [
            ".dropdownListopenButton", 
            "button.dropdownListopenButton",
            "[class*='dropdownList'][class*='openButton']"
        ]
        
        dropdown_button = None
        for selector in dropdown_selectors:
            try:
                dropdown_button = wait_for_element(driver, By.CSS_SELECTOR, selector, 5, "dropdown button")
                if dropdown_button:
                    print(f"Found dropdown button with selector: {selector}")
                    break
            except:
                continue
                
        if not dropdown_button:
            print("Dropdown button not found")
            captcha_debug_screenshot(driver, "dropdown_not_found")
            return False
            
        dropdown_button.click()
        print("Clicked dropdown button")
        time.sleep(2)  # Give dropdown time to open
        
        # Use the EXACT selector path provided by the user
        try:
            # Try the exact selector provided
            since_buy_option = driver.find_element(By.CSS_SELECTOR, "#investments-sinceBuyabs > div:nth-child(1) > p")
            option_text = since_buy_option.text.strip()
            print(f"Found 'Since buy' option with exact selector: '{option_text}'")
            since_buy_option.click()
            print(f"Selected option: {option_text}")
            time.sleep(2)  # Wait for view to update
            return True
        except Exception as e:
            print(f"Could not find 'Since buy' option with exact selector: {e}")
            
            # Print all available options for debugging
            print("Available options:")
            try:
                options = driver.find_elements(By.CSS_SELECTOR, "p[class*='optionName']")
                for i, option in enumerate(options):
                    print(f"Option {i+1}: '{option.text}'")
                    # If we find a "Since buy" option, click it
                    if "Since buy" in option.text and "€" in option.text:
                        option.click()
                        print(f"Selected 'Since buy' option: {option.text}")
                        time.sleep(2)
                        return True
            except Exception as e:
                print(f"Error listing options: {e}")
            
            # Try finding by ID only
            try:
                since_buy_option = driver.find_element(By.ID, "investments-sinceBuyabs")
                print(f"Found element by ID: {since_buy_option.text}")
                since_buy_option.click()
                print("Clicked element by ID")
                time.sleep(2)
                return True
            except Exception as e:
                print(f"Could not find by ID: {e}")
                
            # As a last resort, try to find an option with "Since buy" in it
            try:
                xpath = "//p[contains(text(), 'Since buy')]"
                since_buy_option = driver.find_element(By.XPATH, xpath)
                print(f"Found option with XPath: {since_buy_option.text}")
                since_buy_option.click()
                print(f"Selected option with XPath: {since_buy_option.text}")
                time.sleep(2)
                return True
            except Exception as e:
                print(f"Could not find with XPath: {e}")
                
            print("Could not find 'Since buy (€)' option")
            return False
    except Exception as e:
        print(f"Error setting view to total values: {e}")
        traceback.print_exc()
        return False

def get_portfolio_data(driver):
    """Get portfolio balance, positions with total values, and cash balance."""
    data = {
        "portfolio_balance": "Not available",
        "positions": [],
        "cash_balance": "Not available"
    }
    
    try:
        # Get portfolio balance from main page
        try:
            balance_selectors = [
                ".currencyStatus span[role='status']", 
                "[class*='portfolioValue']",
                "[class*='portfolioBalance']"
            ]
            
            for selector in balance_selectors:
                try:
                    balance_element = wait_for_element(driver, By.CSS_SELECTOR, selector, 5, "portfolio balance")
                    if balance_element:
                        data["portfolio_balance"] = balance_element.text.strip()
                        print(f"Portfolio balance: {data['portfolio_balance']}")
                        break
                except:
                    continue
        except Exception as e:
            print(f"Error getting portfolio balance: {e}")
        
        # Set view to show total values instead of price per share
        if not set_view_to_total_value(driver):
            print("Warning: Could not set view to show total values")
        
        # Find the portfolio list
        portfolio_list = None
        list_selectors = [
            "ul.portfolioInstrumentList",
            "[class*='portfolioInstrumentList']",
            "ul[class*='portfolio']"
        ]
        
        for selector in list_selectors:
            try:
                portfolio_list = wait_for_element(driver, By.CSS_SELECTOR, selector, 5, "portfolio list")
                if portfolio_list:
                    break
            except:
                continue
                
        if not portfolio_list:
            print("Could not find portfolio list")
            captcha_debug_screenshot(driver, "portfolio_list_not_found")
            return data
        
        # Get all position items (li elements)
        position_items = portfolio_list.find_elements(By.TAG_NAME, "li")
        print(f"Found {len(position_items)} positions")
        
        # Process each position
        for index, position_element in enumerate(position_items):
            try:
                # Get position ID
                position_id = position_element.get_attribute("id")
                print(f"Position {index+1} ID: {position_id}")
                
                if not position_id:
                    print(f"Position {index+1} has no ID, skipping")
                    continue
                
                # Create position data structure
                position_data = {
                    "id": position_id,
                    "name": "Unknown",
                    "total_value": "Unknown"
                }
                
                # Get position name
                try:
                    # Try multiple approaches to find name
                    name_selectors = [
                        f"#{position_id} > div > div.instrumentListItem__info > span.instrumentListItem__name",
                        f"#{position_id} .instrumentListItem__name",
                        ".instrumentListItem__name"
                    ]
                    
                    for selector in name_selectors:
                        try:
                            name_element = driver.find_element(By.CSS_SELECTOR, selector)
                            if name_element:
                                position_data["name"] = name_element.text.strip()
                                break
                        except:
                            continue
                except Exception as e:
                    print(f"Error getting name for position {index+1}: {e}")
                
                print(f"Position {index+1} name: {position_data['name']}")
                
                # Get position total value
                try:
                    # Try multiple approaches to find value
                    value_selectors = [
                        f"#{position_id} > div > div.instrumentListItem__info > span.instrumentListItem__priceRow > span.instrumentListItem__currentPrice",
                        f"#{position_id} .instrumentListItem__currentPrice",
                        ".instrumentListItem__currentPrice"
                    ]
                    
                    for selector in value_selectors:
                        try:
                            value_element = driver.find_element(By.CSS_SELECTOR, selector)
                            if value_element:
                                position_data["total_value"] = value_element.text.strip()
                                break
                        except:
                            continue
                except Exception as e:
                    print(f"Error getting value for position {index+1}: {e}")
                
                print(f"Position {index+1} total value: {position_data['total_value']}")
                
                # Add to our positions list
                data["positions"].append(position_data)
                
            except Exception as e:
                print(f"Error processing position {index+1}: {e}")
        
        # Get cash balance from transactions page
        try:
            # Navigate to transactions page
            transaction_link_selectors = [
                "a[href='/profile/transactions']",
                "//a[contains(@href, '/profile/transactions')]",
                "[class*='transactions']"
            ]
            
            transactions_link = None
            for selector in transaction_link_selectors:
                try:
                    if selector.startswith("//"):
                        transactions_link = wait_for_element(driver, By.XPATH, selector, 5, "transactions link")
                    else:
                        transactions_link = wait_for_element(driver, By.CSS_SELECTOR, selector, 5, "transactions link")
                    if transactions_link:
                        break
                except:
                    continue
                    
            if not transactions_link:
                print("Transactions link not found")
                return data
                
            transactions_link.click()
            print("Navigated to transactions page")
            time.sleep(3)
            
            # Find cash balance
            cash_selectors = [
                ".cashBalance__amount",
                "[class*='cashBalance']",
                "[class*='balance'][class*='amount']"
            ]
            
            for selector in cash_selectors:
                try:
                    cash_element = wait_for_element(driver, By.CSS_SELECTOR, selector, 5, "cash balance")
                    if cash_element:
                        data["cash_balance"] = cash_element.text.strip()
                        print(f"Cash balance: {data['cash_balance']}")
                        break
                except:
                    continue
            
        except Exception as e:
            print(f"Error getting cash balance: {e}")
        
    except Exception as e:
        print(f"Error getting portfolio data: {e}")
        traceback.print_exc()
    
    return data
