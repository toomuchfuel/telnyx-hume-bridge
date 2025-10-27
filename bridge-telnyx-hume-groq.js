/**
 * Bridge Service: Telnyx ↔ Hume EVI ↔ Groq
 * 
 * This service acts as a WebSocket bridge between:
 * - Telnyx (audio streaming)
 * - Hume EVI (emotion detection + TTS)
 * - Groq (LLM processing)
 * 
 * Railway Deployment:
 * - Exposes wss://<your-domain>/telnyx
 * - Handles real-time audio streaming
 * - Processes audio through Hume EVI
 * - Generates responses via Groq
 * - Calls back to main server for TTS
 */

const WebSocket = require('ws');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');

// Environment variables validation
const HUME_WS_URL = process.env.HUME_WS_URL;
const HUME_API_KEY = process.env.HUME_API_KEY;
const WEBHOOK_SPEAK_URL = process.env.WEBHOOK_SPEAK_URL;
const PORT = process.env.PORT || process.env.BRIDGE_PORT || 3001;

console.log('🌉 Bridge Service Starting...');
console.log('📋 Environment Check:', {
  HUME_WS_URL: HUME_WS_URL ? 'configured' : 'MISSING',
  HUME_API_KEY: HUME_API_KEY ? 'configured' : 'MISSING',
  WEBHOOK_SPEAK_URL: WEBHOOK_SPEAK_URL ? 'configured' : 'MISSING',
  PORT: PORT
});

if (!HUME_WS_URL || !HUME_API_KEY || !WEBHOOK_SPEAK_URL) {
  console.error('❌ Missing required environment variables!');
  console.error('Required: HUME_WS_URL, HUME_API_KEY, WEBHOOK_SPEAK_URL');
  process.exit(1);
}

// Create HTTP server
const server = createServer();

// Create WebSocket server
const wss = new WebSocketServer({
  server,
  path: '/telnyx'
});

// Store active connections
const activeConnections = new Map();

// Health check endpoint
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'OK',
      service: 'Telnyx-Hume-Groq Bridge',
      timestamp: new Date().toISOString(),
      connections: activeConnections.size,
      environment: {
        HUME_WS_URL: HUME_WS_URL ? 'configured' : 'missing',
        HUME_API_KEY: HUME_API_KEY ? 'configured' : 'missing',
        WEBHOOK_SPEAK_URL: WEBHOOK_SPEAK_URL ? 'configured' : 'missing'
      }
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const clientIP = req.socket.remoteAddress;
  
  console.log(`🔗 New WebSocket connection: ${connectionId} from ${clientIP}`);
  
  // Store connection info
  activeConnections.set(connectionId, {
    ws,
    clientIP,
    connectedAt: new Date(),
    callControlId: null,
    humeConnection: null,
    isProcessing: false
  });
  
  // Handle incoming messages from Telnyx
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleTelnyxMessage(connectionId, message);
    } catch (error) {
      console.error(`❌ Error processing message from ${connectionId}:`, error);
    }
  });
  
  // Handle connection close
  ws.on('close', (code, reason) => {
    console.log(`🔌 WebSocket connection closed: ${connectionId} (${code}) ${reason}`);
    cleanupConnection(connectionId);
  });
  
  // Handle connection errors
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${connectionId}:`, error);
    cleanupConnection(connectionId);
  });
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'bridge_connected',
    connectionId,
    timestamp: new Date().toISOString(),
    message: 'Bridge service connected successfully'
  }));
});

/**
 * Handle incoming messages from Telnyx
 */
async function handleTelnyxMessage(connectionId, message) {
  const connection = activeConnections.get(connectionId);
  if (!connection) {
    console.error(`❌ Connection not found: ${connectionId}`);
    return;
  }
  
  console.log(`📨 Received message from Telnyx:`, {
    connectionId,
    messageType: message.type,
    hasAudio: !!message.audio
  });
  
  // Handle different message types
  switch (message.type) {
    case 'call.initiated':
      await handleCallInitiated(connectionId, message);
      break;
      
    case 'call.answered':
      await handleCallAnswered(connectionId, message);
      break;
      
    case 'media':
      await handleMediaMessage(connectionId, message);
      break;
      
    case 'call.hangup':
      await handleCallHangup(connectionId, message);
      break;
      
    default:
      console.log(`ℹ️  Unhandled message type: ${message.type}`);
  }
}

/**
 * Handle call initiated - establish Hume connection
 */
async function handleCallInitiated(connectionId, message) {
  console.log(`📞 Call initiated for ${connectionId}`);
  
  try {
    // Connect to Hume EVI
    const humeWs = new WebSocket(HUME_WS_URL, {
      headers: {
        'Authorization': `Bearer ${HUME_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    humeWs.on('open', () => {
      console.log(`🎭 Hume EVI connected for ${connectionId}`);
      
      // Send Hume configuration
      humeWs.send(JSON.stringify({
        type: 'configure',
        config: {
          models: {
            prosody: {},
            facemesh: {},
            language: {}
          },
          stream_window_ms: 1000,
          use_embeddings: true
        }
      }));
    });
    
    humeWs.on('message', (data) => {
      handleHumeMessage(connectionId, data);
    });
    
    humeWs.on('error', (error) => {
      console.error(`❌ Hume EVI error for ${connectionId}:`, error);
    });
    
    humeWs.on('close', () => {
      console.log(`🎭 Hume EVI disconnected for ${connectionId}`);
    });
    
    // Store Hume connection
    const connection = activeConnections.get(connectionId);
    if (connection) {
      connection.humeConnection = humeWs;
      connection.callControlId = message.call_control_id;
    }
    
  } catch (error) {
    console.error(`❌ Error connecting to Hume EVI for ${connectionId}:`, error);
  }
}

