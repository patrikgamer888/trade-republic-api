import asyncio, json, sys, os, csv, re
from pathlib import Path
from pytr.account import login
from pytr.dl import DL
from pytr.portfolio import Portfolio
from pytr.details import Details  # Import for ISIN details
from datetime import datetime, timedelta
import pytz
import threading
import time
from flask import Flask, request, jsonify, send_file, session
import requests
import logging
from werkzeug.serving import run_simple
import io
import zipfile
import uuid

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(24).hex())

# Configure output directory
OUT = Path("pytr_out")
OUT.mkdir(exist_ok=True)

# Global variables to store auth sessions
# This is a simple in-memory storage. For production, use Redis or a database
AUTH_SESSIONS = {}

# Define timezone constants
TZ_EUROPE_BERLIN = pytz.timezone('Europe/Berlin')

class QuickDL(DL):
    def dl_doc(self, *_, **__):               # skip PDFs
        pass
    def work_responses(self):                 # finish immediately
        raise SystemExit

def save_details_to_csv(details_obj, output_file):
    """
    Save details object data to a CSV file.
    This is a custom function since Details class doesn't have a details_to_csv method.
    """
    # Let's inspect what attributes and data are actually available in the Details object
    logger.info(f"Available attributes in Details object: {dir(details_obj)}")
    
    # Check for various possible attribute names where data might be stored
    data_to_save = {}
    
    # Try to access various possible attributes where data might be stored
    for attr_name in ['details', 'data', '_data', 'instrument_details', 'instrument', 'response', 'instrumentSuitability']:
        if hasattr(details_obj, attr_name):
            logger.info(f"Found attribute: {attr_name}")
            try:
                attr_value = getattr(details_obj, attr_name)
                logger.info(f"Data type: {type(attr_value)}")
                if attr_value:
                    logger.info(f"Data preview: {str(attr_value)[:200]}...")
                    # Add this data to our collection
                    if isinstance(attr_value, dict):
                        data_to_save[attr_name] = attr_value
                    else:
                        data_to_save[attr_name] = str(attr_value)
            except Exception as e:
                logger.error(f"Error accessing {attr_name}: {e}")
    
    # Also check class variables and instance variables
    for var_name in vars(details_obj):
        if not var_name.startswith('_') and var_name not in data_to_save:
            try:
                var_value = getattr(details_obj, var_name)
                if var_value is not None and not callable(var_value):
                    logger.info(f"Found instance variable: {var_name}")
                    data_to_save[var_name] = var_value
            except Exception as e:
                logger.error(f"Error accessing {var_name}: {e}")
    
    if data_to_save:
        # Convert dictionary to a CSV format
        with open(output_file, 'w', newline='', encoding='utf-8') as f:
            # First, flatten the nested details data
            flattened_data = {}
            for key, value in data_to_save.items():
                if isinstance(value, dict):
                    for subkey, subvalue in value.items():
                        # Convert complex objects to string to avoid JSON in CSV
                        if isinstance(subvalue, (dict, list)):
                            continue  # Skip complex nested data
                        flattened_data[f"{key}_{subkey}"] = subvalue
                elif not isinstance(value, (dict, list)):  # Skip complex objects
                    flattened_data[key] = value
            
            # Write to CSV
            writer = csv.writer(f, delimiter=';')
            writer.writerow(["Property", "Value"])
            for key, value in flattened_data.items():
                # Don't use json.dumps, just use simple values
                writer.writerow([key, value])
        
        logger.info(f"Details saved to {output_file}")
    else:
        logger.info(f"No details data available for {output_file}")
        # Write empty file with header
        with open(output_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f, delimiter=';')
            writer.writerow(["Property", "Value"])
            writer.writerow(["status", "no_data"])
    
    # Check if this is a derivative and return that information
    is_derivative = False
    for key, value in flattened_data.items():
        if key.endswith("_typeId") and str(value).lower() == "derivative":
            is_derivative = True
            logger.info(f"Identified as derivative: {output_file}")
            break
    
    return is_derivative

