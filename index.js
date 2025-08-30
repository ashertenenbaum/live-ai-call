import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import axios from 'axios';

// Load environment variables
dotenv.config();
const { OPENAI_API_KEY, SLACK_WEBHOOK_URL } = process.env;
if (!OPENAI_API_KEY || !SLACK_WEBHOOK_URL) {
  console.error('Missing OPENAI_API_KEY or SLACK_WEBHOOK_URL in .env file.');
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;
const VOICE = 'verse';
const TEMPERATURE = 0.8;

const SYSTEM_MESSAGE = `
You are a helpful AI assistant for The Clinician help desk.
Always speak in English.
Ask for:
- Name
- Email
- Problem description
- Time of occurrence
- TCP domain
Confirm with the user once all fields are collected.
Format the final answer as JSON with keys: name, email, problem, time, tcp.
Stay friendly and respectful.
`;

// Helper: send Slack message
const sendToSlack = async ({ name, email, problem, time, tcp }) => {
  const message = `📞 *New Support Request Received!*\n*Name:* ${name || 'N/A'}\n*Email:* ${email || 'N/A'}\n*Problem:* ${problem || 'N/A'}\n*Time:* ${time || 'N/A'}\n*TCP Domain:* ${tcp || 'N/A'}\n\nWe're working on this issue now.`;
  try {
    await axios.post(SLACK_WEBHOOK_URL, { text: message });
    console.log('Sent to Slack successfully');
  } catch (err) {
    console.error('Error sending to Slack:', err);
  }
};

// Root route
fastify.get('/', async (req, reply) => reply.send({ message: 'AI Voice Call Server running!' }));

// Twilio incoming call
fastify.all('/incoming-call', async (req, reply) => {
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Please wait while we connect you to the AI assistant.
  </Say>
  <Pause length="1"/>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Okay, you can start talking now!
  </Say>
  <Connect>
    <Stream url="wss://${host}/media-stream"/>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// WebSocket for Twilio media stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection) => {
    console.log('Client connected to media-stream');

    let streamSid = null;
    let userData = { name: null, email: null, problem: null, time: null, tcp: null };
    let allConfirmed = false;

    // Connect to OpenAI Realtime API
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&temperature=${TEMPERATURE}&voice=${VOICE}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    const initializeSession = () => {
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-4o-realtime-preview',
          output_modalities: ['audio'],
          audio: { input: { format: { type: 'audio/pcmu' } }, output: { format: { type: 'audio/pcmu' } } },
          instructions: SYSTEM_MESSAGE,
        }
      }));
      console.log('Initialized OpenAI session');
    };

    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      initializeSession();
    });

    // Handle OpenAI messages
    openAiWs.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        // Stream AI audio to Twilio
        if (msg.type === 'response.output_audio.delta' && msg.delta) {
          connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.delta } }));
        }

        // Collect JSON output incrementally
        if (msg.type === 'response.output_text.delta' && msg.delta) {
          try {
            const partial = msg.delta.trim();
            if (partial.startsWith('{') && partial.endsWith('}')) {
              const parsed = JSON.parse(partial);
              userData = { ...userData, ...parsed };
              console.log('Updated userData:', userData);
            }
          } catch {}
        }

        // Check if all fields are filled
        if (!allConfirmed) {
          const allFilled = Object.values(userData).every(f => f);
          if (allFilled) {
            allConfirmed = true;

            // Send Slack message
            await sendToSlack(userData);

            // Play polite farewell
            const farewell = `<speak>Thank you for calling. We are working on your problem now. Have a great day!</speak>`;
            connection.send(JSON.stringify({
              event: 'media',
              media: { payload: Buffer.from(farewell).toString('base64') }
            }));

            // Close connection after 2s
            setTimeout(() => connection.close(), 2000);
          }
        }

      } catch (err) {
        console.error('Error processing OpenAI message:', err, data);
      }
    });

    // Handle Twilio events
    connection.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        switch (data.event) {
          case 'media':
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
            }
            break;
          case 'start':
            streamSid = data.start.streamSid;
            console.log('Media stream started:', streamSid);
            break;
        }
      } catch (err) { console.error('Error parsing Twilio message:', err, msg); }
    });

    // Handle premature hang-ups
    connection.on('close', async () => {
      console.log('Client disconnected from media-stream');
      if (!allConfirmed && Object.values(userData).some(f => f)) {
        console.log('Sending partial data to Slack...');
        await sendToSlack(userData);
      }
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    openAiWs.on('close', () => console.log('OpenAI Realtime API disconnected'));
    openAiWs.on('error', (err) => console.error('OpenAI WebSocket error:', err));
  });
});

// Start Fastify server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server is listening on ${address}`);
});
