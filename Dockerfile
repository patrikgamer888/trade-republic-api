FROM ghcr.io/puppeteer/puppeteer:22.1.0

WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the code
COPY . .

# Run the script
CMD ["node", "render.js"]