def fix_trade_republic_csv(csv_file):
    """
    Fix timezone issues specifically for Trade Republic CSV format with ISO8601 dates.
    This function is tailored to the exact format shown in the sample:
    Date;Type;Value;Note;ISIN;Shares;Fees;Taxes
    2025-01-19T21:27:37;Deposit;1.0;Patrik Tecsi;;;;
    """
    logger.info(f"Fixing dates in {csv_file}")
    if not csv_file.exists():
        logger.error(f"File not found: {csv_file}")
        return False
    
    # Read the file
    with open(csv_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    if not lines:
        logger.error("File is empty")
        return False
    
    # Process the header and find date column index
    header = lines[0].strip().split(';')
    date_column_index = -1
    for i, col in enumerate(header):
        if col.lower() == 'date':
            date_column_index = i
            break
    
    if date_column_index == -1:
        logger.error("Date column not found in header")
        return False
    
    logger.info(f"Found date column at index {date_column_index}: {header[date_column_index]}")
    
    # Regular expression for ISO8601 format with T separator
    # Format: 2025-01-19T21:27:37
    iso8601_pattern = re.compile(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})')
    
    # Track if we made any changes
    changes_made = False
    
    # Process each line except header
    new_lines = [lines[0]]
    for i, line in enumerate(lines[1:], 1):
        parts = line.strip().split(';')
        if len(parts) <= date_column_index:
            logger.warning(f"Line {i} has fewer columns than expected: {line.strip()}")
            new_lines.append(line)
            continue
        
        date_str = parts[date_column_index]
        match = iso8601_pattern.match(date_str)
        if match:
            # Extract date parts
            year, month, day, hour, minute, second = map(int, match.groups())
            
            # Create naive datetime
            dt = datetime(year, month, day, hour, minute, second)
            
            # Determine if Europe/Berlin would be in DST at this time
            # First make a timezone-aware datetime in UTC
            utc_dt = pytz.utc.localize(dt)
            
            # Convert to Europe/Berlin time - this will automatically 
            # handle the DST offset correctly
            berlin_dt = utc_dt.astimezone(TZ_EUROPE_BERLIN)
            
            # Format back to ISO8601 with T separator
            new_date_str = berlin_dt.strftime('%Y-%m-%dT%H:%M:%S')
            
            if new_date_str != date_str:
                logger.info(f"Line {i}: Changed {date_str} to {new_date_str}")
                parts[date_column_index] = new_date_str
                changes_made = True
        else:
            logger.warning(f"Line {i}: Date doesn't match ISO8601 format: {date_str}")
        
        new_lines.append(';'.join(parts) + '\n')
    
    # Write back if changes were made
    if changes_made:
        with open(csv_file, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        logger.info(f"Fixed dates in {csv_file}")
        return True
    else:
        logger.info("No changes were needed")
        return False

def fix_transaction_dates_direct(transactions_file):
    """
    Fix timezone issues by directly modifying the file as text.
    This is a more direct approach that might work when the CSV parsing fails.
    """
    logger.info(f"Attempting direct file modification for {transactions_file}")
    
    if not transactions_file.exists():
        logger.error(f"Transactions file not found: {transactions_file}")
        return False
    
    # Read the file as text
    with open(transactions_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_content = content
    
    # Replace patterns that look like dates with adjusted dates
    # Common formats: 2023-05-15, 15.05.2023, 2023-05-15 14:30:00
    
    # Pattern for yyyy-mm-dd
    patterns = [
        # ISO date: 2023-05-15
        (r'(\d{4})-(\d{2})-(\d{2})', lambda m: handle_date_match(m, 'iso')),
        
        # European date: 15.05.2023
        (r'(\d{2})\.(\d{2})\.(\d{4})', lambda m: handle_date_match(m, 'euro')),
        
        # ISO datetime: 2023-05-15 14:30:00
        (r'(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})', lambda m: handle_datetime_match(m, 'iso')),
        
        # European datetime: 15.05.2023 14:30:00
        (r'(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})', lambda m: handle_datetime_match(m, 'euro')),
        
        # ISO datetime with T: 2023-05-15T14:30:00
        (r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})', lambda m: handle_datetime_match(m, 'iso_t'))
    ]
    
    def handle_date_match(match, format_type):
        if format_type == 'iso':
            year, month, day = match.groups()
        else:  # euro
            day, month, year = match.groups()
        
        # Create datetime object
        dt = datetime(int(year), int(month), int(day))
        
        # Add hours based on month
        if 3 <= dt.month <= 10:
            dt = dt + timedelta(hours=2)
        else:
            dt = dt + timedelta(hours=1)
        
        # Format back
        if format_type == 'iso':
            return f"{dt.year}-{dt.month:02d}-{dt.day:02d}"
        else:  # euro
            return f"{dt.day:02d}.{dt.month:02d}.{dt.year}"
    
    def handle_datetime_match(match, format_type):
        if format_type == 'iso' or format_type == 'iso_t':
            year, month, day, hour, minute, second = match.groups()
        else:  # euro
            day, month, year, hour, minute, second = match.groups()
        
        # Create datetime object
        dt = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second))
        
        # Add hours based on month
        if 3 <= dt.month <= 10:
            dt = dt + timedelta(hours=2)
        else:
            dt = dt + timedelta(hours=1)
        
        # Format back
        if format_type == 'iso':
            return f"{dt.year}-{dt.month:02d}-{dt.day:02d} {dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
        elif format_type == 'iso_t':
            return f"{dt.year}-{dt.month:02d}-{dt.day:02d}T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
        else:  # euro
            return f"{dt.day:02d}.{dt.month:02d}.{dt.year} {dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
    
    # Apply all patterns
    replaced_count = 0
    for pattern, replacement_func in patterns:
        # Count matches before replacement
        matches_before = len(re.findall(pattern, content))
        # Apply replacement
        content = re.sub(pattern, replacement_func, content)
        # Count matches after replacement
        matches_after = len(re.findall(pattern, content))
        replaced_count += matches_before - matches_after
    
    # Write back if changes were made
    if content != original_content:
        with open(transactions_file, 'w', encoding='utf-8') as f:
            f.write(content)
        logger.info(f"Applied approximately {replaced_count} direct date fixes")
        return True
    else:
        logger.info("No changes made with direct approach")
        return False

