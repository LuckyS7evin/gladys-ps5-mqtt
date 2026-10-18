// -----------------------------------------------------------------------------
// Entry point of the PS5 Remote Play integration for Gladys Assistant.
//
// Role of this file: instantiate the SDK, register the handlers (src/app.js)
// BEFORE connect(), and connect. The SDK handles the connection, the auth and
// the reconnections.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// DATA_DIR (default /data) is where the credentials are stored.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from './src/app.js';

const gladys = new GladysIntegration();
const { stopPsn } = registerHandlers(gladys);

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopPsn();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the PS5 Remote Play integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
