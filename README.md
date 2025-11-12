# Mini Games WebSocket Server

This is a separate Node.js/Express WebSocket server for real-time mini game synchronization. Deploy this to Render as a Web Service.

## Setup

1. Create a new GitHub repository for this server
2. Clone and initialize:
   ```bash
   git clone <your-repo-url>
   cd mini-games-websocket-server
   npm init -y
   ```

3. Install dependencies:
   ```bash
   npm install express ws @neondatabase/serverless dotenv
   ```

4. Set environment variables in Render:
   - `NEON_DATABASE_URL` - Your Neon PostgreSQL connection string
   - `PORT` - Port number (default: 10000)
   - `NODE_ENV` - production

5. Deploy to Render:
   - Connect GitHub repository
   - Set build command: (none needed)
   - Set start command: `node src/server.js`
   - Set environment variables

## WebSocket Endpoint

- Production: `wss://your-service.onrender.com/ws`
- Local: `ws://localhost:10000/ws`

## Connection

Connect with query parameters:
```
wss://your-service.onrender.com/ws?session=<SESSION_CODE>&userId=<USER_ID>&role=<teacher|student>
```

## Architecture

- `src/server.js` - Main Express/WebSocket server
- `src/gameManager.js` - Game session management
- `src/queueManager.js` - Matchmaking queue system
- `src/matchManager.js` - 1v1 match management