def fix_transaction_dates(transactions_file):
    """
    Fix timezone issues in transactions file.
    Adds 1-2 hours to dates to correct for timezone differences.
    """
    logger.info(f"Fixing timezone issues in transactions file: {transactions_file}")
    
    if not transactions_file.exists():
        logger.error(f"Transactions file not found: {transactions_file}")
        return
    
    # Read transactions data
    transactions_data = []
    header = []
    with open(transactions_file, newline='', encoding='utf-8') as f:
        reader = csv.reader(f, delimiter=';')
        header = next(reader)
        transactions_data = list(reader)
    
    logger.info(f"Transaction file headers: {header}")
    
    # Define all possible date formats
    date_formats = {
        "yyyy-mm-dd": "%Y-%m-%d",
        "yyyy-mm-dd hh:mm:ss": "%Y-%m-%d %H:%M:%S",
        "yyyy-mm-ddThh:mm:ss": "%Y-%m-%dT%H:%M:%S",
        "yyyy-mm-dd hh:mm:ss.sss": "%Y-%m-%d %H:%M:%S.%f",
        "dd.mm.yyyy": "%d.%m.%Y", 
        "dd.mm.yyyy hh:mm:ss": "%d.%m.%Y %H:%M:%S",
        "dd.mm.yyyy hh:mm": "%d.%m.%Y %H:%M",
        "dd/mm/yyyy": "%d/%m/%Y",
        "dd/mm/yyyy hh:mm:ss": "%d/%m/%Y %H:%M:%S",
        "mm/dd/yyyy": "%m/%d/%Y",
        "mm/dd/yyyy hh:mm:ss": "%m/%d/%Y %H:%M:%S",
        "dd-mm-yyyy": "%d-%m-%Y",
        "dd-mm-yyyy hh:mm:ss": "%d-%m-%Y %H:%M:%S"
    }
    
    # Explicitly target known date columns AND search for potential date columns
    date_columns = ["Date", "Datetime", "Trade Date", "Trade Time", "Trade DateTime", 
                    "Settlement Date", "Created", "CreatedAt", "Created At",
                    "TransactionTime", "Transaction Time", "Datum", "Zeit", "Uhrzeit"]
    
    date_indices = []
    
    # Find exact matches in header
    for col in date_columns:
        if col in header:
            idx = header.index(col)
            date_indices.append(idx)
            logger.info(f"Found exact date column: {col} at index {idx}")
    
    # Also look for columns containing date/time in their name
    for i, col in enumerate(header):
        if i not in date_indices and ('date' in col.lower() or 'time' in col.lower() or 'zeit' in col.lower()):
            date_indices.append(i)
            logger.info(f"Found potential date column: {col} at index {i}")
    
    if not date_indices:
        logger.warning("No date columns found in transactions file")
        # Since we couldn't find columns automatically, print first few rows for debugging
        logger.info("First 3 rows of data:")
        for i, row in enumerate(transactions_data[:3]):
            logger.info(f"Row {i}: {row}")
        return
    
    logger.info(f"Found date columns at indices: {date_indices}")
    
    # Check the first few values in the date columns
    for idx in date_indices:
        logger.info(f"Sample values for column {header[idx]}:")
        for row in transactions_data[:5]:
            if idx < len(row):
                logger.info(f"  {row[idx]}")
    
    # Process each row
    fixes_applied = 0
    for row_idx, row in enumerate(transactions_data):
        for date_idx in date_indices:
            if date_idx < len(row):
                date_str = row[date_idx]
                if date_str and date_str.strip():
                    # Try to parse date with different formats
                    parsed_date = None
                    used_format = None
                    
                    for format_name, fmt in date_formats.items():
                        try:
                            parsed_date = datetime.strptime(date_str, fmt)
                            used_format = fmt
                            break
                        except ValueError:
                            continue
                    
                    if parsed_date:
                        original_date = parsed_date
                        
                        # Determine if we need to add 1 or 2 hours
                        # If date is in DST period, add 2 hours; otherwise add 1 hour
                        # Approximate DST period: end of March to end of October
                        month = parsed_date.month
                        if 3 <= month <= 10:
                            # DST period (summer time)
                            adjusted_date = parsed_date + timedelta(hours=2)
                            hours_added = 2
                        else:
                            # Standard time (winter time)
                            adjusted_date = parsed_date + timedelta(hours=1)
                            hours_added = 1
                        
                        # Format back to original format
                        original_value = row[date_idx]
                        row[date_idx] = adjusted_date.strftime(used_format)
                        
                        # Print the first few adjustments for debugging
                        if fixes_applied < 5:
                            logger.info(f"Row {row_idx}, Column {header[date_idx]}: Changed {original_value} ({original_date}) to {row[date_idx]} ({adjusted_date}) (+{hours_added} hours)")
                        fixes_applied += 1
    
    # Write updated transactions back to file
    with open(transactions_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f, delimiter=';')
        writer.writerow(header)
        writer.writerows(transactions_data)
    
    logger.info(f"Applied {fixes_applied} date fixes in {transactions_file}")

