FROM ghcr.io/puppeteer/puppeteer:22.1.0

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Command to run the app
CMD ["node", "server.js"]