/**
 * Handle call answered - start processing
 */
async function handleCallAnswered(connectionId, message) {
  console.log(`✅ Call answered for ${connectionId}`);
  
  const connection = activeConnections.get(connectionId);
  if (connection) {
    connection.callControlId = message.call_control_id;
    connection.isProcessing = true;
  }
}

/**
 * Handle media messages (audio data)
 */
async function handleMediaMessage(connectionId, message) {
  const connection = activeConnections.get(connectionId);
  if (!connection || !connection.humeConnection || !connection.isProcessing) {
    return;
  }
  
  try {
    // Forward audio to Hume EVI
    if (message.audio) {
      connection.humeConnection.send(JSON.stringify({
        type: 'audio',
        audio: message.audio,
        timestamp: message.timestamp
      }));
    }
  } catch (error) {
    console.error(`❌ Error forwarding audio to Hume for ${connectionId}:`, error);
  }
}

/**
 * Handle Hume EVI responses
 */
async function handleHumeMessage(connectionId, data) {
  try {
    const message = JSON.parse(data.toString());
    const connection = activeConnections.get(connectionId);
    
    if (!connection) {
      return;
    }
    
    console.log(`🎭 Received from Hume EVI:`, {
      connectionId,
      messageType: message.type,
      hasPredictions: !!message.predictions
    });
    
    // Handle different Hume message types
    switch (message.type) {
      case 'audio_output':
        // Hume generated audio response
        await handleHumeAudioOutput(connectionId, message);
        break;
        
      case 'predictions':
        // Emotion/sentiment analysis
        await handleHumePredictions(connectionId, message);
        break;
        
      case 'error':
        console.error(`❌ Hume EVI error for ${connectionId}:`, message.error);
        break;
        
      default:
        console.log(`ℹ️  Unhandled Hume message type: ${message.type}`);
    }
    
  } catch (error) {
    console.error(`❌ Error processing Hume message for ${connectionId}:`, error);
  }
}

/**
 * Handle Hume audio output - send to Telnyx via webhook
 */