def process_portfolio_csv(csv_file, derivative_isins=None):
    """
    Process the portfolio CSV file to:
    1. Remove the svgCost, netValue, and avgCost columns
    2. Remove any positions that are derivatives (if derivative_isins is provided)
    """
    logger.info(f"Processing portfolio CSV to remove unwanted columns and derivative positions: {csv_file}")
    
    if not csv_file.exists():
        logger.error(f"Portfolio CSV not found: {csv_file}")
        return False
    
    # Read the CSV file
    rows = []
    header = []
    
    with open(csv_file, 'r', newline='', encoding='utf-8') as f:
        reader = csv.reader(f, delimiter=';')
        header = next(reader)
        rows = list(reader)
    
    # Check if columns to remove exist
    columns_to_remove = ['svgCost', 'netValue', 'avgCost']
    indices_to_remove = []
    
    for col in columns_to_remove:
        if col in header:
            idx = header.index(col)
            indices_to_remove.append(idx)
            logger.info(f"Found column to remove: {col} at index {idx}")
    
    # Remove columns (in reverse order to maintain correct indices)
    indices_to_remove.sort(reverse=True)
    for idx in indices_to_remove:
        del header[idx]
        for row in rows:
            if idx < len(row):
                del row[idx]
    
    # Find ISIN column index for filtering derivatives
    isin_idx = -1
    if 'ISIN' in header:
        isin_idx = header.index('ISIN')
    
    # Filter out derivative positions if we have the list and ISIN column
    filtered_rows = rows
    if derivative_isins and isin_idx >= 0:
        filtered_rows = []
        for row in rows:
            if isin_idx < len(row) and row[isin_idx] not in derivative_isins:
                filtered_rows.append(row)
        
        logger.info(f"Removed {len(rows) - len(filtered_rows)} derivative positions from portfolio")
    
    # Write back the modified CSV
    with open(csv_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f, delimiter=';')
        writer.writerow(header)
        writer.writerows(filtered_rows)
    
    logger.info(f"Processed portfolio CSV: removed {len(indices_to_remove)} columns and {len(rows) - len(filtered_rows)} derivative positions")
    return True

