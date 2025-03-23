FROM ghcr.io/puppeteer/puppeteer:22.1.0

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy application code
COPY . .

# Set environment variables if needed (can also be set in Render dashboard)
# ENV NODE_ENV=production

# Command to run the app
CMD ["node", "server.js"]
