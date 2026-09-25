/**
 * Test Mode Middleware & Helper Functions
 * 
 * Safeguards test-only endpoints by verifying TEST_MODE=true and
 * guaranteeing it cannot be enabled in production environments.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function isTestModeEnabled() {
  if (process.argv.includes('--test') || process.argv.includes('--test-mode')) {
    process.env.TEST_MODE = 'true';
    return process.env.NODE_ENV !== 'production';
  }
  if (process.argv.includes('--normal')) {
    process.env.TEST_MODE = 'false';
    return false;
  }

  // In development, sync with local .env file changes dynamically (skip in Jest unit tests)
  if (process.env.IS_JEST !== 'true' && process.env.NODE_ENV !== 'test') {
    try {
      const envPath = path.resolve(__dirname, '../../.env');
      if (fs.existsSync(envPath)) {
        const envConfig = dotenv.parse(fs.readFileSync(envPath));
        if (envConfig.TEST_MODE !== undefined) {
          process.env.TEST_MODE = envConfig.TEST_MODE;
        }
        if (envConfig.DEBUG !== undefined) {
          process.env.DEBUG = envConfig.DEBUG;
        }
      }
    } catch (e) {
      // fallback to process.env
    }
  }

  const isTestMode = process.env.TEST_MODE === 'true';
  const isProduction = process.env.NODE_ENV === 'production';

  // Safeguard: Never allow TEST_MODE in production
  if (isProduction && isTestMode) {
    console.error('🚨 [TEST_MODE_SECURITY_ALERT] TEST_MODE=true was detected in NODE_ENV=production! Test Mode is strictly blocked in production.');
    return false;
  }

  return isTestMode && !isProduction;
}

function requireTestMode(req, res, next) {
  if (!isTestModeEnabled()) {
    console.warn(`⚠️ [TEST_MODE] Blocked unauthorized access attempt to ${req.method} ${req.originalUrl} (TEST_MODE is disabled or in production)`);
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Test Mode is disabled. To enable, set TEST_MODE=true in your local backend environment (.env) and ensure NODE_ENV is not "production".'
      }
    });
  }
  next();
}

module.exports = {
  isTestModeEnabled,
  requireTestMode
};