async def fetch_data(client=None, sessionId=None):
    """
    Main function to fetch data from Trade Republic.
    Returns a summary of the operation.
    """
    try:
        tr = client
        if not tr and sessionId and sessionId in AUTH_SESSIONS:
            tr = AUTH_SESSIONS[sessionId]["client"]
        
        if not tr:
            return {"error": "No authenticated client available"}
        
        results = {
            "status": "success",
            "files": []
        }
        
        # 1) transactions -------------------------------------------------
        try:
            await QuickDL(
                tr, OUT, "{iso_date}", since_timestamp=0,
                format_export="csv", sort_export=True
            ).dl_loop()
        except SystemExit:
            acc = OUT / "account_transactions.csv"
            tx = OUT / "transactions.csv"
            if acc.exists():
                if tx.exists():
                    tx.unlink()
                acc.rename(tx)
                results["files"].append("transactions.csv")
                
            for junk in ("other_events.json",
                        "events_with_documents.json",
                        "all_events.json"):    
                f = OUT / junk
                if f.exists():
                    f.unlink()
            
            # Fix timezone issue in transactions file
            if tx.exists():
                if not fix_trade_republic_csv(tx):
                    if not fix_transaction_dates_direct(tx):
                        fix_transaction_dates(tx)

        # 2) portfolio ----------------------------------------------------
        port = Portfolio(tr)
        await port.portfolio_loop()
        port_csv = OUT / "portfolio.csv"
        port.portfolio_to_csv(port_csv)
        results["files"].append("portfolio.csv")
        
        # 3) cash ---------------------------------------------------------
        cash = await tr._receive_one(tr.cash(), timeout=5)
        (OUT / "cash.json").write_text(json.dumps(cash, indent=2))
        results["files"].append("cash.json")

        # 4) details per ISIN ---------------------------------------------
        if port_csv.exists():
            logger.info(f"Reading portfolio from: {port_csv}")
            # Read ISINs from portfolio
            isins = set()
            with open(port_csv, newline='', encoding='utf-8') as f:
                reader = csv.DictReader(f, delimiter=';')
                for row in reader:
                    isin = row.get('ISIN')
                    if isin and isin.strip():
                        isins.add(isin)
            
            # Dictionary to track derivative ISINs
            derivative_isins = set()
            
            # Process each unique ISIN
            logger.info(f"Fetching details for {len(isins)} ISINs...")
            for current_isin in isins:
                logger.info(f"Processing ISIN: {current_isin}")
                
                # Create Details object
                det = Details(tr, current_isin)
                
                # Fetch details
                await det.details_loop()
                
                # Save details to file and check if it's a derivative
                details_file = OUT / f"details_{current_isin}.csv"
                is_derivative = save_details_to_csv(det, details_file)
                
                # If it's a derivative, add to set and remove the details file
                if is_derivative:
                    derivative_isins.add(current_isin)
                    if details_file.exists():
                        details_file.unlink()
                        logger.info(f"Removed details file for derivative: {current_isin}")
                else:
                    logger.info(f"Processing complete for {current_isin}")
                    results["files"].append(f"details_{current_isin}.csv")
            
            # Process the portfolio CSV to remove unwanted columns and derivative positions
            process_portfolio_csv(port_csv, derivative_isins)
        else:
            logger.error(f"Portfolio file not found: {port_csv}")
            results["portfolio_status"] = "not_found"
            
        return results
        
    except Exception as e:
        logger.error(f"Error in fetch_data: {str(e)}")
        return {"error": str(e)}

