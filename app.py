# app.py - Flask API for Trade Republic Portfolio
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import os
import portfolio_fetcher

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

@app.route('/')
def home():
    """Home page to confirm API is running."""
    return render_template('index.html')

@app.route('/api/portfolio', methods=['POST'])
def get_portfolio():
    """
    Endpoint to fetch portfolio data.
    
    Expects JSON with:
    - phone_number: Trade Republic phone number
    - pin: Trade Republic PIN
    
    Returns JSON with portfolio data or error message.
    """
    # Get JSON data from request
    data = request.get_json()
    
    # Validate input
    if not data:
        return jsonify({"success": False, "error": "Missing request data"}), 400
        
    phone_number = data.get('phone_number')
    pin = data.get('pin')
    
    # Check required fields
    if not phone_number or not pin:
        return jsonify({
            "success": False,
            "error": "Missing required fields: phone_number and pin"
        }), 400
    
    try:
        # Call portfolio fetcher function
        result = portfolio_fetcher.fetch_portfolio(phone_number, pin)
        return jsonify(result)
    except Exception as e:
        return jsonify({
            "success": False, 
            "error": str(e)
        }), 500

# Create a simple templates folder for the home page
os.makedirs('templates', exist_ok=True)
with open('templates/index.html', 'w') as f:
    f.write("""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Portfolio API</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 20px;
                line-height: 1.6;
            }
            h1 {
                color: #4a80f5;
            }
            .code {
                background-color: #f5f5f5;
                padding: 10px;
                border-radius: 5px;
                font-family: monospace;
                overflow-x: auto;
            }
        </style>
    </head>
    <body>
        <h1>Trade Republic Portfolio API</h1>
        <p>This API allows you to fetch portfolio data from Trade Republic.</p>
        
        <h2>Usage:</h2>
        <p>Send a POST request to <code>/api/portfolio</code> with the following JSON:</p>
        
        <pre class="code">
{
    "phone_number": "your_phone_number",
    "pin": "your_pin"
}
        </pre>
        
        <p>You'll receive portfolio data in response.</p>
        
        <h2>Status:</h2>
        <p>✅ API is online and ready to receive requests.</p>
    </body>
    </html>
    """)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8000))
    app.run(host='0.0.0.0', port=port)