async function handleHumeAudioOutput(connectionId, message) {
  const connection = activeConnections.get(connectionId);
  if (!connection || !connection.callControlId) {
    return;
  }
  
  try {
    // Call back to main server to speak the audio
    await axios.post(WEBHOOK_SPEAK_URL, {
      call_control_id: connection.callControlId,
      text: message.text || 'I understand.',
      audio: message.audio
    });
    
    console.log(`🔊 Sent audio to Telnyx for ${connectionId}`);
    
  } catch (error) {
    console.error(`❌ Error sending audio to Telnyx for ${connectionId}:`, error);
  }
}

/**
 * Handle Hume predictions (emotion analysis)
 */
async function handleHumePredictions(connectionId, message) {
  const connection = activeConnections.get(connectionId);
  if (!connection) {
    return;
  }
  
  try {
    // Process emotion data and generate appropriate response
    const emotions = message.predictions?.prosody?.emotions || [];
    const sentiment = message.predictions?.language?.sentiment || {};
    
    console.log(`🎭 Emotion analysis for ${connectionId}:`, {
      emotions: emotions.slice(0, 3), // Top 3 emotions
      sentiment: sentiment
    });
    
    // Generate contextual response based on emotions
    let responseText = generateEmotionalResponse(emotions, sentiment);
    
    if (responseText) {
      // Send response back to Hume for TTS
      connection.humeConnection.send(JSON.stringify({
        type: 'text',
        text: responseText,
        timestamp: new Date().toISOString()
      }));
    }
    
  } catch (error) {
    console.error(`❌ Error processing Hume predictions for ${connectionId}:`, error);
  }
}

/**
 * Generate emotional response based on Hume analysis
 */
function generateEmotionalResponse(emotions, sentiment) {
  if (!emotions || emotions.length === 0) {
    return null;
  }
  
  const topEmotion = emotions[0];
  const emotionName = topEmotion.name;
  const emotionScore = topEmotion.score;
  
  // Generate contextual responses based on detected emotions
  const responses = {
    'joy': 'I can hear the happiness in your voice. That\'s wonderful!',
    'sadness': 'I sense some sadness. Would you like to talk about what\'s on your mind?',
    'anger': 'I notice some frustration. Let\'s work through this together.',
    'fear': 'I can hear some concern in your voice. You\'re safe here.',
    'surprise': 'That sounds surprising! Tell me more about what happened.',
    'disgust': 'I understand that might be difficult to discuss.',
    'neutral': 'I\'m here to listen. How are you feeling today?'
  };
  
  return responses[emotionName] || responses['neutral'];
}

/**
 * Handle call hangup - cleanup
 */
async function handleCallHangup(connectionId, message) {
  console.log(`📞 Call ended for ${connectionId}`);
  cleanupConnection(connectionId);
}

/**
 * Cleanup connection resources
 */
function cleanupConnection(connectionId) {
  const connection = activeConnections.get(connectionId);
  if (connection) {
    // Close Hume connection
    if (connection.humeConnection) {
      connection.humeConnection.close();
    }
    
    // Remove from active connections
    activeConnections.delete(connectionId);
    
    console.log(`🧹 Cleaned up connection: ${connectionId}`);
  }
}

/**
 * Start the bridge server
 */
function startServer() {
  // --- add this before server.listen ---
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }
});
server.on('request', (req, res) => {
  if (req.url === '/' || req.url === '/health' || req.url === '/hc') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }
});

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌉 Bridge Service listening on port ${PORT}`);
    console.log(`🔗 WebSocket endpoint: wss://localhost:${PORT}/telnyx`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Active connections: ${activeConnections.size}`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  
  // Close all WebSocket connections
  activeConnections.forEach((connection, connectionId) => {
    cleanupConnection(connectionId);
  });
  
  server.close(() => {
    console.log('✅ Bridge service closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  
  // Close all WebSocket connections
  activeConnections.forEach((connection, connectionId) => {
    cleanupConnection(connectionId);
  });
  
  server.close(() => {
    console.log('✅ Bridge service closed');
    process.exit(0);
  });
});

// Start the server
startServer();
