import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env file.');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Force English in instructions
const SYSTEM_MESSAGE = `
You are a helpful AI assistant for the Clinician Helpdesk.
Always respond in English, regardless of input language.
Keep responses friendly, professional, and conversational.
`;

const VOICE = 'cedar';
const TEMPERATURE = 0.8;
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated'
];
const SHOW_TIMING_MATH = false;
const PORT = process.env.PORT || 5050;

// Health check
fastify.get('/', async (req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Incoming call webhook
fastify.all('/incoming-call', async (req, reply) => {
  const host = req.headers.host;

  // Twilio TTS with a natural pause and male neural voice greeting
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
      Please wait while we connect your call to the AI voice assistant.
    </Say>
    <Pause length="1"/>
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
      Okay, you can start talking!
    </Say>
    <Pause length="1"/>
    <Say voice="Matthew.Neural">
      Hi, welcome to the Clinician Helpdesk. How can I assist you today?
    </Say>
    <Connect>
      <Stream url="wss://${host}/media-stream"/>
    </Connect>
  </Response>`;

  reply.type('text/xml').send(twiml);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected to media-stream');

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&temperature=${TEMPERATURE}&voice=${VOICE}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-4o-realtime-preview',
          output_modalities: ['audio'],
          audio: {
            input: { format: { type: 'audio/pcmu' } },
            output: { format: { type: 'audio/pcmu' } },
          },
          instructions: SYSTEM_MESSAGE,
          language: 'en'
        },
      };
      console.log('Initializing OpenAI session');
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime API');
      setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (LOG_EVENT_TYPES.includes(msg.type)) console.log(msg.type, msg);

        if (msg.type === 'response.output_audio.delta' && msg.delta) {
          connection.send(
            JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: msg.delta },
            })
          );
          if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
          if (msg.item_id) lastAssistantItem = msg.item_id;
        }

        if (msg.type === 'input_audio_buffer.speech_started') {
          if (markQueue.length > 0 && responseStartTimestampTwilio) {
            const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;
            if (lastAssistantItem) {
              openAiWs.send(
                JSON.stringify({
                  type: 'conversation.item.truncate',
                  item_id: lastAssistantItem,
                  content_index: 0,
                  audio_end_ms: elapsed,
                })
              );
            }
            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
          }
        }
      } catch (err) {
        console.error('Error processing OpenAI message:', err, data);
      }
    });

    connection.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        switch (data.event) {
          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
            }
            break;
          case 'start':
            streamSid = data.start.streamSid;
            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;
            console.log('Media stream started:', streamSid);
            break;
          case 'mark':
            if (markQueue.length > 0) markQueue.shift();
            break;
          default:
            console.log('Non-media event:', data.event);
        }
      } catch (err) {
        console.error('Error parsing message:', err, msg);
      }
    });

    connection.on('close', () => {
      console.log('Client disconnected from media-stream');
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    openAiWs.on('close', () => console.log('OpenAI Realtime API disconnected'));
    openAiWs.on('error', (err) => console.error('OpenAI WebSocket error:', err));
  });
});

// Start Fastify server on Render
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on ${address}`);
});
