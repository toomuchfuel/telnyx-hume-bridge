require('dotenv').config();
const WebSocket = require('ws');
const express = require('express');
const app = express();

// Allow JSON body parsing
app.use(express.json());

// Create HTTP server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Bridge server running on port ${PORT}`);
});

// Attach WebSocket server to the same HTTP server (Railway-compatible)
const wss = new WebSocket.Server({ server });

// Hume EVI WebSocket URL (from env)
const HUME_EVI_WS_URL = process.env.HUME_EVI_WS_URL;

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  console.log(`New Telnyx stream connection: ${sessionId}`);

  let humeWs = null;

  // Connect to Hume EVI
  try {
    humeWs = new WebSocket(HUME_EVI_WS_URL);
  } catch (err) {
    console.error('Failed to connect to Hume EVI:', err.message);
    ws.close(1011, 'Hume connection failed');
    return;
  }

  humeWs.on('error', (err) => {
  console.error('Hume EVI WebSocket error:', err.message);
});
humeWs.on('close', (code, reason) => {
  console.log(`Hume EVI closed: ${code} - ${reason}`);
});
  
 humeWs.on('open', () => {
  console.log('Connected to Hume EVI - sending session_settings');
  humeWs.send(JSON.stringify({
    type: 'session_settings',
    voice: {
      provider: 'hume',
      voice_id: 'australian-male-1'  // or your custom voice ID
    },
    model: {
      provider: 'hume',
      model: 'evi'
    },
    system_prompt: 'You are a compassionate AI therapist. Listen deeply, speak gently, focus on body sensations and breath.'
  }));
});

  humeWs.on('message', (data) => {
    // Forward Hume audio/output back to Telnyx
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  humeWs.on('close', () => {
    console.log('Hume EVI connection closed');
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  humeWs.on('error', (err) => {
    console.error('Hume EVI error:', err.message);
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Hume error');
  });

  // Forward Telnyx audio to Hume
  ws.on('message', (message) => {
    if (humeWs.readyState === WebSocket.OPEN) {
      humeWs.send(message);
    }
  });

  ws.on('close', () => {
    console.log('Telnyx stream closed');
    if (humeWs) humeWs.close();
  });

  ws.on('error', (err) => {
    console.error('Telnyx WS error:', err.message);
    if (humeWs) humeWs.close();
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: PORT });
});

console.log('Telnyx-Hume-Groq Bridge Ready');