# Flask routes
@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for Render keep-alive"""
    return jsonify({"status": "ok"})

@app.route('/start-auth', methods=['POST'])
def start_auth():
    """Start the authentication process with phone and PIN"""
    data = request.json or {}
    phone = data.get('phone')
    pin = data.get('pin')
    
    if not phone or not pin:
        return jsonify({"error": "Phone and PIN are required"}), 400
    
    try:
        # Set environment variables for pytr login
        os.environ['TR_PHONE'] = phone
        os.environ['TR_PIN'] = pin
        
        # Generate a session ID
        session_id = str(uuid.uuid4())
        
        # Store this session for later use
        AUTH_SESSIONS[session_id] = {
            "status": "awaiting_2fa",
            "phone": phone,
            "initiated": datetime.now()
        }
        
        # This response tells the client to prompt for 2FA code
        return jsonify({
            "status": "awaiting_2fa",
            "sessionId": session_id,
            "message": "Please provide 2FA code"
        })
    except Exception as e:
        logger.error(f"Error starting authentication: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/verify-2fa', methods=['POST'])
async def verify_2fa():
    """Verify 2FA code and complete authentication"""
    data = request.json or {}
    session_id = data.get('sessionId')
    code = data.get('code')
    
    if not session_id or not code:
        return jsonify({"error": "Session ID and 2FA code are required"}), 400
    
    if session_id not in AUTH_SESSIONS:
        return jsonify({"error": "Invalid or expired session"}), 401
    
    session_data = AUTH_SESSIONS[session_id]
    
    try:
        # At this point, the client has provided the 2FA code 
        # which is entered in the terminal by the user in response
        # to the prompt from pytr.account.login()
        
        # Provide a mechanism for the login to receive the 2FA code
        def custom_input(prompt):
            # This function is monkey-patched to provide the 2FA code
            # instead of waiting for terminal input
            logger.info(f"Intercepted prompt: {prompt}")
            return code
        
        # Monkey patch the input function temporarily
        original_input = __builtins__.input
        __builtins__.input = custom_input
        
        try:
            # Perform the login with the provided credentials
            tr_client = login()
            
            # Store the authenticated client
            session_data["client"] = tr_client
            session_data["status"] = "authenticated"
            session_data["authenticated_at"] = datetime.now()
            
            return jsonify({
                "status": "authenticated",
                "sessionId": session_id,
                "message": "Authentication successful"
            })
        finally:
            # Restore the original input function
            __builtins__.input = original_input
            
    except Exception as e:
        logger.error(f"Error during 2FA verification: {str(e)}")
        session_data["status"] = "failed"
        session_data["error"] = str(e)
        return jsonify({"error": str(e)}), 500

@app.route('/fetch-data', methods=['POST'])
async def handle_fetch_data():
    """Fetch data after authentication"""
    # Extract the session ID from Authorization header
    auth_header = request.headers.get('Authorization', '')
    session_id = None
    
    if auth_header.startswith('Bearer '):
        session_id = auth_header[7:]  # Remove 'Bearer ' prefix
    
    if not session_id or session_id not in AUTH_SESSIONS:
        return jsonify({"error": "Unauthorized - valid session required"}), 401
    
    session_data = AUTH_SESSIONS[session_id]
    
    if session_data["status"] != "authenticated" or "client" not in session_data:
        return jsonify({"error": "Session not authenticated"}), 401
    
    # Now that we have an authenticated client, fetch the data
    result = await fetch_data(sessionId=session_id)
    return jsonify(result)

@app.route('/files', methods=['GET'])
def list_files():
    """List all available files"""
    try:
        files = [f.name for f in OUT.glob('*') if f.is_file()]
        return jsonify({"files": files})
    except Exception as e:
        logger.error(f"Error listing files: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/files/<filename>', methods=['GET'])
def get_file(filename):
    """Get a specific file"""
    try:
        file_path = OUT / filename
        if not file_path.exists():
            return jsonify({"error": "File not found"}), 404
        
        return send_file(file_path, as_attachment=True)
    except Exception as e:
        logger.error(f"Error getting file {filename}: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/download-all', methods=['GET'])
def download_all():
    """Download all files as a zip archive"""
    try:
        memory_file = io.BytesIO()
        
        with zipfile.ZipFile(memory_file, 'w') as zf:
            for file_path in OUT.glob('*'):
                if file_path.is_file():
                    zf.write(file_path, arcname=file_path.name)
        
        memory_file.seek(0)
        return send_file(
            memory_file,
            mimetype='application/zip',
            as_attachment=True,
            download_name='trade_republic_data.zip'
        )
    except Exception as e:
        logger.error(f"Error creating zip archive: {str(e)}")
        return jsonify({"error": str(e)}), 500

def keep_alive():
    """Function to periodically ping the service to keep it alive"""
    while True:
        try:
            # Sleep for 10 minutes
            time.sleep(600)
            
            # Make a request to the health endpoint
            url = os.environ.get('SERVICE_URL', 'http://localhost:8000')
            response = requests.get(f"{url}/health")
            logger.info(f"Keep-alive ping: {response.status_code}")
        except Exception as e:
            logger.error(f"Error in keep_alive: {str(e)}")

def start_keep_alive():
    """Start the keep-alive thread"""
    keep_alive_thread = threading.Thread(target=keep_alive)
    keep_alive_thread.daemon = True
    keep_alive_thread.start()
    logger.info("Keep-alive thread started")

def cleanup_sessions():
    """Clean up expired sessions periodically"""
    while True:
        try:
            # Sleep for 1 hour
            time.sleep(3600)
            
            # Get current time
            now = datetime.now()
            
            # Find expired sessions (older than 24 hours)
            expired_sessions = []
            for session_id, data in AUTH_SESSIONS.items():
                initiated = data.get("initiated")
                if initiated and (now - initiated).total_seconds() > 86400:  # 24 hours
                    expired_sessions.append(session_id)
            
            # Remove expired sessions
            for session_id in expired_sessions:
                del AUTH_SESSIONS[session_id]
                
            logger.info(f"Cleaned up {len(expired_sessions)} expired sessions")
        except Exception as e:
            logger.error(f"Error in session cleanup: {str(e)}")

def start_session_cleanup():
    """Start the session cleanup thread"""
    cleanup_thread = threading.Thread(target=cleanup_sessions)
    cleanup_thread.daemon = True
    cleanup_thread.start()
    logger.info("Session cleanup thread started")

# Main entrypoint for Flask app
if __name__ == "__main__":
    # Start the keep-alive thread
    start_keep_alive()
    
    # Start the session cleanup thread
    start_session_cleanup()
    
    # Get port from environment or use default
    port = int(os.environ.get('PORT', 8000))
    
    # Run the app using Werkzeug's run_simple for async compatibility
    run_simple('0.0.0.0', port, app, use_reloader=False, threaded=True)
